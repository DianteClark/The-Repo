// Boats (5.0 spec §5, SIM-2).
//
// state.vehicles = [{id, kind:'boat', x, y, hp, maxHp, fuel, maxFuel, seats:[unitId…]}]
// A unit aboard has unit.vehicle = boat id (null otherwise) and stands on the boat's tile
// (several units share that tile). unit.tideImmune is set while aboard.
//
// Rules
//   board      move onto an adjacent boat tile (or {type:'board', vehicleId}): 1 AP, needs a free seat (4)
//   disembark  any move by a unit aboard starts from the boat tile and leaves the boat
//   boat_move  {type:'boat_move', x, y}: the driver (first standing unit in seats) moves the boat up to
//              8 tiles through water (shallows, or tide-flooded tiles outside the safe zone).
//              Costs 1 AP + the driver's whole turn and 1 fuel. Everyone aboard moves with it.
//   aboard     at least half cover against every shot; no tide damage. A crewed boat outside the
//              safe zone takes hull damage (the zone's damage) at the end of its driver's squad turn,
//              so a boat is a refuge, not a way to outlive the tide.
//   damage     shoot it ({type:'shoot', vehicleId}), blasts and airstrikes on its tile, stage events.
//   destroyed  at 0 HP: 3 explosive damage to everyone aboard; they are dropped into the water nearby.
//   repair     {type:'repair', vehicleId}: an Engineer standing next to it (not aboard), 1 AP: +4 HP, +1 fuel.
// Events: board {id, vehicle, x, y, seat}, disembark {id, vehicle, x, y, forced?},
//   boat_move {id, driver, path, fuel}, vehicle_damage {id, dmg, hp, source}, vehicle_destroyed {id, x, y},
//   repair {id, vehicle, hp, fuel}, shot_vehicle {from, vehicle, result, dmg, chance}

import { hash32 } from './rng.js';
import { DIRS8, inBounds, dist, standing, hitChance, los, weaponRange, teamSeesTile } from './rules.js';
import {
  HOOKS, hurt, blastDmgFor, nextRoll, chebyshev, flare, noise,
} from './core.js';
import { TURN_HOOKS } from './turns.js';
import { ZONE } from './constants.js';

export const BOAT = { hp: 12, fuel: 3, maxFuel: 4, seats: 4, reach: 8, blast: 3, repairHp: 4, repairFuel: 1 };

const fail = (error) => ({ error });
const S_ = (state) => state.map.size;

export const vehicleAt = (state, x, y) => (state.vehicles || []).find((v) => v.x === x && v.y === y) || null;
export const vehicleById = (state, id) => (state.vehicles || []).find((v) => v.id === id) || null;
export const vehicleOf = (state, u) => (u && u.vehicle != null ? vehicleById(state, u.vehicle) : null);
/** The unit steering the boat: the first standing unit aboard. */
export const driverOf = (state, v) => v.seats.map((id) => state.units[id]).find((m) => m && standing(m)) || null;
const isWaterTile = (state, k) => state.map.terrain && state.map.terrain[k] === 2;
const inZone = (state, x, y) => dist(x, y, state.zone.x, state.zone.y) <= state.zone.r;
/** Can a boat sail on (x,y)? Shallows, or tide-flooded ground outside the safe zone; never on cover. */
export const navigable = (state, x, y) => inBounds(state.map, x, y) && state.map.cover[y * S_(state) + x] === 0
  && (isWaterTile(state, y * S_(state) + x) || !inZone(state, x, y));

/** Boat tiles block walking (they are boarded, not crossed). */
export function syncBlockers(state) {
  const S = S_(state);
  const keep = (state.blockers || []).filter((k) => !(state._boatKeys || []).includes(k));
  state._boatKeys = (state.vehicles || []).map((v) => v.y * S + v.x);
  state.blockers = [...keep, ...state._boatKeys];
}

// ---------- placement (createGame) ----------

