// Tidefall 5.0 battlefield layer (SIM-2): boats, stage events, building collapse, the Pit,
// streak points, and the AI that uses them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, act, endTeamTurn, activeTeams, isTeamActive, aliveTeams, moveOptions, streakInfo, abilityInfo,
  pitDuels, resolvePitBots, settlePit, duelUnitFor, createDuelState, playDuel, PIT, boardTargets, boatMoveTargets,
  repairTargets, dangerTiles, STAGE_EVENT, BOAT, navigable,
} from '../src/sim/game.js';
import { botTakeTurn } from '../src/sim/ai.js';
import { hitChance } from '../src/sim/rules.js';
import { setCover as coreSetCover, STREAK_POINTS } from '../src/sim/core.js';
import { syncBlockers, damageVehicle } from '../src/sim/vehicles.js';
import { planStageEvent } from '../src/sim/stageevents.js';
import { STAGE_KEYS, MODES } from '../src/sim/constants.js';
import { arena, S, cycleTo, cycleLog, only } from './helpers.js';

const sureShot = (u) => { u.weapon.aim = 300; };
const key = (x, y) => y * S + x;
const types = (evs) => evs.map((e) => e.type);
const water = (s, x, y) => { s.map.terrain[y * S + x] = 2; };
const boat = (s, x, y, extra = {}) => {
  const v = { id: s.vehicles.length, kind: 'boat', x, y, hp: 12, maxHp: 12, fuel: 3, maxFuel: 4, seats: [], ...extra };
  s.vehicles.push(v);
  water(s, x, y);
  syncBlockers(s);
  return v;
};

function simulate(opts) {
  const state = createGame(opts);
  const log = [...state.startEvents];
  let guard = 0;
  while (state.winner === null && guard++ < 6000) {
    const t = activeTeams(state)[0];
    for (const id of state.teams[t].members) log.push(...botTakeTurn(state, id));
    log.push(...endTeamTurn(state, t));
  }
  return { state, log };
}

// ---------- boats ----------

test('boats: 2–3 per map on shoreline water, 12 HP, 3 fuel, 4 seats; deterministic', () => {
  for (const stage of STAGE_KEYS) {
    for (const seed of [1, 2, 3]) {
      const s = createGame({ seed, stage, mode: 'duos', noHuman: true });
      assert.ok(s.vehicles.length >= 2 && s.vehicles.length <= 3, `${stage}/${seed}: ${s.vehicles.length}`);
      for (const v of s.vehicles) {
        assert.equal(v.kind, 'boat');
        assert.equal(v.hp, BOAT.hp); assert.equal(v.fuel, 3); assert.deepEqual(v.seats, []);
        assert.equal(s.map.terrain[key(v.x, v.y)], 2, 'on water');
        assert.equal(s.map.cover[key(v.x, v.y)], 0);
        assert.ok(!s.units.some((u) => u.x === v.x && u.y === v.y));
        assert.ok(s.blockers.includes(key(v.x, v.y)), 'boats block walking');
      }
      const again = createGame({ seed, stage, mode: 'duos', noHuman: true });
      assert.deepEqual(again.vehicles, s.vehicles);
    }
  }
});

test('boarding: move onto an adjacent boat (1 AP), needs a free seat; walking through is blocked', () => {
  const { s, a, b } = arena({ me: [5, 5], mate: [5, 7], foes: [[30, 30], [35, 35]] });
  const v = boat(s, 6, 5);
  assert.ok(!moveOptions(s, b).has(key(6, 5)), 'not a walkable tile');
  assert.equal(act(s, b.id, { type: 'move', x: 6, y: 5 }).error, 'Not adjacent');
  assert.deepEqual([...boardTargets(s, a)], [key(6, 5)]);
  assert.ok(abilityInfo(a, s).some((x) => x.key === 'board' && x.ready));
  const r = act(s, a.id, { type: 'move', x: 6, y: 5 });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.events, [{ type: 'board', id: a.id, vehicle: v.id, x: 6, y: 5, seat: 0 }]);
  assert.equal(a.vehicle, v.id); assert.equal(a.x, 6); assert.equal(a.ap, 1); assert.ok(a.tideImmune);
  assert.deepEqual(v.seats, [a.id]);
  // Full boat.
  b.x = 6; b.y = 6;
  v.seats.push(a.id, a.id, a.id);
  assert.equal(act(s, b.id, { type: 'board', vehicleId: v.id }).error, 'Boat full');
  v.seats = [a.id];
  const r2 = act(s, b.id, { type: 'board', vehicleId: v.id });
  assert.ok(r2.ok, r2.error);
  assert.equal(r2.events[0].seat, 1);
});

