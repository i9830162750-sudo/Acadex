const CACHE = 'acadex-v-20260921-8';
const STATIC_ASSETS = [
  '/boot.html',
  '/install',
  '/manifest.json',
  '/icons/acadex-icon.svg',
  '/icons/acadex-minimal.svg',
  '/icons/acadex-tab.svg',
  '/icons/acadex-favicon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(async cache => {
      await Promise.allSettled(
        STATIC_ASSETS.map(asset => cache.add(asset).catch(() => null))
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== self.location.origin) return;

  // Never intercept API calls or the server health ping — always go straight to network.
  // The PWA server gate must be able to detect a Render cold start instead of
  // receiving a cached response from the service worker.
  if (url.pathname.startsWith('/api/') || url.pathname === '/ping') return;

  // Keep the local boot page available offline. It performs the server health
  // check itself and only navigates to the app after /ping succeeds.
  if (url.pathname === '/boot.html') {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        // Not cached yet — fetch and cache it
        return fetch(event.request).then(response => {
          if (response && response.status === 200 && response.type !== 'opaque') {
            const copy = response.clone();
            caches.open(CACHE).then(c => c.put(event.request, copy));
          }
          return response;
        });
      })
    );
    return;
  }

  // Static assets — cache-first
  const isStatic = STATIC_ASSETS.some(path => url.pathname === path);
  if (isStatic) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

  // App pages (/app/...) — network-first, fall back to cache
  if (url.pathname.startsWith('/app/')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200 && response.type !== 'opaque') {
            const copy = response.clone();
            caches.open(CACHE).then(c => c.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then(cached =>
          cached || new Response('Offline', {
            status: 503,
            headers: {'Content-Type': 'text/plain'}
          })
        ))
    );
    return;
  }

  // Everything else — network-first with cache fallback
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.status === 200 && response.type !== 'opaque') {
          const copy = response.clone();
          caches.open(CACHE).then(c => c.put(event.request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then(r =>
          r || new Response('Offline', {
            status: 503,
            headers: {'Content-Type': 'text/plain'}
          })
        )
      )
  );
});
