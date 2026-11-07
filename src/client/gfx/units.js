// Low-poly soldiers with class silhouettes and procedural animation.
//   Assault  — helmet, backpack with bedroll, mid rifle.
//   Marksman — slim, boonie + cape, tall antenna, long scoped rifle.
//   Breacher — bulky, heavy collar, big rusted door-shield, stubby shotgun.
//   Medic    — round cap-helmet, big cross-marked satchel + back pack, short SMG.
//   Recon    — peaked hood (no helmet), quad-drone backpack, scoped carbine.
//
// Rig: root (tile position, yaw = facing; local +z is "forward")
//        pose (whole-body offsets: crouch, downed, death)
//          legL / legR (hip pivots)
//          torso (hip pivot) → body, head (neck pivot), arms (shoulder pivot) → weapon, muzzle
//        blob shadow, team ring, overwatch cone, bleed ring (on root, not posed)
// Animation layers are scalar weights blended every frame: walk, hunker, aim,
// downed, reload, recoil, flinch, idle look/shift. No per-frame allocations.
//
// Revealed units (Recon scan) get a magenta X-ray outline: mask + inflated
// shell meshes on layer 1, drawn by the renderer in an extra pass on top of
// everything (so it reads through walls and fog).

import * as THREE from 'three';
import { GeoBuilder, damp, clamp } from './util.js';
import { TEAM } from './palette.js';

export const HIP = 0.4;
export const XRAY_LAYER = 1;
const NECK = 0.4; // torso-local neck pivot
const SHOULDER = 0.33;

const BODY = {
  assault: { cloth: 0x86a3a6, vest: 0x56706f, helm: 0x6d8a88, w: 0.3 },
  marksman: { cloth: 0xa7a07a, vest: 0x6f6a4b, helm: 0x8a8462, w: 0.26 },
  breacher: { cloth: 0x7d879a, vest: 0x4e5566, helm: 0x666f80, w: 0.38 },
  medic: { cloth: 0xb8b3a2, vest: 0x6a7774, helm: 0xd2cab4, w: 0.29 },
  recon: { cloth: 0x5f7468, vest: 0x3c4a44, helm: 0x4d6157, w: 0.27 },
};
export const CLASS_KEYS = Object.keys(BODY);
const SKIN = 0xd9b896, DARK = 0x2f3538, METAL = 0x69737a, BOOT = 0x3a3330, WOOD = 0x5b4a36;

/** Per-position averaged normals → 'aOut' attribute so inflated outline shells stay watertight. */
function addOutlineNormals(geo) {
  const pos = geo.attributes.position.array, nor = geo.attributes.normal.array;
  const acc = new Map();
  const key = (i) => `${Math.round(pos[i] * 500)},${Math.round(pos[i + 1] * 500)},${Math.round(pos[i + 2] * 500)}`;
  for (let i = 0; i < pos.length; i += 3) {
    const k = key(i);
    let a = acc.get(k);
    if (!a) acc.set(k, (a = [0, 0, 0]));
    a[0] += nor[i]; a[1] += nor[i + 1]; a[2] += nor[i + 2];
  }
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const a = acc.get(key(i)); const l = Math.hypot(a[0], a[1], a[2]) || 1;
    out[i] = a[0] / l; out[i + 1] = a[1] / l; out[i + 2] = a[2] / l;
  }
  geo.setAttribute('aOut', new THREE.BufferAttribute(out, 3));
  return geo;
}

