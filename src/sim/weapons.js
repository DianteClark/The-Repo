// Tidefall 5.0 gameplay data: weapons, attachments, legendaries, equipment, perks,
// killstreaks and the progression tables (weapon levels / camos) the UI builds on.
// Pure data + tiny pure helpers. No state, no rng.
//
// Weapon def: { id, name, cat, range, aim, dmg:[min,max], mag, reserve, desc,
//   special?: string[], move?, owAim?, close? }
// Specials understood by the rules (src/sim/rules.js + combat.js):
//   falloff      shotgun: -7 aim per tile beyond 2 (slug: half)
//   slug         halves shotgun falloff
//   closePenalty -15 aim under 4 tiles (scoped rifles)
//   pellets      wider graze band (+10): pellets rarely miss completely
//   burst        two rolls per shot (each its own hit/graze/miss)
//   pierce       ignores 1 point of armour
//   hipfire      +10 aim within 3 tiles
//   railPierce   (legendary) the target's cover counts one level lower
//   shred        (legendary) hits knock the cover protecting the target down a level
//   slow         (legendary) hits cost the target 2 movement on its next turn
//   flareHit     (legendary) hits light the target up for every squad (night flare rules)
//   killMove     (legendary) a kill gives 1 AP back, usable only to move
//   tracer       (legendary) hits reveal the target to your squad (as Tracker)
//   explosive    launcher: fires at a tile, blast radius 1.5, damages cover, never misses
//   infinite     never needs reloading (pistol)

export const CATEGORIES = {
  AR: { key: 'AR', name: 'Assault Rifle', desc: 'Reliable mid-range all-rounder.' },
  SMG: { key: 'SMG', name: 'SMG', desc: 'Short range, accurate up close, big magazine.' },
  LMG: { key: 'LMG', name: 'LMG', desc: 'Huge magazine, long reach, heavy (-1 move).' },
  Shotgun: { key: 'Shotgun', name: 'Shotgun', desc: 'Devastating within a few tiles, falls off fast.' },
  DMR: { key: 'DMR', name: 'DMR', desc: 'Precise semi-auto with long reach.' },
  Sniper: { key: 'Sniper', name: 'Sniper Rifle', desc: 'Hits hardest at long range, clumsy up close.' },
  Carbine: { key: 'Carbine', name: 'Carbine', desc: 'Light, accurate, long-legged.' },
};

const W = (id, name, cat, range, aim, dmg, mag, extra = {}) => ({
  id, name, cat, range, aim, dmg, mag, reserve: extra.reserve ?? mag * 3, ...extra,
});

