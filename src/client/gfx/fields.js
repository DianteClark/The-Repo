// Per-tile data textures shared by every world shader:
//  - fogTex  (S×S, linear):  R = visibility to my team (animated), G = next-tide warning.
//  - tideTex ((S+2P)², linear): signed distance to the waterline in tiles,
//    R = previous field, G = new field; uTideMix animates between them.
// Plus `patchWorld(material)` which injects fog-of-war shading into stock
// three.js materials via onBeforeCompile.

import * as THREE from 'three';

export const TIDE_PAD = 20;
const SD_MIN = -4, SD_MAX = 16;
export const WATER_Y = 0.1;

export class WorldFields {
  constructor(S) {
    this.S = S;
    const n = S * S;
    this.fogData = new Uint8Array(n * 4);
    this.fogCur = new Float32Array(n);
    this.fogGoal = new Float32Array(n);
    this.fogTex = new THREE.DataTexture(this.fogData, S, S, THREE.RGBAFormat);
    this.fogTex.magFilter = this.fogTex.minFilter = THREE.LinearFilter;
    this.fogTex.needsUpdate = true;

    const T = (this.T = S + TIDE_PAD * 2);
    this.tideData = new Uint8Array(T * T * 4);
    this.tideTex = new THREE.DataTexture(this.tideData, T, T, THREE.RGBAFormat);
    this.tideTex.magFilter = this.tideTex.minFilter = THREE.LinearFilter;
    this.tideTex.wrapS = this.tideTex.wrapT = THREE.ClampToEdgeWrapping;
    this.tideTex.needsUpdate = true;
    this.water = new Uint8Array(T * T);
    this.flooded = new Uint8Array(n); // per map tile, final state

    // Shared value-noise texture: one texel per world unit, bilinear → smooth noise.
    const N = 256, nd = new Uint8Array(N * N * 4);
    for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 256) | 0;
    this.noiseTex = new THREE.DataTexture(nd, N, N, THREE.RGBAFormat);
    this.noiseTex.wrapS = this.noiseTex.wrapT = THREE.RepeatWrapping;
    this.noiseTex.magFilter = THREE.LinearFilter;
    this.noiseTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.noiseTex.generateMipmaps = true;
    this.noiseTex.needsUpdate = true;

    this.uniforms = {
      uNoise: { value: this.noiseTex },
      uFogTex: { value: this.fogTex },
      uTideTex: { value: this.tideTex },
      uMapMin: { value: new THREE.Vector2(-S / 2, -S / 2) },
      uMapExt: { value: S },
      uTideMin: { value: new THREE.Vector2(-S / 2 - TIDE_PAD, -S / 2 - TIDE_PAD) },
      uTideExt: { value: T },
      uTideMix: { value: 1 },
      uTime: { value: 0 },
      uStorm: { value: 0 },
      uFogDark: { value: 0.42 },
      uGridOff: { value: (S % 2) * 0.5 },
      uSunDir: { value: new THREE.Vector3(0.5, 0.7, 0.3).normalize() },
      uSunCol: { value: new THREE.Color(1, 0.8, 0.6) },
      uSkyCol: { value: new THREE.Color(0.6, 0.8, 0.8) },
      uZone: { value: new THREE.Vector4(0, 0, 99, 99) }, // world cx, cz, r, next
      uCloud: { value: 0.2 },
    };
    this.fogAnimating = false;
  }

  dispose() { this.fogTex.dispose(); this.tideTex.dispose(); this.noiseTex.dispose(); }

  /** vis: Uint8Array S*S of 0/1. */
  setFog(vis, instant) {
    const n = this.S * this.S;
    for (let k = 0; k < n; k++) {
      this.fogGoal[k] = vis[k];
      if (instant) this.fogCur[k] = vis[k];
    }
    this.fogAnimating = true;
    this._writeFog();
  }

  setWarn(warn) {
    const n = this.S * this.S;
    for (let k = 0; k < n; k++) this.fogData[k * 4 + 1] = warn[k] ? 255 : 0;
    this.fogTex.needsUpdate = true;
  }

  _writeFog() {
    const n = this.S * this.S, d = this.fogData;
    for (let k = 0; k < n; k++) d[k * 4] = (this.fogCur[k] * 255) | 0;
    this.fogTex.needsUpdate = true;
  }

  update(dt) {
    if (!this.fogAnimating) return;
    const n = this.S * this.S, a = Math.min(1, dt * 7);
    let any = false;
    for (let k = 0; k < n; k++) {
      const g = this.fogGoal[k], c = this.fogCur[k];
      if (c !== g) {
        const nc = Math.abs(g - c) < 0.02 ? g : c + (g - c) * a;
        this.fogCur[k] = nc;
        any = true;
      }
    }
    this._writeFog();
    this.fogAnimating = any;
  }

  /**
   * floodFn(x,y) → true if map tile is under water. Everything outside the
   * map is ocean. Writes the new field into G and moves the old one into R.
   */
  setTide(floodFn, instant) {
    const S = this.S, T = this.T, P = TIDE_PAD, w = this.water;
    for (let ty = 0; ty < T; ty++) for (let tx = 0; tx < T; tx++) {
      const x = tx - P, y = ty - P;
      const inside = x >= 0 && y >= 0 && x < S && y < S;
      const f = inside ? (floodFn(x, y) ? 1 : 0) : 1;
      w[ty * T + tx] = f;
      if (inside) this.flooded[y * S + x] = f;
    }
    // Signed distance to the waterline via an 8-neighbour two-pass vector
    // distance transform (O(T²) instead of O(T² × boundary cells): 44×44 maps
    // shrink the tide on phones without a hitch).
    const n = T * T;
    const vx = this._dtx || (this._dtx = new Int16Array(n)), vy = this._dty || (this._dty = new Int16Array(n));
    const BIG = 2000;
    for (let i = 0; i < n; i++) {
      const ty = (i / T) | 0, tx = i - ty * T, v = w[i];
      const edge = (tx > 0 && w[i - 1] !== v) || (tx < T - 1 && w[i + 1] !== v) || (ty > 0 && w[i - T] !== v) || (ty < T - 1 && w[i + T] !== v);
      vx[i] = edge ? 0 : BIG; vy[i] = edge ? 0 : BIG;
    }
    const relax = (i, j, dx, dy) => {
      const ax = vx[j] + dx, ay = vy[j] + dy;
      if (ax * ax + ay * ay < vx[i] * vx[i] + vy[i] * vy[i]) { vx[i] = ax; vy[i] = ay; }
    };
    for (let ty = 0; ty < T; ty++) {
      for (let tx = 0; tx < T; tx++) {
        const i = ty * T + tx;
        if (tx > 0) relax(i, i - 1, 1, 0);
        if (ty > 0) { relax(i, i - T, 0, 1); if (tx > 0) relax(i, i - T - 1, 1, 1); if (tx < T - 1) relax(i, i - T + 1, 1, 1); }
      }
      for (let tx = T - 2; tx >= 0; tx--) relax(ty * T + tx, ty * T + tx + 1, 1, 0);
    }
    for (let ty = T - 1; ty >= 0; ty--) {
      for (let tx = T - 1; tx >= 0; tx--) {
        const i = ty * T + tx;
        if (tx < T - 1) relax(i, i + 1, 1, 0);
        if (ty < T - 1) { relax(i, i + T, 0, 1); if (tx < T - 1) relax(i, i + T + 1, 1, 1); if (tx > 0) relax(i, i + T - 1, 1, 1); }
      }
      for (let tx = 1; tx < T; tx++) relax(ty * T + tx, ty * T + tx - 1, 1, 0);
    }
    const d = this.tideData;
    for (let i = 0; i < n; i++) {
      // distance from this cell to the nearest boundary cell of the other kind ≈ |v| + 1 for non-edge cells
      const L = vx[i] >= BIG ? 20 : Math.hypot(vx[i], vy[i]);
      let sd = L + 0.5;
      if (!w[i]) sd = -sd;
      const enc = Math.max(0, Math.min(255, Math.round(((sd - SD_MIN) / (SD_MAX - SD_MIN)) * 255)));
      d[i * 4] = instant ? enc : d[i * 4 + 1];
      d[i * 4 + 1] = enc;
    }
    if (instant) {
      for (let i = 0; i < T * T; i++) d[i * 4] = d[i * 4 + 1];
      this.uniforms.uTideMix.value = 1;
    } else this.uniforms.uTideMix.value = 0;
    this.tideTex.needsUpdate = true;
  }
}

