import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, act, endTeamTurn, currentTeamId, isTeamActive, shotPreview, moveOptions, insideZone, insideNextZone,
  barrelTargets, barrelPreview, grenadePreview, aliveTeams,
} from '../src/sim/game.js';
import { botTakeTurn } from '../src/sim/ai.js';
import { generateMap } from '../src/sim/map.js';
import { hitChance, teamSeesUnit, canSeeTile, concealment, isFlared } from '../src/sim/rules.js';
import { STAGES, STAGE_KEYS, MODES, KELP, SMOKE, BARREL } from '../src/sim/constants.js';
import { arena, S, setCover, cycleTo } from './helpers.js';

const sureShot = (u) => { u.weapon.aim = 300; };
const key = (x, y) => y * S + x;
const setTerrain = (s, x, y, t) => { s.map.terrain[key(x, y)] = t; };
const barrel = (s, x, y) => { s.map.cover[key(x, y)] = 1; s.map.explosive[key(x, y)] = 1; };

function simulate(opts) {
  const state = createGame(opts);
  const log = [...state.startEvents];
  let guard = 0;
  while (state.winner === null && guard++ < 4000) {
    const t = currentTeamId(state);
    for (const id of state.teams[t].members) log.push(...botTakeTurn(state, id));
    log.push(...endTeamTurn(state));
  }
  return { state, log };
}

// ---------- stages & maps ----------

test('STAGES: five stages with the documented fields; createGame stores the stage', () => {
  assert.deepEqual(STAGE_KEYS, ['harbor', 'kelp', 'rig', 'spire', 'surge']);
  for (const k of STAGE_KEYS) {
    const st = STAGES[k];
    assert.equal(st.key, k);
    for (const f of ['name', 'tagline', 'twist']) assert.equal(typeof st[f], 'string', `${k}.${f}`);
    assert.equal(st.size, 44);
    const s = createGame({ seed: 3, stage: k });
    assert.equal(s.stage, k);
    assert.equal(s.map.size, 44);
    assert.ok(s.map.terrain instanceof Uint8Array && s.map.terrain.length === 44 * 44);
    assert.ok(s.map.explosive instanceof Uint8Array && s.map.explosive.length === 44 * 44);
  }
  assert.equal(createGame({ seed: 3 }).stage, 'harbor', 'default');
  const r1 = createGame({ seed: 12, stage: 'random' }), r2 = createGame({ seed: 12, stage: 'random' });
  assert.ok(STAGE_KEYS.includes(r1.stage));
  assert.equal(r1.stage, r2.stage, 'random is seeded');
  const picks = new Set();
  for (let seed = 1; seed < 40; seed++) picks.add(createGame({ seed, stage: 'random', noHuman: true }).stage);
  assert.equal(picks.size, 5);
});

test('stage-specific generation: kelp beds, fuel drums, night sight, deterministic', () => {
  for (const k of STAGE_KEYS) {
    assert.deepEqual(generateMap(9, 44, k).cover, generateMap(9, 44, k).cover, k);
    assert.deepEqual(generateMap(9, 44, k).terrain, generateMap(9, 44, k).terrain, k);
  }
  const kelp = generateMap(5, 44, 'kelp');
  let open = 0, kelpN = 0;
  for (let i = 0; i < 44 * 44; i++) if (!kelp.cover[i]) { open++; if (kelp.terrain[i] === 1) kelpN++; }
  assert.ok(kelpN / open > 0.12 && kelpN / open < 0.18, `kelp ${kelpN / open}`);
  assert.ok(kelp.terrain.every((t, i) => t === 0 || kelp.cover[i] === 0), 'terrain only on open ground');
  const rig = generateMap(5, 44, 'rig');
  const drums = [...rig.explosive.keys()].filter((i) => rig.explosive[i]);
  assert.ok(drums.length > 15);
  assert.ok(drums.every((i) => rig.cover[i] === 1), 'drums are half cover');
  assert.equal(generateMap(5, 44, 'spire').sight, 6);
  for (const k of ['harbor', 'spire', 'surge']) {
    const m = generateMap(5, 44, k);
    assert.ok(!m.terrain.some((t) => t === 1), `${k} has no kelp`);
    assert.ok(!m.explosive.some((e) => e), `${k} has no drums`);
  }
  // Harbor is the hard-cover stage, kelp the open one.
  const full = (m) => m.cover.reduce((n, c) => n + (c === 2), 0);
  assert.ok(full(generateMap(5, 44, 'harbor')) > full(kelp) * 1.5);
});

