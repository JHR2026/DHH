// Auswertungen: Datenmodell, CSV, Excel (.xlsx) und PDF – alles offline im Browser
import { S, analysis } from './store.js';
import * as db from './db.js';
import { summarize, calcTrip, LOC, MODES, TRIP_MODES, COST_KINDS, CLASS_LABEL } from './calc.js';
import { RATES_STAND, ENTFERNUNG, KM_DIENSTREISE, VERPFLEGUNG, rateFor } from './rates.js';
import { BUNDESLAENDER } from './holidays.js';
import {
  fmtDate, fmtDay, euro, fmtNum, round2, toNum, csvEscape, todayISO, isoWeekKey, toUTC, needZip, needPdf,
  rangeDates, MONTHS,
} from './util.js';

const strecke = (l) => `${LOC[l.from]} → ${LOC[l.to]}`;
const tripKind = (k) => TRIP_MODES[k] || k;

export function receiptStatus(r) {
  if (r.hasBlob) return 'In der App gespeichert';
  if (r.offloadedIn) return `Ausgelagert (Monatssicherung ${r.offloadedIn})`;
  return 'Kein Bild vorhanden';
}

// ---------------------------------------------------------------------------
// Datenmodell
// ---------------------------------------------------------------------------
export function rangeFor(year, month) {
  if (!month) return { from: `${year}-01-01`, to: `${year}-12-31`, label: `Jahr ${year}`, key: String(year) };
  const m = String(month).padStart(2, '0');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${m}-01`, to: `${year}-${m}-${last}`, label: `${MONTHS[month - 1]} ${year}`, key: `${year}-${m}` };
}

export function buildModel(range) {
  const A = analysis();
  const set = S.data.settings;
  const sum = summarize(A, S.data.trips, range);
  const receipts = S.data.receipts;
  const recById = new Map(receipts.map((r) => [r.id, r]));
  const nrs = (ids) => (ids || []).map((id) => (recById.get(id) || {}).nr).filter(Boolean).join(', ');

  const summaryRows = [];
  const add = (pos, count, unit, amount, bold) => summaryRows.push({ pos, count, unit, amount, bold });
  add('Entfernungspauschale Wohnung – Büro', sum.pendelHO.days, 'Tage', sum.pendelHO.amount);
  add('Entfernungspauschale Zweitwohnung – Büro', sum.pendelOZ.days, 'Tage', sum.pendelOZ.amount);
  if (sum.pendelHZ.days) add('Entfernungspauschale Heimfahrten (Wahlrecht)', sum.pendelHZ.days, 'Tage', sum.pendelHZ.amount);
  if (sum.capReduction) add('Abzug: Höchstbetrag 4.500 € (ohne eigenen Pkw)', '', '', -sum.capReduction);
  add('Zwischensumme Fahrten Wohnung/Büro', '', '', sum.pendelSumme, true);
  add('Familienheimfahrten (eine je Woche)', sum.fhf.count, 'Fahrten', sum.fhf.amount);
  add('Erste Fahrt zur Zweitwohnung (tatsächliche Kosten)', sum.erste.count, 'Fahrten', sum.erste.amount);
  add('Letzte Rückfahrt (tatsächliche Kosten)', sum.letzte.count, 'Fahrten', sum.letzte.amount);
  add('Verpflegungsmehraufwand doppelte Haushaltsführung', sum.dhhVerpflegung.days, 'Tage', sum.dhhVerpflegung.amount);
  add('Dienstreisen: Fahrtkosten', sum.trips.count, 'Reisen', sum.trips.fahrt);
  add('Dienstreisen: Übernachtung', '', '', sum.trips.uebernachtung);
  add('Dienstreisen: Parken, Nebenkosten, Sonstiges', '', '', sum.trips.neben);
  add('Dienstreisen: Verpflegungsmehraufwand', '', '', sum.trips.verpflegung);
  if (sum.trips.erstattung) add('Dienstreisen: abzgl. Erstattung Arbeitgeber', '', '', -sum.trips.erstattung);
  add('Summe', '', '', sum.total, true);

  const fahrten = sum.items.map((i) => ({
    date: i.date, strecke: strecke(i.leg), mode: MODES[i.leg.mode] || '', km: i.km || toNum(i.leg.km) || 0,
    cls: CLASS_LABEL[i.cls], amount: i.amount, note: [i.note, i.leg.note].filter(Boolean).join(' – '),
  }));

  const fhf = sum.items.filter((i) => i.cls === 'fhf_hin').map((i) => ({
    week: i.week, date: i.date, km: i.km, amount: i.amount, note: i.amount > 0 ? '' : i.note,
  }));

  const vz = sum.dhhRows.map((d) => ({
    date: d.date, abw: `${LOC[d.startLoc]} → ${LOC[d.endLoc]}`, base: d.base, cut: d.cut, amount: d.amount, note: d.note,
  }));

  const trips = sum.tripRows.sort((a, b) => a.trip.start.localeCompare(b.trip.start)).map(({ trip, calc }) => ({
    trip, calc,
    legs: calc.legs.map((l) => ({ date: l.date || trip.start, von: l.von || '', nach: l.nach || '', mode: tripKind(l.mode), km: toNum(l.km), amount: l.amountCalc, belege: nrs(l.belegIds), note: l.note || '' })),
    costs: (trip.costs || []).map((c) => ({ date: c.date || trip.start, kind: COST_KINDS[c.kind] || c.kind, amount: toNum(c.amount), belege: nrs(c.belegIds), note: c.note || '' })),
    startOrt: LOC[trip.startOrt] || trip.startOrt || '',
  }));

  // Belegverzeichnis: alle Belege, die in diesem Zeitraum verwendet werden bzw. datiert sind
  const used = new Map();
  for (const t of trips) for (const e of [...(t.trip.legs || []), ...(t.trip.costs || [])]) for (const id of e.belegIds || []) used.set(id, t.trip);
  const belege = receipts.filter((r) => (r.date >= range.from && r.date <= range.to) || (used.has(r.id) && used.get(r.id).start >= range.from && used.get(r.id).start <= range.to))
    .sort((a, b) => a.nr.localeCompare(b.nr))
    .map((r) => ({ nr: r.nr, date: r.date, kind: r.kind, amount: r.amount, note: r.note, zuordnung: used.has(r.id) ? `Dienstreise ${used.get(r.id).ziel || ''} ${fmtDate(used.get(r.id).start)}` : '', status: receiptStatus(r), rec: r }));

  const periods = [...S.data.periods].sort((a, b) => a.start.localeCompare(b.start)).map((p) => {
    const w = A.windows.find((x) => x.period.id === p.id);
    return { start: p.start, end: p.end, note: p.note || '', vzStart: w && w.start, vzEnd: w && w.end };
  });

  return {
    range, sum, summaryRows, fahrten, fhf, vz, trips, belege, periods, warnings: sum.warnings,
    stammdaten: {
      land: BUNDESLAENDER[set.bundesland] || '–', kmHO: toNum(set.kmHomeOffice), kmOZ: toNum(set.kmOfficeZweit), kmHZ: toNum(set.kmHomeZweit),
      name: set.name || '', zweitOffice: set.zweitOfficePauschale !== false,
      modus: (set.heimfahrtModus || {})[range.from.slice(0, 4)] === 'alle' ? 'alle' : 'woechentlich',
    },
    erstellt: todayISO(), stand: RATES_STAND,
  };
}

// ---------------------------------------------------------------------------
// CSV (Fahrtenliste)
// ---------------------------------------------------------------------------
export function buildCsv(m) {
  const head = ['Datum', 'Strecke', 'Verkehrsmittel', 'Entfernung km', 'Einordnung', 'Betrag EUR', 'Hinweis'];
  const lines = [head.join(';')];
  for (const f of m.fahrten) lines.push([fmtDate(f.date), f.strecke, f.mode, String(f.km).replace('.', ','), f.cls, f.amount.toFixed(2).replace('.', ','), f.note].map(csvEscape).join(';'));
  return new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}

// ---------------------------------------------------------------------------
// Excel (.xlsx) – eigener, schlanker Writer auf Basis von JSZip
// ---------------------------------------------------------------------------
const xe = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const colName = (i) => { let s = ''; i++; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
const serial = (d) => (toUTC(d) - Date.UTC(1899, 11, 30)) / 86400000;

// Zelle: string | number | {v, t:'eur'|'date'|'bold'|'head'|'num'}
function sheetXml(rows, widths) {
  let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
  x += '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
  x += '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols><sheetData>';
  rows.forEach((row, r) => {
    x += `<row r="${r + 1}">`;
    row.forEach((cell, c) => {
      if (cell === null || cell === undefined || cell === '') return;
      const ref = colName(c) + (r + 1);
      const o = typeof cell === 'object' ? cell : { v: cell };
      const style = { head: 1, eur: 2, date: 3, bold: 4, eurbold: 5, num: 6 }[o.t] || 0;
      if (typeof o.v === 'number' || o.t === 'date') {
        const v = o.t === 'date' ? serial(o.v) : o.v;
        x += `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
      } else x += `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xe(o.v)}</t></is></c>`;
    });
    x += '</row>';
  });
  return x + '</sheetData></worksheet>';
}

