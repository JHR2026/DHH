// Berechnungslogik – reine Funktionen ohne DOM/Datenbank (daher auch einzeln testbar)
import {
  addDays, addMonths, diffDays, isoWeekKey, rangeDates, round2, toNum, weekday, isWeekend, fmtDate,
} from './util.js';
import {
  ENTFERNUNG, KM_DIENSTREISE, VERPFLEGUNG, MAHLZEIT_KUERZUNG, ENTFERNUNG_HOECHSTBETRAG,
  DHH_VERPFLEGUNG_MONATE, DHH_UNTERBRECHUNG_TAGE, rateFor,
} from './rates.js';

export const LOC = { home: 'Wohnung', office: 'Büro', zweit: 'Zweitwohnung' };
export const MODES = {
  pkw: 'Privater Pkw', oepnv: 'ÖPNV / Bahn', fahrrad: 'Fahrrad / zu Fuß', motorrad: 'Motorrad / Roller',
  taxi: 'Taxi', flug: 'Flug', sammel: 'Sammelbeförderung', sonst: 'Sonstiges',
};

export const CLASS_LABEL = {
  pendel_ho: 'Entfernungspauschale (Wohnung–Büro)',
  pendel_oz: 'Entfernungspauschale (Zweitwohnung–Büro)',
  pendel_hz: 'Entfernungspauschale (Heimfahrt, Wahlrecht)',
  fhf_hin: 'Familienheimfahrt',
  fhf_rueck: 'Rückfahrt zur Familienheimfahrt',
  erste_fahrt: 'Erste Fahrt (dHH, tatsächliche Kosten)',
  letzte_fahrt: 'Letzte Rückfahrt (dHH, tatsächliche Kosten)',
  zweit_office_aus: 'Nicht angesetzt (Option ausgeschaltet)',
  ohne_dhh: 'Nicht ansetzbar (außerhalb der dHH)',
  ungueltig: 'Ungültig',
};

const PENDEL = new Set(['pendel_ho', 'pendel_oz', 'pendel_hz']);

export function entfernungspauschale(km, date) {
  const k = Math.floor(toNum(km));
  if (k <= 0) return 0;
  const r = rateFor(ENTFERNUNG, date);
  return round2(Math.min(k, 20) * r.k20 + Math.max(k - 20, 0) * r.rest);
}

export function mealCut(meals, date) {
  if (!meals) return 0;
  const v = rateFor(VERPFLEGUNG, date).voll;
  return round2((meals.f ? v * MAHLZEIT_KUERZUNG.f : 0) + (meals.m ? v * MAHLZEIT_KUERZUNG.m : 0) + (meals.a ? v * MAHLZEIT_KUERZUNG.a : 0));
}

const byLegOrder = (a, b) =>
  a.date.localeCompare(b.date) || (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0);

/**
 * Ordnet alle Fahrten steuerlich ein und berechnet die Beträge.
 * data: { settings, periods, legs, days, trips }
 */
