// Tidefall service worker: offline play after the first visit.
// - HTML / navigations: network first, cached copy when offline.
// - three.js from unpkg (immutable, versioned URL): cache first.
// - Everything else same-origin (JS modules, CSS, fonts, icons): network first
//   (revalidated against the HTTP cache, so a new deploy is picked up on the very
//   next load and modules never mix versions), falling back to the cache when
//   offline or when the network is too slow.
// Bump VERSION to force-drop every old cache. SHELL lists every module of every
// stream (sim, net, match, gfx, sfx, ui, shared), so a fresh install is fully
// offline-capable even before the first warm message; the page's warm message
// then adds anything loaded at runtime that this list missed.
// PeerJS (esm.sh) is deliberately not cached: online play needs the network anyway.

const VERSION = 'tidefall-v5.2.1';
const NET_TIMEOUT = 4000; // ms before a cached copy wins over a slow network
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  // assets/icon/
  './assets/icon/favicon.svg', './assets/icon/icon-180.png', './assets/icon/icon-192.png', './assets/icon/icon-512.png',
  './assets/icon/icon-maskable-512.png', './assets/icon/icon-maskable.svg', './assets/icon/icon-master.svg',
  // src/client/
  './src/client/audio.js', './src/client/main.js', './src/client/render.js', './src/client/wakelock.js',
  // src/client/gfx/
  './src/client/gfx/ambient.js', './src/client/gfx/battlefield.js', './src/client/gfx/camos.js', './src/client/gfx/cosmeticfx.js',
  './src/client/gfx/director.js', './src/client/gfx/pacing.js',
  './src/client/gfx/fields.js', './src/client/gfx/flatlines.js', './src/client/gfx/fx.js', './src/client/gfx/overlays.js',
  './src/client/gfx/palette.js', './src/client/gfx/pickups.js', './src/client/gfx/post.js', './src/client/gfx/preview.js',
  './src/client/gfx/props.js', './src/client/gfx/skins.js', './src/client/gfx/sky.js', './src/client/gfx/stages.js',
  './src/client/gfx/terrain.js', './src/client/gfx/units.js', './src/client/gfx/util.js', './src/client/gfx/vehicles.js',
  './src/client/gfx/water.js', './src/client/gfx/weapons.js',
  // src/client/match/
  './src/client/match/authority.js', './src/client/match/index.js', './src/client/match/playback.js', './src/client/match/remote.js',
  './src/client/match/turns.js',
  // src/client/online/
  './src/client/online/lobby.js',
  // src/client/sfx/
  './src/client/sfx/ambience.js', './src/client/sfx/buffers.js', './src/client/sfx/feedback.js', './src/client/sfx/gear.js',
  './src/client/sfx/hub.js', './src/client/sfx/inst.js', './src/client/sfx/looper.js', './src/client/sfx/menu.js',
  './src/client/sfx/music.js', './src/client/sfx/pit.js', './src/client/sfx/weapons.js', './src/client/sfx/world.js',
  // src/client/ui/
  './src/client/ui/ambient.js', './src/client/ui/arsenal.js', './src/client/ui/badges.js', './src/client/ui/career.js',
  './src/client/ui/haptics.js', './src/client/ui/hubpages.js', './src/client/ui/hud.js', './src/client/ui/icons.js',
  './src/client/ui/juice.js', './src/client/ui/menu.js', './src/client/ui/meta.js', './src/client/ui/minimap.js',
  './src/client/ui/progress.js', './src/client/ui/qrcode.js', './src/client/ui/settings.js', './src/client/ui/shop.js',
  './src/client/ui/squads.js', './src/client/ui/stages.js', './src/client/ui/stagewheel.js', './src/client/ui/transfer.js', './src/client/ui/weaponthumbs.js',
  './src/client/ui/xferui.js', './src/client/ui/unlocks.js', './src/client/ui/shown.js',
  // src/client/ui/fonts/
  './src/client/ui/fonts/barlow-condensed-latin-600-normal.woff2', './src/client/ui/fonts/barlow-condensed-latin-800-normal.woff2',
  // src/net/
  './src/net/codes.js', './src/net/redact.js', './src/net/session.js', './src/net/transport.js', './src/net/wire.js',
  // src/shared/
  './src/shared/cards.js', './src/shared/colors.js', './src/shared/cosmetics.js',
  // src/sim/
  './src/sim/ai.js', './src/sim/constants.js', './src/sim/core.js', './src/sim/equipment.js', './src/sim/game.js', './src/sim/loadout.js',
  './src/sim/map.js', './src/sim/pit.js', './src/sim/rng.js', './src/sim/rules.js', './src/sim/stageevents.js', './src/sim/streaks.js',
  './src/sim/turns.js', './src/sim/vehicles.js', './src/sim/weapons.js',
  'https://unpkg.com/three@0.170.0/build/three.module.js',
  // three/addons used by gfx/post.js (lazy import; precached so bloom works offline)
  'https://unpkg.com/three@0.170.0/examples/jsm/postprocessing/EffectComposer.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/postprocessing/RenderPass.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/postprocessing/UnrealBloomPass.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/postprocessing/OutputPass.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/postprocessing/ShaderPass.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/postprocessing/MaskPass.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/postprocessing/Pass.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/shaders/CopyShader.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/shaders/LuminosityHighPassShader.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/shaders/OutputShader.js',
  // GTAO (high quality, desktop) and its dependencies
  'https://unpkg.com/three@0.170.0/examples/jsm/postprocessing/GTAOPass.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/shaders/GTAOShader.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/shaders/PoissonDenoiseShader.js',
  'https://unpkg.com/three@0.170.0/examples/jsm/math/SimplexNoise.js',
];

const IMMUTABLE = (url) => url.startsWith('https://unpkg.com/three@');
const cacheable = (url) => url.startsWith(self.location.origin) || IMMUTABLE(url);

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
    if (IMMUTABLE(url)) {
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
