import { chromium } from 'playwright';

let browserPromise = null;

/** Lance (et réutilise) une seule instance de navigateur headless. */
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close();
    browserPromise = null;
  }
}

const PRICE_RE = /\d+[.,]\d{2}\s*€/;

const isPriceOnly = (l) => PRICE_RE.test(l) && l.replace(PRICE_RE, '').trim() === '';

/** Nettoie un nom de catégorie : retire mot-clé, contrôles (+ − 0) et espaces multiples. */
function cleanName(raw, keyword) {
  return raw
    .replace(new RegExp(keyword, 'ig'), '')
    .replace(/[−–—+]/g, ' ')
    .replace(/\s+\d+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Découpe le texte rendu en "catégories".
 * Une catégorie = un nom directement accolé à un prix, soit sur la même ligne
 * ("CARRE OR  150.00 €"), soit sur la ligne juste avant un prix isolé.
 * Elle est "complète" si le mot-clé (ex: "Épuisé") apparaît dans son bloc.
 */
function parseCategories(text, keyword) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const headers = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.replace(PRICE_RE, '').trim();
    const hasInlinePrice = PRICE_RE.test(line) && stripped.length > 0;
    const nextIsPrice = i + 1 < lines.length && isPriceOnly(lines[i + 1]);

    if (hasInlinePrice && stripped.length >= 2 && stripped.length <= 80) {
      headers.push({ name: cleanName(stripped, keyword), index: i }); // nom + prix même ligne
    } else if (nextIsPrice && !PRICE_RE.test(line) && line.length >= 2 && line.length <= 80) {
      headers.push({ name: cleanName(line, keyword), index: i }); // nom suivi d'un prix isolé
    }
  }

  const kw = keyword.toLowerCase();
  const categories = [];
  for (let h = 0; h < headers.length; h++) {
    const start = headers[h].index;
    const end = h + 1 < headers.length ? headers[h + 1].index : lines.length;
    const block = lines.slice(start, end).join(' ');
    const soldout = block.toLowerCase().includes(kw);
    categories.push({ name: headers[h].name, soldout, available: !soldout });
  }
  return categories;
}

const COOKIE_LABELS = ['accepter', 'tout accepter', 'accept', 'accept all', 'ok', "j'accepte"];

async function tryAcceptCookies(page) {
  for (const label of COOKIE_LABELS) {
    try {
      const btn = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
      if (await btn.isVisible({ timeout: 800 })) {
        await btn.click({ timeout: 1500 });
        await page.waitForTimeout(400);
        return;
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Visite l'URL, attend le rendu JS et renvoie l'état des catégories.
 * @returns {{ status, available: string[], soldout: string[], categories, text }}
 */
export async function scrape(target) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    locale: 'fr-FR',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await tryAcceptCookies(page);

    if (target.wait_selector) {
      await page.waitForSelector(target.wait_selector, { timeout: 15000 }).catch(() => {});
    } else {
      // laisse le widget JS se charger
      await page.waitForTimeout(3500);
    }

    const text = await page.evaluate(() => document.body.innerText || '');
    const categories = parseCategories(text, target.keyword);
    const available = categories.filter((c) => c.available).map((c) => c.name);
    const soldout = categories.filter((c) => c.soldout).map((c) => c.name);

    let status;
    if (categories.length === 0) status = 'error';
    else status = available.length > 0 ? 'available' : 'soldout';

    return {
      status,
      available,
      soldout,
      categories,
      error: categories.length === 0 ? 'Aucune catégorie détectée (page vide, bloquée ou mot-clé à ajuster).' : null,
    };
  } finally {
    await context.close();
  }
}
