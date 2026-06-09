// ==UserScript==
// @name         Ticket Monitor — Fast Track (Ticketmaster)
// @namespace    ticket-monitor
// @version      1.0
// @description  À l'ouverture d'une page Ticketmaster : accepte les cookies, déplie "Choix rapide par tarif" et surligne en vert les catégories disponibles (+ scroll dessus). Tu n'as plus qu'à cliquer "+" et payer.
// @match        https://www.ticketmaster.fr/fr/manifestation/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Trouve l'élément cliquable le plus précis contenant un texte donné.
  function findByText(re) {
    const els = [...document.querySelectorAll('a,button,span,div,li,h3,p,[role="button"],[role="tab"]')];
    return els
      .filter((e) => re.test((e.textContent || '').trim()) && e.offsetParent !== null)
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
  }

  async function acceptCookies() {
    for (let i = 0; i < 12; i++) {
      const btn = document.querySelector('#didomi-notice-agree-button');
      if (btn) { btn.click(); return; }
      await sleep(400);
    }
  }

  async function openGrid() {
    for (let i = 0; i < 20; i++) {
      if (document.querySelector('ul.session-price-list')) return true; // déjà ouverte
      const el = findByText(/choix rapide par tarif/i);
      if (el) el.click();
      await sleep(500);
    }
    return !!document.querySelector('ul.session-price-list');
  }

  function markAvailable() {
    const items = [...document.querySelectorAll('li.session-price-item')];
    let firstAvail = null;
    let nAvail = 0;
    items.forEach((li) => {
      const status = li.querySelector('.session-price-cat-title-status');
      const soldout = status && /épuis/i.test(status.textContent || '');
      const cat = li.querySelector('.session-price-cat');
      if (!cat) return;
      if (soldout) {
        cat.style.opacity = '0.45';
      } else {
        nAvail++;
        cat.style.outline = '3px solid #22c55e';
        cat.style.outlineOffset = '2px';
        cat.style.borderRadius = '6px';
        const title = li.querySelector('.session-price-cat-title-txt');
        if (title && !title.dataset.tmFlag) {
          const badge = document.createElement('span');
          badge.textContent = '  ✅ DISPO';
          badge.style.cssText = 'color:#16a34a;font-weight:800;';
          title.appendChild(badge);
          title.dataset.tmFlag = '1';
        }
        if (!firstAvail) firstAvail = li;
      }
    });
    if (firstAvail) firstAvail.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showBanner(nAvail);
  }

  function showBanner(n) {
    let bar = document.getElementById('tm-fasttrack-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'tm-fasttrack-bar';
      bar.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:99999;padding:10px 16px;' +
        'font:700 14px system-ui,-apple-system;text-align:center;color:#fff;';
      document.body.appendChild(bar);
    }
    if (n > 0) {
      bar.style.background = '#16a34a';
      bar.textContent = `🎟️ ${n} catégorie(s) disponible(s) — surlignée(s) en vert. Clique "+" puis paie !`;
    } else {
      bar.style.background = '#dc2626';
      bar.textContent = '🔴 Tout épuisé pour l’instant.';
    }
    setTimeout(() => bar && bar.remove(), 9000);
  }

  async function run() {
    try {
      await acceptCookies();
      await sleep(400);
      if (!(await openGrid())) return;
      await sleep(1200);
      markAvailable();
      setTimeout(markAvailable, 2500); // re-scan si la grille charge en différé
    } catch (e) {
      console.error('[fast-track]', e);
    }
  }
  run();
})();
