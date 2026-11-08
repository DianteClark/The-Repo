// The Pit (5.0 spec §5, SIM-2): a second chance.
//
// A unit's first real death (not being downed) up to round PIT.lastRound sends it to the Pit queue
// (team modes: only while a squadmate is still standing). Two queued units fight a 1v1 duel on a
// 9×9 arena with a pistol and 1 frag, same rules. Anyone still queued when a round ends fights the
// Pit Warden bot. The winner redeploys at the next round start: a random safe tile, 6 HP, primary
// at half a magazine (team modes: only if the squad still has a standing member). The loser is out.
//
// A squad of one (solos, the trios lone wolf) whose only member is in the Pit is *held*: it is not
// eliminated (no team_out) until it loses its duel, and the match isn't won while a squad is held.
//
// state.pit = { enabled, queue:[unitId], duels:[duel], held:[team], redeploys:[unitId], nextDuelId }
// duel = { id, a, b, warden, human, units:{[mainUnitId]: duelUnitId}, state, done, winner, loser }
//   a, b: main-match unit ids (b is null against the Pit Warden). duel.state is a separate mini game
//   state: run it with the same act(duel.state, duelUnitId, action) / endTeamTurn(duel.state, team).
//   Duel unit ids are 0 (a, team 0) and 1 (b or the Warden, team 1); each duel unit has srcId = main id.
//
// API: pitDuels(state) → live duels, resolvePitBots(state, {humans}) → main events,
//      settlePit(state) → main events (collects finished duels), duelUnitFor(duel, mainUnitId).
// Events (main stream): pit_enter {id}, pit_duel {duelId, a, b, warden}, pit_result {duelId, winner,
//   loser, warden, rounds}, redeploy {id, x, y, hp}, pit_out {id, reason}.

import { CLASSES, BASE_AP } from './constants.js';
import { hash32 } from './rng.js';
import { dist, standing } from './rules.js';
import { buildWeapon, EQUIPMENT } from './weapons.js';
import { armWeapon, refreshMove } from './loadout.js';
import { HOOKS, teamAlive, teamOutCheck, winnerCheck } from './core.js';
import { TURN_HOOKS, startFirstRound, endTeamTurn, activeTeams } from './turns.js';
import { botTakeTurn } from './ai.js';
import { dangerTiles } from './stageevents.js';

export const PIT = {
  lastRound: 8, size: 9, redeployHp: 6, wardenHp: 10, wardenCls: 'assault', maxTurns: 120, safeGap: 7,
};

export function initPit(state, opts = {}) {
  state.pit = { enabled: !state.isPit && opts.pit !== false, queue: [], duels: [], held: [], redeploys: [], nextDuelId: 0 };
}

/** Live (unfinished) duels. */
export const pitDuels = (state) => (state.pit ? state.pit.duels.filter((d) => !d.done) : []);
/** The duel unit that stands in for a main-match unit. */
export const duelUnitFor = (duel, mainId) => duel.state.units[duel.units[mainId]] || null;

// ---------- the arena ----------

function arenaMap() {
  const N = PIT.size;
  const cover = new Uint8Array(N * N);
  // Point-symmetric: neither side is favoured.
  for (const [x, y, c] of [[4, 2, 2], [4, 6, 2], [2, 2, 1], [6, 6, 1], [2, 6, 1], [6, 2, 1], [3, 4, 1], [5, 4, 1]]) cover[y * N + x] = c;
  return {
    size: N, cover, terrain: new Uint8Array(N * N), explosive: new Uint8Array(N * N),
    wallHeight: new Float32Array(N * N).fill(1), sight: 10, stage: 'pit',
    building: new Int16Array(N * N).fill(-1), buildings: [],
  };
}

function duelist(src, id, team, x, y) {
  const cls = CLASSES[src.cls] ? src.cls : 'assault';
  const c = CLASSES[cls];
  const hp = src.warden ? src.hp : (src.maxHp || c.hp); // a fresh body: full health
  const u = {
    id, team, srcId: src.id ?? null, cls, name: src.name, isPlayer: !!src.isPlayer, isHuman: !!src.isHuman,
    isLoneWolf: false, warden: !!src.warden, x, y, hp, maxHp: hp, armor: c.armor,
    maxAp: BASE_AP, ap: 0, move: c.move, baseMove: c.move, alive: true, overwatch: false, missStreak: 0, kills: 0,
    mods: { scope: 0, barrel: 0, armor: 0 },
    cooldowns: { aimed: 0, breach: 0, patch: 0, scan: 0, deploy_cover: 0, suppress: 0, run_gun: 0 },
    hunkered: false, downed: false, bleed: 0, downedBy: null, downedAt: -1, streakUsed: {}, streaks: [],
    perks: [...(src.perks || [])], moved: false, swapped: false, loadout: src.loadout,
  };
  const pistol = armWeapon(buildWeapon('pistol'));
  u.weapons = [pistol, null];
  u.slot = 0; u.weapon = pistol; u.ammo = pistol.ammo;
  u.items = { medkit: 0 };
  for (const k of Object.keys(EQUIPMENT)) u.items[k] = 0;
  u.items.frag = 1;
  u.lethal = 'frag'; u.tactical = null;
  refreshMove(u);
  return u;
}