const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00\\ &quot;€&quot;"/><numFmt numFmtId="165" formatCode="DD.MM.YYYY"/><numFmt numFmtId="166" formatCode="#,##0.##"/></numFmts>'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDCEBEA"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>'
  + '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>';

export async function buildXlsx(m) {
  const JSZip = await needZip();
  const H = (...a) => a.map((v) => ({ v, t: 'head' }));
  const sheets = [];

  const s1 = [H('Position', 'Anzahl', 'Einheit', 'Betrag')];
  for (const r of m.summaryRows) s1.push([{ v: r.pos, t: r.bold ? 'bold' : undefined }, r.count === '' ? '' : r.count, r.unit, { v: r.amount, t: r.bold ? 'eurbold' : 'eur' }]);
  s1.push([], [{ v: 'Zeitraum', t: 'bold' }, m.range.label], [{ v: 'Erstellt am', t: 'bold' }, fmtDate(m.erstellt)], [{ v: 'Sätze', t: 'bold' }, m.stand]);
  s1.push([{ v: 'Bundesland', t: 'bold' }, m.stammdaten.land], [{ v: 'Wohnung–Büro (km)', t: 'bold' }, { v: m.stammdaten.kmHO, t: 'num' }], [{ v: 'Büro–Zweitwohnung (km)', t: 'bold' }, { v: m.stammdaten.kmOZ, t: 'num' }]);
  m.periods.forEach((p, i) => s1.push([{ v: i ? 'Doppelte Haushaltsführung (weiterer Zeitraum)' : 'Doppelte Haushaltsführung', t: 'bold' }, `${fmtDate(p.start)} – ${p.end ? fmtDate(p.end) : 'laufend'}`]));
  sheets.push(['Zusammenfassung', s1, [52, 18, 12, 16]]);

  const s2 = [H('Datum', 'Wochentag', 'Strecke', 'Verkehrsmittel', 'km', 'Einordnung', 'Betrag', 'Hinweis')];
  for (const f of m.fahrten) s2.push([{ v: f.date, t: 'date' }, fmtDay(f.date).split(',')[0], f.strecke, f.mode, { v: f.km, t: 'num' }, f.cls, { v: f.amount, t: 'eur' }, f.note]);
  sheets.push(['Fahrten', s2, [12, 11, 30, 18, 8, 42, 14, 50]]);

  const s3 = [H('Kalenderwoche', 'Datum Heimfahrt', 'Einfache Entfernung km', 'Betrag', 'Hinweis')];
  for (const f of m.fhf) s3.push([f.week, { v: f.date, t: 'date' }, { v: f.km, t: 'num' }, { v: f.amount, t: 'eur' }, f.note]);
  sheets.push(['Familienheimfahrten', s3, [16, 16, 22, 14, 60]]);

  const s4 = [H('Datum', 'Abwesenheit', 'Pauschale', 'Kürzung Mahlzeiten', 'Angesetzt', 'Hinweis')];
  for (const v of m.vz) s4.push([{ v: v.date, t: 'date' }, v.abw, { v: v.base, t: 'eur' }, { v: v.cut, t: 'eur' }, { v: v.amount, t: 'eur' }, v.note]);
  sheets.push(['Verpflegung dHH', s4, [12, 30, 12, 18, 12, 40]]);

  const s5 = [H('Reise', 'Zeitraum', 'Art', 'Datum', 'Von', 'Nach / Bezeichnung', 'km', 'Betrag', 'Belege', 'Notiz')];
  for (const t of m.trips) {
    const name = `${t.trip.ziel || ''}${t.trip.zweck ? ' – ' + t.trip.zweck : ''}`;
    const per = `${fmtDate(t.trip.start)} – ${fmtDate(t.trip.end || t.trip.start)}`;
    t.legs.forEach((l) => s5.push([name, per, 'Fahrt – ' + l.mode, { v: l.date, t: 'date' }, l.von, l.nach, { v: l.km, t: 'num' }, { v: l.amount, t: 'eur' }, l.belege, l.note]));
    t.costs.forEach((c) => s5.push([name, per, c.kind, { v: c.date, t: 'date' }, '', '', '', { v: c.amount, t: 'eur' }, c.belege, c.note]));
    t.calc.days.forEach((d) => s5.push([name, per, 'Verpflegungspauschale', { v: d.date, t: 'date' }, '', '', '', { v: d.amount, t: 'eur' }, '', d.cut ? 'Kürzung Mahlzeiten ' + euro(d.cut) : '']));
    if (t.calc.erstattung) s5.push([name, per, 'Erstattung Arbeitgeber (Abzug)', '', '', '', '', { v: -t.calc.erstattung, t: 'eur' }, '', '']);
    s5.push([{ v: name, t: 'bold' }, per, { v: 'Summe Reise', t: 'bold' }, '', '', '', '', { v: t.calc.total, t: 'eurbold' }, '', '']);
  }
  sheets.push(['Dienstreisen', s5, [30, 24, 30, 12, 20, 26, 8, 14, 18, 36]]);

  const s6 = [H('Belegnummer', 'Datum', 'Art', 'Betrag', 'Zuordnung', 'Verbleib des Belegs', 'Notiz')];
  for (const b of m.belege) s6.push([b.nr, { v: b.date, t: 'date' }, b.kind, { v: b.amount, t: 'eur' }, b.zuordnung, b.status, b.note]);
  sheets.push(['Belegverzeichnis', s6, [16, 12, 20, 14, 34, 40, 36]]);

  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
    + sheets.map((s, i) => `<sheet name="${xe(s[0])}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', STYLES);
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s[1], s[2])));
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ---------------------------------------------------------------------------
// PDF (pdf-lib, Standardschrift Helvetica)
// ---------------------------------------------------------------------------
const SUBST = { '→': '->', '–': '-', '—': '-', '≥': '>=', '≤': '<=', '’': "'", '„': '"', '“': '"', '”': '"', '…': '...', '•': '-', '×': 'x', ' ': ' ' };
function safe(s) {
  s = String(s === null || s === undefined ? '' : s);
  let out = '';
  for (const ch of s) {
    if (SUBST[ch]) out += SUBST[ch];
    else {
      const c = ch.codePointAt(0);
      if (c === 0x20ac || (c >= 32 && c <= 255)) out += ch;
      else if (c === 9 || c === 10) out += ' ';
      else out += '?';
    }
  }
  return out;
}

export async function buildPdf(m, opts = {}) {
  const { PDFDocument, StandardFonts, rgb } = await needPdf();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, Hh = 841.89, MX = 36, MT = 48, MB = 44;
  const CW = W - 2 * MX;
  const ink = rgb(0.1, 0.12, 0.14), muted = rgb(0.4, 0.43, 0.46), line = rgb(0.8, 0.83, 0.85), head = rgb(0.86, 0.92, 0.92), zebra = rgb(0.965, 0.975, 0.975);
  let page, y, pageNo = 0;

  const newPage = () => {
    page = doc.addPage([W, Hh]); pageNo++; y = Hh - MT;
    page.drawText(safe(`Fahrtenbuch - ${m.range.label}`), { x: MX, y: Hh - 26, size: 8, font, color: muted });
  };
  const ensure = (h) => { if (y - h < MB) newPage(); };
  const textW = (s, f, size) => f.widthOfTextAtSize(safe(s), size);
  const wrap = (s, f, size, maxW) => {
    const out = [];
    for (const para of safe(s).split('\n')) {
      let cur = '';
      for (const word of para.split(' ')) {
        const t = cur ? cur + ' ' + word : word;
        if (f.widthOfTextAtSize(t, size) <= maxW) cur = t;
        else {
          if (cur) out.push(cur);
          let w = word;
          while (f.widthOfTextAtSize(w, size) > maxW && w.length > 1) {
            let k = w.length - 1;
            while (k > 1 && f.widthOfTextAtSize(w.slice(0, k), size) > maxW) k--;
            out.push(w.slice(0, k)); w = w.slice(k);
          }
          cur = w;
        }
      }
      out.push(cur);
    }
    return out;
  };
  const para = (s, { size = 9, f = font, color = ink, gap = 4, indent = 0 } = {}) => {
    for (const ln of wrap(s, f, size, CW - indent)) {
      ensure(size + 3);
      page.drawText(ln, { x: MX + indent, y: y - size, size, font: f, color }); y -= size + 3;
    }
    y -= gap;
  };
  const h1 = (s) => { ensure(40); y -= 6; page.drawText(safe(s), { x: MX, y: y - 14, size: 14, font: bold, color: ink }); y -= 26; };
  const h2 = (s) => { ensure(30); y -= 4; page.drawText(safe(s), { x: MX, y: y - 11, size: 11, font: bold, color: ink }); y -= 20; };

  // Tabelle: cols [{k,t,w(Anteil),a:'r'|'l'}]
  const table = (cols, rows, { size = 8, boldLast = false } = {}) => {
    const tot = cols.reduce((a, c) => a + c.w, 0);
    const ws = cols.map((c) => (c.w / tot) * CW);
    const pad = 3;
    const drawHead = () => {
      ensure(18);
      page.drawRectangle({ x: MX, y: y - 14, width: CW, height: 14, color: head });
      let x = MX;
      cols.forEach((c, i) => {
        const t = safe(c.t);
        const tw = textW(t, bold, size);
        page.drawText(t, { x: c.a === 'r' ? x + ws[i] - pad - tw : x + pad, y: y - 10.5, size, font: bold, color: ink });
        x += ws[i];
      });
      y -= 14;
    };
    drawHead();
    rows.forEach((r, ri) => {
      const cells = cols.map((c, i) => wrap(r[c.k] === undefined || r[c.k] === null ? '' : r[c.k], (r.bold || (boldLast && ri === rows.length - 1)) ? bold : font, size, ws[i] - 2 * pad));
      const lines = Math.max(1, ...cells.map((c) => c.length));
      const rh = lines * (size + 2) + 4;
      if (y - rh < MB) { newPage(); drawHead(); }
      if (ri % 2 === 1) page.drawRectangle({ x: MX, y: y - rh, width: CW, height: rh, color: zebra });
      let x = MX;
      const f = (r.bold || (boldLast && ri === rows.length - 1)) ? bold : font;
      cells.forEach((cl, i) => {
        cl.forEach((ln, li) => {
          const tw = textW(ln, f, size);
          page.drawText(ln, { x: cols[i].a === 'r' ? x + ws[i] - pad - tw : x + pad, y: y - (size + 1) - li * (size + 2) - 1, size, font: f, color: r.color || ink });
        });
        x += ws[i];
      });
      page.drawLine({ start: { x: MX, y: y - rh }, end: { x: MX + CW, y: y - rh }, thickness: 0.3, color: line });
      y -= rh;
    });
    y -= 8;
  };

  // ---------- Titelseite / Zusammenfassung ----------
  newPage();
  page.drawText('Fahrtenbuch', { x: MX, y: y - 20, size: 22, font: bold, color: ink }); y -= 28;
  para('Fahrten Wohnung - Arbeitsstätte, doppelte Haushaltsführung und Dienstreisen', { size: 11, color: muted, gap: 6 });
  const meta = [`Zeitraum: ${m.range.label}  (${fmtDate(m.range.from)} - ${fmtDate(m.range.to)})`, `Erstellt am: ${fmtDate(m.erstellt)}`, `Berechnungsgrundlage: ${m.stand}`];
  if (m.stammdaten.name) meta.unshift(`Steuerpflichtige/r: ${m.stammdaten.name}`);
  meta.forEach((t) => para(t, { size: 9.5, gap: 1 })); y -= 6;

  h2('Zusammenfassung der ansetzbaren Aufwendungen');
  table([{ k: 'pos', t: 'Position', w: 8 }, { k: 'cnt', t: 'Anzahl', w: 2.2, a: 'r' }, { k: 'amount', t: 'Betrag', w: 2.2, a: 'r' }],
    m.summaryRows.map((r) => ({ pos: r.pos, cnt: r.count === '' ? '' : `${r.count} ${r.unit}`, amount: euro(r.amount), bold: r.bold })), { size: 9, boldLast: true });

  h2('Grundlagen dieser Aufstellung');
  const sd = m.stammdaten;
  const rE = rateFor(ENTFERNUNG, m.range.to), rK = rateFor(KM_DIENSTREISE, m.range.to), rV = rateFor(VERPFLEGUNG, m.range.to);
  [
    `Entfernungen (einfach, kürzeste Straßenverbindung): Wohnung - Büro ${fmtNum(sd.kmHO)} km; Büro - Zweitwohnung ${fmtNum(sd.kmOZ)} km${sd.kmHZ ? `; Wohnung - Zweitwohnung ${fmtNum(sd.kmHZ)} km` : ''}.`,
    ...m.periods.map((p) => `Doppelte Haushaltsführung: ${fmtDate(p.start)} bis ${p.end ? fmtDate(p.end) : 'laufend'}${p.vzStart ? `; Verpflegungsmehraufwand ab ${fmtDate(p.vzStart)} bis ${fmtDate(p.vzEnd)} (drei Monate)` : ''}.`),
    `Entfernungspauschale ${euro(rE.k20)} je vollem Entfernungskilometer (§ 9 Abs. 1 Satz 3 Nr. 4 EStG); höchstens eine je Arbeitstag. Familienheimfahrt: eine je Woche mit der einfachen Entfernung Wohnung - Büro (§ 9 Abs. 1 Satz 3 Nr. 5 EStG).`,
    `Erste Fahrt und letzte Rückfahrt der doppelten Haushaltsführung sowie Dienstreisen mit dem privaten Pkw: ${euro(rK.pkw)} je gefahrenem Kilometer bzw. tatsächliche Kosten (Dienstreisen).`,
    `Verpflegungsmehraufwand Inland: ${euro(rV.kurz)} (mehr als 8 Stunden bzw. An-/Abreisetag), ${euro(rV.voll)} (24 Stunden); bei der doppelten Haushaltsführung nur für die ersten drei Monate (§ 9 Abs. 4a EStG); Kürzung bei gestellten Mahlzeiten 20 % / 40 % / 40 %.`,
    sd.modus === 'alle' ? 'Wahlrecht ausgeübt: alle Heimfahrten werden mit der Entfernungspauschale angesetzt (kein Verpflegungsmehraufwand).' : 'Heimfahrten: eine Familienheimfahrt je Woche.',
  ].forEach((t) => para('- ' + t, { size: 8.5, gap: 2, indent: 6 }));

  if (m.warnings.length) {
    h2('Hinweise zur Prüfung');
    m.warnings.slice(0, 40).forEach((w) => para(`- ${fmtDay(w.date)}: ${w.text}`, { size: 8.5, gap: 1, indent: 6 }));
    if (m.warnings.length > 40) para(`... und ${m.warnings.length - 40} weitere Hinweise.`, { size: 8.5, color: muted });
  }

  // ---------- Fahrtenliste ----------
  if (m.fahrten.length) {
    newPage(); h1('Fahrtenliste');
    table([{ k: 'd', t: 'Datum', w: 1.7 }, { k: 's', t: 'Strecke', w: 3.6 }, { k: 'v', t: 'Fahrzeug', w: 2 }, { k: 'km', t: 'km', w: 1, a: 'r' }, { k: 'c', t: 'Einordnung', w: 4.2 }, { k: 'a', t: 'Betrag', w: 1.8, a: 'r' }],
      m.fahrten.map((f) => ({ d: fmtDay(f.date), s: f.strecke, v: f.mode, km: f.km ? fmtNum(f.km) : '', c: f.cls + (f.note ? ' - ' + f.note : ''), a: f.amount ? euro(f.amount) : '-' })));
  }

  if (m.fhf.length) {
    h1('Familienheimfahrten je Kalenderwoche');
    table([{ k: 'w', t: 'Kalenderwoche', w: 2 }, { k: 'd', t: 'Heimfahrt am', w: 2 }, { k: 'km', t: 'Entfernung (einfach)', w: 2, a: 'r' }, { k: 'a', t: 'Betrag', w: 2, a: 'r' }, { k: 'n', t: 'Hinweis', w: 4 }],
      m.fhf.map((f) => ({ w: f.week, d: fmtDay(f.date), km: fmtNum(f.km) + ' km', a: euro(f.amount), n: f.note })));
  }

  if (m.vz.length) {
    newPage(); h1('Verpflegungsmehraufwand bei doppelter Haushaltsführung');
    table([{ k: 'd', t: 'Datum', w: 2 }, { k: 'abw', t: 'Abwesenheit', w: 3.4 }, { k: 'b', t: 'Pauschale', w: 1.5, a: 'r' }, { k: 'c', t: 'Kürzung', w: 1.5, a: 'r' }, { k: 'a', t: 'Angesetzt', w: 1.6, a: 'r' }, { k: 'n', t: 'Hinweis', w: 3 }],
      m.vz.map((v) => ({ d: fmtDay(v.date), abw: v.abw, b: v.base ? euro(v.base) : '-', c: v.cut ? euro(-v.cut) : '', a: euro(v.amount), n: v.note })));
  }

  // ---------- Dienstreisen ----------
  if (m.trips.length) {
    newPage(); h1('Dienstreisen');
    for (const t of m.trips) {
      ensure(70);
      h2(`${t.trip.ziel || 'Dienstreise'}${t.trip.zweck ? ' - ' + t.trip.zweck : ''}`);
      para(`${fmtDate(t.trip.start)} ${t.trip.startTime || ''} bis ${fmtDate(t.trip.end || t.trip.start)} ${t.trip.endTime || ''}; Start: ${t.startOrt}`, { size: 8.5, color: muted, gap: 3 });
      if (t.legs.length) table([{ k: 'd', t: 'Datum', w: 1.6 }, { k: 'r', t: 'Strecke', w: 3.6 }, { k: 'v', t: 'Verkehrsmittel', w: 3 }, { k: 'km', t: 'km', w: 0.9, a: 'r' }, { k: 'a', t: 'Betrag', w: 1.5, a: 'r' }, { k: 'b', t: 'Beleg', w: 1.8 }],
        t.legs.map((l) => ({ d: fmtDate(l.date), r: `${l.von} -> ${l.nach}`.replace(/^ -> $/, ''), v: l.mode, km: l.km ? fmtNum(l.km) : '', a: euro(l.amount), b: l.belege })));
      if (t.costs.length) table([{ k: 'd', t: 'Datum', w: 1.6 }, { k: 'k', t: 'Kostenart', w: 3 }, { k: 'n', t: 'Notiz', w: 4.2 }, { k: 'a', t: 'Betrag', w: 1.5, a: 'r' }, { k: 'b', t: 'Beleg', w: 1.8 }],
        t.costs.map((c) => ({ d: fmtDate(c.date), k: c.kind, n: c.note, a: euro(c.amount), b: c.belege })));
      const calc = t.calc;
      table([{ k: 'p', t: 'Ergebnis der Reise', w: 6 }, { k: 'a', t: 'Betrag', w: 2, a: 'r' }], [
        { p: 'Fahrtkosten', a: euro(calc.fahrt) }, { p: 'Übernachtung', a: euro(calc.uebernachtung) }, { p: 'Parken, Nebenkosten, Sonstiges', a: euro(calc.neben) },
        { p: `Verpflegungsmehraufwand (${calc.days.map((d) => (d.amount ? d.amount : 0)).join(' / ')})`, a: euro(calc.verpflegung) },
        ...(calc.erstattung ? [{ p: 'abzgl. Erstattung Arbeitgeber', a: euro(-calc.erstattung) }] : []), { p: 'Summe', a: euro(calc.total), bold: true },
      ], { size: 8.5 });
    }
  }

  // ---------- Belegverzeichnis ----------
  if (m.belege.length) {
    newPage(); h1('Belegverzeichnis');
    para('Die Belege sind fortlaufend nummeriert. Ausgelagerte Belege liegen in der jeweiligen Monatssicherung (Dateiname siehe Spalte "Verbleib").', { size: 8.5, color: muted });
    table([{ k: 'n', t: 'Beleg-Nr.', w: 1.9 }, { k: 'd', t: 'Datum', w: 1.5 }, { k: 'k', t: 'Art', w: 1.6 }, { k: 'a', t: 'Betrag', w: 1.4, a: 'r' }, { k: 'z', t: 'Zuordnung', w: 3 }, { k: 's', t: 'Verbleib', w: 3 }],
      m.belege.map((b) => ({ n: b.nr, d: fmtDate(b.date), k: b.kind, a: b.amount ? euro(b.amount) : '', z: b.zuordnung, s: b.status })));
  }

  // ---------- Belege als Anhang ----------
  let attached = 0;
  if (opts.withReceipts) {
    for (const b of m.belege) {
      if (!b.rec.hasBlob) continue;
      const row = await db.getBlob(b.rec.id);
      if (!row) continue;
      try {
        if (b.rec.mime === 'application/pdf') {
          const src = await PDFDocument.load(row.data);
          const pages = await doc.copyPages(src, src.getPageIndices());
          pages.forEach((p) => doc.addPage(p)); attached++;
          continue;
        }
        const img = b.rec.mime === 'image/png' ? await doc.embedPng(row.data) : await doc.embedJpg(row.data);
        const pg = doc.addPage([W, Hh]);
        pg.drawText(safe(`Beleg ${b.nr} - ${fmtDate(b.date)} - ${b.kind || ''} ${b.amount ? euro(b.amount) : ''}`), { x: MX, y: Hh - 30, size: 10, font: bold, color: ink });
        const maxW = W - 2 * MX, maxH = Hh - 80;
        const sc = Math.min(maxW / img.width, maxH / img.height, 1.5);
        pg.drawImage(img, { x: MX, y: Hh - 50 - img.height * sc, width: img.width * sc, height: img.height * sc });
        attached++;
      } catch (e) { /* nicht darstellbares Bild überspringen */ }
    }
  }

  // Seitenzahlen
  const pages = doc.getPages();
  pages.forEach((p, i) => p.drawText(safe(`Seite ${i + 1} von ${pages.length}`), { x: W - MX - 60, y: 22, size: 8, font, color: muted }));
  doc.setTitle(safe(`Fahrtenbuch ${m.range.label}`));
  doc.setCreator('Fahrtenbuch-App');
  const bytes = await doc.save();
  return { blob: new Blob([bytes], { type: 'application/pdf' }), attached };
}

export { rangeDates, isoWeekKey, round2 };
