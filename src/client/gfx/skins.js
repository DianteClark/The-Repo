// Soldier skins (3.0 cosmetics). A skin swaps the palette baked into a class's
// vertex colours and adds a procedural pattern / material treatment in the
// body shader. Geometry (the class silhouette) never changes, and the squad
// accent material (ring, visor, armband, class marks) is never touched.
//
// Vertex tags (GeoBuilder.tag) tell the shader what each surface is:
//   0 skin / eyes   1 cloth   2 plates / vest   3 headgear   4 metal / weapon   5 pack / gear   6 boots

import * as THREE from 'three';

export const TAG = { skin: 0, cloth: 1, vest: 2, helm: 3, metal: 4, pack: 5, boot: 6 };

// Palette slots per class for the default kit (2.0 look).
export const CLASS_KIT = {
  assault: { cloth: 0x86a3a6, vest: 0x56706f, helm: 0x6d8a88, pack: 0x3b4a3f, pack2: 0x6c6150, w: 0.3 },
  marksman: { cloth: 0xa7a07a, vest: 0x6f6a4b, helm: 0x8a8462, pack: 0x3c3a2c, pack2: 0x5b583f, w: 0.26 },
  breacher: { cloth: 0x7d879a, vest: 0x4e5566, helm: 0x666f80, pack: 0x2f3538, pack2: 0x6a5a3a, w: 0.38 },
  medic: { cloth: 0xb8b3a2, vest: 0x6a7774, helm: 0xd2cab4, pack: 0xd8d0bb, pack2: 0x9d968a, w: 0.29 },
  recon: { cloth: 0x5f7468, vest: 0x3c4a44, helm: 0x4d6157, pack: 0x2f3538, pack2: 0x46574f, w: 0.27 },
  engineer: { cloth: 0x7f8a8c, vest: 0x5d6a63, helm: 0xe6e2d6, pack: 0x4a4f46, pack2: 0xa8a28c, w: 0.3 },
  gunner: { cloth: 0x8b8a76, vest: 0x5a5a44, helm: 0x6c6c52, pack: 0x3e3e30, pack2: 0x7a6c4a, w: 0.36 },
};
const BASE = { skinTone: 0xd9b896, dark: 0x2f3538, metal: 0x69737a, boot: 0x3a3330, wood: 0x5b4a36, shield: 0x9a8a72, shieldSkin: 0xb0582f };