/** Primaries. All sidegrades: each trades reach, accuracy, damage, magazine or mobility. */
export const WEAPONS = {
  // Assault rifles: range ~9, aim ~65, 3–5
  tr7: W('tr7', 'TR-7', 'AR', 9, 65, [3, 5], 6, { desc: 'The baseline rifle. Does everything adequately.' }),
  kestrel: W('kestrel', 'Kestrel', 'AR', 8, 60, [2, 3], 8, { special: ['burst'], desc: 'Two-round burst: two rolls per shot, lighter hits.' }),
  bulwark: W('bulwark', 'Bulwark', 'AR', 10, 60, [4, 5], 5, { desc: 'Heavy calibre. Hits harder, less accurate, small mag.' }),
  // SMGs: range ~7, aim ~66, 2–4
  vex9: W('vex9', 'Vex-9', 'SMG', 7, 68, [2, 4], 9, { desc: 'Steady compact SMG.' }),
  hornet: W('hornet', 'Hornet', 'SMG', 6, 68, [2, 4], 10, { special: ['hipfire'], desc: '+10 aim within 3 tiles; short reach.' }),
  ruck: W('ruck', 'Ruck .45', 'SMG', 8, 64, [3, 4], 7, { desc: 'Slow, heavy rounds. Longer reach, less accurate.' }),
  // LMGs: range ~10, aim ~58, -1 move
  anvil: W('anvil', 'Anvil', 'LMG', 10, 62, [3, 5], 12, { move: -1, desc: 'Belt-fed workhorse.' }),
  gale: W('gale', 'Gale', 'LMG', 9, 66, [3, 4], 14, { move: -1, desc: 'Lighter rounds, steadier, enormous drum.' }),
  hammer: W('hammer', 'Hammer', 'LMG', 11, 58, [4, 5], 10, { move: -1, special: ['pierce'], desc: 'Ignores 1 armour. Wild aim.' }),
  // Shotguns: range ~5, aim ~74, 5–7, falloff
  breaker: W('breaker', 'Breaker', 'Shotgun', 5, 74, [5, 7], 4, { special: ['falloff'], desc: 'Pump action. Brutal up close.' }),
  slug: W('slug', 'Slugger', 'Shotgun', 7, 66, [4, 6], 3, { special: ['falloff', 'slug'], desc: 'Slugs: half the falloff, more reach, less punch.' }),
  auto12: W('auto12', 'Auto-12', 'Shotgun', 4, 76, [4, 6], 6, { special: ['falloff', 'pellets'], desc: 'Semi-auto spray. Grazes far more often.' }),
  // DMRs: range ~11, aim ~70
  lancer: W('lancer', 'Lancer', 'DMR', 11, 70, [3, 5], 5, { desc: 'Balanced marksman rifle.' }),
  tern: W('tern', 'Tern', 'DMR', 10, 74, [3, 4], 6, { desc: 'Very accurate, light hits.' }),
  warden: W('warden', 'Warden', 'DMR', 12, 66, [4, 5], 4, { special: ['closePenalty'], desc: 'Heavy DMR: reach and punch, clumsy close.' }),
  // Snipers: range ~13, closePenalty
  longbow: W('longbow', 'Longbow', 'Sniper', 13, 72, [4, 6], 3, { special: ['closePenalty'], desc: 'Bolt-action classic.' }),
  harpoon: W('harpoon', 'Harpoon', 'Sniper', 14, 64, [5, 7], 2, { special: ['closePenalty', 'pierce'], desc: 'Anti-materiel. Pierces armour, two-round mag.' }),
  needle: W('needle', 'Needle', 'Sniper', 12, 76, [3, 5], 4, { special: ['closePenalty'], desc: 'Light, accurate sniper. Less punch.' }),
  // Carbines: range ~10, aim ~70
  reed: W('reed', 'Reed', 'Carbine', 10, 70, [3, 5], 6, { desc: 'The scout\'s carbine.' }),
  marlin: W('marlin', 'Marlin', 'Carbine', 9, 70, [2, 4], 7, { move: 1, desc: 'Featherweight: +1 move, lighter hits.' }),
  gaff: W('gaff', 'Gaff', 'Carbine', 11, 66, [3, 5], 5, { desc: 'Longer barrel: reach for accuracy.' }),
};

export const SECONDARIES = {
  pistol: W('pistol', 'Sidearm', 'Pistol', 6, 62, [2, 3], 8, { reserve: 0, special: ['infinite'], desc: 'Never needs reloading. Low damage.' }),
  mpistol: W('mpistol', 'Machine Pistol', 'Pistol', 5, 60, [1, 3], 6, { reserve: 12, special: ['burst'], desc: 'Two-round burst, short reach.' }),
  launcher: W('launcher', 'Launcher', 'Launcher', 8, 100, [4, 4], 2, { reserve: 0, special: ['explosive'], radius: 1.5, desc: 'Two rockets. Blast radius 1.5, damages cover, never misses the tile.' }),
};

