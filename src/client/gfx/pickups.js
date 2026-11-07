// Pickup crates (cyan = pickups), the supply-drop cache with parachute, and
// distant ocean scenery (sunken towers, buoys) that frames the diorama.

import * as THREE from 'three';
import { GeoBuilder, rng } from './util.js';
import { TEAM, P } from './palette.js';
import { patchWorld } from './fields.js';

let shared = null;
function sharedAssets() {
  if (shared) return shared;
  const box = new GeoBuilder()
    .box(0.44, 0.3, 0.34, 0, 0.15, 0, 0x2b3d40)
    .box(0.46, 0.05, 0.36, 0, 0.3, 0, 0x22302f)
    .box(0.1, 0.18, 0.36, -0.16, 0.13, 0, 0x354a4c)
    .box(0.1, 0.18, 0.36, 0.16, 0.13, 0, 0x354a4c)
    .build({ ao: false });
  const band = new GeoBuilder()
    .box(0.465, 0.04, 0.365, 0, 0.22, 0, 0xffffff)
    .box(0.12, 0.02, 0.06, 0, 0.335, 0, 0xffffff)
    .build({ ao: false });
  const cache = new GeoBuilder()
    .box(0.62, 0.42, 0.5, 0, 0.21, 0, 0x2a383b)
    .box(0.66, 0.06, 0.54, 0, 0.42, 0, 0x1e2829)
    .box(0.66, 0.06, 0.54, 0, 0.03, 0, 0x1e2829)
    .box(0.08, 0.4, 0.52, -0.22, 0.21, 0, 0x3b5254)
    .box(0.08, 0.4, 0.52, 0.22, 0.21, 0, 0x3b5254)
    .build({ ao: false });
  const cacheBand = new GeoBuilder()
    .box(0.665, 0.05, 0.545, 0, 0.3, 0, 0xffffff)
    .box(0.05, 0.14, 0.05, 0.2, 0.5, 0.16, 0xffffff)
    .build({ ao: false });
  const beamGeo = new THREE.CylinderGeometry(0.16, 0.3, 4, 12, 1, true);
  beamGeo.translate(0, 2, 0);
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uCol: { value: new THREE.Color(TEAM.cyan).multiplyScalar(1.2) }, uTime: { value: 0 } },
    vertexShader: 'varying float vY; void main(){ vY = position.y / 4.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 uCol; uniform float uTime; varying float vY; void main(){ float a = (1.0 - vY) * (1.0 - vY) * (0.22 + 0.06 * sin(uTime * 3.0 + vY * 10.0)); gl_FragColor = vec4(uCol, a); }',
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const chute = new GeoBuilder();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    chute.box(0.62, 0.05, 0.46, Math.cos(a) * 0.55, 1.6 - 0.12, Math.sin(a) * 0.55, i % 2 ? 0xe5dcc6 : 0x2e7d7a, -a, 0, 0.42);
  }
  chute.box(0.6, 0.06, 0.6, 0, 1.68, 0, 0xe5dcc6, Math.PI / 4);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    chute.cyl(0.006, 1.4, 3, Math.cos(a) * 0.4, 0.95, Math.sin(a) * 0.4, 0x20282a, 0, Math.sin(a) * 0.45, -Math.cos(a) * 0.45);
  }
  shared = {
    box, band, cache, cacheBand, beamGeo, beamMat, chuteGeo: chute.build({ ao: false }),
    bodyMat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 }),
    bandMat: new THREE.MeshStandardMaterial({ color: TEAM.cyan, emissive: TEAM.cyan, emissiveIntensity: 2.2 }),
    chuteMat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide, transparent: true }),
  };
  return shared;
}

