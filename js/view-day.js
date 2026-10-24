// Ansicht "Erfassen": Fahrten und Status für einen Tag
import {
  h, addDays, todayISO, fmtDayLong, fmtDate, euro, fmtNum, toNum, isWeekend, isoWeekKey, round2,
} from './util.js';
import { S, analysis, save, remove, saveDay, dayRec, holidaysFor, tripAt } from './store.js';
import { LOC, MODES, CLASS_LABEL, STATUS_LABEL } from './calc.js';
import { modal, confirmDialog, field, select, numInput, textInput, dateInput, checkbox, toast, nav } from './ui.js';
import { rateFor } from './rates.js';
import { VERPFLEGUNG } from './rates.js';

const QUICK = [['home', 'office'], ['office', 'home'], ['zweit', 'office'], ['office', 'zweit'], ['home', 'zweit'], ['zweit', 'home']];

function kmFor(a, b) {
  const s = S.data.settings, set = new Set([a, b]);
  if (set.has('home') && set.has('office')) return toNum(s.kmHomeOffice);
  if (set.has('office') && set.has('zweit')) return toNum(s.kmOfficeZweit);
  return toNum(s.kmHomeZweit);
}

const periodAt = (d) => S.data.periods.find((p) => p.start <= d && (!p.end || d <= p.end));

export async function addLeg(date, from, to, extra = {}) {
  const s = S.data.settings;
  const w = [];
  const hol = holidaysFor()(date);
  if (hol) w.push(`Feiertag: ${hol}`);
  const rec = dayRec(date);
  if (rec && ['urlaub', 'krank', 'homeoffice'].includes(rec.status)) w.push(`Der Tag ist als „${STATUS_LABEL[rec.status]}“ markiert`);
  if (isWeekend(date) && from !== 'home' && to !== 'home') w.push('Wochenende');
  if ((from === 'zweit' || to === 'zweit') && !periodAt(date)) w.push('Kein Zeitraum der doppelten Haushaltsführung – die Fahrt wird nicht angesetzt');
  if (tripAt(date)) w.push('An diesem Tag ist eine Dienstreise eingetragen');
  if (w.length) {
    const ok = await confirmDialog(`${fmtDayLong(date)}\n\n• ${w.join('\n• ')}\n\nFahrt trotzdem eintragen?`, { ok: 'Trotzdem eintragen' });
    if (!ok) return null;
  }
  const same = S.data.legs.filter((l) => l.date === date);
  const order = Math.max(0, ...same.map((l) => l.order || 0)) + 1;
  const r = await save('legs', { date, from, to, mode: s.defaultMode || 'pkw', order, ...extra });
  if (!kmFor(from, to)) toast('Hinweis: Entfernung fehlt noch in den Einstellungen.');
  return r;
}

export function legDialog(leg, date) {
  const isNew = !leg;
  const d = { date: date || (leg && leg.date), from: 'home', to: 'office', mode: S.data.settings.defaultMode || 'pkw', km: '', amount: '', note: '', ...(leg || {}) };
  const locs = Object.entries(LOC);
  const f = {};
  const body = h('div', null,
    field('Datum', (f.date = dateInput(d.date))),
    h('div', { class: 'grid2' },
      field('Von', (f.from = select(locs, d.from))),
      field('Nach', (f.to = select(locs, d.to)))),
    field('Verkehrsmittel', (f.mode = select(Object.entries(MODES), d.mode))),
    h('div', { class: 'grid2' },
      field('Gefahrene km (optional)', (f.km = numInput(d.km)), 'Nur für erste/letzte Fahrt der dHH nötig'),
      field('Tatsächliche Kosten € (optional)', (f.amount = numInput(d.amount)), 'z. B. Bahnticket, Flug')),
    field('Notiz', (f.note = textInput(d.note))));
  return new Promise((resolve) => {
    const acts = [{ label: 'Abbrechen', onClick: () => resolve(false) }];
    if (!isNew) acts.push({ label: 'Löschen', kind: 'danger', onClick: async () => { if (await confirmDialog('Diese Fahrt löschen?', { danger: true, ok: 'Löschen' })) { await remove('legs', leg.id); resolve(true); } else return false; } });
    acts.push({
      label: 'Speichern', kind: 'primary', onClick: async () => {
        if (f.from.value === f.to.value) { toast('Start und Ziel dürfen nicht gleich sein.'); return false; }
        await save('legs', { ...(leg || {}), date: f.date.value || d.date, from: f.from.value, to: f.to.value, mode: f.mode.value, km: toNum(f.km.value) || '', amount: toNum(f.amount.value) || '', note: f.note.value.trim(), order: (leg && leg.order) || Math.max(0, ...S.data.legs.filter((l) => l.date === (f.date.value || d.date)).map((l) => l.order || 0)) + 1 });
        resolve(true);
      },
    });
    modal({ title: isNew ? 'Weitere Fahrt eintragen' : 'Fahrt bearbeiten', body, actions: acts, onClose: () => resolve(false) });
  });
}

