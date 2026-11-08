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

const NEON = [0xff4fa0, 0xa05bff, 0x9cff4a, 0xff4a5a, 0xe8d8ff];

export class PropField {
  constructor(map, cls, fields, wx, wz, seed, look = null) {
    this.map = map;
    this.S = map.size;
    this.cls = cls;
    this.wx = wx; this.wz = wz;
    this.seed = seed;
    this.look = look || { mix: null, wallScale: 1, neon: false };
    const n = this.S * this.S;
    this.cover = Uint8Array.from(map.cover); // displayed cover (lags sim until events play)
    this.explosive = map.explosive ? Uint8Array.from(map.explosive) : new Uint8Array(n); // displayed live barrels
    this.damaged = new Uint8Array(n);
    this.version = 0; // bumps on every displayed cover change (contact AO re-bake)
    this.wasCover = new Uint8Array(n);
    this.group = new THREE.Group();
    // Always in the transparent pass (opacity 1 normally): toggling `transparent` would
    // recompile the program (three bakes OPAQUE in), a visible hitch on the first fade.
    this.mat = patchWorld(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.04, transparent: true }), fields, 'props');
    this.glowMat = patchWorld(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true }), fields, 'glow');
    this.spill = []; // neon light pools [{x, z, color, r}] (spire)
    this._classify();
    this.nc = Math.ceil(this.S / CH);
    this.chunks = [];
    for (let cy = 0; cy < this.nc; cy++) for (let cx = 0; cx < this.nc; cx++) this.chunks.push({ cx, cy, mesh: null, glow: null });
    this._collectSpill = true;
    for (const c of this.chunks) this._buildChunk(c);
    this._collectSpill = false;
    // cover fade (move mode): props go near-invisible, footprints take over
    this.fade = 0;
    this.foot = buildFootprints(this.S);
    this.foot.mesh.visible = false;
    this.group.add(this.foot.mesh);
    this._footDirty = true;
  }

  /** k in [0,1]: 0 = props solid, 1 = props at ~6% with ground footprints showing. */
  setFade(k) {
    if (k === this.fade) return;
    this.fade = k;
    const on = k > 0.001;
    const op = 1 - 0.94 * k;
    for (const m of [this.mat, this.glowMat]) { m.opacity = op; m.depthWrite = k < 0.5; }
    for (const c of this.chunks) {
      if (c.mesh) { c.mesh.castShadow = k < 0.5; c.mesh.renderOrder = on ? 3 : 0; }
      if (c.glow) c.glow.renderOrder = on ? 3 : 0;
    }
    if (on && this._footDirty) { this._footDirty = false; this.foot.rebuild(this.cover, this.wx, this.wz, this.cls); }
    this.foot.mesh.visible = on;
    this.foot.mat.uniforms.uA.value = k;
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
    const faded = this.fade > 0.001;
    if (!b.empty) {
      c.mesh = new THREE.Mesh(b.build({ stain: true }), this.mat);
      c.mesh.castShadow = !(this.fade >= 0.5);
      c.mesh.receiveShadow = true;
      c.mesh.renderOrder = faded ? 3 : 0;
      this.group.add(c.mesh);
    }
    if (!gb.empty) {
      c.glow = new THREE.Mesh(gb.build({ ao: false }), this.glowMat);
      c.glow.renderOrder = faded ? 3 : 0;
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
    this.version = (this.version || 0) + 1;
    this._footDirty = true;
    if (this.fade > 0.001) { this._footDirty = false; this.foot.rebuild(this.cover, this.wx, this.wz, this.cls); }
    if (to < from) this.damaged[k] = 1;
    if (to === 0) this.explosive[k] = 0;
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

  /** 5.0 Engineer barricade on a tile: axis 0 = panel along x, 1 = along z; col = squad stripe. */
  markBarricade(x, y, axis, col) {
    if (!this.barricade) this.barricade = new Map();
    this.barricade.set(y * this.S + x, { axis, col: new THREE.Color(col).getHex() });
  }

  /** Rebuild the chunk holding a tile (terrain height changed under it). */
  refreshTile(x, y) {
    this._footDirty = true;
    this.version++;
    this._buildChunk(this.chunks[Math.floor(y / CH) * this.nc + Math.floor(x / CH)]);
  }

  /** A barrel went off: the tile shows scorched wreckage until its cover_change lands. */
  detonate(x, y) {
    const k = y * this.S + x;
    if (!this.explosive[k]) return false;
    this.explosive[k] = 0;
    this.damaged[k] = 1;
    this._buildChunk(this.chunks[Math.floor(y / CH) * this.nc + Math.floor(x / CH)]);
    return true;
  }

  /** Approximate dominant colour of the prop on a tile (for debris). */
  debrisColors(k, cv) {
    if (this.explosive[k]) return [0xc8261c, 0x3a3d40, 0xe0d4b6];
    if (cv === 2) return this.style[k] === 2 ? [P.containerCols[this.lineId[k] % P.containerCols.length], P.rust2, P.steel] : [P.plaster, P.wallConcrete, P.wallDark];
    return [P.wood, P.wallConcrete, P.rust, P.sandbag];
  }

  dispose() {
    for (const c of this.chunks) { c.mesh?.geometry.dispose(); c.glow?.geometry.dispose(); }
    this.mat.dispose(); this.glowMat.dispose();
    this.foot.dispose();
  }

  // ---------- prop recipes ----------

  _prop(b, gb, x, y, k, cv) {
    const r = rng((k * 7919) ^ this.seed);
    const nb = this._nb(x, y);
    if (cv === 0) return debrisScatter(b, r);
    const bar = this.barricade?.get(k);
    if (bar && cv === 2) return barricadeProp(b, r, bar.axis, bar.col);
    if (bar && cv === 1) return rubble(b, r, true);
    if (cv === 2) {
      const wh = this.map.wallHeight ? this.map.wallHeight[k] : 1.1;
      const h = (1.02 + (wh - 0.95) * 1.0) * (this.look.wallScale || 1);
      const st = this.style[k];
      if (st === 2) return container(b, r, this.axis[k], this.lineEnd[k], P.containerCols[hash(this.lineId[k]) * P.containerCols.length | 0], 1.12);
      if (st === 3) { const v = hash(k * 13 + 5); return v < 0.5 ? pillar(b, r, h) : v < 0.78 ? kiosk(b, gb, r, h, this.look.neon) : palletStack(b, r, h); }
      return wall(b, gb, r, nb, h, x, y, this);
    }
    // half cover
    if (this.explosive[k]) return explosiveBarrels(b, gb, r);
    if (this.damaged[k]) return rubble(b, r, true);
    const wallNb = nb.some((v, i) => {
      if (!v) return false;
      const [dx, dy] = DIRS[i];
      const nk = (y + dy) * this.S + x + dx;
      return v === 2 ? this.style[nk] === 1 : this._isStub(x + dx, y + dy);
    });
    if (wallNb) return stub(b, r, nb, x, y, this);
    const mix = this.look.mix || MIX;
    let pick = hash(k * 31 + 7) * this._mixTotal(mix);
    let i = 0;
    for (; i < mix.length - 1; i++) { if ((pick -= mix[i]) < 0) break; }
    switch (i) {
      case 0: return crates(b, r);
      case 1: return barrels(b, r);
      case 2: return sandbags(b, r, nb);
      case 3: return car(b, r);
      case 4: return jersey(b, r, nb);
      case 5: return boat(b, r);
      case 6: return tires(b, r);
      case 7: return nettedCrates(b, r);
      case 8: return buoyPile(b, r);
      case 10: return pipes(b, r, nb);
      default: return rubble(b, r, false);
    }
  }

  _mixTotal(mix) {
    if (this._mixT && this._mixT[0] === mix) return this._mixT[1];
    const t = mix.reduce((a, v) => a + v, 0);
    this._mixT = [mix, t];
    return t;
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
  if (F.look.neon) neonSign(b, gb, r, nb, hc, x, y, F);
  void x; void y; void F;
}

/** Night Spires: neon tubes and signs on wall faces that look onto open ground, plus a light pool below. */
function neonSign(b, gb, r, nb, H, x, y, F) {
  if (hash(y * F.S + x + 4242) > 0.3) return;
  const S = F.S;
  const open = (dx, dy) => { const nx = x + dx, ny = y + dy; return nx >= 0 && ny >= 0 && nx < S && ny < S && !F.map.cover[ny * S + nx]; };
  const faces = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy], i) => !nb[i] && open(dx, dy));
  if (!faces.length) return;
  const [dx, dy] = faces[(r() * faces.length) | 0];
  const col = NEON[(hash(F.lineId[y * S + x] * 3 + 17) * NEON.length) | 0];
  const T = 0.3 + 0.012;
  const ox = dx * T, oz = dy * T;
  const kind = r();
  if (kind < 0.45) {
    // vertical tube
    const hh = 0.5 + r() * (H - 0.7);
    gb.box(dx ? 0.03 : 0.05, hh, dy ? 0.03 : 0.05, ox + (dy ? (r() - 0.5) * 0.3 : 0), 0.35 + hh / 2, oz + (dx ? (r() - 0.5) * 0.3 : 0), col);
  } else {
    // sign: dark backing box + glowing frame + bar "text"
    const sw = 0.42, sh = 0.24, sy = H - 0.3 - r() * 0.3;
    const bx = dx ? 0.04 : sw, bz = dy ? 0.04 : sw;
    b.box(bx, sh, bz, ox + dx * 0.02, sy, oz + dy * 0.02, 0x15161c);
    gb.box(dx ? 0.05 : sw + 0.03, 0.025, dy ? 0.05 : sw + 0.03, ox + dx * 0.03, sy + sh / 2, oz + dy * 0.03, col);
    gb.box(dx ? 0.05 : sw + 0.03, 0.025, dy ? 0.05 : sw + 0.03, ox + dx * 0.03, sy - sh / 2, oz + dy * 0.03, col);
    for (let i = 0; i < 3; i++) {
      const w = 0.06 + r() * 0.06, off = -0.12 + i * 0.12;
      gb.box(dx ? 0.05 : w, 0.07, dy ? 0.05 : w, ox + dx * 0.04 + (dy ? off : 0), sy, oz + dy * 0.04 + (dx ? off : 0), col);
    }
  }
  if (F._collectSpill) F.spill.push({ x: F.wx(x) + dx * 0.95, z: F.wz(y) + dy * 0.95, color: col, r: 1.1 + r() * 0.5 });
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


