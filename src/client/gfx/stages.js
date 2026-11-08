// Tidefall 3.0 stage looks. Each stage (state.stage) gets its own lighting /
// weather arc, water and ground palette, prop mix and set dressing:
//   harbor  Drowned Harbor  golden day (the 2.0 look)
//   kelp    Kelp Shallows   green shallows, swaying kelp beds on terrain=1 tiles
//   rig     Rig Graveyard   rust haze, oil platforms with flare stacks offshore
//   spire   Night Spires    night, neon spill on the ground, short sight
//   surge   Surge Point     violent storm from the first round

import * as THREE from 'three';
import { MOOD, P } from './palette.js';
import { GeoBuilder, rng, hash } from './util.js';
import { patchWorld } from './fields.js';

const C = (h) => new THREE.Color(h);
function kf(sun, sunI, sky, ground, hemiI, fog, bg, exposure, cloud, haze) {
  return { sun: C(sun), sunI, sky: C(sky), ground: C(ground), hemiI, fog: C(fog), bg: C(bg), exposure, cloud, haze };
}

const WATER = { shallow: P.waterShallow, mid: P.waterMid, deep: P.waterDeep, foam: P.foam, oil: 0 };
const GROUND = { sand: P.sand, concrete: P.concrete, board: P.board, floor: P.tileFloor, deck: 0x6f6d66, seabed: 0xa89a74, kelp: 0x6f7f4e };

// Half-cover prop weights: crates, barrels, sandbags, car, jersey, boat, tires, netted, buoys, rubble, pipes
const MIX_DEFAULT = [14, 12, 13, 12, 10, 10, 7, 8, 6, 8, 0];

