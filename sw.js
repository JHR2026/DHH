// Service Worker: legt die App-Dateien auf dem Gerät ab, damit sie offline funktioniert.
// Bei einer neuen App-Version VERSION erhöhen – dann wird der Zwischenspeicher erneuert.
const VERSION = 'fahrtenbuch-v1.0.1';
const FILES = [
  './', './index.html', './app.css', './manifest.webmanifest',
  './js/app.js', './js/util.js', './js/rates.js', './js/holidays.js', './js/calc.js', './js/db.js', './js/store.js',
  './js/ui.js', './js/report.js', './js/backup.js', './js/view-day.js', './js/view-calendar.js', './js/view-trips.js',
  './js/view-report.js', './js/view-settings.js',
  './lib/jszip.min.js', './lib/pdf-lib.min.js',
  './icons/icon-32.png', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('fahrtenbuch-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()));
    })
  );
});