// ---------- 2.0 prop variety ----------

/** Beached rowboat, hull rolled on its side: half cover with a story. */
function boat(b, r) {
  const ry = r() * Math.PI * 2;
  const rot = new THREE.Matrix4().makeRotationY(ry);
  const old = b.parent;
  b.setParent(old ? old.clone().multiply(rot) : rot);
  const hull = jit(r, [P.teal, P.bone, 0x3e5f7d, P.rust][r() * 4 | 0], 0.08);
  const inside = jit(r, P.wood, 0.08);
  const keel = new THREE.Color(hull).multiplyScalar(0.7).getHex();
  const tilt = 0.55;
  // hull: tapered planks (bow at +x), rolled onto its side
  for (let i = 0; i < 5; i++) {
    const t = i / 4, w = 0.9 - Math.abs(t - 0.4) * 0.5;
    b.box(w, 0.07, 0.07, 0.02 - t * 0.04, 0.08 + t * 0.07, -0.22 + t * 0.12, i === 4 ? P.bone : hull, 0, tilt);
  }
  b.box(0.82, 0.05, 0.36, 0, 0.08, 0.02, inside, 0, tilt); // floorboards
  b.box(0.86, 0.06, 0.05, 0, 0.32, 0.12, keel, 0, tilt); // gunwale
  b.box(0.08, 0.04, 0.34, -0.1, 0.17, 0.03, P.wood2, 0, tilt); // thwart
  b.cone(0.14, 0.0, 0.2, 4, 0.48, 0.15, -0.02, hull, Math.PI / 4, 0, Math.PI / 2); // bow point
  b.box(0.04, 0.3, 0.05, -0.42, 0.18, 0.05, keel, 0, tilt); // transom
  // oar + rope
  b.box(0.8, 0.025, 0.04, 0.05, 0.03, 0.38, P.wood, 0.3);
  b.box(0.16, 0.02, 0.07, 0.42, 0.03, 0.47, P.wood, 0.3);
  b.cyl(0.07, 0.04, 8, -0.32, 0.02, 0.36, 0xb59d6d);
  kelpTuft(b, r, 0.3, -0.3);
  b.setParent(old);
}