// GLSL shared by world shaders.
export const FIELDS_GLSL = /* glsl */`
uniform sampler2D uFogTex;
uniform sampler2D uTideTex;
uniform sampler2D uNoise;
uniform vec2 uMapMin;
uniform float uMapExt;
uniform vec2 uTideMin;
uniform float uTideExt;
uniform float uTideMix;
uniform float uTime;
uniform float uStorm;
uniform float uFogDark;
uniform float uGridOff;
uniform float uCloud;
varying vec3 vWPos;
float tideSD(vec2 p) {
  vec2 uv = (p - uTideMin) / uTideExt;
  vec2 s = texture2D(uTideTex, uv).rg;
  float e = mix(s.r, s.g, uTideMix);
  return e * ${(SD_MAX - SD_MIN).toFixed(1)} + ${SD_MIN.toFixed(1)};
}
float fogVis(vec2 p) {
  vec2 uv = (p - uMapMin) / uMapExt;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.8;
  return smoothstep(0.12, 0.88, texture2D(uFogTex, uv).r);
}
vec3 applyFog(vec3 c, vec2 p) {
  float v = fogVis(p);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 f = mix(vec3(l), c, 0.35) * uFogDark * vec3(0.78, 0.93, 1.12);
  return mix(f, c, v);
}
float cloudShade(vec2 p) {
  // big soft cloud shadows drifting across the island
  float c = texture2D(uNoise, p * 0.0009 + vec2(uTime * 0.00011, uTime * 0.00006)).g;
  c = c * 0.6 + texture2D(uNoise, p * 0.0023 - vec2(uTime * 0.00008, 0.0)).b * 0.4;
  return 1.0 - uCloud * 0.42 * smoothstep(0.45, 0.68, c);
}
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) { return texture2D(uNoise, (p + 0.5) * (1.0 / 256.0)).r; }
`;

const WPOS_VERT = /* glsl */`
  {
    vec4 wpP = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      wpP = instanceMatrix * wpP;
    #endif
    vWPos = (modelMatrix * wpP).xyz;
  }
`;

/**
 * Inject fog-of-war (and optionally extra fragment code) into a stock
 * material. `extra.colorFrag` runs after <color_fragment> with access to
 * diffuseColor; `extra.vertDecl`/`extra.vert` add vertex-side code.
 */
export function patchWorld(mat, fields, key, extra = {}) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, fields.uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\n' + (extra.vertDecl || ''))
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + WPOS_VERT + (extra.vert || ''));
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FIELDS_GLSL + (extra.fragDecl || ''))
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + (extra.colorFrag || ''))
      .replace('#include <opaque_fragment>', (extra.preOut || '') + '\noutgoingLight *= cloudShade(vWPos.xz);\noutgoingLight = applyFog(outgoingLight, vWPos.xz);\n#include <opaque_fragment>');
  };
  mat.customProgramCacheKey = () => 'tf-' + key;
  return mat;
}
