// Cover props. Each cover tile gets a deterministic low-poly prop that fills
// its gameplay footprint: half cover (≈0.5 tall) = crates, barrels, sandbags,
// wrecks, jersey barriers, kelp rubble, broken wall stubs; full cover (≥1.05
// tall) = ruined concrete walls with windows/rebar, shipping containers,
// pillars. Props are merged into chunk meshes (few draw calls) and a chunk is
// rebuilt when map cover changes.

import * as THREE from 'three';
import { P } from './palette.js';
import { patchWorld } from './fields.js';
import { GeoBuilder, hash, rng } from './util.js';
import { tileTop } from './terrain.js';

const CH = 9; // chunk size in tiles
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class PropField {
  constructor(map, cls, fields, wx, wz, seed) {
    this.map = map;
    this.S = map.size;
    this.cls = cls;
    this.wx = wx; this.wz = wz;
    this.seed = seed;
    const n = this.S * this.S;
    this.cover = Uint8Array.from(map.cover); // displayed cover (lags sim until events play)
    this.damaged = new Uint8Array(n);
    this.wasCover = new Uint8Array(n);
    this.group = new THREE.Group();
    this.mat = patchWorld(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.04 }), fields, 'props');
    this.glowMat = patchWorld(new THREE.MeshBasicMaterial({ vertexColors: true }), fields, 'glow');
    this._classify();
    this.nc = Math.ceil(this.S / CH);
    this.chunks = [];
    for (let cy = 0; cy < this.nc; cy++) for (let cx = 0; cx < this.nc; cx++) this.chunks.push({ cx, cy, mesh: null, glow: null });
    for (const c of this.chunks) this._buildChunk(c);
  }

  _classify() {
    const S = this.S, cov = this.cover;
    const style = (this.style = new Uint8Array(S * S)); // 1 building, 2 container, 3 pillar
    this.axis = new Uint8Array(S * S);
    this.lineId = new Int32Array(S * S).fill(-1);
    this.lineEnd = new Uint8Array(S * S); // bit0 = start end, bit1 = far end
    const seen = new Uint8Array(S * S);
    const r = rng(this.seed ^ 0xc0ffee);
    for (let s = 0; s < S * S; s++) {
      if (cov[s] !== 2 || seen[s]) continue;
      const comp = [];
      const st = [s];
      seen[s] = 1;
      while (st.length) {
        const k = st.pop();
        comp.push(k);
        const x = k % S, y = (k / S) | 0;
        for (const [dx, dy] of DIRS) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
          const nk = ny * S + nx;
          if (!seen[nk] && cov[nk] === 2) { seen[nk] = 1; st.push(nk); }
        }
      }
      const xs = comp.map((k) => k % S), ys = comp.map((k) => (k / S) | 0);
      const sameRow = ys.every((v) => v === ys[0]), sameCol = xs.every((v) => v === xs[0]);
      let sty = 1;
      if (comp.length === 1) sty = 3;
      else if ((sameRow || sameCol) && comp.length <= 5 && r() < 0.7) sty = 2;
      const ax = sameRow ? 0 : 1;
      const lo = Math.min(...(ax === 0 ? xs : ys)), hi = Math.max(...(ax === 0 ? xs : ys));
      for (const k of comp) {
        style[k] = sty;
        this.axis[k] = ax;
        this.lineId[k] = s;
        const c = ax === 0 ? k % S : (k / S) | 0;
        this.lineEnd[k] = (c === lo ? 1 : 0) | (c === hi ? 2 : 0);
      }
    }
  }

  _buildChunk(c) {
    if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh = null; }
    if (c.glow) { this.group.remove(c.glow); c.glow.geometry.dispose(); c.glow = null; }
    const b = new GeoBuilder(true), gb = new GeoBuilder(true);
    const S = this.S, m4 = new THREE.Matrix4();
    for (let y = c.cy * CH; y < Math.min(S, c.cy * CH + CH); y++) {
      for (let x = c.cx * CH; x < Math.min(S, c.cx * CH + CH); x++) {
        const k = y * S + x;
        const cv = this.cover[k];
        if (!cv && !this.wasCover[k]) continue;
        m4.makeTranslation(this.wx(x), tileTop(this.cls.type[k]), this.wz(y));
        b.setParent(m4); gb.setParent(m4);
        this._prop(b, gb, x, y, k, cv);
      }
    }
    if (!b.empty) {
      c.mesh = new THREE.Mesh(b.build({ stain: true }), this.mat);
      c.mesh.castShadow = true;
      c.mesh.receiveShadow = true;
      this.group.add(c.mesh);
    }
    if (!gb.empty) {
      c.glow = new THREE.Mesh(gb.build({ ao: false }), this.glowMat);
      this.group.add(c.glow);
    }
  }

  /** Neighbour cover levels [E, W, S(+y), N(-y)]. */
  _nb(x, y) {
    const S = this.S;
    return DIRS.map(([dx, dy]) => {
      const nx = x + dx, ny = y + dy;
      return nx < 0 || ny < 0 || nx >= S || ny >= S ? 0 : this.cover[ny * S + nx];
    });
  }

  setCover(x, y, to) {
    const S = this.S, k = y * S + x;
    const from = this.cover[k];
    if (from === to) return false;
    this.cover[k] = to;
    if (to < from) this.damaged[k] = 1;
    if (from > 0) this.wasCover[k] = 1;
    const dirty = new Set();
    for (const [dx, dy] of [[0, 0], ...DIRS]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
      dirty.add(Math.floor(ny / CH) * this.nc + Math.floor(nx / CH));
    }
    for (const i of dirty) this._buildChunk(this.chunks[i]);
    return true;
  }

  /** Approximate dominant colour of the prop on a tile (for debris). */
  debrisColors(k, cv) {
    if (cv === 2) return this.style[k] === 2 ? [P.containerCols[this.lineId[k] % P.containerCols.length], P.rust2, P.steel] : [P.plaster, P.wallConcrete, P.wallDark];
    return [P.wood, P.wallConcrete, P.rust, P.sandbag];
  }

  dispose() {
    for (const c of this.chunks) { c.mesh?.geometry.dispose(); c.glow?.geometry.dispose(); }
    this.mat.dispose(); this.glowMat.dispose();
  }

  // ---------- prop recipes ----------

  _prop(b, gb, x, y, k, cv) {
    const r = rng((k * 7919) ^ this.seed);
    const nb = this._nb(x, y);
    if (cv === 0) return debrisScatter(b, r);
    if (cv === 2) {
      const h = 1.02 + (this.map.wallHeight[k] - 0.95) * 1.0;
      const st = this.style[k];
      if (st === 2) return container(b, r, this.axis[k], this.lineEnd[k], P.containerCols[hash(this.lineId[k]) * P.containerCols.length | 0], 1.12);
      if (st === 3) return pillar(b, r, h);
      return wall(b, gb, r, nb, h, x, y, this);
    }
    // half cover
    if (this.damaged[k]) return rubble(b, r, true);
    const wallNb = nb.some((v, i) => {
      if (!v) return false;
      const [dx, dy] = DIRS[i];
      const nk = (y + dy) * this.S + x + dx;
      return v === 2 ? this.style[nk] === 1 : this._isStub(x + dx, y + dy);
    });
    if (wallNb) return stub(b, r, nb, x, y, this);
    const pick = hash(k * 31 + 7);
    if (pick < 0.19) return crates(b, r);
    if (pick < 0.36) return barrels(b, r);
    if (pick < 0.53) return sandbags(b, r, nb);
    if (pick < 0.68) return car(b, r);
    if (pick < 0.8) return jersey(b, r, nb);
    return rubble(b, r, false);
  }

  _isStub(x, y) {
    const S = this.S;
    if (x < 0 || y < 0 || x >= S || y >= S) return false;
    const k = y * S + x;
    if (this.cover[k] !== 1) return false;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
      const nk = ny * S + nx;
      if (this.cover[nk] === 2 && this.style[nk] === 1) return true;
    }
    return false;
  }
}

