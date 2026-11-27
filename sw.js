// App files: network first, so updates show up as soon as you're online; cached copy when offline.
// Firebase SDK files: cache first, since each version's URL never changes.
const CACHE = 'ewyl-v2';
const SDK_PREFIX = 'https://www.gstatic.com/firebasejs/';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'firebase-config.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function fetchAndCache(request) {
  return fetch(request).then(res => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(request, copy));
    }
    return res;
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.url.startsWith(SDK_PREFIX)) {
    e.respondWith(caches.match(req).then(r => r || fetchAndCache(req)));
    return;
  }
  // Leave everything else that is cross-origin (Firestore, Google sign-in) alone.
  if (new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetchAndCache(req).catch(() =>
    caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
