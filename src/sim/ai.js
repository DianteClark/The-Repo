// Bots play by the same rules and only know what their team can see.
// Each turn a bot looks for, in order: a squadmate to revive or patch, a heal
// it needs, a scan before advancing, a free-action explosive (grenade /
// breach) worth throwing, a shot worth taking from where it stands, a better
// tile to move to, and finally a defensive end to its turn (revive, smoke,
// shot, hunker or overwatch).

import {
  act, moveOptions, shotPreview, aimedPreview, insideZone, insideNextZone, zoneDamage, grenadePreview, breachTargets, breachPreview,
  barrelTargets, barrelPreview,
  smokeTargets, equipmentPreview, equipmentTargets, launchPreview, deployCoverTargets, suppressPreview,
  streakInfo, streakPreview, streakTargets,
  dangerTiles, vehicleOf, driverOf, boardError, boatReach, repairTargets,
} from './game.js';
import {
  coverVs, dist, teamSeesUnit, teamSeesTile, hitChance, los, weaponRange, standing, inBounds,
  concealment, isFlared, isKelp, sightOf, smokeAt, moveOf, DIRS8,
} from './rules.js';
import { roll } from './rng.js';
import { FRAG, SCAN, SUPPRESS } from './constants.js';
import { EQUIPMENT, STREAKS, hasSpecial } from './weapons.js';
import { hasAmmo } from './core.js';
import { hasPerk } from './loadout.js';

/** Enemies the team can see (downed ones included: they can be finished off). */
function visibleEnemies(state, u) {
  return state.units.filter((e) => e.alive && e.team !== u.team && teamSeesUnit(state, u.team, e));
}
/** Visible enemies that can actually shoot back. */
const threats = (enemies) => enemies.filter((e) => !e.downed);
const matesOf = (state, u) => state.units.filter((m) => m.alive && m.team === u.team && m.id !== u.id);
const adjacent = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1;
const chebyshev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

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
  if (!hasAmmo(u) || hasSpecial(u.weapon, 'explosive')) return null;
  const aimedReady = u.cls === 'marksman' && u.cooldowns.aimed <= 0;
  let best = null;
  for (const e of visibleEnemies(state, u)) {
    // Don't burn the aimed-shot cooldown on a downed enemy: any hit kills it anyway.
    const useAimed = aimedReady && !e.downed;
    const p = useAimed ? aimedPreview(state, u, e) : shotPreview(state, u, e);
    if (!p) continue;
    // Somebody who just fired at night is a known, live threat: punish it.
    const value = shotValue(p, e) * (p.burst ? 1.7 : 1) + (isFlared(state, e) ? 1 : 0);
    if (!best || value > best.value) {
      best = {
        target: e, chance: e.downed ? p.chance + p.graze : p.chance, value,
        lethal: e.downed || p.dmg[0] >= e.hp, type: useAimed ? 'aimed' : 'shoot',
      };
    }
  }
  return best;
}

/** Score a grenade (frag / semtex / rocket) landing on (x,y). Null if not worth it at all. */
function grenadeValue(state, u, x, y, enemies, key = 'frag') {
  const p = key === 'rocket' ? launchPreview(state, u, x, y) : key === 'frag' ? grenadePreview(state, u, x, y) : equipmentPreview(state, u, key, x, y);
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
  for (let i = p.cover.length - 1; i >= 0; i--) state.map.cover[p.cover[i].y * S + p.cover[i].x] = p.cover[i].from;
  const fullBroken = enemies.some((e, i) => before[i] === 2 && p.units.some((h) => h.id === e.id)
    && p.cover.length && coverBroken > 0);
  const worth = hits >= 2 || fullBroken || p.units.some((h) => h.lethal) || (coverBroken > 0 && u.ap >= 2);
  return worth ? { x, y, value, hits } : null;
}

function bestGrenade(state, u, enemies, key = 'frag') {
  if (key !== 'rocket' && ((u.items[key] || 0) < 1 || u.ap < 1)) return null;
  if (!enemies.length) return null;
  const reach = key === 'rocket' ? weaponRange(u) : FRAG.range;
  const S = state.map.size;
  const seen = new Set();
  let best = null;
  for (const e of enemies) {
    if (dist(u.x, u.y, e.x, e.y) > reach + 1.5) continue;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = e.x + dx, y = e.y + dy;
        const k = y * S + x;
        if (seen.has(k)) continue;
        seen.add(k);
        if (dist(x, y, u.x, u.y) <= FRAG.radius + 0.5) continue; // too close to self
        const g = grenadeValue(state, u, x, y, enemies, key);
        if (g && (!best || g.value > best.value)) best = g;
      }
    }
  }
  return best;
}

