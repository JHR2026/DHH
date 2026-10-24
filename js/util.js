// Allgemeine Hilfsfunktionen (Datum, Zahlen, DOM)
export const pad = (n, l = 2) => String(n).padStart(l, '0');

export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

export function todayISO() {
  const t = new Date();
  return iso(t.getFullYear(), t.getMonth() + 1, t.getDate());
}

export function parse(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}
export const toUTC = (s) => { const { y, m, d } = parse(s); return Date.UTC(y, m - 1, d); };
export const fromUTC = (ms) => { const t = new Date(ms); return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };
export const addDays = (s, n) => fromUTC(toUTC(s) + n * 86400000);
export const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000); // b - a

export function addMonths(s, n) {
  const { y, m, d } = parse(s);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, Math.min(d, last));
}

// 0 = Montag ... 6 = Sonntag
export const weekday = (s) => (new Date(toUTC(s)).getUTCDay() + 6) % 7;
export const isWeekend = (s) => weekday(s) >= 5;

export function isoWeekKey(s) {
  const thu = toUTC(s) + (3 - weekday(s)) * 86400000;
  const ty = new Date(thu).getUTCFullYear();
  const wk = Math.floor((thu - Date.UTC(ty, 0, 1)) / 86400000 / 7) + 1;
  return `${ty}-W${pad(wk)}`;
}

export function rangeDates(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

export const WD_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
export const WD_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
export const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

export function fmtDate(s) {
  if (!s) return '';
  const { y, m, d } = parse(s);
  return `${pad(d)}.${pad(m)}.${y}`;
}
export const fmtDay = (s) => `${WD_SHORT[weekday(s)]}, ${fmtDate(s)}`;
export const fmtDayLong = (s) => `${WD_LONG[weekday(s)]}, ${fmtDate(s)}`;

const eurFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const numFmt = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
export const euro = (n) => eurFmt.format(round2(n || 0));
export const fmtNum = (n) => numFmt.format(n || 0);
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Zahl aus Eingabe ("12,5" oder "12.5")
export function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = parseFloat(String(v).trim().replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) ? n : 0;
}

export function monthKey(s) { return s.slice(0, 7); }
export function prevMonthKey(s) {
  const { y, m } = parse(s);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

// Kleiner DOM-Helfer: h('div', {class:'x', onclick: fn}, 'text', child, ...)
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}

export function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

// Bibliotheken erst bei Bedarf laden (liegen im Service-Worker-Cache, funktionieren also offline)
const loaded = {};
export function loadScript(src) {
  if (loaded[src]) return loaded[src];
  loaded[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => { delete loaded[src]; reject(new Error('Konnte ' + src + ' nicht laden')); };
    document.head.appendChild(s);
  });
  return loaded[src];
}
export const needZip = async () => { await loadScript('./lib/jszip.min.js'); return window.JSZip; };
export const needPdf = async () => { await loadScript('./lib/pdf-lib.min.js'); return window.PDFLib; };

// Datei teilen (iPhone: Teilen-Menü → Mail/Dateien/iCloud) oder herunterladen
export async function deliver(blob, name, title) {
  try {
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: title || name });
      return 'shared';
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return 'cancelled';
  }
  download(blob, name);
  return 'downloaded';
}
