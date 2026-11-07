// Bots play by the same rules and only know what their team can see.
// Each turn a bot looks for, in order: a squadmate to revive or patch, a heal
// it needs, a scan before advancing, a free-action explosive (grenade /
// breach) worth throwing, a shot worth taking from where it stands, a better
// tile to move to, and finally a defensive end to its turn (revive, smoke,
// shot, hunker or overwatch).

import {
  act, moveOptions, shotPreview, aimedPreview, insideZone, zoneDamage, grenadePreview, breachTargets, breachPreview,
  smokeTargets,
} from './game.js';
import { coverVs, dist, teamSeesUnit, teamSeesTile, hitChance, los, weaponRange, standing, inBounds } from './rules.js';
import { roll } from './rng.js';
import { FRAG, SCAN } from './constants.js';

/** Enemies the team can see (downed ones included: they can be finished off). */
function visibleEnemies(state, u) {
  return state.units.filter((e) => e.alive && e.team !== u.team && teamSeesUnit(state, u.team, e));
}
/** Visible enemies that can actually shoot back. */
const threats = (enemies) => enemies.filter((e) => !e.downed);
const matesOf = (state, u) => state.units.filter((m) => m.alive && m.team === u.team && m.id !== u.id);
const adjacent = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1;

// Tuning weights for move scoring.
const W_DEF = 30; // per expected incoming hit
const W_OFF = 1.5; // per expected point of damage dealt next action
const W_TRAVEL_COVER = 5; // per covered side when nobody is in sight
const T_STAY = 85; // shoot from where we stand (before moving) only above this chance
const avg = ([a, b]) => (a + b) / 2;

/** Expected value of a shot preview: expected damage plus a kill bonus. */
function shotValue(p, target) {
  // Finishing a downed enemy: any hit or graze kills, and denies the revive.
  if (target.downed) return ((p.chance + p.graze) / 100) * 7 * (target.bleed <= 1 ? 0.7 : 1);
  const hitP = p.chance / 100;
  const grazeP = p.graze / 100;
  const ev = hitP * avg(p.dmg) + grazeP * Math.ceil(avg(p.dmg) / 2);
  const killP = hitP * (p.dmg[1] >= target.hp ? (p.dmg[0] >= target.hp ? 1 : 0.5) : 0);
  return ev + killP * 6 + (target.maxHp - target.hp) * 0.15;
}

/** Best regular or aimed shot from the unit's current tile. */
function bestShot(state, u) {
  const aimedReady = u.cls === 'marksman' && u.cooldowns.aimed <= 0;
  let best = null;
  for (const e of visibleEnemies(state, u)) {
    // Don't burn the aimed-shot cooldown on a downed enemy: any hit kills it anyway.
    const useAimed = aimedReady && !e.downed;
    const p = useAimed ? aimedPreview(state, u, e) : shotPreview(state, u, e);
    if (!p) continue;
    const value = shotValue(p, e);
    if (!best || value > best.value) {
      best = {
        target: e, chance: e.downed ? p.chance + p.graze : p.chance, value,
        lethal: e.downed || p.dmg[0] >= e.hp, type: useAimed ? 'aimed' : 'shoot',
      };
    }
  }
  return best;
}

/** Score a grenade landing on (x,y). Null if not worth it at all. */
function grenadeValue(state, u, x, y, enemies) {
  const p = grenadePreview(state, u, x, y);
  if (!p.valid) return null;
  let value = 0, hits = 0, coverBroken = 0;
  for (const h of p.units) {
    if (h.ally) return null; // bots never frag their own squad (downed squadmates included)
    hits++;
    value += h.dmg + (h.lethal ? 8 : 0);
  }
  if (!hits) return null;
  // How much cover the blast strips from the enemies, as seen from the thrower.
  const S = state.map.size;
  const before = enemies.map((e) => coverVs(state.map, e.x, e.y, u.x, u.y));
  for (const c of p.cover) state.map.cover[c.y * S + c.x] = c.to;
  enemies.forEach((e, i) => {
    const after = coverVs(state.map, e.x, e.y, u.x, u.y);
    if (after < before[i]) { coverBroken += before[i] - after; value += (before[i] - after) * 2.5; if (before[i] === 2) value += 2; }
  });
  for (const c of p.cover) state.map.cover[c.y * S + c.x] = c.from;
  const fullBroken = enemies.some((e, i) => before[i] === 2 && p.units.some((h) => h.id === e.id)
    && p.cover.length && coverBroken > 0);
  const worth = hits >= 2 || fullBroken || p.units.some((h) => h.lethal) || (coverBroken > 0 && u.ap >= 2);
  return worth ? { x, y, value, hits } : null;
}

