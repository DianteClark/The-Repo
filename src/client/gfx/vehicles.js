// Tidefall 5.0 vehicles and deployables: low-poly flat-shaded models built
// with GeoBuilder, matching the diorama props. Every factory returns a Group
// whose userData holds the animated parts. Geometry is cached and shared
// (userData.shared), so creating / dropping models never leaks GPU memory.
//
//   boat (RHIB) · UAV drone · strike jet · gunship · cargo plane
//   sentry turret · deployable barricade · claymore · semtex · throwing knife
//   set pieces: container ship · toppling tower · rogue-wave sheet

import * as THREE from 'three';
import { GeoBuilder } from './util.js';
import { P, TEAM } from './palette.js';

const G = new Map();
function geo(key, build) {
  let g = G.get(key);
  if (!g) { g = build(); g.userData.shared = true; G.set(key, g); }
  return g;
}

let M = null;
function mats() {
  if (M) return M;
  M = {
    body: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.2 }),
    matte: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    rotor: new THREE.MeshBasicMaterial({ color: 0x1a1e20, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }),
    add: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  };
  for (const m of Object.values(M)) m.userData.shared = true;
  return M;
}

/** A per-instance additive material (colour / opacity animate per object). Caller disposes. */
export function glowMat(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
}

function mesh(g, m, shadow = true) {
  const o = new THREE.Mesh(g, m);
  o.castShadow = shadow;
  return o;
}

// ---------- boat ----------

/** RHIB patrol boat, ~1.35 long (bow +z). userData: hull (bob), motor, seats [Vector3 local]. */
export function makeBoat(accent = P.teal) {
  const A = mats();
  const hullG = geo('boat:' + accent, () => {
    const b = new GeoBuilder();
    // grey inflatable tubes along both sides, meeting at the bow
    for (const s of [-1, 1]) {
      b.cyl(0.11, 1.0, 8, s * 0.28, 0.13, -0.05, 0x40474a, 0, Math.PI / 2, 0);
      b.cyl(0.115, 0.06, 8, s * 0.28, 0.13, 0.3, accent, 0, Math.PI / 2, 0);
      b.cyl(0.115, 0.06, 8, s * 0.28, 0.13, -0.38, accent, 0, Math.PI / 2, 0);
      b.cyl(0.1, 0.34, 8, s * 0.16, 0.13, 0.55, 0x40474a, s * -0.55, Math.PI / 2, 0);
    }
    // hard hull + deck
    b.box(0.5, 0.12, 1.05, 0, 0.06, -0.04, 0x2a3134);
    b.cone(0.26, 0.0, 0.32, 4, 0, 0.07, 0.6, 0x2a3134, Math.PI / 4, Math.PI / 2, 0);
    b.box(0.46, 0.03, 0.95, 0, 0.13, -0.05, 0x5f6a66);
    // console + windscreen + bench seats
    b.box(0.26, 0.24, 0.16, 0, 0.26, 0.12, 0xd9d2bf);
    b.box(0.27, 0.12, 0.03, 0, 0.42, 0.19, 0x1a2c33, 0, -0.5);
    b.box(0.36, 0.08, 0.14, 0, 0.18, -0.12, 0x23272a);
    b.box(0.36, 0.08, 0.14, 0, 0.18, -0.36, 0x23272a);
    // grab lines, number plate
    b.box(0.03, 0.03, 0.8, 0.39, 0.22, -0.05, 0xb59d6d); b.box(0.03, 0.03, 0.8, -0.39, 0.22, -0.05, 0xb59d6d);
    b.box(0.005, 0.06, 0.2, 0.395, 0.13, 0.2, P.bone); b.box(0.005, 0.06, 0.2, -0.395, 0.13, 0.2, P.bone);
    return b.build({ ao: false });
  });
  const motorG = geo('boat:motor', () => {
    const b = new GeoBuilder();
    b.box(0.16, 0.2, 0.14, 0, 0.26, 0, 0x1d2124);
    b.box(0.14, 0.04, 0.12, 0, 0.37, 0, 0xc8261c);
    b.box(0.05, 0.26, 0.05, 0, 0.06, -0.02, 0x2a2e30);
    b.box(0.08, 0.04, 0.1, 0, -0.06, -0.02, 0x2a2e30);
    return b.build({ ao: false });
  });
  const g = new THREE.Group();
  const hull = new THREE.Group();
  const h = mesh(hullG, A.body);
  h.receiveShadow = true;
  const motor = mesh(motorG, A.body);
  motor.position.set(0, 0.05, -0.6);
  hull.add(h, motor);
  // nav light
  const nav = new THREE.Mesh(geo('boat:nav', () => new THREE.SphereGeometry(0.03, 6, 4)), A.add);
  nav.position.set(0, 0.44, 0.12);
  hull.add(nav);
  g.add(hull);
  g.userData = {
    hull, motor, nav,
    seats: [new THREE.Vector3(0, 0.15, 0.0), new THREE.Vector3(0.16, 0.15, -0.22), new THREE.Vector3(-0.16, 0.15, -0.22), new THREE.Vector3(0, 0.15, -0.45)],
  };
  return g;
}

