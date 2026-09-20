const CACHE = 'acadex-v-20260920-4';
const STATIC_ASSETS = [
  '/',
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

  if (
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('googleusercontent.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('youtube.com') ||
    url.hostname.includes('ytimg.com')
  ) {
    return;
  }

  // App-shell/navigation routes use network-first while online and fall
  // back to the cached shell when Render is unavailable or the device is
  // offline. The app itself no longer performs a startup Render health check.
  if (url.pathname === '/app/acadex-app-7f3c9e21' || url.pathname === '/install' || url.pathname === '/') {
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

  const isStatic = STATIC_ASSETS.some(path => url.pathname === path);
  if (isStatic) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

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
