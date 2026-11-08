// Tidefall 5.0 weapon models: one per category (with small per-id variants),
// a unique gold model per legendary, visibly mounted attachments, a weapon
// charm on a little spring, and held equipment (frag, semtex, knife, ...).
//
// Weapon frame: +z forward along the bore, +y up, origin at the top of the
// pistol grip (where the right hand holds). The soldier rig parents the model
// to its weapon socket; render.js reads the muzzle through SoldierView.muzzleWorld.
//
// Ids: weapons are resolved from whatever the sim gives us — a def
// ({id, cat, name, legendary?}), a sim weapon id (looked up in
// src/sim/weapons.js when it exists), a category name, or a 3.0 class weapon
// name ('Rifle', 'Long Rifle', ...). Unknown → category from keywords → 'ar'.
// Attachments are matched by keywords in their id/name, so any SIM naming works.

import * as THREE from 'three';
import { GeoBuilder, hash, damp } from './util.js';
import { WT, makeCamoMaterial } from './camos.js';

export const WEAPON_CATS = ['ar', 'smg', 'lmg', 'shotgun', 'dmr', 'sniper', 'carbine', 'pistol', 'mpistol', 'launcher'];
export const LEGENDARY_KEYS = ['tidebreaker', 'maw', 'undertow', 'lantern', 'riptide', 'leviathan', 'siren'];
// SIM-1 weapon ids → model variant within their category (3 per category).
const VARIANT = { tr7: 0, kestrel: 1, bulwark: 2, vex9: 0, hornet: 1, ruck: 2, anvil: 0, gale: 1, hammer: 2, breaker: 0, slug: 1, auto12: 2, lancer: 0, tern: 1, warden: 2, longbow: 0, harpoon: 1, needle: 2, reed: 0, marlin: 1, gaff: 2 };
export const CLASS_DEFAULT_WEAPON = { assault: 'ar', marksman: 'sniper', breacher: 'shotgun', medic: 'smg', recon: 'carbine', engineer: 'smg', gunner: 'lmg' };

// SIM-1's weapon table, when it has landed (feature check; never required).
let SIM = null;
import('../../sim/weapons.js').then((m) => { SIM = m; }).catch(() => { /* not written yet */ });
/** Let callers hand us the table directly (e.g. UI already imported it). */
export function registerWeaponTable(mod) { if (mod) SIM = mod; }

const CAT_WORDS = [
  ['mpistol', /machine ?pistol|mpistol|^mp$|auto ?pistol/],
  ['pistol', /pistol|sidearm|handgun|revolver/],
  ['launcher', /launch|rocket|rpg|bazooka/],
  ['shotgun', /shot ?gun|scatter/],
  ['sniper', /sniper|long ?rifle|rail|bolt/],
  ['dmr', /dmr|marksman|designated/],
  ['lmg', /lmg|machine ?gun|light ?machine/],
  ['smg', /smg|sub ?machine/],
  ['carbine', /carbine/],
  ['ar', /^ar$|assault|rifle/],
];
export function normCat(s) {
  if (!s) return null;
  const k = String(s).toLowerCase().replace(/[_-]/g, ' ').trim();
  if (WEAPON_CATS.includes(k.replace(/ /g, ''))) return k.replace(/ /g, '');
  for (const [c, re] of CAT_WORDS) if (re.test(k)) return c;
  return null;
}
function legendaryKey(...xs) {
  for (const x of xs) {
    if (!x) continue;
    const s = String(x).toLowerCase();
    for (const k of LEGENDARY_KEYS) if (s.includes(k)) return k;
  }
  return null;
}

/**
 * Resolve anything weapon-like → { id, cat, legendary (key|null), name }.
 * `w`: def object | sim id | category | 3.0 name. `cls` gives the fallback.
 */
export function resolveWeapon(w, cls) {
  let def = null;
  if (w && typeof w === 'object') def = w.id && SIM?.WEAPONS?.[w.id] ? { ...SIM.WEAPONS[w.id], ...w } : w;
  else if (typeof w === 'string') def = SIM?.WEAPONS?.[w] || SIM?.LEGENDARIES?.[w] || { id: w };
  if (!def) return { id: CLASS_DEFAULT_WEAPON[cls] || 'ar', cat: CLASS_DEFAULT_WEAPON[cls] || 'ar', legendary: null, name: '' };
  const id = def.id || def.key || def.name || '';
  const leg = def.legendary === false ? null : legendaryKey(def.legendary, def.id, def.key, def.name);
  let cat = (/^m(achine)?\s?pistol$/i.test(id) ? 'mpistol' : null) || normCat(def.cat) || normCat(def.category) || normCat(def.type) || normCat(def.id) || normCat(def.name);
  if (leg && !cat) cat = { tidebreaker: 'sniper', maw: 'shotgun', undertow: 'lmg', lantern: 'dmr', riptide: 'smg', leviathan: 'launcher', siren: 'carbine' }[leg];
  return { id, cat: cat || CLASS_DEFAULT_WEAPON[cls] || 'ar', legendary: leg, name: def.name || '' };
}

/** Attachment slot values (ids / objects) → visual kinds. */
export function attachmentKinds(att = {}, cat = 'ar') {
  const word = (v) => (v && typeof v === 'object' ? [v.id, v.key, v.name, v.kind].filter(Boolean).join(' ') : v ? String(v) : '').toLowerCase();
  const o = word(att.optic), b = word(att.barrel), m = word(att.magazine ?? att.mag), u = word(att.underbarrel), s = word(att.stock);
  const K = {};
  if (o) K.optic = /therm/.test(o) ? 'thermal' : /scope|\dx\b|acog|sniper|variable|hybrid|magn|long/.test(o) ? 'scope' : /holo/.test(o) ? 'holo' : 'reddot';
  if (b) K.barrel = /supp|silen|sound|quiet|can/.test(b) ? 'suppressor' : /comp|brake|muzzle|flash|choke/.test(b) ? 'comp' : /short|snub|cqb|sawn/.test(b) ? 'short' : /heavy|bull|thick/.test(b) ? 'heavy' : 'long';
  if (m) K.mag = /drum|belt|box/.test(m) ? 'drum' : /fast|quick|tape|dual|speed|light/.test(m) ? 'fast' : /hollow|ap\b|incend|round|point/.test(m) ? 'hollow' : 'ext';
  if (u) K.under = /bipod/.test(u) ? 'bipod' : /laser/.test(u) ? 'laser' : /angl/.test(u) ? 'angled' : /launch|gl\b|grenade|masterkey|shot/.test(u) ? 'gl' : 'vgrip';
  if (s) K.stock = /heavy|pad|recoil|fixed|marks|stab/.test(s) ? 'heavy' : /fold/.test(s) ? 'fold' : /light|skel|collap|none|no |quick|wire/.test(s) ? 'light' : 'tac';
  void cat;
  return K;
}

// ---------- colours ----------
const BODY = 0x7c7c7c, DARKC = 0x6e6e6e, POLY = 0x30363a, STEEL = 0x4a535a, RUB = 0x25292c, WOOD = 0x7a5432;
const GOLD = 0xd8a840;
const Z = Math.PI / 2;

