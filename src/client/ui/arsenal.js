// Arsenal adapter: the gameplay data the front end shows (classes, weapons,
// attachments, equipment, perks, killstreaks) in one normalised shape.
//
// SIM-1 owns the real data (src/sim/weapons.js, PERKS, the 7 classes). It is
// imported dynamically and every shape is normalised, so the menus keep working
// with the built-in fallback below while the sim is still being written, and
// switch to the sim's numbers the moment they exist.

import * as K from '../../sim/constants.js';
import * as G from '../../sim/game.js';

let W = {};
try { W = await import('../../sim/weapons.js'); } catch (e) { console.info('[tidefall] sim weapons.js not available yet, using the built-in arsenal'); }
let L = {};
try { L = await import('../../sim/loadout.js'); } catch { /* optional */ }
export const SIM = W;

export const SLOT_KEYS = ['optic', 'barrel', 'magazine', 'underbarrel', 'stock'];
export const SLOT_NAMES = { optic: 'Optic', barrel: 'Barrel', magazine: 'Magazine', underbarrel: 'Underbarrel', stock: 'Stock' };
export const CAT_NAMES = { ar: 'Assault Rifle', smg: 'SMG', lmg: 'LMG', shotgun: 'Shotgun', dmr: 'DMR', sniper: 'Sniper', carbine: 'Carbine', pistol: 'Pistol', mpistol: 'Machine Pistol', launcher: 'Launcher', secondary: 'Secondary' };
export const CAT_SHORT = { ar: 'AR', smg: 'SMG', lmg: 'LMG', shotgun: 'SG', dmr: 'DMR', sniper: 'SNP', carbine: 'CRB' };
export const PRIMARY_CATS = ['ar', 'smg', 'lmg', 'shotgun', 'dmr', 'sniper', 'carbine'];

// ------------------------------------------------------------------ fallback data (spec 5.0 §2–4)

