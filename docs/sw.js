/* NZ Masjid Finder — offline app shell.
 *
 * Network first, so a fresh deploy or a ?v= bump wins whenever the phone is
 * online; cached copies only answer when the network fails. Only same-origin
 * GETs are intercepted — the Supabase API, map tiles, CDN libraries and ads
 * are never cached or delayed.
 *
 * Bump CACHE when the shell changes; older caches are deleted on activate.
 */
const CACHE = 'nz-masjid-v15';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'config.js',
  'supabase.js',
  'verification.js',
  'admin.js',
  'prayer.js',
  'qibla.js',
  'app.js',
  'views.js',
  'data/masjids.json',
  'data/halal.json',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // tolerate a missing file rather than failing the whole install
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(networkFirst(request, event));
});

async function networkFirst(request, event) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    // ignoreSearch so a cached styles.css answers styles.css?v=15 offline
    const cached = await cache.match(request, { ignoreSearch: true });
    const shell = request.mode === 'navigate' ? ((await cache.match('index.html')) || (await cache.match('./'))) : null;
    const fallback = cached || shell;
    if (fallback) {
      // tell the page it is reading the cache, so it can show the offline bar
      self.clients.get(event.clientId)
        .then((client) => client && client.postMessage({ type: 'nz-served-from-cache' }))
        .catch(() => {});
      return fallback;
    }
    return new Response('Offline', { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/plain' } });
  }
}