// ---------- building blocks ----------
function ironSights(g, y, zr, zf) {
  g.tag(WT.att).box(0.03, 0.025, 0.02, 0, y + 0.012, zr, STEEL);
  g.box(0.008, 0.03, 0.012, 0, y + 0.015, zf, STEEL);
}
function optic(g, kind, y, z, long = false) {
  g.tag(WT.att);
  if (kind === 'scope' || kind === 'thermal') {
    const L = long ? 0.26 : 0.19, r = long ? 0.026 : 0.022;
    g.box(0.02, 0.02, 0.025, 0, y + 0.01, z - L * 0.25, STEEL); g.box(0.02, 0.02, 0.025, 0, y + 0.01, z + L * 0.25, STEEL); // rings
    g.cyl(r, L, 10, 0, y + 0.035, z, POLY, 0, Z);
    g.cyl(r * 1.35, 0.05, 10, 0, y + 0.035, z + L / 2, POLY, 0, Z); // objective bell
    g.cyl(r * 1.15, 0.035, 10, 0, y + 0.035, z - L / 2, POLY, 0, Z); // eyepiece
    g.box(0.016, 0.02, 0.02, 0, y + 0.062, z, STEEL); // turret
    g.box(0.02, 0.016, 0.016, r + 0.008, y + 0.035, z, STEEL);
    g.tag(WT.lens).cyl(r * 1.15, 0.006, 10, 0, y + 0.035, z + L / 2 + 0.026, kind === 'thermal' ? 0xff5a2a : 0x6ac8ff, 0, Z);
  } else if (kind === 'holo') {
    g.box(0.04, 0.012, 0.07, 0, y + 0.006, z, POLY);
    g.box(0.008, 0.045, 0.06, -0.022, y + 0.03, z, POLY); g.box(0.008, 0.045, 0.06, 0.022, y + 0.03, z, POLY);
    g.box(0.044, 0.008, 0.06, 0, y + 0.054, z, POLY);
    g.tag(WT.lens).box(0.034, 0.034, 0.004, 0, y + 0.032, z + 0.025, 0xff4a6a);
  } else { // red dot
    g.box(0.03, 0.012, 0.05, 0, y + 0.006, z, POLY);
    g.cyl(0.018, 0.04, 8, 0, y + 0.03, z, POLY, 0, Z);
    g.tag(WT.lens).cyl(0.014, 0.004, 8, 0, y + 0.03, z + 0.021, 0xff3a3a, 0, Z);
  }
}
function muzzleDev(g, kind, y, z, r = 0.012) {
  // returns the new muzzle z
  g.tag(WT.att);
  if (kind === 'suppressor') { g.cyl(r * 2.1, 0.14, 10, 0, y, z + 0.07, POLY, 0, Z); g.cyl(r * 2.25, 0.012, 10, 0, y, z + 0.13, STEEL, 0, Z); return z + 0.145; }
  if (kind === 'comp') { g.box(r * 3.2, r * 2.6, 0.05, 0, y, z + 0.025, STEEL); g.box(r * 3.4, 0.006, 0.006, 0, y + r * 1.3, z + 0.015, POLY); g.box(r * 3.4, 0.006, 0.006, 0, y + r * 1.3, z + 0.035, POLY); return z + 0.05; }
  if (kind === 'long') { g.tag(WT.dark).cyl(r, 0.1, 6, 0, y, z + 0.05, STEEL, 0, Z); g.tag(WT.att).cyl(r * 1.35, 0.035, 6, 0, y, z + 0.115, STEEL, 0, Z); return z + 0.135; }
  if (kind === 'short') return z - 0.03;
  if (kind === 'heavy') { g.tag(WT.dark).cyl(r * 1.7, 0.1, 8, 0, y, z + 0.05, STEEL, 0, Z); for (let i = 0; i < 3; i++) g.tag(WT.att).cyl(r * 1.9, 0.01, 8, 0, y, z + 0.02 + i * 0.03, POLY, 0, Z); g.cyl(r * 2.2, 0.04, 8, 0, y, z + 0.12, STEEL, 0, Z); return z + 0.14; }
  g.cyl(r * 1.35, 0.035, 6, 0, y, z + 0.0175, STEEL, 0, Z); // flash hider
  return z + 0.035;
}
function underbarrel(g, kind, y, z) {
  g.tag(WT.att);
  if (kind === 'vgrip') { g.box(0.026, 0.07, 0.03, 0, y - 0.035, z, RUB, 0, 0.12); return 'grip'; }
  if (kind === 'angled') { g.box(0.03, 0.03, 0.08, 0, y - 0.02, z, RUB, 0, -0.5); return 'grip'; }
  if (kind === 'laser') { g.box(0.03, 0.03, 0.06, 0, y - 0.018, z, POLY); g.tag(WT.lens).box(0.012, 0.012, 0.004, 0, y - 0.018, z + 0.031, 0xff2a2a); return 'laser'; }
  if (kind === 'gl') { g.cyl(0.03, 0.17, 8, 0, y - 0.035, z + 0.02, POLY, 0, Z); g.box(0.022, 0.05, 0.03, 0, y - 0.07, z - 0.05, RUB, 0, 0.2); return 'gl'; }
  if (kind === 'bipod') {
    g.box(0.03, 0.02, 0.03, 0, y - 0.01, z, STEEL);
    g.box(0.01, 0.01, 0.16, -0.012, y - 0.022, z + 0.08, STEEL, 0.06); g.box(0.01, 0.01, 0.16, 0.012, y - 0.022, z + 0.08, STEEL, -0.06);
    return 'bipod';
  }
  return null;
}
function stockPart(g, kind, y, z, cat) {
  // z = where the stock meets the receiver; extends to -z
  if (kind === 'light') {
    g.tag(WT.att).box(0.008, 0.008, 0.15, 0, y + 0.015, z - 0.075, STEEL); g.box(0.008, 0.008, 0.15, 0, y - 0.025, z - 0.075, STEEL);
    g.box(0.012, 0.06, 0.012, 0, y - 0.005, z - 0.15, STEEL);
    return;
  }
  if (kind === 'fold') { // folded along the right side of the receiver
    g.tag(WT.att).box(0.012, 0.012, 0.012, 0.03, y, z, STEEL);
    g.tag(WT.body).box(0.014, 0.05, 0.15, 0.04, y - 0.005, z + 0.07, BODY);
    g.tag(WT.rubber).box(0.016, 0.06, 0.014, 0.04, y - 0.005, z + 0.15, RUB);
    return;
  }
  if (kind === 'heavy') {
    g.tag(WT.body).box(0.042, 0.085, 0.17, 0, y - 0.01, z - 0.085, BODY);
    g.box(0.03, 0.02, 0.09, 0, y + 0.04, z - 0.09, BODY); // cheek riser
    g.tag(WT.rubber).box(0.046, 0.095, 0.022, 0, y - 0.01, z - 0.175, RUB);
    return;
  }
  // tactical / default per cat
  g.tag(WT.dark).cyl(0.016, 0.1, 8, 0, y + 0.01, z - 0.05, STEEL, 0, Z);
  g.tag(WT.body).box(0.036, 0.07, 0.1, 0, y - 0.004, z - 0.12, BODY);
  g.box(0.03, 0.02, 0.07, 0, y + 0.028, z - 0.12, BODY);
  g.tag(WT.rubber).box(0.04, 0.078, 0.018, 0, y - 0.004, z - 0.175, RUB);
  void cat;
}
function grip(g, y, z) { g.tag(WT.rubber).box(0.032, 0.085, 0.04, 0, y - 0.045, z, RUB, 0, 0.32); g.tag(WT.dark).box(0.012, 0.025, 0.035, 0, y - 0.018, z + 0.04, STEEL); }