export function analyze(data, today, holidaysFor) {
  const s = data.settings || {};
  const km = { ho: toNum(s.kmHomeOffice), oz: toNum(s.kmOfficeZweit), hz: toNum(s.kmHomeZweit) };
  const periods = [...(data.periods || [])].sort((a, b) => a.start.localeCompare(b.start));
  const periodAt = (d) => periods.find((p) => p.start <= d && (!p.end || d <= p.end));
  const modeFor = (d) => ((s.heimfahrtModus || {})[d.slice(0, 4)] === 'alle' ? 'alle' : 'woechentlich');
  const zweitOfficeOn = s.zweitOfficePauschale !== false;
  const dienstKm = (d) => rateFor(KM_DIENSTREISE, d);

  const legs = [...(data.legs || [])].sort(byLegOrder);
  const warnings = [];
  const warn = (date, text, legId) => warnings.push({ date, text, legId });
  const items = [];

  // --- 1. Einordnung ------------------------------------------------------
  const chains = new Map(); // "periodId|date|first/last" -> aktiv
  for (const leg of legs) {
    const it = { leg, date: leg.date, cls: 'ungueltig', amount: 0, km: 0, note: '' };
    const set = new Set([leg.from, leg.to]);
    const p = periodAt(leg.date);
    const mode = modeFor(leg.date);
    it.period = p || null;

    if (leg.from === leg.to) {
      it.cls = 'ungueltig'; it.note = 'Start und Ziel sind gleich.';
    } else if (set.has('home') && set.has('office')) {
      it.km = km.ho;
      if (p && mode === 'woechentlich') it.cls = leg.to === 'home' ? 'fhf_hin' : 'fhf_rueck';
      else it.cls = 'pendel_ho';
    } else if (set.has('office') && set.has('zweit')) {
      it.km = km.oz;
      if (!p) { it.cls = 'ohne_dhh'; it.note = 'Kein Zeitraum einer doppelten Haushaltsführung an diesem Tag.'; }
      else it.cls = zweitOfficeOn ? 'pendel_oz' : 'zweit_office_aus';
    } else if (set.has('home') && set.has('zweit')) {
      it.km = km.hz;
      if (!p) { it.cls = 'ohne_dhh'; it.note = 'Kein Zeitraum einer doppelten Haushaltsführung an diesem Tag.'; }
      else if (mode === 'woechentlich') it.cls = leg.to === 'home' ? 'fhf_hin' : 'fhf_rueck';
      else { it.cls = 'pendel_hz'; it.km = km.ho; }
    }

    // Erste Fahrt / letzte Rückfahrt (Beginn bzw. Ende der dHH) – auch über das Büro
    if (p && it.cls !== 'ungueltig' && it.cls !== 'ohne_dhh') {
      if (leg.date === p.start) {
        const ck = p.id + '|first';
        if (leg.from === 'home' || chains.get(ck)) {
          chains.set(ck, leg.to !== 'zweit');
          it.cls = 'erste_fahrt';
        }
      }
      if (p.end && leg.date === p.end) {
        const ck = p.id + '|last';
        if (leg.from === 'zweit' || chains.get(ck)) {
          chains.set(ck, leg.to !== 'home');
          it.cls = 'letzte_fahrt';
        }
      }
    }
    items.push(it);
  }

  // --- 2. Beträge ---------------------------------------------------------
  // Entfernungspauschale: je Arbeitstag nur einmal (die längste Strecke)
  const pendelByDay = new Map();
  for (const it of items) if (PENDEL.has(it.cls)) {
    if (!pendelByDay.has(it.date)) pendelByDay.set(it.date, []);
    pendelByDay.get(it.date).push(it);
  }
  for (const [date, list] of pendelByDay) {
    list.sort((a, b) => b.km - a.km);
    list.forEach((it, i) => {
      if (i === 0) {
        it.amount = entfernungspauschale(it.km, date);
        if (!it.km) { it.note = 'Entfernung in den Stammdaten fehlt.'; warn(date, 'Entfernung in den Stammdaten fehlt.', it.leg.id); }
      } else it.note = 'Pro Arbeitstag wird nur eine Entfernungspauschale angesetzt.';
    });
  }

  // Familienheimfahrt: eine je Woche (gezählt wird die Fahrt zur Wohnung; Rückfahrt ist enthalten)
  const fhfWeeks = new Map();
  let lastHin = null, lastHinItem = null;
  for (const it of items) {
    if (it.cls === 'fhf_hin') {
      const wk = isoWeekKey(it.date);
      it.week = wk;
      if (!fhfWeeks.has(wk)) {
        fhfWeeks.set(wk, it);
        const useActual = ['flug', 'sammel'].includes(it.leg.mode) && toNum(it.leg.amount) > 0;
        it.amount = useActual ? round2(toNum(it.leg.amount)) : entfernungspauschale(km.ho, it.date);
        it.km = km.ho;
        if (!km.ho) { it.note = 'Entfernung Wohnung–Büro fehlt in den Stammdaten.'; warn(it.date, it.note, it.leg.id); }
      } else {
        it.note = 'Mehr als eine Familienheimfahrt in dieser Woche – nicht ansetzbar (ggf. Wahlrecht nutzen).';
        warn(it.date, it.note, it.leg.id);
      }
      lastHin = it.date; lastHinItem = it;
    } else if (it.cls === 'fhf_rueck') {
      it.km = km.ho;
      it.note = 'Rückfahrt – in der Familienheimfahrt enthalten.';
      if (lastHinItem && !lastHinItem.rueckDate && diffDays(lastHin, it.date) <= 14) { lastHinItem.rueckDate = it.date; it.hinDate = lastHin; it.note = `Rückfahrt zur Familienheimfahrt vom ${lastHin.split('-').reverse().join('.')} – im Betrag enthalten.`; }
      if (!lastHin || diffDays(lastHin, it.date) > 14) {
        it.note = 'Rückfahrt ohne erfasste Heimfahrt davor.';
        warn(it.date, 'Rückfahrt zum Beschäftigungsort, aber keine Heimfahrt davor erfasst.', it.leg.id);
      }
    } else if (it.cls === 'erste_fahrt' || it.cls === 'letzte_fahrt') {
      const useKm = toNum(it.leg.km) || it.km;
      it.km = useKm;
      if (it.leg.mode === 'pkw' || !it.leg.mode) it.amount = round2(useKm * dienstKm(it.date).pkw);
      else if (it.leg.mode === 'motorrad') it.amount = round2(useKm * dienstKm(it.date).moto);
      else it.amount = round2(toNum(it.leg.amount));
      if (!it.amount) { it.note = 'Betrag/Kilometer fehlen.'; warn(it.date, 'Erste/letzte Fahrt ohne Kilometer oder Betrag.', it.leg.id); }
    } else if (it.cls === 'ohne_dhh') {
      warn(it.date, it.note, it.leg.id);
    }
  }

  // Pendel-Fahrten mit leg.mode != 'pkw' unterliegen dem Höchstbetrag (siehe summarize)
  for (const it of items) it.capped = PENDEL.has(it.cls) && it.amount > 0 && it.leg.mode && it.leg.mode !== 'pkw';

  // --- 3. Verpflegungsmehraufwand bei doppelter Haushaltsführung ----------
  const dayMap = new Map((data.days || []).map((d) => [d.date, d]));
  const tripDays = new Set();
  for (const t of data.trips || []) rangeDates(t.start, t.end || t.start).forEach((d) => tripDays.add(d));

  const legsByDate = new Map();
  for (const l of legs) { if (!legsByDate.has(l.date)) legsByDate.set(l.date, []); legsByDate.get(l.date).push(l); }

  const dhhDays = [];
  const windows = [];
  for (const p of periods) {
    const last = p.end && p.end < today ? p.end : today;
    if (p.start > last) { windows.push({ period: p, start: null, end: null }); continue; }
    const firstLeg = legs.find((l) => l.date >= p.start && (!p.end || l.date <= p.end));
    let loc = firstLeg ? firstLeg.from : 'home';
    let wStart = p.start, wEnd = addDays(addMonths(p.start, DHH_VERPFLEGUNG_MONATE), -1), homeStreak = 0;
    for (const d of rangeDates(p.start, last)) {
      // Tage vor der ersten erfassten Fahrt: nicht erfasst, weder Verpflegung noch „Zuhause“-Serie
      if (!firstLeg || d < firstLeg.date) continue;
      const startLoc = loc;
      let touchedHome = false;
      for (const l of legsByDate.get(d) || []) {
        if (l.from !== loc) warn(d, `Fahrt beginnt in „${LOC[l.from]}“, zuletzt waren Sie laut Erfassung in „${LOC[loc]}“.`, l.id);
        loc = l.to;
        if (l.from === 'home' || l.to === 'home') touchedHome = true;
      }
      const sh = startLoc === 'home', eh = loc === 'home';
      const rate = rateFor(VERPFLEGUNG, d);
      let base = 0;
      if (!(sh && eh)) base = (sh || eh) ? rate.kurz : (touchedHome ? rate.kurz : rate.voll);
      if (sh && eh) { homeStreak++; }
      else {
        if (homeStreak >= DHH_UNTERBRECHUNG_TAGE) {
          wStart = d; wEnd = addDays(addMonths(d, DHH_VERPFLEGUNG_MONATE), -1);
        }
        homeStreak = 0;
      }
      const inWindow = wStart !== null && d >= wStart && d <= wEnd;
      const rec = dayMap.get(d) || {};
      let amount = inWindow ? base : 0;
      let note = '';
      if (base > 0 && !inWindow) note = 'Dreimonatsfrist abgelaufen';
      if (rec.vzOverride === 'none') { amount = 0; note = 'Manuell nicht angesetzt'; }
      else if (rec.vzOverride === 'kurz') { amount = rate.kurz; note = 'Manuell: ' + rate.kurz + ' €'; }
      else if (rec.vzOverride === 'voll') { amount = rate.voll; note = 'Manuell: ' + rate.voll + ' €'; }
      const cut = amount > 0 ? Math.min(mealCut(rec.meals, d), amount) : 0;
      amount = round2(amount - cut);
      if (tripDays.has(d)) { amount = 0; note = 'Dienstreise (siehe dort)'; }
      if (modeFor(d) === 'alle' && amount) { amount = 0; note = 'Wahlrecht: Entfernungspauschale für alle Fahrten'; }
      if (sh && eh && !note) note = 'Zuhause';
      if (base > 0 || rec.vzOverride) {
        dhhDays.push({ date: d, period: p, startLoc, endLoc: loc, base, cut, amount, note, inWindow });
      }
    }
    windows.push({ period: p, start: wStart, end: wEnd });
  }

  // --- 4. Plausibilität mit Kalender ---------------------------------------
  if (holidaysFor) {
    for (const it of items) {
      const d = it.date;
      const rec = dayMap.get(d);
      const hol = holidaysFor(d);
      const isPendel = PENDEL.has(it.cls);
      if (isPendel && it.amount > 0) {
        if (hol) warn(d, `Pendelfahrt an einem Feiertag (${hol}).`, it.leg.id);
        else if (isWeekend(d)) warn(d, 'Pendelfahrt an einem Wochenende.', it.leg.id);
      }
      if (rec && ['urlaub', 'krank', 'homeoffice'].includes(rec.status) && it.amount > 0 && ['pendel_ho', 'pendel_oz', 'pendel_hz'].includes(it.cls)) {
        warn(d, `Fahrt an einem Tag mit Status „${STATUS_LABEL[rec.status]}“.`, it.leg.id);
      }
    }
  }

  warnings.sort((a, b) => a.date.localeCompare(b.date));
  const byLeg = new Map(items.map((i) => [i.leg.id, i]));
  return { items, byLeg, dhhDays, windows, warnings, fhfWeeks };
}