test('boat_move: the driver sails ≤8 water tiles for 1 AP + the whole turn and 1 fuel; everyone aboard moves', () => {
  const { s, a, b, es } = arena({ me: [5, 5], mate: [5, 6], foes: [[30, 30], [35, 35]] });
  for (let x = 6; x <= 25; x++) water(s, x, 5);
  const v = boat(s, 6, 5);
  act(s, a.id, { type: 'move', x: 6, y: 5 });
  act(s, b.id, { type: 'move', x: 6, y: 5 });
  assert.equal(act(s, b.id, { type: 'boat_move', x: 10, y: 5 }).error, 'Not the driver');
  assert.equal(act(s, a.id, { type: 'boat_move', x: 6, y: 9 }).error, 'Unreachable', 'dry land');
  assert.ok(boatMoveTargets(s, a).has(key(14, 5)));
  assert.ok(!boatMoveTargets(s, a).has(key(15, 5)), '9 tiles is too far');
  const r = act(s, a.id, { type: 'boat_move', x: 14, y: 5 });
  assert.ok(r.ok, r.error);
  const ev = r.events.find((e) => e.type === 'boat_move');
  assert.equal(ev.id, v.id); assert.equal(ev.driver, a.id); assert.equal(ev.path.length, 9); assert.equal(ev.fuel, 2);
  assert.deepEqual([v.x, v.y, a.x, a.y, b.x, b.y], [14, 5, 14, 5, 14, 5]);
  assert.equal(a.ap, 0, 'whole turn');
  assert.ok(s.blockers.includes(key(14, 5)) && !s.blockers.includes(key(6, 5)));
  // The tide floods dry ground: outside the safe zone the boat can sail over it.
  s.zone.r = 3; s.zone.x = 40; s.zone.y = 40;
  assert.ok(navigable(s, 14, 9));
  cycleTo(s, a.team);
  v.fuel = 0;
  assert.equal(act(s, a.id, { type: 'boat_move', x: 14, y: 9 }).error, 'No fuel');
  v.fuel = 1;
  assert.ok(act(s, a.id, { type: 'boat_move', x: 14, y: 9 }).ok);
  void es;
});

test('aboard: half cover against every shot, no tide damage; a crewed boat in the tide takes hull damage', () => {
  const { s, a, es } = arena({ mode: 'solos', me: [5, 5], foes: [[5, 12], [35, 35]] });
  const v = boat(s, 6, 5);
  assert.equal(hitChance(s, es[0], a).cover, 0);
  act(s, a.id, { type: 'move', x: 6, y: 5 });
  const hc = hitChance(s, es[0], a);
  assert.equal(hc.cover, 1);
  assert.ok(hc.notes.includes('Aboard a boat'));
  s.zone.r = 3; s.zone.x = 40; s.zone.y = 40; // everyone in the tide
  const log = endTeamTurn(s, a.team);
  assert.ok(!log.some((e) => e.type === 'zone_damage' && e.id === a.id), 'tide-immune aboard');
  const hull = log.find((e) => e.type === 'vehicle_damage' && e.id === v.id);
  assert.ok(hull && hull.source === 'tide' && v.hp < 12);
});

test('boat destroyed at 0 HP: 3 damage to everyone aboard, dropped into the water; boats are shootable', () => {
  const { s, a, es } = arena({ me: [5, 5], foes: [[6, 12], [35, 35]] });
  water(s, 7, 5);
  const v = boat(s, 6, 5);
  act(s, a.id, { type: 'move', x: 6, y: 5 });
  cycleTo(s, es[0].team);
  only(s, es[0].team);
  sureShot(es[0]);
  v.hp = 1;
  const r = act(s, es[0].id, { type: 'shoot', vehicleId: v.id });
  assert.ok(r.ok, r.error);
  const t = types(r.events);
  assert.ok(t.indexOf('shot_vehicle') < t.indexOf('vehicle_damage'));
  assert.ok(t.indexOf('vehicle_destroyed') < t.indexOf('disembark'));
  const off = r.events.find((e) => e.type === 'disembark');
  assert.ok(off.forced);
  assert.equal(r.events.find((e) => e.type === 'damage' && e.id === a.id).dmg, 3);
  assert.equal(a.hp, a.maxHp - 3);
  assert.equal(a.vehicle, null); assert.ok(!a.tideImmune);
  assert.deepEqual([a.x, a.y], [7, 5], 'dropped into the nearest water');
  assert.equal(s.vehicles.length, 0);
  assert.ok(!s.blockers.includes(key(6, 5)));
});