// Attachment stats: aim, range, dmg (+ both ends), mag, move, owAim (reaction shots),
// close (aim within 4 tiles), flags: silent, thermal, freeReload, steady.
export const ATTACHMENT_SLOTS = ['optic', 'barrel', 'magazine', 'underbarrel', 'stock'];
const A = (id, slot, name, mods, pro, con) => ({ id, slot, name, mods, pro, con });
export const ATTACHMENTS = {
  // optic
  reflex: A('reflex', 'optic', 'Reflex Sight', { close: 10, range: -1 }, '+10 aim within 4 tiles', '-1 range'),
  scope4x: A('scope4x', 'optic', 'Tide 4× Scope', { aim: 6, close: -10 }, '+6 aim', '-10 aim within 4 tiles'),
  thermal: A('thermal', 'optic', 'Thermal Optic', { thermal: true, aim: -4 }, 'Ignore smoke and kelp aim penalties', '-4 aim'),
  // barrel
  suppressor: A('suppressor', 'barrel', 'Suppressor', { silent: true, range: -1 }, 'No gunfire pings or night flares', '-1 range'),
  longbarrel: A('longbarrel', 'barrel', 'Long Barrel', { range: 2, close: -8 }, '+2 range', '-8 aim within 4 tiles'),
  heavybarrel: A('heavybarrel', 'barrel', 'Heavy Barrel', { dmg: 1, aim: -6 }, '+1 damage', '-6 aim'),
  // magazine
  extmag: A('extmag', 'magazine', 'Extended Mag', { mag: 3, aim: -3 }, '+3 magazine', '-3 aim'),
  fastmag: A('fastmag', 'magazine', 'Fast Mag', { freeReload: true, mag: -1 }, 'Reloading costs no AP', '-1 magazine'),
  hollow: A('hollow', 'magazine', 'Hollow Points', { dmg: 1, mag: -2 }, '+1 damage', '-2 magazine'),
  // underbarrel
  grip: A('grip', 'underbarrel', 'Vertical Grip', { owAim: 10, range: -1 }, '+10 overwatch aim', '-1 range'),
  bipod: A('bipod', 'underbarrel', 'Bipod', { steady: 8, move: -1 }, '+8 aim if you haven\'t moved this turn', '-1 move'),
  laser: A('laser', 'underbarrel', 'Laser Sight', { close: 8, owAim: -5 }, '+8 aim within 4 tiles', '-5 overwatch aim'),
  // stock
  lightstock: A('lightstock', 'stock', 'Skeleton Stock', { move: 1, aim: -5 }, '+1 move', '-5 aim'),
  heavystock: A('heavystock', 'stock', 'Padded Stock', { aim: 4, move: -1 }, '+4 aim', '-1 move'),
  foldstock: A('foldstock', 'stock', 'Folding Stock', { close: 6, range: -1 }, '+6 aim within 4 tiles', '-1 range'),
};

/** Gold weapons from gold crates and care packages. Each has one unique trait. */
export const LEGENDARIES = {
  tidebreaker: W('tidebreaker', 'Tidebreaker', 'Sniper', 14, 74, [5, 7], 3, { legendary: true, special: ['closePenalty', 'railPierce'], trait: 'Rail rounds: target cover counts one level lower.' }),
  maw: W('maw', 'Maw', 'Shotgun', 5, 76, [5, 7], 5, { legendary: true, special: ['falloff', 'shred'], trait: 'Shreds cover: every hit knocks the target\'s cover down a level.' }),
  undertow: W('undertow', 'Undertow', 'LMG', 10, 62, [3, 5], 14, { legendary: true, move: -1, special: ['slow'], trait: 'Every hit slows the target: -2 move next turn.' }),
  lantern: W('lantern', 'Lantern', 'DMR', 12, 72, [4, 5], 5, { legendary: true, special: ['flareHit'], trait: 'A hit flares the target: visible to every squad until its next turn.' }),
  riptide: W('riptide', 'Riptide', 'SMG', 7, 70, [3, 4], 10, { legendary: true, special: ['killMove'], trait: 'A kill gives back 1 AP to move with.' }),
  leviathan: W('leviathan', 'Leviathan', 'Launcher', 9, 100, [4, 4], 4, { legendary: true, reserve: 0, special: ['explosive'], radius: 1.5, slot: 'secondary', trait: 'Four rockets.' }),
  siren: W('siren', 'Siren', 'Carbine', 10, 72, [3, 5], 7, { legendary: true, special: ['tracer'], trait: 'Tracer rounds: hits reveal the target to your squad.' }),
};
export const LEGENDARY_KEYS = Object.keys(LEGENDARIES);

