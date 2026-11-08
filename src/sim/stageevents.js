// Stage events ("Levolution", 5.0 spec §5, SIM-2) and building collapse.
//
// One set piece per match, per stage. Planned at createGame (round STAGE_EVENT.round = 6–8 from the
// seed), telegraphed at the start of the round before (stage_event_warn {kind, name, tiles, round}),
// then fired at the start of its round (stage_event {kind, name, tiles}) followed by cover_change,
// damage, knockback {id, path} and terrain_change {x, y, from, to} events.
//   harbor  ship      a container ship ploughs a 2-wide lane: 4 damage + shoved out of the lane,
//                     cover in the lane flattened, boats in it sunk, spilled containers (full cover) beside it
//                     and the wreck at the end of the lane.
//   kelp    redtide   a 5-wide band of toxic algae: 2 damage at the end of each squad's turn for 2 rounds
//                     (state.hazards; stage_event_end {kind} when it clears).
//   rig     collapse  a platform section (≤6×5) drops into the sea: 2 damage, cover gone, tiles become water.
//   spire   topple    a tower falls: the tower is gone, 4 damage + shoved aside along its fall line, water on
//                     the line becomes a walkable bridge, dry ground on it becomes rubble half cover.
//   surge   wave      a rogue wave hits a 5-deep band on the flooded side: 3 damage, knocked 2 tiles inland,
//                     loose half cover washed away.
// state.stageEvent = {kind, name, round, warnRound, status:'planned'|'warned'|'done', tiles|null}
// state.hazards = [{kind, tiles:[[x,y]], dmg, untilRound}]
//
// Building collapse: when 40% of a building's walls (its full-cover tiles at generation) are no
// longer full cover, the rest collapse to rubble half cover and everyone inside takes 3.
// Event building_collapse {id, kind, tiles} (then the cover_change and damage events).

import { hash32 } from './rng.js';
import { inBounds, dist } from './rules.js';
import { HOOKS, setCover, hurt } from './core.js';
import { TURN_HOOKS } from './turns.js';
import { damageVehicle } from './vehicles.js';

export const STAGE_EVENT = {
  round: [6, 8], // fired at the start of a round in this range; warned one round earlier
  harbor: { kind: 'ship', name: 'Runaway Freighter', desc: 'A container ship breaks loose and ploughs a lane through the docks.', dmg: 4 },
  kelp: { kind: 'redtide', name: 'Red Tide', desc: 'A toxic algae bloom: 2 damage per turn in the band for 2 rounds.', dmg: 2, rounds: 2 },
  rig: { kind: 'collapse', name: 'Platform Collapse', desc: 'A rig platform gives way and drops into the sea.', dmg: 2 },
  spire: { kind: 'topple', name: 'Tower Collapse', desc: 'A spire topples, leaving a rubble bridge over the water.', dmg: 4 },
  surge: { kind: 'wave', name: 'Rogue Wave', desc: 'A rogue wave slams a band of the map: 3 damage and knocked 2 tiles inland.', dmg: 3, push: 2 },
};
export const COLLAPSE = { threshold: 0.4, dmg: 3 };

// ---------- planning ----------

export function planStageEvent(state) {
  state.hazards = [];
  state.stageEvent = null;
  if (state.isPit) return;
  const def = STAGE_EVENT[state.stage];
  if (!def) return;
  const [lo, hi] = STAGE_EVENT.round;
  const round = lo + (hash32(state.seed, 0x1e7e1) % (hi - lo + 1));
  state.stageEvent = { kind: def.kind, name: def.name, desc: def.desc, round, warnRound: round - 1, status: 'planned', tiles: null };
}

/** Tiles every squad has been warned about (airstrikes, the coming stage event, live hazards). Set of keys. */
export function dangerTiles(state) {
  const S = state.map.size;
  const out = new Set();
  for (const a of state.airstrikes || []) for (const [x, y] of a.tiles) out.add(y * S + x);
  const ev = state.stageEvent;
  if (ev && ev.status === 'warned' && ev.tiles) for (const [x, y] of ev.tiles) out.add(y * S + x);
  for (const h of state.hazards || []) for (const [x, y] of h.tiles) out.add(y * S + x);
  return out;
}

const H = (state, ...k) => hash32(state.seed, 0x57a9e, ...k);
const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

