// Ansicht "Auswertung": Zusammenfassung, Nachweise (PDF/Excel/CSV) und Monatssicherung der Belege
import { h, fmtDate, fmtDay, euro, fmtNum, todayISO, prevMonthKey, MONTHS, deliver } from './util.js';
import { S, analysis } from './store.js';
import { buildModel, buildPdf, buildXlsx, buildCsv, rangeFor } from './report.js';
import { buildMonthlyBackup, monthlyCandidates, finishMonthly, deliverMany } from './backup.js';
import { field, select, checkbox, modal, busy, toast, nav, infoDialog, viewReceipt } from './ui.js';

const state = { month: 0, withReceipts: false, backupMonth: null };

function yearsAvailable() {
  const ys = new Set([Number(todayISO().slice(0, 4))]);
  for (const l of S.data.legs) ys.add(Number(l.date.slice(0, 4)));
  for (const t of S.data.trips) ys.add(Number(t.start.slice(0, 4)));
  for (const p of S.data.periods) ys.add(Number(p.start.slice(0, 4)));
  return [...ys].sort((a, b) => b - a);
}

export function renderReport(root) {
  const years = yearsAvailable();
  if (!years.includes(S.year)) S.year = years[0];
  const range = rangeFor(S.year, state.month);
  analysis();
  const m = buildModel(range);
  const sum = m.sum;

  root.append(h('div', { class: 'card' },
    h('div', { class: 'grid2' },
      field('Jahr', select(years.map((y) => [y, String(y)]), S.year, (v) => { S.year = Number(v); nav.render(); })),
      field('Zeitraum', select([[0, 'Ganzes Jahr'], ...MONTHS.map((n, i) => [i + 1, n])], state.month, (v) => { state.month = Number(v); nav.render(); })))));

  // Zusammenfassung
  const box = h('div', { class: 'card' }, h('h2', null, `Ansetzbare Aufwendungen – ${range.label}`));
  for (const r of m.summaryRows) {
    box.append(h('div', { class: 'stat' + (r.bold && r.pos === 'Summe' ? ' total' : '') },
      h('span', null, r.bold && r.pos !== 'Summe' ? h('strong', null, r.pos) : r.pos, r.count !== '' ? h('div', { class: 'sub' }, `${r.count} ${r.unit}`) : null),
      h('span', { class: r.bold ? 'nowrap' : 'nowrap' }, euro(r.amount))));
  }
  box.append(h('p', { class: 'small muted' }, `Berechnet mit den Sätzen ${m.stand}. Keine Steuerberatung – bitte mit Ihrem Steuerberater abstimmen.`));
  root.append(box);

  // Hinweise
  if (m.warnings.length) {
    const w = h('div', { class: 'card' }, h('h3', null, `Hinweise zur Prüfung (${m.warnings.length})`));
    m.warnings.slice(0, 30).forEach((x) => w.append(h('div', { class: 'leg', style: { cursor: 'pointer' }, onclick: () => { S.date = x.date; S.view = 'day'; nav.render(); } },
      h('div', { class: 'grow' }, h('div', { class: 't' }, fmtDay(x.date)), h('div', { class: 'why bad' }, x.text)), h('div', null, '›'))));
    if (m.warnings.length > 30) w.append(h('p', { class: 'small muted' }, `… und ${m.warnings.length - 30} weitere.`));
    root.append(w);
  }

  // Nachweise
  const withBlobs = m.belege.filter((b) => b.rec.hasBlob).length;
  const out = h('div', { class: 'card' }, h('h3', null, 'Nachweis für das Finanzamt'),
    h('p', { class: 'small muted' }, 'Erzeugt die Unterlagen direkt auf Ihrem Gerät. Über das Teilen-Menü können Sie sie per Mail versenden oder in „Dateien“/iCloud ablegen.'),
    withBlobs ? checkbox(`Belege im PDF anhängen (${withBlobs} mit Bild)`, state.withReceipts, (v) => { state.withReceipts = v; }) : null,
    h('div', { class: 'grid3 gap' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => exportAs('pdf', range) }, 'PDF'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => exportAs('xlsx', range) }, 'Excel'),
      h('button', { class: 'btn', type: 'button', onclick: () => exportAs('csv', range) }, 'CSV')));
  root.append(out);

  // Details
  const det = (title, content, open) => { const d = h('details', { class: 'card' }, h('summary', { style: { fontWeight: 700, cursor: 'pointer' } }, title), content); if (open) d.open = true; return d; };

  const fahrtTbl = h('div', { class: 'scroll-x' }, h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, ['Datum', 'Strecke', 'Einordnung', 'Betrag'].map((t, i) => h('th', { class: i === 3 ? 'r' : '' }, t)))),
    h('tbody', null, m.fahrten.map((f) => h('tr', { class: 'click', onclick: () => { S.date = f.date; S.view = 'day'; nav.render(); } },
      h('td', { class: 'nowrap' }, fmtDay(f.date)), h('td', null, f.strecke), h('td', null, f.cls, f.note ? h('div', { class: 'small muted' }, f.note) : null), h('td', { class: 'r' }, f.amount ? euro(f.amount) : '–'))))));
  root.append(det(`Fahrten (${m.fahrten.length})`, m.fahrten.length ? fahrtTbl : h('div', { class: 'empty' }, 'Keine Fahrten im Zeitraum.')));

  if (m.fhf.length) root.append(det(`Familienheimfahrten (${m.fhf.length})`, h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, h('th', null, 'KW'), h('th', null, 'Datum'), h('th', { class: 'r' }, 'km'), h('th', { class: 'r' }, 'Betrag'))),
    h('tbody', null, m.fhf.map((f) => h('tr', null, h('td', null, f.week), h('td', null, fmtDay(f.date), f.note ? h('div', { class: 'small muted' }, f.note) : null), h('td', { class: 'r' }, fmtNum(f.km)), h('td', { class: 'r' }, euro(f.amount))))))));

  if (m.vz.length || m.periods.length) {
    const info = m.periods.map((p) => h('p', { class: 'small' }, `dHH ${fmtDate(p.start)} – ${p.end ? fmtDate(p.end) : 'laufend'}`, p.vzStart ? ` · Verpflegung bis ${fmtDate(p.vzEnd)}` : ''));
    root.append(det(`Verpflegung dHH (${m.vz.length} Tage)`, h('div', null, ...info, m.vz.length ? h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, 'Datum'), h('th', null, 'Abwesenheit'), h('th', { class: 'r' }, 'Betrag'))),
      h('tbody', null, m.vz.map((v) => h('tr', { class: 'click', onclick: () => { S.date = v.date; S.view = 'day'; nav.render(); } }, h('td', { class: 'nowrap' }, fmtDay(v.date)), h('td', null, v.abw, v.note ? h('div', { class: 'small muted' }, v.note) : null), h('td', { class: 'r' }, euro(v.amount)))))) : h('div', { class: 'empty' }, 'Keine Tage im Zeitraum.'))));
  }

  if (m.trips.length) root.append(det(`Dienstreisen (${m.trips.length})`, h('div', null, m.trips.map((t) => h('div', { class: 'stat', style: { cursor: 'pointer' }, onclick: () => { S.tripId = t.trip.id; nav.go('trips'); } },
    h('span', null, t.trip.ziel || 'Dienstreise', h('div', { class: 'sub' }, `${fmtDate(t.trip.start)}${t.trip.end && t.trip.end !== t.trip.start ? ' – ' + fmtDate(t.trip.end) : ''}`)), h('span', null, euro(t.calc.total)))))));

  if (m.belege.length) root.append(det(`Belegverzeichnis (${m.belege.length})`, h('div', { class: 'scroll-x' }, h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, h('th', null, 'Nr.'), h('th', null, 'Datum'), h('th', null, 'Art'), h('th', { class: 'r' }, 'Betrag'), h('th', null, 'Verbleib'))),
    h('tbody', null, m.belege.map((b) => h('tr', { class: 'click', onclick: () => viewReceipt(b.rec) }, h('td', null, b.nr), h('td', null, fmtDate(b.date)), h('td', null, b.kind), h('td', { class: 'r' }, b.amount ? euro(b.amount) : ''), h('td', { class: 'small' }, b.status))))))));

  renderMonthly(root);
}

