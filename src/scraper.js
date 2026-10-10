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

    const isNoise = (s) => NOISE_NAME.test(s) || SHIPPING_NAME.test(s);
    if (hasInlinePrice && stripped.length >= 2 && stripped.length <= 80 && !isNoise(stripped)) {
      headers.push({ name: cleanName(stripped, keyword), index: i }); // nom + prix même ligne
    } else if (nextIsPrice && !PRICE_RE.test(line) && line.length >= 2 && line.length <= 80 && !isNoise(line)) {
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
// Lignes internes au widget (sous-tarifs, placement…) ET options de livraison/retrait
// (« Lettre Expert (7.90€) », « DHL Express (18.90€) », « E-Ticket »…) → jamais des catégories.
const NOISE_NAME =
  /^(tarif\b|tarif normal|placement|auto|portes?\b|porte\b|choisir|choix|sélection|dès\b|à partir|from\b)/i;
const SHIPPING_NAME =
  /lettre|dhl|colissimo|chronopost|ups\b|fedex|e-?ticket|m-?ticket|billet électronique|retrait|livraison|envoi|expédition|impression|print|jumelles|coffret|assurance|frais de/i;

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

// Sélecteurs des deux structures Ticketmaster (interface 2026).
const SEL_GRID = 'li.session-price-item'; // page séance : grille tarifaire
const SEL_SESSIONS = 'li.event-sessions-item'; // page manifestation : choix de la séance

/**
 * Lecture DOM (fiable) : renvoie les catégories/séances, ou null si la page
 * n'utilise aucune des structures connues (→ on retombe sur l'analyse texte).
 */
async function extractFromDom(page) {
  return page.evaluate(
    ({ SEL_GRID, SEL_SESSIONS }) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const soldRe = /épuis|complet|sold\s*out/i;

      // A) Grille tarifaire (page séance) — signal fort : classe .is-sold-out
      const grid = [...document.querySelectorAll(SEL_GRID)];
      if (grid.length) {
        const cats = grid
          .map((li) => {
            const cat = li.querySelector('.session-price-cat');
            const name = clean(li.querySelector('.session-price-cat-title-txt')?.textContent);
            if (!name) return null;
            const status = clean(li.querySelector('.session-price-cat-title-status')?.textContent);
            const soldout = !!(cat && cat.classList.contains('is-sold-out')) || soldRe.test(status);
            return { name, soldout, available: !soldout };
          })
          .filter(Boolean);
        if (cats.length) return { mode: 'grid', categories: cats };
      }

      // B) Sélecteur de séances (page manifestation) — signal : is-disabled / radio disabled
      const sessions = [...document.querySelectorAll(SEL_SESSIONS)];
      if (sessions.length) {
        const cats = sessions
          .map((li) => {
            const name = clean(li.querySelector('.event-sessions-date')?.textContent);
            if (!name) return null;
            const status = clean(li.querySelector('.event-sessions-status')?.textContent);
            const radio = li.querySelector('input.event-sessions-radio');
            const soldout =
              li.classList.contains('is-disabled') || !!(radio && radio.disabled) || soldRe.test(status);
            return { name, soldout, available: !soldout };
          })
          .filter(Boolean);
        if (cats.length) return { mode: 'sessions', categories: cats };
      }

      return null;
    },
    { SEL_GRID, SEL_SESSIONS }
  );
}

/** Attend l'apparition d'une des structures connues (grille ou séances). */
async function waitForTmStructure(page) {
  for (let i = 0; i < 12; i++) {
    const found = await page
      .evaluate(
        ({ a, b }) => document.querySelectorAll(a).length > 0 || document.querySelectorAll(b).length > 0,
        { a: SEL_GRID, b: SEL_SESSIONS }
      )
      .catch(() => false);
    if (found) return true;
    await page.evaluate(() => window.scrollBy(0, 900)).catch(() => {});
    await page.waitForTimeout(600);
  }
  return false;
}

/**
 * Scrolle la page et relit le texte jusqu'à ce que le nombre de catégories
 * détectées se stabilise — garantit que la liste complète est chargée avant lecture.
 * Renvoie le texte final (celui avec le plus de catégories vu).
 */
async function waitForStableList(page, keyword) {
  let bestText = '';
  let bestCount = -1;
  let stable = 0;
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(600);
    const text = await page.evaluate(() => document.body.innerText || '');
    const count = parseCategories(text, keyword).length;
    if (count > bestCount || !bestText) {
      bestCount = Math.max(bestCount, count);
      bestText = text;
    }
    if (count === bestCount) stable++;
    else stable = 0;
    if (count > 0 && stable >= 3) break; // contenu chargé et stable → fini
    if (count === 0 && i >= 3) break; // toujours rien après 4 lectures → page sans tarifs (pas en vente)
  }
  return bestText;
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
    const resp = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);

    // 1) bandeau cookies (Didomi / OneTrust / générique)
    await acceptCookies(page);
    await page.waitForTimeout(800);

    // 2) bouton/onglet qui révèle la grille de tarifs (Ticketmaster : "Choix rapide par tarif").
    //    `click_text` permet de forcer un libellé précis par billetterie.
    await revealTariffs(page, target.click_text);

    if (target.wait_selector) {
      await page.waitForSelector(target.wait_selector, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    } else {
      await page.waitForTimeout(2500);
    }

    // 3) Lecture DOM en priorité (structures Ticketmaster : grille tarifaire ou
    //    sélecteur de séances). Bien plus fiable que l'analyse du texte brut.
    // Page de blocage anti-robot (« Erreur 403 ») : on le dit clairement au lieu
    // de faire comme si la grille était juste lente.
    const title = await page.title().catch(() => '');
    if ((resp && resp.status() === 403) || /erreur 403|access denied|forbidden|pas l.autorisation/i.test(title)) {
      return {
        status: 'error',
        blocked: true,
        available: [],
        soldout: [],
        categories: [],
        mode: 'blocked',
        text: null,
        error: 'Bloqué par Ticketmaster (erreur 403 anti-robot).',
      };
    }

    await waitForTmStructure(page);
    const dom = await extractFromDom(page).catch(() => null);

    let categories;
    let mode;
    let text = null;
    const isTicketmaster = /ticketmaster\./i.test(target.url);
    if (dom && dom.categories.length) {
      categories = dom.categories;
      mode = dom.mode;
    } else if (isTicketmaster) {
      // Sur Ticketmaster la structure est connue : si elle est absente, c'est que la
      // page n'est pas (encore) chargée. On NE tente PAS l'analyse texte, qui
      // confondrait les options de livraison avec des catégories.
      categories = [];
      mode = 'none';
    } else {
      // 4) Repli générique (autres billetteries uniquement) : analyse du texte rendu.
      text = await waitForStableList(page, target.keyword);
      categories = parseCategories(text, target.keyword);
      mode = 'text';
    }

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
      mode,
      text,
      error:
        categories.length === 0
          ? mode === 'none'
            ? 'Grille Ticketmaster non chargée (page lente, bloquée ou en file d’attente) — état conservé.'
            : 'Aucune catégorie détectée (page vide, bloquée ou mot-clé à ajuster).'
          : null,
    };
  } finally {
    await context.close();
  }
}
