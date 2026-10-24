// Gesetzliche Sätze mit Gültigkeitszeitraum.
// Bei Rechtsänderungen hier einen neuen Eintrag mit "from" ergänzen – bereits
// erfasste Fahrten behalten automatisch den zu ihrem Datum gültigen Satz.
export const RATES_STAND = 'Stand 10/2026 (Steueränderungsgesetz 2025)';

// Entfernungspauschale (Wohnung–erste Tätigkeitsstätte, § 9 Abs. 1 S. 3 Nr. 4 EStG)
// und Familienheimfahrt (§ 9 Abs. 1 S. 3 Nr. 5 S. 6 EStG): € je vollem Entfernungskilometer
export const ENTFERNUNG = [
  { from: '2000-01-01', k20: 0.30, rest: 0.30 },
  { from: '2021-01-01', k20: 0.30, rest: 0.35 },
  { from: '2022-01-01', k20: 0.30, rest: 0.38 },
  { from: '2026-01-01', k20: 0.38, rest: 0.38 },
];

// Dienstreise / Auswärtstätigkeit: € je gefahrenem Kilometer (§ 9 Abs. 1 S. 3 Nr. 4a EStG)
export const KM_DIENSTREISE = [
  { from: '2000-01-01', pkw: 0.30, moto: 0.20 },
];

// Verpflegungspauschalen Inland (§ 9 Abs. 4a EStG): kurz = >8 Std. bzw. An-/Abreisetag, voll = 24 Std.
export const VERPFLEGUNG = [
  { from: '2014-01-01', kurz: 12, voll: 24 },
  { from: '2020-01-01', kurz: 14, voll: 28 },
];

// Kürzung bei gestellten Mahlzeiten (Anteil an der vollen Tagespauschale)
export const MAHLZEIT_KUERZUNG = { f: 0.20, m: 0.40, a: 0.40 };

// Höchstbetrag der Entfernungspauschale, wenn nicht der eigene Pkw genutzt wird
export const ENTFERNUNG_HOECHSTBETRAG = 4500;

// Verpflegung bei doppelter Haushaltsführung: Monate ab Bezug; Unterbrechung (Tage) für Neustart
export const DHH_VERPFLEGUNG_MONATE = 3;
export const DHH_UNTERBRECHUNG_TAGE = 28;

export function rateFor(table, date) {
  let r = table[0];
  for (const e of table) if (e.from <= date) r = e;
  return r;
}
