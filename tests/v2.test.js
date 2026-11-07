import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, act, currentTeamId, shotPreview, abilityInfo, moveOptions, teamAlive, aliveTeams,
  patchTargets, reviveTargets, smokeTargets, scanPreview, endTeamTurn,
} from '../src/sim/game.js';
import { hitChance, teamSeesUnit } from '../src/sim/rules.js';
import { CLASSES, CRATE_LABEL, CRATE_TABLE, SMOKE } from '../src/sim/constants.js';
import { arena, S, setCover, cycleTo, cycleLog } from './helpers.js';

/** Force the next shot roll to hit by giving the shooter a sure thing. */
const sureShot = (u) => { u.weapon.aim = 300; };
const sureMiss = (u) => { u.weapon.aim = -300; };

test('medic and recon classes exist with stable keys and starting kit', () => {
  assert.deepEqual(Object.keys(CLASSES), ['assault', 'marksman', 'breacher', 'medic', 'recon']);
  assert.equal(CLASSES.medic.weapon.range, 7);
  assert.equal(CLASSES.recon.weapon.range, 10);
  assert.equal(CLASSES.recon.move, 7);
  const s = createGame({ seed: 4, playerClass: 'recon' });
  const me = s.units.find((u) => u.isPlayer);
  assert.equal(me.cls, 'recon');
  assert.equal(me.items.smoke, 1);
  assert.ok(CRATE_LABEL.smoke && CRATE_TABLE.some(([k]) => k === 'smoke'));
  const classes = new Set();
  for (let seed = 1; seed < 10; seed++) for (const u of createGame({ seed, noHuman: true }).units) classes.add(u.cls);
  assert.equal(classes.size, 5, 'bots roll all five classes');
});

test('team modes: a unit at 0 HP with a standing squadmate is downed, not dead', () => {
  const { s, a, es } = arena({ me: [5, 5], foes: [[5, 9], [30, 30], [20, 20]] });
  const [t, , mate] = es;
  t.hp = 1;
  sureShot(a);
  const r = act(s, a.id, { type: 'shoot', targetId: t.id });
  const shot = r.events.find((e) => e.type === 'shot');
  assert.equal(shot.downed, true);
  assert.deepEqual(r.events.find((e) => e.type === 'downed'), { type: 'downed', id: t.id, by: a.id });
  assert.ok(!r.events.some((e) => e.type === 'death'));
  assert.equal(t.alive, true);
  assert.equal(t.downed, true);
  assert.equal(t.hp, 0);
  assert.equal(t.bleed, 2);
  assert.equal(a.kills, 0, 'downing is not a kill');
  assert.ok(teamAlive(s, t.team), 'squadmate still standing');
  assert.ok(mate.alive && !mate.downed);
  // Downed units can't act and still occupy their tile.
  cycleTo(s, t.team);
  assert.equal(t.ap, 0);
  assert.equal(act(s, t.id, { type: 'overwatch' }).ok, false);
  mate.x = 5; mate.y = 11;
  assert.ok(!moveOptions(s, mate).has(9 * S + 5));
  assert.equal(abilityInfo(t, s).find((x) => x.key === 'hunker').reason, 'Downed');
});

test('any hit on a downed unit executes it', () => {
  const { s, a, b, es } = arena({ me: [5, 5], mate: [6, 5], foes: [[5, 9], [30, 30], [20, 20]] });
  const t = es[0];
  t.hp = 1;
  sureShot(a);
  act(s, a.id, { type: 'shoot', targetId: t.id });
  assert.ok(t.downed);
  const p = shotPreview(s, b, t);
  assert.ok(p, 'downed enemies are valid targets');
  b.weapon.dmg = [1, 1]; // even a 1-damage graze is enough
  sureShot(b);
  const r = act(s, b.id, { type: 'shoot', targetId: t.id });
  const shot = r.events.find((e) => e.type === 'shot');
  assert.equal(shot.downed, false);
  assert.ok(r.events.some((e) => e.type === 'death' && e.id === t.id && e.by === b.id));
  assert.equal(t.alive, false);
  assert.equal(b.kills, 1);
});

test('downed units bleed out after two of their own team turns', () => {
  const { s, a, es } = arena({ me: [5, 5], foes: [[5, 9], [30, 30], [20, 20]] });
  const t = es[0];
  t.hp = 1;
  sureShot(a);
  act(s, a.id, { type: 'shoot', targetId: t.id });
  // The downed team's first turn ends: 2 -> 1. (Turn order rotates each round,
  // so step one team turn at a time rather than assuming who's next.)
  const ownTurnEnd = () => {
    while (currentTeamId(s) !== t.team) endTeamTurn(s);
    return endTeamTurn(s);
  };
  ownTurnEnd();
  assert.equal(t.bleed, 1);
  assert.equal(t.alive, true);
  const log = ownTurnEnd();
  const i = log.findIndex((e) => e.type === 'bleed_out');
  assert.deepEqual(log[i], { type: 'bleed_out', id: t.id });
  assert.deepEqual(log[i + 1], { type: 'death', id: t.id, by: a.id }, 'death follows, credited to whoever downed it');
  assert.equal(t.alive, false);
  assert.equal(a.kills, 1);
});

