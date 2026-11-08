// Tidefall 5.0 sim: engagement turns, 7 classes, perks, weapons/ammo, equipment, killstreaks, AI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, act, endTeamTurn, currentTeamId, activeTeams, isTeamActive, engagements, freeTeams, aliveTeams,
  shotPreview, moveOptions, abilityInfo, validateLoadout, streakInfo, streakTargets, streakPreview,
  equipmentTargets, equipmentPreview, deployCoverTargets, suppressPreview, weaponInfo, launchPreview, startFirstRound,
} from '../src/sim/game.js';
import { botTakeTurn } from '../src/sim/ai.js';
import { hitChance, teamSeesUnit } from '../src/sim/rules.js';
import {
  CLASSES, MODES, STAGE_KEYS, REVIVE_HP, SUPPRESS, ZONE, COVER_PENALTY,
} from '../src/sim/constants.js';
import {
  WEAPONS, CATEGORIES, SECONDARIES, ATTACHMENTS, ATTACHMENT_SLOTS, LEGENDARIES, EQUIPMENT, STREAKS, PERKS,
  buildWeapon, weaponsForClass, CLASS_WEAPONS, weaponUnlocks, CAMO_CHALLENGES,
} from '../src/sim/weapons.js';
import { applyLoadout, randomLoadout } from '../src/sim/loadout.js';
import { makeRng } from '../src/sim/rng.js';
import { arena, S, setCover, coverAt, cycleTo, cycleLog, only } from './helpers.js';

const sureShot = (u) => { u.weapon.aim = 300; };
const sureMiss = (u) => { u.weapon.aim = -300; };
const key = (x, y) => y * S + x;
const types = (evs) => evs.map((e) => e.type);
const water = (s, x, y) => { s.map.terrain[y * S + x] = 2; };

/** Bot-plays a whole match with the engagement-turn loop; returns state + log. */
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

// ---------- 1. Engagement turns ----------

test('engagement: squads in sight form a group and act in different steps; free squads act at once', () => {
  const { s, a, es } = arena({ me: [5, 5], foes: [[5, 9], [30, 30], [40, 5]] });
  const groups = engagements(s);
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0]].sort((x, y) => x - y), [a.team, es[0].team].sort((x, y) => x - y));
  assert.ok(freeTeams(s).includes(es[1].team) || freeTeams(s).includes(es[2].team));
  // The two engaged squads never share a step.
  let guard = 0;
  const seenTogether = [];
  const startRound = s.round;
  while (s.round < startRound + 2 && guard++ < 50) {
    const act0 = activeTeams(s);
    if (act0.includes(a.team) && act0.includes(es[0].team)) seenTogether.push(s.round);
    endTeamTurn(s, act0[0]);
  }
  assert.deepEqual(seenTogether, []);
});

test('engagement events: round_start, engagement, step_start, turn_start per squad; order rotates each round', () => {
  const { s, a, es } = arena({ me: [5, 5], foes: [[5, 9], [30, 30]] });
  const log = [];
  const firsts = [];
  let guard = 0;
  const r0 = s.round;
  while (s.round < r0 + 3 && guard++ < 60) {
    if (s.turn.step === 0 && !firsts.some((f) => f.round === s.round)) firsts.push({ round: s.round, first: s.turn.groups[0]?.[0] });
    log.push(...endTeamTurn(s, activeTeams(s)[0]));
  }
  const i = log.findIndex((e) => e.type === 'round_start');
  assert.ok(i >= 0);
  assert.equal(log[i + 1]?.type === 'engagement' || log.slice(i, i + 4).some((e) => e.type === 'engagement'), true);
  const eng = log.find((e) => e.type === 'engagement');
  assert.ok(Array.isArray(eng.groups) && Array.isArray(eng.free));
  const ss = log.filter((e) => e.type === 'step_start');
  assert.ok(ss.some((e) => e.step === 1), 'the group needs a second step');
  for (const e of ss) {
    assert.ok(Array.isArray(e.active));
    // each active squad gets its own turn_start right after
    const at = log.indexOf(e);
    const starts = log.slice(at + 1).filter((x) => x.type === 'turn_start').slice(0, e.active.length).map((x) => x.team);
    assert.deepEqual(starts, e.active);
  }
  const order = firsts.map((f) => f.first).filter((x) => x !== undefined);
  assert.ok(order.length >= 2 && order[0] !== order[1], `group order rotates: ${order}`);
  void a; void es;
});

test('concurrency: free squads are active together, each ends its own turn; step advances when all are done', () => {
  const { s, a, es } = arena({ me: [5, 5], foes: [[30, 30], [40, 5]] });
  const act0 = activeTeams(s);
  assert.deepEqual([...act0].sort((x, y) => x - y), [a.team, es[0].team, es[1].team].sort((x, y) => x - y));
  assert.ok(isTeamActive(s, a.team) && isTeamActive(s, es[0].team));
  assert.equal(currentTeamId(s), act0[0], 'deprecated alias = activeTeams[0]');
  // Both can act in the same step, in arrival order.
  assert.ok(act(s, es[0].id, { type: 'move', x: 30, y: 31 }).ok);
  assert.ok(act(s, a.id, { type: 'move', x: 5, y: 6 }).ok);
  const r = s.round;
  assert.ok(endTeamTurn(s, a.team).length >= 0);
  assert.equal(isTeamActive(s, a.team), false);
  assert.equal(act(s, a.id, { type: 'hunker' }).ok, false, 'done squads cannot act');
  assert.deepEqual(endTeamTurn(s, a.team), [], 'ending a finished turn is a no-op');
  endTeamTurn(s, es[0].team);
  assert.equal(s.round, r);
  const log = endTeamTurn(s, es[1].team);
  assert.equal(s.round, r + 1);
  assert.ok(log.some((e) => e.type === 'round_start' && e.round === r + 1));
});

test('zone damage applies at the end of each squad\'s own turn', () => {
  const { s, a, es } = arena({ me: [5, 5], foes: [[30, 30]] });
  s.zone.r = 1; s.zone.x = 40; s.zone.y = 40;
  const log = endTeamTurn(s, a.team);
  assert.ok(log.some((e) => e.type === 'zone_damage' && e.id === a.id));
  assert.ok(!log.some((e) => e.type === 'zone_damage' && e.id === es[0].id));
  assert.equal(es[0].hp, es[0].maxHp);
});

