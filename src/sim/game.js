// Authoritative game state + actions. Pure logic: no DOM, no rendering.
// Every function that changes state returns a list of events the client animates.
//
// Module map (5.0):
//   game.js      createGame, act() dispatch, previews / queries (this file; re-exports the rest)
//   turns.js     Engagement Turns: activeTeams / endTeamTurn / engagements, round + step flow
//   core.js      damage, downing, death, explosions, shots, crates (shared primitives)
//   equipment.js lethal + tactical equipment
//   streaks.js   killstreaks
//   loadout.js   validateLoadout / bot loadouts / applying a loadout to a unit
//   weapons.js   data: WEAPONS, ATTACHMENTS, LEGENDARIES, EQUIPMENT, PERKS, STREAKS, progression tables
//   vehicles.js  (SIM-2) boats: board / disembark / boat_move / repair / shoot, hull damage
//   stageevents.js (SIM-2) stage events ("Levolution") + building collapse
//   pit.js       (SIM-2) The Pit: second-chance 1v1 duels, Pit Warden, redeploy
//
// Extension points for SIM-2 (boats, stage events, collapse, The Pit):
//   ACTIONS[type] = (state, unit, action) => ({events} | {error})   new act() types (e.g. boat_move, repair)
//   TURN_HOOKS (turns.js) roundStart / stepStart / teamStart / teamEnd
//   HOOKS (core.js) onDeath / onDamage / onCoverChange
//   state.blockers (Set-able array of tile keys that block movement), unit.tideImmune (no zone damage)
//   CREATE_HOOKS: (state, opts) => void, run at the end of createGame before round 1 starts

import {
  TOTAL_PLAYERS, MAP_SIZE, CLASSES, MODES, LONE_WOLF, GRAZE_BAND, MEDKIT_HEAL, ZONE, CRATE_COUNT, CRATE_TABLE,
  CALLSIGNS, FRAG, AIMED, BREACH, ABILITY_TEXT, SMOKE, PATCH, SCAN, REVIVE_HP, STAGES, STAGE_KEYS, BARREL,
  DEPLOY_COVER, SUPPRESS, RUN_GUN, BASE_AP,
} from './constants.js';
import { generateMap } from './map.js';
import { makeRng, roll, hash32 } from './rng.js';
import {
  reachable, pathTo, hitChance, inRangeAndLos, teamSeesUnit, teamSeesTile, dist, los, inBounds, DIRS8, standing,
  weaponRange, isBarrel, moveOf,
} from './rules.js';
import { ATTACHMENTS, EQUIPMENT, hasSpecial } from './weapons.js';
import { applyLoadout, randomLoadout, validateLoadout, defaultLoadout, hasPerk } from './loadout.js';
import {
  teamAlive, aliveTeams, nextRoll, resolveShot, detonate, planExplosions, summarisePlan, setCover, pickupCrate,
  reviveUnit, flare, noise, hasAmmo, spendAmmo, isInfinite, hiddenFromIntel, chebyshev, shotDamage, grazeBand, blastRadius,
} from './core.js';
import {
  activeTeams, isTeamActive, currentTeamId, engagements, freeTeams, endTeamTurn, settle, startFirstRound, TURN_HOOKS,
  computeContacts,
} from './turns.js';
import {
  actEquipment, equipmentTargets, equipmentPreview, claymoreReact, throwTileOk, ACTION_ITEM, canUse,
} from './equipment.js';
import {
  actStreak, streakInfo, streakTargets, streakPreview, sentryReact, shootSentry, airstrikeLine,
} from './streaks.js';
import { addPoints, streakPoints, STREAK_POINTS } from './core.js';
import {
  VEHICLE_ACTIONS, BOAT, placeBoats, embark, disembark, vehicleAt, vehicleById, vehicleOf, driverOf, boardError,
  boardTargets, boatReach, boatMoveTargets, repairTargets, vehicleShotPreview, shootVehicle, navigable,
} from './vehicles.js';
import { planStageEvent, dangerTiles, STAGE_EVENT, COLLAPSE, knockback } from './stageevents.js';
import { initPit, pitDuels, resolvePitBots, settlePit, duelUnitFor, createDuelState, playDuel, PIT } from './pit.js';

export {
  activeTeams, isTeamActive, currentTeamId, engagements, freeTeams, endTeamTurn, TURN_HOOKS, computeContacts,
  startFirstRound, teamAlive, aliveTeams, validateLoadout, defaultLoadout, randomLoadout,
  equipmentTargets, equipmentPreview, streakInfo, streakTargets, streakPreview, airstrikeLine,
};
export { HOOKS } from './core.js';
// 5.0 battlefield layer (SIM-2): boats, stage events, building collapse, the Pit, streak points.
export {
  BOAT, vehicleAt, vehicleById, vehicleOf, driverOf, boardError, boardTargets, boatReach, boatMoveTargets, repairTargets,
  vehicleShotPreview, navigable, STAGE_EVENT, COLLAPSE, dangerTiles, knockback, pitDuels, resolvePitBots, settlePit,
  duelUnitFor, createDuelState, playDuel, PIT, streakPoints, STREAK_POINTS,
};

const CLASS_KEYS = Object.keys(CLASSES);
export const ACTIONS = { ...VEHICLE_ACTIONS };
export const CREATE_HOOKS = [
  (state) => placeBoats(state),
  (state) => planStageEvent(state),
  (state, opts) => initPit(state, opts),
];

/**
 * opts: { seed, mode, stage, noHuman, playerClass, loadout, volunteerLoneWolf,
 *         players:[{name, loadout, isHuman:true, squad?}], pit? (false: no Pit second chance) }
 * `players` lists the humans (one entry each). Without it, one human ('You') plays
 * `loadout` or `playerClass` unless noHuman. Humans with the same `squad` number share a squad.
 */
