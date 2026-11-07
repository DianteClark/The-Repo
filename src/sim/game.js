// Authoritative game state + actions. Pure logic: no DOM, no rendering.
// Every function that changes state returns a list of events the client animates.

import {
  TOTAL_PLAYERS, MAP_SIZE, BASE_AP, CLASSES, MODES, LONE_WOLF, GRAZE_BAND,
  MISS_STREAK_CAP, MEDKIT_HEAL, ZONE, CRATE_COUNT, CRATE_TABLE, MOD_CAP, CALLSIGNS,
  FRAG, FRAG_CAP, AIMED, BREACH, START_FRAGS, SUPPLY_DROP_ROUNDS, ABILITY_TEXT, FLANK_DMG,
  START_SMOKES, SMOKE, SMOKE_CAP, PATCH, SCAN, REVIVE_HP, BLEED_TURNS,
} from './constants.js';
import { generateMap } from './map.js';
import { makeRng, roll } from './rng.js';
import {
  reachable, pathTo, hitChance, inRangeAndLos, teamSeesUnit, teamSeesTile, dist, los, inBounds, DIRS8, standing,
} from './rules.js';

const CLASS_KEYS = Object.keys(CLASSES);

export function createGame(opts = {}) {
  const seed = (opts.seed ?? Math.floor(Math.random() * 2 ** 32)) >>> 0;
  const mode = MODES[opts.mode] ? opts.mode : 'solos';
  const playerClass = CLASSES[opts.playerClass] ? opts.playerClass : 'assault';
  const humanCount = opts.noHuman ? 0 : 1;
  const rng = makeRng(seed ^ 0x51ed270b);
  const map = generateMap(seed, MAP_SIZE);
  const S = map.size;

  // Team layout
  const { teamSize, loneWolf } = MODES[mode];
  const sizes = [];
  const full = Math.floor(TOTAL_PLAYERS / teamSize);
  for (let i = 0; i < full; i++) sizes.push(teamSize);
  const rem = TOTAL_PLAYERS - full * teamSize;
  if (rem > 0) sizes.push(rem);
  const loneWolfTeam = loneWolf && rem === 1 ? sizes.length - 1 : -1;
  const playerTeam = humanCount ? (opts.volunteerLoneWolf && loneWolfTeam >= 0 ? loneWolfTeam : 0) : -1;

  const names = [...CALLSIGNS];
  const units = [];
  const teams = sizes.map((n, t) => {
    const members = [];
    for (let i = 0; i < n; i++) {
      const isPlayer = t === playerTeam && i === 0;
      const cls = isPlayer ? playerClass : CLASS_KEYS[Math.floor(rng() * CLASS_KEYS.length)];
      const name = isPlayer ? 'You' : names.splice(Math.floor(rng() * names.length), 1)[0] || 'Bot' + units.length;
      const u = makeUnit(units.length, t, cls, name, isPlayer, t === loneWolfTeam);
      units.push(u);
      members.push(u.id);
    }
    return { id: t, members, isLoneWolf: t === loneWolfTeam };
  });

  // Spawns: squads scattered across the map, kept apart; teammates packed together.
  const occupied = new Set();
  const c = (S - 1) / 2;
  const anchors = [];
  for (let t = 0; t < teams.length; t++) {
    let best = null;
    // Best-of-N candidates: maximise the distance to the nearest squad already placed.
    for (let tries = 0; tries < 120; tries++) {
      const x = 2 + Math.floor(rng() * (S - 4)), y = 2 + Math.floor(rng() * (S - 4));
      if (map.cover[y * S + x]) continue;
      const gap = anchors.length ? Math.min(...anchors.map((a) => dist(a[0], a[1], x, y))) : 99;
      if (!best || gap > best.gap) best = { x, y, gap };
      if (gap >= 14) break;
    }
    anchors.push([best.x, best.y]);
  }
  // The human's squad gets the most isolated open spot once everyone else is placed
  // (deterministic scan, no rng draw), so they rarely get gunned down before their first turn.
  if (playerTeam >= 0) {
    let best = null;
    for (let y = 2; y < S - 2; y++) {
      for (let x = 2; x < S - 2; x++) {
        if (map.cover[y * S + x]) continue;
        const gap = Math.min(99, ...anchors.filter((_, i) => i !== playerTeam).map((a) => dist(a[0], a[1], x, y)));
        if (!best || gap > best.gap) best = { x, y, gap };
      }
    }
    if (best) anchors[playerTeam] = [best.x, best.y];
  }
  teams.forEach((team, t) => {
    const [ax, ay] = anchors[t];
    for (const id of team.members) {
      const [x, y] = nearestFree(map, occupied, ax, ay);
      units[id].x = x; units[id].y = y;
      occupied.add(y * S + x);
    }
  });

  // Crates
  const crates = [];
  let guard = 0;
  while (crates.length < CRATE_COUNT && guard++ < 5000) {
    const x = Math.floor(rng() * S), y = Math.floor(rng() * S);
    const k = y * S + x;
    if (map.cover[k] || occupied.has(k)) continue;
    if (units.some((u) => dist(u.x, u.y, x, y) < 4)) continue;
    if (crates.some((cr) => dist(cr.x, cr.y, x, y) < 3)) continue;
    crates.push({ id: crates.length, x, y, type: weighted(rng, CRATE_TABLE), taken: false });
    occupied.add(k);
  }

  // Zone (the Surge): fixed final center, radius starts covering the whole map.
  const zx = Math.round(c + (rng() - 0.5) * 8);
  const zy = Math.round(c + (rng() - 0.5) * 8);
  const r0 = Math.ceil(Math.max(dist(zx, zy, 0, 0), dist(zx, zy, S, 0), dist(zx, zy, 0, S), dist(zx, zy, S, S))) + 1;
  const zone = { x: zx, y: zy, r: r0, next: r0 - ZONE.step, stage: 0 };

  const order = teams.map((t) => t.id);
  // Rotate the start so the human isn't always first.
  // The human still lands somewhere in the first quarter of round 1, so they get
  // to act before most of the lobby has had a shot at them.
  let startShift = Math.floor(rng() * order.length);
  if (playerTeam >= 0) {
    const q = Math.max(1, Math.ceil(order.length / 4));
    startShift = (playerTeam - (startShift % q) + order.length) % order.length;
  }
  for (let i = 0; i < startShift; i++) order.push(order.shift());

  const state = {
    seed, mode, map, units, teams, crates, zone, order,
    playerTeam, loneWolfTeam,
    round: 1, turnPos: 0, rollCounter: 0,
    eliminated: [], // team ids in elimination order
    winner: null,
    smokes: [], // [{id, x, y, radius, team, expiresRound, expiresTeam}]
    reveals: [], // active scans: [{team, x, y, radius, ids}]
    nextSmokeId: 0,
    turnSerial: 0, // increments every team turn
  };
  state.startEvents = startTeamTurn(state);
  return state;
}

