import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { scrape, closeBrowser } from './scraper.js';
import { notifyAvailable } from './notifier.js';

/**
 * Vérifie toutes les billetteries de targets.json, compare à state.json,
 * notifie les nouvelles places, réécrit state.json.
 * - vérifications EN PARALLÈLE (limitées) pour rester rapide même avec beaucoup d'URLs
 * - verrou anti-chevauchement
 * - l'heure de vérif est mise à jour même en cas d'erreur de lecture
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS_FILE = join(root, 'targets.json');
const STATE_FILE = join(root, 'state.json');
const LOCK_FILE = join(root, '.check.lock');
const CONCURRENCY = 3;

// ── Verrou : si un check tourne déjà (et n'est pas bloqué), on saute ce tour ──
if (existsSync(LOCK_FILE)) {
  const ageMin = (Date.now() - statSync(LOCK_FILE).mtimeMs) / 60000;
  if (ageMin < 8) {
    console.log(`⏭️  Un check est déjà en cours (${ageMin.toFixed(1)} min), on saute.`);
    process.exit(0);
  }
  console.log('⚠️  Verrou périmé, on relance.');
}
writeFileSync(LOCK_FILE, String(process.pid));

const targets = JSON.parse(readFileSync(TARGETS_FILE, 'utf8'));
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
let exitCode = 0;

async function checkOne(t) {
  if (t.enabled === false) return;
  const target = {
    name: t.name || t.url,
    url: t.url,
    keyword: (t.keyword || 'Épuisé').trim(),
    wait_selector: t.wait_selector || null,
    click_text: t.click_text || null,
  };
  const now = new Date().toISOString();
  const prev = state[target.url] || {};

  try {
    const r = await scrape(target);

    if (r.status === 'error') {
      console.log(`⚠️  ${target.name} — ${r.error}`);
      // On conserve les dispos connues, mais on note qu'on a bien re-tenté.
      state[target.url] = { ...prev, name: target.name, status: 'error', last_error: r.error, checked: now };
      return;
    }

    const prevCats = prev.cats || {};
    const nowCats = {};
    for (const c of r.categories) nowCats[c.name] = c.available;
    const mergedCats = { ...prevCats, ...nowCats };

    // Notif UNIQUEMENT si une catégorie connue ÉPUISÉE repasse DISPO.
    const newly = r.categories
      .filter((c) => c.available && prevCats[c.name] === false)
      .map((c) => c.name);

    const available = Object.keys(mergedCats).filter((k) => mergedCats[k]);
    const soldout = Object.keys(mergedCats).filter((k) => !mergedCats[k]);

    if (newly.length > 0) {
      console.log(`🎟️  DISPO — ${target.name} : ${newly.join(', ')}`);
      try {
        await notifyAvailable(target, newly);
      } catch (err) {
        console.error(`   ↳ échec notification : ${err.message}`);
        exitCode = 1;
      }
    } else {
      console.log(`—  ${target.name} : ${available.length} dispo, rien de nouveau`);
    }

    state[target.url] = { name: target.name, status: 'ok', cats: mergedCats, available, soldout, checked: now };
  } catch (err) {
    console.error(`❌ ${target.name} — ${err.message}`);
    state[target.url] = { ...prev, name: target.name, status: 'error', last_error: String(err.message), checked: now };
    exitCode = 1;
  }
}

/** Exécute `worker` sur `items` avec au plus `limit` tâches simultanées. */
async function runPool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

try {
  await runPool(targets, CONCURRENCY, checkOne);
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
} finally {
  await closeBrowser().catch(() => {});
  rmSync(LOCK_FILE, { force: true });
}
process.exit(exitCode);
