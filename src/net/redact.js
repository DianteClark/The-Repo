// Fog-of-war redaction for host-authoritative online play. Pure logic (no DOM): runs on the host
// and in node tests (src/net/redact.test.mjs).
//
// For each client team the host keeps a TeamMemory and calls teamView(state, events, mem) after
// every batch of sim events. It returns:
//   events: only what that team can perceive, positions trimmed to what it saw, private fields stripped;
//           plus synthetic `cover_change {discovered:true}` for terrain changes it discovers later.
//   snap:   a redacted snapshot of the state (same shape as the sim state, so the renderer and UI can
//           use it as a read-only mirror):
//           - enemy units the team can't see: {hidden:true, x:PARK, y:PARK}, no hp/items/loadout
//           - visible enemy units: public fields only (no items, ammo, AP, cooldowns, perks, streaks…)
//           - crates: contents stripped ('crate' | 'cache' | 'gold'); taken/new status only as last seen
//           - cover / barrels: as last seen by the team
//           - no seed, roll counter or future zone plan; only the team's own scans
// Eliminated teams (and team -1) are spectators: every position is visible, privates still stripped.

import * as Rules from '../sim/rules.js';

export const PARK = -99; // where hidden units are parked in a redacted snapshot (never visible)

// Unit fields any team may see on a visible enemy. Everything else is private.
const PUBLIC_UNIT = new Set([
  'id', 'team', 'cls', 'name', 'isLoneWolf', 'isHuman', 'x', 'y', 'hp', 'maxHp', 'armor', 'alive', 'downed', 'bleed',
  'overwatch', 'hunkered', 'suppressed', 'flashed', 'smoked', 'aboard', 'vehicle', 'skin', 'cosmetics', 'flared',
  'pit', 'inPit', 'redeployed', 'boat', 'slot', 'slowed', 'suppressedBy', 'tracked',
]);
// Unit fields kept even for a hidden enemy (who is in the match is public: lobby, kill feed).
const ALWAYS_UNIT = ['id', 'team', 'cls', 'name', 'isLoneWolf', 'isHuman', 'alive', 'maxHp', 'skin', 'cosmetics'];
// Weapon fields visible on the model.
const PUBLIC_WEAPON = new Set(['id', 'name', 'cat', 'legendary', 'gold', 'attachments', 'camo', 'charm', 'special', 'range']);
// Top-level state keys never sent to any client.
const SECRET_STATE = new Set(['seed', 'rollCounter', 'rng', 'zonePlan', 'startEvents', 'ai', 'botMemory', 'memory', 'nextSmokeId',
 'nextEquipId', 'nextStreakId', 'nextVehicleId', 'nextDuelId', 'noises' /* heard gunfire incl. decoys: clients get it as noise events */]);
// Top-level lists only the owning squad may see (traps, fakes, inbound care packages).
const OWN_ONLY_STATE = new Set(['claymores', 'decoys', 'drops', 'cuav']);
// Crate kinds that look different from outside (everything else is just "a crate").
const crateLook = (c) => (c.gold || c.legendary || c.type === 'gold' || c.type === 'legendary' ? 'gold' : c.type === 'cache' ? 'cache' : c.carePackage || c.type === 'care' ? 'care' : 'crate');

