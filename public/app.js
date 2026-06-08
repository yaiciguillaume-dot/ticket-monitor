const $ = (s) => document.querySelector(s);
const listEl = $('#list');
const eventsEl = $('#events');

let config = { channels: {}, defaultInterval: 60 };

// ─── Notifications navigateur + son ───────────────────────
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = [880, 1175, 880];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = f; o.type = 'sine';
      const t = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.001, t);
      g.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      o.start(t); o.stop(t + 0.17);
    });
  } catch { /* ignore */ }
}
function browserNotify(title, body, url) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, icon: '/favicon.ico', requireInteraction: true });
  if (url) n.onclick = () => window.open(url, '_blank');
}

// ─── Rendu ────────────────────────────────────────────────
function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
const STATUS_LABEL = { available: 'PLACES DISPO', soldout: 'Complet', error: 'Erreur', pending: 'En attente…' };

function targetCard(t) {
  const cls = t.enabled ? t.last_status : 'disabled ' + t.last_status;
  const cats = t.available.length
    ? `<div class="cats">${t.available.map((c) => `<span class="cat">🎟️ ${esc(c)}</span>`).join('')}</div>`
    : '';
  const err = t.last_error ? `<div class="err">⚠️ ${esc(t.last_error)}</div>` : '';
  return `
    <div class="target ${cls}" data-id="${t.id}">
      <div class="top">
        <div>
          <div class="name">${esc(t.name || t.url)}</div>
          <a class="url" href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.url)}</a>
        </div>
        <span class="badge ${t.last_status}">${STATUS_LABEL[t.last_status] || t.last_status}</span>
      </div>
      ${cats}
      ${err}
      <div class="meta">
        <span>⏱️ toutes les ${t.interval_sec}s</span>
        <span>🔍 « ${esc(t.keyword)} »</span>
        <span>maj : ${fmtTime(t.last_checked)}</span>
        <span class="actions">
          <button class="ghost" data-act="check">Vérifier</button>
          <button class="ghost" data-act="toggle">${t.enabled ? 'Pause' : 'Reprendre'}</button>
          <button class="ghost" data-act="delete">Suppr.</button>
        </span>
      </div>
    </div>`;
}

async function loadTargets() {
  const targets = await fetch('/api/targets').then((r) => r.json());
  if (!targets.length) {
    listEl.innerHTML = `<div class="card empty">Aucune billetterie surveillée. Ajoute une URL ci-dessus 👆</div>`;
    return;
  }
  listEl.innerHTML = targets.map(targetCard).join('');
}

async function loadEvents() {
  const events = await fetch('/api/events').then((r) => r.json());
  eventsEl.innerHTML = events.length
    ? events.map((e) => `<li class="${e.type}"><span class="t">${fmtTime(e.created_at)}</span><span>${esc(e.message || e.type)}</span></li>`).join('')
    : `<li class="empty">Aucun événement pour l'instant.</li>`;
}

// ─── Actions ──────────────────────────────────────────────
$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    url: f.url.value,
    name: f.name.value,
    keyword: f.keyword.value,
    interval_sec: Number(f.interval_sec.value),
    wait_selector: f.wait_selector.value,
  };
  const res = await fetch('/api/targets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) { alert((await res.json()).error || 'Erreur'); return; }
  f.url.value = ''; f.name.value = '';
  loadTargets();
});

listEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.target').dataset.id;
  const act = btn.dataset.act;
  if (act === 'delete') {
    if (!confirm('Supprimer cette surveillance ?')) return;
    await fetch(`/api/targets/${id}`, { method: 'DELETE' });
  } else if (act === 'toggle') {
    await fetch(`/api/targets/${id}/toggle`, { method: 'POST' });
  } else if (act === 'check') {
    btn.textContent = '…';
    await fetch(`/api/targets/${id}/check`, { method: 'POST' });
  }
  loadTargets();
});

$('#testBtn').addEventListener('click', async () => {
  beep();
  await fetch('/api/test-notify', { method: 'POST' });
  alert('Notification de test envoyée (Telegram/Email si configurés). Un son a aussi été joué.');
});

// ─── Temps réel (SSE) ─────────────────────────────────────
function connectStream() {
  const es = new EventSource('/api/stream');
  es.onopen = () => $('#conn').className = 'pill on', $('#conn').textContent = '● en ligne';
  es.onerror = () => { $('#conn').className = 'pill off'; $('#conn').textContent = '● reconnexion…'; };
  es.addEventListener('update', () => { loadTargets(); loadEvents(); });
  es.addEventListener('alert', (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === 'available') {
      beep();
      browserNotify('🎟️ Places disponibles !', `${data.name}\n${data.message}`, null);
    }
    loadEvents();
  });
}

async function init() {
  config = await fetch('/api/config').then((r) => r.json());
  $('#tg').className = 'pill ' + (config.channels.telegram ? 'on' : 'off');
  $('#mail').className = 'pill ' + (config.channels.email ? 'on' : 'off');
  $("input[name=interval_sec]").value = config.defaultInterval;
  await loadTargets();
  await loadEvents();
  connectStream();
}
function esc(s = '') { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
init();