function makeUnit(id, team, cls, name, isPlayer, isLoneWolf) {
  const c = CLASSES[cls];
  let maxHp = c.hp, armor = c.armor, maxAp = BASE_AP;
  if (isLoneWolf) {
    maxHp = Math.round(maxHp * LONE_WOLF.hpMult);
    armor += LONE_WOLF.armor;
    maxAp += LONE_WOLF.ap;
  }
  return {
    id, team, cls, name, isPlayer, isLoneWolf,
    x: 0, y: 0, hp: maxHp, maxHp, armor, maxAp, ap: 0, move: c.move,
    alive: true, overwatch: false, missStreak: 0, kills: 0,
    weapon: { ...c.weapon, dmg: [...c.weapon.dmg] },
    mods: { scope: 0, barrel: 0, armor: 0 },
    items: { medkit: 1, frag: START_FRAGS[cls] || 0, smoke: START_SMOKES[cls] || 0 },
    cooldowns: { aimed: 0, breach: 0, patch: 0, scan: 0 },
    hunkered: false,
    downed: false, bleed: 0, downedBy: null, downedAt: -1,
  };
}

function weighted(rng, table) {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [k, w] of table) { if ((r -= w) < 0) return k; }
  return table[0][0];
}

function nearestFree(map, occupied, x0, y0) {
  const S = map.size;
  for (let r = 0; r < S; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = x0 + dx, y = y0 + dy;
        if (x < 0 || y < 0 || x >= S || y >= S) continue;
        const k = y * S + x;
        if (!map.cover[k] && !occupied.has(k)) return [x, y];
      }
    }
  }
  throw new Error('No free tile');
}

// ---------- queries ----------

export const currentTeamId = (state) => state.order[state.turnPos];
/** A team is in the match while at least one member is standing (downed members don't count). */
export const teamAlive = (state, t) => state.teams[t].members.some((id) => standing(state.units[id]));
export const aliveTeams = (state) => state.teams.filter((t) => teamAlive(state, t.id)).map((t) => t.id);
export const insideZone = (state, x, y, r = state.zone.r) => dist(x, y, state.zone.x, state.zone.y) <= r;
export const zoneDamage = (state) => ZONE.damage + Math.floor(state.round / 5);
export const roundsUntilShrink = (state) => {
  return ZONE.shrinkEvery - ((state.round - 1) % ZONE.shrinkEvery);
};

export function moveOptions(state, u) {
  const steps = u.move * Math.min(2, u.ap);
  return reachable(state, u, steps);
}

/** Damage range of a shot, after barrel, ability, flank and armor. */
function shotDamage(shooter, target, hc, ability) {
  const bonus = shooter.mods.barrel + (ability === 'aimed' ? AIMED.dmg : 0) + (hc.flank ? FLANK_DMG : 0);
  const [mn, mx] = shooter.weapon.dmg;
  return [Math.max(1, mn + bonus - target.armor), Math.max(1, mx + bonus - target.armor)];
}

/**
 * Shot preview against a target, or null if there is no legal shot.
 * { chance, cover, flank, hunkered, notes, graze, dmg:[min,max] }
 */
