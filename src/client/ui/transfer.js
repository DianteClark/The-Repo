// Account transfer: every local store packed into one code.
//   TF5-<base64url( flag:1 | crc32(json):4 | body )>
//   flag 'D' = body is deflate-raw(json), 'J' = body is the raw UTF-8 JSON
//   (browsers without CompressionStream). The CRC32 covers the JSON text, so a
//   mistyped or truncated code is rejected before anything is overwritten.
// The QR code comes from the vendored MIT qrcode-generator (./qrcode.js).

import qrcode from './qrcode.js';

export const STORE_KEYS = {
  settings: 'tidefall.settings.v1',
  career: 'tidefall.career.v1',
  meta: 'tidefall.meta.v1',
  progress: 'tidefall.v5',
};
const PREFIX = 'TF5-';

// ------------------------------------------------------------------ crc32 + base64url

const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_T[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function b64u(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function pipe(bytes, Stream, fmt) {
  const cs = new Stream(fmt);
  const w = cs.writable.getWriter();
  w.write(bytes).catch(() => {}); w.close().catch(() => {});
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

// ------------------------------------------------------------------ export

export function snapshot() {
  const out = { v: 5, at: Date.now() };
  for (const [k, key] of Object.entries(STORE_KEYS)) {
    try { const raw = localStorage.getItem(key); out[k] = raw ? JSON.parse(raw) : null; } catch { out[k] = null; }
  }
  // Seen-item lists are cosmetic noise: keep codes short.
  if (out.meta && Array.isArray(out.meta.seen)) out.meta = { ...out.meta, seen: [] };
  return out;
}

export async function exportCode(snap = snapshot()) {
  const json = new TextEncoder().encode(JSON.stringify(snap));
  const crc = crc32(json);
  let flag = 'J', body = json;
  if (typeof CompressionStream === 'function') {
    try { body = await pipe(json, CompressionStream, 'deflate-raw'); flag = 'D'; } catch { flag = 'J'; body = json; }
  }
  const buf = new Uint8Array(5 + body.length);
  buf[0] = flag.charCodeAt(0);
  buf[1] = crc >>> 24; buf[2] = (crc >>> 16) & 255; buf[3] = (crc >>> 8) & 255; buf[4] = crc & 255;
  buf.set(body, 5);
  return PREFIX + b64u(buf);
}

// ------------------------------------------------------------------ import

/** Decode + verify. Resolves {ok:true, data} or {ok:false, error}. Never throws. */
export async function decodeCode(code) {
  const raw = String(code || '').replace(/\s+/g, '');
  if (!raw) return { ok: false, error: 'Paste a transfer code first' };
  if (!raw.toUpperCase().startsWith(PREFIX)) return { ok: false, error: 'Transfer codes start with TF5-' };
  let buf;
  try { buf = unb64u(raw.slice(PREFIX.length)); } catch { return { ok: false, error: 'That code has invalid characters' }; }
  if (buf.length < 8) return { ok: false, error: 'That code is too short. Did it get cut off?' };
  const flag = String.fromCharCode(buf[0]);
  const want = ((buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4]) >>> 0;
  let json = buf.subarray(5);
  if (flag === 'D') {
    if (typeof DecompressionStream !== 'function') return { ok: false, error: 'This browser can\'t read compressed codes' };
    try { json = await pipe(json, DecompressionStream, 'deflate-raw'); } catch { return { ok: false, error: 'The code is damaged (it would not unpack)' }; }
  } else if (flag !== 'J') return { ok: false, error: 'Unknown code format' };
  if (crc32(json) !== want) return { ok: false, error: 'Checksum mismatch: part of the code is missing or mistyped' };
  let data;
  try { data = JSON.parse(new TextDecoder().decode(json)); } catch { return { ok: false, error: 'The code is damaged (bad data)' }; }
  if (!data || typeof data !== 'object' || data.v !== 5) return { ok: false, error: 'Not a Tidefall 5 transfer code' };
  return { ok: true, data };
}

/** Write a decoded snapshot into storage (callers sanitise through each store, then reload). */
export function writeSnapshot(clean) {
  for (const [k, key] of Object.entries(STORE_KEYS)) {
    if (clean[k] === undefined) continue;
    try { if (clean[k] === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(clean[k])); } catch { /* quota */ }
  }
}

// ------------------------------------------------------------------ QR

/** SVG markup for a QR code of `text`, or null if it doesn't fit (then show the code only). */
export function qrSVG(text, { size = 220, fg = '#0b171c', bg = '#f4f1e6' } = {}) {
  let qr;
  for (const ecl of ['M', 'L']) {
    try { qr = qrcode(0, ecl); qr.addData(text, 'Byte'); qr.make(); break; } catch { qr = null; }
  }
  if (!qr) return null;
  const n = qr.getModuleCount();
  const q = 4; // quiet zone
  let d = '';
  for (let r = 0; r < n; r++) {
    let run = -1;
    for (let c = 0; c <= n; c++) {
      const dark = c < n && qr.isDark(r, c);
      if (dark && run < 0) run = c;
      if (!dark && run >= 0) { d += `M${run + q} ${r + q}h${c - run}v1h${run - c}z`; run = -1; }
    }
  }
  const t = n + q * 2;
  return `<svg class="qr" viewBox="0 0 ${t} ${t}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="QR code of your transfer code"><rect width="${t}" height="${t}" fill="${bg}"/><path d="${d}" fill="${fg}"/></svg>`;
}
