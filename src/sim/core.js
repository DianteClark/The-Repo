// Combat primitives shared by game.js, turns.js, equipment.js and streaks.js:
// damage, downing / death, explosions, shots, crates. Pure state mutation +
// event emission. Nothing here decides whose turn it is.
//
// Extension points (SIM-2 and later):
//   HOOKS.onDeath(state, unit, killer, events)    after a unit dies
//   HOOKS.onDamage(state, unit, dmg, source, events)  after any damage lands
//   HOOKS.onCoverChange(state, x, y, from, to, events)  after a cover tile changes
// Push functions onto these arrays; they run in registration order.

import {
  GRAZE_BAND, MISS_STREAK_CAP, FLANK_DMG, AIMED, FRAG, BREACH, BARREL, BLEED_TURNS, MOD_CAP, FRAG_CAP, SMOKE_CAP,
  LETHAL_CAP, TACTICAL_CAP, STAGES,
} from './constants.js';
import { roll } from './rng.js';
import { hitChance, dist, inBounds, standing, teamSeesUnit } from './rules.js';
import {
  EQUIPMENT, STREAKS, ATTACHMENTS, LEGENDARIES, hasSpecial, buildWeapon,
} from './weapons.js';
import { armWeapon, refreshMove, hasPerk } from './loadout.js';

export const HOOKS = { onDeath: [], onDamage: [], onCoverChange: [], onBlast: [] };
//   HOOKS.onBlast(state, tiles:[[x,y]], dmg, attacker, events)  explosions / airstrikes (vehicles take hull damage)

export const nextRoll = (state) => roll(state.seed, state.rollCounter++);
export const teamAlive = (state, t) => state.teams[t].members.some((id) => standing(state.units[id]));
export const aliveTeams = (state) => state.teams.filter((t) => teamAlive(state, t.id)).map((t) => t.id);
export const chebyshev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Is this team taking its turn right now (engagement turns)? */
export const teamIsActive = (state, team) => !!state.turn && state.turn.active.includes(team)
  && !state.turn.done.includes(team) && teamAlive(state, team);

/** Streak cost for a unit (Hardline: -1), in streak points. */
export const streakCost = (u, key) => Math.max(1, STREAKS[key].cost - (hasPerk(u, 'hardline') ? 1 : 0));

// ---------- streak points (5.0 §5: replaces kill-count streaks) ----------
// kill +2, down +1, assist +1 (you damaged a unit that an ally of yours downed or killed
// later in the same round), revive +1. A streak is earned when points reach its cost.
export const STREAK_POINTS = { kill: 2, down: 1, assist: 1, revive: 1 };
export const streakPoints = (u) => u.points || 0;
// Damage counts towards an assist for this many rounds back (0: the same round only).
export const ASSIST_ROUNDS = 0;

/** Award streak points; emits streak_points and streak_ready for each streak crossed. */
export function addPoints(state, u, reason, events) {
  if (!u || state.isPit) return;
  const add = STREAK_POINTS[reason] || 0;
  if (!add) return;
  const before = streakPoints(u);
  u.points = before + add;
  events.push({ type: 'streak_points', id: u.id, add, total: u.points, reason });
  for (const k of u.streaks || []) {
    const c = streakCost(u, k);
    if (!u.streakUsed?.[k] && before < c && u.points >= c) events.push({ type: 'streak_ready', id: u.id, key: k });
  }
}

/** Remember who hurt a unit this round (for assists). */
export function noteDamage(state, victim, by) {
  if (!by || by.id === undefined || by.id < 0 || by.team === victim.team) return;
  (victim.hitBy ||= {})[by.id] = state.round;
}

/**
 * A unit was downed or killed by `by`: allies of `by` who hurt it this round get an assist
 * (once per victim life: the downer gets one more if a squadmate finishes the job).
 */
