// 3.0 cosmetic effects: kill effects (played on the victim when the cosmetic's
// owner gets the kill) and drop-in arrivals (match start). Everything rides
// on a Fx instance (particles, rings, lights, timed tweens) plus a few pooled
// meshes, so the same code drives the match renderer and the shop previews.
//
// Kill effects ('default' = none): tidal, bubbles, sonar, ember, kelp, firework,
//   pixel, coins, glitch, shatter, sharks, skull, lightning, ink, anchor, maelstrom.
// Drop-ins: default (transport hop), parachute, zipline, boat, jetski, grapple,
//   cannon, breach, jetpack, whirlpool, orbital, gulls, meteor.
// Tracers (5.0): CosmeticFx.tracer(id, a, b, squadHex, width) — the outer beam
//   always keeps the squad colour; the cosmetic adds a core slug and a trail.
// Streak skins (5.0): buildStreakModel(kind, skinId) and streakLook(skinId).

import * as THREE from 'three';
import { GeoBuilder, clamp, easeOutCubic, easeInOutCubic, lerp } from './util.js';
import { P } from './palette.js';
import { gullGeometry } from './ambient.js';
import { makeChute } from './pickups.js';
import { propMaterial } from './weapons.js';
import { WT } from './camos.js';

let A = null;
function assets() {
  if (A) return A;
  const shared = (o) => { o.userData.shared = true; return o; };
  const coinGeo = shared(new THREE.CylinderGeometry(0.11, 0.11, 0.03, 14));
  const coinMat = shared(new THREE.MeshStandardMaterial({ color: 0xffcf4a, emissive: 0xa86a00, emissiveIntensity: 1.1, metalness: 0.6, roughness: 0.3 }));
  const voxGeo = shared(new THREE.BoxGeometry(0.07, 0.07, 0.07));
  const voxMat = shared(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  const glowMat = (c, op = 0.8) => shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(2), transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
  const beamGeo = shared(new THREE.CylinderGeometry(1, 1, 1, 20, 1, true)); beamGeo.translate(0, 0.5, 0);
  const colGeo = shared(new THREE.CylinderGeometry(0.32, 0.5, 1, 14, 4, true)); colGeo.translate(0, 0.5, 0);
  const frond = new GeoBuilder();
  for (let i = 0; i < 6; i++) {
    const y = i / 6, w = 0.11 * (1 - y * 0.7);
    frond.box(w, 0.18, 0.02, Math.sin(y * 3) * 0.06, y * 1.0 + 0.09, 0, new THREE.Color(0x2f6a3a).lerp(new THREE.Color(0x9fd36b), y).getHex(), 0, 0, Math.sin(y * 4) * 0.2);
  }
  const frondGeo = shared(frond.build({ ao: false }));
  const plantMat = shared(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }));
  // ink tentacle: a curling tube
  const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.05, 0.4, 0), new THREE.Vector3(-0.08, 0.8, 0.05), new THREE.Vector3(-0.3, 1.05, 0.1), new THREE.Vector3(-0.42, 0.9, 0.12)]);
  const tentGeo = new THREE.TubeGeometry(curve, 20, 0.05, 6, false);
  { // taper toward the tip
    const p = tentGeo.attributes.position, n = 21, ring = 7;
    for (let i = 0; i < p.count; i++) {
      const seg = Math.floor(i / ring), t = seg / (n - 1), c = curve.getPointAt(Math.min(1, t));
      const k = 1 - t * 0.8;
      p.setXYZ(i, c.x + (p.getX(i) - c.x) * k, c.y + (p.getY(i) - c.y) * k, c.z + (p.getZ(i) - c.z) * k);
    }
    tentGeo.computeVertexNormals();
  }
  shared(tentGeo);
  const inkMat = shared(new THREE.MeshStandardMaterial({ color: 0x1e1828, roughness: 0.35, metalness: 0.1, emissive: 0x2a1640, emissiveIntensity: 0.6 }));
  // dinghy
  const bt = new GeoBuilder();
  bt.box(0.62, 0.16, 1.15, 0, 0.08, 0, 0x3e5f7d);
  bt.box(0.66, 0.06, 1.19, 0, 0.17, 0, P.bone);
  bt.cone(0.31, 0.0, 0.42, 4, 0, 0.1, 0.78, 0x3e5f7d, Math.PI / 4, Math.PI / 2);
  bt.box(0.5, 0.04, 0.9, 0, 0.12, -0.02, 0x2a3c4e);
  bt.box(0.16, 0.2, 0.16, 0, 0.2, -0.56, 0x2a2e31); // outboard
  bt.box(0.06, 0.3, 0.06, 0, 0.0, -0.62, 0x2a2e31);
  const boatGeo = shared(bt.build({ ao: false }));
  // gunship
  const gs = new GeoBuilder();
  gs.box(0.9, 0.55, 2.2, 0, 0, 0, 0x3a4246);
  gs.box(0.7, 0.35, 0.7, 0, -0.05, 1.3, 0x3a4246);
  gs.box(0.72, 0.2, 0.5, 0, 0.12, 1.4, 0x1a2328); // canopy
  gs.box(0.3, 0.3, 1.6, 0, 0.1, -1.7, 0x353b3e);
  gs.box(0.06, 0.6, 0.4, 0, 0.4, -2.4, 0xa4452c);
  gs.box(3.0, 0.06, 0.4, 0, 0.4, 0.1, 0x2a3034); // stub wings / rotor mast
  gs.cyl(0.18, 0.4, 8, 1.4, 0.2, 0.1, 0x2a3034); gs.cyl(0.18, 0.4, 8, -1.4, 0.2, 0.1, 0x2a3034);
  gs.box(0.9, 0.04, 0.12, 0, -0.29, 0.4, 0xa4452c);
  const shipGeo = shared(gs.build({ ao: false }));
  const rotorGeo = shared(new THREE.CircleGeometry(0.9, 24)); rotorGeo.rotateX(-Math.PI / 2);
  const rotorMat = shared(new THREE.MeshBasicMaterial({ color: 0x1a1e20, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
  const vcMat = shared(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2 }));
  const ropeGeo = shared(new THREE.CylinderGeometry(0.015, 0.015, 1, 4)); ropeGeo.translate(0, -0.5, 0);
  const ropeMat = shared(new THREE.MeshBasicMaterial({ color: 0x1a1a18 }));
  const gullGeo = shared(gullGeometry());
  const gullMat = shared(new THREE.MeshLambertMaterial({ vertexColors: true }));
  // anchor
  const an = new GeoBuilder();
  an.box(0.16, 1.6, 0.16, 0, 0.95, 0, 0x2f3538); // shank
  an.box(1.0, 0.12, 0.12, 0, 1.55, 0, 0x6b4a2c); // stock (wood)
  an.cyl(0.18, 0.08, 12, 0, 1.92, 0, 0x2f3538, 0, Math.PI / 2);
  for (let i = 0; i <= 8; i++) { const a = Math.PI * (i / 8); an.box(0.16, 0.16, 0.16, Math.cos(a) * 0.62, 0.62 - Math.sin(a) * 0.55, 0, 0x2f3538, 0, 0, a); }
  an.cone(0.2, 0, 0.36, 4, 0.66, 0.78, 0, 0x2f3538, 0, 0, -0.5); an.cone(0.2, 0, 0.36, 4, -0.66, 0.78, 0, 0x2f3538, 0, 0, 0.5);
  an.cone(0.14, 0, 0.3, 4, 0, -0.02, 0, 0x2f3538, 0, Math.PI);
  for (let i = 0; i < 6; i++) an.box(0.05, 0.14, 0.05, 0.12 * Math.sin(i), 2.05 + i * 0.12, 0.06 * Math.cos(i), 0xc8b070); // rope
  const anchorGeo = shared(an.build({ ao: false }));
  // skull (smoke-white, faded by opacity)
  const sk = new GeoBuilder();
  sk.sphere(0.5, 0, 0.5, 0, 0xffffff, 1, 0.92, 0.95, 10, 8);
  sk.box(0.62, 0.3, 0.5, 0, 0.12, 0.08, 0xffffff);
  for (let i = 0; i < 5; i++) sk.box(0.08, 0.12, 0.05, -0.2 + i * 0.1, -0.05, 0.33, 0xffffff);
  sk.sphere(0.13, -0.18, 0.48, 0.42, 0x111111, 1, 1.1, 0.5); sk.sphere(0.13, 0.18, 0.48, 0.42, 0x111111, 1, 1.1, 0.5);
  sk.cone(0.07, 0, 0.12, 3, 0, 0.3, 0.45, 0x111111, 0, -0.3);
  const skullGeo = shared(sk.build({ ao: false }));
  const skullMat = shared(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false }));
  // shark fin
  const fs = new THREE.Shape(); fs.moveTo(-0.22, 0); fs.quadraticCurveTo(0.0, 0.1, 0.12, 0.48); fs.quadraticCurveTo(0.1, 0.18, 0.22, 0); fs.closePath();
  const finGeo = shared(new THREE.ExtrudeGeometry(fs, { depth: 0.04, bevelEnabled: false })); finGeo.translate(0, 0, -0.02); finGeo.rotateY(Math.PI / 2);
  const finMat = shared(new THREE.MeshStandardMaterial({ color: 0x4f5d68, roughness: 0.5 }));
  // ice shard / pixel cube / meteor
  const shardGeo = shared(new THREE.TetrahedronGeometry(0.09, 0));
  const iceMat = shared(new THREE.MeshStandardMaterial({ color: 0xcfeeff, emissive: 0x4a9aff, emissiveIntensity: 0.6, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.85 }));
  const pixGeo = shared(new THREE.BoxGeometry(0.12, 0.12, 0.12));
  const pixMat = shared(new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  const rockGeo = shared(new THREE.IcosahedronGeometry(0.42, 1));
  const rockMat = shared(new THREE.MeshStandardMaterial({ color: 0x3a2a22, emissive: 0xff5a1a, emissiveIntensity: 1.4, roughness: 0.9 }));
  // vortex disc (swirl shader)
  const vortexGeo = shared(new THREE.CircleGeometry(1, 48)); vortexGeo.rotateX(-Math.PI / 2);
  const vortexMat = shared(new THREE.ShaderMaterial({
    uniforms: { uT: { value: 0 }, uA: { value: 1 }, uC1: { value: new THREE.Color(0xb46aff) }, uC2: { value: new THREE.Color(0x6ad0ff) } },
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform float uT, uA; uniform vec3 uC1, uC2; varying vec2 vP;
      void main(){ float r = length(vP); float a = atan(vP.y, vP.x);
        float sw = sin(a * 4.0 + r * 14.0 - uT * 9.0);
        float k = smoothstep(0.2, 1.0, sw) * smoothstep(1.0, 0.3, r) * smoothstep(0.0, 0.15, r);
        float core = smoothstep(0.35, 0.0, r);
        gl_FragColor = vec4(mix(uC1, uC2, r) * 1.8 * (k + core * 0.8), (k * 0.8 + core * 0.9) * uA); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  }));
  // jet ski, jetpack, zipline trolley
  const js = new GeoBuilder();
  js.box(0.42, 0.16, 0.95, 0, 0.08, 0, 0xff4a3a); js.box(0.44, 0.06, 0.97, 0, 0.18, 0, 0xf4f2ea);
  js.cone(0.21, 0, 0.3, 4, 0, 0.1, 0.62, 0xff4a3a, Math.PI / 4, Math.PI / 2);
  js.box(0.24, 0.12, 0.4, 0, 0.27, -0.1, 0x22272a); js.box(0.5, 0.04, 0.04, 0, 0.42, 0.18, 0x22272a); js.box(0.04, 0.16, 0.04, 0, 0.34, 0.18, 0x22272a);
  const jetskiGeo = shared(js.build({ ao: false }));
  const jp = new GeoBuilder();
  jp.box(0.26, 0.26, 0.1, 0, 0.0, 0, 0x4a5258); jp.cyl(0.06, 0.3, 8, -0.1, -0.02, -0.06, 0x6a7278); jp.cyl(0.06, 0.3, 8, 0.1, -0.02, -0.06, 0x6a7278);
  jp.cone(0.07, 0.6, 0.08, 8, -0.1, -0.2, -0.06, 0x2a2e31); jp.cone(0.07, 0.6, 0.08, 8, 0.1, -0.2, -0.06, 0x2a2e31);
  const jetpackGeo = shared(jp.build({ ao: false }));
  const cableGeo = shared(new THREE.CylinderGeometry(0.012, 0.012, 1, 4)); cableGeo.rotateX(Math.PI / 2); cableGeo.translate(0, 0, 0.5);
  A = {
    anchorGeo, skullGeo, skullMat, finGeo, finMat, shardGeo, iceMat, pixGeo, pixMat, rockGeo, rockMat, vortexGeo, vortexMat, jetskiGeo, jetpackGeo, cableGeo,
    coinGeo, coinMat, voxGeo, voxMat, beamGeo, colGeo, frondGeo, plantMat, tentGeo, inkMat, boatGeo, shipGeo, rotorGeo, rotorMat, vcMat, ropeGeo, ropeMat, gullGeo, gullMat,
    waterMat: glowMat(0x2f9fa8, 0.35), beamMat: glowMat(0xd8d0ff, 0.6), boltMat: glowMat(0xdfe6ff, 1),
  };
  for (const k of ['waterMat', 'beamMat', 'boltMat']) A[k].userData.shared = true;
  return A;
}

const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _col = new THREE.Color();

// Tracer cosmetics: core colour (HDR rgb for additive particles), trail style, density per unit length.
export const TRACER = {
  ember: { core: [5, 2.6, 0.8], trail: 'sparks', dens: 6, hex: 0xffb060 },
  emerald: { core: [0.8, 4.5, 1.6], trail: 'glitter', dens: 8, hex: 0x6aff9a },
  violet: { core: [2.6, 1.0, 4.8], trail: 'core', dens: 5, hex: 0xb46aff },
  ice: { core: [2.4, 3.6, 5], trail: 'frost', dens: 7, hex: 0xbfe6ff },
  crimson: { core: [5, 0.6, 0.6], trail: 'smoke', dens: 5, smoke: [0.35, 0.08, 0.08], hex: 0xff3a3a },
  gold: { core: [5, 3.6, 1.0], trail: 'glitter', dens: 9, hex: 0xffd24a },
  tide: { core: [1.2, 3.6, 4.8], trail: 'helix', dens: 10, hex: 0x6ae0ff },
  plasma: { core: [3.4, 3.8, 6], trail: 'arc', dens: 12, hex: 0xc8d4ff },
  prism: { core: [4, 4, 4], trail: 'rainbow', dens: 10, hex: 0xffffff },
};
/** Display colour of a tracer cosmetic (falls back to the squad colour). */
export function tracerColor(id, squadHex) { return TRACER[id]?.hex ?? squadHex; }

function bolt(x, y0, z, x1, z1, segs = 10) {
  // zigzag ribbon of thin boxes from the sky to (x1,z1)
  const b = new GeoBuilder();
  let px = x, py = y0, pz = z;
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const nx = lerp(x, x1, t) + (i < segs ? (Math.random() - 0.5) * 0.9 * (1 - t * 0.6) : 0);
    const ny = lerp(y0, 0.2, t);
    const nz = lerp(z, z1, t) + (i < segs ? (Math.random() - 0.5) * 0.9 * (1 - t * 0.6) : 0);
    const dx = nx - px, dy = ny - py, dz = nz - pz, L = Math.hypot(dx, dy, dz);
    const yaw = Math.atan2(dx, dz), pitch = Math.atan2(Math.hypot(dx, dz), dy);
    b.box(0.07, L, 0.07, (px + nx) / 2, (py + ny) / 2, (pz + nz) / 2, 0xffffff, yaw, pitch);
    px = nx; py = ny; pz = nz;
  }
  return b.build({ ao: false });
}

