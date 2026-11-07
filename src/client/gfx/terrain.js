// Ground: one InstancedMesh of tile slabs with procedural surface detail
// (sand ripples, cracked concrete, boardwalk planks, tiled floors), subtle grid
// lines, wet-sand halo near water and hazard stripes for next-tide tiles.

import * as THREE from 'three';
import { P } from './palette.js';
import { patchWorld, WATER_Y } from './fields.js';
import { hash, rng } from './util.js';

export const T_SAND = 0, T_CONCRETE = 1, T_BOARD = 2, T_FLOOR = 3, T_DECK = 4, T_SHALLOW = 5;
// shallow-water tiles (map.terrain == 2) sit below the waterline so the water plane covers them
const TOP = [0, 0.025, 0.06, 0.035, 0.03, -0.13];

/** Classify each tile into a surface type, deterministic per map. look: stage look (deck plating on the rig). */
export function classifyTiles(map, seed, look = null) {
  const S = map.size, cover = map.cover;
  const type = new Uint8Array(S * S);
  const dir = new Uint8Array(S * S);
  const r = rng(seed ^ 0x5eed);
  // Low-frequency noise for sand vs concrete districts.
  const g = 6, gw = Math.ceil(S / g) + 2;
  const grid = Array.from({ length: gw * gw }, () => r());
  const noise = (x, y) => {
    const fx = x / g, fy = y / g, ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = grid[iy * gw + ix], b = grid[iy * gw + ix + 1], c = grid[(iy + 1) * gw + ix], d = grid[(iy + 1) * gw + ix + 1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  const hitWall = (x, y, dx, dy) => {
    for (let i = 1; i <= 6; i++) {
      const nx = x + dx * i, ny = y + dy * i;
      if (nx < 0 || ny < 0 || nx >= S || ny >= S) return false;
      if (cover[ny * S + nx] === 2) return true;
    }
    return false;
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const k = y * S + x;
    const edge = Math.min(x, y, S - 1 - x, S - 1 - y);
    const n = noise(x, y) + (hash(k) - 0.5) * 0.12;
    let t = n > 0.5 ? T_CONCRETE : T_SAND;
    if (edge < 2) t = T_SAND;
    if (hitWall(x, y, 1, 0) && hitWall(x, y, -1, 0) && hitWall(x, y, 0, 1) && hitWall(x, y, 0, -1)) t = T_FLOOR;
    if (look && look.deck && t === T_CONCRETE) t = T_DECK;
    type[k] = t;
  }
  const terr = map.terrain;
  // Boardwalk lanes: a few straight runs across sand.
  const lanes = 3 + Math.floor(r() * 2);
  for (let i = 0; i < lanes; i++) {
    const horiz = r() < 0.5;
    const c = 3 + Math.floor(r() * (S - 6));
    const a = Math.floor(r() * S * 0.4), b = a + Math.floor(S * 0.4 + r() * S * 0.5);
    const w = r() < 0.5 ? 1 : 2;
    for (let s = a; s < Math.min(S, b); s++) for (let o = 0; o < w; o++) {
      const x = horiz ? s : c + o, y = horiz ? c + o : s;
      if (x >= S || y >= S) continue;
      const k = y * S + x;
      if (type[k] === T_FLOOR || (terr && terr[k] === 2)) continue;
      type[k] = T_BOARD;
      dir[k] = horiz ? 0 : 1;
    }
  }
  if (terr) for (let k = 0; k < S * S; k++) if (terr[k] === 2 && !cover[k]) type[k] = T_SHALLOW;
  return { type, dir };
}

export function tileTop(type) { return TOP[type]; }

export function buildTerrain(map, fields, cls, wx, wz, look = null) {
  const S = map.size, n = S * S;
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(1, 0.6, 1);
  geo.translate(0, -0.3, 0);
  const aType = new Float32Array(n);
  const mat = patchWorld(new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 }), fields, 'ground', {
    vertDecl: 'attribute float aType;\nvarying float vType;\nvarying float vNY;\n',
    vert: 'vType = aType; vNY = normal.y;\n',
    fragDecl: 'varying float vType;\nvarying float vNY;\n',
    colorFrag: GROUND_FRAG,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const m4 = new THREE.Matrix4(), col = new THREE.Color();
  const G = look?.ground || {};
  const base = {
    [T_SAND]: G.sand ?? P.sand, [T_CONCRETE]: G.concrete ?? P.concrete, [T_BOARD]: G.board ?? P.board,
    [T_FLOOR]: G.floor ?? P.tileFloor, [T_DECK]: G.deck ?? 0x6f6d66, [T_SHALLOW]: G.seabed ?? 0xa89a74,
  };
  const kelpCol = new THREE.Color(G.kelp ?? 0x6f7f4e);
  const terr = map.terrain;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const k = y * S + x, t = cls.type[k];
    m4.makeTranslation(wx(x), TOP[t], wz(y));
    mesh.setMatrixAt(k, m4);
    col.set(base[t]);
    if (terr && terr[k] === 1) col.lerp(kelpCol, 0.6); // kelp bed: dark mossy ground under the fronds
    const j = (hash(k * 3 + 1) - 0.5);
    col.offsetHSL(j * 0.012, j * 0.04, j * 0.05);
    mesh.setColorAt(k, col);
    aType[k] = t + cls.dir[k] * 10;
  }
  geo.setAttribute('aType', new THREE.InstancedBufferAttribute(aType, 1));
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  group.add(mesh);

  // Island skirt: rough rock under the tiles so the map edge reads as a cliff into the sea.
  const skirtMat = patchWorld(new THREE.MeshStandardMaterial({ color: P.cliff, roughness: 1, flatShading: true }), fields, 'skirt');
  const skirtGeo = new THREE.BoxGeometry(S + 0.6, 2.4, S + 0.6, 24, 3, 24);
  const pa = skirtGeo.attributes.position;
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
    if (y < 1.1) {
      const h = hash(Math.round(x * 7) * 131 + Math.round(z * 7) * 17 + Math.round(y * 3));
      pa.setX(i, x * (1 + (1.2 - y) * 0.035) + (h - 0.5) * 0.35);
      pa.setZ(i, z * (1 + (1.2 - y) * 0.035) + (hash(i) - 0.5) * 0.35);
    }
  }
  skirtGeo.computeVertexNormals();
  const skirt = new THREE.Mesh(skirtGeo, skirtMat);
  skirt.position.y = -0.6 - 1.2 + 0.02;
  skirt.receiveShadow = true;
  group.add(skirt);

  // Sea floor.
  const bed = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshBasicMaterial({ color: P.seabed }));
  bed.rotation.x = -Math.PI / 2;
  bed.position.y = -2.6;
  group.add(bed);
  return { group, mesh, mat };
}