function tires(b, r) {
  const n = 3 + (r() * 2 | 0);
  for (let i = 0; i < n; i++) {
    const x = (i % 2 ? 0.12 : -0.1) + (r() - 0.5) * 0.06, z = (r() - 0.5) * 0.12;
    b.cyl(0.2, 0.11, 10, x, 0.055 + i * 0.1, z, P.rubber);
    b.cyl(0.1, 0.112, 8, x, 0.055 + i * 0.1, z, 0x111416);
  }
  b.cyl(0.2, 0.11, 10, 0.28, 0.15, 0.25, P.rubber, r(), 0, 1.3); // one leaning
  if (r() < 0.6) b.trap(0.5, 0.3, 0.2, -0.2, 0.15, 0.28, 0xb8673a, r()); // cone-ish wedge (faded hazard)
}

function nettedCrates(b, r) {
  crate(b, r, 0.5, 0, 0, 0, r() * 0.4);
  crate(b, r, 0.34, 0.12, 0.5, 0.05, r());
  // fishing net draped over: thin dark boxes + floats
  const net = 0x2f3b38;
  for (let i = -2; i <= 2; i++) b.box(0.02, 0.012, 0.62, i * 0.12, 0.52, 0, net, 0, 0, 0.2);
  for (let i = -2; i <= 2; i++) b.box(0.62, 0.012, 0.02, 0, 0.5, i * 0.12, net, 0, 0.15);
  for (const [x, z] of [[-0.3, 0.3], [0.3, -0.28], [0.32, 0.3]]) b.sphere(0.045, x, 0.3 + r() * 0.2, z, r() < 0.5 ? P.rust : P.bone, 1, 1, 1, 6, 4);
  b.box(0.6, 0.02, 0.25, 0.05, 0.02, 0.35, net, r());
}