// ---------- aircraft ----------

/** Small fixed-wing UAV (nose +z). userData.prop spins, light blinks. */
export function makeDrone() {
  const A = mats();
  const bodyG = geo('uav', () => {
    const b = new GeoBuilder();
    b.cyl(0.07, 0.8, 8, 0, 0, 0, 0xb8bdb8, 0, Math.PI / 2, 0);
    b.sphere(0.085, 0, 0.02, 0.36, 0xc9cec8, 1, 0.9, 1.3, 8, 6); // sensor bulge
    b.box(1.5, 0.02, 0.16, 0, 0.03, 0.02, 0xa9aea9); // wings
    b.box(0.06, 0.02, 0.16, 0.74, 0.04, 0.02, TEAM.cyan);
    b.box(0.06, 0.02, 0.16, -0.74, 0.04, 0.02, TEAM.cyan);
    b.box(0.3, 0.015, 0.1, 0.12, 0.08, -0.37, 0xa9aea9, 0, 0, 0.6); // V tail
    b.box(0.3, 0.015, 0.1, -0.12, 0.08, -0.37, 0xa9aea9, 0, 0, -0.6);
    b.sphere(0.035, 0, -0.07, 0.36, 0x101418, 1, 1, 1, 6, 4); // camera ball
    return b.build({ ao: false });
  });
  const g = new THREE.Group();
  g.add(mesh(bodyG, A.body));
  const prop = new THREE.Mesh(geo('uav:prop', () => { const c = new THREE.CircleGeometry(0.12, 12); return c; }), A.rotor);
  prop.position.set(0, 0, -0.42);
  prop.rotation.y = Math.PI;
  g.add(prop);
  const light = new THREE.Mesh(geo('uav:light', () => new THREE.SphereGeometry(0.03, 6, 4)), A.add);
  light.position.set(0, -0.08, 0);
  g.add(light);
  g.userData = { prop, light };
  return g;
}

/** Strike jet (nose +z), afterburner cone in userData.burner. */
export function makeJet() {
  const A = mats();
  const bodyG = geo('jet', () => {
    const b = new GeoBuilder();
    b.cyl(0.12, 1.5, 8, 0, 0, 0, 0x6c767a, 0, Math.PI / 2, 0);
    b.cone(0.12, 0.0, 0.5, 8, 0, 0, 1.0, 0x6c767a, 0, Math.PI / 2, 0); // nose
    b.sphere(0.08, 0, 0.1, 0.45, 0x1a2c33, 1, 0.8, 2.2, 8, 6); // canopy
    // delta wings
    for (const s of [-1, 1]) {
      b.box(0.9, 0.025, 0.55, s * 0.5, -0.02, -0.15, 0x5d676b, s * 0.35);
      b.box(0.36, 0.02, 0.22, s * 0.25, 0.0, -0.7, 0x5d676b, s * 0.25); // tailplanes
      b.box(0.02, 0.36, 0.3, s * 0.12, 0.2, -0.62, 0x5d676b, 0, 0, s * 0.25); // twin fins
      b.box(0.06, 0.02, 0.2, s * 0.92, -0.02, -0.32, 0xc8261c); // wingtip
    }
    b.cyl(0.1, 0.12, 8, 0, 0, -0.78, 0x2a2e30, 0, Math.PI / 2, 0);
    return b.build({ ao: false });
  });
  const g = new THREE.Group();
  g.add(mesh(bodyG, A.body));
  const burner = new THREE.Mesh(geo('jet:burn', () => { const c = new THREE.ConeGeometry(0.09, 0.7, 8, 1, true); c.rotateX(-Math.PI / 2); c.translate(0, 0, -1.15); return c; }), glowMat(new THREE.Color(0xffa64a).multiplyScalar(2.2), 0.9));
  g.add(burner);
  g.userData = { burner };
  return g;
}

