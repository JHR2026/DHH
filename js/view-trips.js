// Ansicht "Dienstreisen": mehrtägige Reisen mit Einzelfahrten, Kosten, Mahlzeiten und Belegen
import { h, fmtDate, fmtDay, euro, fmtNum, toNum, rangeDates, todayISO, round2 } from './util.js';
import { S, save, remove, deleteReceipt, receiptById } from './store.js';
import { calcTrip, LOC, TRIP_MODES, COST_KINDS } from './calc.js';
import { MAHLZEIT_KUERZUNG } from './rates.js';
import { modal, confirmDialog, field, select, numInput, textInput, dateInput, checkbox, toast, nav, receiptPicker, viewReceipt } from './ui.js';

const encode = encodeURIComponent;
export function mapsUrl(origin, dest) {
  return `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${encode(origin || '')}&destination=${encode(dest || '')}`;
}
const addrOf = (key) => {
  const s = S.data.settings;
  return ({ home: s.addrHome, office: s.addrOffice, zweit: s.addrZweit })[key] || LOC[key];
};

function newDraft() {
  const t = todayISO();
  return { start: t, end: t, startTime: '08:00', endTime: '17:00', startOrt: 'office', ziel: '', zweck: '', legs: [], costs: [], meals: {}, erstattung: '', noVerpflegung: false, note: '' };
}

function startEdit(trip) {
  const draft = trip ? JSON.parse(JSON.stringify(trip)) : newDraft();
  draft.legs = draft.legs || []; draft.costs = draft.costs || []; draft.meals = draft.meals || {};
  const orig = new Set([...draft.legs, ...draft.costs].flatMap((e) => e.belegIds || []));
  S.tripEdit = { draft, isNew: !trip, session: { new: new Set() }, orig };
}

export function renderTrips(root) {
  if (S.tripId) { const t = S.data.trips.find((x) => x.id === S.tripId); S.tripId = null; if (t) startEdit(t); }
  if (S.tripEdit) return renderEdit(root);

  root.append(h('button', { class: 'btn primary block', type: 'button', onclick: () => { startEdit(null); nav.render(); } }, '+ Neue Dienstreise'));
  const trips = [...S.data.trips].sort((a, b) => b.start.localeCompare(a.start));
  if (!trips.length) root.append(h('div', { class: 'empty' }, 'Noch keine Dienstreisen erfasst.'));
  let year = null;
  for (const t of trips) {
    const y = t.start.slice(0, 4);
    if (y !== year) { year = y; root.append(h('h2', null, y)); }
    const c = calcTrip(t);
    root.append(h('div', { class: 'card', style: { cursor: 'pointer' }, onclick: () => { startEdit(t); nav.render(); } },
      h('div', { class: 'row spread' }, h('strong', null, t.ziel || 'Dienstreise'), h('strong', null, euro(c.total))),
      h('div', { class: 'small muted' }, `${fmtDate(t.start)}${t.end && t.end !== t.start ? ' – ' + fmtDate(t.end) : ''}${t.zweck ? ' · ' + t.zweck : ''}`),
      h('div', { class: 'small' }, `Fahrt ${euro(c.fahrt)} · Übernachtung ${euro(c.uebernachtung)} · Nebenkosten ${euro(c.neben)} · Verpflegung ${euro(c.verpflegung)}`)));
  }
}