export function createGame(opts = {}) {
  const seed = (opts.seed ?? Math.floor(Math.random() * 2 ** 32)) >>> 0;
  const mode = MODES[opts.mode] ? opts.mode : 'solos';
  const playerClass = CLASSES[opts.playerClass] ? opts.playerClass : 'assault';
  let humans = [];
  if (Array.isArray(opts.players) && opts.players.length) {
    humans = opts.players.filter((p) => p && p.isHuman !== false).slice(0, TOTAL_PLAYERS)
      .map((p, i) => ({ name: p.name || `Player ${i + 1}`, loadout: validateLoadout(p.loadout || { cls: p.cls }), squad: p.squad }));
  } else if (!opts.noHuman) {
    humans = [{ name: opts.callsign || 'You', loadout: validateLoadout(opts.loadout || { cls: playerClass }) }];
  }
  const rng = makeRng(seed ^ 0x51ed270b);
  const kitRng = makeRng(seed ^ 0x10ad0a7); // bot loadouts: own stream, so maps and spawns don't shift
  // Stage: a key, 'random' (picked from the seed), or harbor by default.
  const stage = STAGES[opts.stage] ? opts.stage
    : opts.stage === 'random' ? STAGE_KEYS[Math.floor(roll(seed, 0x57a6e) * STAGE_KEYS.length)]
      : 'harbor';
  const stageDef = STAGES[stage];
  const map = generateMap(seed, stageDef.size || MAP_SIZE, stage);
  const S = map.size;

  // Team layout
  const { teamSize, loneWolf } = MODES[mode];
  const sizes = [];
  const full = Math.floor(TOTAL_PLAYERS / teamSize);
  for (let i = 0; i < full; i++) sizes.push(teamSize);
  const rem = TOTAL_PLAYERS - full * teamSize;
  if (rem > 0) sizes.push(rem);
  const loneWolfTeam = loneWolf && rem === 1 ? sizes.length - 1 : -1;

  // Seat the humans: grouped by squad number, otherwise one squad each.
  const seats = sizes.map(() => []);
  const fits = (t) => seats[t].length < sizes[t];
  const squadTeam = new Map();
  humans.forEach((h, i) => {
    let t = -1;
    if (i === 0 && opts.volunteerLoneWolf && loneWolfTeam >= 0) t = loneWolfTeam;
    else if (Number.isInteger(h.squad) && squadTeam.has(h.squad) && fits(squadTeam.get(h.squad))) t = squadTeam.get(h.squad);
    else {
      for (let k = 0; k < sizes.length; k++) {
        if (seats[k].length === 0 && k !== loneWolfTeam) { t = k; break; }
      }
      if (t < 0) for (let k = 0; k < sizes.length; k++) if (fits(k)) { t = k; break; }
    }
    if (t < 0) return;
    if (Number.isInteger(h.squad) && !squadTeam.has(h.squad)) squadTeam.set(h.squad, t);
    seats[t].push(h);
  });
  const humanTeams = seats.map((s, t) => (s.length ? t : -1)).filter((t) => t >= 0);
  const playerTeam = humans.length ? humanTeams.find((t) => seats[t].includes(humans[0])) : -1;

  const names = [...CALLSIGNS];
  const units = [];
  const teams = sizes.map((n, t) => {
    const members = [];
    for (let i = 0; i < n; i++) {
      const h = seats[t][i];
      // (no rng draws for human seats: keeps the legacy spawn stream)
      const cls = h ? h.loadout.cls : CLASS_KEYS[Math.floor(rng() * CLASS_KEYS.length)];
      const name = h ? h.name : names.splice(Math.floor(rng() * names.length), 1)[0] || 'Bot' + units.length;
      const loadout = h ? h.loadout : randomLoadout(kitRng, cls);
      const u = makeUnit(units.length, t, loadout, name, !!h, t === loneWolfTeam);
      units.push(u);
      members.push(u.id);
    }
    return { id: t, members, isLoneWolf: t === loneWolfTeam, human: seats[t].length > 0 };
  });

  // Spawns: squads scattered across the map, kept apart; teammates packed together.
  const occupied = new Set();
  const c = (S - 1) / 2;
  const anchors = [];
  for (let t = 0; t < teams.length; t++) {
    let best = null;
    // Best-of-N candidates: maximise the distance to the nearest squad already placed.
    for (let tries = 0; tries < 120; tries++) {
      const x = 2 + Math.floor(rng() * (S - 4)), y = 2 + Math.floor(rng() * (S - 4));
      if (map.cover[y * S + x]) continue;
      const gap = anchors.length ? Math.min(...anchors.map((a) => dist(a[0], a[1], x, y))) : 99;
      if (!best || gap > best.gap) best = { x, y, gap };
      if (gap >= S * 0.4) break;
    }
    anchors.push([best.x, best.y]);
  }
  // Human squads get the most isolated open spots once everyone else is placed
  // (deterministic scan, no rng draw), so they rarely get gunned down before their first turn.
  for (const ht of humanTeams) {
    let best = null;
    for (let y = 2; y < S - 2; y++) {
      for (let x = 2; x < S - 2; x++) {
        if (map.cover[y * S + x]) continue;
        const gap = Math.min(99, ...anchors.filter((_, i) => i !== ht).map((a) => dist(a[0], a[1], x, y)));
        if (!best || gap > best.gap) best = { x, y, gap };
      }
    }
    if (best) anchors[ht] = [best.x, best.y];
  }
  teams.forEach((team, t) => {
    const [ax, ay] = anchors[t];
    for (const id of team.members) {
      const [x, y] = nearestFree(map, occupied, ax, ay);
      units[id].x = x; units[id].y = y;
      occupied.add(y * S + x);
    }
  });

  // Crates
  const crates = [];
  const attKeys = Object.keys(ATTACHMENTS);
  let guard = 0;
  while (crates.length < CRATE_COUNT && guard++ < 5000) {
    const x = Math.floor(rng() * S), y = Math.floor(rng() * S);
    const k = y * S + x;
    if (map.cover[k] || occupied.has(k)) continue;
    if (units.some((u) => dist(u.x, u.y, x, y) < 4)) continue;
    if (crates.some((cr) => dist(cr.x, cr.y, x, y) < 3)) continue;
    const crate = { id: crates.length, x, y, type: weighted(rng, CRATE_TABLE), taken: false };
    if (crate.type === 'attachment') crate.attachment = attKeys[hash32(seed, 0xa77, crate.id) % attKeys.length];
    crates.push(crate);
    occupied.add(k);
  }

  // Zone (the Surge). The whole shrink schedule is planned up front: radius r0
  // covering the whole map, down by ZONE.step to the final ring, then 0.
  // Normally the centre is fixed; on drift stages it walks to a point near one side.
  let zx = Math.round(c + (rng() - 0.5) * 8);
  let zy = Math.round(c + (rng() - 0.5) * 8);
  let fx = zx, fy = zy;
  if (stageDef.drift) {
    const side = Math.floor(rng() * 4);
    const along = 10 + Math.floor(rng() * (S - 20));
    const edge = 8;
    [fx, fy] = [[along, edge], [S - 1 - edge, along], [along, S - 1 - edge], [edge, along]][side];
    // Start on the far side of the map from where it ends up.
    zx = Math.round(Math.min(S - 6, Math.max(5, c + (c - fx) * 0.35)));
    zy = Math.round(Math.min(S - 6, Math.max(5, c + (c - fy) * 0.35)));
  }
  const r0 = Math.ceil(Math.max(dist(zx, zy, 0, 0), dist(zx, zy, S, 0), dist(zx, zy, 0, S), dist(zx, zy, S, S))) + 1;
  const zonePlan = [{ r: r0, x: zx, y: zy }];
  while (zonePlan[zonePlan.length - 1].r > ZONE.finalRadius) {
    zonePlan.push({ r: Math.max(ZONE.finalRadius, zonePlan[zonePlan.length - 1].r - ZONE.step) });
  }
  zonePlan.push({ r: ZONE.minRadius });
  for (const p of zonePlan) {
    if (p.x !== undefined) continue;
    // Drift in proportion to how much the ring shrank, so each ring stays inside the last.
    const t = Math.min(1, (r0 - p.r) / Math.max(1, r0 - ZONE.finalRadius));
    p.x = Math.round(zx + (fx - zx) * t);
    p.y = Math.round(zy + (fy - zy) * t);
  }
  const zone = { x: zx, y: zy, r: r0, next: zonePlan[1].r, nx: zonePlan[1].x, ny: zonePlan[1].y, stage: 0 };

  const order = teams.map((t) => t.id);
  // Rotate the start so the human isn't always first (they still land in the first quarter).
  let startShift = Math.floor(rng() * order.length);
  if (playerTeam >= 0) {
    const q = Math.max(1, Math.ceil(order.length / 4));
    startShift = (playerTeam - (startShift % q) + order.length) % order.length;
  }
  for (let i = 0; i < startShift; i++) order.push(order.shift());

  const state = {
    seed, mode, stage, map, units, teams, crates, zone, zonePlan, order,
    playerTeam, humanTeams, loneWolfTeam, night: !!stageDef.night,
    round: 1, turnPos: 0, rollCounter: 0,
    eliminated: [], // team ids in elimination order
    winner: null,
    smokes: [], // [{id, x, y, radius, team, expiresRound, expiresTeam}]
    reveals: [], // [{team, kind:'scan'|'uav'|'tracker', x, y, radius, ids}]
    nextSmokeId: 0,
    turnSerial: 0, // increments every step
    flares: [], // units visible to all (night muzzle flash, Lantern): [{id, team}]
    turn: null, // engagement-turn bookkeeping (turns.js)
    // 5.0
    noises: [], claymores: [], decoys: [], nextEquipId: 0,
    cuav: [], drops: [], airstrikes: [], sentries: [], gunships: [], nextStreakId: 0,
    blockers: [],
  };
  for (const h of CREATE_HOOKS) h(state, opts);
  state.startEvents = startFirstRound(state);
  return state;
}