const FB_WEAPONS = [
  { id: 'ar_tidewater', name: 'Tidewater AR', cat: 'ar', range: 9, aim: 66, dmg: [3, 5], mag: 6, desc: 'Reliable all-rounder. No weaknesses, no tricks.' },
  { id: 'ar_brine7', name: 'Brine-7', cat: 'ar', range: 10, aim: 62, dmg: [3, 6], mag: 5, desc: 'Harder hitting, heavier kick.' },
  { id: 'ar_gale', name: 'Gale Burst', cat: 'ar', range: 8, aim: 70, dmg: [2, 5], mag: 6, special: 'burst', desc: 'Three-round burst: consistent damage at mid range.' },
  { id: 'smg_wasp', name: 'Wasp', cat: 'smg', range: 6, aim: 70, dmg: [2, 4], mag: 8, desc: 'Fast, light and forgiving up close.' },
  { id: 'smg_moray', name: 'Moray', cat: 'smg', range: 7, aim: 66, dmg: [2, 5], mag: 7, desc: 'Longer barrel, steadier at the edge of its range.' },
  { id: 'smg_ripper', name: 'Ripcurrent', cat: 'smg', range: 5, aim: 72, dmg: [3, 4], mag: 9, special: 'falloff', desc: 'Shreds anything inside five tiles. Useless past it.' },
  { id: 'lmg_anchor', name: 'Anchor LMG', cat: 'lmg', range: 10, aim: 58, dmg: [3, 5], mag: 12, desc: 'A wall of lead. Heavy to carry.' },
  { id: 'lmg_bastion', name: 'Bastion', cat: 'lmg', range: 9, aim: 62, dmg: [3, 4], mag: 14, desc: 'Huge drum, steady fire, modest punch.' },
  { id: 'lmg_squall', name: 'Squall', cat: 'lmg', range: 11, aim: 55, dmg: [4, 5], mag: 10, desc: 'Long-range suppression with a brutal kick.' },
  { id: 'sg_maul', name: 'Maul', cat: 'shotgun', range: 4, aim: 76, dmg: [5, 7], mag: 4, special: 'falloff', desc: 'Pump-action. Ends arguments at the door.' },
  { id: 'sg_breaker', name: 'Breakwater', cat: 'shotgun', range: 5, aim: 72, dmg: [4, 7], mag: 5, special: 'pellets', desc: 'Pellet spread: grazes more, misses less.' },
  { id: 'sg_spray', name: 'Seaspray Auto', cat: 'shotgun', range: 4, aim: 70, dmg: [4, 6], mag: 6, desc: 'Semi-auto drum. Lower punch, more shells.' },
  { id: 'dmr_heron', name: 'Heron DMR', cat: 'dmr', range: 11, aim: 70, dmg: [4, 5], mag: 5, desc: 'Precise semi-auto for patient players.' },
  { id: 'dmr_lance', name: 'Lance', cat: 'dmr', range: 12, aim: 66, dmg: [4, 6], mag: 4, desc: 'Hits like a rifle, handles like a rifle.' },
  { id: 'dmr_spar', name: 'Spar-12', cat: 'dmr', range: 10, aim: 72, dmg: [3, 5], mag: 6, desc: 'Lighter, faster, more forgiving.' },
  { id: 'sn_longtide', name: 'Longtide', cat: 'sniper', range: 14, aim: 74, dmg: [5, 7], mag: 3, special: 'closePenalty', desc: 'Bolt-action. Clears a lane from across the map.' },
  { id: 'sn_gaff', name: 'Gaff', cat: 'sniper', range: 13, aim: 70, dmg: [5, 6], mag: 4, special: 'closePenalty', desc: 'Straight-pull bolt: one more round, a little less bite.' },
  { id: 'sn_harpoon', name: 'Harpoon', cat: 'sniper', range: 15, aim: 68, dmg: [6, 7], mag: 2, special: 'pierce', desc: 'Anti-materiel round punches through half cover.' },
  { id: 'cb_skiff', name: 'Skiff Carbine', cat: 'carbine', range: 9, aim: 70, dmg: [3, 5], mag: 6, desc: 'Light and quick. The scout\'s favourite.' },
  { id: 'cb_tern', name: 'Tern', cat: 'carbine', range: 10, aim: 68, dmg: [3, 5], mag: 5, desc: 'Longer sight radius, slower to shoulder.' },
  { id: 'cb_reed', name: 'Reed', cat: 'carbine', range: 8, aim: 72, dmg: [3, 4], mag: 7, desc: 'Steady and quiet. Rewards accuracy.' },
];
const FB_SECONDARIES = [
  { id: 'pistol', name: 'Sidearm', cat: 'pistol', range: 6, aim: 64, dmg: [2, 3], mag: Infinity, desc: 'Infinite ammo. Low damage. Always there.' },
  { id: 'mpistol', name: 'Viper MP', cat: 'mpistol', range: 5, aim: 66, dmg: [2, 4], mag: 6, desc: 'A machine pistol for when it gets close.' },
  { id: 'launcher', name: 'Breaker RPG', cat: 'launcher', range: 9, aim: 80, dmg: [4, 5], mag: 2, special: 'blast', desc: '2 rockets. Blast radius 1.5. Wrecks cover.' },
];
const A = (id, slot, name, mods, desc) => ({ id, slot, name, mods, desc });
const FB_ATTACHMENTS = [
  A('red_dot', 'optic', 'Reflex Sight', { aim: 5, range: -1 }, 'Quick, clear sight picture.'),
  A('acog', 'optic', '4× Scope', { aim: 8, move: -1 }, 'Magnified. Slower to swing.'),
  A('thermal', 'optic', 'Thermal', { aim: 6, mag: -1 }, 'Sees through smoke edges. Fiddly to reload around.'),
  A('long_barrel', 'barrel', 'Long Barrel', { range: 2, move: -1 }, 'Reaches further, carries heavier.'),
  A('suppressor', 'barrel', 'Suppressor', { aim: 3, dmg: -1 }, 'Quiet shots. A little less punch.'),
  A('heavy_barrel', 'barrel', 'Heavy Barrel', { dmg: 1, aim: -5 }, 'Hits harder. Kicks harder.'),
  A('ext_mag', 'magazine', 'Extended Mag', { mag: 3, aim: -3 }, 'More rounds, heavier gun.'),
  A('fast_mag', 'magazine', 'Fast Mag', { mag: 1, move: -1 }, 'Quicker reloads, a touch of bulk.'),
  A('drum', 'magazine', 'Drum Mag', { mag: 6, move: -1, aim: -4 }, 'Never stop shooting. Never stop sweating.'),
  A('grip', 'underbarrel', 'Vertical Grip', { aim: 4, range: -1 }, 'Steady hands, shorter reach.'),
  A('bipod', 'underbarrel', 'Bipod', { aim: 8, move: -2 }, 'Deadly when set. Slow when not.'),
  A('laser', 'underbarrel', 'Laser', { aim: 3, mag: -1 }, 'Tight hip fire. Battery pack eats mag space.'),
  A('light_stock', 'stock', 'Light Stock', { move: 1, aim: -4 }, 'Run faster, shoot looser.'),
  A('padded_stock', 'stock', 'Padded Stock', { aim: 4, move: -1 }, 'Rock steady, a little slower.'),
  A('no_stock', 'stock', 'No Stock', { move: 1, range: -1, aim: -2 }, 'Strip it down and go.'),
];
const FB_EQUIP = {
  lethal: [
    { id: 'frag', name: 'Frag', charges: 1, desc: 'Lob up to 7 tiles. 3 damage in a 3×3 and it shreds cover.' },
    { id: 'semtex', name: 'Semtex', charges: 1, desc: 'Sticks: never misses its tile, +2 damage to a unit it lands on.' },
    { id: 'claymore', name: 'Claymore', charges: 1, desc: 'Place next to you. The first enemy to move within 1.5 takes 5.' },
    { id: 'knife', name: 'Throwing Knife', charges: 2, desc: 'Range 4, 4 damage, silent.' },
  ],
  tactical: [
    { id: 'smoke', name: 'Smoke', charges: 1, desc: 'A 3×3 cloud that hides anyone inside. -20 aim in and out.' },
    { id: 'flash', name: 'Flashbang', charges: 1, desc: 'Radius 1.5. Hit enemies lose 1 AP and take -30 aim next turn.' },
    { id: 'stim', name: 'Stim', charges: 1, desc: 'Instant: +1 AP this turn and heal 2.' },
    { id: 'decoy', name: 'Decoy', charges: 2, desc: 'Fake gunfire ping that pulls bot overwatch and aim for a round.' },
  ],
};
const FB_STREAKS = [
  { key: 'uav', name: 'UAV', cost: 3, target: 'none', desc: 'Reveals every enemy within 14 tiles of you until your next turn.' },
  { key: 'care_package', name: 'Care Package', cost: 4, target: 'tile', range: 6, desc: 'Pick a tile within 6. A crate drops there next step: 40% legendary.' },
  { key: 'counter_uav', name: 'Counter-UAV', cost: 4, target: 'none', desc: 'Enemy scans and UAVs can\'t see your squad for 2 rounds.' },
  { key: 'airstrike', name: 'Airstrike', cost: 5, target: 'line', length: 7, desc: 'Mark a line of 7 tiles. Next round it hits for 5, ignores and destroys cover.' },
  { key: 'sentry', name: 'Sentry', cost: 5, target: 'tile', range: 2, desc: 'An 8 HP turret that overwatches a cone for 3 rounds.' },
  { key: 'gunship', name: 'Gunship', cost: 7, target: 'none', desc: 'For 2 rounds it fires on up to 2 visible enemies after each of your turns.' },
];
const FB_PERKS = {
  tier1: [
    { key: 'scavenger', name: 'Scavenger', desc: 'A kill refills your magazine and +1 lethal.' },
    { key: 'amphibious', name: 'Amphibious', desc: 'Shallows and tide tiles cost normal movement. Tide damage -1.' },
    { key: 'lightweight', name: 'Lightweight', desc: '+1 move.' },
    { key: 'flak_jacket', name: 'Flak Jacket', desc: 'Explosive damage halved.' },
  ],
  tier2: [
    { key: 'ghost', name: 'Ghost', desc: 'Immune to Scan and UAV.' },
    { key: 'hardline', name: 'Hardline', desc: 'Killstreaks cost 1 fewer kill.' },
    { key: 'steady_aim', name: 'Steady Aim', desc: '+10 aim if you haven\'t moved this turn.' },
    { key: 'trapper', name: 'Trapper', desc: 'Start with a Claymore.' },
  ],
  tier3: [
    { key: 'dead_silence', name: 'Dead Silence', desc: 'No gunfire pings, and your first move each turn ignores overwatch.' },
    { key: 'quick_fix', name: 'Quick Fix', desc: 'Heal 3 on a kill or revive. You revive at +2 HP.' },
    { key: 'tracker', name: 'Tracker', desc: 'Enemies you damage stay revealed to your squad until your next turn.' },
    { key: 'tactical_mask', name: 'Tactical Mask', desc: 'Immune to flashbangs and the smoke aim penalty.' },
  ],
};
const FB_CLASS_EXTRA = {
  engineer: { name: 'Engineer', desc: 'Builds cover where there is none. Repairs boats.', hp: 10, armor: 0, move: 5, weapon: { name: 'Carbine', range: 9, aim: 66, dmg: [3, 5] } },
  gunner: { name: 'Gunner', desc: 'Heavy weapons. Pins enemies down with Suppress.', hp: 12, armor: 1, move: 4, weapon: { name: 'LMG', range: 10, aim: 58, dmg: [3, 5] } },
};
const FB_ALLOWED = {
  assault: ['ar', 'smg'], marksman: ['dmr', 'sniper'], breacher: ['shotgun', 'smg'], medic: ['smg', 'carbine'],
  recon: ['carbine', 'dmr'], engineer: ['smg', 'shotgun', 'carbine'], gunner: ['lmg'],
};
export const CLASS_ROLE = {
  assault: { role: 'Frontline all-rounder', ability: 'Frag specialist · Run & Gun', abilityDesc: '+1 lethal charge. Once every 3 rounds you may shoot after a dash.' },
  marksman: { role: 'Long-range precision', ability: 'Aimed Shot', abilityDesc: '+15 aim and +2 damage on one carefully placed round. Cooldown 3.' },
  breacher: { role: 'Close-quarters bruiser', ability: 'Breach', abilityDesc: 'Blow apart adjacent cover: the tile opens and enemies within 1 take 4. Cooldown 3.' },
  medic: { role: 'Squad lifeline', ability: 'Patch', abilityDesc: 'Heal yourself or an adjacent ally for 5, or revive a downed ally at 4 HP. Cooldown 2.' },
  recon: { role: 'Eyes of the squad', ability: 'Scan', abilityDesc: 'Reveal every unit within 5 tiles of a point up to 12 away, through walls, until your next turn.' },
  engineer: { role: 'Field fortifier', ability: 'Deploy Cover', abilityDesc: 'Drop a full-cover barricade on an adjacent open tile. Cooldown 3. Repairs boats.' },
  gunner: { role: 'Heavy suppression', ability: 'Suppress', abilityDesc: 'Pin an enemy in sight: -25 aim and moving draws a reaction shot. 1 AP, 3 ammo, ends turn. Cooldown 2.' },
};
export const CLASS_ORDER = ['assault', 'marksman', 'breacher', 'medic', 'recon', 'engineer', 'gunner'];

