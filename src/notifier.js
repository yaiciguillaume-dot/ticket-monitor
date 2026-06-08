import nodemailer from 'nodemailer';

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  MAIL_FROM,
  MAIL_TO,
} = process.env;

let mailer = null;
if (SMTP_HOST && SMTP_USER) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: String(SMTP_SECURE) === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

export const channels = {
  telegram: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
  email: Boolean(mailer && MAIL_TO),
};

async function sendTelegram(text) {
  if (!channels.telegram) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
  });
  if (!res.ok) {
    console.error('[telegram] erreur', res.status, await res.text().catch(() => ''));
  }
}

async function sendEmail(subject, html) {
  if (!channels.email) return;
  await mailer.sendMail({
    from: MAIL_FROM || SMTP_USER,
    to: MAIL_TO,
    subject,
    html,
  });
}

/**
 * Notifie qu'une ou plusieurs places se sont libérées.
 */
export async function notifyAvailable(target, newlyAvailable) {
  const title = target.name || target.url;
  const cats = newlyAvailable.join(', ');

  const tg =
    `🎟️ <b>PLACES DISPONIBLES</b>\n\n` +
    `<b>${escapeHtml(title)}</b>\n` +
    `Catégorie(s) : <b>${escapeHtml(cats)}</b>\n\n` +
    `👉 ${escapeHtml(target.url)}`;

  const mailHtml =
    `<h2>🎟️ Places disponibles</h2>` +
    `<p><strong>${escapeHtml(title)}</strong></p>` +
    `<p>Catégorie(s) : <strong>${escapeHtml(cats)}</strong></p>` +
    `<p><a href="${escapeHtml(target.url)}">Ouvrir la billetterie</a></p>`;

  await Promise.allSettled([
    sendTelegram(tg),
    sendEmail(`🎟️ Places dispo — ${title}`, mailHtml),
  ]);
}

export async function sendTest() {
  await Promise.allSettled([
    sendTelegram('✅ Ticket Monitor : test de notification Telegram OK.'),
    sendEmail('✅ Ticket Monitor — test', '<p>Test de notification email OK.</p>'),
  ]);
}

function escapeHtml(s = '') {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