// ---------- recipes (tile-local coordinates, y up, footprint ±0.5) ----------

const jit = (r, c, a = 0.06) => new THREE.Color(c).offsetHSL((r() - 0.5) * a * 0.3, (r() - 0.5) * a, (r() - 0.5) * a).getHex();

function rebar(b, r, x, y, z, n = 3) {
  for (let i = 0; i < n; i++) {
    const h = 0.12 + r() * 0.22;
    b.cyl(0.012, h, 4, x + (r() - 0.5) * 0.3, y + h / 2, z + (r() - 0.5) * 0.25, P.rust2, 0, (r() - 0.5) * 0.7, (r() - 0.5) * 0.7);
  }
}

function wallSeg(b, r, x0, z0, x1, z1, T, H, upper, lower) {
  // axis-aligned wall chunk from (x0,z0) to (x1,z1), thickness T
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const w = Math.abs(x1 - x0) || T, d = Math.abs(z1 - z0) || T;
  const lb = Math.min(0.34, H * 0.4);
  b.box(w, lb, d, cx, lb / 2, cz, lower);
  b.box(w * 0.985 + (w === T ? 0 : 0.01), H - lb, d * 0.985 + (d === T ? 0 : 0.01), cx, lb + (H - lb) / 2, cz, upper);
  // broken top bricks
  const n = r() < 0.55 ? 0 : 1;
  for (let i = 0; i < n; i++) {
    const bw = 0.14 + r() * 0.14, bh = 0.05 + r() * 0.08;
    const t = r();
    b.box(Math.min(bw, w), bh, Math.min(bw, d), x0 + (x1 - x0) * t, H + bh / 2 - 0.02, z0 + (z1 - z0) * t, r() < 0.5 ? upper : lower, (r() - 0.5) * 0.3);
  }
}

