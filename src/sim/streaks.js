// Killstreaks (5.0 spec §4): UAV, Care Package, Counter-UAV, Airstrike, Sentry, Gunship.
// A streak unlocks when the caller's streak points reach its cost (Hardline -1; points: kill +2,
// down +1, assist +1, revive +1 — see core.js addPoints),
// can be used once per match, costs 0 AP, and at most one can be called per turn.
//
// State:
//   unit.streaks:[key×3]  unit.streakUsed:{key:true}  unit.streakCalled (this turn)
//   state.reveals  += {team, kind:'uav', x, y, radius, ids}
//   state.cuav     = [{team, untilRound}]
//   state.drops    = [{x, y, crate}]                 care packages landing next step
//   state.airstrikes = [{id, team, owner, tiles:[[x,y]], round}]
//   state.sentries = [{id, team, owner, x, y, hp, dir:[dx,dy], expiresRound, shots}]
//   state.gunships = [{id, team, owner, untilRound}]

import { COVER_PENALTY, HUNKER_MULT } from './constants.js';
import { roll } from './rng.js';
import {
  dist, inBounds, los, standing, teamSeesUnit, tileCoverDirs, hitChance,
} from './rules.js';
import { STREAKS, LEGENDARY_KEYS, ATTACHMENTS } from './weapons.js';
import {
  streakCost, teamIsActive, hiddenFromIntel, nextRoll, hurt, blastDamage, setCover, dropUnit, detonate,
  streakPoints, noteDamage, HOOKS,
} from './core.js';

const fail = (error) => ({ error });
const tileFree = (state, x, y) => {
  if (!inBounds(state.map, x, y) || state.map.cover[y * state.map.size + x] > 0) return false;
  if (state.units.some((o) => o.alive && o.x === x && o.y === y)) return false;
  if ((state.sentries || []).some((t) => t.x === x && t.y === y)) return false;
  return true;
};

/**
 * Streak bar for a unit: [{key, name, desc, cost, points, kills, ready, used, earned, target, reason?}]
 * 5.0: streaks are earned with streak points (kill +2, down +1, assist +1, revive +1); `cost` is in points.
 */
export function streakInfo(state, u) {
  const pts = streakPoints(u);
  return (u.streaks || []).map((key) => {
    const d = STREAKS[key];
    const cost = streakCost(u, key);
    const used = !!u.streakUsed?.[key];
    let reason = null;
    if (used) reason = 'Used';
    else if (pts < cost) reason = `${cost - pts} more point${cost - pts === 1 ? '' : 's'}`;
    else if (!standing(u)) reason = 'Downed';
    else if (state && !teamIsActive(state, u.team)) reason = 'Not your turn';
    else if (u.streakCalled) reason = 'One per turn';
    const e = { key, name: d.name, desc: d.desc, cost, points: pts, kills: u.kills, ready: !reason, used, target: d.target, earned: pts >= cost };
    if (reason) e.reason = reason;
    return e;
  });
}

/** The 7 tiles an airstrike from (x,y) towards (x2,y2) covers (clipped to the map). */
export function airstrikeLine(state, x, y, x2, y2) {
  let dx = (x2 ?? x + 1) - x, dy = (y2 ?? y) - y;
  if (!dx && !dy) dx = 1;
  const L = Math.max(Math.abs(dx), Math.abs(dy));
  const sx = dx / L, sy = dy / L;
  const tiles = [];
  for (let i = 0; i < STREAKS.airstrike.length; i++) {
    const tx = Math.round(x + sx * i), ty = Math.round(y + sy * i);
    if (inBounds(state.map, tx, ty)) tiles.push([tx, ty]);
  }
  return tiles;
}

/** Valid target tiles (Set of y*size+x) for a targeted streak; empty for instant ones. */
export function streakTargets(state, u, key) {
  const out = new Set();
  const d = STREAKS[key];
  if (!d || !d.target) return out;
  const S = state.map.size;
  const R = Math.ceil(d.range);
  for (let y = Math.max(0, u.y - R); y <= Math.min(S - 1, u.y + R); y++) {
    for (let x = Math.max(0, u.x - R); x <= Math.min(S - 1, u.x + R); x++) {
      if (dist(u.x, u.y, x, y) > d.range) continue;
      if (key === 'airstrike' ? true : tileFree(state, x, y)) out.add(y * S + x);
    }
  }
  return out;
}