export class CosmeticFx {
  /** fx: Fx instance; parent: group temporary meshes go in; hooks: { flash(k), shake(k) } */
  constructor(fx, parent, hooks = {}) {
    this.fx = fx; this.parent = parent; this.hooks = hooks;
    this.live = new Set();
  }

  _add(o) { this.parent.add(o); this.live.add(o); return o; }
  _drop(o) { if (o.parent) o.parent.remove(o); this.live.delete(o); if (o.userData.own) { o.geometry?.dispose(); } }
  clear() { for (const o of [...this.live]) this._drop(o); }

  // ---------- kill effects ----------

  /** Play kill effect `id` on a victim view. Returns its length in seconds (0 for none). */
  killEffect(id, view, opts = {}) {
    const fx = this.fx, a = assets();
    const p = view.root.position, x = p.x, y = p.y, z = p.z;
    const n = (k) => fx._n(k);
    switch (id) {
      case 'tidal': {
        const col = this._add(new THREE.Mesh(a.colGeo, a.waterMat.clone()));
        col.material.userData = {};
        col.position.set(x, y, z); col.scale.set(1, 0.01, 1); col.renderOrder = 7;
        fx.timed(1.3, (t) => {
          const up = t < 0.35 ? easeOutCubic(t / 0.35) : 1 - easeInOutCubic((t - 0.35) / 0.65);
          col.scale.set(1 + t * 0.6, Math.max(0.01, up * 2.4), 1 + t * 0.6);
          col.material.opacity = 0.45 * (1 - t);
          if (t >= 1) { col.material.dispose(); this._drop(col); }
        });
        for (let i = 0; i < n(46); i++) {
          const ang = Math.random() * 6.28, s = 0.4 + Math.random() * 1.4;
          fx.alpha.spawn(x + Math.cos(ang) * 0.15, y + 0.1 + Math.random() * 0.5, z + Math.sin(ang) * 0.15, Math.cos(ang) * s, 4 + Math.random() * 5, Math.sin(ang) * s, 0.8 + Math.random() * 0.5, 0.08, 0.05, 0.85, 0.96, 1, 0.9, 0.4, 9, 0.5, 1);
        }
        fx.splash(x, z, 1.6); fx.ring(x, y + 0.08, z, 0.3, 2.2, 0xcff4ee, 0.9, 1);
        return 1.3;
      }
      case 'ember': {
        for (let i = 0; i < n(80); i++) {
          const ang = Math.random() * 6.28, s = 1 + Math.random() * 3;
          fx.add.spawn(x, y + 0.5, z, Math.cos(ang) * s, 1.5 + Math.random() * 4, Math.sin(ang) * s, 0.8 + Math.random() * 0.9, 0.1, 0.03, 6, 2.2 + Math.random(), 0.4, 1, 1.4, 3, 1.2, 1);
        }
        for (let i = 0; i < n(18); i++) {
          const ang = (i / 18) * 6.28;
          fx.alpha.spawn(x + Math.cos(ang) * 0.3, y + 0.15, z + Math.sin(ang) * 0.3, Math.cos(ang) * 2.2, 0.3, Math.sin(ang) * 2.2, 1.1, 0.25, 0.7, 0.22, 0.2, 0.2, 0.7, 2.5, -0.2, 0, 1.2);
        }
        fx.add.spawn(x, y + 0.6, z, 0, 0, 0, 0.25, 0.5, 1.6, 5, 2.4, 0.8, 1, 0, 0, 0, 1.4);
        fx.flashLight(x, y + 1, z, 0xff7a2a, 22, 0.6, 6);
        fx.ring(x, y + 0.06, z, 0.2, 1.8, 0xff8a3a, 0.6, 1.2);
        return 1.2;
      }
      case 'kelp': {
        const fronds = [];
        for (let i = 0; i < 8; i++) {
          const m = this._add(new THREE.Mesh(a.frondGeo, a.plantMat));
          const ang = (i / 8) * 6.28 + Math.random() * 0.4, d = 0.25 + Math.random() * 0.3;
          m.position.set(x + Math.cos(ang) * d, y, z + Math.sin(ang) * d);
          m.rotation.y = -ang; m.scale.set(1.5, 0.01, 1.5); m.castShadow = true;
          fronds.push({ m, ang, ph: Math.random() * 6, h: 1.2 + Math.random() * 0.8 });
        }
        fx.timed(2.0, (t) => {
          const grow = t < 0.25 ? easeOutCubic(t / 0.25) : t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
          for (const f of fronds) {
            f.m.scale.set(1.5, Math.max(0.01, grow * f.h), 1.5);
            f.m.rotation.z = Math.sin(t * 9 + f.ph) * 0.25 + (t > 0.6 ? (t - 0.6) * 2.2 : 0);
          }
          if (t >= 1) for (const f of fronds) this._drop(f.m);
        });
        for (let i = 0; i < n(26); i++) fx.add.spawn(x + (Math.random() - 0.5), y + Math.random() * 0.8, z + (Math.random() - 0.5), 0, 0.6 + Math.random(), 0, 1.2 + Math.random(), 0.05, 0.02, 0.6, 2.4, 0.7, 1, 1, 0, 0.6, 1);
        fx.ring(x, y + 0.06, z, 0.2, 1.4, 0x6fae5a, 0.8, 1);
        return 2.0;
      }
      case 'coins': {
        const N = 22;
        const im = this._add(new THREE.InstancedMesh(a.coinGeo, a.coinMat, N));
        im.frustumCulled = false; im.castShadow = true;
        const st = [];
        for (let i = 0; i < N; i++) {
          const ang = Math.random() * 6.28, s = 0.6 + Math.random() * 1.6;
          st.push({ x, y: y + 0.6, z, vx: Math.cos(ang) * s, vy: 3.5 + Math.random() * 3, vz: Math.sin(ang) * s, rx: Math.random() * 6, rz: Math.random() * 6, w: 8 + Math.random() * 10 });
        }
        let last = 0;
        fx.timed(2.2, (t) => {
          const dt = Math.max(0, (t - last) * 2.2); last = t;
          for (let i = 0; i < N; i++) {
            const c = st[i];
            c.vy -= 11 * dt; c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
            if (c.y < y + 0.02) { c.y = y + 0.02; c.vy = Math.abs(c.vy) * 0.35; c.vx *= 0.6; c.vz *= 0.6; c.w *= 0.6; }
            c.rx += c.w * dt;
            const k = t > 0.8 ? 1 - (t - 0.8) / 0.2 : 1;
            _e.set(c.rx, 0, c.rz); _q.setFromEuler(_e);
            _m4.compose(_p.set(c.x, c.y, c.z), _q, _s.setScalar(Math.max(0.01, k)));
            im.setMatrixAt(i, _m4);
          }
          im.instanceMatrix.needsUpdate = true;
          if (Math.random() < 0.5) { const c = st[(Math.random() * N) | 0]; fx.add.spawn(c.x, c.y + 0.05, c.z, 0, 0.3, 0, 0.3, 0.12, 0.02, 4, 3.4, 1.2, 1, 0, 0, 0, 1.2); }
          if (t >= 1) { this._drop(im); im.dispose(); }
        });
        fx.add.spawn(x, y + 0.6, z, 0, 0, 0, 0.3, 0.4, 1.4, 4, 3.2, 1, 1, 0, 0, 0, 1.4);
        fx.flashLight(x, y + 1, z, 0xffd060, 16, 0.5, 5);
        return 2.2;
      }
      case 'glitch': {
        const N = 40;
        const im = this._add(new THREE.InstancedMesh(a.voxGeo, a.voxMat, N));
        im.frustumCulled = false; im.renderOrder = 8;
        const cols = [0xff4fd8, 0x6a7bff, 0xffffff, 0x9dffb0];
        const st = [];
        const col = new THREE.Color();
        for (let i = 0; i < N; i++) {
          st.push({ x: x + (Math.random() - 0.5) * 0.4, y: y + 0.1 + Math.random() * 0.9, z: z + (Math.random() - 0.5) * 0.4, vy: 0.4 + Math.random() * 1.2, d: Math.random() * 0.4, s: 0.6 + Math.random() * 0.9 });
          im.setColorAt(i, col.set(cols[i % cols.length]).multiplyScalar(1.5));
        }
        im.instanceColor.needsUpdate = true;
        view.flash = 1;
        fx.timed(1.4, (t) => {
          const on = t < 0.55;
          view.pose.visible = on ? Math.random() < 0.6 : false;
          view.pose.position.x = on ? (Math.random() - 0.5) * 0.08 : 0;
          for (let i = 0; i < N; i++) {
            const c = st[i], tt = clamp((t - c.d * 0.6) / 0.7, 0, 1);
            const k = tt > 0 ? (tt < 0.8 ? 1 : 1 - (tt - 0.8) / 0.2) : 0;
            _m4.compose(_p.set(c.x + Math.round(Math.sin(t * 40 + i) * 2) * 0.03, c.y + c.vy * tt, c.z), _q.identity(), _s.setScalar(Math.max(0.001, k * c.s)));
            im.setMatrixAt(i, _m4);
          }
          im.instanceMatrix.needsUpdate = true;
          if (t >= 1) { this._drop(im); im.dispose(); view.derezzed = true; }
        });
        fx.ring(x, y + 0.06, z, 0.2, 1.3, 0xff4fd8, 0.5, 1.2);
        fx.ring(x, y + 0.5, z, 0.1, 0.9, 0x6a7bff, 0.4, 1);
        return 1.4;
      }
      case 'lightning': {
        const geo = bolt(x + (Math.random() - 0.5) * 2, y + 14, z + (Math.random() - 0.5) * 2, x, z);
        const m = this._add(new THREE.Mesh(geo, a.boltMat));
        m.userData.own = true; m.renderOrder = 9; m.frustumCulled = false;
        fx.timed(0.75, (t) => { m.visible = t < 0.18 || (t > 0.28 && t < 0.45) || (t > 0.55 && t < 0.68); if (t >= 1) this._drop(m); });
        fx.flashLight(x, y + 2, z, 0xc8d4ff, 60, 0.5, 10);
        fx.sparks(x, y + 0.3, z, 30, 3, 3.6, 5, 7);
        fx.ring(x, y + 0.06, z, 0.2, 2.2, 0xdfe6ff, 0.5, 1.4);
        fx.scorch(x, z, 0.9);
        fx.shake = Math.min(1, fx.shake + 0.5);
        this.hooks.flash?.(0.9);
        view.flash = 1.5;
        return 0.9;
      }
      case 'ink': {
        const tents = [];
        for (let i = 0; i < 6; i++) {
          const m = this._add(new THREE.Mesh(a.tentGeo, a.inkMat));
          const ang = (i / 6) * 6.28 + Math.random() * 0.3;
          m.position.set(x + Math.cos(ang) * 0.5, y - 0.05, z + Math.sin(ang) * 0.5);
          m.rotation.y = -ang + Math.PI; m.scale.setScalar(0.01); m.castShadow = true;
          tents.push({ m, ph: Math.random() * 6, s: 0.8 + Math.random() * 0.5 });
        }
        fx.timed(1.9, (t) => {
          const k = t < 0.3 ? easeOutCubic(t / 0.3) : t > 0.65 ? 1 - easeInOutCubic((t - 0.65) / 0.35) : 1;
          for (const T of tents) { T.m.scale.set(T.s, Math.max(0.01, k * T.s * 1.2), T.s); T.m.rotation.x = Math.sin(t * 8 + T.ph) * 0.2; }
          if (t >= 1) for (const T of tents) this._drop(T.m);
        });
        for (let i = 0; i < n(26); i++) {
          const ang = Math.random() * 6.28, s = 0.3 + Math.random() * 1.0;
          fx.alpha.spawn(x + Math.cos(ang) * 0.3, y + 0.2 + Math.random() * 0.4, z + Math.sin(ang) * 0.3, Math.cos(ang) * s, 0.4 + Math.random() * 0.6, Math.sin(ang) * s, 1.6 + Math.random(), 0.3, 1.1, 0.09, 0.06, 0.13, 0.85, 1.5, -0.1, 0, 1.0);
        }
        fx.add.spawn(x, y + 0.5, z, 0, 0, 0, 0.4, 0.3, 1.2, 1.2, 0.5, 2.2, 1, 0, 0, 0, 1.4);
        return 1.9;
      }
      case 'bubbles': {
        for (let i = 0; i < n(60); i++) {
          const ang = Math.random() * 6.28, r = Math.random() * 0.35;
          fx.alpha.spawn(x + Math.cos(ang) * r, y + 0.1 + Math.random() * 0.6, z + Math.sin(ang) * r, (Math.random() - 0.5) * 0.4, 0.6 + Math.random() * 1.6, (Math.random() - 0.5) * 0.4, 1.2 + Math.random() * 0.9, 0.05 + Math.random() * 0.07, 0.1, 0.85, 0.96, 1, 0.75, 0.6, -0.8, 0, 0.6);
        }
        for (let i = 0; i < n(24); i++) fx.add.spawn(x + (Math.random() - 0.5) * 0.6, y + 0.2 + Math.random() * 0.8, z + (Math.random() - 0.5) * 0.6, 0, 0.8 + Math.random(), 0, 1 + Math.random() * 0.6, 0.05, 0.02, 1.2, 2.2, 2.6, 1, 0.5, -0.5, 0, 1);
        fx.ring(x, y + 0.06, z, 0.2, 1.3, 0xbfeaf2, 0.7, 0.8);
        return 1.4;
      }
      case 'sonar': {
        for (let k = 0; k < 3; k++) fx.timed(0.25 * k + 0.001, (t) => { if (t >= 1) fx.ring(x, y + 0.07, z, 0.1, 2.4, 0x7dff8a, 0.9, 1); });
        fx.add.spawn(x, y + 0.9, z, 0, 0, 0, 0.9, 0.5, 0.2, 1.4, 4, 1.6, 1, 0, 0, 0, 2);
        for (let i = 0; i < n(20); i++) fx.add.spawn(x, y + 0.05 + i * 0.12, z, 0, 0.4, 0, 0.8, 0.12, 0.04, 0.8, 3, 1, 1, 0, 0, 0, 1.5);
        fx.flashLight(x, y + 1, z, 0x7dff8a, 12, 0.6, 5);
        return 1.2;
      }
      case 'firework': {
        const cols = [[3, 0.8, 1.2], [3, 2.4, 0.6], [0.8, 2, 3.2]];
        for (let k = 0; k < 3; k++) {
          const dx = (Math.random() - 0.5) * 1.2, dz = (Math.random() - 0.5) * 1.2, h = 2.4 + Math.random() * 1.2, c = cols[k];
          const t0 = k * 0.18;
          fx.timed(t0 + 0.55, (t) => {
            const tt = t * (t0 + 0.55) - t0;
            if (tt > 0 && tt < 0.55) { const kk = tt / 0.55; fx.add.spawn(x + dx * kk, y + h * kk, z + dz * kk, 0, -0.5, 0, 0.35, 0.09, 0.02, 3, 2.2, 1.2, 1, 0, 0, 0, 1.2); }
            if (t >= 1) {
              for (let i = 0; i < n(42); i++) {
                const a = Math.random() * 6.28, b = Math.acos(Math.random() * 2 - 1), sp = 1.8 + Math.random() * 0.9;
                fx.add.spawn(x + dx, y + h, z + dz, Math.sin(b) * Math.cos(a) * sp, Math.cos(b) * sp, Math.sin(b) * Math.sin(a) * sp, 0.9 + Math.random() * 0.5, 0.1, 0.03, c[0], c[1], c[2], 1, 1.5, 1.4, 0.6, 1);
              }
              fx.flashLight(x + dx, y + h, z + dz, new THREE.Color(c[0] / 3, c[1] / 3, c[2] / 3).getHex(), 14, 0.35, 6);
            }
          });
        }
        return 1.6;
      }
      case 'pixel': {
        const N = 34;
        const im = this._add(new THREE.InstancedMesh(a.pixGeo, a.pixMat, N));
        im.frustumCulled = false;
        const pal = [0xff4a4a, 0x4aff6a, 0x4a7aff, 0xffd24a, 0xffffff, 0xff7ad9];
        const col = new THREE.Color(), st = [];
        for (let i = 0; i < N; i++) {
          const ang = Math.random() * 6.28, sp = 0.6 + Math.random() * 1.8;
          st.push({ x: x + (Math.random() - 0.5) * 0.3, y: y + 0.15 + Math.random() * 0.85, z: z + (Math.random() - 0.5) * 0.3, vx: Math.cos(ang) * sp, vy: 1.5 + Math.random() * 2.5, vz: Math.sin(ang) * sp });
          im.setColorAt(i, col.set(pal[i % pal.length]).multiplyScalar(1.3));
        }
        im.instanceColor.needsUpdate = true;
        let last = 0;
        fx.timed(1.8, (t) => {
          const dt = Math.max(0, (t - last) * 1.8); last = t;
          view.pose.visible = t < 0.06;
          for (let i = 0; i < N; i++) {
            const c = st[i];
            c.vy -= 9 * dt; c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
            if (c.y < y + 0.06) { c.y = y + 0.06; c.vy = Math.abs(c.vy) * 0.4; c.vx *= 0.6; c.vz *= 0.6; }
            // snap to a chunky grid: it's 8-bit
            const k = t > 0.75 ? 1 - (t - 0.75) / 0.25 : 1;
            _m4.compose(_p.set(Math.round(c.x * 10) / 10, Math.round(c.y * 10) / 10, Math.round(c.z * 10) / 10), _q.identity(), _s.setScalar(Math.max(0.01, k)));
            im.setMatrixAt(i, _m4);
          }
          im.instanceMatrix.needsUpdate = true;
          if (t >= 1) { this._drop(im); im.dispose(); view.derezzed = true; }
        });
        fx.ring(x, y + 0.06, z, 0.2, 1.2, 0xffffff, 0.35, 1);
        return 1.8;
      }
      case 'shatter': {
        // freeze (icy tint + frost spikes), then burst into shards
        if (view.flashCol) { view.flashCol.set(0x9fd8ff); }
        fx.timed(0.55, (t) => { view.flash = Math.max(view.flash, 0.9); if (t >= 1 && view.flashCol) view.flashCol.set(0xffffff); });
        for (let i = 0; i < n(30); i++) fx.alpha.spawn(x + (Math.random() - 0.5) * 0.5, y + Math.random() * 1.0, z + (Math.random() - 0.5) * 0.5, 0, 0.1, 0, 0.6, 0.12, 0.2, 0.85, 0.95, 1, 0.6, 1, 0, 0, 1.2);
        const N = 30;
        const im = this._add(new THREE.InstancedMesh(a.shardGeo, a.iceMat, N));
        im.frustumCulled = false; im.visible = false; im.castShadow = true;
        const st = [];
        for (let i = 0; i < N; i++) {
          const ang = Math.random() * 6.28, sp = 1 + Math.random() * 2.6;
          st.push({ x, y: y + 0.15 + Math.random() * 0.9, z, vx: Math.cos(ang) * sp, vy: 1 + Math.random() * 3, vz: Math.sin(ang) * sp, r: Math.random() * 6, w: 6 + Math.random() * 10, s: 0.6 + Math.random() * 1.2 });
        }
        let last = 0;
        fx.timed(1.9, (t) => {
          const T = t * 1.9, dt = Math.max(0, T - last); last = T;
          if (T < 0.55) return;
          if (!im.visible) {
            im.visible = true; view.pose.visible = false; view.derezzed = true;
            fx.flashLight(x, y + 0.8, z, 0x9fd8ff, 18, 0.3, 5);
            fx.ring(x, y + 0.06, z, 0.2, 1.6, 0xcfeeff, 0.6, 1);
            for (let i = 0; i < n(40); i++) { const g = Math.random() * 6.28, sp = 1 + Math.random() * 3; fx.add.spawn(x, y + 0.6, z, Math.cos(g) * sp, Math.random() * 3, Math.sin(g) * sp, 0.6, 0.05, 0.02, 2, 2.6, 3, 1, 1.5, 6, 0.6, 1); }
          }
          for (let i = 0; i < N; i++) {
            const c = st[i];
            c.vy -= 10 * dt; c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt; c.r += c.w * dt;
            if (c.y < y + 0.04) { c.y = y + 0.04; c.vy *= -0.3; c.vx *= 0.5; c.vz *= 0.5; c.w *= 0.5; }
            const k = t > 0.8 ? 1 - (t - 0.8) / 0.2 : 1;
            _e.set(c.r, c.r * 0.7, 0); _q.setFromEuler(_e);
            _m4.compose(_p.set(c.x, c.y, c.z), _q, _s.setScalar(Math.max(0.01, k * c.s)));
            im.setMatrixAt(i, _m4);
          }
          im.instanceMatrix.needsUpdate = true;
          if (t >= 1) { this._drop(im); im.dispose(); }
        });
        return 1.9;
      }
      case 'sharks': {
        const fins = [];
        for (let i = 0; i < 3; i++) { const m = this._add(new THREE.Mesh(a.finGeo, a.finMat)); m.castShadow = true; fins.push(m); }
        const ring = this._add(new THREE.Mesh(a.colGeo, a.waterMat.clone())); ring.material.userData = {};
        ring.position.set(x, y, z); ring.scale.set(2.2, 0.06, 2.2); ring.renderOrder = 7;
        fx.timed(2.0, (t) => {
          const T = t * 2;
          const rise = Math.min(1, T / 0.3), dive = t > 0.75 ? (t - 0.75) / 0.25 : 0;
          for (let i = 0; i < 3; i++) {
            const ang = T * 3.2 + (i / 3) * 6.28, r = 0.95 - t * 0.35;
            const m = fins[i];
            m.position.set(x + Math.cos(ang) * r, y - 0.45 + 0.45 * rise - dive * 0.6, z + Math.sin(ang) * r);
            m.rotation.y = -ang;
            if (Math.random() < 0.4) fx.alpha.spawn(m.position.x, y + 0.05, m.position.z, 0, 0.6, 0, 0.5, 0.06, 0.12, 0.88, 0.97, 1, 0.8, 2, 4, 0, 1);
          }
          ring.material.opacity = 0.4 * (1 - t);
          ring.rotation.y = T * 2;
          if (t >= 1) { for (const f of fins) this._drop(f); ring.material.dispose(); this._drop(ring); }
        });
        fx.timed(1.4, (t) => { if (t >= 1) { fx.splash(x, z, 1.8); fx.ring(x, y + 0.08, z, 0.3, 2.0, 0xcff4ee, 0.7, 1); } });
        fx.splash(x, z, 1.0);
        return 2.0;
      }
      case 'skull': {
        const m = this._add(new THREE.Mesh(a.skullGeo, a.skullMat.clone())); m.material.userData = {};
        m.renderOrder = 8;
        fx.timed(2.0, (t) => {
          const k = easeOutCubic(Math.min(1, t * 2.2));
          m.position.set(x, y + 0.6 + t * 1.6, z);
          m.scale.setScalar(0.2 + k * 0.7);
          m.rotation.y = Math.sin(t * 6) * 0.15;
          m.material.opacity = 0.85 * (t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4);
          if (Math.random() < 0.6) fx.alpha.spawn(x + (Math.random() - 0.5) * 0.6, y + 0.4 + t * 1.4, z + (Math.random() - 0.5) * 0.6, 0, 0.5, 0, 1.2, 0.3, 0.8, 0.85, 0.84, 0.8, 0.45, 1.5, -0.2, 0, 1.2);
          if (t >= 1) { m.material.dispose(); this._drop(m); }
        });
        for (let i = 0; i < n(20); i++) fx.alpha.spawn(x, y + 0.3, z, (Math.random() - 0.5) * 1.2, 0.8 + Math.random(), (Math.random() - 0.5) * 1.2, 1.2, 0.3, 0.9, 0.2, 0.2, 0.2, 0.7, 2, -0.2, 0, 1.2);
        fx.ring(x, y + 0.06, z, 0.2, 1.3, 0xe8e4d8, 0.6, 1);
        return 2.0;
      }
      case 'anchor': {
        const m = this._add(new THREE.Mesh(a.anchorGeo, a.vcMat)); m.castShadow = true;
        let hit = false;
        fx.timed(2.0, (t) => {
          const T = t * 2;
          const fall = Math.min(1, T / 0.35);
          m.position.set(x + 0.25, y + 9 * (1 - fall * fall) - (T > 1.4 ? (T - 1.4) * 2.2 : 0), z - 0.1);
          m.rotation.set(0.15 * (1 - fall), 0.6, 0.2 * (1 - fall) - 0.12);
          m.scale.setScalar(0.85);
          if (fall >= 1 && !hit) {
            hit = true;
            fx.shake = Math.min(1, fx.shake + 0.7);
            fx.dust(x, z, 18, 0.78, 0.72, 0.6, y + 0.05, 2);
            fx.ring(x, y + 0.06, z, 0.3, 2.4, 0xe8e0cc, 0.6, 1);
            fx.debrisBurst(x, y + 0.2, z, [0x9b9a90, 0xcbbd9c, 0x7a6a50], 8, 1.2);
            fx.scorch(x, z, 1.1);
            this.hooks.flash?.(0.4);
            view.flinch = 1;
          }
          if (t >= 1) this._drop(m);
        });
        return 1.4;
      }
      case 'maelstrom': {
        const disc = this._add(new THREE.Mesh(a.vortexGeo, a.vortexMat.clone())); disc.material.userData = {};
        disc.position.set(x, y + 0.04, z); disc.renderOrder = 7;
        const y0 = view.root.position.y;
        fx.timed(2.1, (t) => {
          const T = t * 2.1;
          const open = Math.min(1, T / 0.4), close = t > 0.8 ? (t - 0.8) / 0.2 : 0;
          disc.scale.setScalar(Math.max(0.01, 1.6 * open * (1 - close)));
          disc.material.uniforms.uT.value = T; disc.material.uniforms.uA.value = 1 - close;
          const pull = Math.max(0, (T - 0.5) / 1.1);
          if (pull > 0 && pull < 1) { view.root.position.y = y0 - pull * pull * 1.2; view.root.rotation.y += 0.25 * pull; }
          if (pull >= 1 && view.pose.visible) { view.pose.visible = false; view.derezzed = true; view.root.position.y = y0; }
          if (Math.random() < 0.8) {
            const ang = Math.random() * 6.28, r = 1.4;
            fx.add.spawn(x + Math.cos(ang) * r, y + 0.1, z + Math.sin(ang) * r, -Math.cos(ang) * 1.6 - Math.sin(ang) * 2, 0.1, -Math.sin(ang) * 1.6 + Math.cos(ang) * 2, 0.7, 0.07, 0.02, 2.2, 1.2, 3, 1, 0.3, 0, 0.8, 1);
          }
          if (t >= 1) { disc.material.dispose(); this._drop(disc); }
        });
        fx.flashLight(x, y + 0.8, z, 0xb46aff, 16, 1.2, 6);
        return 2.1;
      }
      default: return 0;
    }
  }

