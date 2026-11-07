// Authoritative game state + actions. Pure logic: no DOM, no rendering.
// Every function that changes state returns a list of events the client animates.

import {
  TOTAL_PLAYERS, MAP_SIZE, BASE_AP, CLASSES, MODES, LONE_WOLF, GRAZE_BAND,
  MISS_STREAK_CAP, MEDKIT_HEAL, ZONE, CRATE_COUNT, CRATE_TABLE, MOD_CAP, CALLSIGNS,
} from './constants.js';
import { generateMap } from './map.js';
import { makeRng, roll } from './rng.js';
import {
  reachable, pathTo, hitChance, inRangeAndLos, teamSeesUnit, dist,
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
    for (let tries = 0; tries < 60; tries++) {
      const x = 2 + Math.floor(rng() * (S - 4)), y = 2 + Math.floor(rng() * (S - 4));
      if (map.cover[y * S + x]) continue;
      const gap = anchors.length ? Math.min(...anchors.map((a) => dist(a[0], a[1], x, y))) : 99;
      if (!best || gap > best.gap) best = { x, y, gap };
      if (gap >= 8) break;
    }
    anchors.push([best.x, best.y]);
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
  const startShift = Math.floor(rng() * order.length);
  for (let i = 0; i < startShift; i++) order.push(order.shift());

  const state = {
    seed, mode, map, units, teams, crates, zone, order,
    playerTeam, loneWolfTeam,
    round: 1, turnPos: 0, rollCounter: 0,
    eliminated: [], // team ids in elimination order
    winner: null,
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
    items: { medkit: 1 },
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
export const teamAlive = (state, t) => state.teams[t].members.some((id) => state.units[id].alive);
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

export function shotPreview(state, shooter, target) {
  if (!target.alive || target.team === shooter.team) return null;
  if (!teamSeesUnit(state, shooter.team, target)) return null;
  if (!inRangeAndLos(state, shooter, target)) return null;
  const hc = hitChance(state, shooter, target);
  const graze = Math.max(0, Math.min(GRAZE_BAND, 100 - hc.chance));
  const [mn, mx] = shooter.weapon.dmg;
  return {
    ...hc, graze,
    dmg: [Math.max(1, mn + shooter.mods.barrel - target.armor), Math.max(1, mx + shooter.mods.barrel - target.armor)],
  };
}

// ---------- turn flow ----------

function startTeamTurn(state) {
  const t = currentTeamId(state);
  for (const id of state.teams[t].members) {
    const u = state.units[id];
    if (!u.alive) continue;
    u.ap = u.maxAp;
    u.overwatch = false;
  }
  return [{ type: 'turn_start', team: t, round: state.round }];
}

export function endTeamTurn(state) {
  if (state.winner !== null) return [];
  const events = [];
  const t = currentTeamId(state);
  // The tide hurts anyone caught outside at the end of their turn.
  for (const id of state.teams[t].members) {
    const u = state.units[id];
    if (!u.alive) continue;
    u.ap = 0;
    if (!insideZone(state, u.x, u.y)) {
      const dmg = zoneDamage(state);
      u.hp -= dmg;
      events.push({ type: 'zone_damage', id: u.id, dmg });
      if (u.hp <= 0) kill(state, u, null, events);
    }
  }
  if (state.winner !== null) return events;

  // Advance to the next living team.
  let pos = state.turnPos + 1;
  while (pos < state.order.length && !teamAlive(state, state.order[pos])) pos++;
  if (pos >= state.order.length) {
    state.round++;
    state.order = state.order.filter((id) => teamAlive(state, id));
    state.order.push(state.order.shift()); // rotate who goes first each round
    pos = 0;
    events.push({ type: 'round_start', round: state.round });
    if ((state.round - 1) % ZONE.shrinkEvery === 0) {
      const z = state.zone;
      z.r = Math.max(ZONE.minRadius, z.next);
      z.next = Math.max(ZONE.minRadius, z.r - ZONE.step);
      z.stage++;
      events.push({ type: 'zone_shrink', r: z.r, next: z.next });
    }
  }
  state.turnPos = pos;
  events.push(...startTeamTurn(state));
  return events;
}

function kill(state, u, killer, events) {
  u.hp = 0;
  u.alive = false;
  u.overwatch = false;
  if (killer) killer.kills++;
  events.push({ type: 'death', id: u.id, by: killer ? killer.id : null });
  // Leftover medkits drop as a crate.
  if (u.items.medkit > 0) {
    const crate = { id: state.crates.length, x: u.x, y: u.y, type: 'medkit', taken: false, dropped: true };
    state.crates.push(crate);
    events.push({ type: 'crate_drop', crate: { ...crate } });
  }
  if (!teamAlive(state, u.team)) {
    state.eliminated.push(u.team);
    events.push({ type: 'team_out', team: u.team, place: state.teams.length - state.eliminated.length + 1 });
  }
  const alive = aliveTeams(state);
  if (alive.length <= 1 && state.winner === null) {
    state.winner = alive.length ? alive[0] : -1;
    events.push({ type: 'game_over', winner: state.winner });
  }
}

function resolveShot(state, s, t, { reaction = false } = {}) {
  const events = [];
  const { chance } = hitChance(state, s, t, { reaction });
  const r = roll(state.seed, state.rollCounter++) * 100;
  let result = 'miss';
  if (r < chance) result = 'hit';
  else if (r < chance + GRAZE_BAND) result = 'graze';
  let dmg = 0;
  if (result !== 'miss') {
    const [mn, mx] = s.weapon.dmg;
    let base = mn + Math.floor(roll(state.seed, state.rollCounter++) * (mx - mn + 1)) + s.mods.barrel;
    if (result === 'graze') base = Math.ceil(base / 2);
    dmg = Math.max(1, base - t.armor);
    t.hp -= dmg;
  }
  s.missStreak = result === 'hit' ? 0 : Math.min(MISS_STREAK_CAP, s.missStreak + 1);
  events.push({ type: 'shot', from: s.id, to: t.id, result, dmg, chance, reaction });
  if (t.hp <= 0) kill(state, t, s, events);
  return events;
}

function pickupCrate(state, u, events) {
  const crate = state.crates.find((c) => !c.taken && c.x === u.x && c.y === u.y);
  if (!crate) return;
  crate.taken = true;
  let type = crate.type;
  if ((type === 'scope' || type === 'barrel' || type === 'armor') && u.mods[type] >= MOD_CAP) type = 'medkit';
  if (type === 'medkit') u.items.medkit++;
  else if (type === 'armor') { u.mods.armor++; u.armor++; }
  else u.mods[type]++;
  events.push({ type: 'crate', id: u.id, crate: crate.id, item: type });
}

// ---------- actions ----------

const fail = (error) => ({ ok: false, error, events: [] });

export function act(state, unitId, action) {
  const u = state.units[unitId];
  if (state.winner !== null) return fail('Game over');
  if (!u || !u.alive) return fail('Unit is down');
  if (u.team !== currentTeamId(state)) return fail('Not your turn');
  const events = [];

  switch (action.type) {
    case 'move': {
      if (u.ap < 1) return fail('No AP');
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
          if (!e.alive || !e.overwatch || e.team === u.team) continue;
          if (!teamSeesUnit(state, e.team, u) || !inRangeAndLos(state, e, u)) continue;
          events.push({ type: 'move', id: u.id, path: leg });
          leg = [[px, py]];
          e.overwatch = false;
          events.push({ type: 'overwatch_trigger', id: e.id, target: u.id });
          events.push(...resolveShot(state, e, u, { reaction: true }));
          if (!u.alive) break outer;
        }
      }
      if (leg.length > 1) events.push({ type: 'move', id: u.id, path: leg });
      if (u.alive) pickupCrate(state, u, events);
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
    case 'hold': {
      u.ap = 0;
      return { ok: true, events };
    }
    default:
      return fail('Unknown action');
  }
}