// mags: built with their top at y=0, at z=0
function magGeo(kind, cat, leg) {
  const g = new GeoBuilder();
  g.tag(WT.dark);
  if (leg === 'riptide') { // twin curved mags taped together
    for (const sx of [-0.019, 0.019]) for (let i = 0; i < 3; i++) g.box(0.03, 0.05, 0.045, sx, -0.025 - i * 0.042, 0.012 * i, POLY, 0, 0.22 * i);
    g.tag(WT.gold).box(0.07, 0.02, 0.05, 0, -0.06, 0.012, GOLD);
    return g.build({ ao: false });
  }
  if (kind === 'drumround') { g.box(0.03, 0.04, 0.04, 0, -0.02, 0, POLY); g.cyl(0.075, 0.06, 14, 0, -0.09, 0, POLY, 0, 0, Z); g.tag(WT.att).cyl(0.03, 0.065, 8, 0, -0.09, 0, STEEL, 0, 0, Z); return g.build({ ao: false }); }
  if (cat === 'shotgun' && kind === 'box') { g.box(0.034, 0.09, 0.06, 0, -0.045, 0, POLY); return g.build({ ao: false }); }
  if (cat === 'shotgun' && kind === 'drum' && !leg) { g.box(0.02, 0.03, 0.03, 0, -0.015, 0, POLY); g.cyl(0.065, 0.05, 12, 0, -0.08, 0, POLY, 0, 0, Z); return g.build({ ao: false }); }
  if (cat === 'shotgun') { g.tag(WT.att).cyl(0.012, 0.045, 6, 0, -0.02, 0, 0xc8322c, 0, Z); g.tag(WT.gold).cyl(0.0125, 0.012, 6, 0, -0.02, -0.024, GOLD, 0, Z); return g.build({ ao: false }); }
  if (cat === 'launcher') {
    g.tag(WT.att).cone(0.04, 0, 0.09, 8, 0, 0, 0.05, 0x5a6a4a, 0, Z);
    g.cyl(0.04, 0.08, 8, 0, 0, -0.02, 0x5a6a4a, 0, Z);
    g.tag(WT.glow).cyl(0.03, 0.01, 8, 0, 0, -0.065, 0xff7a2a, 0, Z);
    return g.build({ ao: false });
  }
  if (kind === 'drum' || cat === 'lmg') {
    if (cat === 'lmg' || leg === 'undertow') { g.box(0.07, 0.11, 0.1, 0.0, -0.055, 0, POLY); g.tag(WT.att).box(0.02, 0.03, 0.07, -0.04, -0.03, 0, 0xb09040); return g.build({ ao: false }); }
    g.box(0.016, 0.04, 0.03, 0, -0.02, 0, POLY);
    g.cyl(0.055, 0.045, 12, 0, -0.07, 0, POLY, 0, 0, Z);
    g.tag(WT.att).cyl(0.02, 0.05, 8, 0, -0.07, 0, STEEL, 0, 0, Z);
    return g.build({ ao: false });
  }
  const ext = kind === 'ext' ? 1.45 : 1;
  const pistolish = cat === 'pistol' || cat === 'mpistol';
  if (pistolish) { g.box(0.026, 0.05 * ext, 0.03, 0, -0.025 * ext, 0, POLY); return g.build({ ao: false }); }
  if (kind === 'hollow') { g.tag(WT.att).box(cat === 'smg' ? 0.03 : 0.034, 0.012, cat === 'smg' ? 0.036 : 0.062, 0, -0.008, 0, 0xc8322c); g.tag(WT.dark); }
  if (cat === 'smg' || cat === 'carbine' && kind === 'fast') {
    const L = (cat === 'smg' ? 0.13 : 0.1) * ext;
    g.box(0.028, L, 0.034, 0, -L / 2, 0, POLY);
    if (kind === 'fast') { g.box(0.028, L, 0.034, 0.03, -L / 2, 0, POLY); g.tag(WT.att).box(0.064, 0.02, 0.04, 0.015, -L * 0.55, 0, 0x8a6a3a); }
    return g.build({ ao: false });
  }
  if (cat === 'sniper' || cat === 'dmr') {
    const L = 0.06 * ext;
    g.box(0.032, L, 0.06, 0, -L / 2, 0, POLY);
    return g.build({ ao: false });
  }
  // curved rifle mag
  const n = kind === 'ext' ? 4 : 3;
  if (kind === 'hollow') { g.tag(WT.att).box(0.032, 0.012, 0.052, 0, -0.012, 0, 0xc8322c); g.tag(WT.dark); }
  for (let i = 0; i < n; i++) g.box(0.03, 0.04, 0.05, 0, -0.02 - i * 0.036, 0.009 * i * i, POLY, 0, 0.12 * i);
  if (kind === 'fast') { for (let i = 0; i < n; i++) g.box(0.03, 0.04, 0.05, 0.032, -0.02 - i * 0.036, 0.009 * i * i, POLY, 0, 0.12 * i); g.tag(WT.att).box(0.066, 0.018, 0.056, 0.016, -0.06, 0.01, 0x8a6a3a); }
  return g.build({ ao: false });
}