test('a unit downed during its own turn starts bleeding next turn', () => {
  const { s, a, b, es } = arena({ me: [5, 5], mate: [6, 5], foes: [[5, 12], [30, 30]] });
  // Overwatch from the enemy downs us as we move.
  sureShot(es[0]);
  es[0].overwatch = true;
  a.hp = 1;
  const r = act(s, a.id, { type: 'move', x: 5, y: 8 });
  assert.ok(r.events.some((e) => e.type === 'downed' && e.id === a.id));
  endTeamTurn(s);
  assert.equal(a.bleed, 2);
  assert.ok(b.alive);
});

test('revive: adjacent squadmate, 1 AP, back at 3 HP and acts next turn', () => {
  const { s, a, b, es } = arena({ me: [5, 5], mate: [6, 6], foes: [[20, 20], [30, 30]] });
  // Down the mate with the enemy.
  cycleTo(s, es[0].team);
  b.hp = 1;
  es[0].x = 6; es[0].y = 10;
  sureShot(es[0]);
  act(s, es[0].id, { type: 'shoot', targetId: b.id });
  assert.ok(b.downed);
  cycleTo(s, a.team);
  assert.deepEqual([...reviveTargets(s, a)], [6 * S + 6]);
  const far = { ...a, x: 9, y: 9 };
  assert.equal(reviveTargets(s, far).size, 0);
  const r = act(s, a.id, { type: 'revive', targetId: b.id });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.events, [{ type: 'revive', id: b.id, by: a.id, hp: 3 }]);
  assert.equal(b.downed, false);
  assert.equal(b.hp, 3);
  assert.equal(b.ap, 0);
  assert.equal(a.ap, 1);
  assert.equal(act(s, a.id, { type: 'revive', targetId: b.id }).ok, false, 'already up');
  assert.equal(act(s, a.id, { type: 'revive', targetId: es[0].id }).ok, false, 'not an enemy');
});

test('medic patch: heals self or adjacent ally, revives downed at 4 HP, cooldown 2', () => {
  const { s, a, b, es } = arena({ me: [5, 5, 'medic'], mate: [6, 5], foes: [[20, 20], [30, 30]] });
  assert.equal(act(s, a.id, { type: 'patch', targetId: a.id }).ok, false, 'full HP');
  b.hp = 3;
  assert.ok(patchTargets(s, a).has(5 * S + 6));
  const r = act(s, a.id, { type: 'patch', targetId: b.id });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.events, [{ type: 'patch', id: a.id, target: b.id, amount: 5 }]);
  assert.equal(b.hp, 8);
  assert.equal(a.cooldowns.patch, 2);
  assert.equal(act(s, a.id, { type: 'patch', targetId: b.id }).ok, false, 'cooldown');
  assert.equal(abilityInfo(a, s).find((x) => x.key === 'patch').reason, 'Cooldown 2');
  cycleTo(s, a.team);
  assert.equal(a.cooldowns.patch, 1);
  cycleTo(s, a.team);
  assert.equal(a.cooldowns.patch, 0);
  // Self patch, capped at max HP.
  a.hp = a.maxHp - 2;
  const self = act(s, a.id, { type: 'patch' });
  assert.deepEqual(self.events, [{ type: 'patch', id: a.id, target: a.id, amount: 2 }]);
  // Revive through patch.
  cycleTo(s, a.team); cycleTo(s, a.team);
  b.downed = true; b.hp = 0; b.bleed = 2;
  const rv = act(s, a.id, { type: 'patch', targetId: b.id });
  assert.deepEqual(rv.events, [
    { type: 'patch', id: a.id, target: b.id, amount: 4 },
    { type: 'revive', id: b.id, by: a.id, hp: 4 },
  ]);
  // Not adjacent / not a medic.
  cycleTo(s, a.team); cycleTo(s, a.team);
  b.x = 9; b.hp = 2;
  assert.equal(act(s, a.id, { type: 'patch', targetId: b.id }).ok, false);
  const { s: s2, a: notMedic } = arena({ me: [5, 5, 'assault'] });
  notMedic.hp = 2;
  assert.equal(act(s2, notMedic.id, { type: 'patch' }).ok, false);
});