test('blasts hit boats; Engineer repairs an adjacent boat (+4 HP, +1 fuel, 1 AP)', () => {
  const { s, a, b } = arena({ me: [5, 5, 'assault'], mate: [12, 12, 'engineer'], foes: [[30, 30], [35, 35]] });
  const v = boat(s, 10, 5);
  const r = act(s, a.id, { type: 'grenade', x: 10, y: 5 });
  assert.ok(r.ok, r.error);
  const d = r.events.find((e) => e.type === 'vehicle_damage');
  assert.equal(d.source, 'blast'); assert.equal(v.hp, 12 - d.dmg);
  assert.equal(act(s, a.id, { type: 'repair', vehicleId: v.id }).error, 'Engineer only');
  assert.equal(act(s, b.id, { type: 'repair', vehicleId: v.id }).error, 'No boat in reach');
  b.x = 11; b.y = 6;
  v.hp = 5; v.fuel = 0;
  assert.ok(repairTargets(s, b).has(v.id));
  const rp = act(s, b.id, { type: 'repair', vehicleId: v.id });
  assert.ok(rp.ok, rp.error);
  assert.deepEqual(rp.events, [{ type: 'repair', id: b.id, vehicle: v.id, hp: 9, fuel: 1 }]);
  assert.equal(b.ap, 1);
  assert.ok(abilityInfo(b, s).some((x) => x.key === 'repair'));
});

test('disembark: any move from aboard steps off the boat', () => {
  const { s, a } = arena({ me: [5, 5], foes: [[30, 30], [35, 35]] });
  const v = boat(s, 6, 5);
  act(s, a.id, { type: 'move', x: 6, y: 5 });
  const r = act(s, a.id, { type: 'move', x: 7, y: 6 });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.events[0], { type: 'disembark', id: a.id, vehicle: v.id, x: 6, y: 5 });
  assert.equal(r.events[1].type, 'move');
  assert.equal(a.vehicle, null); assert.deepEqual(v.seats, []);
});

// ---------- stage events ----------

/** Arena on a stage with its event warned next round and fired the round after. */
function staged(stage, extra = {}) {
  const res = arena({ mode: 'solos', stage, me: [3, 3], foes: [[40, 3], [3, 40]], ...extra });
  planStageEvent(res.s);
  Object.assign(res.s.stageEvent, { round: res.s.round + 2, warnRound: res.s.round + 1 });
  const warn = cycleLog(res.s, res.a.team).find((e) => e.type === 'stage_event_warn');
  return { ...res, warn };
}

test('stage events: one per match per stage, telegraphed a round before with its tiles', () => {
  for (const stage of STAGE_KEYS) {
    const s = createGame({ seed: 5, stage, noHuman: true });
    assert.equal(s.stageEvent.kind, STAGE_EVENT[stage].kind);
    assert.ok(s.stageEvent.round >= 6 && s.stageEvent.round <= 8);
    assert.equal(s.stageEvent.warnRound, s.stageEvent.round - 1);
  }
  const { s, warn } = staged('kelp');
  assert.ok(warn, 'warned');
  assert.equal(warn.kind, 'redtide'); assert.equal(warn.round, s.round + 1);
  assert.ok(warn.tiles.length > 0);
  assert.ok(dangerTiles(s).has(key(...warn.tiles[0])), 'warned tiles are danger for the AI');
});