function creditAssists(state, victim, by, events) {
  const hb = victim.hitBy;
  if (!hb || !by) return;
  victim.assisted ||= [];
  for (const id of Object.keys(hb)) {
    const a = state.units[id];
    if (state.round - hb[id] > ASSIST_ROUNDS || !a || a.id === by.id || a.team !== by.team) continue;
    if (victim.assisted.includes(a.id)) continue;
    victim.assisted.push(a.id);
    addPoints(state, a, 'assist', events);
  }
}

// ---------- ammo ----------
export const isInfinite = (w) => hasSpecial(w, 'infinite');
export const hasAmmo = (u, n = 1) => isInfinite(u.weapon) || (u.ammo ?? 0) >= n;
export function spendAmmo(u, n = 1) {
  if (isInfinite(u.weapon)) return;
  u.ammo = Math.max(0, (u.ammo ?? 0) - n);
  u.weapon.ammo = u.ammo;
}
/** Refill every carried weapon (ammo crates, Scavenger refills only the active mag). */
export function refillAll(u) {
  for (const w of (u.weapons || [u.weapon]).filter(Boolean)) {
    if (hasSpecial(w, 'explosive')) w.ammo = Math.min(w.mag, (w.ammo ?? 0) + 1);
    else { w.ammo = w.mag; w.spare = w.reserve ?? w.mag * 2; }
  }
  u.ammo = u.weapon.ammo ?? u.weapon.mag;
}

// ---------- geometry ----------
export const blastTiles = (map, x, y, r) => {
  const out = [];
  const R = Math.ceil(r);
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (Math.hypot(dx, dy) <= r && inBounds(map, x + dx, y + dy)) out.push([x + dx, y + dy]);
    }
  }
  return out;
};

/** The tile that gives (tx,ty) its cover against an attacker at (ax,ay), or null. Mirrors coverVs. */
export function coverSourceTile(map, tx, ty, ax, ay) {
  const ddx = ax - tx, ddy = ay - ty;
  let best = null, bc = 0;
  const S = map.size;
  if (ddx !== 0 && Math.abs(ddx) * 2 >= Math.abs(ddy)) {
    const x = tx + Math.sign(ddx);
    if (inBounds(map, x, ty) && map.cover[ty * S + x] > bc) { bc = map.cover[ty * S + x]; best = [x, ty]; }
  }
  if (ddy !== 0 && Math.abs(ddy) * 2 >= Math.abs(ddx)) {
    const y = ty + Math.sign(ddy);
    if (inBounds(map, tx, y) && map.cover[y * S + tx] > bc) { bc = map.cover[y * S + tx]; best = [tx, y]; }
  }
  return best;
}

export function setCover(state, x, y, to, events) {
  const S = state.map.size;
  const from = state.map.cover[y * S + x];
  if (from === to) return;
  state.map.cover[y * S + x] = to;
  if (to === 0 && state.map.explosive) state.map.explosive[y * S + x] = 0;
  events.push({ type: 'cover_change', x, y, from, to });
  for (const h of HOOKS.onCoverChange) h(state, x, y, from, to, events);
}

// ---------- reveals / noise ----------
/** Units that scans and UAVs can't pick up: Ghost perk, or a squad under Counter-UAV. */
export const hiddenFromIntel = (state, o) => hasPerk(o, 'ghost')
  || (state.cuav || []).some((c) => c.team === o.team && c.untilRound > state.round);

/** Tracker perk / tracer rounds: reveal a unit to a team until that team's next turn. */
export function track(state, team, target, events) {
  let r = state.reveals.find((x) => x.team === team && x.kind === 'tracker');
  if (!r) { r = { team, kind: 'tracker', x: target.x, y: target.y, radius: 0, ids: [] }; state.reveals.push(r); }
  if (!r.ids.includes(target.id)) {
    r.ids.push(target.id);
    events.push({ type: 'tracked', id: target.id, team });
  }
}