test('shallow water costs 2 movement', () => {
  const { s, a } = arena({ me: [5, 5], foes: [[30, 30]] });
  a.move = 4; a.ap = 1;
  for (let x = 6; x <= 12; x++) setTerrain(s, x, 5, 2);
  for (let y = 0; y < S; y++) for (const x of [5]) if (y !== 5) setCover(s, x, y, 2); // only east is open
  setCover(s, 4, 5, 2); setCover(s, 4, 4, 2); setCover(s, 4, 6, 2);
  for (let x = 6; x <= 12; x++) { setCover(s, x, 4, 2); setCover(s, x, 6, 2); } // a water corridor
  const reach = moveOptions(s, a);
  assert.equal(reach.get(key(6, 5)).d, 2);
  assert.equal(reach.get(key(7, 5)).d, 4);
  assert.ok(!reach.has(key(8, 5)), '3 water tiles is 6 movement: too far');
});

// ---------- kelp ----------

test('kelp: hidden beyond 3 tiles, -10 aim, no cover, scan still reveals', () => {
  const { s, a, b, es } = arena({ mode: 'duos', stage: 'kelp', me: [5, 5], mate: [30, 30, 'recon'], foes: [[5, 10]] });
  const t = es[0];
  setTerrain(s, 5, 10, 1);
  assert.equal(concealment(s, 5, 10).by, 'kelp');
  assert.ok(!teamSeesUnit(s, a.team, t), '5 tiles away: hidden');
  assert.equal(shotPreview(s, a, t), null, 'cannot target what you cannot see');
  a.y = 7; // 3 tiles
  assert.ok(teamSeesUnit(s, a.team, t));
  const inKelp = hitChance(s, a, t);
  setTerrain(s, 5, 10, 0);
  const out = hitChance(s, a, t);
  assert.equal(out.chance - inKelp.chance, KELP.aim);
  assert.equal(inKelp.cover, 0, 'kelp is not cover');
  assert.ok(inKelp.notes.some((n) => n.startsWith('Kelp')));
  // Kelp is passable.
  setTerrain(s, 5, 8, 1);
  assert.ok(moveOptions(s, a).has(key(5, 8)));
  // Scan sees through it.
  setTerrain(s, 5, 10, 1);
  a.y = 5;
  b.x = 10; b.y = 12; b.cls = 'recon'; b.cooldowns.scan = 0;
  cycleTo(s, a.team);
  assert.ok(!teamSeesUnit(s, a.team, t));
  const r = act(s, b.id, { type: 'scan', x: 5, y: 10 });
  assert.ok(r.ok, r.error);
  assert.ok(teamSeesUnit(s, a.team, t));
});

// ---------- smoke rework ----------

test('smoke hides units from enemies further than 1.5 tiles; adjacent enemies still see in', () => {
  // The cloud sits on (6,9); our unit is at its edge (6,10).
  const { s, a, b, es } = arena({ me: [5, 5, 'recon'], mate: [6, 10], foes: [[6, 14]] });
  const e = es[0];
  assert.ok(teamSeesUnit(s, e.team, b));
  act(s, a.id, { type: 'smoke', x: 6, y: 9 });
  assert.ok(!teamSeesUnit(s, e.team, b), 'hidden in smoke at 4 tiles');
  assert.equal(shotPreview(s, e, b), null, 'and cannot be targeted');
  e.x = 7; e.y = 11; // diagonal to the smoked unit, itself outside the cloud
  assert.ok(teamSeesUnit(s, e.team, b));
  assert.ok(shotPreview(s, e, b));
  const into = hitChance(s, e, b);
  assert.ok(into.notes.includes('Target in smoke -' + SMOKE.aimIn));
  // Firing out of smoke costs aim too.
  const outOf = hitChance(s, b, e);
  assert.ok(outOf.notes.includes('Firing from smoke -' + SMOKE.aimOut));
  s.smokes = [];
  assert.equal(hitChance(s, b, e).chance - outOf.chance, SMOKE.aimOut);
  assert.equal(hitChance(s, e, b).chance - into.chance, SMOKE.aimIn);
});