test('squad wipe: when the last standing member falls, downed squadmates die and the team is out', () => {
  const { s, a, es } = arena({ me: [5, 5], foes: [[5, 9], [30, 30], [6, 9]] });
  const [t, , mate] = es;
  t.downed = true; t.hp = 0; t.bleed = 2; t.downedBy = a.id;
  mate.hp = 1;
  sureShot(a);
  const r = act(s, a.id, { type: 'shoot', targetId: mate.id });
  const types = r.events.map((e) => e.type);
  assert.ok(!types.includes('downed'), 'last one standing dies outright');
  const deaths = r.events.filter((e) => e.type === 'death').map((e) => e.id);
  assert.deepEqual(deaths.sort(), [t.id, mate.id].sort());
  assert.ok(types.indexOf('team_out') > types.lastIndexOf('death'));
  assert.equal(t.alive, false);
  assert.equal(t.downed, false);
  assert.ok(!aliveTeams(s).includes(t.team));
  assert.equal(a.kills, 2);
});

test('solos: no downed state, units die outright', () => {
  const { s, a, es } = arena({ mode: 'solos', me: [5, 5], foes: [[5, 9], [20, 20]] });
  es[0].hp = 1;
  sureShot(a);
  const r = act(s, a.id, { type: 'shoot', targetId: es[0].id });
  assert.ok(r.events.some((e) => e.type === 'death' && e.id === es[0].id));
  assert.ok(!r.events.some((e) => e.type === 'downed'));
  assert.ok(!abilityInfo(a, s).some((x) => x.key === 'revive'));
});

test('the tide finishes downed units and can down standing ones', () => {
  const { s, a, b, es } = arena({ me: [5, 5], mate: [6, 5], foes: [[20, 20], [30, 30]] });
  s.zone.r = 1; s.zone.x = 30; s.zone.y = 30; // everyone but es[1] outside
  b.downed = true; b.hp = 0; b.bleed = 2;
  a.hp = 50; a.maxHp = 50;
  const log = endTeamTurn(s);
  assert.ok(log.some((e) => e.type === 'zone_damage' && e.id === b.id));
  assert.ok(log.some((e) => e.type === 'death' && e.id === b.id && e.by === null));
  assert.ok(a.alive && !a.downed);
  // Standing unit with a standing squadmate gets downed by the tide.
  const { s: s2, a: a2, b: b2 } = arena({ me: [5, 5], mate: [6, 5], foes: [[20, 20], [30, 30]] });
  s2.zone.r = 3; s2.zone.x = 6; s2.zone.y = 1; // mate inside, me outside
  a2.x = 5; a2.y = 9; a2.hp = 1;
  const log2 = endTeamTurn(s2);
  const zd = log2.find((e) => e.type === 'zone_damage' && e.id === a2.id);
  assert.equal(zd.downed, true);
  assert.ok(a2.downed && b2.alive);
});

test('friendly fire on a downed squadmate kills it without kill credit', () => {
  const { s, a, b, es } = arena({ me: [5, 5], mate: [8, 5], foes: [[9, 5], [30, 30], [20, 20]] });
  b.downed = true; b.hp = 0; b.bleed = 2;
  const r = act(s, a.id, { type: 'grenade', x: 9, y: 5 });
  const bd = r.events.find((e) => e.type === 'damage' && e.id === b.id);
  assert.equal(bd.downed, false);
  assert.ok(r.events.some((e) => e.type === 'death' && e.id === b.id));
  assert.equal(es[0].hp, es[0].maxHp - 3);
  assert.equal(a.kills, 0);
  // Explosion downs the enemy with a standing mate -> damage.downed true.
  es[0].hp = 2;
  const r2 = act(s, a.id, { type: 'grenade', x: 9, y: 6 });
  assert.equal(r2.events.find((e) => e.type === 'damage' && e.id === es[0].id).downed, true);
});

test('downed units do not spot for their team', () => {
  const { s, a, b, es } = arena({ me: [5, 5], mate: [25, 25], foes: [[5, 12], [30, 30]] });
  assert.ok(teamSeesUnit(s, a.team, es[0]));
  a.downed = true; a.hp = 0;
  assert.ok(!teamSeesUnit(s, a.team, es[0]));
  assert.ok(b.alive);
});