// pattern ids (shader switch): 0 none 1 stripes 2 camo 3 digital 4 rust 5 tiger 6 coral 7 seams 8 gold 9 abyss 10 holo
const LOOKS = {
  default: { pattern: 0 },
  tidewater: { cloth: 0x2b3f63, vest: 0x33496b, helm: 0x2a3550, pack: 0x23314d, pack2: 0xd9d2bf, boot: 0x1f2533, pattern: 1, A: 0xe7e1cf, B: 0x2b3f63 },
  sandstorm: { cloth: 0xc8a873, vest: 0xa88a5a, helm: 0xb99a66, pack: 0x8a6d44, pack2: 0xa58a5c, boot: 0x5a4632, pattern: 2, A: 0x8a6d44, B: 0xe0cfa0 },
  kelpie: { cloth: 0x4c7a50, vest: 0x3a5e40, helm: 0x47704b, pack: 0x2d4a33, pack2: 0x5a7f4a, boot: 0x26302a, pattern: 2, A: 0x22402c, B: 0x86a35c },
  arctic: { cloth: 0xdfe5e8, vest: 0xc4ccd2, helm: 0xe6ebee, pack: 0xaeb8bf, pack2: 0x8c99a3, boot: 0x4a5258, dark: 0x4a5258, pattern: 3, A: 0x8c99a3, B: 0xffffff },
  rustbucket: { cloth: 0x6b5a4a, vest: 0xa4512c, helm: 0xb35a30, pack: 0x7c3a22, pack2: 0x8a6a4a, metal: 0x8a6a52, pattern: 4, A: 0x5c3220, B: 0xd9783e, rough: 0.9 },
  nightops: { cloth: 0x2a2f34, vest: 0x1c2024, helm: 0x23282d, pack: 0x1a1d20, pack2: 0x30363c, boot: 0x141618, metal: 0x3a4046, dark: 0x16191b, pattern: 0, rough: 0.92 },
  tigershark: { cloth: 0x7d8890, vest: 0x5f6a72, helm: 0x6d7880, pack: 0x4b545a, pack2: 0xc9cdd0, boot: 0x23282c, pattern: 5, A: 0x1b2024, B: 0xd8dcde },
  coral: { cloth: 0x2f8f8a, vest: 0xf08a7e, helm: 0xf3a090, pack: 0x26706c, pack2: 0xf6d6c4, pattern: 6, A: 0xffd0b8, B: 0x1d6763 },
  synthwave: { cloth: 0x231a3d, vest: 0x1a1430, helm: 0x2a1f48, pack: 0x161126, pack2: 0x3a2a5c, boot: 0x110d1d, metal: 0x3d3560, dark: 0x120e1c, pattern: 7, A: 0xc04dff, B: 0xff4fa8, glow: 1 },
  gilded: { cloth: 0x1c1a17, vest: 0xe2b84f, helm: 0xe9c25a, pack: 0x2a2620, pack2: 0xd6ad48, boot: 0x14120f, metal: 0xcaa040, dark: 0x1a1814, pattern: 8, A: 0xffe08a, B: 0x8a6418, rough: 0.32, metalness: 0.55 },
  abyssal: { cloth: 0x0f2236, vest: 0x0b1a2e, helm: 0x102640, pack: 0x081422, pack2: 0x15304d, boot: 0x060d16, metal: 0x1f3550, dark: 0x060d16, pattern: 9, A: 0x5bffb0, B: 0x2a7bff, glow: 1 },
  op_splinter: { cloth: 0x8f969a, vest: 0x62696d, helm: 0x7a8286, pack: 0x4a5054, pack2: 0x9aa0a2, boot: 0x26292c, pattern: 12, A: 0x3e4448, B: 0xc5c9c6 },
  op_monsoon: { cloth: 0x4a5868, vest: 0x3a4654, helm: 0x56677a, pack: 0x2c3540, pack2: 0x9fb3c4, boot: 0x1d232a, pattern: 22, A: 0x9fb3c4, B: 0x2c3540, rough: 0.45 },
  op_hazard: { cloth: 0xe0762a, vest: 0x2a2a28, helm: 0xf2c230, pack: 0x3a3a36, pack2: 0xe0762a, boot: 0x1d1d1d, pattern: 11, A: 0xf2c230, B: 0x1d1d1d },
  op_lighthouse: { cloth: 0xf1ece0, vest: 0xc8322c, helm: 0xf1ece0, pack: 0xc8322c, pack2: 0xf1ece0, boot: 0x2a2a2a, pattern: 1, A: 0xc8322c, B: 0xf1ece0 },
  op_moray: { cloth: 0x3d5a2a, vest: 0x2e4520, helm: 0x46632e, pack: 0x26381a, pack2: 0x5a7a3a, boot: 0x1d2414, pattern: 2, A: 0x1d2a12, B: 0xc8c040 },
  op_carbon: { cloth: 0x2c3034, vest: 0x3a4044, helm: 0x33383c, pack: 0x22262a, pack2: 0x4a5258, boot: 0x16181a, metal: 0x4a5258, dark: 0x16181a, pattern: 15, A: 0x5d666c, B: 0x16181a, rough: 0.45, metalness: 0.3 },
  op_ghillie: { cloth: 0x8d9a55, vest: 0x6f7a40, helm: 0x8a9650, pack: 0x5a6a32, pack2: 0x9aa860, boot: 0x2e3220, pattern: 13, A: 0x5a6a32, B: 0xb8b878, rough: 1.0 },
  op_scrap: { cloth: 0x5a5a4c, vest: 0x6c7a62, helm: 0xa0663a, pack: 0x5a6c80, pack2: 0x8a7a5a, metal: 0x6a6258, pattern: 20, A: 0xa0663a, B: 0x5a6c80, rough: 0.85 },
  op_koi: { cloth: 0xf2ede4, vest: 0xe8e2d6, helm: 0xf6f2ea, pack: 0xd8d2c4, pack2: 0xef6a2a, boot: 0x1a1a1a, pattern: 2, A: 0xef6a2a, B: 0x1a1a1a, rough: 0.5 },
  op_dazzle: { cloth: 0xf2f2ee, vest: 0x1b1d22, helm: 0xe8e8e4, pack: 0x2a2e36, pack2: 0x5b7ea8, boot: 0x15171a, pattern: 18, A: 0x1b1d22, B: 0x5b7ea8 },
  op_brine: { cloth: 0x16484e, vest: 0x123a40, helm: 0x1a5258, pack: 0x0e3036, pack2: 0xff8a3a, boot: 0x0b2226, metal: 0x2a4a50, pattern: 4, A: 0xe8f0ec, B: 0xff8a3a, rough: 0.55 },
  op_redtide: { cloth: 0x5a1418, vest: 0x40100f, helm: 0x6a1a1c, pack: 0x300c0c, pack2: 0x7a2420, boot: 0x1a0606, dark: 0x1a0606, pattern: 9, A: 0xff4a3a, B: 0xff8a5a, glow: 1 },
  op_frost: { cloth: 0xcfe6f2, vest: 0xa8cce0, helm: 0xdff0f8, pack: 0x8ab4cc, pack2: 0xe8f6ff, boot: 0x3a4e5c, metal: 0x9ab8cc, pattern: 16, A: 0x5aa8ff, B: 0xffffff, rough: 0.35, glow: 1 },
  op_circuit: { cloth: 0x121a14, vest: 0x1a241c, helm: 0x162018, pack: 0x0e140f, pack2: 0x243026, boot: 0x0a0e0b, metal: 0x2a342c, dark: 0x0a0e0b, pattern: 17, A: 0x9dff3a, B: 0x3aff9a, glow: 1 },
  op_sunset: { cloth: 0xff9a6a, vest: 0xff6a7a, helm: 0xffb36a, pack: 0x6a3a8a, pack2: 0x4a2a7a, boot: 0x2a1a3a, pattern: 21, A: 0xffc06a, B: 0x4a2a7a },
  op_cinder: { cloth: 0x1a1412, vest: 0x241a16, helm: 0x2a201a, pack: 0x140f0d, pack2: 0x30241c, boot: 0x0c0908, metal: 0x2a2420, dark: 0x0c0908, pattern: 14, A: 0xff6a1a, B: 0xffd04a, rough: 0.9, glow: 1 },
  op_admiral: { cloth: 0xf4f2ea, vest: 0x1c2a4a, helm: 0xf4f2ea, pack: 0x1c2a4a, pack2: 0xe8e4d8, boot: 0x111318, metal: 0xd8b048, pattern: 24, A: 0xffd870, B: 0x1c2a4a, rough: 0.45 },
  op_wraith: { cloth: 0xc8d4dc, vest: 0xb0bec8, helm: 0xd8e2ea, pack: 0x9aa8b4, pack2: 0xe0e8ee, boot: 0x5a6670, metal: 0xa8b4c0, pattern: 19, A: 0x8fb8ff, B: 0xe8f2ff, rough: 0.6, glow: 1 },
  op_obsidian: { cloth: 0x0c0a10, vest: 0x14101a, helm: 0x100c16, pack: 0x08060c, pack2: 0x1a1424, boot: 0x050408, metal: 0x1a1424, dark: 0x050408, pattern: 23, A: 0x7a4dff, B: 0x2ad0c0, rough: 0.15, metalness: 0.4, glow: 1 },
  holo: { cloth: 0x8a8fb0, vest: 0xb0b4d0, helm: 0xc0c4e0, pack: 0x7a7fa0, pack2: 0xd0d4f0, metal: 0x9aa0c0, pattern: 10, A: 0xffffff, B: 0xffffff, rough: 0.35, glow: 1 },
};