// ---------- categories ----------
// Each returns { g, mag:[x,y,z], muzzle:[y,z], hand:z (support hand), charm:[x,y,z], len }
function buildCat(cat, v, K) {
  const g = new GeoBuilder();
  const r = { mag: [0, -0.03, 0.07], muzzle: [0.035, 0.45], hand: 0.24, charm: [0.03, -0.02, -0.05], len: 0.7 };
  switch (cat) {
    case 'ar': case 'carbine': {
      const car = cat === 'carbine';
      const gl = car ? (v === 2 ? 0.17 : 0.13) : v === 1 ? 0.17 : 0.2, bl = car ? (v === 2 ? 0.13 : 0.07) : v === 2 ? 0.09 : 0.11;
      stockPart(g, K.stock || (car && v === 1 ? 'light' : v === 2 && !car ? 'heavy' : 'tac'), 0.02, -0.05, cat);
      if (v === 1 && !car) { g.tag(WT.dark).box(0.016, 0.03, 0.1, 0, 0.1, 0.03, DARKC); g.box(0.016, 0.03, 0.016, 0, 0.085, -0.01, DARKC); g.box(0.016, 0.03, 0.016, 0, 0.085, 0.07, DARKC); } // carry handle
      grip(g, 0, -0.01);
      g.tag(WT.dark).box(0.05, 0.05, 0.17, 0, -0.005, 0.03, DARKC); // lower
      g.tag(WT.body).box(0.054, 0.048, 0.2, 0, 0.042, 0.04, BODY); // upper
      g.tag(WT.dark).box(0.012, 0.022, 0.03, 0.03, 0.035, 0.02, DARKC); // charging/eject
      if (v === 2 && !car) { g.tag(WT.body).box(0.056, 0.055, gl, 0, 0.03, 0.14 + gl / 2, BODY); g.tag(WT.dark).box(0.058, 0.01, gl * 0.9, 0, 0.0, 0.14 + gl / 2, DARKC); }
      else { g.tag(WT.body).cyl(0.03, gl, 8, 0, 0.032, 0.14 + gl / 2, BODY, 0, Z); for (let i = 0; i < 3; i++) g.tag(WT.dark).box(0.062, 0.008, 0.02, 0, 0.032, 0.17 + i * gl * 0.3, DARKC); }
      g.tag(WT.dark).box(0.022, 0.012, 0.16 + gl, 0, 0.072, 0.06 + gl / 2, DARKC); // top rail
      const bz = 0.14 + gl;
      g.tag(WT.dark).cyl(v === 2 && !car ? 0.017 : 0.012, bl, 6, 0, 0.032, bz + bl / 2, STEEL, 0, Z);
      if (!K.optic) ironSights(g, v === 1 && !car ? 0.118 : 0.078, -0.02, bz - 0.02);
      else optic(g, K.optic, 0.078, 0.06);
      const mz = muzzleDev(g, K.barrel, 0.032, bz + bl);
      r.muzzle = [0.032, mz]; r.hand = 0.14 + gl * 0.55; r.mag = [0, -0.03, 0.07]; r.len = mz + 0.2;
      if (K.under) { underbarrel(g, K.under, 0.0, 0.14 + gl * 0.5); if (K.under !== 'bipod' && K.under !== 'laser') r.hand = 0.14 + gl * 0.5; }
      break;
    }
    case 'smg': {
      if (K.stock === 'heavy' || K.stock === 'tac') stockPart(g, K.stock, 0.02, -0.06, cat);
      else { g.tag(WT.att).box(0.008, 0.008, 0.12, 0.02, 0.03, -0.1, STEEL); g.box(0.008, 0.008, 0.12, -0.02, 0.03, -0.1, STEEL); g.box(0.05, 0.05, 0.01, 0, 0.015, -0.16, STEEL); }
      grip(g, 0, -0.02);
      const L = v === 1 ? 0.24 : 0.2;
      g.tag(WT.body).box(0.056, 0.068, L, 0, 0.025, L / 2 - 0.06, BODY); // boxy receiver
      g.tag(WT.dark).box(0.058, 0.014, L * 0.8, 0, 0.065, L / 2 - 0.05, DARKC);
      if (v === 2) { g.tag(WT.body).box(0.05, 0.03, 0.06, 0, -0.02, L - 0.09, BODY); } // front grip lump
      const bz = L - 0.06;
      g.tag(WT.dark).cyl(0.012, 0.05, 6, 0, 0.03, bz + 0.025, STEEL, 0, Z);
      if (!K.optic) ironSights(g, 0.072, -0.03, bz - 0.02); else optic(g, K.optic, 0.072, 0.04);
      const mz = muzzleDev(g, K.barrel, 0.03, bz + 0.05);
      r.muzzle = [0.03, mz]; r.mag = [0, -0.008, 0.06]; r.hand = 0.08; r.len = mz + 0.16;
      if (K.under) { underbarrel(g, K.under, -0.01, bz - 0.03); r.hand = bz - 0.03; }
      break;
    }
    case 'lmg': {
      stockPart(g, K.stock || 'heavy', 0.02, -0.06, cat);
      grip(g, 0, -0.02);
      g.tag(WT.body).box(0.07, 0.09, 0.26, 0, 0.03, 0.07, BODY); // receiver
      g.tag(WT.dark).box(0.072, 0.03, 0.16, 0, 0.088, 0.05, DARKC); // feed cover
      g.box(0.016, 0.03, 0.08, 0, 0.12, 0.08, STEEL); // carry handle
      g.box(0.016, 0.018, 0.016, 0, 0.105, 0.04, STEEL); g.box(0.016, 0.018, 0.016, 0, 0.105, 0.12, STEEL);
      g.tag(WT.body).box(0.06, 0.06, 0.16, 0, 0.03, 0.28, BODY); // handguard
      for (let i = 0; i < 4; i++) g.tag(WT.dark).box(0.064, 0.012, 0.016, 0, 0.062, 0.22 + i * 0.04, DARKC); // heat vents
      const bz = 0.36, bl = v === 2 ? 0.24 : 0.2;
      g.tag(WT.dark).cyl(0.016, bl, 8, 0, 0.03, bz + bl / 2, STEEL, 0, Z);
      if (v === 2) { g.tag(WT.body).cyl(0.028, 0.16, 8, 0, 0.03, bz + 0.09, BODY, 0, Z); for (let i = 0; i < 5; i++) g.tag(WT.att).cyl(0.03, 0.008, 8, 0, 0.03, bz + 0.03 + i * 0.03, POLY, 0, Z); }
      g.tag(WT.att).cyl(0.026, 0.06, 8, 0, 0.03, bz + 0.05, POLY, 0, Z); // barrel collar
      if (K.optic) optic(g, K.optic, 0.104, -0.01); else ironSights(g, 0.104, -0.04, bz + bl - 0.03);
      const mz = muzzleDev(g, K.barrel || 'comp', 0.03, bz + bl, 0.016);
      underbarrel(g, K.under || 'bipod', 0.0, bz + 0.03);
      r.muzzle = [0.03, mz]; r.mag = [-0.01, -0.016, 0.07]; r.hand = 0.27; r.len = mz + 0.24;
      // belt from box to feed
      g.tag(WT.att); for (let i = 0; i < 4; i++) g.box(0.012, 0.012, 0.02, -0.038, 0.02 - i * 0.02, 0.02 + i * 0.004, 0xb09040);
      break;
    }
    case 'shotgun': {
      const sawn = K.barrel === 'short';
      if (K.stock === 'light') { g.tag(WT.rubber).box(0.034, 0.09, 0.04, 0, -0.05, -0.04, RUB, 0, 0.45); }
      else { g.tag(v === 0 ? WT.att : WT.body).box(0.042, 0.075, 0.2, 0, -0.012, -0.12, v === 0 ? WOOD : BODY, 0, -0.12); g.tag(WT.rubber).box(0.046, 0.09, 0.022, 0, -0.03, -0.22, RUB, 0, -0.12); }
      g.tag(WT.dark).box(0.05, 0.065, 0.18, 0, 0.02, 0.06, DARKC); // receiver
      g.tag(WT.body).box(0.052, 0.03, 0.17, 0, 0.055, 0.06, BODY);
      const bl = sawn ? 0.18 : v === 1 ? 0.38 : 0.32;
      g.tag(WT.body).cyl(0.019, bl, 8, 0, 0.04, 0.15 + bl / 2, BODY, 0, Z); // barrel
      if (v === 2) { // semi-auto with a box mag and a vented shroud
        g.tag(WT.body).box(0.05, 0.06, 0.2, 0, 0.02, 0.24, BODY);
        for (let i = 0; i < 4; i++) g.tag(WT.dark).box(0.052, 0.012, 0.02, 0, 0.052, 0.17 + i * 0.045, DARKC);
      } else {
        g.tag(WT.dark).cyl(0.016, bl * 0.85, 8, 0, 0.002, 0.15 + bl * 0.42, STEEL, 0, Z); // tube mag
        g.tag(v === 0 ? WT.att : WT.rubber).box(0.05, 0.05, 0.12, 0, 0.012, 0.25, v === 0 ? WOOD : RUB); // pump
        for (let i = 0; i < 4; i++) g.tag(WT.rubber).box(0.052, 0.006, 0.008, 0, 0.012, 0.21 + i * 0.025, RUB);
      }
      if (v === 1) { g.tag(WT.dark).box(0.016, 0.012, 0.3, 0, 0.068, 0.25, DARKC); g.tag(WT.att).box(0.012, 0.03, 0.012, 0, 0.085, 0.4, 0xff7a2a); } // rib + fibre sight
      g.tag(WT.att).box(0.008, 0.012, 0.01, 0, 0.065, 0.14 + bl, 0xd8c060); // bead
      if (K.optic) optic(g, K.optic, 0.07, 0.06);
      const mz = muzzleDev(g, K.barrel === 'short' ? null : K.barrel, 0.04, 0.15 + bl, 0.019);
      for (let i = 0; i < (K.mag === 'ext' ? 6 : 4); i++) g.tag(WT.att).cyl(0.009, 0.04, 6, -0.03, 0.0 - (i % 2) * 0.0, -0.12 + i * 0.018, 0xc8322c, 0, 0, 0); // side saddle shells
      if (K.under) underbarrel(g, K.under === 'bipod' ? 'laser' : K.under, -0.015, 0.2);
      grip(g, 0, -0.02);
      r.muzzle = [0.04, mz]; r.mag = v === 2 ? [0, -0.008, 0.07] : [0, -0.02, 0.1]; r.hand = v === 2 ? 0.27 : 0.25; r.len = mz + 0.24;
      break;
    }
    case 'dmr': case 'sniper': {
      const sn = cat === 'sniper';
      if (K.stock && K.stock !== 'tac' && (!sn || K.stock !== 'heavy')) stockPart(g, K.stock, 0.02, -0.06, cat);
      else if (!sn && v === 1) stockPart(g, 'light', 0.02, -0.06, cat);
      else if (sn) {
        g.tag(WT.body).box(0.044, 0.05, 0.22, 0, 0.02, -0.12, BODY); g.box(0.04, 0.04, 0.12, 0, -0.05, -0.14, BODY, 0, 0.35); // thumbhole
        g.box(0.034, 0.026, 0.1, 0, 0.058, -0.12, BODY); g.tag(WT.rubber).box(0.048, 0.1, 0.022, 0, -0.01, -0.235, RUB);
      } else stockPart(g, K.stock || 'heavy', 0.02, -0.06, cat);
      grip(g, 0, -0.02);
      g.tag(WT.body).box(0.05, 0.06, 0.22, 0, 0.03, 0.05, BODY);
      g.tag(WT.dark).box(0.04, 0.02, 0.2, 0, 0.066, 0.05, DARKC);
      if (sn) { g.tag(WT.att).box(0.05, 0.012, 0.012, 0.035, 0.05, -0.02, STEEL); g.sphere(0.012, 0.062, 0.05, -0.02, STEEL); } // bolt handle
      const gl = sn ? 0.2 : 0.22;
      g.tag(WT.body).box(0.05, 0.05, gl, 0, 0.026, 0.16 + gl / 2, BODY, 0, 0, 0);
      g.tag(WT.dark).box(0.052, 0.008, gl, 0, 0.0, 0.16 + gl / 2, DARKC);
      const bz = 0.16 + gl, bl = sn ? (v === 1 ? 0.3 : 0.24) : v === 1 ? 0.12 : 0.14;
      const br = sn && v === 1 ? 0.019 : v === 1 ? 0.01 : 0.013;
      g.tag(WT.dark).cyl(br, bl, 6, 0, 0.03, bz + bl / 2, STEEL, 0, Z);
      if (sn && v === 2) { g.tag(WT.body).cyl(0.022, 0.14, 8, 0, 0.03, bz + 0.12, BODY, 0, Z); } // integral moderator
      optic(g, K.optic || 'scope', 0.075, 0.05, sn);
      const mz = muzzleDev(g, K.barrel || (sn && v === 1 ? 'heavy' : sn || v === 2 ? 'comp' : null), 0.03, bz + bl, br);
      if (K.under || sn) underbarrel(g, K.under || 'bipod', 0.0, bz - 0.04);
      r.muzzle = [0.03, mz]; r.mag = [0, -0.0, 0.07]; r.hand = 0.26; r.len = mz + 0.24;
      break;
    }
    case 'pistol': case 'mpistol': {
      const mp = cat === 'mpistol';
      g.tag(WT.rubber).box(0.03, 0.085, 0.04, 0, -0.045, 0.0, RUB, 0, 0.22);
      g.tag(WT.body).box(0.034, 0.034, mp ? 0.17 : 0.15, 0, 0.022, 0.05, BODY); // slide
      g.tag(WT.dark).box(0.03, 0.022, 0.1, 0, -0.008, 0.05, DARKC); // frame
      g.box(0.006, 0.012, 0.012, 0, 0.044, 0.12, STEEL);
      if (mp) { g.tag(WT.rubber).box(0.022, 0.05, 0.022, 0, -0.03, 0.1, RUB, 0, -0.15); stockPart(g, 'light', 0.0, -0.03, cat); }
      if (K.optic) optic(g, 'reddot', 0.04, 0.03);
      const mz = muzzleDev(g, K.barrel === 'long' ? 'comp' : K.barrel, 0.022, mp ? 0.135 : 0.125, 0.01);
      r.muzzle = [0.022, mz]; r.mag = [0, -0.02, 0.0]; r.hand = 0.0; r.charm = [0.02, -0.04, -0.02]; r.len = mz + 0.1;
      break;
    }
    case 'launcher': {
      g.tag(WT.body).cyl(0.052, 0.62, 10, 0, 0.06, 0.12, BODY, 0, Z);
      g.tag(WT.dark).cyl(0.06, 0.08, 10, 0, 0.06, 0.42, DARKC, 0, Z); g.cyl(0.062, 0.06, 10, 0, 0.06, -0.17, DARKC, 0, Z);
      g.tag(WT.att).box(0.03, 0.06, 0.08, -0.06, 0.08, 0.06, POLY); g.tag(WT.lens).box(0.024, 0.024, 0.004, -0.06, 0.09, 0.101, 0xff7a2a); // side sight
      g.tag(WT.rubber).box(0.03, 0.08, 0.035, 0, -0.03, 0.0, RUB, 0, 0.2); g.box(0.03, 0.07, 0.035, 0, -0.03, 0.18, RUB);
      g.tag(WT.dark).box(0.04, 0.03, 0.16, 0, 0.0, 0.08, DARKC);
      r.muzzle = [0.06, 0.48]; r.mag = [0, 0.06, 0.44]; r.hand = 0.18; r.charm = [0.06, 0.0, -0.05]; r.len = 0.75;
      break;
    }
    default: return buildCat('ar', v, K);
  }
  return { g, ...r };
}

