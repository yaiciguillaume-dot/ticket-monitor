import { EventEmitter } from 'events';
import { queries } from './db.js';
import { scrape } from './scraper.js';
import { notifyAvailable } from './notifier.js';

export const bus = new EventEmitter();
bus.setMaxListeners(0);

const timers = new Map(); // targetId -> timeout
let running = false;

function emitEvent(target, type, message) {
  const row = { target_id: target.id, type, message: message || null, created_at: Date.now() };
  queries.insertEvent.run(row);
  bus.emit('event', { ...row, name: target.name || target.url });
}

async function checkTarget(id) {
  const target = queries.getTarget.get(id);
  if (!target || !target.enabled) return;

  const prevAvailable = JSON.parse(target.available || '[]');
  let result;
  try {
    result = await scrape(target);
  } catch (err) {
    queries.updateResult.run({
      id,
      last_status: 'error',
      last_checked: Date.now(),
      available: target.available || '[]',
      last_error: String(err.message || err).slice(0, 500),
    });
    emitEvent(target, 'error', String(err.message || err).slice(0, 200));
    bus.emit('update');
    return;
  }

  // Nouvelles catégories dispo qui ne l'étaient pas au tour précédent.
  const newly = result.available.filter((c) => !prevAvailable.includes(c));

  queries.updateResult.run({
    id,
    last_status: result.status,
    last_checked: Date.now(),
    available: JSON.stringify(result.available),
    last_error: result.error || null,
  });

  if (newly.length > 0) {
    emitEvent(target, 'available', `Dispo : ${newly.join(', ')}`);
    try {
      await notifyAvailable(target, newly);
    } catch (err) {
      console.error('[notify] échec', err);
    }
  } else if (result.status === 'error') {
    emitEvent(target, 'error', result.error);
  }

  bus.emit('update');
}

/** (Re)programme le prochain check d'une cible selon son intervalle. */
export function schedule(id) {
  clearTimer(id);
  const target = queries.getTarget.get(id);
  if (!target || !target.enabled) return;

  const loop = async () => {
    await checkTarget(id).catch((e) => console.error('[monitor]', e));
    const t = queries.getTarget.get(id);
    if (t && t.enabled && running) {
      timers.set(id, setTimeout(loop, Math.max(20, t.interval_sec) * 1000));
    }
  };
  // premier check rapidement
  timers.set(id, setTimeout(loop, 1500));
}

export function clearTimer(id) {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
}

/** Lance le monitoring de toutes les cibles activées. */
export function startAll() {
  running = true;
  for (const target of queries.listTargets.all()) {
    if (target.enabled) schedule(target.id);
  }
}

export function checkNow(id) {
  return checkTarget(id);
}