test('smoke: 1 AP, frag reach rules, -20 aim into it, clears at thrower\'s next-round turn start', () => {
  // The enemy stands next to the cloud, so it can still see (and shoot) into it.
  const { s, a, b, es } = arena({ me: [5, 5, 'recon'], mate: [7, 9], foes: [[7, 11], [30, 30]] });
  assert.equal(act(s, a.id, { type: 'smoke', x: 13, y: 5 }).ok, false, 'out of reach (8)');
  assert.ok(smokeTargets(s, a).has(9 * S + 7));
  const before = hitChance(s, es[0], b).chance;
  const r = act(s, a.id, { type: 'smoke', x: 7, y: 9 });
  assert.ok(r.ok, r.error);
  const ev = r.events[0];
  assert.deepEqual(ev, { type: 'smoke', id: a.id, x: 7, y: 9, radius: 1.5, smokeId: ev.smokeId });
  assert.equal(a.items.smoke, 0);
  assert.equal(a.ap, 1, 'smoke does not end the turn');
  assert.deepEqual(s.smokes, [{ id: ev.smokeId, x: 7, y: 9, radius: 1.5, team: a.team, expiresRound: s.round + 1, expiresTeam: a.team }]);
  const after = hitChance(s, es[0], b);
  assert.equal(before - after.chance, SMOKE.aimIn);
  assert.ok(after.notes.some((n) => n.startsWith('Target in smoke')));
  assert.equal(act(s, a.id, { type: 'smoke', x: 7, y: 9 }).ok, false, 'no smoke left');
  // Still there through the enemy turns of this round...
  const round = s.round;
  const log = cycleLog(s, a.team);
  assert.equal(s.round, round + 1);
  const clear = log.findIndex((e) => e.type === 'smoke_clear');
  assert.ok(clear >= 0);
  assert.deepEqual(log[clear], { type: 'smoke_clear', smokeId: ev.smokeId });
  assert.ok(clear < log.findIndex((e) => e.type === 'turn_start' && e.team === a.team));
  assert.equal(s.smokes.length, 0);
});

test('scan: recon only, 12 tiles, no LOS needed, reveals radius 5 until the recon team\'s next turn', () => {
  const { s, a, es } = arena({ me: [5, 5, 'recon'], foes: [[15, 9], [17, 10], [30, 30]] });
  for (let y = 0; y < S; y++) setCover(s, 9, y, 2); // a wall: no LOS at all
  assert.ok(!teamSeesUnit(s, a.team, es[0]));
  assert.equal(act(s, a.id, { type: 'scan', x: 18, y: 5 }).ok, false, '13 tiles is too far');
  const pv = scanPreview(s, a, 15, 9);
  assert.equal(pv.valid, true);
  assert.deepEqual(pv.units, [], 'never leaks hidden units');
  const r = act(s, a.id, { type: 'scan', x: 15, y: 9 });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.events, [{ type: 'scan', id: a.id, x: 15, y: 9, radius: 5, revealed: [es[0].id, es[1].id] }]);
  assert.ok(teamSeesUnit(s, a.team, es[0]) && teamSeesUnit(s, a.team, es[1]));
  assert.ok(!teamSeesUnit(s, a.team, es[2]));
  assert.equal(a.cooldowns.scan, 3);
  assert.equal(a.ap, 1);
  assert.equal(scanPreview(s, a, 15, 9).valid, false, 'cooldown');
  // Revealed units stay tagged even after they move, until our next turn starts.
  cycleTo(s, es[0].team);
  assert.equal(teamSeesUnit(s, a.team, es[0]), true);
  const log = cycleLog(s, a.team);
  assert.ok(log.some((e) => e.type === 'reveal_end' && e.team === a.team));
  assert.ok(!teamSeesUnit(s, a.team, es[0]));
  const { s: s2, a: notRecon } = arena({ me: [5, 5, 'assault'] });
  assert.equal(act(s2, notRecon.id, { type: 'scan', x: 8, y: 8 }).ok, false);
});

test('abilityInfo covers patch, scan, smoke and revive', () => {
  const { s, a: medic } = arena({ me: [5, 5, 'medic'], mate: [6, 5, 'recon'] });
  const keys = abilityInfo(medic, s).map((x) => x.key);
  assert.deepEqual(keys, ['grenade', 'smoke', 'patch', 'revive', 'hunker']);
  const recon = s.units.find((u) => u.alive && u.cls === 'recon');
  const info = abilityInfo(recon, s);
  assert.deepEqual(info.map((x) => x.key), ['grenade', 'smoke', 'scan', 'revive', 'hunker']);
  const sm = info.find((x) => x.key === 'smoke');
  assert.equal(sm.charges, 1);
  assert.equal(info.find((x) => x.key === 'scan').ready, true);
  assert.equal(abilityInfo(medic, s).find((x) => x.key === 'patch').reason, 'Nobody hurt nearby');
  assert.equal(abilityInfo(medic, s).find((x) => x.key === 'revive').reason, 'No downed squadmate adjacent');
  for (const e of info) assert.ok(e.name && e.desc);
});

test('a blast that ends the match stops before it can hurt the winners', () => {
  const { s, a, es } = arena({ mode: 'solos', me: [5, 5], foes: [[6, 6]] });
  es[0].hp = 1; a.hp = 1;
  const r = act(s, a.id, { type: 'grenade', x: 6, y: 6 });
  assert.ok(r.ok);
  assert.equal(s.winner, a.team);
  assert.ok(a.alive, 'thrower would have died, but the match was already won');
  assert.ok(r.events.some((e) => e.type === 'game_over' && e.winner === a.team));
});
