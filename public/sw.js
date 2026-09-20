const CACHE = 'acadex-v__BUILD_TS__';
const STATIC_ASSETS = [
  '/manifest.json',
  '/icons/acadex-icon.svg',
  '/icons/acadex-minimal.svg',
  '/icons/acadex-tab.svg',
  '/icons/acadex-favicon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC_ASSETS).catch(() => {}))
  );
  // Wait for the page to request activation so updates can be shown cleanly.
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

  // Keep live data and third-party resources out of the app cache.
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

  // The document is always network-first.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(c => c.put('/index.html', copy));
          }
          return response;
        })
        .catch(() =>
          caches.match('/index.html').then(r =>
            r || new Response('Offline', {
              status: 503,
              headers: {'Content-Type': 'text/plain'}
            })
          )
        )
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
