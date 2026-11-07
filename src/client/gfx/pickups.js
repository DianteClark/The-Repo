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
  for (const o of [box, band, cache, cacheBand, beamGeo, beamMat, shared.chuteGeo, shared.bodyMat, shared.bandMat, shared.chuteMat]) o.userData.shared = true;
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
  m.material.userData = {};
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
  // ---- shoreline: rocks hugging the cliff foot, rotten pier pilings, a beached
  // fishing boat, a capsized hull, a half-drowned lighthouse and road signs
  // poking out of the sea where the coast road used to run.
  const I = new THREE.Matrix4();
  b.setParent(I);
  for (let i = 0; i < S * 2.2; i++) {
    const side = i % 4, along = (r() - 0.5) * (S + 2), out = half + 0.4 + r() * 1.6;
    const x = side === 0 ? out : side === 1 ? -out : along, z = side === 2 ? out : side === 3 ? -out : along;
    const sz = 0.14 + r() * 0.32;
    b.ico(sz, x, -0.12, z, r() < 0.6 ? 0x7d766b : 0x8f897c, 1.3, 0.55 + r() * 0.35, 1, r() * 6, r() * 0.4, 0, 0);
  }
  const edgePt = (off) => {
    const side = (r() * 4) | 0, along = (r() - 0.5) * (S - 6);
    return { x: side === 0 ? half + off : side === 1 ? -half - off : along, z: side === 2 ? half + off : side === 3 ? -half - off : along, side };
  };
  // pier: two rows of pilings running out to sea, a few deck planks left
  for (let n = 0; n < 2; n++) {
    const e = edgePt(0.5);
    const dx = e.side === 0 ? 1 : e.side === 1 ? -1 : 0, dz = e.side === 2 ? 1 : e.side === 3 ? -1 : 0;
    for (let i = 0; i < 7; i++) {
      for (const o of [-0.45, 0.45]) {
        const px = e.x + dx * i * 0.9 + (dz ? o : 0), pz = e.z + dz * i * 0.9 + (dx ? o : 0);
        const h = 0.6 + r() * 0.5 - i * 0.05;
        b.cyl(0.07, h + 0.8, 6, px, h / 2 - 0.4, pz, P.wood2, 0, (r() - 0.5) * 0.15, (r() - 0.5) * 0.15);
      }
      if (r() < 0.45) b.box(dx ? 0.22 : 1.1, 0.05, dx ? 1.1 : 0.22, e.x + dx * i * 0.9, 0.35 - i * 0.03, e.z + dz * i * 0.9, P.wood, 0, (r() - 0.5) * 0.2, (r() - 0.5) * 0.2);
    }
  }
  // beached fishing boat leaning on the rocks
  {
    const e = edgePt(1.6);
    const ry = Math.atan2(e.x, e.z) + (r() - 0.5);
    const m = new THREE.Matrix4().makeRotationY(ry).setPosition(e.x, -0.1, e.z);
    b.setParent(m);
    const hull = [P.teal, 0x3e5f7d, P.rust][(r() * 3) | 0];
    b.box(1.0, 0.55, 3.0, 0, 0.2, 0, hull, 0, 0.08, 0.35);
    b.box(1.02, 0.12, 3.02, 0, 0.5, 0, P.bone, 0, 0.08, 0.35);
    b.cone(0.5, 0.0, 0.9, 4, 0, 0.25, 1.85, hull, Math.PI / 4, Math.PI / 2, 0.35);
    b.box(0.7, 0.6, 0.8, 0.12, 0.75, -0.6, P.bone, 0, 0.08, 0.35); // wheelhouse
    b.box(0.72, 0.18, 0.5, 0.12, 0.85, -0.45, P.window, 0, 0.08, 0.35);
    b.cyl(0.04, 1.6, 5, 0.3, 1.3, 0.3, P.steelDark, 0, 0.08, 0.35); // mast
    b.box(0.04, 0.04, 1.2, 0.5, 1.6, 0.3, P.steelDark, 0, 0.08, 0.35);
    b.box(0.5, 0.1, 0.5, -0.7, -0.05, 0.6, 0x2f3b38, 0.4); // net spilling out
  }
  // capsized hull further out
  {
    const e = edgePt(9 + r() * 5);
    const m = new THREE.Matrix4().makeRotationY(r() * 6).setPosition(e.x, -0.25, e.z);
    b.setParent(m);
    b.box(2.0, 0.5, 6.0, 0, 0.15, 0, P.rust2, 0, 0, Math.PI - 0.15);
    b.box(0.18, 0.3, 6.1, -0.05, 0.45, 0, P.rustDark, 0, 0, -0.15);
    b.cone(1.0, 0.0, 1.8, 4, 0, 0.1, 3.8, P.rust2, Math.PI / 4, Math.PI / 2, Math.PI - 0.15);
    b.cyl(0.3, 0.08, 8, 0.1, 0.5, -2.6, 0x5a4a3a, 0, Math.PI / 2, 0); // propeller hub
  }
  // half-drowned lighthouse on its own rock
  {
    const e = edgePt(14 + r() * 4);
    const m = new THREE.Matrix4().makeTranslation(e.x, -0.4, e.z);
    b.setParent(m);
    b.ico(1.8, 0, -0.4, 0, P.cliff, 1.3, 0.7, 1.1, r() * 6);
    b.cyl(0.62, 4.2, 10, 0, 2.3, 0, P.bone, 0, 0.06, 0);
    for (const y of [1.2, 2.6]) b.cyl(0.64, 0.5, 10, 0, y, 0, P.rust, 0, 0.06, 0);
    b.cyl(0.78, 0.12, 10, 0.25, 4.4, 0, P.steelDark, 0, 0.06, 0);
    b.cyl(0.42, 0.55, 8, 0.27, 4.75, 0, P.window, 0, 0.06, 0);
    b.cone(0.5, 0.0, 0.45, 8, 0.29, 5.25, 0, P.rust2, 0, 0.06, 0);
  }
  // coast-road signs sticking out of the water
  for (let i = 0; i < 4; i++) {
    const e = edgePt(2.2 + r() * 4);
    const m = new THREE.Matrix4().makeRotationY(r() * 6).setPosition(e.x, -0.3, e.z);
    b.setParent(m);
    const lean = (r() - 0.5) * 0.4;
    b.cyl(0.035, 1.6, 5, 0, 0.8, 0, P.steel, 0, lean, 0);
    if (r() < 0.5) b.box(0.55, 0.38, 0.03, lean * -1.6, 1.5, 0, P.tealDeep, 0, lean, 0);
    else b.cyl(0.26, 0.03, 3, lean * -1.6, 1.5, 0, P.bone, 0, Math.PI / 2 + lean, 0);
    b.box(0.4, 0.06, 0.035, lean * -1.6, 1.5, 0.02, P.bone, 0, lean, 0);
  }
  b.setParent(null);
  const mat = patchWorld(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), fields, 'scenery');
  const mesh = new THREE.Mesh(b.build({ stain: true }), mat);
  mesh.receiveShadow = false;
  return mesh;
}