// ------------------------------------------------------------------ normalisers

const arr = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.entries(v).map(([id, d]) => (d && typeof d === 'object' ? { id, key: id, ...d } : null)).filter(Boolean) : []);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function normWeapon(w) {
  const id = String(w.id ?? w.key);
  const dmg = Array.isArray(w.dmg) ? [num(w.dmg[0], 1), num(w.dmg[1] ?? w.dmg[0], 1)] : [num(w.dmg, 2), num(w.dmg, 2)];
  const cat = String(w.cat || w.category || 'ar').toLowerCase();
  return {
    ...w, id, name: String(w.name || id), cat, dmg,
    range: num(w.range, 8), aim: num(w.aim, 65),
    mag: w.mag === Infinity || w.mag === null || w.infinite ? Infinity : num(w.mag, 6),
    move: num(w.move, 0),
    legendary: !!(w.legendary || w.gold || w.trait),
    desc: String(w.desc || w.trait || ''),
  };
}
function normAttachment(a, slotHint) {
  const id = String(a.id ?? a.key);
  const slot = String(a.slot || slotHint || 'optic');
  const mods = {};
  const src = a.mods && typeof a.mods === 'object' ? a.mods : a;
  for (const k of ['aim', 'range', 'dmg', 'mag', 'move', 'close', 'owAim', 'steady']) if (k in src && Number.isFinite(Number(src[k])) && Number(src[k]) !== 0) mods[k] = Number(src[k]);
  for (const k of ['silent', 'thermal', 'freeReload']) if (src[k] === true) mods[k] = true;
  const pro = a.pro ? String(a.pro) : null, con = a.con ? String(a.con) : null;
  return { id, slot, name: String(a.name || id), mods, pro, con, desc: String(a.desc || [pro, con].filter(Boolean).join(' · ')) };
}