function renderEdit(root) {
  const E = S.tripEdit;
  const d = E.draft;
  const boxLegs = h('div'), boxCosts = h('div'), boxMeals = h('div'), boxSum = h('div');

  const refresh = () => { drawLegs(); drawCosts(); drawMeals(); drawSum(); };

  function drawSum() {
    const c = calcTrip(d);
    boxSum.replaceChildren(
      h('div', { class: 'stat' }, h('span', null, 'Fahrtkosten'), h('span', null, euro(c.fahrt))),
      h('div', { class: 'stat' }, h('span', null, 'Übernachtung'), h('span', null, euro(c.uebernachtung))),
      h('div', { class: 'stat' }, h('span', null, 'Parken, Nebenkosten, Sonstiges'), h('span', null, euro(c.neben))),
      h('div', { class: 'stat' }, h('span', null, 'Verpflegungsmehraufwand'), h('span', null, euro(c.verpflegung))),
      c.erstattung ? h('div', { class: 'stat' }, h('span', null, 'abzgl. Erstattung Arbeitgeber'), h('span', null, '− ' + euro(c.erstattung))) : null,
      h('div', { class: 'stat total' }, h('span', null, 'Summe Dienstreise'), h('span', null, euro(c.total))),
      c.longTrip ? h('p', { class: 'small', style: { color: 'var(--warn)' } }, 'Die Reise dauert länger als drei Monate. Beim selben Einsatzort gilt für den Verpflegungsmehraufwand die Dreimonatsfrist – bitte ggf. „Verpflegung nicht ansetzen“ wählen.') : null);
  }

  function drawLegs() {
    boxLegs.replaceChildren();
    if (!d.legs.length) boxLegs.append(h('div', { class: 'empty' }, 'Noch keine Fahrten.'));
    const calc = calcTrip(d).legs;
    d.legs.forEach((l, i) => {
      boxLegs.append(h('div', { class: 'leg' },
        h('div', { class: 'grow', style: { cursor: 'pointer' }, onclick: async () => { await legDialog(d, E, i); refresh(); } },
          h('div', { class: 't' }, `${l.von || '?'} → ${l.nach || '?'}`),
          h('div', { class: 'small muted' }, `${fmtDate(l.date || d.start)} · ${TRIP_MODES[l.mode] || ''}${toNum(l.km) ? ' · ' + fmtNum(toNum(l.km)) + ' km' : ''}${(l.belegIds || []).length ? ' · 📎 ' + l.belegIds.length : ''}`)),
        h('div', { class: 'right' }, h('div', { class: 'amt' }, euro(calc[i] ? calc[i].amountCalc : 0)),
          h('button', { class: 'btn s ghost', type: 'button', 'aria-label': 'Fahrt entfernen', onclick: async () => { if (await confirmDialog('Diese Fahrt entfernen?', { danger: true, ok: 'Entfernen' })) { d.legs.splice(i, 1); refresh(); } } }, '🗑'))));
    });
  }

  function drawCosts() {
    boxCosts.replaceChildren();
    if (!d.costs.length) boxCosts.append(h('div', { class: 'empty' }, 'Noch keine Kosten.'));
    d.costs.forEach((c, i) => {
      boxCosts.append(h('div', { class: 'leg' },
        h('div', { class: 'grow', style: { cursor: 'pointer' }, onclick: async () => { await costDialog(d, E, i); refresh(); } },
          h('div', { class: 't' }, COST_KINDS[c.kind] || c.kind),
          h('div', { class: 'small muted' }, `${fmtDate(c.date || d.start)}${c.note ? ' · ' + c.note : ''}${(c.belegIds || []).length ? ' · 📎 ' + c.belegIds.length : ''}`)),
        h('div', { class: 'right' }, h('div', { class: 'amt' }, euro(toNum(c.amount))),
          h('button', { class: 'btn s ghost', type: 'button', 'aria-label': 'Kosten entfernen', onclick: async () => { if (await confirmDialog('Diese Kosten entfernen?', { danger: true, ok: 'Entfernen' })) { d.costs.splice(i, 1); refresh(); } } }, '🗑'))));
    });
  }

  function drawMeals() {
    boxMeals.replaceChildren();
    const c = calcTrip(d);
    if (d.noVerpflegung) { boxMeals.append(h('p', { class: 'muted small' }, 'Verpflegungsmehraufwand wird nicht angesetzt.')); return; }
    c.days.forEach((day) => {
      const m = d.meals[day.date] || {};
      const set = (k, v) => { d.meals[day.date] = { ...(d.meals[day.date] || {}), [k]: v }; drawMeals(); drawSum(); };
      boxMeals.append(h('div', { class: 'leg' },
        h('div', { class: 'grow' }, h('div', { class: 't' }, fmtDay(day.date)),
          h('div', { class: 'row wrap' }, checkbox('Frühstück', m.f, (v) => set('f', v)), checkbox('Mittag', m.m, (v) => set('m', v)), checkbox('Abend', m.a, (v) => set('a', v)))),
        h('div', { class: 'right' }, h('div', { class: 'amt' }, euro(day.amount)), day.cut ? h('div', { class: 'small muted' }, `Kürzung ${euro(day.cut)}`) : null)));
    });
  }

  const f = {};
  const dateChanged = () => {
    d.start = f.start.value || d.start; d.end = f.end.value || d.start;
    if (d.end < d.start) d.end = d.start;
    nav.render();
  };

  root.append(h('div', { class: 'row spread' },
    h('button', { class: 'btn s', type: 'button', onclick: async () => { await cancelEdit(); } }, '‹ Zurück'),
    h('strong', null, E.isNew ? 'Neue Dienstreise' : 'Dienstreise bearbeiten')));

  root.append(h('div', { class: 'card' },
    field('Zielort', (f.ziel = textInput(d.ziel, (v) => { d.ziel = v; }, { placeholder: 'z. B. Hamburg, Kunde Müller' }))),
    field('Anlass / Zweck', (f.zweck = textInput(d.zweck, (v) => { d.zweck = v; }, { placeholder: 'z. B. Workshop, Kundentermin' }))),
    field('Startort', (f.startOrt = select(Object.entries(LOC), d.startOrt, (v) => { d.startOrt = v; }))),
    h('div', { class: 'grid2' },
      field('Beginn', (f.start = dateInput(d.start, dateChanged))),
      field('Uhrzeit', (f.startTime = h('input', { type: 'time', value: d.startTime || '08:00', onchange: (e) => { d.startTime = e.target.value; drawMeals(); drawSum(); } })))),
    h('div', { class: 'grid2' },
      field('Ende', (f.end = dateInput(d.end, dateChanged))),
      field('Uhrzeit', (f.endTime = h('input', { type: 'time', value: d.endTime || '17:00', onchange: (e) => { d.endTime = e.target.value; drawMeals(); drawSum(); } })))),
    h('button', { class: 'btn s', type: 'button', onclick: () => window.open(mapsUrl(addrOf(d.startOrt), d.ziel), '_blank', 'noopener') }, '🗺 Route in Google Maps öffnen'),
    h('p', { class: 'small muted' }, 'Die Kilometer lesen Sie dort ab und tragen sie bei der Fahrt ein. Beim Öffnen werden Start und Ziel an Google übermittelt.')));

  root.append(h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h3', { style: { margin: 0 } }, 'Fahrten'),
    h('button', { class: 'btn s primary', type: 'button', onclick: async () => { await legDialog(d, E, -1); refresh(); } }, '+ Fahrt')), boxLegs));

  root.append(h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h3', { style: { margin: 0 } }, 'Weitere Kosten'),
    h('button', { class: 'btn s primary', type: 'button', onclick: async () => { await costDialog(d, E, -1); refresh(); } }, '+ Kosten')),
    h('p', { class: 'small muted' }, 'Übernachtung, Parken, Maut, Nebenkosten. Bahn, Taxi oder Flug erfassen Sie als Fahrt.'), boxCosts));

  root.append(h('div', { class: 'card' }, h('h3', null, 'Verpflegungsmehraufwand'),
    h('p', { class: 'small muted' }, 'Pauschalen je Abwesenheit. Wurden Mahlzeiten gestellt (z. B. Hotelfrühstück), bitte ankreuzen – die Pauschale wird gekürzt.'),
    checkbox('Verpflegungsmehraufwand nicht ansetzen', d.noVerpflegung, (v) => { d.noVerpflegung = v; drawMeals(); drawSum(); }), boxMeals));

  root.append(h('div', { class: 'card' },
    field('Erstattung durch den Arbeitgeber (€, steuerfrei)', (f.erst = numInput(d.erstattung, (v) => { d.erstattung = v; drawSum(); })), 'Wird von der Summe abgezogen.'),
    field('Notiz', (f.note = textInput(d.note || '', (v) => { d.note = v; })))));

  root.append(h('div', { class: 'card' }, h('h3', null, 'Ergebnis'), boxSum));

  root.append(h('div', { class: 'row' },
    !E.isNew ? h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      if (!(await confirmDialog('Diese Dienstreise samt zugehöriger Belege löschen?', { danger: true, ok: 'Löschen' }))) return;
      for (const id of [...d.legs, ...d.costs].flatMap((e) => e.belegIds || [])) await deleteReceipt(id);
      await remove('trips', d.id); S.tripEdit = null; nav.render(); toast('Dienstreise gelöscht');
    } }, 'Löschen') : null,
    h('button', { class: 'btn primary grow', type: 'button', onclick: saveTrip }, 'Speichern')));

  async function saveTrip() {
    if (!d.ziel.trim()) { toast('Bitte einen Zielort eintragen.'); return; }
    if (!d.start) { toast('Bitte das Datum eintragen.'); return; }
    if (!d.end || d.end < d.start) d.end = d.start;
    const rec = await save('trips', { ...d, ziel: d.ziel.trim(), erstattung: toNum(d.erstattung) || '' });
    const now = new Set([...d.legs, ...d.costs].flatMap((e) => e.belegIds || []));
    for (const id of E.orig) if (!now.has(id)) await deleteReceipt(id);
    S.tripEdit = null;
    toast('Dienstreise gespeichert');
    nav.render();
    return rec;
  }

  async function cancelEdit() {
    const changed = true;
    if (changed && !(await confirmDialog('Änderungen verwerfen und zurück zur Liste?', { ok: 'Verwerfen' }))) return;
    for (const id of E.session.new) await deleteReceipt(id);
    S.tripEdit = null; nav.render();
  }

  refresh();
}

