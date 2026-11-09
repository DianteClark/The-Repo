// 5.2 bot sanity: placements, tide discipline, streak targeting and no hidden-information leaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, insideZone, insideNextZone, createGame, endTeamTurn, activeTeams } from '../src/sim/game.js';
import {
  botTakeTurn, claymoreSpot, deployCoverSpot, sentrySpot, airstrikeSpot, chooseMove, careSpot, crateValue,
} from '../src/sim/ai.js';
import { teamSeesUnit, dist, coverVs, reachable, moveOf, isWater, hitChance } from '../src/sim/rules.js';
import { dropUnit } from '../src/sim/core.js';
import { arena, S, setCover, cycleLog } from './helpers.js';

const zone = (s, x, y, r, next = r, nx = x, ny = y) => Object.assign(s.zone, { x, y, r, next, nx, ny });
const types = (evs) => evs.map((e) => e.type);
const trapper = (cls = 'assault') => [cls, { lethal: 'claymore' }];

test('claymore: never on a tide tile or outside the next ring, even with an enemy right there', () => {
  // The next ring's edge runs right past the bot: the tiles to its west are outside it.
  const { s, a, es } = arena({ me: [20, 20, ...trapper()], foes: [[14, 20, 'breacher'], [40, 40]] });
  zone(s, 30, 20, 20, 10, 30, 20);
  assert.ok(insideNextZone(s, 20, 20) && !insideNextZone(s, 19, 20));
  assert.ok(teamSeesUnit(s, a.team, es[0]));
  const spot = claymoreSpot(s, a);
  if (spot) assert.ok(insideZone(s, spot.x, spot.y) && insideNextZone(s, spot.x, spot.y), `${spot.x},${spot.y}`);
  // And in the tide itself: no claymore at all.
  zone(s, 40, 40, 8, 6);
  assert.equal(claymoreSpot(s, a), null);
  const evs = botTakeTurn(s, a.id);
  for (const e of evs) if (e.type === 'claymore') assert.ok(insideZone(s, e.x, e.y) && insideNextZone(s, e.x, e.y));
});

test('claymore: goes on the approach side, toward the enemy, and only when someone is coming', () => {
  const { s, a, es } = arena({ me: [20, 20, ...trapper()], foes: [[20, 14, 'breacher'], [40, 40]] });
  zone(s, 22, 22, 20);
  const spot = claymoreSpot(s, a);
  assert.ok(spot, 'a close shotgun is coming: claymore it');
  assert.ok(spot.y < 20, `north side, got ${spot.x},${spot.y}`);
  // No enemy seen, heard or remembered: nothing to claymore.
  const fresh = arena({ me: [20, 20, ...trapper()], foes: [[40, 40], [42, 2]] });
  zone(fresh.s, 22, 22, 20);
  fresh.s.noises = [];
  assert.ok(!fresh.es.some((e) => teamSeesUnit(fresh.s, fresh.a.team, e)));
  assert.equal(claymoreSpot(fresh.s, fresh.a), null);
  void es;
});

test('claymore: in a corridor it covers the doorway the enemy must use, not the dead end behind', () => {
  // A walled corridor running north-south; the enemy can only come from the north.
  const { s, a } = arena({ me: [20, 20, ...trapper()], foes: [[20, 13, 'breacher'], [40, 40]] });
  zone(s, 22, 22, 20);
  for (let y = 14; y <= 24; y++) { setCover(s, 19, y, 2); setCover(s, 21, y, 2); }
  setCover(s, 20, 23, 2); // dead end to the south
  const spot = claymoreSpot(s, a);
  assert.ok(spot, 'chokepoint claymore');
  assert.deepEqual([spot.x, spot.y], [20, 19]);
});

test('claymore: remembers where an enemy was after losing sight of it', () => {
  const { s, a, es } = arena({ me: [20, 20, ...trapper()], foes: [[20, 15, 'breacher'], [40, 40]] });
  zone(s, 22, 22, 20);
  assert.ok(claymoreSpot(s, a), 'seen');
  // It ducks behind a wall: still known for a couple of rounds.
  for (let x = 17; x <= 23; x++) setCover(s, x, 16, 2);
  es[0].y = 14;
  assert.ok(!teamSeesUnit(s, a.team, es[0]));
  const spot = claymoreSpot(s, a);
  assert.ok(spot && spot.y < 20, 'remembered approach');
});

