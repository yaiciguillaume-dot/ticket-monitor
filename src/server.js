import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { queries } from './db.js';
import { bus, startAll, schedule, clearTimer, checkNow } from './monitor.js';
import { channels, sendTest } from './notifier.js';
import { closeBrowser } from './scraper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

const DEFAULT_INTERVAL = Number(process.env.DEFAULT_INTERVAL || 60);

// ─── API ───────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({ channels, defaultInterval: DEFAULT_INTERVAL });
});

app.get('/api/targets', (req, res) => {
  res.json(queries.listTargets.all().map(serialize));
});

app.post('/api/targets', (req, res) => {
  const { url, name, keyword, interval_sec, wait_selector } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'URL invalide (http/https requis).' });
  }
  const info = queries.insertTarget.run({
    name: name?.trim() || null,
    url: url.trim(),
    keyword: keyword?.trim() || 'Épuisé',
    interval_sec: Math.max(20, Number(interval_sec) || DEFAULT_INTERVAL),
    enabled: 1,
    wait_selector: wait_selector?.trim() || null,
    created_at: Date.now(),
  });
  schedule(info.lastInsertRowid);
  res.json(serialize(queries.getTarget.get(info.lastInsertRowid)));
});

app.delete('/api/targets/:id', (req, res) => {
  const id = Number(req.params.id);
  clearTimer(id);
  queries.deleteTarget.run(id);
  res.json({ ok: true });
});

app.post('/api/targets/:id/toggle', (req, res) => {
  const id = Number(req.params.id);
  const t = queries.getTarget.get(id);
  if (!t) return res.status(404).json({ error: 'introuvable' });
  const next = t.enabled ? 0 : 1;
  queries.setEnabled.run(next, id);
  if (next) schedule(id);
  else clearTimer(id);
  res.json(serialize(queries.getTarget.get(id)));
});

app.post('/api/targets/:id/check', async (req, res) => {
  const id = Number(req.params.id);
  await checkNow(id).catch(() => {});
  res.json(serialize(queries.getTarget.get(id)));
});

app.get('/api/events', (req, res) => {
  res.json(queries.recentEvents.all(50));
});

app.post('/api/test-notify', async (req, res) => {
  await sendTest();
  res.json({ ok: true, channels });
});

// ─── SSE temps réel ────────────────────────────────────
app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  const onUpdate = () => res.write(`event: update\ndata: {}\n\n`);
  const onEvent = (e) => res.write(`event: alert\ndata: ${JSON.stringify(e)}\n\n`);
  bus.on('update', onUpdate);
  bus.on('event', onEvent);

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('update', onUpdate);
    bus.off('event', onEvent);
  });
});

function serialize(t) {
  return {
    id: t.id,
    name: t.name,
    url: t.url,
    keyword: t.keyword,
    interval_sec: t.interval_sec,
    enabled: !!t.enabled,
    wait_selector: t.wait_selector,
    last_status: t.last_status,
    last_checked: t.last_checked,
    available: JSON.parse(t.available || '[]'),
    last_error: t.last_error,
  };
}

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`\n  🎟️  Ticket Monitor sur http://localhost:${PORT}`);
  console.log(`  Notifs → Telegram: ${channels.telegram ? 'ON' : 'off'} | Email: ${channels.email ? 'ON' : 'off'}\n`);
  startAll();
});

async function shutdown() {
  await closeBrowser().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
