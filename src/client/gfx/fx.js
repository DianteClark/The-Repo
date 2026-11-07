// Pooled effects: GPU-billboard particles (additive + alpha), physical debris,
// tracers, shockwave rings, flash lights, scorch decals and floating text.
// Per-frame updates write into preallocated typed arrays (no allocations).

import * as THREE from 'three';
import { clamp, easeOutBack, easeOutCubic, roundRect } from './util.js';
import { WATER_Y } from './fields.js';

const PVERT = /* glsl */`
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iCol;
attribute vec3 iSz; // size, stretch, softness
varying vec2 vUv;
varying vec4 vCol;
varying float vSoft;
void main() {
  vUv = position.xy + 0.5;
  vCol = iCol;
  vSoft = iSz.z;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  vec2 q = position.xy;
  float s = iSz.x;
  vec2 off = q * s;
  if (iSz.y > 0.0) {
    vec2 d = (modelViewMatrix * vec4(iVel, 0.0)).xy;
    float L = length(d);
    if (L > 1e-4) {
      d /= L;
      vec2 n = vec2(-d.y, d.x);
      off = d * q.y * (s + L * iSz.y) + n * q.x * s;
    }
  }
  mv.xy += off;
  gl_Position = projectionMatrix * mv;
}`;
const PFRAG = /* glsl */`
uniform vec3 uTint;
varying vec2 vUv;
varying vec4 vCol;
varying float vSoft;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float a = clamp(1.0 - r, 0.0, 1.0);
  a = pow(a, vSoft);
  if (a <= 0.003) discard;
  gl_FragColor = vec4(vCol.rgb * uTint, vCol.a * a);
}`;