export function shotPreview(state, shooter, target, { ability } = {}) {
  if (!target || !target.alive || target.team === shooter.team) return null;
  if (!teamSeesUnit(state, shooter.team, target)) return null;
  if (!inRangeAndLos(state, shooter, target)) return null;
  const hc = hitChance(state, shooter, target, { ability });
  const graze = hc.hunkered ? 0 : Math.max(0, Math.min(GRAZE_BAND, 100 - hc.chance));
  return { ...hc, graze, dmg: shotDamage(shooter, target, hc, ability) };
}

/** Same shape as shotPreview with the aimed-shot modifiers applied (null if not usable). */
export function aimedPreview(state, u, target) {
  if (u.cls !== 'marksman') return null;
  return shotPreview(state, u, target, { ability: 'aimed' });
}

const blastTiles = (map, x, y, r) => {
  const out = [];
  const R = Math.ceil(r);
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (Math.hypot(dx, dy) <= r && inBounds(map, x + dx, y + dy)) out.push([x + dx, y + dy]);
    }
  }
  return out;
};

function grenadeTileOk(state, u, x, y) {
  return inBounds(state.map, x, y)
    && dist(u.x, u.y, x, y) <= FRAG.range
    && teamSeesTile(state, u.team, x, y)
    && los(state.map, u.x, u.y, x, y);
}

const canGrenade = (u) => standing(u) && u.ap >= 1 && u.items.frag > 0;

/** Valid grenade target tiles (Set of y*size+x). Empty if the unit can't throw right now. */
export function grenadeTargets(state, u) {
  const out = new Set();
  if (!canGrenade(u)) return out;
  const S = state.map.size;
  const R = FRAG.range;
  for (let y = Math.max(0, u.y - R); y <= Math.min(S - 1, u.y + R); y++) {
    for (let x = Math.max(0, u.x - R); x <= Math.min(S - 1, u.x + R); x++) {
      if (grenadeTileOk(state, u, x, y)) out.add(y * S + x);
    }
  }
  return out;
}

/**
 * What a grenade at (x,y) would do. Only lists units the thrower's team can see.
 * { valid, x, y, radius, units:[{id, dmg, lethal, ally}], cover:[{x,y,from,to}] }
 */
export function grenadePreview(state, u, x, y) {
  const valid = canGrenade(u) && grenadeTileOk(state, u, x, y);
  const { map } = state;
  const S = map.size;
  const units = [];
  const cover = [];
  if (inBounds(map, x, y)) {
    for (const o of state.units) {
      if (!o.alive || dist(o.x, o.y, x, y) > FRAG.radius) continue;
      if (!teamSeesUnit(state, u.team, o)) continue;
      const dmg = Math.max(1, FRAG.dmg - o.armor);
      units.push({ id: o.id, dmg, lethal: o.downed || dmg >= o.hp, ally: o.team === u.team, downed: !!o.downed });
    }
    for (const [tx, ty] of blastTiles(map, x, y, FRAG.radius)) {
      const from = map.cover[ty * S + tx];
      if (from > 0) cover.push({ x: tx, y: ty, from, to: from - 1 });
    }
  }
  return { valid, x, y, radius: FRAG.radius, units, cover };
}

const canBreach = (u) => standing(u) && u.cls === 'breacher' && u.ap >= 1 && u.cooldowns.breach <= 0;

/** Adjacent (8-way) tiles with cover the Breacher can blow open. Empty if not usable now. */
export function breachTargets(state, u) {
  const out = new Set();
  if (!canBreach(u)) return out;
  const { map } = state;
  for (const [dx, dy] of DIRS8) {
    const x = u.x + dx, y = u.y + dy;
    if (inBounds(map, x, y) && map.cover[y * map.size + x] > 0) out.add(y * map.size + x);
  }
  return out;
}

/** Breach preview: enemies the team can see that would be hit. { valid, units:[{id,dmg,lethal}], cover:[{x,y,from,to}] } */
export function breachPreview(state, u, x, y) {
  const S = state.map.size;
  const valid = breachTargets(state, u).has(y * S + x);
  const units = [];
  for (const o of state.units) {
    if (!o.alive || o.team === u.team || Math.max(Math.abs(o.x - x), Math.abs(o.y - y)) > BREACH.radius) continue;
    if (!teamSeesUnit(state, u.team, o)) continue;
    const dmg = Math.max(1, BREACH.dmg - o.armor);
    units.push({ id: o.id, dmg, lethal: o.downed || dmg >= o.hp });
  }
  const from = inBounds(state.map, x, y) ? state.map.cover[y * S + x] : 0;
  return { valid, units, cover: from ? [{ x, y, from, to: 0 }] : [] };
}

// ---------- 2.0 helpers: smoke, patch, scan, revive ----------

const chebyshev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const hasSquadmates = (state, u) => state.teams[u.team].members.length > 1;

const canSmoke = (u) => standing(u) && u.ap >= 1 && u.items.smoke > 0;