// Weapons
const simWeapons = [...arr(W.WEAPONS), ...arr(W.SECONDARIES)].map(normWeapon);
const simPrim = simWeapons.filter((w) => PRIMARY_CATS.includes(w.cat) && !w.legendary);
const simSec = simWeapons.filter((w) => !PRIMARY_CATS.includes(w.cat) && !w.legendary);
export const SOURCE = { weapons: simPrim.length ? 'sim' : 'fallback' };
export const PRIMARIES = simPrim.length ? simPrim : FB_WEAPONS.map(normWeapon);
export const SECONDARIES = simSec.length ? simSec : FB_SECONDARIES.map(normWeapon);
export const LEGENDARIES = arr(W.LEGENDARIES).map(normWeapon);
const weaponIndex = new Map([...PRIMARIES, ...SECONDARIES, ...LEGENDARIES].map((w) => [w.id, w]));
export const weaponById = (id) => weaponIndex.get(id) || null;

// Attachments: {slot: [..]} or id -> def with .slot, or a flat array.
let simAtt = [];
if (W.ATTACHMENTS && !Array.isArray(W.ATTACHMENTS) && SLOT_KEYS.some((s) => Array.isArray(W.ATTACHMENTS[s]))) {
  for (const s of SLOT_KEYS) for (const a of arr(W.ATTACHMENTS[s])) simAtt.push(normAttachment(a, s));
} else simAtt = arr(W.ATTACHMENTS).map((a) => normAttachment(a));
export const ATTACHMENTS = simAtt.length ? simAtt : FB_ATTACHMENTS.map((a) => normAttachment(a));
const attIndex = new Map(ATTACHMENTS.map((a) => [a.id, a]));
export const attachmentById = (id) => attIndex.get(id) || null;
export const attachmentsFor = (slot) => ATTACHMENTS.filter((a) => a.slot === slot);

