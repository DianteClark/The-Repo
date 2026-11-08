// All tunable numbers live here so balance changes never touch logic.

export const TOTAL_PLAYERS = 16;
export const TURN_SECONDS = 20;
export const MAP_SIZE = 44;
export const SIGHT = 10; // daytime sight; stages can lower it (map.sight)
export const NIGHT_SIGHT = 6;
export const BASE_AP = 2;

import { buildWeapon, DEFAULT_PRIMARY, CLASS_WEAPONS } from './weapons.js';

// Classes give role, ability, health/armour and allowed weapon categories (5.0).
// `weapon` is the default primary, fully built (legacy UI reads name/range/aim/dmg).
const CLS = (key, name, desc, hp, armor, move, ability) => ({
  key, name, desc, hp, armor, move, ability, weapons: CLASS_WEAPONS[key], weapon: buildWeapon(DEFAULT_PRIMARY[key]),
});
export const CLASSES = {
  assault: CLS('assault', 'Assault', 'Frag specialist (+1 lethal). Run & Gun: shoot after a dash once per 3 rounds.', 9, 0, 6, 'run_gun'),
  marksman: CLS('marksman', 'Marksman', 'Long range, hits hard. Aimed Shot. Weak up close.', 8, 0, 5, 'aimed'),
  breacher: CLS('breacher', 'Breacher', 'Tough. Breach charges blow open cover.', 12, 0, 5, 'breach'),
  medic: CLS('medic', 'Medic', 'Keeps the squad standing. Patch heals or revives.', 9, 0, 6, 'patch'),
  recon: CLS('recon', 'Recon', 'Fast scout. Scan reveals enemies through walls.', 9, 0, 7, 'scan'),
  engineer: CLS('engineer', 'Engineer', 'Deploy Cover: drop a full-cover barricade next to you. Repairs boats.', 11, 0, 6, 'deploy_cover'),
  gunner: CLS('gunner', 'Gunner', 'Suppress: pin an enemy (-25 aim, moving draws fire). LMGs only.', 11, 0, 5, 'suppress'),
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
// Crates hold supplies and field attachments. Weapons only come from gold crates.
// 'lethal' / 'tactical' give a charge of whatever you carry in that slot;
// 'attachment' crates carry a specific attachment (crate.attachment), fitted to your primary.
export const CRATE_TABLE = [
  ['medkit', 26],
  ['armor', 16],
  ['ammo', 18],
  ['attachment', 20],
  ['lethal', 12],
  ['tactical', 8],
];
export const CRATE_LABEL = {
  medkit: '+1 Medkit',
  armor: '+1 Armor plate',
  scope: 'Scope: +2 range, +5 aim',
  barrel: 'Heavy barrel: +1 damage',
  frag: '+1 Frag grenade',
  smoke: '+1 Smoke grenade',
  cache: 'Supply cache: +1 scope, +1 barrel, +1 lethal, ammo',
  ammo: 'Ammo: full magazine and spare rounds',
  attachment: 'Field attachment',
  lethal: '+1 Lethal',
  tactical: '+1 Tactical',
  gold: 'Legendary weapon',
  care: 'Care package',
};
// Supply drops (rounds below) are gold crates this often (legendary weapon inside).
export const GOLD_DROP_CHANCE = 0.25;
export const MOD_CAP = 2; // max stacks of scope / barrel / crate armor
export const FRAG_CAP = 3; // max grenades carried
export const SMOKE_CAP = 2;
export const LETHAL_CAP = 3; // any lethal
export const TACTICAL_CAP = 2;

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
export const DEPLOY_COVER = { cooldown: 3 }; // Engineer: full-cover barricade on an adjacent open tile, 1 AP
export const SUPPRESS = { aim: 25, ammo: 3, cooldown: 2 }; // Gunner: 1 AP + 3 ammo, ends turn
export const RUN_GUN = { cooldown: 3 }; // Assault: shoot after a dash, once per 3 rounds
export const RELOAD_AP = 1;
export const BLEED_TURNS = 2; // own team turns a downed unit lasts

export const ABILITY_TEXT = {
  grenade: { name: 'Frag Grenade', desc: `Throw up to ${FRAG.range} tiles. ${FRAG.dmg} damage in a 3×3 blast, hits allies too, shreds cover. 1 AP.` },
  aimed: { name: 'Aimed Shot', desc: `+${AIMED.aim} aim, +${AIMED.dmg} damage. Ends turn. Cooldown ${AIMED.cooldown}.` },
  breach: { name: 'Breach Charge', desc: `Blow open adjacent cover; ${BREACH.dmg} damage to enemies next to it. 1 AP. Cooldown ${BREACH.cooldown}.` },
  patch: { name: 'Patch', desc: `Heal yourself or an adjacent ally for ${PATCH.heal}, or revive a downed ally at ${PATCH.reviveHp} HP. 1 AP. Cooldown ${PATCH.cooldown}.` },
  scan: { name: 'Scan', desc: `Reveal every unit within ${SCAN.radius} tiles of a point up to ${SCAN.range} tiles away, through walls, until your next turn. 1 AP. Cooldown ${SCAN.cooldown}.` },
  smoke: { name: 'Smoke Grenade', desc: `Up to ${SMOKE.range} tiles. A 3×3 cloud hides anyone inside from enemies more than a tile away; shots into or out of it take -${SMOKE.aimIn} aim. Lasts until your next turn. 1 AP.` },
  revive: { name: 'Revive', desc: `Get an adjacent downed squadmate back up at ${REVIVE_HP} HP. 1 AP.` },
  deploy_cover: { name: 'Deploy Cover', desc: `Place a full-cover barricade on an adjacent open tile. 1 AP. Cooldown ${DEPLOY_COVER.cooldown}.` },
  suppress: { name: 'Suppress', desc: `Pin a visible enemy: -${SUPPRESS.aim} aim until its next turn ends, and moving draws a reaction shot. 1 AP, ${SUPPRESS.ammo} ammo, ends turn. Cooldown ${SUPPRESS.cooldown}.` },
  run_gun: { name: 'Run & Gun', desc: `Passive: after a dash you may still shoot. Once per ${RUN_GUN.cooldown} rounds.` },
  semtex: { name: 'Semtex', desc: 'Sticks to a unit on the target tile (+2 to it). 3 damage in radius 1.5. 1 AP.' },
  claymore: { name: 'Claymore', desc: 'Place on an adjacent tile. The first enemy to move within 1.5 takes 5. 1 AP.' },
  knife: { name: 'Throwing Knife', desc: 'Range 4, 4 damage, silent. 1 AP, doesn\'t end the turn.' },
  flashbang: { name: 'Flashbang', desc: 'Radius 1.5: enemies lose 1 AP next turn and take -30 aim until it ends. 1 AP.' },
  stim: { name: 'Stim', desc: '+1 AP this turn and heal 2. Free.' },
  decoy: { name: 'Decoy', desc: 'A fake gunfire ping that draws bot overwatch and attention for a round. 1 AP.' },
  reload: { name: 'Reload', desc: 'Refill the magazine from spare rounds. 1 AP, doesn\'t end the turn.' },
  swap: { name: 'Swap Weapon', desc: 'Switch primary / secondary. Free, once per turn.' },
  hunker: { name: 'Hunker Down', desc: 'Double your cover bonus and no grazes until your next turn. Ends turn.' },
  // 5.0 battlefield (SIM-2)
  repair: { name: 'Repair Boat', desc: 'Fix an adjacent boat: +4 hull, +1 fuel. 1 AP.' },
  boat_move: { name: 'Drive Boat', desc: 'Sail up to 8 tiles through water. Costs 1 fuel and the rest of your turn. Everyone aboard comes along.' },
  board: { name: 'Board Boat', desc: 'Step onto an adjacent boat (4 seats). Aboard: half cover against every shot and no tide damage. 1 AP.' },
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