/** What a streak would do. { valid, key, tiles:[[x,y]], radius?, units:[{id, ally}] } (visible units only). */
export function streakPreview(state, u, key, x, y, x2, y2) {
  const d = STREAKS[key];
  const info = streakInfo(state, u).find((s) => s.key === key);
  const res = { valid: !!info && info.ready, key, tiles: [], units: [] };
  if (!d) return { ...res, valid: false };
  const seen = (o) => o.alive && teamSeesUnit(state, u.team, o);
  if (key === 'uav') {
    res.radius = d.radius; res.tiles = [[u.x, u.y]];
    res.units = state.units.filter((o) => seen(o) && o.team !== u.team && dist(o.x, o.y, u.x, u.y) <= d.radius).map((o) => ({ id: o.id, ally: false }));
  } else if (key === 'cuav' || key === 'gunship') {
    res.tiles = [];
  } else if (key === 'airstrike') {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return { ...res, valid: false };
    res.tiles = airstrikeLine(state, x, y, x2, y2);
    res.valid = res.valid && dist(u.x, u.y, x, y) <= d.range && inBounds(state.map, x, y);
    res.units = state.units.filter((o) => seen(o) && res.tiles.some(([tx, ty]) => tx === o.x && ty === o.y))
      .map((o) => ({ id: o.id, ally: o.team === u.team, dmg: d.dmg }));
  } else {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return { ...res, valid: false };
    res.tiles = [[x, y]];
    res.valid = res.valid && streakTargets(state, u, key).has(y * state.map.size + x);
    if (key === 'sentry') res.radius = d.reach;
  }
  return res;
}

function careCrate(state, x, y) {
  const crate = { id: state.crates.length + (state.drops?.length || 0), x, y, type: 'care', taken: false, dropped: true };
  if (nextRoll(state) < STREAKS.care.legendaryChance) {
    crate.weapon = LEGENDARY_KEYS[Math.floor(nextRoll(state) * LEGENDARY_KEYS.length)];
  } else {
    const atts = Object.keys(ATTACHMENTS);
    crate.attachment = atts[Math.floor(nextRoll(state) * atts.length)];
  }
  return crate;
}

/**
 * Call a streak in. action = {type:'streak', key, x?, y?, x2?, y2?}.
 * Returns {events} or {error}.
 */
export function actStreak(state, u, action) {
  const key = action.key;
  const d = STREAKS[key];
  if (!d || !(u.streaks || []).includes(key)) return fail('Not equipped');
  const info = streakInfo(state, u).find((s) => s.key === key);
  if (!info.ready) return fail(info.reason);
  const { x, y, x2, y2 } = action;
  const events = [];
  const use = () => {
    u.streakUsed = { ...(u.streakUsed || {}), [key]: true };
    u.streakCalled = true;
    events.push({ type: 'streak_used', id: u.id, key });
  };
  switch (key) {
    case 'uav': {
      use();
      const ids = state.units.filter((o) => o.alive && o.team !== u.team && dist(o.x, o.y, u.x, u.y) <= d.radius
        && !hiddenFromIntel(state, o)).map((o) => o.id);
      state.reveals.push({ team: u.team, kind: 'uav', x: u.x, y: u.y, radius: d.radius, ids });
      events.push({ type: 'uav', team: u.team, id: u.id, x: u.x, y: u.y, r: d.radius, revealed: [...ids] });
      break;
    }
    case 'cuav': {
      use();
      state.cuav.push({ team: u.team, untilRound: state.round + d.rounds });
      // Live enemy intel on this squad goes dark right away.
      for (const r of state.reveals) {
        if (r.team !== u.team && (r.kind === 'uav' || r.kind === 'scan' || !r.kind)) {
          r.ids = r.ids.filter((id) => state.units[id].team !== u.team);
        }
      }
      events.push({ type: 'cuav', team: u.team, id: u.id, until: state.round + d.rounds });
      break;
    }
    case 'care': {
      if (!Number.isInteger(x) || !Number.isInteger(y) || !streakTargets(state, u, key).has(y * state.map.size + x)) return fail('Bad target');
      use();
      const crate = careCrate(state, x, y);
      state.drops.push({ x, y, crate, team: u.team });
      events.push({ type: 'care_package_called', id: u.id, x, y });
      break;
    }
    case 'airstrike': {
      if (!Number.isInteger(x) || !Number.isInteger(y) || !inBounds(state.map, x, y) || dist(u.x, u.y, x, y) > d.range) return fail('Bad target');
      use();
      const tiles = airstrikeLine(state, x, y, x2, y2);
      const strike = { id: state.nextStreakId++, team: u.team, owner: u.id, tiles, round: state.round + 1 };
      state.airstrikes.push(strike);
      events.push({ type: 'airstrike_mark', id: strike.id, owner: u.id, tiles: tiles.map((t) => [...t]), round: strike.round });
      break;
    }
    case 'sentry': {
      if (!Number.isInteger(x) || !Number.isInteger(y) || !streakTargets(state, u, key).has(y * state.map.size + x)) return fail('Bad target');
      use();
      let dir = [x - u.x, y - u.y];
      if (Number.isInteger(x2) && Number.isInteger(y2) && (x2 !== x || y2 !== y)) dir = [x2 - x, y2 - y];
      const t = {
        id: state.nextStreakId++, team: u.team, owner: u.id, x, y, hp: d.hp, dir,
        expiresRound: state.round + d.rounds, shots: d.shots,
      };
      state.sentries.push(t);
      events.push({ type: 'sentry', id: t.id, x, y, owner: u.id, team: u.team, dir: [...dir], hp: t.hp });
      break;
    }
    case 'gunship': {
      use();
      const g = { id: state.nextStreakId++, team: u.team, owner: u.id, untilRound: state.round + d.rounds - 1 };
      state.gunships.push(g);
      events.push({ type: 'gunship_start', team: u.team, id: g.id, owner: u.id, until: g.untilRound });
      break;
    }
    default:
      return fail('Unknown streak');
  }
  return { events };
}

