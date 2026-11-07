// Low-poly soldiers with class silhouettes and procedural animation:
// idle breathing, walk cycle, recoil, hit flinch + flash, hunker, death fall.
//   Assault  — backpack with bedroll, mid rifle.
//   Marksman — slim, tall radio antenna, long scoped rifle.
//   Breacher — bulky, big rusted door-shield, stubby shotgun.

import * as THREE from 'three';
import { GeoBuilder, damp, clamp } from './util.js';
import { TEAM } from './palette.js';

const BODY = {
  assault: { cloth: 0x86a3a6, vest: 0x56706f, helm: 0x6d8a88, w: 0.3 },
  marksman: { cloth: 0xa7a07a, vest: 0x6f6a4b, helm: 0x8a8462, w: 0.26 },
  breacher: { cloth: 0x7d879a, vest: 0x4e5566, helm: 0x666f80, w: 0.38 },
};
const SKIN = 0xd9b896, DARK = 0x33393c, METAL = 0x69737a, BOOT = 0x3a3330;
export const HIP = 0.4;

const GEO = new Map();
function geos(cls) {
  if (GEO.has(cls)) return GEO.get(cls);
  const B = BODY[cls];
  const w = B.w;
  // Leg (pivot at hip, extends down)
  const leg = new GeoBuilder()
    .box(0.11, 0.3, 0.13, 0, -0.17, 0, B.cloth)
    .box(0.12, 0.1, 0.17, 0, -0.35, 0.02, BOOT)
    .box(0.12, 0.08, 0.04, 0, -0.12, 0.07, B.vest)
    .build({ ao: false });
  // Torso (pivot at hip)
  const t = new GeoBuilder();
  t.box(w * 0.85, 0.1, 0.2, 0, 0.04, 0, B.vest); // belt
  t.box(w, 0.3, 0.22, 0, 0.23, 0, B.cloth);
  t.box(w * 0.92, 0.22, 0.24, 0, 0.25, 0.005, B.vest); // plate carrier
  t.box(0.07, 0.06, 0.03, -w * 0.25, 0.2, 0.13, DARK); // pouches
  t.box(0.07, 0.06, 0.03, w * 0.05, 0.2, 0.13, DARK);
  t.box(0.09, 0.06, 0.09, 0, 0.4, 0, SKIN); // neck
  // head + helmet
  t.sphere(0.105, 0, 0.49, 0.01, SKIN, 1, 1.05, 1, 8, 6);
  t.sphere(0.125, 0, 0.53, -0.005, B.helm, 1.05, 0.8, 1.1, 8, 5);
  t.box(0.27, 0.025, 0.27, 0, 0.5, -0.01, B.helm);
  if (cls === 'assault') {
    t.box(0.26, 0.3, 0.14, 0, 0.26, -0.18, 0x3b4a3f); // backpack
    t.cyl(0.06, 0.28, 7, 0, 0.44, -0.18, 0x6c6150, 0, 0, Math.PI / 2); // bedroll
    t.box(0.1, 0.12, 0.05, 0.1, 0.18, -0.26, DARK);
  } else if (cls === 'marksman') {
    t.box(0.18, 0.22, 0.1, -0.03, 0.26, -0.16, 0x3c3a2c); // radio
    t.cyl(0.012, 0.78, 4, -0.09, 0.72, -0.19, DARK); // antenna
    t.box(0.3, 0.2, 0.04, 0, 0.42, -0.08, 0x5b583f, 0, 0.25); // hood/cape
  } else {
    t.box(w * 1.05, 0.12, 0.26, 0, 0.36, 0, METAL); // heavy collar
    t.box(0.2, 0.18, 0.1, 0, 0.24, -0.17, DARK);
  }
  const torso = t.build({ ao: false });
  // Team accents (shoulders, helmet stripe, visor, + class beacons)
  const a = new GeoBuilder();
  const sw = cls === 'breacher' ? 0.13 : 0.1;
  a.box(sw, 0.07, 0.17, -w / 2 - 0.02, 0.35, 0, 0xffffff, 0, 0, 0.2);
  a.box(sw, 0.07, 0.17, w / 2 + 0.02, 0.35, 0, 0xffffff, 0, 0, -0.2);
  a.box(0.2, 0.045, 0.06, 0, 0.5, 0.1, 0xffffff); // visor
  a.box(0.03, 0.02, 0.24, 0, 0.635, -0.01, 0xffffff); // helmet stripe
  if (cls === 'marksman') a.sphere(0.028, -0.09, 1.11, -0.19, 0xffffff, 1, 1, 1, 6, 4);
  if (cls === 'assault') a.box(0.2, 0.025, 0.02, 0, 0.36, -0.252, 0xffffff);
  const accent = a.build({ ao: false });
  // Arms + weapon (pivot at shoulder: torso-local y = 0.33)
  const g = new GeoBuilder();
  g.box(0.08, 0.08, 0.26, w / 2 + 0.02, -0.08, 0.08, B.cloth, 0, 0.5); // right upper arm
  g.box(0.08, 0.08, 0.24, -w / 2 - 0.0, -0.08, 0.1, B.cloth, 0.35, 0.4); // left arm
  g.box(0.07, 0.07, 0.07, 0.08, -0.13, 0.25, SKIN);
  let muzzleZ;
  if (cls === 'assault') {
    g.box(0.06, 0.09, 0.42, 0.09, -0.1, 0.32, DARK);
    g.box(0.05, 0.12, 0.06, 0.09, -0.18, 0.3, METAL); // mag
    g.box(0.05, 0.07, 0.14, 0.09, -0.12, 0.08, METAL); // stock
    g.box(0.03, 0.03, 0.12, 0.09, -0.07, 0.56, METAL); // barrel
    muzzleZ = 0.62;
  } else if (cls === 'marksman') {
    g.box(0.05, 0.07, 0.7, 0.09, -0.1, 0.4, DARK);
    g.cyl(0.03, 0.2, 6, 0.09, -0.03, 0.3, METAL, 0, Math.PI / 2);
    g.box(0.05, 0.08, 0.16, 0.09, -0.13, 0.04, 0x5b4a36); // stock
    g.box(0.025, 0.025, 0.2, 0.09, -0.09, 0.82, METAL);
    muzzleZ = 0.92;
  } else {
    g.box(0.08, 0.1, 0.36, 0.11, -0.12, 0.28, DARK);
    g.cyl(0.035, 0.18, 6, 0.11, -0.1, 0.5, METAL, 0, Math.PI / 2);
    g.box(0.07, 0.06, 0.16, 0.11, -0.16, 0.36, 0x5b4a36); // pump
    muzzleZ = 0.6;
    // door-shield on the left arm
    g.box(0.56, 0.7, 0.05, -0.1, -0.13, 0.32, 0x9a8a72, -0.15);
    g.box(0.5, 0.62, 0.012, -0.1, -0.14, 0.35, 0xb0582f, -0.15); // rusted skin
    g.box(0.32, 0.1, 0.02, -0.1, 0.07, 0.357, 0x1a2328, -0.15); // window slit
    g.box(0.5, 0.05, 0.07, -0.1, -0.47, 0.32, METAL, -0.15);
    g.box(0.05, 0.62, 0.07, -0.37, -0.13, 0.36, METAL, -0.15);
    g.box(0.05, 0.62, 0.07, 0.17, -0.13, 0.28, METAL, -0.15);
  }
  const arms = g.build({ ao: false });
  const res = { leg, torso, accent, arms, muzzleZ };
  GEO.set(cls, res);
  return res;
}