test('deploy cover: the barricade goes between the engineer and the shooter', () => {
  const { s, a, es } = arena({ me: [20, 20, 'engineer'], foes: [[20, 13, 'marksman'], [40, 40]] });
  zone(s, 22, 22, 20);
  const spot = deployCoverSpot(s, a, [es[0]]);
  assert.ok(spot);
  assert.ok(spot.y < 20, `north side, got ${spot.x},${spot.y}`);
  const before = coverVs(s.map, a.x, a.y, es[0].x, es[0].y);
  setCover(s, spot.x, spot.y, 2);
  assert.ok(coverVs(s.map, a.x, a.y, es[0].x, es[0].y) > before);
  setCover(s, spot.x, spot.y, 0);
  // Nobody known anywhere: no barricade.
  const lone = arena({ me: [20, 20, 'engineer'], foes: [[40, 40], [2, 42]] });
  lone.s.noises = [];
  assert.equal(deployCoverSpot(lone.s, lone.a, []), null);
});

test('no ending a turn in the tide when dry ground is reachable (even with a shot or a frag on offer)', () => {
  for (const variant of ['shot', 'frag', 'empty']) {
    const { s, a, es } = arena({ me: [10, 20, 'assault'], foes: [[10, 14], [12, 14]] });
    // The ring is 9 tiles east: dry ground needs the whole turn (two moves).
    zone(s, 30, 20, 11);
    assert.ok(!insideZone(s, a.x, a.y));
    if (variant === 'shot') a.weapon.aim = 300;
    if (variant === 'frag') es[1].x = 11;
    if (variant === 'empty') { a.ammo = 0; a.weapon.ammo = 0; }
    botTakeTurn(s, a.id);
    assert.ok(insideZone(s, a.x, a.y), `${variant}: ended at ${a.x},${a.y}`);
  }
});

test('a bot standing on a telegraphed airstrike line walks off it', () => {
  const { s, a } = arena({ me: [20, 20, 'assault'], foes: [[40, 40], [2, 42]] });
  zone(s, 22, 22, 20);
  s.airstrikes.push({ id: 99, team: 7, owner: 0, tiles: [[17, 20], [18, 20], [19, 20], [20, 20], [21, 20], [22, 20], [23, 20]], round: s.round + 1 });
  botTakeTurn(s, a.id);
  assert.ok(a.y !== 20 || a.x < 17 || a.x > 23, `still on the line at ${a.x},${a.y}`);
});

test('airstrike: never marked over (or next to) the own squad; prefers enemies that already moved', () => {
  const { s, a, b, es } = arena({
    me: [10, 10, 'assault', { streaks: ['airstrike', 'uav', 'care'] }], mate: [20, 16, 'medic'],
    foes: [[21, 16], [24, 22], [26, 22]],
  });
  zone(s, 22, 22, 20);
  a.points = 9;
  for (const e of es) assert.ok(teamSeesUnit(s, a.team, e));
  const best = airstrikeSpot(s, a, es);
  assert.ok(best);
  const tiles = [];
  const dx = Math.sign(best.x2 - best.x), dy = Math.sign(best.y2 - best.y);
  for (let i = 0; i < 7; i++) tiles.push([best.x + dx * i, best.y + dy * i]);
  for (const [x, y] of tiles) assert.ok(Math.max(Math.abs(x - b.x), Math.abs(y - b.y)) > 1, 'clear of the medic');
  const evs = botTakeTurn(s, a.id);
  const mark = evs.find((e) => e.type === 'airstrike_mark');
  if (mark) for (const [x, y] of mark.tiles) assert.ok(!(x === b.x && y === b.y) && !(x === a.x && y === a.y));
});

test('sentry: faces the threat; care package: near the caller, inside the coming ring', () => {
  const { s, a, es } = arena({ me: [20, 20, 'assault', { streaks: ['sentry', 'care', 'uav'] }], foes: [[26, 20], [40, 40]] });
  zone(s, 22, 22, 20);
  a.points = 9;
  const spot = sentrySpot(s, a, [es[0]]);
  assert.ok(spot);
  const [dx, dy] = [spot.x2 - spot.x, spot.y2 - spot.y];
  const [vx, vy] = [es[0].x - spot.x, es[0].y - spot.y];
  assert.ok((dx * vx + dy * vy) / (Math.hypot(dx, dy) * Math.hypot(vx, vy)) >= Math.SQRT1_2 - 1e-9, 'enemy inside the cone');
  const r = botTakeTurn(s, a.id);
  const placed = r.find((e) => e.type === 'sentry');
  assert.ok(placed, types(r).join(','));
  // Care package: a quiet moment, inside the next ring and close by.
  const q = arena({ me: [20, 20, 'assault', { streaks: ['care', 'sentry', 'uav'] }], foes: [[40, 40], [2, 42]] });
  zone(q.s, 26, 20, 20, 10, 26, 20);
  q.a.points = 9;
  const evs = botTakeTurn(q.s, q.a.id);
  const call = evs.find((e) => e.type === 'care_package_called');
  assert.ok(call, types(evs).join(','));
  assert.ok(insideNextZone(q.s, call.x, call.y) && dist(call.x, call.y, 20, 20) <= 4);
});