export function makeCrate(type) {
  const A = sharedAssets();
  const g = new THREE.Group();
  const spin = new THREE.Group();
  const big = type === 'cache';
  const body = new THREE.Mesh(big ? A.cache : A.box, A.bodyMat);
  const band = new THREE.Mesh(big ? A.cacheBand : A.band, A.bandMat);
  body.castShadow = true;
  spin.add(body, band);
  g.add(spin);
  const beam = new THREE.Mesh(A.beamGeo, A.beamMat);
  beam.scale.set(big ? 1.4 : 1, big ? 1.6 : 0.6, big ? 1.4 : 1);
  beam.renderOrder = 6;
  g.add(beam);
  g.userData = { spin, beam, phase: Math.random() * 6, big };
  return g;
}

export function makeChute() {
  const A = sharedAssets();
  const m = new THREE.Mesh(A.chuteGeo, A.chuteMat.clone());
  return m;
}

export function updatePickupShared(t) { if (shared) shared.beamMat.uniforms.uTime.value = t; }

/** Sunken towers, pylons and buoys out at sea, outside the playable map. */
export function buildScenery(S, seed, fields) {
  const r = rng(seed ^ 0xbadc0de);
  const b = new GeoBuilder();
  const half = S / 2;
  const spots = [];
  for (let i = 0; i < 14; i++) {
    const side = i % 4;
    const along = (r() - 0.5) * (S + 16);
    const out = half + 6 + r() * 12;
    const x = side === 0 ? out : side === 1 ? -out : along;
    const z = side === 2 ? out : side === 3 ? -out : along;
    if (spots.some(([a, c]) => Math.hypot(a - x, c - z) < 5)) continue;
    spots.push([x, z]);
    const kind = r();
    const m = new THREE.Matrix4().makeTranslation(x, -0.4, z);
    b.setParent(m);
    if (kind < 0.55) {
      // sunken tower block, broken top, windows
      const w = 2 + r() * 2.2, d = 2 + r() * 2, h = 1.2 + r() * 2.6;
      const c = r() < 0.5 ? P.plaster2 : P.wallConcrete;
      b.box(w, h, d, 0, h / 2, 0, c, r() * 0.3);
      for (let fy = 1.0; fy < h - 0.4; fy += 0.75) {
        b.box(w + 0.02, 0.32, d * 0.7, 0, fy, 0, P.window, 0);
        b.box(w * 0.7, 0.32, d + 0.02, 0, fy, 0, P.window, 0);
      }
      b.box(w * 0.6, 0.5 + r(), d * 0.5, (r() - 0.5) * w * 0.4, h + 0.2, (r() - 0.5) * d * 0.3, c, r(), 0.15, 0.2);
      for (let k = 0; k < 4; k++) b.cyl(0.03, 0.6 + r() * 0.6, 4, (r() - 0.5) * w * 0.8, h + 0.4, (r() - 0.5) * d * 0.8, P.rust2, 0, (r() - 0.5) * 0.6, (r() - 0.5) * 0.6);
    } else if (kind < 0.8) {
      // rusted pylon / crane stump
      const h = 2 + r() * 2;
      for (const [ox, oz] of [[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]]) b.box(0.12, h, 0.12, ox, h / 2, oz, P.rust2);
      for (let y = 0.8; y < h; y += 0.9) { b.box(0.92, 0.07, 0.07, 0, y, -0.4, P.rust); b.box(0.92, 0.07, 0.07, 0, y, 0.4, P.rust); b.box(0.07, 0.07, 0.92, -0.4, y, 0, P.rust); b.box(0.07, 0.07, 0.92, 0.4, y, 0, P.rust); }
      b.box(2.4, 0.18, 0.3, 0.8, h, 0, P.rust, r() * 3);
    } else {
      // buoy
      b.cyl(0.35, 0.6, 8, 0, 0.6, 0, P.rust);
      b.cyl(0.38, 0.12, 8, 0, 0.85, 0, P.bone);
      b.cone(0.18, 0.2, 0.9, 6, 0, 1.4, 0, P.steelDark);
    }
  }
  const mat = patchWorld(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), fields, 'scenery');
  const mesh = new THREE.Mesh(b.build({ stain: true }), mat);
  mesh.receiveShadow = false;
  return mesh;
}