/** A separate mini game: two duelists, a 9×9 arena, a tide that floods it after a few rounds. */
export function createDuelState(main, a, b, duelId) {
  const N = PIT.size, c = (N - 1) / 2;
  const ua = duelist(a, 0, 0, 1, 4);
  const ub = duelist(b || { name: 'Pit Warden', cls: PIT.wardenCls, warden: true, hp: PIT.wardenHp }, 1, 1, 7, 4);
  const big = 99;
  // Round 1–4 dry; then the arena floods to a 3-tile ring, then entirely: duels always end.
  const zonePlan = [{ r: big, x: c, y: c }, { r: big, x: c, y: c }, { r: 3, x: c, y: c }, { r: 0, x: c, y: c }];
  const ds = {
    seed: hash32(main.seed, 0x917, duelId) >>> 0, mode: 'solos', stage: main.stage, map: arenaMap(),
    units: [ua, ub], teams: [{ id: 0, members: [0], isLoneWolf: false, human: ua.isHuman }, { id: 1, members: [1], isLoneWolf: false, human: ub.isHuman }],
    crates: [], zone: { x: c, y: c, r: big, next: big, nx: c, ny: c, stage: 0 }, zonePlan, order: [0, 1],
    playerTeam: ua.isPlayer ? 0 : ub.isPlayer ? 1 : -1, humanTeams: [ua, ub].filter((u) => u.isHuman).map((u) => u.team),
    loneWolfTeam: -1, night: false, round: 1, turnPos: 0, rollCounter: 0, eliminated: [], winner: null,
    smokes: [], reveals: [], nextSmokeId: 0, turnSerial: 0, flares: [], turn: null,
    noises: [], claymores: [], decoys: [], nextEquipId: 0, cuav: [], drops: [], airstrikes: [], sentries: [], gunships: [], nextStreakId: 0,
    blockers: [], vehicles: [], hazards: [], stageEvent: null,
    isPit: true, duelId,
  };
  ds.pit = { enabled: false, queue: [], duels: [], held: [], redeploys: [], nextDuelId: 0 };
  ds.startEvents = startFirstRound(ds);
  return ds;
}

function makeDuel(state, aId, bId, events) {
  const id = state.pit.nextDuelId++;
  const a = state.units[aId], b = bId === null ? null : state.units[bId];
  const ds = createDuelState(state, a, b, id);
  const duel = {
    id, a: aId, b: bId, warden: bId === null, human: !!(a.isHuman || (b && b.isHuman)),
    units: { [aId]: 0 }, state: ds, done: false, winner: null, loser: null, round: state.round,
  };
  if (bId !== null) duel.units[bId] = 1;
  state.pit.duels.push(duel);
  state.pit.queue = state.pit.queue.filter((x) => x !== aId && x !== bId);
  events.push({ type: 'pit_duel', duelId: id, a: aId, b: bId, warden: duel.warden });
  return duel;
}

// ---------- entering ----------

function pitEnter(state, u, events) {
  const P = state.pit;
  if (!P || !P.enabled || state.isPit || state.winner !== null) return;
  if (u.pitUsed || state.round > PIT.lastRound) return;
  const team = state.teams[u.team];
  const solo = team.members.length === 1;
  if (!solo && !teamAlive(state, u.team)) return; // squad wiped: nobody to come back to
  u.pitUsed = true;
  u.inPit = true;
  if (solo && !P.held.includes(u.team)) P.held.push(u.team);
  P.queue.push(u.id);
  events.push({ type: 'pit_enter', id: u.id });
  if (P.queue.length >= 2) makeDuel(state, P.queue[0], P.queue[1], events);
}

HOOKS.onDeath.push((state, u, killer, events) => pitEnter(state, u, events));

// ---------- results ----------

const duelOver = (d) => d.state.winner !== null;

function finishDuel(state, d, events) {
  const ds = d.state;
  d.done = true;
  const wu = ds.units.find((x) => x.team === ds.winner);
  const lu = ds.units.find((x) => x.team !== ds.winner);
  d.winner = wu.warden ? null : wu.srcId;
  d.loser = lu.warden ? null : lu.srcId;
  events.push({ type: 'pit_result', duelId: d.id, winner: d.winner, loser: d.loser, warden: d.warden, rounds: ds.round });
  if (d.winner !== null) state.pit.redeploys.push(d.winner);
  if (d.loser !== null) knockOut(state, state.units[d.loser], 'lost', events, false);
}

/** A Pit unit is done for good: release its held squad (which is then out). */
function knockOut(state, u, reason, events, emit = true) {
  u.inPit = false;
  if (emit) events.push({ type: 'pit_out', id: u.id, reason });
  const P = state.pit;
  if (P.held.includes(u.team)) {
    P.held = P.held.filter((t) => t !== u.team);
    if (state.winner === null) {
      teamOutCheck(state, u.team, null, events);
      winnerCheck(state, events);
    }
  }
}