/** Where the set piece will land. Aimed at the ring the fight is heading for. */
function pickTiles(state) {
  const ev = state.stageEvent;
  const { map, zone } = state;
  const S = map.size;
  const cx = zone.nx ?? zone.x, cy = zone.ny ?? zone.y;
  const tiles = [];
  const add = (x, y) => { if (inBounds(map, x, y)) tiles.push([x, y]); };
  const jitter = (n, m) => (H(state, n) % (2 * m + 1)) - m;
  switch (ev.kind) {
    case 'ship': {
      const horiz = H(state, 1) % 2 === 0;
      const fromLow = H(state, 2) % 2 === 0;
      const line = clampI((horiz ? cy : cx) + jitter(3, 4), 2, S - 4);
      const len = Math.min(S, 26);
      ev.axis = horiz ? 'x' : 'y'; ev.dir = fromLow ? 1 : -1; ev.line = line; ev.len = len;
      for (let i = 0; i < len; i++) {
        const along = fromLow ? i : S - 1 - i;
        for (let w = 0; w < 2; w++) (horiz ? add(along, line + w) : add(line + w, along));
      }
      break;
    }
    case 'redtide': {
      const horiz = H(state, 1) % 2 === 0;
      const mid = clampI((horiz ? cy : cx) + jitter(3, 3), 2, S - 3);
      for (let a = 0; a < S; a++) for (let w = -2; w <= 2; w++) (horiz ? add(a, mid + w) : add(mid + w, a));
      break;
    }
    case 'collapse': {
      const w = 6, h = 5;
      const x0 = clampI(cx + jitter(4, 5) - w / 2, 1, S - w - 1), y0 = clampI(cy + jitter(5, 5) - h / 2, 1, S - h - 1);
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) add(x, y);
      break;
    }
    case 'topple': {
      const towers = (map.buildings || []).filter((b) => !b.collapsed && b.walls.length);
      towers.sort((a, b) => (a.kind === 'tower' ? 0 : 1) - (b.kind === 'tower' ? 0 : 1)
        || dist(a.x0, a.y0, cx, cy) - dist(b.x0, b.y0, cx, cy) || a.id - b.id);
      const t = towers.find((b) => b.kind === 'tower') || towers[0];
      let ox, oy;
      if (t) { ev.building = t.id; ox = t.x0 + Math.floor(t.w / 2); oy = t.y0 + Math.floor(t.h / 2); }
      else { ox = clampI(cx, 2, S - 3); oy = clampI(cy, 2, S - 3); }
      // Fall where it bridges the most water (else towards the circle).
      let best = null;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        let water = 0, ok = 0;
        for (let i = 1; i <= 9; i++) {
          const x = ox + dx * i, y = oy + dy * i;
          if (!inBounds(map, x, y)) break;
          ok++;
          if (map.terrain[y * S + x] === 2) water++;
        }
        const score = water * 3 + ok - dist(ox + dx * 5, oy + dy * 5, cx, cy) * 0.2;
        if (!best || score > best.score) best = { dx, dy, score };
      }
      ev.dir = [best.dx, best.dy]; ev.origin = [ox, oy];
      for (let i = 1; i <= 9; i++) add(ox + best.dx * i, oy + best.dy * i);
      break;
    }
    case 'wave': {
      // The flooded side: the edge furthest from where the circle is going.
      const sides = [[cx, 0], [S - 1 - cx, 1], [cy, 2], [S - 1 - cy, 3]].sort((a, b) => b[0] - a[0] || a[1] - b[1]);
      const side = sides[0][1];
      ev.side = side;
      // Just inside the current ring on that side.
      const r = zone.r;
      const edge = side === 0 ? zone.x - r : side === 1 ? zone.x + r : side === 2 ? zone.y - r : zone.y + r;
      const lim = side === 0 || side === 2 ? clampI(edge, 0, S - 5) : clampI(edge - 4, 0, S - 5);
      for (let a = 0; a < S; a++) for (let d = 0; d < 5; d++) (side <= 1 ? add(lim + d, a) : add(a, lim + d));
      break;
    }
    default:
  }
  return tiles;
}

// ---------- effects ----------

const unitsOn = (state, set) => state.units.filter((u) => u.alive && set.has(u.y * state.map.size + u.x));
const tileBusy = (state, x, y) => {
  const S = state.map.size;
  return state.map.cover[y * S + x] > 0 || state.units.some((o) => o.alive && o.x === x && o.y === y)
    || (state.vehicles || []).some((v) => v.x === x && v.y === y) || (state.sentries || []).some((t) => t.x === x && t.y === y);
};