async function exportAs(kind, range) {
  const b = busy('Wird erstellt …');
  try {
    const m = buildModel(range);
    let blob, name;
    if (kind === 'pdf') { const r = await buildPdf(m, { withReceipts: state.withReceipts }); blob = r.blob; name = `Fahrtenbuch-${range.key}.pdf`; }
    else if (kind === 'xlsx') { blob = await buildXlsx(m); name = `Fahrtenbuch-${range.key}.xlsx`; }
    else { blob = buildCsv(m); name = `Fahrten-${range.key}.csv`; }
    b.done();
    const r = await deliver(blob, name, 'Fahrtenbuch ' + range.label);
    if (r === 'downloaded') toast('Datei wurde heruntergeladen');
  } catch (e) { b.done(); infoDialog('Fehler', 'Die Datei konnte nicht erstellt werden: ' + (e.message || e)); }
}

function renderMonthly(root) {
  const prev = prevMonthKey(todayISO());
  if (!state.backupMonth) state.backupMonth = prev;
  const opts = [];
  const now = new Date();
  for (let i = 0; i < 18; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    opts.push([k, `${MONTHS[d.getMonth()]} ${d.getFullYear()}`]);
  }
  const cands = monthlyCandidates(state.backupMonth);
  const withImg = cands.filter((r) => r.hasBlob).length;
  const done = S.meta.lastMonthlyBackup;
  root.append(h('div', { class: 'card' }, h('h3', null, 'Monatssicherung der Belege'),
    h('p', { class: 'small muted' }, 'Bündelt die Belege eines Monats mit Belegverzeichnis und Monatsübersicht in einer Datei, die Sie zu Ihren privaten Unterlagen legen. Danach können die Belegbilder aus der App gelöscht werden; Beträge und Belegnummern bleiben erhalten.'),
    field('Monat', select(opts, state.backupMonth, (v) => { state.backupMonth = v; nav.render(); })),
    h('p', { class: 'small' }, `${cands.length} Beleg(e) im Monat, davon ${withImg} mit Bild in der App.${done ? ` Zuletzt gesichert: ${done}.` : ''}`),
    h('button', { class: 'btn primary block', type: 'button', onclick: () => doMonthly(state.backupMonth) }, 'Monatssicherung erstellen & teilen')));
}