const standing = (u) => !!u && u.alive && !u.downed;
const inMap = (st, x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < st.map.size && y < st.map.size;

// ------------------------------------------------------------------ vision

/** Is `team` a spectator (out of the match, or no team)? */
export function isSpectatorTeam(state, team) {
  if (team === null || team === undefined || team < 0 || !state.teams[team]) return true;
  if (state.eliminated?.includes(team)) return true;
  return !state.teams[team].members.some((id) => state.units[id]?.alive);
}

/** Tiles the team's standing units see (Uint8Array, 1 = seen). */
export function teamTiles(state, team) {
  const S = state.map.size;
  const out = new Uint8Array(S * S);
  const sight = Math.ceil(Rules.sightOf ? Rules.sightOf(state.map) : 10);
  for (const u of state.units) {
    if (u.team !== team || !standing(u) || !inMap(state, u.x, u.y)) continue;
    for (let y = Math.max(0, u.y - sight); y <= Math.min(S - 1, u.y + sight); y++) {
      for (let x = Math.max(0, u.x - sight); x <= Math.min(S - 1, u.x + sight); x++) {
        const k = y * S + x;
        if (!out[k] && Rules.canSeeTile(state.map, u.x, u.y, x, y)) out[k] = 1;
      }
    }
  }
  return out;
}

/** A vision helper for one team at one moment. `pos` optionally overrides unit positions. */
export function vision(state, team, pos = null) {
  if (isSpectatorTeam(state, team)) return { all: true, tile: () => true, unit: () => true };
  // A light view of the state with overridden positions (for "at the time of this event").
  let vs = state;
  if (pos && pos.size) {
    vs = Object.create(state);
    vs.units = state.units.map((u) => (pos.has(u.id) ? { ...u, x: pos.get(u.id)[0], y: pos.get(u.id)[1] } : u));
  }
  let tiles = null;
  const tile = (x, y) => {
    if (!inMap(state, x, y)) return false;
    if (!tiles) tiles = teamTiles(vs, team);
    return tiles[y * state.map.size + x] === 1;
  };
  const unit = (id, at = null) => {
    const u = vs.units[id];
    if (!u) return false;
    if (u.team === team) return true;
    const t = at ? { ...u, x: at[0], y: at[1] } : u;
    if (!inMap(state, t.x, t.y)) return false;
    if (!u.alive) return tile(t.x, t.y); // a body: seen where the tile is seen
    try { return !!Rules.teamSeesUnit(vs, team, t); } catch { return tile(t.x, t.y); }
  };
  return { all: false, tile, unit, vs };
}

// ------------------------------------------------------------------ memory

/** Per-team knowledge the host keeps across batches (cover, barrels, crates as last seen). */
export function createTeamMemory(state, team) {
  return {
    team,
    cover: state.map.cover ? Uint8Array.from(state.map.cover) : null,
    explosive: state.map.explosive ? Uint8Array.from(state.map.explosive) : null,
    // Initial crates are public (props on the map); later drops are learned when seen.
    crates: new Map((state.crates || []).filter((c) => !c.taken).map((c) => [c.id, { id: c.id, x: c.x, y: c.y, type: crateLook(c), taken: false, dropped: !!c.dropped }])),
    // Boats are map objects: their spawn spots are public; afterwards, as last seen.
    vehicles: new Map((state.vehicles || []).map((v) => [v.id, { id: v.id, kind: v.kind, x: v.x, y: v.y, hp: v.hp, maxHp: v.maxHp, seats: [], stale: true }])),
    decoys: new Set(),
  };
}

// ------------------------------------------------------------------ snapshot

function ownerTeam(state, o) {
  if (!o || typeof o !== 'object') return undefined;
  if (Number.isInteger(o.team)) return o.team;
  for (const k of ['owner', 'ownerId', 'by', 'unit', 'unitId']) if (Number.isInteger(o[k]) && state.units[o[k]]) return state.units[o[k]].team;
  return undefined;
}

function redactUnit(state, u, team, vis, myUnitId) {
  const mine = u.team === team;
  if (mine || vis.all) {
    const o = mine ? structuredClone(u) : pick(u, PUBLIC_UNIT);
    if (!mine && u.weapon) o.weapon = pick(u.weapon, PUBLIC_WEAPON);
    o.isPlayer = u.id === myUnitId;
    return o;
  }
  const seen = vis.unit(u.id);
  if (!seen) {
    const o = pick(u, new Set(ALWAYS_UNIT));
    o.hidden = true;
    o.x = PARK; o.y = PARK;
    o.hp = u.alive ? u.maxHp : 0;
    o.downed = false;
    o.isPlayer = false;
    return o;
  }
  const o = pick(u, PUBLIC_UNIT);
  if (u.weapon) o.weapon = pick(u.weapon, PUBLIC_WEAPON);
  o.isPlayer = false;
  return o;
}

function pick(o, keys) {
  const r = {};
  for (const k of keys) if (o[k] !== undefined) r[k] = typeof o[k] === 'object' && o[k] !== null ? structuredClone(o[k]) : o[k];
  return r;
}

/**
 * Redacted snapshot of `state` for `team`. `mem` (TeamMemory) is updated with what the team sees now.
 * myUnitId marks which unit is "me" (isPlayer) on that client.
 */
export function redactSnapshot(state, team, mem, { myUnitId = -1, vis = vision(state, team) } = {}) {
  const S = state.map.size;
  const snap = {};
  for (const k of Object.keys(state)) {
    if (SECRET_STATE.has(k) || k.startsWith('_')) continue;
    const v = state[k];
    switch (k) {
      case 'map': snap.map = redactMap(state, mem, vis); break;
      case 'units': snap.units = state.units.map((u) => redactUnit(state, u, team, vis, myUnitId)); break;
      case 'teams': snap.teams = state.teams.map((t) => ({ id: t.id, members: [...t.members], isLoneWolf: !!t.isLoneWolf, name: t.name, out: t.out })); break;
      case 'crates': snap.crates = redactCrates(state, mem, vis); break;
      case 'reveals': snap.reveals = vis.all ? [] : (v || []).filter((r) => r.team === team).map((r) => structuredClone(r)); break;
      case 'zone': snap.zone = { ...v }; break;
      case 'pit': snap.pit = redactPit(state, v, team, myUnitId); break;
      case 'vehicles': snap.vehicles = redactVehicles(state, v, team, vis, mem); break;
      case 'blockers': snap.blockers = vis.all ? [...(v || [])] : (v || []).filter((k) => vis.tile(k % state.map.size, (k / state.map.size) | 0)
        || [...mem.vehicles.values()].some((b) => b.y * state.map.size + b.x === k)); break;
      case 'stageEvent': snap.stageEvent = !v || typeof v !== 'object' ? v : v.status === 'planned' && !vis.all ? { status: 'planned' } : structuredClone(v); break;
      case 'playerTeam': snap.playerTeam = team; break;
      case 'humanTeams': snap.humanTeams = Array.isArray(v) ? [...v] : v; break;
      case 'turn': snap.turn = redactTurn(v, team, vis); break;
      case 'claymores': case 'decoys': case 'drops': case 'cuav':
        snap[k] = vis.all ? [] : (Array.isArray(v) ? v.filter((o) => ownerTeam(state, o) === team).map((o) => structuredClone(o)) : []);
        break;
      default: snap[k] = genericRedact(state, v, team, vis, k);
    }
  }
  if (!('playerTeam' in snap)) snap.playerTeam = team;
  void S;
  return snap;
}

/** Engagement bookkeeping: only my own group / step membership. */
function redactTurn(t, team, vis) {
  if (!t || typeof t !== 'object') return t;
  if (vis.all) return structuredClone(t);
  const mineGroup = (t.groups || []).find((g) => g.includes(team)) || [team];
  const keep = (arr) => (Array.isArray(arr) ? arr.filter((x) => mineGroup.includes(x)) : arr);
  return {
    step: t.step,
    steps: Array.isArray(t.steps) ? t.steps.map((s) => keep(s)) : t.steps,
    stepCount: Array.isArray(t.steps) ? t.steps.length : undefined,
    groups: (t.groups || []).filter((g) => g.includes(team)).map((g) => [...g]),
    free: (t.free || []).includes(team) ? [team] : [],
    active: keep(t.active), activeCount: (t.active || []).length,
    done: keep(t.done),
  };
}

function redactMap(state, mem, vis) {
  const m = state.map;
  const out = {};
  for (const k of Object.keys(m)) {
    if (k === 'cover' || k === 'explosive') continue;
    const v = m[k];
    out[k] = ArrayBuffer.isView(v) ? v.slice() : (v && typeof v === 'object' ? structuredClone(v) : v);
  }
  if (vis.all) {
    if (m.cover) out.cover = m.cover.slice();
    if (m.explosive) out.explosive = m.explosive.slice();
    return out;
  }
  // Memory is refreshed for visible tiles by teamView() before the snapshot is taken.
  if (m.cover) out.cover = mem.cover.slice();
  if (m.explosive) out.explosive = mem.explosive.slice();
  return out;
}

function redactCrates(state, mem, vis) {
  if (vis.all) return (state.crates || []).map((c) => ({ id: c.id, x: c.x, y: c.y, type: crateLook(c), taken: !!c.taken, dropped: !!c.dropped }));
  const out = [];
  for (const c of mem.crates.values()) out.push({ ...c });
  return out.sort((a, b) => a.id - b.id);
}

function redactPlaced(state, list, team, vis) {
  if (!Array.isArray(list)) return list;
  return list.map((o) => {
    if (!o || typeof o !== 'object') return o;
    const aboardMine = Array.isArray(o.seats) && o.seats.some((id) => state.units[id]?.team === team);
    if (vis.all || aboardMine || vis.tile(o.x, o.y)) return structuredClone(o);
    return { id: o.id, kind: o.kind, hidden: true, x: PARK, y: PARK };
  });
}

/** Boats: visible (or carrying my squad) → live, seats limited to units I can see; otherwise as last seen. */
function redactVehicles(state, list, team, vis, mem) {
  if (!Array.isArray(list)) return list;
  const live = new Set();
  const out = [];
  for (const v of list) {
    live.add(v.id);
    const aboardMine = Array.isArray(v.seats) && v.seats.some((id) => state.units[id]?.team === team);
    if (vis.all || aboardMine || vis.tile(v.x, v.y)) {
      const o = structuredClone(v);
      if (!vis.all) o.seats = (v.seats || []).filter((id) => state.units[id]?.team === team || vis.unit(id));
      if (!vis.all && !aboardMine) delete o.fuel; // fuel is the crew's business
      if (mem) mem.vehicles.set(v.id, { id: v.id, kind: v.kind, x: v.x, y: v.y, hp: v.hp, maxHp: v.maxHp, seats: [], stale: true });
      out.push(o);
    } else if (mem?.vehicles.has(v.id)) {
      out.push({ ...mem.vehicles.get(v.id), seats: [] });
    }
  }
  // A boat I last saw but which is now gone: forget it only once its tile is in view.
  if (mem) for (const [id, b] of mem.vehicles) if (!live.has(id) && (vis.all || vis.tile(b.x, b.y))) mem.vehicles.delete(id);
  if (mem && !vis.all) for (const [id, b] of mem.vehicles) if (!live.has(id)) out.push({ ...b, seats: [] });
  return out.sort((a, b) => a.id - b.id);
}

function redactPit(state, pit, team, myUnitId) {
  if (!pit || typeof pit !== 'object') return pit;
  const mine = (id) => id === myUnitId || state.units[id]?.team === team;
  return {
    queue: Array.isArray(pit.queue) ? pit.queue.filter((id) => mine(id)) : [],
    duels: (pit.duels || []).map((d) => {
      const o = { id: d.id, a: d.a, b: d.b, warden: !!d.warden, winner: d.winner ?? null, loser: d.loser ?? null, done: !!d.done };
      if ((d.a === myUnitId || d.b === myUnitId) && d.state) {
        // The duel is a mini game: redact it from my side's point of view.
        const ds = d.state;
        const did = d.units?.[myUnitId];
        const me = did !== undefined ? ds.units[did] : ds.units?.find((u) => u.srcId === myUnitId);
        const dteam = me ? me.team : -1;
        o.state = redactSnapshot(ds, dteam, createTeamMemory(ds, dteam), { myUnitId: me ? me.id : -1 });
      }
      return o;
    }),
  };
}

// Unknown state keys (added by later sim work): keep public scalars; for arrays of placed things
// (claymores, sentries, airstrike marks…) keep own-team items and items on tiles the team sees.
function genericRedact(state, v, team, vis, key) {
  if (v === null || typeof v !== 'object') return v;
  if (ArrayBuffer.isView(v)) return v.slice();
  if (Array.isArray(v)) {
    // engagement groups ([[t,…],…]): only the group the team is part of
    if (v.length && v.every((g) => Array.isArray(g) && g.every((n) => Number.isInteger(n)))) {
      return vis.all ? structuredClone(v) : v.filter((g) => g.includes(team)).map((g) => [...g]);
    }
    if (key === 'order' || key === 'eliminated' || key === 'flares' || key === 'smokes' || key === 'active' || key === 'activeTeams') return structuredClone(v);
    return v.filter((o) => {
      if (!o || typeof o !== 'object') return true;
      if (vis.all) return true;
      const ot = ownerTeam(state, o);
      if (ot === team) return true;
      if (o.public || o.telegraphed) return true;
      if (Number.isFinite(o.x) && Number.isFinite(o.y)) return vis.tile(o.x, o.y);
      if (Array.isArray(o.tiles)) return true; // telegraphed areas (airstrike marks, stage events)
      return ot === undefined;
    }).map((o) => (o && typeof o === 'object' ? stripPrivate(structuredClone(o), ownerTeam(state, o) === team || vis.all) : o));
  }
  // A per-team / per-unit dictionary? keep only my team's entry when keys are team ids.
  return structuredClone(v);
}

function stripPrivate(o, mine) {
  if (mine) return o;
  for (const k of ['items', 'loadout', 'perks', 'streaks', 'ammo', 'charges', 'contents', 'item', 'weapon', 'secret']) delete o[k];
  return o;
}

// ------------------------------------------------------------------ events

/**
 * Positions of every unit just before each event: walk the batch backwards from the final state,
 * undoing moves, then forwards. Returns an array of Map(id → [x,y]) snapshots (only moved units).
 */
function positionsTimeline(state, events) {
  const cur = new Map();
  const at = (id) => cur.get(id) || [state.units[id]?.x, state.units[id]?.y];
  const movers = (ev) => (ev.type === 'move' || ev.type === 'knockback') && Number.isInteger(ev.id) && Array.isArray(ev.path) && ev.path.length;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (movers(ev)) cur.set(ev.id, [...ev.path[0]]);
    else if (ev.type === 'redeploy' && Number.isInteger(ev.id)) cur.set(ev.id, [PARK, PARK]);
  }
  const out = [];
  for (const ev of events) {
    out.push(new Map(cur));
    if (movers(ev)) cur.set(ev.id, [...ev.path[ev.path.length - 1]]);
    else if (ev.type === 'redeploy' && Number.isInteger(ev.id)) cur.set(ev.id, [ev.x, ev.y]);
  }
  void at;
  return out;
}