// ---------- legendaries ----------
function buildLegendary(key, K) {
  const g = new GeoBuilder();
  const r = { mag: [0, -0.03, 0.07], muzzle: [0.035, 0.6], hand: 0.24, charm: [0.03, -0.02, -0.05], len: 0.8 };
  const GL = (c) => g.tag(WT.glow) && c;
  void GL;
  switch (key) {
    case 'tidebreaker': { // rail sniper: split rail prongs with a glowing core
      g.tag(WT.gold).box(0.046, 0.06, 0.2, 0, 0.02, -0.13, GOLD); g.tag(WT.dark).box(0.04, 0.04, 0.1, 0, -0.04, -0.12, 0x2a2e33, 0, 0.35);
      g.tag(WT.rubber).box(0.05, 0.1, 0.022, 0, 0.0, -0.24, RUB);
      grip(g, 0, -0.02);
      g.tag(WT.dark).box(0.06, 0.075, 0.24, 0, 0.03, 0.06, 0x20262b);
      g.tag(WT.gold).box(0.064, 0.016, 0.24, 0, 0.074, 0.06, GOLD);
      for (const sy of [-1, 1]) g.tag(WT.gold).box(0.022, 0.02, 0.5, 0, 0.03 + sy * 0.03, 0.42, GOLD); // twin rails
      g.tag(WT.glow).box(0.012, 0.03, 0.46, 0, 0.03, 0.42, 0x5ac8ff);
      for (let i = 0; i < 5; i++) g.tag(WT.gold).cyl(0.045, 0.014, 8, 0, 0.03, 0.22 + i * 0.09, GOLD, 0, Z); // coils
      for (let i = 0; i < 5; i++) g.tag(WT.glow).cyl(0.047, 0.004, 8, 0, 0.03, 0.225 + i * 0.09, 0x5ac8ff, 0, Z);
      g.tag(WT.dark).box(0.05, 0.05, 0.08, 0, -0.03, 0.09, 0x20262b); // power cell
      g.tag(WT.glow).box(0.052, 0.012, 0.06, 0, -0.03, 0.09, 0x5ac8ff);
      optic(g, K.optic || 'scope', 0.082, 0.05, true);
      underbarrel(g, 'bipod', 0.0, 0.3);
      r.muzzle = [0.03, 0.67]; r.mag = [0, -0.0, 0.03]; r.hand = 0.28; r.len = 0.95;
      break;
    }
    case 'maw': { // shotgun: a gaping jaw with fangs and a drum
      g.tag(WT.gold).box(0.046, 0.08, 0.18, 0, -0.01, -0.12, GOLD, 0, -0.12); g.tag(WT.rubber).box(0.05, 0.095, 0.022, 0, -0.03, -0.21, RUB, 0, -0.12);
      grip(g, 0, -0.02);
      g.tag(WT.dark).box(0.07, 0.08, 0.2, 0, 0.025, 0.07, 0x2a1a1a);
      g.tag(WT.gold).box(0.074, 0.02, 0.2, 0, 0.07, 0.07, GOLD);
      // upper and lower jaw
      g.tag(WT.gold).box(0.11, 0.035, 0.2, 0, 0.065, 0.27, GOLD, 0, -0.12); g.box(0.11, 0.035, 0.2, 0, -0.01, 0.27, GOLD, 0, 0.12);
      g.tag(WT.glow).box(0.08, 0.04, 0.16, 0, 0.028, 0.27, 0xff3a2a); // throat glow
      for (let i = 0; i < 4; i++) { g.tag(WT.att).cone(0.012, 0, 0.035, 4, -0.04 + i * 0.027, 0.04, 0.35, 0xf4f0e4, 0, Math.PI); g.cone(0.012, 0, 0.035, 4, -0.04 + i * 0.027, 0.016, 0.35, 0xf4f0e4); }
      g.tag(WT.dark).cyl(0.07, 0.055, 12, 0, -0.07, 0.08, 0x2a1a1a, 0, 0, Z);
      g.tag(WT.gold).cyl(0.03, 0.06, 8, 0, -0.07, 0.08, GOLD, 0, 0, Z);
      g.tag(WT.glow).box(0.004, 0.012, 0.012, 0.03, 0.05, 0.36, 0xff3a2a); g.box(0.004, 0.012, 0.012, -0.03, 0.05, 0.36, 0xff3a2a); // eyes
      r.muzzle = [0.03, 0.38]; r.mag = [0, -0.02, 0.15]; r.hand = 0.22; r.len = 0.66;
      break;
    }
    case 'undertow': { // LMG: wave-finned barrel, abyssal drum
      stockPart(g, 'heavy', 0.02, -0.06, 'lmg');
      grip(g, 0, -0.02);
      g.tag(WT.gold).box(0.074, 0.095, 0.27, 0, 0.03, 0.07, GOLD);
      g.tag(WT.dark).box(0.076, 0.03, 0.17, 0, 0.09, 0.05, 0x10262e);
      g.tag(WT.dark).box(0.064, 0.064, 0.18, 0, 0.03, 0.29, 0x10262e);
      for (let i = 0; i < 5; i++) { g.tag(WT.gold).box(0.012, 0.05, 0.04, 0, 0.08, 0.22 + i * 0.04, GOLD, 0, -0.5); g.tag(WT.glow).box(0.066, 0.006, 0.02, 0, 0.03, 0.22 + i * 0.04, 0x2ad0c0); }
      g.tag(WT.dark).cyl(0.018, 0.2, 8, 0, 0.03, 0.47, 0x10262e, 0, Z);
      g.tag(WT.gold).cyl(0.03, 0.05, 8, 0, 0.03, 0.57, GOLD, 0, Z);
      g.tag(WT.glow).cyl(0.026, 0.006, 8, 0, 0.03, 0.596, 0x2ad0c0, 0, Z);
      underbarrel(g, 'bipod', 0.0, 0.39);
      r.muzzle = [0.03, 0.6]; r.mag = [-0.005, -0.02, 0.08]; r.hand = 0.28; r.len = 0.85;
      break;
    }
    case 'lantern': { // DMR: a caged glowing core around the barrel
      stockPart(g, 'heavy', 0.02, -0.06, 'dmr');
      g.tag(WT.gold).box(0.046, 0.085, 0.17, 0, 0.01, -0.145, GOLD);
      grip(g, 0, -0.02);
      g.tag(WT.dark).box(0.052, 0.062, 0.22, 0, 0.03, 0.05, 0x2a2018);
      g.tag(WT.gold).box(0.054, 0.014, 0.22, 0, 0.066, 0.05, GOLD);
      g.tag(WT.glow).sphere(0.04, 0, 0.03, 0.26, 0xffb040, 1, 1, 1.6, 8, 6); // lantern core
      for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; g.tag(WT.gold).box(0.008, 0.008, 0.16, Math.cos(a) * 0.055, 0.03 + Math.sin(a) * 0.055, 0.26, GOLD); }
      g.tag(WT.gold).cyl(0.06, 0.016, 8, 0, 0.03, 0.18, GOLD, 0, Z); g.cyl(0.06, 0.016, 8, 0, 0.03, 0.34, GOLD, 0, Z);
      g.tag(WT.dark).cyl(0.012, 0.16, 6, 0, 0.03, 0.42, 0x2a2018, 0, Z);
      g.tag(WT.gold).cone(0.03, 0.4, 0.05, 8, 0, 0.03, 0.51, GOLD, 0, Z);
      g.box(0.01, 0.06, 0.01, 0, 0.115, 0.26, GOLD); g.tag(WT.gold).cyl(0.016, 0.006, 8, 0, 0.145, 0.26, GOLD, 0, 0, Z); // hanging ring
      optic(g, K.optic || 'scope', 0.075, 0.03);
      r.muzzle = [0.03, 0.54]; r.mag = [0, 0.0, 0.07]; r.hand = 0.17; r.len = 0.8;
      break;
    }
    case 'riptide': { // SMG: sleek, spiral shroud, twin mags
      g.tag(WT.gold).box(0.008, 0.008, 0.13, 0.02, 0.03, -0.1, GOLD); g.box(0.008, 0.008, 0.13, -0.02, 0.03, -0.1, GOLD); g.box(0.05, 0.05, 0.012, 0, 0.012, -0.165, GOLD);
      grip(g, 0, -0.02);
      g.tag(WT.gold).box(0.056, 0.07, 0.22, 0, 0.026, 0.05, GOLD);
      g.tag(WT.dark).box(0.058, 0.02, 0.2, 0, 0.068, 0.05, 0x10262e);
      g.tag(WT.glow).box(0.06, 0.006, 0.18, 0, 0.044, 0.05, 0x2ad0c0);
      for (let i = 0; i < 6; i++) { const a = i * 1.1; g.tag(WT.gold).box(0.012, 0.012, 0.03, Math.cos(a) * 0.026, 0.03 + Math.sin(a) * 0.026, 0.19 + i * 0.022, GOLD, a); }
      g.tag(WT.dark).cyl(0.018, 0.14, 8, 0, 0.03, 0.24, 0x10262e, 0, Z);
      g.tag(WT.glow).cyl(0.019, 0.006, 8, 0, 0.03, 0.31, 0x2ad0c0, 0, Z);
      ironSights(g, 0.078, -0.03, 0.15);
      r.muzzle = [0.03, 0.32]; r.mag = [0, -0.008, 0.06]; r.hand = 0.12; r.len = 0.5;
      break;
    }
    case 'leviathan': { // 4-tube launcher with a sea-monster head
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.tag(WT.dark).cyl(0.034, 0.56, 8, sx * 0.036, 0.06 + sy * 0.036, 0.12, 0x10262e, 0, Z);
      g.tag(WT.gold).box(0.15, 0.15, 0.05, 0, 0.06, -0.15, GOLD); g.box(0.15, 0.15, 0.04, 0, 0.06, 0.12, GOLD);
      for (let i = 0; i < 5; i++) g.tag(WT.gold).box(0.16, 0.012, 0.05, 0, 0.14, -0.08 + i * 0.07, GOLD, 0, 0.2); // dorsal scales
      g.tag(WT.gold).cone(0.11, 0.6, 0.08, 4, 0, 0.06, 0.43, GOLD, Math.PI / 4, -Z); // jaw rim
      for (let i = 0; i < 4; i++) { const a = i * Z + Math.PI / 4; g.tag(WT.att).cone(0.014, 0, 0.05, 4, Math.cos(a) * 0.07, 0.06 + Math.sin(a) * 0.07, 0.45, 0xf4f0e4, 0, Z); }
      g.tag(WT.glow).box(0.015, 0.015, 0.015, 0.06, 0.13, 0.4, 0xff3a2a); g.box(0.015, 0.015, 0.015, -0.06, 0.13, 0.4, 0xff3a2a);
      g.tag(WT.rubber).box(0.03, 0.08, 0.035, 0, -0.04, 0.0, RUB, 0, 0.2); g.box(0.03, 0.07, 0.035, 0, -0.04, 0.2, RUB);
      g.tag(WT.att).box(0.03, 0.06, 0.08, -0.1, 0.1, 0.0, POLY); g.tag(WT.lens).box(0.024, 0.024, 0.004, -0.1, 0.11, 0.041, 0xff7a2a);
      r.muzzle = [0.06, 0.47]; r.mag = [0.036, 0.096, 0.44]; r.hand = 0.2; r.charm = [0.08, 0.0, -0.05]; r.len = 0.75;
      break;
    }
    case 'siren': { // carbine: sleek gold with a finned tail stock and a pulsing red stripe
      g.tag(WT.gold).box(0.03, 0.09, 0.12, 0, 0.0, -0.12, GOLD, 0, 0.1);
      g.cone(0.05, 0, 0.08, 3, 0, 0.03, -0.2, GOLD, 0, Z - 0.3); g.cone(0.05, 0, 0.08, 3, 0, -0.03, -0.2, GOLD, 0, Z + 0.3); // tail fins
      grip(g, 0, -0.01);
      g.tag(WT.dark).box(0.052, 0.05, 0.17, 0, -0.005, 0.03, 0x2a1418);
      g.tag(WT.gold).box(0.056, 0.05, 0.22, 0, 0.04, 0.05, GOLD);
      g.tag(WT.glow).box(0.058, 0.01, 0.2, 0, 0.03, 0.06, 0xff5a7a);
      g.tag(WT.gold).cone(0.034, 0.5, 0.18, 8, 0, 0.03, 0.25, GOLD, 0, Z); // tapered shroud
      g.tag(WT.dark).cyl(0.012, 0.08, 6, 0, 0.03, 0.37, 0x2a1418, 0, Z);
      g.tag(WT.gold).cone(0.022, 1.0, 0.03, 8, 0, 0.03, 0.42, GOLD, 0, Z);
      g.tag(WT.glow).cyl(0.018, 0.005, 8, 0, 0.03, 0.437, 0xff5a7a, 0, Z);
      optic(g, K.optic || 'holo', 0.065, 0.04);
      r.muzzle = [0.03, 0.44]; r.mag = [0, -0.03, 0.07]; r.hand = 0.24; r.len = 0.7;
      break;
    }
    default: return null;
  }
  return { g, ...r };
}