async function doMonthly(monthKey) {
  const b = busy('Monatssicherung wird erstellt …');
  let res;
  try { res = await buildMonthlyBackup(monthKey); }
  catch (e) { b.done(); infoDialog('Fehler', 'Die Sicherung konnte nicht erstellt werden: ' + (e.message || e)); return; }
  b.done();
  const r = await deliverMany(res.files, `Fahrtenbuch Monatssicherung ${monthKey}`);
  if (r === 'cancelled') { toast('Abgebrochen – nichts wurde verändert.'); return; }
  await new Promise((resolve) => {
    let handled = false;
    const fin = async (mode) => { if (handled) return; handled = true; if (mode) await finishMonthly(monthKey, res.receipts, mode === 'delete'); resolve(); if (mode) { toast(mode === 'delete' ? 'Belegbilder aus der App gelöscht' : 'Als gesichert vermerkt'); nav.render(); } };
    modal({
      title: 'Sicherung abgelegt?',
      body: h('div', null, h('p', null, `Die Monatssicherung (${res.files.length} Datei${res.files.length > 1 ? 'en' : ''}, ${res.count} Beleg${res.count === 1 ? '' : 'e'}) wurde ${r === 'shared' ? 'geteilt' : 'heruntergeladen'}.`),
        h('p', null, 'Löschen Sie die Belegbilder in der App erst, wenn die Datei sicher bei Ihnen liegt (E-Mail angekommen oder in Dateien/iCloud gespeichert). Die App kann das nicht selbst prüfen.')),
      actions: [{ label: 'Später entscheiden', onClick: () => fin(null) }, { label: 'Gesichert – Bilder behalten', onClick: () => fin('keep') }, { label: 'Gesichert – Bilder löschen', kind: 'danger', onClick: () => fin('delete') }],
      onClose: () => fin(null),
    });
  });
}
