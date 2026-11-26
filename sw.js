/*
  Offline shell.

  The app has no backend, so everything it needs is a handful of static files.
  They are fetched once at install and served from the cache afterwards, which
  is what lets the app open with no signal at all.

  The cache name carries a version. On activate, every old START. cache is
  deleted — without that step a fixed bug stays on the phone forever, because
  the old file keeps being served and nothing ever asks for a new one.

  Bump CACHE_VERSION on every release.
*/

const CACHE_VERSION = 'v3'
const CACHE_PREFIX = 'start-app-'
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`

const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/storage.js',
  './js/timer.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      // Take over immediately rather than waiting for every tab to close. There
      // is only ever one tab of this app, and waiting means an update appears to
      // do nothing.
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  // Only this app's own files. Anything else is none of the worker's business,
  // and there is nothing else to fetch anyway.
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Navigations get the network first so a new version is picked up as soon as
  // there is a connection, and fall back to the cached shell when there is not.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy)).catch(() => {})
          return response
        })
        .catch(() => caches.match('./index.html').then((cached) => cached ?? Response.error())),
    )
    return
  }

  // Everything else is cache first: these files only change when the version
  // does, and reading them from disk is what makes the app open instantly.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {})
          }
          return response
        })
        .catch(() => cached ?? Response.error())
    }),
  )
})
