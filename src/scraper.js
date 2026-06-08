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

/** Nettoie un nom de catégorie : retire mot-clé, contrôles (+ −) et espaces multiples. */
function cleanName(raw, keyword) {
  return raw
    .replace(new RegExp(keyword, 'ig'), '')
    .replace(/[−–—+]/g, ' ')
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

    if (hasInlinePrice && stripped.length >= 2 && stripped.length <= 80 && !NOISE_NAME.test(stripped)) {
      headers.push({ name: cleanName(stripped, keyword), index: i }); // nom + prix même ligne
    } else if (nextIsPrice && !PRICE_RE.test(line) && line.length >= 2 && line.length <= 80 && !NOISE_NAME.test(line)) {
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
  // Déduplique par nom (les widgets répètent parfois un libellé).
  const seen = new Set();
  return categories.filter((c) => {
    const key = c.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Lignes génériques internes au widget (sous-tarifs, placement…) → pas des catégories.
const NOISE_NAME = /^(tarif\b|tarif normal|placement|auto|portes?\b|porte\b|choisir|choix|sélection|dès\b|à partir|from\b)/i;

// Sélecteurs de bouton "accepter les cookies" (CSS + texte). Didomi en premier (Ticketmaster).
const COOKIE_SELECTORS = [
  '#didomi-notice-agree-button',
  'button#onetrust-accept-btn-handler',
  'button:has-text("Tout accepter")',
  'button:has-text("J\'accepte")',
  'button:has-text("J’accepte")',
  'button:has-text("Accepter")',
  'button:has-text("Accept all")',
];
// Widgets cachés derrière un bouton/onglet à cliquer pour afficher les tarifs.
const REVEAL_LABELS = ['choix rapide par tarif', 'choisissez vos places', 'voir les billets', 'acheter des billets'];

async function tryClick(page, selector, timeout = 1500) {
  try {
    const loc = page.locator(selector).first();
    if (await loc.isVisible({ timeout })) {
      await loc.click({ timeout: 2500 });
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function acceptCookies(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const sel of COOKIE_SELECTORS) {
      if (await tryClick(page, sel, 1200)) {
        await page.waitForTimeout(700);
        return true;
      }
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

async function revealTariffs(page, extraLabel) {
  const labels = extraLabel ? [extraLabel, ...REVEAL_LABELS] : REVEAL_LABELS;
  for (const label of labels) {
    try {
      const loc = page.getByText(new RegExp(label, 'i')).first();
      if (await loc.isVisible({ timeout: 1500 })) {
        await loc.click({ timeout: 2500 });
        return label;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
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
    await page.waitForTimeout(1500);

    // 1) bandeau cookies (Didomi / OneTrust / générique)
    await acceptCookies(page);
    await page.waitForTimeout(800);

    // 2) bouton/onglet qui révèle la grille de tarifs (Ticketmaster : "Choix rapide par tarif").
    //    `click_text` permet de forcer un libellé précis par billetterie.
    await revealTariffs(page, target.click_text);

    if (target.wait_selector) {
      await page.waitForSelector(target.wait_selector, { timeout: 15000 }).catch(() => {});
    } else {
      // laisse le widget JS se charger
      await page.waitForTimeout(4000);
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