/** Unseen-gunfire ping. Suppressors, Dead Silence and knives make none. */
export function noise(state, u, events, kind = 'gunfire') {
  if (u.weapon?.silent || hasPerk(u, 'deadsilence')) return;
  state.noises.push({ x: u.x, y: u.y, team: u.team, round: state.round, kind });
  if (state.noises.length > 24) state.noises.shift();
  events.push({ type: 'noise', id: u.id, x: u.x, y: u.y, kind });
}

/** Night stages: firing lights the shooter up for every squad until its team's next turn. */
export function flare(state, u, events, force = false) {
  if (!u.alive) return;
  if (!force && (!(state.night ?? STAGES[state.stage]?.night) || u.weapon?.silent)) return;
  if (state.flares.some((f) => f.id === u.id)) return;
  state.flares.push({ id: u.id, team: u.team });
  events.push({ type: 'flare', id: u.id });
}

// ---------- downing and death ----------
/**
 * A unit has hit 0 HP. Downed if a squadmate is still standing (team modes),
 * otherwise dead; a downed unit hit again dies. Returns 'downed' | 'dead'.
 */
export function dropUnit(state, u, by, events) {
  if (!u.alive) return 'dead';
  const mateUp = !u.downed && state.teams[u.team].members.some((id) => id !== u.id && standing(state.units[id]));
  if (mateUp) {
    u.hp = 0;
    u.downed = true;
    u.bleed = BLEED_TURNS;
    u.downedBy = by ? by.id : null;
    u.downedAt = state.turnSerial;
    u.ap = 0;
    u.overwatch = false;
    u.hunkered = false;
    events.push({ type: 'downed', id: u.id, by: by ? by.id : null });
    if (by && by.team !== u.team && state.units[by.id] === by) { addPoints(state, by, 'down', events); creditAssists(state, u, by, events); }
    return 'downed';
  }
  kill(state, u, by, events);
  return 'dead';
}

/** Kill credit: streak unlocks and on-kill perks / legendary traits. */
function onKillCredit(state, killer, victim, events) {
  killer.kills++;
  addPoints(state, killer, 'kill', events);
  creditAssists(state, victim, killer, events);
  if (!standing(killer)) return;
  if (hasPerk(killer, 'scavenger')) {
    if (!isInfinite(killer.weapon)) { killer.ammo = killer.weapon.mag; killer.weapon.ammo = killer.ammo; }
    if (killer.lethal && killer.items[killer.lethal] < LETHAL_CAP) killer.items[killer.lethal]++;
    events.push({ type: 'scavenge', id: killer.id, ammo: killer.ammo, lethal: killer.lethal });
  }
  if (hasPerk(killer, 'quickfix') && killer.hp < killer.maxHp) {
    const amount = Math.min(3, killer.maxHp - killer.hp);
    killer.hp += amount;
    events.push({ type: 'heal', id: killer.id, amount, source: 'quickfix' });
  }
  if (hasSpecial(killer.weapon, 'killMove') && !killer.killMoved && teamIsActive(state, killer.team)) {
    killer.killMoved = true;
    killer.ap = Math.max(killer.ap, 1);
    killer.moveOnly = true;
    events.push({ type: 'kill_move', id: killer.id });
  }
}

export function markDead(state, u, killer, events) {
  u.hp = 0;
  u.alive = false;
  u.downed = false;
  u.bleed = 0;
  u.ap = 0;
  u.overwatch = false;
  u.hunkered = false;
  const credit = killer && killer.team !== u.team;
  const ev = { type: 'death', id: u.id, by: killer ? killer.id : null };
  if (credit && killer.weapon) ev.weapon = killer.weapon.id;
  events.push(ev);
  if (credit && state.units[killer.id] === killer) onKillCredit(state, killer, u, events);
  u.hitBy = null;
  u.assisted = null;
  if (state.flares.some((f) => f.id === u.id)) {
    state.flares = state.flares.filter((f) => f.id !== u.id);
    events.push({ type: 'flare_end', id: u.id });
  }
  // Leftovers drop as a crate: a medkit, else a lethal / tactical, else ammo.
  const items = u.items || {};
  const lethalLeft = u.lethal && items[u.lethal] > 0;
  const tacLeft = u.tactical && items[u.tactical] > 0;
  const drop = items.medkit > 0 ? 'medkit' : items.frag > 0 ? 'frag' : items.smoke > 0 ? 'smoke'
    : lethalLeft ? 'lethal' : tacLeft ? 'tactical' : 'ammo';
  if (!state.crates.some((c) => !c.taken && c.x === u.x && c.y === u.y)) {
    const crate = { id: state.crates.length, x: u.x, y: u.y, type: drop, taken: false, dropped: true };
    state.crates.push(crate);
    events.push({ type: 'crate_drop', crate: { ...crate } });
  }
  for (const h of HOOKS.onDeath) h(state, u, killer, events);
}

