import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, act, endTeamTurn, currentTeamId, shotPreview, aimedPreview, grenadeTargets, grenadePreview,
  breachTargets, breachPreview, abilityInfo, moveOptions,
} from '../src/sim/game.js';
import { hitChance, losDirect } from '../src/sim/rules.js';
import { CLASSES, CRATE_LABEL, FRAG_CAP, MOD_CAP, COVER_PENALTY } from '../src/sim/constants.js';

import { arena, S, setCover, coverAt } from './helpers.js';


test('new unit fields: frags, cooldowns, hunkered', () => {
  const s = createGame({ seed: 5, mode: 'solos' });
  for (const u of s.units) {
    assert.equal(u.items.frag, u.cls === 'assault' ? 2 : 0);
    assert.deepEqual(u.cooldowns, { aimed: 0, breach: 0, patch: 0, scan: 0 });
    assert.equal(u.items.smoke, u.cls === 'recon' ? 1 : 0);
    assert.equal(u.downed, false);
    assert.equal(u.hunkered, false);
  }
  assert.ok(CRATE_LABEL.frag && CRATE_LABEL.cache);
});

test('grenade: 3x3 blast, friendly fire, armor, cover shredding, keeps the turn going', () => {
  const { s, a, b, es } = arena({ me: [6, 6], mate: [11, 11], foes: [[10, 10], [10, 11, 'breacher'], [14, 14]] });
  es[1].armor = 1;
  setCover(s, 9, 10, 2); setCover(s, 11, 10, 1); setCover(s, 13, 13, 2);
  const r = act(s, a.id, { type: 'grenade', x: 10, y: 10 });
  assert.ok(r.ok, r.error);
  assert.equal(r.events[0].type, 'grenade');
  assert.deepEqual(r.events[0], { type: 'grenade', id: a.id, x: 10, y: 10, radius: 1.5 });
  const dmg = Object.fromEntries(r.events.filter((e) => e.type === 'damage').map((e) => [e.id, e]));
  assert.equal(dmg[es[0].id].dmg, 3);
  assert.equal(dmg[es[1].id].dmg, 2, 'armor 1');
  assert.equal(dmg[b.id].dmg, 3, 'friendly fire');
  assert.equal(dmg[es[0].id].source, 'explosion');
  assert.equal(dmg[es[2].id], undefined, 'outside the radius');
  assert.equal(coverAt(s, 9, 10), 1);
  assert.equal(coverAt(s, 11, 10), 0);
  assert.equal(coverAt(s, 13, 13), 2);
  const cc = r.events.filter((e) => e.type === 'cover_change');
  assert.deepEqual(cc.map((e) => [e.x, e.y, e.from, e.to]).sort(), [[11, 10, 1, 0], [9, 10, 2, 1]].sort());
  assert.equal(a.items.frag, 1);
  assert.equal(a.ap, 1, 'grenade does not end the turn');
  assert.ok(act(s, a.id, { type: 'grenade', x: 10, y: 10 }).ok);
  assert.equal(a.ap, 0);
  assert.equal(act(s, a.id, { type: 'grenade', x: 10, y: 10 }).ok, false);
});

test('grenade validation: range 7, line of sight, team vision, charges', () => {
  const { s, a } = arena({ me: [5, 5], foes: [[25, 25]] });
  assert.equal(act(s, a.id, { type: 'grenade', x: 13, y: 5 }).ok, false, '8 tiles is too far');
  assert.ok(grenadeTargets(s, a).has(5 * S + 12));
  assert.ok(!grenadeTargets(s, a).has(5 * S + 13));
  for (let y = 0; y < S; y++) setCover(s, 8, y, 2); // a wall line
  assert.ok(!grenadeTargets(s, a).has(5 * S + 10), 'no LOS through the wall');
  assert.equal(act(s, a.id, { type: 'grenade', x: 10, y: 5 }).ok, false);
  a.items.frag = 0;
  assert.equal(grenadeTargets(s, a).size, 0);
  assert.equal(act(s, a.id, { type: 'grenade', x: 6, y: 6 }).ok, false);
});

