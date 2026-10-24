// Sicherung, Geräte-Abgleich (Zusammenführen) und Monatssicherung der Belege
import * as db from './db.js';
import { S, load, setMetaValue, offloadReceipt } from './store.js';
import { buildModel, buildPdf, buildXlsx, rangeFor, receiptStatus } from './report.js';
import { needZip, todayISO, csvEscape, fmtDate, download, pad } from './util.js';

const FORMAT = 'fahrtenbuch-backup';
const extOf = (mime) => (mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg');

// Mehrere Dateien teilen (iPhone: Teilen-Menü) oder herunterladen
export async function deliverMany(files, title) {
  try {
    const fs = files.map((f) => new File([f.blob], f.name, { type: f.blob.type || 'application/octet-stream' }));
    if (navigator.canShare && navigator.canShare({ files: fs })) {
      await navigator.share({ files: fs, title });
      return 'shared';
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return 'cancelled';
  }
  for (const f of files) { download(f.blob, f.name); await new Promise((r) => setTimeout(r, 400)); }
  return 'downloaded';
}

// ---------------------------------------------------------------------------
// Vollsicherung
// ---------------------------------------------------------------------------
export async function buildFullBackup() {
  const JSZip = await needZip();
  const zip = new JSZip();
  const payload = { format: FORMAT, version: 1, exportedAt: Date.now(), deviceId: S.meta.deviceId, stores: S.all };
  zip.file('data.json', JSON.stringify(payload));
  let count = 0;
  for (const r of S.all.receipts) {
    if (r.deleted || !r.hasBlob) continue;
    const row = await db.getBlob(r.id);
    if (row) { zip.file(`belege/${r.id}.${extOf(r.mime)}`, row.data); count++; }
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { blob, name: `Fahrtenbuch-Sicherung-${todayISO()}.zip`, receipts: count };
}

export async function markFullBackupDone() { await setMetaValue('lastFullBackupAt', Date.now()); }

// ---------------------------------------------------------------------------
// Import / Zusammenführen
// ---------------------------------------------------------------------------
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) if (k !== 'updatedAt') o[k] = canon(v[k]);
    return o;
  }
  return v;
}
const sig = (r) => JSON.stringify(canon(r));

export function describe(store, r) {
  if (r.deleted) return '(gelöscht)';
  if (store === 'legs') return `Fahrt ${fmtDate(r.date)}: ${r.from} → ${r.to}`;
  if (store === 'trips') return `Dienstreise ${fmtDate(r.start)} ${r.ziel || ''}`;
  if (store === 'periods') return `Doppelte Haushaltsführung ab ${fmtDate(r.start)}`;
  if (store === 'days') return `Tag ${fmtDate(r.date)} (${r.status || 'Notiz/Mahlzeiten'})`;
  if (store === 'receipts') return `Beleg ${r.nr}`;
  return 'Stammdaten/Einstellungen';
}

export async function readBackupFile(file) {
  const name = (file.name || '').toLowerCase();
  let payload; const blobs = new Map();
  if (name.endsWith('.json')) payload = JSON.parse(await file.text());
  else {
    const JSZip = await needZip();
    const zip = await JSZip.loadAsync(file);
    const f = zip.file('data.json');
    if (!f) throw new Error('Keine gültige Fahrtenbuch-Sicherung (data.json fehlt).');
    payload = JSON.parse(await f.async('string'));
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir || !path.startsWith('belege/')) continue;
      const id = path.slice(7).replace(/\.[a-z]+$/i, '');
      blobs.set(id, { data: await entry.async('arraybuffer'), mime: path.endsWith('.pdf') ? 'application/pdf' : path.endsWith('.png') ? 'image/png' : 'image/jpeg' });
    }
  }
  if (!payload || payload.format !== FORMAT || !payload.stores) throw new Error('Das ist keine Fahrtenbuch-Sicherung.');
  return { payload, blobs };
}

// Vorschau: was würde passieren? (ohne etwas zu schreiben)
export function planMerge(payload) {
  const lastSync = S.meta.lastSyncAt || 0;
  const plan = { add: [], update: [], same: 0, keep: 0, conflicts: [] };
  for (const store of db.STORES) {
    for (const inc of payload.stores[store] || []) {
      const cur = S.all[store].find((x) => x.id === inc.id);
      if (!cur) { plan.add.push({ store, inc }); continue; }
      if (sig(cur) === sig(inc)) { plan.same++; continue; }
      const bothChanged = (cur.updatedAt || 0) > lastSync && (inc.updatedAt || 0) > lastSync;
      if (bothChanged && !cur.deleted !== !inc.deleted) plan.conflicts.push({ store, id: inc.id, cur, inc });
      else if (bothChanged && !cur.deleted && !inc.deleted) plan.conflicts.push({ store, id: inc.id, cur, inc });
      else if ((inc.updatedAt || 0) > (cur.updatedAt || 0)) plan.update.push({ store, inc });
      else plan.keep++;
    }
  }
  return plan;
}

