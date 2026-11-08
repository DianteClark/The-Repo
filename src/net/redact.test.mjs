// Redaction tests: no hidden information may reach a client.
// Run: node --test src/net/redact.test.mjs   (or: node src/net/redact.test.mjs)

import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../sim/game.js';
import * as AI from '../sim/ai.js';
import * as Rules from '../sim/rules.js';
import { teamView, createTeamMemory, redactSnapshot, filterEvents, vision, PARK } from './redact.js';
import { encode, decode } from './wire.js';
import { turnModel, runBotStep } from '../client/match/turns.js';

const ENEMY_KEYS = new Set(['id', 'team', 'cls', 'name', 'isLoneWolf', 'isHuman', 'x', 'y', 'hp', 'maxHp', 'armor', 'alive', 'downed', 'bleed',
  'overwatch', 'hunkered', 'suppressed', 'flashed', 'smoked', 'aboard', 'vehicle', 'skin', 'cosmetics', 'flared', 'pit', 'inPit', 'redeployed',
  'boat', 'weapon', 'hidden', 'isPlayer', 'slot', 'slowed', 'suppressedBy', 'tracked']);
const PRIVATE_WEAPON = ['reserve', 'ammo', 'mag_left', 'aim', 'dmg'];
const CRATE_LOOKS = new Set(['crate', 'cache', 'gold', 'care']);

function game(mode = 'duos', seed = 1234, stage = 'harbor') { return G.createGame({ mode, seed, stage, noHuman: true }); }