function bestGrenade(state, u, enemies) {
  if (u.items.frag < 1 || u.ap < 1 || !enemies.length) return null;
  const S = state.map.size;
  const seen = new Set();
  let best = null;
  for (const e of enemies) {
    if (dist(u.x, u.y, e.x, e.y) > FRAG.range + 1.5) continue;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = e.x + dx, y = e.y + dy;
        const k = y * S + x;
        if (seen.has(k)) continue;
        seen.add(k);
        if (dist(x, y, u.x, u.y) <= FRAG.radius + 0.5) continue; // too close to self
        const g = grenadeValue(state, u, x, y, enemies);
        if (g && (!best || g.value > best.value)) best = g;
      }
    }
  }
  return best;
}

function bestBreach(state, u) {
  let best = null;
  for (const k of breachTargets(state, u)) {
    const S = state.map.size;
    const x = k % S, y = (k / S) | 0;
    const p = breachPreview(state, u, x, y);
    if (!p.units.length) continue;
    const value = p.units.reduce((s, h) => s + h.dmg + (h.lethal ? 8 : 0), 0);
    if (!best || value > best.value) best = { x, y, value };
  }
  return best;
}

/** Expected incoming fire if `u` stood on (x,y): sum of visible enemies' hit chances. */
function threatAt(state, u, x, y, enemies, hunker = false) {
  const ghost = { ...u, x, y, hunkered: hunker };
  let t = 0;
  for (const e of enemies) {
    if (e.downed) continue;
    const d = dist(e.x, e.y, x, y);
    if (d > weaponRange(e) + e.move * 0.5) continue;
    if (!los(state.map, e.x, e.y, x, y)) continue;
    // Enemies can reposition, so treat "just out of range" as a lesser threat.
    const c = d <= weaponRange(e) ? hitChance(state, e, ghost).chance : 25;
    t += c / 100;
  }
  return t;
}