test('a squad wiped while it was the last active one moves the match on', () => {
  const { s, a, es } = arena({ mode: 'solos', me: [5, 5], foes: [[5, 25], [40, 40]] });
  assert.ok(isTeamActive(s, es[0].team) && isTeamActive(s, a.team));
  sureShot(a);
  act(s, a.id, { type: 'overwatch' });
  endTeamTurn(s, a.team);
  endTeamTurn(s, es[1].team);
  es[0].hp = 1;
  const r0 = s.round;
  const r = act(s, es[0].id, { type: 'move', x: 5, y: 14 });
  assert.ok(r.ok);
  assert.ok(r.events.some((e) => e.type === 'death' && e.id === es[0].id));
  assert.equal(s.round, r0 + 1, 'nobody left in the step: next round');
  assert.ok(r.events.some((e) => e.type === 'round_start'));
  assert.ok(activeTeams(s).length > 0);
});

test('deterministic: same seed, same event stream with 5.0 kit (loadouts, equipment, streaks)', () => {
  const a = simulate({ seed: 4242, mode: 'duos', stage: 'rig', noHuman: true });
  const b = simulate({ seed: 4242, mode: 'duos', stage: 'rig', noHuman: true });
  assert.deepEqual(a.log, b.log);
  assert.equal(a.state.winner, b.state.winner);
});

// ---------- 2. Classes ----------

test('7 classes with role, ability, hp/armour and allowed primaries', () => {
  assert.equal(Object.keys(CLASSES).length, 7);
  assert.deepEqual(CLASS_WEAPONS.engineer, ['SMG', 'Shotgun', 'Carbine']);
  assert.deepEqual(CLASS_WEAPONS.gunner, ['LMG']);
  for (const [k, c] of Object.entries(CLASSES)) {
    assert.ok(c.hp > 0 && c.armor >= 0 && c.move > 0 && c.ability, k);
    assert.ok(weaponsForClass(k).length >= 3, k);
    assert.ok(c.weapons.includes(c.weapon.cat), `${k} default weapon is allowed`);
  }
});

test('engineer: deploy cover places a full-cover barricade on an adjacent open tile (1 AP, cooldown 3)', () => {
  const { s, a, es } = arena({ me: [5, 5, 'engineer'], foes: [[5, 12]] });
  const t = deployCoverTargets(s, a);
  assert.equal(t.size, 8);
  assert.equal(act(s, a.id, { type: 'deploy_cover', x: 7, y: 5 }).ok, false, 'not adjacent');
  const r = act(s, a.id, { type: 'deploy_cover', x: 5, y: 6 });
  assert.ok(r.ok, r.error);
  assert.deepEqual(types(r.events), ['deploy_cover', 'cover_change']);
  assert.equal(coverAt(s, 5, 6), 2);
  assert.equal(a.ap, 1, "doesn't end the turn");
  assert.equal(a.cooldowns.deploy_cover, 3);
  assert.equal(hitChance(s, es[0], a).cover, 2);
  assert.equal(deployCoverTargets(s, a).size, 0);
  const { a: other } = arena({ me: [5, 5, 'assault'] });
  assert.equal(act(other.s ?? s, other.id, { type: 'deploy_cover', x: 5, y: 6 }).ok, false);
});

test('gunner: suppress costs 1 AP + 3 ammo, ends turn, -25 aim, moving draws one reaction shot, expires after its turn', () => {
  const { s, a, es } = arena({ me: [5, 5, 'gunner'], foes: [[5, 12, 'assault'], [30, 30]] });
  const t = es[0];
  const before = hitChance(s, t, a).chance;
  const ammo = a.ammo;
  assert.ok(suppressPreview(s, a, t));
  const r = act(s, a.id, { type: 'suppress', targetId: t.id });
  assert.ok(r.ok, r.error);
  assert.deepEqual(types(r.events).slice(0, 1), ['suppress']);
  assert.equal(a.ap, 0);
  assert.equal(a.ammo, ammo - SUPPRESS.ammo);
  assert.equal(a.cooldowns.suppress, SUPPRESS.cooldown);
  assert.equal(before - hitChance(s, t, a).chance, SUPPRESS.aim);
  cycleTo(s, t.team);
  sureShot(a);
  t.hp = 50; t.maxHp = 50;
  const m = act(s, t.id, { type: 'move', x: 7, y: 12 });
  assert.ok(m.events.some((e) => e.type === 'suppress_trigger' && e.id === a.id));
  assert.ok(m.events.some((e) => e.type === 'shot' && e.from === a.id && e.reaction));
  const m2 = act(s, t.id, { type: 'move', x: 8, y: 12 });
  assert.ok(!m2.events.some((e) => e.type === 'suppress_trigger'), 'only once');
  endTeamTurn(s, t.team);
  assert.equal(t.suppressed, null);
});

test('assault: Run & Gun lets it shoot after a dash, once per 3 rounds', () => {
  const { s, a, es } = arena({ me: [5, 5, 'assault'], foes: [[5, 16], [30, 30]] });
  only(s, a.team);
  sureShot(a);
  es[0].hp = 99; es[0].maxHp = 99;
  const m = act(s, a.id, { type: 'move', x: 5, y: 12 });
  assert.ok(m.ok, m.error);
  assert.equal(a.ap, 0);
  assert.ok(a.runGun);
  const r = act(s, a.id, { type: 'shoot', targetId: es[0].id });
  assert.ok(r.ok, r.error);
  assert.equal(a.cooldowns.run_gun, 3);
  cycleTo(s, a.team);
  act(s, a.id, { type: 'move', x: 5, y: 5 });
  assert.equal(a.runGun, false, 'on cooldown');
  const { s: s2, a: m2 } = arena({ me: [5, 5, 'medic'], foes: [[5, 16], [30, 30]] });
  act(s2, m2.id, { type: 'move', x: 5, y: 12 });
  assert.equal(act(s2, m2.id, { type: 'shoot', targetId: s2.units.find((u) => u.alive && u.team !== m2.team).id }).ok, false);
});

// ---------- 2b. Perks ----------

test('PERKS: 3 tiers × 4 with key/name/desc', () => {
  for (const t of ['tier1', 'tier2', 'tier3']) {
    assert.equal(PERKS[t].length, 4);
    for (const p of PERKS[t]) assert.ok(p.key && p.name && p.desc);
  }
});

test('perk Scavenger: a kill refills the magazine and adds a lethal', () => {
  const { s, a, es } = arena({ mode: 'solos', me: [5, 5, 'assault', { perks: ['scavenger', 'steady', 'quickfix'] }], foes: [[5, 9], [30, 30]] });
  a.ammo = 1; const lethal = a.items[a.lethal];
  sureShot(a); es[0].hp = 1;
  const r = act(s, a.id, { type: 'shoot', targetId: es[0].id });
  assert.ok(r.events.some((e) => e.type === 'scavenge'));
  assert.equal(a.ammo, a.weapon.mag);
  assert.equal(a.items[a.lethal], lethal + 1);
});