function buoyPile(b, r) {
  const cols = [P.rust, P.bone, P.teal];
  b.cyl(0.24, 0.48, 9, -0.1, 0.24, -0.05, cols[r() * 3 | 0], 0, Math.PI / 2, 0.4);
  b.cyl(0.25, 0.08, 9, -0.1, 0.24, -0.05, P.bone, 0, Math.PI / 2, 0.4);
  b.sphere(0.17, 0.22, 0.17, 0.2, cols[r() * 3 | 0], 1, 1, 1, 8, 6);
  b.sphere(0.14, 0.27, 0.42, 0.12, P.bone, 1, 1, 1, 8, 6);
  b.cyl(0.22, 0.06, 10, 0.2, 0.03, -0.25, 0xb59d6d); // rope coil
  b.cyl(0.12, 0.065, 8, 0.2, 0.031, -0.25, 0x4a3f2c);
  kelpTuft(b, r, -0.3, 0.3);
}

/** Single full-cover tile: a rusted harbour kiosk with a lit sign. */
function kiosk(b, gb, r, H, neon = false) {
  const body = jit(r, [0x8d9d95, P.plaster2, 0x7fa3a3][r() * 3 | 0]);
  b.box(0.7, 0.18, 0.7, 0, 0.09, 0, P.wallConcrete);
  b.box(0.62, H - 0.3, 0.62, 0, 0.18 + (H - 0.3) / 2, 0, body);
  b.box(0.74, 0.08, 0.74, 0, H - 0.05, 0, P.steelDark);
  b.box(0.46, 0.36, 0.64, 0, 0.62, 0, P.window); // shutters / window band
  b.box(0.64, 0.36, 0.46, 0, 0.62, 0, P.window);
  for (let i = 0; i < 4; i++) b.box(0.66, 0.025, 0.66, 0, 0.47 + i * 0.1, 0, P.steel);
  b.box(0.3, 0.14, 0.02, 0, H - 0.2, 0.322, P.bone); // sign
  if (neon || r() < 0.6) gb.box(0.24, 0.08, 0.025, 0, H - 0.2, 0.325, neon ? NEON[(r() * NEON.length) | 0] : P.windowGlow);
  b.box(0.12, 0.3, 0.012, 0.2, 0.75, 0.315, P.rust2); // rust streak
  rebar(b, r, 0.2, H, 0.1, 2);
}