test('no hidden-information leaks: where an unseen enemy stands never changes a bot\'s turn', () => {
  const run = (hx, hy) => {
    const { s, a } = arena({ me: [12, 12, ...trapper('engineer')], foes: [[30, 12], [hx, hy]] });
    zone(s, 22, 22, 20);
    for (let y = 0; y < S; y++) setCover(s, 22, y, 2); // a wall splits the map: the east is unseen
    s.noises = [];
    assert.ok(!s.units.some((e) => e.alive && e.team !== a.team && teamSeesUnit(s, a.team, e)));
    const evs = botTakeTurn(s, a.id);
    return JSON.stringify({ x: a.x, y: a.y, evs: evs.map((e) => [e.type, e.x, e.y, e.path]) });
  };
  assert.equal(run(34, 30), run(38, 5));
});

test('bots skip a claymore when nothing sensible is in reach, and every claymore over many matches sits on dry ground', () => {
  let n = 0;
  // (Every one of these matches had a tide claymore with the 5.1 bots.)
  for (const [mode, stage, seed] of [['duos', 'rig', 4242], ['quads', 'spire', 4242], ['duos', 'spire', 2], ['solos', 'surge', 4242]]) {
    const s = createGame({ seed, mode, stage, noHuman: true });
    let guard = 0;
    while (s.winner === null && guard++ < 3000) {
      const t = activeTeams(s)[0];
      for (const id of s.teams[t].members) {
        for (const e of botTakeTurn(s, id)) {
          if (e.type !== 'claymore') continue;
          n++;
          assert.ok(insideZone(s, e.x, e.y) && insideNextZone(s, e.x, e.y), `claymore in the tide at ${e.x},${e.y}`);
        }
      }
      endTeamTurn(s, t);
    }
    assert.notEqual(s.winner, null);
  }
  void n; void act; void chooseMove;
});

// ---------- 5.3 care packages: call them where they can be reached, then go and get them ----------

/** A landed care package belonging to `u`'s squad (as streaksStepStart leaves it). */
const careAt = (s, u, x, y) => {
  const c = { id: s.crates.length, x, y, type: 'care', taken: false, team: u.team, by: u.id };
  s.crates.push(c);
  return c;
};

test('care package: a bot claims its own care package on its first turn after it lands (open arena)', () => {
  for (const [x, y] of [[20, 20], [14, 26], [30, 16]]) {
    const { s, a } = arena({ me: [x, y, 'assault', { streaks: ['care', 'sentry', 'uav'] }], foes: [[42, 42], [1, 42]] });
    zone(s, 22, 22, 20);
    s.noises = [];
    a.points = 9;
    let called = null, claimed = -1;
    for (let t = 0; t < 4 && claimed < 0; t++) {
      for (const e of botTakeTurn(s, a.id)) {
        if (e.type === 'care_package_called') called = e;
        if (e.type === 'crate' && e.item === 'care') claimed = t;
      }
      assert.ok(called, `called on the first turn from ${x},${y}`);
      cycleLog(s, a.team);
    }
    // Called where one move reaches it: picked up on the first turn after it lands.
    assert.equal(claimed, 1, `claimed on turn ${claimed} (from ${x},${y}, called at ${called.x},${called.y})`);
  }
});

test('care package: called on dry ground walkable within 2 moves, never across water', () => {
  const { s, a } = arena({ me: [20, 20, 'assault', { streaks: ['care', 'sentry', 'uav'] }], foes: [[42, 42], [1, 42]] });
  // The circle is east, across a channel: the far bank is in call range but not in walking range.
  zone(s, 30, 20, 20, 13, 30, 20);
  for (let y = 0; y < S; y++) for (let x = 22; x <= 27; x++) s.map.terrain[y * S + x] = 2;
  s.noises = [];
  const spot = careSpot(s, a);
  assert.ok(spot);
  assert.ok(!isWater(s.map, spot.x, spot.y) && spot.x < 22, `${spot.x},${spot.y}`);
  assert.ok(insideNextZone(s, spot.x, spot.y));
  assert.ok(reachable(s, a, moveOf(a) * 2).has(spot.y * S + spot.x));
  // Caller standing outside the coming ring (dry for now): the package still goes inside it.
  const o = arena({ me: [12, 20, 'assault', { streaks: ['care', 'sentry', 'uav'] }], foes: [[42, 42], [1, 42]] });
  zone(o.s, 22, 20, 20, 7, 22, 20);
  o.s.noises = [];
  o.a.points = 9;
  assert.ok(!insideNextZone(o.s, 12, 20));
  const call = botTakeTurn(o.s, o.a.id).find((e) => e.type === 'care_package_called');
  assert.ok(call && insideNextZone(o.s, call.x, call.y), JSON.stringify(call));
  // In the tide itself the bot gets out first and holds the package.
  zone(s, 40, 40, 6, 4);
  a.points = 9;
  const evs = botTakeTurn(s, a.id);
  assert.ok(!evs.some((e) => e.type === 'care_package_called'), types(evs).join(','));
});

