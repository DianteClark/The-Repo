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
    weapon: { name: 'Rifle', range: 9, aim: 62, dmg: [3, 5] },
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
    hp: 13, armor: 1, move: 5,
    weapon: { name: 'Shotgun', range: 5, aim: 78, dmg: [5, 7], falloff: true },
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
  step: 4, // tiles of radius per shrink
  minRadius: 0, // the tide eventually covers everything, so matches always end
  damage: 2, // + 1 per 5 rounds
};

export const CRATE_COUNT = 24;
// Crates hold supplies and weapon upgrades — no weapons.
export const CRATE_TABLE = [
  ['medkit', 30],
  ['armor', 18],
  ['scope', 22],
  ['barrel', 17],
  ['frag', 13],
];
export const CRATE_LABEL = {
  medkit: '+1 Medkit',
  armor: '+1 Armor plate',
  scope: 'Scope: +2 range, +5 aim',
  barrel: 'Heavy barrel: +1 damage',
  frag: '+1 Frag grenade',
  cache: 'Supply cache: +1 scope, +1 barrel, +1 frag',
};
export const MOD_CAP = 2; // max stacks of scope / barrel / crate armor
export const FRAG_CAP = 3; // max grenades carried

// Supply caches land inside the next safe zone at the start of these rounds.
export const SUPPLY_DROP_ROUNDS = [4, 8, 12];

// ---------- abilities ----------
export const START_FRAGS = { assault: 2, marksman: 0, breacher: 0 };
export const FRAG = { range: 7, radius: 1.5, dmg: 3 };
export const AIMED = { aim: 15, dmg: 2, cooldown: 3 }; // Marksman
export const BREACH = { dmg: 4, radius: 1, cooldown: 3 }; // Breacher; radius is Chebyshev
export const ABILITY_TEXT = {
  grenade: { name: 'Frag Grenade', desc: `Throw up to ${FRAG.range} tiles. ${FRAG.dmg} damage in a 3×3 blast, hits allies too, shreds cover. 1 AP.` },
  aimed: { name: 'Aimed Shot', desc: `+${AIMED.aim} aim, +${AIMED.dmg} damage. Ends turn. Cooldown ${AIMED.cooldown}.` },
  breach: { name: 'Breach Charge', desc: `Blow open adjacent cover; ${BREACH.dmg} damage to enemies next to it. 1 AP. Cooldown ${BREACH.cooldown}.` },
  hunker: { name: 'Hunker Down', desc: 'Double your cover bonus and no grazes until your next turn. Ends turn.' },
};

export const CALLSIGNS = [
  'Rook', 'Vex', 'Salt', 'Kestrel', 'Brine', 'Hollow', 'Mako', 'Rust', 'Tern', 'Ash',
  'Wick', 'Gale', 'Flint', 'Echo', 'Reef', 'Cinder', 'Pike', 'Moth', 'Drift', 'Quill',
];