/** Valid smoke target tiles (same reach and LOS rules as a frag). Empty if the unit can't throw. */
export function smokeTargets(state, u) {
  const out = new Set();
  if (!canSmoke(u)) return out;
  const S = state.map.size;
  const R = SMOKE.range;
  for (let y = Math.max(0, u.y - R); y <= Math.min(S - 1, u.y + R); y++) {
    for (let x = Math.max(0, u.x - R); x <= Math.min(S - 1, u.x + R); x++) {
      if (grenadeTileOk(state, u, x, y)) out.add(y * S + x);
    }
  }
  return out;
}

const canPatch = (u) => standing(u) && u.cls === 'medic' && u.ap >= 1 && u.cooldowns.patch <= 0;
const patchable = (u, t) => t.alive && t.team === u.team && chebyshev(u, t) <= 1
  && (t.downed || t.hp < t.maxHp);

/** Tiles of units the Medic can patch now: itself or adjacent squadmates that are hurt or downed. */
export function patchTargets(state, u) {
  const out = new Set();
  if (!canPatch(u)) return out;
  for (const t of state.units) if (patchable(u, t)) out.add(t.y * state.map.size + t.x);
  return out;
}

const canRevive = (u) => standing(u) && u.ap >= 1;
const revivable = (u, t) => t.alive && t.downed && t.team === u.team && t.id !== u.id && chebyshev(u, t) <= 1;

/** Tiles of adjacent downed squadmates this unit can revive. */
export function reviveTargets(state, u) {
  const out = new Set();
  if (!canRevive(u)) return out;
  for (const t of state.units) if (revivable(u, t)) out.add(t.y * state.map.size + t.x);
  return out;
}

const canScan = (u) => standing(u) && u.cls === 'recon' && u.ap >= 1 && u.cooldowns.scan <= 0;
const scanTileOk = (state, u, x, y) => Number.isInteger(x) && Number.isInteger(y)
  && inBounds(state.map, x, y) && dist(u.x, u.y, x, y) <= SCAN.range;

/**
 * Scan preview. Never leaks hidden units: `units` lists only enemies in the
 * area the team can already see. { valid, x, y, radius, units:[{id}] }
 */
export function scanPreview(state, u, x, y) {
  const valid = canScan(u) && scanTileOk(state, u, x, y);
  const units = [];
  for (const o of state.units) {
    if (!o.alive || o.team === u.team || dist(o.x, o.y, x, y) > SCAN.radius) continue;
    if (teamSeesUnit(state, u.team, o)) units.push({ id: o.id });
  }
  return { valid, x, y, radius: SCAN.radius, units };
}

/** Units patch / revive / smoke would affect. Squadmates: always known. */
export function smokePreview(state, u, x, y) {
  const valid = canSmoke(u) && grenadeTileOk(state, u, x, y);
  const units = state.units.filter((o) => o.alive && dist(o.x, o.y, x, y) <= SMOKE.radius
    && teamSeesUnit(state, u.team, o)).map((o) => ({ id: o.id, ally: o.team === u.team }));
  return { valid, x, y, radius: SMOKE.radius, units };
}

/**
 * Ability buttons for a unit. Pass state as well to also check for targets
 * (e.g. "No cover adjacent"); without it only AP / charges / cooldowns are checked.
 * Keys: grenade, smoke, aimed (marksman), breach (breacher), patch (medic),
 * scan (recon), revive (team modes), hunker.
 */
export function abilityInfo(u, state) {
  const out = [];
  const entry = (key, ready, reason, extra) => {
    const e = { key, ...ABILITY_TEXT[key], ready, ...extra };
    if (!ready && reason) e.reason = reason;
    out.push(e);
  };
  const apReason = !u.alive ? 'Down' : u.downed ? 'Downed' : u.ap < 1 ? 'No AP' : null;
  const cdReason = (cd) => (cd > 0 ? `Cooldown ${cd}` : apReason);
  {
    let reason = apReason || (u.items.frag < 1 ? 'No grenades' : null);
    if (!reason && state && grenadeTargets(state, u).size === 0) reason = 'No target';
    entry('grenade', !reason, reason, { charges: u.items.frag });
  }
  {
    const n = u.items.smoke || 0;
    let reason = apReason || (n < 1 ? 'No smoke' : null);
    if (!reason && state && smokeTargets(state, u).size === 0) reason = 'No target';
    entry('smoke', !reason, reason, { charges: n });
  }
  if (u.cls === 'marksman') {
    const cd = u.cooldowns.aimed;
    let reason = cdReason(cd);
    if (!reason && state && !state.units.some((t) => aimedPreview(state, u, t))) reason = 'No target';
    entry('aimed', !reason, reason, { cooldown: cd });
  }
  if (u.cls === 'breacher') {
    const cd = u.cooldowns.breach;
    let reason = cdReason(cd);
    if (!reason && state && breachTargets(state, u).size === 0) reason = 'No cover adjacent';
    entry('breach', !reason, reason, { cooldown: cd });
  }
  if (u.cls === 'medic') {
    const cd = u.cooldowns.patch;
    let reason = cdReason(cd);
    if (!reason && state && patchTargets(state, u).size === 0) reason = 'Nobody hurt nearby';
    entry('patch', !reason, reason, { cooldown: cd });
  }
  if (u.cls === 'recon') {
    const cd = u.cooldowns.scan;
    entry('scan', !cdReason(cd), cdReason(cd), { cooldown: cd });
  }
  if (!state || hasSquadmates(state, u)) {
    let reason = apReason;
    if (!reason && state && reviveTargets(state, u).size === 0) reason = 'No downed squadmate adjacent';
    if (!reason && !state) reason = 'No downed squadmate adjacent';
    entry('revive', !reason, reason, {});
  }
  entry('hunker', !apReason, apReason, {});
  return out;
}

