// Engagement Turns (5.0 spec §1).
//
// A round is a series of steps. At round start, squads that can see each other
// (any standing unit of one sees any unit of the other, either direction) form
// engagement groups: connected components of the contact graph. Squads with no
// contact are free.
//   step 0: every free squad + the first squad of each group, all at once
//   step k: the k-th squad of each group
// Order inside a group rotates every round. The round ends after the largest
// group's last step. Every active squad has its own turn (turn_start / zone
// damage / bleed-out at its own end); actions resolve in arrival order.
//
// state.turn = { step, steps:[[team…]…], groups:[[team…]…], free:[team…], active:[team…], done:[team…] }
//
// Extension points (SIM-2): push (state, events) => void onto
//   TURN_HOOKS.roundStart  after round_start / airstrikes / zone shrink, before contact is computed
//   TURN_HOOKS.stepStart   before step_start's squads begin their turns
// and (state, team, events) => void onto
//   TURN_HOOKS.teamStart   after a squad's per-unit reset, before turn_start
//   TURN_HOOKS.teamEnd     after bleed-out and the gunship, before zone damage

import { ZONE, SUPPLY_DROP_ROUNDS, GOLD_DROP_CHANCE } from './constants.js';
import { roll, hash32 } from './rng.js';
import { dist, standing, canSeeTile, concealment } from './rules.js';
import {
  teamAlive, kill, dropUnit, clearSmokes, nextRoll,
} from './core.js';
import { hasPerk } from './loadout.js';
import { expireDecoys } from './equipment.js';
import { LEGENDARY_KEYS } from './weapons.js';
import {
  streaksRoundStart, streaksStepStart, streaksTeamStart, streaksTeamEnd,
} from './streaks.js';

export const TURN_HOOKS = { roundStart: [], stepStart: [], teamStart: [], teamEnd: [] };

// ---------- queries ----------

/** Squads whose turn is open right now (concurrent). */
export function activeTeams(state) {
  const t = state.turn;
  if (!t) return [];
  return t.active.filter((id) => !t.done.includes(id) && teamAlive(state, id));
}
export const isTeamActive = (state, team) => activeTeams(state).includes(team);
/** @deprecated Engagement turns can have several active squads: use activeTeams(). */
export const currentTeamId = (state) => activeTeams(state)[0] ?? state.turn?.active[0] ?? state.order[0];
/** Engagement groups this round (squads in contact), each in this round's acting order. */
export const engagements = (state) => (state.turn ? state.turn.groups.map((g) => [...g]) : []);
/** Squads with no contact this round. */
export const freeTeams = (state) => (state.turn ? [...state.turn.free] : []);

/** Can unit `a` see unit `b` with its own eyes (no scans / flares)? */
function eyesOn(state, a, b) {
  const { range } = concealment(state, b.x, b.y);
  if (range !== Infinity && dist(a.x, a.y, b.x, b.y) > range) return false;
  return canSeeTile(state.map, a.x, a.y, b.x, b.y);
}
function contact(state, ta, tb) {
  const A = state.teams[ta].members.map((id) => state.units[id]).filter((u) => u.alive);
  const B = state.teams[tb].members.map((id) => state.units[id]).filter((u) => u.alive);
  for (const a of A) for (const b of B) {
    if ((standing(a) && eyesOn(state, a, b)) || (standing(b) && eyesOn(state, b, a))) return true;
  }
  return false;
}

/** Contact graph → { groups:[[team…]], free:[team…] } (groups in rotated acting order). */
export function computeContacts(state) {
  const alive = state.order.filter((t) => teamAlive(state, t));
  const adj = new Map(alive.map((t) => [t, []]));
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      if (contact(state, alive[i], alive[j])) { adj.get(alive[i]).push(alive[j]); adj.get(alive[j]).push(alive[i]); }
    }
  }
  const seen = new Set();
  const groups = [], free = [];
  for (const t of alive) {
    if (seen.has(t)) continue;
    const comp = [];
    const q = [t];
    seen.add(t);
    while (q.length) {
      const c = q.shift();
      comp.push(c);
      for (const n of adj.get(c)) if (!seen.has(n)) { seen.add(n); q.push(n); }
    }
    if (comp.length === 1) { free.push(t); continue; }
    comp.sort((a, b) => a - b);
    const shift = (hash32(state.seed, comp[0], 0x6e6) + state.round) % comp.length; // rotates every round
    groups.push([...comp.slice(shift), ...comp.slice(0, shift)]);
  }
  return { groups, free };
}

// ---------- flow ----------

/** Legacy mirror for old UI code: turnPos points at currentTeamId in state.order. */
function syncLegacy(state) {
  const i = state.order.indexOf(currentTeamId(state));
  state.turnPos = i < 0 ? 0 : i;
}

