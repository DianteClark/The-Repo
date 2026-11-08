// Stylized water: a single subdivided plane covering the ocean and every
// flooded tile. Shape comes from the tide signed-distance field, so the
// shoreline follows the gameplay tiles (with organic wobble), gets foam, and
// animates when the tide rises.

import * as THREE from 'three';
import { FIELDS_GLSL, WATER_Y } from './fields.js';
import { P } from './palette.js';

export function buildWater(fields, S, segs = 160, look = null) {
  const W = look?.water || {};
  const size = S + 120;
  const geo = new THREE.PlaneGeometry(size, size, segs, segs);
  geo.rotateX(-Math.PI / 2);
  const uniforms = {
    ...fields.uniforms,
    uShallow: { value: new THREE.Color(W.shallow ?? P.waterShallow) },
    uMid: { value: new THREE.Color(W.mid ?? P.waterMid) },
    uDeep: { value: new THREE.Color(W.deep ?? P.waterDeep) },
    uFoam: { value: new THREE.Color(W.foam ?? P.foam) },
    uOil: { value: W.oil ?? 0 },
    uNight: { value: look?.night ? 1 : 0 },
    uFogColor: { value: new THREE.Color() },
    uFogNear: { value: 1 },
    uFogFar: { value: 100 },
    uRedTide: { value: 0 },
    uRedCol: { value: new THREE.Color(0xa8231c) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: true,
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = WATER_Y;
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;
  return { mesh, mat, uniforms };
}

const VERT = /* glsl */`
${FIELDS_GLSL}
varying float vSD;
varying float vViewZ;
void main() {
  vec3 pos = position;
  vec4 w = modelMatrix * vec4(pos, 1.0);
  float sd = tideSD(w.xz);
  float deep = smoothstep(0.5, 6.0, sd);
  float amp = (0.03 + 0.09 * uStorm) * deep + 0.012;
  float wave = sin(w.x * 0.55 + uTime * 1.3) * 0.6 + sin(w.z * 0.43 - uTime * 1.05 + w.x * 0.2) * 0.4
             + sin((w.x + w.z) * 1.3 + uTime * 2.1) * 0.25;
  w.y += wave * amp;
  vWPos = w.xyz;
  vSD = sd;
  vec4 mv = viewMatrix * w;
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
${FIELDS_GLSL}
uniform vec3 uShallow, uMid, uDeep, uFoam, uFogColor;
uniform vec3 uSkyCol;
uniform float uFogNear, uFogFar;
uniform float uOil, uNight, uRedTide;
uniform vec3 uRedCol;
varying float vSD;
varying float vViewZ;

void main() {
  vec2 p = vWPos.xz;
  float t = uTime;
  // organic edge wobble
  float wob = (vnoise(p * 1.7 + vec2(t * 0.15, -t * 0.1)) - 0.5) * 0.28 + (vnoise(p * 4.3 - t * 0.2) - 0.5) * 0.1;
  float sd = tideSD(p) + wob;
  if (sd < -0.02) discard;
  float aa = max(fwidth(sd), 1e-3);

  vec3 col = mix(uShallow, uMid, smoothstep(0.0, 2.2, sd));
  col = mix(col, uDeep, smoothstep(1.8, 10.0, sd));

  // smooth analytic swell (sum of directional sines) + fine noise ripple for the normal
  float h1 = vnoise(p * 1.2 + vec2(t * 0.35, t * 0.22));
  float h2 = vnoise(p * 2.7 - vec2(t * 0.28, -t * 0.4));
  float h = h1 * 0.65 + h2 * 0.35;
  vec2 d1 = vec2(0.8, 0.6), d2 = vec2(-0.45, 0.89), d3 = vec2(0.96, -0.28), d4 = vec2(-0.7, -0.71);
  float f1 = dot(p, d1) * 1.9 + t * 1.4, f2 = dot(p, d2) * 2.7 - t * 1.7, f3 = dot(p, d3) * 4.3 + t * 2.3, f4 = dot(p, d4) * 6.1 - t * 2.9;
  vec2 g = d1 * cos(f1) * 0.5 + d2 * cos(f2) * 0.38 + d3 * cos(f3) * 0.24 + d4 * cos(f4) * 0.16;
  float nk = 0.16 + uStorm * 0.22;
  vec3 n = normalize(vec3(-g.x * nk, 1.0, -g.y * nk));
  vec3 V = normalize(cameraPosition - vWPos);
  float diff = 0.8 + 0.2 * max(dot(n, uSunDir), 0.0);
  col *= diff;
  // mottled swell: darker troughs, sky-tinted crests
  col *= 0.86 + 0.24 * h;
  col = mix(col, col + uSkyCol * 0.1, smoothstep(0.45, 0.8, h) * (0.6 - uStorm * 0.3));
  // shallow-water glow: sunlight scattering through the turquoise shelf
  col += uShallow * 0.22 * (1.0 - smoothstep(0.0, 2.6, sd)) * (0.6 + 0.4 * h);
  // caustic shimmer seen through the shallows
  if (uHigh > 0.5) col += uSunCol * caustic(p * 1.1, t) * 0.16 * (1.0 - smoothstep(0.2, 2.4, sd)) * uCaustic;
  // sky reflection with a stylized fresnel
  vec3 R = reflect(-V, n);
  float fres = 0.06 + 0.5 * pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 4.0);
  vec3 sky = skyColor(R);
  col = mix(col, sky, fres * (0.6 - uNight * 0.42) * (0.55 + 0.45 * smoothstep(0.3, 0.7, h)));
  // sun glitter: broad sheen + tight sparkles
  float sdot = max(dot(R, uSunDir), 0.0);
  float sheen = pow(sdot, 24.0) * 0.35 + smoothstep(0.35, 0.6, pow(sdot, 120.0)) * 0.9;
  if (uHigh > 0.5) {
    vec2 q = p * 6.0; vec2 gc = floor(q); vec2 fc = fract(q) - 0.5;
    float tw = hash21(gc + floor(t * 2.2 + hash21(gc) * 3.0));
    float dm = 1.0 - smoothstep(0.03, 0.11, length(fc - (vec2(hash21(gc + 1.3), hash21(gc + 2.7)) - 0.5) * 0.6));
    sheen += step(0.965, tw) * dm * smoothstep(0.45, 0.8, h) * 1.4 * (0.35 + pow(sdot, 4.0));
  }
  col += uSunCol * sheen * (0.95 - uStorm * 0.65) * (1.0 - uNight * 0.6);

  // foam: crisp anti-aliased shoreline, a swash line that rolls in and out,
  // lacy breakup behind it, and break lines further out
  float lace = smoothstep(0.42, 0.62, vnoise(p * 5.5 + vec2(t * 0.25, -t * 0.18)) * 0.6 + vnoise(p * 11.0 - t * 0.3) * 0.4);
  float edgeW = 0.07 + uStorm * 0.05;
  float shore = 1.0 - smoothstep(edgeW, edgeW + aa * 1.5, sd);
  float swPos = edgeW + 0.24 + 0.16 * sin(t * 0.85 + vnoise(p * 0.55) * 6.2831) + uStorm * 0.15;
  float swash = (1.0 - smoothstep(0.0, aa * 1.6 + 0.025, abs(sd - swPos))) * (0.55 + 0.45 * lace);
  float band = (1.0 - smoothstep(edgeW, swPos, sd)) * smoothstep(0.55, 0.75, lace) * 0.5;
  float lines = sin(sd * 4.2 - t * 1.7 + vnoise(p * 0.8) * 4.0) * 0.5 + 0.5;
  float lw = fwidth(lines) * 1.5 + 0.02;
  lines = smoothstep(0.93 - lw, 0.93 + lw, lines) * (1.0 - smoothstep(0.5, 2.8 + uStorm * 2.0, sd)) * smoothstep(0.3, 0.6, sd);
  lines *= smoothstep(0.35, 0.6, vnoise(p * 2.2 + t * 0.1));
  // whitecaps out at sea when stormy
  float caps = smoothstep(0.86, 0.97, vnoise(vec2(p.x * 2.2, p.y * 1.1) + vec2(t * 0.6, t * 0.2)) * h2 * 1.6) * smoothstep(3.0, 8.0, sd) * uStorm;
  caps *= smoothstep(0.55, 0.9, sin((p.x + p.y) * 3.1 + vnoise(p * 0.7) * 6.0 - t * 1.4) * 0.5 + 0.5) * 0.75;
  float foam = max(max(shore, swash), max(band, max(lines * 0.8, caps * 0.7)));
  vec3 foamCol = uFoam * (0.92 + 0.08 * max(dot(n, uSunDir), 0.0)) * mix(1.0, 0.8, uStorm);
  col = mix(col, foamCol, foam);
  if (uOil > 0.0) {
    // oil slicks: iridescent sheen patches drifting on the swell
    float o = smoothstep(0.62, 0.8, vnoise(p * 0.45 + vec2(t * 0.015, -t * 0.01)) * 0.7 + vnoise(p * 1.7) * 0.3) * (1.0 - foam);
    float bnd = vnoise(p * 3.0 + h * 2.0);
    vec3 film = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + bnd * 1.5));
    col = mix(col, col * 0.5, o * uOil * 0.7);
    col += (film - 0.5) * 0.045 * o * uOil * smoothstep(0.35, 0.75, bnd);
  }
  if (uNight > 0.0) {
    // night: neon shimmer from the city on the swell
    float nn = smoothstep(0.9, 0.97, vnoise(vec2(p.x * 6.0, p.y * 1.2) + vec2(t * 0.4, 0.0))) * smoothstep(0.4, 0.7, h2);
    col += vec3(0.75, 0.45, 1.0) * nn * 0.12 * (1.0 - smoothstep(0.5, 4.0, sd)) * uNight;
  }
  if (uRedTide > 0.0) {
    // stage event: toxic red-tide band (mask from the fog texture's B channel)
    vec2 fuv = (p - uMapMin) / uMapExt;
    float m = (fuv.x > 0.0 && fuv.y > 0.0 && fuv.x < 1.0 && fuv.y < 1.0) ? texture2D(uFogTex, fuv).b : 0.0;
    float swirl = vnoise(p * 1.6 + vec2(t * 0.2, -t * 0.13)) * 0.6 + vnoise(p * 4.0 - t * 0.3) * 0.4;
    col = mix(col, uRedCol * (0.65 + swirl * 0.7), smoothstep(0.15, 0.6, m) * uRedTide * 0.85);
  }

  float alpha = mix(0.5, 0.97, smoothstep(0.0, 3.2, sd));
  alpha = max(alpha, foam);

  col *= mix(1.0, cloudShade(p), 0.8);
  col = applyFog(col, p);
  float fogF = smoothstep(uFogNear, uFogFar, vViewZ);
  col = mix(col, uFogColor, fogF);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