/** Shove a unit up to n tiles along (dx,dy), stopping at anything solid. Units aboard boats stay put. */
export function knockback(state, u, dx, dy, n, events) {
  if (!u.alive || u.vehicle != null) return;
  const path = [[u.x, u.y]];
  for (let i = 0; i < n; i++) {
    const x = u.x + dx, y = u.y + dy;
    if (!inBounds(state.map, x, y) || tileBusy(state, x, y)) break;
    u.x = x; u.y = y;
    path.push([x, y]);
  }
  if (path.length > 1) events.push({ type: 'knockback', id: u.id, path });
}

export function setTerrain(state, x, y, to, events) {
  const S = state.map.size;
  const from = state.map.terrain[y * S + x];
  if (from === to) return;
  state.map.terrain[y * S + x] = to;
  events.push({ type: 'terrain_change', x, y, from, to });
}

function damageAll(state, list, dmg, source, events) {
  for (const u of list) {
    if (state.winner !== null) return;
    if (u.alive) hurt(state, u, dmg, source, null, events);
  }
}

function damageBoats(state, set, dmg, events) {
  for (const v of [...(state.vehicles || [])]) {
    if (state.winner !== null) return;
    if (set.has(v.y * state.map.size + v.x)) damageVehicle(state, v, dmg, 'stage', null, events);
  }
}

function fire(state, events) {
  const ev = state.stageEvent;
  const def = STAGE_EVENT[state.stage];
  const { map } = state;
  const S = map.size;
  const tiles = ev.tiles;
  const set = new Set(tiles.map(([x, y]) => y * S + x));
  ev.status = 'done';
  events.push({ type: 'stage_event', kind: ev.kind, name: ev.name, tiles: tiles.map((t) => [...t]) });
  switch (ev.kind) {
    case 'ship': {
      const hit = unitsOn(state, set);
      damageAll(state, hit, def.dmg, 'stage', events);
      damageBoats(state, set, 99, events);
      // Shoved out of the lane, to whichever side is nearer.
      for (const u of hit) {
        const off = (ev.axis === 'x' ? u.y : u.x) - ev.line; // 0 or 1
        const d = off === 0 ? -1 : 1;
        knockback(state, u, ev.axis === 'x' ? 0 : d, ev.axis === 'x' ? d : 0, 2, events);
      }
      for (const [x, y] of tiles) setCover(state, x, y, 0, events);
      // Spilled containers alongside the lane, and the wreck where it runs aground.
      for (let i = 2; i < ev.len - 3; i += 4) {
        const along = ev.dir > 0 ? i : S - 1 - i;
        const side = (i / 4) % 2 < 1 ? ev.line - 1 : ev.line + 2;
        const [x, y] = ev.axis === 'x' ? [along, side] : [side, along];
        if (inBounds(map, x, y) && !tileBusy(state, x, y) && !state.crates.some((c) => !c.taken && c.x === x && c.y === y)) setCover(state, x, y, 2, events);
      }
      for (let i = ev.len - 2; i < ev.len; i++) {
        const along = ev.dir > 0 ? i : S - 1 - i;
        for (let w = 0; w < 2; w++) {
          const [x, y] = ev.axis === 'x' ? [along, ev.line + w] : [ev.line + w, along];
          if (inBounds(map, x, y) && !tileBusy(state, x, y) && !state.crates.some((c) => !c.taken && c.x === x && c.y === y)) setCover(state, x, y, 2, events);
        }
      }
      break;
    }
    case 'redtide': {
      state.hazards.push({ kind: 'redtide', tiles: tiles.map((t) => [...t]), dmg: def.dmg, untilRound: state.round + def.rounds });
      break;
    }
    case 'collapse': {
      damageAll(state, unitsOn(state, set), def.dmg, 'stage', events);
      for (const [x, y] of tiles) {
        if (map.explosive) map.explosive[y * S + x] = 0;
        setCover(state, x, y, 0, events);
        setTerrain(state, x, y, 2, events);
      }
      break;
    }
    case 'topple': {
      const b = ev.building !== undefined ? map.buildings[ev.building] : null;
      if (b) {
        b.collapsed = true;
        for (const k of b.walls) setCover(state, k % S, (k / S) | 0, 0, events);
      }
      const hit = unitsOn(state, set);
      damageAll(state, hit, def.dmg, 'stage', events);
      const [dx, dy] = ev.dir;
      for (const u of hit) {
        // Sideways out from under it (alternating by id).
        const s = u.id % 2 ? 1 : -1;
        knockback(state, u, dy * s, dx * s, 1, events);
      }
      for (const [x, y] of tiles) {
        const k = y * S + x;
        if (map.terrain[k] === 2) {
          setCover(state, x, y, 0, events);
          setTerrain(state, x, y, 0, events); // the bridge deck
        } else if (!tileBusy(state, x, y) && !state.crates.some((c) => !c.taken && c.x === x && c.y === y)) {
          setCover(state, x, y, 1, events);
        } else if (map.cover[k] === 2) setCover(state, x, y, 1, events);
      }
      break;
    }
    case 'wave': {
      const hit = unitsOn(state, set);
      damageAll(state, hit, def.dmg, 'stage', events);
      const [dx, dy] = [[1, 0], [-1, 0], [0, 1], [0, -1]][ev.side];
      // Furthest inland first, so nobody blocks the unit behind it.
      hit.sort((a, b) => (b.x * dx + b.y * dy) - (a.x * dx + a.y * dy));
      for (const u of hit) knockback(state, u, dx, dy, def.push, events);
      for (const [x, y] of tiles) {
        const k = y * S + x;
        if (map.cover[k] === 1 && !(map.explosive && map.explosive[k]) && !(map.building && map.building[k] >= 0)) setCover(state, x, y, 0, events);
      }
      break;
    }
    default:
  }
}