// ---- Dialoge -----------------------------------------------------------------
function legDialog(d, E, index) {
  const isNew = index < 0;
  const prev = d.legs[d.legs.length - 1];
  const l = isNew
    ? { date: d.start, von: prev ? prev.nach : (d.startOrt ? LOC[d.startOrt] : ''), nach: d.ziel || '', mode: 'pkw_pausch', km: '', amount: '', note: '', belegIds: [] }
    : JSON.parse(JSON.stringify(d.legs[index]));
  l.belegIds = l.belegIds || [];
  const f = {};
  const preview = h('p', { class: 'small muted' });
  const kmField = field('Gefahrene Kilometer', (f.km = numInput(l.km, () => upd())));
  const amField = field('Betrag (€)', (f.amount = numInput(l.amount, () => upd())));
  const upd = () => {
    const m = f.mode.value;
    kmField.hidden = !['pkw_pausch', 'pkw_ist', 'moto'].includes(m);
    amField.hidden = ['pkw_pausch', 'moto'].includes(m);
    amField.firstChild.textContent = m === 'pkw_ist' ? 'Tatsächliche Kosten des Fahrzeugs (€)' : 'Betrag laut Beleg (€)';
    const c = calcTrip({ start: f.date.value || d.start, legs: [{ date: f.date.value, mode: m, km: f.km.value, amount: f.amount.value }] });
    preview.textContent = `Ansatz: ${euro(c.legs[0].amountCalc)}`;
  };
  const body = h('div', null,
    field('Datum', (f.date = dateInput(l.date, () => upd()))),
    h('div', { class: 'grid2' }, field('Von', (f.von = textInput(l.von))), field('Nach', (f.nach = textInput(l.nach)))),
    field('Verkehrsmittel', (f.mode = select(Object.entries(TRIP_MODES), l.mode, () => upd()))),
    kmField, amField, preview,
    h('button', { class: 'btn s', type: 'button', onclick: () => window.open(mapsUrl(f.von.value, f.nach.value), '_blank', 'noopener') }, '🗺 Route in Google Maps'),
    field('Notiz', (f.note = textInput(l.note))),
    h('h3', null, 'Belege'),
    receiptPicker(l.belegIds, () => ({ date: f.date.value || d.start, kind: (TRIP_MODES[f.mode.value] || '').split(' –')[0], amount: toNum(f.amount.value), tripId: d.id }), E.session));
  upd();
  return new Promise((resolve) => {
    modal({
      title: isNew ? 'Fahrt hinzufügen' : 'Fahrt bearbeiten', body, onClose: () => resolve(false),
      actions: [{ label: 'Abbrechen', onClick: () => resolve(false) }, {
        label: 'Übernehmen', kind: 'primary', onClick: () => {
          if (!f.von.value.trim() && !f.nach.value.trim()) { toast('Bitte Start oder Ziel eintragen.'); return false; }
          const out = { ...l, date: f.date.value || d.start, von: f.von.value.trim(), nach: f.nach.value.trim(), mode: f.mode.value, km: toNum(f.km.value) || '', amount: toNum(f.amount.value) || '', note: f.note.value.trim() };
          if (isNew) d.legs.push(out); else d.legs[index] = out;
          resolve(true);
        },
      }],
    });
  });
}

