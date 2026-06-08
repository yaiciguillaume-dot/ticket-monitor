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

    // État mémorisé par catégorie : { "CATEGORIE OR": true(=dispo)/false(=épuisé) }
    const prevCats = state[target.url]?.cats || {};
    const nowCats = {};
    for (const c of r.categories) nowCats[c.name] = c.available;

    // Fusion : on conserve l'historique des catégories momentanément absentes d'une
    // lecture, on n'écrase qu'avec ce qu'on a réellement revu cette fois-ci.
    const mergedCats = { ...prevCats, ...nowCats };

    // Notif UNIQUEMENT si une catégorie connue ÉPUISÉE passe à DISPO ce tour-ci.
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

    state[target.url] = {
      name: target.name,
      cats: mergedCats,
      available,
      soldout,
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
