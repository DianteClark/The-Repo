// Tidefall palette: teal / rust / bone world. Amber, magenta and cyan are
// reserved for gameplay (own squad / enemies / pickups+signals).

import * as THREE from 'three';

export const TEAM = {
  amber: 0xffb000,
  magenta: 0xff3fa4,
  cyan: 0x7fe9ff,
};

export const P = {
  // ground
  sand: 0xcdb68a,
  sand2: 0xbea57a,
  concrete: 0x8e8f87,
  concrete2: 0x7b7d77,
  tileFloor: 0xb3a88e,
  board: 0x93704a,
  board2: 0x7a5a3a,
  cliff: 0x5d554a,
  seabed: 0x2b5a5a,
  // props
  bone: 0xe0d4b6,
  plaster: 0xcbbd9c,
  plaster2: 0xb7a888,
  wallConcrete: 0x9b9a90,
  wallDark: 0x6f716c,
  rust: 0xa3502e,
  rust2: 0x7c3a22,
  rustDark: 0x4e2617,
  teal: 0x2f7c78,
  tealDeep: 0x1e5257,
  steel: 0x5a6266,
  steelDark: 0x353b3e,
  rubber: 0x23272a,
  wood: 0x8d6a42,
  wood2: 0x6f5233,
  sandbag: 0xb5a47c,
  sandbag2: 0xa08f68,
  kelp: 0x3e6e46,
  kelp2: 0x2b553a,
  glass: 0x1a2c33,
  window: 0x182327,
  windowGlow: 0xc9a77a,
  containerCols: [0xa4452c, 0x2e7d7a, 0x3e5f7d, 0xc7b994, 0x7a8a52],
  // water
  waterShallow: 0x5fd3c3,
  waterMid: 0x1f8d98,
  waterDeep: 0x0b3a4a,
  foam: 0xeef8f1,
  // ui-ish world overlays (non-team)
  move1: 0x9ff5e8,
  move2: 0xe3a65a,
  hazard: 0xf2e6c8,
};

// Lighting / weather arc keyframes by tide stage (storm 0..1):
// golden morning → hazy overcast afternoon → storm front at dusk → night storm.
// cloud = drifting cloud-shadow strength, haze = extra distance fog.
export const MOOD = [
  {
    sun: new THREE.Color(0xffc48a), sunI: 3.1,
    sky: new THREE.Color(0x9cc2dc), ground: new THREE.Color(0x4a3a2e), hemiI: 1.25,
    fog: new THREE.Color(0x24515a), bg: new THREE.Color(0x173a44),
    exposure: 1.0, cloud: 0.18, haze: 0,
  },
  {
    sun: new THREE.Color(0xf0d2ac), sunI: 2.5,
    sky: new THREE.Color(0x95b4bd), ground: new THREE.Color(0x3d362e), hemiI: 1.15,
    fog: new THREE.Color(0x2a4e56), bg: new THREE.Color(0x183740),
    exposure: 1.0, cloud: 0.5, haze: 0.3,
  },
  {
    sun: new THREE.Color(0xe09a68), sunI: 1.9,
    sky: new THREE.Color(0x6c8a92), ground: new THREE.Color(0x2b2a29), hemiI: 1.1,
    fog: new THREE.Color(0x1b3640), bg: new THREE.Color(0x10262f),
    exposure: 1.02, cloud: 0.6, haze: 0.6,
  },
  {
    sun: new THREE.Color(0x92aec4), sunI: 1.3,
    sky: new THREE.Color(0x51707f), ground: new THREE.Color(0x1b2125), hemiI: 1.05,
    fog: new THREE.Color(0x10222b), bg: new THREE.Color(0x0a1820),
    exposure: 1.04, cloud: 0.35, haze: 1,
  },
];

/** Blend mood keyframes (default: the harbor arc) into `out` for storm in [0,1]. */
export function moodAt(storm, out, frames = MOOD) {
  const f = Math.max(0, Math.min(1, storm)) * (frames.length - 1);
  const i = Math.min(frames.length - 2, Math.floor(f));
  const t = f - i;
  const A = frames[i], B = frames[i + 1];
  out.sun.copy(A.sun).lerp(B.sun, t); out.sky.copy(A.sky).lerp(B.sky, t); out.ground.copy(A.ground).lerp(B.ground, t);
  out.fog.copy(A.fog).lerp(B.fog, t); out.bg.copy(A.bg).lerp(B.bg, t);
  out.sunI = A.sunI + (B.sunI - A.sunI) * t;
  out.hemiI = A.hemiI + (B.hemiI - A.hemiI) * t;
  out.exposure = A.exposure + (B.exposure - A.exposure) * t;
  out.cloud = A.cloud + (B.cloud - A.cloud) * t;
  out.haze = A.haze + (B.haze - A.haze) * t;
  return out;
}
export function makeMood() {
  return { sun: new THREE.Color(), sky: new THREE.Color(), ground: new THREE.Color(), fog: new THREE.Color(), bg: new THREE.Color(), sunI: 1, hemiI: 1, exposure: 1, cloud: 0, haze: 0 };
}
