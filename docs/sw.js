/* sw.js — caches the app shell so the app installs and works offline.
   Data (GitHub API / Anthropic API) always goes to the network. */
var CACHE = 'flashcards-shell-v12';
var SHELL = [
  './', './index.html', './styles.css', './app.js', './core.js',
  './manifest.webmanifest', './icons/icon.svg'
];

self.addEventListener('install', function (e) {
  // precache with cache:'reload' so we never store a stale HTTP-cached copy
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  // never touch API traffic
  if (url.hostname === 'api.github.com' || url.hostname === 'api.anthropic.com') return;
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;

  // NETWORK-FIRST: always get fresh code when online; fall back to cache offline.
  e.respondWith(
    fetch(e.request).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (hit) {
        return hit || (e.request.mode === 'navigate' ? caches.match('./index.html') : undefined);
      });
    })
  );
});