/** Lethal and tactical equipment. `action` is the act() type that uses it. */
export const EQUIPMENT = {
  frag: { key: 'frag', slot: 'lethal', action: 'grenade', name: 'Frag Grenade', charges: 1, range: 7, radius: 1.5, dmg: 3, desc: '3 damage in radius 1.5, shreds cover, hits allies too. 1 AP.' },
  semtex: { key: 'semtex', slot: 'lethal', action: 'semtex', name: 'Semtex', charges: 1, range: 7, radius: 1.5, dmg: 3, stick: 2, desc: 'Sticks: a unit on the target tile takes +2. Never misses its tile. 1 AP.' },
  claymore: { key: 'claymore', slot: 'lethal', action: 'claymore', name: 'Claymore', charges: 1, range: 1.5, trigger: 1.5, dmg: 5, desc: 'Place on an adjacent tile. The first enemy to move within 1.5 takes 5. 1 AP.' },
  knife: { key: 'knife', slot: 'lethal', action: 'knife', name: 'Throwing Knife', charges: 2, range: 4, dmg: 4, aim: 75, desc: 'Range 4, 4 damage, silent. Cover applies. 1 AP, doesn\'t end the turn.' },
  smoke: { key: 'smoke', slot: 'tactical', action: 'smoke', name: 'Smoke Grenade', charges: 1, range: 7, radius: 1.5, desc: 'Hides anyone inside from enemies more than a tile away; -20 aim into or out of it. 1 AP.' },
  flashbang: { key: 'flashbang', slot: 'tactical', action: 'flashbang', name: 'Flashbang', charges: 1, range: 7, radius: 1.5, apLoss: 1, aim: 30, desc: 'Radius 1.5: enemies lose 1 AP next turn and take -30 aim until it ends. 1 AP.' },
  stim: { key: 'stim', slot: 'tactical', action: 'stim', name: 'Stim', charges: 1, heal: 2, ap: 1, desc: 'Instant: +1 AP this turn and heal 2. Free.' },
  decoy: { key: 'decoy', slot: 'tactical', action: 'decoy', name: 'Decoy', charges: 1, range: 7, desc: 'A fake gunfire ping. Draws bot overwatch and attention for a round. 1 AP.' },
};
export const LETHALS = Object.keys(EQUIPMENT).filter((k) => EQUIPMENT[k].slot === 'lethal');
export const TACTICALS = Object.keys(EQUIPMENT).filter((k) => EQUIPMENT[k].slot === 'tactical');

const P = (key, name, desc) => ({ key, name, desc });
export const PERKS = {
  tier1: [
    P('scavenger', 'Scavenger', 'A kill refills your magazine and gives +1 lethal.'),
    P('amphibious', 'Amphibious', 'Shallow water costs normal movement; tide damage -1.'),
    P('lightweight', 'Lightweight', '+1 move.'),
    P('flak', 'Flak Jacket', 'Explosive damage halved.'),
  ],
  tier2: [
    P('ghost', 'Ghost', 'Immune to Scan and UAV.'),
    P('hardline', 'Hardline', 'Killstreaks cost 1 fewer streak point.'),
    P('steady', 'Steady Aim', '+10 aim if you haven\'t moved this turn.'),
    P('trapper', 'Trapper', 'Start with a Claymore.'),
  ],
  tier3: [
    P('deadsilence', 'Dead Silence', 'No gunfire pings; your first move each turn doesn\'t trigger overwatch.'),
    P('quickfix', 'Quick Fix', 'Heal 3 on a kill or revive; you revive at +2 HP.'),
    P('tracker', 'Tracker', 'Enemies you damage are revealed to your squad until your next turn.'),
    P('mask', 'Tactical Mask', 'Immune to flashbangs and the smoke aim penalty.'),
  ],
};
export const PERK_KEYS = [...PERKS.tier1, ...PERKS.tier2, ...PERKS.tier3].map((p) => p.key);