function wall(b, gb, r, nb, H, x, y, F) {
  const T = 0.6;
  const paint = WALL_PAINT[(hash(F.lineId[y * F.S + x] + 911) * WALL_PAINT.length) | 0];
  const upper = jit(r, r() < 0.8 ? paint : P.plaster2);
  const lower = jit(r, P.wallConcrete);
  const hc = H * (0.92 + r() * 0.1);
  // central block
  b.box(T, 0.34, T, 0, 0.17, 0, lower);
  b.box(T * 0.99, hc - 0.34, T * 0.99, 0, 0.34 + (hc - 0.34) / 2, 0, upper);
  let arms = 0;
  const hs = [];
  DIRS.forEach(([dx, dy], i) => {
    const v = nb[i];
    if (!v) return;
    arms++;
    const ah = v === 2 ? H * (0.88 + r() * 0.16) : H * (0.55 + r() * 0.2);
    hs.push(ah);
    wallSeg(b, r, dx * T / 2, dy * T / 2, dx * 0.5, dy * 0.5, T, ah, upper, lower);
  });
  // window holes on straight runs
  const straight = (nb[0] && nb[1] && !nb[2] && !nb[3]) || (nb[2] && nb[3] && !nb[0] && !nb[1]);
  if (straight && r() < 0.55 && Math.min(...hs) > 0.95) {
    const alongX = !!nb[0];
    const ww = 0.36, wh = 0.3, wy = 0.6;
    if (alongX) {
      b.box(ww, wh, T + 0.03, 0, wy + wh / 2, 0, P.window);
      b.box(ww + 0.08, 0.05, T + 0.08, 0, wy - 0.02, 0, P.bone);
      if (r() < 0.18) gb.box(ww * 0.8, wh * 0.75, T + 0.035, 0, wy + wh / 2, 0, P.windowGlow);
    } else {
      b.box(T + 0.03, wh, ww, 0, wy + wh / 2, 0, P.window);
      b.box(T + 0.08, 0.05, ww + 0.08, 0, wy - 0.02, 0, P.bone);
      if (r() < 0.18) gb.box(T + 0.035, wh * 0.75, ww * 0.8, 0, wy + wh / 2, 0, P.windowGlow);
    }
  }
  // exposed concrete patches
  if (r() < 0.6) {
    const side = r() < 0.5 ? 1 : -1;
    const along = nb[0] || nb[1];
    const py = 0.4 + r() * (H - 0.6);
    if (along) b.box(0.22 + r() * 0.2, 0.14 + r() * 0.12, 0.03, (r() - 0.5) * 0.5, py, side * (T / 2 + 0.005), P.wallDark);
    else b.box(0.03, 0.14 + r() * 0.12, 0.22 + r() * 0.2, side * (T / 2 + 0.005), py, (r() - 0.5) * 0.5, P.wallDark);
  }
  if (arms <= 1 || r() < 0.2) rebar(b, r, 0, hc, 0, 2 + (r() * 2 | 0));
  // kelp/rubble at the foot
  if (r() < 0.5) kelpTuft(b, r, (r() - 0.5) * 0.8, (r() < 0.5 ? 1 : -1) * 0.36);
  void x; void y; void F;
}