test('harbor: a ship ploughs a lane: 4 damage, shoved out, cover flattened, containers left behind', () => {
  const { s, a, warn } = staged('harbor');
  const lane = new Set(warn.tiles.map(([x, y]) => key(x, y)));
  const [tx, ty] = warn.tiles[6];
  a.x = tx; a.y = ty;
  const [cx, cy] = warn.tiles[12];
  s.map.cover[key(cx, cy)] = 2;
  const log = cycleLog(s, a.team);
  const ev = log.find((e) => e.type === 'stage_event');
  assert.equal(ev.kind, 'ship');
  assert.equal(log.find((e) => e.type === 'damage' && e.id === a.id).dmg, 4);
  assert.ok(log.some((e) => e.type === 'knockback' && e.id === a.id));
  assert.ok(!lane.has(key(a.x, a.y)), 'out of the lane');
  assert.equal(s.map.cover[key(cx, cy)] === 0 || log.some((e) => e.type === 'cover_change' && e.x === cx && e.y === cy && e.to === 0), true);
  assert.ok(log.some((e) => e.type === 'cover_change' && e.to === 2), 'containers');
});

test('kelp: red tide does 2 damage per turn in the band for 2 rounds, then clears', () => {
  const { s, a, warn } = staged('kelp');
  [a.x, a.y] = warn.tiles[Math.floor(warn.tiles.length / 2)];
  const hp0 = a.hp;
  let log = cycleLog(s, a.team); // event fires at round start; damage at the end of my turn
  assert.ok(log.some((e) => e.type === 'stage_event' && e.kind === 'redtide'));
  log = cycleLog(s, a.team);
  const hits = log.filter((e) => e.type === 'damage' && e.id === a.id && e.source === 'redtide');
  assert.equal(hits.length, 1); assert.equal(hits[0].dmg, 2);
  log = cycleLog(s, a.team);
  assert.ok(log.some((e) => e.type === 'damage' && e.id === a.id && e.source === 'redtide'));
  assert.ok(log.some((e) => e.type === 'stage_event_end' && e.kind === 'redtide'));
  log = cycleLog(s, a.team);
  assert.ok(!log.some((e) => e.type === 'damage' && e.id === a.id));
  assert.equal(a.hp, hp0 - 4);
});

test('rig: a platform section collapses into water (terrain_change), 2 damage on it', () => {
  const { s, a, warn } = staged('rig');
  [a.x, a.y] = warn.tiles[0];
  const [bx, by] = warn.tiles[3];
  s.map.cover[key(bx, by)] = 1; s.map.explosive[key(bx, by)] = 1;
  const log = cycleLog(s, a.team);
  assert.ok(log.some((e) => e.type === 'stage_event' && e.kind === 'collapse'));
  assert.equal(log.find((e) => e.type === 'damage' && e.id === a.id).dmg, 2);
  for (const [x, y] of warn.tiles) {
    assert.equal(s.map.terrain[key(x, y)], 2);
    assert.equal(s.map.cover[key(x, y)], 0);
  }
  assert.ok(log.some((e) => e.type === 'terrain_change' && e.to === 2));
});

test('spire: a tower topples; water on its line becomes a walkable bridge, dry ground rubble half cover', () => {
  const res = arena({ mode: 'solos', stage: 'spire', me: [3, 3], foes: [[40, 3], [3, 40]] });
  const { s, a } = res;
  // A 2×2 tower at (20,20) and a channel of water east of it.
  const walls = [key(20, 20), key(21, 20), key(20, 21), key(21, 21)];
  for (const k of walls) { s.map.cover[k] = 2; s.map.building[k] = 0; }
  s.map.buildings = [{ id: 0, kind: 'tower', x0: 20, y0: 20, w: 2, h: 2, walls, floor: [], collapsed: false }];
  for (let x = 24; x <= 29; x++) water(s, x, 21);
  planStageEvent(s);
  Object.assign(s.stageEvent, { round: s.round + 2, warnRound: s.round + 1 });
  const warn = cycleLog(s, a.team).find((e) => e.type === 'stage_event_warn');
  assert.deepEqual(warn.tiles[0], [22, 21], 'falls east, over the water');
  a.x = 23; a.y = 21;
  const log = cycleLog(s, a.team);
  assert.ok(log.some((e) => e.type === 'stage_event' && e.kind === 'topple'));
  for (const k of walls) assert.equal(s.map.cover[k], 0, 'the tower is gone');
  assert.equal(log.find((e) => e.type === 'damage' && e.id === a.id).dmg, 4);
  assert.ok(log.some((e) => e.type === 'knockback' && e.id === a.id));
  for (let x = 24; x <= 29; x++) {
    assert.equal(s.map.terrain[key(x, 21)], 0, 'bridge deck');
    assert.equal(s.map.cover[key(x, 21)], 0);
  }
  assert.equal(s.map.cover[key(22, 21)], 1, 'rubble on dry ground');
  assert.ok(log.some((e) => e.type === 'terrain_change' && e.to === 0));
});