const GEO = new Map();
function weaponGeos(w, K) {
  const v = w.legendary ? 0 : VARIANT[w.id] ?? Math.floor(hash(String(w.id).split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0) * 3);
  const key = [w.cat, w.legendary || '', v, K.optic || '', K.barrel || '', K.mag || '', K.under || '', K.stock || ''].join('|');
  if (GEO.has(key)) return GEO.get(key);
  const B = (w.legendary && buildLegendary(w.legendary, K)) || buildCat(w.cat, v, K);
  let mk = K.mag;
  if (!mk && !w.legendary && w.cat === 'lmg' && v === 1) mk = 'drumround';
  if (!w.legendary && w.cat === 'shotgun' && v === 2) mk = mk === 'drum' ? 'drum' : 'box';
  const style = w.cat === 'launcher' ? 'rocket' : w.cat === 'shotgun' && mk !== 'box' && mk !== 'drum' && w.legendary !== 'maw' ? 'shells' : w.cat === 'sniper' ? 'bolt' : 'mag';
  const res = { body: B.g.build({ ao: false }), mag: magGeo(mk, w.cat, w.legendary), magPos: B.mag, muzzle: B.muzzle, hand: B.hand, charm: B.charm, len: B.len, style };
  res.body.userData.shared = true; res.mag.userData.shared = true;
  GEO.set(key, res);
  return res;
}