const GEO = new Map();
function geos(cls) {
  if (!BODY[cls]) cls = 'assault';
  if (GEO.has(cls)) return GEO.get(cls);
  const B = BODY[cls];
  const w = B.w;
  const bulky = cls === 'breacher';
  // ---- leg (pivot at hip, extends down)
  const lg = new GeoBuilder()
    .box(bulky ? 0.13 : 0.11, 0.3, 0.13, 0, -0.17, 0, B.cloth)
    .box(0.125, 0.1, 0.18, 0, -0.35, 0.025, BOOT)
    .box(0.125, 0.08, 0.045, 0, -0.13, 0.07, B.vest); // knee pad
  if (cls === 'recon') lg.box(0.06, 0.09, 0.05, 0.07, -0.06, 0.0, DARK); // thigh pouch
  if (cls === 'medic') lg.box(0.05, 0.1, 0.09, -0.07, -0.08, 0.0, B.vest);
  const leg = lg.build({ ao: false });

  // ---- torso body (pivot at hip)
  const t = new GeoBuilder();
  t.box(w * 0.85, 0.1, 0.2, 0, 0.04, 0, B.vest); // belt
  t.box(w, 0.3, 0.22, 0, 0.23, 0, B.cloth);
  t.box(w * 0.92, 0.22, 0.24, 0, 0.25, 0.005, B.vest); // plate carrier
  t.box(0.07, 0.06, 0.03, -w * 0.25, 0.2, 0.13, DARK); // pouches
  t.box(0.07, 0.06, 0.03, w * 0.05, 0.2, 0.13, DARK);
  if (cls === 'assault') {
    t.box(0.26, 0.3, 0.14, 0, 0.26, -0.18, 0x3b4a3f); // backpack
    t.cyl(0.06, 0.3, 7, 0, 0.44, -0.18, 0x6c6150, 0, 0, Math.PI / 2); // bedroll
    t.box(0.1, 0.12, 0.05, 0.1, 0.18, -0.26, DARK);
    t.box(0.1, 0.12, 0.05, -0.1, 0.18, -0.26, DARK);
  } else if (cls === 'marksman') {
    t.box(0.18, 0.22, 0.1, -0.03, 0.26, -0.16, 0x3c3a2c); // radio
    t.cyl(0.012, 0.78, 4, -0.09, 0.72, -0.19, DARK); // antenna
    t.box(0.34, 0.34, 0.035, 0, 0.2, -0.14, 0x5b583f, 0, 0.12); // cape
    t.box(0.36, 0.08, 0.06, 0, 0.36, -0.11, 0x5b583f);
  } else if (cls === 'breacher') {
    t.box(w * 1.05, 0.12, 0.27, 0, 0.36, 0, METAL); // heavy collar
    t.box(0.22, 0.2, 0.1, 0, 0.24, -0.17, DARK);
    t.box(0.08, 0.14, 0.08, 0.13, 0.08, -0.12, 0x6a5a3a); // charges
    t.box(0.08, 0.14, 0.08, -0.13, 0.08, -0.12, 0x6a5a3a);
  } else if (cls === 'medic') {
    t.box(0.28, 0.32, 0.16, 0, 0.27, -0.19, 0xd8d0bb); // med pack (bone, cross is accent)
    t.box(0.3, 0.06, 0.17, 0, 0.44, -0.19, 0x9d968a);
    t.box(0.17, 0.16, 0.12, w / 2 + 0.07, 0.07, 0.02, 0xd8d0bb); // hip satchel
    t.box(0.02, 0.02, 0.5, 0, 0.27, 0.0, 0x5c5446, 0, 0.0, 0.78); // satchel strap
  } else if (cls === 'recon') {
    // drone backpack: flat body + 4 arms + rotor rings (wide shoulder silhouette)
    t.box(0.2, 0.22, 0.09, 0, 0.27, -0.16, DARK); // pack
    t.box(0.18, 0.05, 0.16, 0, 0.47, -0.2, 0x3a4440); // drone body
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      t.box(0.2, 0.025, 0.025, sx * 0.1, 0.48, -0.2 + sz * 0.07, METAL, sx * sz * 0.6);
      t.cyl(0.075, 0.015, 10, sx * 0.19, 0.5, -0.2 + sz * 0.13, 0x232a2c);
    }
    t.box(0.3, 0.24, 0.03, 0, 0.18, -0.135, 0x46574f, 0, 0.1); // short cloak
  }
  const torso = addOutlineNormals(t.build({ ao: false }));

  // ---- head (pivot at neck)
  const h = new GeoBuilder();
  h.box(0.09, 0.06, 0.09, 0, 0.0, 0, SKIN); // neck
  h.sphere(0.105, 0, 0.09, 0.01, SKIN, 1, 1.05, 1, 8, 6);
  if (cls === 'recon') {
    // peaked hood
    h.sphere(0.13, 0, 0.1, -0.015, B.helm, 1.05, 1.0, 1.12, 8, 6);
    h.cone(0.11, 0.0, 0.16, 6, 0, 0.24, -0.04, B.helm, 0, -0.35);
    h.box(0.24, 0.05, 0.08, 0, -0.01, 0.02, B.helm); // scarf
  } else if (cls === 'marksman') {
    h.sphere(0.12, 0, 0.13, -0.005, B.helm, 1.05, 0.62, 1.1, 8, 5); // boonie crown
    h.cyl(0.2, 0.02, 10, 0, 0.12, 0, B.helm); // brim
  } else if (cls === 'medic') {
    h.sphere(0.125, 0, 0.13, -0.005, B.helm, 1.05, 0.78, 1.1, 8, 5);
    h.box(0.2, 0.02, 0.08, 0, 0.11, 0.1, B.helm); // cap peak
  } else {
    h.sphere(bulky ? 0.135 : 0.125, 0, 0.13, -0.005, B.helm, 1.05, 0.8, 1.1, 8, 5);
    h.box(bulky ? 0.29 : 0.27, 0.025, 0.27, 0, 0.1, -0.01, B.helm);
    if (bulky) h.box(0.22, 0.09, 0.03, 0, 0.06, 0.12, METAL); // face guard
  }
  const head = addOutlineNormals(h.build({ ao: false }));

  // ---- team accents (torso: shoulders + class back marks; head: visor/stripe)
  const a = new GeoBuilder();
  const sw = bulky ? 0.13 : 0.1;
  a.box(sw, 0.07, 0.17, -w / 2 - 0.02, 0.35, 0, 0xffffff, 0, 0, 0.2);
  a.box(sw, 0.07, 0.17, w / 2 + 0.02, 0.35, 0, 0xffffff, 0, 0, -0.2);
  if (cls === 'marksman') a.sphere(0.03, -0.09, 1.11, -0.19, 0xffffff, 1, 1, 1, 6, 4);
  if (cls === 'assault') a.box(0.2, 0.025, 0.02, 0, 0.36, -0.252, 0xffffff);
  if (cls === 'breacher') a.box(0.06, 0.06, 0.02, 0, 0.36, 0.14, 0xffffff);
  if (cls === 'medic') {
    // big cross on the back pack + small one on the satchel: reads at 40px
    a.box(0.2, 0.065, 0.02, 0, 0.29, -0.275, 0xffffff);
    a.box(0.065, 0.2, 0.02, 0, 0.29, -0.275, 0xffffff);
    a.box(0.02, 0.04, 0.11, w / 2 + 0.157, 0.08, 0.02, 0xffffff);
    a.box(0.02, 0.11, 0.04, w / 2 + 0.157, 0.08, 0.02, 0xffffff);
  }
  if (cls === 'recon') {
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) a.box(0.03, 0.03, 0.03, sx * 0.19, 0.52, -0.2 + sz * 0.13, 0xffffff);
  }
  const accent = a.build({ ao: false });
  const ha = new GeoBuilder();
  if (cls === 'recon') ha.box(0.19, 0.04, 0.06, 0, 0.11, 0.095, 0xffffff); // goggles
  else if (cls === 'medic') {
    ha.box(0.18, 0.04, 0.06, 0, 0.1, 0.1, 0xffffff);
    ha.box(0.04, 0.11, 0.02, 0, 0.19, 0.105, 0xffffff, 0, -0.5); // cap cross
    ha.box(0.1, 0.035, 0.02, 0, 0.19, 0.105, 0xffffff, 0, -0.5);
  } else {
    ha.box(0.2, 0.045, 0.06, 0, 0.1, 0.1, 0xffffff); // visor
    if (cls !== 'marksman') ha.box(0.03, 0.02, 0.24, 0, cls === 'breacher' ? 0.245 : 0.235, -0.01, 0xffffff); // helmet stripe
  }
  const headAccent = ha.build({ ao: false });

  // ---- arms + weapon (pivot at shoulder)
  const g = new GeoBuilder();
  const ax = w / 2 + 0.02;
  g.box(0.08, 0.08, 0.26, ax, -0.08, 0.08, B.cloth, 0, 0.5); // right arm
  g.box(0.08, 0.08, 0.24, -w / 2, -0.08, 0.1, B.cloth, 0.35, 0.4); // left arm
  g.box(0.07, 0.07, 0.07, 0.08, -0.13, 0.25, SKIN);
  let muzzleZ, gx = 0.09;
  if (cls === 'assault') {
    g.box(0.06, 0.09, 0.42, gx, -0.1, 0.32, DARK);
    g.box(0.05, 0.12, 0.06, gx, -0.18, 0.3, METAL); // mag
    g.box(0.05, 0.07, 0.14, gx, -0.12, 0.08, METAL); // stock
    g.box(0.03, 0.03, 0.12, gx, -0.07, 0.56, METAL); // barrel
    muzzleZ = 0.62;
  } else if (cls === 'marksman') {
    g.box(0.05, 0.07, 0.7, gx, -0.1, 0.4, DARK);
    g.cyl(0.03, 0.2, 6, gx, -0.03, 0.3, METAL, 0, Math.PI / 2);
    g.box(0.05, 0.08, 0.16, gx, -0.13, 0.04, WOOD); // stock
    g.box(0.025, 0.025, 0.2, gx, -0.09, 0.82, METAL);
    muzzleZ = 0.92;
  } else if (cls === 'breacher') {
    gx = 0.11;
    g.box(0.08, 0.1, 0.36, gx, -0.12, 0.28, DARK);
    g.cyl(0.035, 0.18, 6, gx, -0.1, 0.5, METAL, 0, Math.PI / 2);
    g.box(0.07, 0.06, 0.16, gx, -0.16, 0.36, WOOD); // pump
    muzzleZ = 0.6;
    // door-shield on the left arm
    g.box(0.56, 0.7, 0.05, -0.1, -0.13, 0.32, 0x9a8a72, -0.15);
    g.box(0.5, 0.62, 0.012, -0.1, -0.14, 0.35, 0xb0582f, -0.15); // rusted skin
    g.box(0.32, 0.1, 0.02, -0.1, 0.07, 0.357, 0x1a2328, -0.15); // window slit
    g.box(0.5, 0.05, 0.07, -0.1, -0.47, 0.32, METAL, -0.15);
    g.box(0.05, 0.62, 0.07, -0.37, -0.13, 0.36, METAL, -0.15);
    g.box(0.05, 0.62, 0.07, 0.17, -0.13, 0.28, METAL, -0.15);
  } else if (cls === 'medic') {
    // compact SMG: short body, long vertical mag, folded stock
    g.box(0.06, 0.08, 0.26, gx, -0.1, 0.26, DARK);
    g.box(0.04, 0.16, 0.05, gx, -0.2, 0.28, METAL); // mag
    g.box(0.04, 0.05, 0.1, gx, -0.11, 0.1, METAL);
    g.box(0.028, 0.028, 0.08, gx, -0.08, 0.42, METAL);
    muzzleZ = 0.46;
  } else {
    // recon carbine: mid length, chunky optic, suppressor
    g.box(0.055, 0.08, 0.38, gx, -0.1, 0.3, DARK);
    g.box(0.05, 0.06, 0.1, gx, -0.03, 0.26, METAL); // optic
    g.box(0.05, 0.1, 0.05, gx, -0.17, 0.3, METAL); // mag
    g.box(0.045, 0.06, 0.12, gx, -0.12, 0.08, 0x4a524c); // stock
    g.cyl(0.024, 0.16, 6, gx, -0.08, 0.55, 0x23292b, 0, Math.PI / 2); // suppressor
    muzzleZ = 0.64;
  }
  const arms = addOutlineNormals(g.build({ ao: false }));
  const aa = new GeoBuilder();
  if (cls === 'medic') aa.box(0.085, 0.05, 0.1, ax, -0.07, 0.0, 0xffffff, 0, 0.5); // armband
  if (cls === 'recon') aa.box(0.012, 0.012, 0.02, gx, -0.03, 0.315, 0xffffff); // optic glint
  const armsAccent = aa.empty ? null : aa.build({ ao: false });
  addOutlineNormals(leg);
  const res = { leg, torso, head, accent, headAccent, arms, armsAccent, muzzleZ, gx };
  for (const k of ['leg', 'torso', 'head', 'accent', 'headAccent', 'arms', 'armsAccent']) if (res[k]) res[k].userData.shared = true;
  GEO.set(cls, res);
  return res;
}