/** Collect finished duels into the main match. Returns main-stream events. */
export function settlePit(state) {
  const events = [];
  if (!state.pit) return events;
  for (const d of state.pit.duels) if (!d.done && duelOver(d)) finishDuel(state, d, events);
  return events;
}

/** Bot-play a duel state to the end (both sides with the match AI). */
export function playDuel(ds) {
  let guard = 0;
  while (ds.winner === null && guard++ < PIT.maxTurns) {
    const t = activeTeams(ds)[0];
    if (t === undefined) break;
    for (const id of ds.teams[t].members) botTakeTurn(ds, id);
    endTeamTurn(ds, t);
  }
  if (ds.winner === null) {
    // Safety net (the flooding arena should always settle it first): most HP wins.
    const [a, b] = ds.units;
    ds.winner = (a.alive ? a.hp : -99) >= (b.alive ? b.hp : -99) ? 0 : 1;
  }
}

/**
 * Auto-play every duel without a human in it (pass {humans:true} to auto-play humans too,
 * e.g. a controller with no Pit screen, or a timed-out human). Returns main-stream events.
 */
export function resolvePitBots(state, { humans = false } = {}) {
  if (!state.pit || state.isPit) return [];
  for (const d of state.pit.duels) {
    if (d.done || duelOver(d) || (d.human && !humans)) continue;
    playDuel(d.state);
  }
  return settlePit(state);
}

// ---------- redeploy ----------

function redeployTile(state, u) {
  const { map } = state;
  const S = map.size;
  const busy = new Set();
  for (const o of state.units) if (o.alive) busy.add(o.y * S + o.x);
  for (const v of state.vehicles || []) busy.add(v.y * S + v.x);
  for (const t of state.sentries || []) busy.add(t.y * S + t.x);
  for (const k of state.blockers || []) busy.add(k);
  const danger = dangerTiles(state);
  const z = state.zone;
  const foes = state.units.filter((o) => standing(o) && o.team !== u.team);
  const mates = state.units.filter((o) => standing(o) && o.team === u.team && o.id !== u.id);
  const tiers = [[], [], []];
  for (let k = 0; k < S * S; k++) {
    if (map.cover[k] || busy.has(k) || danger.has(k)) continue;
    const x = k % S, y = (k / S) | 0;
    if (dist(x, y, z.nx ?? z.x, z.ny ?? z.y) > Math.max(1, z.next)) {
      if (dist(x, y, z.x, z.y) <= z.r) tiers[2].push(k);
      continue;
    }
    const gap = foes.length ? Math.min(...foes.map((o) => dist(o.x, o.y, x, y))) : 99;
    if (gap < PIT.safeGap) { tiers[2].push(k); continue; }
    // Team modes: land near the squad.
    if (mates.length && !mates.some((m) => dist(m.x, m.y, x, y) <= 6)) { tiers[1].push(k); continue; }
    tiers[0].push(k);
  }
  const pool = tiers.find((t) => t.length);
  if (!pool) return null;
  const k = pool[hash32(state.seed, 0x2ede, u.id, state.round) % pool.length];
  return [k % S, (k / S) | 0];
}

function redeploy(state, id, events) {
  const u = state.units[id];
  const team = state.teams[u.team];
  const solo = team.members.length === 1;
  if (!solo && !teamAlive(state, u.team)) { knockOut(state, u, 'squad_out', events); return; }
  const at = redeployTile(state, u);
  if (!at) { knockOut(state, u, 'no_room', events); return; }
  Object.assign(u, {
    alive: true, downed: false, bleed: 0, downedBy: null, downedAt: -1, hp: Math.min(PIT.redeployHp, u.maxHp),
    ap: 0, overwatch: false, hunkered: false, flash: null, suppressed: null, slow: 0, vehicle: null, tideImmune: false,
    inPit: false, runGun: false, moveOnly: false, x: at[0], y: at[1], hitBy: null,
  });
  if (u.weapons) {
    const p = u.weapons[0];
    p.ammo = Math.ceil(p.mag / 2);
    u.slot = 0; u.weapon = p; u.ammo = p.ammo;
  }
  for (const k of Object.keys(u.items || {})) u.items[k] = 0; // the kit went down with the body
  state.pit.held = state.pit.held.filter((t) => t !== u.team);
  if (!state.order.includes(u.team)) state.order.push(u.team);
  events.push({ type: 'redeploy', id: u.id, x: u.x, y: u.y, hp: u.hp });
}

// ---------- turn hooks ----------

TURN_HOOKS.stepStart.push((state, events) => {
  if (!state.pit || state.isPit || state.winner !== null) return;
  events.push(...resolvePitBots(state));
});

TURN_HOOKS.roundStart.push((state, events) => {
  const P = state.pit;
  if (!P || state.isPit || state.winner !== null) return;
  // Nobody to pair with by the end of the round: the Pit Warden.
  for (const id of [...P.queue]) makeDuel(state, id, null, events);
  events.push(...resolvePitBots(state));
  for (const id of P.redeploys.splice(0)) {
    if (state.winner !== null) break;
    redeploy(state, id, events);
  }
});