// Equipment: {lethal:[..], tactical:[..]} or id -> {kind|slot|type}.
function equipList(kind) {
  const E = W.EQUIPMENT;
  let list = [];
  if (E && (Array.isArray(E[kind]) || (E[kind] && typeof E[kind] === 'object'))) list = arr(E[kind]);
  else if (E) list = arr(E).filter((e) => (e.kind || e.slot || e.type) === kind);
  list = list.map((e) => ({ ...e, id: String(e.id ?? e.key), name: String(e.name || e.id || e.key), charges: num(e.charges, 1), desc: String(e.desc || ''), action: String(e.action || e.id || e.key) }));
  return list.length ? list : FB_EQUIP[kind].map((e) => ({ ...e }));
}
export const LETHALS = equipList('lethal');
export const TACTICALS = equipList('tactical');
export const equipById = (id) => LETHALS.find((e) => e.id === id) || TACTICALS.find((e) => e.id === id) || null;

// Streaks
const simStreaks = arr(W.STREAKS).map((s) => ({ ...s, key: String(s.key ?? s.id), name: String(s.name || s.key || s.id), cost: num(s.cost ?? s.kills, 4), desc: String(s.desc || '') }));
export const STREAKS = (simStreaks.length ? simStreaks : FB_STREAKS.map((s) => ({ ...s })))
  .map((s) => ({ ...s, target: s.target === null ? 'none' : s.target || FB_STREAKS.find((f) => f.key === s.key)?.target || 'none' }))
  .sort((a, b) => a.cost - b.cost);