test('grenade preview lists visible units and cover changes', () => {
  const { s, a, b, es } = arena({ me: [6, 6], mate: [9, 9], foes: [[10, 10]] });
  setCover(s, 10, 11, 2);
  const p = grenadePreview(s, a, 10, 10);
  assert.equal(p.valid, true);
  const ids = p.units.map((h) => h.id).sort();
  assert.deepEqual(ids, [b.id, es[0].id].sort());
  assert.ok(p.units.every((h) => h.dmg === 3 && h.lethal === false));
  assert.deepEqual(p.cover, [{ x: 10, y: 11, from: 2, to: 1 }]);
  es[0].hp = 2;
  assert.equal(grenadePreview(s, a, 10, 10).units.find((h) => h.id === es[0].id).lethal, true);
  assert.equal(grenadePreview(s, a, 20, 20).valid, false);
});

test('grenade kill credits the thrower; destroyed walls open line of sight live', () => {
  const { s, a, es } = arena({ me: [5, 5], foes: [[9, 5], [20, 20]] });
  es[0].hp = 3;
  setCover(s, 10, 5, 2);
  assert.equal(losDirect(s.map, 8, 5, 12, 5), false);
  const r = act(s, a.id, { type: 'grenade', x: 9, y: 5 });
  assert.ok(r.events.some((e) => e.type === 'death' && e.id === es[0].id && e.by === a.id));
  assert.equal(a.kills, 1);
  assert.equal(losDirect(s.map, 8, 5, 12, 5), true, 'full -> half no longer blocks sight');
});

test('aimed shot: marksman only, +15 aim, +2 dmg, ends turn, cooldown 3 ticking per own turn', () => {
  const { s, a, es } = arena({ me: [5, 5, 'marksman'], foes: [[5, 12], [30, 30]] });
  setCover(s, 5, 11, 1); // half cover facing the marksman
  const base = shotPreview(s, a, es[0]);
  const p = aimedPreview(s, a, es[0]);
  assert.equal(p.chance, Math.min(95, base.chance + 15));
  assert.deepEqual(p.dmg, [base.dmg[0] + 2, base.dmg[1] + 2]);
  assert.equal(p.cover, 1);
  const r = act(s, a.id, { type: 'aimed', targetId: es[0].id });
  assert.ok(r.ok, r.error);
  const shot = r.events.find((e) => e.type === 'shot');
  assert.equal(shot.ability, 'aimed');
  assert.equal(shot.cover, 1);
  assert.equal(shot.flank, false);
  assert.equal(a.ap, 0);
  assert.equal(a.cooldowns.aimed, 3);
  const info = () => abilityInfo(a).find((x) => x.key === 'aimed');
  assert.equal(info().ready, false);
  // Cycle to our next turn: cooldown ticks to 2.
  const myTeam = a.team;
  const cycle = () => { do endTeamTurn(s); while (currentTeamId(s) !== myTeam); };
  cycle();
  assert.equal(a.cooldowns.aimed, 2);
  assert.equal(act(s, a.id, { type: 'aimed', targetId: es[0].id }).ok, false, 'on cooldown');
  cycle(); cycle();
  assert.equal(a.cooldowns.aimed, 0);
  assert.equal(info().ready, true);
});

test('aimed shot is refused for other classes', () => {
  const { s, a, es } = arena({ me: [5, 5, 'assault'], foes: [[5, 9]] });
  assert.equal(aimedPreview(s, a, es[0]), null);
  assert.equal(act(s, a.id, { type: 'aimed', targetId: es[0].id }).ok, false);
});