/** 2–3 boats on shoreline shallows, spread out. Deterministic from the seed; draws no rng. */
export function placeBoats(state) {
  const { map } = state;
  const S = map.size;
  state.vehicles = [];
  state.nextVehicleId = 0;
  if (state.isPit) return;
  const busy = new Set();
  for (const u of state.units) busy.add(u.y * S + u.x);
  for (const c of state.crates) busy.add(c.y * S + c.x);
  const want = 2 + (hash32(state.seed, 0xb0a7) % 2);
  const shore = [], wet = [];
  for (let k = 0; k < S * S; k++) {
    const x = k % S, y = (k / S) | 0;
    if (map.cover[k] || busy.has(k) || x < 1 || y < 1 || x >= S - 1 || y >= S - 1) continue;
    if (map.terrain[k] !== 2) continue;
    wet.push(k);
    if (DIRS8.some(([dx, dy]) => inBounds(map, x + dx, y + dy) && map.terrain[(y + dy) * S + x + dx] !== 2
      && map.cover[(y + dy) * S + x + dx] === 0)) shore.push(k);
  }
  const order = (arr) => arr.map((k) => [hash32(state.seed, 0xb0a7, k), k]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
  const picked = [];
  for (const [pool, gap] of [[shore, 12], [shore, 6], [wet, 6], [wet, 2]]) {
    for (const k of order(pool)) {
      if (picked.length >= want) break;
      if (picked.includes(k)) continue;
      if (picked.some((p) => dist(p % S, (p / S) | 0, k % S, (k / S) | 0) < gap)) continue;
      picked.push(k);
    }
  }
  // Bone-dry map: carve a slipway near the edge (where the tide comes in first).
  for (let i = 0; picked.length < 2 && i < 400; i++) {
    const h = hash32(state.seed, 0x51b, i);
    const side = h % 4, along = 3 + ((h >>> 4) % (S - 6));
    const [x, y] = [[along, 1], [S - 2, along], [along, S - 2], [1, along]][side];
    const k = y * S + x;
    if (map.cover[k] || busy.has(k) || picked.includes(k)) continue;
    map.terrain[k] = 2;
    picked.push(k);
  }
  for (const k of picked) {
    state.vehicles.push({
      id: state.nextVehicleId++, kind: 'boat', x: k % S, y: (k / S) | 0,
      hp: BOAT.hp, maxHp: BOAT.hp, fuel: BOAT.fuel, maxFuel: BOAT.maxFuel, seats: [],
    });
  }
  syncBlockers(state);
}

// ---------- queries ----------

/** Can `u` board `v` right now? Returns an error string or null. */
export function boardError(state, u, v) {
  if (!v) return 'No boat';
  if (!standing(u)) return 'Downed';
  if (u.vehicle != null) return 'Already aboard';
  if (u.ap < 1) return 'No AP';
  if (chebyshev(u, v) !== 1) return 'Not adjacent';
  if (v.seats.length >= BOAT.seats) return 'Boat full';
  const enemyAboard = v.seats.some((id) => state.units[id].alive && state.units[id].team !== u.team);
  if (enemyAboard) return 'Enemy aboard';
  // No corner cutting onto the boat (same rule as walking).
  const S = S_(state);
  const dx = v.x - u.x, dy = v.y - u.y;
  if (dx && dy && (state.map.cover[u.y * S + v.x] > 0 || state.map.cover[v.y * S + u.x] > 0)) return 'Blocked';
  return null;
}

/** Boat tiles `u` can board now (Set of tile keys). */
export function boardTargets(state, u) {
  const out = new Set();
  for (const v of state.vehicles || []) if (!boardError(state, u, v)) out.add(v.y * S_(state) + v.x);
  return out;
}

/** Water tiles a boat can reach this turn: Map<tileKey, {d, prev}> (8 directions, no corner cutting). */
export function boatReach(state, v, maxSteps = BOAT.reach) {
  const { map } = state;
  const S = map.size;
  const occ = new Set();
  for (const o of state.units) if (o.alive && o.vehicle !== v.id) occ.add(o.y * S + o.x);
  for (const w of state.vehicles || []) if (w !== v) occ.add(w.y * S + w.x);
  for (const t of state.sentries || []) occ.add(t.y * S + t.x);
  const start = v.y * S + v.x;
  const res = new Map([[start, { d: 0, prev: -1 }]]);
  const q = [start];
  while (q.length) {
    const k = q.shift();
    const d = res.get(k).d;
    if (d >= maxSteps) continue;
    const x = k % S, y = (k / S) | 0;
    for (const [dx, dy] of DIRS8) {
      const nx = x + dx, ny = y + dy;
      const nk = ny * S + nx;
      if (res.has(nk) || occ.has(nk) || !navigable(state, nx, ny)) continue;
      if (dx && dy && (map.cover[y * S + nx] > 0 || map.cover[ny * S + x] > 0)) continue;
      res.set(nk, { d: d + 1, prev: k });
      q.push(nk);
    }
  }
  return res;
}

/** Driver: tiles the boat can move to now (Set of keys); empty if `u` can't drive. */
export function boatMoveTargets(state, u) {
  const out = new Set();
  const v = vehicleOf(state, u);
  if (!v || driverOf(state, v) !== u || u.ap < 1 || v.fuel < 1 || u.moveOnly) return out;
  for (const [k, n] of boatReach(state, v)) if (n.d > 0) out.add(k);
  return out;
}

/** Engineer: boats it can repair now (Set of vehicle ids). */
export function repairTargets(state, u) {
  const out = new Set();
  if (u.cls !== 'engineer' || !standing(u) || u.ap < 1 || u.moveOnly || u.vehicle != null) return out;
  for (const v of state.vehicles || []) {
    if (chebyshev(u, v) === 1 && (v.hp < v.maxHp || v.fuel < v.maxFuel)) out.add(v.id);
  }
  return out;
}

// ---------- state changes ----------

/** Put `u` aboard `v` (no checks). */
export function embark(state, u, v, events) {
  u.x = v.x; u.y = v.y;
  v.seats.push(u.id);
  u.vehicle = v.id;
  u.tideImmune = true;
  u.overwatch = false;
  events.push({ type: 'board', id: u.id, vehicle: v.id, x: v.x, y: v.y, seat: v.seats.length - 1 });
}

/** Take `u` off its boat. Its position is left as is unless (x,y) is given. */
export function disembark(state, u, events, { x, y, forced = false, vehicle } = {}) {
  const v = vehicle || vehicleOf(state, u);
  u.vehicle = null;
  u.tideImmune = false;
  if (!v) return;
  v.seats = v.seats.filter((id) => id !== u.id);
  if (x !== undefined) { u.x = x; u.y = y; }
  const ev = { type: 'disembark', id: u.id, vehicle: v.id, x: u.x, y: u.y };
  if (forced) ev.forced = true;
  events.push(ev);
}

/** Nearest tile a swimmer can be dropped on (prefers water). */
function dropTile(state, x0, y0, taken) {
  const S = S_(state);
  const busy = new Set(taken);
  for (const o of state.units) if (o.alive) busy.add(o.y * S + o.x);
  for (const v of state.vehicles || []) busy.add(v.y * S + v.x);
  for (const t of state.sentries || []) busy.add(t.y * S + t.x);
  let best = null;
  for (let r = 1; r < 8 && !best; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = x0 + dx, y = y0 + dy;
        if (!inBounds(state.map, x, y)) continue;
        const k = y * S + x;
        if (state.map.cover[k] || busy.has(k)) continue;
        const score = dist(x, y, x0, y0) + (isWaterTile(state, k) ? 0 : 0.6);
        if (!best || score < best.score) best = { x, y, score };
      }
    }
  }
  return best;
}