TURN_HOOKS.roundStart.push((state, events) => {
  if (state.isPit || state.winner !== null) return;
  // Hazards clear.
  for (const h of (state.hazards || []).filter((x) => x.untilRound <= state.round)) events.push({ type: 'stage_event_end', kind: h.kind });
  if (state.hazards) state.hazards = state.hazards.filter((x) => x.untilRound > state.round);
  const ev = state.stageEvent;
  if (!ev || ev.status === 'done') return;
  if (ev.status === 'planned' && state.round >= ev.warnRound) {
    ev.tiles = pickTiles(state);
    ev.status = 'warned';
    events.push({ type: 'stage_event_warn', kind: ev.kind, name: ev.name, tiles: ev.tiles.map((t) => [...t]), round: ev.round });
  }
  if (ev.status === 'warned' && state.round >= ev.round) fire(state, events);
});

// Red tide: 2 damage at the end of each squad's own turn to its units in the band.
TURN_HOOKS.teamEnd.push((state, team, events) => {
  if (!state.hazards || !state.hazards.length) return;
  const S = state.map.size;
  for (const h of state.hazards) {
    const set = new Set(h.tiles.map(([x, y]) => y * S + x));
    for (const id of state.teams[team].members) {
      const u = state.units[id];
      if (!u.alive || !set.has(u.y * S + u.x)) continue;
      hurt(state, u, h.dmg, h.kind, null, events);
      if (state.winner !== null) return;
    }
  }
});

// ---------- building collapse ----------

function collapse(state, b, events) {
  const { map } = state;
  const S = map.size;
  b.collapsed = true;
  const left = b.walls.filter((k) => map.cover[k] === 2);
  events.push({ type: 'building_collapse', id: b.id, kind: b.kind, tiles: left.map((k) => [k % S, (k / S) | 0]) });
  for (const k of left) setCover(state, k % S, (k / S) | 0, 1, events);
  const inside = new Set(b.floor);
  for (let y = b.y0 + 1; y < b.y0 + b.h - 1; y++) for (let x = b.x0 + 1; x < b.x0 + b.w - 1; x++) {
    if (inBounds(map, x, y) && map.building[y * S + x] === b.id) inside.add(y * S + x);
  }
  for (const u of state.units) {
    if (state.winner !== null) return;
    if (u.alive && inside.has(u.y * S + u.x)) hurt(state, u, COLLAPSE.dmg, 'collapse', null, events);
  }
}

HOOKS.onCoverChange.push((state, x, y, from, to, events) => {
  const { map } = state;
  if (!map.building || !map.buildings || from !== 2 || to >= 2) return;
  const b = map.buildings[map.building[y * map.size + x]];
  if (!b || b.collapsed || !b.walls.length) return;
  const broken = b.walls.filter((k) => map.cover[k] < 2).length;
  if (broken >= Math.ceil(b.walls.length * COLLAPSE.threshold)) collapse(state, b, events);
});