test('smoke: moving through it does not trigger overwatch from afar; scan still reveals', () => {
  const { s, a, b, es } = arena({ me: [5, 5, 'recon'], mate: [8, 10], foes: [[8, 16]] });
  const e = es[0];
  sureShot(e);
  e.overwatch = true;
  act(s, a.id, { type: 'smoke', x: 8, y: 10 });
  // b steps within the cloud: hidden from the overwatcher 5+ tiles away.
  const r = act(s, b.id, { type: 'move', x: 8, y: 11 });
  assert.ok(r.ok, r.error);
  assert.ok(!r.events.some((ev) => ev.type === 'overwatch_trigger'));
  assert.ok(e.overwatch, 'overwatch still primed');
  // A scan reveals smoked units.
  s.reveals.push({ team: e.team, x: 8, y: 11, radius: 5, ids: [b.id] });
  assert.ok(teamSeesUnit(s, e.team, b));
});

// ---------- barrels ----------

test('barrels: a frag sets off a drum within 1.5; drums chain; damage, cover and events', () => {
  const { s, a, b, es } = arena({ stage: 'rig', me: [5, 5], mate: [30, 30], foes: [[10, 9], [13, 9], [20, 20]] });
  barrel(s, 11, 9); barrel(s, 12, 9); // a pair of drums: the second chains
  setCover(s, 13, 10, 2);
  const p = grenadePreview(s, a, 10, 8);
  assert.deepEqual(p.barrels, [{ x: 11, y: 9 }, { x: 12, y: 9 }]);
  const e0 = p.units.find((h) => h.id === es[0].id), e1 = p.units.find((h) => h.id === es[1].id);
  assert.equal(e0.dmg, 3 + 4, 'frag + first drum');
  assert.equal(e1.dmg, 4, 'second drum only');
  const r = act(s, a.id, { type: 'grenade', x: 10, y: 8 });
  assert.ok(r.ok, r.error);
  const types = r.events.map((e) => e.type);
  const b1 = types.indexOf('barrel');
  assert.deepEqual(r.events[b1], { type: 'barrel', x: 11, y: 9 });
  assert.ok(types.lastIndexOf('barrel') > b1, 'chain reaction');
  const drumDmg = r.events.filter((e) => e.type === 'damage' && e.source === 'barrel');
  assert.ok(drumDmg.some((e) => e.id === es[1].id && e.dmg === 4 && e.by === a.id));
  assert.equal(es[0].hp, es[0].maxHp - 7);
  assert.equal(s.map.cover[key(11, 9)], 0);
  assert.equal(s.map.explosive[key(11, 9)], 0);
  assert.equal(s.map.explosive[key(12, 9)], 0);
  assert.equal(s.map.cover[key(13, 10)], 1, 'the drum blast knocks nearby cover down a level');
  assert.ok(r.events.some((e) => e.type === 'cover_change' && e.x === 12 && e.y === 9 && e.to === 0));
  assert.ok(b.alive && b.hp === b.maxHp);
});

test('shoot_barrel: 1 AP, ends the turn, needs range and line of sight, always detonates', () => {
  const { s, a, es } = arena({ stage: 'rig', me: [5, 5], foes: [[9, 11], [10, 13], [30, 30]] });
  barrel(s, 9, 12);
  assert.ok(barrelTargets(s, a).has(key(9, 12)));
  const pv = barrelPreview(s, a, 9, 12);
  assert.equal(pv.valid, true);
  assert.equal(pv.radius, BARREL.radius);
  assert.deepEqual(pv.units.map((h) => h.id).sort(), [es[0].id, es[1].id].sort());
  assert.equal(act(s, a.id, { type: 'shoot_barrel', x: 9, y: 13 }).ok, false, 'not a barrel');
  const r = act(s, a.id, { type: 'shoot_barrel', x: 9, y: 12 });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.events.slice(0, 2), [{ type: 'barrel_shot', id: a.id, x: 9, y: 12 }, { type: 'barrel', x: 9, y: 12 }]);
  assert.equal(a.ap, 0, 'ends the turn');
  assert.equal(es[0].hp, es[0].maxHp - 4);
  assert.equal(barrelTargets(s, a).size, 0);
  // Range and line of sight.
  const { s: s2, a: a2 } = arena({ stage: 'rig', me: [5, 5], foes: [[30, 30]] });
  barrel(s2, 5, 16); // 11 tiles, rifle range 9
  assert.equal(act(s2, a2.id, { type: 'shoot_barrel', x: 5, y: 16 }).ok, false);
  barrel(s2, 5, 9);
  for (let x = 0; x < S; x++) setCover(s2, x, 7, 2);
  assert.equal(act(s2, a2.id, { type: 'shoot_barrel', x: 5, y: 9 }).ok, false, 'no LOS');
});

