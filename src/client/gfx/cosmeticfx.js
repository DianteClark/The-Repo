// 3.0 cosmetic effects: kill effects (played on the victim when the cosmetic's
// owner gets the kill) and drop-in arrivals (match start). Everything rides
// on a Fx instance (particles, rings, lights, timed tweens) plus a few pooled
// meshes, so the same code drives the match renderer and the shop previews.
//
// Kill effects: tidal, ember, kelp, coins, glitch, lightning, ink ('default' = none).
// Drop-ins: default (transport hop), parachute, boat, grapple, breach, orbital, gulls.

import * as THREE from 'three';
import { GeoBuilder, clamp, easeOutCubic, easeInOutCubic, lerp } from './util.js';
import { P } from './palette.js';
import { gullGeometry } from './ambient.js';
import { makeChute } from './pickups.js';

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
  A = {
    coinGeo, coinMat, voxGeo, voxMat, beamGeo, colGeo, frondGeo, plantMat, tentGeo, inkMat, boatGeo, shipGeo, rotorGeo, rotorMat, vcMat, ropeGeo, ropeMat, gullGeo, gullMat,
    waterMat: glowMat(0x2f9fa8, 0.35), beamMat: glowMat(0xd8d0ff, 0.6), boltMat: glowMat(0xdfe6ff, 1),
  };
  for (const k of ['waterMat', 'beamMat', 'boltMat']) A[k].userData.shared = true;
  return A;
}

const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

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
    const fx = this.fx, a = assets(), H = opts.h ?? 1;
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
}
