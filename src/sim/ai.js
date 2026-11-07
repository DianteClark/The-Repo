// Bots play by the same rules and only know what their team can see.

import { act, moveOptions, shotPreview, insideZone } from './game.js';
import { coverVs, dist, teamSeesUnit, hitChance } from './rules.js';
import { roll } from './rng.js';

function visibleEnemies(state, u) {
  return state.units.filter((e) => e.alive && e.team !== u.team && teamSeesUnit(state, u.team, e));
}

function bestShot(state, u) {
  let best = null;
  for (const e of visibleEnemies(state, u)) {
    const p = shotPreview(state, u, e);
    if (!p) continue;
    const score = p.chance + (e.hp <= p.dmg[1] ? 15 : 0);
    if (!best || score > best.score) best = { target: e, chance: p.chance, score };
  }
  return best;
}

function chooseMove(state, u, maxCostOne = true) {
  const S = state.map.size;
  const reach = moveOptions(state, u);
  const enemies = visibleEnemies(state, u);
  const z = state.zone;
  const crates = state.crates.filter((c) => !c.taken && dist(c.x, c.y, u.x, u.y) <= 10);
  let goal = null;
  if (!enemies.length) {
    if (crates.length) {
      crates.sort((a, b) => dist(a.x, a.y, u.x, u.y) - dist(b.x, b.y, u.x, u.y));
      goal = crates[0];
    } else {
      goal = { x: z.x, y: z.y };
    }
  }
  const mates = state.units.filter((m) => m.alive && m.team === u.team && m.id !== u.id);

  let best = null;
  for (const [k, node] of reach) {
    if (maxCostOne && node.d > u.move) continue;
    const x = k % S, y = (k / S) | 0;
    let score = 0;
    const dz = dist(x, y, z.x, z.y);
    if (dz > z.next) score -= (dz - z.next) * 4;
    if (dz > z.r) score -= 40;
    if (enemies.length) {
      let nearest = enemies[0];
      for (const e of enemies) if (dist(x, y, e.x, e.y) < dist(x, y, nearest.x, nearest.y)) nearest = e;
      const cov = coverVs(state.map, x, y, nearest.x, nearest.y);
      score += cov * 10;
      if (cov === 0) score -= 8;
      // Value a good shot from the new tile.
      const ghost = { ...u, x, y };
      const d = dist(x, y, nearest.x, nearest.y);
      if (d <= u.weapon.range + u.mods.scope * 2) score += hitChance(state, ghost, nearest).chance * 0.25;
      // Keep a sensible distance for the weapon.
      const ideal = u.weapon.falloff ? 2 : u.weapon.closePenalty ? 9 : 6;
      score -= Math.abs(d - ideal) * 1.2;
    } else if (goal) {
      score -= dist(x, y, goal.x, goal.y) * 2;
      if (state.crates.some((c) => !c.taken && c.x === x && c.y === y)) score += 20;
      // Mild preference for ending next to cover.
      const covered = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        return nx >= 0 && ny >= 0 && nx < S && ny < S && state.map.cover[ny * S + nx] > 0;
      });
      if (covered) score += 3;
    }
    for (const m of mates) {
      const dm = dist(x, y, m.x, m.y);
      if (dm > 5) score -= (dm - 5) * 0.6;
    }
    score += roll(state.seed, u.id, state.round, k) * 2; // deterministic jitter
    if (!best || score > best.score) best = { x, y, score, d: node.d };
  }
  if (!best || (best.x === u.x && best.y === u.y)) return null;
  return best;
}

/** Plays one bot's whole turn. Returns the events produced. */
export function botTakeTurn(state, unitId) {
  const u = state.units[unitId];
  const events = [];
  const doAct = (a) => {
    const r = act(state, u.id, a);
    if (r.ok) events.push(...r.events);
    return r.ok;
  };
  if (!u.alive) return events;

  if (u.hp <= u.maxHp * 0.45 && u.items.medkit > 0) doAct({ type: 'medkit' });

  let shot = bestShot(state, u);
  if (u.ap > 0 && shot && shot.chance >= 55) {
    doAct({ type: 'shoot', targetId: shot.target.id });
    return events;
  }

  if (u.ap > 0) {
    const dest = chooseMove(state, u);
    if (dest) doAct({ type: 'move', x: dest.x, y: dest.y });
  }
  if (!u.alive || u.ap <= 0 || state.winner !== null) return events;

  shot = bestShot(state, u);
  if (shot && shot.chance >= 35) {
    doAct({ type: 'shoot', targetId: shot.target.id });
  } else if (!visibleEnemies(state, u).length && !insideZone(state, u.x, u.y, state.zone.next)) {
    const dest = chooseMove(state, u);
    if (dest) doAct({ type: 'move', x: dest.x, y: dest.y });
    if (u.alive && u.ap > 0) doAct({ type: 'overwatch' });
  } else if (!visibleEnemies(state, u).length && u.ap > 0 && roll(state.seed, u.id, state.round, 7) < 0.5) {
    const dest = chooseMove(state, u);
    if (dest) doAct({ type: 'move', x: dest.x, y: dest.y });
    if (u.alive && u.ap > 0) doAct({ type: 'overwatch' });
  } else {
    doAct({ type: 'overwatch' });
  }
  return events;
}