// ---------- turn flow ----------

function startTeamTurn(state) {
  const t = currentTeamId(state);
  const events = [];
  state.turnSerial++;
  // This team's scans and smoke clouds run out as its turn begins.
  if (state.reveals.some((r) => r.team === t)) {
    state.reveals = state.reveals.filter((r) => r.team !== t);
    events.push({ type: 'reveal_end', team: t });
  }
  clearSmokes(state, events, (c) => c.expiresTeam === t && c.expiresRound <= state.round);
  for (const id of state.teams[t].members) {
    const u = state.units[id];
    if (!u.alive) continue;
    u.overwatch = false;
    u.hunkered = false;
    u.ap = u.downed ? 0 : u.maxAp;
    for (const k of Object.keys(u.cooldowns)) if (u.cooldowns[k] > 0) u.cooldowns[k]--;
  }
  events.push({ type: 'turn_start', team: t, round: state.round });
  return events;
}

function clearSmokes(state, events, pred) {
  if (!state.smokes.some(pred)) return;
  state.smokes = state.smokes.filter((c) => {
    if (!pred(c)) return true;
    events.push({ type: 'smoke_clear', smokeId: c.id });
    return false;
  });
}

export function endTeamTurn(state) {
  if (state.winner !== null) return [];
  const events = [];
  const t = currentTeamId(state);
  const members = state.teams[t].members.map((id) => state.units[id]);
  // Downed squadmates bleed out at the end of their own team's turn.
  for (const u of members) {
    if (!u.alive || !u.downed) continue;
    if (u.downedAt === state.turnSerial) continue; // went down this very turn: the clock starts next turn
    u.bleed--;
    if (u.bleed <= 0) {
      events.push({ type: 'bleed_out', id: u.id });
      kill(state, u, u.downedBy !== null ? state.units[u.downedBy] : null, events);
      if (state.winner !== null) return events;
    }
  }
  // The tide hurts anyone caught outside at the end of their turn (and finishes the downed).
  for (const u of members) {
    if (!u.alive) continue;
    u.ap = 0;
    if (!insideZone(state, u.x, u.y)) {
      const dmg = zoneDamage(state);
      u.hp -= dmg;
      const ev = { type: 'zone_damage', id: u.id, dmg, downed: false };
      events.push(ev);
      if (u.hp <= 0) ev.downed = dropUnit(state, u, null, events) === 'downed';
      if (state.winner !== null) return events;
    }
  }

  // Advance to the next living team.
  let pos = state.turnPos + 1;
  while (pos < state.order.length && !teamAlive(state, state.order[pos])) pos++;
  if (pos >= state.order.length) {
    state.round++;
    state.order = state.order.filter((id) => teamAlive(state, id));
    state.order.push(state.order.shift()); // rotate who goes first each round
    pos = 0;
    events.push({ type: 'round_start', round: state.round });
    // Smoke from a squad that has since been wiped never gets its expiry turn.
    clearSmokes(state, events, (c) => c.expiresRound < state.round);
    if ((state.round - 1) % ZONE.shrinkEvery === 0) {
      const z = state.zone;
      z.r = Math.max(ZONE.minRadius, z.next);
      // Shrink in steps down to the final ring, hold it once, then flood everything.
      z.next = z.r > ZONE.finalRadius ? Math.max(ZONE.finalRadius, z.r - ZONE.step) : ZONE.minRadius;
      z.stage++;
      events.push({ type: 'zone_shrink', r: z.r, next: z.next });
    }
    if (SUPPLY_DROP_ROUNDS.includes(state.round)) supplyDrop(state, events);
  }
  state.turnPos = pos;
  events.push(...startTeamTurn(state));
  return events;
}

/** A cache lands on a random free open tile inside the next safe zone. */
function supplyDrop(state, events) {
  const { map, zone } = state;
  const S = map.size;
  const busy = new Set();
  for (const o of state.units) if (o.alive) busy.add(o.y * S + o.x);
  for (const c of state.crates) if (!c.taken) busy.add(c.y * S + c.x);
  let spots = [];
  for (const r of [zone.next, zone.r, Infinity]) {
    spots = [];
    for (let k = 0; k < S * S; k++) {
      if (map.cover[k] || busy.has(k)) continue;
      if (dist(k % S, (k / S) | 0, zone.x, zone.y) <= r) spots.push(k);
    }
    if (spots.length) break;
  }
  if (!spots.length) return;
  const k = spots[Math.floor(roll(state.seed, state.rollCounter++) * spots.length)];
  const crate = { id: state.crates.length, x: k % S, y: (k / S) | 0, type: 'cache', taken: false, dropped: true };
  state.crates.push(crate);
  events.push({ type: 'supply_drop', crate: { ...crate } });
}

