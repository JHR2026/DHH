// Gesetzliche Feiertage der deutschen Bundesländer
import { iso, addDays, weekday, fromUTC, toUTC } from './util.js';

export const BUNDESLAENDER = {
  BW: 'Baden-Württemberg', BY: 'Bayern', BE: 'Berlin', BB: 'Brandenburg', HB: 'Bremen',
  HH: 'Hamburg', HE: 'Hessen', MV: 'Mecklenburg-Vorpommern', NI: 'Niedersachsen',
  NW: 'Nordrhein-Westfalen', RP: 'Rheinland-Pfalz', SL: 'Saarland', SN: 'Sachsen',
  ST: 'Sachsen-Anhalt', SH: 'Schleswig-Holstein', TH: 'Thüringen',
};

// Ostersonntag (Gauß-Algorithmus, anonymer gregorianischer Algorithmus)
export function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const hh = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - hh - k) % 7;
  const m = Math.floor((a + 11 * hh + 22 * l) / 451);
  const month = Math.floor((hh + l - 7 * m + 114) / 31);
  const day = ((hh + l - 7 * m + 114) % 31) + 1;
  return iso(y, month, day);
}

// Buß- und Bettag: Mittwoch vor dem 23. November
function bussUndBettag(y) {
  let d = iso(y, 11, 22);
  while (weekday(d) !== 2) d = addDays(d, -1);
  return d;
}

const cache = new Map();

// Liefert { 'YYYY-MM-DD': 'Name' } für ein Jahr und Bundesland
export function holidays(y, land) {
  const key = y + '|' + land;
  if (cache.has(key)) return cache.get(key);
  const out = {};
  const add = (date, name) => { out[date] = name; };
  const E = easter(y);
  const ein = (...l) => l.includes(land);

  add(iso(y, 1, 1), 'Neujahr');
  add(addDays(E, -2), 'Karfreitag');
  add(addDays(E, 1), 'Ostermontag');
  add(iso(y, 5, 1), 'Tag der Arbeit');
  add(addDays(E, 39), 'Christi Himmelfahrt');
  add(addDays(E, 50), 'Pfingstmontag');
  add(iso(y, 10, 3), 'Tag der Deutschen Einheit');
  add(iso(y, 12, 25), '1. Weihnachtstag');
  add(iso(y, 12, 26), '2. Weihnachtstag');

  if (ein('BW', 'BY', 'ST')) add(iso(y, 1, 6), 'Heilige Drei Könige');
  if (ein('BE') && y >= 2019) add(iso(y, 3, 8), 'Internationaler Frauentag');
  if (ein('MV') && y >= 2023) add(iso(y, 3, 8), 'Internationaler Frauentag');
  if (ein('BB')) { add(E, 'Ostersonntag'); add(addDays(E, 49), 'Pfingstsonntag'); }
  if (ein('BW', 'BY', 'HE', 'NW', 'RP', 'SL')) add(addDays(E, 60), 'Fronleichnam');
  if (ein('SL')) add(iso(y, 8, 15), 'Mariä Himmelfahrt');
  if (ein('TH') && y >= 2019) add(iso(y, 9, 20), 'Weltkindertag');
  if (ein('BB', 'MV', 'SN', 'ST', 'TH') || (ein('HB', 'HH', 'NI', 'SH') && y >= 2018)) add(iso(y, 10, 31), 'Reformationstag');
  if (ein('BW', 'BY', 'NW', 'RP', 'SL')) add(iso(y, 11, 1), 'Allerheiligen');
  if (ein('SN')) add(bussUndBettag(y), 'Buß- und Bettag');

  cache.set(key, out);
  return out;
}

export function holidayName(date, land) {
  if (!land) return null;
  return holidays(Number(date.slice(0, 4)), land)[date] || null;
}