const WALL_PAINT = [P.plaster, P.plaster, 0x9fbcae, 0xc79a7d, 0xa9a69a, 0xd8cdb0, 0x7fa3a3];

function stub(b, r, nb, x, y, F) {
  const T = 0.56;
  const H = 0.46 + r() * 0.14;
  const upper = jit(r, P.plaster2), lower = jit(r, P.wallConcrete);
  b.box(T, H * 0.6, T, 0, H * 0.3, 0, lower);
  b.box(T * 0.96, H * 0.4, T * 0.96, 0, H * 0.8, 0, upper);
  DIRS.forEach(([dx, dy], i) => {
    if (!nb[i]) return;
    wallSeg(b, r, dx * T / 2, dy * T / 2, dx * 0.5, dy * 0.5, T, H * (0.9 + r() * 0.25), upper, lower);
  });
  rebar(b, r, 0, H, 0, 3);
  for (let i = 0; i < 3; i++) chunk(b, r, (r() - 0.5) * 0.8, (r() - 0.5) * 0.8, 0.08 + r() * 0.08, P.wallConcrete);
  void x; void y; void F;
}

function chunk(b, r, x, z, s, color) {
  b.ico(s, x, s * 0.45, z, jit(r, color, 0.1), 1, 0.65 + r() * 0.4, 1, r() * 6, r() * 0.6, r() * 0.6);
}

function kelpTuft(b, r, x, z) {
  const n = 2 + (r() * 3 | 0);
  for (let i = 0; i < n; i++) {
    const h = 0.18 + r() * 0.3;
    b.cone(0.05 + r() * 0.03, 0.05, h, 3, x + (r() - 0.5) * 0.15, h / 2, z + (r() - 0.5) * 0.15, r() < 0.5 ? P.kelp : P.kelp2, r() * 6, (r() - 0.5) * 0.6, (r() - 0.5) * 0.6);
  }
}

function container(b, r, axis, ends, color, H) {
  // container piece along axis (0 = x, 1 = z); local frame: long axis = x
  const ry = axis === 0 ? 0 : Math.PI / 2;
  const cos = Math.cos(ry), sin = Math.sin(ry);
  const L0 = ends & 1 ? -0.46 : -0.5, L1 = ends & 2 ? 0.46 : 0.5;
  const W = 0.9;
  const place = (lx, lz) => [lx * cos + lz * sin, -lx * sin + lz * cos];
  const L = L1 - L0, cxl = (L0 + L1) / 2;
  const [cx, cz] = place(cxl, 0);
  const body = jit(r, color, 0.05);
  const dark = new THREE.Color(body).multiplyScalar(0.72).getHex();
  b.box(L, H - 0.06, W, cx, 0.03 + (H - 0.06) / 2, cz, body, ry);
  b.box(L, 0.05, W + 0.02, cx, H - 0.02, cz, dark, ry); // roof rim
  b.box(L, 0.06, W + 0.02, cx, 0.03, cz, P.steelDark, ry); // base rail
  // ribs along long sides
  for (let lx = L0 + 0.06; lx < L1 - 0.03; lx += 0.11) {
    for (const s of [-1, 1]) {
      const [px, pz] = place(lx, s * (W / 2 + 0.008));
      b.box(0.04, H - 0.14, 0.02, px, H / 2, pz, dark, ry);
    }
  }
  // rust streaks
  if (r() < 0.7) {
    const [px, pz] = place(L0 + r() * L, (r() < 0.5 ? -1 : 1) * (W / 2 + 0.02));
    b.box(0.1 + r() * 0.12, 0.3 + r() * 0.4, 0.012, px, H - 0.35, pz, P.rust2, ry);
  }
  // doors at the ends
  for (const [bit, ex] of [[1, L0], [2, L1]]) {
    if (!(ends & bit)) continue;
    const s = Math.sign(ex);
    const [px, pz] = place(ex + s * 0.01, 0);
    b.box(0.02, H - 0.12, W - 0.06, px, H / 2, pz, dark, ry);
    for (const o of [-0.28, -0.1, 0.1, 0.28]) {
      const [qx, qz] = place(ex + s * 0.03, o);
      b.cyl(0.012, H - 0.16, 4, qx, H / 2, qz, P.steel);
    }
  }
  // dents / barnacles at the base
  if (r() < 0.5) kelpTuft(b, r, (r() - 0.5) * 0.6 * cos, (r() < 0.5 ? -1 : 1) * 0.48 * (axis === 0 ? 1 : 0.2));
}