/** Teams kept in the match while their only member fights in the Pit (pit.js keeps the list). */
export const heldTeams = (state) => (state.pit && state.pit.held) || [];

export function kill(state, u, killer, events) {
  if (!u.alive) return;
  markDead(state, u, killer, events);
  teamOutCheck(state, u.team, killer, events);
  winnerCheck(state, events);
}

/** A squad with nobody standing (and nobody held for the Pit) is out. */
export function teamOutCheck(state, team, killer, events) {
  if (!teamAlive(state, team) && !state.eliminated.includes(team) && !heldTeams(state).includes(team)) {
    // Squad wipe: nobody left to revive the downed.
    for (const id of state.teams[team].members) {
      const m = state.units[id];
      if (m.alive) markDead(state, m, m.downedBy !== null ? state.units[m.downedBy] : killer, events);
    }
    state.eliminated.push(team);
    if (state.reveals.some((r) => r.team === team)) {
      state.reveals = state.reveals.filter((r) => r.team !== team);
      events.push({ type: 'reveal_end', team: team });
    }
    events.push({ type: 'team_out', team: team, place: state.teams.length - state.eliminated.length + 1 });
  }
}

/** One squad left standing (and nobody waiting in the Pit to come back) wins. */
export function winnerCheck(state, events) {
  if (state.winner !== null) return;
  const alive = aliveTeams(state);
  const held = heldTeams(state);
  if (alive.length === 0 && held.length) {
    // Nobody standing at all: the Pit can't save anyone now.
    for (const t of [...held]) {
      state.pit.held = state.pit.held.filter((x) => x !== t);
      teamOutCheck(state, t, null, events);
    }
  }
  if (alive.length === 0 || (alive.length === 1 && !heldTeams(state).length)) {
    // If the last squads fall together, the last one eliminated takes the win.
    state.winner = alive.length ? alive[0] : state.eliminated[state.eliminated.length - 1];
    events.push({ type: 'game_over', winner: state.winner });
  }
}

/** Apply `dmg` to a unit and down / kill it at 0. Returns the damage event. */
export function hurt(state, o, dmg, source, by, events, extra = {}) {
  o.hp -= dmg;
  noteDamage(state, o, by);
  const ev = { type: 'damage', id: o.id, dmg, source, by: by ? by.id : null, downed: false, ...extra };
  events.push(ev);
  for (const h of HOOKS.onDamage) h(state, o, dmg, source, events);
  if (o.hp <= 0 || o.downed) ev.downed = dropUnit(state, o, by, events) === 'downed';
  return ev;
}

const EXPLOSIVE_SOURCES = new Set(['explosion', 'breach', 'barrel', 'semtex', 'rocket', 'claymore', 'airstrike', 'boat']);
/** Damage after armour and Flak Jacket. */
export function blastDmgFor(o, base, source) {
  let d = Math.max(1, base - o.armor);
  if (EXPLOSIVE_SOURCES.has(source) && hasPerk(o, 'flak')) d = Math.max(1, Math.ceil(d / 2));
  return d;
}

/**
 * Explosive damage (ignores cover). Emits damage (+downed/death) events. Stops once the match is decided.
 * `bonus` maps unit id → extra damage (semtex stick).
 */
