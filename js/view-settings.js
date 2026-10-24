// Ansicht "Einstellungen": Stammdaten, Zeiträume der dHH, steuerliche Optionen, Sicherung & Abgleich
import { h, fmtDate, todayISO, euro, toNum, fmtNum, deliver, download } from './util.js';
import { S, analysis, saveSettings, save, remove, setMetaValue } from './store.js';
import { BUNDESLAENDER } from './holidays.js';
import { MODES } from './calc.js';
import { RATES_STAND, ENTFERNUNG, KM_DIENSTREISE, VERPFLEGUNG, rateFor } from './rates.js';
import { buildFullBackup, markFullBackupDone, readBackupFile, planMerge, applyMerge, describe, buildIcs, deliverMany } from './backup.js';
import { field, select, textInput, numInput, dateInput, checkbox, modal, confirmDialog, infoDialog, busy, toast, nav } from './ui.js';

export const APP_VERSION = '1.0.0';

// Eingabefeld, das beim Verlassen/Ändern sofort in die Einstellungen schreibt
function saved(input, key, parse = (v) => v) {
  input.addEventListener('change', async () => { await saveSettings({ [key]: parse(input.value) }); toast('Gespeichert', 1200); });
  return input;
}

export function renderSettings(root) {
  const s = S.data.settings;
  const A = analysis();

  // --- Allgemein
  root.append(h('div', { class: 'card' }, h('h2', null, 'Allgemein'),
    field('Bundesland (für Feiertage)', saved(select([['', 'Bitte wählen …'], ...Object.entries(BUNDESLAENDER)], s.bundesland || ''), 'bundesland'), 'Wird nur auf diesem Gerät gespeichert.'),
    field('Name (optional)', saved(textInput(s.name || '', null, { placeholder: 'erscheint nur im Kopf der Auswertung', autocomplete: 'off' }), 'name', (v) => v.trim())),
    field('E-Mail-Adresse für Sicherungen', saved(textInput(s.mailTo || '', null, { type: 'email', inputmode: 'email', placeholder: 'name@example.de', autocomplete: 'off' }), 'mailTo', (v) => v.trim()),
      'Die App kann Mails nicht selbst versenden. Beim Teilen wählen Sie „Mail“; die Adresse können Sie hier kopieren.'),
    s.mailTo ? h('button', { class: 'btn s', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(s.mailTo); toast('Adresse kopiert'); } catch (e) { toast(s.mailTo); } } }, 'Adresse kopieren') : null));

  // --- Strecken
  const km = (label, key, hint) => field(label, saved(numInput(s[key], null, { placeholder: 'km' }), key, (v) => toNum(v) || ''), hint);
  root.append(h('div', { class: 'card' }, h('h2', null, 'Strecken (einfache Entfernung)'),
    h('p', { class: 'small muted' }, 'Maßgeblich ist die kürzeste verkehrsgünstige Straßenverbindung. Ermitteln Sie die Werte einmal mit einem Routenplaner und tragen Sie volle Kilometer ein.'),
    km('Wohnung – Büro (km)', 'kmHomeOffice', 'Grundlage für Pendelfahrten und Familienheimfahrten.'),
    km('Büro – Zweitwohnung (km)', 'kmOfficeZweit'),
    km('Wohnung – Zweitwohnung (km, optional)', 'kmHomeZweit', 'Nur für die erste Fahrt und die letzte Rückfahrt der doppelten Haushaltsführung.'),
    field('Standard-Verkehrsmittel', saved(select(Object.entries(MODES), s.defaultMode || 'pkw'), 'defaultMode')),
    h('details', null, h('summary', { class: 'small', style: { cursor: 'pointer' } }, 'Adressen für Google-Maps-Links (optional)'),
      h('p', { class: 'small muted' }, 'Nur lokal gespeichert und nur für den Knopf „Route in Google Maps“ bei Dienstreisen. Erst beim Antippen dieses Knopfes werden Start und Ziel an Google übermittelt.'),
      field('Adresse Wohnung', saved(textInput(s.addrHome || '', null, { autocomplete: 'off' }), 'addrHome', (v) => v.trim())),
      field('Adresse Büro', saved(textInput(s.addrOffice || '', null, { autocomplete: 'off' }), 'addrOffice', (v) => v.trim())),
      field('Adresse Zweitwohnung', saved(textInput(s.addrZweit || '', null, { autocomplete: 'off' }), 'addrZweit', (v) => v.trim())))));

  // --- Doppelte Haushaltsführung
  const pc = h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', { style: { margin: 0 } }, 'Doppelte Haushaltsführung'), h('button', { class: 'btn s primary', type: 'button', onclick: () => periodDialog(null) }, '+ Zeitraum')));
  const periods = [...S.data.periods].sort((a, b) => a.start.localeCompare(b.start));
  if (!periods.length) pc.append(h('div', { class: 'empty' }, 'Noch kein Zeitraum eingetragen.'));
  for (const p of periods) {
    const w = A.windows.find((x) => x.period.id === p.id);
    pc.append(h('div', { class: 'leg', style: { cursor: 'pointer' }, onclick: () => periodDialog(p) },
      h('div', { class: 'grow' }, h('div', { class: 't' }, `${fmtDate(p.start)} – ${p.end ? fmtDate(p.end) : 'laufend'}`),
        h('div', { class: 'small muted' }, p.note || ''),
        w && w.start ? h('div', { class: 'small' }, `Verpflegungsmehraufwand ${fmtDate(w.start)} bis ${fmtDate(w.end)}${w.end >= todayISO() ? '' : ' (abgelaufen)'}`) : h('div', { class: 'small muted' }, 'Verpflegungsfrist beginnt mit der ersten Fahrt zur Zweitwohnung.')),
      h('div', null, '›')));
  }
  pc.append(h('p', { class: 'small muted' }, 'Mehrere Zeiträume sind möglich (z. B. bei einem Neustart nach einem Umzug). Für jeden Zeitraum beginnt der Verpflegungsmehraufwand neu.'));
  root.append(pc);

  // --- Steuerliche Optionen
  const oc = h('div', { class: 'card' }, h('h2', null, 'Steuerliche Optionen'),
    checkbox('Fahrten Zweitwohnung – Büro mit Entfernungspauschale ansetzen', s.zweitOfficePauschale !== false, async (v) => { await saveSettings({ zweitOfficePauschale: v }); toast('Gespeichert', 1200); }),
    h('p', { class: 'small muted' }, 'Standard: an. Bitte mit Ihrem Steuerberater abstimmen; hier lässt sich der Ansatz abschalten.'),
    h('h3', null, 'Heimfahrten je Kalenderjahr (Wahlrecht)'));
  const years = new Set([Number(todayISO().slice(0, 4))]);
  S.data.legs.forEach((l) => years.add(Number(l.date.slice(0, 4))));
  S.data.periods.forEach((p) => years.add(Number(p.start.slice(0, 4))));
  for (const y of [...years].sort((a, b) => b - a)) {
    const cur = (s.heimfahrtModus || {})[y] === 'alle' ? 'alle' : 'woechentlich';
    oc.append(field(String(y), select([['woechentlich', 'Eine Familienheimfahrt je Woche + Unterkunft + Verpflegung (Standard)'], ['alle', 'Alle Heimfahrten mit Entfernungspauschale (ohne Verpflegung dHH)']], cur, async (v) => {
      await saveSettings({ heimfahrtModus: { ...(s.heimfahrtModus || {}), [y]: v } }); nav.render();
    })));
  }
  root.append(oc);

  // --- Sicherung & Abgleich
  const last = S.meta.lastFullBackupAt;
  const bc = h('div', { class: 'card' }, h('h2', null, 'Sicherung & Geräte-Abgleich'),
    h('p', { class: 'small' }, last ? `Letzte Vollsicherung: ${new Date(last).toLocaleString('de-DE')}` : 'Noch keine Vollsicherung erstellt.'),
    h('p', { class: 'small muted' }, 'Ihre Daten liegen nur auf diesem Gerät. Sichern Sie regelmäßig und legen Sie die Datei in iCloud/Dateien oder per Mail ab. Mit derselben Datei gleichen Sie ein zweites Gerät ab: Daten werden zusammengeführt, nichts wird einfach überschrieben.'),
    h('button', { class: 'btn primary block', type: 'button', onclick: doFullBackup }, 'Vollsicherung erstellen & teilen'),
    h('div', { class: 'gap' }),
    (() => {
      const inp = h('input', { type: 'file', accept: '.zip,.json,application/zip,application/json', style: { display: 'none' } });
      inp.addEventListener('change', () => { const f = inp.files[0]; inp.value = ''; if (f) doImport(f); });
      return h('div', null, inp, h('button', { class: 'btn block', type: 'button', onclick: () => inp.click() }, 'Sicherung einspielen / Gerät abgleichen'));
    })(),
    h('div', { class: 'gap' }),
    h('button', { class: 'btn block', type: 'button', onclick: async () => { await deliver(buildIcs(), 'Fahrtenbuch-Erinnerung.ics', 'Monatliche Erinnerung'); } }, 'Monatliche Erinnerung in den Kalender (.ics)'),
    h('p', { class: 'small muted' }, 'Die Datei öffnen und „Alle hinzufügen“ wählen – der Kalender erinnert Sie dann jeden Monatsersten an die Monatssicherung.'));
  root.append(bc);

  // --- Speicher
  const stor = h('div', { class: 'card' }, h('h2', null, 'Speicher'), h('p', { class: 'small', id: 'storinfo' }, 'Wird ermittelt …'));
  root.append(stor);
  (async () => {
    const el = stor.querySelector('#storinfo');
    try {
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
      const mb = (n) => (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
      el.textContent = est ? `Belegt: ${mb(est.usage)} von ca. ${mb(est.quota)}. Dauerhafter Speicher: ${persisted ? 'angefordert/gewährt' : 'nicht gewährt'}.` : 'Speicherangaben sind auf diesem Gerät nicht verfügbar.';
      if (!persisted && navigator.storage && navigator.storage.persist) {
        stor.append(h('button', { class: 'btn s', type: 'button', onclick: async () => { const ok = await navigator.storage.persist(); toast(ok ? 'Dauerhafter Speicher gewährt' : 'Das Gerät hat dies nicht gewährt – bitte regelmäßig sichern.'); nav.render(); } }, 'Daten vor automatischem Löschen schützen'));
      }
    } catch (e) { el.textContent = 'Speicherangaben nicht verfügbar.'; }
  })();

  // --- Info
  const rE = rateFor(ENTFERNUNG, todayISO()), rK = rateFor(KM_DIENSTREISE, todayISO()), rV = rateFor(VERPFLEGUNG, todayISO());
  root.append(h('div', { class: 'card' }, h('h2', null, 'Hinterlegte Sätze'),
    h('p', { class: 'small muted' }, RATES_STAND),
    h('table', { class: 'tbl' }, h('tbody', null,
      row('Entfernungspauschale / Familienheimfahrt', rE.k20 === rE.rest ? `${euro(rE.k20)} je km` : `${euro(rE.k20)} (bis 20 km), ${euro(rE.rest)} (ab 21. km)`),
      row('Erste/letzte Fahrt dHH, Dienstreise Pkw', `${euro(rK.pkw)} je gefahrenem km`),
      row('Dienstreise Motorrad/Roller', `${euro(rK.moto)} je km`),
      row('Verpflegung Inland', `${euro(rV.kurz)} / ${euro(rV.voll)}`),
      row('Kürzung gestellte Mahlzeiten', '20 % / 40 % / 40 % der vollen Pauschale'),
      row('Verpflegung dHH', 'ersten 3 Monate; Neustart nach 4 Wochen Unterbrechung'))),
    h('p', { class: 'small muted' }, 'Ändern sich die gesetzlichen Werte, wird die App aktualisiert. Bereits erfasste Fahrten behalten den damals gültigen Satz.')));

  root.append(h('div', { class: 'card' }, h('h2', null, 'Über die App'),
    h('p', { class: 'small' }, `Fahrtenbuch Version ${APP_VERSION}`),
    h('p', { class: 'small muted' }, 'Die App ersetzt keine Steuerberatung. Die Berechnungen beruhen auf den hinterlegten Sätzen und Ihren Eingaben; bitte lassen Sie die Einordnung einmal von Ihrem Steuerberater prüfen. Alle Daten bleiben auf Ihrem Gerät, solange Sie sie nicht selbst exportieren.'),
    h('button', { class: 'btn s', type: 'button', onclick: async () => {
      if ('serviceWorker' in navigator) { const reg = await navigator.serviceWorker.getRegistration(); if (reg) { await reg.update(); toast('Auf Updates geprüft'); return; } }
      toast('Updates werden beim Start geprüft.');
    } }, 'Nach Update suchen')));
}

