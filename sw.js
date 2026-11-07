// Tidefall service worker: offline play after the first visit.
// - HTML / navigations: network first, cached copy when offline.
// - three.js from unpkg (immutable, versioned URL): cache first.
// - Everything else same-origin (JS modules, CSS, fonts, icons): network first
//   (revalidated against the HTTP cache, so a new deploy is picked up on the very
//   next load and modules never mix versions), falling back to the cache when
//   offline or when the network is too slow.
// Bump VERSION to force-drop every old cache.

const VERSION = 'tidefall-v2.0.1';
const NET_TIMEOUT = 4000; // ms before a cached copy wins over a slow network
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest', './src/client/main.js',
  './assets/icon/favicon.svg', './assets/icon/icon-180.png', './assets/icon/icon-192.png', './assets/icon/icon-512.png', './assets/icon/icon-maskable-512.png',
  'https://unpkg.com/three@0.170.0/build/three.module.js',
];

const cacheable = (url) => url.startsWith(self.location.origin) || url.startsWith('https://unpkg.com/three@');

async function put(cache, url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (res.ok || res.type === 'opaque') await cache.put(url, res);
  } catch { /* offline or missing: skip, never fail the install */ }
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(SHELL.map((u) => put(cache, new URL(u, self.location).href)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

// The page sends every resource it loaded on the first visit.
self.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.type !== 'warm' || !Array.isArray(d.urls)) return;
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(d.urls.filter(cacheable).map(async (u) => { if (!(await cache.match(u))) await put(cache, u); }));
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (!cacheable(url)) return;
  const isNav = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  if (isNav) {
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        // Revalidate past the HTTP cache (GitHub Pages sends max-age=600) so the
        // shell and its modules come from the same deploy. A redirected response
        // can't answer a navigation, so redirects go through the plain request.
        let res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
        if (res.redirected) res = await fetch(req);
        if (res.ok && !res.redirected) cache.put('./index.html', res.clone()).catch(() => {});
        return res;
      } catch {
        return (await cache.match(req, { ignoreSearch: true })) || (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: url.startsWith(self.location.origin) });
    if (url.startsWith('https://unpkg.com/')) {
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    }
    // Network first. A slow network falls back to the cached copy after
    // NET_TIMEOUT (the fetch still finishes and refreshes the cache).
    const net = fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    });
    if (!hit) return net;
    e.waitUntil(net.catch(() => {}));
    let timer;
    const slow = new Promise((r) => { timer = setTimeout(() => r(hit), NET_TIMEOUT); });
    try {
      const res = await Promise.race([net, slow]);
      return res.ok || res === hit ? res : hit;
    } catch { return hit; } finally { clearTimeout(timer); }
  })());
});
