// Tidefall 5.0 soldiers: seven class silhouettes, real weapons, 2-bone arms
// and a layered procedural animation system.
//
// Silhouettes (must read at ~40px):
//   Assault  — helmet + goggles, backpack with bedroll, rifle.
//   Marksman — slim, boonie + fringed cape, tall antenna, long scoped rifle.
//   Breacher — bulky, heavy collar, face guard, big rusted door-shield, shotgun.
//   Medic    — round cap-helmet with cross, big cross-marked pack, SMG.
//   Recon    — peaked hood, quad-drone backpack, carbine.
//   Engineer — wide-brim hard hat, tall folded barricade plate on the back, welding tank.
//   Gunner   — widest: huge pauldrons, ammo-can backpack with a belt over the
//              shoulder, beanie + headset, LMG.
//
// Rig: root (tile position, yaw = facing; local +z is "forward")
//        pose (whole-body offsets: crouch, downed, death, emotes)
//          legL / legR (hip pivots)
//          torso (hip pivot) → body, head (neck pivot),
//            arms (shoulder-centre pivot) → upper/fore arm segments (2-bone IK
//            toward hand targets), gun socket → WeaponModel (gfx/weapons.js), muzzle
//        blob shadow, team ring, overwatch cone, bleed ring, emote props (on root)
// The squad colour (ring, visor, armband, shoulder and class marks) is one
// material that skins never touch.
//
// Actions (one at a time, each returns its key moment in seconds where useful):
//   doReload(), doSwap(), doThrow(kind) → release, doStim(), doDeployCover() → plant,
//   doSuppress(dur), playEmote(id, {fx}), stopEmote(), doHit(kind, nx, nz),
//   die(dir, kind). See the bottom of this header for render.js hooks.
//
// No per-frame allocations.

import * as THREE from 'three';
import { GeoBuilder, damp, clamp, easeOutCubic, easeInOutCubic, lerp, hash } from './util.js';
import { TEAM } from './palette.js';
import { CLASS_KIT, TAG, skinKit, hasSkin, makeSkinMaterial, tickSkinMaterial } from './skins.js';
import { WeaponModel, equipGeo, propMaterial, resolveWeapon, CLASS_DEFAULT_WEAPON } from './weapons.js';
import { tickCamos } from './camos.js';

export const HIP = 0.4;
export const XRAY_LAYER = 1;
const NECK = 0.4; // torso-local neck pivot
const SHOULDER = 0.33;
const UPPER = 0.16, FORE = 0.16; // arm segment lengths
const GUN_SCALE = 1.18;