/** AC-130-style gunship (nose +z), side guns on the left (-x). userData.props[], lights[]. */
export function makeGunship(tint = 0x4e575a) {
  const A = mats();
  const bodyG = geo('gunship:' + tint, () => {
    const b = new GeoBuilder();
    b.cyl(0.26, 2.6, 10, 0, 0, 0, tint, 0, Math.PI / 2, 0);
    b.cone(0.26, 0.4, 0.5, 10, 0, 0.0, 1.5, tint, 0, Math.PI / 2, 0);
    b.cone(0.26, 0.15, 0.9, 10, 0, 0.12, -1.7, tint, 0, -Math.PI / 2 + 0.12, 0);
    b.box(0.3, 0.1, 0.16, 0, 0.18, 1.55, 0x1a2c33); // cockpit glass
    b.box(3.6, 0.06, 0.42, 0, 0.26, 0.2, tint); // high wing
    for (const x of [-1.25, -0.6, 0.6, 1.25]) b.cyl(0.08, 0.5, 8, x, 0.2, 0.42, 0x3a4144, 0, Math.PI / 2, 0); // nacelles
    b.box(1.3, 0.05, 0.36, 0, 0.36, -2.0, tint); // tailplane
    b.box(0.05, 0.7, 0.5, 0, 0.62, -1.95, tint); // fin
    b.box(0.08, 0.06, 0.3, -0.27, -0.05, 0.35, 0x1d2022); // side guns
    b.box(0.06, 0.05, 0.3, -0.27, -0.1, -0.15, 0x1d2022);
    return b.build({ ao: false });
  });
  const g = new THREE.Group();
  g.add(mesh(bodyG, A.body, false));
  const props = [];
  for (const x of [-1.25, -0.6, 0.6, 1.25]) {
    const p = new THREE.Mesh(geo('gunship:prop', () => new THREE.CircleGeometry(0.26, 14)), A.rotor);
    p.position.set(x, 0.2, 0.69);
    g.add(p); props.push(p);
  }
  const lights = [];
  for (const [x, c] of [[-1.8, 0xff3030], [1.8, 0x30ff60]]) {
    const l = new THREE.Mesh(geo('gs:l', () => new THREE.SphereGeometry(0.05, 6, 4)), glowMat(new THREE.Color(c).multiplyScalar(2)));
    l.position.set(x, 0.26, 0.2); g.add(l); lights.push(l);
  }
  const muzzle = new THREE.Object3D(); muzzle.position.set(-0.4, -0.05, 0.35); g.add(muzzle);
  g.userData = { props, lights, muzzle };
  return g;
}

// ---------- deployables ----------

/** Sentry turret on a tripod. userData.yaw (rotates), barrel (recoils), eye (team glow). */
export function makeSentry(color) {
  const A = mats();
  const baseG = geo('sentry:base', () => {
    const b = new GeoBuilder();
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      b.box(0.04, 0.42, 0.04, Math.cos(a) * 0.16, 0.16, Math.sin(a) * 0.16, 0x2d3234, 0, Math.sin(a) * 0.45, -Math.cos(a) * 0.45);
      b.box(0.08, 0.02, 0.08, Math.cos(a) * 0.3, 0.01, Math.sin(a) * 0.3, 0x2d3234);
    }
    b.cyl(0.07, 0.12, 8, 0, 0.36, 0, 0x3d4447);
    return b.build({ ao: false });
  });
  const headG = geo('sentry:head', () => {
    const b = new GeoBuilder();
    b.box(0.3, 0.2, 0.34, 0, 0.0, 0, 0x5b6468);
    b.box(0.32, 0.04, 0.36, 0, 0.11, 0, 0x2d3234);
    b.box(0.12, 0.14, 0.18, -0.2, -0.02, -0.04, 0x4c5a3e); // ammo box
    b.box(0.16, 0.08, 0.05, 0, 0.04, 0.18, 0x1a1e20); // sensor plate
    b.box(0.006, 0.12, 0.3, 0.155, 0.0, 0, P.bone);
    return b.build({ ao: false });
  });
  const barrelG = geo('sentry:barrel', () => {
    const b = new GeoBuilder();
    b.cyl(0.035, 0.42, 6, 0.05, 0, 0.36, 0x1d2022, 0, Math.PI / 2, 0);
    b.cyl(0.05, 0.08, 6, 0.05, 0, 0.56, 0x1d2022, 0, Math.PI / 2, 0);
    return b.build({ ao: false });
  });
  const g = new THREE.Group();
  const base = mesh(baseG, A.matte);
  const yaw = new THREE.Group(); yaw.position.y = 0.48;
  const head = mesh(headG, A.body);
  const barrel = mesh(barrelG, A.body);
  const eye = new THREE.Mesh(geo('sentry:eye', () => new THREE.BoxGeometry(0.1, 0.03, 0.01)), glowMat(new THREE.Color(color).multiplyScalar(2.2)));
  eye.position.set(0, 0.05, 0.208);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0.05, 0, 0.62);
  yaw.add(head, barrel, eye, muzzle);
  g.add(base, yaw);
  g.userData = { yaw, barrel, eye, muzzle };
  return g;
}

