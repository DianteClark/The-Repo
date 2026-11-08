// Lethal and tactical equipment (5.0 spec §3). Frag and smoke keep their legacy
// action names ('grenade', 'smoke'); everything else uses its own key as the action type:
//   {type:'grenade'|'semtex'|'flashbang'|'smoke'|'decoy', x, y}
//   {type:'claymore', x, y}        adjacent open tile
//   {type:'knife', targetId}       visible enemy within 4
//   {type:'stim'}
// All cost 1 AP and don't end the turn, except stim (free).
//
// State: unit.items[key] charges; state.claymores = [{id, team, owner, x, y}];
// state.decoys = [{id, team, owner, x, y, untilRound}].

import { SMOKE } from './constants.js';
import {
  dist, inBounds, los, standing, teamSeesTile, teamSeesUnit, hitChance,
} from './rules.js';
import { EQUIPMENT } from './weapons.js';
import {
  detonate, planExplosions, summarisePlan, blastDamage, nextRoll, hurt, teamIsActive, chebyshev, track,
} from './core.js';
import { hasPerk } from './loadout.js';

const intXY = (a) => Number.isInteger(a.x) && Number.isInteger(a.y);
const charges = (u, key) => (u.items && u.items[key]) || 0;

/** Item key for an action type (grenade → frag). */
export const ACTION_ITEM = { grenade: 'frag', semtex: 'semtex', claymore: 'claymore', knife: 'knife', smoke: 'smoke', flashbang: 'flashbang', stim: 'stim', decoy: 'decoy' };

/** Thrown-item tile rules (frag, semtex, smoke, flashbang, decoy): range, seen tile, line of sight. */
export function throwTileOk(state, u, x, y, range = EQUIPMENT.frag.range) {
  return inBounds(state.map, x, y)
    && dist(u.x, u.y, x, y) <= range
    && teamSeesTile(state, u.team, x, y)
    && los(state.map, u.x, u.y, x, y);
}

export const canUse = (u, key) => standing(u) && charges(u, key) > 0 && (key === 'stim' ? u.ap >= 1 : u.ap >= 1) && !u.moveOnly;

function claymoreTileOk(state, u, x, y) {
  if (!inBounds(state.map, x, y) || chebyshev(u, { x, y }) !== 1) return false;
  if (state.map.cover[y * state.map.size + x] > 0) return false;
  if (state.units.some((o) => o.alive && o.x === x && o.y === y)) return false;
  return !state.claymores.some((c) => c.x === x && c.y === y);
}

function knifeTarget(state, u, t) {
  return !!t && t.alive && t.team !== u.team && teamSeesUnit(state, u.team, t)
    && dist(u.x, u.y, t.x, t.y) <= EQUIPMENT.knife.range && los(state.map, u.x, u.y, t.x, t.y);
}

/** Knife hit chance: a thrown blade with its own aim; cover, smoke and status still apply. */
export function knifeChance(state, u, t) {
  const blade = { ...u, weapon: { aim: EQUIPMENT.knife.aim, range: EQUIPMENT.knife.range, dmg: [4, 4], special: [] }, mods: { scope: 0, barrel: 0 }, missStreak: 0 };
  return hitChance(state, blade, t);
}

/** Valid targets for an equipment item: Set of tile keys (knife: the targets' tiles; stim: own tile). */
export function equipmentTargets(state, u, key) {
  const out = new Set();
  const e = EQUIPMENT[key];
  if (!e || !canUse(u, key)) return out;
  const S = state.map.size;
  if (key === 'stim') { out.add(u.y * S + u.x); return out; }
  if (key === 'knife') {
    for (const t of state.units) if (knifeTarget(state, u, t)) out.add(t.y * S + t.x);
    return out;
  }
  if (key === 'claymore') {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (claymoreTileOk(state, u, u.x + dx, u.y + dy)) out.add((u.y + dy) * S + u.x + dx);
    return out;
  }
  const R = Math.ceil(e.range);
  for (let y = Math.max(0, u.y - R); y <= Math.min(S - 1, u.y + R); y++) {
    for (let x = Math.max(0, u.x - R); x <= Math.min(S - 1, u.x + R); x++) {
      if (throwTileOk(state, u, x, y, e.range)) out.add(y * S + x);
    }
  }
  return out;
}

const stuckTo = (state, x, y) => state.units.find((o) => o.alive && o.x === x && o.y === y) || null;