export function blastDamage(state, attacker, victims, base, source, events, bonus = null) {
  // Enemies first, so a blast that also catches the thrower's squad settles the match in the thrower's favour.
  const team = attacker ? attacker.team : -1;
  const order = [...victims].sort((a, b) => (a.team === team) - (b.team === team));
  for (const o of order) {
    if (!o.alive || state.winner !== null) continue;
    const dmg = blastDmgFor(o, base + (bonus?.get(o.id) || 0), source);
    hurt(state, o, dmg, source, attacker, events);
    if (hasPerk(attacker, 'tracker') && o.alive && o.team !== team) track(state, team, o, events);
  }
}

export function damageSentry(state, t, dmg, events) {
  if (t.hp <= 0) return;
  t.hp -= dmg;
  events.push({ type: 'sentry_damage', id: t.id, dmg, hp: Math.max(0, t.hp) });
  if (t.hp <= 0) {
    state.sentries = state.sentries.filter((s) => s !== t);
    events.push({ type: 'sentry_destroyed', id: t.id });
  }
}

// ---------- explosions ----------
const BLAST = {
  frag: { r: FRAG.radius, dmg: FRAG.dmg, src: 'explosion' },
  semtex: { r: EQUIPMENT.semtex.radius, dmg: EQUIPMENT.semtex.dmg, src: 'semtex' },
  rocket: { r: 1.5, dmg: 4, src: 'rocket' },
  barrel: { r: BARREL.radius, dmg: BARREL.dmg, src: 'barrel' },
  breach: { r: BREACH.radius, dmg: BREACH.dmg, src: 'breach' },
};
export const blastRadius = (kind) => BLAST[kind].r;

/**
 * Plan an explosion and everything it sets off, without touching state.
 * first = {kind:'frag'|'semtex'|'rocket'|'breach'|'barrel', x, y, dmg?, radius?}.
 * Returns the steps in order: [{kind, x, y, victims:[unitId], dmg, cover:[{x,y,from,to}], radius}]
 * Thrown / fired blasts and barrels hit everyone within their radius and knock cover down a level;
 * breaches only open their own tile and hit enemies of `attacker` within 1.
 * Any barrel within a blast detonates too (each one once), and chains.
 */
export function planExplosions(state, attacker, first) {
  const { map } = state;
  const S = map.size;
  const cover = Uint8Array.from(map.cover);
  const boomed = new Set();
  const steps = [];
  const queue = [first];
  if (first.kind === 'barrel') boomed.add(first.y * S + first.x);
  while (queue.length) {
    const b = queue.shift();
    const def = BLAST[b.kind];
    const r = b.radius ?? def.r;
    const step = { kind: b.kind, x: b.x, y: b.y, victims: [], dmg: b.dmg ?? def.dmg, cover: [], radius: r };
    const change = (x, y, to) => {
      const k = y * S + x;
      if (cover[k] === to) return;
      step.cover.push({ x, y, from: cover[k], to });
      cover[k] = to;
    };
    if (b.kind === 'breach') {
      step.victims = state.units.filter((o) => o.alive && o.team !== attacker.team
        && Math.max(Math.abs(o.x - b.x), Math.abs(o.y - b.y)) <= BREACH.radius).map((o) => o.id);
      const k0 = b.y * S + b.x;
      if (map.explosive && map.explosive[k0] && cover[k0] > 0 && !boomed.has(k0)) {
        boomed.add(k0);
        queue.push({ kind: 'barrel', x: b.x, y: b.y }); // blowing open a fuel drum
      }
      change(b.x, b.y, 0);
    } else {
      step.victims = state.units.filter((o) => o.alive && dist(o.x, o.y, b.x, b.y) <= r).map((o) => o.id);
      if (b.kind === 'barrel') change(b.x, b.y, 0);
    }
    for (const [tx, ty] of blastTiles(map, b.x, b.y, r)) {
      const k = ty * S + tx;
      if (tx === b.x && ty === b.y && (b.kind === 'breach' || b.kind === 'barrel')) continue; // handled above
      if (map.explosive && map.explosive[k] && cover[k] > 0 && !boomed.has(k)) {
        boomed.add(k);
        queue.push({ kind: 'barrel', x: tx, y: ty });
      } else if (b.kind !== 'breach' && cover[k] > 0 && !boomed.has(k)) {
        change(tx, ty, cover[k] - 1);
      }
    }
    steps.push(step);
  }
  return steps;
}

