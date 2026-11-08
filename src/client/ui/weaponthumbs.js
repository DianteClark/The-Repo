// 3D weapon thumbnails (5.1). The Armory, Barracks and pickers show real renders
// of every gun (with its equipped camo and attachments) instead of SVG art.
//
// One live WebGL preview per card would melt a phone, so each gun is rendered
// ONCE through the shared preview renderer (render.js renderPreview kind:'weapon'),
// snapshotted to a PNG data URL, cropped to the weapon and cached in memory. The
// cache key is weapon + camo + attachments, so changing either re-renders just
// that gun; older snapshots of the same gun are dropped. The SVG art stays as the
// instant fallback until the render lands (or forever without WebGL).

const cache = new Map();      // key → data URL ('' = render failed: keep the SVG)
const byWeapon = new Map();   // weapon id → Set<key> (to drop stale camos / builds)
const waiting = new Map();    // key → Promise<string>
let chain = Promise.resolve();
let getR = () => null;
let enabled = null;           // null = unknown yet; false after a failed probe
const SIZE = 384;             // preview renderer's max canvas size

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

export function setThumbRenderer(fn) { getR = fn; }

export function thumbKey(id, attachments = {}, camo = 'none') {
  const att = Object.keys(attachments || {}).sort().map((k) => `${k}:${attachments[k]}`).join(',');
  return `${id}|${camo || 'none'}|${att}`;
}

/**
 * Card art for a weapon: the cached 3D snapshot if we have it, else the SVG fallback
 * wrapped so hydrateThumbs() can swap the render in when it lands.
 */
export function weaponThumb(id, { attachments = {}, camo = 'none', fallback = '', cls = '' } = {}) {
  const key = thumbKey(id, attachments, camo);
  const url = cache.get(key);
  const data = `data-wt="${esc(key)}" data-wid="${esc(id)}" data-camo="${esc(camo || 'none')}" data-att="${esc(JSON.stringify(attachments || {}))}"`;
  if (url) return `<span class="wthumb on ${cls}" ${data}><img src="${url}" alt="" draggable="false" /></span>`;
  return `<span class="wthumb ${cls}" ${data}>${fallback}</span>`;
}

/** Swap every pending thumbnail under root for its 3D render (rendered one at a time). */
export function hydrateThumbs(root) {
  if (!root || enabled === false) return;
  const els = [...root.querySelectorAll('.wthumb:not(.on)')];
  for (const el of els) {
    const key = el.dataset.wt;
    let att = {};
    try { att = JSON.parse(el.dataset.att || '{}'); } catch { /* ignore */ }
    request(key, el.dataset.wid, att, el.dataset.camo).then((url) => {
      if (!url || !el.isConnected || el.dataset.wt !== key || el.classList.contains('on')) return;
      const img = new Image();
      img.alt = ''; img.draggable = false; img.src = url;
      img.onload = () => { if (!el.isConnected) return; el.classList.add('on', 'fresh'); el.replaceChildren(img); };
    });
  }
}

function request(key, id, attachments, camo) {
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (waiting.has(key)) return waiting.get(key);
  const p = (chain = chain.then(() => (cache.has(key) ? cache.get(key) : snap(id, attachments, camo)))
    .then((url) => { remember(key, id, url || ''); return url || ''; })
    .catch(() => { remember(key, id, ''); return ''; }));
  waiting.set(key, p);
  p.finally(() => waiting.delete(key));
  return p;
}

function remember(key, id, url) {
  cache.set(key, url);
  let set = byWeapon.get(id);
  if (!set) byWeapon.set(id, (set = new Set()));
  set.add(key);
  // keep the 3 most recent builds of a gun (Armory camo + Barracks build + one spare)
  while (set.size > 3) { const old = set.values().next().value; set.delete(old); cache.delete(old); }
}

/** Drop a gun's snapshots (e.g. after a camo or attachment change elsewhere). */
export function invalidateThumbs(id = null) {
  if (id === null) { cache.clear(); byWeapon.clear(); return; }
  for (const k of byWeapon.get(id) || []) cache.delete(k);
  byWeapon.delete(id);
}

async function snap(id, attachments, camo) {
  const R = getR();
  if (typeof R?.renderPreview !== 'function' || document.hidden) return '';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cv = document.createElement('canvas');
  const css = SIZE / dpr;
  // On screen (the shared renderer skips off-screen canvases) but invisible.
  cv.style.cssText = `position:fixed;left:0;top:0;width:${css}px;height:${css}px;opacity:0;pointer-events:none;z-index:-1;`;
  document.body.appendChild(cv);
  try {
    let ok = false;
    try { ok = R.renderPreview(cv, { kind: 'weapon', weapon: id, id, attachments: attachments || {}, camo: camo || 'none' }) !== false; } catch { ok = false; }
    if (!ok) { if (enabled === null) enabled = false; return ''; }
    enabled = true;
    // Wait for the first real frame (shader compile can take a few on software GL).
    let url = '';
    for (let i = 0; i < 60; i++) {
      await frame();
      if (i < 2) continue;
      url = crop(cv);
      if (url) break;
      await sleep(25);
    }
    return url;
  } finally {
    try { R.stopPreview?.(cv); } catch { /* ignore */ }
    cv.remove();
  }
}

/** Crop the canvas to the weapon's pixels (plus a little air) and encode it. */
let scratch = null;
function crop(cv) {
  if (!cv.width || !cv.height) return '';
  const { width: w, height: h } = cv;
  // read back through our own canvas (the preview's 2D context isn't set up for readbacks)
  if (!scratch) { scratch = document.createElement('canvas'); scratch.ctx = scratch.getContext('2d', { willReadFrequently: true }); }
  if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
  const g = scratch.ctx;
  let d;
  try { g.clearRect(0, 0, w, h); g.drawImage(cv, 0, 0); d = g.getImageData(0, 0, w, h).data; } catch { return ''; }
  let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (d[(y * w + x) * 4 + 3] > 12) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (n < 400 || x1 <= x0 || y1 <= y0) return '';
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.04) + 2;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(cv, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  try { return out.toDataURL('image/png'); } catch { return ''; }
}