function startTeamTurn(state, t) {
  const events = [];
  // This team's scans, UAVs and tracking run out as its turn begins.
  if (state.reveals.some((r) => r.team === t)) {
    state.reveals = state.reveals.filter((r) => r.team !== t);
    events.push({ type: 'reveal_end', team: t });
  }
  clearSmokes(state, events, (c) => c.expiresTeam === t && c.expiresRound <= state.round);
  // Night: muzzle flares fade as the shooter's squad starts its next turn.
  for (const f of state.flares.filter((f) => f.team === t)) events.push({ type: 'flare_end', id: f.id });
  state.flares = state.flares.filter((f) => f.team !== t);
  for (const id of state.teams[t].members) {
    const u = state.units[id];
    if (!u.alive) continue;
    u.overwatch = false;
    u.hunkered = false;
    u.ap = u.downed ? 0 : u.maxAp;
    u.moved = false;
    u.swapped = false;
    u.streakCalled = false;
    u.runGun = false;
    u.moveOnly = false;
    u.killMoved = false;
    u.freeReloaded = false;
    u.silentMove = hasPerk(u, 'deadsilence');
    if (u.flash && u.flash.apLoss && !u.downed) {
      u.ap = Math.max(0, u.ap - u.flash.apLoss);
      u.flash.apLoss = 0;
    }
    for (const k of Object.keys(u.cooldowns)) if (u.cooldowns[k] > 0) u.cooldowns[k]--;
  }
  streaksTeamStart(state, t, events);
  for (const h of TURN_HOOKS.teamStart) h(state, t, events);
  events.push({ type: 'turn_start', team: t, round: state.round, step: state.turn.step });
  return events;
}

/** Status effects that last "until its next turn ends". */
function expireEffects(u) {
  for (const k of ['flash', 'suppressed']) {
    if (!u[k]) continue;
    if (u[k].pending) u[k].pending = false;
    else u[k] = null;
  }
  if (u.slow) {
    if (u.slowPending) u.slowPending = false;
    else u.slow = 0;
  }
}

/** A squad's own end of turn: bleed-out, gunship, tide. Returns false if the match ended. */
function finishTeamTurn(state, t, events) {
  const members = state.teams[t].members.map((id) => state.units[id]);
  // Downed squadmates bleed out at the end of their own team's turn.
  for (const u of members) {
    if (!u.alive || !u.downed) continue;
    if (u.downedAt === state.turnSerial) continue; // went down this very turn: the clock starts next turn
    u.bleed--;
    if (u.bleed <= 0) {
      events.push({ type: 'bleed_out', id: u.id });
      kill(state, u, u.downedBy !== null ? state.units[u.downedBy] : null, events);
      if (state.winner !== null) return false;
    }
  }
  streaksTeamEnd(state, t, events);
  if (state.winner !== null) return false;
  for (const h of TURN_HOOKS.teamEnd) h(state, t, events);
  if (state.winner !== null) return false;
  // The tide hurts anyone caught outside at the end of their turn (and finishes the downed).
  for (const u of members) {
    if (!u.alive) continue;
    u.ap = 0;
    u.runGun = false;
    u.moveOnly = false;
    expireEffects(u);
    if (!insideZoneNow(state, u.x, u.y) && !u.tideImmune) {
      const dmg = Math.max(1, zoneDamageNow(state) - (hasPerk(u, 'amphibious') ? 1 : 0));
      u.hp -= dmg;
      const ev = { type: 'zone_damage', id: u.id, dmg, downed: false };
      events.push(ev);
      if (u.hp <= 0) ev.downed = dropUnit(state, u, null, events) === 'downed';
      if (state.winner !== null) return false;
    }
  }
  return true;
}

const insideZoneNow = (state, x, y) => dist(x, y, state.zone.x, state.zone.y) <= state.zone.r;
const zoneDamageNow = (state) => ZONE.damage + Math.floor(state.round / 5);

function beginStep(state, events) {
  const T = state.turn;
  T.active = (T.steps[T.step] || []).filter((t) => teamAlive(state, t));
  T.done = [];
  state.turnSerial++;
  streaksStepStart(state, events);
  for (const h of TURN_HOOKS.stepStart) h(state, events);
  if (state.winner !== null) return;
  T.active = T.active.filter((t) => teamAlive(state, t));
  events.push({ type: 'step_start', step: T.step, round: state.round, active: [...T.active] });
  for (const t of T.active) events.push(...startTeamTurn(state, t));
  syncLegacy(state);
}

