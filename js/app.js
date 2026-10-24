// Einstiegspunkt: Navigation, Erinnerungen, Service Worker
import { h, todayISO, prevMonthKey, MONTHS } from './util.js';
import { S, load } from './store.js';
import { nav, icon, toast } from './ui.js';
import { renderDay } from './view-day.js';
import { renderCalendar } from './view-calendar.js';
import { renderTrips } from './view-trips.js';
import { renderReport } from './view-report.js';
import { renderSettings } from './view-settings.js';

const VIEWS = {
  day: ['Erfassen', 'day', renderDay],
  calendar: ['Kalender', 'calendar', renderCalendar],
  trips: ['Dienstreisen', 'trips', renderTrips],
  report: ['Auswertung', 'report', renderReport],
  settings: ['Einstellungen', 'settings', renderSettings],
};

let updateBanner = null;

function banners() {
  const box = document.getElementById('banners');
  box.replaceChildren();
  if (updateBanner) box.append(updateBanner);
  const prev = prevMonthKey(todayISO());
  const [py, pm] = prev.split('-').map(Number);
  const pendingReceipts = S.data.receipts.filter((r) => r.date.slice(0, 7) === prev && r.hasBlob).length;
  if (S.meta.lastMonthlyBackup !== prev && pendingReceipts > 0 && S.view !== 'report') {
    box.append(h('div', { class: 'banner' }, h('div', { class: 'grow' }, `Monatssicherung für ${MONTHS[pm - 1]} ${py} offen (${pendingReceipts} Beleg${pendingReceipts === 1 ? '' : 'e'}).`),
      h('button', { class: 'btn s', type: 'button', onclick: () => nav.go('report') }, 'Jetzt sichern')));
  }
  const hasData = S.data.legs.length + S.data.trips.length > 0;
  const lastFull = S.meta.lastFullBackupAt || S.meta.installedAt || Date.now();
  if (hasData && Date.now() - lastFull > 35 * 86400000 && S.view !== 'settings') {
    box.append(h('div', { class: 'banner info' }, h('div', { class: 'grow' }, 'Die letzte Vollsicherung ist über einen Monat her.'),
      h('button', { class: 'btn s', type: 'button', onclick: () => nav.go('settings') }, 'Sichern')));
  }
}

function tabs() {
  const t = document.getElementById('tabs');
  const inner = h('div', { class: 'inner' });
  for (const [key, [label, ic]] of Object.entries(VIEWS)) {
    const b = h('button', { class: S.view === key ? 'on' : '', type: 'button', 'aria-label': label, 'aria-current': S.view === key ? 'page' : null, onclick: () => nav.go(key) }, icon(ic), label);
    inner.append(b);
  }
  t.replaceChildren(inner);
}

function render() {
  const scroll = window.scrollY;
  const [label, , fn] = VIEWS[S.view];
  document.getElementById('title').textContent = label;
  document.getElementById('sub').textContent = '';
  const main = document.getElementById('main');
  main.replaceChildren();
  try { fn(main); }
  catch (e) { console.error(e); main.append(h('div', { class: 'card' }, h('h3', null, 'Fehler in der Anzeige'), h('p', { class: 'small' }, String(e && e.message || e)))); }
  tabs(); banners();
  window.scrollTo(0, scroll);
}

nav.render = render;
nav.go = (view) => { S.view = view; window.scrollTo(0, 0); render(); };

async function init() {
  try { await load(); }
  catch (e) {
    document.getElementById('main').append(h('div', { class: 'card' }, h('h3', null, 'Speicher nicht verfügbar'),
      h('p', null, 'Die lokale Datenbank konnte nicht geöffnet werden. Bitte nicht im privaten Modus nutzen und die App über „Zum Home-Bildschirm“ installieren.'), h('p', { class: 'small muted' }, String(e && e.message || e))));
    return;
  }
  // Erster Start: direkt zu den Einstellungen
  if (!S.data.settings.bundesland && !S.data.legs.length && !S.data.periods.length) S.view = 'settings';
  render();
  registerSW();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

function registerSW() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const offer = (worker) => {
      updateBanner = h('div', { class: 'banner info' }, h('div', { class: 'grow' }, 'Eine neue Version der App ist verfügbar.'),
        h('button', { class: 'btn s', type: 'button', onclick: () => worker.postMessage('skipWaiting') }, 'Aktualisieren'));
      banners();
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
    // Beim Öffnen mit Internet nach Updates suchen
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloaded || !hadController) return; reloaded = true; location.reload(); });
}

init();