test('perk Amphibious: shallow water costs normal movement; tide damage -1', () => {
  const mk = (perks) => arena({ me: [5, 5, 'assault', { perks }], foes: [[30, 30]] });
  const { s, a } = mk(['amphibious', 'ghost', 'tracker']);
  const { s: s2, a: b } = mk(['lightweight', 'ghost', 'tracker']);
  for (let x = 0; x < S; x++) for (let y = 0; y < S; y++) { water(s, x, y); water(s2, x, y); }
  assert.ok(moveOptions(s, a).has(key(5, 17)));
  assert.ok(!moveOptions(s2, b).has(key(5, 17)), 'water costs 2 for everyone else');
  s.zone.r = 1; s.zone.x = 40; s.zone.y = 40;
  const ev = endTeamTurn(s, a.team).find((e) => e.type === 'zone_damage' && e.id === a.id);
  assert.equal(ev.dmg, ZONE.damage - 1);
});

test('perk Lightweight: +1 move; Trapper: starts with a Claymore', () => {
  const u1 = applyLoadout({ cooldowns: {} }, { cls: 'recon', perks: ['lightweight', 'trapper', 'mask'] });
  assert.equal(u1.move, CLASSES.recon.move + 1);
  assert.ok(u1.items.claymore >= 1);
  const u2 = applyLoadout({ cooldowns: {} }, { cls: 'recon', lethal: 'frag', perks: ['flak', 'ghost', 'mask'] });
  assert.equal(u2.move, CLASSES.recon.move);
  assert.equal(u2.items.claymore, 0);
});

test('perk Flak Jacket: explosive damage halved', () => {
  const { s, a, es } = arena({ me: [5, 5], foes: [[8, 8, 'assault', { perks: ['flak', 'ghost', 'mask'] }], [10, 8]] });
  const r = act(s, a.id, { type: 'grenade', x: 9, y: 8 });
  assert.ok(r.ok, r.error);
  const d = (id) => r.events.find((e) => e.type === 'damage' && e.id === id).dmg;
  assert.equal(d(es[0].id), 2);
  assert.equal(d(es[1].id), 3);
});

test('perk Ghost: immune to Scan and UAV', () => {
  const { s, a, es } = arena({ me: [5, 5, 'recon', { perks: ['flak', 'ghost', 'mask'] }], foes: [[5, 15, 'assault', { perks: ['flak', 'ghost', 'mask'] }], [8, 15]] });
  a.perks = [];
  const r = act(s, a.id, { type: 'scan', x: 6, y: 15 });
  assert.ok(r.ok, r.error);
  assert.ok(!r.events[0].revealed.includes(es[0].id));
  assert.ok(r.events[0].revealed.includes(es[1].id));
});

test('perk Hardline: streaks cost 1 fewer kill', () => {
  const { s, a, es } = arena({ mode: 'solos', me: [5, 5, 'assault', { perks: ['flak', 'hardline', 'mask'], streaks: ['uav', 'care', 'gunship'] }], foes: [[5, 9], [30, 30]] });
  assert.equal(streakInfo(s, a).find((x) => x.key === 'uav').cost, STREAKS.uav.cost - 1);
  a.points = 0; sureShot(a); es[0].hp = 1;
  const r = act(s, a.id, { type: 'shoot', targetId: es[0].id });
  assert.ok(r.events.some((e) => e.type === 'streak_ready' && e.id === a.id && e.key === 'care'), 'care (3-1=2) unlocks on a 2-point kill');
});

test('perk Steady Aim: +10 aim if you haven\'t moved this turn', () => {
  const { s, a, es } = arena({ me: [5, 5, 'assault', { perks: ['flak', 'steady', 'mask'] }], foes: [[5, 12]] });
  const still = hitChance(s, a, es[0]).chance;
  a.moved = true;
  assert.equal(still - hitChance(s, a, es[0]).chance, 10);
});

test('perk Dead Silence: no gunfire ping; first move each turn ignores overwatch', () => {
  const { s, a, es } = arena({ me: [5, 5, 'assault', { perks: ['flak', 'ghost', 'deadsilence'] }], foes: [[5, 13], [30, 30]] });
  only(s, a.team);
  // Fresh turn so the first-move flag is armed.
  cycleTo(s, a.team);
  es[0].overwatch = true; sureShot(es[0]); es[0].ammo = 5;
  const m1 = act(s, a.id, { type: 'move', x: 6, y: 7 });
  assert.ok(!m1.events.some((e) => e.type === 'overwatch_trigger'));
  a.hp = 50; a.maxHp = 50;
  const m2 = act(s, a.id, { type: 'move', x: 6, y: 9 });
  assert.ok(m2.events.some((e) => e.type === 'overwatch_trigger'));
  const { s: s2, a: b, es: f2 } = arena({ me: [5, 5, 'assault', { perks: ['flak', 'ghost', 'deadsilence'] }], foes: [[5, 9]] });
  const sh = act(s2, b.id, { type: 'shoot', targetId: f2[0].id });
  assert.ok(!sh.events.some((e) => e.type === 'noise'));
  const { s: s3, a: c, es: f3 } = arena({ me: [5, 5], foes: [[5, 9]] });
  assert.ok(act(s3, c.id, { type: 'shoot', targetId: f3[0].id }).events.some((e) => e.type === 'noise' && e.id === c.id));
});

test('perk Quick Fix: heal 3 on a kill or revive; revived at +2 HP', () => {
  const { s, a, b, es } = arena({ me: [5, 5, 'assault', { perks: ['flak', 'ghost', 'quickfix'] }], mate: [6, 5, 'assault', { perks: ['flak', 'ghost', 'quickfix'] }], foes: [[5, 9], [30, 30], [31, 30]] });
  a.hp = 4; sureShot(a); es[0].hp = 1; es[0].downed = true;
  const r = act(s, a.id, { type: 'shoot', targetId: es[0].id });
  assert.ok(r.events.some((e) => e.type === 'heal' && e.id === a.id && e.source === 'quickfix' && e.amount === 3));
  b.downed = true; b.hp = 0; b.bleed = 2; a.ap = 2;
  const rv = act(s, a.id, { type: 'revive', targetId: b.id });
  assert.ok(rv.ok, rv.error);
  assert.equal(b.hp, REVIVE_HP + 2);
});