/**
 * A unit has hit 0 HP. Downed if a squadmate is still standing (team modes),
 * otherwise dead; a downed unit hit again dies. Returns 'downed' | 'dead'.
 */
function dropUnit(state, u, by, events) {
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
    return 'downed';
  }
  kill(state, u, by, events);
  return 'dead';
}

function markDead(state, u, killer, events) {
  u.hp = 0;
  u.alive = false;
  u.downed = false;
  u.bleed = 0;
  u.ap = 0;
  u.overwatch = false;
  u.hunkered = false;
  if (killer && killer.team !== u.team) killer.kills++;
  events.push({ type: 'death', id: u.id, by: killer ? killer.id : null });
  // Leftover medkits (or failing that, grenades / smoke) drop as a crate.
  const drop = u.items.medkit > 0 ? 'medkit' : u.items.frag > 0 ? 'frag' : u.items.smoke > 0 ? 'smoke' : null;
  if (drop && !state.crates.some((c) => !c.taken && c.x === u.x && c.y === u.y)) {
    const crate = { id: state.crates.length, x: u.x, y: u.y, type: drop, taken: false, dropped: true };
    state.crates.push(crate);
    events.push({ type: 'crate_drop', crate: { ...crate } });
  }
}

function kill(state, u, killer, events) {
  if (!u.alive) return;
  markDead(state, u, killer, events);
  if (!teamAlive(state, u.team) && !state.eliminated.includes(u.team)) {
    // Squad wipe: nobody left to revive the downed.
    for (const id of state.teams[u.team].members) {
      const m = state.units[id];
      if (m.alive) markDead(state, m, m.downedBy !== null ? state.units[m.downedBy] : killer, events);
    }
    state.eliminated.push(u.team);
    if (state.reveals.some((r) => r.team === u.team)) {
      state.reveals = state.reveals.filter((r) => r.team !== u.team);
      events.push({ type: 'reveal_end', team: u.team });
    }
    events.push({ type: 'team_out', team: u.team, place: state.teams.length - state.eliminated.length + 1 });
  }
  const alive = aliveTeams(state);
  if (alive.length <= 1 && state.winner === null) {
    // If the last squads fall together, the last one eliminated takes the win.
    state.winner = alive.length ? alive[0] : state.eliminated[state.eliminated.length - 1];
    events.push({ type: 'game_over', winner: state.winner });
  }
}

function resolveShot(state, s, t, { reaction = false, ability } = {}) {
  const events = [];
  const hc = hitChance(state, s, t, { reaction, ability });
  const { chance, cover, flank } = hc;
  const r = roll(state.seed, state.rollCounter++) * 100;
  let result = 'miss';
  if (r < chance) result = 'hit';
  else if (!hc.hunkered && r < chance + GRAZE_BAND) result = 'graze';
  let dmg = 0;
  if (result !== 'miss') {
    const [mn, mx] = s.weapon.dmg;
    const bonus = s.mods.barrel + (ability === 'aimed' ? AIMED.dmg : 0) + (flank ? FLANK_DMG : 0);
    let base = mn + Math.floor(roll(state.seed, state.rollCounter++) * (mx - mn + 1)) + bonus;
    if (result === 'graze') base = Math.ceil(base / 2);
    dmg = Math.max(1, base - t.armor);
    t.hp -= dmg;
  }
  s.missStreak = result === 'hit' ? 0 : Math.min(MISS_STREAK_CAP, s.missStreak + 1);
  const ev = { type: 'shot', from: s.id, to: t.id, result, dmg, chance, reaction, ability, cover, flank, downed: false };
  events.push(ev);
  if (result !== 'miss' && (t.hp <= 0 || t.downed)) ev.downed = dropUnit(state, t, s, events) === 'downed';
  return events;
}

/** Explosive damage (ignores cover). Emits damage (+downed/death) events. Stops once the match is decided. */
function blastDamage(state, attacker, victims, base, source, events) {
  // Enemies first, so a blast that also catches the thrower's squad settles the match in the thrower's favour.
  const order = [...victims].sort((a, b) => (a.team === attacker.team) - (b.team === attacker.team));
  for (const o of order) {
    if (!o.alive || state.winner !== null) continue;
    const dmg = Math.max(1, base - o.armor);
    o.hp -= dmg;
    const ev = { type: 'damage', id: o.id, dmg, source, by: attacker.id, downed: false };
    events.push(ev);
    if (o.hp <= 0 || o.downed) ev.downed = dropUnit(state, o, attacker, events) === 'downed';
  }
}