/** Engineer barricade: telescoping steel panel wall (spans the tile on local x). userData.panel rises. */
export function makeBarricade(color = 0xffb000) {
  const A = mats();
  const panelG = geo('barricade:' + color, () => {
    const b = new GeoBuilder();
    b.box(0.92, 1.0, 0.1, 0, 0.5, 0, 0x55605f);
    for (const x of [-0.3, 0, 0.3]) b.box(0.03, 0.96, 0.12, x, 0.5, 0, 0x3c4544);
    b.box(0.94, 0.06, 0.13, 0, 1.0, 0, 0x2f3636);
    b.box(0.94, 0.08, 0.13, 0, 0.62, 0, color); // squad stripe
    b.box(0.12, 0.2, 0.11, -0.3, 0.82, 0, 0x1a2228); // view slot
    b.box(0.12, 0.2, 0.11, 0.3, 0.82, 0, 0x1a2228);
    return b.build({ ao: false });
  });
  const footG = geo('barricade:foot', () => {
    const b = new GeoBuilder();
    for (const x of [-0.38, 0.38]) b.box(0.1, 0.08, 0.5, x, 0.04, 0, 0x2f3636);
    b.box(0.96, 0.05, 0.16, 0, 0.025, 0, 0x2f3636);
    return b.build({ ao: false });
  });
  const g = new THREE.Group();
  g.add(mesh(footG, A.matte));
  const panel = mesh(panelG, A.body);
  g.add(panel);
  g.userData = { panel };
  return g;
}

/** Claymore: small curved charge on legs facing local +z; laser origin in userData.eye. */
export function makeClaymore() {
  const A = mats();
  const g0 = geo('claymore', () => {
    const b = new GeoBuilder();
    b.box(0.22, 0.13, 0.05, 0, 0.11, 0, 0x4b5a3a, 0, -0.1);
    b.box(0.2, 0.02, 0.04, 0, 0.18, 0.005, 0x39452c);
    for (const x of [-0.08, 0.08]) { b.box(0.015, 0.1, 0.015, x, 0.03, 0.02, 0x2a2e30, 0, 0.3); b.box(0.015, 0.1, 0.015, x, 0.03, -0.02, 0x2a2e30, 0, -0.3); }
    b.box(0.07, 0.03, 0.01, 0, 0.12, 0.03, P.bone);
    return b.build({ ao: false });
  });
  const g = new THREE.Group();
  g.add(mesh(g0, A.matte));
  const eye = new THREE.Object3D(); eye.position.set(0, 0.16, 0.04); g.add(eye);
  g.userData = { eye };
  return g;
}

export function makeSemtex() {
  const A = mats();
  const g = new THREE.Group();
  g.add(mesh(geo('semtex', () => {
    const b = new GeoBuilder();
    b.cyl(0.07, 0.08, 8, 0, 0, 0, 0x3a4b5a);
    b.cyl(0.075, 0.02, 8, 0, 0.03, 0, 0xc9b240);
    b.box(0.04, 0.03, 0.04, 0, 0.055, 0, 0x1a1e20);
    return b.build({ ao: false });
  }), A.body));
  const led = new THREE.Mesh(geo('semtex:led', () => new THREE.SphereGeometry(0.022, 6, 4)), glowMat(0xff2a1a));
  led.position.y = 0.075; g.add(led);
  g.userData = { led };
  return g;
}