/** Contact + step plan for the current round, then open step 0. */
function planRound(state, events) {
  const { groups, free } = computeContacts(state);
  const depth = Math.max(1, ...groups.map((g) => g.length));
  const steps = [];
  for (let k = 0; k < depth; k++) {
    const s = k === 0 ? [...free] : [];
    for (const g of groups) if (g.length > k) s.push(g[k]);
    // Stable order inside a step: follow this round's turn order.
    s.sort((a, b) => state.order.indexOf(a) - state.order.indexOf(b));
    steps.push(s);
  }
  state.turn = { step: 0, steps, groups, free, active: [], done: [] };
  events.push({ type: 'engagement', round: state.round, groups: groups.map((g) => [...g]), free: [...free] });
  beginStep(state, events);
  // A step can be empty only if all its squads fell before it began.
  while (state.winner === null && state.turn.active.length === 0) advance(state, events);
}

/** Round 1 (called once by createGame). */
export function startFirstRound(state) {
  const events = [{ type: 'round_start', round: state.round }];
  planRound(state, events);
  return events;
}

function newRound(state, events) {
  state.round++;
  state.order = state.order.filter((id) => teamAlive(state, id));
  state.order.push(state.order.shift()); // rotate who goes first each round
  events.push({ type: 'round_start', round: state.round });
  // Smoke from a squad that has since been wiped never gets its expiry turn.
  clearSmokes(state, events, (c) => c.expiresRound < state.round);
  expireDecoys(state, events);
  streaksRoundStart(state, events); // airstrikes land, counter-UAV / sentries expire
  if (state.winner !== null) return;
  if ((state.round - 1) % ZONE.shrinkEvery === 0) {
    // Step through the planned schedule: down to the final ring, hold it once, then flood.
    const z = state.zone;
    const plan = state.zonePlan;
    z.stage = Math.min(plan.length - 1, z.stage + 1);
    const cur = plan[z.stage], nxt = plan[Math.min(plan.length - 1, z.stage + 1)];
    z.r = cur.r; z.x = cur.x; z.y = cur.y;
    z.next = nxt.r; z.nx = nxt.x; z.ny = nxt.y;
    events.push({ type: 'zone_shrink', r: z.r, next: z.next, x: z.x, y: z.y, nx: z.nx, ny: z.ny });
  }
  if (SUPPLY_DROP_ROUNDS.includes(state.round)) supplyDrop(state, events);
  for (const h of TURN_HOOKS.roundStart) h(state, events);
  if (state.winner !== null) return;
  planRound(state, events);
}

function advance(state, events) {
  const T = state.turn;
  T.step++;
  if (T.step >= T.steps.length) { newRound(state, events); return; }
  beginStep(state, events);
}

/**
 * End one squad's turn (default: the first active squad, for back-compat).
 * When every active squad is done, the step (or round) advances.
 * Returns the events, or [] if that squad isn't active.
 */
export function endTeamTurn(state, team) {
  if (state.winner !== null) return [];
  const events = [];
  if (team === undefined) team = activeTeams(state)[0];
  if (team === undefined) { settle(state, events); return events; }
  if (!isTeamActive(state, team)) return [];
  if (!finishTeamTurn(state, team, events)) return events;
  state.turn.done.push(team);
  settle(state, events);
  return events;
}

/** If nobody is left to act in this step (all done or wiped), move on. */
export function settle(state, events) {
  let guard = 0;
  while (state.winner === null && activeTeams(state).length === 0 && guard++ < 64) advance(state, events);
  syncLegacy(state);
}

/** A cache lands on a random free open tile inside the next safe zone; sometimes it's gold. */
export function supplyDrop(state, events) {
  const { map, zone } = state;
  const S = map.size;
  const busy = new Set();
  for (const o of state.units) if (o.alive) busy.add(o.y * S + o.x);
  for (const c of state.crates) if (!c.taken) busy.add(c.y * S + c.x);
  let spots = [];
  const rings = [[zone.next, zone.nx ?? zone.x, zone.ny ?? zone.y], [zone.r, zone.x, zone.y], [Infinity, zone.x, zone.y]];
  for (const [r, cx, cy] of rings) {
    spots = [];
    for (let k = 0; k < S * S; k++) {
      if (map.cover[k] || busy.has(k)) continue;
      if (dist(k % S, (k / S) | 0, cx, cy) <= r) spots.push(k);
    }
    if (spots.length) break;
  }
  if (!spots.length) return;
  const k = spots[Math.floor(nextRoll(state) * spots.length)];
  const crate = { id: state.crates.length, x: k % S, y: (k / S) | 0, type: 'cache', taken: false, dropped: true };
  // Gold crates: decided from the seed alone so the stream of other rolls is unchanged.
  if (roll(state.seed, 0x601d, state.round) < GOLD_DROP_CHANCE) {
    crate.type = 'gold';
    crate.weapon = LEGENDARY_KEYS[Math.floor(roll(state.seed, 0x1e6, state.round) * LEGENDARY_KEYS.length)];
  }
  state.crates.push(crate);
  events.push({ type: 'supply_drop', crate: { ...crate } });
}