function setCover(state, x, y, to, events) {
  const S = state.map.size;
  const from = state.map.cover[y * S + x];
  if (from === to) return;
  state.map.cover[y * S + x] = to;
  events.push({ type: 'cover_change', x, y, from, to });
}

function pickupCrate(state, u, events) {
  const crate = state.crates.find((c) => !c.taken && c.x === u.x && c.y === u.y);
  if (!crate) return;
  crate.taken = true;
  let type = crate.type;
  if (type === 'cache') {
    if (u.mods.scope < MOD_CAP) u.mods.scope++;
    if (u.mods.barrel < MOD_CAP) u.mods.barrel++;
    if (u.items.frag < FRAG_CAP) u.items.frag++;
  } else {
    if ((type === 'scope' || type === 'barrel' || type === 'armor') && u.mods[type] >= MOD_CAP) type = 'medkit';
    if (type === 'frag' && u.items.frag >= FRAG_CAP) type = 'medkit';
    if (type === 'smoke' && u.items.smoke >= SMOKE_CAP) type = 'medkit';
    if (type === 'medkit') u.items.medkit++;
    else if (type === 'frag') u.items.frag++;
    else if (type === 'smoke') u.items.smoke++;
    else if (type === 'armor') { u.mods.armor++; u.armor++; }
    else u.mods[type]++;
  }
  events.push({ type: 'crate', id: u.id, crate: crate.id, item: type });
}

function reviveUnit(t, hp) {
  t.downed = false;
  t.bleed = 0;
  t.downedBy = null;
  t.hp = Math.min(t.maxHp, hp);
  t.ap = 0; // back up, but acts next turn
}

// ---------- actions ----------

const fail = (error) => ({ ok: false, error, events: [] });
const intXY = (a) => Number.isInteger(a.x) && Number.isInteger(a.y);

