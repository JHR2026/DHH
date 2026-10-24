// Ansicht "Kalender": Jahreskalender mit Feiertagen, Urlaub, Krankheit, Fahrten und Dienstreisen
import { h, MONTHS, WD_SHORT, daysInMonth, iso, weekday, todayISO, rangeDates, isWeekend, fmtDate, fmtDay } from './util.js';
import { S, saveDay, dayRec, holidaysFor, remove } from './store.js';
import { holidays, BUNDESLAENDER } from './holidays.js';
import { STATUS_LABEL } from './calc.js';
import { field, select, dateInput, checkbox, modal, confirmDialog, toast, nav } from './ui.js';

export function renderCalendar(root) {
  const year = S.year;
  const land = S.data.settings.bundesland;
  const hol = holidaysFor();
  const today = todayISO();
  const statusOf = new Map(S.data.days.map((d) => [d.date, d.status]));
  const legDays = new Set(S.data.legs.map((l) => l.date));
  const tripDays = new Set();
  S.data.trips.forEach((t) => rangeDates(t.start, t.end || t.start).forEach((d) => tripDays.add(d)));
  const inDhh = (d) => S.data.periods.some((p) => p.start <= d && (!p.end || d <= p.end));

  root.append(h('div', { class: 'row' },
    h('button', { class: 'btn', type: 'button', onclick: () => { S.year--; nav.render(); } }, '‹'),
    h('div', { class: 'grow', style: { textAlign: 'center', fontWeight: 700, fontSize: '18px' } }, String(year)),
    h('button', { class: 'btn', type: 'button', onclick: () => { S.year++; nav.render(); } }, '›')));

  if (!land) root.append(h('div', { class: 'banner' }, h('div', { class: 'grow' }, 'Bitte in den Einstellungen das Bundesland wählen, damit die Feiertage angezeigt werden.'),
    h('button', { class: 'btn s', type: 'button', onclick: () => nav.go('settings') }, 'Einstellungen')));

  root.append(h('div', { class: 'row gap' },
    h('button', { class: 'btn grow', type: 'button', onclick: () => rangeDialog(year) }, 'Zeitraum markieren'),
    h('button', { class: 'btn grow', type: 'button', onclick: () => { S.date = today; S.view = 'day'; nav.render(); } }, 'Zu heute')));

  const months = h('div', { class: 'months gap' });
  for (let m = 1; m <= 12; m++) {
    const g = h('div', { class: 'g' });
    WD_SHORT.forEach((w) => g.append(h('div', { class: 'wd' }, w)));
    const first = weekday(iso(year, m, 1));
    for (let i = 0; i < first; i++) g.append(h('div'));
    for (let d = 1; d <= daysInMonth(year, m); d++) {
      const date = iso(year, m, d);
      const st = statusOf.get(date);
      const hn = hol(date);
      const cls = ['d'];
      if (isWeekend(date)) cls.push('we');
      if (hn) cls.push('hol');
      else if (st) cls.push(st);
      if (tripDays.has(date)) cls.push('trip');
      if (legDays.has(date)) cls.push('legs');
      if (date === today) cls.push('today');
      if (inDhh(date)) cls.push('dhh');
      const title = [fmtDay(date), hn, st && STATUS_LABEL[st], tripDays.has(date) && 'Dienstreise', legDays.has(date) && 'Fahrten erfasst'].filter(Boolean).join(' · ');
      g.append(h('button', { class: cls.join(' '), type: 'button', title, 'aria-label': title, onclick: () => { S.date = date; S.view = 'day'; nav.render(); } }, String(d)));
    }
    months.append(h('div', { class: 'cal' }, h('h3', null, MONTHS[m - 1]), g));
  }
  root.append(months);

  root.append(h('div', { class: 'legend' },
    legend('var(--danger-soft)', 'Feiertag'), legend('var(--info-soft)', 'Urlaub'), legend('var(--warn-soft)', 'Krank'),
    legend('var(--violet-soft)', 'Homeoffice'), legend('var(--grey-soft)', 'Frei'), legend('var(--accent-soft)', 'Doppelte Haushaltsführung'),
    h('span', null, '● Fahrten erfasst'), h('span', null, '▢ Dienstreise')));

  if (land) {
    const hs = holidays(year, land);
    root.append(h('div', { class: 'card' }, h('h3', null, `Feiertage ${year} – ${BUNDESLAENDER[land]}`),
      h('table', { class: 'tbl' }, h('tbody', null, Object.entries(hs).sort().map(([d, n]) => h('tr', null, h('td', null, fmtDay(d)), h('td', null, n))))),
      h('p', { class: 'small muted' }, 'Regionale Feiertage einzelner Gemeinden (z. B. Fronleichnam in Teilen Sachsens oder das Augsburger Friedensfest) sind nicht enthalten.')));
  }
}

const legend = (c, t) => h('span', null, h('i', { style: { background: c } }), t);

function rangeDialog(year) {
  const f = {};
  const body = h('div', null,
    field('Art', (f.kind = select([['urlaub', 'Urlaub'], ['krank', 'Krank'], ['homeoffice', 'Homeoffice'], ['frei', 'Frei / sonstiges'], ['clear', 'Markierung entfernen']], 'urlaub'))),
    h('div', { class: 'grid2' },
      field('Von', (f.from = dateInput(S.date))),
      field('Bis', (f.to = dateInput(S.date)))),
    checkbox('Wochenenden und Feiertage überspringen', true, (v) => { f.skip = v; }));
  f.skip = true;
  modal({
    title: 'Zeitraum markieren', body,
    actions: [{ label: 'Abbrechen' }, {
      label: 'Übernehmen', kind: 'primary', onClick: async () => {
        const from = f.from.value, to = f.to.value;
        if (!from || !to || from > to) { toast('Bitte einen gültigen Zeitraum wählen.'); return false; }
        const hol = holidaysFor();
        const days = rangeDates(from, to).filter((d) => !(f.skip && (isWeekend(d) || hol(d))));
        if (days.length > 120) { toast('Bitte höchstens 120 Tage auf einmal.'); return false; }
        const withLegs = days.filter((d) => f.kind.value !== 'clear' && f.kind.value !== 'frei' && S.data.legs.some((l) => l.date === d));
        if (withLegs.length && !(await confirmDialog(`An ${withLegs.length} dieser Tage sind bereits Fahrten erfasst (z. B. ${fmtDate(withLegs[0])}). Trotzdem markieren?`))) return false;
        for (const d of days) await saveDay(d, { status: f.kind.value === 'clear' ? null : f.kind.value });
        toast(`${days.length} Tage ${f.kind.value === 'clear' ? 'zurückgesetzt' : 'markiert'}`);
        nav.render();
      },
    }],
  });
}