function pillar(b, r, H) {
  const c = jit(r, P.wallConcrete), u = jit(r, P.plaster2);
  b.box(0.72, 0.3, 0.72, 0, 0.15, 0, c);
  b.box(0.62, H - 0.3, 0.62, 0, 0.3 + (H - 0.3) / 2, 0, u, r() * 0.2);
  b.box(0.34, 0.2, 0.3, 0.1, H + 0.08, 0.05, c, r(), 0.1, 0.15);
  rebar(b, r, 0, H, 0, 4);
  chunk(b, r, 0.36, -0.3, 0.12, P.wallConcrete);
  kelpTuft(b, r, -0.38, 0.3);
}

function crate(b, r, s, x, y, z, ry) {
  const w = jit(r, P.wood, 0.1), d = new THREE.Color(w).multiplyScalar(0.7).getHex();
  b.box(s * 0.92, s * 0.92, s * 0.92, x, y + s * 0.46, z, w, ry);
  b.box(s, s * 0.14, s, x, y + s * 0.07, z, d, ry);
  b.box(s, s * 0.14, s, x, y + s * 0.85, z, d, ry);
  b.box(s * 0.14, s * 0.92, s * 1.01, x, y + s * 0.46, z, d, ry);
}

function crates(b, r) {
  const ry = (r() - 0.5) * 0.5;
  crate(b, r, 0.52, -0.12, 0, -0.08, ry);
  crate(b, r, 0.36, 0.26, 0, 0.2, ry + 0.3);
  if (r() < 0.5) crate(b, r, 0.3, -0.14, 0.48, -0.06, ry + 0.4);
  else b.box(0.7, 0.06, 0.6, 0.02, 0.03, 0.04, P.wood2, ry); // pallet
}

function barrel(b, r, x, z, tipped) {
  const cols = [P.rust, P.teal, P.bone, P.rust2];
  const c = jit(r, cols[r() * cols.length | 0], 0.12);
  const dk = new THREE.Color(c).multiplyScalar(0.62).getHex();
  if (tipped) {
    const ry = r() * Math.PI;
    b.cyl(0.16, 0.46, 10, x, 0.16, z, c, ry, 0, Math.PI / 2);
    b.cyl(0.168, 0.04, 10, x + Math.cos(ry) * 0.12, 0.16, z - Math.sin(ry) * 0.12, dk, ry, 0, Math.PI / 2);
    return;
  }
  b.cyl(0.16, 0.5, 8, x, 0.25, z, c);
  b.cyl(0.168, 0.035, 8, x, 0.15, z, dk);
  b.cyl(0.168, 0.035, 8, x, 0.36, z, dk);
  b.cyl(0.13, 0.02, 8, x, 0.505, z, dk);
}

function barrels(b, r) {
  barrel(b, r, -0.18, -0.15, false);
  barrel(b, r, 0.18, -0.1, false);
  if (r() < 0.6) barrel(b, r, 0.02, 0.22, r() < 0.5);
  else barrel(b, r, -0.05, 0.2, false);
}

function sandbags(b, r, nb) {
  // wall of bags across the tile; orient along an axis with neighbours if any
  const alongX = nb[0] || nb[1] ? true : nb[2] || nb[3] ? false : r() < 0.5;
  const ry = alongX ? 0 : Math.PI / 2;
  const off = (r() - 0.5) * 0.2;
  const rows = [[-0.32, 0, 0.32], [-0.16, 0.16], [-0.3, 0, 0.3]];
  const ys = [0.08, 0.22, 0.36];
  rows.forEach((row, ri) => {
    if (ri === 2 && r() < 0.35) return;
    for (const p of row) {
      const lx = p + (r() - 0.5) * 0.04, lz = off + (ri === 2 ? 0.02 : 0);
      const x = alongX ? lx : lz, z = alongX ? lz : lx;
      b.ico(0.16, x, ys[ri], z, jit(r, r() < 0.5 ? P.sandbag : P.sandbag2, 0.08), alongX ? 1.05 : 0.6, 0.42, alongX ? 0.6 : 1.05, (r() - 0.5) * 0.2, 0, 0, 0);
    }
  });
  void ry;
}