export function skinIds() { return Object.keys(LOOKS); }
export function hasSkin(id) { return !!LOOKS[id]; }

/** Palette used to bake a class's vertex colours under a skin. */
export function skinKit(cls, skin) {
  const k = CLASS_KIT[cls] || CLASS_KIT.assault;
  const L = LOOKS[skin] || LOOKS.default;
  return {
    w: k.w,
    cloth: L.cloth ?? k.cloth, vest: L.vest ?? k.vest, helm: L.helm ?? k.helm,
    pack: L.pack ?? k.pack, pack2: L.pack2 ?? k.pack2,
    skinTone: BASE.skinTone, dark: L.dark ?? BASE.dark, metal: L.metal ?? BASE.metal,
    boot: L.boot ?? BASE.boot, wood: L.wood ?? BASE.wood,
    shield: L.vest ?? BASE.shield, shieldSkin: L.helm ?? BASE.shieldSkin,
  };
}

const SKIN_GLSL = /* glsl */`
uniform float uSkT;
uniform vec3 uSkA, uSkB;
varying vec3 vSkP;
varying float vSkTag;
float skH(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float skN(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(skH(i), skH(i + vec3(1, 0, 0)), f.x), mix(skH(i + vec3(0, 1, 0)), skH(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(skH(i + vec3(0, 0, 1)), skH(i + vec3(1, 0, 1)), f.x), mix(skH(i + vec3(0, 1, 1)), skH(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
vec3 skHue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
`;