function makeUnit(id, team, loadout, name, isPlayer, isLoneWolf) {
  const u = {
    id, team, cls: loadout.cls, name, isPlayer, isHuman: isPlayer, isLoneWolf,
    x: 0, y: 0, hp: 0, maxHp: 0, armor: 0, maxAp: BASE_AP, ap: 0, move: 0,
    alive: true, overwatch: false, missStreak: 0, kills: 0,
    mods: { scope: 0, barrel: 0, armor: 0 },
    cooldowns: { aimed: 0, breach: 0, patch: 0, scan: 0, deploy_cover: 0, suppress: 0, run_gun: 0 },
    hunkered: false,
    downed: false, bleed: 0, downedBy: null, downedAt: -1,
    streakUsed: {}, moved: false, swapped: false,
  };
  applyLoadout(u, loadout);
  if (isLoneWolf) {
    u.maxHp = Math.round(u.maxHp * LONE_WOLF.hpMult);
    u.hp = u.maxHp;
    u.armor += LONE_WOLF.armor;
    u.maxAp += LONE_WOLF.ap;
  }
  return u;
}

function weighted(rng, table) {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [k, w] of table) { if ((r -= w) < 0) return k; }
  return table[0][0];
}

function nearestFree(map, occupied, x0, y0) {
  const S = map.size;
  for (let r = 0; r < S; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = x0 + dx, y = y0 + dy;
        if (x < 0 || y < 0 || x >= S || y >= S) continue;
        const k = y * S + x;
        if (!map.cover[k] && !occupied.has(k)) return [x, y];
      }
    }
  }
  throw new Error('No free tile');
}

// ---------- queries ----------

/**
 * Is (x,y) inside the safe zone? Pass `r = state.zone.next` to ask about the next
 * ring: on drifting stages that is measured from the next ring's own centre.
 */
export const insideZone = (state, x, y, r = state.zone.r) => {
  const z = state.zone;
  const next = r === z.next && r !== z.r && z.nx !== undefined;
  return dist(x, y, next ? z.nx : z.x, next ? z.ny : z.y) <= r;
};
/** Inside the next ring (after the coming shrink), using its own centre. */
export const insideNextZone = (state, x, y) => dist(x, y, state.zone.nx ?? state.zone.x, state.zone.ny ?? state.zone.y) <= state.zone.next;
/** The stage definition for this match. */
export const stageOf = (state) => STAGES[state.stage] || STAGES.harbor;
export const zoneDamage = (state) => ZONE.damage + Math.floor(state.round / 5);
export const roundsUntilShrink = (state) => ZONE.shrinkEvery - ((state.round - 1) % ZONE.shrinkEvery);

export function moveOptions(state, u) {
  const steps = moveOf(u) * Math.min(2, u.ap);
  return reachable(state, u, steps);
}

const isLauncher = (u) => hasSpecial(u.weapon, 'explosive');
/** Can this unit fire its weapon right now (AP or Run & Gun, ammo)? */
const canFire = (u) => standing(u) && !u.moveOnly && (u.ap >= 1 || u.runGun) && hasAmmo(u);

/**
 * Shot preview against a target, or null if there is no legal shot (geometry/visibility).
 * { chance, cover, flank, hunkered, notes, graze, dmg:[min,max], needsReload, burst }
 * Launchers have no unit shot preview: use launchPreview.
 */
