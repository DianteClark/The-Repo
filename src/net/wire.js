// JSON-safe wire encoding: typed arrays travel as {$ta:'Uint8Array', b:<base64>}.
// Used for every transport so the loopback behaves exactly like PeerJS (json serialization).

const TA = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array };

function b64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let s = '';
  const u = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) {
  if (typeof Buffer !== 'undefined') { const b = Buffer.from(s, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice(); }
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/** Deep-copy into plain JSON values (Sets → arrays, Maps → entry arrays, typed arrays tagged). */
export function encode(v, depth = 0) {
  if (depth > 40) return null;
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) return v > 0 ? 1e308 : v < 0 ? -1e308 : null;
    if (typeof v === 'function' || typeof v === 'symbol' || v === undefined) return undefined;
    return v;
  }
  if (ArrayBuffer.isView(v)) {
    const name = v.constructor?.name;
    return TA[name] ? { $ta: name, b: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) } : null;
  }
  if (Array.isArray(v)) return v.map((x) => { const e = encode(x, depth + 1); return e === undefined ? null : e; });
  if (v instanceof Set) return [...v].map((x) => encode(x, depth + 1));
  if (v instanceof Map) return { $map: [...v].map(([k, x]) => [encode(k, depth + 1), encode(x, depth + 1)]) };
  const o = {};
  for (const k of Object.keys(v)) { const e = encode(v[k], depth + 1); if (e !== undefined) o[k] = e; }
  return o;
}

export function decode(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decode);
  if (typeof v.$ta === 'string' && typeof v.b === 'string') {
    const C = TA[v.$ta];
    if (!C) return null;
    const bytes = unb64(v.b);
    return new C(bytes.buffer, bytes.byteOffset, bytes.byteLength / C.BYTES_PER_ELEMENT);
  }
  if (Array.isArray(v.$map)) return new Map(v.$map.map(([k, x]) => [decode(k), decode(x)]));
  const o = {};
  for (const k of Object.keys(v)) o[k] = decode(v[k]);
  return o;
}

export const PROTO = 5; // bump on any breaking wire change