export function damageVehicle(state, v, dmg, source, by, events) {
  if (!state.vehicles.includes(v) || dmg <= 0) return;
  v.hp = Math.max(0, v.hp - dmg);
  events.push({ type: 'vehicle_damage', id: v.id, dmg, hp: v.hp, source });
  if (v.hp <= 0) destroyVehicle(state, v, by, events);
}

export function destroyVehicle(state, v, by, events) {
  state.vehicles = state.vehicles.filter((w) => w !== v);
  syncBlockers(state);
  events.push({ type: 'vehicle_destroyed', id: v.id, x: v.x, y: v.y });
  const crew = v.seats.map((id) => state.units[id]).filter((m) => m && m.alive);
  const taken = [];
  for (const m of crew) {
    const t = dropTile(state, v.x, v.y, [...taken, v.y * S_(state) + v.x]);
    if (t) taken.push(t.y * S_(state) + t.x);
    disembark(state, m, events, t ? { x: t.x, y: t.y, forced: true, vehicle: v } : { forced: true, vehicle: v });
  }
  v.seats = [];
  for (const m of crew) {
    if (state.winner !== null) return;
    if (m.alive) hurt(state, m, blastDmgFor(m, BOAT.blast, 'boat'), 'boat', by, events);
  }
}

// ---------- actions (registered on game.js ACTIONS) ----------