export function renderDay(root) {
  const s = S.data.settings;
  const date = S.date;
  const A = analysis();
  const hol = holidaysFor()(date);
  const rec = dayRec(date);
  const trip = tripAt(date);
  const period = periodAt(date);
  const today = todayISO();
  const items = A.items.filter((i) => i.date === date);
  const dhh = A.dhhDays.find((x) => x.date === date);

  const setupMissing = !s.bundesland || !toNum(s.kmHomeOffice);

  // --- Datumsleiste
  root.append(h('div', { class: 'row' },
    h('button', { class: 'btn', type: 'button', 'aria-label': 'Vorheriger Tag', onclick: () => { S.date = addDays(date, -1); nav.render(); } }, '‹'),
    h('div', { class: 'grow' }, dateInput(date, (v) => { if (v) { S.date = v; nav.render(); } })),
    h('button', { class: 'btn', type: 'button', 'aria-label': 'Nächster Tag', onclick: () => { S.date = addDays(date, 1); nav.render(); } }, '›'),
    date !== today ? h('button', { class: 'btn s', type: 'button', onclick: () => { S.date = today; nav.render(); } }, 'Heute') : null));

  // --- Tagesinfo
  const chips = [];
  if (hol) chips.push(h('span', { class: 'chip hol' }, hol));
  else if (isWeekend(date)) chips.push(h('span', { class: 'chip' }, 'Wochenende'));
  if (rec && rec.status) chips.push(h('span', { class: 'chip ' + rec.status }, STATUS_LABEL[rec.status]));
  if (trip) chips.push(h('span', { class: 'chip trip' }, 'Dienstreise: ' + (trip.ziel || '')));
  chips.push(period ? h('span', { class: 'chip ok' }, 'Doppelte Haushaltsführung aktiv') : h('span', { class: 'chip' }, 'Keine dHH an diesem Tag'));
  const fw = A.fhfWeeks.get(isoWeekKey(date));
  if (fw) chips.push(h('span', { class: 'chip' }, `Familienheimfahrt dieser Woche: ${fmtDate(fw.date)}`));
  root.append(h('div', { class: 'card' }, h('h2', null, fmtDayLong(date)), h('div', null, chips)));

  if (setupMissing) {
    root.append(h('div', { class: 'card' }, h('h3', null, 'Einrichtung'), h('p', null, 'Bitte tragen Sie zuerst Bundesland, Entfernungen und den Zeitraum der doppelten Haushaltsführung ein.'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => nav.go('settings') }, 'Zu den Einstellungen')));
  }

  // --- Schnellerfassung
  const grid = h('div', { class: 'grid2 quick' });
  for (const [a, b] of QUICK) {
    const km = kmFor(a, b);
    grid.append(h('button', { class: 'btn', type: 'button', onclick: async () => { const r = await addLeg(date, a, b); if (r) { nav.render(); toast('Fahrt eingetragen'); } } },
      `${LOC[a]} → ${LOC[b]}`, h('small', null, km ? `${fmtNum(km)} km` : 'km fehlt')));
  }
  root.append(h('div', { class: 'card' }, h('h3', null, 'Fahrt eintragen'), grid,
    h('button', { class: 'btn block gap', type: 'button', onclick: async () => { if (await legDialog(null, date)) nav.render(); } }, 'Andere Fahrt …')));

  // --- Fahrten des Tages
  const list = h('div');
  if (!items.length) list.append(h('div', { class: 'empty' }, 'Für diesen Tag sind keine Fahrten erfasst.'));
  let sum = 0;
  for (const it of items) {
    sum += it.amount;
    const l = it.leg;
    const bad = ['ohne_dhh', 'ungueltig', 'zweit_office_aus'].includes(it.cls) || (it.cls === 'fhf_hin' && it.amount === 0);
    list.append(h('div', { class: 'leg' },
      h('div', { class: 'grow', onclick: async () => { if (await legDialog(l)) nav.render(); }, style: { cursor: 'pointer' } },
        h('div', { class: 't' }, `${LOC[l.from]} → ${LOC[l.to]}`),
        h('div', { class: 'small muted' }, `${MODES[l.mode] || ''}${it.km ? ' · ' + fmtNum(it.km) + ' km' : ''}${l.note ? ' · ' + l.note : ''}`),
        h('div', { class: 'why' + (bad ? ' bad' : '') }, CLASS_LABEL[it.cls] + (it.note ? ' – ' + it.note : ''))),
      h('div', { class: 'right' }, h('div', { class: 'amt' }, it.amount ? euro(it.amount) : '–'),
        h('button', { class: 'btn s ghost', type: 'button', 'aria-label': 'Fahrt löschen', onclick: async () => { if (await confirmDialog(`Fahrt „${LOC[l.from]} → ${LOC[l.to]}“ löschen?`, { danger: true, ok: 'Löschen' })) { await remove('legs', l.id); nav.render(); } } }, '🗑'))));
  }
  if (items.length) list.append(h('div', { class: 'stat total' }, h('span', null, 'Summe Fahrten'), h('span', null, euro(round2(sum)))));
  root.append(h('div', { class: 'card' }, h('h3', null, 'Fahrten an diesem Tag'), list));

  // --- Verpflegung dHH
  if (period && date <= today) {
    const rate = rateFor(VERPFLEGUNG, date);
    const meals = (rec && rec.meals) || {};
    const ov = (rec && rec.vzOverride) || '';
    const setMeal = async (k, v) => { await saveDay(date, { meals: { ...meals, [k]: v } }); nav.render(); };
    const info = dhh
      ? `${euro(dhh.amount)}${dhh.note ? ' – ' + dhh.note : ''}`
      : 'Kein Ansatz (laut Erfassung zu Hause oder kein Abwesenheitstag).';
    root.append(h('div', { class: 'card' }, h('h3', null, 'Verpflegungsmehraufwand (dHH)'),
      h('p', null, info),
      h('p', { class: 'small muted' }, `Automatisch aus Ihren Fahrten: An-/Abreisetag ${euro(rate.kurz)}, voller Tag ${euro(rate.voll)}, nur in den ersten drei Monaten.`),
      h('div', { class: 'grid3' },
        checkbox('Frühstück gestellt', meals.f, (v) => setMeal('f', v)),
        checkbox('Mittag gestellt', meals.m, (v) => setMeal('m', v)),
        checkbox('Abend gestellt', meals.a, (v) => setMeal('a', v))),
      field('Manuell festlegen', select([['', 'Automatisch'], ['none', 'Nicht ansetzen'], ['kurz', `${euro(rate.kurz)} (An-/Abreisetag)`], ['voll', `${euro(rate.voll)} (voller Tag)`]], ov, async (v) => { await saveDay(date, { vzOverride: v || null }); nav.render(); }))));
  }

  // --- Status
  const seg = h('div', { class: 'seg' });
  for (const k of ['urlaub', 'krank', 'homeoffice', 'frei']) {
    seg.append(h('button', { class: 'btn' + (rec && rec.status === k ? ' on ' + k : ''), type: 'button', onclick: async () => {
      if (rec && rec.status === k) await saveDay(date, { status: null });
      else {
        if (items.length && k !== 'frei') { if (!(await confirmDialog(`Für diesen Tag sind bereits Fahrten erfasst. Trotzdem als „${STATUS_LABEL[k]}“ markieren?`))) return; }
        await saveDay(date, { status: k });
      }
      nav.render();
    } }, STATUS_LABEL[k]));
  }
  root.append(h('div', { class: 'card' }, h('h3', null, 'Tag markieren'), seg,
    h('p', { class: 'small muted' }, 'Mehrere Tage am Stück markieren Sie im Kalender. Erneut tippen hebt die Markierung auf.'),
    field('Notiz zum Tag', textInput((rec && rec.note) || '', null, { onchange: async (e) => { await saveDay(date, { note: e.target.value.trim() || null }); } }))));

  if (trip) {
    root.append(h('div', { class: 'card' }, h('h3', null, 'Dienstreise'), h('p', null, `${trip.ziel || ''} · ${fmtDate(trip.start)} – ${fmtDate(trip.end || trip.start)}`),
      h('button', { class: 'btn', type: 'button', onclick: () => { S.tripId = trip.id; nav.go('trips'); } }, 'Dienstreise öffnen')));
  }
}