test('surge: a rogue wave hits a band for 3 and knocks units 2 tiles inland', () => {
  const { s, a, warn } = staged('surge');
  const side = s.stageEvent.side;
  const [dx, dy] = [[1, 0], [-1, 0], [0, 1], [0, -1]][side];
  // A tile in the middle of the band with room inland.
  const t = warn.tiles.find(([x, y]) => (side <= 1 ? y === 20 : x === 20));
  [a.x, a.y] = t;
  const [x0, y0] = [a.x, a.y];
  const log = cycleLog(s, a.team);
  assert.ok(log.some((e) => e.type === 'stage_event' && e.kind === 'wave'));
  assert.equal(log.find((e) => e.type === 'damage' && e.id === a.id).dmg, 3);
  const kb = log.find((e) => e.type === 'knockback' && e.id === a.id);
  assert.equal(kb.path.length, 3);
  assert.deepEqual([a.x, a.y], [x0 + dx * 2, y0 + dy * 2]);
});

// ---------- building collapse ----------

test('building collapse: 40% of the walls gone → the rest drops to rubble, 3 damage inside', () => {
  const { s, a, es } = arena({ mode: 'solos', me: [3, 3], foes: [[12, 12], [35, 35]] });
  const walls = [], floor = [];
  for (let y = 10; y <= 14; y++) for (let x = 10; x <= 14; x++) {
    const k = key(x, y);
    s.map.building[k] = 0;
    if (x === 10 || x === 14 || y === 10 || y === 14) { s.map.cover[k] = 2; walls.push(k); } else floor.push(k);
  }
  s.map.buildings = [{ id: 0, kind: 'building', x0: 10, y0: 10, w: 5, h: 5, walls, floor, collapsed: false }];
  const events = [];
  const need = Math.ceil(walls.length * 0.4); // 7 of 16
  for (let i = 0; i < need - 1; i++) coreSetCover(s, walls[i] % S, (walls[i] / S) | 0, 1, events);
  assert.ok(!events.some((e) => e.type === 'building_collapse'));
  coreSetCover(s, walls[need - 1] % S, (walls[need - 1] / S) | 0, 0, events);
  const c = events.find((e) => e.type === 'building_collapse');
  assert.ok(c);
  assert.equal(c.id, 0); assert.equal(c.tiles.length, walls.length - need);
  for (const k of walls) assert.ok(s.map.cover[k] < 2);
  assert.equal(events.find((e) => e.type === 'damage' && e.id === es[0].id).dmg, 3);
  assert.ok(!events.some((e) => e.type === 'damage' && e.id === a.id));
  assert.ok(s.map.buildings[0].collapsed);
});

test('building ids come from map generation (towers on Night Spires)', () => {
  const s = createGame({ seed: 9, stage: 'spire', noHuman: true });
  assert.ok(s.map.building instanceof Int16Array);
  const live = s.map.buildings.filter((b) => !b.collapsed);
  assert.ok(live.some((b) => b.kind === 'building') && live.some((b) => b.kind === 'tower'));
  for (const b of live) for (const k of b.walls) assert.equal(s.map.building[k], b.id);
});

// ---------- the Pit ----------

const pitArena = (mode = 'solos', foes = [[5, 8], [6, 8]]) => arena({ mode, pit: true, me: [5, 5], foes });

