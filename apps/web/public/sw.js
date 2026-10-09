/* KudiWatch service worker: app shell cached; video NEVER cached (always streamed
   via token-bound /v1/stream URLs). API calls pass through (offline queue lives
   in the page via IndexedDB). */
const CACHE = 'kw-shell-v1';
const SHELL = [
  '/app/', '/app/index.html', '/app/signup.html', '/app/earnings.html', '/app/payout.html',
  '/app/watch.html', '/css/kw.css', '/js/kw.js', '/js/player.js',
  '/manifest.webmanifest', '/icons/icon.svg', '/',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache: video streams, API, uploads.
  if (url.pathname.startsWith('/v1/')) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        // Cache same-origin static assets opportunistically.
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match('/app/index.html'));
    })
  );
});