function chooseMove(state, u, { costOne = true, defensive = false } = {}) {
  const S = state.map.size;
  const reach = moveOptions(state, u);
  const enemies = visibleEnemies(state, u);
  const z = state.zone;
  const crates = state.crates.filter((c) => !c.taken && dist(c.x, c.y, u.x, u.y) <= 10 && insideZone(state, c.x, c.y, z.r));
  const aimedReady = u.cls === 'marksman' && u.cooldowns.aimed <= 0;
  const breachReady = u.cls === 'breacher' && u.cooldowns.breach <= 0;
  let goal = null;
  if (!enemies.length) {
    if (crates.length) {
      crates.sort((a, b) => dist(a.x, a.y, u.x, u.y) - dist(b.x, b.y, u.x, u.y));
      goal = crates[0];
    } else {
      goal = { x: z.x, y: z.y };
    }
  }
  const mates = matesOf(state, u);
  const near = threats(enemies).filter((e) => dist(e.x, e.y, u.x, u.y) <= weaponRange(u) + u.move * 2 + 2);
  // Downed squadmates (and, for medics, badly hurt ones) pull the bot towards them.
  // A downed mate out in the tide is already lost.
  const needy = mates.filter((m) => (m.downed && insideZone(state, m.x, m.y))
    || (u.cls === 'medic' && u.cooldowns.patch <= 1 && m.hp <= m.maxHp * 0.6));

  let best = null;
  for (const [k, node] of reach) {
    if (costOne && node.d > u.move) continue;
    const x = k % S, y = (k / S) | 0;
    let score = 0;
    const dz = dist(x, y, z.x, z.y);
    if (dz > z.next) score -= (dz - z.next) * 4;
    if (dz > z.r) score -= 40 + (dz - z.r) * 6 + (u.hp <= zoneDamage(state) ? 200 : 0);
    if (near.length) {
      // Defense: incoming expected hits from everyone who can see this tile.
      const threat = threatAt(state, u, x, y, near);
      score -= threat * (defensive ? 30 : W_DEF);
      // Offense: the best shot available from here next action.
      const ghost = { ...u, x, y };
      let off = 0;
      for (const e of near) {
        const d = dist(x, y, e.x, e.y);
        if (d > weaponRange(u) || !los(state.map, x, y, e.x, e.y)) continue;
        const hc = hitChance(state, ghost, e, { ability: aimedReady ? 'aimed' : undefined });
        const [mn, mx] = u.weapon.dmg;
        const v = (hc.chance / 100) * ((mn + mx) / 2 + u.mods.barrel) + (hc.flank ? 1.5 : 0)
          + (hc.chance >= 50 && mx + u.mods.barrel - e.armor >= e.hp ? 4 : 0);
        if (v > off) off = v;
      }
      score += off * (defensive ? 1.2 : W_OFF);
      // Breachers like standing next to the wall an enemy hides behind.
      if (breachReady && u.ap >= 2) {
        for (const e of near) {
          if (Math.max(Math.abs(e.x - x), Math.abs(e.y - y)) > 2) continue;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const cx = x + dx, cy = y + dy;
            if ((dx || dy) && state.map.cover[cy * S + cx] > 0
              && Math.max(Math.abs(e.x - cx), Math.abs(e.y - cy)) <= 1) score += 3;
          }
        }
      }
      // Keep a sensible distance for the weapon.
      let nearest = near[0];
      for (const e of near) if (dist(x, y, e.x, e.y) < dist(x, y, nearest.x, nearest.y)) nearest = e;
      const d = dist(x, y, nearest.x, nearest.y);
      const ideal = u.weapon.falloff ? 2.5 : u.weapon.closePenalty ? 9 : 6;
      score -= Math.abs(d - ideal) * (defensive ? 0.3 : 0.7);
      if (defensive) score += Math.min(d, 12) * 0.5;
    } else if (goal) {
      score -= dist(x, y, goal.x, goal.y) * 2;
      if (state.crates.some((c) => !c.taken && c.x === x && c.y === y)) score += 20;
      // Nobody in sight, but somebody always is: end the move tucked into cover.
      let sides = 0, full = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
        const c = state.map.cover[ny * S + nx];
        if (c > 0) sides++;
        if (c === 2) full++;
      }
      score += Math.min(sides, 2) * W_TRAVEL_COVER + full * 1.5;
    }
    if (near.length && state.crates.some((c) => !c.taken && c.x === x && c.y === y)) score += c8(state, x, y);
    for (const m of needy) {
      const reach = Math.max(Math.abs(m.x - x), Math.abs(m.y - y));
      const w = m.downed ? (m.bleed <= 1 ? 30 : 22) : 10;
      if (reach <= 1) score += w;
      else score -= Math.min(reach, 12) * (m.downed ? 1.5 : 0.5);
    }
    for (const m of mates) {
      const dm = dist(x, y, m.x, m.y);
      if (dm > 5) score -= (dm - 5) * 0.6;
      if (dm < 1.5) score -= 1.5; // don't bunch up for grenades
    }
    score += roll(state.seed, u.id, state.round, k) * 2; // deterministic jitter
    if (!best || score > best.score) best = { x, y, score, d: node.d };
  }
  if (!best || (best.x === u.x && best.y === u.y)) return null;
  return best;
}

// Crates are still worth grabbing mid-fight; caches especially.
const c8 = (state, x, y) => (state.crates.some((c) => !c.taken && c.x === x && c.y === y && c.type === 'cache') ? 10 : 4);

/** Would this unit be shot at where it stands? */
function exposed(state, u, enemies) {
  return threatAt(state, u, u.x, u.y, enemies) >= 0.15;
}

