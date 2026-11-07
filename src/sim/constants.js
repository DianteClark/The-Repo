// All tunable numbers live here so balance changes never touch logic.

export const TOTAL_PLAYERS = 16;
export const TURN_SECONDS = 20;
export const MAP_SIZE = 44;
export const SIGHT = 10; // daytime sight; stages can lower it (map.sight)
export const NIGHT_SIGHT = 6;
export const BASE_AP = 2;

export const CLASSES = {
  assault: {
    name: 'Assault',
    desc: 'All-rounder. Solid rifle, good mobility.',
    hp: 10, armor: 0, move: 6,
    weapon: { name: 'Rifle', range: 9, aim: 65, dmg: [3, 5] },
  },
  marksman: {
    name: 'Marksman',
    desc: 'Long range, hits hard. Weak up close.',
    hp: 8, armor: 0, move: 5,
    weapon: { name: 'Long Rifle', range: 13, aim: 72, dmg: [4, 6], closePenalty: true },
  },
  breacher: {
    name: 'Breacher',
    desc: 'Tough. Shotgun is brutal at close range.',
    hp: 12, armor: 0, move: 5,
    weapon: { name: 'Shotgun', range: 5, aim: 74, dmg: [5, 7], falloff: true },
  },
  medic: {
    name: 'Medic',
    desc: 'Keeps the squad standing. Patch heals or revives.',
    hp: 9, armor: 0, move: 6,
    weapon: { name: 'SMG', range: 7, aim: 66, dmg: [2, 4] },
  },
  recon: {
    name: 'Recon',
    desc: 'Fast scout. Scan reveals enemies through walls; carries smoke.',
    hp: 9, armor: 0, move: 7,
    weapon: { name: 'Carbine', range: 10, aim: 70, dmg: [3, 5] },
  },
};

export const MODES = {
  solos: { name: 'Solos', teamSize: 1 },
  duos: { name: 'Duos', teamSize: 2 },
  trios: { name: 'Trios', teamSize: 3, loneWolf: true }, // 5 trios + 1 lone wolf
  quads: { name: 'Quads', teamSize: 4 },
};

// The leftover player in Trios.
export const LONE_WOLF = { ap: 1, hpMult: 1.5, armor: 1 };

export const COVER_PENALTY = [0, 20, 40]; // none / half / full
export const HUNKER_MULT = 2; // hunkered: cover penalties doubled (40 / 80), no grazes
// Flanked = the target is in cover, just not from this angle. Standing in the
// open is simply "exposed": no cover penalty, but no flank bonus either.
export const FLANK_BONUS = 10;
export const FLANK_DMG = 1; // flanking shots also hit a little harder
export const GRAZE_BAND = 10; // misses within this many % of the roll do half damage
export const MISS_STREAK_BONUS = 10; // +% per consecutive miss, visible to the player
export const MISS_STREAK_CAP = 3;
export const REACTION_PENALTY = 15; // overwatch shots
export const MEDKIT_HEAL = 5;

export const ZONE = {
  shrinkEvery: 2, // rounds
  step: 6, // tiles of radius per shrink (44×44 maps)
  minRadius: 0, // the tide eventually covers everything, so matches always end
  finalRadius: 4, // the last ring holds for one interval: a real final-circle fight
  damage: 2, // + 1 per 5 rounds
};

export const CRATE_COUNT = 40; // ~24 per 34×34, scaled to the 44×44 area
// Crates hold supplies and weapon upgrades — no weapons.
export const CRATE_TABLE = [
  ['medkit', 30],
  ['armor', 18],
  ['scope', 22],
  ['barrel', 17],
  ['frag', 12],
  ['smoke', 10],
];
export const CRATE_LABEL = {
  medkit: '+1 Medkit',
  armor: '+1 Armor plate',
  scope: 'Scope: +2 range, +5 aim',
  barrel: 'Heavy barrel: +1 damage',
  frag: '+1 Frag grenade',
  smoke: '+1 Smoke grenade',
  cache: 'Supply cache: +1 scope, +1 barrel, +1 frag',
};
export const MOD_CAP = 2; // max stacks of scope / barrel / crate armor
export const FRAG_CAP = 3; // max grenades carried
export const SMOKE_CAP = 2;

// Supply caches land inside the next safe zone at the start of these rounds.
export const SUPPLY_DROP_ROUNDS = [4, 8, 12];

// ---------- abilities ----------
export const START_FRAGS = { assault: 2, marksman: 0, breacher: 0, medic: 0, recon: 0 };
export const START_SMOKES = { recon: 1 };
export const FRAG = { range: 7, radius: 1.5, dmg: 3 };
export const AIMED = { aim: 15, dmg: 2, cooldown: 3 }; // Marksman
export const BREACH = { dmg: 4, radius: 1, cooldown: 3 }; // Breacher; radius is Chebyshev
// Smoke hides anyone inside from enemies more than `reveal` tiles away, and
// costs 20 aim for shots out of it or into it. Lasts until the thrower's next turn.
// (`defense` mirrors the into-smoke penalty for older UI text.)
export const SMOKE = { range: 7, radius: 1.5, reveal: 1.5, aimOut: 20, aimIn: 20, defense: 20 };
export const PATCH = { heal: 5, reviveHp: 4, cooldown: 2 }; // Medic
export const SCAN = { range: 12, radius: 5, cooldown: 3 }; // Recon
export const REVIVE_HP = 3;
export const BLEED_TURNS = 2; // own team turns a downed unit lasts

