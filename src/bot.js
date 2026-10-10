import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { scrape, closeBrowser } from './scraper.js';

/**
 * Bot Telegram : piloter le monitoring depuis le téléphone.
 * Commandes : /status /add /remove /pause /resume /help
 * Partage targets.json + state.json avec l'agent de vérification (check.js).
 */
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED = String(process.env.TELEGRAM_CHAT_ID || '');
if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN manquant dans .env');
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS_FILE = join(root, 'targets.json');
const STATE_FILE = join(root, 'state.json');
const api = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;

const readJson = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);
const writeTargets = (t) => writeFileSync(TARGETS_FILE, JSON.stringify(t, null, 2) + '\n');
const esc = (s = '') => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(chatId, text, keyboard) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (keyboard) body.reply_markup = keyboard;
  try {
    await fetch(api('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error('send err', e.message);
  }
}

const MENU = {
  keyboard: [['/status'], ['/add ', '/help']],
  resize_keyboard: true,
};

const HELP =
  '🎟️ <b>Ticket Monitor</b>\n\n' +
  'Voici ce que je sais faire :\n\n' +
  '📊 <b>/status</b> — l\'état en direct de tes spectacles\n' +
  '➕ <b>/add &lt;lien&gt;</b> [nom] — suivre un nouveau spectacle\n' +
  '   <i>ex : /add https://www.ticketmaster.fr/...</i>\n' +
  '🗑️ <b>/remove &lt;n&gt;</b> — arrêter de suivre le spectacle n°n\n' +
  '⏸️ <b>/pause &lt;n&gt;</b> · ▶️ <b>/resume &lt;n&gt;</b>\n' +
  '❓ <b>/help</b> — ce message\n\n' +
  'Je te préviens automatiquement dès qu\'une place se libère. 📲';

const NOISE_SEG = /^(fr|en|de|es|it|www|manifestation|evenement|event|billet|billets|tickets|spectacle|concert|artist|venue|fra)$/i;

function deriveName(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname
      .split('/')
      .filter(Boolean)
      .filter((s) => !NOISE_SEG.test(s) && !/^\d+$/.test(s) && !/^id/i.test(s))
      .sort((a, b) => b.length - a.length)[0];
    if (seg) {
      return seg
        .replace(/[-_]billets?$/i, '')
        .replace(/[-_]/g, ' ')
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// Une lecture est « fraîche » si la dernière lecture RÉUSSIE date de moins de 20 min.
const READ_STALE_MIN = 20;
const fmtWhen = (iso) => {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const isFresh = (st) => !!st?.last_ok && (Date.now() - Date.parse(st.last_ok)) / 60000 < READ_STALE_MIN;

function statusText() {
  const targets = readJson(TARGETS_FILE, []);
  const state = readJson(STATE_FILE, {});
  if (!targets.length) return 'Aucun spectacle suivi pour l\'instant.\nAjoute-en un avec <b>/add &lt;lien&gt;</b>';

  let out = '🎫 <b>Tes spectacles suivis</b>\n';
  targets.forEach((t, i) => {
    const st = state[t.url];
    const paused = t.enabled === false ? ' ⏸️ <i>(en pause)</i>' : '';
    out += `\n<b>${i + 1}. ${esc(t.name || t.url)}</b>${paused}\n`;
    if (!st) {
      out += '   ⏳ pas encore vérifié…\n';
      return;
    }
    const av = st.available || [];
    if (isFresh(st)) {
      if (av.length) out += `   🟢 <b>DISPO</b> : ${esc(av.join(', '))}\n`;
      else out += '   🔴 tout épuisé\n';
      out += `   <i>vérifié à ${fmtWhen(st.last_ok)}</i>\n`;
    } else {
      // Données périmées : on ne prétend PAS savoir.
      const why = st.blocked ? 'Ticketmaster bloque le tracker (403)' : esc(st.last_error || 'erreur de lecture');
      out += `   ⚠️ <b>Statut inconnu</b> — ${why}\n`;
      out += st.last_ok
        ? `   <i>dernière lecture réussie : ${fmtWhen(st.last_ok)}</i>\n`
        : '   <i>jamais lu avec succès</i>\n';
      out += '   👉 vérifie directement sur la page\n';
    }
  });
  return out;
}

async function handleAdd(chatId, arg) {
  const parts = arg.trim().split(/\s+/);
  const url = parts[0];
  if (!/^https?:\/\//i.test(url)) {
    return send(chatId, '❌ Donne-moi un lien valide.\nEx : <b>/add https://www.ticketmaster.fr/...</b>');
  }
  const targets = readJson(TARGETS_FILE, []);
  if (targets.some((t) => t.url === url)) {
    return send(chatId, '⚠️ Ce lien est déjà dans ta liste. Fais /status pour le voir.');
  }
  const name = parts.slice(1).join(' ') || deriveName(url);
  const isTM = /ticketmaster\./i.test(url);
  const target = {
    name,
    url,
    keyword: 'Épuisé',
    click_text: isTM ? 'Choix rapide par tarif' : null,
    wait_selector: null,
    enabled: true,
  };

  await send(chatId, `🔎 J'analyse <b>${esc(name)}</b>, un instant…`);
  let baseline = null;
  try {
    const r = await scrape(target);
    if (r.status === 'error') {
      await send(chatId, `⚠️ Ajouté, mais je n'ai pas pu lire les tarifs maintenant (${esc(r.error)}).\nJe réessaie tout seul toutes les 2 min.`);
    } else {
      baseline = r;
      const dispo = r.available.length ? `🟢 Dispo : <b>${esc(r.available.join(', '))}</b>` : '🔴 Tout épuisé pour l\'instant';
      await send(chatId, `✅ <b>${esc(name)}</b> ajouté !\n${dispo}\n\nJe te préviens dès qu'une place se libère.`);
    }
  } catch (e) {
    await send(chatId, '⚠️ Ajouté, mais lecture impossible à l\'instant. Je réessaierai automatiquement.');
  } finally {
    await closeBrowser().catch(() => {});
  }

  targets.push(target);
  writeTargets(targets);

  // Écrit une base de référence pour ne pas re-notifier les dispos déjà connues.
  if (baseline) {
    try {
      const state = readJson(STATE_FILE, {});
      const cats = {};
      for (const c of baseline.categories) cats[c.name] = c.available;
      state[url] = {
        name,
        cats,
        available: baseline.available,
        soldout: baseline.soldout,
        checked: new Date().toISOString(),
        last_ok: new Date().toISOString(),
      };
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
    } catch {
      /* ignore */
    }
  }
}

function handleIndexCmd(chatId, arg, action) {
  const targets = readJson(TARGETS_FILE, []);
  const n = Number(arg.trim());
  if (!n || n < 1 || n > targets.length) {
    return send(chatId, `❌ Numéro invalide. Fais /status pour voir les numéros.`);
  }
  const t = targets[n - 1];
  if (action === 'remove') {
    targets.splice(n - 1, 1);
    writeTargets(targets);
    return send(chatId, `🗑️ <b>${esc(t.name)}</b> retiré de la surveillance.`);
  }
  if (action === 'pause') t.enabled = false;
  if (action === 'resume') t.enabled = true;
  writeTargets(targets);
  return send(chatId, `${action === 'pause' ? '⏸️ En pause' : '▶️ Réactivé'} : <b>${esc(t.name)}</b>`);
}

async function handleUpdate(u) {
  const msg = u.message || u.edited_message;
  if (!msg || !msg.text) return;
  const chatId = String(msg.chat.id);
  if (ALLOWED && chatId !== ALLOWED) return; // ne répond qu'à toi

  const text = msg.text.trim();
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, '');
  const arg = rest.join(' ');

  switch (cmd) {
    case '/start':
    case '/help':
      return send(chatId, HELP, MENU);
    case '/status':
    case '/list':
      return send(chatId, statusText(), MENU);
    case '/add':
      return handleAdd(chatId, arg);
    case '/remove':
    case '/supprimer':
      return handleIndexCmd(chatId, arg, 'remove');
    case '/pause':
      return handleIndexCmd(chatId, arg, 'pause');
    case '/resume':
      return handleIndexCmd(chatId, arg, 'resume');
    default:
      if (/^https?:\/\//i.test(text)) return handleAdd(chatId, text); // lien collé directement
      return send(chatId, 'Commande inconnue. Tape /help pour voir ce que je sais faire.', MENU);
  }
}

// ── Heartbeat : alerte si la surveillance est arrêtée (Mac endormi) OU si des
//    spectacles ne sont plus lisibles (blocage, page changée…). Basé sur la dernière
//    lecture RÉUSSIE, pas sur le dernier essai — sinon une panne reste silencieuse. ──
const AGENT_STALE_MIN = 25;
let agentStalled = false;
let blindKey = '';
async function heartbeat() {
  const targets = readJson(TARGETS_FILE, []).filter((t) => t.enabled !== false);
  const state = readJson(STATE_FILE, {});

  // 1) L'agent tourne-t-il encore ?
  const lastTry = Math.max(0, ...Object.values(state).map((v) => Date.parse(v.checked || 0) || 0));
  const tryAge = lastTry ? (Date.now() - lastTry) / 60000 : 0;
  if (lastTry && tryAge > AGENT_STALE_MIN && !agentStalled) {
    agentStalled = true;
    await send(
      ALLOWED,
      `⚠️ <b>Surveillance en pause</b>\nAucune vérification depuis ${Math.round(tryAge)} min.\n` +
        'Ton Mac est probablement endormi ou débranché → rebranche-le / garde-le ouvert.'
    );
  } else if (tryAge <= AGENT_STALE_MIN && agentStalled) {
    agentStalled = false;
    await send(ALLOWED, '✅ <b>Surveillance reprise</b> — les vérifications ont redémarré.');
  }

  // 2) Des spectacles sont-ils « aveugles » (plus lus avec succès) ?
  const blind = targets.filter((t) => state[t.url] && !isFresh(state[t.url]));
  const key = blind.map((t) => t.url).sort().join('|');
  if (key === blindKey) return;
  const wasBlind = !!blindKey;
  blindKey = key;
  if (blind.length) {
    const blocked = blind.some((t) => state[t.url]?.blocked);
    const lines = blind.map((t) => `• ${esc(t.name)}`).join('\n');
    await send(
      ALLOWED,
      `🚨 <b>Le tracker ne voit plus ces spectacles</b> (statut inconnu, ne te fie pas au « épuisé ») :\n${lines}\n\n` +
        (blocked
          ? 'Cause : <b>Ticketmaster bloque le tracker (erreur 403)</b>.'
          : `Cause : ${esc(state[blind[0].url]?.last_error || 'lecture impossible')}`)
    );
  } else if (wasBlind) {
    await send(ALLOWED, '✅ <b>Lecture rétablie</b> — tous tes spectacles sont de nouveau surveillés.');
  }
}

async function main() {
  console.log('🤖 Bot Telegram démarré.');
  // message de démarrage + clavier de commandes
  if (ALLOWED) await send(ALLOWED, '🤖 Bot en ligne. Tape /status pour voir tes spectacles, ou /help.', MENU);

  // Vérifie l'état de la surveillance toutes les 3 min.
  if (ALLOWED) setInterval(() => heartbeat().catch(() => {}), 3 * 60 * 1000);

  let offset = 0;
  while (true) {
    try {
      const res = await fetch(api('getUpdates') + `?timeout=30&offset=${offset}`);
      const data = await res.json();
      if (data.ok) {
        for (const upd of data.result) {
          offset = upd.update_id + 1;
          await handleUpdate(upd).catch((e) => console.error('handle err', e.message));
        }
      }
    } catch (e) {
      console.error('poll err', e.message);
      await sleep(3000);
    }
  }
}

main();