// ---------- charms ----------
const CHARM_GEO = new Map();
/** Charm geometry: hangs from y=0 down. Tags: 0 painted, 3 matte, 5 gold, 6 glow. */
export function charmGeo(id) {
  if (CHARM_GEO.has(id)) return CHARM_GEO.get(id);
  const g = new GeoBuilder();
  g.tag(WT.att).box(0.006, 0.03, 0.006, 0, -0.015, 0, 0x8a9096); // chain
  const y = -0.045;
  switch (id) {
    case 'tags': g.box(0.03, 0.045, 0.004, -0.006, y, 0.003, 0xc8ccd0, 0, 0, 0.2); g.box(0.03, 0.045, 0.004, 0.006, y - 0.004, -0.003, 0xaab0b6, 0, 0, -0.15); break;
    case 'dice': g.box(0.036, 0.036, 0.036, 0, y, 0, 0xe83a3a, 0.5, 0.4); g.box(0.008, 0.008, 0.038, 0, y, 0, 0xffffff, 0.5, 0.4); g.box(0.038, 0.008, 0.008, 0, y, 0, 0xffffff, 0.5, 0.4); break;
    case 'shell': g.sphere(0.024, 0, y, 0, 0xf2e2c8, 0.8, 1.2, 0.6, 8, 6); g.box(0.004, 0.04, 0.012, 0, y, 0.013, 0xa0603a); g.sphere(0.006, 0.01, y + 0.01, 0.012, 0xa0603a); break;
    case 'tooth': g.cone(0.022, 0, 0.06, 3, 0, y - 0.01, 0, 0xf4f0e4, 0, Math.PI); g.box(0.03, 0.01, 0.012, 0, y + 0.02, 0, 0x2a2e31); break;
    case 'duck': g.sphere(0.024, 0, y - 0.006, 0, 0xffd23a, 1.2, 0.9, 1, 8, 6); g.sphere(0.017, 0, y + 0.022, 0.012, 0xffd23a); g.box(0.016, 0.006, 0.016, 0, y + 0.02, 0.03, 0xff8a2a); g.box(0.005, 0.005, 0.005, 0.008, y + 0.028, 0.025, 0x111111); break;
    case 'buoy': g.sphere(0.024, 0, y, 0, 0xe83a3a, 1, 1.2, 1, 8, 6); g.cyl(0.0255, 0.014, 8, 0, y, 0, 0xf4f0e4); g.cyl(0.004, 0.02, 4, 0, y + 0.034, 0, 0x2a2e31); break;
    case 'compass': g.tag(WT.gold).cyl(0.026, 0.01, 12, 0, y, 0, 0xc8a050, 0, Z); g.tag(WT.att).cyl(0.021, 0.012, 12, 0, y, 0, 0xf4f0e4, 0, Z); g.box(0.004, 0.032, 0.014, 0, y, 0, 0xc8322c, 0, 0, 0.5); break;
    case 'anchor': g.box(0.008, 0.05, 0.008, 0, y, 0, 0x3a4246); g.box(0.03, 0.007, 0.008, 0, y + 0.017, 0, 0x3a4246); g.cyl(0.026, 0.008, 10, 0, y - 0.02, 0, 0x3a4246, 0, Z, 0, 0.012); g.cone(0.008, 0, 0.012, 4, 0.025, y - 0.012, 0, 0x3a4246); g.cone(0.008, 0, 0.012, 4, -0.025, y - 0.012, 0, 0x3a4246); g.tag(WT.gold).cyl(0.009, 0.006, 8, 0, y + 0.03, 0, 0xc8b070, 0, Z); break;
    case 'crab': g.sphere(0.026, 0, y, 0, 0xf2e2c8, 1, 1.1, 1, 8, 6); g.cone(0.024, 0.2, 0.03, 8, 0, y + 0.024, 0, 0xd8b890); g.sphere(0.014, 0, y - 0.03, 0.006, 0xff6a3a, 1.4, 0.8, 1.2); g.sphere(0.009, 0.022, y - 0.026, 0.014, 0xff6a3a); g.sphere(0.009, -0.022, y - 0.026, 0.014, 0xff6a3a); g.box(0.004, 0.004, 0.004, 0.006, y - 0.022, 0.018, 0x111111); g.box(0.004, 0.004, 0.004, -0.006, y - 0.022, 0.018, 0x111111); break;
    case 'fish': g.ico(0.03, 0, y - 0.004, 0, 0xffd88a, 1, 1, 1, 0, 0, 0, 1); for (let i = 0; i < 6; i++) { const a = i * 1.05; g.cone(0.006, 0, 0.018, 3, Math.cos(a) * 0.03, y + Math.sin(a) * 0.03, 0, 0x6a8a3a, 0, 0, a - Z); } g.box(0.006, 0.006, 0.006, 0.012, y + 0.006, 0.026, 0x111111); g.box(0.006, 0.006, 0.006, -0.012, y + 0.006, 0.026, 0x111111); break;
    case 'lantern': g.tag(WT.gold).box(0.03, 0.006, 0.03, 0, y + 0.024, 0, 0x3a2a1a); g.box(0.03, 0.006, 0.03, 0, y - 0.024, 0, 0x3a2a1a); for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.tag(WT.att).box(0.004, 0.046, 0.004, sx * 0.013, y, sz * 0.013, 0x3a2a1a); g.tag(WT.glow).sphere(0.012, 0, y, 0, 0xffcf6a, 1, 1.4, 1, 6, 5); break;
    case 'coin': g.tag(WT.gold).cyl(0.03, 0.006, 14, 0, y - 0.004, 0, 0xffd24a, 0, Z); g.tag(WT.att).cyl(0.007, 0.008, 6, 0, y + 0.016, 0, 0x1a1a1a, 0, Z); break;
    case 'gem': g.tag(WT.glow).cone(0.026, 0, 0.034, 6, 0, y - 0.018, 0, 0xff7ad9, 0, Math.PI); g.cone(0.026, 0.55, 0.018, 6, 0, y + 0.008, 0, 0x7aa8ff); g.tag(WT.gold).cyl(0.027, 0.005, 6, 0, y - 0.001, 0, 0xffd24a); break;
    case 'kraken': g.sphere(0.024, 0, y + 0.006, 0, 0x6a3f9a, 1, 1.3, 1, 8, 6); for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; g.cyl(0.005, 0.04, 4, Math.cos(a) * 0.014, y - 0.028, Math.sin(a) * 0.014, 0x8a5aba, 0, Math.sin(a) * 0.5, -Math.cos(a) * 0.5); } g.tag(WT.glow).box(0.008, 0.008, 0.004, 0.009, y + 0.01, 0.022, 0xff7ad9); g.box(0.008, 0.008, 0.004, -0.009, y + 0.01, 0.022, 0xff7ad9); break;
    default: g.box(0.001, 0.001, 0.001, 0, -0.01, 0, 0x000000);
  }
  const geo = g.build({ ao: false });
  geo.userData.shared = true;
  CHARM_GEO.set(id, geo);
  return geo;
}