test('perk Tracker: enemies you damage are revealed to your squad until your next turn', () => {
  const { s, a, es } = arena({ me: [5, 5, 'assault', { perks: ['flak', 'ghost', 'tracker'] }], foes: [[5, 9], [30, 30]] });
  sureShot(a); es[0].hp = 50; es[0].maxHp = 50;
  const r = act(s, a.id, { type: 'shoot', targetId: es[0].id });
  assert.ok(r.events.some((e) => e.type === 'tracked' && e.id === es[0].id));
  es[0].x = 40; es[0].y = 40;
  assert.ok(teamSeesUnit(s, a.team, es[0]));
  cycleTo(s, a.team);
  assert.ok(!teamSeesUnit(s, a.team, es[0]));
});

test('perk Tactical Mask: immune to flashbangs and the smoke aim penalty', () => {
  const { s, a, es } = arena({ me: [5, 5, 'breacher', { lethal: 'frag', tactical: 'flashbang', perks: ['flak', 'ghost', 'tracker'] }], foes: [[8, 8, 'assault', { perks: ['flak', 'ghost', 'mask'] }], [9, 8]] });
  const r = act(s, a.id, { type: 'flashbang', x: 8, y: 8 });
  assert.ok(r.ok, r.error);
  const ev = r.events[0];
  assert.ok(ev.immune.includes(es[0].id) && ev.hit.includes(es[1].id));
  assert.equal(es[0].flash ?? null, null);
  s.smokes.push({ id: 9, x: es[0].x, y: es[0].y, radius: 1.5, team: a.team, expiresRound: 9, expiresTeam: a.team });
  const masked = hitChance(s, es[0], a).chance;
  es[0].perks = [];
  assert.equal(masked - hitChance(s, es[0], a).chance, 20);
});

// ---------- 3. Weapons, attachments, ammo ----------

test('weapon catalog: ≥18 primaries over 7 categories, all sidegrades', () => {
  const ws = Object.values(WEAPONS);
  assert.ok(ws.length >= 18);
  assert.deepEqual(new Set(ws.map((w) => w.cat)), new Set(Object.keys(CATEGORIES)));
  for (const w of ws) {
    assert.ok(w.id && w.name && w.range > 0 && w.aim > 0 && w.dmg.length === 2 && w.mag > 0, w.id);
  }
  // No weapon is at least as good as another of its category on every axis.
  const axes = (w) => [w.range, w.aim, w.dmg[0] + w.dmg[1], w.mag, w.move || 0, w.special?.includes('pierce') ? 1 : 0, w.special?.includes('closePenalty') ? 0 : 1];
  for (const a of ws) for (const b of ws) {
    if (a === b || a.cat !== b.cat) continue;
    const A = axes(a), B = axes(b);
    const dominates = A.every((v, i) => v >= B[i]) && A.some((v, i) => v > B[i]);
    assert.ok(!dominates || (b.special || []).some((x) => !(a.special || []).includes(x)), `${a.id} strictly beats ${b.id}`);
  }
  assert.ok(SECONDARIES.pistol && SECONDARIES.mpistol && SECONDARIES.launcher);
});

test('attachments: 5 slots × ≥3, each with a pro and a con; buildWeapon applies them', () => {
  for (const slot of ATTACHMENT_SLOTS) {
    const list = Object.values(ATTACHMENTS).filter((a) => a.slot === slot);
    assert.ok(list.length >= 3, slot);
    for (const a of list) {
      assert.ok(a.pro && a.con, a.id);
      const nums = Object.values(a.mods).filter((v) => typeof v === 'number');
      assert.ok(nums.some((v) => v < 0), `${a.id} has a downside`);
    }
  }
  const w = buildWeapon('tr7', { optic: 'scope4x', magazine: 'extmag', stock: 'lightstock', barrel: 'nope' });
  assert.equal(w.aim, WEAPONS.tr7.aim + 6 - 3 - 5);
  assert.equal(w.mag, WEAPONS.tr7.mag + 3);
  assert.equal(w.move, 1);
  assert.equal(w.attachments.barrel, undefined);
});

test('legendaries: ≥6 named gold weapons, each with a unique trait', () => {
  const ls = Object.values(LEGENDARIES);
  assert.ok(ls.length >= 6);
  const traits = new Set(ls.map((l) => l.trait));
  assert.equal(traits.size, ls.length);
  for (const k of ['tidebreaker', 'maw', 'undertow', 'lantern', 'riptide', 'leviathan']) assert.ok(LEGENDARIES[k], k);
  assert.equal(LEGENDARIES.leviathan.mag, 4);
});

test('ammo: shots cost 1, empty can\'t shoot, reload is 1 AP and keeps the turn, spares run out', () => {
  const { s, a, es } = arena({ me: [5, 5], foes: [[5, 12], [30, 30]] });
  es[0].hp = 99; es[0].maxHp = 99;
  const mag = a.weapon.mag;
  assert.equal(a.ammo, mag);
  act(s, a.id, { type: 'shoot', targetId: es[0].id });
  assert.equal(a.ammo, mag - 1);
  cycleTo(s, a.team);
  a.ammo = 0;
  assert.ok(shotPreview(s, a, es[0]).needsReload);
  assert.equal(act(s, a.id, { type: 'shoot', targetId: es[0].id }).error, 'Reload');
  assert.equal(act(s, a.id, { type: 'overwatch' }).ok, false);
  a.weapon.spare = 2;
  const r = act(s, a.id, { type: 'reload' });
  assert.ok(r.ok);
  assert.deepEqual(types(r.events), ['reload']);
  assert.equal(a.ammo, 2);
  assert.equal(a.ap, 1);
  assert.equal(act(s, a.id, { type: 'reload' }).error, 'No spare ammo');
  assert.equal(weaponInfo(a).spare, 0);
});

