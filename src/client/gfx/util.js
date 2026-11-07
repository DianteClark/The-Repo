// Small shared helpers for the Tidefall renderer: hashing, easing, and a
// flat-shaded vertex-colour geometry builder used for props and soldiers.

import * as THREE from 'three';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => t * t * (3 - 2 * t);
export const easeOutCubic = (t) => 1 - (1 - t) ** 3;
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const easeOutBack = (t, s = 1.70158) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2;
export const easeOutElastic = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1);
/** Exponential approach factor that is frame-rate independent. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

export function hash(k) {
  let h = (k * 2654435761) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Deterministic little PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- geometry builder ----------

const TPL = new Map();
function template(kind, a = 0, b = 0) {
  const key = kind + ':' + a + ':' + b;
  let t = TPL.get(key);
  if (t) return t;
  let g;
  if (kind === 'box') g = new THREE.BoxGeometry(1, 1, 1);
  else if (kind === 'cyl') g = new THREE.CylinderGeometry(1, 1, 1, a, 1);
  else if (kind === 'cone') g = new THREE.CylinderGeometry(b, 1, 1, a, 1); // b = top ratio
  else if (kind === 'ico') g = new THREE.IcosahedronGeometry(1, a);
  else if (kind === 'sphere') g = new THREE.SphereGeometry(1, a, b);
  else if (kind === 'wedge') {
    // triangular prism: ramp rising along +z
    const s = new THREE.Shape();
    s.moveTo(-0.5, -0.5); s.lineTo(0.5, -0.5); s.lineTo(-0.5, 0.5); s.closePath();
    g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
    g.translate(0, 0, -0.5);
    g.rotateY(-Math.PI / 2);
  } else if (kind === 'trap') {
    // Jersey-barrier profile (trapezoid), extruded along x.
    const s = new THREE.Shape();
    s.moveTo(-0.5, -0.5); s.lineTo(0.5, -0.5); s.lineTo(0.22, -0.2); s.lineTo(0.14, 0.5); s.lineTo(-0.14, 0.5); s.lineTo(-0.22, -0.2); s.closePath();
    g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
    g.translate(0, 0, -0.5);
    g.rotateY(Math.PI / 2);
  }
  const ng = g.index ? g.toNonIndexed() : g;
  t = ng.attributes.position.array.slice();
  // Drop downward-facing triangles (never visible for upright props).
  const keep = [];
  for (let i = 0; i < t.length; i += 9) {
    const ax = t[i + 3] - t[i], ay = t[i + 4] - t[i + 1], az = t[i + 5] - t[i + 2];
    const bx = t[i + 6] - t[i], by = t[i + 7] - t[i + 1], bz = t[i + 8] - t[i + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    if (ny / l < -0.98) continue;
    for (let j = 0; j < 9; j++) keep.push(t[i + j]);
  }
  t.up = new Float32Array(keep);
  g.dispose();
  TPL.set(key, t);
  return t;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _c = new THREE.Color();

/**
 * Accumulates transformed primitive triangles with per-vertex colours, then
 * emits one flat-shaded BufferGeometry. Not used in hot paths.
 */
export class GeoBuilder {
  constructor(cull = false) { this.pos = []; this.col = []; this.tags = null; this.tagV = 0; this.parent = null; this.cull = cull; }

  /** Material tag for the following primitives (emitted as an 'aTag' float attribute; used by skins). */
  tag(v) { this.tagV = v; if (!this.tags && v) this.tags = new Array(this.pos.length / 3).fill(0); return this; }

  /** Optional matrix applied to every following primitive (e.g. a prop's tile transform). */
  setParent(m) { this.parent = m; return this; }