test('Pit: a real death up to round 8 queues you; two queued fight a 9×9 pistol + 1 frag duel', () => {
  const { s, a, es } = pitArena();
  sureShot(a);
  es[0].hp = 1;
  let r = act(s, a.id, { type: 'shoot', targetId: es[0].id });
  assert.ok(r.events.some((e) => e.type === 'pit_enter' && e.id === es[0].id));
  assert.ok(!r.events.some((e) => e.type === 'team_out'), 'held, not out');
  assert.deepEqual(s.pit.queue, [es[0].id]);
  a.ap = 2; es[1].hp = 1;
  r = act(s, a.id, { type: 'shoot', targetId: es[1].id });
  const pd = r.events.find((e) => e.type === 'pit_duel');
  assert.deepEqual(pd, { type: 'pit_duel', duelId: 0, a: es[0].id, b: es[1].id, warden: false });
  assert.equal(s.winner, null, 'the match waits for the Pit');
  const [duel] = pitDuels(s);
  const ds = duel.state;
  assert.equal(ds.map.size, PIT.size);
  assert.equal(ds.units.length, 2);
  for (const u of ds.units) {
    assert.equal(u.weapon.id, 'pistol'); assert.equal(u.items.frag, 1); assert.equal(u.weapons[1], null);
  }
  assert.equal(duelUnitFor(duel, es[0].id).srcId, es[0].id);
  assert.equal(duelUnitFor(duel, es[1].id).srcId, es[1].id);
  assert.ok(activeTeams(ds).length > 0, 'the duel is a live mini game');
});

test('Pit: bot duels resolve between steps; the winner redeploys next round with 6 HP and half a magazine', () => {
  const { s, a, es } = pitArena();
  sureShot(a);
  es[0].hp = 1; act(s, a.id, { type: 'shoot', targetId: es[0].id });
  a.ap = 2; es[1].hp = 1; act(s, a.id, { type: 'shoot', targetId: es[1].id });
  const log = cycleLog(s, a.team);
  const res = log.find((e) => e.type === 'pit_result');
  assert.ok(res, 'resolved');
  const t = types(log);
  assert.ok(t.indexOf('pit_result') < t.indexOf('redeploy'));
  assert.ok(t.indexOf('round_start') < t.indexOf('redeploy'), 'redeploys at the next round start');
  const w = s.units[res.winner], l = s.units[res.loser];
  const rd = log.find((e) => e.type === 'redeploy');
  assert.equal(rd.id, w.id);
  assert.ok(w.alive && !w.inPit); assert.equal(w.hp, 6);
  assert.equal(w.weapon, w.weapons[0]); assert.equal(w.ammo, Math.ceil(w.weapon.mag / 2));
  assert.deepEqual([w.x, w.y], [rd.x, rd.y]);
  assert.ok(!l.alive);
  assert.ok(log.some((e) => e.type === 'team_out' && e.team === l.team), 'the loser is out');
  assert.ok(s.order.includes(w.team) && aliveTeams(s).includes(w.team));
  assert.ok(t.indexOf('redeploy') < t.indexOf('engagement'), 'back in before contact is planned');
});

test('Pit: alone in the queue at round end → the Pit Warden', () => {
  const { s, a, es } = pitArena();
  sureShot(a);
  es[0].hp = 1; act(s, a.id, { type: 'shoot', targetId: es[0].id });
  const log = cycleLog(s, a.team);
  const pd = log.find((e) => e.type === 'pit_duel');
  assert.equal(pd.warden, true); assert.equal(pd.b, null);
  const res = log.find((e) => e.type === 'pit_result');
  assert.ok(res.warden);
  assert.ok(res.winner === es[0].id || res.loser === es[0].id);
  assert.equal(s.pit.duels[0].state.units[1].name, 'Pit Warden');
});

test('Pit: only real deaths, only up to round 8, once per match; team modes need a standing squadmate', () => {
  // Downed is not dead.
  const d = arena({ mode: 'duos', pit: true, me: [5, 5], foes: [[5, 8], [30, 30], [6, 9]] });
  sureShot(d.a);
  d.es[0].hp = 1;
  let r = act(d.s, d.a.id, { type: 'shoot', targetId: d.es[0].id });
  assert.ok(d.es[0].downed && !r.events.some((e) => e.type === 'pit_enter'));
  d.a.ap = 2;
  r = act(d.s, d.a.id, { type: 'shoot', targetId: d.es[0].id });
  assert.ok(r.events.some((e) => e.type === 'pit_enter' && e.id === d.es[0].id), 'executed with a squadmate up');
  // The last of a squad: nobody to come back to.
  d.a.ap = 2; d.es[2].hp = 1;
  r = act(d.s, d.a.id, { type: 'shoot', targetId: d.es[2].id });
  assert.ok(!r.events.some((e) => e.type === 'pit_enter'));
  // Too late.
  const late = pitArena();
  late.s.round = PIT.lastRound + 1;
  sureShot(late.a); late.es[0].hp = 1;
  r = act(late.s, late.a.id, { type: 'shoot', targetId: late.es[0].id });
  assert.ok(!r.events.some((e) => e.type === 'pit_enter'));
  assert.ok(r.events.some((e) => e.type === 'team_out'));
});

