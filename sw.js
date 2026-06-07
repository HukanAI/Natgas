// sw.js — minimal service worker.
// Its only job is to make the app installable as a PWA. It deliberately does
// NOT cache anything: every request goes to the network, so you never get
// stuck on a stale version (no offline support by design).

self.addEventListener('install', (event) => {
  // Activate this worker immediately, don't wait for old tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Remove any caches a previous version might have created, then take control.
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  // Network-only: always fetch fresh. If offline, the request simply fails.
  event.respondWith(fetch(event.request));
});
