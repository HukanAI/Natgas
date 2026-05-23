const CACHE_NAME = 'natgas-v1';
const STATIC_ASSETS = [
  '/Natgas/',
  '/Natgas/index.html',
  '/Natgas/js/main.js',
  '/Natgas/js/topbar.js',
  '/Natgas/js/bias.js',
  '/Natgas/js/widgets.js',
  '/Natgas/js/technical.js',
  '/Natgas/js/contracts.js',
  '/Natgas/js/weather.js',
  '/Natgas/js/storage.js',
  '/Natgas/js/storage5y.js',
  '/Natgas/js/futures.js',
  '/Natgas/js/cot.js',
  '/Natgas/js/production.js',
  '/Natgas/js/charts.js',
  '/Natgas/js/smc.js',
  '/Natgas/js/sessions.js',
  '/Natgas/js/news.js',
  '/Natgas/js/mobile.js',
  '/Natgas/js/season.js',
  '/Natgas/js/state.js',
  '/Natgas/js/utils.js',
  '/Natgas/js/debug.js',
  '/Natgas/js/constants.js',
  '/Natgas/js/exports.js',
  '/Natgas/images/icon-192.png',
  '/Natgas/images/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(STATIC_ASSETS).catch(err => console.warn('SW cache fail', err))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Always network for external APIs
  if (url.hostname !== self.location.hostname) {
    event.respondWith(fetch(event.request).catch(() => new Response('', { status: 503 })));
    return;
  }
  // Cache-first for same-origin static assets
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
        }
        return response;
      });
    })
  );
});
