/* sw.js — caches the app shell so the app installs and works offline.
   Data (GitHub API / Anthropic API) always goes to the network. */
var CACHE = 'flashcards-shell-v6';
var SHELL = [
  './', './index.html', './styles.css', './app.js', './core.js',
  './manifest.webmanifest', './icons/icon.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
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
  // never cache API traffic
  if (url.hostname === 'api.github.com' || url.hostname === 'api.anthropic.com') return;
  if (e.request.method !== 'GET') return;

  // app shell: cache-first, fall back to network, then to cached index for navigations
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (res) {
        if (url.origin === location.origin && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () {
        if (e.request.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