function palletStack(b, r, H) {
  const n = Math.round(H / 0.16);
  for (let i = 0; i < n; i++) {
    const ry = (r() - 0.5) * 0.16;
    b.box(0.74, 0.04, 0.72, (r() - 0.5) * 0.05, 0.02 + i * 0.16, (r() - 0.5) * 0.05, jit(r, P.wood2), ry);
    b.box(0.7, 0.1, 0.66, (r() - 0.5) * 0.04, 0.09 + i * 0.16, (r() - 0.5) * 0.04, jit(r, P.wood), ry);
  }
  b.box(0.8, H * 0.55, 0.04, 0, H * 0.62, 0.36, 0x46574f, 0, 0.06); // tarp hanging off one side
  b.box(0.82, 0.05, 0.78, 0, n * 0.16 + 0.02, 0, 0x46574f, 0.1);
}

// ---------- 3.0 recipes ----------

/** Rig Graveyard explosive drums: dark steel, bright red bands, hazard diamond. */
function explosiveBarrels(b, gb, r) {
  const spots = [[-0.17, -0.12], [0.18, -0.08], [0.0, 0.2]];
  const n = r() < 0.5 ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const [x, z] = spots[i];
    const red = 0xc8261c, steel = 0x3a3d40;
    b.cyl(0.165, 0.52, 10, x, 0.26, z, steel);
    b.cyl(0.172, 0.07, 10, x, 0.13, z, red);
    b.cyl(0.172, 0.07, 10, x, 0.39, z, red);
    b.cyl(0.14, 0.02, 10, x, 0.525, z, 0x2a2c2e);
    b.cyl(0.03, 0.03, 6, x + 0.06, 0.54, z + 0.04, 0x8a8f90); // bung
    // hazard diamond facing outward
    const a = Math.atan2(x, z) || 0.4;
    const fx = x + Math.sin(a) * 0.168, fz = z + Math.cos(a) * 0.168;
    b.box(0.11, 0.11, 0.012, fx, 0.26, fz, P.bone, a, 0, Math.PI / 4);
    b.box(0.06, 0.06, 0.016, fx + Math.sin(a) * 0.004, 0.26, fz + Math.cos(a) * 0.004, red, a, 0, Math.PI / 4);
    gb.cyl(0.174, 0.018, 10, x, 0.39, z, 0xff3a24); // glowing band so they read at night / in fog
  }
  b.box(0.7, 0.04, 0.6, 0.0, 0.02, 0.03, 0x2d2a26, r() * 0.4); // oil-soaked pallet
}

/** Rig pipe bundle: stacked rusty pipes on chocks. */
function pipes(b, r, nb) {
  const alongX = nb[0] || nb[1] ? true : nb[2] || nb[3] ? false : r() < 0.5;
  const rz = alongX ? Math.PI / 2 : 0, rx = alongX ? 0 : Math.PI / 2;
  const rows = [[-0.2, 0.12], [0.0, 0.12], [0.2, 0.12], [-0.1, 0.32], [0.1, 0.32]];
  for (const [o, y] of rows) {
    if (y > 0.3 && r() < 0.3) continue;
    const c = jit(r, r() < 0.6 ? P.rust : P.steel, 0.1);
    b.cyl(0.1, 0.96, 8, alongX ? 0 : o, y, alongX ? o : 0, c, 0, rx, rz);
    b.cyl(0.06, 0.97, 6, alongX ? 0 : o, y, alongX ? o : 0, 0x1d1f20, 0, rx, rz);
  }
  for (const s of [-0.35, 0.35]) b.box(alongX ? 0.08 : 0.62, 0.06, alongX ? 0.62 : 0.08, alongX ? s : 0, 0.03, alongX ? 0 : s, P.wood2);
}

const MIX = [14, 12, 13, 12, 10, 10, 7, 8, 6, 8, 0];

