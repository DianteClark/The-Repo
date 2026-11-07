// Ambient life around the diorama: a flock of gulls wheeling over the
// island (one instanced draw, wing flap in the vertex shader), marker buoys
// bobbing offshore with blinking lamps, and flotsam drifting in the shallows
// off the coast. All per-frame work writes into preallocated objects.

import * as THREE from 'three';
import { GeoBuilder, rng } from './util.js';
import { P } from './palette.js';
import { WATER_Y } from './fields.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _e = new THREE.Euler();

function gullGeometry() {
  // body + two wings (wings are flapped in the shader by |x|)
  const g = new GeoBuilder();
  g.box(0.07, 0.06, 0.26, 0, 0, 0, 0xeee8da);
  g.box(0.05, 0.05, 0.06, 0, 0.02, 0.15, 0xeee8da);
  g.box(0.02, 0.015, 0.05, 0, 0.015, 0.2, 0xd9a441); // beak
  g.box(0.36, 0.012, 0.13, 0.21, 0.01, -0.01, 0xf3efe4, -0.12);
  g.box(0.36, 0.012, 0.13, -0.21, 0.01, -0.01, 0xf3efe4, 0.12);
  g.box(0.1, 0.014, 0.1, 0.36, 0.012, -0.03, 0x3a3f42, -0.2); // dark wing tips
  g.box(0.1, 0.014, 0.1, -0.36, 0.012, -0.03, 0x3a3f42, 0.2);
  g.box(0.08, 0.012, 0.08, 0, 0.0, -0.17, 0xe2dccd); // tail
  return g.build({ ao: false });
}

