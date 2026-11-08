// Tidefall 5.0 weapon camos: procedural shader patterns on the weapon body.
//
// One material per camo id, shared by every weapon that wears it (weapons
// don't need a per-instance hit flash), so a 16-player match compiles at most
// a handful of camo programs. Patterns are evaluated in weapon-local space
// (object position), so they stick to the gun as it moves.
//
// Weapon vertex tags (aTag, set by gfx/weapons.js):
//   0/3 attachment / grip rubber: keeps its vertex colour (no camo)
//   1   body: full camo           2 dark metal: camo, darkened
//   4   lens / sight glass: glows  5 gold trim: always polished gold
//   6   emissive accent (legendary glow)
//
// Ids: none; SIM-1 challenge camos kelpweave, driftwood, saltcrust, reefstripe,
// stormglass, rustbloom, nightoil, harborgray, tidemark; bonus standard camos
// woodland, desert, urban, kelp, digital, tiger, splinter, arctic, reef, dazzle,
// hex, topo, magma (22 standard in all); gold, diamond, tidal (animated).
// Cost: two or three value-noise lookups per fragment on the weapon only.

import * as THREE from 'three';

export const WT = { att: 0, body: 1, dark: 2, rubber: 3, lens: 4, gold: 5, glow: 6 };

const C = (h) => new THREE.Color(h);
// pattern ids in the shader switch, colours A/B/C, roughness/metalness
const LOOK = {
  none: { p: 0, A: 0x5e676d, B: 0x5e676d, C: 0x5e676d, rough: 0.45, metal: 0.2 },
  woodland: { p: 1, A: 0x4a5a32, B: 0x2a2a1a, C: 0x7a6a42, rough: 0.7, metal: 0.1 },
  desert: { p: 2, A: 0xc8a873, B: 0x8a6d44, C: 0xe2cfa0, rough: 0.75, metal: 0.05 },
  urban: { p: 1, A: 0x8f969a, B: 0x3e4448, C: 0x62696d, rough: 0.7, metal: 0.1 },
  kelp: { p: 3, A: 0x3f7a45, B: 0x22402a, C: 0x9fc06a, rough: 0.7, metal: 0.1 },
  digital: { p: 4, A: 0x5a7a8a, B: 0x2a3a4a, C: 0xa8c0c8, rough: 0.7, metal: 0.1 },
  tiger: { p: 5, A: 0xe0a040, B: 0x1a1a1a, C: 0xf0c060, rough: 0.6, metal: 0.1 },
  splinter: { p: 6, A: 0x7a8a6a, B: 0x3a4a3a, C: 0xb0b89a, rough: 0.7, metal: 0.1 },
  arctic: { p: 2, A: 0xe6ebee, B: 0x8c99a3, C: 0xffffff, rough: 0.6, metal: 0.05 },
  reef: { p: 7, A: 0xf08a7e, B: 0x2f8f8a, C: 0xffd0b8, rough: 0.6, metal: 0.05 },
  dazzle: { p: 8, A: 0xf2f2ee, B: 0x1b1d22, C: 0x5b7ea8, rough: 0.55, metal: 0.1 },
  hex: { p: 9, A: 0x2c3034, B: 0x5d666c, C: 0x9dff3a, rough: 0.45, metal: 0.4 },
  topo: { p: 10, A: 0x1e3a4a, B: 0x7ac0c8, C: 0x2a5a6a, rough: 0.6, metal: 0.1 },
  magma: { p: 11, A: 0x1a1412, B: 0xff6a1a, C: 0xffd04a, rough: 0.8, metal: 0.05 },
  // SIM-1's challenge camos (src/sim/weapons.js CAMO_CHALLENGES)
  kelpweave: { p: 17, A: 0x4a8048, B: 0x2a4a2a, C: 0xb8d07a, rough: 0.7, metal: 0.1 },
  driftwood: { p: 15, A: 0x9a7a58, B: 0x5a4430, C: 0xc8b090, rough: 0.8, metal: 0.0 },
  saltcrust: { p: 2, A: 0xd8e0dc, B: 0x6a7a80, C: 0xffffff, rough: 0.85, metal: 0.05 },
  reefstripe: { p: 5, A: 0x2f8f8a, B: 0xf08a7e, C: 0x3aa8a0, rough: 0.6, metal: 0.1 },
  stormglass: { p: 6, A: 0x5a6a80, B: 0x2a3444, C: 0xa8b8d0, rough: 0.35, metal: 0.3 },
  rustbloom: { p: 7, A: 0xa4512c, B: 0x5c3220, C: 0xe08a4a, rough: 0.9, metal: 0.1 },
  nightoil: { p: 16, A: 0x0e0c12, B: 0x7a4dff, C: 0x2ad0c0, rough: 0.2, metal: 0.5 },
  harborgray: { p: 1, A: 0x7a8890, B: 0x3a4650, C: 0x9aa8b0, rough: 0.6, metal: 0.2 },
  tidemark: { p: 10, A: 0x2a5a6a, B: 0xe8dcc0, C: 0x3a7a80, rough: 0.6, metal: 0.1 },
  gold: { p: 12, A: 0xffc23a, B: 0x8a4e08, C: 0xfff0c0, rough: 0.3, metal: 0.2 },
  diamond: { p: 13, A: 0xdff2ff, B: 0x7ac8ff, C: 0xff9ae0, rough: 0.1, metal: 0.3 },
  tidal: { p: 14, A: 0x0a3a5a, B: 0x2ad0e0, C: 0xe8fbff, rough: 0.3, metal: 0.3 },
};