/** Killstreaks. target: null (instant), 'tile', or 'line' (x,y → x2,y2). */
export const STREAKS = {
  uav: { key: 'uav', name: 'UAV', cost: 2, target: null, radius: 14, desc: 'Reveal every enemy within 14 tiles to your squad until your next turn.' },
  care: { key: 'care', name: 'Care Package', cost: 3, target: 'tile', range: 6, legendaryChance: 0.4, desc: 'A crate drops on a tile within 6 next step. 40% legendary.' },
  cuav: { key: 'cuav', name: 'Counter-UAV', cost: 3, target: null, rounds: 2, desc: 'Enemy scans and UAVs can\'t see your squad for 2 rounds.' },
  airstrike: { key: 'airstrike', name: 'Airstrike', cost: 4, target: 'line', length: 7, range: 14, dmg: 5, desc: 'Mark a 7-tile line. Next round it hits for 5, ignores and destroys cover.' },
  sentry: { key: 'sentry', name: 'Sentry Turret', cost: 4, target: 'tile', range: 1.5, hp: 8, rounds: 3, reach: 8, aim: 60, dmg: [3, 4], shots: 2, desc: 'An 8 HP turret on an adjacent tile. Overwatches a 90° cone for 3 rounds.' },
  gunship: { key: 'gunship', name: 'Gunship', cost: 6, target: null, rounds: 2, aim: 60, dmg: 4, targets: 2, desc: 'For 2 rounds, fires on up to 2 visible enemies at the end of each of your turns.' },
};
export const STREAK_KEYS = Object.keys(STREAKS);

// ---------- classes (5.0 additions live in constants.CLASSES) ----------
export const CLASS_WEAPONS = {
  assault: ['AR', 'SMG'],
  marksman: ['DMR', 'Sniper'],
  breacher: ['Shotgun', 'SMG'],
  medic: ['SMG', 'Carbine'],
  recon: ['Carbine', 'DMR'],
  engineer: ['SMG', 'Shotgun', 'Carbine'],
  gunner: ['LMG'],
};
export const DEFAULT_PRIMARY = {
  assault: 'tr7', marksman: 'longbow', breacher: 'breaker', medic: 'vex9', recon: 'reed', engineer: 'vex9', gunner: 'anvil',
};
export const DEFAULT_KIT = {
  assault: { lethal: 'frag', tactical: 'stim' },
  marksman: { lethal: 'claymore', tactical: 'smoke' },
  breacher: { lethal: 'frag', tactical: 'flashbang' },
  medic: { lethal: 'knife', tactical: 'smoke' },
  recon: { lethal: 'knife', tactical: 'smoke' },
  engineer: { lethal: 'claymore', tactical: 'flashbang' },
  gunner: { lethal: 'frag', tactical: 'stim' },
};

/** Weapons a class may carry as primary. */
export const weaponsForClass = (cls) => Object.values(WEAPONS).filter((w) => (CLASS_WEAPONS[cls] || []).includes(w.cat)).map((w) => w.id);

/** Any weapon def by id (primary, secondary or legendary). */
export const weaponDef = (id) => WEAPONS[id] || SECONDARIES[id] || LEGENDARIES[id] || null;

/**
 * Full weapon stats with attachments applied. Returns a fresh object:
 * { id, name, cat, range, aim, dmg, mag, reserve, special:[], attachments:{slot:id},
 *   move, owAim, close, steady, silent, thermal, freeReload, legendary? }
 */
export function buildWeapon(id, attachments = {}) {
  const d = weaponDef(id) || WEAPONS.tr7;
  const w = {
    id: d.id, name: d.name, cat: d.cat, range: d.range, aim: d.aim, dmg: [...d.dmg], mag: d.mag, reserve: d.reserve,
    special: [...(d.special || [])], attachments: {}, move: d.move || 0, owAim: 0, close: 0, steady: 0,
    silent: false, thermal: false, freeReload: false,
  };
  if (d.legendary) { w.legendary = true; w.trait = d.trait; }
  if (d.radius) w.radius = d.radius;
  const canMod = w.cat !== 'Launcher' && w.cat !== 'Pistol';
  for (const slot of ATTACHMENT_SLOTS) {
    const a = ATTACHMENTS[attachments?.[slot]];
    if (!canMod || !a || a.slot !== slot) continue;
    w.attachments[slot] = a.id;
    const m = a.mods;
    w.aim += m.aim || 0;
    w.range = Math.max(2, w.range + (m.range || 0));
    if (m.dmg) w.dmg = [w.dmg[0] + m.dmg, w.dmg[1] + m.dmg];
    if (m.mag) w.mag = Math.max(1, w.mag + m.mag);
    w.move += m.move || 0;
    w.owAim += m.owAim || 0;
    w.close += m.close || 0;
    w.steady += m.steady || 0;
    if (m.silent) w.silent = true;
    if (m.thermal) w.thermal = true;
    if (m.freeReload) w.freeReload = true;
  }
  // Legacy flags read by older code paths / UI.
  if (w.special.includes('falloff')) w.falloff = true;
  if (w.special.includes('closePenalty')) w.closePenalty = true;
  w.reserve = d.reserve === 0 ? 0 : Math.max(w.mag * 2, d.reserve);
  return w;
}

