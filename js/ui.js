// UI-Bausteine: Dialoge, Meldungen, Formularfelder, Belege
import { h, euro, fmtDate } from './util.js';
import * as db from './db.js';
import { S, addReceipt, deleteReceipt, receiptById } from './store.js';

const layer = () => document.getElementById('layer');

export function toast(msg, ms = 2600) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  layer().appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// Dialog. actions: [{label, kind, onClick}] – onClick darf false liefern, dann bleibt der Dialog offen
export function modal({ title, body, actions = [], onClose }) {
  const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', esc); if (onClose) onClose(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  const sheet = h('div', { class: 'sheet' }, title ? h('h2', null, title) : null, body,
    actions.length ? h('div', { class: 'acts' }, actions.map((a) => h('button', {
      class: 'btn ' + (a.kind || ''), type: 'button',
      onclick: async (ev) => {
        ev.target.disabled = true;
        try { const r = a.onClick ? await a.onClick() : undefined; if (r !== false) close(); else ev.target.disabled = false; }
        catch (e) { ev.target.disabled = false; toast('Fehler: ' + (e.message || e)); }
      },
    }, a.label))) : null);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.appendChild(sheet);
  layer().appendChild(overlay);
  return { close, el: sheet };
}

export function confirmDialog(text, { ok = 'OK', cancel = 'Abbrechen', danger = false, title = '' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    modal({
      title, body: h('p', { style: { whiteSpace: 'pre-line' } }, text),
      actions: [{ label: cancel, onClick: () => fin(false) }, { label: ok, kind: danger ? 'danger' : 'primary', onClick: () => fin(true) }],
      onClose: () => fin(false),
    });
  });
}

export function infoDialog(title, body) {
  return new Promise((resolve) => modal({ title, body: typeof body === 'string' ? h('p', { style: { whiteSpace: 'pre-line' } }, body) : body, actions: [{ label: 'OK', kind: 'primary', onClick: () => resolve() }], onClose: resolve }));
}

export function busy(text) {
  const bar = h('i', { style: { width: '35%' } });
  const m = modal({ title: text, body: h('div', { class: 'progress' }, bar) });
  let w = 35;
  const iv = setInterval(() => { w = (w + 9) % 100; bar.style.width = (w < 20 ? 20 : w) + '%'; }, 250);
  return { done: () => { clearInterval(iv); m.close(); } };
}

export function field(label, input, hint) {
  return h('div', { class: 'field' }, h('label', null, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
}

export function select(options, value, onchange, attrs = {}) {
  const el = h('select', { ...attrs }, options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t)));
  if (onchange) el.addEventListener('change', () => onchange(el.value));
  return el;
}

export function textInput(value, onchange, attrs = {}) {
  const el = h('input', { type: 'text', value: value ?? '', ...attrs });
  if (onchange) el.addEventListener('input', () => onchange(el.value));
  return el;
}

export function numInput(value, onchange, attrs = {}) {
  const el = h('input', { type: 'text', inputmode: 'decimal', value: value === 0 || value ? String(value).replace('.', ',') : '', ...attrs });
  if (onchange) el.addEventListener('input', () => onchange(el.value));
  return el;
}

export function dateInput(value, onchange, attrs = {}) {
  const el = h('input', { type: 'date', value: value || '', ...attrs });
  if (onchange) el.addEventListener('change', () => onchange(el.value));
  return el;
}

export function checkbox(label, checked, onchange) {
  const cb = h('input', { type: 'checkbox', checked: !!checked });
  cb.addEventListener('change', () => onchange(cb.checked));
  return h('label', { class: 'check' }, cb, h('span', null, label));
}

export const ICONS = {
  day: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13 7l4 4"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3.5v3M16 3.5v3"/></svg>',
  trips: '<svg viewBox="0 0 24 24"><path d="M3 15l18-8-6 13-3-5-9 0z"/><path d="M12 15l9-8"/></svg>',
  report: '<svg viewBox="0 0 24 24"><path d="M6 3.5h9l4 4V20.5H6z"/><path d="M9 12h7M9 16h7M9 8.5h3"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-.9c.6.5 1.3.9 2 1.2l.4 2.6h4l.4-2.6c.7-.3 1.4-.7 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/></svg>',
};
export const icon = (name) => { const s = h('span', { style: { display: 'contents' } }); s.innerHTML = ICONS[name]; return s; };

