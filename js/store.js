// Zentraler Zustand + Zugriff auf die Daten (mit Soft-Delete für den Geräte-Abgleich)
import * as db from './db.js';
import { analyze, calcTrip } from './calc.js';
import { holidayName } from './holidays.js';
import { uuid, todayISO, pad, toNum } from './util.js';

export const S = {
  all: null,          // alle Datensätze inkl. gelöschter
  data: null,         // nur aktive Datensätze + settings als Objekt
  meta: {},           // gerätelokal: deviceId, deviceCode, lastSyncAt, lastMonthlyBackup ...
  date: todayISO(),
  year: Number(todayISO().slice(0, 4)),
  view: 'day',
  cache: null,
};

const live = (a) => a.filter((r) => !r.deleted);

export async function load() {
  S.all = await db.loadAll();
  for (const k of ['deviceId', 'deviceCode', 'lastSyncAt', 'lastMonthlyBackup', 'lastFullBackupAt', 'installedAt']) {
    S.meta[k] = await db.getMeta(k);
  }
  if (!S.meta.deviceId) {
    S.meta.deviceId = uuid();
    S.meta.deviceCode = Math.random().toString(36).slice(2, 4).toUpperCase();
    S.meta.installedAt = Date.now();
    await db.setMeta('deviceId', S.meta.deviceId);
    await db.setMeta('deviceCode', S.meta.deviceCode);
    await db.setMeta('installedAt', S.meta.installedAt);
  }
  rebuild();
}

export function rebuild() {
  const main = S.all.settings.find((r) => r.id === 'main');
  S.data = {
    settings: main && !main.deleted ? main : {},
    periods: live(S.all.periods),
    legs: live(S.all.legs),
    days: live(S.all.days),
    trips: live(S.all.trips),
    receipts: live(S.all.receipts),
  };
  S.cache = null;
}

export function holidaysFor() {
  const land = S.data.settings.bundesland;
  return (date) => (land ? holidayName(date, land) : null);
}

export function analysis() {
  if (!S.cache) S.cache = analyze(S.data, todayISO(), holidaysFor());
  return S.cache;
}

export async function setMetaValue(key, value) {
  S.meta[key] = value;
  await db.setMeta(key, value);
}

export async function save(store, rec) {
  const now = Date.now();
  const r = { ...rec };
  if (!r.id) r.id = uuid();
  if (!r.createdAt) r.createdAt = now;
  r.updatedAt = now;
  r.deleted = false;
  await db.putRaw(store, r);
  const arr = S.all[store];
  const i = arr.findIndex((x) => x.id === r.id);
  if (i >= 0) arr[i] = r; else arr.push(r);
  rebuild();
  return r;
}

export async function remove(store, id) {
  const arr = S.all[store];
  const cur = arr.find((x) => x.id === id);
  if (!cur) return;
  const r = { id, deleted: true, updatedAt: Date.now(), createdAt: cur.createdAt };
  if (store === 'days') r.date = cur.date;
  await db.putRaw(store, r);
  arr[arr.indexOf(cur)] = r;
  rebuild();
}

export async function saveSettings(patch) {
  const cur = S.all.settings.find((r) => r.id === 'main') || { id: 'main' };
  return save('settings', { ...cur, ...patch, id: 'main' });
}

// Tagesdatensatz (Status, Mahlzeiten, Override) – id = Datum
export function dayRec(date) {
  return S.data.days.find((d) => d.date === date) || null;
}
export async function saveDay(date, patch) {
  const cur = S.all.days.find((d) => d.id === date && !d.deleted) || { id: date, date };
  const next = { ...cur, ...patch, id: date, date };
  const empty = !next.status && !next.vzOverride && !(next.meals && (next.meals.f || next.meals.m || next.meals.a)) && !next.note;
  if (empty) { if (S.all.days.find((d) => d.id === date && !d.deleted)) await remove('days', date); return null; }
  return save('days', next);
}

export function tripAt(date) {
  return S.data.trips.find((t) => t.start <= date && date <= (t.end || t.start)) || null;
}

// ---- Belege -----------------------------------------------------------------
export function nextReceiptNr(date) {
  const year = date.slice(0, 4);
  const code = S.meta.deviceCode || 'X';
  let max = 0;
  for (const r of S.all.receipts) {
    const m = /^(\d{4})-(\d{4})/.exec(r.nr || '');
    if (m && m[1] === year && r.nr.endsWith(code)) max = Math.max(max, Number(m[2]));
  }
  return `${year}-${pad(max + 1, 4)}${code}`;
}

// Foto/PDF verkleinern und als Beleg speichern
export async function addReceipt(file, meta) {
  let data, mime = file.type || 'application/octet-stream';
  if (mime.startsWith('image/')) {
    const r = await shrinkImage(file);
    data = r.data; mime = r.mime;
  } else data = await file.arrayBuffer();
  const rec = await save('receipts', {
    nr: nextReceiptNr(meta.date), date: meta.date, kind: meta.kind || '', amount: toNum(meta.amount),
    note: meta.note || '', mime, size: data.byteLength, hasBlob: true, offloadedIn: null, tripId: meta.tripId || null,
  });
  await db.putBlob(rec.id, data, mime);
  return rec;
}

async function shrinkImage(file, maxSide = 1600, quality = 0.7) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', quality));
    if (!blob) throw new Error('toBlob');
    return { data: await blob.arrayBuffer(), mime: 'image/jpeg' };
  } catch (e) {
    return { data: await file.arrayBuffer(), mime: file.type || 'image/jpeg' };
  }
}

export async function deleteReceipt(id) {
  await db.delBlob(id);
  await remove('receipts', id);
}

// Nur das Bild entfernen, die Daten bleiben (nach Monatssicherung)
export async function offloadReceipt(rec, monthKey) {
  await db.delBlob(rec.id);
  await save('receipts', { ...rec, hasBlob: false, offloadedIn: monthKey });
}

export function receiptById(id) { return S.data.receipts.find((r) => r.id === id) || null; }

export { calcTrip };