test('swap: free, once per turn; pistol never needs reloading; burst fires two rolls for 1 round', () => {
  const { s, a, es } = arena({ me: [5, 5, 'assault', { secondary: 'pistol' }], foes: [[5, 9], [30, 30]] });
  es[0].hp = 99; es[0].maxHp = 99;
  a.ammo = 0;
  const r = act(s, a.id, { type: 'swap' });
  assert.ok(r.ok);
  assert.equal(a.weapon.id, 'pistol');
  assert.equal(a.ap, 2);
  assert.equal(act(s, a.id, { type: 'swap' }).error, 'Once per turn');
  act(s, a.id, { type: 'shoot', targetId: es[0].id });
  assert.ok(weaponInfo(a).infinite);
  cycleTo(s, a.team);
  act(s, a.id, { type: 'swap' });
  assert.equal(a.weapon.id, a.weapons[0].id);
  assert.equal(a.ammo, 0, 'the primary kept its empty magazine');
  // Burst
  const { s: s2, a: b, es: f2 } = arena({ me: [5, 5, 'assault', { primary: { id: 'kestrel' } }], foes: [[5, 9], [30, 30]] });
  f2[0].hp = 99; f2[0].maxHp = 99;
  const before = b.ammo;
  const sh = act(s2, b.id, { type: 'shoot', targetId: f2[0].id });
  assert.equal(sh.events.filter((e) => e.type === 'shot').length, 2);
  assert.equal(b.ammo, before - 1);
});

test('launcher: 2 rockets, blast radius 1.5, damages cover, never misses its tile', () => {
  const { s, a, es } = arena({ me: [5, 5, 'assault', { secondary: 'launcher' }], foes: [[5, 11], [30, 30]] });
  setCover(s, 5, 10, 2);
  act(s, a.id, { type: 'swap' });
  assert.equal(a.ammo, 2);
  const p = launchPreview(s, a, 5, 11);
  assert.ok(p.valid && p.radius === 1.5);
  const r = act(s, a.id, { type: 'shoot', x: 5, y: 11 });
  assert.ok(r.ok, r.error);
  assert.ok(r.events.some((e) => e.type === 'rocket'));
  assert.ok(r.events.some((e) => e.type === 'damage' && e.id === es[0].id && e.source === 'rocket'));
  assert.equal(coverAt(s, 5, 10), 1);
  assert.equal(a.ammo, 1);
  assert.equal(act(s, a.id, { type: 'reload' }).ok, false);
});

test('validateLoadout clamps anything illegal; opts.players seats humans with their loadouts', () => {
  const l = validateLoadout({ cls: 'gunner', primary: { id: 'longbow', attachments: { optic: 'grip', stock: 'lightstock' } }, secondary: { id: 'bazooka' }, lethal: 'nuke', tactical: 'stim', perks: ['ghost', 'hardline', 'mask'], streaks: ['uav', 'uav', 'moab'] });
  assert.equal(l.cls, 'gunner');
  assert.equal(WEAPONS[l.primary.id].cat, 'LMG');
  assert.deepEqual(l.primary.attachments, { stock: 'lightstock' });
  assert.equal(l.secondary.id, 'pistol');
  assert.ok(EQUIPMENT[l.lethal].slot === 'lethal');
  assert.equal(l.tactical, 'stim');
  assert.equal(l.perks[0] !== 'ghost', true, 'tier-1 slot rejects a tier-2 perk');
  assert.equal(l.perks[1], 'hardline');
  assert.equal(l.streaks.length, 3);
  assert.equal(new Set(l.streaks).size, 3);
  assert.deepEqual(validateLoadout(null).cls, 'assault');
  const s = createGame({ seed: 3, mode: 'duos', players: [
    { name: 'Ana', isHuman: true, squad: 1, loadout: { cls: 'engineer', primary: { id: 'gaff' } } },
    { name: 'Bo', isHuman: true, squad: 1, loadout: { cls: 'gunner' } },
    { name: 'Cy', isHuman: true, loadout: { cls: 'medic' } },
  ] });
  const ana = s.units.find((u) => u.name === 'Ana'), bo = s.units.find((u) => u.name === 'Bo'), cy = s.units.find((u) => u.name === 'Cy');
  assert.equal(ana.team, bo.team, 'same squad');
  assert.notEqual(cy.team, ana.team);
  assert.equal(ana.weapon.id, 'gaff');
  assert.ok(ana.isPlayer && bo.isHuman && cy.isPlayer);
  assert.equal(s.humanTeams.length, 2);
  for (let i = 0; i < 30; i++) {
    const rl = randomLoadout(makeRng(i), Object.keys(CLASSES)[i % 7]);
    assert.deepEqual(validateLoadout(rl), rl, 'bot loadouts are legal');
  }
});

test('crates: ammo, field attachment and gold (legendary) crates', () => {
  const { s, a } = arena({ me: [5, 5], foes: [[30, 30]] });
  a.ammo = 0; a.weapon.spare = 0;
  s.crates.push({ id: 900, x: 6, y: 5, type: 'ammo', taken: false });
  act(s, a.id, { type: 'move', x: 6, y: 5 });
  assert.equal(a.ammo, a.weapon.mag);
  assert.ok(a.weapon.spare > 0);
  s.crates.push({ id: 901, x: 7, y: 5, type: 'attachment', attachment: 'scope4x', taken: false });
  const r = act(s, a.id, { type: 'move', x: 7, y: 5 });
  assert.ok(r.events.some((e) => e.type === 'crate' && e.item === 'attachment' && e.attachment === 'scope4x'));
  assert.equal(a.weapon.attachments.optic, 'scope4x');
  cycleTo(s, a.team);
  s.crates.push({ id: 902, x: 8, y: 5, type: 'gold', weapon: 'maw', taken: false });
  const g = act(s, a.id, { type: 'move', x: 8, y: 5 });
  assert.ok(g.events.some((e) => e.type === 'crate' && e.weapon === 'maw'));
  assert.equal(a.weapon.id, 'maw');
  assert.ok(a.weapon.legendary);
});

test('supply drops are sometimes gold crates with a legendary', () => {
  let gold = 0, drops = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const { log } = simulate({ seed, mode: 'quads', noHuman: true });
    for (const e of log) {
      if (e.type !== 'supply_drop') continue;
      drops++;
      if (e.crate.type === 'gold') { gold++; assert.ok(LEGENDARIES[e.crate.weapon]); }
    }
  }
  assert.ok(drops > 10);
  assert.ok(gold > 0 && gold < drops, `${gold}/${drops} gold`);
});

