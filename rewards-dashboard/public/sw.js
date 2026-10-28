// v2: same-origin assets switched to network-first below. v1 kept
// cache-first, so a redeploy of /views/*.js or /style.css stayed invisible to
// anyone who had the page open - the old bundle was served from the cache
// until the whole cache name changed. Bumping it drops those stale entries.
const CACHE_NAME = 'rewards-dashboard-pwa-v2'
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icon.png',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js'
]

self.addEventListener('install', event => {
  self.skipWaiting()
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => response)
        .catch(() => caches.match('/index.html'))
    )
    return
  }

  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html'))
    )
    return
  }

  // Same-origin views/scripts/styles: always try the server first so a
  // redeploy shows up on the next reload, and only fall back to the cached
  // copy when the panel is unreachable (offline).
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response && response.status === 200 && response.type !== 'opaque') {
            const clone = response.clone()
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone))
          }
          return response
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match('/index.html')))
    )
    return
  }

  // Cross-origin (the Chart.js CDN) stays cache-first: it never changes under
  // the same URL, and the phone is often offline-ish.
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached
      return fetch(request).then(response => {
        if (!response || response.status !== 200 || response.type === 'opaque') return response
        const responseClone = response.clone()
        caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone))
        return response
      })
    }).catch(() => caches.match('/index.html'))
  )
})