test('breaching a drum sets it off', () => {
  const { s, a, es } = arena({ stage: 'rig', me: [5, 5, 'breacher'], foes: [[7, 6], [30, 30]] });
  barrel(s, 6, 5);
  const r = act(s, a.id, { type: 'breach', x: 6, y: 5 });
  assert.ok(r.ok, r.error);
  assert.ok(r.events.some((e) => e.type === 'barrel' && e.x === 6 && e.y === 5));
  // Breach 4 + drum 4 on the enemy; the breacher is caught by its own drum.
  assert.equal(es[0].hp, es[0].maxHp - 8);
  assert.equal(a.hp, a.maxHp - 4);
});

// ---------- night ----------

test('night: sight 6; firing flares the shooter for every squad until its next turn', () => {
  const { s, a, b, es } = arena({ stage: 'spire', me: [5, 5, 'marksman'], mate: [30, 5], foes: [[5, 13], [20, 30], [25, 30]] });
  assert.equal(s.map.sight, 6);
  assert.ok(!canSeeTile(s.map, 5, 5, 5, 12));
  assert.ok(canSeeTile(s.map, 5, 5, 5, 11));
  assert.ok(!teamSeesUnit(s, a.team, es[0]), '8 tiles at night: unseen');
  a.y = 8; // 5 tiles: visible, in range
  const otherTeam = es[1].team;
  assert.ok(!teamSeesUnit(s, otherTeam, a));
  const r = act(s, a.id, { type: 'shoot', targetId: es[0].id });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.events.find((e) => e.type === 'flare'), { type: 'flare', id: a.id });
  assert.ok(isFlared(s, a));
  assert.deepEqual(s.flares, [{ id: a.id, team: a.team }]);
  assert.ok(teamSeesUnit(s, otherTeam, a), 'lit up for everyone, at any distance');
  for (let x = 0; x < S; x++) setCover(s, x, 20, 2);
  assert.ok(teamSeesUnit(s, otherTeam, a), 'even through walls');
  // Lasts through the other squads' turns; ends as the shooter's squad starts its next turn.
  const log = [];
  do log.push(...endTeamTurn(s)); while (currentTeamId(s) !== a.team);
  const end = log.findIndex((e) => e.type === 'flare_end');
  assert.deepEqual(log[end], { type: 'flare_end', id: a.id });
  assert.ok(end < log.findIndex((e) => e.type === 'turn_start' && e.team === a.team));
  assert.equal(s.flares.length, 0);
  assert.ok(b.alive);
});

test('night: overwatch shots and barrel shots flare too; no flares by day', () => {
  const { s, a, es } = arena({ stage: 'spire', me: [5, 5], foes: [[5, 9], [30, 30]] });
  es[0].overwatch = true;
  const r = act(s, a.id, { type: 'move', x: 6, y: 6 });
  assert.ok(r.events.some((e) => e.type === 'overwatch_trigger'));
  assert.ok(r.events.some((e) => e.type === 'flare' && e.id === es[0].id));
  const { s: s2, a: a2 } = arena({ stage: 'spire', me: [5, 5], foes: [[30, 30]] });
  barrel(s2, 5, 8);
  const r2 = act(s2, a2.id, { type: 'shoot_barrel', x: 5, y: 8 });
  assert.ok(r2.events.some((e) => e.type === 'flare' && e.id === a2.id));
  const { s: s3, a: a3, es: es3 } = arena({ stage: 'harbor', me: [5, 5], foes: [[5, 9], [30, 30]] });
  const r3 = act(s3, a3.id, { type: 'shoot', targetId: es3[0].id });
  assert.ok(!r3.events.some((e) => e.type === 'flare'));
  assert.equal(s3.flares.length, 0);
});