test('legendary traits: Tidebreaker, Maw, Undertow, Lantern, Riptide, Siren', () => {
  const give = (u, id) => { u.weapon = buildWeapon(id); u.weapons[0] = u.weapon; u.ammo = u.weapon.mag; };
  { // Tidebreaker: cover counts one level lower
    const { s, a, es } = arena({ me: [5, 5, 'marksman'], foes: [[5, 14]] });
    setCover(s, 5, 13, 2);
    give(a, 'tidebreaker');
    assert.equal(hitChance(s, a, es[0]).cover, 1);
  }
  { // Maw: shreds the target's cover
    const { s, a, es } = arena({ me: [5, 5, 'breacher'], foes: [[5, 8], [30, 30]] });
    setCover(s, 5, 7, 2); give(a, 'maw'); sureShot(a); es[0].hp = 99; es[0].maxHp = 99;
    act(s, a.id, { type: 'shoot', targetId: es[0].id });
    assert.equal(coverAt(s, 5, 7), 1);
  }
  { // Undertow: slows; Lantern: flares; Siren: tracks
    const { s, a, es } = arena({ me: [5, 5, 'gunner'], foes: [[5, 9], [30, 30]] });
    give(a, 'undertow'); sureShot(a); es[0].hp = 99; es[0].maxHp = 99;
    const mv = es[0].move;
    act(s, a.id, { type: 'shoot', targetId: es[0].id });
    assert.equal(es[0].slow, 2);
    cycleTo(s, es[0].team);
    assert.ok(!moveOptions(s, es[0]).has(key(5, 9 + 2 * mv - 2)), 'slowed this turn');
    endTeamTurn(s, es[0].team);
    assert.equal(es[0].slow, 0);
  }
  {
    const { s, a, es } = arena({ me: [5, 5], foes: [[5, 9], [30, 30]] });
    give(a, 'lantern'); sureShot(a); es[0].hp = 99; es[0].maxHp = 99;
    const r = act(s, a.id, { type: 'shoot', targetId: es[0].id });
    assert.ok(r.events.some((e) => e.type === 'flare' && e.id === es[0].id));
  }
  {
    const { s, a, es } = arena({ mode: 'solos', me: [5, 5, 'medic'], foes: [[5, 9], [30, 30]] });
    give(a, 'riptide'); sureShot(a); es[0].hp = 1;
    const r = act(s, a.id, { type: 'shoot', targetId: es[0].id });
    assert.ok(r.events.some((e) => e.type === 'kill_move'));
    assert.equal(a.ap, 1);
    assert.equal(act(s, a.id, { type: 'hunker' }).error, 'Move only');
    assert.ok(act(s, a.id, { type: 'move', x: 6, y: 6 }).ok);
    assert.equal(a.ap, 0);
  }
  {
    const { s, a, es } = arena({ me: [5, 5, 'recon'], foes: [[5, 9], [30, 30]] });
    give(a, 'siren'); sureShot(a); es[0].hp = 99; es[0].maxHp = 99;
    const r = act(s, a.id, { type: 'shoot', targetId: es[0].id });
    assert.ok(r.events.some((e) => e.type === 'tracked' && e.id === es[0].id));
  }
});

// ---------- 3b. Equipment ----------

test('semtex sticks: +2 to the unit on the target tile; never misses its tile', () => {
  const { s, a, es } = arena({ me: [5, 5, 'assault', { lethal: 'semtex' }], foes: [[5, 10], [6, 10]] });
  const p = equipmentPreview(s, a, 'semtex', 5, 10);
  assert.equal(p.stuck, es[0].id);
  const r = act(s, a.id, { type: 'semtex', x: 5, y: 10 });
  assert.ok(r.ok, r.error);
  assert.equal(r.events[0].stuck, es[0].id);
  assert.equal(r.events.find((e) => e.type === 'damage' && e.id === es[0].id).dmg, EQUIPMENT.semtex.dmg + 2);
  assert.equal(r.events.find((e) => e.type === 'damage' && e.id === es[1].id).dmg, EQUIPMENT.semtex.dmg);
  assert.equal(a.ap, 1);
});

test('claymore: adjacent tile; the first enemy to move within 1.5 takes 5', () => {
  const { s, a, es } = arena({ me: [5, 5, 'engineer', { lethal: 'claymore' }], foes: [[5, 12], [30, 30]] });
  assert.equal(equipmentTargets(s, a, 'claymore').size, 8);
  assert.equal(act(s, a.id, { type: 'claymore', x: 5, y: 8 }).ok, false);
  const r = act(s, a.id, { type: 'claymore', x: 5, y: 6 });
  assert.ok(r.ok, r.error);
  assert.equal(s.claymores.length, 1);
  cycleTo(s, es[0].team);
  es[0].hp = 20; es[0].maxHp = 20;
  const m = act(s, es[0].id, { type: 'move', x: 5, y: 7 });
  assert.ok(m.events.some((e) => e.type === 'claymore_trigger' && e.target === es[0].id));
  assert.equal(m.events.find((e) => e.type === 'damage' && e.id === es[0].id).dmg, 5);
  assert.equal(s.claymores.length, 0);
});

test('throwing knife: range 4, 4 damage, silent, keeps the turn', () => {
  const { s, a, es } = arena({ me: [5, 5, 'medic', { lethal: 'knife' }], foes: [[5, 9], [5, 10]] });
  assert.ok(equipmentTargets(s, a, 'knife').has(key(5, 9)));
  assert.ok(!equipmentTargets(s, a, 'knife').has(key(5, 10)));
  a.weapon.aim = 300; // knife aim is its own
  es[0].hp = 20;
  let r;
  for (let i = 0; i < 2; i++) { r = act(s, a.id, { type: 'knife', targetId: es[0].id }); if (r.events[0].result === 'hit') break; a.ap = 2; }
  assert.ok(r.ok, r.error);
  assert.ok(!r.events.some((e) => e.type === 'noise' || e.type === 'flare'));
  if (r.events[0].result === 'hit') assert.equal(r.events[0].dmg, 4);
});

test('flashbang: enemies lose 1 AP next turn and -30 aim until it ends', () => {
  const { s, a, es } = arena({ me: [5, 5, 'breacher', { lethal: 'frag', tactical: 'flashbang' }], foes: [[5, 11], [30, 30]] });
  const before = hitChance(s, es[0], a).chance;
  const r = act(s, a.id, { type: 'flashbang', x: 5, y: 11 });
  assert.ok(r.ok, r.error);
  assert.equal(before - hitChance(s, es[0], a).chance, 30);
  cycleTo(s, es[0].team);
  assert.equal(es[0].ap, es[0].maxAp - 1);
  assert.ok(es[0].flash);
  endTeamTurn(s, es[0].team);
  assert.equal(es[0].flash, null);
});