function costDialog(d, E, index) {
  const isNew = index < 0;
  const c = isNew ? { date: d.start, kind: 'uebernachtung', amount: '', note: '', belegIds: [] } : JSON.parse(JSON.stringify(d.costs[index]));
  c.belegIds = c.belegIds || [];
  const f = {};
  const body = h('div', null,
    field('Datum', (f.date = dateInput(c.date))),
    field('Art', (f.kind = select(Object.entries(COST_KINDS), c.kind))),
    field('Betrag (€)', (f.amount = numInput(c.amount))),
    field('Notiz', (f.note = textInput(c.note))),
    h('h3', null, 'Belege'),
    receiptPicker(c.belegIds, () => ({ date: f.date.value || d.start, kind: COST_KINDS[f.kind.value], amount: toNum(f.amount.value), tripId: d.id }), E.session));
  return new Promise((resolve) => {
    modal({
      title: isNew ? 'Kosten hinzufügen' : 'Kosten bearbeiten', body, onClose: () => resolve(false),
      actions: [{ label: 'Abbrechen', onClick: () => resolve(false) }, {
        label: 'Übernehmen', kind: 'primary', onClick: () => {
          if (!toNum(f.amount.value)) { toast('Bitte einen Betrag eintragen.'); return false; }
          const out = { ...c, date: f.date.value || d.start, kind: f.kind.value, amount: toNum(f.amount.value), note: f.note.value.trim() };
          if (isNew) d.costs.push(out); else d.costs[index] = out;
          resolve(true);
        },
      }],
    });
  });
}