/** Revive or patch an adjacent downed squadmate when it's safe enough (or now-or-never). */
function tryRevive(state, u, enemies, doAct) {
  const downed = matesOf(state, u).filter((m) => m.downed && adjacent(u, m));
  if (!downed.length) return false;
  downed.sort((a, b) => a.bleed - b.bleed);
  const m = downed[0];
  const danger = threatAt(state, u, u.x, u.y, threats(enemies));
  if (danger > 1.1 && m.bleed > 1 && u.hp <= u.maxHp * 0.4) return false; // too hot; try next turn
  if (u.cls === 'medic' && u.cooldowns.patch <= 0 && doAct({ type: 'patch', targetId: m.id })) return true;
  return doAct({ type: 'revive', targetId: m.id });
}

/** Medic: patch self or an adjacent squadmate that's hurt. */
function tryPatch(state, u, doAct) {
  if (u.cls !== 'medic' || u.cooldowns.patch > 0) return false;
  const cands = [u, ...matesOf(state, u).filter((m) => !m.downed && adjacent(u, m))]
    .filter((m) => m.hp <= m.maxHp - 4 || m.hp <= m.maxHp * 0.6);
  if (!cands.length) return false;
  cands.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);
  return doAct({ type: 'patch', targetId: cands[0].id });
}

/** Recon: scan ahead (towards the zone, or where unseen ground is) before advancing. */
function tryScan(state, u, enemies, doAct) {
  if (u.cls !== 'recon' || u.cooldowns.scan > 0 || u.ap < 2) return false;
  if (threats(enemies).length >= 1) return false; // already in a fight: shoot instead
  const S = state.map.size;
  const z = state.zone;
  let best = null;
  for (let i = 0; i < 9; i++) {
    let x, y;
    if (i === 8) {
      const d = dist(u.x, u.y, z.x, z.y) || 1;
      const k = Math.min(1, 9 / d);
      x = Math.round(u.x + (z.x - u.x) * k); y = Math.round(u.y + (z.y - u.y) * k);
    } else {
      const a = (i / 8) * Math.PI * 2;
      x = Math.round(u.x + Math.cos(a) * 9); y = Math.round(u.y + Math.sin(a) * 9);
    }
    x = Math.max(0, Math.min(S - 1, x)); y = Math.max(0, Math.min(S - 1, y));
    // Count unseen ground in the scan, sampled on a coarse grid; prefer the safe zone.
    let unseen = 0;
    for (let dy = -4; dy <= 4; dy += 2) {
      for (let dx = -4; dx <= 4; dx += 2) {
        const sx = x + dx, sy = y + dy;
        if (!inBounds(state.map, sx, sy) || Math.hypot(dx, dy) > SCAN.radius) continue;
        if (!insideZone(state, sx, sy, z.r)) continue;
        if (!teamSeesTile(state, u.team, sx, sy)) unseen++;
      }
    }
    const score = unseen + (i === 8 ? 2 : 0) + roll(state.seed, u.id, state.round, i, 31);
    if (unseen >= 3 && (!best || score > best.score)) best = { x, y, score };
  }
  return !!best && doAct({ type: 'scan', x: best.x, y: best.y });
}