export function shotPreview(state, shooter, target, { ability } = {}) {
  if (!target || !target.alive || target.team === shooter.team) return null;
  if (isLauncher(shooter)) return null;
  if (!teamSeesUnit(state, shooter.team, target)) return null;
  if (!inRangeAndLos(state, shooter, target)) return null;
  const hc = hitChance(state, shooter, target, { ability });
  const graze = hc.hunkered ? 0 : Math.max(0, Math.min(grazeBand(shooter.weapon), 100 - hc.chance));
  return {
    ...hc, graze, dmg: shotDamage(shooter, target, hc, ability),
    needsReload: !hasAmmo(shooter), burst: hasSpecial(shooter.weapon, 'burst'),
  };
}

/** Same shape as shotPreview with the aimed-shot modifiers applied (null if not usable). */
export function aimedPreview(state, u, target) {
  if (u.cls !== 'marksman') return null;
  return shotPreview(state, u, target, { ability: 'aimed' });
}

/** Rocket tile rules: weapon range, line of sight, a tile your squad can see. */
const launchTileOk = (state, u, x, y) => inBounds(state.map, x, y) && dist(u.x, u.y, x, y) <= weaponRange(u)
  && teamSeesTile(state, u.team, x, y) && los(state.map, u.x, u.y, x, y);

/** Launcher: valid tiles (Set) and preview. Preview shape as grenadePreview. */
export function launchTargets(state, u) {
  const out = new Set();
  if (!isLauncher(u) || !canFire(u)) return out;
  const S = state.map.size, R = Math.ceil(weaponRange(u));
  for (let y = Math.max(0, u.y - R); y <= Math.min(S - 1, u.y + R); y++) {
    for (let x = Math.max(0, u.x - R); x <= Math.min(S - 1, u.x + R); x++) if (launchTileOk(state, u, x, y)) out.add(y * S + x);
  }
  return out;
}
export function launchPreview(state, u, x, y) {
  const valid = isLauncher(u) && canFire(u) && launchTileOk(state, u, x, y);
  const res = inBounds(state.map, x, y)
    ? summarisePlan(state, u, planExplosions(state, u, { kind: 'rocket', x, y, dmg: u.weapon.dmg[0] }))
    : { units: [], cover: [], barrels: [] };
  return { valid, x, y, radius: blastRadius('rocket'), ...res };
}

const grenadeTileOk = (state, u, x, y) => throwTileOk(state, u, x, y, FRAG.range);

/** Valid grenade (frag) target tiles (Set of y*size+x). Empty if the unit can't throw right now. */
export const grenadeTargets = (state, u) => equipmentTargets(state, u, 'frag');

/**
 * What a frag at (x,y) would do, barrel chains included. Only lists units the
 * thrower's team can see; dmg is the total across the chain.
 * { valid, x, y, radius, units:[{id, dmg, lethal, ally, downed}], cover:[{x,y,from,to}], barrels:[{x,y}] }
 */
export function grenadePreview(state, u, x, y) {
  const valid = canUse(u, 'frag') && grenadeTileOk(state, u, x, y);
  const res = inBounds(state.map, x, y)
    ? summarisePlan(state, u, planExplosions(state, u, { kind: 'frag', x, y }))
    : { units: [], cover: [], barrels: [] };
  return { valid, x, y, radius: FRAG.radius, ...res };
}

const canShootBarrel = (u) => canFire(u) && !isLauncher(u);
const barrelShotOk = (state, u, x, y) => Number.isInteger(x) && Number.isInteger(y) && isBarrel(state.map, x, y)
  && dist(u.x, u.y, x, y) <= weaponRange(u) && los(state.map, u.x, u.y, x, y);

/** Barrels this unit can shoot now (in weapon range and line of sight). */
export function barrelTargets(state, u) {
  const out = new Set();
  if (!canShootBarrel(u) || !state.map.explosive) return out;
  const S = state.map.size;
  for (let k = 0; k < S * S; k++) {
    if (!state.map.explosive[k]) continue;
    if (barrelShotOk(state, u, k % S, (k / S) | 0)) out.add(k);
  }
  return out;
}

/** Shooting the barrel at (x,y): { valid, x, y, radius, units, cover, barrels } (chain included). */
export function barrelPreview(state, u, x, y) {
  const valid = canShootBarrel(u) && barrelShotOk(state, u, x, y);
  const res = isBarrel(state.map, x, y)
    ? summarisePlan(state, u, planExplosions(state, u, { kind: 'barrel', x, y }))
    : { units: [], cover: [], barrels: [] };
  return { valid, x, y, radius: BARREL.radius, ...res };
}

const canBreach = (u) => standing(u) && u.cls === 'breacher' && u.ap >= 1 && u.cooldowns.breach <= 0 && !u.moveOnly;

/** Adjacent (8-way) tiles with cover the Breacher can blow open. Empty if not usable now. */
export function breachTargets(state, u) {
  const out = new Set();
  if (!canBreach(u)) return out;
  const { map } = state;
  for (const [dx, dy] of DIRS8) {
    const x = u.x + dx, y = u.y + dy;
    if (inBounds(map, x, y) && map.cover[y * map.size + x] > 0) out.add(y * map.size + x);
  }
  return out;
}

/** Breach preview (barrel chains included): { valid, units:[{id,dmg,lethal}], cover:[{x,y,from,to}], barrels } */
export function breachPreview(state, u, x, y) {
  const S = state.map.size;
  const valid = breachTargets(state, u).has(y * S + x);
  if (!inBounds(state.map, x, y)) return { valid, units: [], cover: [], barrels: [] };
  const res = summarisePlan(state, u, planExplosions(state, u, { kind: 'breach', x, y }));
  return { valid, ...res };
}

// ---------- class abilities: smoke, patch, scan, revive, deploy cover, suppress ----------

const hasSquadmates = (state, u) => state.teams[u.team].members.length > 1;

/** Valid smoke target tiles (same reach and LOS rules as a frag). Empty if the unit can't throw. */
export const smokeTargets = (state, u) => equipmentTargets(state, u, 'smoke');

const canPatch = (u) => standing(u) && u.cls === 'medic' && u.ap >= 1 && u.cooldowns.patch <= 0 && !u.moveOnly;
const patchable = (u, t) => t.alive && t.team === u.team && chebyshev(u, t) <= 1
  && (t.downed || t.hp < t.maxHp);

/** Tiles of units the Medic can patch now: itself or adjacent squadmates that are hurt or downed. */
export function patchTargets(state, u) {
  const out = new Set();
  if (!canPatch(u)) return out;
  for (const t of state.units) if (patchable(u, t)) out.add(t.y * state.map.size + t.x);
  return out;
}

const canRevive = (u) => standing(u) && u.ap >= 1 && !u.moveOnly;
const revivable = (u, t) => t.alive && t.downed && t.team === u.team && t.id !== u.id && chebyshev(u, t) <= 1;