export const streakByKey = (k) => STREAKS.find((s) => s.key === k) || null;

// Perks
const PK = W.PERKS || K.PERKS || G.PERKS;
const perkTier = (t) => {
  const l = PK && (PK[`tier${t}`] || PK[t - 1] || PK[t]);
  const n = arr(l).map((p) => ({ ...p, key: String(p.key ?? p.id), name: String(p.name || p.key), desc: String(p.desc || '') }));
  return n.length ? n : FB_PERKS[`tier${t}`].map((p) => ({ ...p }));
};
export const PERKS = { tier1: perkTier(1), tier2: perkTier(2), tier3: perkTier(3) };
export const perkByKey = (k) => [...PERKS.tier1, ...PERKS.tier2, ...PERKS.tier3].find((p) => p.key === k) || null;

// Classes: the sim's, plus fallbacks for the 5.0 classes it doesn't have yet.
export const CLASSES = (() => {
  const out = {};
  for (const k of CLASS_ORDER) {
    const sim = K.CLASSES?.[k];
    if (sim) out[k] = { ...sim, key: k, pending: false };
    else if (FB_CLASS_EXTRA[k]) out[k] = { ...FB_CLASS_EXTRA[k], key: k, pending: true };
  }
  for (const [k, c] of Object.entries(K.CLASSES || {})) if (!out[k]) out[k] = { ...c, key: k, pending: false };
  return out;
})();
export const classKeys = () => Object.keys(CLASSES);
export function allowedCats(cls) {
  if (Array.isArray(W.CLASS_WEAPONS?.[cls])) return W.CLASS_WEAPONS[cls].map((x) => String(x).toLowerCase());
  const c = K.CLASSES?.[cls] || {};
  const v = c.primaries || c.allowed || c.allowedPrimaries || c.cats || c.weapons;
  if (Array.isArray(v) && v.length) return v.map((x) => String(x).toLowerCase());
  return FB_ALLOWED[cls] || ['ar', 'smg'];
}
export const primariesFor = (cls) => PRIMARIES.filter((w) => allowedCats(cls).includes(w.cat));

// ------------------------------------------------------------------ loadouts

export function defaultLoadout(cls = 'assault') {
  if (typeof L.defaultLoadout === 'function' && K.CLASSES?.[cls]) { try { const d = L.defaultLoadout(cls); if (d?.primary) return d; } catch { /* fall back */ } }
  const p = primariesFor(cls)[0] || PRIMARIES[0];
  return {
    cls, primary: { id: p.id, attachments: {} }, secondary: { id: SECONDARIES[0]?.id || 'pistol' },
    lethal: (cls === 'assault' ? 'frag' : LETHALS[0]?.id) || 'frag',
    tactical: (cls === 'recon' ? 'smoke' : cls === 'medic' ? 'stim' : TACTICALS[0]?.id) || 'smoke',
    perks: [PERKS.tier1[0].key, PERKS.tier2[0].key, PERKS.tier3[0].key],
    streaks: STREAKS.slice(0, 3).map((s) => s.key),
  };
}