// ---- Belege --------------------------------------------------------------------
async function thumbFor(rec) {
  if (!rec.hasBlob) return h('div', { class: 'ph' }, rec.offloadedIn ? 'ausgelagert ' + rec.offloadedIn : 'kein Bild');
  const row = await db.getBlob(rec.id);
  if (!row) return h('div', { class: 'ph' }, 'kein Bild');
  if (rec.mime === 'application/pdf') return h('div', { class: 'ph' }, 'PDF');
  const url = URL.createObjectURL(new Blob([row.data], { type: rec.mime }));
  return h('img', { src: url, alt: 'Beleg ' + rec.nr, onclick: () => viewReceipt(rec) });
}

export async function viewReceipt(rec) {
  const row = rec.hasBlob ? await db.getBlob(rec.id) : null;
  let body;
  if (!row) body = h('p', { class: 'muted' }, rec.offloadedIn ? `Das Bild wurde in die Monatssicherung ${rec.offloadedIn} ausgelagert und ist nicht mehr in der App gespeichert.` : 'Kein Bild gespeichert.');
  else if (rec.mime === 'application/pdf') {
    const url = URL.createObjectURL(new Blob([row.data], { type: 'application/pdf' }));
    body = h('p', null, h('a', { href: url, target: '_blank', rel: 'noopener' }, 'PDF öffnen'));
  } else body = h('div', { class: 'viewer' }, h('img', { src: URL.createObjectURL(new Blob([row.data], { type: rec.mime })), alt: rec.nr }));
  modal({ title: `Beleg ${rec.nr}`, body: h('div', null, h('p', { class: 'muted small' }, `${fmtDate(rec.date)}${rec.kind ? ' · ' + rec.kind : ''}${rec.amount ? ' · ' + euro(rec.amount) : ''}`), body), actions: [{ label: 'Schließen', kind: 'primary' }] });
}

// Belege zu einem Eintrag: ids = Array (wird direkt verändert), ctx() liefert {date, kind, amount, tripId}
export function receiptPicker(ids, ctx, session) {
  const wrap = h('div');
  const list = h('div', { class: 'thumbs' });
  const file = h('input', { type: 'file', accept: 'image/*,application/pdf', style: { display: 'none' } });
  const cam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: { display: 'none' } });

  async function draw() {
    list.replaceChildren();
    for (const id of ids) {
      const rec = receiptById(id);
      if (!rec) continue;
      const th = h('div', { class: 'thumb' }, await thumbFor(rec), h('div', null, rec.nr),
        h('button', { class: 'x', type: 'button', 'aria-label': 'Beleg entfernen', onclick: async () => {
          ids.splice(ids.indexOf(id), 1);
          if (session && session.new.has(id)) { await deleteReceipt(id); session.new.delete(id); }
          draw();
        } }, '×'));
      list.appendChild(th);
    }
  }
  async function onFile(inp) {
    const f = inp.files && inp.files[0];
    inp.value = '';
    if (!f) return;
    try {
      const c = ctx();
      const rec = await addReceipt(f, c);
      ids.push(rec.id);
      if (session) session.new.add(rec.id);
      await draw();
      toast(`Beleg ${rec.nr} gespeichert`);
    } catch (e) { toast('Beleg konnte nicht gespeichert werden: ' + (e.message || e)); }
  }
  file.addEventListener('change', () => onFile(file));
  cam.addEventListener('change', () => onFile(cam));
  wrap.append(list, file, cam,
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn s', type: 'button', onclick: () => cam.click() }, '📷 Foto aufnehmen'),
      h('button', { class: 'btn s', type: 'button', onclick: () => file.click() }, '📎 Datei wählen')));
  draw();
  return wrap;
}

export function storageInfo() { return S.meta; }

// Navigation (wird von app.js gesetzt, damit die Ansichten sich nicht gegenseitig importieren müssen)
export const nav = { go: () => {}, render: () => {} };