/** Tiles of adjacent downed squadmates this unit can revive. */
export function reviveTargets(state, u) {
  const out = new Set();
  if (!canRevive(u)) return out;
  for (const t of state.units) if (revivable(u, t)) out.add(t.y * state.map.size + t.x);
  return out;
}

const canScan = (u) => standing(u) && u.cls === 'recon' && u.ap >= 1 && u.cooldowns.scan <= 0 && !u.moveOnly;
const scanTileOk = (state, u, x, y) => Number.isInteger(x) && Number.isInteger(y)
  && inBounds(state.map, x, y) && dist(u.x, u.y, x, y) <= SCAN.range;

/**
 * Scan preview. Never leaks hidden units: `units` lists only enemies in the
 * area the team can already see. { valid, x, y, radius, units:[{id}] }
 */
export function scanPreview(state, u, x, y) {
  const valid = canScan(u) && scanTileOk(state, u, x, y);
  const units = [];
  for (const o of state.units) {
    if (!o.alive || o.team === u.team || dist(o.x, o.y, x, y) > SCAN.radius) continue;
    if (teamSeesUnit(state, u.team, o)) units.push({ id: o.id });
  }
  return { valid, x, y, radius: SCAN.radius, units };
}

/** Units a smoke cloud at (x,y) would cover. Squadmates: always known. */
export function smokePreview(state, u, x, y) {
  const valid = canUse(u, 'smoke') && grenadeTileOk(state, u, x, y);
  const units = state.units.filter((o) => o.alive && dist(o.x, o.y, x, y) <= SMOKE.radius
    && teamSeesUnit(state, u.team, o)).map((o) => ({ id: o.id, ally: o.team === u.team }));
  return { valid, x, y, radius: SMOKE.radius, units };
}

const canDeploy = (u) => standing(u) && u.cls === 'engineer' && u.ap >= 1 && u.cooldowns.deploy_cover <= 0 && !u.moveOnly;
const deployTileOk = (state, u, x, y) => Number.isInteger(x) && Number.isInteger(y) && inBounds(state.map, x, y)
  && chebyshev(u, { x, y }) === 1 && state.map.cover[y * state.map.size + x] === 0
  && !state.units.some((o) => o.alive && o.x === x && o.y === y)
  && !state.crates.some((c) => !c.taken && c.x === x && c.y === y)
  && !state.claymores.some((c) => c.x === x && c.y === y)
  && !state.sentries.some((c) => c.x === x && c.y === y)
  && !(state.blockers || []).includes(y * state.map.size + x);

/** Engineer: adjacent open tiles that can take a barricade (Set). */
export function deployCoverTargets(state, u) {
  const out = new Set();
  if (!canDeploy(u)) return out;
  for (const [dx, dy] of DIRS8) if (deployTileOk(state, u, u.x + dx, u.y + dy)) out.add((u.y + dy) * state.map.size + u.x + dx);
  return out;
}

const canSuppress = (u) => standing(u) && u.cls === 'gunner' && u.ap >= 1 && u.cooldowns.suppress <= 0
  && !u.moveOnly && hasAmmo(u, SUPPRESS.ammo) && !isLauncher(u);
/** Gunner: suppress preview against a target, or null. { aim: -25, target } */
export function suppressPreview(state, u, t) {
  if (!canSuppress(u) || !t || !t.alive || t.downed || t.team === u.team) return null;
  if (!teamSeesUnit(state, u.team, t) || !inRangeAndLos(state, u, t)) return null;
  return { target: t.id, aim: -SUPPRESS.aim, ammo: SUPPRESS.ammo };
}

/** Weapon panel data: { active, slot, weapon, ammo, mag, spare, canReload, canSwap, other } */
export function weaponInfo(u) {
  const other = u.weapons ? u.weapons[1 - (u.slot || 0)] : null;
  const w = u.weapon;
  const canReload = standing(u) && !isInfinite(w) && !hasSpecial(w, 'explosive') && (u.ammo ?? 0) < w.mag
    && (w.spare ?? 0) > 0 && (u.ap >= 1 || (w.freeReload && !u.freeReloaded));
  return {
    slot: u.slot || 0, weapon: w, ammo: isInfinite(w) ? Infinity : u.ammo, mag: w.mag, spare: w.spare ?? 0,
    infinite: isInfinite(w), canReload, canSwap: standing(u) && !!other && !u.swapped, other,
    empty: !hasAmmo(u),
  };
}

/**
 * Ability buttons for a unit. Pass state as well to also check for targets
 * (e.g. "No cover adjacent"); without it only AP / charges / cooldowns are checked.
 * Keys: the carried lethal / tactical (grenade, semtex, claymore, knife, smoke, flashbang,
 * stim, decoy), the class ability (aimed, breach, patch, scan, deploy_cover, suppress, run_gun),
 * revive (team modes), reload, swap, hunker.
 */