export function camoIds() { return Object.keys(LOOK); }
export function hasCamo(id) { return !!LOOK[id]; }

const TIME = { value: 0 };
/** Advance animated camos (call once per frame with the renderer clock). */
export function tickCamos(t) { TIME.value = t; }

const GLSL = /* glsl */`
uniform float uCmT;
uniform vec3 uCmA, uCmB, uCmC;
varying vec3 vCmP;
varying float vCmTag;
float cmH(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float cmN(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(cmH(i), cmH(i + vec3(1, 0, 0)), f.x), mix(cmH(i + vec3(0, 1, 0)), cmH(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(cmH(i + vec3(0, 0, 1)), cmH(i + vec3(1, 0, 1)), f.x), mix(cmH(i + vec3(0, 1, 1)), cmH(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// Faked studio reflection for polished metal (the scene has nothing to reflect):
// a sky/horizon/ground ramp on the view-space reflection vector, a hot spec band,
// a slow glint sweeping along the gun and a fresnel rim. Returns emissive; sets diffuse dark.
vec3 cmGold(vec3 P, vec3 N, vec3 V, vec3 lo, vec3 hi, vec3 spec, inout vec3 dif) {
  vec3 R = reflect(-V, N);
  float fr = pow(1.0 - abs(dot(N, V)), 2.0);
  // flat faces would reflect one colour: bend the lookup across the face so it reads as polished metal
  float ry = R.y + sin(P.z * 9.0 + P.y * 14.0 + P.x * 6.0) * 0.32 + R.x * 0.25;
  vec3 env = mix(lo * 0.75, hi * 1.1, smoothstep(-0.7, 0.35, ry));              // ground → sky
  env += spec * smoothstep(0.4, 0.6, ry) * smoothstep(1.1, 0.75, ry) * 0.45;   // softbox band
  env *= mix(0.62, 1.0, smoothstep(-0.35, -0.1, ry));                         // darker underside
  float sweep = fract(P.z * 1.2 + P.y * 0.8 - uCmT * 0.35);
  float glint = smoothstep(0.0, 0.03, sweep) * smoothstep(0.09, 0.03, sweep);
  dif = lo * 0.22;
  return env * 0.95 + spec * glint * 1.6 + hi * fr * 0.55;
}
vec3 cmHue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
`;