// ---------- reactions & timers ----------

const inCone = (t, x, y) => {
  const [dx, dy] = t.dir;
  const vx = x - t.x, vy = y - t.y;
  const l1 = Math.hypot(dx, dy), l2 = Math.hypot(vx, vy);
  if (!l2) return false;
  return (dx * vx + dy * vy) / (l1 * l2) >= Math.SQRT1_2 - 1e-9; // 90° cone
};

/** Pseudo-shooter for turret / gunship fire. */
const gunOf = (team, x, y, aim, range, dmg) => ({
  id: -1, team, x, y, weapon: { aim, range, dmg, special: [] }, mods: { scope: 0, barrel: 0 }, missStreak: 0, moved: true,
});

/** Enemy sentries react to a unit stepping into their cone. Called after each step of a move. */
export function sentryReact(state, mover, events) {
  for (const t of [...(state.sentries || [])]) {
    if (t.team === mover.team || t.shots <= 0 || !standing(mover)) continue;
    if (dist(t.x, t.y, mover.x, mover.y) > STREAKS.sentry.reach || !inCone(t, mover.x, mover.y)) continue;
    if (!los(state.map, t.x, t.y, mover.x, mover.y)) continue;
    t.shots--;
    const d = STREAKS.sentry;
    const gun = gunOf(t.team, t.x, t.y, d.aim, d.reach, d.dmg);
    const { chance, cover } = hitChance(state, gun, mover);
    const r = nextRoll(state) * 100;
    const result = r < chance ? 'hit' : 'miss';
    let dmg = 0;
    if (result === 'hit') dmg = Math.max(1, d.dmg[0] + Math.floor(nextRoll(state) * (d.dmg[1] - d.dmg[0] + 1)) - mover.armor);
    const ev = { type: 'sentry_shot', id: t.id, target: mover.id, result, dmg, chance, cover, downed: false };
    events.push(ev);
    if (dmg) {
      mover.hp -= dmg;
      noteDamage(state, mover, state.units[t.owner]);
      if (mover.hp <= 0) ev.downed = dropUnit(state, mover, state.units[t.owner], events) === 'downed';
    }
    if (state.winner !== null) return;
  }
}

/** Shoot a sentry (regular shot rules: hit chance vs a 0-cover target, weapon damage). */
export function shootSentry(state, u, t, events) {
  const { chance } = hitChance(state, u, { ...t, team: t.team, armor: 0, hunkered: false });
  const r = nextRoll(state) * 100;
  const result = r < chance ? 'hit' : 'miss';
  let dmg = 0;
  if (result === 'hit') dmg = u.weapon.dmg[0] + Math.floor(nextRoll(state) * (u.weapon.dmg[1] - u.weapon.dmg[0] + 1));
  events.push({ type: 'shot_sentry', from: u.id, sentry: t.id, result, dmg, chance });
  if (dmg) {
    t.hp -= dmg;
    events.push({ type: 'sentry_damage', id: t.id, dmg, hp: Math.max(0, t.hp) });
    if (t.hp <= 0) {
      state.sentries = state.sentries.filter((s) => s !== t);
      events.push({ type: 'sentry_destroyed', id: t.id });
    }
  }
}