test('Pit: a human duel is run by the controller on duel.state; settlePit hands the result back', () => {
  const { s, a, es } = pitArena();
  const me = es[0];
  me.isHuman = true; me.isPlayer = true;
  sureShot(a);
  me.hp = 1; act(s, a.id, { type: 'shoot', targetId: me.id });
  let log = cycleLog(s, a.team);
  const pd = log.find((e) => e.type === 'pit_duel');
  assert.ok(pd && pd.warden);
  assert.ok(!log.some((e) => e.type === 'pit_result'), 'never auto-played');
  const duel = pitDuels(s)[0];
  assert.ok(duel.human);
  const ds = duel.state;
  const mine = duelUnitFor(duel, me.id);
  mine.weapon.aim = 300;
  ds.units[1].hp = 1;
  let guard = 0;
  while (ds.winner === null && guard++ < 50) {
    for (const t of activeTeams(ds)) {
      if (t === mine.team) {
        const warden = ds.units[1];
        if (warden.alive) act(ds, mine.id, { type: 'shoot', targetId: warden.id });
      } else for (const id of ds.teams[t].members) botTakeTurn(ds, id);
      if (ds.winner === null) endTeamTurn(ds, t);
    }
  }
  assert.equal(ds.winner, mine.team);
  const res = settlePit(s);
  assert.deepEqual(res, [{ type: 'pit_result', duelId: duel.id, winner: me.id, loser: null, warden: true, rounds: ds.round }]);
  assert.equal(pitDuels(s).length, 0);
  log = cycleLog(s, a.team);
  assert.ok(log.some((e) => e.type === 'redeploy' && e.id === me.id));
  assert.ok(me.alive && me.hp === 6);
});

test('Pit: resolvePitBots({humans:true}) auto-plays a human duel (controllers without a Pit screen)', () => {
  const { s, a, es } = pitArena();
  es[0].isHuman = true;
  sureShot(a);
  es[0].hp = 1; act(s, a.id, { type: 'shoot', targetId: es[0].id });
  cycleLog(s, a.team);
  assert.equal(pitDuels(s).length, 1);
  assert.deepEqual(resolvePitBots(s), []);
  const evs = resolvePitBots(s, { humans: true });
  assert.equal(evs[0].type, 'pit_result');
  assert.equal(pitDuels(s).length, 0);
});

test('Pit duels always finish: the arena floods', () => {
  const s = createGame({ seed: 4, noHuman: true });
  for (let i = 0; i < 12; i++) {
    const ds = createDuelState(s, s.units[i], i % 3 ? s.units[i + 1] : null, i);
    playDuel(ds);
    assert.notEqual(ds.winner, null);
    assert.ok(ds.round <= 12, `duel ${i} lasted ${ds.round} rounds`);
  }
});

// ---------- streak points ----------