const GROUND_FRAG = /* glsl */`
{
  float ty = mod(vType, 10.0);
  float dirv = floor(vType / 10.0 + 0.01);
  vec2 p = vWPos.xz;
  vec2 f = fract(p + uGridOff);
  vec3 c = diffuseColor.rgb;
  float top = step(0.5, vNY);
  float n1 = vnoise(p * 3.1);
  float n2 = vnoise(p * 11.0);
  if (ty < 0.5) {
    // sand: ripples + speckle
    float rip = sin(p.x * 7.0 + p.y * 3.0 + n1 * 5.0) * 0.5 + 0.5;
    c *= 0.93 + rip * 0.07 + (hash21(floor(p * 18.0)) - 0.5) * 0.08;
  } else if (ty < 1.5) {
    // cracked concrete slabs
    vec2 sl = fract(p * 1.0 + uGridOff + 0.5);
    float seam = 1.0 - smoothstep(0.0, 0.02, min(min(sl.x, 1.0 - sl.x), min(sl.y, 1.0 - sl.y)));
    float crack = 1.0 - smoothstep(0.0, 0.018, abs(vnoise(p * 1.7) - 0.5));
    crack *= smoothstep(0.55, 0.7, vnoise(p * 0.6 + 7.0));
    c *= (0.9 + n1 * 0.14 + (n2 - 0.5) * 0.06) * (1.0 - seam * 0.22 - crack * 0.12);
    c = mix(c, c * vec3(0.86, 0.95, 0.88), smoothstep(0.62, 0.85, vnoise(p * 0.7 + 3.0)) * 0.4);
  } else if (ty < 2.5) {
    // boardwalk planks
    float along = dirv > 0.5 ? p.x : p.y;
    float across = dirv > 0.5 ? p.y : p.x;
    float pl = along * 5.0;
    float id = floor(pl);
    float gap = 1.0 - smoothstep(0.0, 0.07, min(fract(pl), 1.0 - fract(pl)));
    float pj = hash21(vec2(id, floor(across * 0.7 + hash21(vec2(id, 3.0)))));
    c *= (0.82 + pj * 0.3) * (1.0 - gap * 0.6);
    c *= 0.95 + sin(across * 40.0 + pj * 20.0) * 0.03 * top;
  } else if (ty > 4.5) {
    // shallow-water seabed: soft ripples, pebbles
    float rip = sin(p.x * 5.0 - p.y * 4.0 + n1 * 6.0 + uTime * 0.6) * 0.5 + 0.5;
    c *= 0.86 + rip * 0.1 + (hash21(floor(p * 14.0)) - 0.5) * 0.1;
  } else if (ty > 3.5) {
    // rig deck plating: 1-tile plates, diamond tread, rivets, rust bleed
    vec2 sl = fract(p + uGridOff + 0.5);
    float seam = 1.0 - smoothstep(0.0, 0.03, min(min(sl.x, 1.0 - sl.x), min(sl.y, 1.0 - sl.y)));
    vec2 dq = fract(vec2(p.x + p.y, p.x - p.y) * 4.0);
    float tread = smoothstep(0.35, 0.5, min(abs(dq.x - 0.5), abs(dq.y - 0.5)) * 2.0);
    vec2 rv = fract(sl * 4.0);
    float rivet = (1.0 - smoothstep(0.05, 0.1, length(rv - 0.5))) * step(0.85, max(abs(sl.x - 0.5), abs(sl.y - 0.5)) * 2.0);
    float rust = smoothstep(0.55, 0.8, vnoise(p * 1.3 + 11.0)) * 0.6 + smoothstep(0.7, 0.9, n2) * 0.3;
    c *= (0.92 + tread * 0.08 + (n1 - 0.5) * 0.08) * (1.0 - seam * 0.35) * (1.0 + rivet * 0.25);
    c = mix(c, vec3(0.42, 0.2, 0.1), rust * 0.55);
  } else {
    // tiled floor
    vec2 tf = fract(p * 3.0 + uGridOff * 3.0);
    float seam = 1.0 - smoothstep(0.0, 0.05, min(min(tf.x, 1.0 - tf.x), min(tf.y, 1.0 - tf.y)));
    float tj = hash21(floor(p * 3.0 + uGridOff * 3.0));
    c *= (0.88 + tj * 0.16) * (1.0 - seam * 0.22);
    c *= 1.0 - step(0.86, tj) * 0.18;
  }
  // grid lines on top faces
  float e = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
  float grid = (1.0 - smoothstep(0.0, 0.03, e)) * top;
  c *= 1.0 - grid * 0.22;
  // sides are darker earth
  c = mix(c * vec3(0.55, 0.5, 0.45), c, top);
  // wet halo near water + algae
  float sd = tideSD(p);
  float wet = smoothstep(-1.4, -0.05, sd);
  c = mix(c, c * vec3(0.55, 0.62, 0.6), wet * 0.75);
  // next-tide warning: diagonal hazard stripes + darkened wet look
  vec2 fuv = (p - uMapMin) / uMapExt;
  float warn = texture2D(uFogTex, fuv).g;
  float wr = smoothstep(0.42, 0.58, warn);
  float stripe = step(0.5, fract((p.x + p.y) * 1.6 - uTime * 0.25));
  c = mix(c, c * vec3(0.72, 0.86, 0.9), wr * 0.55);
  c = mix(c, vec3(0.75, 0.83, 0.82), wr * stripe * 0.14 * top);
  // tide mark line at the inner edge of the warning band
  float wl = 1.0 - smoothstep(0.0, 1.6, abs(warn - 0.5) / max(fwidth(warn), 1e-4));
  c = mix(c, vec3(0.85, 0.95, 0.93), wl * 0.7 * top * step(0.01, warn));
  diffuseColor.rgb = c;
}
`;
void WATER_Y;