const row = (a, b) => h('tr', null, h('td', null, a), h('td', { class: 'r', style: { whiteSpace: 'normal' } }, b));

function periodDialog(p) {
  const d = p ? { ...p } : { start: todayISO(), end: null, note: '' };
  const f = {};
  const endBox = h('div');
  const drawEnd = () => {
    endBox.replaceChildren(field('Ende', (f.end = dateInput(d.end || todayISO(), (v) => { d.end = v; }, { disabled: !d.end }))));
    f.end.disabled = !d.end;
  };
  const laufend = checkbox('laufend (noch nicht beendet)', !d.end, (v) => { d.end = v ? null : (d.end || todayISO()); drawEnd(); });
  const body = h('div', null, field('Beginn (Bezug der Zweitwohnung)', (f.start = dateInput(d.start))), laufend, endBox, field('Notiz (optional)', (f.note = textInput(d.note || ''))));
  drawEnd();
  const acts = [{ label: 'Abbrechen' }];
  if (p) acts.push({ label: 'Löschen', kind: 'danger', onClick: async () => { if (!(await confirmDialog('Diesen Zeitraum löschen? Erfasste Fahrten bleiben erhalten, werden aber nicht mehr als dHH eingeordnet.', { danger: true, ok: 'Löschen' }))) return false; await remove('periods', p.id); nav.render(); } });
  acts.push({
    label: 'Speichern', kind: 'primary', onClick: async () => {
      const start = f.start.value;
      const end = d.end ? f.end.value : null;
      if (!start) { toast('Bitte den Beginn eintragen.'); return false; }
      if (end && end < start) { toast('Das Ende liegt vor dem Beginn.'); return false; }
      const overlap = S.data.periods.find((x) => (!p || x.id !== p.id) && x.start <= (end || '9999-12-31') && (!x.end || x.end >= start));
      if (overlap) { toast('Der Zeitraum überschneidet sich mit einem anderen.'); return false; }
      await save('periods', { ...(p || {}), start, end, note: f.note.value.trim() });
      nav.render();
    },
  });
  modal({ title: p ? 'Zeitraum bearbeiten' : 'Zeitraum hinzufügen', body, actions: acts });
}