test('streak points: kill +2, down +1, assist +1 (same round, ally finishes), streak_ready on crossing a cost', () => {
  assert.deepEqual(STREAK_POINTS, { kill: 2, down: 1, assist: 1, revive: 1 });
  const { s, a, b, es } = arena({ mode: 'duos', me: [5, 5, 'assault', { streaks: ['uav', 'care', 'gunship'] }], mate: [6, 5], foes: [[5, 9], [30, 30], [30, 33]] });
  sureShot(a); sureShot(b);
  // a chips, b downs: b +1 (down), a +1 (assist).
  es[0].hp = 20;
  act(s, a.id, { type: 'shoot', targetId: es[0].id });
  es[0].hp = 1;
  let r = act(s, b.id, { type: 'shoot', targetId: es[0].id });
  assert.ok(es[0].downed);
  assert.ok(r.events.some((e) => e.type === 'streak_points' && e.id === b.id && e.reason === 'down' && e.add === 1));
  assert.ok(r.events.some((e) => e.type === 'streak_points' && e.id === a.id && e.reason === 'assist'));
  assert.equal(a.points, 1); assert.equal(b.points, 1);
  // a finishes it: kill +2 → 3 → UAV ready (b already had its assist? no: b downed it and gets one when a finishes).
  a.ap = 2;
  r = act(s, a.id, { type: 'shoot', targetId: es[0].id });
  assert.ok(r.events.some((e) => e.type === 'streak_points' && e.id === a.id && e.reason === 'kill' && e.add === 2 && e.total === 3));
  assert.ok(r.events.some((e) => e.type === 'streak_ready' && e.id === a.id && e.key === 'uav'));
  assert.ok(r.events.some((e) => e.type === 'streak_points' && e.id === b.id && e.reason === 'assist'));
  assert.equal(b.points, 2);
  const info = streakInfo(s, a);
  assert.equal(info[0].points, 3); assert.equal(info[0].kills, 1); assert.ok(info[0].ready);
  assert.ok(info[1].ready); // care (3) is ready at 3 points
  assert.equal(info[2].reason, '3 more points'); // gunship costs 6
  // Damage from an earlier round is no assist.
  es[2].x = 6; es[2].y = 9; es[2].hp = 20;
  a.ap = 2;
  act(s, a.id, { type: 'shoot', targetId: es[2].id });
  cycleTo(s, a.team);
  es[2].hp = 1;
  r = act(s, b.id, { type: 'shoot', targetId: es[2].id });
  assert.ok(!r.events.some((e) => e.type === 'streak_points' && e.id === a.id));
});

// ---------- AI ----------

test('AI moves out of a telegraphed airstrike line / stage event', () => {
  const { s, a, es } = arena({ me: [10, 10], foes: [[30, 30], [35, 35]] });
  s.airstrikes.push({ id: 9, team: es[0].team, owner: es[0].id, tiles: [[7, 10], [8, 10], [9, 10], [10, 10], [11, 10], [12, 10], [13, 10]], round: s.round + 1 });
  botTakeTurn(s, a.id);
  assert.notEqual(a.y, 10);
});

test('AI: stranded in the tide, a bot boards the boat alongside and sails for the circle', () => {
  const { s, a } = arena({ mode: 'solos', me: [5, 5], foes: [[40, 40], [41, 38]] });
  Object.assign(s.zone, { x: 34, y: 34, r: 8, next: 4, nx: 34, ny: 34 });
  const v = boat(s, 6, 6);
  const evs = botTakeTurn(s, a.id);
  assert.ok(evs.some((e) => e.type === 'board' && e.id === a.id), types(evs).join(','));
  assert.ok(evs.some((e) => e.type === 'boat_move' && e.id === v.id));
  assert.ok(Math.hypot(v.x - 34, v.y - 34) < Math.hypot(6 - 34, 6 - 34));
});

test('AI: an Engineer repairs a damaged boat when it is quiet', () => {
  const { s, b } = arena({ me: [3, 3], mate: [10, 9, 'engineer'], foes: [[40, 40], [41, 38]] });
  const v = boat(s, 10, 10, { hp: 4, fuel: 0 });
  const evs = botTakeTurn(s, b.id);
  assert.ok(evs.some((e) => e.type === 'repair' && e.vehicle === v.id), types(evs).join(','));
});

test('bot matches use the battlefield layer and stay deterministic', () => {
  const count = {};
  for (const stage of STAGE_KEYS) {
    const { log } = simulate({ seed: 7919, stage, mode: 'duos', noHuman: true });
    for (const e of log) count[e.type] = (count[e.type] || 0) + 1;
    assert.equal(log.filter((e) => e.type === 'stage_event').length, 1, `${stage}: one stage event`);
    assert.ok(log.some((e) => e.type === 'stage_event_warn'));
  }
  for (const k of ['pit_enter', 'pit_duel', 'pit_result', 'redeploy', 'building_collapse', 'terrain_change', 'streak_points', 'streak_ready']) {
    assert.ok(count[k] > 0, `bots never produced ${k}`);
  }
  const x = simulate({ seed: 31, stage: 'rig', mode: 'trios', noHuman: true });
  const y = simulate({ seed: 31, stage: 'rig', mode: 'trios', noHuman: true });
  assert.deepEqual(y.log, x.log);
  assert.deepEqual(y.state.pit.duels.map((d) => [d.winner, d.loser, d.state.round]), x.state.pit.duels.map((d) => [d.winner, d.loser, d.state.round]));
  void MODES; void isTeamActive; void damageVehicle;
});