/** Smoke over self or a squadmate that is hurt (or downed) and under fire. */
function trySmoke(state, u, enemies, doAct) {
  if (!u.items.smoke || u.ap < 1) return false;
  const foes = threats(enemies);
  if (!foes.length) return false;
  const S = state.map.size;
  const targets = smokeTargets(state, u);
  let best = null;
  for (const m of [u, ...matesOf(state, u)]) {
    if (!(m.downed || m.hp <= m.maxHp * 0.6 || m.id === u.id)) continue;
    if (state.smokes.some((c) => dist(c.x, c.y, m.x, m.y) <= c.radius)) continue;
    if (!targets.has(m.y * S + m.x)) continue;
    const t = m.downed
      ? foes.filter((e) => dist(e.x, e.y, m.x, m.y) <= weaponRange(e) + 2).length * 0.5
      : threatAt(state, m, m.x, m.y, foes);
    if (t < (m.id === u.id && m.hp > m.maxHp * 0.6 ? 0.6 : 0.3)) continue;
    const value = t + (m.downed ? 0.6 : 0) + (m.id === u.id ? 0.2 : 0);
    if (!best || value > best.value) best = { x: m.x, y: m.y, value };
  }
  return !!best && doAct({ type: 'smoke', x: best.x, y: best.y });
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
  if (!standing(u) || state.winner !== null) return events;

  let moved = 0;
  for (let step = 0; step < 8 && standing(u) && u.ap > 0 && state.winner === null; step++) {
    const enemies = visibleEnemies(state, u);
    const foes = threats(enemies);
    const lowHp = u.hp <= u.maxHp * 0.4;
    const shot = bestShot(state, u);
    const killShot = shot && shot.lethal && shot.chance >= 50;
    const inTide = !insideZone(state, u.x, u.y);

    // 1. Squadmates first: revive the downed, patch the hurt.
    if (tryRevive(state, u, enemies, doAct)) continue;
    if (!killShot && tryPatch(state, u, doAct)) continue;

    // 2. Patch up if hurt and nothing can be killed right now.
    if (u.hp <= u.maxHp * 0.5 && u.items.medkit > 0 && u.hp < u.maxHp && !killShot
      && !(u.cls === 'medic' && u.cooldowns.patch <= 0)) {
      if (doAct({ type: 'medkit' })) continue;
    }

    // 3. Recon looks before it leaps.
    if (!moved && tryScan(state, u, enemies, doAct)) continue;

    // 4. Explosives cost 1 AP and don't end the turn, so they come before the shot.
    const breach = u.cls === 'breacher' ? bestBreach(state, u) : null;
    if (breach && doAct({ type: 'breach', x: breach.x, y: breach.y })) continue;
    const nade = bestGrenade(state, u, enemies);
    if (nade && (!shot || nade.value >= shot.value * 0.8 || nade.hits >= 2 || u.ap >= 2)) {
      if (doAct({ type: 'grenade', x: nade.x, y: nade.y })) continue;
    }

    // 5. Take a good shot from here; after moving, accept a lesser one.
    const canStillMove = !moved && u.ap >= 1;
    // Before moving only take sure things: repositioning into cover first is usually better.
    const threshold = canStillMove ? (shot && shot.lethal ? 55 : T_STAY) : 30;
    if (shot && shot.chance >= threshold && !(inTide && canStillMove && !killShot)) {
      doAct({ type: shot.type, targetId: shot.target.id });
      break;
    }

    // 6. Reposition. With enemies around keep 1 AP to act; otherwise travel.
    if (moved < 2 && u.ap >= 1) {
      const fighting = foes.length > 0;
      const downedMate = matesOf(state, u).some((m) => m.downed);
      const travel = !fighting && (moved === 0 || !insideZone(state, u.x, u.y, state.zone.next));
      if (inTide || (fighting || downedMate ? moved === 0 : travel)) {
        const dest = chooseMove(state, u, {
          // Caught in the tide: dash for dry ground even mid-fight.
          costOne: inTide ? false : fighting || downedMate || u.ap >= 2,
          defensive: lowHp && !(shot && shot.chance >= 50),
        });
        if (dest && doAct({ type: 'move', x: dest.x, y: dest.y })) { moved++; continue; }
      }
    }

    // 7. End of turn.
    if (tryRevive(state, u, enemies, doAct)) continue;
    if (u.ap >= 1 && !(shot && shot.chance >= 55) && trySmoke(state, u, enemies, doAct)) continue;
    const goodShot = shot && (shot.chance >= 50 || (shot.lethal && shot.chance >= 35));
    if (foes.length && lowHp && !goodShot && exposed(state, u, foes)
      && threatAt(state, u, u.x, u.y, foes, true) < threatAt(state, u, u.x, u.y, foes) - 0.1) {
      doAct({ type: 'hunker' });
    } else if (shot && shot.chance >= 25) {
      doAct({ type: shot.type, targetId: shot.target.id });
    } else {
      doAct({ type: 'overwatch' });
    }
    break;
  }
  return events;
}