export const STATUS_LABEL = { urlaub: 'Urlaub', krank: 'Krank', homeoffice: 'Homeoffice', frei: 'Frei / sonstiges' };

// ---------------------------------------------------------------------------
// Dienstreisen
// ---------------------------------------------------------------------------
export const TRIP_MODES = {
  pkw_pausch: 'Privater Pkw – Pauschale (0,30 €/km)',
  pkw_ist: 'Privater Pkw – tatsächliche Kosten',
  moto: 'Motorrad/Roller – Pauschale (0,20 €/km)',
  bahn: 'Bahn', oepnv: 'ÖPNV', taxi: 'Taxi', flug: 'Flug', miet: 'Mietwagen', sonst: 'Sonstiges',
};
export const COST_KINDS = {
  uebernachtung: 'Übernachtung', parken: 'Parken / Maut', neben: 'Reisenebenkosten', sonst: 'Sonstiges',
};

function hoursBetween(a, b) {
  if (!a || !b) return 0;
  const [h1, m1] = a.split(':').map(Number), [h2, m2] = b.split(':').map(Number);
  const d = (h2 * 60 + m2) - (h1 * 60 + m1);
  return d > 0 ? d / 60 : 0;
}

export function calcTrip(trip) {
  const end = trip.end || trip.start;
  const dates = rangeDates(trip.start, end);
  const days = [];
  let verp = 0;
  dates.forEach((d, i) => {
    const r = rateFor(VERPFLEGUNG, d);
    let base;
    if (dates.length === 1) base = hoursBetween(trip.startTime || '08:00', trip.endTime || '17:00') > 8 ? r.kurz : 0;
    else base = (i === 0 || i === dates.length - 1) ? r.kurz : r.voll;
    const cut = base > 0 ? Math.min(mealCut((trip.meals || {})[d], d), base) : 0;
    const amount = trip.noVerpflegung ? 0 : round2(base - cut);
    days.push({ date: d, base, cut, amount });
    verp += amount;
  });

  let fahrt = 0, km = 0;
  const legs = (trip.legs || []).map((l) => {
    const date = l.date || trip.start;
    const r = rateFor(KM_DIENSTREISE, date);
    let amt;
    if (l.mode === 'pkw_pausch') amt = round2(toNum(l.km) * r.pkw);
    else if (l.mode === 'moto') amt = round2(toNum(l.km) * r.moto);
    else amt = round2(toNum(l.amount));
    if (l.mode === 'pkw_pausch' || l.mode === 'pkw_ist' || l.mode === 'moto') km += toNum(l.km);
    fahrt += amt;
    return { ...l, amountCalc: amt };
  });

  const cost = { uebernachtung: 0, parken: 0, neben: 0, sonst: 0 };
  for (const c of trip.costs || []) cost[c.kind in cost ? c.kind : 'sonst'] += toNum(c.amount);
  const erstattung = round2(toNum(trip.erstattung));
  const nebenSum = round2(cost.parken + cost.neben + cost.sonst);
  const total = round2(fahrt + cost.uebernachtung + nebenSum + verp - erstattung);
  const duration = dates.length;
  return {
    days, legs, km: round2(km), verpflegung: round2(verp), fahrt: round2(fahrt),
    uebernachtung: round2(cost.uebernachtung), neben: nebenSum, erstattung, total, duration,
    longTrip: duration > 90,
  };
}