// Owner-only even for spectators: loadout/streak bookkeeping and hidden gadgets.
const PRIVATE_EVENTS = new Set(['streak_points', 'streak_ready', 'claymore', 'decoy', 'decoy_end', 'care_package_called', 'tracked',
  'scavenge', 'run_gun_ready', 'reload', 'swap', 'reveal_end']);

const PUBLIC_EVENTS = new Set([
  'round_start', 'zone_shrink', 'game_over', 'team_out', 'turn_start', 'death', 'flare', 'flare_end', 'smoke_clear',
  'supply_drop', 'airstrike_mark', 'airstrike', 'stage_event_warn', 'stage_event', 'gunship_start', 'gunship_end',
  'pit_enter', 'pit_duel', 'pit_result', 'pit_out', 'zone_warn', 'stage_event_end', 'terrain_change', 'round_end', 'match_start', 'building_collapse',
]);

/**
 * Filter one batch of events for `team`. Pure: needs the post-batch state (as the sim leaves it).
 * opts.mem (TeamMemory) receives included cover changes.
 */
export function filterEvents(state, events, team, { mem = null, myUnitId = -1 } = {}) {
  if (!Array.isArray(events) || !events.length) return [];
  const spectator = isSpectatorTeam(state, team);
  const timeline = spectator ? null : positionsTimeline(state, events);
  const out = [];
  const mine = (id) => Number.isInteger(id) && state.units[id]?.team === team;
  ctxHasNoise = Array.isArray(state.noises);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || typeof ev.type !== 'string') continue;
    if (spectator && ev.type === 'noise') { out.push({ type: 'noise', kind: ev.kind || 'gunfire', x: ev.x, y: ev.y }); continue; }
    if (spectator && PRIVATE_EVENTS.has(ev.type) && !mine(ev.id) && ev.team !== team) continue;
    if (spectator) { out.push(scrubEvent(state, ev, team, mine(ev.id) && !ev.to && !ev.target)); continue; }
    const vis = vision(state, team, timeline[i]);
    let src = ev;
    if (mem) {
      mem.decoys ||= new Set();
      // Stage events and collapses are loud and public: the map changes they cause are known to all.
      if ((ev.type === 'cover_change' && ev.stage) && mem.cover && inMap(state, ev.x, ev.y)) mem.cover[ev.y * state.map.size + ev.x] = ev.to;
      if (ev.type === 'decoy' && mine(ev.id)) mem.decoys.add(ev.decoyId);
      if (ev.type === 'decoy_end') { src = { ...ev, _mine: mem.decoys.has(ev.decoyId) || undefined }; mem.decoys.delete(ev.decoyId); }
    }
    const r = filterOne(state, src, team, vis, mine, myUnitId);
    if (r && !Array.isArray(r)) delete r._mine;
    if (!r) continue;
    for (const e of Array.isArray(r) ? r : [r]) {
      if (mem && e.type === 'cover_change' && mem.cover && inMap(state, e.x, e.y)) mem.cover[e.y * state.map.size + e.x] = e.to;
      if (mem && e.type === 'barrel' && mem.explosive && inMap(state, e.x, e.y)) mem.explosive[e.y * state.map.size + e.x] = 0;
      out.push(e);
    }
  }
  return out;
}