test('regular shot events carry cover/flank and flanks get +10 aim', () => {
  const { s, a, es } = arena({ me: [5, 5], foes: [[5, 10]] });
  setCover(s, 6, 10, 2); // cover to the east of the target, shooter is north
  const p = shotPreview(s, a, es[0]);
  assert.equal(p.cover, 0);
  assert.equal(p.flank, true);
  setCover(s, 6, 10, 0);
  const exposed = shotPreview(s, a, es[0]);
  assert.equal(exposed.flank, false);
  assert.equal(p.chance, exposed.chance + 10);
  setCover(s, 6, 10, 2);
  const r = act(s, a.id, { type: 'shoot', targetId: es[0].id });
  const shot = r.events.find((e) => e.type === 'shot');
  assert.equal(shot.flank, true);
  assert.equal(shot.cover, 0);
  assert.equal(shot.ability, undefined);
});

test('breach: blows adjacent cover open, damages adjacent enemies only, cooldown 3', () => {
  const { s, a, b, es } = arena({ me: [5, 5, 'breacher'], mate: [7, 4], foes: [[7, 5], [7, 6, 'breacher'], [9, 5]] });
  es[1].armor = 1;
  setCover(s, 6, 5, 2);
  assert.deepEqual([...breachTargets(s, a)], [5 * S + 6]);
  const pv = breachPreview(s, a, 6, 5);
  assert.deepEqual(pv.units.map((h) => [h.id, h.dmg]).sort(), [[es[0].id, 4], [es[1].id, 3]].sort());
  assert.equal(act(s, a.id, { type: 'breach', x: 7, y: 5 }).ok, false, 'must be adjacent with cover');
  const r = act(s, a.id, { type: 'breach', x: 6, y: 5 });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.events[0], { type: 'breach', id: a.id, x: 6, y: 5 });
  assert.ok(r.events.some((e) => e.type === 'cover_change' && e.x === 6 && e.y === 5 && e.from === 2 && e.to === 0));
  assert.equal(coverAt(s, 6, 5), 0);
  const dmg = r.events.filter((e) => e.type === 'damage');
  assert.ok(dmg.every((e) => e.source === 'breach'));
  assert.deepEqual(dmg.map((e) => e.id).sort(), [es[0].id, es[1].id].sort());
  assert.equal(b.hp, b.maxHp, 'allies are spared');
  assert.equal(es[2].hp, es[2].maxHp);
  assert.equal(a.ap, 1);
  assert.equal(a.cooldowns.breach, 3);
  assert.equal(breachTargets(s, a).size, 0);
  // Pathing reads the live map: the breached tile is now walkable.
  assert.ok(moveOptions(s, a).has(5 * S + 6));
});

test('breach is refused for other classes', () => {
  const { s, a } = arena({ me: [5, 5, 'assault'], foes: [[20, 20]] });
  setCover(s, 6, 5, 1);
  assert.equal(breachTargets(s, a).size, 0);
  assert.equal(act(s, a.id, { type: 'breach', x: 6, y: 5 }).ok, false);
});

test('hunker: ends turn, doubles cover, no grazes, clears on own next turn', () => {
  const { s, a, es } = arena({ me: [5, 5], foes: [[5, 12]] });
  setCover(s, 5, 6, 1); // half cover facing south
  const before = hitChance(s, es[0], a);
  const r = act(s, a.id, { type: 'hunker' });
  assert.ok(r.ok);
  assert.deepEqual(r.events, [{ type: 'hunker', id: a.id }]);
  assert.equal(a.ap, 0);
  assert.equal(a.hunkered, true);
  const after = hitChance(s, es[0], a);
  assert.equal(before.chance - after.chance, COVER_PENALTY[1]);
  // Graze impossible: roll many shots, never a graze.
  endTeamTurn(s);
  while (currentTeamId(s) !== es[0].team) endTeamTurn(s);
  const p = shotPreview(s, es[0], a);
  assert.equal(p.graze, 0);
  for (let i = 0; i < 40 && a.alive; i++) {
    es[0].ap = 2;
    const shot = act(s, es[0].id, { type: 'shoot', targetId: a.id }).events.find((e) => e.type === 'shot');
    assert.notEqual(shot.result, 'graze');
    a.hp = a.maxHp;
  }
  while (currentTeamId(s) !== a.team) endTeamTurn(s);
  assert.equal(a.hunkered, false);
});