/** Sum a plan into a preview: visible units only. */
export function summarisePlan(state, u, steps, bonus = null) {
  const dmg = new Map();
  for (const st of steps) {
    const src = BLAST[st.kind].src;
    for (const id of st.victims) {
      const o = state.units[id];
      dmg.set(id, (dmg.get(id) || 0) + blastDmgFor(o, st.dmg + (bonus?.get(id) || 0), src));
    }
  }
  const units = [];
  for (const [id, d] of dmg) {
    const o = state.units[id];
    if (!teamSeesUnit(state, u.team, o)) continue;
    units.push({ id, dmg: d, lethal: o.downed || d >= o.hp, ally: o.team === u.team, downed: !!o.downed });
  }
  const cover = steps.flatMap((st) => st.cover);
  const barrels = steps.filter((st) => st.kind === 'barrel').map((st) => ({ x: st.x, y: st.y }));
  return { units, cover, barrels };
}

/** Run a planned chain: emits barrel / damage / cover_change events in order. */
export function detonate(state, attacker, first, events, bonus = null) {
  const S = state.map.size;
  for (const st of planExplosions(state, attacker, first)) {
    if (state.winner !== null) return;
    if (st.kind === 'barrel') {
      events.push({ type: 'barrel', x: st.x, y: st.y });
      state.map.explosive[st.y * S + st.x] = 0;
    }
    const victims = st.victims.map((id) => state.units[id]);
    const applyCover = () => { for (const c of st.cover) setCover(state, c.x, c.y, c.to, events); };
    const src = BLAST[st.kind].src;
    if (st.kind === 'breach') { applyCover(); blastDamage(state, attacker, victims, st.dmg, src, events); }
    else {
      blastDamage(state, attacker, victims, st.dmg, src, events, bonus);
      for (const t of [...(state.sentries || [])]) if (dist(t.x, t.y, st.x, st.y) <= st.radius) damageSentry(state, t, st.dmg, events);
      if (HOOKS.onBlast.length) {
        const tiles = blastTiles(state.map, st.x, st.y, st.radius);
        for (const h of HOOKS.onBlast) h(state, tiles, st.dmg, attacker, events);
      }
      applyCover();
    }
    bonus = null; // the stick bonus only applies to the first blast
  }
}

// ---------- shots ----------
/** Damage range of a shot, after mods, ability, flank and armour (pierce ignores 1). */
export function shotDamage(shooter, target, hc, ability) {
  const bonus = (shooter.mods?.barrel || 0) + (ability === 'aimed' ? AIMED.dmg : 0) + (hc.flank ? FLANK_DMG : 0);
  const armor = Math.max(0, target.armor - (hasSpecial(shooter.weapon, 'pierce') ? 1 : 0));
  const [mn, mx] = shooter.weapon.dmg;
  return [Math.max(1, mn + bonus - armor), Math.max(1, mx + bonus - armor)];
}
export const grazeBand = (w) => GRAZE_BAND + (hasSpecial(w, 'pellets') ? 10 : 0);

/** On-hit legendary traits and the Tracker perk. */
function onHit(state, s, t, events) {
  const w = s.weapon;
  if (hasPerk(s, 'tracker') || hasSpecial(w, 'tracer')) if (t.alive) track(state, s.team, t, events);
  if (hasSpecial(w, 'slow') && t.alive) {
    t.slow = 2; t.slowPending = teamIsActive(state, t.team);
    events.push({ type: 'slowed', id: t.id, by: s.id });
  }
  if (hasSpecial(w, 'flareHit') && t.alive) flare(state, t, events, true);
  if (hasSpecial(w, 'shred')) {
    const tile = coverSourceTile(state.map, t.x, t.y, s.x, s.y);
    if (tile) setCover(state, tile[0], tile[1], state.map.cover[tile[1] * state.map.size + tile[0]] - 1, events);
  }
}