export function makeKnife() {
  const A = mats();
  const g = new THREE.Group();
  g.add(mesh(geo('knife', () => {
    const b = new GeoBuilder();
    b.box(0.03, 0.006, 0.2, 0, 0, 0.08, 0xd8dcdc);
    b.cone(0.016, 0.0, 0.05, 4, 0, 0, 0.2, 0xd8dcdc, 0, Math.PI / 2, 0);
    b.box(0.03, 0.025, 0.1, 0, 0, -0.06, 0x2a2420);
    b.box(0.07, 0.012, 0.015, 0, 0, -0.01, 0x4a4f50);
    return b.build({ ao: false });
  }), A.body, false));
  return g;
}

/** Throwable canister (flashbang): light grey cylinder with a yellow band. */
export function makeFlashbang() {
  const A = mats();
  const g = new THREE.Group();
  g.add(mesh(geo('flash', () => {
    const b = new GeoBuilder();
    b.cyl(0.045, 0.16, 8, 0, 0, 0, 0x8c9296);
    b.cyl(0.047, 0.03, 8, 0, 0.03, 0, 0xe0c040);
    b.box(0.02, 0.04, 0.06, 0.03, 0.09, 0, 0x2a2e30);
    return b.build({ ao: false });
  }), A.body));
  return g;
}

// ---------- care package ----------

/** Airdropped care package: crate with straps, beacon (gold when legendary). userData.beacon glows. */
export function makeCarePackage(gold = false) {
  const A = mats();
  const g = new THREE.Group();
  g.add(mesh(geo('cp:' + gold, () => {
    const b = new GeoBuilder();
    const body = gold ? 0x6b5320 : 0x3c4a3a, rim = gold ? 0xe8b830 : 0x26302a;
    b.box(0.74, 0.5, 0.6, 0, 0.25, 0, body);
    b.box(0.78, 0.06, 0.64, 0, 0.03, 0, rim); b.box(0.78, 0.06, 0.64, 0, 0.5, 0, rim);
    for (const x of [-0.22, 0.22]) b.box(0.06, 0.52, 0.62, x, 0.26, 0, gold ? 0xd9a62a : 0x2b3330);
    b.box(0.3, 0.12, 0.02, 0, 0.3, 0.305, P.bone);
    b.box(0.16, 0.16, 0.16, 0.24, 0.6, 0.16, 0x1a1e20);
    return b.build({ ao: false });
  }), A.body));
  const beacon = new THREE.Mesh(geo('cp:beacon', () => new THREE.SphereGeometry(0.06, 8, 6)), glowMat(gold ? new THREE.Color(0xffc040).multiplyScalar(2.5) : new THREE.Color(TEAM.cyan).multiplyScalar(2.2)));
  beacon.position.set(0.24, 0.72, 0.16);
  g.add(beacon);
  g.userData = { beacon, gold };
  return g;
}

// ---------- set pieces ----------

/** Container ship (bow +z), ~length L. */
export function makeShip(L = 12) {
  const A = mats();
  const g = new THREE.Group();
  g.add(mesh(geo('ship:' + L, () => {
    const b = new GeoBuilder();
    const W = 2.6, H = 1.6;
    b.box(W, H, L, 0, H / 2 - 0.9, 0, 0x2b3a44);
    b.box(W + 0.02, 0.35, L + 0.02, 0, -0.75, 0, 0x8a2a22); // antifouling red
    b.box(W + 0.04, 0.08, L, 0, H - 0.9, 0, P.bone);
    b.cone(W / 2, 0.0, 2.4, 4, 0, H / 2 - 0.9, L / 2 + 1.2, 0x2b3a44, Math.PI / 4, Math.PI / 2, 0); // bow
    // container stacks
    const cols = P.containerCols;
    let i = 0;
    for (let z = -L / 2 + 2.6; z < L / 2 - 0.8; z += 1.25) {
      const rows = 2 + ((i * 7) % 3);
      for (let r = 0; r < rows; r++) for (const x of [-0.65, 0.65]) b.box(1.2, 0.55, 1.15, x, 0.98 + r * 0.56 - 0.9 + 0.62, z, cols[(i + r * 3 + (x > 0 ? 1 : 0)) % cols.length]);
      i++;
    }
    // bridge at the stern
    b.box(W * 0.9, 2.4, 1.4, 0, H - 0.9 + 1.2, -L / 2 + 1.0, 0xd9d2bf);
    b.box(W * 0.92, 0.25, 1.42, 0, H - 0.9 + 2.0, -L / 2 + 1.0, 0x1a2c33);
    b.box(0.5, 1.2, 0.5, 0, H - 0.9 + 2.9, -L / 2 + 0.7, 0x8a2a22); // funnel
    return b.build({ stain: false, ao: false });
  }), A.body));
  return g;
}