export const hasSpecial = (w, s) => !!w && ((w.special && w.special.includes(s)) || w[s] === true);

// ---------- progression data (UI owns meta; these are the gameplay tables) ----------
export const WEAPON_MAX_LEVEL = 20;
/** XP needed to go from level L to L+1 (L = 1..19). Weapon XP: 100 per kill, 25 per hit, 10 per shot fired. */
export const weaponXpForLevel = (L) => 400 + (L - 1) * 150;
export const WEAPON_XP = { kill: 100, hit: 25, shot: 10, win: 150 };

/**
 * Fixed attachment unlock order for a weapon: one per level from 2 upward,
 * rotating through the slots so every level is a sidegrade. [{level, attachment}]
 */
export function weaponUnlocks(id) {
  const d = weaponDef(id);
  if (!d || d.legendary || d.cat === 'Pistol' || d.cat === 'Launcher') return [];
  // Deterministic per-weapon rotation so weapons don't all unlock the same thing first.
  const seed = [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const bySlot = ATTACHMENT_SLOTS.map((s) => Object.values(ATTACHMENTS).filter((a) => a.slot === s).map((a) => a.id));
  const out = [];
  let level = 2;
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < ATTACHMENT_SLOTS.length; i++) {
      const slot = (i + seed) % ATTACHMENT_SLOTS.length;
      const list = bySlot[slot];
      out.push({ level, attachment: list[(round + seed) % list.length] });
      level++;
    }
  }
  return out; // 15 attachments, levels 2..16; 17–20 are camo/charm levels for UI
}

/**
 * Camo challenges, per weapon, in unlock order. `stat` names what to count, using the
 * sim's event stream (all from the weapon owner's point of view):
 *   kills     death events where `by` is you and `weapon` is this weapon
 *   headshots kills by a shot event with headshot:true (a full hit that rolled max damage)
 *   flanks    kills by a shot event with flank:true
 *   longshots kills by a shot event with dist >= 0.75 × weapon range
 *   closes    kills by a shot event with dist <= 3
 *   multis    two kills in one of your turns with this weapon
 *   wins      matches won with this weapon equipped
 * Completing all standard camos unlocks Gold; Gold on 5 weapons → Diamond; all Diamond → Tidal.
 */
export const CAMO_CHALLENGES = [
  { id: 'kelpweave', name: 'Kelpweave', stat: 'kills', count: 10, desc: '10 kills' },
  { id: 'driftwood', name: 'Driftwood', stat: 'kills', count: 25, desc: '25 kills' },
  { id: 'saltcrust', name: 'Saltcrust', stat: 'headshots', count: 10, desc: '10 headshots (max-damage kill shots)' },
  { id: 'reefstripe', name: 'Reef Stripe', stat: 'flanks', count: 5, desc: '5 flanking kills' },
  { id: 'stormglass', name: 'Stormglass', stat: 'longshots', count: 5, desc: '5 longshot kills (≥75% of range)' },
  { id: 'rustbloom', name: 'Rustbloom', stat: 'closes', count: 5, desc: '5 kills within 3 tiles' },
  { id: 'nightoil', name: 'Night Oil', stat: 'multis', count: 3, desc: '3 multi-kill turns' },
  { id: 'harborgray', name: 'Harbor Gray', stat: 'kills', count: 50, desc: '50 kills' },
  { id: 'tidemark', name: 'Tidemark', stat: 'wins', count: 3, desc: 'Win 3 matches' },
];
export const MASTERY_CAMOS = [
  { id: 'gold', name: 'Gold', req: 'All standard camos on this weapon' },
  { id: 'diamond', name: 'Diamond', req: 'Gold on 5 weapons' },
  { id: 'tidal', name: 'Tidal', req: 'Diamond on every weapon category', animated: true },
];