/**
 * Fire the shooter's weapon at a unit (ammo is the caller's business). Burst weapons
 * roll twice (two `shot` events, `burst` 0 and 1). Returns events.
 * Shot event: {type:'shot', from, to, result:'hit'|'graze'|'miss', dmg, chance, reaction, ability,
 *   cover, flank, downed, weapon, headshot, dist, burst?}
 */
export function resolveShot(state, s, t, { reaction = false, ability } = {}) {
  const events = [];
  const w = s.weapon;
  const shots = hasSpecial(w, 'burst') ? 2 : 1;
  for (let i = 0; i < shots; i++) {
    if (!t.alive || state.winner !== null || (i > 0 && (t.downed || t.hp <= 0))) break;
    const hc = hitChance(state, s, t, { reaction, ability });
    const { chance, cover, flank } = hc;
    const r = nextRoll(state) * 100;
    let result = 'miss';
    if (r < chance) result = 'hit';
    else if (!hc.hunkered && r < chance + grazeBand(w)) result = 'graze';
    let dmg = 0, headshot = false;
    if (result !== 'miss') {
      const [mn, mx] = w.dmg;
      const bonus = (s.mods?.barrel || 0) + (ability === 'aimed' ? AIMED.dmg : 0) + (flank ? FLANK_DMG : 0);
      const rolled = mn + Math.floor(nextRoll(state) * (mx - mn + 1));
      headshot = result === 'hit' && rolled === mx;
      let base = rolled + bonus;
      if (result === 'graze') base = Math.ceil(base / 2);
      const armor = Math.max(0, t.armor - (hasSpecial(w, 'pierce') ? 1 : 0));
      dmg = Math.max(1, base - armor);
      t.hp -= dmg;
      noteDamage(state, t, s);
    }
    s.missStreak = result === 'hit' ? 0 : Math.min(MISS_STREAK_CAP, s.missStreak + 1);
    const ev = {
      type: 'shot', from: s.id, to: t.id, result, dmg, chance, reaction, ability, cover, flank, downed: false,
      weapon: w.id, headshot, dist: Math.round(dist(s.x, s.y, t.x, t.y) * 10) / 10,
    };
    if (shots > 1) ev.burst = i;
    events.push(ev);
    if (i === 0) { flare(state, s, events); noise(state, s, events); }
    if (result !== 'miss') {
      for (const h of HOOKS.onDamage) h(state, t, dmg, 'shot', events);
      onHit(state, s, t, events);
      if (t.hp <= 0 || t.downed) ev.downed = dropUnit(state, t, s, events) === 'downed';
    }
  }
  return events;
}

// ---------- smoke / revive ----------
export function clearSmokes(state, events, pred) {
  if (!state.smokes.some(pred)) return;
  state.smokes = state.smokes.filter((c) => {
    if (!pred(c)) return true;
    events.push({ type: 'smoke_clear', smokeId: c.id });
    return false;
  });
}

/** Get a downed unit back up. Quick Fix on the revived unit: +2 HP. */
export function reviveUnit(t, hp) {
  t.downed = false;
  t.bleed = 0;
  t.downedBy = null;
  t.hp = Math.min(t.maxHp, hp + (hasPerk(t, 'quickfix') ? 2 : 0));
  t.ap = 0; // back up, but acts next turn
}

// ---------- crates ----------
function swapIn(u, slot, w) {
  armWeapon(w);
  if (!u.weapons) { u.weapons = [u.weapon, null]; u.slot = 0; }
  u.weapons[slot] = w;
  if (u.slot === slot) { u.weapon = w; u.ammo = w.ammo; }
  refreshMove(u);
}

