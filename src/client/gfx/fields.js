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
    };
    this.fogAnimating = false;
  }

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
    // Boundary cells (have a 4-neighbour of the other kind).
    const bx = [], by = [], bt = [];
    for (let ty = 0; ty < T; ty++) for (let tx = 0; tx < T; tx++) {
      const v = w[ty * T + tx];
      if ((tx > 0 && w[ty * T + tx - 1] !== v) || (tx < T - 1 && w[ty * T + tx + 1] !== v)
        || (ty > 0 && w[(ty - 1) * T + tx] !== v) || (ty < T - 1 && w[(ty + 1) * T + tx] !== v)) {
        bx.push(tx); by.push(ty); bt.push(v);
      }
    }
    const d = this.tideData;
    const nb = bx.length;
    for (let ty = 0; ty < T; ty++) for (let tx = 0; tx < T; tx++) {
      const i = ty * T + tx, v = w[i];
      let best = 1e9;
      for (let j = 0; j < nb; j++) {
        if (bt[j] === v) continue;
        const dx = bx[j] - tx, dy = by[j] - ty;
        const dd = dx * dx + dy * dy;
        if (dd < best) best = dd;
      }
      let sd = nb ? Math.sqrt(best) - 0.5 : 20;
      if (!v) sd = -sd;
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
      .replace('#include <opaque_fragment>', (extra.preOut || '') + '\noutgoingLight = applyFog(outgoingLight, vWPos.xz);\n#include <opaque_fragment>');
  };
  mat.customProgramCacheKey = () => 'tf-' + key;
  return mat;
}