// ---------- held equipment ----------
const EQ_GEO = new Map();
/** Throwables / gadgets held in the hand (origin = hand). kinds: frag semtex smoke flash knife claymore stim decoy mag shell. */
export function equipGeo(kind) {
  if (EQ_GEO.has(kind)) return EQ_GEO.get(kind);
  const g = new GeoBuilder();
  switch (kind) {
    case 'frag': g.tag(WT.att).ico(0.045, 0, 0, 0, 0x4a5a3a, 1, 1.1, 1, 0, 0, 0, 1); g.box(0.02, 0.025, 0.02, 0, 0.05, 0, STEEL); g.box(0.008, 0.04, 0.012, 0.016, 0.03, 0, STEEL, 0, 0, -0.3); break;
    case 'semtex': g.tag(WT.att).box(0.07, 0.04, 0.05, 0, 0, 0, 0xc8b890); g.box(0.072, 0.012, 0.052, 0, 0, 0, 0x2a2e31); g.tag(WT.glow).box(0.016, 0.016, 0.016, 0, 0.026, 0, 0xff2a2a); break;
    case 'smoke': g.tag(WT.att).cyl(0.03, 0.1, 8, 0, 0, 0, 0x7a8a7a); g.cyl(0.031, 0.02, 8, 0, 0.02, 0, 0xe8e4d8); g.box(0.012, 0.03, 0.012, 0, 0.06, 0, STEEL); break;
    case 'flash': g.tag(WT.att).cyl(0.026, 0.1, 8, 0, 0, 0, 0x2a2e31); for (let i = 0; i < 3; i++) g.cyl(0.027, 0.008, 8, 0, -0.03 + i * 0.03, 0, 0xe8e4d8); g.box(0.012, 0.03, 0.012, 0, 0.06, 0, STEEL); break;
    case 'knife': g.tag(WT.rubber).box(0.022, 0.07, 0.02, 0, -0.02, 0, RUB); g.tag(WT.att).box(0.006, 0.11, 0.028, 0, 0.07, 0.004, 0xc8ccd0); g.box(0.04, 0.008, 0.024, 0, 0.016, 0, STEEL); break;
    case 'claymore': g.tag(WT.att).box(0.12, 0.07, 0.025, 0, 0, 0, 0x5a6a3a, 0, 0.1); g.box(0.006, 0.04, 0.006, -0.04, -0.05, 0, STEEL); g.box(0.006, 0.04, 0.006, 0.04, -0.05, 0, STEEL); g.tag(WT.glow).box(0.01, 0.01, 0.01, 0, 0.04, 0, 0xff2a2a); break;
    case 'stim': g.tag(WT.att).cyl(0.016, 0.08, 6, 0, 0, 0, 0xe8e4d8); g.tag(WT.glow).cyl(0.012, 0.05, 6, 0, 0.005, 0, 0x6aff6a); g.tag(WT.att).cyl(0.003, 0.04, 4, 0, 0.06, 0, 0xc8ccd0); g.box(0.03, 0.008, 0.008, 0, -0.04, 0, STEEL); break;
    case 'decoy': g.tag(WT.att).box(0.05, 0.035, 0.07, 0, 0, 0, 0x3a4246); g.cyl(0.003, 0.08, 4, 0.015, 0.05, 0, STEEL); g.tag(WT.glow).box(0.01, 0.01, 0.01, 0.015, 0.09, 0, 0xffb000); break;
    case 'mag': g.tag(WT.att).box(0.03, 0.1, 0.045, 0, -0.03, 0, POLY, 0, 0.15); break;
    case 'shell': g.tag(WT.att).cyl(0.012, 0.045, 6, 0, 0, 0, 0xc8322c, 0, Z); g.tag(WT.gold).cyl(0.0125, 0.012, 6, 0, 0, -0.024, GOLD, 0, Z); break;
    case 'flare': g.tag(WT.att).cyl(0.02, 0.09, 6, 0, 0, 0, 0xc8322c); g.tag(WT.glow).cyl(0.016, 0.02, 6, 0, 0.05, 0, 0xffd04a); break;
    default: g.tag(WT.att).ico(0.04, 0, 0, 0, 0x4a5a3a); break;
  }
  const geo = g.build({ ao: false });
  geo.userData.shared = true;
  EQ_GEO.set(kind, geo);
  return geo;
}
/** Shared material for charms and held equipment (vertex colours + gold/glow tags). */
export function propMaterial() { return makeCamoMaterial('none'); }

// ---------- the model ----------
const _w = new THREE.Vector3();

/**
 * A weapon on its own group. spec: { weapon, attachments, camo, charm, cls }.
 * group children: body mesh, mag mesh (mag.userData.home), muzzle Object3D, charm pivot.
 */
export class WeaponModel {
  constructor(spec = {}) {
    this.group = new THREE.Group();
    this.muzzle = new THREE.Object3D();
    this.group.add(this.muzzle);
    this.body = new THREE.Mesh(undefined, makeCamoMaterial('none'));
    this.mag = new THREE.Mesh(undefined, makeCamoMaterial('none'));
    this.body.castShadow = true; this.mag.castShadow = true;
    this.group.add(this.body, this.mag);
    this.charmPivot = new THREE.Group();
    this.charmMesh = new THREE.Mesh(charmGeo('default'), propMaterial());
    this.charmMesh.scale.setScalar(1.5);
    this.charmPivot.add(this.charmMesh);
    this.group.add(this.charmPivot);
    this.ch = { a: 0, va: 0, b: 0, vb: 0, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, init: false };
    this.set(spec);
  }

  /** Rebuild for a new weapon / attachments / camo / charm (any subset). */
  set(spec = {}) {
    this.spec = { ...(this.spec || {}), ...spec };
    const s = this.spec;
    const w = (this.info = resolveWeapon(s.weapon, s.cls));
    const K = (this.kinds = attachmentKinds(s.attachments || {}, w.cat));
    const G = weaponGeos(w, K);
    this.G = G;
    this.body.geometry = G.body;
    this.mag.geometry = G.mag;
    this.mag.position.set(...G.magPos);
    this.mag.userData.home = G.magPos;
    this.mag.visible = true; this.mag.scale.setScalar(1);
    this.muzzle.position.set(0, G.muzzle[0], G.muzzle[1]);
    this.charmPivot.position.set(...G.charm);
    this.setCamo(s.camo);
    this.setCharm(s.charm);
    return this;
  }
  setCamo(id) {
    this.spec.camo = id;
    const m = makeCamoMaterial(this.info.legendary ? (id === 'tidal' || id === 'diamond' ? id : 'none') : id || 'none');
    this.body.material = m; this.mag.material = m;
  }
  setCharm(id) {
    this.spec.charm = id;
    const on = !!id && id !== 'default' && id !== 'none';
    this.charmPivot.visible = on;
    if (on) this.charmMesh.geometry = charmGeo(id);
  }
  get handZ() { return this.G.hand; }
  /** 'mag' | 'shells' | 'rocket' | 'bolt' (sniper: mag + bolt cycle). */
  get reloadStyle() { return this.G.style; }
  get length() { return this.G.len; }

  /** Charm swing: a damped 2-axis pendulum pushed by the pivot's world motion. */
  update(dt, t) {
    if (!this.charmPivot.visible || dt <= 0) return;
    const c = this.ch;
    this.charmPivot.getWorldPosition(_w);
    if (!c.init) { c.px = _w.x; c.py = _w.y; c.pz = _w.z; c.init = true; }
    const vx = (_w.x - c.px) / dt, vy = (_w.y - c.py) / dt, vz = (_w.z - c.pz) / dt;
    const ax = (vx - c.vx) / dt, az = (vz - c.vz) / dt;
    c.vx = vx; c.vy = vy; c.vz = vz; c.px = _w.x; c.py = _w.y; c.pz = _w.z;
    const k = 60, d = 4.5;
    const fa = Math.max(-40, Math.min(40, -ax * 0.06)), fb = Math.max(-40, Math.min(40, az * 0.06));
    c.va += (-k * c.a - d * c.va + fa + Math.sin(t * 2.3) * 0.6) * dt; c.a += c.va * dt;
    c.vb += (-k * c.b - d * c.vb + fb + Math.cos(t * 1.7) * 0.5) * dt; c.b += c.vb * dt;
    c.a = Math.max(-1.1, Math.min(1.1, c.a)); c.b = Math.max(-1.1, Math.min(1.1, c.b));
    // the pivot is in the weapon frame; undo the weapon tilt so the charm hangs "down"-ish
    this.charmPivot.rotation.set(c.b, 0, c.a);
    if (this.spec.charm === 'gem') this.charmMesh.rotation.y = t * 2;
    void damp;
  }
}