function scrubEvent(state, ev, team, full) {
  const e = structuredClone(ev);
  if (e.type === 'crate' && !full && state.units[e.id]?.team !== team) for (const k of ['item', 'weapon', 'attachment', 'legendary', 'slot']) delete e[k];
  if (e.crate && typeof e.crate === 'object') e.crate = { id: e.crate.id, x: e.crate.x, y: e.crate.y, type: crateLook(e.crate), dropped: !!e.crate.dropped };
  if (!full) for (const k of ['loadout', 'perks', 'streaks', 'items', 'ammo', 'spare', 'seed', 'roll', 'points', 'charges']) delete e[k];
  return e;
}

let ctxHasNoise = false;
function filterOne(state, ev, team, vis, mine, myUnitId) {
  const t = ev.type;
  const unitSeen = (id) => Number.isInteger(id) && (mine(id) || vis.unit(id));
  switch (t) {
    case 'noise': {
      // Unseen gunfire: my squad's own noise as is; anyone else's (decoys included: their id:null
      // would give them away) as an anonymous ping on a coarse 3-tile grid.
      if (Number.isInteger(ev.id) && mine(ev.id)) return scrubEvent(state, ev, team, true);
      if (ev.decoy !== undefined || ev.id === null || ev.id === undefined) {
        const d = state.decoys?.find((x) => x.x === ev.x && x.y === ev.y);
        if (d && d.team === team) return scrubEvent(state, ev, team, true);
      }
      if (!Number.isFinite(ev.x) || !Number.isFinite(ev.y)) return null;
      const S = state.map.size;
      return { type: 'noise', kind: ev.kind === 'gunfire' || !ev.kind ? 'gunfire' : ev.kind, x: Math.min(S - 1, Math.round(ev.x / 3) * 3 + 1), y: Math.min(S - 1, Math.round(ev.y / 3) * 3 + 1) };
    }
    case 'claymore': case 'decoy': case 'decoy_end': case 'care_package_called': case 'cuav': case 'cuav_end': case 'streak_points':
    case 'run_gun_ready': case 'scavenge': {
      const owner = ev.id ?? ev.by ?? ev.owner;
      const own = (Number.isInteger(owner) && mine(owner)) || ev.team === team || ev._mine;
      if (own) return scrubEvent(state, ev, team, true);
      if (t === 'cuav') return { type: t, team: ev.team, enemy: true };
      return null;
    }
    case 'tracked': return ev.team === team ? scrubEvent(state, ev, team, true) : null;
    case 'engagement': {
      const groups = (ev.groups || []).filter((g) => g.includes(team));
      return { type: t, groups, free: (ev.free || []).includes(team) ? [team] : [], count: (ev.groups || []).length, freeCount: (ev.free || []).length };
    }
    case 'step_start': return { type: t, step: ev.step, active: (ev.active || []).filter((x) => x === team || state.teams[x]?.members.some((id) => vis.unit(id))), activeCount: (ev.active || []).length };
    case 'move': case 'knockback': {
      if (mine(ev.id)) return scrubEvent(state, ev, team, true);
      // Split the path into runs of tiles where the mover is visible.
      const runs = [];
      let run = null;
      for (const p of ev.path || []) {
        const seen = vis.unit(ev.id, p);
        if (seen) { if (!run) runs.push(run = []); run.push([p[0], p[1]]); } else run = null;
      }
      if (!runs.length) return null;
      return runs.map((path) => ({ ...scrubEvent(state, ev, team, false), path, partial: path.length !== ev.path.length || undefined }));
    }
    case 'shot': case 'sentry_shot': case 'gunship_shot': {
      const from = ev.from ?? ev.id, to = ev.to ?? ev.target;
      const sSeen = unitSeen(from), tSeen = unitSeen(to);
      if (!sSeen && !tSeen) {
        // 5.0 sims announce unseen gunfire themselves with 'noise' events (silencers make none).
        if (ev.silent || ev.suppressed || t !== 'shot' || ctxHasNoise) return null;
        const s = state.units[from];
        const p = vis.vs?.units?.[from] || s;
        if (!s || !inMap(state, p.x, p.y)) return null;
        // Heard, not seen: a rough ping on a 3-tile grid (the same rounding the renderer uses).
        const S = state.map.size;
        const px = Math.min(S - 1, Math.round(p.x / 3) * 3 + 1), py = Math.min(S - 1, Math.round(p.y / 3) * 3 + 1);
        return { type: 'ping', kind: 'gunfire', x: px, y: py };
      }
      const e = scrubEvent(state, ev, team, false);
      if (!sSeen && Number.isInteger(from)) {
        // Firing at someone you can see reveals the shooter for the shot (the local game shows them too).
        const p = vis.vs?.units?.[from] || state.units[from];
        e.fx = p.x; e.fy = p.y;
      }
      if (!tSeen) { e.result = 'miss'; e.dmg = 0; e.downed = false; e.hiddenTarget = true; }
      return e;
    }
    case 'overwatch_trigger':
      return unitSeen(ev.id) || unitSeen(ev.target) ? withShooterPos(state, ev, team, vis, ev.id) : null;
    case 'grenade': case 'smoke': case 'breach': case 'barrel_shot': case 'semtex': case 'knife': case 'flashbang': case 'claymore_placed': case 'deploy_cover': {
      const actor = ev.id ?? ev.by;
      if (mine(actor)) return scrubEvent(state, ev, team, true);
      if (t === 'claymore_placed') return null; // traps stay secret until seen as objects in the snapshot
      if (!unitSeen(actor) && !vis.tile(ev.x, ev.y)) return null;
      return withShooterPos(state, ev, team, vis, actor);
    }
    case 'scan': {
      if (mine(ev.id)) return scrubEvent(state, ev, team, true);
      const revealedMine = (ev.revealed || []).filter((id) => mine(id));
      if (!unitSeen(ev.id) && !revealedMine.length) return null;
      const e = withShooterPos(state, ev, team, vis, ev.id);
      e.revealed = revealedMine;
      return e;
    }
    case 'uav': case 'counter_uav':
      return ev.team === team ? scrubEvent(state, ev, team, true) : { type: t, team: ev.team, enemy: true };
    case 'reveal_end': case 'streak_ready': case 'streak_used': case 'reload': case 'swap': case 'equip':
      return mine(ev.id) || ev.team === team ? scrubEvent(state, ev, team, true)
        : (t === 'streak_used' ? { type: t, id: ev.id, key: ev.key, enemy: true } : null);
    case 'cover_change': case 'barrel':
      return vis.tile(ev.x, ev.y) ? scrubEvent(state, ev, team, false) : null;
    case 'crate_drop': case 'care_package': {
      const c = ev.crate || ev;
      const ok = mine(ev.by ?? ev.id) || vis.tile(c.x, c.y);
      return ok ? scrubEvent(state, ev, team, false) : null;
    }
    case 'death':
      return { type: 'death', id: ev.id, by: ev.by ?? null, seen: unitSeen(ev.id) || undefined };
    case 'team_out': case 'game_over': case 'round_start': case 'turn_start': case 'zone_shrink':
      return scrubEvent(state, ev, team, false);
    case 'redeploy':
      return mine(ev.id) || vis.tile(ev.x, ev.y) ? scrubEvent(state, ev, team, false) : { type: 'redeploy', id: ev.id, hidden: true };
    case 'pit_enter': case 'pit_duel': case 'pit_result': case 'pit_out':
      return scrubEvent(state, ev, team, false);
    case 'board': case 'disembark': case 'boat_move': case 'vehicle_damage': case 'vehicle_destroyed': case 'repair': case 'shot_vehicle': {
      const vid = t === 'boat_move' || t.startsWith('vehicle_') ? ev.id : ev.vehicle;
      const actor = t === 'boat_move' ? ev.driver : t === 'shot_vehicle' ? ev.from : t.startsWith('vehicle_') ? undefined : ev.id;
      const v = state.vehicles?.find((b) => b.id === vid);
      if (Number.isInteger(actor) && mine(actor)) return scrubEvent(state, ev, team, true);
      if (v && v.seats?.some((id) => mine(id))) return scrubEvent(state, ev, team, true);
      if (t === 'shot_vehicle') {
        if (unitSeen(actor) || (v && vis.tile(v.x, v.y))) return withShooterPos(state, ev, team, vis, actor);
        return null;
      }
      if (Number.isInteger(actor) && unitSeen(actor) && t !== 'boat_move') { const e = scrubEvent(state, ev, team, false); delete e.fuel; return e; }
      if (Array.isArray(ev.path)) {
        const path = ev.path.filter(([x, y]) => vis.tile(x, y));
        if (!path.length) return null;
        const e = { ...scrubEvent(state, ev, team, false), path };
        delete e.fuel; delete e.driver;
        return e;
      }
      if (Number.isFinite(ev.x) && Number.isFinite(ev.y)) return vis.tile(ev.x, ev.y) ? scrubEvent(state, ev, team, false) : null;
      if (v && vis.tile(v.x, v.y)) { const e = scrubEvent(state, ev, team, false); delete e.fuel; return e; }
      return null;
    }
    default: {
      if (PUBLIC_EVENTS.has(t)) return scrubEvent(state, ev, team, false);
      // Generic: anything about a unit is visible if that unit is (or any unit it touches is mine);
      // anything at a tile is visible if the tile is; team-tagged events go to that team only.
      const ids = ['id', 'target', 'by', 'from', 'to', 'unit'].map((k) => ev[k]).filter((v) => Number.isInteger(v) && state.units[v]);
      if (ids.length) {
        if (ids.some((id) => mine(id))) return scrubEvent(state, ev, team, ids.every((id) => mine(id)));
        return ids.some((id) => vis.unit(id)) ? scrubEvent(state, ev, team, false) : null;
      }
      if (Number.isFinite(ev.x) && Number.isFinite(ev.y)) return vis.tile(ev.x, ev.y) ? scrubEvent(state, ev, team, false) : null;
      if (Number.isInteger(ev.team)) return ev.team === team ? scrubEvent(state, ev, team, true) : null;
      if (Array.isArray(ev.tiles)) return scrubEvent(state, ev, team, false);
      return null; // unknown and unplaceable: safest to drop
    }
  }
}