export function abilityInfo(u, state) {
  const out = [];
  const entry = (key, ready, reason, extra) => {
    const e = { key, ...ABILITY_TEXT[key], ready, ...extra };
    if (!ready && reason) e.reason = reason;
    out.push(e);
  };
  const apReason = !u.alive ? 'Down' : u.downed ? 'Downed' : u.ap < 1 ? 'No AP' : u.moveOnly ? 'Move only' : null;
  const cdReason = (cd) => (cd > 0 ? `Cooldown ${cd}` : apReason);
  for (const key of Object.keys(EQUIPMENT)) {
    const n = (u.items && u.items[key]) || 0;
    const carried = key === u.lethal || key === u.tactical || (!u.lethal && (key === 'frag' || key === 'smoke'));
    if (!carried && n < 1) continue;
    const action = EQUIPMENT[key].action;
    let reason = apReason || (n < 1 ? (key === 'frag' ? 'No grenades' : key === 'smoke' ? 'No smoke' : 'None left') : null);
    if (!reason && state && key !== 'stim' && equipmentTargets(state, u, key).size === 0) reason = 'No target';
    entry(action, !reason, reason, { charges: n, item: key, slot: EQUIPMENT[key].slot, ...(ABILITY_TEXT[action] ? {} : { name: EQUIPMENT[key].name, desc: EQUIPMENT[key].desc }) });
  }
  if (u.cls === 'marksman') {
    const cd = u.cooldowns.aimed;
    let reason = cdReason(cd) || (!hasAmmo(u) ? 'Reload' : null);
    if (!reason && state && !state.units.some((t) => aimedPreview(state, u, t))) reason = 'No target';
    entry('aimed', !reason, reason, { cooldown: cd });
  }
  if (u.cls === 'breacher') {
    const cd = u.cooldowns.breach;
    let reason = cdReason(cd);
    if (!reason && state && breachTargets(state, u).size === 0) reason = 'No cover adjacent';
    entry('breach', !reason, reason, { cooldown: cd });
  }
  if (u.cls === 'medic') {
    const cd = u.cooldowns.patch;
    let reason = cdReason(cd);
    if (!reason && state && patchTargets(state, u).size === 0) reason = 'Nobody hurt nearby';
    entry('patch', !reason, reason, { cooldown: cd });
  }
  if (u.cls === 'recon') {
    const cd = u.cooldowns.scan;
    entry('scan', !cdReason(cd), cdReason(cd), { cooldown: cd });
  }
  if (u.cls === 'engineer') {
    const cd = u.cooldowns.deploy_cover;
    let reason = cdReason(cd);
    if (!reason && state && deployCoverTargets(state, u).size === 0) reason = 'No open tile adjacent';
    entry('deploy_cover', !reason, reason, { cooldown: cd });
  }
  if (u.cls === 'gunner') {
    const cd = u.cooldowns.suppress;
    let reason = cdReason(cd) || (!hasAmmo(u, SUPPRESS.ammo) ? 'Needs 3 ammo' : null);
    if (!reason && state && !state.units.some((t) => suppressPreview(state, u, t))) reason = 'No target';
    entry('suppress', !reason, reason, { cooldown: cd });
  }
  if (u.cls === 'assault') {
    const cd = u.cooldowns.run_gun;
    entry('run_gun', cd <= 0, cd > 0 ? `Cooldown ${cd}` : null, { cooldown: cd, passive: true, active: !!u.runGun });
  }
  if (!state || hasSquadmates(state, u)) {
    let reason = apReason;
    if (!reason && state && reviveTargets(state, u).size === 0) reason = 'No downed squadmate adjacent';
    if (!reason && !state) reason = 'No downed squadmate adjacent';
    entry('revive', !reason, reason, {});
  }
  {
    const wi = weaponInfo(u);
    let reason = !standing(u) ? apReason : wi.infinite ? 'Never needs it' : hasSpecial(u.weapon, 'explosive') ? 'No reload'
      : (u.ammo ?? 0) >= u.weapon.mag ? 'Full' : (u.weapon.spare ?? 0) <= 0 ? 'No spare ammo' : !wi.canReload ? 'No AP' : null;
    entry('reload', !reason, reason, { ammo: u.ammo, mag: u.weapon.mag, spare: u.weapon.spare ?? 0, free: !!u.weapon.freeReload });
    const sreason = !standing(u) ? apReason : !wi.other ? 'No secondary' : u.swapped ? 'Once per turn' : null;
    entry('swap', !sreason, sreason, {});
  }
  entry('hunker', !apReason, apReason, {});
  // 5.0 boats
  if (state && state.vehicles && state.vehicles.length) {
    const v = vehicleOf(state, u);
    if (v && driverOf(state, v) === u) {
      const reason = apReason || (v.fuel < 1 ? 'No fuel' : boatMoveTargets(state, u).size === 0 ? 'No water to sail' : null);
      entry('boat_move', !reason, reason, { vehicle: v.id, fuel: v.fuel, hp: v.hp });
    }
    if (!v && boardTargets(state, u).size) entry('board', !apReason, apReason, {});
    if (u.cls === 'engineer') {
      const reason = apReason || (repairTargets(state, u).size === 0 ? 'No damaged boat adjacent' : null);
      entry('repair', !reason, reason, {});
    }
  }
  return out;
}

// ---------- actions ----------

const fail = (error) => ({ ok: false, error, events: [] });
const intXY = (a) => Number.isInteger(a.x) && Number.isInteger(a.y);

/** Overwatch, suppression, claymores and sentries react to one step of a move. */
function stepReactions(state, u, events, first) {
  if (!u.silentMove) {
    for (const e of state.units) {
      if (!standing(e) || !e.overwatch || e.team === u.team) continue;
      if (!teamSeesUnit(state, e.team, u) || !inRangeAndLos(state, e, u) || !hasAmmo(e) || hasSpecial(e.weapon, 'explosive')) continue;
      e.overwatch = false;
      spendAmmo(e);
      events.push({ type: 'overwatch_trigger', id: e.id, target: u.id });
      events.push(...resolveShot(state, e, u, { reaction: true }));
      if (!standing(u) || state.winner !== null) return false;
    }
  }
  if (first && u.suppressed && !u.suppressed.fired) {
    const g = state.units[u.suppressed.by];
    u.suppressed.fired = true;
    if (g && standing(g) && hasAmmo(g) && teamSeesUnit(state, g.team, u) && inRangeAndLos(state, g, u)) {
      spendAmmo(g);
      events.push({ type: 'suppress_trigger', id: g.id, target: u.id });
      events.push(...resolveShot(state, g, u, { reaction: true }));
      if (!standing(u) || state.winner !== null) return false;
    }
  }
  claymoreReact(state, u, events);
  if (!standing(u) || state.winner !== null) return false;
  if (!u.silentMove) sentryReact(state, u, events);
  return standing(u) && state.winner === null;
}

/**
 * Perform an action for a unit. Returns { ok, error?, events }.
 * The unit's squad must be active (isTeamActive).
 */
export function act(state, unitId, action) {
  const u = state.units[unitId];
  if (state.winner !== null) return fail('Game over');
  if (!u || !u.alive) return fail('Unit is down');
  if (u.downed) return fail('Unit is downed');
  if (!isTeamActive(state, u.team)) return fail('Not your turn');
  if (!action || typeof action.type !== 'string') return fail('Unknown action');
  if (u.moveOnly && !['move', 'hold', 'swap', 'reload', 'streak'].includes(action.type)) return fail('Move only');
  const r = dispatch(state, u, action);
  if (r.ok) settle(state, r.events); // a wiped last active squad moves the match on
  return r;
}

