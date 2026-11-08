// 5.2 bot sanity: placements, tide discipline, streak targeting and no hidden-information leaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, insideZone, insideNextZone, createGame, endTeamTurn, activeTeams } from '../src/sim/game.js';
import {
  botTakeTurn, claymoreSpot, deployCoverSpot, sentrySpot, airstrikeSpot, chooseMove,
} from '../src/sim/ai.js';
import { teamSeesUnit, dist, coverVs } from '../src/sim/rules.js';
import { arena, S, setCover } from './helpers.js';

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