export function act(state, unitId, action) {
  const u = state.units[unitId];
  if (state.winner !== null) return fail('Game over');
  if (!u || !u.alive) return fail('Unit is down');
  if (u.downed) return fail('Unit is downed');
  if (u.team !== currentTeamId(state)) return fail('Not your turn');
  if (!action || typeof action.type !== 'string') return fail('Unknown action');
  const events = [];

  switch (action.type) {
    case 'move': {
      if (u.ap < 1) return fail('No AP');
      if (!intXY(action)) return fail('Unreachable');
      const S = state.map.size;
      const reach = moveOptions(state, u);
      const key = action.y * S + action.x;
      const node = reach.get(key);
      if (!node || node.d === 0) return fail('Unreachable');
      const cost = node.d <= u.move ? 1 : 2;
      if (cost > u.ap) return fail('Not enough AP');
      u.ap -= cost;
      const path = pathTo(reach, S, key);
      let leg = [path[0]];
      outer: for (const [px, py] of path.slice(1)) {
        u.x = px; u.y = py;
        leg.push([px, py]);
        for (const e of state.units) {
          if (!standing(e) || !e.overwatch || e.team === u.team) continue;
          if (!teamSeesUnit(state, e.team, u) || !inRangeAndLos(state, e, u)) continue;
          events.push({ type: 'move', id: u.id, path: leg });
          leg = [[px, py]];
          e.overwatch = false;
          events.push({ type: 'overwatch_trigger', id: e.id, target: u.id });
          events.push(...resolveShot(state, e, u, { reaction: true }));
          if (!standing(u) || state.winner !== null) break outer;
        }
      }
      if (leg.length > 1) events.push({ type: 'move', id: u.id, path: leg });
      if (standing(u)) pickupCrate(state, u, events);
      else u.ap = 0;
      return { ok: true, events };
    }
    case 'shoot': {
      if (u.ap < 1) return fail('No AP');
      const t = state.units[action.targetId];
      if (!t || !shotPreview(state, u, t)) return fail('No shot');
      u.ap = 0; // firing ends your turn, XCOM-style
      events.push(...resolveShot(state, u, t));
      return { ok: true, events };
    }
    case 'overwatch': {
      if (u.ap < 1) return fail('No AP');
      u.ap = 0;
      u.overwatch = true;
      events.push({ type: 'overwatch', id: u.id });
      return { ok: true, events };
    }
    case 'medkit': {
      if (u.ap < 1) return fail('No AP');
      if (u.items.medkit < 1) return fail('No medkit');
      if (u.hp >= u.maxHp) return fail('Full health');
      u.ap--;
      u.items.medkit--;
      const heal = Math.min(MEDKIT_HEAL, u.maxHp - u.hp);
      u.hp += heal;
      events.push({ type: 'heal', id: u.id, amount: heal });
      return { ok: true, events };
    }
    case 'aimed': {
      if (u.cls !== 'marksman') return fail('Marksman only');
      if (u.cooldowns.aimed > 0) return fail('Cooldown');
      if (u.ap < 1) return fail('No AP');
      const t = state.units[action.targetId];
      if (!t || !aimedPreview(state, u, t)) return fail('No shot');
      u.ap = 0;
      u.cooldowns.aimed = AIMED.cooldown;
      events.push(...resolveShot(state, u, t, { ability: 'aimed' }));
      return { ok: true, events };
    }
    case 'grenade': {
      if (u.ap < 1) return fail('No AP');
      if (u.items.frag < 1) return fail('No grenades');
      const { x, y } = action;
      if (!intXY(action) || !grenadeTileOk(state, u, x, y)) return fail('Bad target');
      u.ap--;
      u.items.frag--;
      events.push({ type: 'grenade', id: u.id, x, y, radius: FRAG.radius });
      const victims = state.units.filter((o) => o.alive && dist(o.x, o.y, x, y) <= FRAG.radius);
      blastDamage(state, u, victims, FRAG.dmg, 'explosion', events);
      const S = state.map.size;
      for (const [tx, ty] of blastTiles(state.map, x, y, FRAG.radius)) {
        const c = state.map.cover[ty * S + tx];
        if (c > 0) setCover(state, tx, ty, c - 1, events);
      }
      if (!standing(u)) u.ap = 0;
      return { ok: true, events };
    }
    case 'smoke': {
      if (u.ap < 1) return fail('No AP');
      if ((u.items.smoke || 0) < 1) return fail('No smoke');
      const { x, y } = action;
      if (!intXY(action) || !grenadeTileOk(state, u, x, y)) return fail('Bad target');
      u.ap--;
      u.items.smoke--;
      const cloud = {
        id: state.nextSmokeId++, x, y, radius: SMOKE.radius, team: u.team,
        expiresRound: state.round + 1, expiresTeam: u.team,
      };
      state.smokes.push(cloud);
      events.push({ type: 'smoke', id: u.id, x, y, radius: SMOKE.radius, smokeId: cloud.id });
      return { ok: true, events };
    }
    case 'breach': {
      if (u.cls !== 'breacher') return fail('Breacher only');
      if (u.cooldowns.breach > 0) return fail('Cooldown');
      if (u.ap < 1) return fail('No AP');
      const { x, y } = action;
      if (!intXY(action) || !breachTargets(state, u).has(y * state.map.size + x)) return fail('Bad target');
      u.ap--;
      u.cooldowns.breach = BREACH.cooldown;
      events.push({ type: 'breach', id: u.id, x, y });
      setCover(state, x, y, 0, events);
      const victims = state.units.filter((o) => o.alive && o.team !== u.team
        && Math.max(Math.abs(o.x - x), Math.abs(o.y - y)) <= BREACH.radius);
      blastDamage(state, u, victims, BREACH.dmg, 'breach', events);
      return { ok: true, events };
    }
    case 'patch': {
      if (u.cls !== 'medic') return fail('Medic only');
      if (u.cooldowns.patch > 0) return fail('Cooldown');
      if (u.ap < 1) return fail('No AP');
      const t = action.targetId === undefined ? u : state.units[action.targetId];
      if (!t || !patchable(u, t)) return fail('Bad target');
      u.ap--;
      u.cooldowns.patch = PATCH.cooldown;
      if (t.downed) {
        reviveUnit(t, PATCH.reviveHp);
        events.push({ type: 'patch', id: u.id, target: t.id, amount: t.hp });
        events.push({ type: 'revive', id: t.id, by: u.id, hp: t.hp });
      } else {
        const amount = Math.min(PATCH.heal, t.maxHp - t.hp);
        t.hp += amount;
        events.push({ type: 'patch', id: u.id, target: t.id, amount });
      }
      return { ok: true, events };
    }
    case 'revive': {
      if (u.ap < 1) return fail('No AP');
      const t = state.units[action.targetId];
      if (!t || !revivable(u, t)) return fail('Bad target');
      u.ap--;
      reviveUnit(t, REVIVE_HP);
      events.push({ type: 'revive', id: t.id, by: u.id, hp: t.hp });
      return { ok: true, events };
    }
    case 'scan': {
      if (u.cls !== 'recon') return fail('Recon only');
      if (u.cooldowns.scan > 0) return fail('Cooldown');
      if (u.ap < 1) return fail('No AP');
      const { x, y } = action;
      if (!scanTileOk(state, u, x, y)) return fail('Bad target');
      u.ap--;
      u.cooldowns.scan = SCAN.cooldown;
      const ids = state.units.filter((o) => o.alive && o.team !== u.team && dist(o.x, o.y, x, y) <= SCAN.radius).map((o) => o.id);
      state.reveals.push({ team: u.team, x, y, radius: SCAN.radius, ids });
      events.push({ type: 'scan', id: u.id, x, y, radius: SCAN.radius, revealed: [...ids] });
      return { ok: true, events };
    }
    case 'hunker': {
      if (u.ap < 1) return fail('No AP');
      u.ap = 0;
      u.overwatch = false;
      u.hunkered = true;
      events.push({ type: 'hunker', id: u.id });
      return { ok: true, events };
    }
    case 'hold': {
      u.ap = 0;
      return { ok: true, events };
    }
    default:
      return fail('Unknown action');
  }
}