/** Drowned tower for the Spire topple (pivot at its base, falls toward local +z). */
export function makeTower(h = 9) {
  const A = mats();
  const g = new THREE.Group();
  const body = mesh(geo('tower:' + h, () => {
    const b = new GeoBuilder();
    const w = 1.8;
    b.box(w, h, w, 0, h / 2, 0, 0x5c6070);
    for (let y = 0.8; y < h - 0.4; y += 0.62) {
      for (const s of [-1, 1]) {
        b.box(w + 0.02, 0.3, 0.22, 0, y, s * 0.45, 0x161a26);
        b.box(0.22, 0.3, w + 0.02, s * 0.45, y, 0, 0x161a26);
      }
    }
    b.box(w * 0.7, 1.0, w * 0.7, 0, h + 0.5, 0, 0x6a6878);
    b.cyl(0.04, 1.4, 4, 0.3, h + 1.6, 0.2, 0x2a2e30);
    return b.build({ ao: false });
  }), A.body);
  const neon = new THREE.Mesh(geo('tower:neon:' + h, () => {
    const b = new GeoBuilder();
    b.box(1.84, 0.12, 1.84, 0, h * 0.62, 0, 0xff4fa0);
    b.box(1.84, 0.12, 1.84, 0, h * 0.34, 0, 0xa05bff);
    b.box(0.14, 0.14, 0.14, 0, h + 1.05, 0, 0xff3b5c);
    return b.build({ ao: false });
  }), A.glow);
  g.add(body, neon);
  g.userData = { body, neon };
  return g;
}

/** Rogue-wave sheet: a curling wall of water spanning local x (width w), travelling +z. */
export function makeWave(w = 10) {
  const segX = 24, segY = 10;
  const g0 = new THREE.PlaneGeometry(w, 1, segX, segY);
  const pa = g0.attributes.position;
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), v = pa.getY(i) + 0.5; // 0 bottom .. 1 crest
    const curl = Math.sin(v * Math.PI * 0.85);
    pa.setXYZ(i, x, v * 3.0 + Math.sin(x * 0.9) * 0.15 * v, -1.8 + v * 2.0 + curl * 0.8 * v * v);
  }
  g0.computeVertexNormals();
  const mat = new THREE.ShaderMaterial({
    uniforms: { uT: { value: 0 }, uA: { value: 1 }, uDeep: { value: new THREE.Color(0x0e4a58) }, uFoam: { value: new THREE.Color(0xeef8f1) } },
    vertexShader: 'varying vec2 vUv; varying vec3 vN; void main(){ vUv = uv; vN = normalMatrix * normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform float uT, uA; uniform vec3 uDeep, uFoam; varying vec2 vUv; varying vec3 vN;
      float h(float x){ return fract(sin(x * 91.7) * 4375.5); }
      void main(){
        float v = vUv.y;
        vec3 c = mix(uDeep, uDeep * 1.9 + vec3(0.05, 0.15, 0.12), smoothstep(0.1, 0.8, v));
        float streak = smoothstep(0.6, 1.0, sin(vUv.x * 60.0 + v * 8.0 - uT * 6.0) * 0.5 + 0.5) * v;
        float crest = smoothstep(0.72, 0.9, v + sin(vUv.x * 40.0 + uT * 3.0) * 0.04);
        c = mix(c, uFoam, max(crest, streak * 0.35));
        float a = uA * mix(0.75, 1.0, crest) * smoothstep(0.0, 0.08, v);
        gl_FragColor = vec4(c, a);
      }`,
    transparent: true, side: THREE.DoubleSide, depthWrite: false,
  });
  const m = new THREE.Mesh(g0, mat);
  m.renderOrder = 7;
  m.frustumCulled = false;
  return m;
}

/** Dispose an object made here (shared geometry / materials are kept). */
export function disposeModel(o) {
  if (!o) return;
  o.parent?.remove(o);
  o.traverse((c) => {
    if (c.geometry && !c.geometry.userData?.shared) c.geometry.dispose();
    if (c.material && !c.material.userData?.shared) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose());
  });
}
