/* VIWO service worker — installable app shell.
 * HTML + JS use NETWORK-FIRST so new deploys show immediately when online
 * (cache is only an offline fallback); images/manifest stay cache-first for
 * speed. API and image mutations always hit the network (never stale). */
var CACHE = 'viwo-shell-v2';
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

function putCache(req, res) {
  if (res && res.status === 200) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
  return res;
}

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;                 // never cache mutations
  if (url.origin !== self.location.origin) return;        // let cross-origin (fonts) pass through
  if (url.pathname.indexOf('/api/') === 0) return;        // live data — network only

  var isDoc = e.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html';
  var isCode = /\.js$/.test(url.pathname);

  if (isDoc || isCode) {
    // Network-first: always the freshest code when online; fall back to cache offline.
    e.respondWith(
      fetch(e.request).then(function (res) { return putCache(e.request, res); })
        .catch(function () { return caches.match(e.request).then(function (hit) { return hit || caches.match('/index.html'); }); })
    );
    return;
  }
  // Static assets (images, manifest): cache-first for instant load.
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request).then(function (res) { return putCache(e.request, res); })
        .catch(function () { return caches.match('/index.html'); });
    })
  );
});