/** Clamp anything illegal (unknown ids, wrong category, too many attachments). Never throws. */
export function cleanLoadout(l, unlocked = null) {
  const src = l && typeof l === 'object' ? l : {};
  const cls = CLASSES[src.cls] ? src.cls : 'assault';
  const d = defaultLoadout(cls);
  const out = { ...d, name: typeof src.name === 'string' ? src.name.slice(0, 18) : undefined };
  const pid = src.primary?.id;
  const pw = weaponById(pid);
  if (pw && primariesFor(cls).some((w) => w.id === pid)) {
    const att = {};
    const sa = src.primary?.attachments && typeof src.primary.attachments === 'object' ? src.primary.attachments : {};
    for (const s of SLOT_KEYS) {
      const a = attachmentById(sa[s]);
      if (a && a.slot === s && (!unlocked || unlocked(pid, a.id))) att[s] = a.id;
    }
    out.primary = { id: pid, attachments: att };
  }
  if (SECONDARIES.some((w) => w.id === src.secondary?.id)) out.secondary = { id: src.secondary.id };
  if (LETHALS.some((e) => e.id === src.lethal)) out.lethal = src.lethal;
  if (TACTICALS.some((e) => e.id === src.tactical)) out.tactical = src.tactical;
  if (Array.isArray(src.perks)) out.perks = [1, 2, 3].map((t, i) => (PERKS[`tier${t}`].some((p) => p.key === src.perks[i]) ? src.perks[i] : d.perks[i]));
  if (Array.isArray(src.streaks)) {
    const ks = [...new Set(src.streaks.filter((k) => streakByKey(k)))].slice(0, 3);
    for (const s of STREAKS) { if (ks.length >= 3) break; if (!ks.includes(s.key)) ks.push(s.key); }
    out.streaks = ks.sort((a, b) => streakByKey(a).cost - streakByKey(b).cost);
  }
  if (!out.name) delete out.name;
  return out;
}

/** The sim's validator when it exists, else ours. */
export function validate(l) {
  const clean = cleanLoadout(l);
  const fn = L.validateLoadout || W.validateLoadout || G.validateLoadout;
  if (typeof fn === 'function') { try { const v = fn(clean); if (v && typeof v === 'object') return v; } catch (e) { console.warn('[tidefall] validateLoadout', e); } }
  return clean;
}
export const simHasLoadouts = () => typeof (L.validateLoadout || W.validateLoadout || G.validateLoadout) === 'function';

/** Effective primary stats with attachments applied (for the stat bars). */
export function weaponStats(id, attachments = {}) {
  const w = weaponById(id);
  if (!w) return null;
  if (typeof W.buildWeapon === 'function') {
    try {
      const b = W.buildWeapon(id, attachments || {});
      if (b && b.id === id) return { range: b.range, aim: b.aim, dmg: [...b.dmg], mag: b.special?.includes('infinite') ? Infinity : b.mag, move: b.move || 0, close: b.close || 0, owAim: b.owAim || 0, steady: b.steady || 0, silent: !!b.silent, thermal: !!b.thermal, freeReload: !!b.freeReload, special: b.special || [] };
    } catch { /* fall back */ }
  }
  const s = { range: w.range, aim: w.aim, dmg: [...w.dmg], mag: w.mag, move: w.move || 0 };
  for (const aid of Object.values(attachments || {})) {
    const a = attachmentById(aid);
    if (!a) continue;
    const m = a.mods;
    s.range += m.range || 0; s.aim += m.aim || 0; s.move += m.move || 0;
    if (m.dmg) { s.dmg = [Math.max(1, s.dmg[0] + m.dmg), Math.max(1, s.dmg[1] + m.dmg)]; }
    if (s.mag !== Infinity) s.mag = Math.max(1, s.mag + (m.mag || 0));
  }
  return s;
}

/** Fixed attachment unlock order for a weapon: one per level from 2, cycling through slots. */
export function unlockTrack(weaponId) {
  if (typeof W.weaponUnlocks === 'function') {
    try { const u = W.weaponUnlocks(weaponId); if (Array.isArray(u) && u.length) return [...u].sort((a, b) => a.level - b.level).map((x) => x.attachment); } catch { /* fall back */ }
  }
  const bySlot = SLOT_KEYS.map((s) => attachmentsFor(s));
  // Rotate each weapon's start so different guns don't all unlock the same thing first.
  let h = 0; for (const c of String(weaponId)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const out = [];
  const depth = Math.max(...bySlot.map((l) => l.length));
  for (let d = 0; d < depth; d++) {
    for (let i = 0; i < SLOT_KEYS.length; i++) {
      const l = bySlot[(i + h) % SLOT_KEYS.length];
      const a = l[(d + h) % Math.max(1, l.length)];
      if (a && !out.includes(a.id)) out.push(a.id);
    }
  }
  return out; // index i unlocks at weapon level i + 2
}
export const MAX_WEAPON_LEVEL = W.WEAPON_MAX_LEVEL || 20;