let ringGeo = null, ring2Geo = null, blobGeo = null, coneGeo = null;
function sharedGeos() {
  if (ringGeo) return;
  ringGeo = new THREE.RingGeometry(0.34, 0.42, 32); ringGeo.rotateX(-Math.PI / 2);
  ring2Geo = new THREE.RingGeometry(0.47, 0.51, 32); ring2Geo.rotateX(-Math.PI / 2);
  blobGeo = new THREE.CircleGeometry(0.4, 20); blobGeo.rotateX(-Math.PI / 2);
  coneGeo = new THREE.CircleGeometry(3.2, 24, Math.PI / 2 - 0.55, 1.1); coneGeo.rotateX(-Math.PI / 2);
}
const blobMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false });
const coneMat = new THREE.MeshBasicMaterial({ color: TEAM.cyan, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });

export class SoldierView {
  constructor(u, mine) {
    sharedGeos();
    const G = geos(u.cls);
    this.cls = u.cls;
    const team = mine ? TEAM.amber : TEAM.magenta;
    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05, emissive: 0xffffff, emissiveIntensity: 0 });
    this.accentMat = new THREE.MeshStandardMaterial({ color: team, emissive: team, emissiveIntensity: 0.45, roughness: 0.5 });
    this.ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(team).multiplyScalar(1.6), transparent: true, opacity: 0.95, depthWrite: false });

    const root = (this.root = new THREE.Group());
    const pose = (this.pose = new THREE.Group());
    root.add(pose);
    const mk = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; return m; };
    this.legL = mk(G.leg, this.bodyMat); this.legL.position.set(-0.08, HIP, 0);
    this.legR = mk(G.leg, this.bodyMat); this.legR.position.set(0.08, HIP, 0);
    this.torso = new THREE.Group(); this.torso.position.y = HIP;
    this.torso.add(mk(G.torso, this.bodyMat), mk(G.accent, this.accentMat));
    this.arms = new THREE.Group(); this.arms.position.y = 0.33;
    this.arms.add(mk(G.arms, this.bodyMat));
    this.muzzle = new THREE.Object3D(); this.muzzle.position.set(cls1(u.cls), -0.09, G.muzzleZ);
    this.arms.add(this.muzzle);
    this.torso.add(this.arms);
    pose.add(this.legL, this.legR, this.torso);

    this.blob = new THREE.Mesh(blobGeo, blobMat); this.blob.position.y = 0.015; this.blob.renderOrder = 2;
    this.ring = new THREE.Mesh(ringGeo, this.ringMat); this.ring.position.y = 0.03; this.ring.renderOrder = 3;
    root.add(this.blob, this.ring);
    if (u.isLoneWolf) {
      this.ring2 = new THREE.Mesh(ring2Geo, this.ringMat); this.ring2.position.y = 0.03; this.ring2.renderOrder = 3;
      root.add(this.ring2);
    }
    this.cone = new THREE.Mesh(coneGeo, coneMat); this.cone.position.y = 0.05; this.cone.visible = false; this.cone.renderOrder = 3;
    root.add(this.cone);
    root.userData.unitId = u.id;

    this.phase = Math.random() * 10;
    this.walk = 0; this.walkGoal = 0; this.walkPhase = 0;
    this.recoil = 0; this.flinch = 0; this.flash = 0;
    this.hunk = 0; this.hunkGoal = u.hunkered ? 1 : 0;
    this.dead = false; this.deathT = 0;
    this.yawGoal = null;
    this.aim = 0; this.aimGoal = 0;
  }

  get position() { return this.root.position; }

  faceTo(wx, wz, instant) {
    const p = this.root.position;
    if (Math.abs(wx - p.x) + Math.abs(wz - p.z) < 1e-4) return;
    const y = Math.atan2(wx - p.x, wz - p.z);
    if (instant) { this.root.rotation.y = y; this.yawGoal = null; } else this.yawGoal = y;
  }

  setOverwatch(on) { this.cone.visible = on; }
  setHunker(on) { this.hunkGoal = on ? 1 : 0; }
  doRecoil(k = 1) { this.recoil = k; }
  doFlinch(k = 1) { this.flinch = k; this.flash = k; }
  die() { this.dead = true; this.deathT = 0; this.cone.visible = false; this.hunkGoal = 0; }
  revive() {
    this.dead = false; this.deathT = 0;
    this.pose.rotation.set(0, 0, 0); this.pose.position.set(0, 0, 0);
    this.root.visible = true;
    this.ring.visible = true; this.blob.visible = true;
    if (this.ring2) this.ring2.visible = true;
  }

  update(dt, t) {
    const r = this.root;
    if (this.yawGoal !== null) {
      let d = this.yawGoal - r.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      r.rotation.y += d * damp(16, dt);
      if (Math.abs(d) < 0.002) this.yawGoal = null;
    }
    this.walk += (this.walkGoal - this.walk) * damp(14, dt);
    this.hunk += (this.hunkGoal - this.hunk) * damp(9, dt);
    this.recoil = Math.max(0, this.recoil - dt * 4.5);
    this.flinch = Math.max(0, this.flinch - dt * 3.2);
    this.flash = Math.max(0, this.flash - dt * 5);
    this.aim += (this.aimGoal - this.aim) * damp(10, dt);
    this.bodyMat.emissiveIntensity = this.flash * 1.4;

    const p = this.pose;
    if (this.dead) {
      this.deathT += dt;
      const k = clamp(this.deathT / 0.55, 0, 1);
      // fall backwards with a small bounce
      const fall = k < 1 ? k * k : 1;
      const bounce = this.deathT > 0.55 ? Math.sin(clamp((this.deathT - 0.55) / 0.25, 0, 1) * Math.PI) * 0.12 : 0;
      p.rotation.x = -(Math.PI / 2 - 0.08) * fall + bounce;
      p.position.y = 0.06 * fall;
      p.position.z = -0.12 * fall;
      this.torso.rotation.x = 0.25 * fall;
      this.arms.rotation.x = -1.6 * fall;
      this.arms.rotation.z = 0.3 * fall;
      this.legL.rotation.x = 0.35 * fall; this.legR.rotation.x = -0.15 * fall;
      this.legL.rotation.z = -0.2 * fall; this.legR.rotation.z = 0.25 * fall;
      this.ring.visible = false; this.blob.visible = false;
      if (this.ring2) this.ring2.visible = false;
      return;
    }
    const ph = t * 2.1 + this.phase;
    // walk cycle
    if (this.walk > 0.01 || this.walkGoal) this.walkPhase += dt * 15;
    const sw = Math.sin(this.walkPhase) * 0.75 * this.walk;
    const bob = Math.abs(Math.cos(this.walkPhase)) * 0.045 * this.walk;
    const hk = this.hunk;
    this.legL.rotation.x = sw - hk * 1.05;
    this.legR.rotation.x = -sw - hk * 0.35;
    this.legL.scale.y = 1 - hk * 0.18; this.legR.scale.y = 1 - hk * 0.3;
    p.position.y = bob - hk * 0.13;
    p.position.z = 0;
    p.rotation.x = 0;
    const breath = Math.sin(ph) * 0.012;
    this.torso.scale.set(1 + breath * 0.5, 1 + breath, 1 + breath * 0.5);
    this.torso.position.y = HIP;
    this.torso.rotation.x = 0.06 * this.walk + hk * 0.45 - this.recoil * 0.12 - this.flinch * 0.35;
    this.torso.rotation.z = Math.sin(this.walkPhase * 0.5) * 0.04 * this.walk + Math.sin(t * 40) * this.flinch * 0.05;
    const guard = this.cls === 'breacher' ? hk * 0.5 : hk * 0.2;
    this.arms.rotation.x = Math.sin(ph * 0.5) * 0.02 - this.recoil * 0.45 + this.flinch * 0.3 - guard - this.aim * 0.05 + this.walk * 0.1;
    this.arms.rotation.z = 0;
    this.arms.position.z = -this.recoil * 0.05;
  }

  dispose() { this.bodyMat.dispose(); this.accentMat.dispose(); this.ringMat.dispose(); }
}

function cls1(cls) { return cls === 'breacher' ? 0.11 : 0.09; }