/** Round start: airstrikes land, Counter-UAVs and sentries time out. */
export function streaksRoundStart(state, events) {
  for (const c of state.cuav.filter((c) => c.untilRound <= state.round)) events.push({ type: 'cuav_end', team: c.team });
  state.cuav = state.cuav.filter((c) => c.untilRound > state.round);
  for (const t of state.sentries.filter((t) => t.expiresRound <= state.round)) events.push({ type: 'sentry_end', id: t.id });
  state.sentries = state.sentries.filter((t) => t.expiresRound > state.round);
  const due = state.airstrikes.filter((a) => a.round <= state.round);
  state.airstrikes = state.airstrikes.filter((a) => a.round > state.round);
  const S = state.map.size;
  for (const a of due) {
    if (state.winner !== null) return;
    events.push({ type: 'airstrike', id: a.id, tiles: a.tiles.map((t) => [...t]) });
    const owner = state.units[a.owner];
    const victims = state.units.filter((o) => o.alive && a.tiles.some(([x, y]) => o.x === x && o.y === y));
    blastDamage(state, owner, victims, STREAKS.airstrike.dmg, 'airstrike', events);
    for (const h of HOOKS.onBlast) h(state, a.tiles, STREAKS.airstrike.dmg, owner, events);
    for (const t of [...state.sentries]) {
      if (a.tiles.some(([x, y]) => t.x === x && t.y === y)) {
        state.sentries = state.sentries.filter((s) => s !== t);
        events.push({ type: 'sentry_destroyed', id: t.id });
      }
    }
    for (const [x, y] of a.tiles) {
      if (state.winner !== null) return;
      const k = y * S + x;
      if (state.map.cover[k] === 0) continue;
      if (state.map.explosive && state.map.explosive[k]) detonate(state, owner, { kind: 'barrel', x, y }, events);
      else setCover(state, x, y, 0, events);
    }
  }
}

/** Step start: called-in care packages land (on the nearest free tile). */
export function streaksStepStart(state, events) {
  if (!state.drops.length) return;
  const S = state.map.size;
  for (const d of state.drops) {
    let { x, y } = d;
    if (!tileFree(state, x, y) || state.crates.some((c) => !c.taken && c.x === x && c.y === y)) {
      let best = null;
      for (let r = 1; r < 6 && !best; r++) {
        for (let dy = -r; dy <= r && !best; dy++) for (let dx = -r; dx <= r && !best; dx++) {
          const nx = x + dx, ny = y + dy;
          if (tileFree(state, nx, ny) && !state.crates.some((c) => !c.taken && c.x === nx && c.y === ny)) best = [nx, ny];
        }
      }
      if (best) [x, y] = best;
    }
    const crate = { ...d.crate, id: state.crates.length, x, y };
    state.crates.push(crate);
    events.push({ type: 'care_package', crate: { ...crate }, team: d.team });
  }
  state.drops = [];
  void S;
}

/** A squad's turn begins: its sentries re-arm. */
export function streaksTeamStart(state, team) {
  for (const t of state.sentries) if (t.team === team) t.shots = STREAKS.sentry.shots;
}

/** A squad's turn ends: its gunship fires on up to 2 visible enemies. */
export function streaksTeamEnd(state, team, events) {
  for (const g of state.gunships.filter((g) => g.team === team)) {
    const d = STREAKS.gunship;
    const targets = state.units.filter((o) => standing(o) && o.team !== team && teamSeesUnit(state, team, o))
      .sort((a, b) => a.hp - b.hp || a.id - b.id).slice(0, d.targets);
    for (const o of targets) {
      if (state.winner !== null || !o.alive) break;
      // Overhead fire: the target's best cover from any side applies.
      const cover = Math.max(o.vehicle != null ? 1 : 0, ...tileCoverDirs(state.map, o.x, o.y));
      const chance = Math.max(5, Math.min(95, d.aim - COVER_PENALTY[cover] * (o.hunkered && cover ? HUNKER_MULT : 1)));
      const result = nextRoll(state) * 100 < chance ? 'hit' : 'miss';
      const dmg = result === 'hit' ? Math.max(1, d.dmg - o.armor) : 0;
      events.push({ type: 'gunship_shot', id: g.id, team, target: o.id, result, dmg, chance, cover });
      if (dmg) hurt(state, o, dmg, 'gunship', state.units[g.owner], events);
    }
    if (state.round >= g.untilRound) {
      state.gunships = state.gunships.filter((x) => x !== g);
      events.push({ type: 'gunship_end', team, id: g.id });
    }
  }
  void roll;
}