/** Best fuel drum to shoot: worth it when it catches 2+ enemies, kills, or beats the best shot. */
function bestBarrel(state, u, enemies) {
  if (u.ap < 1 || !state.map.explosive || !enemies.length) return null;
  const S = state.map.size;
  let best = null;
  for (const k of barrelTargets(state, u)) {
    const x = k % S, y = (k / S) | 0;
    if (!enemies.some((e) => dist(e.x, e.y, x, y) <= 4)) continue; // chains reach a few tiles at most
    const p = barrelPreview(state, u, x, y);
    if (p.units.some((h) => h.ally)) continue;
    const hits = p.units.length;
    if (!hits) continue;
    const value = p.units.reduce((s2, h) => s2 + h.dmg + (h.lethal ? 8 : 0), 0) + p.cover.length * 0.3;
    if (!best || value > best.value) best = { x, y, value, hits, lethal: p.units.some((h) => h.lethal) };
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

/**
 * Expected incoming fire if `u` stood on (x,y): sum of visible enemies' hit chances.
 * Smoke and kelp hide the tile from anyone further than 1.5 / 3 tiles; at night,
 * enemies beyond sight mostly can't find you unless you've lit yourself up.
 */
function threatAt(state, u, x, y, enemies, hunker = false) {
  const ghost = { ...u, x, y, hunkered: hunker };
  const hide = concealment(state, x, y).range;
  const flared = isFlared(state, u);
  const sight = sightOf(state.map);
  let t = 0;
  for (const e of enemies) {
    if (e.downed) continue;
    const d = dist(e.x, e.y, x, y);
    if (d > weaponRange(e) + e.move * 0.5) continue;
    if (!flared && d > hide + e.move * 0.25) continue;
    if (!los(state.map, e.x, e.y, x, y)) continue;
    const dark = !flared && d > sight ? 0.35 : 1;
    // Enemies can reposition, so treat "just out of range" as a lesser threat.
    const c = d <= weaponRange(e) ? hitChance(state, e, ghost).chance : 25;
    t += (c / 100) * dark;
  }
  return t;
}

function chooseMove(state, u, { costOne = true, defensive = false } = {}) {
  const S = state.map.size;
  const reach = moveOptions(state, u);
  const danger = dangerTiles(state); // telegraphed airstrikes / stage events / red tide: get out
  const aboard = u.vehicle != null;
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
      // Unseen gunfire (or a decoy) nearby and inside the coming ring: go and look.
      const heard = (state.noises || []).filter((n) => n.team !== u.team && n.round >= state.round - 1
        && dist(n.x, n.y, u.x, u.y) <= 12 && insideNextZone(state, n.x, n.y));
      heard.sort((a, b) => dist(a.x, a.y, u.x, u.y) - dist(b.x, b.y, u.x, u.y));
      goal = heard.length ? { x: heard[0].x, y: heard[0].y } : { x: z.nx ?? z.x, y: z.ny ?? z.y }; // else where the circle is going
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
    const dn = dist(x, y, z.nx ?? z.x, z.ny ?? z.y); // the next ring may sit elsewhere (drift)
    const stay = aboard && node.d === 0; // staying aboard: tide-immune, half cover
    if (dn > z.next && !stay) score -= (dn - z.next) * 4;
    if (dz > z.r && !stay) score -= 40 + (dz - z.r) * 6 + (u.hp <= zoneDamage(state) ? 200 : 0);
    if (stay) score += 4;
    if (danger.has(k)) score -= 45;
    // Kelp and smoke hide you: good ground to advance through.
    if (isKelp(state.map, x, y)) score += near.length ? 3 : 1;
    if (near.length && smokeAt(state, x, y)) score += 2;
    if (near.length) {
      // Defense: incoming expected hits from everyone who can see this tile.
      const threat = threatAt(state, u, x, y, near);
      score -= threat * (defensive ? 30 : W_DEF);
      // Offense: the best shot available from here next action.
      const ghost = { ...u, x, y, moved: true };
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
  // A mate downed out in the tide just goes down again at the end of the turn: not worth the AP
  // (and reviving in a loop there drags the endgame out).
  const downed = matesOf(state, u).filter((m) => m.downed && adjacent(u, m)
    && (insideZone(state, m.x, m.y) || m.hp + 5 > zoneDamage(state) + 2));
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
      const gx = z.nx ?? z.x, gy = z.ny ?? z.y;
      const d = dist(u.x, u.y, gx, gy) || 1;
      const k = Math.min(1, 9 / d);
      x = Math.round(u.x + (gx - u.x) * k); y = Math.round(u.y + (gy - u.y) * k);
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
    let t = m.downed
      ? foes.filter((e) => dist(e.x, e.y, m.x, m.y) <= weaponRange(e) + 2).length * 0.5
      : threatAt(state, m, m.x, m.y, foes);
    if (!m.downed) {
      // Smoke now hides rather than shields: value it by how much fire it actually breaks.
      state.smokes.push({ id: -1, x: m.x, y: m.y, radius: 1.5 });
      t -= threatAt(state, m, m.x, m.y, foes);
      state.smokes.pop();
    }
    if (t < (m.id === u.id && m.hp > m.maxHp * 0.6 ? 0.6 : 0.3)) continue;
    const value = t + (m.downed ? 0.6 : 0) + (m.id === u.id ? 0.2 : 0);
    if (!best || value > best.value) best = { x: m.x, y: m.y, value };
  }
  return !!best && doAct({ type: 'smoke', x: best.x, y: best.y });
}

// ---------- 5.0: ammo, equipment, streaks, class abilities ----------

/** Turn-start weapon housekeeping: back to the primary if it has rounds, swap away from an empty gun. */
function manageWeapons(state, u, enemies, doAct) {
  if (!u.weapons || u.swapped) return;
  const prim = u.weapons[0], sec = u.weapons[1];
  const primLoaded = (u.slot === 0 ? u.ammo : prim.ammo) > 0 || (prim.spare ?? 0) > 0;
  if (u.slot === 1 && primLoaded) { doAct({ type: 'swap' }); return; }
  // Primary dry with no spares: the sidearm (or launcher) it is.
  if (u.slot === 0 && !hasAmmo(u) && (prim.spare ?? 0) <= 0 && sec && (sec.ammo > 0 || hasSpecial(sec, 'infinite'))) doAct({ type: 'swap' });
}

/** Reload when empty, or topping up when nothing is in sight and there's AP to spare. */
function tryReload(state, u, foes, doAct, force = false) {
  const w = u.weapon;
  if (hasSpecial(w, 'infinite') || hasSpecial(w, 'explosive') || (w.spare ?? 0) <= 0 || u.ammo >= w.mag) return false;
  const free = w.freeReload && !u.freeReloaded;
  if (!free && u.ap < 1) return false;
  const low = u.ammo <= Math.max(1, Math.floor(w.mag / 3));
  if (u.ammo === 0 || force || (low && (!foes.length || free)) || (free && u.ammo < w.mag && !foes.length)) {
    return doAct({ type: 'reload' });
  }
  return false;
}

/** Rocket a cluster or a dug-in enemy with the launcher (swapping to it is free). */
function tryLauncher(state, u, enemies, shot, doAct) {
  const sec = u.weapons?.[1];
  if (!sec || !hasSpecial(sec, 'explosive') || !(sec.ammo > 0) || u.ap < 1 || u.moveOnly) return false;
  if (u.slot !== 1 && u.swapped) return false;
  const wasSlot = u.slot;
  if (u.slot !== 1) { u.slot = 1; u.weapon = sec; }
  const best = bestGrenade(state, u, enemies, 'rocket');
  if (wasSlot !== 1) { u.slot = wasSlot; u.weapon = u.weapons[wasSlot]; }
  if (!best) return false;
  const worth = best.hits >= 2 || best.value >= 9 || (shot ? best.value >= shot.value * 1.4 : best.value >= 5);
  if (!worth) return false;
  if (u.slot !== 1 && !doAct({ type: 'swap' })) return false;
  return doAct({ type: 'shoot', x: best.x, y: best.y });
}

/** Throwing knife: free-ish damage (doesn't end the turn) at close range. */
function tryKnife(state, u, foes, doAct) {
  if ((u.items.knife || 0) < 1 || u.ap < 2) return false;
  let best = null;
  const S = state.map.size;
  for (const k of equipmentTargets(state, u, 'knife')) {
    const p = equipmentPreview(state, u, 'knife', k % S, (k / S) | 0);
    if (!p.units.length || p.units[0].ally) continue;
    const t = state.units[p.units[0].id];
    const v = (p.chance / 100) * p.units[0].dmg + (p.units[0].lethal ? 4 : 0) + (t.downed ? 3 : 0);
    if (p.chance >= 45 && (!best || v > best.v)) best = { v, id: t.id };
  }
  return !!best && doAct({ type: 'knife', targetId: best.id });
}

/** Flashbang a group of enemies (or one that's about to be engaged) before acting. */
function tryFlash(state, u, foes, doAct) {
  if ((u.items.flashbang || 0) < 1 || u.ap < 2 || !foes.length) return false;
  let best = null;
  for (const e of foes) {
    if (dist(u.x, u.y, e.x, e.y) > EQUIPMENT.flashbang.range) continue;
    for (const [dx, dy] of [[0, 0], ...DIRS8]) {
      const x = e.x + dx, y = e.y + dy;
      if (dist(x, y, u.x, u.y) <= EQUIPMENT.flashbang.radius + 0.5) continue;
      const p = equipmentPreview(state, u, 'flashbang', x, y);
      if (!p.valid || p.units.some((h) => h.ally)) continue;
      const hit = p.units.filter((h) => !h.immune && !state.units[h.id].downed && !state.units[h.id].flash).length;
      if (hit && (!best || hit > best.hit)) best = { x, y, hit };
    }
  }
  if (!best) return false;
  const close = foes.some((e) => dist(u.x, u.y, e.x, e.y) <= 7);
  if (best.hit >= 2 || close) return doAct({ type: 'flashbang', x: best.x, y: best.y });
  return false;
}

/** Stim: an extra action when there's a fight on, or a heal when hurt. */
function tryStim(state, u, foes, doAct) {
  if ((u.items.stim || 0) < 1 || u.ap < 1) return false;
  if ((foes.length && u.ap >= u.maxAp) || u.hp <= u.maxHp * 0.5) return doAct({ type: 'stim' });
  return false;
}

/** Decoy: bait an enemy overwatch before moving, or cover a retreat. */
function tryDecoy(state, u, foes, doAct) {
  if ((u.items.decoy || 0) < 1 || u.ap < 2 || !foes.length) return false;
  const watcher = foes.find((e) => e.overwatch && !e.isPlayer);
  const lowHp = u.hp <= u.maxHp * 0.5;
  if (!watcher && !lowHp) return false;
  const S = state.map.size;
  const near = watcher || foes[0];
  let best = null;
  for (const k of equipmentTargets(state, u, 'decoy')) {
    const x = k % S, y = (k / S) | 0;
    if (watcher && (dist(x, y, watcher.x, watcher.y) > watcher.weapon.range || !los(state.map, watcher.x, watcher.y, x, y))) continue;
    const v = -dist(x, y, near.x, near.y) + dist(x, y, u.x, u.y) * 0.3;
    if (!best || v > best.v) best = { x, y, v };
  }
  return !!best && doAct({ type: 'decoy', x: best.x, y: best.y });
}

/** Claymore on the adjacent tile closest to the nearest threat. */
function tryClaymore(state, u, foes, doAct) {
  if ((u.items.claymore || 0) < 1 || u.ap < 1 || !foes.length) return false;
  const near = foes.reduce((a, b) => (dist(u.x, u.y, a.x, a.y) <= dist(u.x, u.y, b.x, b.y) ? a : b));
  if (dist(u.x, u.y, near.x, near.y) > 9) return false;
  const S = state.map.size;
  let best = null;
  for (const k of equipmentTargets(state, u, 'claymore')) {
    const x = k % S, y = (k / S) | 0;
    const v = -dist(x, y, near.x, near.y);
    if (!best || v > best.v) best = { x, y, v };
  }
  return !!best && doAct({ type: 'claymore', x: best.x, y: best.y });
}

/** Engineer: drop a barricade on the side the fire comes from. */
function tryDeployCover(state, u, foes, doAct) {
  if (u.cls !== 'engineer' || u.cooldowns.deploy_cover > 0 || u.ap < 1 || !foes.length) return false;
  const S = state.map.size;
  const now = threatAt(state, u, u.x, u.y, foes);
  if (now < 0.35) return false;
  let best = null;
  for (const k of deployCoverTargets(state, u)) {
    state.map.cover[k] = 2;
    const t = threatAt(state, u, u.x, u.y, foes);
    state.map.cover[k] = 0;
    const gain = now - t;
    if (gain > 0.25 && (!best || gain > best.gain)) best = { x: k % S, y: (k / S) | 0, gain };
  }
  return !!best && doAct({ type: 'deploy_cover', x: best.x, y: best.y });
}

/** Gunner: pin the most dangerous enemy when the straight shot is poor. */
function trySuppress(state, u, foes, shot, doAct) {
  if (u.cls !== 'gunner' || u.cooldowns.suppress > 0 || u.ap < 1 || !hasAmmo(u, SUPPRESS.ammo)) return false;
  if (shot && (shot.chance >= 55 || (shot.lethal && shot.chance >= 40))) return false;
  let best = null;
  for (const e of foes) {
    if (e.suppressed || !suppressPreview(state, u, e)) continue;
    const v = (e.ap > 0 ? 1 : 0) + (dist(u.x, u.y, e.x, e.y) <= weaponRange(e) ? 2 : 0) + e.hp * 0.05;
    if (!best || v > best.v) best = { v, id: e.id };
  }
  return !!best && doAct({ type: 'suppress', targetId: best.id });
}

/** Killstreaks: use them when they'll matter. One per turn. */
function tryStreak(state, u, enemies, doAct) {
  const ready = streakInfo(state, u).filter((s) => s.ready);
  if (!ready.length) return false;
  const foes = threats(enemies);
  const S = state.map.size;
  for (const s of ready) {
    switch (s.key) {
      case 'uav':
        return doAct({ type: 'streak', key: 'uav' });
      case 'cuav':
        if (foes.length >= 1) return doAct({ type: 'streak', key: 'cuav' });
        break;
      case 'gunship':
        if (foes.length >= 1) return doAct({ type: 'streak', key: 'gunship' });
        break;
      case 'care': {
        if (foes.some((e) => dist(e.x, e.y, u.x, u.y) <= 3)) break;
        let best = null;
        for (const k of streakTargets(state, u, 'care')) {
          const x = k % S, y = (k / S) | 0;
          if (!insideZone(state, x, y, state.zone.next) && insideZone(state, u.x, u.y, state.zone.next)) continue;
          const v = -Math.abs(dist(x, y, u.x, u.y) - 2) + roll(state.seed, u.id, k, 77);
          if (!best || v > best.v) best = { x, y, v };
        }
        if (best) return doAct({ type: 'streak', key: 'care', x: best.x, y: best.y });
        break;
      }
      case 'sentry': {
        const near = foes.filter((e) => dist(e.x, e.y, u.x, u.y) <= STREAKS.sentry.reach + 2);
        if (!near.length) break;
        const tgt = near[0];
        let best = null;
        for (const k of streakTargets(state, u, 'sentry')) {
          const x = k % S, y = (k / S) | 0;
          const v = -dist(x, y, tgt.x, tgt.y) + (los(state.map, x, y, tgt.x, tgt.y) ? 3 : 0);
          if (!best || v > best.v) best = { x, y, v };
        }
        if (best) return doAct({ type: 'streak', key: 'sentry', x: best.x, y: best.y, x2: tgt.x, y2: tgt.y });
        break;
      }
      case 'airstrike': {
        if (!foes.length) break;
        let best = null;
        for (const e of foes) {
          if (dist(u.x, u.y, e.x, e.y) > STREAKS.airstrike.range) continue;
          for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
            for (let off = -3; off <= 0; off++) {
              const x = e.x + dx * off, y = e.y + dy * off;
              const p = streakPreview(state, u, 'airstrike', x, y, x + dx, y + dy);
              if (!p.valid || p.units.some((h) => h.ally)) continue;
              // The strike lands next round: favour targets dug in (hunkered / overwatching / downed / in cover).
              const v = p.units.reduce((a, h) => {
                const o = state.units[h.id];
                return a + 1 + (o.hunkered || o.overwatch ? 0.5 : 0) + (o.downed ? 0.5 : 0);
              }, 0) + p.tiles.filter(([tx, ty]) => state.map.cover[ty * S + tx] > 0).length * 0.15;
              if (p.units.length && (!best || v > best.v)) best = { x, y, x2: x + dx, y2: y + dy, v };
            }
          }
        }
        if (best && best.v >= 1) return doAct({ type: 'streak', key: 'airstrike', x: best.x, y: best.y, x2: best.x2, y2: best.y2 });
        break;
      }
      default:
    }
  }
  return false;
}

// ---------- 5.0 battlefield: boats ----------

/** Score a water tile for the boat: closer to the coming circle, a landing nearby, out of harm's way. */
function boatTileScore(state, u, x, y, foes, danger) {
  const S = state.map.size;
  const z = state.zone;
  const gx = z.nx ?? z.x, gy = z.ny ?? z.y;
  let score = -Math.max(0, dist(x, y, gx, gy) - z.next * 0.6);
  if (dist(x, y, z.x, z.y) > z.r) score -= 3; // still in the tide: hull damage
  // A dry landing inside the coming ring right next to the boat.
  for (const [dx, dy] of DIRS8) {
    const nx = x + dx, ny = y + dy;
    if (!inBounds(state.map, nx, ny)) continue;
    const k = ny * S + nx;
    if (state.map.cover[k] === 0 && state.map.terrain[k] !== 2 && insideNextZone(state, nx, ny)) { score += 4; break; }
  }
  if (danger.has(y * S + x)) score -= 30;
  if (foes.length) {
    // Flank: somewhere with a shot, but not under every gun.
    const ghost = { ...u, x, y, moved: true, vehicle: u.vehicle };
    let off = 0;
    for (const e of foes) {
      if (dist(x, y, e.x, e.y) > weaponRange(u) || !los(state.map, x, y, e.x, e.y)) continue;
      const hc = hitChance(state, ghost, e);
      if (hc.flank) off = Math.max(off, 2);
      off = Math.max(off, hc.chance / 40);
    }
    score += off - threatAt(state, ghost, x, y, foes) * 3;
  }
  return score;
}

/**
 * Boats: a driver sails for the circle (or a flank); a unit stranded in the tide boards a nearby boat
 * (aboard it takes no tide damage). Uses the whole turn when the boat moves.
 */
function tryBoat(state, u, foes, shot, doAct) {
  if (!state.vehicles || !state.vehicles.length || u.ap < 1 || u.moveOnly) return false;
  const S = state.map.size;
  const z = state.zone;
  const danger = dangerTiles(state);
  const v = vehicleOf(state, u);
  if (v) {
    if (driverOf(state, v) !== u || v.fuel < 1) return false;
    if (shot && shot.chance >= 55) return false; // a good shot beats a boat ride
    const safe = insideNextZone(state, v.x, v.y) && !danger.has(v.y * S + v.x);
    if (safe && !foes.length) return false;
    const here = boatTileScore(state, u, v.x, v.y, foes, danger);
    let best = null;
    for (const [k, n] of boatReach(state, v)) {
      if (n.d === 0) continue;
      const x = k % S, y = (k / S) | 0;
      const sc = boatTileScore(state, u, x, y, foes, danger) + roll(state.seed, u.id, state.round, k, 0xb0) * 0.5;
      if (!best || sc > best.sc) best = { x, y, sc };
    }
    if (best && best.sc > here + (safe ? 3 : 1.5)) return doAct({ type: 'boat_move', x: best.x, y: best.y });
    return false;
  }
  // Stranded in the tide (won't reach dry ground this turn), or a boat is right here to flank with.
  const outside = !insideZone(state, u.x, u.y);
  const gap = dist(u.x, u.y, z.x, z.y) - z.r;
  const stranded = outside && gap > moveOf(u) - 1;
  const usable = state.vehicles.filter((b) => b.hp > 4 && b.seats.length < 4
    && (b.fuel >= 1 || b.seats.length) && !b.seats.some((id) => state.units[id].team !== u.team));
  if (!usable.length) return false;
  const adj = usable.find((b) => !boardError(state, u, b));
  if (adj && (stranded || (outside && u.hp <= zoneDamage(state) * 2))) return doAct({ type: 'move', x: adj.x, y: adj.y });
  // Under fire in the open with a boat alongside: aboard is guaranteed half cover.
  if (adj && foes.length && !(shot && shot.chance >= 50) && insideZone(state, adj.x, adj.y)
    && !danger.has(adj.y * S + adj.x)) {
    const now = threatAt(state, u, u.x, u.y, foes);
    const there = threatAt(state, { ...u, vehicle: adj.id }, adj.x, adj.y, foes);
    if (now - there >= 0.3) return doAct({ type: 'move', x: adj.x, y: adj.y });
  }
  // Commute: nobody in sight, a long way to the coming circle, and the boat gets there faster.
  const gx = z.nx ?? z.x, gy = z.ny ?? z.y;
  const far = !foes.length && !insideNextZone(state, u.x, u.y) && dist(u.x, u.y, gx, gy) - z.next > moveOf(u);
  if (far) {
    const walk = dist(u.x, u.y, gx, gy) - moveOf(u) * 2;
    for (const b of usable) {
      if (b.fuel < 1 || b.seats.length || chebyshev(u, b) > (u.ap >= 2 ? 1 : 0)) continue;
      let sail = Infinity;
      for (const [k, n] of boatReach(state, b)) if (n.d > 0) sail = Math.min(sail, dist(k % S, (k / S) | 0, gx, gy));
      if (sail <= walk - 1 && !boardError(state, u, b)) return doAct({ type: 'move', x: b.x, y: b.y });
    }
  }
  if (!stranded || u.ap < 2) return false;
  // Walk next to a boat (1 AP), board next action.
  const reach = moveOptions(state, u);
  let best = null;
  for (const b of usable) {
    for (const [dx, dy] of DIRS8) {
      const k = (b.y + dy) * S + b.x + dx;
      const n = reach.get(k);
      if (!n || n.d === 0 || n.d > moveOf(u)) continue;
      const sc = -n.d - dist(b.x, b.y, z.nx ?? z.x, z.ny ?? z.y) * 0.3;
      if (!best || sc > best.sc) best = { x: k % S, y: (k / S) | 0, sc };
    }
  }
  return !!best && doAct({ type: 'move', x: best.x, y: best.y });
}

/** Engineer: patch up a damaged boat nearby when it's quiet enough. */
function tryRepair(state, u, foes, doAct) {
  if (u.cls !== 'engineer' || u.ap < 1) return false;
  for (const id of repairTargets(state, u)) {
    const v = state.vehicles.find((b) => b.id === id);
    if (v.hp > v.maxHp - 4 && v.fuel >= 1) continue;
    if (foes.length && threatAt(state, u, u.x, u.y, foes) > 0.4) continue;
    if (doAct({ type: 'repair', vehicleId: id })) return true;
  }
  return false;
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

  manageWeapons(state, u, visibleEnemies(state, u), doAct);
  let moved = 0;
  for (let step = 0; step < 10 && standing(u) && (u.ap > 0 || u.runGun) && state.winner === null; step++) {
    const enemies = visibleEnemies(state, u);
    const foes = threats(enemies);
    // Riptide: a kill gave one move back.
    if (u.moveOnly) {
      const dest = chooseMove(state, u, { costOne: true, defensive: true });
      if (!dest || !doAct({ type: 'move', x: dest.x, y: dest.y })) doAct({ type: 'hold' });
      break;
    }
    // Run & Gun: a dash left no AP, but one shot is still allowed.
    if (u.ap < 1 && u.runGun) {
      const shot = bestShot(state, u);
      if (shot && shot.chance >= 25) doAct({ type: shot.type, targetId: shot.target.id });
      else doAct({ type: 'hold' });
      break;
    }
    const lowHp = u.hp <= u.maxHp * 0.4;
    const shot = bestShot(state, u);
    const killShot = shot && shot.lethal && shot.chance >= 50;
    const inTide = !insideZone(state, u.x, u.y) && u.vehicle == null;
    // Standing where a telegraphed airstrike / stage event / red tide will land: move out.
    const inDanger = dangerTiles(state).has(u.y * state.map.size + u.x) && !killShot;

    // 0. Free actions: killstreaks, then an empty magazine.
    if (!u.streakCalled && tryStreak(state, u, enemies, doAct)) continue;
    if (!hasAmmo(u) && !hasSpecial(u.weapon, 'explosive')) {
      if (tryReload(state, u, foes, doAct, true)) continue;
      if (!u.swapped && u.weapons?.[1 - u.slot] && doAct({ type: 'swap' })) continue;
    }

    // 1. Squadmates first: revive the downed, patch the hurt.
    if (tryRevive(state, u, enemies, doAct)) continue;
    if (!killShot && tryPatch(state, u, doAct)) continue;

    // 1b. Boats: sail for the circle / a flank, or get off a drowning shore.
    if (!killShot && tryBoat(state, u, foes, shot, doAct)) { if (u.vehicle != null && u.ap < 1) break; continue; }
    if (!foes.length && tryRepair(state, u, foes, doAct)) continue;

    // 2. Patch up if hurt and nothing can be killed right now.
    if (u.hp <= u.maxHp * 0.5 && u.items.medkit > 0 && u.hp < u.maxHp && !killShot
      && !(u.cls === 'medic' && u.cooldowns.patch <= 0)) {
      if (doAct({ type: 'medkit' })) continue;
    }
    if (tryStim(state, u, foes, doAct)) continue;

    // 3. Recon looks before it leaps.
    if (!moved && tryScan(state, u, enemies, doAct)) continue;

    // 4. Explosives and equipment cost 1 AP and don't end the turn, so they come before the shot.
    const breach = u.cls === 'breacher' ? bestBreach(state, u) : null;
    if (breach && doAct({ type: 'breach', x: breach.x, y: breach.y })) continue;
    let threw = false;
    for (const key of ['frag', 'semtex']) {
      const nade = bestGrenade(state, u, enemies, key);
      if (nade && (!shot || nade.value >= shot.value * 0.8 || nade.hits >= 2 || u.ap >= 2)
        && doAct({ type: key === 'frag' ? 'grenade' : 'semtex', x: nade.x, y: nade.y })) { threw = true; break; }
    }
    if (threw) continue;
    if (tryKnife(state, u, foes, doAct)) continue;
    if (!moved && tryFlash(state, u, foes, doAct)) continue;
    if (!moved && tryDecoy(state, u, foes, doAct)) continue;
    // Fuel drums: shooting one ends the turn, so it has to beat the best shot.
    const drum = hasAmmo(u) ? bestBarrel(state, u, enemies) : null;
    if (drum && (drum.hits >= 2 || drum.lethal || !shot || drum.value >= shot.value * 1.3)) {
      if (doAct({ type: 'shoot_barrel', x: drum.x, y: drum.y })) break;
    }
    if (tryLauncher(state, u, enemies, shot, doAct)) break;

    // 5. Take a good shot from here; after moving, accept a lesser one.
    const canStillMove = !moved && u.ap >= 1;
    const steady = (hasPerk(u, 'steady') ? 10 : 0) + (u.weapon.steady || 0);
    // Before moving only take sure things: repositioning into cover first is usually better.
    const threshold = canStillMove ? (shot && shot.lethal ? 55 : T_STAY - steady) : 30;
    if (!canStillMove && trySuppress(state, u, foes, shot, doAct)) break;
    if (shot && shot.chance >= threshold && !((inTide || inDanger) && canStillMove && !killShot)) {
      doAct({ type: shot.type, targetId: shot.target.id });
      break;
    }

    // 6. Reposition. With enemies around keep 1 AP to act; otherwise travel.
    if (moved < 2 && u.ap >= 1) {
      const fighting = foes.length > 0;
      const downedMate = matesOf(state, u).some((m) => m.downed);
      const travel = !fighting && (moved === 0 || !insideNextZone(state, u.x, u.y));
      if (inTide || inDanger || (fighting || downedMate ? moved === 0 : travel)) {
        // Assault Run & Gun: dash into a flank and still fire.
        const runGun = fighting && u.cls === 'assault' && u.cooldowns.run_gun <= 0 && u.ap >= 2 && !lowHp && !(shot && shot.chance >= 50);
        const opts = {
          // Caught in the tide: dash for dry ground even mid-fight.
          costOne: inTide || inDanger || runGun ? false : fighting || downedMate || u.ap >= 2,
          defensive: lowHp && !(shot && shot.chance >= 50),
        };
        let dest = chooseMove(state, u, opts);
        // Approach under smoke: if the best tile is exposed, drop a cloud on it first.
        if (dest && fighting && u.items.smoke > 0 && u.ap >= 2 && !smokeAt(state, dest.x, dest.y)
          && threatAt(state, u, dest.x, dest.y, foes) >= 0.5 && doAct({ type: 'smoke', x: dest.x, y: dest.y })) {
          dest = chooseMove(state, u, opts);
        }
        if (dest && doAct({ type: 'move', x: dest.x, y: dest.y })) { moved++; continue; }
      }
    }

    // 7. End of turn.
    if (tryRevive(state, u, enemies, doAct)) continue;
    if (tryRepair(state, u, foes, doAct)) continue;
    if (tryDeployCover(state, u, foes, doAct)) continue;
    if (u.ap >= 1 && !(shot && shot.chance >= 55) && trySmoke(state, u, enemies, doAct)) continue;
    if (!hasAmmo(u) && tryReload(state, u, foes, doAct, true)) continue;
    if (trySuppress(state, u, foes, shot, doAct)) break;
    const goodShot = shot && (shot.chance >= 50 || (shot.lethal && shot.chance >= 35));
    if (!goodShot && tryClaymore(state, u, foes, doAct)) continue;
    if (foes.length && lowHp && !goodShot && exposed(state, u, foes)
      && threatAt(state, u, u.x, u.y, foes, true) < threatAt(state, u, u.x, u.y, foes) - 0.1) {
      doAct({ type: 'hunker' });
    } else if (shot && shot.chance >= 25) {
      doAct({ type: shot.type, targetId: shot.target.id });
    } else if (!foes.length && tryReload(state, u, foes, doAct, u.ammo < u.weapon.mag)) {
      continue;
    } else if (!hasAmmo(u) || hasSpecial(u.weapon, 'explosive') || !doAct({ type: 'overwatch' })) {
      doAct({ type: 'hold' });
    }
    break;
  }
  return events;
}