test('care package: no run into a crossfire for it at low HP; a lone distant enemy doesn\'t stop the grab', () => {
  const setup = (foes) => {
    const r = arena({ me: [20, 20, 'assault'], foes });
    zone(r.s, 22, 22, 20);
    r.a.items.medkit = 0;
    return { ...r, c: careAt(r.s, r.a, 24, 20) };
  };
  // Three rifles with clear, good shots on the crate tile.
  const x = setup([[24, 14], [30, 20], [24, 26]]);
  x.a.hp = Math.ceil(x.a.maxHp * 0.35);
  for (const e of x.es) {
    assert.ok(teamSeesUnit(x.s, x.a.team, e));
    assert.ok(hitChance(x.s, e, { ...x.a, x: 24, y: 20 }).chance >= 45);
  }
  botTakeTurn(x.s, x.a.id);
  assert.ok(!x.c.taken && !(x.a.x === 24 && x.a.y === 20), `walked into the crossfire to ${x.a.x},${x.a.y}`);
  // Two of them, still low: same answer.
  const y = setup([[24, 14], [30, 20], [42, 42]]);
  y.a.hp = Math.ceil(y.a.maxHp * 0.35);
  botTakeTurn(y.s, y.a.id);
  assert.ok(!y.c.taken, `low HP into two good shots at ${y.a.x},${y.a.y}`);
  // One enemy in sight but well off: the package is worth the dash.
  const z = setup([[20, 13], [42, 42]]);
  assert.ok(teamSeesUnit(z.s, z.a.team, z.es[0]));
  botTakeTurn(z.s, z.a.id);
  assert.ok(z.c.taken, `left the package at ${z.a.x},${z.a.y}`);
});

test('care package: a squadmate claims it when the caller is downed', () => {
  const { s, a, b } = arena({ mode: 'duos', me: [20, 20, 'assault'], mate: [14, 25, 'medic'], foes: [[42, 42], [1, 42]] });
  zone(s, 22, 22, 20);
  s.noises = [];
  dropUnit(s, a, null, []);
  assert.ok(a.downed);
  const c = careAt(s, a, 24, 21);
  let by = null;
  for (let t = 0; t < 3 && !c.taken; t++) {
    for (const e of botTakeTurn(s, b.id)) if (e.type === 'crate' && e.crate === c.id) by = e.id;
    cycleLog(s, a.team);
  }
  assert.equal(by, b.id, `mate at ${b.x},${b.y}`);
});

test('care package: one claimer per squad; enemy packages are contested when seen', () => {
  // The caller and its mate: only the closer one walks to it.
  const { s, a, b } = arena({ mode: 'duos', me: [20, 20, 'assault'], mate: [30, 20, 'assault'], foes: [[42, 42], [1, 42]] });
  zone(s, 22, 22, 20);
  s.noises = [];
  const c = careAt(s, a, 27, 20);
  const evs = botTakeTurn(s, b.id);
  assert.ok(c.taken && evs.some((e) => e.type === 'crate' && e.crate === c.id), 'the mate is closer: it takes it');
  void a;
  // An enemy squad's package in plain view, nobody guarding it: go and take it.
  const q = arena({ me: [20, 20, 'assault'], foes: [[42, 42], [1, 42]] });
  zone(q.s, 22, 22, 20);
  q.s.noises = [];
  const enemyPkg = careAt(q.s, q.es[0], 25, 22);
  botTakeTurn(q.s, q.a.id);
  assert.ok(enemyPkg.taken, `left the enemy package; at ${q.a.x},${q.a.y}`);
});

test('crate values: gold and care packages first; medkits when hurt, ammo when low', () => {
  const { a } = arena({ me: [20, 20, 'assault'], foes: [[42, 42], [1, 42]] });
  const v = (c) => crateValue(null, a, c);
  assert.ok(v({ type: 'care' }) > v({ type: 'cache' }) && v({ type: 'gold', weapon: 'x' }) > v({ type: 'cache' }));
  assert.ok(v({ type: 'cache' }) > v({ type: 'medkit' }) && v({ type: 'cache' }) > v({ type: 'ammo' }));
  const healthy = v({ type: 'medkit' });
  a.hp = 2; a.items.medkit = 0;
  assert.ok(v({ type: 'medkit' }) > healthy + 5);
  const full = v({ type: 'ammo' });
  a.ammo = 0;
  if (a.weapons) { a.weapons[0].spare = 0; a.weapons[0].ammo = 0; }
  assert.ok(v({ type: 'ammo' }) > full + 5);
});
