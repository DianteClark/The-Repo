import {
  SIGHT, COVER_PENALTY, FLANK_BONUS, MISS_STREAK_BONUS, REACTION_PENALTY, HUNKER_MULT, AIMED, SMOKE, KELP,
} from './constants.js';

export const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export const inBounds = (map, x, y) => x >= 0 && y >= 0 && x < map.size && y < map.size;
export const coverAt = (map, x, y) => (inBounds(map, x, y) ? map.cover[y * map.size + x] : 2);
export const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/** Straight line of sight; only full cover (walls) blocks it. */
export function losDirect(map, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const steps = Math.max(Math.abs(dx), Math.abs(dy)) * 3;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = Math.round(ax + dx * t);
    const y = Math.round(ay + dy * t);
    if ((x === ax && y === ay) || (x === bx && y === by)) continue;
    if (coverAt(map, x, y) === 2) return false;
  }
  return true;
}

/**
 * XCOM-style line of sight with "step out": a unit hugging a wall can lean
 * out to an adjacent open tile, and so can the target.
 */
export function los(map, ax, ay, bx, by) {
  if (losDirect(map, ax, ay, bx, by)) return true;
  const outs = (x, y) => [[x, y], ...DIRS4.map(([dx, dy]) => [x + dx, y + dy]).filter(([nx, ny]) => coverAt(map, nx, ny) === 0)];
  for (const [sx, sy] of outs(ax, ay)) {
    for (const [tx, ty] of outs(bx, by)) {
      if (sx === ax && sy === ay && tx === bx && ty === by) continue;
      if (losDirect(map, sx, sy, tx, ty)) return true;
    }
  }
  return false;
}

/** Cover the tile (tx,ty) gets against an attacker at (ax,ay): 0, 1 or 2. */
export function coverVs(map, tx, ty, ax, ay) {
  const ddx = ax - tx, ddy = ay - ty;
  let best = 0;
  const useX = ddx !== 0 && Math.abs(ddx) * 2 >= Math.abs(ddy);
  const useY = ddy !== 0 && Math.abs(ddy) * 2 >= Math.abs(ddx);
  if (useX) {
    const x = tx + Math.sign(ddx);
    if (inBounds(map, x, ty)) best = Math.max(best, map.cover[ty * map.size + x]);
  }
  if (useY) {
    const y = ty + Math.sign(ddy);
    if (inBounds(map, tx, y)) best = Math.max(best, map.cover[y * map.size + tx]);
  }
  return best;
}

/** Best cover this tile offers from any direction (for UI shields). */
export function tileCoverDirs(map, x, y) {
  return DIRS4.map(([dx, dy]) => (inBounds(map, x + dx, y + dy) ? map.cover[(y + dy) * map.size + x + dx] : 0));
}

/** Sight radius on this map (night stages see less). */
export const sightOf = (map) => map.sight ?? SIGHT;

export function canSeeTile(map, ux, uy, x, y) {
  return dist(ux, uy, x, y) <= sightOf(map) && los(map, ux, uy, x, y);
}

export const terrainAt = (map, x, y) => (map.terrain && inBounds(map, x, y) ? map.terrain[y * map.size + x] : 0);
export const isKelp = (map, x, y) => terrainAt(map, x, y) === 1;
export const isWater = (map, x, y) => terrainAt(map, x, y) === 2;
export const isBarrel = (map, x, y) => !!(map.explosive && inBounds(map, x, y) && map.explosive[y * map.size + x]
  && map.cover[y * map.size + x] > 0);

/** Alive and not downed: can act, spot and take cover. */
export const standing = (u) => u.alive && !u.downed;

/** Does any standing member of `team` see the given tile? (Downed units don't spot.) */
export function teamSeesTile(state, team, x, y) {
  for (const u of state.units) {
    if (u.team === team && standing(u) && canSeeTile(state.map, u.x, u.y, x, y)) return true;
  }
  return false;
}

/** Is the unit tagged by an active Recon scan of `team`? */
export function revealedTo(state, team, target) {
  if (!state.reveals) return false;
  for (const r of state.reveals) if (r.team === team && r.ids.includes(target.id)) return true;
  return false;
}

/** Has this unit fired at night and lit itself up for everyone? */
export function isFlared(state, u) {
  return !!state.flares && state.flares.some((f) => f.id === u.id);
}

/**
 * How close an enemy must be to see a unit standing at (x,y):
 * smoke 1.5, kelp 3, otherwise unlimited (normal sight). { range, by:'smoke'|'kelp'|null }
 */
export function concealment(state, x, y) {
  if (smokeAt(state, x, y)) return { range: SMOKE.reveal, by: 'smoke' };
  if (isKelp(state.map, x, y)) return { range: KELP.reveal, by: 'kelp' };
  return { range: Infinity, by: null };
}

/**
 * Can `team` see `target`? Squadmates always; scans and flares reveal through
 * anything; otherwise a standing teammate needs sight + line of sight, and must
 * be close if the target is in smoke (1.5) or kelp (3).
 */
export function teamSeesUnit(state, team, target) {
  if (target.team === team) return true;
  if (revealedTo(state, team, target) || isFlared(state, target)) return true;
  const { range } = concealment(state, target.x, target.y);
  if (range === Infinity) return teamSeesTile(state, team, target.x, target.y);
  for (const u of state.units) {
    if (u.team !== team || !standing(u)) continue;
    if (dist(u.x, u.y, target.x, target.y) <= range && canSeeTile(state.map, u.x, u.y, target.x, target.y)) return true;
  }
  return false;
}

