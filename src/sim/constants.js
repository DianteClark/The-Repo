// All tunable numbers live here so balance changes never touch logic.

export const TOTAL_PLAYERS = 16;
export const TURN_SECONDS = 20;
export const MAP_SIZE = 34;
export const SIGHT = 10;
export const BASE_AP = 2;

export const CLASSES = {
  assault: {
    name: 'Assault',
    desc: 'All-rounder. Solid rifle, good mobility.',
    hp: 10, armor: 0, move: 6,
    weapon: { name: 'Rifle', range: 9, aim: 70, dmg: [3, 5] },
  },
  marksman: {
    name: 'Marksman',
    desc: 'Long range, hits hard. Weak up close.',
    hp: 8, armor: 0, move: 5,
    weapon: { name: 'Long Rifle', range: 13, aim: 78, dmg: [4, 6], closePenalty: true },
  },
  breacher: {
    name: 'Breacher',
    desc: 'Tough. Shotgun is brutal at close range.',
    hp: 13, armor: 1, move: 5,
    weapon: { name: 'Shotgun', range: 5, aim: 82, dmg: [5, 7], falloff: true },
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
export const FLANK_BONUS = 10;
export const GRAZE_BAND = 15; // misses within this many % of the roll do half damage
export const MISS_STREAK_BONUS = 10; // +% per consecutive miss, visible to the player
export const MISS_STREAK_CAP = 3;
export const REACTION_PENALTY = 15; // overwatch shots
export const MEDKIT_HEAL = 5;

export const ZONE = {
  shrinkEvery: 2, // rounds
  step: 4, // tiles of radius per shrink
  minRadius: 0, // the tide eventually covers everything, so matches always end
  damage: 2, // + 1 per 5 rounds
};

export const CRATE_COUNT = 24;
// Crates hold supplies and weapon upgrades — no weapons.
export const CRATE_TABLE = [
  ['medkit', 35],
  ['armor', 20],
  ['scope', 25],
  ['barrel', 20],
];
export const CRATE_LABEL = {
  medkit: '+1 Medkit',
  armor: '+1 Armor plate',
  scope: 'Scope: +2 range, +5 aim',
  barrel: 'Heavy barrel: +1 damage',
};
export const MOD_CAP = 2; // max stacks of scope / barrel / crate armor

export const CALLSIGNS = [
  'Rook', 'Vex', 'Salt', 'Kestrel', 'Brine', 'Hollow', 'Mako', 'Rust', 'Tern', 'Ash',
  'Wick', 'Gale', 'Flint', 'Echo', 'Reef', 'Cinder', 'Pike', 'Moth', 'Drift', 'Quill',
];
