const CACHE = 'aadd-v3';
const STATIC = [
  '/', '/index.html', '/index.js', '/i18n.js',
  '/manifest.json', '/favicon.ico',
  '/icons/icon-192.png', '/icons/icon-512.png'
];

const NETWORK_ONLY = ['/api/', '/app.html', '/app.js'];

self.addEventListener('install', e => e.waitUntil(
  caches.open(CACHE).then(c => c.addAll(STATIC))
));

self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE).map(k => caches.delete(k))
  ))
));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (NETWORK_ONLY.some(p => url.pathname.startsWith(p))) {
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