/** Fit a field attachment to the primary (fills or replaces the slot). false if it can't take one. */
export function fitAttachment(u, attId) {
  const a = ATTACHMENTS[attId];
  const prim = u.weapons ? u.weapons[0] : u.weapon;
  if (!a || !prim || prim.legendary || prim.cat === 'Pistol' || prim.cat === 'Launcher') return false;
  const atts = { ...(prim.attachments || {}), [a.slot]: a.id };
  const w = buildWeapon(prim.id, atts);
  if (w.id !== prim.id) return false; // not a catalog weapon (test fixtures)
  const cur = !u.weapons || u.slot === 0 ? u.ammo : prim.ammo;
  w.ammo = Math.min(w.mag, cur ?? w.mag);
  w.spare = prim.spare ?? w.reserve;
  if (u.weapons) u.weapons[0] = w;
  if (!u.weapons || u.slot === 0) { u.weapon = w; u.ammo = w.ammo; }
  refreshMove(u);
  return true;
}

/** Strong random crate contents for care packages and kill drops. */
export function giveLegendary(u, id) {
  const def = LEGENDARIES[id];
  if (!def) return;
  const slot = def.slot === 'secondary' ? 1 : 0;
  swapIn(u, slot, buildWeapon(id));
}

export function pickupCrate(state, u, events) {
  const crate = state.crates.find((c) => !c.taken && c.x === u.x && c.y === u.y);
  if (!crate) return;
  crate.taken = true;
  let type = crate.type;
  const ev = { type: 'crate', id: u.id, crate: crate.id, item: type };
  const addLethal = () => {
    const k = u.lethal || 'frag';
    if ((u.items[k] || 0) >= LETHAL_CAP) return false;
    u.items[k] = (u.items[k] || 0) + 1; ev.equip = k; return true;
  };
  const addTactical = () => {
    const k = u.tactical || 'smoke';
    if ((u.items[k] || 0) >= TACTICAL_CAP) return false;
    u.items[k] = (u.items[k] || 0) + 1; ev.equip = k; return true;
  };
  if (type === 'cache' || type === 'care') {
    if (u.mods.scope < MOD_CAP) u.mods.scope++;
    if (u.mods.barrel < MOD_CAP) u.mods.barrel++;
    if ((u.items.frag || 0) < FRAG_CAP && (!u.lethal || u.lethal === 'frag')) u.items.frag = (u.items.frag || 0) + 1;
    else addLethal();
    refillAll(u);
    if (type === 'care') {
      u.items.medkit++;
      addTactical();
    }
    if (crate.weapon) { giveLegendary(u, crate.weapon); ev.weapon = crate.weapon; }
  } else if (type === 'gold') {
    giveLegendary(u, crate.weapon);
    ev.weapon = crate.weapon;
  } else {
    if ((type === 'scope' || type === 'barrel' || type === 'armor') && u.mods[type] >= MOD_CAP) type = 'medkit';
    if (type === 'frag' && (u.items.frag || 0) >= FRAG_CAP) type = 'medkit';
    if (type === 'smoke' && (u.items.smoke || 0) >= SMOKE_CAP) type = 'medkit';
    if (type === 'lethal' && !addLethal()) type = 'medkit';
    if (type === 'tactical' && !addTactical()) type = 'medkit';
    if (type === 'attachment') {
      if (fitAttachment(u, crate.attachment)) ev.attachment = crate.attachment;
      else type = 'ammo';
    }
    if (type === 'medkit') u.items.medkit++;
    else if (type === 'frag') u.items.frag = (u.items.frag || 0) + 1;
    else if (type === 'smoke') u.items.smoke = (u.items.smoke || 0) + 1;
    else if (type === 'armor') { u.mods.armor++; u.armor++; }
    else if (type === 'ammo') refillAll(u);
    else if (type === 'scope' || type === 'barrel') u.mods[type]++;
    ev.item = type;
  }
  events.push(ev);
}