function withShooterPos(state, ev, team, vis, id) {
  const e = scrubEvent(state, ev, team, false);
  if (Number.isInteger(id) && state.units[id] && state.units[id].team !== team && !vis.unit(id)) {
    const p = vis.vs?.units?.[id] || state.units[id];
    e.fx = p.x; e.fy = p.y;
  }
  return e;
}

// ------------------------------------------------------------------ the one-call API

/**
 * Everything one client needs after a batch: filtered events (+ discovered cover changes) and a
 * redacted snapshot. Updates `mem`.
 */
export function teamView(state, events, mem, { myUnitId = -1, snapshot = true } = {}) {
  const team = mem.team;
  const out = filterEvents(state, events || [], team, { mem, myUnitId });
  const vis = vision(state, team);
  if (!vis.all) {
    const S = state.map.size;
    const disc = [];
    for (let k = 0; k < S * S; k++) {
      const x = k % S, y = (k / S) | 0;
      const coverDiff = mem.cover && mem.cover[k] !== state.map.cover[k];
      const exDiff = mem.explosive && mem.explosive[k] !== state.map.explosive[k];
      if (!coverDiff && !exDiff) continue;
      if (!vis.tile(x, y)) continue;
      if (coverDiff) { disc.push({ type: 'cover_change', x, y, from: mem.cover[k], to: state.map.cover[k], discovered: true }); mem.cover[k] = state.map.cover[k]; }
      if (exDiff) mem.explosive[k] = state.map.explosive[k];
    }
    out.push(...disc);
    // Crates as last seen.
    for (const c of state.crates || []) {
      const known = mem.crates.get(c.id);
      if (!vis.tile(c.x, c.y)) {
        // A crate my squad picked up (anywhere) is known to be gone.
        if (known && c.taken && out.some((e) => e.type === 'crate' && e.crate === c.id)) known.taken = true;
        continue;
      }
      if (known) known.taken = !!c.taken;
      else if (!c.taken) mem.crates.set(c.id, { id: c.id, x: c.x, y: c.y, type: crateLook(c), taken: false, dropped: !!c.dropped });
    }
    for (const [id, c] of mem.crates) if (c.taken) mem.crates.delete(id);
  }
  return { events: out, snap: snapshot ? redactSnapshot(state, team, mem, { myUnitId, vis }) : null };
}