function patternFrag(p) {
  // runs after <color_fragment>; may set skGlow (emissive add), skRough / skMetal (multipliers)
  const fabric = 'float fab = (vSkTag > 0.5 && vSkTag < 3.5) || (vSkTag > 4.5 && vSkTag < 5.5) ? 1.0 : 0.0;';
  switch (p) {
    case 1: return `${fabric}
      if (vSkTag > 0.5 && vSkTag < 1.5) diffuseColor.rgb = mix(diffuseColor.rgb, uSkA, step(0.55, fract(vSkP.y * 13.0)) * 0.9);
      if (vSkTag > 2.5 && vSkTag < 3.5) diffuseColor.rgb = mix(diffuseColor.rgb, uSkA, step(0.82, fract(vSkP.x * 9.0 + 0.3)) * 0.8);`;
    case 2: return `${fabric}
      float n = skN(vSkP * 7.5) * 0.65 + skN(vSkP * 17.0) * 0.35;
      vec3 cm = n < 0.42 ? uSkA : (n > 0.62 ? uSkB : diffuseColor.rgb);
      diffuseColor.rgb = mix(diffuseColor.rgb, cm, fab * 0.92);`;
    case 3: return `${fabric}
      vec3 q = floor(vSkP * 22.0);
      float n = skN(floor(vSkP * 6.0) + 0.5) * 0.6 + skH(q) * 0.4;
      vec3 cm = n < 0.38 ? uSkA : (n > 0.66 ? uSkB : diffuseColor.rgb);
      diffuseColor.rgb = mix(diffuseColor.rgb, cm, fab * 0.9);`;
    case 4: return `
      float n = skN(vSkP * 13.0) * 0.6 + skN(vSkP * 31.0) * 0.4;
      float on = (vSkTag > 1.5 && vSkTag < 5.5) ? 1.0 : 0.0;
      diffuseColor.rgb = mix(diffuseColor.rgb, uSkA, smoothstep(0.55, 0.6, n) * on * 0.85);
      diffuseColor.rgb = mix(diffuseColor.rgb, uSkB, smoothstep(0.28, 0.22, n) * on * 0.6);
      skRough = 1.1;`;
    case 5: return `${fabric}
      float w = sin((vSkP.y * 1.0 + vSkP.x * 0.35 + skN(vSkP * 4.0) * 0.18) * 42.0);
      float st = smoothstep(0.5, 0.62, w);
      diffuseColor.rgb = mix(diffuseColor.rgb, uSkA, st * fab * 0.95);
      if (vSkTag > 4.5 && vSkTag < 5.5) diffuseColor.rgb = mix(diffuseColor.rgb, uSkB, 0.25);`;
    case 6: return `${fabric}
      float n = skN(vSkP * 9.0);
      float spot = step(0.86, skH(floor(vSkP * 26.0)));
      diffuseColor.rgb = mix(diffuseColor.rgb, uSkB, smoothstep(0.62, 0.68, n) * fab * 0.8);
      diffuseColor.rgb = mix(diffuseColor.rgb, uSkA, spot * fab * 0.9);`;
    case 7: return `${fabric}
      float l1 = smoothstep(0.43, 0.48, abs(fract(vSkP.y * 7.0) - 0.5));
      float l2 = smoothstep(0.45, 0.49, abs(fract(vSkP.x * 6.0 + vSkP.z * 6.0) - 0.5));
      float g = max(l1, l2 * 0.7) * fab;
      float pulse = 0.75 + 0.25 * sin(uSkT * 2.4 + vSkP.y * 9.0);
      skGlow = mix(uSkA, uSkB, smoothstep(-0.2, 0.6, vSkP.y)) * g * 1.6 * pulse;
      diffuseColor.rgb = mix(diffuseColor.rgb, uSkA, g * 0.5);`;
    case 8: return `
      float plate = (vSkTag > 1.5 && vSkTag < 3.5) || (vSkTag > 3.5 && vSkTag < 4.5) ? 1.0 : 0.0;
      float n = skN(vSkP * 20.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, mix(uSkB, uSkA, 0.55 + n * 0.45), plate * 0.75);
      float sparkle = step(0.985, skH(floor(vSkP * 60.0) + floor(uSkT * 3.0)));
      skGlow = uSkA * (plate * sparkle * 1.5 + plate * 0.08);
      skMetal = mix(1.0, 1.4, plate); skRough = mix(1.0, 0.7, plate);`;
    case 9: return `${fabric}
      vec3 c = floor(vSkP * 11.0);
      float h = skH(c);
      vec3 f = fract(vSkP * 11.0) - 0.5;
      float dot_ = (1.0 - smoothstep(0.12, 0.32, length(f))) * step(0.8, h);
      float pulse = 0.55 + 0.45 * sin(uSkT * 2.2 + h * 30.0);
      skGlow = mix(uSkA, uSkB, fract(h * 7.0)) * dot_ * pulse * 2.2 * max(fab, 0.4);
      float vein = 1.0 - smoothstep(0.0, 0.05, abs(skN(vSkP * 5.0) - 0.5));
      skGlow += uSkB * vein * fab * 0.35 * pulse;`;
    case 10: return `
      float on = vSkTag > 0.5 ? 1.0 : 0.0;
      vec3 V = normalize(vViewPosition);
      float fr = 1.0 - abs(dot(normalize(vNormal), V));
      vec3 hc = skHue(fract(vSkP.y * 1.4 + fr * 0.8 + uSkT * 0.08));
      float scan = 0.85 + 0.15 * step(0.5, fract(vSkP.y * 40.0 - uSkT * 1.5));
      diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.85), hc, 0.75) * scan, on * 0.85);
      skGlow = hc * on * (0.18 + fr * 0.55);`;
    case 11: return `
      float on = (vSkTag > 1.5 && vSkTag < 3.5) || (vSkTag > 4.5 && vSkTag < 5.5) ? 1.0 : 0.0;
      float band = step(0.5, fract((vSkP.x + vSkP.y) * 9.0));
      float zone = step(0.5, fract(vSkP.y * 2.6 + 0.2));
      diffuseColor.rgb = mix(diffuseColor.rgb, mix(uSkB, uSkA, band), on * zone);
      float tape = (1.0 - step(0.035, abs(fract(vSkP.y * 4.0) - 0.5))) * (vSkTag > 0.5 && vSkTag < 1.5 ? 1.0 : 0.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85), tape);
      skGlow = vec3(0.9) * tape * 0.25;`;
    case 12: return `${fabric}
      vec3 c = floor(vSkP * 8.0 + vec3(0.0, skN(vSkP * 3.0), 0.0));
      float h = skH(c);
      float d = dot(fract(vSkP * 8.0) - 0.5, normalize(vec3(skH(c + 3.1) - 0.5, skH(c + 7.3) - 0.5, 0.4)));
      vec3 cm = d > 0.0 ? (h < 0.5 ? uSkA : diffuseColor.rgb) : (h < 0.4 ? uSkB : diffuseColor.rgb);
      diffuseColor.rgb = mix(diffuseColor.rgb, cm, fab * 0.92);`;
    case 13: return `${fabric}
      float s = skN(vec3(vSkP.x * 60.0, vSkP.y * 7.0, vSkP.z * 60.0));
      float n = skN(vSkP * 6.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, mix(uSkA, uSkB, s), fab * (0.55 + n * 0.4));
      diffuseColor.rgb *= 0.8 + s * 0.35;`;
    case 14: return `
      float n = skN(vSkP * 9.0);
      float n2 = skN(vSkP * 23.0 + 4.0);
      float crack = max(1.0 - smoothstep(0.0, 0.06, abs(n - 0.5)), (1.0 - smoothstep(0.0, 0.05, abs(n2 - 0.5))) * 0.7);
      float on = vSkTag > 0.5 ? 1.0 : 0.0;
      float pulse = 0.7 + 0.3 * sin(uSkT * 2.0 + n * 14.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, uSkA, crack * on);
      skGlow = mix(uSkA, uSkB, crack) * crack * on * 1.8 * pulse + uSkA * on * 0.04 * smoothstep(0.2, -0.3, vSkP.y);`;
    case 15: return `
      vec2 q = vec2(vSkP.x + vSkP.z, vSkP.y) * 34.0;
      vec2 r = vec2(1.0, 1.732);
      vec2 a = mod(q, r) - r * 0.5, b = mod(q - r * 0.5, r) - r * 0.5;
      vec2 g = dot(a, a) < dot(b, b) ? a : b;
      float e = max(abs(g.x) * 0.866 + abs(g.y) * 0.5, abs(g.y));
      float line = smoothstep(0.4, 0.46, e);
      float on = vSkTag > 0.5 ? 1.0 : 0.0;
      diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb * 1.15, uSkB, line), on);`;
    case 16: return `
      float on = vSkTag > 0.5 ? 1.0 : 0.0;
      vec3 c = floor(vSkP * 16.0);
      vec3 f = fract(vSkP * 16.0) - 0.5;
      float h = skH(c);
      float star = max(1.0 - smoothstep(0.0, 0.06, abs(f.x)), 1.0 - smoothstep(0.0, 0.06, abs(f.y))) * (1.0 - smoothstep(0.1, 0.45, length(f)));
      star *= step(0.72, h);
      float frost = smoothstep(0.55, 0.75, skN(vSkP * 12.0));
      diffuseColor.rgb = mix(diffuseColor.rgb, uSkB, frost * on * 0.7);
      float tw = 0.6 + 0.4 * sin(uSkT * 3.0 + h * 40.0);
      skGlow = uSkA * star * on * 1.6 * tw + uSkA * frost * on * 0.12;`;
    case 17: return `${fabric}
      vec3 p = vSkP * 18.0;
      vec3 c = floor(p); vec3 f = fract(p);
      float h = skH(c);
      float lx = (1.0 - smoothstep(0.04, 0.1, abs(f.y - 0.5))) * step(0.45, h);
      float ly = (1.0 - smoothstep(0.04, 0.1, abs(f.x - 0.5))) * step(h, 0.55) * step(0.2, h);
      float pad = (1.0 - smoothstep(0.12, 0.2, length(f.xy - 0.5))) * step(0.85, h);
      float tr = max(max(lx, ly), pad) * max(fab, 0.5);
      float flow = 0.55 + 0.45 * sin(uSkT * 4.0 - (vSkP.y + vSkP.x) * 20.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, uSkA * 0.6, tr * 0.5);
      skGlow = mix(uSkA, uSkB, h) * tr * 1.4 * flow;`;
    case 18: return `${fabric}
      vec3 c = floor(vSkP * vec3(3.0, 3.5, 3.0));
      float h = skH(c);
      vec2 dir = h < 0.33 ? vec2(1.0, 0.0) : (h < 0.66 ? vec2(0.7, 0.7) : vec2(0.7, -0.7));
      float s = step(0.5, fract(dot(vec2(vSkP.x + vSkP.z, vSkP.y), dir) * (10.0 + h * 8.0)));
      vec3 cm = s > 0.5 ? uSkA : (h > 0.8 ? uSkB : diffuseColor.rgb);
      diffuseColor.rgb = mix(diffuseColor.rgb, cm, fab);`;
    case 19: return `
      float on = vSkTag > 0.5 ? 1.0 : 0.0;
      vec3 V = normalize(vViewPosition);
      float fr = pow(1.0 - abs(dot(normalize(vNormal), V)), 2.0);
      float mist = skN(vSkP * 7.0 + vec3(0.0, -uSkT * 0.6, 0.0));
      diffuseColor.rgb = mix(diffuseColor.rgb, uSkB, mist * on * 0.3);
      skGlow = uSkA * on * (fr * 1.3 + mist * 0.2) * (0.8 + 0.2 * sin(uSkT * 1.7));`;
    case 20: return `
      float on = vSkTag > 0.5 && vSkTag < 6.5 && !(vSkTag > 3.5 && vSkTag < 4.5) ? 1.0 : 0.0;
      vec3 c = floor(vSkP * vec3(7.0, 6.0, 7.0));
      float h = skH(c);
      vec3 f = fract(vSkP * vec3(7.0, 6.0, 7.0));
      vec3 cm = h < 0.3 ? uSkA : (h < 0.55 ? uSkB : (h < 0.75 ? diffuseColor.rgb * 1.2 : diffuseColor.rgb * 0.8));
      float seam = 1.0 - smoothstep(0.03, 0.07, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
      float rivet = step(0.9, skH(floor(vSkP * 40.0))) * seam;
      diffuseColor.rgb = mix(diffuseColor.rgb, cm, on * 0.85);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12), seam * on * 0.6);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.7), rivet * on);`;
    case 21: return `
      float on = vSkTag > 0.5 && vSkTag < 6.5 ? 1.0 : 0.0;
      float k = clamp(vSkP.y * 1.6 + 0.35, 0.0, 1.0);
      vec3 g = mix(uSkB, mix(vec3(1.0, 0.35, 0.45), uSkA, smoothstep(0.45, 1.0, k)), smoothstep(0.0, 0.55, k));
      diffuseColor.rgb = mix(diffuseColor.rgb, g, on * 0.85);
      skGlow = uSkA * on * smoothstep(0.75, 1.0, k) * 0.15;`;
    case 22: return `${fabric}
      float streak = smoothstep(0.7, 1.0, skN(vec3(vSkP.x * 70.0, vSkP.y * 3.0 + uSkT * 0.6, vSkP.z * 70.0)));
      diffuseColor.rgb = mix(diffuseColor.rgb, uSkA, streak * fab * 0.55);
      skRough = mix(1.0, 0.5, streak);`;
    case 23: return `
      float on = vSkTag > 0.5 ? 1.0 : 0.0;
      vec3 V = normalize(vViewPosition);
      float fr = 1.0 - abs(dot(normalize(vNormal), V));
      vec3 oil = skHue(fract(fr * 1.3 + vSkP.y * 0.8 + skN(vSkP * 4.0) * 0.5 + uSkT * 0.04));
      vec3 sheen = mix(uSkA, uSkB, 0.5 + 0.5 * sin(fr * 6.0 + uSkT * 0.5));
      skGlow = mix(sheen, oil, 0.4) * on * pow(fr, 1.6) * 1.2;
      skMetal = 1.6; skRough = 0.8;`;
    case 24: return `
      float vest = (vSkTag > 1.5 && vSkTag < 2.5) ? 1.0 : 0.0;
      float helm = (vSkTag > 2.5 && vSkTag < 3.5) ? 1.0 : 0.0;
      float cloth = (vSkTag > 0.5 && vSkTag < 1.5) ? 1.0 : 0.0;
      float gold = vest * (1.0 - step(0.035, abs(fract(vSkP.y * 5.5) - 0.5) - 0.42)) + helm * (1.0 - step(0.02, abs(vSkP.y - 0.1))) + cloth * (1.0 - step(0.012, abs(fract(vSkP.x * 3.0 + 0.5) - 0.5))) * 0.0;
      gold = clamp(gold, 0.0, 1.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, uSkA, gold);
      skGlow = uSkA * gold * 0.25;
      skMetal = mix(1.0, 12.0, gold); skRough = mix(1.0, 0.6, gold);`;
    default: return '';
  }
}