class Particles {
  constructor(cap, blending) {
    this.cap = cap;
    this.n = 0;
    const F = (k) => new Float32Array(cap * k);
    this.p = F(3); this.v = F(3); this.c = F(4); this.s = F(4); // size0,size1,stretch,soft
    this.life = F(1); this.max = F(1); this.drag = F(1); this.grav = F(1);
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    this.aPos = new THREE.InstancedBufferAttribute(F(3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.InstancedBufferAttribute(F(3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(F(4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aSz = new THREE.InstancedBufferAttribute(F(3), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iVel', this.aVel);
    geo.setAttribute('iCol', this.aCol);
    geo.setAttribute('iSz', this.aSz);
    geo.instanceCount = 0;
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTint: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: PVERT, fragmentShader: PFRAG, transparent: true, depthWrite: false, blending,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = blending === THREE.AdditiveBlending ? 6 : 5;
  }

  spawn(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, drag = 1, grav = 0, stretch = 0, soft = 1.5) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.c[i * 4] = r; this.c[i * 4 + 1] = g; this.c[i * 4 + 2] = b; this.c[i * 4 + 3] = a;
    this.s[i * 4] = s0; this.s[i * 4 + 1] = s1; this.s[i * 4 + 2] = stretch; this.s[i * 4 + 3] = soft;
    this.life[i] = 0; this.max[i] = life; this.drag[i] = drag; this.grav[i] = grav;
  }

  _kill(i) {
    const j = --this.n;
    if (i === j) return;
    for (let k = 0; k < 3; k++) { this.p[i * 3 + k] = this.p[j * 3 + k]; this.v[i * 3 + k] = this.v[j * 3 + k]; }
    for (let k = 0; k < 4; k++) { this.c[i * 4 + k] = this.c[j * 4 + k]; this.s[i * 4 + k] = this.s[j * 4 + k]; }
    this.life[i] = this.life[j]; this.max[i] = this.max[j]; this.drag[i] = this.drag[j]; this.grav[i] = this.grav[j];
  }

  update(dt) {
    const P = this.aPos.array, V = this.aVel.array, C = this.aCol.array, Z = this.aSz.array;
    for (let i = this.n - 1; i >= 0; i--) {
      this.life[i] += dt;
      if (this.life[i] >= this.max[i]) { this._kill(i); continue; }
    }
    for (let i = 0; i < this.n; i++) {
      const t = this.life[i] / this.max[i];
      const dr = Math.exp(-this.drag[i] * dt);
      const i3 = i * 3, i4 = i * 4;
      this.v[i3] *= dr; this.v[i3 + 2] *= dr;
      this.v[i3 + 1] = this.v[i3 + 1] * dr - this.grav[i] * dt;
      this.p[i3] += this.v[i3] * dt; this.p[i3 + 1] += this.v[i3 + 1] * dt; this.p[i3 + 2] += this.v[i3 + 2] * dt;
      if (this.grav[i] > 0 && this.p[i3 + 1] < 0.02) { this.p[i3 + 1] = 0.02; this.v[i3 + 1] *= -0.3; this.v[i3] *= 0.6; this.v[i3 + 2] *= 0.6; }
      P[i3] = this.p[i3]; P[i3 + 1] = this.p[i3 + 1]; P[i3 + 2] = this.p[i3 + 2];
      V[i3] = this.v[i3] * 0.05; V[i3 + 1] = this.v[i3 + 1] * 0.05; V[i3 + 2] = this.v[i3 + 2] * 0.05;
      const fade = Math.min(1, t * 12) * (1 - t) * (1 - t * 0.3);
      C[i4] = this.c[i4]; C[i4 + 1] = this.c[i4 + 1]; C[i4 + 2] = this.c[i4 + 2]; C[i4 + 3] = this.c[i4 + 3] * fade;
      Z[i3] = this.s[i4] + (this.s[i4 + 1] - this.s[i4]) * easeOutCubic(t);
      Z[i3 + 1] = this.s[i4 + 2]; Z[i3 + 2] = this.s[i4 + 3];
    }
    this.geo.instanceCount = this.n;
    if (this.n) {
      this.aPos.needsUpdate = this.aVel.needsUpdate = this.aCol.needsUpdate = this.aSz.needsUpdate = true;
      this.aPos.clearUpdateRanges(); this.aPos.addUpdateRange(0, this.n * 3);
      this.aVel.clearUpdateRanges(); this.aVel.addUpdateRange(0, this.n * 3);
      this.aCol.clearUpdateRanges(); this.aCol.addUpdateRange(0, this.n * 4);
      this.aSz.clearUpdateRanges(); this.aSz.addUpdateRange(0, this.n * 3);
    }
  }
}

class Debris {
  constructor(cap) {
    this.cap = cap; this.n = 0;
    const F = (k) => new Float32Array(cap * k);
    this.p = F(3); this.v = F(3); this.r = F(3); this.w = F(3); this.sz = F(3); this.life = F(1); this.max = F(1);
    this.col = F(3);
    this.arrs = [this.p, this.v, this.r, this.w, this.sz, this.col];
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.setColorAt(0, new THREE.Color());
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler();
    this._v = new THREE.Vector3(); this._s = new THREE.Vector3(); this._c = new THREE.Color();
    this.onSplash = null;
  }
  spawn(x, y, z, vx, vy, vz, s, color, life = 3.2) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    const i3 = i * 3, R = Math.random;
    this.p[i3] = x; this.p[i3 + 1] = y; this.p[i3 + 2] = z;
    this.v[i3] = vx; this.v[i3 + 1] = vy; this.v[i3 + 2] = vz;
    this.r[i3] = R() * 6; this.r[i3 + 1] = R() * 6; this.r[i3 + 2] = R() * 6;
    this.w[i3] = (R() - 0.5) * 18; this.w[i3 + 1] = (R() - 0.5) * 18; this.w[i3 + 2] = (R() - 0.5) * 18;
    this.sz[i3] = s * (0.6 + R() * 0.8); this.sz[i3 + 1] = s * (0.4 + R() * 0.6); this.sz[i3 + 2] = s * (0.6 + R() * 0.8);
    this._c.set(color).offsetHSL(0, 0, (R() - 0.5) * 0.1);
    this.col[i3] = this._c.r; this.col[i3 + 1] = this._c.g; this.col[i3 + 2] = this._c.b;
    this.life[i] = 0; this.max[i] = life * (0.8 + Math.random() * 0.4);
  }
  update(dt, floodedAt) {
    for (let i = this.n - 1; i >= 0; i--) {
      this.life[i] += dt;
      if (this.life[i] < this.max[i]) continue;
      const j = --this.n;
      if (i !== j) {
        for (let q = 0; q < 6; q++) { const a = this.arrs[q]; a[i * 3] = a[j * 3]; a[i * 3 + 1] = a[j * 3 + 1]; a[i * 3 + 2] = a[j * 3 + 2]; }
        this.life[i] = this.life[j]; this.max[i] = this.max[j];
      }
    }
    const { p, v, r, w } = this;
    for (let i = 0; i < this.n; i++) {
      const i3 = i * 3;
      const wet = floodedAt ? floodedAt(p[i3], p[i3 + 2]) : false;
      const floor = wet ? -0.2 : 0.02;
      v[i3 + 1] -= (wet && p[i3 + 1] < WATER_Y ? 3 : 14) * dt;
      p[i3] += v[i3] * dt; p[i3 + 1] += v[i3 + 1] * dt; p[i3 + 2] += v[i3 + 2] * dt;
      if (wet && p[i3 + 1] < WATER_Y && v[i3 + 1] < -2) {
        if (this.onSplash) this.onSplash(p[i3], p[i3 + 2]);
        v[i3 + 1] *= 0.15; v[i3] *= 0.3; v[i3 + 2] *= 0.3;
      }
      if (p[i3 + 1] < floor) {
        p[i3 + 1] = floor;
        if (v[i3 + 1] < -1) { v[i3 + 1] *= -0.32; w[i3] *= 0.5; w[i3 + 2] *= 0.5; } else v[i3 + 1] = 0;
        v[i3] *= 0.7; v[i3 + 2] *= 0.7;
        if (Math.abs(v[i3 + 1]) < 0.3) { w[i3] *= 0.8; w[i3 + 1] *= 0.8; w[i3 + 2] *= 0.8; }
      }
      r[i3] += w[i3] * dt; r[i3 + 1] += w[i3 + 1] * dt; r[i3 + 2] += w[i3 + 2] * dt;
      const t = this.life[i] / this.max[i];
      const k = t > 0.8 ? 1 - (t - 0.8) / 0.2 : 1;
      this._e.set(r[i3], r[i3 + 1], r[i3 + 2]);
      this._q.setFromEuler(this._e);
      this._m.compose(this._v.set(p[i3], p[i3 + 1], p[i3 + 2]), this._q, this._s.set(this.sz[i3] * k, this.sz[i3 + 1] * k, this.sz[i3 + 2] * k));
      this.mesh.setMatrixAt(i, this._m);
      this.mesh.instanceColor.setXYZ(i, this.col[i3], this.col[i3 + 1], this.col[i3 + 2]);
    }
    this.mesh.count = this.n;
    if (this.n) { this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor.needsUpdate = true; }
  }
}

function radialTexture(inner, outer) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, inner); gr.addColorStop(0.55, inner); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3();

export class Fx {
  constructor(world, overlay, opts = {}) {
    this.world = world;
    this.overlay = overlay;
    this.scale = opts.scale ?? 1; // particle-count scale (quality)
    this.add = new Particles(1000, THREE.AdditiveBlending);
    this.alpha = new Particles(1400, THREE.NormalBlending);
    this.debris = new Debris(260);
    world.add(this.add.mesh, this.alpha.mesh, this.debris.mesh);
    this.items = []; // timed custom effects {t, dur, fn}
    this.floodedAt = null;
    this.debris.onSplash = (x, z) => { if (Math.random() < 0.5) this.splash(x, z, 0.4); };

    // tracer beams
    this.beamGeo = new THREE.BoxGeometry(1, 1, 1);
    this.beamGeo.translate(0, 0, 0.5);
    this.beams = [];
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(this.beamGeo, new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.visible = false; m.renderOrder = 7; m.frustumCulled = false;
      world.add(m); this.beams.push(m);
    }
    // rings
    this.ringGeo = new THREE.RingGeometry(0.82, 1, 48); this.ringGeo.rotateX(-Math.PI / 2);
    this.thinRingGeo = new THREE.RingGeometry(0.965, 1, 72); this.thinRingGeo.rotateX(-Math.PI / 2);
    this.rings = [];
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      m.visible = false; m.renderOrder = 7; world.add(m); this.rings.push(m);
    }
    // flash lights (always present so the shader light count never changes)
    this.lights = [];
    for (let i = 0; i < 2; i++) {
      const l = new THREE.PointLight(0xffc080, 0, 6, 1.6);
      l.position.set(0, -50, 0);
      world.add(l);
      this.lights.push({ l, t: 1, dur: 1, i0: 0 });
    }
    // scorch decals
    this.scorchTex = radialTexture('rgba(24,19,14,0.62)', 'rgba(24,19,14,0)');
    this.scorchGeo = new THREE.PlaneGeometry(1, 1); this.scorchGeo.rotateX(-Math.PI / 2);
    this.scorches = [];
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(this.scorchGeo, new THREE.MeshBasicMaterial({ map: this.scorchTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
      m.visible = false; m.renderOrder = 2; world.add(m);
      this.scorches.push({ m, t: 0 });
    }
    this.scorchI = 0;
    // floating text pool
    this.texts = [];
    for (let i = 0; i < 10; i++) {
      const c = document.createElement('canvas'); c.width = 512; c.height = 128;
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
      s.visible = false; s.renderOrder = 30; s.center.set(0.5, 0.2);
      overlay.add(s);
      this.texts.push({ s, c, tex, t: 1, dur: 1, x: 0, y: 0, z: 0, big: 1 });
    }
    this.textI = 0;
    this.shake = 0;
    this.clock = 0;

    // pooled thrown projectile (frag / smoke canister)
    this.nade = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 0), new THREE.MeshStandardMaterial({ color: 0x3b4436, roughness: 0.6 }));
    this.nade.castShadow = true; this.nade.visible = false;
    world.add(this.nade);
    // scan sweep: radar arm + grid disc (one at a time)
    const sg = new THREE.CircleGeometry(1, 40, 0, 1.2); sg.rotateX(-Math.PI / 2);
    this.sweepMat = new THREE.ShaderMaterial({
      uniforms: { uCol: { value: new THREE.Color(0x7fe9ff) }, uA: { value: 0 } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 uCol; uniform float uA; varying vec3 vP; void main(){ float a = clamp(atan(-vP.z, vP.x) / 1.2, 0.0, 1.0); float r = length(vP.xz); float g = smoothstep(0.03, 0.0, abs(fract(r * 5.0) - 0.5) - 0.46); gl_FragColor = vec4(uCol * 1.6, (pow(a, 4.0) * 0.7 + g * a * 0.4) * uA * smoothstep(1.0, 0.92, r)); }',
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.sweep = new THREE.Mesh(sg, this.sweepMat); this.sweep.visible = false; this.sweep.renderOrder = 7;
    world.add(this.sweep);
    // persistent smoke clouds: id -> {x, z, r, t, fade, acc}
    this.smokes = []; // [{id, x, z, r, t, fade, acc}]
  }

  // ---------- persistent smoke ----------
  smokeCloud(id, x, z, r) {
    this.clearSmokeNow(id);
    this.smokes.push({ id, x, z, r, t: 0, fade: -1, acc: 0 });
    // initial burst so the cloud blooms immediately
    for (let i = 0; i < this._n(46); i++) this._puff(x, z, r, true);
    this.ring(x, 0.06, z, 0.2, r * 1.5, 0xe8e4d8, 0.9, 0.7);
  }
  clearSmoke(id) { for (const c of this.smokes) if (c.id === id && c.fade < 0) c.fade = 0; }
  clearSmokeNow(id) { const i = this.smokes.findIndex((c) => c.id === id); if (i >= 0) this.smokes.splice(i, 1); }
  clearAllSmoke() { this.smokes.length = 0; }
  _puff(x, z, r, burst) {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r * 0.85;
    const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
    const y = 0.15 + Math.random() * (burst ? 0.4 : 0.9);
    // lit from above: low puffs darker and cooler, high puffs bright bone
    const hk = Math.min(1, y / 1.0);
    const g = 0.5 + hk * 0.3 + Math.random() * 0.06;
    const out = burst ? 1.6 : 0.18;
    this.alpha.spawn(px, y, pz, Math.cos(a) * out, 0.05 + Math.random() * 0.12, Math.sin(a) * out,
      burst ? 2.6 + Math.random() * 1.5 : 3.4 + Math.random() * 1.6, burst ? 0.45 : 0.75, 1.25 + Math.random() * 0.55,
      g * 0.97, g, g * 1.02, 1, burst ? 2.2 : 0.6, -0.02, 0, 0.7);
  }
  _updateSmoke(dt) {
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const c = this.smokes[i];
      c.t += dt;
      let rate = 28 * Math.max(0.7, this.scale) * c.r / 1.5;
      if (c.fade >= 0) {
        c.fade += dt;
        rate *= Math.max(0, 1 - c.fade / 1.2);
        if (c.fade > 1.2) { this.smokes.splice(i, 1); continue; }
      }
      c.acc += rate * dt;
      while (c.acc >= 1) { c.acc -= 1; this._puff(c.x, c.z, c.r, false); }
    }
  }

  /** Projectile arc for throws. kind: 'frag' | 'smoke'. Returns nothing; caller animates via fn(t). */
  throwStart(kind) {
    const n = this.nade;
    n.visible = true;
    n.material.color.set(kind === 'smoke' ? 0xb9b8ae : 0x3b4436);
    n.scale.set(kind === 'smoke' ? 0.8 : 1, kind === 'smoke' ? 1.6 : 1, kind === 'smoke' ? 0.8 : 1);
    return n;
  }
  throwEnd() { this.nade.visible = false; }

  // ---------- recon scan ----------
  scanSweep(x, z, radius, dur = 1.5) {
    const m = this.sweep;
    m.position.set(x, 0.16, z); m.visible = true;
    m.userData.tok = (m.userData.tok || 0) + 1;
    const tok = m.userData.tok;
    this.ring(x, 0.1, z, 0.2, radius, 0x7fe9ff, 0.9, 1.2);
    this.timed(0.35, (t) => { if (t >= 1) this.ring(x, 0.1, z, 0.2, radius, 0x7fe9ff, 0.9, 0.8); });
    this.timed(0.7, (t) => { if (t >= 1) this.ring(x, 0.1, z, 0.2, radius, 0x7fe9ff, 0.9, 0.5); });
    this.add.spawn(x, 0.3, z, 0, 0, 0, 0.4, 0.3, 1.4, 0.6, 2.2, 2.6, 1, 0, 0, 0, 1.4);
    this.timed(dur, (t) => {
      if (m.userData.tok !== tok) return;
      m.scale.setScalar(radius * Math.min(1, t * 4));
      m.rotation.y = -t * Math.PI * 4.2;
      this.sweepMat.uniforms.uA.value = t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2;
      if (t >= 1) m.visible = false;
    });
  }
  /** Magenta ping on a revealed unit. */
  revealPing(x, z) {
    this.ring(x, 0.08, z, 0.2, 1.1, 0xff3fa4, 0.6, 1.3);
    this.add.spawn(x, 0.6, z, 0, 0, 0, 0.35, 0.2, 0.9, 3.2, 0.5, 1.6, 1, 0, 0, 0, 1.3);
  }

  // ---------- heals / revive ----------
  healPulse(x, z, k = 1) {
    this.ring(x, 0.08, z, 0.2, 1.0 * k, 0x7fe9ff, 0.7, 1.2);
    for (let i = 0; i < this._n(16 * k); i++) {
      const a = Math.random() * Math.PI * 2, d = 0.15 + Math.random() * 0.3;
      this.add.spawn(x + Math.cos(a) * d, 0.1 + Math.random() * 0.4, z + Math.sin(a) * d, 0, 0.7 + Math.random() * 0.9, 0, 0.9 + Math.random() * 0.4, 0.07, 0.03, 1.0, 3.0, 3.6, 1, 1, 0, 0.6, 1);
    }
  }
  /** Stream of motes from (ax,az) to (bx,bz). */
  healStream(ax, ay, az, bx, by, bz, n = 14) {
    for (let i = 0; i < this._n(n); i++) {
      const T = 0.35 + Math.random() * 0.25;
      this.add.spawn(ax, ay, az, (bx - ax) / T + (Math.random() - 0.5) * 0.6, (by - ay) / T + 0.8, (bz - az) / T + (Math.random() - 0.5) * 0.6,
        T, 0.06, 0.04, 1.0, 3.0, 3.6, 1, 0, 1.6, 0.8, 1);
    }
  }
  reviveShimmer(x, z) {
    this.ring(x, 0.08, z, 0.3, 1.5, 0x7fe9ff, 0.8, 1.4);
    this.ring(x, 0.6, z, 0.1, 0.9, 0x7fe9ff, 0.6, 0.9);
    for (let i = 0; i < this._n(30); i++) {
      const a = Math.random() * Math.PI * 2, d = 0.3 + Math.random() * 0.15;
      this.add.spawn(x + Math.cos(a) * d, 0.05 + Math.random() * 0.2, z + Math.sin(a) * d, -Math.sin(a) * 0.9, 1.6 + Math.random() * 1.6, Math.cos(a) * 0.9,
        0.8 + Math.random() * 0.4, 0.06, 0.02, 1.2, 3.4, 4.2, 1, 1.2, 0, 1.2, 1);
    }
    this.add.spawn(x, 0.6, z, 0, 0.4, 0, 0.45, 0.4, 1.4, 0.7, 2.0, 2.4, 1, 0, 0, 0, 1.4);
    this.flashLight(x, 0.8, z, 0x7fe9ff, 10, 0.4, 4);
  }

  /** Unit hits the deck (downed / death impact). */
  slump(x, z, wet) {
    if (wet) this.splash(x, z, 0.9);
    else this.dust(x, z, 9, 0.76, 0.7, 0.58, 0.05, 1.2);
  }

  setScale(s) { this.scale = s; }
  /** Ambient light on alpha particles (smoke, dust, rain) so they darken with the storm. */
  setAmbient(r, g, b) { this.alpha.mat.uniforms.uTint.value.setRGB(r, g, b); }
  _n(n) { return Math.max(1, Math.round(n * this.scale)); }

  timed(dur, fn) { this.items.push({ t: 0, dur, fn }); }

  flashLight(x, y, z, color, intensity, dur = 0.12, dist = 6) {
    let L = this.lights[0];
    for (const b of this.lights) if (b.t / b.dur > L.t / L.dur) L = b;
    L.l.position.set(x, y, z); L.l.color.set(color); L.l.distance = dist;
    L.t = 0; L.dur = dur; L.i0 = intensity;
    L.l.intensity = intensity;
  }

  muzzle(x, y, z, dx, dz, big = 1) {
    const A = this.add;
    A.spawn(x, y, z, 0, 0, 0, 0.07, 0.35 * big, 0.55 * big, 6, 4.6, 2.4, 1, 0, 0, 0, 1.2);
    for (let i = 0; i < this._n(7 * big); i++) {
      const s = 3 + Math.random() * 5;
      A.spawn(x, y, z, dx * s + (Math.random() - 0.5) * 2, (Math.random() - 0.3) * 1.5, dz * s + (Math.random() - 0.5) * 2, 0.08 + Math.random() * 0.06, 0.07, 0.03, 5, 3.4, 1.4, 1, 6, 0, 1.6, 1);
    }
    for (let i = 0; i < this._n(3); i++) this.alpha.spawn(x + dx * 0.1, y, z + dz * 0.1, dx * 0.6 + (Math.random() - 0.5) * 0.3, 0.3 + Math.random() * 0.3, dz * 0.6, 0.6 + Math.random() * 0.4, 0.15, 0.5, 0.75, 0.73, 0.68, 0.35, 2, 0, 0, 1.2);
    this.flashLight(x, y + 0.1, z, 0xffc070, 9 * big, 0.09, 5);
  }

  _pick(list) {
    // free slot, else the oldest one (each reuse bumps a token so the old timer lets go)
    let best = list[0];
    for (const m of list) { if (!m.visible) { best = m; break; } if ((m.userData.t0 || 0) < (best.userData.t0 || 0)) best = m; }
    best.userData.tok = (best.userData.tok || 0) + 1;
    best.userData.t0 = this.clock;
    return best;
  }

  tracer(ax, ay, az, bx, by, bz, color, width = 0.035, dur = 0.16) {
    const m = this._pick(this.beams), tok = m.userData.tok;
    _a.set(ax, ay, az); _b.set(bx, by, bz);
    const L = _a.distanceTo(_b);
    m.position.copy(_a);
    m.lookAt(_b);
    m.scale.set(width, width, L);
    m.material.color.set(color).multiplyScalar(3.2);
    m.visible = true;
    // travelling bright slug
    const dx = (bx - ax) / L, dy = (by - ay) / L, dz = (bz - az) / L;
    const sp = 55;
    this.add.spawn(ax, ay, az, dx * sp, dy * sp, dz * sp, Math.min(0.5, L / sp), 0.08, 0.08, 7, 6, 4.5, 1, 0, 0, 0.9, 0.8);
    this.timed(dur, (t) => {
      if (m.userData.tok !== tok) return;
      m.material.opacity = (1 - t) * (1 - t);
      m.scale.x = m.scale.y = width * (1 - t * 0.6);
      if (t >= 1) m.visible = false;
    });
  }

  sparks(x, y, z, n, r = 5, g = 3.2, b = 1.4, speed = 5) {
    for (let i = 0; i < this._n(n); i++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.4 + Math.random());
      this.add.spawn(x, y, z, Math.cos(a) * s, Math.random() * speed * 0.9, Math.sin(a) * s, 0.25 + Math.random() * 0.35, 0.05, 0.02, r, g, b, 1, 2, 9, 1.4, 1);
    }
  }

  /** Impact flash. (nx, nz): travel direction of the hit; sparks + cloth puff spray out the far side. */
  hitFlash(x, y, z, k = 1, nx = 0, nz = 0) {
    this.add.spawn(x, y, z, 0, 0, 0, 0.12, 0.3 * k, 0.75 * k, 5, 4.6, 4.2, 1, 0, 0, 0, 1.5);
    for (let i = 0; i < this._n(10 * k); i++) {
      const a = Math.random() * Math.PI * 2, sp = 4 * (0.4 + Math.random());
      this.add.spawn(x, y, z, Math.cos(a) * sp * 0.6 + nx * 5, Math.random() * 3.6, Math.sin(a) * sp * 0.6 + nz * 5,
        0.25 + Math.random() * 0.3, 0.05, 0.02, 5, 4.4, 3.6, 1, 2, 9, 1.4, 1);
    }
    for (let i = 0; i < this._n(5 * k); i++) {
      this.alpha.spawn(x + nx * 0.15, y, z + nz * 0.15, nx * (1 + Math.random()) + (Math.random() - 0.5) * 0.6, 0.3 + Math.random() * 0.5, nz * (1 + Math.random()) + (Math.random() - 0.5) * 0.6,
        0.5 + Math.random() * 0.3, 0.08, 0.3, 0.7, 0.68, 0.62, 0.5, 3, 0, 0, 1.3);
    }
  }

  /** Ejected brass: a few tiny glints popping out to the side and dropping. */
  shell(x, y, z, nx, nz) {
    if (this.scale < 1) return;
    const s = Math.random() < 0.5 ? 1 : -1;
    this.add.spawn(x - nx * 0.3, y, z - nz * 0.3, -nz * s * 1.6 + (Math.random() - 0.5), 1.6 + Math.random(), nx * s * 1.6 + (Math.random() - 0.5),
      0.45, 0.025, 0.02, 3.6, 2.6, 1.0, 1, 0.5, 11, 0.4, 1);
  }

  dust(x, z, n = 4, r = 0.78, g = 0.7, b = 0.56, y = 0.05, spread = 1) {
    for (let i = 0; i < this._n(n); i++) {
      const a = Math.random() * Math.PI * 2, s = (0.3 + Math.random() * 0.6) * spread;
      this.alpha.spawn(x + Math.cos(a) * 0.1, y + Math.random() * 0.05, z + Math.sin(a) * 0.1, Math.cos(a) * s, 0.25 + Math.random() * 0.3, Math.sin(a) * s,
        0.5 + Math.random() * 0.4, 0.12 * spread, 0.42 * spread, r, g, b, 0.45, 3, -0.2, 0, 1.4);
    }
  }

  splash(x, z, k = 1) {
    const y = WATER_Y + 0.02;
    for (let i = 0; i < this._n(10 * k); i++) {
      const a = Math.random() * Math.PI * 2, s = (0.5 + Math.random()) * 1.2 * k;
      this.alpha.spawn(x, y, z, Math.cos(a) * s, (2 + Math.random() * 2.5) * k, Math.sin(a) * s, 0.4 + Math.random() * 0.3, 0.07 * k + 0.03, 0.04, 0.9, 0.97, 1, 0.9, 0.5, 9, 0.5, 1);
    }
    this.ring(x, y, z, 0.25, 0.8 * k + 0.3, 0xcff4ee, 0.5, 0.8);
  }

  ring(x, y, z, r0, r1, color, dur = 0.45, op = 1) {
    const m = this._pick(this.rings), tok = m.userData.tok;
    m.geometry = r1 > 2.4 ? this.thinRingGeo : this.ringGeo;
    m.position.set(x, y, z); m.visible = true;
    m.material.color.set(color);
    m.scale.setScalar(r0); m.material.opacity = op;
    this.timed(dur, (t) => {
      if (m.userData.tok !== tok) return;
      const e = easeOutCubic(t);
      m.scale.setScalar(r0 + (r1 - r0) * e);
      m.material.opacity = op * (1 - t);
      if (t >= 1) m.visible = false;
    });
  }

  scorch(x, z, r) {
    const s = this.scorches[this.scorchI++ % this.scorches.length];
    s.m.position.set(x, 0.012, z); s.m.scale.set(r * 2.4, 1, r * 2.4); s.m.rotation.y = Math.random() * 6;
    s.m.visible = true; s.t = 0; s.m.material.opacity = 1;
  }

  debrisBurst(x, y, z, colors, n, power = 1) {
    for (let i = 0; i < this._n(n); i++) {
      const a = Math.random() * Math.PI * 2, s = (1 + Math.random() * 2.5) * power;
      this.debris.spawn(x + (Math.random() - 0.5) * 0.4, y + Math.random() * 0.4, z + (Math.random() - 0.5) * 0.4,
        Math.cos(a) * s, (2 + Math.random() * 4) * power, Math.sin(a) * s, 0.05 + Math.random() * 0.1, colors[i % colors.length]);
    }
  }

  explosion(x, z, radius = 1.5, wet = false) {
    const y = 0.35;
    const A = this.add;
    // core flash + fireball
    A.spawn(x, y + 0.2, z, 0, 0, 0, 0.14, 0.8, 2.0 * radius, 5, 3.6, 2.2, 1, 0, 0, 0, 1.4);
    for (let i = 0; i < this._n(28); i++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * 1.2, s = 1.2 + Math.random() * 2.6 * radius;
      const hot = Math.random();
      A.spawn(x, y, z, Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s * 0.8 + 1.2, Math.sin(a) * Math.cos(e) * s,
        0.45 + Math.random() * 0.5, 0.35 + Math.random() * 0.25, 0.8 + Math.random() * 0.5, 3.2 + hot * 2.2, 1.0 + hot * 1.6, 0.18 + hot * 0.35, 1, 4, -1.8, 0, 1.6);
    }
    // sparks
    for (let i = 0; i < this._n(30); i++) {
      const a = Math.random() * Math.PI * 2, s = 4 + Math.random() * 8;
      A.spawn(x, y, z, Math.cos(a) * s, 2 + Math.random() * 7, Math.sin(a) * s, 0.5 + Math.random() * 0.6, 0.06, 0.02, 6, 3.5, 1.2, 1, 1.4, 12, 2.2, 1);
    }
    // smoke
    for (let i = 0; i < this._n(22); i++) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * radius * 0.8;
      const g = 0.16 + Math.random() * 0.12;
      this.alpha.spawn(x + Math.cos(a) * d, y + Math.random() * 0.4, z + Math.sin(a) * d, Math.cos(a) * 1.2, 0.8 + Math.random() * 1.4, Math.sin(a) * 1.2,
        1.8 + Math.random() * 1.6, 0.5, 1.6 + Math.random(), g, g * 0.97, g * 0.95, 0.75, 1.4, -0.25, 0, 1.2);
    }
    // lingering embers drifting up, and a rising smoke column
    for (let i = 0; i < this._n(16); i++) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * radius * 0.7;
      A.spawn(x + Math.cos(a) * d, 0.1, z + Math.sin(a) * d, (Math.random() - 0.5) * 0.6, 0.6 + Math.random() * 1.4, (Math.random() - 0.5) * 0.6,
        1.4 + Math.random() * 1.4, 0.035, 0.015, 5, 2.2, 0.5, 1, 0.8, -0.3, 0.6, 1);
    }
    for (let i = 0; i < this._n(8); i++) {
      const g = 0.3 + Math.random() * 0.1;
      this.alpha.spawn(x + (Math.random() - 0.5) * 0.4, 0.8 + i * 0.12, z + (Math.random() - 0.5) * 0.4, 0.2, 0.9 + Math.random() * 0.6, 0.1,
        1.8 + Math.random() * 1.2, 0.3, 0.9 + Math.random() * 0.4, g, g * 0.97, g * 0.95, 0.45, 0.6, -0.15, 0, 1.2);
    }
    if (!wet) this.debrisBurst(x, 0.15, z, [0x3d3a33, 0x6b6253, 0x8d7f63], 10, 1.0);
    this.ring(x, 0.06, z, 0.3, radius * 2.3, 0xffd9a8, 0.5, 1.4);
    this.ring(x, 0.05, z, 0.2, radius * 1.4, 0xffffff, 0.22, 1.8);
    this.flashLight(x, 1, z, 0xffa860, 26, 0.4, 7);
    if (wet) { this.splash(x, z, 2.2); this.splash(x + 0.4, z - 0.3, 1.4); } else this.scorch(x, z, radius);
    this.shake = Math.min(1, this.shake + 0.75);
  }

  pickupBurst(x, z) {
    for (let i = 0; i < this._n(24); i++) {
      const a = Math.random() * Math.PI * 2, s = 1.5 + Math.random() * 2;
      this.add.spawn(x, 0.4, z, Math.cos(a) * s, 1 + Math.random() * 3, Math.sin(a) * s, 0.5 + Math.random() * 0.4, 0.08, 0.03, 1.4, 3.6, 4.4, 1, 2.5, 3, 1.2, 1);
    }
    this.add.spawn(x, 0.4, z, 0, 0.5, 0, 0.3, 0.5, 1.6, 1.2, 3.2, 4, 1, 0, 0, 0, 1.4);
    this.ring(x, 0.08, z, 0.2, 1.4, 0x7fe9ff, 0.5, 1.3);
  }

  /** style: 'hit' | 'graze' | 'miss' | 'heal' | 'info' | 'tide' | 'kill' */
  floatText(x, y, z, text, color, big = 1) {
    const T = this.texts[this.textI++ % this.texts.length];
    // Stack above fresh texts on the same spot (e.g. FLANKED + damage + GRAZE) instead of overprinting.
    for (let n = 0; n < 4; n++) {
      const clash = this.texts.some((o) => o !== T && o.s.visible && o.t < o.dur * 0.75 && Math.abs(o.x - x) + Math.abs(o.z - z) < 0.3 && Math.abs(o.s.position.y - y) < 0.45);
      if (!clash) break;
      y += 0.45;
    }
    const g = T.c.getContext('2d');
    g.clearRect(0, 0, 512, 128);
    const font = (px) => `900 ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    let px = 76;
    g.font = font(px);
    const w = g.measureText(text).width;
    if (w > 470) { px = Math.floor(px * 470 / w); g.font = font(px); }
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 13; g.strokeStyle = 'rgba(8,14,18,0.92)';
    g.strokeText(text, 256, 66);
    g.fillStyle = color; g.fillText(text, 256, 66);
    g.globalAlpha = 0.35; g.fillStyle = '#ffffff';
    g.save(); g.beginPath(); g.rect(0, 0, 512, 58); g.clip(); g.fillText(text, 256, 66); g.restore();
    g.globalAlpha = 1;
    T.tex.needsUpdate = true;
    T.s.visible = true; T.t = 0; T.dur = 1.15 + big * 0.15; T.x = x; T.y = y; T.z = z; T.big = big;
    T.s.position.set(x, y, z);
  }

  update(dt, camRight) {
    this.clock += dt;
    this._updateSmoke(dt);
    this.add.update(dt);
    this.alpha.update(dt);
    this.debris.update(dt, this.floodedAt);
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      const k = Math.min(1, it.t / it.dur);
      it.fn(k);
      if (k >= 1) this.items.splice(i, 1);
    }
    for (const L of this.lights) {
      if (L.t >= L.dur) { L.l.intensity = 0; continue; }
      L.t += dt;
      const k = clamp(L.t / L.dur, 0, 1);
      L.l.intensity = L.i0 * (1 - k) * (1 - k);
    }
    for (const s of this.scorches) {
      if (!s.m.visible) continue;
      s.t += dt;
      s.m.material.opacity = clamp(1 - (s.t - 18) / 8, 0, 1);
      if (s.t > 26) s.m.visible = false;
    }
    for (const T of this.texts) {
      if (!T.s.visible) continue;
      T.t += dt;
      const k = T.t / T.dur;
      if (k >= 1) { T.s.visible = false; continue; }
      const pop = k < 0.22 ? easeOutBack(k / 0.22, 3) : 1;
      const sc = (0.25 + 0.75 * pop) * (k < 0.22 ? 1.25 - 0.25 * (k / 0.22) : 1) * T.big;
      T.s.scale.set(3.2 * sc, 0.8 * sc, 1);
      const rise = easeOutCubic(Math.min(1, k * 1.4)) * 0.9;
      T.s.position.set(T.x + (camRight ? camRight.x * k * 0.25 : 0), T.y + rise, T.z + (camRight ? camRight.z * k * 0.25 : 0));
      T.s.material.opacity = k > 0.72 ? 1 - (k - 0.72) / 0.28 : 1;
    }
    this.shake = Math.max(0, this.shake - dt * 1.6);
  }

  clear() {
    this.add.n = 0; this.alpha.n = 0; this.debris.n = 0;
    this.items.length = 0;
    for (const b of this.beams) b.visible = false;
    for (const r of this.rings) r.visible = false;
    for (const s of this.scorches) s.m.visible = false;
    for (const t of this.texts) t.s.visible = false;
    for (const L of this.lights) { L.t = L.dur; L.l.intensity = 0; }
    this.smokes.length = 0;
    this.nade.visible = false; this.sweep.visible = false;
    this.shake = 0;
  }
}