test('a flare ends when the shooter dies', () => {
  const { s, a, b, es } = arena({ stage: 'spire', me: [5, 5], mate: [8, 5], foes: [[5, 9], [30, 30]] });
  act(s, a.id, { type: 'shoot', targetId: es[0].id });
  assert.ok(isFlared(s, a));
  // A squadmate's frags (friendly fire) down, then finish, the flared shooter.
  a.hp = 1;
  b.hp = b.maxHp = 50;
  act(s, b.id, { type: 'grenade', x: 5, y: 5 });
  assert.ok(a.downed);
  const r = act(s, b.id, { type: 'grenade', x: 5, y: 5 });
  assert.ok(r.events.some((e) => e.type === 'death' && e.id === a.id));
  assert.ok(r.events.some((e) => e.type === 'flare_end' && e.id === a.id));
  assert.ok(!isFlared(s, a));
});

// ---------- drifting zone ----------

test('surge: the zone drifts toward one side, each ring inside the last; zone_shrink carries x,y', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const s = createGame({ seed, stage: 'surge', noHuman: true });
    const plan = s.zonePlan;
    const first = plan[0], last = plan[plan.length - 1];
    const travel = Math.hypot(first.x - last.x, first.y - last.y);
    assert.ok(travel >= 12, `seed ${seed}: drift ${travel}`);
    const fromEdge = Math.min(last.x, last.y, 43 - last.x, 43 - last.y);
    assert.ok(fromEdge <= 10, 'ends near a side');
    for (let i = 1; i < plan.length; i++) {
      const d = Math.hypot(plan[i].x - plan[i - 1].x, plan[i].y - plan[i - 1].y);
      assert.ok(d + plan[i].r <= plan[i - 1].r + 1, `ring ${i} inside ring ${i - 1}`);
    }
    for (const u of s.units) u.hp = u.maxHp = 9999;
    let shrinks = 0;
    while (s.round < 12) {
      for (const e of endTeamTurn(s)) {
        if (e.type !== 'zone_shrink') continue;
        shrinks++;
        assert.equal(e.x, s.zone.x); assert.equal(e.y, s.zone.y);
        assert.equal(e.nx, s.zone.nx); assert.equal(e.ny, s.zone.ny);
      }
    }
    assert.ok(shrinks >= 4);
    // insideZone(…, next) measures from the next ring's centre.
    const z = s.zone;
    assert.equal(insideZone(s, z.nx, z.ny, z.next), true);
    assert.equal(insideNextZone(s, z.nx, z.ny), true);
  }
  const h = createGame({ seed: 4, stage: 'harbor' });
  assert.ok(h.zonePlan.every((p) => p.x === h.zonePlan[0].x && p.y === h.zonePlan[0].y), 'other stages: fixed centre');
});

test('bots rotate with the drifting zone', () => {
  const s = createGame({ seed: 21, stage: 'surge', mode: 'solos', noHuman: true });
  for (const u of s.units) u.hp = u.maxHp = 9999;
  // Fast-forward to a late ring so the drift is large, then let one lonely bot travel.
  while (s.round < 9) endTeamTurn(s);
  const t = currentTeamId(s);
  const u = s.units[s.teams[t].members[0]];
  for (const o of s.units) if (o.id !== u.id) { o.x = 0; o.y = 0; o.alive = o.team !== t ? o.alive : o.alive; }
  // Put it far from the next ring, with nobody in sight.
  for (const o of s.units) if (o.team !== u.team) { o.alive = false; }
  s.units.find((o) => o.team !== u.team).alive = true; // keep the match going
  const z = s.zone;
  const before = Math.hypot(u.x - z.nx, u.y - z.ny);
  botTakeTurn(s, u.id);
  const after = Math.hypot(u.x - z.nx, u.y - z.ny);
  assert.ok(after < before || after <= z.next, `moved toward the next ring (${before.toFixed(1)} -> ${after.toFixed(1)})`);
});