/**
 * Preview: { valid, key, x, y, radius, units:[{id, dmg?, lethal?, ally}], cover, barrels, chance? }.
 * Lists only units the thrower's team can see.
 */
export function equipmentPreview(state, u, key, x, y) {
  const e = EQUIPMENT[key];
  const S = state.map.size;
  const res = { valid: false, key, x, y, radius: e?.radius || 0, units: [], cover: [], barrels: [] };
  if (!e) return res;
  if (key === 'stim') return { ...res, valid: canUse(u, key), units: [{ id: u.id, ally: true, heal: Math.min(e.heal, u.maxHp - u.hp) }] };
  if (!Number.isInteger(x) || !Number.isInteger(y)) return res;
  res.valid = equipmentTargets(state, u, key).has(y * S + x);
  if (!inBounds(state.map, x, y)) return res;
  if (key === 'frag' || key === 'semtex') {
    const stick = key === 'semtex' ? stuckTo(state, x, y) : null;
    const bonus = stick ? new Map([[stick.id, e.stick]]) : null;
    Object.assign(res, summarisePlan(state, u, planExplosions(state, u, { kind: key, x, y }), bonus));
    if (stick && teamSeesUnit(state, u.team, stick)) res.stuck = stick.id;
  } else if (key === 'knife') {
    const t = stuckTo(state, x, y);
    if (t && knifeTarget(state, u, t)) {
      const hc = knifeChance(state, u, t);
      const dmg = Math.max(1, e.dmg - t.armor);
      res.chance = hc.chance;
      res.units = [{ id: t.id, dmg, lethal: dmg >= t.hp, ally: false }];
    }
  } else if (key === 'flashbang' || key === 'smoke') {
    res.units = state.units.filter((o) => o.alive && dist(o.x, o.y, x, y) <= e.radius && teamSeesUnit(state, u.team, o))
      .map((o) => ({ id: o.id, ally: o.team === u.team, immune: key === 'flashbang' && hasPerk(o, 'mask') }));
  } else if (key === 'claymore') {
    res.radius = e.trigger;
  }
  return res;
}