/** 5.0 deployable barricade as a full-cover prop: steel panel wall with a squad stripe. */
function barricadeProp(b, r, axis, col) {
  const ry = axis ? Math.PI / 2 : 0;
  const c = Math.cos(ry), s = Math.sin(ry);
  const at = (lx, lz) => [lx * c + lz * s, -lx * s + lz * c];
  b.box(0.92, 1.0, 0.1, 0, 0.5, 0, 0x55605f, ry);
  for (const x of [-0.3, 0, 0.3]) { const [px, pz] = at(x, 0); b.box(0.03, 0.96, 0.12, px, 0.5, pz, 0x3c4544, ry); }
  b.box(0.94, 0.06, 0.13, 0, 1.0, 0, 0x2f3636, ry);
  b.box(0.94, 0.08, 0.13, 0, 0.62, 0, col, ry);
  for (const x of [-0.3, 0.3]) { const [px, pz] = at(x, 0); b.box(0.12, 0.2, 0.11, px, 0.82, pz, 0x1a2228, ry); }
  for (const x of [-0.38, 0.38]) { const [px, pz] = at(x, 0); b.box(0.1, 0.08, 0.5, px, 0.04, pz, 0x2f3636, ry); }
  void r;
}

// ---------- cover footprints (shown while cover is faded in move mode) ----------

const FOOT_VERT = /* glsl */`
attribute float aEdge;
attribute float aKind;
varying vec2 vUv;
varying float vEdge;
varying float vKind;
void main() {
  vUv = uv; vEdge = aEdge; vKind = aKind;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const FOOT_FRAG = /* glsl */`
