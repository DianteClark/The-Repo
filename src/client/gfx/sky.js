// Tidefall 5.0 atmosphere: a screen-space sky/horizon backdrop (gradient
// haze with a sun-side glow, stars at night) and volumetric-looking light
// shafts (high quality only): a handful of soft additive beams slanting down
// along the sun direction, drifting and breathing around the camera target.

import * as THREE from 'three';

const _right = new THREE.Vector3(), _norm = new THREE.Vector3(), _m = new THREE.Matrix4(), _view = new THREE.Vector3(), _ax = new THREE.Vector3();

// ---------- backdrop ----------

const SKY_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.99999, 1.0); }`;
const SKY_FRAG = /* glsl */`
uniform vec3 uTop, uHor, uGlow;
uniform float uGlowK, uSunX, uNight, uTime;
varying vec2 vUv;
float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  float y = vUv.y;
  vec3 c = mix(uHor, uTop, smoothstep(0.15, 1.0, y));
  // sun-side horizon glow: brighter toward the sun's screen side, near the top (far) edge
  float g = exp(-pow((vUv.x - uSunX) * 1.6, 2.0)) * smoothstep(0.2, 0.95, y);
  c += uGlow * g * uGlowK;
  if (uNight > 0.0) {
    vec2 q = floor(vUv * vec2(260.0, 160.0));
    float s = step(0.996, h(q)) * (0.5 + 0.5 * sin(uTime * 2.0 + h(q + 3.0) * 30.0));
    c += vec3(0.8, 0.85, 1.0) * s * uNight * smoothstep(0.3, 0.9, y);
  }
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class SkyBackdrop {
  constructor() {
    this.uniforms = {
      uTop: { value: new THREE.Color() }, uHor: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() },
      uGlowK: { value: 0.3 }, uSunX: { value: 0.7 }, uNight: { value: 0 }, uTime: { value: 0 },
    };
    const geo = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, depthWrite: false, depthTest: false, fog: false,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }
  /** mood: palette mood; sunScreenX: 0..1 screen side the sun is on; night 0/1. */
  update(mood, sunScreenX, night, t) {
    const U = this.uniforms;
    U.uHor.value.copy(mood.fog).lerp(mood.sun, 0.08);
    U.uTop.value.copy(mood.bg).lerp(mood.sky, 0.18);
    U.uGlow.value.copy(mood.sun).multiplyScalar(0.5);
    U.uGlowK.value = 0.35 * (1 - mood.haze * 0.5);
    U.uSunX.value = sunScreenX;
    U.uNight.value = night;
    U.uTime.value = t;
  }
  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

// ---------- light shafts ----------

const SHAFT_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vW;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const SHAFT_FRAG = /* glsl */`
uniform vec3 uCol;
uniform float uA, uTime, uSeed;
varying vec2 vUv;
varying vec3 vW;
void main() {
  float u = vUv.x * 2.0 - 1.0;
  float across = pow(max(0.0, 1.0 - u * u), 1.6);
  // striations drifting across the beam
  float st = 0.7 + 0.3 * sin(u * 3.5 + uSeed * 7.0 + uTime * 0.25);
  float along = smoothstep(0.0, 0.12, vUv.y) * pow(1.0 - vUv.y, 1.3);
  // soft ground contact: the beam pools on the floor instead of cutting off
  float a = across * st * along * uA;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uCol * a, a);
}`;

export class LightShafts {
  constructor(parent, n = 7) {
    this.group = new THREE.Group();
    parent.add(this.group);
    const geo = (this.geo = new THREE.PlaneGeometry(1, 1));
    geo.translate(0, 0.5, 0); // base at the ground, extends up along +y (local axis)
    this.shafts = [];
    for (let i = 0; i < n; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uCol: { value: new THREE.Color() }, uA: { value: 0 }, uTime: { value: 0 }, uSeed: { value: Math.random() * 10 } },
        vertexShader: SHAFT_VERT, fragmentShader: SHAFT_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.renderOrder = 9;
      m.matrixAutoUpdate = false;
      this.group.add(m);
      this.shafts.push({ m, mat, t: 0, life: 0, x: 0, z: 0, w: 1, L: 20, fresh: true });
    }
    this.k = -1;
    this.enabled = true;
  }

  setEnabled(on) { this.enabled = !!on; this.group.visible = this.enabled; }

  /**
   * dt: real seconds. target: camera target (world). view: ortho view height.
   * sunDir: unit vector toward the sun. col: beam colour. k: overall strength 0..1.
   * camPos: camera position (beams turn to face it around their own axis).
   */
  update(dt, time, target, view, sunDir, col, k, camPos) {
    if (!this.enabled) return;
    this.k = this.k < 0 ? k : this.k + (k - this.k) * Math.min(1, dt * 0.8);
    this.group.visible = this.k > 0.01;
    if (!this.group.visible) return;
    _view.copy(camPos).sub(target).normalize();
    for (const s of this.shafts) {
      s.t += dt;
      if (s.t >= s.life) {
        // respawn somewhere in view (pre-warmed on the first frame so beams are already there)
        s.life = 9 + Math.random() * 9;
        s.t = s.fresh ? Math.random() * s.life * 0.8 : 0; s.fresh = false;
        const R = view * 0.75;
        s.x = target.x + (Math.random() - 0.5) * R * 2; s.z = target.z + (Math.random() - 0.5) * R * 2;
        s.w = 2.2 + Math.random() * 4.5; s.L = 22 + Math.random() * 10;
      }
      const f = Math.min(1, s.t / 3) * Math.min(1, (s.life - s.t) / 3);
      const breathe = 0.75 + 0.25 * Math.sin(time * 0.4 + s.mat.uniforms.uSeed.value * 3);
      s.mat.uniforms.uA.value = f * breathe * this.k * 0.42;
      s.mat.uniforms.uTime.value = time;
      s.mat.uniforms.uCol.value.copy(col);
      // basis: y = sun axis, x = across (perpendicular to the view), z = normal
      _right.crossVectors(sunDir, _view).normalize();
      _norm.crossVectors(_right, sunDir).normalize();
      _m.makeBasis(_right.multiplyScalar(s.w), _ax.copy(sunDir).multiplyScalar(s.L), _norm);
      _m.setPosition(s.x + Math.sin(time * 0.05 + s.w) * 0.6, 0.02, s.z);
      s.m.matrix.copy(_m);
      s.m.matrixWorldNeedsUpdate = true;
    }
  }

  dispose() { this.geo.dispose(); for (const s of this.shafts) s.mat.dispose(); this.group.parent?.remove(this.group); }
}