export class Ambient {
  constructor(world, S, seed, high) {
    this.S = S;
    const r = rng((seed ^ 0x9a11) >>> 0);
    this.group = new THREE.Group();
    world.add(this.group);
    // ---- gulls
    const N = 12;
    const geo = gullGeometry();
    const phase = new Float32Array(N);
    for (let i = 0; i < N; i++) phase[i] = r() * 20;
    geo.setAttribute('aPh', new THREE.InstancedBufferAttribute(phase, 1));
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.gullU = { uT: { value: 0 }, uFlap: { value: 1 } };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.gullU);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPh;\nuniform float uT;\nuniform float uFlap;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float ax = abs(position.x);
          float glide = smoothstep(0.2, 0.8, sin(uT * 0.7 + aPh * 1.3));
          float fl = sin(uT * 11.0 + aPh) * (1.0 - glide * 0.85) * uFlap;
          transformed.y += ax * fl * 0.9 + ax * 0.12;`);
    };
    mat.customProgramCacheKey = () => 'tf-gull';
    this.gulls = new THREE.InstancedMesh(geo, mat, N);
    this.gulls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.gulls.frustumCulled = false;
    this.group.add(this.gulls);
    this.birds = [];
    for (let i = 0; i < N; i++) {
      const flock = i < 7 ? 0 : 1;
      this.birds.push({
        cx: (flock ? -1 : 1) * S * (0.12 + r() * 0.15), cz: (r() - 0.5) * S * 0.5,
        rad: 4 + r() * (S * 0.3), h: 5 + r() * 4, w: (0.12 + r() * 0.12) * (r() < 0.3 ? -1 : 1), a0: r() * 6.28,
        bob: r() * 6.28, s: 0.5 + r() * 0.22,
      });
    }
    // ---- bobbing buoys with lamps + flotsam just off the island
    const bb = new GeoBuilder();
    bb.cyl(0.3, 0.5, 8, 0, 0.0, 0, P.rust);
    bb.cyl(0.32, 0.12, 8, 0, 0.2, 0, P.bone);
    bb.cone(0.16, 0.25, 0.7, 6, 0, 0.6, 0, P.steelDark);
    bb.box(0.04, 0.3, 0.3, 0, 0.75, 0, P.rust2);
    const buoyGeo = bb.build({ ao: false });
    const buoyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0xfff1cc, toneMapped: false });
    const lampGeo = new THREE.SphereGeometry(0.07, 8, 6);
    this.floaters = [];
    const half = S / 2;
    const place = (out) => {
      const side = (r() * 4) | 0, along = (r() - 0.5) * (S + 4);
      return [side === 0 ? half + out : side === 1 ? -half - out : along, side === 2 ? half + out : side === 3 ? -half - out : along];
    };
    for (let i = 0; i < 4; i++) {
      const [x, z] = place(3 + r() * 5);
      const m = new THREE.Mesh(buoyGeo, buoyMat);
      const lamp = new THREE.Mesh(lampGeo, this.lampMat.clone());
      lamp.position.y = 0.98;
      m.add(lamp);
      m.position.set(x, WATER_Y, z);
      this.group.add(m);
      this.floaters.push({ m, lamp, x, z, ph: r() * 6.28, amp: 0.08, tilt: 0.12, blink: r() * 3 });
    }
    const fb = new GeoBuilder();
    fb.box(0.7, 0.08, 0.14, 0, 0, 0, P.wood2, 0.3); // plank
    fb.box(0.5, 0.07, 0.12, 0.1, 0.02, 0.15, P.wood, -0.5);
    const flot1 = fb.build({ ao: false });
    const fb2 = new GeoBuilder();
    fb2.cyl(0.13, 0.36, 8, 0, 0, 0, P.teal, 0, Math.PI / 2, 0.4); // floating barrel
    const flot2 = fb2.build({ ao: false });
    const fb3 = new GeoBuilder();
    fb3.box(0.4, 0.06, 0.4, 0, 0, 0, P.wood, 0.4); fb3.box(0.08, 0.06, 0.4, 0.15, 0.04, 0, P.wood2, 0.4); // pallet
    const flot3 = fb3.build({ ao: false });
    const flots = [flot1, flot2, flot3];
    for (let i = 0; i < 9; i++) {
      const [x, z] = place(0.8 + r() * 3.5);
      const m = new THREE.Mesh(flots[i % 3], buoyMat);
      m.position.set(x, WATER_Y, z);
      m.rotation.y = r() * 6.28;
      this.group.add(m);
      this.floaters.push({ m, lamp: null, x, z, ph: r() * 6.28, amp: 0.035, tilt: 0.08, blink: 0, drift: (r() - 0.5) * 0.05 });
    }
    this.setQuality(high);
  }

  setQuality(high) { this.gulls.count = high ? this.birds.length : 6; }

  update(dt, t, storm) {
    this.gullU.uT.value = t;
    this.gullU.uFlap.value = 1 + storm * 0.6;
    const n = this.gulls.count;
    for (let i = 0; i < n; i++) {
      const b = this.birds[i];
      const a = b.a0 + t * b.w;
      // storms push the flock lower and wider
      const rad = b.rad * (1 + storm * 0.25);
      _p.set(b.cx + Math.cos(a) * rad, b.h - storm * 1.5 + Math.sin(t * 0.5 + b.bob) * 0.4, b.cz + Math.sin(a) * rad);
      const dir = b.w > 0 ? 1 : -1;
      // heading = tangent of the circle; bank into the turn
      _e.set(0, Math.atan2(-Math.sin(a) * dir, Math.cos(a) * dir), -0.35 * dir, 'YXZ');
      _q.setFromEuler(_e);
      _s.setScalar(b.s);
      _m.compose(_p, _q, _s);
      this.gulls.setMatrixAt(i, _m);
    }
    this.gulls.instanceMatrix.needsUpdate = true;
    const sea = 1 + storm * 2.2;
    for (const f of this.floaters) {
      const ph = t * 1.3 + f.ph;
      f.m.position.y = WATER_Y - 0.06 + Math.sin(ph) * f.amp * sea;
      f.m.rotation.x = Math.sin(ph * 0.8) * f.tilt * sea;
      f.m.rotation.z = Math.cos(ph * 0.7) * f.tilt * sea;
      if (f.drift) f.m.rotation.y += f.drift * dt;
      if (f.lamp) f.lamp.visible = ((t + f.blink) % 2.4) < 0.35;
    }
  }
}