// ---------- shared ground pieces ----------

let ringGeo = null, ring2Geo = null, blobGeo = null, coneGeo = null, bleedGeo = null;
let coneMat = null, blobMat = null, xrayMaskMat = null;
function sharedGeos() {
  if (ringGeo) return;
  ringGeo = new THREE.RingGeometry(0.34, 0.42, 32); ringGeo.rotateX(-Math.PI / 2);
  ring2Geo = new THREE.RingGeometry(0.47, 0.51, 32); ring2Geo.rotateX(-Math.PI / 2);
  blobGeo = new THREE.CircleGeometry(0.4, 20); blobGeo.rotateX(-Math.PI / 2);
  // Overwatch cone. CircleGeometry lies in XY with θ measured from +x; we
  // centre it on +y, and rotateX(+π/2) maps +y → +z, the soldier's forward.
  // (1.0 had rotateX(-π/2), which mapped it to -z: the cone sat behind them.)
  const R = 3.6, half = 0.55;
  coneGeo = new THREE.CircleGeometry(R, 28, Math.PI / 2 - half, half * 2);
  coneGeo.rotateX(Math.PI / 2);
  const uv = coneGeo.attributes.uv, p = coneGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    uv.setXY(i, Math.atan2(x, z) / half * 0.5 + 0.5, Math.hypot(x, z) / R);
  }
  coneMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uCol: { value: new THREE.Color(TEAM.cyan) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: /* glsl */`uniform float uTime; uniform vec3 uCol; varying vec2 vUv;
      void main(){
        float r = vUv.y, a = vUv.x;
        float edge = 1.0 - smoothstep(0.0, 0.05, min(a, 1.0 - a));
        float body = (1.0 - smoothstep(0.55, 1.0, r)) * 0.16;
        float sweep = smoothstep(0.08, 0.0, abs(fract(r * 1.0 - uTime * 0.45) - 0.5) - 0.42) * 0.25 * (1.0 - r);
        float arcs = smoothstep(0.03, 0.0, abs(fract(r * 4.0) - 0.5) - 0.47) * 0.12;
        float al = (body + edge * 0.55 * (1.0 - r * 0.7) + sweep + arcs) * smoothstep(0.0, 0.12, r);
        gl_FragColor = vec4(uCol * 1.4, al);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  blobMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false });
  bleedGeo = new THREE.RingGeometry(0.46, 0.6, 48); bleedGeo.rotateX(-Math.PI / 2);
  xrayMaskMat = new THREE.MeshBasicMaterial({ colorWrite: false });
  for (const o of [ringGeo, ring2Geo, blobGeo, coneGeo, bleedGeo, coneMat, blobMat, xrayMaskMat]) o.userData.shared = true;
}
export function updateUnitShared(t) { if (coneMat) coneMat.uniforms.uTime.value = t; }

const BLEED_FRAG = /* glsl */`
uniform float uTime, uCount, uMax; uniform vec3 uCol; varying vec2 vP;
void main(){
  float ang = atan(vP.x, -vP.y) / 6.2831853 + 0.5;          // 0..1 around
  float seg = floor(ang * uMax);
  float f = fract(ang * uMax);
  float gap = smoothstep(0.0, 0.04, f) * smoothstep(1.0, 0.96, f);
  float on = step(seg, uCount - 0.5);
  float pulse = 0.55 + 0.45 * sin(uTime * 5.0);
  float a = gap * mix(0.18, 0.95 * pulse, on);
  gl_FragColor = vec4(uCol * mix(0.8, 1.6, on), a);
}`;

function makeXrayShellMat() {
  return new THREE.ShaderMaterial({
    uniforms: { uCol: { value: new THREE.Color(TEAM.magenta).multiplyScalar(1.5) }, uW: { value: 0.035 }, uA: { value: 1 } },
    vertexShader: 'attribute vec3 aOut; uniform float uW; void main(){ vec3 p = position + aOut * uW; gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0); }',
    fragmentShader: 'uniform vec3 uCol; uniform float uA; void main(){ gl_FragColor = vec4(uCol, uA); }',
    side: THREE.BackSide, transparent: true, depthWrite: false, toneMapped: false,
  });
}

const _wp = new THREE.Vector3();

export class SoldierView {
  constructor(u, mine) {
    sharedGeos();
    const G = geos(u.cls);
    this.cls = BODY[u.cls] ? u.cls : 'assault';
    this.id = u.id;
    const team = mine ? TEAM.amber : TEAM.magenta;
    this.teamCol = new THREE.Color(team);
    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05, emissive: 0xffffff, emissiveIntensity: 0 });
    this.accentMat = new THREE.MeshStandardMaterial({ color: team, emissive: team, emissiveIntensity: 0.45, roughness: 0.5 });
    this.ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(team).multiplyScalar(1.6), transparent: true, opacity: 0.95, depthWrite: false });

    const root = (this.root = new THREE.Group());
    const pose = (this.pose = new THREE.Group());
    root.add(pose);
    this.parts = [];
    const mk = (geo, mat, outline = true) => {
      const m = new THREE.Mesh(geo, mat); m.castShadow = true;
      if (outline) this.parts.push(m);
      return m;
    };
    this.legL = mk(G.leg, this.bodyMat); this.legL.position.set(-0.08, HIP, 0);
    this.legR = mk(G.leg, this.bodyMat); this.legR.position.set(0.08, HIP, 0);
    this.torso = new THREE.Group(); this.torso.position.y = HIP;
    this.torso.add(mk(G.torso, this.bodyMat), mk(G.accent, this.accentMat, false));
    this.head = new THREE.Group(); this.head.position.y = NECK;
    this.head.add(mk(G.head, this.bodyMat), mk(G.headAccent, this.accentMat, false));
    this.torso.add(this.head);
    this.arms = new THREE.Group(); this.arms.position.y = SHOULDER;
    this.arms.add(mk(G.arms, this.bodyMat));
    if (G.armsAccent) this.arms.add(mk(G.armsAccent, this.accentMat, false));
    this.muzzle = new THREE.Object3D(); this.muzzle.position.set(G.gx, -0.09, G.muzzleZ);
    this.arms.add(this.muzzle);
    this.torso.add(this.arms);
    pose.add(this.legL, this.legR, this.torso);

    this.blob = new THREE.Mesh(blobGeo, blobMat); this.blob.position.y = 0.015; this.blob.renderOrder = 2;
    this.ring = new THREE.Mesh(ringGeo, this.ringMat); this.ring.position.y = 0.03; this.ring.renderOrder = 3;
    root.add(this.blob, this.ring);
    if (u.isLoneWolf) {
      this.ring2 = new THREE.Mesh(ring2Geo, this.ringMat); this.ring2.position.y = 0.03; this.ring2.renderOrder = 3;
      root.add(this.ring2);
    }
    this.cone = new THREE.Mesh(coneGeo, coneMat); this.cone.position.y = 0.06; this.cone.visible = false; this.cone.renderOrder = 3;
    root.add(this.cone);
    this.coneK = 0; this.coneGoal = 0;
    this.bleedMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uCount: { value: 2 }, uMax: { value: 2 }, uCol: { value: new THREE.Color(team) } },
      vertexShader: 'varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: BLEED_FRAG, transparent: true, depthWrite: false, toneMapped: false,
    });
    this.bleedRing = new THREE.Mesh(bleedGeo, this.bleedMat); this.bleedRing.position.y = 0.035; this.bleedRing.visible = false; this.bleedRing.renderOrder = 3;
    root.add(this.bleedRing);
    root.userData.unitId = u.id;
    pose.userData.unitId = u.id;

    const r = Math.random;
    this.phase = r() * 10;
    this.walk = 0; this.walkGoal = 0; this.walkPhase = 0;
    this.recoil = 0; this.flinch = 0; this.flash = 0;
    this.hunk = 0; this.hunkGoal = u.hunkered ? 1 : 0;
    this.down = u.downed ? 1 : 0; this.downGoal = this.down;
    this.dead = false; this.deathT = 0; this.deathDir = 1;
    this.corpse = false;
    this.yawGoal = null;
    this.aim = 0; this.aimGoal = 0;
    this.reload = 1; // 0..1 progress, 1 = idle
    this.pop = 0; // revive stand-up squash
    this.look = 0; this.lookGoal = 0; this.lookT = 1 + r() * 4;
    this.shift = 0; this.shiftGoal = 0; this.shiftT = 2 + r() * 5;
    this.fidget = 1; this.fidgetT = 6 + r() * 10;
    this.xray = null; this.xrayK = 0;
    this.fx = 0; this.fz = -1; // local flinch push direction
  }

  get position() { return this.root.position; }

  faceTo(wx, wz, instant) {
    const p = this.root.position;
    if (Math.abs(wx - p.x) + Math.abs(wz - p.z) < 1e-4) return;
    const y = Math.atan2(wx - p.x, wz - p.z);
    if (instant) { this.root.rotation.y = y; this.yawGoal = null; } else this.yawGoal = y;
  }
  /** Current facing as a world-space yaw (goal if turning). */
  facing() { return this.yawGoal ?? this.root.rotation.y; }
  /** Finish any turn / aim blend now (before sampling the muzzle). */
  settle() {
    if (this.yawGoal !== null) { this.root.rotation.y = this.yawGoal; this.yawGoal = null; }
    this.aim = this.aimGoal;
    this._pose(0, 0);
    this.root.updateMatrixWorld(true);
  }
  muzzleWorld(out) { this.muzzle.getWorldPosition(out); return out; }

  setOverwatch(on) { this.coneGoal = on ? 1 : 0; if (on) this.cone.visible = true; }
  get overwatch() { return this.coneGoal > 0; }
  setHunker(on) { this.hunkGoal = on ? 1 : 0; }
  setDowned(on, bleed = 2, max = 2) {
    this.downGoal = on ? 1 : 0;
    this.bleedRing.visible = on;
    this.bleedMat.uniforms.uCount.value = bleed;
    this.bleedMat.uniforms.uMax.value = Math.max(1, max);
    if (on) { this.hunkGoal = 0; this.aimGoal = 0; this.setOverwatch(false); this.ring.visible = false; }
    else { this.ring.visible = !this.dead; if (this.down > 0.3) this.pop = 1; }
  }
  setBleed(n) { this.bleedMat.uniforms.uCount.value = n; }
  doRecoil(k = 1) { this.recoil = k; }
  /** Hit reaction. (nx, nz): world direction the hit travels (pushes the body that way). */
  doFlinch(k = 1, nx = 0, nz = 0) {
    this.flinch = k; this.flash = Math.max(this.flash, k);
    const y = this.root.rotation.y, c = Math.cos(y), s = Math.sin(y);
    // world → local: pushed forward (+lz) pitches forward, pushed to +lx leans to +x
    if (nx || nz) { this.fx = nx * c - nz * s; this.fz = nx * s + nz * c; } else { this.fx = 0; this.fz = -1; }
  }
  doReload() { this.reload = 0; }
  die(dir = 1) {
    this.dead = true; this.deathT = 0; this.deathDir = dir;
    this.coneGoal = 0; this.cone.visible = false; this.hunkGoal = 0; this.aimGoal = 0;
    this.bleedRing.visible = false; this.setReveal(false);
  }
  /** Reset to a clean standing pose (used by syncFromState). */
  revive() {
    this.dead = false; this.deathT = 0; this.corpse = false;
    this.pose.rotation.set(0, 0, 0); this.pose.position.set(0, 0, 0);
    this.root.visible = true;
    this.ring.visible = true; this.blob.visible = true;
    if (this.ring2) this.ring2.visible = true;
    this.down = this.downGoal = 0; this.bleedRing.visible = false;
    this.recoil = this.flinch = this.flash = 0; this.reload = 1; this.pop = 0;
    this.aim = this.aimGoal = 0; this.walk = this.walkGoal = 0;
  }

  /** Magenta X-ray outline (Recon scan reveal). */
  setReveal(on) {
    if (on && !this.xray) {
      const shellMat = makeXrayShellMat();
      const list = [];
      for (const m of this.parts) {
        const mask = new THREE.Mesh(m.geometry, xrayMaskMat); mask.renderOrder = 1;
        const shell = new THREE.Mesh(m.geometry, shellMat); shell.renderOrder = 2;
        for (const o of [mask, shell]) { o.layers.set(XRAY_LAYER); o.frustumCulled = false; m.add(o); list.push(o); }
      }
      this.xray = { mat: shellMat, list };
    }
    this.xrayOn = !!on;
    if (this.xray) for (const o of this.xray.list) o.visible = this.xrayOn;
  }

  update(dt, t) {
    const r = this.root;
    if (this.yawGoal !== null) {
      let d = this.yawGoal - r.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      r.rotation.y += d * damp(16, dt);
      if (Math.abs(d) < 0.002) { r.rotation.y = this.yawGoal; this.yawGoal = null; }
    }
    this.walk += (this.walkGoal - this.walk) * damp(14, dt);
    this.hunk += (this.hunkGoal - this.hunk) * damp(9, dt);
    this.down += (this.downGoal - this.down) * damp(this.downGoal > this.down ? 7 : 5, dt);
    this.recoil = Math.max(0, this.recoil - dt * 4.5);
    this.flinch = Math.max(0, this.flinch - dt * 3.2);
    this.flash = Math.max(0, this.flash - dt * 5);
    this.pop = Math.max(0, this.pop - dt * 2.2);
    if (this.reload < 1) this.reload = Math.min(1, this.reload + dt / 0.75);
    this.aim += (this.aimGoal - this.aim) * damp(12, dt);
    this.bodyMat.emissiveIntensity = this.flash * 1.4;
    // overwatch cone fade in/out
    this.coneK += (this.coneGoal - this.coneK) * damp(8, dt);
    if (this.cone.visible) {
      const k = this.coneK;
      this.cone.scale.set(0.3 + 0.7 * k, 1, 0.3 + 0.7 * k);
      if (k < 0.02 && this.coneGoal === 0) this.cone.visible = false;
    }
    if (this.bleedRing.visible) {
      this.bleedMat.uniforms.uTime.value = t + this.phase;
      const s = 1 + Math.sin((t + this.phase) * 5) * 0.05;
      this.bleedRing.scale.set(s, 1, s);
    }
    if (this.xray && this.xrayOn) this.xray.mat.uniforms.uA.value = 0.75 + 0.25 * Math.sin(t * 6);
    // idle variety timers (look around, weight shift, gear fidget)
    const idle = this.walk < 0.1 && this.aim < 0.1 && this.down < 0.1 && !this.dead;
    this.lookT -= dt; this.shiftT -= dt; this.fidgetT -= dt;
    if (this.lookT <= 0) { this.lookT = 1.5 + Math.random() * 4; this.lookGoal = idle ? (Math.random() - 0.5) * 1.3 : 0; }
    if (this.shiftT <= 0) { this.shiftT = 2.5 + Math.random() * 5; this.shiftGoal = idle ? (Math.random() < 0.5 ? -1 : 1) : 0; }
    if (this.fidgetT <= 0) { this.fidgetT = 7 + Math.random() * 12; if (idle && this.hunk < 0.1) this.fidget = 0; }
    if (this.fidget < 1) this.fidget = Math.min(1, this.fidget + dt / 1.4);
    if (!idle) { this.lookGoal *= 0.0; this.shiftGoal = 0; }
    this.look += (this.lookGoal - this.look) * damp(3, dt);
    this.shift += (this.shiftGoal - this.shift) * damp(2, dt);
    this._pose(dt, t);
  }

  _pose(dt, t) {
    const p = this.pose;
    if (this.dead) {
      this.deathT += dt;
      const k = clamp(this.deathT / 0.55, 0, 1);
      const fall = k < 1 ? k * k : 1;
      const bounce = this.deathT > 0.55 ? Math.sin(clamp((this.deathT - 0.55) / 0.25, 0, 1) * Math.PI) * 0.12 : 0;
      const from = this.down; // already sitting: smaller fall
      p.rotation.x = -(Math.PI / 2 - 0.08) * fall + bounce;
      p.rotation.z = 0.15 * fall * this.deathDir;
      p.position.y = (0.06 - from * 0.2) * fall + (1 - fall) * (-0.28 * from);
      p.position.z = -0.12 * fall;
      this.torso.rotation.set(0.25 * fall, 0, 0);
      this.head.rotation.set(-0.3 * fall, 0.4 * fall * this.deathDir, 0);
      // weapon arm flops out to the side instead of pointing at the sky
      this.arms.rotation.set(-0.5 * fall, 0.5 * fall * this.deathDir, 1.25 * fall * this.deathDir);
      this.arms.position.set(0, SHOULDER, 0);
      this.legL.rotation.set(0.35 * fall, 0, -0.2 * fall); this.legR.rotation.set(-0.15 * fall, 0, 0.25 * fall);
      this.legL.scale.y = 1; this.legR.scale.y = 1;
      this.torso.scale.set(1, 1, 1);
      this.ring.visible = false; this.blob.visible = false;
      if (this.ring2) this.ring2.visible = false;
      return;
    }
    const ph = t * 2.1 + this.phase;
    if (this.walk > 0.01 || this.walkGoal) this.walkPhase += dt * 15;
    const wk = this.walk * (1 - this.down);
    const sw = Math.sin(this.walkPhase) * 0.75 * wk;
    const bob = Math.abs(Math.cos(this.walkPhase)) * 0.045 * wk;
    const hk = this.hunk * (1 - this.down);
    const dn = this.down;
    const aim = this.aim * (1 - dn);
    const sh = this.shift * (1 - dn) * (1 - hk);
    // legs: walk swing, crouch, sit-down (legs out forward)
    this.legL.rotation.set(sw - hk * 1.05 - dn * 1.3, 0, -sh * 0.06 + dn * 0.12);
    this.legR.rotation.set(-sw - hk * 0.35 - dn * 1.45, 0, -sh * 0.06 - dn * 0.25);
    this.legL.scale.y = 1 - hk * 0.18; this.legR.scale.y = 1 - hk * 0.3;
    const squash = Math.sin(this.pop * Math.PI) * 0.08;
    p.position.set(sh * 0.025, bob - hk * 0.13 - dn * 0.27 + squash, 0);
    p.rotation.set(0, 0, sh * 0.04);
    const breath = Math.sin(ph * (1 + dn * 0.8)) * (0.012 + dn * 0.02);
    this.torso.scale.set(1 + breath * 0.5, 1 + breath - squash * 0.5, 1 + breath * 0.5);
    this.torso.position.y = HIP;
    // torso: walk lean, crouch, aim lean, recoil, flinch, sit slump
    this.torso.rotation.x = 0.06 * wk + hk * 0.45 + aim * 0.1 - this.recoil * 0.12 + this.flinch * this.fz * 0.38 - dn * 0.42;
    this.torso.rotation.y = aim * 0.22 + dn * 0.2;
    this.torso.rotation.z = Math.sin(this.walkPhase * 0.5) * 0.04 * wk + Math.sin(t * 40) * this.flinch * 0.05 - this.flinch * this.fx * 0.38 - sh * 0.05 + dn * 0.22;
    // head: look around when idle, sight down when aiming, droop when downed
    this.head.rotation.set(-aim * 0.08 + dn * 0.35 + this.flinch * 0.2, this.look * (1 - aim) - aim * 0.2 + dn * 0.3, dn * -0.25);
    // arms: low-ready → shouldered aim, recoil kick, reload flourish, gear fidget
    const rl = this.reload < 1 ? Math.sin(this.reload * Math.PI) : 0;
    const fg = this.fidget < 1 ? Math.sin(this.fidget * Math.PI) : 0;
    const guard = this.cls === 'breacher' ? hk * 0.5 : hk * 0.2;
    const lowReady = 0.42 * (1 - aim) * (1 - wk * 0.4);
    this.arms.rotation.x = lowReady + Math.sin(ph * 0.5) * 0.02 - this.recoil * 0.45 + this.flinch * 0.3 - guard
      + wk * 0.08 + rl * 0.55 + fg * 0.25 + dn * 0.75 - aim * 0.04;
    this.arms.rotation.y = rl * 0.35 - fg * 0.2;
    this.arms.rotation.z = rl * 0.7 + fg * 0.45 + dn * 0.25;
    this.arms.position.set(0, SHOULDER + aim * 0.05, -this.recoil * 0.06 + aim * 0.02);
  }

  /** World position of the head (for labels / text anchors). */
  headWorld(out) { this.head.getWorldPosition(out); return out; }

  dispose() {
    this.bodyMat.dispose(); this.accentMat.dispose(); this.ringMat.dispose(); this.bleedMat.dispose();
    if (this.xray) this.xray.mat.dispose();
  }
}
void _wp;