function patternGLSL(p) {
  // sets: vec3 cm (camo colour), cmGlow (emissive add), cmR / cmM (roughness / metalness overrides, <0 = keep)
  switch (p) {
    case 0: return 'cm = mix(uCmA, uCmB, step(0.5, fract(P.y * 0.0)));';
    case 1: return `float n = cmN(P * 9.0) * 0.65 + cmN(P * 21.0) * 0.35;
      cm = n < 0.4 ? uCmB : (n < 0.55 ? uCmA : (n < 0.68 ? uCmC : uCmA * 0.8));`;
    case 2: return `float n = cmN(P * 7.0) * 0.7 + cmN(P * 19.0) * 0.3;
      cm = mix(uCmA, uCmB, smoothstep(0.52, 0.56, n));
      cm = mix(cm, uCmC, step(0.9, cmH(floor(P * 70.0))) * 0.8);`;
    case 3: return `vec3 q = vec3(P.x * 14.0, P.y * 5.0, P.z * 5.0 + cmN(P * 8.0) * 1.5);
      float n = cmN(q);
      cm = n < 0.38 ? uCmB : (n > 0.62 ? uCmC : uCmA);`;
    case 4: return `vec3 q = floor(P * 34.0);
      float n = cmN(floor(P * 9.0) + 0.5) * 0.55 + cmH(q) * 0.45;
      cm = n < 0.36 ? uCmB : (n > 0.64 ? uCmC : uCmA);`;
    case 5: return `float w = sin((P.z * 1.0 + P.y * 0.6 + cmN(P * 6.0) * 0.12) * 52.0);
      cm = mix(uCmA, uCmC, cmN(P * 4.0) * 0.6);
      cm = mix(cm, uCmB, smoothstep(0.45, 0.6, w));`;
    case 6: return `vec3 c = floor(P * 7.0 + vec3(0.0, cmN(P * 3.0), 0.0));
      float h = cmH(c);
      float d = dot(fract(P * 7.0) - 0.5, normalize(vec3(cmH(c + 3.1) - 0.5, cmH(c + 7.3) - 0.5, 0.4)));
      cm = d > 0.0 ? (h < 0.5 ? uCmA : uCmB) : (h < 0.33 ? uCmC : uCmA);`;
    case 7: return `float n = cmN(P * 10.0);
      cm = mix(uCmB, uCmA, smoothstep(0.45, 0.5, n));
      vec3 f = fract(P * 30.0) - 0.5;
      cm = mix(cm, uCmC, (1.0 - smoothstep(0.18, 0.26, length(f))) * step(0.7, cmH(floor(P * 30.0))));`;
    case 8: return `vec3 c = floor(P * vec3(3.5, 3.5, 4.0));
      float h = cmH(c);
      vec2 dir = h < 0.33 ? vec2(1.0, 0.0) : (h < 0.66 ? vec2(0.7, 0.7) : vec2(0.7, -0.7));
      float s = step(0.5, fract(dot(vec2(P.z, P.y), dir) * (14.0 + h * 10.0)));
      cm = s > 0.5 ? uCmA : (h > 0.8 ? uCmC : uCmB);`;
    case 9: return `vec2 q = vec2(P.z, P.y + P.x * 0.5) * 34.0;
      vec2 r = vec2(1.0, 1.732);
      vec2 a = mod(q, r) - r * 0.5, b = mod(q - r * 0.5, r) - r * 0.5;
      vec2 g = dot(a, a) < dot(b, b) ? a : b;
      float e = max(abs(g.x) * 0.866 + abs(g.y) * 0.5, abs(g.y));
      float line = smoothstep(0.4, 0.46, e);
      cm = mix(uCmA, uCmB, line);
      cmGlow = uCmC * line * step(0.86, cmH(floor(vec3(q, 0.0)))) * 1.4;`;
    case 10: return `float n = cmN(P * 6.0) * 0.7 + cmN(P * 13.0) * 0.3;
      float band = fract(n * 9.0);
      float line = 1.0 - smoothstep(0.0, 0.12, min(band, 1.0 - band));
      cm = mix(uCmA, uCmC, floor(n * 9.0) / 9.0);
      cm = mix(cm, uCmB, line);`;
    case 11: return `float n = cmN(P * 11.0);
      float crack = 1.0 - smoothstep(0.0, 0.07, abs(n - 0.5));
      float n2 = cmN(P * 27.0);
      crack = max(crack, (1.0 - smoothstep(0.0, 0.05, abs(n2 - 0.5))) * 0.6);
      float pulse = 0.75 + 0.25 * sin(uCmT * 2.0 + n * 12.0);
      cm = mix(uCmA, uCmA * 1.8, n2 * 0.4);
      cm = mix(cm, uCmB, crack);
      cmGlow = mix(uCmB, uCmC, crack) * crack * 1.6 * pulse;`;
    case 12: return `vec3 dif = cm;
      cmGlow = cmGold(P, normalize(vNormal), normalize(vViewPosition), uCmB * 1.1, uCmA, uCmC, dif);
      float br = cmN(vec3(P.z * 140.0, P.y * 5.0, P.x * 5.0));
      cm = dif * (0.8 + br * 0.4);
      cmGlow *= 0.92 + br * 0.16;
      float sp = step(0.992, cmH(floor(P * 90.0) + floor(uCmT * 4.0)));
      cmGlow += uCmC * sp * 2.5;
      cmR = 0.3; cmM = 0.2;`;
    case 13: return `vec3 nV = normalize(vNormal);
      vec3 cell = floor(P * 22.0) + floor(nV * 2.5);
      float h = cmH(cell);
      vec3 V = normalize(vViewPosition);
      float fr = 1.0 - abs(dot(nV, V));
      vec3 R = reflect(-V, nV);
      vec3 iri = cmHue(fract(h * 0.6 + fr * 0.9 + R.y * 0.4 + uCmT * 0.05));
      float facet = 0.55 + 0.6 * h;                       // each facet catches light differently
      float env = smoothstep(-0.3, 0.6, R.y);
      cm = uCmA * facet * 0.55;
      float sp = step(0.955, cmH(cell + floor(uCmT * 6.0)));      // twinkling facets
      float star = step(0.993, cmH(floor(P * 70.0) + floor(uCmT * 9.0)));
      float sweep = fract(P.z * 1.2 + P.y * 0.8 - uCmT * 0.35);
      float glint = smoothstep(0.0, 0.03, sweep) * smoothstep(0.09, 0.03, sweep);
      cmGlow = uCmA * env * 0.55 * facet + uCmB * 0.1 + iri * (0.15 + pow(fr, 2.0) * 0.8)
             + vec3(1.0) * (sp * 1.4 + star * 4.0 + glint * 1.2);
      cmR = 0.1; cmM = 0.2;`;
    case 14: return `float t = uCmT;
      float w1 = sin(P.z * 26.0 - t * 2.4 + cmN(P * 7.0 + vec3(0.0, 0.0, t * 0.3)) * 4.0 + P.y * 9.0);
      float w2 = sin(P.z * 15.0 + P.x * 11.0 - t * 1.6);
      float n = w1 * 0.6 + w2 * 0.4;
      float foam = smoothstep(0.78, 0.92, n);
      cm = mix(uCmA, uCmB, smoothstep(-0.6, 0.7, n));
      cm = mix(cm, uCmC, foam);
      float caus = pow(cmN(P * 18.0 + vec3(t * 0.6, t * 0.4, -t * 0.8)), 4.0);
      cm *= 0.75;
      cmGlow = uCmB * (0.1 + 0.18 * smoothstep(0.0, 1.0, n)) + uCmC * (foam * 0.45 + caus * 0.7);
      cmR = 0.25; cmM = 0.35;`;
    case 17: return `float u = P.z * 26.0 + P.x * 10.0, v = P.y * 26.0;
      float over = mod(floor(u) + floor(v), 2.0);
      float strand = over > 0.5 ? smoothstep(0.1, 0.25, fract(v)) * smoothstep(0.9, 0.75, fract(v)) : smoothstep(0.1, 0.25, fract(u)) * smoothstep(0.9, 0.75, fract(u));
      cm = mix(uCmB, over > 0.5 ? uCmA : mix(uCmA, uCmC, 0.45), strand);
      cm *= 0.85 + 0.3 * cmN(P * 8.0);
`;
    case 15: return `float n = cmN(P * vec3(10.0, 10.0, 2.0));
      float grain = fract((P.y * 40.0 + P.x * 40.0) + n * 6.0);
      cm = mix(uCmA, uCmB, smoothstep(0.55, 0.95, grain));
      cm = mix(cm, uCmC, smoothstep(0.75, 0.9, cmN(P * 25.0)) * 0.35);`;
    case 16: return `float fr = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
      vec3 oil = cmHue(fract(fr * 1.4 + cmN(P * 9.0) * 0.8 + P.z * 1.5 + uCmT * 0.03));
      cm = mix(uCmA, oil * 0.35, 0.25 + fr * 0.4);
      cmGlow = mix(uCmB, uCmC, cmN(P * 6.0)) * pow(fr, 2.0) * 0.6 + oil * pow(fr, 3.0) * 0.4;
      cmR = 0.18; cmM = 0.6;`;
    default: return 'cm = diffuseColor.rgb;';
  }
}