const BODY = CLASS_KIT;
export const CLASS_KEYS = Object.keys(BODY);

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
/** Class geometry baked with a skin's palette. Silhouette is identical for every skin. */
export function soldierGeos(cls, skin = 'default') {
  if (!BODY[cls]) cls = 'assault';
  if (!hasSkin(skin)) skin = 'default';
  const gk = cls + '|' + skin;
  if (GEO.has(gk)) { const hit = GEO.get(gk); GEO.delete(gk); GEO.set(gk, hit); return hit; }
  const B = skinKit(cls, skin);
  const SKIN = B.skinTone, DARK = B.dark, METAL = B.metal, BOOT = B.boot;
  const w = B.w;
  const bulky = cls === 'breacher' || cls === 'gunner';
  const thick = bulky ? 1.18 : 1;
  // ---- leg (pivot at hip, extends down)
  const lg = new GeoBuilder()
    .tag(TAG.cloth).box(bulky ? 0.13 : 0.11, 0.3, 0.13, 0, -0.17, 0, B.cloth)
    .tag(TAG.boot).box(0.125, 0.1, 0.18, 0, -0.35, 0.025, BOOT)
    .box(0.13, 0.03, 0.19, 0, -0.39, 0.025, DARK)
    .tag(TAG.vest).box(0.125, 0.08, 0.045, 0, -0.13, 0.07, B.vest); // knee pad
  lg.tag(TAG.pack);
  if (cls === 'recon') lg.box(0.06, 0.09, 0.05, 0.07, -0.06, 0.0, DARK); // thigh pouch
  if (cls === 'medic') lg.box(0.05, 0.1, 0.09, -0.07, -0.08, 0.0, B.vest);
  if (cls === 'engineer') lg.box(0.05, 0.12, 0.08, 0.075, -0.1, 0.0, B.pack2); // tool pocket
  if (cls === 'gunner') lg.tag(TAG.vest).box(0.14, 0.12, 0.05, 0, -0.04, 0.065, B.vest); // thigh plate
  const leg = addOutlineNormals(lg.build({ ao: false }));

  // ---- torso body (pivot at hip)
  const t = new GeoBuilder();
  t.tag(TAG.vest).box(w * 0.85, 0.1, 0.2, 0, 0.04, 0, B.vest); // belt
  t.tag(TAG.cloth).box(w, 0.3, 0.22, 0, 0.23, 0, B.cloth);
  t.tag(TAG.vest).box(w * 0.92, 0.22, 0.24, 0, 0.25, 0.005, B.vest); // plate carrier
  t.box(w * 0.6, 0.12, 0.025, 0, 0.27, 0.13, B.vest); // front plate face
  t.tag(TAG.pack).box(0.07, 0.06, 0.03, -w * 0.25, 0.17, 0.135, DARK); // pouches
  t.box(0.07, 0.06, 0.03, w * 0.05, 0.17, 0.135, DARK);
  t.box(0.06, 0.07, 0.04, w * 0.42, 0.06, 0.06, DARK); // hip pouch
  if (cls === 'assault') {
    t.box(0.26, 0.3, 0.14, 0, 0.26, -0.18, B.pack); // backpack
    t.cyl(0.06, 0.3, 7, 0, 0.44, -0.18, B.pack2, 0, 0, Math.PI / 2); // bedroll
    t.box(0.1, 0.12, 0.05, 0.1, 0.18, -0.26, DARK);
    t.box(0.1, 0.12, 0.05, -0.1, 0.18, -0.26, DARK);
    t.tag(TAG.metal).box(0.04, 0.1, 0.04, -w * 0.4, 0.2, 0.1, 0x4a5a3a); // frag on the strap
  } else if (cls === 'marksman') {
    t.box(0.18, 0.22, 0.1, -0.03, 0.26, -0.16, B.pack); // radio
    t.tag(TAG.metal).cyl(0.012, 0.78, 4, -0.09, 0.72, -0.19, DARK); // antenna
    t.tag(TAG.cloth).box(0.34, 0.34, 0.035, 0, 0.2, -0.14, B.pack2, 0, 0.12); // cape
    for (let i = 0; i < 7; i++) t.box(0.035, 0.1 + (i % 3) * 0.03, 0.02, -0.15 + i * 0.05, 0.0 - (i % 2) * 0.02, -0.15, B.pack2, 0, 0.15, (i - 3) * 0.06); // ghillie fringe
    t.box(0.36, 0.08, 0.06, 0, 0.36, -0.11, B.pack2);
  } else if (cls === 'breacher') {
    t.tag(TAG.metal).box(w * 1.05, 0.12, 0.27, 0, 0.36, 0, METAL); // heavy collar
    t.tag(TAG.pack).box(0.22, 0.2, 0.1, 0, 0.24, -0.17, B.pack);
    t.box(0.08, 0.14, 0.08, 0.13, 0.08, -0.12, B.pack2); // charges
    t.box(0.08, 0.14, 0.08, -0.13, 0.08, -0.12, B.pack2);
  } else if (cls === 'medic') {
    t.box(0.28, 0.32, 0.16, 0, 0.27, -0.19, B.pack); // med pack (cross is accent)
    t.box(0.3, 0.06, 0.17, 0, 0.44, -0.19, B.pack2);
    t.box(0.17, 0.16, 0.12, w / 2 + 0.07, 0.07, 0.02, B.pack); // hip satchel
    t.box(0.02, 0.02, 0.5, 0, 0.27, 0.0, 0x5c5446, 0, 0.0, 0.78); // satchel strap
  } else if (cls === 'recon') {
    t.box(0.2, 0.22, 0.09, 0, 0.27, -0.16, B.pack); // pack
    t.tag(TAG.metal).box(0.18, 0.05, 0.16, 0, 0.47, -0.2, 0x3a4440); // drone body
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      t.box(0.2, 0.025, 0.025, sx * 0.1, 0.48, -0.2 + sz * 0.07, METAL, sx * sz * 0.6);
      t.cyl(0.075, 0.015, 10, sx * 0.19, 0.5, -0.2 + sz * 0.13, 0x232a2c);
    }
    t.tag(TAG.cloth).box(0.3, 0.24, 0.03, 0, 0.18, -0.135, B.pack2, 0, 0.1); // short cloak
  } else if (cls === 'engineer') {
    t.box(0.24, 0.26, 0.12, 0, 0.24, -0.17, B.pack); // tool pack
    // folded barricade plate: a tall slab rising above the head (the class read)
    t.tag(TAG.pack).box(0.4, 0.62, 0.05, 0, 0.5, -0.255, B.pack2);
    t.tag(TAG.metal).box(0.42, 0.04, 0.06, 0, 0.2, -0.255, METAL); t.box(0.42, 0.04, 0.06, 0, 0.8, -0.255, METAL);
    t.box(0.04, 0.62, 0.06, -0.2, 0.5, -0.255, METAL); t.box(0.04, 0.62, 0.06, 0.2, 0.5, -0.255, METAL);
    for (let i = 0; i < 4; i++) t.box(0.07, 0.36, 0.012, -0.135 + i * 0.09, 0.5, -0.285, i % 2 ? 0x1d1d1d : 0xf2c230, 0, 0, 0.6); // hazard bands
    t.cyl(0.05, 0.3, 8, w / 2 + 0.04, 0.22, -0.13, 0xb8402a); // welding tank
    t.cyl(0.02, 0.04, 6, w / 2 + 0.04, 0.39, -0.13, METAL);
    t.box(0.03, 0.14, 0.02, -w * 0.45, 0.02, 0.06, METAL, 0, 0, 0.3); // wrench on the belt
  } else if (cls === 'gunner') {
    t.tag(TAG.pack).box(0.3, 0.3, 0.17, 0, 0.27, -0.2, B.pack); // ammo can pack
    t.tag(TAG.metal).box(0.32, 0.04, 0.19, 0, 0.43, -0.2, METAL); t.box(0.08, 0.03, 0.03, 0, 0.465, -0.2, DARK);
    for (let i = 0; i < 9; i++) { // belt over the right shoulder
      const k = i / 8, x = lerp(0.12, w / 2 - 0.02, k), y = lerp(0.42, 0.46, Math.sin(k * Math.PI)), z = lerp(-0.12, 0.12, k);
      t.box(0.05, 0.03, 0.035, x, y, z, 0xb09040, 0, 0, 0.3);
    }
    t.tag(TAG.vest).box(0.16, 0.12, 0.2, -w / 2 - 0.04, 0.38, 0, B.vest, 0, 0, 0.35); // pauldrons
    t.box(0.16, 0.12, 0.2, w / 2 + 0.04, 0.38, 0, B.vest, 0, 0, -0.35);
  }
  const torso = addOutlineNormals(t.build({ ao: false }));

  // ---- head (pivot at neck)
  const h = new GeoBuilder();
  h.tag(TAG.skin).box(0.09, 0.06, 0.09, 0, 0.0, 0, SKIN); // neck
  h.sphere(0.105, 0, 0.09, 0.01, SKIN, 1, 1.05, 1, 8, 6);
  h.tag(TAG.helm);
  if (cls === 'recon') {
    h.sphere(0.13, 0, 0.1, -0.015, B.helm, 1.05, 1.0, 1.12, 8, 6);
    h.cone(0.11, 0.0, 0.16, 6, 0, 0.24, -0.04, B.helm, 0, -0.35);
    h.tag(TAG.cloth).box(0.24, 0.05, 0.08, 0, -0.01, 0.02, B.helm); // scarf
  } else if (cls === 'marksman') {
    h.sphere(0.12, 0, 0.13, -0.005, B.helm, 1.05, 0.62, 1.1, 8, 5); // boonie crown
    h.cyl(0.2, 0.02, 10, 0, 0.12, 0, B.helm); // brim
    h.tag(TAG.cloth).box(0.2, 0.06, 0.06, 0, 0.04, 0.08, B.pack2); // face scarf
  } else if (cls === 'medic') {
    h.sphere(0.125, 0, 0.13, -0.005, B.helm, 1.05, 0.78, 1.1, 8, 5);
    h.box(0.2, 0.02, 0.08, 0, 0.11, 0.1, B.helm); // cap peak
  } else if (cls === 'engineer') {
    h.sphere(0.13, 0, 0.14, -0.005, B.helm, 1.08, 0.78, 1.15, 10, 5); // hard hat
    h.cyl(0.19, 0.022, 12, 0, 0.12, 0.0, B.helm, 0, 0, 0, 0.21); // wide brim
    h.box(0.035, 0.04, 0.24, 0, 0.235, -0.005, B.helm); // ridge
    h.tag(TAG.metal).cyl(0.025, 0.03, 8, 0, 0.17, 0.13, METAL, 0, Math.PI / 2); // headlamp
  } else if (cls === 'gunner') {
    h.sphere(0.118, 0, 0.13, -0.01, B.helm, 1.04, 0.8, 1.08, 8, 5); // beanie
    h.box(0.24, 0.035, 0.24, 0, 0.09, -0.01, B.helm); // beanie fold
    h.tag(TAG.metal).cyl(0.045, 0.04, 8, 0.115, 0.1, 0, DARK, 0, 0, Math.PI / 2); h.cyl(0.045, 0.04, 8, -0.115, 0.1, 0, DARK, 0, 0, Math.PI / 2); // ear cups
    h.box(0.02, 0.02, 0.14, 0.12, 0.05, 0.07, DARK, 0.2); // boom mic
    h.box(0.03, 0.03, 0.03, 0.1, 0.05, 0.14, DARK);
  } else {
    h.sphere(bulky ? 0.135 : 0.125, 0, 0.13, -0.005, B.helm, 1.05, 0.8, 1.1, 8, 5);
    h.box(bulky ? 0.29 : 0.27, 0.025, 0.27, 0, 0.1, -0.01, B.helm);
    if (bulky) h.tag(TAG.metal).box(0.22, 0.09, 0.03, 0, 0.06, 0.12, METAL); // face guard
    if (cls === 'assault') { h.tag(TAG.metal).cyl(0.03, 0.03, 8, -0.045, 0.2, 0.1, DARK, 0, Math.PI / 2 - 0.4); h.cyl(0.03, 0.03, 8, 0.045, 0.2, 0.1, DARK, 0, Math.PI / 2 - 0.4); } // goggles up
  }
  const head = addOutlineNormals(h.build({ ao: false }));

  // ---- squad accents (torso: shoulders + class back marks; head: visor/stripe)
  const a = new GeoBuilder();
  const sw = bulky ? 0.13 : 0.1;
  if (cls === 'gunner') { a.box(0.17, 0.03, 0.21, -w / 2 - 0.05, 0.44, 0, 0xffffff, 0, 0, 0.35); a.box(0.17, 0.03, 0.21, w / 2 + 0.05, 0.44, 0, 0xffffff, 0, 0, -0.35); }
  else { a.box(sw, 0.07, 0.17, -w / 2 - 0.02, 0.35, 0, 0xffffff, 0, 0, 0.2); a.box(sw, 0.07, 0.17, w / 2 + 0.02, 0.35, 0, 0xffffff, 0, 0, -0.2); }
  if (cls === 'marksman') a.sphere(0.03, -0.09, 1.11, -0.19, 0xffffff, 1, 1, 1, 6, 4);
  if (cls === 'assault') a.box(0.2, 0.025, 0.02, 0, 0.36, -0.252, 0xffffff);
  if (cls === 'breacher') a.box(0.06, 0.06, 0.02, 0, 0.36, 0.14, 0xffffff);
  if (cls === 'engineer') a.box(0.36, 0.05, 0.02, 0, 0.74, -0.285, 0xffffff);
  if (cls === 'gunner') a.box(0.33, 0.05, 0.02, 0, 0.3, -0.29, 0xffffff);
  if (cls === 'medic') {
    a.box(0.2, 0.065, 0.02, 0, 0.29, -0.275, 0xffffff);
    a.box(0.065, 0.2, 0.02, 0, 0.29, -0.275, 0xffffff);
    a.box(0.02, 0.04, 0.11, w / 2 + 0.157, 0.08, 0.02, 0xffffff);
    a.box(0.02, 0.11, 0.04, w / 2 + 0.157, 0.08, 0.02, 0xffffff);
  }
  if (cls === 'recon') for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) a.box(0.03, 0.03, 0.03, sx * 0.19, 0.52, -0.2 + sz * 0.13, 0xffffff);
  const accent = a.build({ ao: false });
  const ha = new GeoBuilder();
  if (cls === 'recon') ha.box(0.19, 0.04, 0.06, 0, 0.11, 0.095, 0xffffff); // goggles
  else if (cls === 'medic') {
    ha.box(0.18, 0.04, 0.06, 0, 0.1, 0.1, 0xffffff);
    ha.box(0.04, 0.11, 0.02, 0, 0.19, 0.105, 0xffffff, 0, -0.5); // cap cross
    ha.box(0.1, 0.035, 0.02, 0, 0.19, 0.105, 0xffffff, 0, -0.5);
  } else if (cls === 'engineer') {
    ha.box(0.2, 0.045, 0.06, 0, 0.085, 0.1, 0xffffff); // welding goggles band
    ha.box(0.22, 0.03, 0.03, 0, 0.165, 0.115, 0xffffff); // hat band
  } else if (cls === 'gunner') {
    ha.box(0.2, 0.04, 0.05, 0, 0.1, 0.1, 0xffffff); // ballistic shades
    ha.box(0.03, 0.02, 0.2, 0, 0.215, -0.01, 0xffffff); // beanie stripe
  } else {
    ha.box(0.2, 0.045, 0.06, 0, 0.1, 0.1, 0xffffff); // visor
    if (cls !== 'marksman') ha.box(0.03, 0.02, 0.24, 0, cls === 'breacher' ? 0.245 : 0.235, -0.01, 0xffffff); // helmet stripe
  }
  const headAccent = ha.build({ ao: false });

  // ---- arm segments (built along +z from the joint; the hand sits at the end of the forearm)
  const up = new GeoBuilder();
  up.tag(TAG.cloth).box(0.085 * thick, 0.085 * thick, UPPER + 0.02, 0, 0, UPPER / 2, B.cloth);
  up.tag(TAG.vest).box(0.1 * thick, 0.1 * thick, 0.07, 0, 0, 0.03, B.vest); // shoulder pad
  const upper = addOutlineNormals(up.build({ ao: false }));
  const fo = new GeoBuilder();
  fo.tag(TAG.cloth).box(0.075 * thick, 0.075 * thick, FORE, 0, 0, FORE / 2 - 0.02, B.cloth);
  fo.tag(TAG.boot).box(0.084 * thick, 0.084 * thick, 0.04, 0, 0, FORE - 0.05, BOOT); // glove cuff
  fo.box(0.07 * thick, 0.07 * thick, 0.07, 0, -0.005, FORE, BOOT); // hand
  const fore = addOutlineNormals(fo.build({ ao: false }));
  const ab = new GeoBuilder();
  ab.box(0.095 * thick, 0.095 * thick, 0.05, 0, 0, 0.1, 0xffffff); // squad armband on the upper arm
  const armband = ab.build({ ao: false });
  let shield = null;
  if (cls === 'breacher') {
    const s = new GeoBuilder();
    s.tag(TAG.vest).box(0.56, 0.7, 0.05, -0.1, -0.13, 0.32, skin === 'default' ? 0x9a8a72 : B.shield, -0.15);
    s.box(0.5, 0.62, 0.012, -0.1, -0.14, 0.35, skin === 'default' ? 0xb0582f : B.shieldSkin, -0.15); // rusted skin
    s.tag(TAG.metal).box(0.32, 0.1, 0.02, -0.1, 0.07, 0.357, 0x1a2328, -0.15); // window slit
    s.box(0.5, 0.05, 0.07, -0.1, -0.47, 0.32, METAL, -0.15);
    s.box(0.05, 0.62, 0.07, -0.37, -0.13, 0.36, METAL, -0.15);
    s.box(0.05, 0.62, 0.07, 0.17, -0.13, 0.28, METAL, -0.15);
    shield = addOutlineNormals(s.build({ ao: false }));
  }
  const res = { leg, torso, head, accent, headAccent, upper, fore, armband, shield, w, thick };
  for (const k of ['leg', 'torso', 'head', 'accent', 'headAccent', 'upper', 'fore', 'armband', 'shield']) if (res[k]) res[k].userData.shared = true;
  GEO.set(gk, res);
  // LRU cap (bots wear random skins: the class×skin cache used to grow every match).
  // A match needs ≤16 combos; evicted geometries are disposed (re-uploaded if still drawn).
  while (GEO.size > 40) {
    const k0 = GEO.keys().next().value, old = GEO.get(k0);
    GEO.delete(k0);
    for (const k of ['leg', 'torso', 'head', 'accent', 'headAccent', 'upper', 'fore', 'armband', 'shield']) old[k]?.dispose?.();
  }
  return res;
}