/** Every invariant a redacted snapshot must hold for `team`. */
function checkSnap(state, snap, team, mem, label) {
  for (const k of ['seed', 'rollCounter', 'zonePlan', 'startEvents', 'noises']) assert.equal(snap[k], undefined, `${label}: ${k} leaked`);
  for (const k of ['claymores', 'decoys', 'drops']) {
    for (const o of snap[k] || []) assert.equal(o.team ?? state.units[o.owner]?.team, team, `${label}: another squad's ${k} leaked`);
  }
  const spectator = state.eliminated.includes(team) || !state.teams[team].members.some((id) => state.units[id].alive);
  for (const u of state.units) {
    const s = snap.units[u.id];
    assert.ok(s, `${label}: unit ${u.id} missing`);
    if (u.team === team) { assert.equal(s.x, u.x); continue; }
    for (const k of Object.keys(s)) assert.ok(ENEMY_KEYS.has(k), `${label}: enemy unit ${u.id} leaks field ${k}`);
    if (s.weapon) for (const k of PRIVATE_WEAPON) assert.equal(s.weapon[k], undefined, `${label}: enemy weapon.${k} leaked`);
    if (spectator) continue;
    const seen = u.alive ? Rules.teamSeesUnit(state, team, u) : vision(state, team).tile(u.x, u.y);
    if (!seen) {
      assert.equal(s.hidden, true, `${label}: unseen unit ${u.id} not hidden`);
      assert.equal(s.x, PARK, `${label}: hidden unit ${u.id} x leaked`);
      assert.equal(s.y, PARK, `${label}: hidden unit ${u.id} y leaked`);
      assert.equal(s.downed, false, `${label}: hidden unit ${u.id} downed state leaked`);
      if (u.alive) assert.equal(s.hp, u.maxHp, `${label}: hidden unit ${u.id} hp leaked`);
    } else {
      assert.ok(!s.hidden, `${label}: visible unit ${u.id} marked hidden`);
      assert.equal(s.x, u.x);
    }
  }
  for (const c of snap.crates) {
    assert.ok(CRATE_LOOKS.has(c.type), `${label}: crate ${c.id} contents leaked (${c.type})`);
    for (const k of Object.keys(c)) assert.ok(['id', 'x', 'y', 'type', 'taken', 'dropped'].includes(k), `${label}: crate field ${k}`);
  }
  for (const r of snap.reveals || []) assert.equal(r.team, team, `${label}: another squad's scan leaked`);
  if (!spectator) {
    for (const v of snap.vehicles || []) {
      for (const id of v.seats || []) assert.ok(state.units[id].team === team || Rules.teamSeesUnit(state, team, state.units[id]), `${label}: unseen boat passenger ${id} leaked`);
      const live = state.vehicles.find((b) => b.id === v.id);
      if (live && !vision(state, team).tile(live.x, live.y) && !live.seats.some((id) => state.units[id].team === team)) {
        assert.equal(v.seats.length, 0, `${label}: unseen boat seats leaked`);
        assert.equal(v.fuel, undefined, `${label}: unseen boat fuel leaked`);
      }
    }
    if (state.stageEvent?.status === 'planned') assert.deepEqual(snap.stageEvent, { status: 'planned' }, `${label}: planned stage event leaked`);
    for (const k of snap.blockers || []) {
      const S = state.map.size;
      assert.ok(vision(state, team).tile(k % S, (k / S) | 0) || (snap.vehicles || []).some((b) => b.y * S + b.x === k), `${label}: blocker ${k} leaks a hidden object`);
    }
    if (snap.pit) for (const d of snap.pit.duels || []) if (d.state) assert.ok(state.units[d.a]?.team === team || state.units[d.b]?.team === team, `${label}: someone else's duel state leaked`);
  }
  if (!spectator && snap.turn) for (const g of snap.turn.groups || []) assert.ok(g.includes(team), `${label}: foreign engagement group in state.turn`);
  if (!spectator) {
    // Cover: every tile the team can't see now matches its memory, never the live map.
    const S = state.map.size;
    const vis = vision(state, team);
    for (let k = 0; k < S * S; k++) {
      if (vis.tile(k % S, (k / S) | 0)) assert.equal(snap.map.cover[k], state.map.cover[k], `${label}: visible cover stale`);
      else assert.equal(snap.map.cover[k], mem.cover[k]);
    }
  }
  // No object anywhere in the snapshot carries a hidden unit's real position.
  const hiddenIds = new Set(snap.units.filter((u) => u.hidden).map((u) => u.id));
  (function walk(o, path) {
    if (!o || typeof o !== 'object' || ArrayBuffer.isView(o)) return;
    if (Array.isArray(o)) { o.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (path.startsWith('.units[') && hiddenIds.has(o.id)) assert.equal(o.x, PARK, `${label}: ${path} leaks`);
    for (const k of Object.keys(o)) walk(o[k], `${path}.${k}`);
  })(snap, '');
}

function checkEvents(state, evs, team, label) {
  const mine = (id) => state.units[id]?.team === team;
  const spectator = state.eliminated.includes(team) || !state.teams[team].members.some((id) => state.units[id].alive);
  for (const e of evs) {
    for (const k of ['loadout', 'perks', 'streaks', 'items', 'seed']) assert.equal(e[k], undefined, `${label}: event ${e.type}.${k}`);
    if (e.type === 'crate' && !mine(e.id)) for (const k of ['item', 'weapon', 'attachment']) assert.equal(e[k], undefined, `${label}: enemy crate pickup ${k} leaked`);
    if (e.type === 'noise' && !mine(e.id) && !(state.decoys || []).some((d) => d.team === team && d.x === e.x && d.y === e.y)) { assert.ok(!('id' in e), `${label}: noise carries an id (decoy tell)`); assert.equal(spectator || (e.x - 1) % 3 === 0 || e.x === state.map.size - 1, true); }
    if (['claymore', 'decoy', 'decoy_end', 'care_package_called', 'tracked'].includes(e.type) && !spectator) assert.ok(mine(e.id) || e.team === team || e.type === 'decoy_end', `${label}: ${e.type} leaked`);
    if (e.type === 'streak_points') assert.ok(mine(e.id), `${label}: streak_points leaked`);
    if (e.type === 'boat_move' && !spectator) assert.equal(e.fuel === undefined || state.vehicles.find((b) => b.id === e.id)?.seats.some((id) => mine(id)) || mine(e.driver), true, `${label}: enemy boat fuel leaked`);
    if (spectator) continue;
    if (e.type === 'scan') for (const id of e.revealed || []) assert.ok(mine(e.id) || mine(id), `${label}: scan reveals another squad's contacts`);
    if (e.type === 'reveal_end') assert.equal(e.team, team);
    if (e.crate && typeof e.crate === 'object') assert.ok(CRATE_LOOKS.has(e.crate.type), `${label}: crate contents in ${e.type}`);
    if (e.type === 'engagement') for (const g of e.groups) assert.ok(g.includes(team), `${label}: foreign engagement group leaked`);
  }
}

test('wire encode/decode round-trips typed arrays', () => {
  const s = game();
  const back = decode(JSON.parse(JSON.stringify(encode({ map: s.map, n: 1, m: new Map([[1, 'a']]) }))));
  assert.ok(back.map.cover instanceof Uint8Array);
  assert.deepEqual([...back.map.cover], [...s.map.cover]);
  assert.equal(back.m.get(1), 'a');
});

test('initial snapshot hides every unseen enemy, strips seed and privates', () => {
  const s = game('duos', 77);
  for (let team = 0; team < s.teams.length; team++) {
    const mem = createTeamMemory(s, team);
    const { snap } = teamView(s, [], mem, { myUnitId: s.teams[team].members[0] });
    checkSnap(s, snap, team, mem, `t${team} start`);
    assert.equal(snap.units[s.teams[team].members[0]].isPlayer, true);
    const hidden = snap.units.filter((u) => u.hidden).length;
    assert.ok(hidden > 0, 'someone should be hidden at the start');
    // my own squad keeps its private data
    assert.ok(snap.units[s.teams[team].members[0]].items, 'own items kept');
  }
});

test('enemy movement in fog is never sent; unseen gunfire becomes a coarse ping', () => {
  const s = game('solos', 5);
  const team = 0;
  const mem = createTeamMemory(s, team);
  const me = s.units[s.teams[0].members[0]];
  const S = s.map.size;
  // Pick an enemy that team 0 can't see and fake a move + shot far away.
  const foe = s.units.find((u) => u.team !== team && !Rules.teamSeesUnit(s, team, u));
  const victim = s.units.find((u) => u.team !== team && u.team !== foe.team && !Rules.teamSeesUnit(s, team, u));
  const from = [foe.x, foe.y];
  const to = [foe.x + (foe.x < S - 2 ? 1 : -1), foe.y];
  const evs = [
    { type: 'move', id: foe.id, path: [from, to] },
    { type: 'shot', from: foe.id, to: victim.id, result: 'hit', dmg: 3, chance: 70 },
    { type: 'noise', id: foe.id, x: to[0], y: to[1], kind: 'gunfire' },
    { type: 'crate', id: foe.id, crate: 0, item: 'medkit' },
    { type: 'damage', id: victim.id, dmg: 2, by: foe.id },
    { type: 'scan', id: foe.id, x: 3, y: 3, radius: 5, revealed: [victim.id] },
    { type: 'death', id: victim.id, by: foe.id },
    { type: 'reveal_end', team: foe.team },
    { type: 'engagement', groups: [[foe.team, victim.team], [team, 99]], free: [] },
  ];
  // Final state after the fake move
  foe.x = to[0]; foe.y = to[1];
  const visible = Rules.teamSeesUnit(s, team, foe);
  const out = filterEvents(s, evs, team, { mem });
  checkEvents(s, out, team, 'fog');
  if (!visible) {
    assert.ok(!out.some((e) => e.type === 'move'), 'fogged move leaked');
    const ping = out.find((e) => e.type === 'noise');
    assert.ok(ping, 'gunfire ping expected');
    assert.ok((ping.x - 1) % 3 === 0 || ping.x === s.map.size - 1, 'ping is on the 3-grid');
    assert.ok(!('id' in ping), 'ping is anonymous');
    assert.ok(!out.some((e) => e.type === 'shot'), 'fogged shot leaked');
    assert.ok(!out.some((e) => e.type === 'damage'), 'fogged damage leaked');
    assert.ok(!out.some((e) => e.type === 'crate'), 'fogged pickup leaked');
    assert.ok(!out.some((e) => e.type === 'scan'), 'foreign scan leaked');
  }
  assert.ok(out.some((e) => e.type === 'death'), 'deaths are public (kill feed)');
  assert.equal(out.find((e) => e.type === 'engagement').groups.length, 1);
  void me;
});

test('a move that crosses into view is trimmed to the visible tiles', () => {
  const s = game('solos', 9);
  const team = 0;
  const me = s.units[s.teams[0].members[0]];
  const foe = s.units.find((u) => u.team !== team);
  const S = s.map.size;
  // Line the foe up to walk towards me along a row through open ground, from far away.
  const row = me.y;
  const path = [];
  for (let x = 0; x < S; x++) if (!s.map.cover[row * S + x] && Math.abs(x - me.x) > 1) path.push([x, row]);
  const far = path.filter(([x]) => x < me.x).slice(-14);
  if (far.length < 6) return; // map-dependent: skip
  foe.x = far[far.length - 1][0]; foe.y = row;
  const out = filterEvents(s, [{ type: 'move', id: foe.id, path: far }], team);
  for (const e of out) {
    assert.equal(e.type, 'move');
    for (const p of e.path) assert.ok(vision(s, team, new Map([[foe.id, p]])).unit(foe.id, p), `tile ${p} sent but not visible`);
  }
});

test('cover destroyed in fog is remembered, then discovered when seen', () => {
  const s = game('solos', 11);
  const team = 0;
  const mem = createTeamMemory(s, team);
  const S = s.map.size;
  const vis = vision(s, team);
  let k = -1;
  for (let i = 0; i < S * S; i++) if (s.map.cover[i] && !vis.tile(i % S, (i / S) | 0)) { k = i; break; }
  assert.ok(k >= 0);
  const x = k % S, y = (k / S) | 0;
  const old = s.map.cover[k];
  s.map.cover[k] = 0;
  let r = teamView(s, [{ type: 'cover_change', x, y, from: old, to: 0 }], mem, {});
  assert.ok(!r.events.some((e) => e.type === 'cover_change'), 'fogged cover change leaked');
  assert.equal(r.snap.map.cover[k], old, 'snapshot leaked fogged cover');
  // Walk my unit next to it: the change is discovered.
  const me = s.units[s.teams[0].members[0]];
  me.x = Math.min(S - 1, x + 1); me.y = y;
  if (s.map.cover[me.y * S + me.x]) me.x = Math.max(0, x - 1);
  r = teamView(s, [], mem, {});
  if (vision(s, team).tile(x, y)) {
    assert.ok(r.events.some((e) => e.type === 'cover_change' && e.discovered && e.x === x && e.y === y), 'discovered change expected');
    assert.equal(r.snap.map.cover[k], 0);
  }
});

test('full bot matches: every batch, every team, no leaks (and JSON-safe)', () => {
  for (const [mode, seed, stage] of [['solos', 3, 'harbor'], ['duos', 42, 'kelp'], ['quads', 7, 'spire'], ['trios', 99, 'rig']]) {
    const s = G.createGame({ mode, seed, stage, noHuman: true });
    const model = turnModel(G);
    const mems = s.teams.map((t) => createTeamMemory(s, t.id));
    let batches = 0;
    const view = (evs, label) => {
      batches++;
      for (const mem of mems) {
        const team = mem.team;
        const r = teamView(s, evs, mem, { myUnitId: s.teams[team].members[0] });
        // every 7th batch do the full (slow) checks for every team; always for team 0
        if (team === 0 || batches % 7 === 0) {
          checkSnap(s, r.snap, team, mem, `${mode}/${label}/t${team}`);
          checkEvents(s, r.events, team, `${mode}/${label}/t${team}`);
          JSON.stringify(encode(r));
        }
      }
    };
    view(s.startEvents || [], 'start');
    let guard = 0;
    while (s.winner === null && guard++ < 2000) {
      runBotStep(G, AI, s, model, (evs) => view(evs, `r${s.round}`));
    }
    assert.notEqual(s.winner, null, `${mode} match ended`);
    assert.ok(batches > 20);
  }
});

test('decoys: the fake gunfire looks exactly like real gunfire to opponents; traps stay secret', () => {
  const s = game('solos', 31);
  const team = 0;
  const foe = s.units.find((u) => u.team !== team && !Rules.teamSeesUnit(s, team, u));
  s.decoys.push({ id: 9, team: foe.team, owner: foe.id, x: 10, y: 10, untilRound: 3 });
  s.claymores.push({ id: 4, team: foe.team, owner: foe.id, x: 11, y: 10 });
  s.drops.push({ x: 12, y: 12, crate: { id: 99, type: 'care', weapon: 'maw' }, team: foe.team });
  const mem = createTeamMemory(s, team);
  const evs = [
    { type: 'decoy', id: foe.id, x: 10, y: 10, decoyId: 9 },
    { type: 'noise', id: null, x: 10, y: 10, kind: 'gunfire' },
    { type: 'claymore', id: foe.id, x: 11, y: 10, claymoreId: 4, radius: 1.5 },
    { type: 'noise', id: foe.id, x: foe.x, y: foe.y, kind: 'gunfire' },
    { type: 'decoy_end', decoyId: 9 },
  ];
  const r = teamView(s, evs, mem, {});
  const noises = r.events.filter((e) => e.type === 'noise');
  assert.equal(noises.length, 2);
  for (const n of noises) assert.deepEqual(Object.keys(n).sort(), ['kind', 'type', 'x', 'y']);
  assert.ok(!r.events.some((e) => ['decoy', 'claymore', 'decoy_end'].includes(e.type)));
  assert.deepEqual(r.snap.claymores, []);
  assert.deepEqual(r.snap.decoys, []);
  assert.deepEqual(r.snap.drops, []);
  // the owner sees its own
  const mine = teamView(s, evs, createTeamMemory(s, foe.team), {});
  assert.ok(mine.events.some((e) => e.type === 'decoy') && mine.events.some((e) => e.type === 'decoy_end'));
  assert.equal(mine.snap.claymores.length, 1);
});

test('crate contents (weapon, attachment) never reach a client', () => {
  const s = game('solos', 8);
  s.crates[0].type = 'gold'; s.crates[0].weapon = 'tidebreaker'; s.crates[1].attachment = 'optic_x';
  const snap = redactSnapshot(s, 0, createTeamMemory(s, 0), {});
  assert.equal(JSON.stringify(snap.crates).includes('tidebreaker'), false);
  assert.equal(JSON.stringify(snap.crates).includes('optic_x'), false);
  assert.equal(snap.crates.find((c) => c.id === 0).type, 'gold');
});

test('boats: enemy crews and fuel stay hidden; unseen boats stay where last seen', () => {
  const s = game('duos', 3);
  const team = 0;
  const mem = createTeamMemory(s, team);
  const boat = s.vehicles[0];
  assert.ok(boat, 'harbor has boats');
  const foe = s.units.find((u) => u.team !== team && !Rules.teamSeesUnit(s, team, u));
  const start = [boat.x, boat.y];
  boat.seats.push(foe.id);
  const path = [start, [start[0], start[1]]];
  boat.fuel = 1;
  const r = teamView(s, [{ type: 'board', id: foe.id, vehicle: boat.id, x: boat.x, y: boat.y, seat: 0 },
    { type: 'boat_move', id: boat.id, driver: foe.id, path, fuel: 1 }, { type: 'streak_points', id: foe.id, add: 1, total: 3 }], mem, {});
  const sv = r.snap.vehicles.find((v) => v.id === boat.id);
  if (!vision(s, team).tile(boat.x, boat.y)) {
    assert.deepEqual(sv.seats, []);
    assert.equal(sv.fuel, undefined);
    assert.deepEqual([sv.x, sv.y], start);
    assert.ok(!r.events.some((e) => e.type === 'board' || e.type === 'boat_move'));
  }
  assert.ok(!r.events.some((e) => e.type === 'streak_points'), 'streak points are private');
  // the owner sees its points
  const own = teamView(s, [{ type: 'streak_points', id: foe.id, add: 1, total: 3 }], createTeamMemory(s, foe.team), {});
  assert.equal(own.events.length, 1);
});

test('stage events: planned ones are secret until the warning; warnings and tiles are public', () => {
  const s = game('solos', 3, 'harbor');
  assert.ok(s.stageEvent);
  const snap = redactSnapshot(s, 0, createTeamMemory(s, 0), {});
  assert.deepEqual(snap.stageEvent, { status: 'planned' });
  const evs = filterEvents(s, [{ type: 'stage_event_warn', kind: 'ship', name: 'X', tiles: [[1, 1]], round: 6 }, { type: 'terrain_change', x: 40, y: 40, from: 0, to: 2 }, { type: 'building_collapse', id: 1, tiles: [[2, 2]] }], 0);
  assert.equal(evs.length, 3);
});

test('the Pit: only my own duel state is sent, redacted from my side', () => {
  const s = game('solos', 4);
  const a = s.units[s.teams[0].members[0]], b = s.units[s.teams[1].members[0]], c = s.units[s.teams[2].members[0]];
  const duelState = game('solos', 9);
  s.pit = { enabled: true, queue: [c.id], duels: [
    { id: 0, a: a.id, b: b.id, units: { [a.id]: 0, [b.id]: 1 }, state: duelState, done: false, winner: null },
    { id: 1, a: c.id, b: null, warden: true, units: { [c.id]: 0 }, state: game('solos', 10), done: false },
  ], held: [], redeploys: [], nextDuelId: 2 };
  const snap = redactSnapshot(s, 0, createTeamMemory(s, 0), { myUnitId: a.id });
  assert.ok(snap.pit.duels[0].state, 'my duel state is sent');
  assert.equal(snap.pit.duels[1].state, undefined, "another duel's state is not");
  assert.equal(snap.pit.duels[0].state.seed, undefined);
  assert.deepEqual(snap.pit.queue, []);
});

test('spectators (eliminated squads) see positions but never private loadouts', () => {
  const s = game('solos', 21);
  const out = s.units[s.teams[3].members[0]];
  out.alive = false; out.hp = 0;
  s.eliminated.push(3);
  const snap = redactSnapshot(s, 3, createTeamMemory(s, 3), {});
  for (const u of s.units) {
    if (u.team === 3) continue;
    assert.equal(snap.units[u.id].x, u.x);
    assert.equal(snap.units[u.id].items, undefined);
  }
});