// ---------- AI ----------

test('bots shoot a drum next to clustered enemies', () => {
  const { s, a, es } = arena({ stage: 'rig', me: [8, 8, 'medic'], foes: [[12, 11], [13, 12], [30, 30]] });
  barrel(s, 12, 12);
  // Both enemies behind full cover from the bot: a poor shot, a great drum.
  setCover(s, 11, 11, 2); setCover(s, 12, 10, 2); setCover(s, 13, 11, 2); setCover(s, 12, 13, 1);
  a.items.frag = 0;
  const evs = botTakeTurn(s, a.id);
  assert.ok(evs.some((e) => e.type === 'barrel_shot'), evs.map((e) => e.type).join(','));
});

test('bots go after flared shooters they could not otherwise see', () => {
  const { s, a, es } = arena({ stage: 'spire', me: [5, 5, 'marksman'], foes: [[5, 14], [30, 30]] });
  assert.ok(!teamSeesUnit(s, a.team, es[0]));
  s.flares.push({ id: es[0].id, team: es[0].team });
  const evs = botTakeTurn(s, a.id);
  assert.ok(evs.some((e) => e.type === 'shot' && e.to === es[0].id), evs.map((e) => e.type).join(','));
});

// ---------- determinism & completion ----------

test('same seed, same match, on every stage', () => {
  for (const stage of STAGE_KEYS) {
    const a = simulate({ seed: 31, stage, mode: 'duos', noHuman: true });
    const b = simulate({ seed: 31, stage, mode: 'duos', noHuman: true });
    assert.deepEqual(a.log, b.log, stage);
    assert.deepEqual(a.state.map.cover, b.state.map.cover);
  }
});

test('bot-only matches end with one winner on every stage × mode', () => {
  const seen = {};
  for (const stage of STAGE_KEYS) {
    for (const mode of Object.keys(MODES)) {
      for (const seed of [2, 5]) {
        const { state, log } = simulate({ seed, stage, mode, noHuman: true });
        assert.notEqual(state.winner, null, `${stage}/${mode}/${seed} never ended`);
        assert.equal(aliveTeams(state).length, 1);
        assert.ok(state.round <= 24, `${stage}/${mode}/${seed} dragged to round ${state.round}`);
        let lastWeapon = null;
        for (const e of log) {
          if (e.type === 'shot') lastWeapon = e.weapon;
          // The Lantern legendary flares what it hits on any stage (5.0): not a night flare.
          if (e.type === 'flare' && lastWeapon === 'lantern') continue;
          seen[`${stage}:${e.type}`] = true;
        }
      }
    }
  }
  assert.ok(seen['rig:barrel'] && seen['rig:barrel_shot'], 'drums go off on the rig');
  assert.ok(seen['spire:flare'] && seen['spire:flare_end'], 'flares at night');
  assert.ok(!seen['harbor:flare'] && !seen['harbor:barrel'], 'no twists leak into the harbor');
});

test('human squad still gets the most isolated spawn and acts in the first step of round 1', () => {
  for (const stage of STAGE_KEYS) {
    for (const mode of Object.keys(MODES)) {
      const s = createGame({ seed: 8, stage, mode });
      const pos = s.order.indexOf(s.playerTeam);
      assert.ok(pos < Math.ceil(s.order.length / 4), `${stage}/${mode}: human at order position ${pos}`);
      assert.ok(isTeamActive(s, s.playerTeam), `${stage}/${mode}: human squad active from the start`);
      const me = s.units.find((u) => u.isPlayer);
      const gap = (team) => Math.min(...s.units.filter((o) => o.team !== team).map((o) => Math.hypot(o.x - s.units[s.teams[team].members[0]].x, o.y - s.units[s.teams[team].members[0]].y)));
      const myGap = gap(me.team);
      const others = s.teams.filter((t) => t.id !== me.team).map((t) => gap(t.id));
      others.sort((x, y) => x - y);
      const median = others[others.length >> 1];
      assert.ok(myGap >= median, `${stage}/${mode}: human spawn gap ${myGap.toFixed(1)} vs median ${median.toFixed(1)}`);
    }
  }
});
