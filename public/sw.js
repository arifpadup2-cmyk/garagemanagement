/* VIWO service worker — installable app shell.
 * Static shell is cached (app loads offline to the login screen); API and image
 * requests always go to the network (live data, never stale money/stock). */
var CACHE = 'viwo-shell-v1';
var SHELL = [
  '/', '/index.html', '/gms-backend.js', '/brand/intro.js',
  '/brand/viwo-word-white.png', '/brand/viwo-icon.png',
  '/brand/viwo-icon-192.png', '/brand/viwo-icon-512.png', '/manifest.json'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL).catch(function () {}); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;                 // never cache mutations
  if (url.origin !== self.location.origin) return;        // let cross-origin (fonts) pass through
  if (url.pathname.indexOf('/api/') === 0) return;        // live data — network only
  // Static shell: cache-first, fall back to network, then to the cached shell.
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request).then(function (res) {
        if (res && res.status === 200) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); }
        return res;
      }).catch(function () { return caches.match('/index.html'); });
    })
  );
});