const CACHE = new Map();

/**
 * Shared material for camo `id` (unknown ids fall back to 'none'). Works on
 * any geometry with vertex colours and an aTag attribute (gfx/weapons.js).
 */
export function makeCamoMaterial(id) {
  if (!LOOK[id]) id = 'none';
  if (CACHE.has(id)) return CACHE.get(id);
  const L = LOOK[id];
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: L.rough, metalness: L.metal });
  const U = { uCmT: TIME, uCmA: { value: C(L.A) }, uCmB: { value: C(L.B) }, uCmC: { value: C(L.C) } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aTag;\nvarying vec3 vCmP;\nvarying float vCmTag;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCmP = position; vCmTag = aTag;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 cmGlow = vec3(0.0); float cmR = -1.0; float cmM = -1.0; float cmOn = 0.0;
        {
          vec3 P = vCmP; vec3 cm = diffuseColor.rgb;
          float tg = floor(vCmTag + 0.5);
          if (tg == 1.0 || tg == 2.0) {
            ${patternGLSL(L.p)}
            float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
            float detail = clamp(0.62 + lum * 1.1, 0.7, 1.15);
            diffuseColor.rgb = cm * detail * (tg == 2.0 ? 0.62 : 1.0);
            cmOn = 1.0;
          } else if (tg == 4.0) {
            cmGlow = diffuseColor.rgb * 1.6;
          } else if (tg == 5.0) {
            vec3 dif = diffuseColor.rgb;
            cmGlow = cmGold(P, normalize(vNormal), normalize(vViewPosition), vec3(0.42, 0.17, 0.01), vec3(1.0, 0.58, 0.06), vec3(1.0, 0.86, 0.5), dif); // linear-space gold
            diffuseColor.rgb = dif;
            cmR = 0.3; cmM = 0.2;
          } else if (tg == 6.0) {
            cmGlow = diffuseColor.rgb * (1.4 + 0.5 * sin(uCmT * 3.0 + P.z * 10.0));
          } else if (tg == 3.0) {
            cmR = 0.85; cmM = 0.0;
          } else {
            cmR = 0.4; cmM = 0.25;
          }
        }
      `)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (cmR >= 0.0) roughnessFactor = cmR;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nif (cmM >= 0.0) metalnessFactor = cmM;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += cmGlow;');
  };
  mat.customProgramCacheKey = () => 'tf-camo-' + L.p;
  mat.userData.shared = true;
  mat.userData.camo = id;
  CACHE.set(id, mat);
  return mat;
}