function car(b, r) {
  const ry = (r() < 0.5 ? 0 : Math.PI / 2) + (r() - 0.5) * 0.7;
  const paint = jit(r, [P.teal, P.bone, P.rust, P.tealDeep][r() * 4 | 0], 0.1);
  const rot = new THREE.Matrix4().makeRotationY(ry);
  const pb = b.parent ? b.parent.clone().multiply(rot) : rot;
  const old = b.parent;
  b.setParent(pb);
  // wheels (flat, half sunk)
  for (const [x, z] of [[-0.28, -0.22], [0.28, -0.22], [-0.28, 0.22], [0.28, 0.22]]) b.cyl(0.11, 0.08, 7, x, 0.09, z, P.rubber, 0, Math.PI / 2, 0);
  b.box(0.9, 0.22, 0.46, 0, 0.24, 0, paint);
  b.box(0.92, 0.06, 0.48, 0, 0.14, 0, P.rust2);
  b.box(0.46, 0.16, 0.42, -0.06, 0.43, 0, paint);
  b.box(0.47, 0.11, 0.43, -0.06, 0.43, 0, P.glass);
  b.box(0.2, 0.03, 0.44, 0.27, 0.36, 0, paint, 0, 0, -0.35); // hood
  b.box(0.02, 0.05, 0.36, 0.45, 0.26, 0, P.steel);
  // rust holes / kelp
  b.box(0.18, 0.1, 0.02, 0.2, 0.25, 0.235, P.rustDark);
  b.box(0.14, 0.08, 0.02, -0.28, 0.22, -0.235, P.rustDark);
  kelpTuft(b, r, 0.36, 0.2);
  b.setParent(old);
}

function jersey(b, r, nb) {
  const alongX = nb[0] || nb[1] ? true : nb[2] || nb[3] ? false : r() < 0.5;
  const ry = alongX ? 0 : Math.PI / 2;
  const c = jit(r, P.wallConcrete, 0.05);
  b.trap(0.96, 0.52, 0.38, 0, 0.26, 0, c, ry);
  // faded stripes
  for (const o of [-0.3, 0, 0.3]) {
    const [x, z] = alongX ? [o, 0] : [0, o];
    b.box(alongX ? 0.1 : 0.31, 0.08, alongX ? 0.31 : 0.1, x, 0.32, z, r() < 0.5 ? P.bone : P.tealDeep, 0, alongX ? 0 : 0, 0);
  }
  if (r() < 0.6) chunk(b, r, alongX ? 0.3 : 0.25, alongX ? 0.28 : 0.3, 0.1, P.wallConcrete);
}

function rubble(b, r, broken) {
  const n = 5 + (r() * 3 | 0);
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2, d = r() * 0.28;
    const s = 0.12 + r() * 0.14;
    chunk(b, r, Math.cos(a) * d, Math.sin(a) * d, s, r() < 0.7 ? P.wallConcrete : P.plaster2);
  }
  // leaning slab
  b.box(0.58, 0.08, 0.36, 0.05, 0.26, -0.04, jit(r, P.wallConcrete), r() * 3, 0.1, 0.65);
  b.box(0.3, 0.3, 0.3, -0.1, 0.15, 0.12, jit(r, P.plaster2), r(), 0.2, 0.1);
  rebar(b, r, 0, 0.3, 0, broken ? 4 : 2);
  kelpTuft(b, r, (r() - 0.5) * 0.5, (r() - 0.5) * 0.5);
  if (!broken) kelpTuft(b, r, (r() - 0.5) * 0.5, (r() - 0.5) * 0.5);
}

function debrisScatter(b, r) {
  for (let i = 0; i < 5; i++) {
    const s = 0.06 + r() * 0.07;
    b.box(s * 1.4, 0.035 + r() * 0.03, s, (r() - 0.5) * 0.8, 0.02, (r() - 0.5) * 0.8, r() < 0.6 ? P.wallDark : P.plaster2, r() * 6);
  }
  b.box(0.5, 0.012, 0.4, (r() - 0.5) * 0.2, 0.006, (r() - 0.5) * 0.2, 0x3a3631, r() * 6);
}