function actBoatMove(state, u, a) {
  const v = vehicleOf(state, u);
  if (!v) return fail('Not aboard');
  if (driverOf(state, v) !== u) return fail('Not the driver');
  if (u.ap < 1) return fail('No AP');
  if (v.fuel < 1) return fail('No fuel');
  if (!Number.isInteger(a.x) || !Number.isInteger(a.y)) return fail('Unreachable');
  const S = S_(state);
  const reach = boatReach(state, v);
  const key = a.y * S + a.x;
  const node = reach.get(key);
  if (!node || node.d === 0) return fail('Unreachable');
  const path = [];
  for (let k = key; k !== -1; k = reach.get(k).prev) path.push([k % S, (k / S) | 0]);
  path.reverse();
  v.x = a.x; v.y = a.y;
  v.fuel--;
  for (const id of v.seats) { const m = state.units[id]; m.x = v.x; m.y = v.y; }
  u.ap = 0; // the driver's whole turn
  u.moved = true;
  u.runGun = false;
  syncBlockers(state);
  const events = [{ type: 'boat_move', id: v.id, driver: u.id, path, fuel: v.fuel }];
  // Engine noise carries.
  noise(state, u, events, 'engine');
  return { events };
}

function actRepair(state, u, a) {
  if (u.cls !== 'engineer') return fail('Engineer only');
  if (u.ap < 1) return fail('No AP');
  if (u.vehicle != null) return fail('Get ashore to repair');
  const v = a.vehicleId !== undefined ? vehicleById(state, a.vehicleId)
    : (state.vehicles || []).find((w) => chebyshev(u, w) === 1);
  if (!v || chebyshev(u, v) !== 1) return fail('No boat in reach');
  if (v.hp >= v.maxHp && v.fuel >= v.maxFuel) return fail('Nothing to repair');
  u.ap--;
  v.hp = Math.min(v.maxHp, v.hp + BOAT.repairHp);
  v.fuel = Math.min(v.maxFuel, v.fuel + BOAT.repairFuel);
  return { events: [{ type: 'repair', id: u.id, vehicle: v.id, hp: v.hp, fuel: v.fuel }] };
}

function actBoard(state, u, a) {
  const v = a.vehicleId !== undefined ? vehicleById(state, a.vehicleId) : vehicleAt(state, a.x, a.y);
  const err = boardError(state, u, v);
  if (err) return fail(err);
  u.ap--;
  u.moved = true;
  const events = [];
  embark(state, u, v, events);
  return { events };
}

export const VEHICLE_ACTIONS = { boat_move: actBoatMove, repair: actRepair, board: actBoard };

/** Shot preview against a boat: {chance, dmg} or null. */
export function vehicleShotPreview(state, u, v) {
  if (!v || !standing(u) || v.seats.some((id) => state.units[id].team === u.team)) return null;
  if (dist(u.x, u.y, v.x, v.y) > weaponRange(u) || !los(state.map, u.x, u.y, v.x, v.y)) return null;
  if (!teamSeesTile(state, u.team, v.x, v.y)) return null;
  const { chance } = hitChance(state, u, { x: v.x, y: v.y, team: -2, armor: 0, hunkered: false });
  return { chance, dmg: [...u.weapon.dmg] };
}

/** Fire at a boat (ammo / AP handled by the caller). */
export function shootVehicle(state, u, v, events) {
  const { chance } = vehicleShotPreview(state, u, v) || { chance: 0 };
  const result = nextRoll(state) * 100 < chance ? 'hit' : 'miss';
  let dmg = 0;
  if (result === 'hit') dmg = u.weapon.dmg[0] + Math.floor(nextRoll(state) * (u.weapon.dmg[1] - u.weapon.dmg[0] + 1)) + (u.mods?.barrel || 0);
  events.push({ type: 'shot_vehicle', from: u.id, vehicle: v.id, result, dmg, chance });
  flare(state, u, events);
  noise(state, u, events);
  if (dmg) damageVehicle(state, v, dmg, 'shot', u, events);
}

// ---------- hooks ----------

HOOKS.onBlast.push((state, tiles, dmg, by, events) => {
  if (!state.vehicles || !state.vehicles.length) return;
  for (const v of [...state.vehicles]) {
    if (tiles.some(([x, y]) => x === v.x && y === v.y)) damageVehicle(state, v, dmg, 'blast', by, events);
  }
});

HOOKS.onDeath.push((state, u, killer, events) => {
  if (u.vehicle != null) disembark(state, u, events);
});

// A crewed boat out in the tide takes a beating at the end of its driver's squad turn.
TURN_HOOKS.teamEnd.push((state, team, events) => {
  if (!state.vehicles || !state.vehicles.length) return;
  for (const v of [...state.vehicles]) {
    const d = driverOf(state, v) || state.units[v.seats[0]];
    if (!d || d.team !== team || inZone(state, v.x, v.y)) continue;
    damageVehicle(state, v, ZONE.damage + Math.floor(state.round / 5), 'tide', null, events);
    if (state.winner !== null) return;
  }
});