/** Use an equipment action. Returns {events} or {error}. */
export function actEquipment(state, u, action) {
  const key = ACTION_ITEM[action.type];
  const e = EQUIPMENT[key];
  if (u.moveOnly) return { error: 'Move only' };
  if (u.ap < 1) return { error: 'No AP' };
  if (charges(u, key) < 1) return { error: key === 'frag' ? 'No grenades' : key === 'smoke' ? 'No smoke' : 'None left' };
  const events = [];
  const { x, y } = action;
  switch (key) {
    case 'frag':
    case 'semtex': {
      if (!intXY(action) || !throwTileOk(state, u, x, y, e.range)) return { error: 'Bad target' };
      u.ap--;
      u.items[key]--;
      if (key === 'frag') {
        events.push({ type: 'grenade', id: u.id, x, y, radius: e.radius });
        detonate(state, u, { kind: 'frag', x, y }, events);
      } else {
        const stick = stuckTo(state, x, y);
        events.push({ type: 'semtex', id: u.id, x, y, radius: e.radius, stuck: stick ? stick.id : null });
        detonate(state, u, { kind: 'semtex', x, y }, events, stick ? new Map([[stick.id, e.stick]]) : null);
      }
      break;
    }
    case 'smoke': {
      if (!intXY(action) || !throwTileOk(state, u, x, y, e.range)) return { error: 'Bad target' };
      u.ap--;
      u.items.smoke--;
      const cloud = {
        id: state.nextSmokeId++, x, y, radius: SMOKE.radius, team: u.team,
        expiresRound: state.round + 1, expiresTeam: u.team,
      };
      state.smokes.push(cloud);
      events.push({ type: 'smoke', id: u.id, x, y, radius: SMOKE.radius, smokeId: cloud.id });
      break;
    }
    case 'flashbang': {
      if (!intXY(action) || !throwTileOk(state, u, x, y, e.range)) return { error: 'Bad target' };
      u.ap--;
      u.items.flashbang--;
      const hit = [], immune = [];
      for (const o of state.units) {
        if (!o.alive || o.team === u.team || dist(o.x, o.y, x, y) > e.radius) continue;
        if (hasPerk(o, 'mask')) { immune.push(o.id); continue; }
        o.flash = { pending: teamIsActive(state, o.team), apLoss: e.apLoss };
        o.overwatch = false; // blinded: overwatch drops
        hit.push(o.id);
      }
      events.push({ type: 'flashbang', id: u.id, x, y, radius: e.radius, hit, immune });
      break;
    }
    case 'stim': {
      u.items.stim--;
      u.ap = Math.min(u.maxAp + 1, u.ap + e.ap);
      const heal = Math.min(e.heal, u.maxHp - u.hp);
      u.hp += heal;
      events.push({ type: 'stim', id: u.id, heal, ap: u.ap });
      break;
    }
    case 'claymore': {
      if (!intXY(action) || !claymoreTileOk(state, u, x, y)) return { error: 'Bad target' };
      u.ap--;
      u.items.claymore--;
      const c = { id: state.nextEquipId++, team: u.team, owner: u.id, x, y };
      state.claymores.push(c);
      events.push({ type: 'claymore', id: u.id, x, y, claymoreId: c.id, radius: e.trigger });
      break;
    }
    case 'knife': {
      const t = state.units[action.targetId];
      if (!knifeTarget(state, u, t)) return { error: 'No target' };
      u.ap--;
      u.items.knife--;
      const hc = knifeChance(state, u, t);
      const r = nextRoll(state) * 100;
      const result = r < hc.chance ? 'hit' : r < hc.chance + 10 && !hc.hunkered ? 'graze' : 'miss';
      let dmg = 0;
      if (result !== 'miss') dmg = Math.max(1, (result === 'graze' ? Math.ceil(e.dmg / 2) : e.dmg) - t.armor);
      const ev = { type: 'knife', id: u.id, target: t.id, result, dmg, chance: hc.chance, cover: hc.cover };
      events.push(ev);
      if (dmg) {
        hurt(state, t, dmg, 'knife', u, events);
        if (hasPerk(u, 'tracker') && t.alive) track(state, u.team, t, events);
      }
      break;
    }
    case 'decoy': {
      if (!intXY(action) || !throwTileOk(state, u, x, y, e.range)) return { error: 'Bad target' };
      u.ap--;
      u.items.decoy--;
      const d = { id: state.nextEquipId++, team: u.team, owner: u.id, x, y, untilRound: state.round + 1 };
      state.decoys.push(d);
      state.noises.push({ x, y, team: u.team, round: state.round, kind: 'gunfire', decoy: d.id });
      events.push({ type: 'decoy', id: u.id, x, y, decoyId: d.id });
      events.push({ type: 'noise', id: null, x, y, kind: 'gunfire' });
      // Bot overwatch takes the bait: any enemy bot on overwatch that can see the tile wastes its shot on it.
      for (const o of state.units) {
        if (!standing(o) || !o.overwatch || o.team === u.team || o.isPlayer) continue;
        if (dist(o.x, o.y, x, y) > o.weapon.range || !los(state.map, o.x, o.y, x, y)) continue;
        o.overwatch = false;
        if (o.ammo > 0 && !o.weapon.special?.includes('infinite')) { o.ammo--; o.weapon.ammo = o.ammo; }
        events.push({ type: 'overwatch_trigger', id: o.id, target: null, decoy: d.id, x, y });
      }
      break;
    }
    default:
      return { error: 'Unknown action' };
  }
  if (!standing(u)) u.ap = 0;
  return { events };
}

/** Enemy claymores go off when a unit moves within 1.5 of them. Called after each step. */
export function claymoreReact(state, mover, events) {
  for (const c of [...state.claymores]) {
    if (c.team === mover.team || !standing(mover)) continue;
    if (dist(c.x, c.y, mover.x, mover.y) > EQUIPMENT.claymore.trigger) continue;
    state.claymores = state.claymores.filter((x) => x !== c);
    events.push({ type: 'claymore_trigger', claymoreId: c.id, target: mover.id, x: c.x, y: c.y });
    blastDamage(state, state.units[c.owner], [mover], EQUIPMENT.claymore.dmg, 'claymore', events);
    if (state.winner !== null) return;
  }
}

/** Decoys fade at the start of the round after they were thrown + 1. */
export function expireDecoys(state, events) {
  for (const d of state.decoys.filter((d) => d.untilRound < state.round)) events.push({ type: 'decoy_end', decoyId: d.id });
  state.decoys = state.decoys.filter((d) => d.untilRound >= state.round);
}