async function doFullBackup() {
  const b = busy('Sicherung wird erstellt …');
  try {
    const res = await buildFullBackup();
    b.done();
    const r = await deliver(res.blob, res.name, 'Fahrtenbuch Sicherung');
    if (r !== 'cancelled') { await markFullBackupDone(); toast(`Sicherung erstellt (${res.receipts} Belegbilder)`); nav.render(); }
  } catch (e) { b.done(); infoDialog('Fehler', 'Die Sicherung konnte nicht erstellt werden: ' + (e.message || e)); }
}

async function doImport(file) {
  const b = busy('Datei wird gelesen …');
  let parsed;
  try { parsed = await readBackupFile(file); } catch (e) { b.done(); infoDialog('Datei nicht lesbar', e.message || String(e)); return; }
  b.done();
  const plan = planMerge(parsed.payload);
  const summary = h('div', null,
    h('p', null, `Neu: ${plan.add.length} · Aktualisiert: ${plan.update.length} · Unverändert: ${plan.same + plan.keep} · Konflikte: ${plan.conflicts.length}`),
    h('p', { class: 'small muted' }, 'Es wird zusammengeführt: neue Einträge kommen dazu, jeweils die neuere Änderung gewinnt. Bei Einträgen, die auf beiden Geräten geändert wurden, entscheiden Sie.'));
  const choices = {};
  if (plan.conflicts.length) {
    plan.conflicts.forEach((c) => {
      choices[c.id] = 'local';
      summary.append(h('div', { class: 'card' }, h('div', { class: 't' }, describe(c.store, c.inc.deleted ? c.cur : c.inc)),
        field('Welche Version behalten?', select([['local', `Dieses Gerät${c.cur.deleted ? ' (gelöscht)' : ''} – geändert ${new Date(c.cur.updatedAt).toLocaleString('de-DE')}`], ['incoming', `Importierte Datei${c.inc.deleted ? ' (gelöscht)' : ''} – geändert ${new Date(c.inc.updatedAt).toLocaleString('de-DE')}`]], 'local', (v) => { choices[c.id] = v; }))));
    });
  }
  if (!plan.add.length && !plan.update.length && !plan.conflicts.length) { await infoDialog('Nichts zu tun', 'Alle Daten aus der Datei sind bereits auf diesem Gerät vorhanden.'); await setMetaValue('lastSyncAt', Date.now()); return; }
  modal({
    title: 'Sicherung einspielen', body: summary,
    actions: [{ label: 'Abbrechen' }, {
      label: 'Zusammenführen', kind: 'primary', onClick: async () => {
        const bb = busy('Daten werden zusammengeführt …');
        try { const n = await applyMerge(plan, parsed.blobs, choices); bb.done(); toast(`${n} Einträge übernommen`); nav.render(); }
        catch (e) { bb.done(); infoDialog('Fehler', e.message || String(e)); }
      },
    }],
  });
}