test('stim: free, +1 AP this turn and heal 2; decoy pings and baits bot overwatch', () => {
  const { s, a, es } = arena({ me: [5, 5, 'assault', { tactical: 'stim' }], foes: [[5, 12], [30, 30]] });
  a.hp = 5;
  const r = act(s, a.id, { type: 'stim' });
  assert.ok(r.ok, r.error);
  assert.equal(a.ap, 3);
  assert.equal(a.hp, 7);
  const { s: s2, a: b, es: f2 } = arena({ me: [5, 5, 'recon', { tactical: 'decoy' }], foes: [[5, 12], [30, 30]] });
  f2[0].overwatch = true;
  const d = act(s2, b.id, { type: 'decoy', x: 6, y: 9 });
  assert.ok(d.ok, d.error);
  assert.ok(d.events.some((e) => e.type === 'noise' && e.x === 6 && e.y === 9));
  assert.ok(d.events.some((e) => e.type === 'overwatch_trigger' && e.id === f2[0].id && e.decoy !== undefined));
  assert.equal(f2[0].overwatch, false);
  assert.equal(s2.decoys.length, 1);
});

// ---------- 4. Killstreaks ----------

const streaky = (streaks, extra = {}) => arena({ me: [5, 5, 'assault', { streaks, perks: ['flak', 'ghost', 'mask'] }], foes: [[5, 12], [30, 30]], ...extra });

test('streaks: locked until kills reach cost, once each, one per turn, 0 AP', () => {
  const { s, a } = streaky(['uav', 'cuav', 'gunship']);
  let info = streakInfo(s, a);
  assert.deepEqual(info.map((x) => x.key), ['uav', 'cuav', 'gunship']);
  assert.equal(info[0].ready, false);
  assert.equal(act(s, a.id, { type: 'streak', key: 'uav' }).ok, false);
  a.points = 7;
  info = streakInfo(s, a);
  assert.ok(info.every((x) => x.ready));
  const r = act(s, a.id, { type: 'streak', key: 'uav' });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.events[0], { type: 'streak_used', id: a.id, key: 'uav' });
  assert.equal(a.ap, 2, 'free');
  assert.equal(act(s, a.id, { type: 'streak', key: 'cuav' }).error, 'One per turn');
  cycleTo(s, a.team);
  assert.equal(act(s, a.id, { type: 'streak', key: 'uav' }).error, 'Used');
  assert.ok(act(s, a.id, { type: 'streak', key: 'cuav' }).ok);
});

test('UAV reveals every enemy within 14 to your squad until your next turn (Ghost counters)', () => {
  const { s, a, es } = arena({ me: [5, 5, 'assault', { streaks: ['uav', 'care', 'sentry'], perks: ['flak', 'ghost', 'mask'] }], foes: [[5, 17], [8, 17, 'recon', { perks: ['flak', 'ghost', 'mask'] }], [5, 30]] });
  for (let x = 0; x < S; x++) setCover(s, x, 10, 2);
  a.points = 3;
  const r = act(s, a.id, { type: 'streak', key: 'uav' });
  const ev = r.events.find((e) => e.type === 'uav');
  assert.deepEqual({ type: ev.type, team: ev.team, x: ev.x, y: ev.y, r: ev.r }, { type: 'uav', team: a.team, x: 5, y: 5, r: 14 });
  assert.ok(teamSeesUnit(s, a.team, es[0]));
  assert.ok(!teamSeesUnit(s, a.team, es[1]), 'ghost');
  assert.ok(!teamSeesUnit(s, a.team, es[2]), 'out of radius');
  cycleTo(s, a.team);
  assert.ok(!teamSeesUnit(s, a.team, es[0]));
});

test('Counter-UAV hides your squad from enemy scans and UAVs for 2 rounds', () => {
  const { s, a, es } = arena({ me: [5, 5, 'assault', { streaks: ['cuav', 'care', 'sentry'] }], foes: [[5, 20, 'recon'], [30, 30]] });
  a.points = 4;
  const r = act(s, a.id, { type: 'streak', key: 'cuav' });
  assert.ok(r.events.some((e) => e.type === 'cuav' && e.team === a.team));
  cycleTo(s, es[0].team);
  const sc = act(s, es[0].id, { type: 'scan', x: 5, y: 8 });
  assert.ok(sc.ok, sc.error);
  assert.ok(!sc.events[0].revealed.includes(a.id));
  let guard = 0;
  const log = [];
  while (s.cuav.length && guard++ < 40) log.push(...endTeamTurn(s, activeTeams(s)[0]));
  assert.ok(log.some((e) => e.type === 'cuav_end'));
});

test('Care Package: tile within 6, lands next step as a strong crate (40% legendary)', () => {
  const { s, a } = streaky(['uav', 'care', 'sentry']);
  a.points = 4;
  assert.ok(streakTargets(s, a, 'care').has(key(5, 8)));
  assert.ok(!streakTargets(s, a, 'care').has(key(5, 20)));
  assert.ok(streakPreview(s, a, 'care', 5, 8).valid);
  const r = act(s, a.id, { type: 'streak', key: 'care', x: 5, y: 8 });
  assert.ok(r.ok, r.error);
  assert.ok(!s.crates.some((c) => c.type === 'care'));
  const log = cycleLog(s, a.team);
  const ev = log.find((e) => e.type === 'care_package');
  assert.ok(ev);
  assert.equal(ev.crate.type, 'care');
  assert.ok(ev.crate.weapon ? LEGENDARIES[ev.crate.weapon] : ATTACHMENTS[ev.crate.attachment]);
  let leg = 0;
  for (let seed = 0; seed < 60; seed++) {
    const st = createGame({ seed, noHuman: true });
    const u = st.units[st.teams[activeTeams(st)[0]].members[0]];
    u.streaks = ['care', 'uav', 'cuav']; u.points = 4;
    const k = [...streakTargets(st, u, 'care')][0];
    act(st, u.id, { type: 'streak', key: 'care', x: k % st.map.size, y: (k / st.map.size) | 0 });
    if (st.drops[0]?.crate.weapon) leg++;
  }
  assert.ok(leg >= 12 && leg <= 38, `legendary care packages ${leg}/60`);
});