export async function applyMerge(plan, blobs, choices = {}) {
  let n = 0;
  const apply = async (store, rec) => {
    await db.putRaw(store, rec); n++;
    if (store === 'receipts') {
      if (rec.deleted) { await db.delBlob(rec.id); return; }
      const b = blobs.get(rec.id);
      const have = await db.getBlob(rec.id);
      if (rec.hasBlob) {
        if (b) await db.putBlob(rec.id, b.data, b.mime || rec.mime);
        else if (!have) await db.putRaw('receipts', { ...rec, hasBlob: false });
      } else if (have) await db.delBlob(rec.id);
    }
  };
  for (const a of plan.add) await apply(a.store, a.inc);
  for (const u of plan.update) await apply(u.store, u.inc);
  for (const c of plan.conflicts) {
    if (choices[c.id] === 'incoming') await apply(c.store, { ...c.inc, updatedAt: Date.now() });
  }
  await setMetaValue('lastSyncAt', Date.now());
  await load();
  return n;
}

// ---------------------------------------------------------------------------
// Monatssicherung: Belege des Monats + Verzeichnis + Übersicht
// ---------------------------------------------------------------------------
export function monthlyCandidates(monthKey) {
  return S.data.receipts.filter((r) => r.date.slice(0, 7) === monthKey);
}

export async function buildMonthlyBackup(monthKey) {
  const JSZip = await needZip();
  const [y, m] = monthKey.split('-').map(Number);
  const range = rangeFor(y, m);
  const model = buildModel(range);
  const recs = monthlyCandidates(monthKey).sort((a, b) => a.nr.localeCompare(b.nr));

  // Belege auf Dateien aufteilen (max. ca. 14 MB je Datei, damit sie in eine E-Mail passen)
  const LIMIT = 14 * 1024 * 1024;
  const parts = [[]]; let size = 0;
  const withData = [];
  for (const r of recs) {
    if (!r.hasBlob) continue;
    const row = await db.getBlob(r.id);
    if (!row) continue;
    withData.push({ r, row });
    if (size + row.data.byteLength > LIMIT && parts[parts.length - 1].length) { parts.push([]); size = 0; }
    parts[parts.length - 1].push({ r, row }); size += row.data.byteLength;
  }
  const total = parts.length;
  const files = [];

  // Verzeichnis (CSV) nennt Dateiname je Beleg
  const nameOf = (i) => `Fahrtenbuch-Monatssicherung-${monthKey}${total > 1 ? `-Teil${i + 1}von${total}` : ''}.zip`;
  const where = new Map();
  parts.forEach((p, i) => p.forEach(({ r }) => where.set(r.id, nameOf(i))));
  const lines = [['Belegnummer', 'Datum', 'Art', 'Betrag EUR', 'Notiz', 'Enthalten in Datei', 'Dateiname im Archiv'].join(';')];
  for (const r of recs) {
    const f = where.get(r.id) || '';
    lines.push([r.nr, fmtDate(r.date), r.kind, r.amount ? r.amount.toFixed(2).replace('.', ',') : '', r.note, f, f ? `belege/${r.nr}.${extOf(r.mime)}` : receiptStatus(r)].map(csvEscape).join(';'));
  }
  const csv = '﻿' + lines.join('\r\n');
  const pdf = await buildPdf(model, { withReceipts: false });
  const xlsx = await buildXlsx(model);

  for (let i = 0; i < total; i++) {
    const zip = new JSZip();
    if (i === 0) {
      zip.file('Belegverzeichnis.csv', csv);
      zip.file(`Monatsuebersicht-${monthKey}.pdf`, pdf.blob);
      zip.file(`Monatsuebersicht-${monthKey}.xlsx`, xlsx);
    }
    for (const { r, row } of parts[i]) zip.file(`belege/${r.nr}.${extOf(r.mime)}`, row.data);
    files.push({ name: nameOf(i), blob: await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } }) });
  }
  return { files, receipts: withData.map((x) => x.r), monthKey, count: withData.length };
}

export async function finishMonthly(monthKey, receipts, deleteImages) {
  if (deleteImages) for (const r of receipts) await offloadReceipt(r, monthKey);
  await setMetaValue('lastMonthlyBackup', monthKey);
}

// ---------------------------------------------------------------------------
// Kalender-Erinnerung (.ics) – monatlich am 1. um 9:00
// ---------------------------------------------------------------------------
export function buildIcs() {
  const d = new Date();
  const nextM = d.getMonth() + 2 > 12 ? 1 : d.getMonth() + 2;
  const nextY = d.getMonth() + 2 > 12 ? d.getFullYear() + 1 : d.getFullYear();
  const dt = `${nextY}${pad(nextM)}01T090000`;
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fahrtenbuch//DE', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:fahrtenbuch-monatssicherung-${S.meta.deviceId || 'x'}@local`, `DTSTAMP:${d.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART:${dt}`, 'DURATION:PT15M', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1', 'SUMMARY:Fahrtenbuch: Monatssicherung der Belege',
    'DESCRIPTION:Fahrtenbuch-App öffnen und unter Auswertung > Monatssicherung die Belege des Vormonats sichern.',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Monatssicherung Fahrtenbuch', 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  return new Blob([ics], { type: 'text/calendar;charset=utf-8' });
}