/** The smoke cloud covering (x,y), if any. */
export function smokeAt(state, x, y) {
  if (!state.smokes) return null;
  for (const c of state.smokes) if (dist(c.x, c.y, x, y) <= c.radius) return c;
  return null;
}

export function weaponRange(u) {
  return u.weapon.range + u.mods.scope * 2;
}

export function inRangeAndLos(state, shooter, target) {
  return dist(shooter.x, shooter.y, target.x, target.y) <= weaponRange(shooter)
    && los(state.map, shooter.x, shooter.y, target.x, target.y);
}

/** Is the target in cover from some direction, but not against this attacker? */
export function isFlanked(map, tx, ty, ax, ay) {
  if (coverVs(map, tx, ty, ax, ay) > 0) return false;
  return tileCoverDirs(map, tx, ty).some((c) => c > 0);
}

/**
 * Hit chance as an integer percentage, plus a breakdown for the UI.
 * opts.reaction: overwatch shot. opts.ability: 'aimed' for the Marksman's aimed shot.
 * Returns { chance, cover, flank, hunkered, smoke, kelp, notes }.
 */
export function hitChance(state, shooter, target, { reaction = false, ability } = {}) {
  const d = dist(shooter.x, shooter.y, target.x, target.y);
  const range = weaponRange(shooter);
  if (d > range) return { chance: 0, cover: 0, flank: false, hunkered: false, smoke: false, kelp: false, notes: ['Out of range'] };
  const w = shooter.weapon;
  const notes = [];
  let aim = w.aim + shooter.mods.scope * 5;
  if (shooter.mods.scope) notes.push('Scope +' + shooter.mods.scope * 5);
  const cover = coverVs(state.map, target.x, target.y, shooter.x, shooter.y);
  const flank = cover === 0 && isFlanked(state.map, target.x, target.y, shooter.x, shooter.y);
  const hunkered = !!target.hunkered && cover > 0;
  if (cover) {
    const p = COVER_PENALTY[cover] * (hunkered ? HUNKER_MULT : 1);
    aim -= p;
    notes.push((cover === 2 ? 'Full' : 'Half') + ' cover' + (hunkered ? ' (hunkered)' : '') + ' -' + p);
  } else if (flank) { aim += FLANK_BONUS; notes.push('Flanked +' + FLANK_BONUS); }
  else notes.push('Exposed');
  if (w.falloff) {
    const p = Math.max(0, Math.round(d) - 2) * 7;
    if (p) { aim -= p; notes.push('Shotgun falloff -' + p); }
  }
  if (w.closePenalty && d < 4) { aim -= 15; notes.push('Too close -15'); }
  const longP = Math.max(0, Math.round((d - range * 0.6) * 2));
  if (longP) { aim -= longP; notes.push('Long range -' + longP); }
  const tSmoke = !!smokeAt(state, target.x, target.y);
  if (tSmoke) { aim -= SMOKE.aimIn; notes.push('Target in smoke -' + SMOKE.aimIn); }
  if (smokeAt(state, shooter.x, shooter.y)) { aim -= SMOKE.aimOut; notes.push('Firing from smoke -' + SMOKE.aimOut); }
  const kelp = isKelp(state.map, target.x, target.y);
  if (kelp) { aim -= KELP.aim; notes.push('Kelp -' + KELP.aim); }
  if (shooter.missStreak) {
    const b = shooter.missStreak * MISS_STREAK_BONUS;
    aim += b; notes.push('Miss streak +' + b);
  }
  if (ability === 'aimed') { aim += AIMED.aim; notes.push('Aimed +' + AIMED.aim); }
  if (reaction) { aim -= REACTION_PENALTY; notes.push('Reaction -' + REACTION_PENALTY); }
  const chance = Math.max(5, Math.min(95, Math.round(aim)));
  return { chance, cover, flank, hunkered, smoke: tSmoke, kelp, notes };
}

/** Movement cost of stepping onto a tile: shallow water costs 2, everything else 1. */
export const stepCost = (map, k) => (map.terrain && map.terrain[k] === 2 ? 2 : 1);

/**
 * Cheapest paths over 8 directions without cutting corners, up to `maxSteps`
 * movement. Returns Map<tileKey, {d, prev}> where d is the movement spent.
 */
export function reachable(state, u, maxSteps) {
  const { map } = state;
  const S = map.size;
  const occ = new Set();
  for (const o of state.units) if (o.alive && o.id !== u.id) occ.add(o.y * S + o.x);
  const start = u.y * S + u.x;
  const res = new Map([[start, { d: 0, prev: -1 }]]);
  // Bucket queue: costs are small integers.
  const buckets = [[start]];
  for (let d = 0; d <= maxSteps; d++) {
    const list = buckets[d];
    if (!list) continue;
    for (const k of list) {
      if (res.get(k).d !== d) continue; // stale entry
      const x = k % S, y = (k / S) | 0;
      for (const [dx, dy] of DIRS8) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(map, nx, ny)) continue;
        const nk = ny * S + nx;
        if (map.cover[nk] > 0 || occ.has(nk)) continue;
        if (dx && dy && (map.cover[y * S + nx] > 0 || map.cover[ny * S + x] > 0)) continue;
        const nd = d + stepCost(map, nk);
        if (nd > maxSteps) continue;
        const prev = res.get(nk);
        if (prev && prev.d <= nd) continue;
        res.set(nk, { d: nd, prev: k });
        (buckets[nd] ||= []).push(nk);
      }
    }
  }
  return res;
}

export function pathTo(reach, S, key) {
  const path = [];
  let k = key;
  while (k !== -1 && reach.has(k)) {
    path.push([k % S, (k / S) | 0]);
    k = reach.get(k).prev;
  }
  return path.reverse();
}
