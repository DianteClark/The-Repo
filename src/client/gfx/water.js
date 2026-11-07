// Stylized water: a single subdivided plane covering the ocean and every
// flooded tile. Shape comes from the tide signed-distance field, so the
// shoreline follows the gameplay tiles (with organic wobble), gets foam, and
// animates when the tide rises.

import * as THREE from 'three';
import { FIELDS_GLSL, WATER_Y } from './fields.js';
import { P } from './palette.js';

export function buildWater(fields, S, segs = 160) {
  const size = S + 120;
  const geo = new THREE.PlaneGeometry(size, size, segs, segs);
  geo.rotateX(-Math.PI / 2);
  const uniforms = {
    ...fields.uniforms,
    uShallow: { value: new THREE.Color(P.waterShallow) },
    uMid: { value: new THREE.Color(P.waterMid) },
    uDeep: { value: new THREE.Color(P.waterDeep) },
    uFoam: { value: new THREE.Color(P.foam) },
    uFogColor: { value: new THREE.Color() },
    uFogNear: { value: 1 },
    uFogFar: { value: 100 },
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
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSkyCol;
uniform float uFogNear, uFogFar;
varying float vSD;
varying float vViewZ;

void main() {
  vec2 p = vWPos.xz;
  float t = uTime;
  // organic edge wobble
  float wob = (vnoise(p * 1.7 + vec2(t * 0.15, -t * 0.1)) - 0.5) * 0.28 + (vnoise(p * 4.3 - t * 0.2) - 0.5) * 0.1;
  float sd = tideSD(p) + wob;
  if (sd < -0.02) discard;

  float depth = smoothstep(0.0, 7.0, sd);
  vec3 col = mix(uShallow, uMid, smoothstep(0.0, 1.8, sd));
  col = mix(col, uDeep, smoothstep(1.5, 9.0, sd));

  // fake normal from scrolling noise -> sun glints + soft shading
  float h1 = vnoise(p * 1.2 + vec2(t * 0.35, t * 0.22));
  float h2 = vnoise(p * 2.7 - vec2(t * 0.28, -t * 0.4));
  float h = h1 * 0.65 + h2 * 0.35;
  vec2 grad = vec2(vnoise(p * 1.2 + vec2(t * 0.35 + 0.05, t * 0.22)) - h1, vnoise(p * 1.2 + vec2(t * 0.35, t * 0.22 + 0.05)) - h1) * 14.0;
  vec3 n = normalize(vec3(-grad.x, 1.0, -grad.y));
  float diff = 0.82 + 0.18 * max(dot(n, uSunDir), 0.0);
  col *= diff;
  col = mix(col, col + uSkyCol * 0.12, h * (0.6 - uStorm * 0.3));
  // caustic-ish bright cells in the shallows
  float cell = smoothstep(0.62, 0.9, vnoise(p * 3.2 + vec2(t * 0.4, t * 0.3)) * vnoise(p * 2.1 - vec2(t * 0.2, 0.0)) * 2.0);
  col += uShallow * cell * 0.25 * (1.0 - smoothstep(0.0, 2.5, sd));
  // stylized glints
  vec3 V = normalize(vec3(0.55, 0.65, 0.5));
  vec3 Hh = normalize(uSunDir + V);
  float spec = pow(max(dot(n, Hh), 0.0), 90.0);
  col += uSunCol * smoothstep(0.35, 0.6, spec) * (0.9 - uStorm * 0.6);

  // foam: hard shoreline band + animated lines rolling in toward land
  float shore = 1.0 - smoothstep(0.0, 0.16 + uStorm * 0.08, sd);
  float lines = sin(sd * 4.2 + t * 1.7 + vnoise(p * 0.8) * 4.0) * 0.5 + 0.5;
  lines = smoothstep(0.86, 0.96, lines) * (1.0 - smoothstep(0.3, 2.6 + uStorm * 2.0, sd));
  lines *= smoothstep(0.35, 0.6, vnoise(p * 2.2 + t * 0.1));
  // whitecaps out at sea when stormy
  float caps = smoothstep(0.86, 0.95, vnoise(p * 0.9 + vec2(t * 0.6, t * 0.2)) * h2 * 1.6) * smoothstep(3.0, 8.0, sd) * uStorm;
  float foam = max(shore, max(lines * 0.8, caps * 0.7));
  col = mix(col, uFoam, foam);

  float alpha = mix(0.6, 0.97, smoothstep(0.0, 3.0, sd));
  alpha = max(alpha, foam);

  col = applyFog(col, p);
  // distance fog matching scene fog
  float fogF = smoothstep(uFogNear, uFogFar, vViewZ);
  col = mix(col, uFogColor, fogF);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