uniform float uA;
uniform sampler2D uGlyph;
varying vec2 vUv;
varying float vEdge;
varying float vKind;
float bit(float m, float b) { return mod(floor(m / b), 2.0); }
void main() {
  vec2 u = vUv;
  float e = 1e3;
  float ins = 0.06;
  if (bit(vEdge, 1.0) < 0.5) e = min(e, 1.0 - ins - u.x);
  if (bit(vEdge, 2.0) < 0.5) e = min(e, u.x - ins);
  if (bit(vEdge, 4.0) < 0.5) e = min(e, 1.0 - ins - u.y);
  if (bit(vEdge, 8.0) < 0.5) e = min(e, u.y - ins);
  float full = step(1.5, vKind);
  float w = mix(0.022, 0.034, full);
  float aa = fwidth(e) * 1.2;
  float line = 1.0 - smoothstep(w - aa, w + aa, abs(e));
  float inside = step(0.0, e);
  // glyph in the middle of each tile: half shield / full shield
  vec2 g = (u - 0.5) / 0.46 + 0.5;
  vec4 gl = vec4(0.0);
  if (g.x > 0.0 && g.y > 0.0 && g.x < 1.0 && g.y < 1.0) gl = texture2D(uGlyph, vec2((g.x + full) * 0.5, 1.0 - g.y));
  vec3 bone = vec3(0.95, 0.93, 0.86);
  vec3 col = mix(vec3(0.04, 0.07, 0.08), bone, max(line, gl.r));
  float a = max(max(line * 0.95, inside * mix(0.3, 0.42, full)), gl.a * 0.92);
  gl_FragColor = vec4(col, a * uA);
}`;

function glyphAtlas() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  for (let i = 0; i < 2; i++) {
    g.save(); g.translate(i * 128, 0);
    const path = () => {
      g.beginPath(); g.moveTo(64, 14); g.lineTo(104, 28); g.lineTo(100, 66); g.quadraticCurveTo(90, 96, 64, 114);
      g.quadraticCurveTo(38, 96, 28, 66); g.lineTo(24, 28); g.closePath();
    };
    g.lineJoin = 'round';
    // r = bone amount, a = coverage
    path(); g.fillStyle = 'rgba(0,0,0,0.85)'; g.fill();
    g.save(); path(); g.clip(); g.fillStyle = '#fff';
    if (i === 1) g.fillRect(0, 0, 128, 128); else g.fillRect(0, 66, 128, 62);
    g.restore();
    path(); g.lineWidth = 9; g.strokeStyle = '#fff'; g.stroke();
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4;
  return t;
}

function buildFootprints(S) {
  const cap = S * S;
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  const edge = new Float32Array(cap), kind = new Float32Array(cap);
  geo.setAttribute('aEdge', new THREE.InstancedBufferAttribute(edge, 1));
  geo.setAttribute('aKind', new THREE.InstancedBufferAttribute(kind, 1));
  const tex = glyphAtlas();
  const mat = new THREE.ShaderMaterial({
    uniforms: { uA: { value: 0 }, uGlyph: { value: tex } },
    vertexShader: FOOT_VERT, fragmentShader: FOOT_FRAG, transparent: true, depthWrite: false,
  });
  mat.extensions = { derivatives: true };
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.count = 0; mesh.renderOrder = 4; mesh.frustumCulled = false;
  const m4 = new THREE.Matrix4();
  return {
    mesh, mat,
    rebuild(cover, wx, wz, cls) {
      let i = 0;
      const same = (x, y, v) => x >= 0 && y >= 0 && x < S && y < S && cover[y * S + x] === v ? 1 : 0;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const v = cover[y * S + x];
        if (!v) continue;
        m4.makeTranslation(wx(x), tileTop(cls.type[y * S + x]) + 0.135, wz(y));
        mesh.setMatrixAt(i, m4);
        edge[i] = same(x + 1, y, v) + same(x - 1, y, v) * 2 + same(x, y + 1, v) * 4 + same(x, y - 1, v) * 8;
        kind[i] = v;
        i++;
      }
      mesh.count = i;
      mesh.instanceMatrix.needsUpdate = true;
      geo.attributes.aEdge.needsUpdate = true; geo.attributes.aKind.needsUpdate = true;
    },
    dispose() { geo.dispose(); mat.dispose(); tex.dispose(); },
  };
}

// ---------- open-ground decor (never taller than ~0.12: must not read as cover) ----------

/**
 * Low clutter on open, dry tiles: puddles, oil stains, shells and pebbles,
 * driftwood, rope coils, road paint and manholes on concrete, kelp drifts on
 * sand, traffic signs flattened on the ground, scattered planks. One merged mesh.
 */
export function buildDecor(map, cls, fields, wx, wz, seed) {
  const S = map.size;
  const b = new GeoBuilder(true);
  const m4 = new THREE.Matrix4();
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const k = y * S + x;
    if (map.cover[k]) continue;
    const h = hash(k * 977 + (seed & 0xffff));
    if (h > 0.3) continue;
    const r = rng((k * 3571) ^ seed);
    const type = cls.type[k];
    m4.makeTranslation(wx(x), tileTop(type), wz(y));
    b.setParent(m4);
    const ox = (r() - 0.5) * 0.5, oz = (r() - 0.5) * 0.5;
    const pick = r();
    if (type === 0) {
      // sand
      if (pick < 0.3) { for (let i = 0; i < 4; i++) b.ico(0.03 + r() * 0.03, ox + (r() - 0.5) * 0.4, 0.01, oz + (r() - 0.5) * 0.4, r() < 0.5 ? P.bone : 0xb7ab92, 1, 0.5, 1, r() * 6); }
      else if (pick < 0.55) b.box(0.55 + r() * 0.3, 0.05, 0.07, ox, 0.025, oz, 0x8a7a63, r() * 6, 0, (r() - 0.5) * 0.1); // driftwood
      else if (pick < 0.75) kelpDrift(b, r, ox, oz);
      else if (pick < 0.88) { b.cyl(0.13, 0.05, 10, ox, 0.025, oz, 0xb59d6d); b.cyl(0.06, 0.052, 8, ox, 0.026, oz, 0x6f5f45); }
      else { b.box(0.3, 0.012, 0.3, ox, 0.006, oz, 0x8f8a7c, r() * 6); b.box(0.1, 0.02, 0.02, ox, 0.02, oz, P.rust2, r() * 6); }
    } else if (type === 1) {
      // concrete
      if (pick < 0.25) b.box(0.08, 0.006, 0.7, ox * 0.4, 0.003, 0, P.bone, (x + y) % 2 ? 0 : Math.PI / 2); // road paint
      else if (pick < 0.42) { b.cyl(0.2, 0.012, 12, ox, 0.006, oz, 0x575a56); b.cyl(0.16, 0.014, 12, ox, 0.007, oz, 0x6a6d68); }
      else if (pick < 0.6) b.cyl(0.25 + r() * 0.15, 0.004, 10, ox, 0.002, oz, 0x5d605b, 0, 0, 0, 0.18 + r() * 0.12); // oil stain
      else if (pick < 0.75) { b.box(0.34, 0.02, 0.24, ox, 0.012, oz, 0xc9c2ae, r() * 6, 0.05); b.box(0.3, 0.005, 0.04, ox, 0.024, oz, 0xa3502e, r() * 6); } // fallen sign
      else if (pick < 0.88) for (let i = 0; i < 3; i++) b.box(0.08 + r() * 0.08, 0.03, 0.06 + r() * 0.06, ox + (r() - 0.5) * 0.3, 0.015, oz + (r() - 0.5) * 0.3, P.wallDark, r() * 6);
      else { b.cone(0.07, 0.15, 0.13, 6, ox, 0.065, oz, 0xd28a3a); b.box(0.15, 0.015, 0.15, ox, 0.008, oz, 0x2a2a28); } // traffic cone
    } else if (type === 2) {
      if (pick < 0.5) b.box(0.5, 0.025, 0.1, ox, 0.012, oz, P.wood2, cls.dir[k] ? 0 : Math.PI / 2); // loose plank
      else { b.cyl(0.12, 0.05, 10, ox, 0.025, oz, 0xb59d6d); }
    } else if (type === 5) {
      // shallow water: a few stones and shells on the seabed
      if (pick < 0.6) for (let i = 0; i < 3; i++) b.ico(0.04 + r() * 0.04, ox + (r() - 0.5) * 0.4, 0.01, oz + (r() - 0.5) * 0.4, r() < 0.5 ? 0x8a8070 : 0xc9bea2, 1, 0.5, 1, r() * 6);
    } else if (type === 4) {
      // rig deck: oil stains, hatch plates, coiled hose, chain
      if (pick < 0.3) b.cyl(0.25 + r() * 0.15, 0.004, 10, ox, 0.002, oz, 0x2a2826, 0, 0, 0, 0.2 + r() * 0.12);
      else if (pick < 0.5) { b.box(0.42, 0.012, 0.42, ox, 0.006, oz, 0x56534d); b.box(0.12, 0.02, 0.03, ox + 0.12, 0.016, oz, 0x8a8f90); }
      else if (pick < 0.7) { b.cyl(0.14, 0.05, 10, ox, 0.025, oz, 0x2b2f30); b.cyl(0.08, 0.052, 8, ox, 0.026, oz, 0x141616); }
      else if (pick < 0.85) for (let i = 0; i < 5; i++) b.box(0.07, 0.03, 0.045, ox + i * 0.07 - 0.14, 0.015, oz + Math.sin(i) * 0.04, 0x6a5040, (i % 2) * 1.57);
      else b.box(0.08, 0.006, 0.7, ox * 0.4, 0.003, 0, 0xc9b240, (x + y) % 2 ? 0 : Math.PI / 2); // faded deck paint
    } else {
      // tiled floor (indoors): broken tiles, paper, a chair on its side
      if (pick < 0.4) for (let i = 0; i < 3; i++) b.box(0.12, 0.012, 0.12, ox + (r() - 0.5) * 0.3, 0.006, oz + (r() - 0.5) * 0.3, 0xcfc6ae, r() * 6);
      else if (pick < 0.7) { b.box(0.22, 0.02, 0.22, ox, 0.05, oz, P.wood, r() * 6, 1.2); b.box(0.22, 0.02, 0.2, ox + 0.1, 0.015, oz, P.wood, r() * 6); }
      else b.box(0.18, 0.006, 0.24, ox, 0.003, oz, P.bone, r() * 6);
    }
  }
  if (b.empty) return null;
  const mat = patchWorld(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), fields, 'decor');
  const mesh = new THREE.Mesh(b.build({ ao: false }), mat);
  mesh.receiveShadow = true;
  return mesh;
}

function kelpDrift(b, r, x, z) {
  for (let i = 0; i < 5; i++) b.box(0.3 + r() * 0.2, 0.012, 0.05, x + (r() - 0.5) * 0.25, 0.008, z + (r() - 0.5) * 0.25, r() < 0.5 ? P.kelp : P.kelp2, r() * 6);
}