// ---------- shared ground pieces + emote props ----------

let ringGeo = null, ring2Geo = null, blobGeo = null, coneGeo = null, bleedGeo = null;
let coneMat = null, blobMat = null, xrayMaskMat = null;
let PROPS = null;
function sharedGeos() {
  if (ringGeo) return;
  ringGeo = new THREE.RingGeometry(0.34, 0.42, 32); ringGeo.rotateX(-Math.PI / 2);
  ring2Geo = new THREE.RingGeometry(0.47, 0.51, 32); ring2Geo.rotateX(-Math.PI / 2);
  blobGeo = new THREE.CircleGeometry(0.4, 20); blobGeo.rotateX(-Math.PI / 2);
  // Overwatch cone, centred on the soldier's forward (+z).
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
function props() {
  if (PROPS) return PROPS;
  const sh = (o) => { o.userData.shared = true; return o; };
  // deck chair
  const c = new GeoBuilder();
  c.box(0.42, 0.03, 0.4, 0, 0.2, 0.02, 0xe8e0c8); // seat
  for (let i = 0; i < 4; i++) c.box(0.42 / 4 - 0.01, 0.031, 0.4, -0.157 + i * 0.105, 0.201, 0.02, i % 2 ? 0x2e7d7a : 0xe8e0c8);
  c.box(0.42, 0.48, 0.03, 0, 0.4, -0.25, 0xe8e0c8, 0, -0.55);
  for (let i = 0; i < 4; i++) c.box(0.42 / 4 - 0.01, 0.48, 0.031, -0.157 + i * 0.105, 0.401, -0.249, i % 2 ? 0x2e7d7a : 0xe8e0c8, 0, -0.55);
  for (const sx of [-1, 1]) { c.box(0.025, 0.3, 0.025, sx * 0.21, 0.1, 0.2, 0x8d6a42, 0, -0.5); c.box(0.025, 0.3, 0.025, sx * 0.21, 0.1, -0.15, 0x8d6a42, 0, 0.5); }
  c.cyl(0.05, 0.1, 8, 0.32, 0.05, 0.25, 0x3a6a8a); c.cyl(0.03, 0.03, 8, 0.32, 0.11, 0.25, 0xffd04a); // drink
  const chair = sh(c.build({ ao: false }));
  // flag pole (cloth is a separate squad-coloured plane)
  const f = new GeoBuilder();
  f.cyl(0.018, 1.5, 6, 0, 0.75, 0, 0x8d6a42); f.sphere(0.035, 0, 1.52, 0, 0xd8b048); f.cone(0.12, 0.2, 0.08, 6, 0, 0.03, 0, 0x5a5a50);
  const pole = sh(f.build({ ao: false }));
  const vc = sh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
  const ringG = sh(new THREE.TorusGeometry(0.55, 0.035, 6, 40)); ringG.rotateX(Math.PI / 2);
  const ringM = sh(new THREE.MeshBasicMaterial({ color: new THREE.Color(0x9ff0ff).multiplyScalar(1.6), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  PROPS = { chair, pole, vc, ringG, ringM };
  return PROPS;
}
export function updateUnitShared(t) { if (coneMat) coneMat.uniforms.uTime.value = t; tickCamos(t); }

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

// ---------- tiny math helpers (no allocations) ----------
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _d = new THREE.Vector3(), _pole = new THREE.Vector3(), _e = new THREE.Vector3();
const _q = new THREE.Quaternion(), _eu = new THREE.Euler();
const ZF = new THREE.Vector3(0, 0, 1);
const seg01 = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
const bump = (t, a, b) => { const k = seg01(t, a, b); return Math.sin(k * Math.PI); };
const ease = (t, a, b) => easeInOutCubic(seg01(t, a, b));

/** Orient `mesh` (built along +z) at S pointing to P. */
function aim(mesh, S, P) {
  _d.subVectors(P, S);
  const L = _d.length();
  if (L < 1e-5) return;
  _d.multiplyScalar(1 / L);
  mesh.position.copy(S);
  mesh.quaternion.setFromUnitVectors(ZF, _d);
}
/** 2-bone solve: shoulder S → target T with a pole; writes the elbow into E. */
function solveElbow(S, T, a, b, px, py, pz, E) {
  _d.subVectors(T, S);
  let d = _d.length();
  if (d < 1e-4) { E.copy(S).y -= a; return; }
  _d.multiplyScalar(1 / d);
  d = Math.min(d, a + b - 1e-3);
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
  _pole.set(px, py, pz);
  _pole.addScaledVector(_d, -_pole.dot(_d));
  if (_pole.lengthSq() < 1e-6) _pole.set(0, -1, 0).addScaledVector(_d, -_d.y);
  _pole.normalize();
  E.copy(S).addScaledVector(_d, a * cosA).addScaledVector(_pole, a * sinA);
}

/** Weapon spec for a unit from whatever the sim gives (5.0 loadout or 3.0 class weapon). */
export function unitWeapons(u = {}) {
  // SIM-1 5.0: u.weapons = [primaryDef, secondaryDef|null], u.slot = 0|1, u.weapon = current def
  // (defs from buildWeapon carry .attachments). Older shapes: u.loadout / u.primary / 3.0 class weapon.
  if (Array.isArray(u.weapons) && u.weapons[0]) {
    const p = u.weapons[0], s = u.weapons[1];
    const sec = (u.slot | 0) === 1;
    const prim = sec ? p : (u.weapon || p); // a picked-up legendary replaces the current weapon
    return {
      primary: { weapon: prim, attachments: prim.attachments || u.loadout?.primary?.attachments || {} },
      secondary: { weapon: (sec ? u.weapon : s) || 'pistol', attachments: {} },
      usingSecondary: sec && !!(u.weapon || s),
    };
  }
  const L = u.loadout || {};
  const p = u.primary || L.primary || null;
  const s = u.secondary || L.secondary || null;
  const cur = u.weapon && typeof u.weapon === 'object' && (u.weapon.id || u.weapon.cat) ? u.weapon : null;
  const prim = cur || p;
  return {
    primary: { weapon: prim ? (prim.def || prim) : (u.weapon || CLASS_DEFAULT_WEAPON[u.cls] || 'ar'), attachments: (prim && prim.attachments) || (p && p.attachments) || {} },
    secondary: { weapon: s ? (s.def || s) : 'pistol', attachments: (s && s.attachments) || {} },
    usingSecondary: false,
  };
}

const DEATH_KINDS = ['back', 'crumple', 'spin', 'knees', 'head', 'back'];

export class SoldierView {
  /**
   * opts: { color: 0xRRGGBB squad colour, skin, cos: full cosmetic loadout
   * ({skin, camo, charm, emote, ...}), camo, charm, weapon, attachments, secondary }.
   * Weapons default to the unit's loadout (u.loadout / u.primary / u.weapon), then the class default.
   * (Legacy: a boolean second argument means "my squad" → amber / magenta.)
   */
  constructor(u, opts = {}) {
    sharedGeos();
    if (typeof opts === 'boolean') opts = { color: opts ? TEAM.amber : TEAM.magenta };
    const cos = opts.cos || {};
    const skin = hasSkin(opts.skin ?? cos.skin) ? (opts.skin ?? cos.skin) : 'default';
    this.skin = skin;
    this.cls = BODY[u.cls] ? u.cls : 'assault';
    const G = (this.G = soldierGeos(this.cls, skin));
    this.id = u.id;
    const team = opts.color ?? TEAM.magenta;
    this.teamCol = new THREE.Color(team);
    this.bodyMat = makeSkinMaterial(skin);
    this.accentMat = new THREE.MeshStandardMaterial({ color: team, emissive: team, emissiveIntensity: 0.45, roughness: 0.5 });
    this.ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(team).multiplyScalar(1.6), transparent: true, opacity: 0.95, depthWrite: false });
    this.flashCol = new THREE.Color(0xffffff);

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
    this.torso.add(this.arms);
    // arm segments (arms frame)
    this.upR = mk(G.upper, this.bodyMat); this.foR = mk(G.fore, this.bodyMat);
    this.upL = mk(G.upper, this.bodyMat); this.foL = mk(G.fore, this.bodyMat);
    this.upR.add(mk(G.armband, this.accentMat, false));
    this.arms.add(this.upR, this.foR, this.upL, this.foL);
    this.shR = new THREE.Vector3(G.w / 2 + 0.015, -0.01, 0); this.shL = new THREE.Vector3(-G.w / 2 - 0.015, -0.01, 0);
    this.elR = new THREE.Vector3(); this.elL = new THREE.Vector3();
    this.hR = new THREE.Vector3(); this.hL = new THREE.Vector3();
    if (G.shield) { this.shield = mk(G.shield, this.bodyMat); this.arms.add(this.shield); }
    // held item (left hand)
    this.item = new THREE.Mesh(equipGeo('frag'), propMaterial()); this.item.visible = false; this.item.castShadow = true;
    this.arms.add(this.item);
    // weapon socket
    this.gun = new THREE.Group();
    this.arms.add(this.gun);
    const W = unitWeapons(u);
    this.loadout = {
      primary: { weapon: opts.weapon ?? W.primary.weapon, attachments: opts.attachments ?? W.primary.attachments },
      secondary: { weapon: opts.secondary ?? W.secondary.weapon, attachments: W.secondary.attachments },
    };
    this.camo = opts.camo ?? cos.camo ?? 'none';
    this.charm = opts.charm ?? cos.charm ?? 'default';
    this.emoteId = cos.emote || 'default';
    this.slot = W.usingSecondary ? 'secondary' : 'primary';
    this.weapon = new WeaponModel({ cls: this.cls });
    this.gun.add(this.weapon.group);
    this._applyWeapon();
    this.muzzle = this.weapon.muzzle; // render.js reads this through muzzleWorld()
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
    this.dead = false; this.deathT = 0; this.deathDir = 1; this.deathKind = 'back';
    this.corpse = false;
    this.yawGoal = null;
    this.aim = 0; this.aimGoal = 0;
    this.reload = 1; // legacy flag (1 = idle)
    this.pop = 0; // revive stand-up squash
    this.look = 0; this.lookGoal = 0; this.lookT = 1 + r() * 4;
    this.shift = 0; this.shiftGoal = 0; this.shiftT = 2 + r() * 5;
    this.fidget = 1; this.fidgetT = 6 + r() * 10;
    this.xray = null; this.xrayK = 0;
    this.fx = 0; this.fz = -1; // local flinch push direction
    this.hitKind = 'light'; this.stagger = 0;
    this.act = null; // current action {kind, t, dur, ...}
    this.emote = null; // looping emote {id, t, fx, props}
    this.supT = 0; // suppress time left
  }

  get position() { return this.root.position; }

  // ---------- weapons ----------
  _applyWeapon() {
    const L = this.loadout[this.slot] || this.loadout.primary;
    this.weapon.set({ weapon: L.weapon, attachments: L.attachments || {}, camo: this.slot === 'primary' ? this.camo : 'none', charm: this.slot === 'primary' ? this.charm : 'default', cls: this.cls });
    const cat = this.weapon.info.cat;
    this.hold = cat === 'pistol' || cat === 'mpistol' ? 'pistol' : cat === 'launcher' ? 'launcher' : this.cls === 'breacher' && cat === 'shotgun' ? 'shield' : 'rifle';
    this._wkey = this._weaponKey();
  }
  _weaponKey() {
    const L = this.loadout[this.slot] || {};
    const id = (x) => (x && typeof x === 'object' ? x.id || x.cat || x.name : x);
    return [this.slot, id(L.weapon), JSON.stringify(L.attachments || {}), this.camo, this.charm].join('|');
  }
  /** Current weapon info: { id, cat, legendary, name }. */
  get weaponInfo() { return this.weapon.info; }
  /** Replace the loadout (any subset): { primary:{weapon, attachments}, secondary:{weapon}, camo, charm, slot }. */
  setLoadout(o = {}) {
    if (o.primary) this.loadout.primary = { ...this.loadout.primary, ...o.primary };
    if (o.secondary) this.loadout.secondary = { ...this.loadout.secondary, ...o.secondary };
    if (o.camo !== undefined) this.camo = o.camo;
    if (o.charm !== undefined) this.charm = o.charm;
    if (o.slot) this.slot = o.slot;
    if (this._weaponKey() !== this._wkey) this._applyWeapon();
  }
  /** Shortcut: put weapon def/id `w` in the primary slot (e.g. a legendary from a gold crate). */
  setWeapon(w, attachments) { this.setLoadout({ primary: { weapon: w, attachments: attachments ?? this.loadout.primary.attachments }, slot: 'primary' }); }
  /** Re-read the unit's loadout from sim state; cheap no-op when nothing changed. */
  syncWeapon(u) {
    const W = unitWeapons(u);
    this.setLoadout({ primary: W.primary, secondary: W.secondary, slot: W.usingSecondary ? 'secondary' : 'primary' });
  }

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
    if (this.act && (this.act.kind === 'reload' || this.act.kind === 'swap')) this._endAct();
    this._pose(0, this._t || 0);
    this.root.updateMatrixWorld(true);
  }
  muzzleWorld(out) { this.weapon.muzzle.getWorldPosition(out); return out; }
  /** World position of the left hand (throw release point). */
  handWorld(out) { out.copy(this.hL); this.arms.localToWorld(out); return out; }

  setOverwatch(on) { this.coneGoal = on ? 1 : 0; if (on) this.cone.visible = true; }
  get overwatch() { return this.coneGoal > 0; }
  setHunker(on) { this.hunkGoal = on ? 1 : 0; }
  setDowned(on, bleed = 2, max = 2) {
    this.downGoal = on ? 1 : 0;
    this.bleedRing.visible = on;
    this.bleedMat.uniforms.uCount.value = bleed;
    this.bleedMat.uniforms.uMax.value = Math.max(1, max);
    if (on) { this.hunkGoal = 0; this.aimGoal = 0; this.setOverwatch(false); this.ring.visible = false; this.stopEmote(); this._endAct(); }
    else { this.ring.visible = !this.dead; if (this.down > 0.3) this.pop = 1; }
  }
  setBleed(n) { this.bleedMat.uniforms.uCount.value = n; }
  doRecoil(k = 1) { this.recoil = k; }
  /** Hit reaction. (nx, nz): world direction the hit travels (pushes the body that way). */
  doFlinch(k = 1, nx = 0, nz = 0, kind) {
    this.flinch = k; this.flash = Math.max(this.flash, k); this.flashCol.set(0xffffff);
    this.hitKind = kind || (k >= 1.2 ? 'heavy' : 'light');
    if (this.hitKind === 'heavy' || this.hitKind === 'blast') this.stagger = 1;
    const y = this.root.rotation.y, c = Math.cos(y), s = Math.sin(y);
    // world → local: pushed forward (+lz) pitches forward, pushed to +lx leans to +x
    if (nx || nz) { this.fx = nx * c - nz * s; this.fz = nx * s + nz * c; } else { this.fx = 0; this.fz = -1; }
  }
  /** Hit variety: kind 'light' | 'heavy' | 'head' | 'blast' | 'graze'. */
  doHit(kind = 'light', nx = 0, nz = 0) {
    const k = { graze: 0.55, light: 1, heavy: 1.3, head: 1.1, blast: 1.5 }[kind] ?? 1;
    this.doFlinch(k, nx, nz, kind === 'graze' ? 'light' : kind);
    if (this.act && this.act.kind !== 'suppress') this._endAct();
  }

  // ---------- actions ----------
  _startAct(kind, dur, extra) {
    this._endAct();
    this.stopEmote();
    this.act = { kind, t: 0, dur, ...extra };
    return this.act;
  }
  _endAct() {
    const a = this.act;
    if (!a) return;
    this.act = null;
    this.item.visible = false;
    this.weapon.mag.visible = true;
    const h = this.weapon.mag.userData.home; if (h) this.weapon.mag.position.set(h[0], h[1], h[2]);
    if (a.kind === 'swap' && !a.swapped) { this.slot = a.to; this._applyWeapon(); }
    if (a.kind === 'stim' || a.kind === 'throw') this.flashCol.set(0xffffff);
  }
  /** Reload: mag out, fresh mag from the pouch, charge. Shotguns load shells; launchers a rocket. */
  doReload() {
    if (this.dead || this.down > 0.5) return 0;
    const cat = this.weapon.info.cat, style = this.weapon.reloadStyle;
    const dur = style === 'shells' ? 1.25 : style === 'rocket' ? 1.2 : cat === 'pistol' || cat === 'mpistol' ? 0.75 : cat === 'lmg' ? 1.3 : cat === 'sniper' ? 1.15 : 1.0;
    this._startAct('reload', dur, { cat, style });
    this.reload = 0;
    return dur;
  }
  /** Swap primary ↔ secondary (or to `slot`). Returns its length; the model changes halfway. */
  doSwap(slot) {
    const to = slot || (this.slot === 'primary' ? 'secondary' : 'primary');
    if (to === this.slot && !this.act) return 0;
    if (this.dead) { this.slot = to; this._applyWeapon(); return 0; }
    this._startAct('swap', 0.7, { to, swapped: false });
    return 0.7;
  }
  /**
   * Throw / use equipment with the left hand. kind: frag | semtex | smoke | flash |
   * decoy | knife | claymore | stim. Returns the release moment in seconds (spawn the
   * projectile at handWorld() then).
   */
  doThrow(kind = 'frag') {
    if (this.dead) return 0;
    if (kind === 'stim') return this.doStim();
    if (kind === 'flashbang') kind = 'flash';
    if (kind === 'grenade') kind = 'frag';
    if (kind === 'knife' || kind === 'throwing_knife' || kind === 'throwingKnife') { this._startAct('throw', 0.55, { item: 'knife', style: 'knife', rel: 0.26 }); return 0.26; }
    if (kind === 'claymore') { this._startAct('throw', 1.0, { item: 'claymore', style: 'place', rel: 0.55 }); return 0.55; }
    this._startAct('throw', 0.85, { item: ['frag', 'semtex', 'smoke', 'flash', 'decoy'].includes(kind) ? kind : 'frag', style: 'over', rel: 0.42 });
    return 0.42;
  }
  /** Stim injection: +AP rush. Returns the jab moment. */
  doStim() { this._startAct('stim', 1.0, { item: 'stim', rel: 0.45 }); return 0.45; }
  /** Engineer: unfold and plant a barricade in front. Returns the plant moment (spawn the cover then). */
  doDeployCover() { this._startAct('cover', 1.15, { rel: 0.55 }); return 0.55; }
  /** Gunner suppress: braced sustained fire for `dur` seconds (render spawns tracers from muzzleWorld). */
  doSuppress(dur = 1.4) { this._startAct('suppress', dur, {}); this.aimGoal = 1; return dur; }

  // ---------- emotes ----------
  /** Victory emote (loops until stopEmote). opts.fx: an Fx instance for particles (flares, water ring). */
  playEmote(id, opts = {}) {
    this._endAct();
    this.stopEmote();
    id = id || this.emoteId || 'default';
    this.aimGoal = 0; this.hunkGoal = 0; this.walkGoal = 0; this.setOverwatch(false);
    const e = (this.emote = { id, t: 0, fx: opts.fx || null, props: [], n: 0 });
    const P = props();
    if (id === 'lounge') {
      const ch = new THREE.Mesh(P.chair, P.vc); ch.castShadow = true; ch.position.set(0, 0, -0.08); this.root.add(ch); e.props.push(ch);
    } else if (id === 'flag') {
      const pole = new THREE.Mesh(P.pole, P.vc); pole.castShadow = true; pole.position.set(0.42, 0, 0.18); pole.visible = false;
      const geo = new THREE.PlaneGeometry(0.5, 0.32, 6, 1); geo.translate(0.25, 0, 0);
      const cloth = new THREE.Mesh(geo, this.accentMat); cloth.position.set(0, 1.32, 0); cloth.castShadow = true;
      cloth.material.side = THREE.DoubleSide;
      pole.add(cloth);
      this.root.add(pole); e.props.push(pole); e.cloth = cloth; e.pole = pole;
    } else if (id === 'meditate') {
      const ring = new THREE.Mesh(P.ringG, P.ringM); ring.position.y = 0.35; this.root.add(ring); e.props.push(ring); e.ring = ring;
    }
    return e;
  }
  stopEmote() {
    const e = this.emote;
    if (!e) return;
    this.emote = null;
    for (const p of e.props) { if (p.parent) p.parent.remove(p); }
    if (e.cloth) { e.cloth.geometry.dispose(); }
    this.item.visible = false;
    this.pose.position.set(0, 0, 0); this.pose.rotation.set(0, 0, 0, 'XYZ');
  }

  die(dir = 1, kind) {
    this.dead = true; this.deathT = 0; this.deathDir = dir;
    this.deathKind = kind || DEATH_KINDS[Math.floor(hash(this.id * 7 + 3 + (dir > 0 ? 1 : 0)) * DEATH_KINDS.length)];
    if (this.hitKind === 'blast' && !kind) this.deathKind = 'blast';
    if (this.hitKind === 'head' && !kind) this.deathKind = 'head';
    this.coneGoal = 0; this.cone.visible = false; this.hunkGoal = 0; this.aimGoal = 0;
    this.bleedRing.visible = false; this.setReveal(false);
    this._endAct(); this.stopEmote();
  }
  /** Reset to a clean standing pose (used by syncFromState). */
  revive() {
    this.dead = false; this.deathT = 0; this.corpse = false;
    this.pose.rotation.set(0, 0, 0); this.pose.position.set(0, 0, 0);
    this.pose.visible = true; this.derezzed = false;
    this.root.visible = true; this.root.scale.set(1, 1, 1); this.root.rotation.x = this.root.rotation.z = 0;
    this.ring.visible = true; this.blob.visible = true;
    if (this.ring2) this.ring2.visible = true;
    this.down = this.downGoal = 0; this.bleedRing.visible = false;
    this.recoil = this.flinch = this.flash = 0; this.reload = 1; this.pop = 0; this.stagger = 0; this.hitKind = 'light';
    this.aim = this.aimGoal = 0; this.walk = this.walkGoal = 0;
    this._endAct(); this.stopEmote();
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
    this._t = t;
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
    this.stagger = Math.max(0, this.stagger - dt * 1.8);
    this.flash = Math.max(0, this.flash - dt * 5);
    this.pop = Math.max(0, this.pop - dt * 2.2);
    if (this.reload < 1) this.reload = Math.min(1, this.reload + dt / 0.9);
    this.aim += (this.aimGoal - this.aim) * damp(12, dt);
    if (this.act) {
      this.act.t += dt;
      if (this.act.kind === 'swap' && !this.act.swapped && this.act.t >= this.act.dur * 0.45) { this.act.swapped = true; this.slot = this.act.to; this._applyWeapon(); }
      if (this.act.kind === 'suppress') { this.recoil = Math.max(this.recoil, 0.35 + 0.35 * Math.abs(Math.sin(this.act.t * 38))); this.aimGoal = 1; }
      if (this.act.t >= this.act.dur) { if (this.act.kind === 'suppress') this.aimGoal = 0; this._endAct(); }
    }
    if (this.emote) this.emote.t += dt;
    this.bodyMat.emissive.copy(this.flashCol);
    this.bodyMat.emissiveIntensity = this.flash * 1.4;
    tickSkinMaterial(this.bodyMat, t);
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
    const idle = this.walk < 0.1 && this.aim < 0.1 && this.down < 0.1 && !this.dead && !this.act && !this.emote;
    this.lookT -= dt; this.shiftT -= dt; this.fidgetT -= dt;
    if (this.lookT <= 0) { this.lookT = 1.5 + Math.random() * 4; this.lookGoal = idle ? (Math.random() - 0.5) * 1.3 : 0; }
    if (this.shiftT <= 0) { this.shiftT = 2.5 + Math.random() * 5; this.shiftGoal = idle ? (Math.random() < 0.5 ? -1 : 1) : 0; }
    if (this.fidgetT <= 0) { this.fidgetT = 7 + Math.random() * 12; if (idle && this.hunk < 0.1) this.fidget = 0; }
    if (this.fidget < 1) this.fidget = Math.min(1, this.fidget + dt / 1.4);
    if (!idle) { this.lookGoal = 0; this.shiftGoal = 0; }
    this.look += (this.lookGoal - this.look) * damp(3, dt);
    this.shift += (this.shiftGoal - this.shift) * damp(2, dt);
    this._pose(dt, t);
    if (this.root.visible) this.weapon.update(dt, t);
  }

  // ---------- posing ----------
  /** Default gun placement (arms frame) for the current hold. */
  _gunRest() {
    const g = this.gun, w = this.G.w;
    g.scale.setScalar(GUN_SCALE);
    g.rotation.set(0, 0, 0);
    if (this.hold === 'pistol') g.position.set(0.02, -0.06, 0.34);
    else if (this.hold === 'launcher') g.position.set(w / 2 - 0.02, -0.04, 0.14);
    else if (this.hold === 'shield') g.position.set(0.11, -0.11, 0.24);
    else g.position.set(0.09, -0.1, 0.22);
  }
  /** Point in gun space → arms space (into out). */
  _gunPt(x, y, z, out) {
    out.set(x, y, z).multiplyScalar(this.gun.scale.x).applyQuaternion(_q.setFromEuler(_eu.copy(this.gun.rotation))).add(this.gun.position);
    return out;
  }
  /** poles: null | [lx,ly,lz] (left elbow pole) | { l:[..], r:[..] }. */
  _setArms(poles) {
    const lp = Array.isArray(poles) ? poles : poles?.l, rp = poles && !Array.isArray(poles) ? poles.r : null;
    solveElbow(this.shR, this.hR, UPPER, FORE, rp ? rp[0] : 1, rp ? rp[1] : -1, rp ? rp[2] : -0.35, this.elR);
    solveElbow(this.shL, this.hL, UPPER, FORE, lp ? lp[0] : -1, lp ? lp[1] : -1, lp ? lp[2] : -0.35, this.elL);
    aim(this.upR, this.shR, this.elR); aim(this.foR, this.elR, _v.copy(this.hR));
    aim(this.upL, this.shL, this.elL); aim(this.foL, this.elL, _v.copy(this.hL));
    // the forearm is FORE long: put it so its hand lands on the target
    this._fit(this.foR, this.elR, this.hR); this._fit(this.foL, this.elL, this.hL);
  }
  _fit(fore, E, H) { _v2.subVectors(H, E); const L = _v2.length(); fore.scale.set(1, 1, clamp(L / FORE, 0.4, 1.25)); }

  _pose(dt, t) {
    const p = this.pose;
    this.item.visible = false;
    if (this.dead) { this._poseDead(dt); return; }
    const ph = t * 2.1 + this.phase;
    if (this.walk > 0.01 || this.walkGoal) this.walkPhase += dt * 15;
    const wk = this.walk * (1 - this.down);
    const sw = Math.sin(this.walkPhase) * 0.75 * wk;
    const bob = Math.abs(Math.cos(this.walkPhase)) * 0.045 * wk;
    const hk = this.hunk * (1 - this.down);
    const dn = this.down;
    const aim = this.aim * (1 - dn);
    const sh = this.shift * (1 - dn) * (1 - hk);
    const stg = Math.sin(this.stagger * Math.PI) * (this.hitKind === 'blast' ? 1.4 : 1);
    // legs: walk swing, crouch, sit-down (legs out forward), stagger step
    this.legL.rotation.set(sw - hk * 1.05 - dn * 1.3 + stg * 0.35, 0, -sh * 0.06 + dn * 0.12);
    this.legR.rotation.set(-sw - hk * 0.35 - dn * 1.45 - stg * 0.25, 0, -sh * 0.06 - dn * 0.25);
    this.legL.scale.y = 1 - hk * 0.18; this.legR.scale.y = 1 - hk * 0.3;
    const squash = Math.sin(this.pop * Math.PI) * 0.08;
    p.position.set(sh * 0.025 + this.fx * stg * 0.08, bob - hk * 0.13 - dn * 0.27 + squash - stg * 0.05, this.fz * stg * 0.08);
    p.rotation.set(0, 0, sh * 0.04);
    const breath = Math.sin(ph * (1 + dn * 0.8)) * (0.012 + dn * 0.02);
    this.torso.scale.set(1 + breath * 0.5, 1 + breath - squash * 0.5, 1 + breath * 0.5);
    this.torso.position.y = HIP;
    const fl = this.flinch, head = this.hitKind === 'head' ? 1 : 0;
    // torso: walk lean, crouch, aim lean, recoil, flinch, sit slump
    this.torso.rotation.x = 0.06 * wk + hk * 0.45 + aim * 0.1 - this.recoil * 0.12 + fl * this.fz * (0.38 - head * 0.2) - dn * 0.42;
    this.torso.rotation.y = aim * 0.22 + dn * 0.2;
    this.torso.rotation.z = Math.sin(this.walkPhase * 0.5) * 0.04 * wk + Math.sin(t * 40) * fl * 0.05 - fl * this.fx * 0.38 - sh * 0.05 + dn * 0.22;
    // head: look around when idle, sight down when aiming, droop when downed, snap on a head hit
    this.head.rotation.set(-aim * 0.08 + dn * 0.35 + fl * (0.2 - head * 0.9), this.look * (1 - aim) - aim * 0.2 + dn * 0.3, dn * -0.25 + head * fl * this.fx * 0.4);
    // arms: low-ready → shouldered aim, recoil kick, gear fidget
    const fg = this.fidget < 1 ? Math.sin(this.fidget * Math.PI) : 0;
    const guard = this.cls === 'breacher' ? hk * 0.5 : hk * 0.2;
    const lowReady = (this.hold === 'launcher' ? 0.12 : 0.42) * (1 - aim) * (1 - wk * 0.4);
    this.arms.rotation.x = lowReady + Math.sin(ph * 0.5) * 0.02 - this.recoil * 0.45 + fl * 0.3 - guard
      + wk * 0.08 + fg * 0.25 + dn * 0.75 - aim * 0.04 - stg * 0.3;
    this.arms.rotation.y = -fg * 0.2;
    this.arms.rotation.z = fg * 0.45 + dn * 0.25;
    this.arms.position.set(0, SHOULDER + aim * 0.05, -this.recoil * 0.06 + aim * 0.02);
    // gun + hands
    this._gunRest();
    this.gun.position.z -= this.recoil * 0.03;
    const hz = this.weapon.handZ;
    this._gunPt(0, -0.04, -0.005, this.hR);
    if (this.hold === 'pistol') this._gunPt(-0.01, -0.05, 0.0, this.hL).x -= 0.05;
    else if (this.hold === 'shield') this.hL.set(-0.06, -0.14, 0.28);
    else this._gunPt(0, -0.025, hz, this.hL);
    if (this.hold === 'launcher') this._gunPt(0, -0.04, 0.18, this.hL);
    let lPole = null;
    if (this.shield) { this.shield.rotation.set(0, 0, 0); this.shield.position.set(0, 0, 0); }
    if (this.act) lPole = this._poseAct(this.act, dt, t);
    else if (this.emote) {
      lPole = this._poseEmote(this.emote, dt, t);
      if (this.shield) { this.shield.rotation.set(0, Math.PI, 0); this.shield.position.set(-0.2, -0.05, -0.08); } // slung on the back
    }
    this._setArms(lPole);
  }

  /** Action overrides on top of the base pose. Returns an optional left-elbow pole. */
  _poseAct(a, dt, t) {
    const k = a.t / a.dur, T = a.t;
    const g = this.gun, hL = this.hL;
    const w = this.G.w;
    switch (a.kind) {
      case 'reload': {
        const tilt = bump(k, 0.0, 1.0);
        g.rotation.z += tilt * 0.55; g.rotation.x -= tilt * 0.18; g.position.x -= tilt * 0.04; g.position.y += tilt * 0.03;
        this.arms.rotation.x += tilt * 0.2;
        this.head.rotation.x += tilt * 0.25; this.head.rotation.y -= tilt * 0.15;
        const mag = this.weapon.mag, home = mag.userData.home;
        if (a.style === 'shells' || a.style === 'rocket') {
          // fetch shell / rocket twice (shotgun) or once (launcher), insert at the port, then pump
          const cycles = a.style === 'shells' ? 2 : 1;
          const span = 0.72 / cycles, c = Math.min(cycles - 1, Math.floor(k / span)), kk = (k - c * span) / span;
          const pouch = _v2.set(-w * 0.35, -0.42, 0.12);
          const port = this._gunPt(home[0], home[1] - 0.03, home[2], _e);
          if (k < 0.72) {
            hL.lerpVectors(port, pouch, bump(kk, 0, 1));
            if (kk > 0.35 && kk < 0.85) {
              this.item.visible = true;
              if (a.style === 'rocket') { this.item.geometry = mag.geometry; this.item.material = mag.material; mag.visible = false; } else { this.item.geometry = equipGeo('shell'); this.item.material = propMaterial(); }
            }
            if (a.style === 'rocket') mag.visible = kk >= 0.85;
          } else {
            const pk = bump(k, 0.75, 0.95);
            this._gunPt(0, -0.025, this.weapon.handZ - pk * 0.06, hL);
            g.position.z -= pk * 0.015;
          }
        } else {
          const magPt = this._gunPt(home[0], home[1] - 0.02, home[2], _e);
          const pouch = _v2.set(-w * 0.3, -0.42, 0.14);
          if (k < 0.18) hL.lerp(magPt, ease(k, 0, 0.18));
          else if (k < 0.45) hL.lerpVectors(magPt, pouch, ease(k, 0.18, 0.42));
          else if (k < 0.72) hL.lerpVectors(pouch, magPt, ease(k, 0.47, 0.72));
          else if (k < 0.86) { const ch = this._gunPt(-0.04, 0.05, -0.02, _v2); hL.lerpVectors(magPt, ch, ease(k, 0.72, 0.8)); g.position.z -= bump(k, 0.8, 0.86) * 0.03; }
          else hL.lerp(this._gunPt(-0.04, 0.05, -0.02, _v2), 1 - ease(k, 0.86, 1));
          // the mag: drops out, a fresh one rides in the hand, then seats
          if (k > 0.16 && k < 0.7) {
            const drop = seg01(k, 0.16, 0.3);
            mag.position.set(home[0], home[1] - drop * 0.5, home[2] + drop * 0.05);
            mag.visible = drop < 1;
          } else mag.position.set(home[0], home[1], home[2]);
          if (k > 0.42 && k < 0.7) { this.item.visible = true; this.item.geometry = mag.geometry; this.item.material = mag.material; }
          else this.item.material = propMaterial();
          if (k > 0.7 && k < 0.74) g.position.y += 0.015;
          if (a.style === 'bolt' && k > 0.74) { const bk = bump(k, 0.76, 0.95); this.hR.x += bk * 0.05; this.hR.y += bk * 0.03; this.hR.z -= bk * 0.06; }
        }
        this.item.position.copy(hL); this.item.position.y -= 0.02; this.item.rotation.set(0, 0, 0); this.item.scale.setScalar(GUN_SCALE);
        return [-1, -0.6, 0.2];
      }
      case 'swap': {
        const low = bump(k, 0, 1);
        g.rotation.x += low * 1.25; g.position.y -= low * 0.14; g.position.x += low * 0.04;
        this.arms.rotation.x += low * 0.2;
        if (k > 0.3 && k < 0.6) hL.set(-w * 0.2, -0.25, 0.1);
        this.torso.rotation.y -= low * 0.15;
        return null;
      }
      case 'throw': {
        const it = a.item;
        this.item.geometry = equipGeo(it); this.item.material = propMaterial(); this.item.scale.setScalar(GUN_SCALE);
        const held = T < a.rel && T > 0.05;
        // the gun drops to the right hip
        const low = a.style === 'knife' ? bump(k, 0, 1) * 0.6 : bump(k, 0, 1);
        g.rotation.x += low * 0.9; g.position.x += low * 0.05; g.position.y -= low * 0.08;
        this.arms.rotation.x *= 1 - low * 0.7;
        if (a.style === 'over') {
          const wind = ease(T, 0.05, a.rel - 0.06), fling = ease(T, a.rel - 0.06, a.rel + 0.06), back = ease(T, a.rel + 0.12, a.dur);
          _e.set(-w * 0.3, -0.32, 0.12);
          _v2.set(-w * 0.55, 0.26, -0.24);
          hL.lerpVectors(_e, _v2, wind);
          _e.set(-0.05, 0.12, 0.42);
          hL.lerp(_e, fling);
          _v2.set(-0.02, -0.25, 0.34); hL.lerp(_v2, seg01(T, a.rel + 0.04, a.rel + 0.2));
          const sup = this._gunPt(0, -0.025, this.weapon.handZ, _e); hL.lerp(sup, back);
          this.torso.rotation.y += wind * 0.5 - fling * 0.85 + back * 0.35;
          this.torso.rotation.x += -wind * 0.15 + fling * 0.3 - back * 0.15;
          this.legL.rotation.x += fling * 0.4 - back * 0.4; this.legR.rotation.x -= wind * 0.25 - back * 0.25;
          this.head.rotation.x -= wind * 0.15;
          if (held) { this.item.visible = true; this.item.position.copy(hL); this.item.rotation.set(T * 3, 0, 0); }
          return [-1, -0.2 + wind * 0.8, -0.6];
        }
        if (a.style === 'knife') {
          const cock = ease(T, 0.02, a.rel - 0.08), whip = ease(T, a.rel - 0.08, a.rel + 0.03), back = ease(T, a.rel + 0.1, a.dur);
          _e.set(-w * 0.35, -0.2, 0.1); _v2.set(-w * 0.75, 0.12, -0.12);
          hL.lerpVectors(_e, _v2, cock);
          _e.set(0.12, 0.08, 0.46); hL.lerp(_e, whip);
          const sup = this._gunPt(0, -0.025, this.weapon.handZ, _v2); hL.lerp(sup, back);
          this.torso.rotation.y += cock * 0.45 - whip * 0.9 + back * 0.45;
          if (held) { this.item.visible = true; this.item.position.copy(hL); this.item.rotation.set(1.2 - whip * 1.5, cock * 0.5, 0); }
          return [-1, -0.5, -0.3];
        }
        // place (claymore): kneel, set it down in front
        const kneel = bump(k, 0, 1.05);
        this.legL.rotation.x -= kneel * 1.2; this.legR.rotation.x -= kneel * 0.3; this.legL.scale.y = 1 - kneel * 0.2;
        this.pose.position.y -= kneel * 0.18;
        this.torso.rotation.x += kneel * 0.55;
        _e.set(-w * 0.3, -0.32, 0.12); _v2.set(-0.02, -0.55, 0.36);
        hL.lerpVectors(_e, _v2, ease(T, 0.1, a.rel));
        hL.lerp(this._gunPt(0, -0.025, this.weapon.handZ, _e), ease(T, a.rel + 0.1, a.dur));
        if (held) { this.item.visible = true; this.item.position.copy(hL); this.item.rotation.set(-0.2, 0, 0); }
        return [-1, -0.2, 0.2];
      }
      case 'stim': {
        this.item.geometry = equipGeo('stim'); this.item.material = propMaterial(); this.item.scale.setScalar(GUN_SCALE);
        const low = bump(k, 0, 1);
        g.rotation.x += low * 0.8; g.position.y -= low * 0.06;
        this.arms.rotation.x *= 1 - low * 0.6;
        _e.set(-w * 0.3, -0.32, 0.12); _v2.set(0.02, -0.08, 0.2);
        hL.lerpVectors(_e, _v2, ease(T, 0.05, a.rel - 0.05));
        _e.set(0.06, -0.1, 0.1); hL.lerp(_e, bump(T, a.rel - 0.05, a.rel + 0.12));
        hL.lerp(this._gunPt(0, -0.025, this.weapon.handZ, _e), ease(T, a.rel + 0.25, a.dur));
        if (T < a.rel + 0.2) { this.item.visible = true; this.item.position.copy(hL); this.item.rotation.set(-1.2, 0.6, 0); }
        if (T > a.rel && T < a.rel + 0.5) { this.flashCol.set(0x6aff7a); this.flash = Math.max(this.flash, 0.6 * (1 - (T - a.rel) / 0.5)); }
        const rush = bump(T, a.rel, a.dur);
        this.head.rotation.x -= rush * 0.35; this.torso.rotation.x -= rush * 0.12;
        this.torso.scale.multiplyScalar(1 + rush * 0.04);
        return [-1, -0.6, 0.3];
      }
      case 'cover': {
        const kneel = bump(k, 0, 1.05);
        this.legL.rotation.x -= kneel * 1.25; this.legR.rotation.x -= kneel * 0.35; this.legL.scale.y = 1 - kneel * 0.2;
        this.pose.position.y -= kneel * 0.2;
        this.torso.rotation.x += kneel * 0.5;
        g.rotation.x += kneel * 1.1; g.position.x += kneel * 0.06; g.position.y -= kneel * 0.06;
        this.arms.rotation.x *= 1 - kneel;
        const reach = ease(T, 0.1, a.rel - 0.05), slam = bump(T, a.rel - 0.05, a.rel + 0.15);
        _e.set(-w * 0.4, 0.15, -0.1); _v2.set(-0.06, -0.5, 0.42);
        hL.lerpVectors(_e, _v2, reach);
        hL.y -= slam * 0.05;
        hL.lerp(this._gunPt(0, -0.025, this.weapon.handZ, _e), ease(T, a.rel + 0.3, a.dur));
        this.pose.position.y -= slam * 0.03;
        return [-1, 0.2, -0.3];
      }
      case 'suppress': {
        this.legL.rotation.z += 0.14; this.legR.rotation.z -= 0.14;
        this.legL.rotation.x -= 0.25; this.legR.rotation.x += 0.15;
        this.pose.position.y -= 0.04;
        this.torso.rotation.x += 0.16;
        g.position.z += Math.sin(T * 41) * 0.01; g.position.y += Math.sin(T * 53) * 0.006;
        this.head.rotation.x += 0.05;
        return null;
      }
    }
    return null;
  }

  /** Emote poses (loop). Many sling the weapon over the right shoulder. */
  _poseEmote(e, dt, t) {
    const T = e.t, g = this.gun, hL = this.hL, hR = this.hR, w = this.G.w;
    const sling = () => {
      g.rotation.set(-1.25, 0.15, 0.25); g.position.set(w / 2 + 0.06, 0.02, -0.14);
      this.arms.rotation.set(0, 0, 0); this.arms.position.set(0, SHOULDER, 0);
    };
    const restL = () => hL.set(-w / 2 - 0.1, -0.3, 0.02);
    const restR = () => hR.set(w / 2 + 0.1, -0.3, 0.02);
    const intro = ease(T, 0, 0.35);
    this.legL.scale.y = this.legR.scale.y = 1;
    switch (e.id) {
      case 'fistpump': {
        sling(); restL();
        const pump = Math.abs(Math.sin(T * 7));
        hR.set(w / 2 + 0.05, lerp(0.02, 0.38, pump), 0.06);
        hL.set(-w / 2 - 0.12, -0.08, 0.1);
        this.torso.rotation.x = -0.1 + pump * 0.08; this.torso.rotation.z = -0.08;
        this.pose.position.y = Math.abs(Math.sin(T * 7)) * 0.04;
        this.legL.rotation.x = -pump * 0.2; this.legR.rotation.x = -pump * 0.1;
        this.head.rotation.x = -0.25 * pump;
        return [-1, -1, 0.4];
      }
      case 'wave': {
        g.rotation.set(1.3, 0, 0); g.position.set(-w / 2 - 0.08, -0.25, 0.04); this.arms.rotation.set(0, 0, 0);
        this._gunPt(0, -0.04, -0.005, hL);
        hR.set(w / 2 + 0.16 + Math.sin(T * 9) * 0.07, 0.32, 0.05);
        this.torso.rotation.z = -0.06; this.head.rotation.z = Math.sin(T * 4.5) * 0.08; this.head.rotation.x = -0.1;
        this.pose.rotation.z = Math.sin(T * 4.5) * 0.02;
        // gun was moved to the left hand: right hand target is free
        return [-1, -1, 0];
      }
      case 'pushups': {
        sling();
        const down = intro, push = 0.5 + 0.5 * Math.sin(T * 5);
        this.pose.rotation.set(1.38 * down, 1.25 * down, 0, 'YXZ');
        this.pose.position.set(-0.45 * down * Math.sin(1.25), (0.12 + push * 0.12) * down, -0.45 * down * Math.cos(1.25));
        this.legL.rotation.set(0, 0, 0.04); this.legR.rotation.set(0, 0, -0.04);
        this.torso.rotation.set(0, 0, 0); this.head.rotation.set(-0.6 * down, 0, 0);
        // arms frame forward (+z) points at the ground in the plank
        const reach = 0.12 + push * 0.18;
        hL.set(-w / 2 - 0.04, -0.03, reach); hR.set(w / 2 + 0.04, -0.03, reach);
        g.rotation.set(-1.25, 0.15, 0.25); g.position.set(w / 2 + 0.02, 0.02, -0.18);
        return [-1, 0.3, -0.2];
      }
      case 'flex': {
        sling();
        const pulse = 0.5 + 0.5 * Math.sin(T * 3);
        hL.set(-w / 2 - 0.16, 0.18 + pulse * 0.04, 0.02); hR.set(w / 2 + 0.16, 0.18 + pulse * 0.04, 0.02);
        this.torso.scale.set(1.04 + pulse * 0.05, 1.02, 1.04 + pulse * 0.04);
        this.torso.rotation.x = -0.12; this.head.rotation.set(-0.15, Math.sin(T * 1.5) * 0.3, 0);
        this.legL.rotation.z = 0.1; this.legR.rotation.z = -0.1;
        this.arms.rotation.set(0, 0, 0);
        // elbows straight out to the sides
        return { l: [-1, -0.3, 0], r: [1, -0.3, 0] };
      }
      case 'twirl': {
        this.arms.rotation.set(0.2, 0, 0);
        const cyc = T % 2.4;
        const spin = cyc < 1.2 ? easeOutCubic(cyc / 1.2) * Math.PI * 4 : 0;
        g.position.set(w / 2 + 0.08, -0.18, 0.12); g.rotation.set(spin, 0, 0);
        this._gunPt(0, -0.04, -0.005, hR);
        hR.set(w / 2 + 0.08, -0.2, 0.1);
        hL.set(-w / 2 - 0.02, -0.28, -0.04);
        this.legL.rotation.z = 0.08;
        this.head.rotation.set(0.1, -0.3, 0);
        this.torso.rotation.y = cyc > 1.2 ? -0.25 * bump(cyc, 1.2, 2.4) : 0;
        return null;
      }
      case 'chest': {
        sling();
        const cyc = T % 2.6;
        if (cyc < 1.4) {
          const beat = Math.floor(cyc / 0.35) % 2, kk = (cyc % 0.35) / 0.35;
          const hit = Math.sin(kk * Math.PI);
          hL.set(-0.07, 0.0, 0.08 + (beat === 0 ? 0.12 * (1 - hit) : 0.18));
          hR.set(0.07, 0.0, 0.08 + (beat === 1 ? 0.12 * (1 - hit) : 0.18));
          this.torso.rotation.x = -0.05 + hit * 0.06;
          this.head.rotation.x = -0.1;
        } else {
          const roar = bump(cyc, 1.4, 2.6);
          hL.set(-w / 2 - 0.22 * roar - 0.05, 0.05 + roar * 0.1, 0.1); hR.set(w / 2 + 0.22 * roar + 0.05, 0.05 + roar * 0.1, 0.1);
          this.torso.rotation.x = -0.25 * roar; this.head.rotation.x = -0.5 * roar;
          this.torso.scale.multiplyScalar(1 + roar * 0.05);
        }
        return [-1, -0.6, -0.2];
      }
      case 'dance': {
        sling();
        const b = T * 5.2, s = Math.sin(b), c = Math.cos(b);
        this.pose.position.set(s * 0.09, Math.abs(c) * 0.04, 0);
        this.pose.rotation.set(0, s * 0.35, -s * 0.08);
        this.legL.rotation.set(Math.max(0, s) * 0.5, 0, 0.1 + s * 0.1); this.legR.rotation.set(Math.max(0, -s) * 0.5, 0, -0.1 + s * 0.1);
        this.torso.rotation.set(0.05, -s * 0.2, s * 0.12);
        hL.set(-w / 2 - 0.12, -0.05 + c * 0.12, 0.12 + s * 0.08); hR.set(w / 2 + 0.12, -0.05 - c * 0.12, 0.12 - s * 0.08);
        this.head.rotation.set(-0.05, -s * 0.25, s * 0.15);
        return [-1, -0.8, -0.2];
      }
      case 'airguitar': {
        sling();
        const slide = T < 0.7 ? easeOutCubic(T / 0.7) : 1;
        this.pose.position.set(0, -0.2 * (T < 0.9 ? slide : 1 - seg01(T, 0.9, 1.3) * 0.6), (T < 0.7 ? -0.5 * (1 - slide) : 0));
        this.legL.rotation.x = -1.4 * (T < 0.9 ? slide : 0.4); this.legR.rotation.x = -1.2 * (T < 0.9 ? slide : 0.3);
        this.torso.rotation.set(-0.3 + Math.abs(Math.sin(T * 6)) * 0.15, 0.2, 0);
        hL.set(-w / 2 - 0.2, 0.05 + Math.sin(T * 2) * 0.03, 0.25);
        hR.set(0.06, -0.12 + Math.sin(T * 24) * 0.05, 0.14);
        this.head.rotation.set(Math.abs(Math.sin(T * 6)) * 0.4 - 0.2, 0, 0);
        return [-1, -0.3, -0.2];
      }
      case 'lounge': {
        sling();
        const sit = intro;
        this.pose.position.set(0, -0.2 * sit, -0.05 * sit);
        this.legL.rotation.set(-1.45 * sit, 0, 0.12); this.legR.rotation.set(-1.25 * sit, 0, -0.12);
        this.torso.rotation.set(-0.5 * sit, 0, 0);
        hL.set(-0.14, 0.28, -0.1); hR.set(0.14, 0.28, -0.1);
        g.rotation.set(-0.3, 0, 0.0); g.position.set(w / 2 + 0.18, -0.45, 0.25);
        this.head.rotation.set(0.2 + Math.sin(T * 0.8) * 0.05, Math.sin(T * 0.4) * 0.3, 0);
        return [-1, 0.6, -0.5];
      }
      case 'flag': {
        const pole = e.pole;
        if (T < 1.0) {
          // kneel and drive it in
          const kk = ease(T, 0, 0.4), drive = ease(T, 0.4, 0.8);
          sling();
          this.legL.rotation.x = -1.2 * kk; this.legR.rotation.x = -0.3 * kk; this.pose.position.y = -0.2 * kk;
          this.torso.rotation.x = 0.35 * kk;
          pole.visible = true; pole.position.set(0.32, (1 - drive) * 0.4, 0.3); pole.rotation.set(0, 0, 0);
          hL.set(0.18, 0.1 - drive * 0.2, 0.32); hR.set(0.22, 0.15 - drive * 0.2, 0.32);
          if (T > 0.8 && !e.n) { e.n = 1; e.fx?.dust?.(this.root.position.x + 0.3, this.root.position.z + 0.3, 8); }
        } else {
          const up = ease(T, 1.0, 1.4);
          sling();
          pole.position.set(0.32, 0, 0.3);
          this.legL.rotation.x = -1.2 * (1 - up); this.pose.position.y = -0.2 * (1 - up);
          this.torso.rotation.set(-0.08 * up, -0.2, 0);
          hR.set(0.26, 0.05, 0.3); hL.set(-w / 2 - 0.12, -0.12, -0.03);
          this.head.rotation.set(-0.2, -0.6, 0);
        }
        // wave the cloth
        const geo = e.cloth.geometry, pp = geo.attributes.position;
        for (let i = 0; i < pp.count; i++) { const x = pp.getX(i); pp.setZ(i, Math.sin(x * 9 - t * 6) * 0.05 * x * 2); }
        pp.needsUpdate = true;
        e.cloth.rotation.y = Math.sin(t * 0.7) * 0.3 - 0.3;
        return [-1, -1, 0.2];
      }
      case 'fireworks': {
        g.rotation.set(1.3, 0, 0); g.position.set(-w / 2 - 0.08, -0.25, 0.04); this.arms.rotation.set(0, 0, 0);
        this._gunPt(0, -0.04, -0.005, hL);
        const cyc = T % 1.6;
        const raise = ease(cyc, 0, 0.3);
        hR.set(w / 2 + 0.06, lerp(-0.2, 0.42, raise), lerp(0.1, 0.12, raise));
        this.item.geometry = equipGeo('flare'); this.item.material = propMaterial(); this.item.visible = true;
        this.item.position.copy(hR); this.item.rotation.set(0, 0, 0); this.item.scale.setScalar(GUN_SCALE);
        this.head.rotation.x = -0.45 * raise; this.torso.rotation.x = -0.12 * raise;
        if (cyc > 0.35 && (e.n | 0) !== Math.floor(T / 1.6) + 1) { e.n = Math.floor(T / 1.6) + 1; this._flare(e); }
        return [-1, -1, 0];
      }
      case 'meditate': {
        sling();
        const fl = intro;
        this.pose.position.set(0, (0.25 + Math.sin(T * 1.6) * 0.04) * fl - 0.18 * fl, 0);
        this.legL.rotation.set(-1.5 * fl, 0, 0.9 * fl); this.legR.rotation.set(-1.5 * fl, 0, -0.9 * fl);
        this.torso.rotation.set(0, 0, 0); this.head.rotation.set(0.15, 0, 0);
        hL.set(-0.2, -0.32, 0.18); hR.set(0.2, -0.32, 0.18);
        if (e.ring) { e.ring.rotation.y = T * 1.6; e.ring.position.y = 0.35 + Math.sin(T * 1.6) * 0.05; e.ring.scale.setScalar(0.6 + fl * 0.4 + Math.sin(T * 3) * 0.03); }
        if (e.fx && Math.random() < 0.5) {
          const a = T * 3 + Math.random() * 6.28, p = this.root.position;
          e.fx.add.spawn(p.x + Math.cos(a) * 0.55, p.y + 0.35 + Math.random() * 0.1, p.z + Math.sin(a) * 0.55, -Math.sin(a) * 1.2, 0.4, Math.cos(a) * 1.2, 0.6, 0.06, 0.02, 0.6, 1.4, 1.8, 1, 0.5, 0, 0.4, 1);
        }
        return [-1, -0.5, 0.5];
      }
      default: { // salute
        g.rotation.set(1.3, 0, 0); g.position.set(-w / 2 - 0.08, -0.25, 0.04); this.arms.rotation.set(0, 0, 0);
        this._gunPt(0, -0.04, -0.005, hL);
        const cyc = T % 3.2;
        const up = cyc < 2.4 ? ease(cyc, 0, 0.3) : 1 - ease(cyc, 2.4, 2.8);
        _e.set(w / 2 + 0.1, -0.3, 0.04); _v2.set(0.075, 0.17, 0.08);
        hR.lerpVectors(_e, _v2, up);
        this.torso.rotation.x = -0.06 * up; this.head.rotation.x = -0.1 * up;
        this.legL.rotation.z = -0.02; this.legR.rotation.z = 0.02;
        return { l: [-1, -1, 0], r: [1, -0.2 * up - (1 - up), 0.2] };
      }
    }
  }

  _flare(e) {
    const fx = e.fx;
    if (!fx) return;
    this.root.updateMatrixWorld(true);
    const p = this.item.getWorldPosition(_v);
    const x = p.x, y = p.y + 0.1, z = p.z;
    const c = this.teamCol;
    for (let i = 0; i < 10; i++) fx.add.spawn(x, y + i * 0.02, z, (Math.random() - 0.5) * 0.3, 7 + Math.random(), (Math.random() - 0.5) * 0.3, 0.55, 0.12, 0.04, 4, 2.6, 1.2, 1, 0.8, 4, 1.2, 1);
    fx.timed(0.6, (k) => {
      if (k < 1) return;
      const by = y + 3.0;
      for (let i = 0; i < 46; i++) {
        const a = Math.random() * 6.28, b = Math.acos(Math.random() * 2 - 1), s = 2.2 + Math.random() * 1.2;
        fx.add.spawn(x, by, z, Math.sin(b) * Math.cos(a) * s, Math.cos(b) * s, Math.sin(b) * Math.sin(a) * s, 0.9 + Math.random() * 0.4, 0.12, 0.03, c.r * 3, c.g * 3, c.b * 3, 1, 1.4, 1.2, 0.6, 1);
      }
      fx.flashLight?.(x, by, z, c.getHex(), 14, 0.4, 7);
    });
  }

  _poseDead(dt) {
    const p = this.pose;
    this.deathT += dt;
    const T = this.deathT, dir = this.deathDir, from = this.down;
    const kind = this.deathKind;
    let fall, rx, rz, ry = 0, py, pz, px = 0;
    const settle = (d) => (T > d ? Math.sin(clamp((T - d) / 0.25, 0, 1) * Math.PI) * 0.1 : 0);
    if (kind === 'crumple' || kind === 'knees') {
      // knees buckle, then topple forward
      const kn = clamp(T / 0.25, 0, 1), d0 = kind === 'knees' ? 0.55 : 0.25;
      const f = clamp((T - d0) / 0.45, 0, 1); fall = f * f;
      rx = (Math.PI / 2 - 0.1) * fall - settle(d0 + 0.45);
      rz = 0.2 * fall * dir;
      py = -0.22 * kn * (1 - fall) + (0.07 - from * 0.2) * fall;
      pz = 0.18 * fall;
      this.legL.rotation.set(-1.3 * kn * (1 - fall * 0.6), 0, -0.1); this.legR.rotation.set(-1.1 * kn * (1 - fall * 0.6), 0, 0.15);
      this.torso.rotation.set(0.3 * kn - 0.1 * fall, 0, 0);
      this.head.rotation.set(0.4 * kn, 0.5 * fall * dir, 0);
      this.arms.rotation.set(0.9 * kn, 0.2 * dir, 0.9 * fall * dir);
    } else if (kind === 'spin') {
      const f = clamp(T / 0.6, 0, 1); fall = f * f;
      ry = 1.8 * easeOutCubic(f) * dir;
      rx = -(Math.PI / 2 - 0.1) * fall * 0.35; rz = (Math.PI / 2 - 0.12) * fall * dir;
      py = (0.08 - from * 0.2) * fall; pz = 0;
      px = 0.15 * fall * dir;
      this.legL.rotation.set(0.3 * fall, 0, -0.3 * fall); this.legR.rotation.set(-0.3 * fall, 0, 0.2 * fall);
      this.torso.rotation.set(0.1, 0.3 * fall * dir, 0);
      this.head.rotation.set(-0.2, 0.5 * dir, 0);
      this.arms.rotation.set(-0.8 * fall, 0.3 * dir, 1.4 * fall * dir);
    } else if (kind === 'blast') {
      // thrown back through the air with a tumble
      const f = clamp(T / 0.85, 0, 1);
      fall = f;
      const arc = Math.sin(f * Math.PI) * 0.55;
      rx = -(Math.PI / 2 + 0.6 * Math.sin(f * Math.PI)) * easeOutCubic(f) + (f >= 1 ? 0.6 * 0 : 0) - settle(0.85) * -1;
      rx = Math.max(rx, -Math.PI / 2 - 0.5);
      if (f >= 1) rx = -(Math.PI / 2 - 0.08) + settle(0.85);
      rz = 0.25 * f * dir;
      py = arc + (0.06 - from * 0.2) * f; pz = -0.9 * easeOutCubic(f);
      this.legL.rotation.set(0.7 * Math.sin(f * 6), 0, -0.3); this.legR.rotation.set(-0.5 * Math.sin(f * 5), 0, 0.3);
      this.torso.rotation.set(-0.3 * (1 - f), 0, 0);
      this.head.rotation.set(-0.5, 0.3 * dir, 0);
      this.arms.rotation.set(-1.6 * (1 - f) - 0.4, 0.4 * dir, 1.0 * dir);
    } else if (kind === 'head') {
      const f = clamp(T / 0.4, 0, 1); fall = f * f * f;
      rx = -(Math.PI / 2 - 0.06) * fall + settle(0.4);
      rz = 0.08 * fall * dir;
      py = (0.06 - from * 0.2) * fall + (1 - fall) * (-0.28 * from); pz = -0.2 * fall;
      this.legL.rotation.set(0.2 * fall, 0, -0.1); this.legR.rotation.set(0.1 * fall, 0, 0.12);
      this.torso.rotation.set(-0.25 * (1 - fall) + 0.2 * fall, 0, 0);
      this.head.rotation.set(-0.9 * clamp(T / 0.12, 0, 1) + 0.5 * fall, 0.3 * fall * dir, 0);
      this.arms.rotation.set(-1.2 * (1 - fall) - 0.4 * fall, 0.4 * dir, 1.0 * fall * dir);
    } else {
      // back (3.0)
      const k = clamp(T / 0.55, 0, 1);
      fall = k < 1 ? k * k : 1;
      rx = -(Math.PI / 2 - 0.08) * fall + settle(0.55) * 1.2;
      rz = 0.15 * fall * dir;
      py = (0.06 - from * 0.2) * fall + (1 - fall) * (-0.28 * from);
      pz = -0.12 * fall;
      this.torso.rotation.set(0.25 * fall, 0, 0);
      this.head.rotation.set(-0.3 * fall, 0.4 * fall * dir, 0);
      this.arms.rotation.set(-0.5 * fall, 0.5 * fall * dir, 1.25 * fall * dir);
      this.legL.rotation.set(0.35 * fall, 0, -0.2 * fall); this.legR.rotation.set(-0.15 * fall, 0, 0.25 * fall);
    }
    p.rotation.set(rx, ry, rz, 'YXZ');
    p.position.set(px, py, pz);
    this.arms.position.set(0, SHOULDER, 0);
    this.legL.scale.y = 1; this.legR.scale.y = 1;
    this.torso.scale.set(1, 1, 1);
    // the gun drops along the body; the support hand lets go
    this._gunRest();
    this.gun.rotation.x += 1.3 * fall; this.gun.position.y -= 0.08 * fall;
    this._gunPt(0, -0.04, -0.005, this.hR);
    this._gunPt(0, -0.025, this.weapon.handZ, this.hL);
    if (fall > 0.3) { this.hL.lerp(_e.set(-this.G.w / 2 - 0.25, -0.1, 0.1), (fall - 0.3) / 0.7); }
    this._setArms(null);
    this.ring.visible = false; this.blob.visible = false;
    if (this.ring2) this.ring2.visible = false;
  }

  /** World position of the head (for labels / text anchors). */
  headWorld(out) { this.head.getWorldPosition(out); return out; }

  /** Squad colour (rings, visor, armband, bleed ring, emote flag). */
  setColor(hex) {
    this.teamCol.set(hex);
    this.accentMat.color.set(hex); this.accentMat.emissive.set(hex);
    this.ringMat.color.set(hex).multiplyScalar(1.6);
    this.bleedMat.uniforms.uCol.value.set(hex);
  }

  dispose() {
    this.stopEmote();
    this.bodyMat.dispose(); this.accentMat.dispose(); this.ringMat.dispose(); this.bleedMat.dispose();
    if (this.xray) this.xray.mat.dispose();
  }
}
void resolveWeapon;