function dispatch(state, u, action) {
  const events = [];
  if (ACTION_ITEM[action.type]) {
    const r = actEquipment(state, u, action);
    return r.error ? fail(r.error) : { ok: true, events: r.events };
  }
  if (ACTIONS[action.type]) {
    const r = ACTIONS[action.type](state, u, action) || {};
    return r.error ? fail(r.error) : { ok: true, events: r.events || [] };
  }
  switch (action.type) {
    case 'move': {
      if (u.ap < 1) return fail('No AP');
      if (!intXY(action)) return fail('Unreachable');
      // Moving onto an adjacent boat boards it.
      const boat = u.vehicle == null ? vehicleAt(state, action.x, action.y) : null;
      if (boat) {
        const err = boardError(state, u, boat);
        if (err) return fail(err);
        u.ap--;
        u.moved = true;
        if (u.moveOnly) { u.moveOnly = false; u.ap = 0; }
        embark(state, u, boat, events);
        return { ok: true, events };
      }
      const S = state.map.size;
      const reach = moveOptions(state, u);
      const key = action.y * S + action.x;
      const node = reach.get(key);
      if (!node || node.d === 0) return fail('Unreachable');
      const cost = node.d <= moveOf(u) ? 1 : 2;
      if (cost > u.ap) return fail('Not enough AP');
      u.ap -= cost;
      u.moved = true;
      if (u.moveOnly) { u.moveOnly = false; u.ap = 0; }
      if (cost === 2 && u.cls === 'assault' && u.cooldowns.run_gun <= 0) {
        u.runGun = true;
        events.push({ type: 'run_gun_ready', id: u.id });
      }
      if (u.vehicle != null) disembark(state, u, events); // stepping off a boat
      const path = pathTo(reach, S, key);
      let leg = [path[0]];
      let first = true;
      for (const [px, py] of path.slice(1)) {
        u.x = px; u.y = py;
        leg.push([px, py]);
        const probe = [];
        const ok = stepReactions(state, u, probe, first);
        first = false;
        if (probe.length) {
          events.push({ type: 'move', id: u.id, path: leg });
          leg = [[px, py]];
          events.push(...probe);
        }
        if (!ok) break;
      }
      u.silentMove = false;
      if (leg.length > 1) events.push({ type: 'move', id: u.id, path: leg });
      if (standing(u)) pickupCrate(state, u, events);
      else { u.ap = 0; u.runGun = false; }
      return { ok: true, events };
    }
    case 'shoot': {
      if (!(u.ap >= 1 || u.runGun)) return fail('No AP');
      if (!hasAmmo(u)) return fail('Reload');
      if (action.vehicleId !== undefined) {
        const v = vehicleById(state, action.vehicleId);
        if (!v || isLauncher(u) || !vehicleShotPreview(state, u, v)) return fail('No shot');
        useShot(u);
        spendAmmo(u);
        shootVehicle(state, u, v, events);
        return { ok: true, events };
      }
      if (action.sentryId !== undefined) {
        const t = state.sentries.find((s) => s.id === action.sentryId);
        if (!t || t.team === u.team || dist(u.x, u.y, t.x, t.y) > weaponRange(u) || !los(state.map, u.x, u.y, t.x, t.y)
          || !teamSeesTile(state, u.team, t.x, t.y) || isLauncher(u)) return fail('No shot');
        useShot(u);
        spendAmmo(u);
        shootSentry(state, u, t, events);
        flare(state, u, events); noise(state, u, events);
        return { ok: true, events };
      }
      if (isLauncher(u)) {
        const t = action.targetId !== undefined ? state.units[action.targetId] : null;
        const x = t ? t.x : action.x, y = t ? t.y : action.y;
        if (t && !teamSeesUnit(state, u.team, t)) return fail('No shot');
        if (!Number.isInteger(x) || !Number.isInteger(y) || !launchTileOk(state, u, x, y)) return fail('No shot');
        useShot(u);
        spendAmmo(u);
        events.push({ type: 'rocket', id: u.id, x, y, radius: blastRadius('rocket'), weapon: u.weapon.id });
        flare(state, u, events); noise(state, u, events);
        detonate(state, u, { kind: 'rocket', x, y, dmg: u.weapon.dmg[0] }, events);
        return { ok: true, events };
      }
      const t = state.units[action.targetId];
      if (!t || !shotPreview(state, u, t)) return fail('No shot');
      useShot(u);
      spendAmmo(u);
      events.push(...resolveShot(state, u, t));
      return { ok: true, events };
    }
    case 'reload': {
      const w = u.weapon;
      if (isInfinite(w)) return fail('Never needs reloading');
      if (hasSpecial(w, 'explosive')) return fail('No reload');
      if ((u.ammo ?? 0) >= w.mag) return fail('Full');
      if ((w.spare ?? 0) <= 0) return fail('No spare ammo');
      const free = w.freeReload && !u.freeReloaded;
      if (!free && u.ap < 1) return fail('No AP');
      if (free) u.freeReloaded = true; else u.ap--;
      const n = Math.min(w.mag - (u.ammo ?? 0), w.spare);
      u.ammo = (u.ammo ?? 0) + n;
      w.spare -= n;
      w.ammo = u.ammo;
      events.push({ type: 'reload', id: u.id, weapon: w.id, ammo: u.ammo, spare: w.spare, free });
      return { ok: true, events };
    }
    case 'swap': {
      if (!u.weapons || !u.weapons[1 - (u.slot || 0)]) return fail('No secondary');
      if (u.swapped) return fail('Once per turn');
      u.weapon.ammo = u.ammo;
      u.weapons[u.slot || 0] = u.weapon;
      u.slot = 1 - (u.slot || 0);
      u.weapon = u.weapons[u.slot];
      u.ammo = u.weapon.ammo ?? u.weapon.mag;
      u.swapped = true;
      events.push({ type: 'swap', id: u.id, slot: u.slot, weapon: u.weapon.id, ammo: u.ammo });
      return { ok: true, events };
    }
    case 'overwatch': {
      if (u.ap < 1) return fail('No AP');
      if (!hasAmmo(u)) return fail('Reload');
      if (isLauncher(u)) return fail('Not with a launcher');
      u.ap = 0;
      u.overwatch = true;
      events.push({ type: 'overwatch', id: u.id });
      return { ok: true, events };
    }
    case 'medkit': {
      if (u.ap < 1) return fail('No AP');
      if (u.items.medkit < 1) return fail('No medkit');
      if (u.hp >= u.maxHp) return fail('Full health');
      u.ap--;
      u.items.medkit--;
      const heal = Math.min(MEDKIT_HEAL, u.maxHp - u.hp);
      u.hp += heal;
      events.push({ type: 'heal', id: u.id, amount: heal });
      return { ok: true, events };
    }
    case 'aimed': {
      if (u.cls !== 'marksman') return fail('Marksman only');
      if (u.cooldowns.aimed > 0) return fail('Cooldown');
      if (u.ap < 1) return fail('No AP');
      if (!hasAmmo(u)) return fail('Reload');
      const t = state.units[action.targetId];
      if (!t || !aimedPreview(state, u, t)) return fail('No shot');
      useShot(u);
      spendAmmo(u);
      u.cooldowns.aimed = AIMED.cooldown;
      events.push(...resolveShot(state, u, t, { ability: 'aimed' }));
      return { ok: true, events };
    }
    case 'breach': {
      if (u.cls !== 'breacher') return fail('Breacher only');
      if (u.cooldowns.breach > 0) return fail('Cooldown');
      if (u.ap < 1) return fail('No AP');
      const { x, y } = action;
      if (!intXY(action) || !breachTargets(state, u).has(y * state.map.size + x)) return fail('Bad target');
      u.ap--;
      u.cooldowns.breach = BREACH.cooldown;
      events.push({ type: 'breach', id: u.id, x, y });
      detonate(state, u, { kind: 'breach', x, y }, events);
      if (!standing(u)) u.ap = 0;
      return { ok: true, events };
    }
    case 'shoot_barrel': {
      if (!(u.ap >= 1 || u.runGun)) return fail('No AP');
      if (!hasAmmo(u)) return fail('Reload');
      const { x, y } = action;
      if (isLauncher(u) || !barrelShotOk(state, u, x, y)) return fail('No shot');
      useShot(u);
      spendAmmo(u);
      events.push({ type: 'barrel_shot', id: u.id, x, y });
      flare(state, u, events);
      detonate(state, u, { kind: 'barrel', x, y }, events);
      noise(state, u, events);
      return { ok: true, events };
    }
    case 'patch': {
      if (u.cls !== 'medic') return fail('Medic only');
      if (u.cooldowns.patch > 0) return fail('Cooldown');
      if (u.ap < 1) return fail('No AP');
      const t = action.targetId === undefined ? u : state.units[action.targetId];
      if (!t || !patchable(u, t)) return fail('Bad target');
      u.ap--;
      u.cooldowns.patch = PATCH.cooldown;
      if (t.downed) {
        reviveUnit(t, PATCH.reviveHp);
        events.push({ type: 'patch', id: u.id, target: t.id, amount: t.hp });
        events.push({ type: 'revive', id: t.id, by: u.id, hp: t.hp });
        addPoints(state, u, 'revive', events);
        quickFixHeal(u, events);
      } else {
        const amount = Math.min(PATCH.heal, t.maxHp - t.hp);
        t.hp += amount;
        events.push({ type: 'patch', id: u.id, target: t.id, amount });
      }
      return { ok: true, events };
    }
    case 'revive': {
      if (u.ap < 1) return fail('No AP');
      const t = state.units[action.targetId];
      if (!t || !revivable(u, t)) return fail('Bad target');
      u.ap--;
      reviveUnit(t, REVIVE_HP);
      events.push({ type: 'revive', id: t.id, by: u.id, hp: t.hp });
      addPoints(state, u, 'revive', events);
      quickFixHeal(u, events);
      return { ok: true, events };
    }
    case 'scan': {
      if (u.cls !== 'recon') return fail('Recon only');
      if (u.cooldowns.scan > 0) return fail('Cooldown');
      if (u.ap < 1) return fail('No AP');
      const { x, y } = action;
      if (!scanTileOk(state, u, x, y)) return fail('Bad target');
      u.ap--;
      u.cooldowns.scan = SCAN.cooldown;
      const ids = state.units.filter((o) => o.alive && o.team !== u.team && dist(o.x, o.y, x, y) <= SCAN.radius
        && !hiddenFromIntel(state, o)).map((o) => o.id);
      state.reveals.push({ team: u.team, kind: 'scan', x, y, radius: SCAN.radius, ids });
      events.push({ type: 'scan', id: u.id, x, y, radius: SCAN.radius, revealed: [...ids] });
      return { ok: true, events };
    }
    case 'deploy_cover': {
      if (u.cls !== 'engineer') return fail('Engineer only');
      if (u.cooldowns.deploy_cover > 0) return fail('Cooldown');
      if (u.ap < 1) return fail('No AP');
      const { x, y } = action;
      if (!deployTileOk(state, u, x, y)) return fail('Bad target');
      u.ap--;
      u.cooldowns.deploy_cover = DEPLOY_COVER.cooldown;
      events.push({ type: 'deploy_cover', id: u.id, x, y });
      setCover(state, x, y, 2, events);
      return { ok: true, events };
    }
    case 'suppress': {
      if (u.cls !== 'gunner') return fail('Gunner only');
      if (u.cooldowns.suppress > 0) return fail('Cooldown');
      if (u.ap < 1) return fail('No AP');
      if (!hasAmmo(u, SUPPRESS.ammo)) return fail('Needs 3 ammo');
      const t = state.units[action.targetId];
      if (!suppressPreview(state, u, t)) return fail('No target');
      u.ap = 0;
      spendAmmo(u, SUPPRESS.ammo);
      u.cooldowns.suppress = SUPPRESS.cooldown;
      t.suppressed = { by: u.id, pending: isTeamActive(state, t.team), fired: false };
      events.push({ type: 'suppress', id: u.id, target: t.id });
      flare(state, u, events);
      noise(state, u, events);
      return { ok: true, events };
    }
    case 'streak': {
      const r = actStreak(state, u, action);
      return r.error ? fail(r.error) : { ok: true, events: r.events };
    }
    case 'hunker': {
      if (u.ap < 1) return fail('No AP');
      u.ap = 0;
      u.overwatch = false;
      u.hunkered = true;
      events.push({ type: 'hunker', id: u.id });
      return { ok: true, events };
    }
    case 'hold': {
      u.ap = 0;
      u.runGun = false;
      u.moveOnly = false;
      return { ok: true, events };
    }
    default:
      return fail('Unknown action');
  }
}

/** Firing ends your turn (XCOM rule). A Run & Gun shot spends the passive. */
function useShot(u) {
  if (u.ap < 1 && u.runGun) u.cooldowns.run_gun = RUN_GUN.cooldown;
  u.ap = 0;
  u.runGun = false;
}

function quickFixHeal(u, events) {
  if (!hasPerk(u, 'quickfix') || u.hp >= u.maxHp) return;
  const amount = Math.min(3, u.maxHp - u.hp);
  u.hp += amount;
  events.push({ type: 'heal', id: u.id, amount, source: 'quickfix' });
}

// Keep a few legacy helpers reachable for UI code that imported them from here.
export { grazeBand, GRAZE_BAND };