  _add(tpl, x, y, z, sx, sy, sz, rx, ry, rz, color, shade) {
    if (this.cull && !rx && !rz && tpl.up) tpl = tpl.up;
    _e.set(rx, ry, rz, 'YXZ');
    _q.setFromEuler(_e);
    _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
    if (this.parent) _m.premultiply(this.parent);
    _c.set(color);
    const { pos, col, tags } = this;
    for (let i = 0; i < tpl.length; i += 3) {
      _v.set(tpl[i], tpl[i + 1], tpl[i + 2]).applyMatrix4(_m);
      pos.push(_v.x, _v.y, _v.z);
      if (tags) tags.push(this.tagV);
      let k = 1;
      if (shade) k = shade(tpl[i], tpl[i + 1], tpl[i + 2]);
      col.push(_c.r * k, _c.g * k, _c.b * k);
    }
    return this;
  }

  box(w, h, d, x, y, z, color, ry = 0, rx = 0, rz = 0, shade) {
    return this._add(template('box'), x, y, z, w, h, d, rx, ry, rz, color, shade);
  }
  /** Box whose bottom sits at y. */
  boxB(w, h, d, x, y, z, color, ry = 0, rx = 0, rz = 0) { return this.box(w, h, d, x, y + h / 2, z, color, ry, rx, rz); }
  cyl(r, h, seg, x, y, z, color, ry = 0, rx = 0, rz = 0, rz2) {
    return this._add(template('cyl', seg), x, y, z, r, h, rz2 ?? r, rx, ry, rz, color);
  }
  cone(r, top, h, seg, x, y, z, color, ry = 0, rx = 0, rz = 0) {
    return this._add(template('cone', seg, top), x, y, z, r, h, r, rx, ry, rz, color);
  }
  ico(r, x, y, z, color, sx = 1, sy = 1, sz = 1, ry = 0, rx = 0, rz = 0, detail = 0) {
    return this._add(template('ico', detail), x, y, z, r * sx, r * sy, r * sz, rx, ry, rz, color);
  }
  sphere(r, x, y, z, color, sx = 1, sy = 1, sz = 1, ws = 8, hs = 6) {
    return this._add(template('sphere', ws, hs), x, y, z, r * sx, r * sy, r * sz, 0, 0, 0, color);
  }
  wedge(w, h, d, x, y, z, color, ry = 0) { return this._add(template('wedge'), x, y, z, w, h, d, 0, ry, 0, color); }
  trap(w, h, d, x, y, z, color, ry = 0) { return this._add(template('trap'), x, y, z, w, h, d, 0, ry, 0, color); }

  get empty() { return this.pos.length === 0; }

  /**
   * Build the geometry. `stain` darkens and tints vertices near the ground
   * with an algae/waterline band so everything reads as drowned.
   */
  build({ stain = false, ao = true } = {}) {
    const n = this.pos.length / 3;
    const pos = new Float32Array(this.pos);
    const col = new Float32Array(this.col);
    if (stain || ao) {
      for (let i = 0; i < n; i++) {
        const y = pos[i * 3 + 1];
        let r = col[i * 3], g = col[i * 3 + 1], b = col[i * 3 + 2];
        if (stain) {
          const k = (1 - smooth(clamp((y - 0.04) / 0.26, 0, 1))) * 0.6;
          r = lerp(r, 0.08, k); g = lerp(g, 0.16, k); b = lerp(b, 0.12, k);
        }
        if (ao) {
          const a = 0.62 + 0.38 * smooth(clamp(y / 0.18, 0, 1));
          r *= a; g *= a; b *= a;
        }
        col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (this.tags) geo.setAttribute('aTag', new THREE.BufferAttribute(new Float32Array(this.tags), 1));
    geo.computeVertexNormals(); // non-indexed → flat normals
    geo.computeBoundingSphere();
    return geo;
  }
}

/** Shared canvas helper. */
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function compass(from, x, y) {
  const a = Math.atan2(y - from.y, x - from.x); // map y grows "south"
  const dirs = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
  return dirs[(Math.round(a / (Math.PI / 4)) + 8) % 8];
}