test('supply drops land inside the next zone at rounds 4, 8, 12 and caches give scope+barrel+frag', () => {
  const s = createGame({ seed: 11, mode: 'quads', noHuman: true });
  for (const u of s.units) { u.hp = u.maxHp = 999; } // nobody dies to the tide while we fast-forward
  const drops = [];
  while (s.round < 13 && s.winner === null) {
    const evs = endTeamTurn(s);
    for (const e of evs) {
      if (e.type === 'supply_drop') {
        drops.push(s.round);
        assert.equal(e.crate.type, 'cache');
        assert.equal(s.map.cover[e.crate.y * s.map.size + e.crate.x], 0);
        const z = s.zone;
        assert.ok(Math.hypot(e.crate.x - z.nx, e.crate.y - z.ny) <= z.next || Math.hypot(e.crate.x - z.x, e.crate.y - z.y) <= z.r);
      }
    }
  }
  assert.deepEqual(drops, [4, 8, 12]);
  // Pick a cache up.
  const { s: s2, a } = arena({ me: [5, 5], foes: [[20, 20]] });
  s2.crates.push({ id: 0, x: 6, y: 5, type: 'cache', taken: false });
  a.mods.scope = MOD_CAP;
  const r = act(s2, a.id, { type: 'move', x: 6, y: 5 });
  assert.ok(r.events.some((e) => e.type === 'crate' && e.item === 'cache'));
  assert.equal(a.mods.scope, MOD_CAP, 'capped');
  assert.equal(a.mods.barrel, 1);
  assert.equal(a.items.frag, 3);
});

test('frag crates add a grenade, up to the cap', () => {
  const { s, a } = arena({ me: [5, 5], foes: [[20, 20]] });
  s.crates.push({ id: 0, x: 6, y: 5, type: 'frag', taken: false }, { id: 1, x: 7, y: 5, type: 'frag', taken: false });
  const r1 = act(s, a.id, { type: 'move', x: 6, y: 5 });
  assert.ok(r1.events.some((e) => e.type === 'crate' && e.item === 'frag'));
  assert.equal(a.items.frag, FRAG_CAP);
  const r2 = act(s, a.id, { type: 'move', x: 7, y: 5 });
  assert.ok(r2.events.some((e) => e.type === 'crate' && e.item === 'medkit'), 'over the cap becomes a medkit');
});

test('abilityInfo reports readiness, charges, cooldowns and reasons', () => {
  const { s, a } = arena({ me: [5, 5, 'marksman'], foes: [[20, 20]] });
  let info = abilityInfo(a);
  assert.deepEqual(info.map((x) => x.key), ['grenade', 'smoke', 'aimed', 'revive', 'hunker']);
  const g = info.find((x) => x.key === 'grenade');
  assert.equal(g.ready, false);
  assert.equal(g.reason, 'No grenades');
  assert.equal(g.charges, 0);
  assert.ok(info.every((x) => typeof x.name === 'string' && typeof x.desc === 'string'));
  assert.equal(info.find((x) => x.key === 'aimed').ready, true);
  assert.equal(abilityInfo(a, s).find((x) => x.key === 'aimed').reason, 'No target');
  a.cooldowns.aimed = 2;
  info = abilityInfo(a);
  assert.equal(info.find((x) => x.key === 'aimed').reason, 'Cooldown 2');
  assert.equal(info.find((x) => x.key === 'aimed').cooldown, 2);
  a.ap = 0;
  assert.equal(abilityInfo(a).find((x) => x.key === 'hunker').reason, 'No AP');
  const { a: br } = arena({ me: [5, 5, 'breacher'] });
  assert.deepEqual(abilityInfo(br).map((x) => x.key), ['grenade', 'smoke', 'breach', 'revive', 'hunker']);
  const solo = createGame({ seed: 3, mode: 'solos' });
  assert.ok(!abilityInfo(solo.units[0], solo).some((x) => x.key === 'revive'), 'no revive in solos');
});