/**
 * Body material for a skin. One per soldier (the hit flash uses
 * emissiveIntensity), but every soldier with the same pattern shares a program.
 */
export function makeSkinMaterial(skin) {
  const L = LOOKS[skin] || LOOKS.default;
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: L.rough ?? 0.75, metalness: L.metalness ?? 0.05, emissive: 0xffffff, emissiveIntensity: 0,
  });
  const pat = L.pattern | 0;
  if (!pat) return mat;
  const U = { uSkT: { value: 0 }, uSkA: { value: new THREE.Color(L.A ?? 0xffffff) }, uSkB: { value: new THREE.Color(L.B ?? 0xffffff) } };
  mat.userData.skinU = U;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aTag;\nvarying vec3 vSkP;\nvarying float vSkTag;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkP = position; vSkTag = aTag;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SKIN_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\nvec3 skGlow = vec3(0.0); float skRough = 1.0; float skMetal = 1.0;\n{\n' + patternFrag(pat) + '\n}\n')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor * skRough, 0.04, 1.0);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = clamp(metalnessFactor * skMetal, 0.0, 1.0);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += skGlow;');
  };
  mat.customProgramCacheKey = () => 'tf-skin-' + pat;
  return mat;
}

/** Advance animated skin patterns (shared clock). */
export function tickSkinMaterial(mat, t) { const U = mat.userData.skinU; if (U) U.uSkT.value = t; }