export const STAGE_LOOK = {
  harbor: {
    key: 'harbor', mood: MOOD, water: WATER, ground: GROUND, mix: MIX_DEFAULT,
    stormFloor: 0, stormGain: 1, rain: 0, wallScale: 1, fogDark: 0.42, gulls: 1, sightFeel: 0, neon: false, shafts: { k: 1 }, caustic: 1, grade: { lift: [0.012, 0.02, 0.03], gain: [1.03, 1.0, 0.95], sat: 1.06, contrast: 1.08 }, lightning: 1,
  },
  kelp: {
    key: 'kelp',
    mood: [
      kf(0xfff0c6, 3.0, 0xa6dcc4, 0x3a4a30, 1.3, 0x2a5a4c, 0x163a32, 1.02, 0.12, 0.1),
      kf(0xf3e8b6, 2.6, 0x9ad0b6, 0x34402c, 1.2, 0x28524a, 0x15362f, 1.0, 0.35, 0.3),
      kf(0xe2b482, 2.0, 0x7aa596, 0x2a3026, 1.1, 0x1c3c36, 0x0f2a25, 1.02, 0.55, 0.6),
      kf(0x9ab8b0, 1.35, 0x5a8078, 0x1a2420, 1.05, 0x10241f, 0x0a1a16, 1.04, 0.35, 1),
    ],
    water: { shallow: 0x86d6a2, mid: 0x2f9a7e, deep: 0x0e4a40, foam: 0xeefbe8, oil: 0 },
    ground: { ...GROUND, sand: 0xd6c79c, concrete: 0x8c957f, floor: 0xaaa98c, seabed: 0x9fa77a, kelp: 0x5d7a45 },
    mix: [8, 6, 8, 4, 3, 16, 6, 16, 14, 12, 0],
    stormFloor: 0, stormGain: 1, rain: 0, wallScale: 0.9, fogDark: 0.45, gulls: 1, sightFeel: 0, neon: false, shafts: { k: 1.15, col: 0xd8ffc0 }, caustic: 1.3, grade: { lift: [0.0, 0.025, 0.02], gain: [1.0, 1.03, 0.94], sat: 1.08, contrast: 1.06 }, lightning: 1,
  },
  rig: {
    key: 'rig',
    mood: [
      kf(0xffb47a, 2.9, 0xb89e8a, 0x4a2e22, 1.15, 0x3a2e2a, 0x2a201c, 1.0, 0.25, 0.3),
      kf(0xf29c62, 2.4, 0x9a8478, 0x40281e, 1.1, 0x33292a, 0x241b1a, 1.0, 0.4, 0.45),
      kf(0xd47c52, 1.9, 0x786a66, 0x2c201c, 1.08, 0x241e20, 0x181314, 1.02, 0.55, 0.7),
      kf(0x9a8aa0, 1.3, 0x5a5260, 0x1a1418, 1.05, 0x161318, 0x0e0b0e, 1.04, 0.35, 1),
    ],
    water: { shallow: 0x5f8f80, mid: 0x24514f, deep: 0x0e2427, foam: 0xd9d6c8, oil: 1 },
    ground: { ...GROUND, sand: 0x7e7064, concrete: 0x6f6b63, board: 0x6c4e36, floor: 0x7f7a6e, deck: 0x75736c, seabed: 0x6f6250 },
    mix: [12, 22, 6, 6, 8, 4, 10, 4, 4, 10, 14],
    stormFloor: 0, stormGain: 1, rain: 0, wallScale: 1.05, fogDark: 0.4, gulls: 0.5, sightFeel: 0, neon: false, deck: true, shafts: { k: 0.9, col: 0xffb070 }, caustic: 0.6, grade: { lift: [0.03, 0.012, 0.0], gain: [1.05, 0.98, 0.9], sat: 0.98, contrast: 1.12 }, lightning: 1,
  },
  spire: {
    key: 'spire',
    mood: [
      kf(0x9ab4ff, 1.15, 0x3c4c86, 0x15121f, 0.9, 0x0e1430, 0x070a1a, 1.12, 0.1, 0.3),
      kf(0x92aaf0, 1.05, 0x36447a, 0x13101c, 0.86, 0x0c1229, 0x060916, 1.12, 0.2, 0.45),
      kf(0x8a9ad8, 0.95, 0x2f3a6c, 0x100e18, 0.82, 0x0a0f22, 0x050712, 1.12, 0.3, 0.7),
      kf(0x8090c0, 0.85, 0x2a3460, 0x0c0b12, 0.78, 0x080c1e, 0x04060f, 1.14, 0.3, 0.9),
    ],
    water: { shallow: 0x2f6680, mid: 0x143c54, deep: 0x061826, foam: 0xb8c8e8, oil: 0 },
    ground: { ...GROUND, sand: 0x9a9284, concrete: 0x7c7e8a, board: 0x7a6250, floor: 0x8e8a86, seabed: 0x5a6070 },
    mix: [10, 8, 8, 20, 18, 4, 10, 6, 4, 12, 0],
    stormFloor: 0, stormGain: 0.8, rain: 0.15, wallScale: 1.35, fogDark: 0.26, gulls: 0, sightFeel: 1, neon: true, night: true, shafts: { k: 0.55, col: 0x9fb8ff }, caustic: 0.5, grade: { lift: [0.012, 0.008, 0.018], gain: [1.0, 1.0, 1.02], sat: 1.02, contrast: 1.05 }, lightning: 0.6,
  },
  surge: {
    key: 'surge',
    mood: [
      kf(0xd8a070, 2.0, 0x6c8a92, 0x2b2a29, 1.2, 0x1b3640, 0x10262f, 1.08, 0.6, 0.5),
      kf(0xb89a80, 1.7, 0x5f7c86, 0x242628, 1.16, 0x16303a, 0x0d2129, 1.08, 0.55, 0.7),
      kf(0x92aec4, 1.35, 0x51707f, 0x1b2125, 1.06, 0x10222b, 0x0a1820, 1.04, 0.4, 0.9),
      kf(0x8aa2b8, 1.15, 0x435f6e, 0x15191c, 1.04, 0x0b1a22, 0x071218, 1.05, 0.35, 1),
    ],
    water: { shallow: 0x427f7a, mid: 0x1c4f57, deep: 0x0a2a33, foam: 0xe6eeec, oil: 0 },
    ground: { ...GROUND, sand: 0xb8a580, concrete: 0x84867f },
    mix: [14, 10, 14, 10, 10, 14, 8, 8, 8, 12, 0],
    stormFloor: 0.62, stormGain: 1, rain: 0.55, wallScale: 1, fogDark: 0.4, gulls: 0.4, sightFeel: 0, neon: false, shafts: { k: 0.35 }, caustic: 0.7, grade: { lift: [0.0, 0.015, 0.03], gain: [0.96, 1.0, 1.04], sat: 0.92, contrast: 1.12 }, lightning: 1.8,
  },
  // 5.0 The Pit: a flooded dry-dock arena at night under red floodlights
  pit: {
    key: 'pit',
    mood: [
      kf(0xff8a6a, 1.6, 0x5a3a46, 0x1a0e10, 0.95, 0x1c0c10, 0x0c0507, 1.1, 0.1, 0.4),
      kf(0xff8a6a, 1.6, 0x5a3a46, 0x1a0e10, 0.95, 0x1c0c10, 0x0c0507, 1.1, 0.1, 0.4),
      kf(0xff7a5a, 1.5, 0x4e3240, 0x160c0e, 0.92, 0x180a0e, 0x0a0406, 1.1, 0.1, 0.5),
      kf(0xff7a5a, 1.5, 0x4e3240, 0x160c0e, 0.92, 0x180a0e, 0x0a0406, 1.1, 0.1, 0.5),
    ],
    water: { shallow: 0x3a5a5c, mid: 0x1a3036, deep: 0x080f14, foam: 0xd8c8c0, oil: 0.5 },
    ground: { ...GROUND, sand: 0x6e625a, concrete: 0x5f5a58, floor: 0x6a625c, deck: 0x5a5856, seabed: 0x4a4440 },
    mix: [12, 14, 6, 4, 8, 2, 10, 4, 2, 14, 10],
    stormFloor: 0, stormGain: 0, rain: 0, wallScale: 1.1, fogDark: 0.5, gulls: 0, sightFeel: 0, neon: true, deck: true,
    shafts: { k: 0.8, col: 0xff4a3a }, caustic: 0.4, grade: { lift: [0.03, 0.0, 0.01], gain: [1.06, 0.96, 0.94], sat: 1.05, contrast: 1.14 }, lightning: 0,
  },
};

