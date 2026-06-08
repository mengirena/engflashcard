/* sw.js — network-first with cache fallback (offline study works, never serves stale).
   Online: always fetch fresh and update the cache. Offline: serve last cached copy. */
var CACHE = 'flashcards-v18';
var SHELL = [
  './', './index.html',
  './styles.css?v=18', './app.js?v=18', './core.js?v=18',
  './manifest.webmanifest', './icons/icon.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // cache:'reload' so we never store a stale HTTP-cached copy
      return Promise.all(SHELL.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (url.hostname === 'api.github.com' || url.hostname === 'api.anthropic.com') return;
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

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