// ---------------------------------------------------------------------------
// Zusammenfassung für einen Zeitraum
// ---------------------------------------------------------------------------
export function summarize(analysis, trips, range) {
  const inRange = (d) => d >= range.from && d <= range.to;
  const sum = (arr, f) => round2(arr.reduce((a, x) => a + f(x), 0));
  const items = analysis.items.filter((i) => inRange(i.date));
  const by = (cls) => items.filter((i) => cls.includes(i.cls));

  const pendelHO = by(['pendel_ho']), pendelOZ = by(['pendel_oz']), pendelHZ = by(['pendel_hz']);
  const fhf = by(['fhf_hin']).filter((i) => i.amount > 0);
  const erste = by(['erste_fahrt']), letzte = by(['letzte_fahrt']);

  // Höchstbetrag bei Nutzung anderer Verkehrsmittel als dem eigenen Pkw (je Kalenderjahr)
  const capByYear = {};
  for (const i of items) if (i.capped) capByYear[i.date.slice(0, 4)] = (capByYear[i.date.slice(0, 4)] || 0) + i.amount;
  let capReduction = 0;
  for (const y in capByYear) capReduction += Math.max(0, capByYear[y] - ENTFERNUNG_HOECHSTBETRAG);

  const dhh = analysis.dhhDays.filter((d) => inRange(d.date) && d.amount > 0);
  const tripRows = (trips || []).filter((t) => inRange(t.start)).map((t) => ({ trip: t, calc: calcTrip(t) }));

  const r = {
    pendelHO: { days: pendelHO.filter((i) => i.amount > 0).length, amount: sum(pendelHO, (i) => i.amount) },
    pendelOZ: { days: pendelOZ.filter((i) => i.amount > 0).length, amount: sum(pendelOZ, (i) => i.amount) },
    pendelHZ: { days: pendelHZ.filter((i) => i.amount > 0).length, amount: sum(pendelHZ, (i) => i.amount) },
    fhf: { count: fhf.length, amount: sum(fhf, (i) => i.amount) },
    erste: { count: erste.length, amount: sum(erste, (i) => i.amount) },
    letzte: { count: letzte.length, amount: sum(letzte, (i) => i.amount) },
    capReduction: round2(capReduction),
    dhhVerpflegung: { days: dhh.length, amount: sum(dhh, (d) => d.amount) },
    trips: {
      count: tripRows.length,
      fahrt: sum(tripRows, (x) => x.calc.fahrt), uebernachtung: sum(tripRows, (x) => x.calc.uebernachtung),
      neben: sum(tripRows, (x) => x.calc.neben), verpflegung: sum(tripRows, (x) => x.calc.verpflegung),
      erstattung: sum(tripRows, (x) => x.calc.erstattung), total: sum(tripRows, (x) => x.calc.total),
    },
    items, dhhRows: dhh, tripRows,
    warnings: analysis.warnings.filter((w) => inRange(w.date)),
  };
  r.pendelSumme = round2(r.pendelHO.amount + r.pendelOZ.amount + r.pendelHZ.amount - r.capReduction);
  r.dhhFahrten = round2(r.fhf.amount + r.erste.amount + r.letzte.amount);
  r.total = round2(r.pendelSumme + r.dhhFahrten + r.dhhVerpflegung.amount + r.trips.total);
  return r;
}

export { fmtDate, weekday };