export const ABILITY_TEXT = {
  grenade: { name: 'Frag Grenade', desc: `Throw up to ${FRAG.range} tiles. ${FRAG.dmg} damage in a 3×3 blast, hits allies too, shreds cover. 1 AP.` },
  aimed: { name: 'Aimed Shot', desc: `+${AIMED.aim} aim, +${AIMED.dmg} damage. Ends turn. Cooldown ${AIMED.cooldown}.` },
  breach: { name: 'Breach Charge', desc: `Blow open adjacent cover; ${BREACH.dmg} damage to enemies next to it. 1 AP. Cooldown ${BREACH.cooldown}.` },
  patch: { name: 'Patch', desc: `Heal yourself or an adjacent ally for ${PATCH.heal}, or revive a downed ally at ${PATCH.reviveHp} HP. 1 AP. Cooldown ${PATCH.cooldown}.` },
  scan: { name: 'Scan', desc: `Reveal every unit within ${SCAN.radius} tiles of a point up to ${SCAN.range} tiles away, through walls, until your next turn. 1 AP. Cooldown ${SCAN.cooldown}.` },
  smoke: { name: 'Smoke Grenade', desc: `Up to ${SMOKE.range} tiles. A 3×3 cloud hides anyone inside from enemies more than a tile away; shots into or out of it take -${SMOKE.aimIn} aim. Lasts until your next turn. 1 AP.` },
  revive: { name: 'Revive', desc: `Get an adjacent downed squadmate back up at ${REVIVE_HP} HP. 1 AP.` },
  hunker: { name: 'Hunker Down', desc: 'Double your cover bonus and no grazes until your next turn. Ends turn.' },
};

// ---------- stages (3.0) ----------
export const KELP = { reveal: 3, aim: 10 }; // seen only from within 3 tiles; -10 aim to shots at you
export const BARREL = { radius: 1.5, dmg: 4 };
export const TERRAIN = { ground: 0, kelp: 1, water: 2 }; // shallow water costs 2 movement

/**
 * Stage catalog. `gen` drives map generation; the rest is gameplay.
 * zone.drift: the safe circle walks toward a point near one side at every shrink.
 */
export const STAGES = {
  harbor: {
    key: 'harbor', name: 'Drowned Harbor', size: 44,
    tagline: 'Docks, containers and the tide from every edge.',
    twist: 'Classic tide. Dense hard cover: containers and warehouses.',
    sight: SIGHT,
    gen: { buildings: 0.95, containers: 11, walls: 0.8, low: 0.08, water: 0.05, kelp: 0, barrels: 0, clusters: 0 },
  },
  kelp: {
    key: 'kelp', name: 'Kelp Shallows', size: 44,
    tagline: 'Low cover, tall kelp, nowhere to hide but the weeds.',
    twist: `Kelp beds: units in kelp can't be seen from more than ${KELP.reveal} tiles away and take -${KELP.aim} aim against them.`,
    sight: SIGHT,
    gen: { buildings: 0.45, containers: 3, walls: 0.5, low: 0.06, water: 0.12, kelp: 0.15, barrels: 0, clusters: 0 },
  },
  rig: {
    key: 'rig', name: 'Rig Graveyard', size: 44,
    tagline: 'Rusting platforms stacked with fuel drums.',
    twist: `Explosive barrels: frags, breaches and gunfire set them off for ${BARREL.dmg} damage, and they chain.`,
    sight: SIGHT,
    gen: { buildings: 0.8, containers: 6, walls: 0.7, low: 0.07, water: 0.14, kelp: 0, barrels: 0.3, clusters: 0 },
  },
  spire: {
    key: 'spire', name: 'Night Spires', size: 44,
    tagline: 'Towers in the dark. Every muzzle flash is a beacon.',
    twist: `Night: sight drops to ${NIGHT_SIGHT}. Firing lights you up for every squad until your next turn.`,
    sight: NIGHT_SIGHT,
    night: true,
    gen: { buildings: 0.6, containers: 2, walls: 0.6, low: 0.07, water: 0.04, kelp: 0, barrels: 0, clusters: 7 },
  },
  surge: {
    key: 'surge', name: 'Surge Point', size: 44,
    tagline: 'The storm walks across the map. Keep moving.',
    twist: 'Drifting zone: the safe circle slides toward one side at every shrink.',
    sight: SIGHT,
    drift: true,
    gen: { buildings: 0.8, containers: 6, walls: 0.8, low: 0.08, water: 0.07, kelp: 0, barrels: 0, clusters: 0 },
  },
};
export const STAGE_KEYS = Object.keys(STAGES);

export const CALLSIGNS = [
  'Rook', 'Vex', 'Salt', 'Kestrel', 'Brine', 'Hollow', 'Mako', 'Rust', 'Tern', 'Ash',
  'Wick', 'Gale', 'Flint', 'Echo', 'Reef', 'Cinder', 'Pike', 'Moth', 'Drift', 'Quill',
];