test('Airstrike: telegraphed 7-tile line, hits next round for 5, ignores and destroys cover', () => {
  const { s, a, es } = arena({ me: [5, 5, 'assault', { streaks: ['uav', 'care', 'airstrike'] }], foes: [[8, 12], [30, 30]] });
  setCover(s, 7, 12, 2);
  setCover(s, 6, 12, 1);
  a.points = 5;
  const p = streakPreview(s, a, 'airstrike', 4, 12, 5, 12);
  assert.equal(p.tiles.length, 7);
  assert.ok(p.units.some((h) => h.id === es[0].id));
  const r = act(s, a.id, { type: 'streak', key: 'airstrike', x: 4, y: 12, x2: 5, y2: 12 });
  const mark = r.events.find((e) => e.type === 'airstrike_mark');
  assert.equal(mark.round, s.round + 1);
  assert.equal(mark.tiles.length, 7);
  es[0].hunkered = true;
  const log = [];
  let guard = 0;
  const r0 = s.round;
  while (s.round === r0 && guard++ < 40) log.push(...endTeamTurn(s, activeTeams(s)[0]));
  const i = log.findIndex((e) => e.type === 'airstrike');
  assert.ok(i >= 0);
  assert.ok(log.findIndex((e) => e.type === 'round_start') < i, 'lands at the start of the next round');
  assert.equal(log.find((e) => e.type === 'damage' && e.id === es[0].id && e.source === 'airstrike').dmg, 5);
  assert.equal(coverAt(s, 7, 12), 0);
  assert.equal(coverAt(s, 6, 12), 0);
});

test('Sentry: 8 HP turret on an adjacent tile, shoots enemies moving through its cone, lasts 3 rounds', () => {
  const { s, a, es } = arena({ me: [5, 5, 'assault', { streaks: ['uav', 'sentry', 'gunship'] }], foes: [[5, 14], [30, 30]] });
  a.points = 5;
  const r = act(s, a.id, { type: 'streak', key: 'sentry', x: 5, y: 6, x2: 5, y2: 14 });
  assert.ok(r.ok, r.error);
  const ev = r.events.find((e) => e.type === 'sentry');
  assert.deepEqual({ x: ev.x, y: ev.y, owner: ev.owner }, { x: 5, y: 6, owner: a.id });
  assert.equal(s.sentries[0].hp, 8);
  assert.ok(!moveOptions(s, a).has(key(5, 6)), 'blocks its tile');
  cycleTo(s, es[0].team);
  es[0].hp = 50; es[0].maxHp = 50;
  const m = act(s, es[0].id, { type: 'move', x: 5, y: 11 });
  assert.ok(m.events.some((e) => e.type === 'sentry_shot' && e.target === es[0].id));
  // Shooting it back
  sureShot(es[0]);
  const sh = act(s, es[0].id, { type: 'shoot', sentryId: s.sentries[0].id });
  assert.ok(sh.ok, sh.error);
  assert.ok(sh.events.some((e) => e.type === 'sentry_damage'));
  let guard = 0;
  const log = [];
  while (s.sentries.length && guard++ < 80) log.push(...endTeamTurn(s, activeTeams(s)[0]));
  assert.ok(log.some((e) => e.type === 'sentry_end' || e.type === 'sentry_destroyed'));
});

test('Gunship: fires on up to 2 visible enemies at the end of each of your turns, for 2 rounds', () => {
  const { s, a, es } = arena({ me: [5, 5, 'assault', { streaks: ['uav', 'sentry', 'gunship'] }], foes: [[5, 12], [8, 12], [30, 30]] });
  for (const e of es) { e.hp = 99; e.maxHp = 99; }
  a.points = 7;
  const r = act(s, a.id, { type: 'streak', key: 'gunship' });
  assert.ok(r.events.some((e) => e.type === 'gunship_start' && e.team === a.team));
  const end1 = endTeamTurn(s, a.team);
  const shots = end1.filter((e) => e.type === 'gunship_shot');
  assert.equal(shots.length, 2);
  assert.ok(shots.every((e) => e.chance <= 60 && [es[0].id, es[1].id].includes(e.target)));
  const log = cycleLog(s, a.team);
  void log;
  const end2 = endTeamTurn(s, a.team);
  assert.ok(end2.some((e) => e.type === 'gunship_shot'));
  assert.ok(end2.some((e) => e.type === 'gunship_end'));
  cycleTo(s, a.team);
  assert.ok(!endTeamTurn(s, a.team).some((e) => e.type === 'gunship_shot'));
});

// ---------- 8. progression data ----------

test('progression tables: attachment unlock order per weapon and camo challenges', () => {
  for (const id of Object.keys(WEAPONS)) {
    const u = weaponUnlocks(id);
    assert.equal(u.length, 15);
    assert.equal(new Set(u.map((x) => x.attachment)).size, 15, `${id} unlocks every attachment once`);
    assert.ok(u.every((x) => x.level >= 2 && x.level <= 20));
  }
  assert.ok(CAMO_CHALLENGES.length >= 6 && CAMO_CHALLENGES.every((c) => c.stat && c.count > 0));
});

// ---------- 5. AI ----------

test('bots use the 5.0 kit: reload, swap, equipment, suppress, deploy cover, streaks', () => {
  const count = {};
  for (const mode of Object.keys(MODES)) {
    for (let seed = 1; seed <= 5; seed++) {
      for (const e of simulate({ seed: seed * 31, mode, noHuman: true }).log) count[e.type] = (count[e.type] || 0) + 1;
    }
  }
  for (const k of ['reload', 'swap', 'grenade', 'semtex', 'knife', 'claymore', 'flashbang', 'stim', 'suppress',
    'deploy_cover', 'streak_used', 'uav', 'run_gun_ready', 'step_start', 'engagement', 'noise']) {
    assert.ok(count[k] > 0, `bots never produced ${k}`);
  }
});

test('bot-only matches end in every stage × mode, around 13–17 rounds on average', () => {
  const rounds = [];
  for (const stage of STAGE_KEYS) {
    for (const mode of Object.keys(MODES)) {
      const { state } = simulate({ seed: 77, stage, mode, noHuman: true });
      assert.notEqual(state.winner, null, `${stage}/${mode}`);
      assert.equal(aliveTeams(state).length, 1);
      assert.ok(state.round <= 26, `${stage}/${mode} dragged to ${state.round}`);
      rounds.push(state.round);
    }
  }
  const avg = rounds.reduce((x, y) => x + y, 0) / rounds.length;
  assert.ok(avg >= 13 && avg <= 18, `avg rounds ${avg}`);
});

test('a human seat is never auto-played: humans only act through act()', () => {
  const s = createGame({ seed: 12, mode: 'duos', loadout: { cls: 'gunner', primary: { id: 'gale' } } });
  const me = s.units.find((u) => u.isPlayer);
  assert.equal(me.cls, 'gunner');
  assert.equal(me.weapon.id, 'gale');
  assert.ok(isTeamActive(s, me.team));
  const info = abilityInfo(me, s).map((x) => x.key);
  assert.ok(info.includes('suppress') && info.includes('reload') && info.includes('swap'));
  void startFirstRound; void COVER_PENALTY; void sureMiss;
});
