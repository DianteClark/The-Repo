import {
  SIGHT, COVER_PENALTY, FLANK_BONUS, MISS_STREAK_BONUS, REACTION_PENALTY,
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

export function canSeeTile(map, ux, uy, x, y) {
  return dist(ux, uy, x, y) <= SIGHT && los(map, ux, uy, x, y);
}

/** Does any living member of `team` see the given tile? */
export function teamSeesTile(state, team, x, y) {
  for (const u of state.units) {
    if (u.alive && u.team === team && canSeeTile(state.map, u.x, u.y, x, y)) return true;
  }
  return false;
}

export function teamSeesUnit(state, team, target) {
  if (target.team === team) return true;
  return teamSeesTile(state, team, target.x, target.y);
}

export function weaponRange(u) {
  return u.weapon.range + u.mods.scope * 2;
}

export function inRangeAndLos(state, shooter, target) {
  return dist(shooter.x, shooter.y, target.x, target.y) <= weaponRange(shooter)
    && los(state.map, shooter.x, shooter.y, target.x, target.y);
}

/** Hit chance as an integer percentage, plus a breakdown for the UI. */
export function hitChance(state, shooter, target, { reaction = false } = {}) {
  const d = dist(shooter.x, shooter.y, target.x, target.y);
  const range = weaponRange(shooter);
  if (d > range) return { chance: 0, cover: 0, notes: ['Out of range'] };
  const w = shooter.weapon;
  const notes = [];
  let aim = w.aim + shooter.mods.scope * 5;
  const cover = coverVs(state.map, target.x, target.y, shooter.x, shooter.y);
  aim -= COVER_PENALTY[cover];
  if (cover === 0) { aim += FLANK_BONUS; notes.push('Flanked +' + FLANK_BONUS); }
  else notes.push((cover === 2 ? 'Full' : 'Half') + ' cover -' + COVER_PENALTY[cover]);
  if (w.falloff) {
    const p = Math.max(0, Math.round(d) - 2) * 7;
    if (p) { aim -= p; notes.push('Shotgun falloff -' + p); }
  }
  if (w.closePenalty && d < 4) { aim -= 15; notes.push('Too close -15'); }
  const longP = Math.max(0, Math.round((d - range * 0.6) * 2));
  if (longP) { aim -= longP; notes.push('Long range -' + longP); }
  if (shooter.missStreak) {
    const b = shooter.missStreak * MISS_STREAK_BONUS;
    aim += b; notes.push('Miss streak +' + b);
  }
  if (reaction) { aim -= REACTION_PENALTY; notes.push('Reaction -' + REACTION_PENALTY); }
  const chance = Math.max(5, Math.min(95, Math.round(aim)));
  return { chance, cover, notes };
}

/** BFS over 8 directions without cutting corners. Returns Map<tileKey, {d, prev}>. */
export function reachable(state, u, maxSteps) {
  const { map } = state;
  const S = map.size;
  const occ = new Set();
  for (const o of state.units) if (o.alive && o.id !== u.id) occ.add(o.y * S + o.x);
  const start = u.y * S + u.x;
  const res = new Map([[start, { d: 0, prev: -1 }]]);
  let frontier = [start];
  for (let d = 1; d <= maxSteps && frontier.length; d++) {
    const next = [];
    for (const k of frontier) {
      const x = k % S, y = (k / S) | 0;
      for (const [dx, dy] of DIRS8) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(map, nx, ny)) continue;
        const nk = ny * S + nx;
        if (res.has(nk) || map.cover[nk] > 0 || occ.has(nk)) continue;
        if (dx && dy && (map.cover[y * S + nx] > 0 || map.cover[ny * S + x] > 0)) continue;
        res.set(nk, { d, prev: k });
        next.push(nk);
      }
    }
    frontier = next;
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
