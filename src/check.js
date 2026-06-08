import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { scrape, closeBrowser } from './scraper.js';
import { notifyAvailable } from './notifier.js';

/**
 * Mode "cron sans serveur" (GitHub Actions).
 * Lit targets.json, compare à state.json (état précédent), notifie les
 * nouvelles places, réécrit state.json (committé par le workflow).
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS_FILE = join(root, 'targets.json');
const STATE_FILE = join(root, 'state.json');

const targets = JSON.parse(readFileSync(TARGETS_FILE, 'utf8'));
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};

let exitCode = 0;

for (const t of targets) {
  if (t.enabled === false) continue;
  const target = {
    name: t.name || t.url,
    url: t.url,
    keyword: (t.keyword || 'Épuisé').trim(),
    wait_selector: t.wait_selector || null,
    click_text: t.click_text || null,
  };

  try {
    const r = await scrape(target);

    if (r.status === 'error') {
      console.log(`⚠️  ${target.name} — ${r.error}`);
      continue; // on garde l'état précédent, pas de fausse alerte
    }

    const prev = state[target.url]?.available || [];
    const newly = r.available.filter((c) => !prev.includes(c));

    if (newly.length > 0) {
      console.log(`🎟️  DISPO — ${target.name} : ${newly.join(', ')}`);
      try {
        await notifyAvailable(target, newly);
      } catch (err) {
        console.error(`   ↳ échec notification : ${err.message}`);
        exitCode = 1;
      }
    } else {
      console.log(`—  ${target.name} : ${r.available.length} dispo, rien de nouveau`);
    }

    state[target.url] = {
      name: target.name,
      available: r.available,
      soldout: r.soldout,
      checked: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`❌ ${target.name} — ${err.message}`);
    exitCode = 1;
  }
}

writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
await closeBrowser();
process.exit(exitCode);