  // ---------- drop-ins ----------

  /**
   * Build a drop-in controller for a view landing at goal (Vector3).
   * Returns { dur, update(t seconds), end() }. opts.h scales vertical travel (previews), opts.from: unit vector
   * on the ground pointing the way the unit travels in from (boat / gunship).
   */
  dropIn(id, view, goal, opts = {}) {
    const fx = this.fx, a = assets(), H = opts.h ?? 1, hooks = this.hooks;
    const root = view.root, gx = goal.x, gy = goal.y, gz = goal.z;
    const from = opts.from || { x: 0, z: -1 };
    const yaw0 = root.rotation.y;
    const place = (x, y, z) => root.position.set(x, y, z);
    const land = (k = 1) => {
      fx.dust(gx, gz, 10 * k, 0.78, 0.72, 0.6, gy + 0.05, 1.4 * k);
      fx.ring(gx, gy + 0.06, gz, 0.2, 1.1 * k, 0xeaf3ef, 0.45, 0.9);
      view.pop = 1;
    };
    const tmp = [];
    const own = (o) => { this._add(o); tmp.push(o); return o; };
    const cleanup = () => { for (const o of tmp) this._drop(o); tmp.length = 0; };
    const done = () => { cleanup(); place(gx, gy, gz); root.rotation.set(0, root.rotation.y, 0); root.scale.set(1, 1, 1); view.pose.visible = true; view.ring.visible = !view.dead; };
    switch (id) {
      case 'parachute': {
        const chute = makeChute(); chute.scale.setScalar(1.3); chute.position.y = 0.2;
        root.add(chute); tmp.push(chute);
        let landed = false;
        return {
          dur: 2.3,
          update(t) {
            const k = clamp(t / 1.9, 0, 1), e = 1 - (1 - k) * (1 - k);
            place(gx + Math.sin(t * 2.4) * 0.35 * (1 - k), gy + 9 * H * (1 - e), gz + Math.cos(t * 1.9) * 0.2 * (1 - k));
            root.rotation.z = Math.sin(t * 2.4) * 0.12 * (1 - k);
            if (k >= 1 && !landed) { landed = true; land(0.8); }
            if (t > 1.9) { const c = (t - 1.9) / 0.4; chute.position.set(c * 0.8, 0.2 - c * 1.2, c * 0.3); chute.rotation.z = c * 1.2; chute.material.opacity = 1 - c; }
          },
          end() { root.remove(chute); chute.material.dispose(); root.rotation.z = 0; done(); },
        };
      }
      case 'boat': {
        const boat = own(new THREE.Mesh(a.boatGeo, a.vcMat)); boat.castShadow = true;
        const yaw = Math.atan2(-from.x, -from.z);
        boat.rotation.y = yaw; root.rotation.y = yaw;
        const sx = gx + from.x * 4.5, sz = gz + from.z * 4.5, ex = gx + from.x * 0.9, ez = gz + from.z * 0.9;
        let hopped = false;
        return {
          dur: 2.1,
          update(t) {
            const k = easeOutCubic(clamp(t / 1.2, 0, 1));
            const bx = lerp(sx, ex, k), bz = lerp(sz, ez, k);
            const bob = Math.sin(t * 7) * 0.03;
            boat.position.set(bx, gy + 0.02 + bob - (t > 1.5 ? (t - 1.5) * 0.5 : 0), bz);
            boat.rotation.x = Math.sin(t * 5) * 0.05 - 0.08 * (1 - k);
            if (t < 1.2 && Math.random() < 0.7) fx.splash(bx - from.x * -0.6, bz - from.z * -0.6, 0.35);
            if (t < 1.25) place(bx, boat.position.y + 0.14, bz);
            else {
              const h = clamp((t - 1.25) / 0.45, 0, 1);
              place(lerp(ex, gx, h), gy + 0.14 * (1 - h) + Math.sin(h * Math.PI) * 0.55, lerp(ez, gz, h));
              if (h >= 1 && !hopped) { hopped = true; land(0.7); }
            }
            boat.visible = t < 2.05;
          },
          end() { root.rotation.y = yaw0; done(); },
        };
      }
      case 'grapple': {
        const ship = own(new THREE.Mesh(a.shipGeo, a.vcMat)); ship.castShadow = true;
        const rotor = own(new THREE.Mesh(a.rotorGeo, a.rotorMat));
        const rope = own(new THREE.Mesh(a.ropeGeo, a.ropeMat));
        const hy = gy + 6.5 * H;
        const yaw = Math.atan2(-from.x, -from.z);
        ship.rotation.y = yaw;
        let landed = false;
        return {
          dur: 2.4,
          update(t) {
            const inK = easeOutCubic(clamp(t / 0.6, 0, 1)), outK = clamp((t - 1.75) / 0.65, 0, 1);
            const sx = gx + from.x * 9 * (1 - inK) - from.x * 10 * outK * outK, sz = gz + from.z * 9 * (1 - inK) - from.z * 10 * outK * outK;
            const sy = hy + outK * 3 + Math.sin(t * 3) * 0.08;
            ship.position.set(sx, sy, sz); ship.rotation.z = Math.sin(t * 2) * 0.05;
            ship.rotation.x = (1 - inK) * 0.2 - outK * 0.25;
            rotor.position.set(sx, sy + 0.55, sz); rotor.rotation.y = t * 30; rotor.scale.setScalar(1.6);
            const slide = clamp((t - 0.6) / 0.85, 0, 1);
            const uy = lerp(hy - 0.3, gy, easeInOutCubic(slide));
            rope.visible = t > 0.45 && t < 1.8;
            rope.position.set(gx, hy - 0.2, gz);
            const ropeLen = t < 0.6 ? clamp((t - 0.45) / 0.15, 0.01, 1) * (hy - gy) : (t < 1.5 ? hy - gy : (hy - gy) * (1 - clamp((t - 1.5) / 0.3, 0, 0.99)));
            rope.scale.set(1, Math.max(0.01, ropeLen), 1);
            place(gx, t < 0.6 ? hy - 0.3 : uy, gz);
            view.pose.visible = t > 0.5;
            if (slide >= 1 && !landed) { landed = true; land(0.8); }
          },
          end() { done(); },
        };
      }
      case 'breach': {
        let landed = false, plumed = false;
        return {
          dur: 1.5,
          update(t) {
            if (!plumed && t > 0.1) {
              plumed = true;
              for (let i = 0; i < fx._n(40); i++) {
                const ang = Math.random() * 6.28, s = 0.3 + Math.random() * 1.2;
                fx.alpha.spawn(gx, gy + 0.1, gz, Math.cos(ang) * s, (4 + Math.random() * 5) * Math.sqrt(H), Math.sin(ang) * s, 0.8 + Math.random() * 0.5, 0.08, 0.06, 0.85, 0.96, 1, 0.9, 0.4, 9, 0.5, 1);
              }
              fx.splash(gx, gz, 1.8); fx.ring(gx, gy + 0.08, gz, 0.3, 2.0, 0xcff4ee, 0.7, 1);
            }
            const k = clamp((t - 0.12) / 1.0, 0, 1);
            const arc = Math.sin(k * Math.PI) * 2.2 * H;
            place(gx, lerp(gy - 1.4, gy, k) + arc, gz);
            root.rotation.x = k < 1 ? k * Math.PI * 2 : 0;
            view.pose.visible = t > 0.12;
            if (k >= 1 && !landed) { landed = true; land(0.6); fx.splash(gx, gz, 0.6); }
          },
          end() { root.rotation.x = 0; done(); },
        };
      }
      case 'orbital': {
        const beam = own(new THREE.Mesh(a.beamGeo, a.beamMat.clone()));
        beam.material.userData = {}; beam.renderOrder = 8; beam.frustumCulled = false;
        const outer = own(new THREE.Mesh(a.beamGeo, a.beamMat.clone()));
        outer.material.userData = {}; outer.renderOrder = 8; outer.frustumCulled = false;
        let rung = false;
        return {
          dur: 1.9,
          update(t) {
            const fin = clamp(t / 0.3, 0, 1), fout = clamp((t - 1.25) / 0.6, 0, 1);
            beam.position.set(gx, gy, gz); beam.scale.set(0.32 * (1 - fout * 0.8), 18 * H, 0.32 * (1 - fout * 0.8));
            beam.material.opacity = 0.75 * fin * (1 - fout);
            outer.position.set(gx, gy, gz); outer.scale.set(0.7 + Math.sin(t * 20) * 0.04, 18 * H, 0.7 + Math.sin(t * 20) * 0.04);
            outer.material.opacity = 0.22 * fin * (1 - fout);
            const m = clamp((t - 0.45) / 0.7, 0, 1);
            place(gx, gy, gz);
            root.scale.set(lerp(0.3, 1, m), Math.max(0.01, m), lerp(0.3, 1, m));
            view.pose.visible = t > 0.45;
            if (t > 0.45) view.flash = Math.max(view.flash, 1.2 * (1 - m));
            if (Math.random() < 0.6 && t < 1.3) fx.add.spawn(gx + (Math.random() - 0.5) * 0.5, gy + Math.random() * 2 * H, gz + (Math.random() - 0.5) * 0.5, 0, -2, 0, 0.5, 0.05, 0.02, 2.4, 2.2, 3.4, 1, 0, 0, 1, 1);
            if (m >= 1 && !rung) { rung = true; fx.ring(gx, gy + 0.06, gz, 0.2, 1.6, 0xd8d0ff, 0.6, 1.3); fx.flashLight(gx, gy + 1, gz, 0xc8c0ff, 20, 0.4, 5); }
          },
          end() { done(); },
        };
      }
      case 'gulls': {
        const N = 12;
        const im = own(new THREE.InstancedMesh(a.gullGeo, a.gullMat, N));
        im.frustumCulled = false;
        const st = [];
        for (let i = 0; i < N; i++) st.push({ a: (i / N) * 6.28, h: 0.3 + Math.random() * 1.1 * Math.max(0.6, H), r: 0.6 + Math.random() * 0.5, w: 5 + Math.random() * 2, s: 0.55 + Math.random() * 0.2 });
        return {
          dur: 2.1,
          update(t) {
            const out = clamp((t - 1.1) / 1.0, 0, 1);
            for (let i = 0; i < N; i++) {
              const g = st[i], ang = g.a + t * g.w;
              const rad = g.r * (1.6 - Math.min(1, t) * 0.8) + out * out * 6;
              _p.set(gx + Math.cos(ang) * rad, gy + g.h + out * out * 5 * H, gz + Math.sin(ang) * rad);
              _e.set(0, Math.atan2(-Math.sin(ang), Math.cos(ang)), -0.5, 'YXZ'); _q.setFromEuler(_e);
              _m4.compose(_p, _q, _s.setScalar(g.s * (1 - out * 0.5)));
              im.setMatrixAt(i, _m4);
            }
            im.instanceMatrix.needsUpdate = true;
            const m = clamp((t - 0.9) / 0.4, 0, 1);
            place(gx, gy, gz);
            root.scale.set(1, Math.max(0.01, easeOutCubic(m)), 1);
            view.pose.visible = t > 0.9;
            if (t > 0.9 && t < 1.0) for (let i = 0; i < 2; i++) fx.alpha.spawn(gx + (Math.random() - 0.5) * 0.6, gy + 0.3 + Math.random() * 0.8, gz + (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 2, 0.5, (Math.random() - 0.5) * 2, 0.9, 0.05, 0.05, 0.95, 0.94, 0.9, 1, 1, 1.5, 0, 1);
          },
          end() { im.dispose(); done(); },
        };
      }
      case 'zipline': {
        const yaw = Math.atan2(-from.x, -from.z);
        const sx = gx + from.x * 6, sz = gz + from.z * 6, sy = gy + 4.2 * H + 0.9;
        const ex = gx + from.x * 0.35, ez = gz + from.z * 0.35, ey = gy + 1.25;
        const cable = own(new THREE.Mesh(a.cableGeo, a.ropeMat));
        cable.position.set(sx, sy, sz); cable.lookAt(ex, ey - 0.1, ez);
        const L = Math.hypot(ex - sx, ey - sy, ez - sz);
        let landed = false;
        return {
          dur: 1.7,
          update(t) {
            cable.scale.set(1, 1, L * Math.min(1, t / 0.15));
            cable.visible = t < 1.45;
            root.rotation.y = yaw;
            const k = easeInOutCubic(clamp((t - 0.15) / 0.9, 0, 1));
            if (t < 1.05) {
              place(lerp(sx, ex, k), lerp(sy, ey, k) - 1.15, lerp(sz, ez, k));
              root.rotation.x = -0.15; view.hunk = 0.3;
              if (Math.random() < 0.6) fx.add.spawn(root.position.x, root.position.y + 1.15, root.position.z, 0, -0.5, 0, 0.2, 0.05, 0.02, 4, 3, 1.5, 1, 0, 3, 0.8, 1);
            } else {
              const d = clamp((t - 1.05) / 0.3, 0, 1);
              place(lerp(ex, gx, d), lerp(ey - 1.15, gy, d * d), lerp(ez, gz, d));
              root.rotation.x = 0;
              if (d >= 1 && !landed) { landed = true; land(0.8); view.hunk = 0.9; }
            }
          },
          end() { root.rotation.x = 0; root.rotation.y = yaw0; done(); },
        };
      }
      case 'jetski': {
        const ski = own(new THREE.Mesh(a.jetskiGeo, a.vcMat)); ski.castShadow = true;
        const yaw = Math.atan2(-from.x, -from.z);
        ski.rotation.y = yaw; root.rotation.y = yaw;
        const sx = gx + from.x * 7, sz = gz + from.z * 7, ex = gx + from.x * 0.8, ez = gz + from.z * 0.8;
        let hopped = false;
        return {
          dur: 1.9,
          update(t) {
            const k = easeOutCubic(clamp(t / 0.9, 0, 1));
            const bx = lerp(sx, ex, k), bz = lerp(sz, ez, k);
            ski.position.set(bx, gy + 0.03 + Math.sin(t * 11) * 0.02 - (t > 1.2 ? (t - 1.2) * 0.4 : 0), bz);
            ski.rotation.set(-0.12 * (1 - k) + Math.sin(t * 9) * 0.03, yaw + (t > 0.85 ? (t - 0.85) * 2.2 : 0), Math.sin(t * 7) * 0.06);
            if (t < 0.95) for (let i = 0; i < 2; i++) fx.alpha.spawn(bx + from.x * 0.5, gy + 0.15, bz + from.z * 0.5, from.x * 2 + (Math.random() - 0.5), 2.5 + Math.random() * 2, from.z * 2 + (Math.random() - 0.5), 0.6, 0.06, 0.12, 0.88, 0.97, 1, 0.85, 1, 9, 0.4, 1);
            if (t < 0.95) place(bx, ski.position.y + 0.12, bz);
            else {
              const h = clamp((t - 0.95) / 0.5, 0, 1);
              place(lerp(ex, gx, h), gy + 0.12 * (1 - h) + Math.sin(h * Math.PI) * 0.7, lerp(ez, gz, h));
              root.rotation.x = h < 1 ? -h * Math.PI * 2 : 0;
              if (h >= 1 && !hopped) { hopped = true; land(0.7); fx.splash(ex, ez, 0.8); }
            }
            ski.visible = t < 1.85;
          },
          end() { root.rotation.x = 0; root.rotation.y = yaw0; done(); },
        };
      }
      case 'cannon': {
        const sx = gx + from.x * 9, sz = gz + from.z * 9;
        let landed = false;
        fx.flashLight(sx, gy + 1, sz, 0xff9a3a, 20, 0.3, 8);
        return {
          dur: 1.6,
          update(t) {
            const k = clamp(t / 1.0, 0, 1);
            const arc = Math.sin(k * Math.PI) * 4.2 * H;
            if (k < 1) {
              place(lerp(sx, gx, k), gy + arc, lerp(sz, gz, k));
              root.rotation.x = k * Math.PI * 4;
              view.hunk = 1;
              fx.alpha.spawn(root.position.x, root.position.y + 0.5, root.position.z, 0, 0.2, 0, 0.7, 0.15, 0.4, 0.45, 0.42, 0.4, 0.5, 1.5, -0.2, 0, 1.2);
              if (Math.random() < 0.5) fx.add.spawn(root.position.x, root.position.y + 0.5, root.position.z, 0, 0, 0, 0.25, 0.12, 0.05, 4, 2.4, 1, 1, 0, 0, 0, 1);
            } else {
              const r = clamp((t - 1.0) / 0.4, 0, 1);
              place(gx, gy, gz);
              root.rotation.x = r < 1 ? r * Math.PI * 2 : 0;
              if (!landed) { landed = true; land(1.1); fx.shake = Math.min(1, fx.shake + 0.25); }
            }
          },
          end() { root.rotation.x = 0; done(); },
        };
      }
      case 'jetpack': {
        const pack = new THREE.Mesh(a.jetpackGeo, a.vcMat); pack.position.set(0, 0.9, -0.24); pack.castShadow = true;
        root.add(pack); tmp.push(pack);
        let landed = false;
        return {
          dur: 2.0,
          update(t) {
            const k = clamp(t / 1.6, 0, 1), e = 1 - (1 - k) * (1 - k) * (1 - k);
            place(gx + Math.sin(t * 3) * 0.12 * (1 - k), gy + 6.5 * H * (1 - e), gz + Math.cos(t * 2.3) * 0.1 * (1 - k));
            root.rotation.z = Math.sin(t * 3) * 0.08 * (1 - k);
            view.hunk = 0.25;
            const p = root.position;
            if (t < 1.75) for (const sx of [-0.1, 0.1]) {
              fx.add.spawn(p.x + sx, p.y + 0.66, p.z - 0.3, (Math.random() - 0.5) * 0.3, -3 - Math.random() * 2, (Math.random() - 0.5) * 0.3, 0.25, 0.14, 0.04, 4, 2.2, 0.8, 1, 1, 0, 1.2, 1);
              if (Math.random() < 0.3) fx.alpha.spawn(p.x + sx, p.y + 0.4, p.z - 0.3, 0, -1, 0, 0.8, 0.12, 0.4, 0.6, 0.58, 0.55, 0.35, 2, -0.3, 0, 1.2);
            }
            if (k > 0.85 && Math.random() < 0.6) fx.dust(gx, gz, 2, 0.78, 0.72, 0.6, gy + 0.05, 1.2);
            if (k >= 1 && !landed) { landed = true; land(0.8); }
            if (t > 1.7) pack.scale.setScalar(Math.max(0.01, 1 - (t - 1.7) / 0.3));
          },
          end() { root.remove(pack); root.rotation.z = 0; done(); },
        };
      }
      case 'whirlpool': {
        const disc = own(new THREE.Mesh(a.vortexGeo, a.vortexMat.clone())); disc.material.userData = {};
        disc.material.uniforms.uC1.value.set(0x1a7a9a); disc.material.uniforms.uC2.value.set(0xa8f0ff);
        disc.position.set(gx, gy + 0.04, gz); disc.renderOrder = 7;
        let up = false;
        return {
          dur: 1.9,
          update(t) {
            const open = clamp(t / 0.4, 0, 1), close = clamp((t - 1.4) / 0.5, 0, 1);
            disc.scale.setScalar(Math.max(0.01, 1.5 * open * (1 - close)));
            disc.material.uniforms.uT.value = -t; disc.material.uniforms.uA.value = 1 - close;
            const r = clamp((t - 0.35) / 0.8, 0, 1);
            place(gx, gy - 1.2 * (1 - easeOutCubic(r)), gz);
            root.rotation.y = yaw0 + (1 - r) * 8;
            view.pose.visible = t > 0.35;
            if (Math.random() < 0.8 && t < 1.3) { const ang = Math.random() * 6.28; fx.alpha.spawn(gx + Math.cos(ang) * 1.2, gy + 0.08, gz + Math.sin(ang) * 1.2, -Math.sin(ang) * 2.4 - Math.cos(ang), 0.3, Math.cos(ang) * 2.4 - Math.sin(ang), 0.6, 0.06, 0.12, 0.88, 0.97, 1, 0.8, 0.5, 0, 0.5, 1); }
            if (r >= 1 && !up) { up = true; fx.splash(gx, gz, 1.4); fx.ring(gx, gy + 0.08, gz, 0.3, 1.8, 0xcff4ee, 0.7, 1); view.pop = 1; }
          },
          end() { root.rotation.y = yaw0; done(); },
        };
      }
      case 'meteor': {
        const rock = own(new THREE.Mesh(a.rockGeo, a.rockMat));
        const sx = gx + from.x * 6, sz = gz + from.z * 6, sy = gy + 12 * H;
        let hit = false;
        return {
          dur: 1.8,
          update(t) {
            const k = clamp(t / 0.7, 0, 1), kk = k * k;
            if (k < 1) {
              rock.visible = true;
              rock.position.set(lerp(sx, gx, kk), lerp(sy, gy + 0.3, kk), lerp(sz, gz, kk));
              rock.rotation.set(t * 9, t * 7, 0);
              const p = rock.position;
              for (let i = 0; i < 3; i++) fx.add.spawn(p.x + (Math.random() - 0.5) * 0.3, p.y + (Math.random() - 0.5) * 0.3, p.z + (Math.random() - 0.5) * 0.3, (Math.random() - 0.5), 1, (Math.random() - 0.5), 0.45, 0.35, 0.1, 4, 1.6, 0.4, 1, 1, 0, 0, 1.2);
              fx.alpha.spawn(p.x, p.y, p.z, 0, 0.5, 0, 1.1, 0.3, 0.8, 0.25, 0.22, 0.2, 0.6, 1, -0.2, 0, 1.2);
              view.pose.visible = false;
            } else {
              rock.visible = t < 0.95;
              rock.scale.setScalar(Math.max(0.01, 1 - (t - 0.7) / 0.25));
              if (!hit) {
                hit = true;
                fx.explosion?.(gx, gz, 1.2, false);
                fx.ring(gx, gy + 0.06, gz, 0.3, 2.2, 0xff8a3a, 0.6, 1.2);
                fx.shake = Math.min(1, fx.shake + 0.6);
                hooks.flash?.(0.4);
              }
              const r = clamp((t - 0.85) / 0.4, 0, 1);
              place(gx, gy, gz);
              view.pose.visible = t > 0.85;
              view.hunk = 1 - r;
              if (t > 0.85 && t < 1.2) view.flash = Math.max(view.flash, 1 - r);
            }
          },
          end() { done(); },
        };
      }
      default: {
        // transport hop: drops from a low pass, lands in a crouch
        let landed = false;
        return {
          dur: 1.1,
          update(t) {
            const k = clamp(t / 0.7, 0, 1);
            place(gx - from.x * 0.6 * (1 - k), gy + 4.5 * H * (1 - k * k), gz - from.z * 0.6 * (1 - k));
            view.pose.visible = true;
            if (k < 1 && Math.random() < 0.5) fx.alpha.spawn(root.position.x, root.position.y + 0.6, root.position.z, 0, 0.5, 0, 0.3, 0.12, 0.25, 0.85, 0.88, 0.86, 0.35, 1, 0, 0, 1.2);
            if (k >= 1 && !landed) { landed = true; land(1); view.hunk = 0.8; }
          },
          end() { done(); },
        };
      }
    }
  }

  // ---------- 5.0 tracers ----------

  /**
   * Cosmetic tracer from A to B. The beam keeps `squadHex` (readability);
   * cosmetic id adds a coloured core slug and a trail. width/dur as Fx.tracer.
   */
  tracer(id, ax, ay, az, bx, by, bz, squadHex, width = 0.035, dur = 0.16) {
    const fx = this.fx;
    fx.tracer(ax, ay, az, bx, by, bz, squadHex, width, dur);
    const L = TRACER[id];
    if (!L) return;
    _col.setRGB(L.core[0] / 5, L.core[1] / 5, L.core[2] / 5);
    fx.tracer(ax, ay, az, bx, by, bz, _col, width * 0.5, dur * 1.2); // coloured inner core
    const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    const sp = 55, life = Math.min(0.5, len / sp);
    const c = L.core;
    // a second, coloured slug riding with the default one
    fx.add.spawn(ax, ay, az, ux * sp, uy * sp, uz * sp, life, 0.12, 0.1, c[0], c[1], c[2], 1, 0, 0, 1.2, 0.8);
    const n = Math.min(40, Math.round(len * L.dens));
    // perpendicular basis for helix / arcs
    let px = -uz, pz = ux; const pl = Math.hypot(px, pz) || 1; px /= pl; pz /= pl;
    for (let i = 0; i < n; i++) {
      const k = (i + Math.random()) / n, x = ax + dx * k, y = ay + dy * k, z = az + dz * k;
      const delay = k * life;
      const t = L.trail;
      if (t === 'helix') {
        const a = k * len * 9, r = 0.07;
        const ox = px * Math.cos(a) * r, oy = Math.sin(a) * r, oz = pz * Math.cos(a) * r;
        fx.alpha.spawn(x + ox, y + oy, z + oz, ox * 2, oy * 2 + 0.2, oz * 2, 0.35 + delay, 0.05, 0.03, 0.75, 0.95, 1, 0.9, 1, 1.5, 0, 1);
        fx.add.spawn(x + ox, y + oy, z + oz, 0, 0, 0, 0.18 + delay, 0.04, 0.01, c[0], c[1], c[2], 1, 0, 0, 0, 1);
      } else if (t === 'sparks') {
        fx.add.spawn(x, y, z, (Math.random() - 0.5) * 1.5, Math.random() * 1.2, (Math.random() - 0.5) * 1.5, 0.25 + delay + Math.random() * 0.2, 0.04, 0.01, c[0], c[1], c[2], 1, 2, 6, 0.8, 1);
      } else if (t === 'glitter') {
        fx.add.spawn(x, y, z, (Math.random() - 0.5) * 0.4, -0.3 - Math.random() * 0.5, (Math.random() - 0.5) * 0.4, 0.4 + delay + Math.random() * 0.3, 0.035, 0.015, c[0], c[1], c[2], 1, 1, 1.5, 0, 1);
      } else if (t === 'smoke') {
        fx.alpha.spawn(x, y, z, 0, 0.15, 0, 0.5 + delay, 0.04, 0.16, L.smoke[0], L.smoke[1], L.smoke[2], 0.45, 1, -0.2, 0, 1.4);
      } else if (t === 'frost') {
        fx.alpha.spawn(x, y, z, (Math.random() - 0.5) * 0.3, -0.1, (Math.random() - 0.5) * 0.3, 0.45 + delay, 0.05, 0.02, 0.85, 0.95, 1, 0.85, 1, 0.5, 0, 1);
      } else if (t === 'arc') {
        const j = 0.09;
        fx.add.spawn(x + (Math.random() - 0.5) * j, y + (Math.random() - 0.5) * j, z + (Math.random() - 0.5) * j, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, 0.08 + delay * 0.5, 0.05, 0.02, c[0], c[1], c[2], 1, 0, 0, 2, 1);
      } else if (t === 'rainbow') {
        _col.setHSL((k * 2 + fx.clock * 0.5) % 1, 1, 0.6);
        fx.add.spawn(x, y, z, 0, 0.1, 0, 0.25 + delay, 0.06, 0.02, _col.r * 3, _col.g * 3, _col.b * 3, 1, 0, 0, 0, 1);
      } else {
        fx.add.spawn(x, y, z, 0, 0, 0, 0.15 + delay, 0.04, 0.02, c[0], c[1], c[2], 1, 0, 0, 0, 1);
      }
    }
  }
}

// ---------- 5.0 streak skins ----------
// streakLook(id) gives GFX-WORLD a palette to tint its own vehicle models;
// buildStreakModel(kind, id) builds a complete skinned model (used by the
// shop previews, and by render.js if it wants them). kind: gunship | uav |
// cuav | airstrike (jet) | sentry | care. Models face +z, origin at their centre
// (sentry / care: base on y=0). group.userData.rotors spin around y; call
// tickStreakModel(group, t) each frame.

const STREAK_LOOK = {
  default: { hull: 0x5a6266, hull2: 0x3a4246, trim: 0xa4452c, glow: 0xffb060, tracer: null },
  desert: { hull: 0xc8a873, hull2: 0x9a7a4a, trim: 0x6a4a2a, glow: 0xffb060, tracer: null },
  shark: { hull: 0x6d7880, hull2: 0x4a545a, trim: 0xe83a3a, glow: 0xffb060, decal: 'teeth', tracer: null },
  gullseye: { hull: 0xf3efe4, hull2: 0x8a9096, trim: 0x3a3f42, glow: 0xffd04a, decal: 'gull', tracer: null },
  totem: { hull: 0x8d6a42, hull2: 0x6a4a2a, trim: 0x2ad0c0, glow: 0x2ad0c0, decal: 'tiki', tracer: 0x2ad0c0 },
  stingray: { hull: 0x16191b, hull2: 0x24292c, trim: 0x5aa8ff, glow: 0x5aa8ff, decal: 'manta', tracer: 0x5aa8ff },
  goldrush: { hull: 0xe9c25a, hull2: 0x1c1a17, trim: 0xffe08a, glow: 0xffe08a, decal: 'gold', tracer: 0xffd24a },
  leviathan: { hull: 0x0b1a2e, hull2: 0x10262e, trim: 0x2ad0c0, glow: 0xff4a3a, decal: 'scales', tracer: 0x2ad0c0 },
  synth: { hull: 0x1a1430, hull2: 0x120e1c, trim: 0xc04dff, glow: 0xff4fa8, decal: 'neon', tracer: 0xc04dff },
};
/** Palette of a streak skin: { hull, hull2, trim, glow, decal?, tracer (hex|null: keep squad colour) }. */
export function streakLook(id) { return STREAK_LOOK[id] || STREAK_LOOK.default; }

const STREAK_GEO = new Map();
function streakGeo(kind, id) {
  const key = kind + '|' + id;
  if (STREAK_GEO.has(key)) return STREAK_GEO.get(key);
  const L = streakLook(id), g = new GeoBuilder();
  const H = L.hull, H2 = L.hull2, T = L.trim, gold = L.decal === 'gold';
  const body = () => g.tag(gold ? WT.gold : WT.att), glow = () => g.tag(WT.glow), plain = () => g.tag(WT.att);
  const neon = L.decal === 'neon';
  const rotors = [];
  if (kind === 'gunship') {
    body().box(0.9, 0.6, 2.2, 0, 0, 0, H);
    g.box(0.72, 0.4, 0.7, 0, -0.04, 1.32, H);
    plain().box(0.74, 0.22, 0.52, 0, 0.14, 1.42, 0x1a2328); // canopy
    body().box(0.3, 0.3, 1.7, 0, 0.12, -1.75, H2); g.box(0.06, 0.65, 0.45, 0, 0.42, -2.45, T);
    g.box(3.0, 0.07, 0.42, 0, 0.36, 0.1, H2);
    for (const sx of [-1, 1]) { g.cyl(0.17, 0.5, 8, sx * 1.42, 0.22, 0.1, H2, 0, Math.PI / 2); plain().box(0.16, 0.16, 0.5, sx * 1.1, 0.2, 0.2, 0x2a2e31); }
    plain().cyl(0.06, 0.55, 6, 0.5, -0.2, 0.7, 0x2a2e31, 0, Math.PI / 2); // side cannon
    g.tag(WT.att).box(0.92, 0.05, 0.14, 0, -0.31, 0.4, T);
    g.cyl(0.06, 0.4, 6, 0, 0.5, 0, 0x2a2e31);
    if (L.decal === 'teeth') { for (let i = 0; i < 6; i++) { plain().cone(0.05, 0, 0.12, 3, -0.3 + i * 0.12, -0.12, 1.68, 0xf4f0e4, 0, Math.PI); } g.box(0.75, 0.06, 0.05, 0, -0.06, 1.68, T); }
    if (L.decal === 'scales') {
      for (let i = 0; i < 7; i++) g.tag(WT.att).cone(0.14, 0, 0.3, 4, 0, 0.42, -0.9 + i * 0.32, T, Math.PI / 4); // dorsal fins
      for (let i = 0; i < 5; i++) plain().cone(0.05, 0, 0.16, 3, -0.28 + i * 0.14, -0.28, 1.66, 0xf4f0e4, 0, Math.PI + 0.4); // jaw
      glow().box(0.12, 0.08, 0.06, 0.26, 0.1, 1.68, L.glow); g.box(0.12, 0.08, 0.06, -0.26, 0.1, 1.68, L.glow); // eyes
      glow().box(0.92, 0.03, 1.8, 0, -0.18, 0, T); // lateral line
      for (let k = 0; k < 4; k++) for (let i = 0; i < 5; i++) g.tag(WT.att).box(0.05, 0.12, 0.05, -0.3 + k * 0.2, -0.38 - i * 0.12, -0.6 + k * 0.1 + Math.sin(i) * 0.06, H2); // tentacle cables
    }
    if (neon) { glow().box(0.92, 0.03, 2.22, 0, 0.3, 0, T); g.box(0.92, 0.03, 2.22, 0, -0.3, 0, L.glow); }
    if (gold) glow().box(0.92, 0.03, 2.22, 0, 0.0, 0, T);
    rotors.push({ y: 0.72, r: 1.9 }); rotors.push({ y: 0.42, r: 0.5, z: -2.5, side: true });
  } else if (kind === 'uav' || kind === 'cuav') {
    if (kind === 'cuav') {
      body().box(0.4, 0.14, 0.4, 0, 0, 0, H);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { g.box(0.5, 0.04, 0.05, sx * 0.25, 0.02, sz * 0.25, H2, sx * sz * Math.PI / 4); g.cyl(0.04, 0.08, 6, sx * 0.4, 0.06, sz * 0.4, H2); rotors.push({ x: sx * 0.4, z: sz * 0.4, y: 0.11, r: 0.2 }); }
      plain().cyl(0.012, 0.4, 4, 0.1, 0.25, 0, 0x2a2e31); g.cyl(0.012, 0.3, 4, -0.1, 0.2, 0, 0x2a2e31);
      glow().box(0.06, 0.06, 0.06, 0.1, 0.46, 0, L.glow); g.box(0.42, 0.03, 0.42, 0, -0.08, 0, T);
    } else {
      body().box(0.22, 0.2, 1.1, 0, 0, 0, H);
      g.cone(0.11, 0.6, 0.3, 6, 0, 0, 0.68, H, 0, Math.PI / 2);
      const wing = L.decal === 'gull' ? H : H2;
      g.box(2.2, 0.04, 0.32, 0, 0.06, 0.05, wing);
      if (L.decal === 'gull') { g.box(0.5, 0.045, 0.3, 1.0, 0.06, 0.04, 0x3a3f42); g.box(0.5, 0.045, 0.3, -1.0, 0.06, 0.04, 0x3a3f42); plain().cone(0.05, 0, 0.16, 4, 0, -0.03, 0.88, 0xffa040, 0, Math.PI / 2); g.box(0.04, 0.04, 0.02, 0.07, 0.05, 0.6, 0x111111); g.box(0.04, 0.04, 0.02, -0.07, 0.05, 0.6, 0x111111); }
      body().box(0.03, 0.26, 0.24, 0.16, 0.16, -0.5, T, 0, 0, 0.5); g.box(0.03, 0.26, 0.24, -0.16, 0.16, -0.5, T, 0, 0, -0.5);
      plain().cyl(0.09, 0.08, 8, 0, -0.13, 0.2, 0x1a2328); glow().cyl(0.05, 0.02, 8, 0, -0.18, 0.2, L.glow);
      if (neon) glow().box(2.22, 0.02, 0.05, 0, 0.09, 0.2, T);
      rotors.push({ z: -0.6, y: 0, r: 0.24, side: true });
    }
  } else if (kind === 'airstrike' || kind === 'jet') {
    const manta = L.decal === 'manta';
    body().box(0.34, 0.3, 2.2, 0, 0, 0, H);
    g.cone(0.17, 0.0, 0.7, 6, 0, 0, 1.45, H, 0, Math.PI / 2);
    plain().box(0.24, 0.16, 0.6, 0, 0.18, 0.6, 0x1a2a38); // canopy
    for (const sx of [-1, 1]) {
      body().box(manta ? 1.3 : 1.0, 0.05, manta ? 1.2 : 0.9, sx * (manta ? 0.75 : 0.6), -0.02, -0.25, manta ? H2 : H, sx * (manta ? -0.55 : -0.45));
      g.box(0.05, 0.45, 0.5, sx * 0.22, 0.3, -0.9, H, 0, 0, sx * -0.35);
      g.tag(WT.att).box(0.4, 0.04, 0.08, sx * 0.9, -0.02, -0.2, T, sx * -0.5);
    }
    if (manta) { glow().box(2.3, 0.02, 0.05, 0, 0.02, -0.75, T); }
    if (L.decal === 'teeth') { for (let i = 0; i < 4; i++) plain().cone(0.035, 0, 0.09, 3, -0.11 + i * 0.075, -0.1, 1.2, 0xf4f0e4, 0, Math.PI); }
    plain().cyl(0.14, 0.12, 8, 0, 0, -1.12, 0x2a2e31, 0, Math.PI / 2);
    glow().cyl(0.11, 0.02, 8, 0, 0, -1.19, L.decal ? L.glow : 0xff9a3a, 0, Math.PI / 2);
    if (neon) glow().box(0.36, 0.02, 2.2, 0, 0.16, 0, T);
  } else if (kind === 'sentry') {
    const tiki = L.decal === 'tiki';
    for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2 + 0.5; plain().box(0.05, 0.42, 0.05, Math.cos(a) * 0.24, 0.17, Math.sin(a) * 0.24, 0x2a2e31, Math.PI / 2 - a, 0, -0.6); g.box(0.1, 0.03, 0.1, Math.cos(a) * 0.36, 0.015, Math.sin(a) * 0.36, 0x2a2e31); }
    if (tiki) {
      body().box(0.38, 0.6, 0.34, 0, 0.75, 0, H);
      g.box(0.42, 0.06, 0.36, 0, 1.08, 0, H2); g.box(0.42, 0.06, 0.36, 0, 0.47, 0, H2);
      g.box(0.3, 0.06, 0.04, 0, 0.92, 0.18, H2); // brow
      glow().box(0.08, 0.07, 0.03, 0.09, 0.85, 0.18, L.glow); g.box(0.08, 0.07, 0.03, -0.09, 0.85, 0.18, L.glow);
      plain().box(0.22, 0.1, 0.04, 0, 0.66, 0.18, 0xff6a3a); // grin
      g.box(0.04, 0.24, 0.04, 0, 1.2, 0, T); g.box(0.24, 0.04, 0.04, 0, 1.24, 0, T); // headdress
      plain().cyl(0.04, 0.4, 6, 0, 0.66, 0.36, 0x2a2e31, 0, Math.PI / 2);
    } else {
      plain().cyl(0.26, 0.08, 12, 0, 0.36, 0, 0x2a2e31); // turntable
      body().box(0.46, 0.26, 0.5, 0, 0.53, -0.02, H); // receiver
      g.sphere(0.2, 0, 0.66, -0.06, H2, 1.1, 0.7, 1.2, 10, 6); // armoured dome
      plain().box(0.1, 0.12, 0.08, 0, 0.66, 0.2, 0x1a2328); glow().box(0.07, 0.05, 0.02, 0, 0.67, 0.245, L.glow); // sensor eye
      plain().cyl(0.035, 0.46, 6, 0.09, 0.52, 0.42, 0x2a2e31, 0, Math.PI / 2); g.cyl(0.035, 0.46, 6, -0.09, 0.52, 0.42, 0x2a2e31, 0, Math.PI / 2);
      g.cyl(0.05, 0.08, 6, 0.09, 0.52, 0.64, 0x2a2e31, 0, Math.PI / 2); g.cyl(0.05, 0.08, 6, -0.09, 0.52, 0.64, 0x2a2e31, 0, Math.PI / 2);
      g.box(0.12, 0.22, 0.26, 0.3, 0.5, -0.04, 0x3a4246); g.tag(WT.att).box(0.13, 0.04, 0.27, 0.3, 0.5, -0.04, T); // ammo box
      g.tag(WT.att).box(0.48, 0.05, 0.52, 0, 0.42, -0.02, T); // trim band
      for (let i = 0; i < 4; i++) g.tag(WT.att).box(0.04, 0.04, 0.03, -0.15 + i * 0.1, 0.48, 0.24, 0xf2c230); // hazard dots
      if (neon) glow().box(0.48, 0.02, 0.52, 0, 0.66, -0.02, T);
    }
  } else { // care package
    body().box(0.7, 0.55, 0.7, 0, 0.28, 0, H);
    plain().box(0.72, 0.08, 0.72, 0, 0.04, 0, gold ? 0x1c1a17 : 0x2a2e31); g.box(0.72, 0.08, 0.72, 0, 0.52, 0, gold ? 0x1c1a17 : 0x2a2e31);
    g.tag(gold ? WT.gold : WT.att).box(0.12, 0.57, 0.72, 0, 0.28, 0, T); g.box(0.72, 0.57, 0.12, 0, 0.28, 0, T);
    glow().box(0.1, 0.06, 0.02, 0.2, 0.42, 0.36, L.glow);
    if (neon) glow().box(0.74, 0.02, 0.74, 0, 0.3, 0, T);
  }
  const res = { geo: g.build({ ao: false }), rotors };
  res.geo.userData.shared = true;
  STREAK_GEO.set(key, res);
  return res;
}
let _rotorGeo = null, _rotorMat = null;
/** A skinned killstreak model. kind: gunship | uav | cuav | airstrike | sentry | care. */
export function buildStreakModel(kind, id = 'default') {
  const S = streakGeo(kind === 'jet' ? 'airstrike' : kind, STREAK_LOOK[id] ? id : 'default');
  const grp = new THREE.Group();
  const m = new THREE.Mesh(S.geo, propMaterial()); m.castShadow = true;
  grp.add(m);
  if (!_rotorGeo) { _rotorGeo = new THREE.CircleGeometry(1, 24); _rotorGeo.rotateX(-Math.PI / 2); _rotorGeo.userData.shared = true; _rotorMat = new THREE.MeshBasicMaterial({ color: 0x1a1e20, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }); _rotorMat.userData.shared = true; }
  grp.userData.rotors = [];
  for (const r of S.rotors) {
    const d = new THREE.Mesh(_rotorGeo, _rotorMat);
    d.scale.setScalar(r.r); d.position.set(r.x || 0, r.y || 0, r.z || 0);
    if (r.side) d.rotation.z = Math.PI / 2;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(r.r * 2, 0.02, 0.06), propMaterial());
    blade.position.copy(d.position); if (r.side) blade.rotation.z = Math.PI / 2;
    grp.add(d, blade);
    grp.userData.rotors.push({ disc: d, blade, side: !!r.side });
  }
  grp.userData.kind = kind; grp.userData.skin = id;
  return grp;
}
/** Spin rotors / bob a model from buildStreakModel. */
export function tickStreakModel(grp, t) {
  for (const r of grp.userData.rotors || []) {
    if (r.side) r.blade.rotation.x = t * 40; else r.blade.rotation.y = t * 30;
  }
}