export function stageLook(stage) { return STAGE_LOOK[stage] || STAGE_LOOK.harbor; }

// ---------- kelp beds (terrain == 1) ----------

const KELP_VERT = /* glsl */`
attribute float aPh;
attribute float aH;
uniform float uT;
uniform float uWind;
`;

/**
 * Swaying kelp fronds on every kelp tile: one instanced draw, sway in the
 * vertex shader (bend grows with height). Fronds stay under ~0.8 tall so
 * soldiers inside still read, but the bed clearly reads as concealment.
 */
export function buildKelp(map, cls, fields, wx, wz, groundY, seed) {
  const S = map.size, T = map.terrain;
  if (!T) return null;
  const tiles = [];
  for (let k = 0; k < S * S; k++) if (T[k] === 1 && !map.cover[k]) tiles.push(k);
  if (!tiles.length) return null;
  // frond: two crossed tapered ribbons, 5 segments each (20 triangles), green → olive toward the tip
  const segs = 5, pos = [], col = [];
  const c0 = new THREE.Color(P.kelp2), c1 = new THREE.Color(0x8fae5a), cc = new THREE.Color();
  for (const rot of [0, Math.PI / 2]) {
    const cx = Math.cos(rot), cz = Math.sin(rot);
    for (let i = 0; i < segs; i++) {
      const y0 = i / segs, y1 = (i + 1) / segs;
      const w0 = 0.075 * (1 - y0 * 0.7), w1 = 0.075 * (1 - y1 * 0.7);
      const o0 = Math.sin(y0 * 5 + rot) * 0.03, o1 = Math.sin(y1 * 5 + rot) * 0.03;
      const q = [[-w0 + o0, y0], [w0 + o0, y0], [w1 + o1, y1], [-w0 + o0, y0], [w1 + o1, y1], [-w1 + o1, y1]];
      for (const [u, y] of q) {
        pos.push(u * cx, y, u * cz);
        cc.copy(c0).lerp(c1, y * 0.85);
        col.push(cc.r, cc.g, cc.b);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const r = rng((seed ^ 0x6b31) >>> 0);
  const per = 6;
  const n = tiles.length * per;
  const ph = new Float32Array(n), hh = new Float32Array(n);
  const mat = patchWorld(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }), fields, 'kelp', {
    vertDecl: KELP_VERT,
  });
  const U = { uT: { value: 0 }, uWind: { value: 0 } };
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh) => {
    prev(sh);
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        float hy = position.y;
        float b = hy * hy * (0.16 + uWind * 0.22);
        float s = sin(uT * 1.3 + aPh) + 0.4 * sin(uT * 2.7 + aPh * 1.7);
        transformed.x += s * b;
        transformed.z += cos(uT * 1.1 + aPh * 0.7) * b * 0.6;
        transformed.y *= aH;
      }`);
  };
  mat.customProgramCacheKey = () => 'tf-kelp';
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  let i = 0;
  for (const k of tiles) {
    const x = k % S, y = (k / S) | 0;
    for (let j = 0; j < per; j++) {
      p.set(wx(x) + (r() - 0.5) * 0.85, groundY(x, y), wz(y) + (r() - 0.5) * 0.85);
      e.set((r() - 0.5) * 0.25, r() * 6.28, (r() - 0.5) * 0.25);
      q.setFromEuler(e);
      const s = 0.8 + r() * 0.5;
      sc.set(s, 1, s);
      m4.compose(p, q, sc);
      mesh.setMatrixAt(i, m4);
      ph[i] = r() * 6.28 + x * 0.4 + y * 0.3;
      hh[i] = 0.55 + r() * 0.4;
      i++;
    }
  }
  geo.setAttribute('aPh', new THREE.InstancedBufferAttribute(ph, 1));
  geo.setAttribute('aH', new THREE.InstancedBufferAttribute(hh, 1));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  geo.computeBoundingSphere();
  // Instanced meshes are culled by geometry bounds: cover the whole bed.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.4, 0), S * 0.75);
  return { mesh, update(t, wind) { U.uT.value = t; U.uWind.value = wind; } };
}

// ---------- neon spill (spire) ----------

function spillTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Additive coloured light pools on the ground under neon signs. points: [{x, z, color, r}] */
export function buildSpill(points) {
  if (!points.length) return null;
  const geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ map: spillTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const mesh = new THREE.InstancedMesh(geo, mat, points.length);
  const m4 = new THREE.Matrix4(), c = new THREE.Color();
  points.forEach((p, i) => {
    m4.makeScale(p.r * 2, 1, p.r * 2); m4.setPosition(p.x, 0.05, p.z);
    mesh.setMatrixAt(i, m4);
    mesh.setColorAt(i, c.set(p.color).multiplyScalar(0.55));
  });
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  return mesh;
}

// ---------- offshore set dressing per stage ----------

/**
 * Extra scenery around the island for a stage. Returns { group, update(t) } or null.
 * rig: oil platforms (legs, decks, derricks) with burning flare stacks.
 * spire: drowned towers with lit windows and rooftop beacons.
 * kelp: tall kelp forests and reef rocks offshore.
 */
export function buildStageScenery(look, S, seed, fields) {
  const key = look.key;
  if (key !== 'rig' && key !== 'spire' && key !== 'kelp') return null;
  const r = rng((seed ^ 0x51a6e) >>> 0);
  const b = new GeoBuilder(), gb = new GeoBuilder();
  const half = S / 2;
  const group = new THREE.Group();
  const flames = [];
  const spots = [];
  const around = (minOut, maxOut) => {
    for (let tries = 0; tries < 40; tries++) {
      const side = (r() * 4) | 0, along = (r() - 0.5) * (S + 20);
      const out = half + minOut + r() * (maxOut - minOut);
      const x = side === 0 ? out : side === 1 ? -out : along, z = side === 2 ? out : side === 3 ? -out : along;
      if (spots.every(([a, c]) => Math.hypot(a - x, c - z) > 9)) { spots.push([x, z]); return [x, z]; }
    }
    return null;
  };
  if (key === 'rig') {
    for (let i = 0; i < 5; i++) {
      const at = around(8, 20); if (!at) continue;
      const [x, z] = at;
      const m = new THREE.Matrix4().makeRotationY(r() * 6).setPosition(x, -0.4, z);
      b.setParent(m); gb.setParent(m);
      const W = 4 + r() * 2.5, D = 3.5 + r() * 2, H = 2.2 + r() * 1.2;
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        b.cyl(0.28, H + 0.6, 8, sx * W * 0.4, H / 2 - 0.3, sz * D * 0.4, P.rust2);
        b.cyl(0.32, 0.25, 8, sx * W * 0.4, 0.15, sz * D * 0.4, P.bone);
      }
      for (const yy of [H * 0.45]) {
        b.box(W * 0.8, 0.12, 0.12, 0, yy, -D * 0.4, P.rust, 0, 0, 0.0);
        b.box(W * 0.8, 0.12, 0.12, 0, yy, D * 0.4, P.rust);
        b.box(0.12, 0.12, D * 0.8, -W * 0.4, yy, 0, P.rust);
        b.box(0.12, 0.12, D * 0.8, W * 0.4, yy, 0, P.rust);
      }
      b.box(W, 0.35, D, 0, H, 0, P.steelDark); // main deck
      b.box(W * 1.02, 0.08, D * 1.02, 0, H + 0.2, 0, P.rust2);
      b.box(W * 0.35, 0.9, D * 0.4, -W * 0.25, H + 0.6, -D * 0.2, P.bone); // accommodation block
      b.box(W * 0.36, 0.22, D * 0.41, -W * 0.25, H + 0.75, -D * 0.2, P.window);
      if (r() < 0.6) gb.box(W * 0.2, 0.12, D * 0.42, -W * 0.25, H + 0.75, -D * 0.2, 0xffc890);
      // derrick: tapered lattice tower
      const dx = W * 0.22, dz = D * 0.15, DH = 3.2 + r() * 1.6;
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.cyl(0.05, DH, 4, dx + sx * 0.32, H + DH / 2, dz + sz * 0.32, P.rust, 0, sz * 0.09, -sx * 0.09);
      for (let yy = H + 0.6; yy < H + DH - 0.3; yy += 0.7) { const k = 0.6 - (yy - H) / DH * 0.4; b.box(k * 1.1, 0.04, 0.04, dx, yy, dz - k * 0.5, P.rust); b.box(k * 1.1, 0.04, 0.04, dx, yy, dz + k * 0.5, P.rust); }
      b.box(0.24, 0.24, 0.24, dx, H + DH, dz, P.steelDark);
      // crane arm
      b.box(0.14, 0.14, D * 0.9, W * 0.4, H + 1.2, 0, P.rust, 0.3, -0.25);
      // flare boom + stack
      const fx = -W * 0.5 - 1.6;
      b.box(2.2, 0.08, 0.08, -W * 0.5 - 0.8, H + 0.9, D * 0.3, P.steel, 0, 0, -0.35);
      b.cyl(0.08, 0.6, 6, fx, H + 1.5, D * 0.3, P.steelDark);
      const p = new THREE.Vector3(fx, H + 1.85, D * 0.3).applyMatrix4(m);
      flames.push(p);
    }
  } else if (key === 'spire') {
    for (let i = 0; i < 9; i++) {
      const at = around(9, 24); if (!at) continue;
      const [x, z] = at;
      const m = new THREE.Matrix4().makeRotationY(r() * 0.4).setPosition(x, -0.6, z);
      b.setParent(m); gb.setParent(m);
      const w = 2.2 + r() * 2.2, d = 2.2 + r() * 2, h = 2.6 + r() * 3.6;
      const c = r() < 0.5 ? 0x5c6070 : 0x6a6878;
      b.box(w, h, d, 0, h / 2, 0, c);
      b.box(w * 0.7, 1.2, d * 0.7, 0, h + 0.6, 0, c);
      for (let fy = 0.9; fy < h - 0.3; fy += 0.62) {
        for (let fx = -w / 2 + 0.35; fx < w / 2 - 0.2; fx += 0.42) {
          const lit = hash(i * 977 + fy * 31 + fx * 7) < 0.22;
          const wc = lit ? [0xffd9a0, 0xff6fb8, 0xb08cff, 0xa8ff7a][(hash(fx * 13 + fy) * 4) | 0] : 0x161a26;
          (lit ? gb : b).box(0.2, 0.3, d + 0.02, fx, fy, 0, wc);
          (lit && hash(fy + fx) < 0.5 ? gb : b).box(w + 0.02, 0.3, 0.2, 0, fy, fx * (d / w), lit ? wc : 0x161a26);
        }
      }
      // rooftop beacon + neon band
      gb.box(0.14, 0.14, 0.14, 0, h + 1.3, 0, 0xff3b5c);
      if (r() < 0.6) gb.box(w + 0.04, 0.12, d + 0.04, 0, h - 0.4 - r() * 2, 0, [0xff4fa0, 0xa05bff, 0x9cff4a][(r() * 3) | 0]);
    }
  } else if (key === 'kelp') {
    for (let i = 0; i < 26; i++) {
      const at = around(1.5, 16); if (!at) continue;
      const [x, z] = at;
      const m = new THREE.Matrix4().makeTranslation(x, -0.5, z);
      b.setParent(m);
      if (r() < 0.35) { b.ico(0.8 + r() * 1.2, 0, -0.1, 0, r() < 0.5 ? 0x6f6a5a : 0x7d7562, 1.4, 0.6, 1.1, r() * 6); continue; }
      const n = 4 + ((r() * 5) | 0);
      for (let j = 0; j < n; j++) {
        const h = 1.4 + r() * 2.4, ox = (r() - 0.5) * 1.6, oz = (r() - 0.5) * 1.6;
        b.cone(0.09, 0.2, h, 4, ox, h / 2, oz, r() < 0.5 ? P.kelp : 0x56804a, r() * 6, (r() - 0.5) * 0.4, (r() - 0.5) * 0.4);
      }
    }
  }
  b.setParent(null); gb.setParent(null);
  if (!b.empty) {
    const mat = patchWorld(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), fields, 'stage-scenery');
    group.add(new THREE.Mesh(b.build({ stain: true }), mat));
  }
  if (!gb.empty) group.add(new THREE.Mesh(gb.build({ ao: false }), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false })));
  // rig flare flames: additive flickering cones + a glow sprite
  const flameMeshes = [];
  if (flames.length) {
    const fg = new THREE.ConeGeometry(0.28, 1.2, 8, 1, true); fg.translate(0, 0.6, 0);
    const fm = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff8a3a).multiplyScalar(2.2), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const cg = new THREE.ConeGeometry(0.14, 0.7, 8, 1, true); cg.translate(0, 0.35, 0);
    const cm = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe6a0).multiplyScalar(2.5), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    for (const p of flames) {
      const o = new THREE.Mesh(fg, fm), c = new THREE.Mesh(cg, cm);
      o.position.copy(p); c.position.copy(p);
      o.renderOrder = c.renderOrder = 6;
      group.add(o, c);
      flameMeshes.push({ o, c, ph: r() * 6 });
    }
  }
  return {
    group,
    update(t, wind = 0) {
      for (const f of flameMeshes) {
        const k = 0.8 + 0.25 * Math.sin(t * 9 + f.ph) + 0.12 * Math.sin(t * 23 + f.ph * 2);
        f.o.scale.set(1 + 0.1 * Math.sin(t * 13 + f.ph), k, 1); f.c.scale.set(1, k * 0.9, 1);
        f.o.rotation.z = f.c.rotation.z = -0.25 - wind * 0.4 + Math.sin(t * 3 + f.ph) * 0.08;
      }
    },
  };
}
