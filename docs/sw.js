/* NZ Masjid Finder — offline app shell.
 *
 * Network first, so a fresh deploy or a ?v= bump wins whenever the phone is
 * online; cached copies only answer when the network fails. Same-origin GETs
 * and viewed map tiles are handled here — the Supabase API and ads are never
 * cached or delayed. Leaflet ships in vendor/, so the map no longer depends on
 * a CDN being reachable.
 *
 * Bump CACHE when the shell changes; older caches are deleted on activate.
 */
const CACHE = 'nz-masjid-v33';
const TILE_CACHE = 'nz-masjid-tiles-v1';
const TILE_HOST = 'tile.openstreetmap.org';
const TILE_LIMIT = 300;   // ~a few MB: panning a region, not a whole country
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
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/markercluster/leaflet.markercluster.js',
  'vendor/markercluster/MarkerCluster.css',
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
      // keep the tile cache across shell updates: it is versioned separately
      .then((keys) => Promise.all(keys
        .filter((key) => key !== CACHE && key !== TILE_CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Map tiles: keep what has been looked at, so the map still has a base
  // offline. Nothing is pre-downloaded in bulk.
  if (url.hostname === TILE_HOST || url.hostname.endsWith('.' + TILE_HOST)) {
    event.respondWith(tileResponse(request));
    return;
  }
  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(request, event));
});

async function tileResponse(request) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const response = await fetch(request);
    // tiles arrive as opaque (no-cors) responses, which have ok === false
    if (response && (response.ok || response.type === 'opaque')) {
      cache.put(request, response.clone())
        .then(() => trimTiles(cache))
        .catch(() => {});
    }
    return response;
  } catch (err) {
    // never seen this tile and there is no network: Leaflet shows its blank tile
    return new Response('', { status: 504, statusText: 'Tile unavailable offline' });
  }
}

/** Keep the tile cache bounded: drop the oldest entries past the limit. */
async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length <= TILE_LIMIT) return;
  await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map((key) => cache.delete(key)));
}

async function networkFirst(request, event) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    // ignoreSearch so a cached styles.css answers styles.css?v=16 offline
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
