// Tidefall 5.0 battlefield layer for the renderer: everything the 5.0 sim
// adds on top of the 3.0 events. Owned by the Renderer (one per game); it
// keeps persistent world objects (boats, sentries, claymores, drones, the
// gunship, airstrike telegraphs, engagement overlay, stage-event hazards) and
// plays the new events with the same lifecycle rules as render.js:
//  - every handler captures R.gen and bails after each await on a new game;
//  - all timing runs on the renderer's playback clock (R._anim / R._wait),
//    so spectator speed scales every animation, camera move and delay;
//  - camera holds are tagged and always released.
//
// Event shapes follow docs/V5_SPEC.md; field names are read defensively
// (the sim streams may add / rename fields), and unknown kinds degrade to a
// generic, still-readable effect instead of nothing.

import * as THREE from 'three';
import { TEAM } from './palette.js';
import { FlatLines } from './flatlines.js';
import { WATER_Y } from './fields.js';
import {
  makeBoat, makeDrone, makeJet, makeGunship, makeSentry, makeBarricade, makeClaymore, makeSemtex, makeKnife,
  makeFlashbang, makeCarePackage, makeShip, makeTower, makeWave, glowMat, disposeModel,
} from './vehicles.js';
import { clamp, lerp, easeOutCubic, easeInOutCubic, easeOutBack, compass } from './util.js';
import * as CFX from './cosmeticfx.js';

/**
 * Streak skins (GFX-CHAR): when the owner has a non-default streak skin, use
 * their skinned model inside our rig (keeps our muzzle / light anchors).
 */
function skinned(kind, skin, fallback) {
  if (!skin || skin === 'default' || !CFX.buildStreakModel) return fallback();
  try {
    const base = fallback();
    for (const c of [...base.children]) if (c.isMesh && c.material?.blending !== THREE.AdditiveBlending) base.remove(c);
    const m = CFX.buildStreakModel(kind, skin);
    base.add(m);
    base.userData.skinModel = m;
    return base;
  } catch { return fallback(); }
}

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _c = new THREE.Color();
const RED = 0xff3a2a, MAGENTA = TEAM.magenta, CYAN = TEAM.cyan, GOLD = 0xffc040;

const STREAK_NAME = {
  uav: 'UAV', care: 'CARE PACKAGE', care_package: 'CARE PACKAGE', carePackage: 'CARE PACKAGE', counter_uav: 'COUNTER-UAV', cuav: 'COUNTER-UAV',
  airstrike: 'AIRSTRIKE', sentry: 'SENTRY', gunship: 'GUNSHIP',
};

/** Events this module plays (render.js delegates them before its own id checks). */
export const BF_EVENTS = new Set([
  'round_start', 'engagement', 'step_start', 'spotted', 'contact',
  'reload', 'swap', 'stim', 'decoy', 'suppress', 'suppress_end', 'suppressed',
  'semtex', 'flashbang', 'flash', 'knife', 'throwing_knife', 'claymore', 'claymore_place', 'claymore_trigger', 'claymore_blast',
  'deploy_cover', 'barricade', 'repair',
  'rocket', 'shot_sentry', 'sentry_damage', 'cuav', 'cuav_end', 'care_package_called', 'noise', 'decoy_end', 'suppress_trigger',
  'streak_ready', 'streak_used', 'uav', 'uav_end', 'counter_uav', 'care_package', 'airstrike_mark', 'airstrike',
  'sentry', 'sentry_shot', 'sentry_end', 'sentry_destroyed', 'sentry_expire', 'gunship_start', 'gunship_shot', 'gunship_end',
  'board', 'disembark', 'boat_move', 'vehicle_damage', 'vehicle_destroyed',
  'stage_event_warn', 'stage_event', 'stage_event_end', 'red_tide_end', 'knockback', 'terrain_change', 'building_collapse',
  'pit_enter', 'pit_duel', 'pit_result', 'redeploy', 'pit_out', 'shot_vehicle', 'streak_points', 'tracked', 'run_gun_ready',
]);

/** [[x,y]...] from [[x,y]] | [{x,y}] | [k] (tile index). */
function tilesOf(list, S) {
  const out = [];
  for (const t of list || []) {
    if (Array.isArray(t)) out.push([t[0], t[1]]);
    else if (t && typeof t === 'object') out.push([t.x, t.y]);
    else if (Number.isFinite(t)) out.push([t % S, (t / S) | 0]);
  }
  return out;
}

function stageKind(kind, stage) {
  const k = String(kind || '').toLowerCase();
  if (/ship|container|harbor/.test(k)) return 'ship';
  if (/tide|algae|red|kelp/.test(k)) return 'redtide';
  if (/collapse|platform|rig/.test(k)) return 'collapse';
  if (/tower|topple|spire/.test(k)) return 'tower';
  if (/wave|surge/.test(k)) return 'wave';
  return { harbor: 'ship', kelp: 'redtide', rig: 'collapse', spire: 'tower', surge: 'wave' }[stage] || 'wave';
}

export class Battlefield {
  constructor(R) {
    this.R = R;
    this.group = new THREE.Group();
    R.world.add(this.group);
    this.lines = new FlatLines(R.world, 160);
    this.boats = new Map(); // vehicle id -> {o, x, y, yaw, seats:[ids], hp, moving, smoke}
    this.aboard = new Map(); // unit id -> vehicle id
    this.sentries = new Map(); // id -> {o, x, y, team, yawGoal, cone}
    this.claymores = new Map(); // key -> {o, x, y, team, dir}
    this.marks = new Map(); // airstrike id -> {tiles, t}
    this.uavs = new Map(); // team -> {o, cx, cz, r, a, t}
    this.gunships = new Map(); // team -> {o, cx, cz, a, t, leaving}
    this.flares = new Map(); // "x,y" -> {x, z, gold, t}
    this.suppressed = new Map(); // unit id -> t
    this.dazed = new Map(); // unit id -> t
    this.stuck = []; // semtex stuck to units / ground
    this.engage = { groups: [], free: [], active: null, mine: new Set(), t: 0 };
    this.warn = null; // {kind, tiles, t, prop}
    this.redTide = null; // {tiles, rounds, k}
    this.redTideK = 0;
    this.temp = new Set(); // transient models to dispose on clear
    this.time = 0;
  }

  // ---------- helpers ----------
  /** The player has the camera (drag / pinch / wheel recently): set pieces stop steering it. */
  get camFree() { const R = this.R; return !R.dragging && R.realTime - R.userCamT > 1.2; }
  get st() { return this.R.state; }
  wx(x) { return this.R.wx(x); }
  wz(y) { return this.R.wz(y); }
  gy(x, y) { const S = this.R.S; return x >= 0 && y >= 0 && x < S && y < S ? this.R._groundY(x, y) : 0; }
  vis(x, y) { const S = this.R.S; return x >= 0 && y >= 0 && x < S && y < S && this.R.visibleToMe(x, y); }
  unit(id) { return typeof id === 'number' ? this.st.units[id] : null; }
  view(id) { return this.unit(id) ? this.R.views[id] : null; }
  seenUnit(id) { const u = this.unit(id); return !!u && (u.team === this.R.myTeam || this.R.spectator || this.R.views[id].root.visible); }
  mineTeam(t) { return t === this.R.myTeam; }
  sfx() { return this.R.hooks.sfx; }
  call(name, ...a) { const s = this.R.hooks.sfx; try { s?.[name]?.(...a); } catch { /* audio stream still landing */ } }
  feed(msg) { this.R.hooks.onFeed?.(msg); }
  add(o) { this.group.add(o); this.temp.add(o); return o; }
  drop(o) { if (!o) return; this.temp.delete(o); disposeModel(o); }
  teamOf(ev) { const u = this.unit(ev.id ?? ev.owner); return ev.team ?? u?.team ?? -1; }
  colorOf(team) { return team >= 0 ? this.R.teamColor(team) : '#ff3a2a'; }

  /** Rebuild persistent objects from the sim state (setGame / syncFromState). */
  sync(st) {
    for (const b of this.boats.values()) disposeModel(b.o);
    for (const s of this.sentries.values()) disposeModel(s.o);
    for (const c of this.claymores.values()) disposeModel(c.o);
    for (const u of this.uavs.values()) disposeModel(u.o);
    for (const g of this.gunships.values()) disposeModel(g.o);
    for (const o of [...this.temp]) this.drop(o);
    for (const s of this.stuck) disposeModel(s.o);
    this.boats.clear(); this.aboard.clear(); this.sentries.clear(); this.claymores.clear(); this.marks.clear();
    this.uavs.clear(); this.gunships.clear(); this.flares.clear(); this.suppressed.clear(); this.dazed.clear(); this.stuck = [];
    this.warn = null;
    for (const v of st.vehicles || []) if (v && v.kind !== 'gone' && !(v.hp <= 0)) this._addBoat(v);
    for (const s of st.sentries || []) if (s && !(s.hp <= 0)) this._addSentry(s.id, s.x, s.y, s.team ?? this.unit(s.owner)?.team ?? -1);
    for (const c of st.claymores || []) if (c) this._addClaymore(c.id ?? `${c.x},${c.y}`, c.x, c.y, c.team ?? this.unit(c.owner)?.team ?? -1, c.dir);
    for (const a of st.airstrikes || []) if (a && a.tiles) this.marks.set(a.id ?? 'a', { tiles: tilesOf(a.tiles, this.R.S), t: 0 });
    for (const u of st.units) if (u.alive && u.suppressed) this.suppressed.set(u.id, 0);
    const se = st.stageEvent;
    if (se && se.tiles && se.warned && !se.done) this._warnStart(stageKind(se.kind, st.stage), tilesOf(se.tiles, this.R.S), true);
    const rt = (st.hazards || []).find((h) => h.kind === 'redtide') || st.redTide;
    this._setRedTide(rt && rt.tiles ? tilesOf(rt.tiles, this.R.S) : null, true);
  }

  clear() { this.sync({ units: this.st?.units || [] }); }

  dispose() {
    this.clear();
    this.lines.dispose();
    this.R.world?.remove(this.group);
  }

  // ---------- per frame ----------
  /** dt: gameplay clock (speed × slow-mo). rt: real seconds (UI pulses). */
  update(dt, rt) {
    const R = this.R;
    this.time += dt;
    const T = this.time;
    // boats: bob, wake, carry their passengers
    for (const b of this.boats.values()) {
      const o = b.o, hull = o.userData.hull;
      const sea = 1 + R.storm * 1.6;
      hull.position.y = Math.sin(T * 1.7 + b.ph) * 0.03 * sea - (b.sink || 0);
      hull.rotation.x = Math.sin(T * 1.3 + b.ph) * 0.04 * sea + (b.pitch || 0);
      hull.rotation.z = Math.cos(T * 1.1 + b.ph) * 0.05 * sea + (b.roll || 0);
      o.userData.nav.visible = ((T + b.ph) % 1.6) < 0.25;
      const show = this._boatVisible(b);
      o.visible = show;
      if (show && !b.moving && Math.random() < dt * 3) R.fx.ring(o.position.x, WATER_Y + 0.01, o.position.z, 0.5, 0.95, 0xdff4ee, 1.2, 0.35);
      if (show && b.hp !== undefined && b.hp <= 5 && Math.random() < dt * 8) R.fx.alpha.spawn(o.position.x, 0.5, o.position.z - 0.2, 0.1, 0.7, 0.05, 1.6, 0.12, 0.45, 0.2, 0.19, 0.18, 0.5, 0.6, -0.1, 0, 1.2);
      // passengers ride the seats
      if (b.seats.length) o.updateMatrixWorld(true);
      b.seats.forEach((id, i) => {
        const v = R.views[id];
        if (!v || !R.disp[id]?.alive || b.hop === id) return;
        const s = o.userData.seats[Math.min(i, 3)];
        _v.copy(s).applyMatrix4(hull.matrixWorld);
        v.root.position.copy(_v);
        if (!v.aimGoal) v.faceTo(_v.x + Math.sin(o.rotation.y), _v.z + Math.cos(o.rotation.y), true);
      });
    }
    // sentries idle-scan, claymore blink
    for (const s of this.sentries.values()) {
      s.o.visible = this.vis(s.x, s.y) || this.mineTeam(s.team);
      const y = s.o.userData.yaw;
      if (!s.busy) s.yawGoal = s.yaw0 + Math.sin(T * 0.6 + s.ph) * 0.5;
      y.rotation.y += (s.yawGoal - y.rotation.y) * Math.min(1, dt * 6);
      s.o.userData.eye.material.opacity = 0.6 + 0.4 * Math.sin(T * 5 + s.ph);
      s.o.userData.barrel.position.z += (0 - s.o.userData.barrel.position.z) * Math.min(1, dt * 12);
    }
    // drones / gunships orbit
    for (const [team, u] of this.uavs) {
      u.a += dt * 0.45;
      const x = u.cx + Math.cos(u.a) * u.r, z = u.cz + Math.sin(u.a) * u.r;
      u.o.position.set(x, 7.5 + Math.sin(T * 0.7) * 0.2, z);
      u.o.rotation.set(0, Math.atan2(-Math.sin(u.a), Math.cos(u.a)), -0.35, 'YXZ');
      u.o.userData.prop.rotation.z += dt * 40;
      if (u.o.userData.skinModel) CFX.tickStreakModel?.(u.o.userData.skinModel, T);
      u.o.userData.light.visible = (T % 1.2) < 0.15;
      void team; // drones are visible to everyone: an enemy UAV overhead is a warning
    }
    for (const g of this.gunships.values()) {
      g.a += dt * (g.leaving ? 0.25 : 0.16);
      const r = g.r + (g.leaving ? g.lt * 14 : 0);
      if (g.leaving) g.lt += dt;
      const x = g.cx + Math.cos(g.a) * r, z = g.cz + Math.sin(g.a) * r;
      g.o.position.set(x, 10 + (g.leaving ? g.lt * 3 : 0) + Math.sin(T * 0.5) * 0.15, z);
      // counter-clockwise orbit: nose along the tangent, banked so the left-side guns face in
      g.o.rotation.set(0, Math.atan2(-Math.sin(g.a), Math.cos(g.a)), -0.28, 'YXZ');
      for (const p of g.o.userData.props) p.rotation.z += dt * 30;
      if (g.o.userData.skinModel) CFX.tickStreakModel?.(g.o.userData.skinModel, T);
      for (const l of g.o.userData.lights) l.visible = (T % 1.0) < 0.12;
    }
    // care-package smoke flares
    for (const f of this.flares.values()) {
      f.t += dt;
      const fade = f.landed ? Math.max(0, 1 - f.lt / 2.5) : 1;
      if (f.landed) f.lt += dt;
      if (Math.random() < dt * 26 * fade * (R.fx.scale || 1)) {
        const col = f.gold ? [0.95, 0.72, 0.25] : [0.92, 0.22, 0.16];
        R.fx.alpha.spawn(f.x + (Math.random() - 0.5) * 0.15, 0.12, f.z + (Math.random() - 0.5) * 0.15, 0.35 + Math.random() * 0.2, 1.4 + Math.random() * 0.9, (Math.random() - 0.5) * 0.25,
          2.6 + Math.random() * 1.4, 0.16, 0.9 + Math.random() * 0.6, col[0], col[1], col[2], 0.75, 0.6, -0.2, 0, 1.1);
      }
      if (Math.random() < dt * 8 * fade) R.fx.add.spawn(f.x, 0.12, f.z, 0, 0.4, 0, 0.25, 0.12, 0.05, 6, 1.5, 0.6, 1, 0, 0, 0, 1.2);
    }
    for (const [k, f] of this.flares) if (f.landed && f.lt > 2.6) this.flares.delete(k);
    // semtex blink
    for (const s of this.stuck) {
      s.t += dt;
      s.o.userData.led.visible = (s.t * (4 + s.t * 10)) % 1 < 0.5;
      if (s.unit !== undefined) { const v = R.views[s.unit]; if (v) { v.root.getWorldPosition(_v); s.o.position.set(_v.x + 0.08, _v.y + 0.62, _v.z + 0.06); } }
    }
    // dazed (flashbang) and suppressed status motes
    for (const [id, t0] of this.dazed) {
      const v = R.views[id];
      if (!v?.root.visible || !R.disp[id]?.alive) continue;
      if (Math.random() < dt * 10) {
        const a = T * 5 + Math.random() * 6, p = v.root.position;
        R.fx.add.spawn(p.x + Math.cos(a) * 0.22, p.y + 1.15, p.z + Math.sin(a) * 0.22, -Math.sin(a) * 0.6, 0.05, Math.cos(a) * 0.6, 0.5, 0.05, 0.02, 4, 4, 3.4, 1, 1, 0, 0, 1);
      }
      void t0;
    }
    for (const id of this.suppressed.keys()) {
      const v = R.views[id];
      if (!v?.root.visible || !R.disp[id]?.alive) continue;
      if (Math.random() < dt * 6) {
        const p = v.root.position, a = Math.random() * 6.28;
        R.fx.add.spawn(p.x + Math.cos(a) * 0.5, p.y + 0.4 + Math.random() * 0.6, p.z + Math.sin(a) * 0.5, -Math.cos(a) * 2.5, 0, -Math.sin(a) * 2.5, 0.12, 0.03, 0.02, 5, 2.8, 1.2, 1, 0, 0, 2.5, 1);
      }
    }
    // red tide strength
    const rtGoal = this.redTide ? 1 : 0;
    this.redTideK += (rtGoal - this.redTideK) * Math.min(1, dt * 0.8);
    if (R.water) R.water.uniforms.uRedTide.value = this.redTideK;
    if (this.redTide && Math.random() < dt * 14 && this.redTide.tiles.length) {
      const [x, y] = this.redTide.tiles[(Math.random() * this.redTide.tiles.length) | 0];
      R.fx.alpha.spawn(this.wx(x) + (Math.random() - 0.5), WATER_Y + 0.05, this.wz(y) + (Math.random() - 0.5), 0, 0.12, 0, 2.2, 0.15, 0.55, 0.55, 0.1, 0.08, 0.35, 0.8, -0.02, 0, 1.4);
    }
    this._drawLines(rt);
  }

  _boatVisible(b) {
    const R = this.R;
    if (R.spectator) return true;
    if (b.seats.some((id) => this.unit(id)?.team === R.myTeam)) return true;
    return this.vis(b.x, b.y);
  }

  /** Engagement brackets + links, airstrike telegraphs, claymore trip lasers. */
  _drawLines(rt) {
    const R = this.R, L = this.lines;
    L.begin();
    // engagement: brackets round each engaged squad I can see, links to my squad
    const E = this.engage;
    if (E.groups.length && !R.showcase) {
      const k = Math.min(1, E.t * 2.5);
      for (const grp of E.groups) {
        if (!R.spectator && !grp.includes(R.myTeam)) continue;
        const boxes = [];
        for (const team of grp) {
          const bb = this._squadBox(team);
          if (!bb) continue;
          const active = !E.active || E.active.includes(team);
          const col = this.colorOf(team);
          const pulse = active ? 0.75 + 0.25 * Math.sin(rt * 5 + team) : 0.35;
          L.bracket(bb[0] - 0.55, bb[1] - 0.55, bb[2] + 0.55, bb[3] + 0.55, 0.075, col, pulse * k, 0.42);
          boxes.push({ team, cx: (bb[0] + bb[2]) / 2, cz: (bb[1] + bb[3]) / 2 });
        }
        const hub = boxes.find((b) => b.team === R.myTeam) || boxes[0];
        for (const b of boxes) {
          if (b === hub) continue;
          const dx = b.cx - hub.cx, dz = b.cz - hub.cz, D = Math.hypot(dx, dz) || 1;
          const pad = Math.min(1.2, D * 0.3);
          L.seg(hub.cx + dx / D * pad, hub.cz + dz / D * pad, b.cx - dx / D * pad, b.cz - dz / D * pad, 0.06, MAGENTA, 0.55 * k, true);
        }
      }
    }
    // airstrike telegraphs: hot red dashed run line + tile pips
    for (const m of this.marks.values()) {
      const t = m.tiles;
      if (!t.length) continue;
      const a = t[0], b = t[t.length - 1];
      const p = 0.6 + 0.4 * Math.sin(rt * 7);
      L.seg(this.wx(a[0]), this.wz(a[1]), this.wx(b[0]), this.wz(b[1]), 0.2, 0xff6040, 0.95 * p, true);
      for (const [x, y] of t) {
        L.seg(this.wx(x), this.wz(y) - 0.45, this.wx(x), this.wz(y) + 0.45, 0.9, RED, 0.16 + 0.1 * p);
        L.bracket(this.wx(x) - 0.42, this.wz(y) - 0.42, this.wx(x) + 0.42, this.wz(y) + 0.42, 0.06, RED, 0.75 * p, 0.2);
      }
    }
    // stage-event warning tiles
    if (this.warn) {
      const p = 0.45 + 0.35 * Math.sin(rt * 6);
      for (const [x, y] of this.warn.tiles) L.bracket(this.wx(x) - 0.44, this.wz(y) - 0.44, this.wx(x) + 0.44, this.wz(y) + 0.44, 0.045, 0xffa020, p, 0.2);
    }
    // claymore lasers (owner team or visible)
    for (const c of this.claymores.values()) {
      const show = this.mineTeam(c.team) || R.spectator || this.vis(c.x, c.y);
      c.o.visible = show;
      if (!show) continue;
      const ox = this.wx(c.x), oz = this.wz(c.y);
      const a0 = Math.atan2(c.dir[1], c.dir[0]);
      for (const s of [-0.38, 0, 0.38]) {
        const a = a0 + s;
        L.seg(ox, oz, ox + Math.cos(a) * 1.55, oz + Math.sin(a) * 1.55, 0.022, 0xff2020, 0.75 + 0.25 * Math.sin(rt * 9 + s * 4), false, 0.2);
      }
    }
    L.end(rt);
  }

  _squadBox(team) {
    const R = this.R, T = this.st.teams[team];
    if (!T) return null;
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9, n = 0;
    for (const id of T.members) {
      const v = R.views[id], d = R.disp[id];
      if (!v || !d?.alive || !v.root.visible) continue;
      const p = v.root.position;
      x0 = Math.min(x0, p.x); z0 = Math.min(z0, p.z); x1 = Math.max(x1, p.x); z1 = Math.max(z1, p.z); n++;
    }
    return n ? [x0, z0, x1, z1] : null;
  }

  /** A squad's turn begins: status markers that last "until its next turn ends" age out. */
  onTurnStart(team) {
    const T = this.st.teams[team];
    if (!T) return;
    for (const id of T.members) {
      for (const m of [this.suppressed, this.dazed]) {
        if (!m.has(id)) continue;
        const n = m.get(id) + 1;
        if (n >= 2) m.delete(id); else m.set(id, n);
      }
    }
  }

  /** A unit walks: if it steps off its boat, it leaves the seat (the seat no longer pins it). */
  onMove(ev) {
    const vid = this.aboard.get(ev.id);
    if (vid === undefined || !ev.path?.length) return;
    const b = this.boats.get(vid);
    const [ex, ey] = ev.path[ev.path.length - 1];
    if (b && (b.x !== ex || b.y !== ey)) { this.aboard.delete(ev.id); b.seats = b.seats.filter((i) => i !== ev.id); }
  }

  // ---------- dispatch ----------
  async play(ev) {
    const t = ev.type;
    switch (t) {
      case 'round_start': return this._round(ev);
      case 'engagement': return this._engagement(ev);
      case 'step_start': this.engage.active = ev.active || null; return;
      case 'spotted': case 'contact': return this._spotted(ev.teams || [ev.team ?? this.unit(ev.id)?.team], ev);
      case 'reload': return this._reload(ev);
      case 'swap': return this._swap(ev);
      case 'stim': return this._stim(ev);
      case 'decoy': return this._decoy(ev);
      case 'suppress': case 'suppressed': return this._suppress(ev);
      case 'suppress_end': this.suppressed.delete(ev.target ?? ev.id); return;
      case 'semtex': return this._semtex(ev);
      case 'flashbang': case 'flash': return this._flashbang(ev);
      case 'knife': case 'throwing_knife': return this._knife(ev);
      case 'claymore': case 'claymore_place': return this._claymorePlace(ev);
      case 'claymore_trigger': case 'claymore_blast': return this._claymoreBlast(ev);
      case 'deploy_cover': case 'barricade': return this._deployCover(ev);
      case 'repair': return this._repair(ev);
      case 'streak_ready': return this._streakReady(ev);
      case 'streak_used': return this._streakUsed(ev);
      case 'uav': return this._uav(ev);
      case 'uav_end': { const u = this.uavs.get(ev.team); if (u) { this.uavs.delete(ev.team); this._flyOff(u.o); } return; }
      case 'counter_uav': case 'cuav': return this._counterUav(ev);
      case 'cuav_end': if (this.mineTeam(ev.team)) this.feed('Counter-UAV offline'); return;
      case 'care_package_called': this._flare(ev.x, ev.y, false); this.call('flareSmoke'); return;
      case 'rocket': return this._rocketEv(ev);
      case 'shot_sentry': return this._shotSentry(ev);
      case 'sentry_damage': { const s = this.sentries.get(ev.id); if (s && (this.vis(s.x, s.y) || this.mineTeam(s.team))) { const p = s.o.position; this.R.fx.sparks(p.x, 0.5, p.z, 8, 5, 3.6, 1.6, 3); this.R._text(s.x, s.y, '-' + ev.dmg, '#ffa060', 0.9, 1.1); } return; }
      case 'noise': return this._noise(ev);
      case 'decoy_end': { const d = this.decoys?.get(ev.decoyId); if (d) { this.drop(d); this.decoys.delete(ev.decoyId); } return; }
      case 'suppress_trigger': { const v = this.view(ev.target); if (v?.root.visible) { this.R._textAt(ev.target, 'SUPPRESSED!', '#ffb35a', 0.85, 0.3); this.call('tripwire'); await this.R._wait(260); } return; }
      case 'care_package': return this._carePackage(ev);
      case 'airstrike_mark': return this._airstrikeMark(ev);
      case 'airstrike': return this._airstrike(ev);
      case 'sentry': return this._sentry(ev);
      case 'sentry_shot': return this._sentryShot(ev);
      case 'sentry_end': case 'sentry_destroyed': case 'sentry_expire': return this._sentryEnd(ev);
      case 'gunship_start': return this._gunshipStart(ev);
      case 'gunship_shot': return this._gunshipShot(ev);
      case 'gunship_end': return this._gunshipEnd(ev);
      case 'board': return this._board(ev);
      case 'disembark': return this._disembark(ev);
      case 'boat_move': return this._boatMove(ev);
      case 'vehicle_damage': return this._vehicleDamage(ev);
      case 'vehicle_destroyed': return this._vehicleDestroyed(ev);
      case 'stage_event_warn': return this._stageWarn(ev);
      case 'stage_event': return this._stageEvent(ev);
      case 'stage_event_end': case 'red_tide_end': this._setRedTide(null); this.warn = null; return;
      case 'knockback': return this._knockback(ev);
      case 'terrain_change': this.R.setTileTerrain(ev.x, ev.y, ev.to); return;
      case 'building_collapse': return this._buildingCollapse(ev);
      case 'pit_enter': return this._pitEnter(ev);
      case 'pit_duel': { const a = this.unit(ev.a), b = this.unit(ev.b); if (a && b) this.feed(`Pit duel: ${a.name} vs ${b.name}`); return; }
      case 'pit_result': { const w = this.unit(ev.winner); if (w) this.feed(`${w.name} wins the Pit and will redeploy`); return; }
      case 'redeploy': return this._redeploy(ev);
      case 'pit_out': { const u = this.unit(ev.id); if (u) this.feed(`${u.name} is out`); return; }
      case 'streak_points': return;
      case 'run_gun_ready': { const u = this.unit(ev.id); if (u?.team === this.R.myTeam && this.R.views[ev.id].root.visible) this.R._textAt(ev.id, 'RUN & GUN', '#ffd36a', 0.75, 0.3); return; }
      case 'tracked': {
        // Tracker perk: the damaged enemy stays revealed to the shooter's squad
        const R = this.R;
        let set = R.reveals.get(ev.team);
        if (!set) R.reveals.set(ev.team, (set = new Set()));
        set.add(ev.id);
        R._refreshUnits();
        const v = R.views[ev.id];
        if ((ev.team === R.myTeam || R.spectator) && v?.root.visible) { R.fx.revealPing(v.root.position.x, v.root.position.z); R._textAt(ev.id, 'TRACKED', '#ff5fb4', 0.75, 0.5); }
        return;
      }
      case 'shot_vehicle': return this._shotVehicle(ev);
      default: return;
    }
  }

  // ---------- turn system ----------
  _round(ev) {
    void ev;
    // red tide lasts a fixed number of rounds once it has spread
    if (this.redTide && this.redTide.rounds !== undefined && --this.redTide.rounds < 0) this._setRedTide(null);
  }

  async _engagement(ev) {
    const R = this.R, g = R.gen;
    const groups = (ev.groups || []).filter((x) => Array.isArray(x) && x.length > 1);
    const prev = this.engage.mine;
    const mine = new Set();
    for (const grp of groups) if (grp.includes(R.myTeam)) for (const t of grp) if (t !== R.myTeam) mine.add(t);
    this.engage = { groups, free: ev.free || [], active: null, mine, t: 0 };
    // ramp the overlay in on the gameplay clock
    R.fx.timed(0.4, (k) => { if (g === R.gen) this.engage.t = k; });
    const fresh = [...mine].filter((t) => !prev.has(t));
    if (fresh.length) await this._spotted(fresh, ev);
  }

  /** "Spotted!" pulse on newly contacted squads (magenta rings + text on the nearest). */
  async _spotted(teams, ev) {
    const R = this.R, g = R.gen;
    void ev;
    let best = null, bd = 1e9;
    const me = R.myRef();
    for (const team of teams) {
      const T = this.st.teams[team];
      if (!T) continue;
      for (const id of T.members) {
        const v = R.views[id], d = R.disp[id];
        if (!v?.root.visible || !d?.alive) continue;
        const p = v.root.position;
        R.fx.ring(p.x, p.y + 0.07, p.z, 0.2, 1.5, MAGENTA, 0.6, 1.2);
        R.fx.ring(p.x, p.y + 0.07, p.z, 0.2, 2.4, MAGENTA, 0.9, 0.6);
        R.fx.revealPing(p.x, p.z);
        const dd = Math.hypot(d.x - me.x, d.y - me.y);
        if (dd < bd) { bd = dd; best = id; }
      }
    }
    if (best === null) return;
    this.call('engagementStart');
    R._textAt(best, 'SPOTTED!', '#ff5fb4', 1.15, 0.45);
    await R._wait(420);
    if (g !== R.gen) return;
  }

  // ---------- weapons / equipment ----------
  async _reload(ev) {
    const v = this.view(ev.id); if (!v) return;
    v.doReload();
    if (this.seenUnit(ev.id)) {
      this.call('reload', ev.weapon);
      if (this.unit(ev.id).team === this.R.myTeam) this.R._textAt(ev.id, 'RELOAD', '#efe7d4', 0.7);
      await this.R._wait(380);
    }
  }

  async _swap(ev) {
    const v = this.view(ev.id); if (!v) return;
    if (v.doSwap) v.doSwap(ev.slot); else v.doReload();
    v.syncWeapon?.(this.unit(ev.id));
    if (this.seenUnit(ev.id)) { this.call('swap'); await this.R._wait(240); }
  }

  async _stim(ev) {
    const R = this.R, v = this.view(ev.id); if (!v) return;
    const jab = v.doStim ? v.doStim() : (v.doReload(), 0.26);
    if (ev.heal || ev.amount) R._hp(ev.id, ev.heal || ev.amount);
    if (!this.seenUnit(ev.id)) return;
    const p = v.root.position;
    await R._wait(jab * 1000);
    this.call('stim');
    R.fx.healPulse(p.x, p.z, 0.8);
    for (let i = 0; i < 14; i++) R.fx.add.spawn(p.x, p.y + 0.7, p.z, (Math.random() - 0.5) * 1.2, 1 + Math.random() * 1.5, (Math.random() - 0.5) * 1.2, 0.6, 0.05, 0.02, 1.6, 4.0, 2.2, 1, 1.5, 0, 0.8, 1);
    R._textAt(ev.id, '+1 AP' + (ev.heal || ev.amount ? `  +${ev.heal || ev.amount}` : ''), '#9dffc8', 0.95);
    await R._wait(420);
  }

  async _decoy(ev) {
    const R = this.R, g = R.gen;
    const x = this.wx(ev.x), z = this.wz(ev.y);
    if (!this.vis(ev.x, ev.y) && !this.mineTeam(this.teamOf(ev))) { R._ping(ev.x, ev.y); this.feed(`Gunfire to the ${compass(R.myRef(), ev.x, ev.y)}`); return; }
    const dev = this.add(makeSemtex()); dev.position.set(x, this.gy(ev.x, ev.y), z); dev.scale.setScalar(1.3);
    for (let i = 0; i < 5; i++) {
      R.fx.muzzle(x, 0.5, z, Math.random() - 0.5, Math.random() - 0.5, 0.7);
      this.call('shot', 1, 'Rifle');
      await R._wait(110);
      if (g !== R.gen) return;
    }
    this.call('decoy');
    R._text(ev.x, ev.y, 'DECOY', '#efe7d4', 0.85, 1.2);
    if (ev.decoyId !== undefined) (this.decoys || (this.decoys = new Map())).set(ev.decoyId, dev);
    else R.fx.timed(8, (t) => { if (t >= 1) this.drop(dev); });
  }

  /** Gunner suppression: a long raking burst around the target, then a status marker. */
  async _suppress(ev) {
    const R = this.R, g = R.gen;
    const tid = ev.target ?? ev.to;
    const s = this.unit(ev.id ?? ev.from), t = this.unit(tid);
    if (!s || !t) return;
    const vs = R.views[s.id], vt = R.views[t.id];
    this.suppressed.set(t.id, 0);
    const sVis = R._unitSeen(s.id), tVis = R._unitSeen(t.id);
    if (!sVis && !tVis) { R._ping(R.disp[s.id].x, R.disp[s.id].y); this.call('shot', 1, 'LMG'); return; }
    vs.root.visible = true; vs.setHunker(false);
    R._face(s.id, R.disp[t.id].x, R.disp[t.id].y);
    vs.aimGoal = 1;
    const B = vt.root.position;
    const cam = R._actionCam(vs.root.position, B, false);
    await R._wait(260);
    if (g !== R.gen) return;
    vs.settle();
    const col = new THREE.Color(R.teamColor(s.team));
    const n = 12;
    vs.doSuppress?.(n * 0.07 + 0.2);
    for (let i = 0; i < n; i++) {
      vs.muzzleWorld(_v);
      const dx = B.x - _v.x, dz = B.z - _v.z, L = Math.hypot(dx, dz) || 1;
      const nx = dx / L, nz = dz / L;
      // rake: impacts walk across and around the target, never on it
      const side = Math.sin(i * 1.7) * 0.9, along = (Math.random() - 0.3) * 1.2;
      const ix = B.x - nz * side + nx * along, iz = B.z + nx * side + nz * along, iy = 0.1 + Math.random() * 0.8;
      if (i % 3 === 0) this.call('shot', R._far(R.disp[s.id].x, R.disp[s.id].y), s.weapon?.id || 'LMG', { burst: 3 });
      R.fx.muzzle(_v.x, _v.y, _v.z, nx, nz, 0.8);
      R.fx.shell(_v.x, _v.y, _v.z, nx, nz);
      R.cfx.tracer(R.cos?.[s.id]?.tracer, _v.x, _v.y, _v.z, ix, iy, iz, col, 0.03, 0.12);
      vs.doRecoil(0.5);
      if (R._floodedWorld(ix, iz)) R.fx.splash(ix, iz, 0.35);
      else { R.fx.dust(ix, iz, 2, 0.78, 0.7, 0.56, iy * 0.3, 0.6); if (Math.random() < 0.5) R.fx.sparks(ix, iy, iz, 4, 5, 3.2, 1.4, 3); }
      if (i === 4) { vt.doFlinch(0.7, nx, nz); vt.setHunker?.(true); }
      await R._wait(70);
      if (g !== R.gen) return;
    }
    if (tVis) R._textAt(t.id, 'SUPPRESSED', '#ffb35a', 0.95, 0.3);
    await R._wait(420);
    if (g !== R.gen) return;
    vs.aimGoal = 0;
    vt.setHunker?.(!!this.st.units[t.id].hunkered);
    if (cam) R._camRelease('shot');
  }

  _tracerCol(u) {
    const tr = this.R.cos?.[u.id]?.tracer;
    return tr && tr !== 'default' && /^#|^0x/.test(String(tr)) ? tr : this.R.teamColor(u.team);
  }

  /** rocket {id, x, y, radius}: the shooter fires a launcher at a tile (damage / cover events follow). */
  async _rocketEv(ev) {
    const R = this.R, g = R.gen, u = this.unit(ev.id);
    if (!u) return;
    const tx = this.wx(ev.x), tz = this.wz(ev.y);
    R._blast = { x: tx, z: tz };
    const sVis = R._unitSeen(u.id), tVis = this.vis(ev.x, ev.y);
    if (!sVis && !tVis) { this.call('explosion', 1); R._ping(ev.x, ev.y); this.feed(`Explosion to the ${compass(R.myRef(), ev.x, ev.y)}`); return; }
    const v = R.views[u.id];
    v.root.visible = true; v.setHunker(false);
    R._face(u.id, ev.x, ev.y); v.aimGoal = 1;
    const cam = R._pointCam('blast', (v.root.position.x + tx) / 2, (v.root.position.z + tz) / 2);
    await R._wait(260);
    if (g !== R.gen) return;
    v.settle();
    v.muzzleWorld(_v);
    R.fx.muzzle(_v.x, _v.y, _v.z, Math.sin(v.root.rotation.y), Math.cos(v.root.rotation.y), 1.3);
    // back-blast
    for (let i = 0; i < 8; i++) R.fx.alpha.spawn(_v.x, _v.y, _v.z, -Math.sin(v.root.rotation.y) * 2 + (Math.random() - 0.5), 0.3, -Math.cos(v.root.rotation.y) * 2 + (Math.random() - 0.5), 1, 0.15, 0.6, 0.8, 0.78, 0.74, 0.6, 2, 0, 0, 1.2);
    v.doRecoil(1.5);
    await this.rocket(_v.x, _v.y, _v.z, tx, this.gy(ev.x, ev.y) + 0.3, tz);
    if (g !== R.gen) return;
    v.aimGoal = 0;
    await R._wait(300);
    if (g !== R.gen) return;
    if (cam) { const s = R.camStack[R.camStack.length - 1]; if (s && s.tag === 'blast') s.until = Math.min(s.until, R.playT + 1.1); }
  }

  /** shot_sentry {from, sentry, result, dmg}: a unit shoots at a sentry turret. */
  async _shotSentry(ev) {
    const R = this.R, g = R.gen, u = this.unit(ev.from);
    const s = this.sentries.get(ev.sentry);
    if (!u || !s) return;
    const show = R._unitSeen(u.id) || this.vis(s.x, s.y);
    if (!show) { this.call('shot', 1, R._weaponOf(u)); return; }
    const v = R.views[u.id];
    v.root.visible = true; v.setHunker(false);
    R._face(u.id, s.x, s.y); v.aimGoal = 1;
    await R._wait(240);
    if (g !== R.gen) return;
    v.settle(); v.muzzleWorld(_v);
    const p = s.o.position, hit = ev.result !== 'miss';
    const dx = p.x - _v.x, dz = p.z - _v.z, L = Math.hypot(dx, dz) || 1;
    this.call('shot', R._far(R.disp[u.id].x, R.disp[u.id].y), u.weapon?.id || R._weaponOf(u), { burst: 1 });
    R.fx.muzzle(_v.x, _v.y, _v.z, dx / L, dz / L, 1);
    const ix = hit ? p.x : p.x + (Math.random() - 0.5), iz = hit ? p.z : p.z + (Math.random() - 0.5);
    R.cfx.tracer(R.cos?.[u.id]?.tracer, _v.x, _v.y, _v.z, ix, hit ? 0.55 : 0.1, iz, new THREE.Color(R.teamColor(u.team)), 0.035);
    v.doRecoil(1);
    await R._wait(120);
    if (g !== R.gen) return;
    if (hit) R.fx.sparks(ix, 0.55, iz, 12, 5, 3.6, 1.6, 4); else { R.fx.dust(ix, iz, 4); R._text(s.x, s.y, 'MISS', '#c9d2d0', 0.8, 1.1); }
    await R._wait(260);
    v.aimGoal = 0;
  }

  /** shot_vehicle {from, vehicle, result, dmg}: small-arms fire on a boat (vehicle_damage follows). */
  async _shotVehicle(ev) {
    const R = this.R, g = R.gen, u = this.unit(ev.from);
    const b = this.boats.get(ev.vehicle);
    if (!u || !b) return;
    const show = R._unitSeen(u.id) || this._boatVisible(b);
    if (!show) { this.call('shot', 1, u.weapon?.id || R._weaponOf(u), { burst: 1 }); return; }
    const v = R.views[u.id];
    v.root.visible = true; v.setHunker(false);
    R._face(u.id, b.x, b.y); v.aimGoal = 1;
    await R._wait(240);
    if (g !== R.gen) return;
    v.settle(); v.muzzleWorld(_v);
    const p = b.o.position, hit = ev.result !== 'miss';
    const dx = p.x - _v.x, dz = p.z - _v.z, L = Math.hypot(dx, dz) || 1;
    this.call('shot', R._far(R.disp[u.id].x, R.disp[u.id].y), u.weapon?.id || R._weaponOf(u), { burst: 1 });
    R.fx.muzzle(_v.x, _v.y, _v.z, dx / L, dz / L, 1);
    const ix = hit ? p.x : p.x + (Math.random() - 0.5) * 1.4, iz = hit ? p.z : p.z + (Math.random() - 0.5) * 1.4;
    R.cfx.tracer(R.cos?.[u.id]?.tracer, _v.x, _v.y, _v.z, ix, hit ? 0.3 : WATER_Y, iz, new THREE.Color(R.teamColor(u.team)), 0.035);
    v.doRecoil(1);
    await R._wait(120);
    if (g !== R.gen) return;
    if (hit) R.fx.sparks(ix, 0.3, iz, 10, 5, 3.6, 1.6, 4); else { R.fx.splash(ix, iz, 0.5); R._text(b.x, b.y, 'MISS', '#c9d2d0', 0.8, 0.9); }
    await R._wait(240);
    v.aimGoal = 0;
  }

  /** noise {x, y, kind}: unseen gunfire / blast heard by my squad: a rough ping, never the exact tile. */
  _noise(ev) {
    const R = this.R;
    if (R.spectator || !Number.isFinite(ev.x)) return;
    if (ev.id !== null && ev.id !== undefined && (this.unit(ev.id)?.team === R.myTeam || this.seenUnit(ev.id))) return;
    if (this.vis(ev.x, ev.y)) return;
    const px = Math.round(ev.x / 3) * 3 + 1, py = Math.round(ev.y / 3) * 3 + 1;
    R._ping(Math.min(R.S - 1, px), Math.min(R.S - 1, py));
  }

  /** Launcher rocket: straight-ish flight with a smoke trail, explodes at the far end. */
  async rocket(ax, ay, az, bx, by, bz) {
    const R = this.R, g = R.gen;
    const o = this.add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.3, 6).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x4a5a3a, roughness: 0.6 })));
    const L = Math.hypot(bx - ax, by - ay, bz - az);
    o.position.set(ax, ay, az); o.lookAt(bx, by, bz);
    this.call('rocket');
    await R._anim(120 + L * 32, (t) => {
      o.position.set(lerp(ax, bx, t), lerp(ay, by, t) + Math.sin(t * Math.PI) * 0.15, lerp(az, bz, t));
      R.fx.alpha.spawn(o.position.x, o.position.y, o.position.z, (Math.random() - 0.5) * 0.3, 0.3, (Math.random() - 0.5) * 0.3, 1.2, 0.08, 0.35, 0.75, 0.73, 0.7, 0.6, 1.5, -0.1, 0, 1.2);
      R.fx.add.spawn(o.position.x, o.position.y, o.position.z, 0, 0, 0, 0.08, 0.12, 0.05, 6, 3.4, 1.2, 1, 0, 0, 0, 1.2);
    });
    this.drop(o);
    if (g !== R.gen) return;
    R.fx.explosion(bx, bz, 1.5, R._floodedWorld(bx, bz));
    this.call('explosion', 0.5);
    R.hitStop = 0.05;
  }

  /** Lob arc for a thrown object; resolves at the landing point. */
  async _lob(id, obj, tx, ty, tz, spin = 12, peakK = 1) {
    const R = this.R, v = R.views[id];
    const a0 = v.handWorld ? v.handWorld(_w) : _w.copy(v.root.position).setY(v.root.position.y + 0.95);
    const ax = a0.x, ay = a0.y, az = a0.z;
    const dist = Math.hypot(tx - ax, tz - az);
    const peak = (1.2 + dist * 0.25) * peakK;
    const dur = 380 + dist * 40;
    obj.position.set(ax, ay, az);
    await R._anim(dur, (t) => {
      obj.position.set(lerp(ax, tx, t), lerp(ay, ty, t) + Math.sin(t * Math.PI) * peak, lerp(az, tz, t));
      obj.rotation.set(t * spin, t * spin * 0.6, 0);
    });
  }

  /** Face the target and start the class throw animation; returns the release moment (s). */
  _throwPose(id, kind, tx, ty) {
    const R = this.R, v = R.views[id];
    R._face(id, tx, ty);
    v.setHunker(false); v.aimGoal = 0;
    if (v.doThrow) return v.doThrow(kind) || 0.2;
    v.doRecoil(1.4);
    return 0.2;
  }

  async _semtex(ev) {
    const R = this.R, g = R.gen;
    const u = this.unit(ev.id); if (!u) return;
    const tid = ev.target ?? ev.stuck ?? null;
    const tu = this.unit(tid);
    const tx = tu ? R.disp[tid].x : ev.x, ty = tu ? R.disp[tid].y : ev.y;
    const sVis = R._unitSeen(u.id), tVis = this.vis(tx, ty) || (tu && this.seenUnit(tid));
    const bx = this.wx(tx), bz = this.wz(ty);
    R._blast = { x: bx, z: bz };
    if (!sVis && !tVis) { this.call('explosion', 1); R._ping(tx, ty); this.feed(`Explosion to the ${compass(R.myRef(), tx, ty)}`); return; }
    const cam = R._pointCam('blast', (R.views[u.id].root.position.x + bx) / 2, (R.views[u.id].root.position.z + bz) / 2);
    const rel = sVis ? this._throwPose(u.id, 'semtex', tx, ty) : 0.2;
    await R._wait(rel * 1000);
    if (g !== R.gen) return;
    this.call('grenadeThrow');
    const o = this.add(makeSemtex());
    const tgtY = tu ? R.views[tid].root.position.y + 0.62 : this.gy(tx, ty) + 0.05;
    await this._lob(u.id, o, bx, tgtY, bz, 10, 0.8);
    if (g !== R.gen) { this.drop(o); return; }
    const stick = { o, t: 0, unit: tu ? tid : undefined };
    this.stuck.push(stick);
    this.call(tu ? 'semtexStick' : 'semtexBeep'); this.call('semtexBeep');
    if (tu && tVis) { R._textAt(tid, 'STUCK!', '#ff6a55', 1.1, 0.45); R.views[tid].doFlinch(0.5); }
    else R._text(tx, ty, 'SEMTEX', '#ff8a5a', 0.85, 1.3);
    await R._wait(820);
    this.stuck = this.stuck.filter((s) => s !== stick);
    this.drop(o);
    if (g !== R.gen) return;
    this.call('explosion', R._far(tx, ty));
    R.fx.explosion(bx, bz, ev.radius || 1.5, R._flooded(tx, ty));
    R.hitStop = 0.06;
    await R._wait(360);
    if (g !== R.gen) return;
    if (cam) { const s = R.camStack[R.camStack.length - 1]; if (s && s.tag === 'blast') s.until = Math.min(s.until, R.playT + 1.1); }
  }

  async _flashbang(ev) {
    const R = this.R, g = R.gen;
    const u = this.unit(ev.id);
    const bx = this.wx(ev.x), bz = this.wz(ev.y), by = this.gy(ev.x, ev.y);
    const hit = ev.hit || ev.affected || ev.ids || [];
    const immune = ev.immune || [];
    const sVis = u ? R._unitSeen(u.id) : false, tVis = this.vis(ev.x, ev.y);
    const mineHit = hit.some((id) => this.unit(id)?.team === R.myTeam);
    for (const id of hit) this.dazed.set(id, 0);
    if (!sVis && !tVis && !mineHit) { R._ping(ev.x, ev.y); this.call('flashbang', { far: 1, deafen: false }); return; }
    const cam = u ? R._pointCam('blast', bx, bz) : false;
    if (u && sVis) {
      const rel = this._throwPose(u.id, 'flashbang', ev.x, ev.y);
      await R._wait(rel * 1000);
      if (g !== R.gen) return;
      const o = this.add(makeFlashbang());
      this.call('grenadeThrow');
      await this._lob(u.id, o, bx, by + 0.08, bz, 14);
      this.drop(o);
      if (g !== R.gen) return;
      await R._wait(160); // the canister rattles before it pops
      if (g !== R.gen) return;
    }
    this.call('flashbang', { far: R._far(ev.x, ev.y), deafen: mineHit });
    const r = ev.radius || 1.5;
    // blinding pop: white core, hard ring, lingering sparkle haze
    R.fx.add.spawn(bx, by + 0.5, bz, 0, 0, 0, 0.35, 1.4, 5 * r, 12, 12, 12, 1, 0, 0, 0, 1.2);
    R.fx.add.spawn(bx, by + 0.5, bz, 0, 0, 0, 0.9, 0.8, 2.6 * r, 3, 3, 3.2, 1, 0, 0, 0, 1.6);
    R.fx.ring(bx, by + 0.08, bz, 0.2, r * 2.4, 0xffffff, 0.5, 1.6);
    R.fx.ring(bx, by + 0.1, bz, 0.2, r * 1.3, 0xffffff, 0.3, 2);
    R.fx.flashLight(bx, by + 1.2, bz, 0xffffff, 60, 0.6, 10);
    for (let i = 0; i < R.fx._n(30); i++) {
      const a = Math.random() * 6.28, s = 1 + Math.random() * 3;
      R.fx.add.spawn(bx, by + 0.4, bz, Math.cos(a) * s, 0.5 + Math.random() * 2, Math.sin(a) * s, 0.7 + Math.random() * 0.5, 0.05, 0.02, 4, 4, 4, 1, 2, 2, 0.8, 1);
    }
    R.fx.shake = Math.max(R.fx.shake, 0.4);
    R._flash = Math.max(R._flash, mineHit ? 1.0 : 0.45);
    R.whiteout(mineHit ? 1 : tVis ? 0.35 : 0);
    for (const id of hit) {
      const v = R.views[id];
      if (!v?.root.visible) continue;
      v.doFlinch(0.8);
      R._textAt(id, 'BLINDED', '#f4f4f4', 0.9, 0.3);
    }
    for (const id of immune) if (R.views[id]?.root.visible) R._textAt(id, 'MASKED', '#9fd8e0', 0.8, 0.3);
    await R._wait(520);
    if (g !== R.gen) return;
    if (cam) R._camRelease('blast');
  }

  async _knife(ev) {
    const R = this.R, g = R.gen;
    const u = this.unit(ev.id), tid = ev.target ?? ev.to, t = this.unit(tid);
    if (!u) return;
    const tx = t ? R.disp[tid].x : ev.x, ty = t ? R.disp[tid].y : ev.y;
    const hitting = ev.hit ?? (ev.result ? ev.result !== 'miss' : (ev.dmg || 0) > 0);
    // (HP and the damage number arrive with the sim's own damage event)
    const sVis = R._unitSeen(u.id), tVis = t ? R._unitSeen(tid) : this.vis(tx, ty);
    if (!sVis && !tVis) return; // silent
    const rel = this._throwPose(u.id, 'knife', tx, ty);
    await R._wait(rel * 1000);
    if (g !== R.gen) return;
    this.call('knifeThrow');
    const k = this.add(makeKnife());
    const B = t ? R.views[tid].root.position : _w.set(this.wx(tx), this.gy(tx, ty), this.wz(ty));
    const ix = hitting ? B.x : B.x + (Math.random() - 0.5) * 1.2, iz = hitting ? B.z : B.z + (Math.random() - 0.5) * 1.2;
    const iy = hitting ? B.y + 0.62 : 0.03;
    const vk = R.views[u.id];
    const a0 = vk.handWorld ? vk.handWorld(_v) : _v.copy(vk.root.position).setY(vk.root.position.y + 0.9);
    const ax = a0.x, ay = a0.y, az = a0.z;
    const L = Math.hypot(ix - ax, iz - az);
    k.rotation.order = 'YXZ';
    const yaw = Math.atan2(ix - ax, iz - az);
    await R._anim(160 + L * 55, (q) => {
      k.position.set(lerp(ax, ix, q), lerp(ay, iy, q) + Math.sin(q * Math.PI) * 0.25, lerp(az, iz, q));
      k.rotation.set(q * 22, yaw, 0);
      if (Math.random() < 0.5) R.fx.add.spawn(k.position.x, k.position.y, k.position.z, 0, 0, 0, 0.12, 0.04, 0.01, 2, 2.2, 2.4, 1, 0, 0, 0, 1);
    });
    if (g !== R.gen) { this.drop(k); return; }
    if (hitting && t) {
      this.call('knifeHit');
      k.rotation.set(-0.3, yaw, 0);
      R.fx.hitFlash(ix, iy, iz, 0.8, Math.sin(yaw), Math.cos(yaw));
      R.views[tid].doFlinch(1, Math.sin(yaw), Math.cos(yaw));
      if (tVis && ev.result === 'graze') R._textAt(tid, 'GRAZE', '#ffd9a0', 0.8, 0.4);
      k.visible = false;
    } else {
      k.rotation.set(0.6, yaw, 0); k.position.y = 0.06;
      R.fx.dust(ix, iz, 3);
      if (tVis && t) R._textAt(tid, 'MISS', '#c9d2d0', 0.9);
    }
    R.fx.timed(hitting ? 0.01 : 6, (q) => { if (q >= 1) this.drop(k); });
    await R._wait(320);
  }

  _addClaymore(key, x, y, team, dir) {
    if (this.claymores.has(key)) return;
    const o = makeClaymore();
    const d = Array.isArray(dir) ? dir : dir && typeof dir === 'object' ? [dir.x, dir.y] : [0, 1];
    const L = Math.hypot(d[0], d[1]) || 1;
    o.position.set(this.wx(x), this.gy(x, y), this.wz(y));
    o.rotation.y = Math.atan2(d[0] / L, d[1] / L);
    this.group.add(o);
    this.claymores.set(key, { o, x, y, team, dir: [d[0] / L, d[1] / L] });
  }

  async _claymorePlace(ev) {
    const R = this.R, g = R.gen, u = this.unit(ev.id);
    const team = this.teamOf(ev);
    let dir = ev.dir;
    if (!dir && u) { const d = R.disp[u.id]; dir = [ev.x - d.x || 0, ev.y - d.y || 1]; }
    const key = ev.claymoreId ?? ev.cid ?? `${ev.x},${ev.y}`;
    const show = this.mineTeam(team) || R.spectator || this.vis(ev.x, ev.y);
    if (u && show) {
      const v = R.views[u.id];
      R._face(u.id, ev.x, ev.y);
      const rel = v.doThrow ? v.doThrow('claymore') : (v.setHunker(true), 0.3);
      await R._wait(rel * 1000);
      if (g !== R.gen) return;
    }
    this._addClaymore(key, ev.x, ev.y, team, dir);
    if (show) {
      const c = this.claymores.get(key);
      c.o.scale.setScalar(0.01);
      await R._anim(220, (t) => c.o.scale.setScalar(Math.max(0.01, easeOutBack(t))));
      if (g !== R.gen) return;
      this.call('claymorePlace');
      R._text(ev.x, ev.y, 'CLAYMORE', '#ff8a7a', 0.75, 1.0);
      if (u) R.views[u.id].setHunker(!!u.hunkered);
      await R._wait(240);
    }
  }

  async _claymoreBlast(ev) {
    const R = this.R, g = R.gen;
    let key = ev.claymoreId ?? ev.cid ?? `${ev.x},${ev.y}`;
    if (!this.claymores.has(key)) for (const [k, c] of this.claymores) if (c.x === ev.x && c.y === ev.y) key = k;
    const c = this.claymores.get(key);
    const x = c ? c.x : ev.x, y = c ? c.y : ev.y;
    const bx = this.wx(x), bz = this.wz(y);
    R._blast = { x: bx, z: bz };
    if (!this.vis(x, y) && !(c && this.mineTeam(c.team))) {
      if (c) { disposeModel(c.o); this.claymores.delete(key); }
      this.call('explosion', 1); R._ping(x, y); return;
    }
    const cam = R._pointCam('blast', bx, bz, 9);
    this.call('claymoreTrigger', R._far(x, y));
    R._text(x, y, 'CLICK', '#ff8a7a', 0.7, 0.8);
    if (ev.target !== undefined && R.views[ev.target]?.root.visible) R.views[ev.target].doFlinch(0.5);
    await R._wait(240);
    if (g !== R.gen) return;
    if (c) { disposeModel(c.o); this.claymores.delete(key); }
    this.call('explosion', R._far(x, y));
    R.fx.explosion(bx, bz, 1.2, R._flooded(x, y));
    // directional ball-bearing spray along the claymore's facing
    const d = c ? c.dir : [0, 1];
    for (let i = 0; i < R.fx._n(36); i++) {
      const a = Math.atan2(d[1], d[0]) + (Math.random() - 0.5) * 1.1, s = 6 + Math.random() * 8;
      R.fx.add.spawn(bx, 0.3, bz, Math.cos(a) * s, Math.random() * 2, Math.sin(a) * s, 0.25 + Math.random() * 0.2, 0.04, 0.02, 6, 3.8, 1.6, 1, 2, 4, 2, 1);
    }
    R.hitStop = 0.06;
    await R._wait(340);
    if (g !== R.gen) return;
    if (cam) { const s = R.camStack[R.camStack.length - 1]; if (s && s.tag === 'blast') s.until = Math.min(s.until, R.playT + 1.0); }
  }

  /** Engineer barricade: telescoping steel wall rises, then becomes a full-cover prop. */
  async _deployCover(ev) {
    const R = this.R, g = R.gen;
    const u = this.unit(ev.id);
    const team = this.teamOf(ev);
    const x = ev.x, y = ev.y;
    let axis = 0; // panel along x (blocks north/south)
    if (u) { const d = R.disp[u.id]; axis = Math.abs(x - d.x) > Math.abs(y - d.y) ? 1 : 0; }
    const col = team >= 0 ? R.teamColor(team) : '#ffb000';
    const show = this.vis(x, y) || this.mineTeam(team) || R.spectator;
    R.props.markBarricade?.(x, y, axis, col);
    if (!show) { R.props.setCover(x, y, 2); return; }
    let plant = 0.22;
    if (u) {
      const v = R.views[u.id];
      R._face(u.id, x, y);
      plant = v.doDeployCover ? v.doDeployCover() : (v.setHunker(true), 0.22);
    }
    const cam = R._pointCam('blast', this.wx(x), this.wz(y), 8);
    await R._wait(plant * 1000);
    if (g !== R.gen) return;
    this.call('deployCover');
    const o = this.add(makeBarricade(new THREE.Color(col).getHex()));
    o.position.set(this.wx(x), this.gy(x, y), this.wz(y));
    o.rotation.y = axis ? Math.PI / 2 : 0;
    const panel = o.userData.panel;
    R.fx.dust(o.position.x, o.position.z, 10, 0.78, 0.72, 0.6, 0.05, 1.2);
    await R._anim(420, (t) => {
      const e = easeOutBack(t, 2.2);
      panel.scale.set(1, Math.max(0.02, e), 1);
      if (Math.random() < 0.4) R.fx.sparks(o.position.x, 0.1, o.position.z, 2, 5, 3.4, 1.6, 2);
    });
    if (g !== R.gen) { this.drop(o); return; }
    R.fx.ring(o.position.x, o.position.y + 0.06, o.position.z, 0.3, 1.1, 0xeaf3ef, 0.4, 0.8);
    R.fx.shake = Math.max(R.fx.shake, 0.2);
    R.props.setCover(x, y, 2);
    this.drop(o);
    R._text(x, y, 'COVER UP', '#efe7d4', 0.8, 1.5);
    if (u) R.views[u.id].setHunker(!!u.hunkered);
    await R._wait(300);
    if (g !== R.gen) return;
    if (cam) R._camRelease('blast');
  }

  async _repair(ev) {
    const R = this.R;
    const b = this.boats.get(ev.vehicle ?? ev.target);
    if (ev.hp !== undefined && b) b.hp = ev.hp; else if (b) b.hp = (b.hp ?? 12) + (ev.amount || 4);
    if (!b || !this._boatVisible(b)) return;
    const u = this.unit(ev.id);
    if (u) { R._face(u.id, b.x, b.y); R.views[u.id].doReload(); }
    const p = b.o.position;
    this.call('repair');
    for (let i = 0; i < 4; i++) { R.fx.sparks(p.x, 0.35, p.z, 5, 5, 4, 2.5, 2.5); await R._wait(110); }
    R.fx.healPulse(p.x, p.z, 0.9);
    R._text(b.x, b.y, `REPAIRED +${ev.amount || 4}`, '#7fe9ff', 0.9, 1.0);
    await R._wait(300);
  }

  // ---------- killstreaks ----------
  async _streakReady(ev) {
    const R = this.R, u = this.unit(ev.id);
    if (!u || u.team !== R.myTeam) return;
    const v = R.views[ev.id];
    if (!v.root.visible) return;
    const p = v.root.position;
    R.fx.ring(p.x, p.y + 0.07, p.z, 0.2, 1.2, GOLD, 0.7, 1.2);
    for (let i = 0; i < 12; i++) R.fx.add.spawn(p.x + (Math.random() - 0.5) * 0.5, p.y + 0.2, p.z + (Math.random() - 0.5) * 0.5, 0, 1.5 + Math.random(), 0, 0.8, 0.06, 0.02, 4, 3, 1, 1, 1, 0, 0.6, 1);
    R._textAt(ev.id, `${STREAK_NAME[ev.key] || String(ev.key || '').toUpperCase()} READY`, '#ffd36a', 0.85, 0.35);
    this.call('streakReady', ev.key);
    await R._wait(300);
  }

  async _streakUsed(ev) {
    const R = this.R, g = R.gen, u = this.unit(ev.id);
    if (!u) return;
    const key = ev.key;
    const v = R.views[ev.id];
    // a care-package marker smoke can come with the call-in
    if ((key === 'care_package' || key === 'carePackage') && Number.isFinite(ev.x)) this._flare(ev.x, ev.y, false);
    if (!this.seenUnit(ev.id)) return;
    this.call('streakCall', key);
    if (v.doThrow && Number.isFinite(ev.x)) { R._face(ev.id, ev.x, ev.y); v.doThrow('flare'); } else v.doReload();
    const p = v.root.position;
    R.fx.ring(p.x, p.y + 0.07, p.z, 0.2, 1.3, u.team === R.myTeam ? TEAM.amber : MAGENTA, 0.6, 1);
    R._textAt(ev.id, STREAK_NAME[key] || String(key || 'STREAK').toUpperCase(), '#ffd36a', 1.0, 0.35);
    await R._wait(360);
    if (g !== R.gen) return;
  }

  _flare(x, y, gold) {
    const key = `${x},${y}`;
    const f = this.flares.get(key);
    if (f) { f.gold = f.gold || gold; return f; }
    const o = { x: this.wx(x), z: this.wz(y), gold, t: 0, landed: false, lt: 0 };
    this.flares.set(key, o);
    return o;
  }

  async _uav(ev) {
    const R = this.R, g = R.gen;
    const team = ev.team ?? this.unit(ev.id)?.team ?? -1;
    const x = ev.x ?? R.disp[ev.id]?.x ?? R.S / 2, y = ev.y ?? R.disp[ev.id]?.y ?? R.S / 2, r = ev.r ?? ev.radius ?? 14;
    const cx = this.wx(x), cz = this.wz(y);
    const mine = this.mineTeam(team) || R.spectator;
    // the drone flies in and orbits until the reveal ends
    let u = this.uavs.get(team);
    if (!u) {
      const o = skinned('uav', R.cos?.[ev.id]?.streakSkin, makeDrone);
      this.group.add(o);
      u = { o, cx, cz, r: Math.min(6, r * 0.45), a: Math.random() * 6 };
      this.uavs.set(team, u);
    } else { u.cx = cx; u.cz = cz; }
    // reveals: explicit list, else what the sim says the team now sees
    let ids = ev.revealed || ev.ids;
    if (!ids) {
      const rv = (this.st.reveals || []).find((q) => q.team === team);
      ids = rv ? rv.ids.filter((id) => { const d = R.disp[id]; return d && Math.hypot(d.x - x, d.y - y) <= r; }) : [];
    }
    let s = R.reveals.get(team);
    if (!s) R.reveals.set(team, (s = new Set()));
    for (const id of ids) s.add(id);
    if (!mine) {
      this.feed('Enemy UAV overhead');
      this.call('uavOnline', { enemy: true });
      R._refreshUnits();
      return;
    }
    this.call('uavOnline', { enemy: false });
    const cam = R._pointCam('scan', cx, cz, 16);
    if (cam) R.viewGoal = Math.max(R.viewGoal, Math.min(26, r * 1.4));
    u.o.position.set(cx - 20, 9, cz - 20);
    await R._wait(500);
    if (g !== R.gen) return;
    R.fx.scanSweep(cx, cz, r, 2.2);
    R.fx.ring(cx, 0.12, cz, 0.5, r, CYAN, 1.4, 0.9);
    await R._wait(1100);
    if (g !== R.gen) return;
    R._refreshUnits();
    for (const id of ids) { const p = R.views[id]?.root.position; if (p) R.fx.revealPing(p.x, p.z); }
    R._text(x, y, ids.length ? `UAV · ${ids.length} CONTACT${ids.length > 1 ? 'S' : ''}` : 'UAV · NO CONTACTS', '#7fe9ff', 1.1, 1.2);
    await R._wait(700);
    if (g !== R.gen) return;
    if (cam) R._camRelease('scan');
  }

  _flyOff(o) {
    const R = this.R;
    const x0 = o.position.x, z0 = o.position.z, y0 = o.position.y;
    const dx = Math.sin(o.rotation.y), dz = Math.cos(o.rotation.y);
    this.temp.add(o);
    R.fx.timed(2.5, (t) => {
      o.position.set(x0 + dx * t * 30, y0 + t * 4, z0 + dz * t * 30);
      if (t >= 1) this.drop(o);
    });
  }

  async _counterUav(ev) {
    const R = this.R;
    const team = ev.team ?? this.unit(ev.id)?.team;
    // enemy drones jam: they flicker and spin out
    for (const [t, u] of this.uavs) if (t !== team) { this.uavs.delete(t); this._flyOff(u.o); }
    if (this.mineTeam(team) || R.spectator) {
      R._text(R.myRef().x, R.myRef().y, 'COUNTER-UAV ONLINE', '#7fe9ff', 1.0, 1.6);
      this.call('counterUav');
      await R._wait(500);
    } else if (team !== undefined) { this.feed('Enemy Counter-UAV: your scans are jammed'); R.glitch?.(0.6); }
  }

  async _carePackage(ev) {
    const R = this.R, g = R.gen;
    const c = ev.crate || ev;
    if (!Number.isFinite(c.x)) return;
    const gold = !!(c.legendary || c.gold || c.type === 'legendary' || c.type === 'gold' || c.rarity === 'legendary');
    const f = this._flare(c.x, c.y, gold);
    const gx = this.wx(c.x), gz = this.wz(c.y), gy = this.gy(c.x, c.y);
    const visible = this.vis(c.x, c.y) || R.spectator;
    const cp = makeCarePackage(gold);
    const holder = new THREE.Group();
    holder.add(cp);
    holder.position.set(gx, gy, gz);
    // register as a pickup so the normal crate events remove it
    const dummy = new THREE.Object3D();
    holder.userData = { spin: dummy, beam: null, phase: 0, big: true, cp: true };
    if (gold) {
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.4, 6, 12, 1, true).translate(0, 3, 0), glowMat(new THREE.Color(GOLD).multiplyScalar(0.9), 0.22));
      beam.renderOrder = 6;
      holder.add(beam);
      holder.userData.goldBeam = beam;
    }
    if (c.id !== undefined) {
      if (R.crateMeshes.has(c.id)) R._removeCrate(c.id);
      R.world.add(holder);
      R.crateMeshes.set(c.id, holder); R.crateList.push(holder);
    } else this.add(holder);
    this.feed(`${gold ? 'Legendary care package' : 'Care package'} inbound to the ${compass(R.myRef(), c.x, c.y)}`);
    if (!visible || R._fast) { f.landed = true; return; }
    const cam = R._pointCam('supply', gx, gz, 13);
    this.call('carePackage', R._far(c.x, c.y));
    // cargo plane pass overhead
    const plane = this.add(makeGunship(0x5d6560));
    plane.scale.setScalar(0.9);
    const ang = Math.random() * Math.PI * 2, dx = Math.cos(ang), dz = Math.sin(ang);
    plane.rotation.y = Math.atan2(dx, dz);
    const H = 11;
    await R._anim(900, (t) => plane.position.set(gx - dx * 22 * (1 - t), H, gz - dz * 22 * (1 - t)));
    if (g !== R.gen) { this.drop(plane); return; }
    R.fx.timed(1.4, (t) => { plane.position.set(gx + dx * 26 * t, H + t * 2, gz + dz * 26 * t); if (t >= 1) this.drop(plane); });
    // crate + parachute descent
    const chute = R._makeChute();
    chute.scale.setScalar(1.6);
    chute.position.y = 0.35;
    cp.add(chute);
    if (holder.userData.goldBeam) holder.userData.goldBeam.visible = false;
    await R._anim(1700, (t) => {
      const e = t * t * (0.35 + 0.65 * t);
      cp.position.set(Math.sin(t * 5) * 0.25 * (1 - t), H * (1 - e), 0);
      cp.rotation.set(Math.sin(t * 7) * 0.12 * (1 - t), Math.sin(t * 3) * 0.4, Math.cos(t * 6) * 0.1 * (1 - t));
      if (gold && Math.random() < 0.6) R.fx.add.spawn(gx + cp.position.x, gy + cp.position.y + 0.4, gz, 0, -0.3, 0, 0.5, 0.06, 0.02, 4, 3, 1, 1, 1, 0, 0, 1);
    });
    cp.position.set(0, 0, 0); cp.rotation.set(0, 0, 0);
    if (g !== R.gen) return;
    f.landed = true;
    R.fx.dust(gx, gz, 22, 0.8, 0.74, 0.6, 0.05, 2.6);
    R.fx.ring(gx, gy + 0.08, gz, 0.3, 2.8, gold ? GOLD : 0xeaf3ef, 0.6, 1.2);
    R.fx.flashLight(gx, 1, gz, gold ? GOLD : CYAN, 24, 0.5, 6);
    if (R._flooded(c.x, c.y)) R.fx.splash(gx, gz, 2);
    R.fx.shake = Math.max(R.fx.shake, 0.5);
    this.call('crateLand', R._far(c.x, c.y));
    if (gold) {
      holder.userData.goldBeam && (holder.userData.goldBeam.visible = true);
      for (let i = 0; i < R.fx._n(40); i++) {
        const a = Math.random() * 6.28, s = 1 + Math.random() * 2.5;
        R.fx.add.spawn(gx, gy + 0.5, gz, Math.cos(a) * s, 2 + Math.random() * 3, Math.sin(a) * s, 0.9, 0.08, 0.03, 5, 3.6, 1.2, 1, 2, 3, 1, 1);
      }
      R._text(c.x, c.y, 'LEGENDARY', '#ffd36a', 1.25, 1.6);
    }
    // chute collapses
    const cm = chute.material;
    R.fx.timed(1.3, (t) => {
      chute.position.set(t * 0.9, 0.35 - t * 1.0, t * 0.3); chute.rotation.z = t * 1.1; cm.opacity = 1 - t;
      if (t >= 1 && chute.parent) { cp.remove(chute); cm.dispose(); }
    });
    await R._wait(700);
    if (g !== R.gen) return;
    if (cam) R._camRelease('supply');
  }

  async _airstrikeMark(ev) {
    const R = this.R, g = R.gen;
    const tiles = tilesOf(ev.tiles, R.S);
    if (!tiles.length) return;
    this.marks.set(ev.id ?? ev.markId ?? JSON.stringify(tiles[0]), { tiles, t: 0, round: ev.round, owner: ev.owner });
    const [ax, ay] = tiles[0], [bx, by] = tiles[tiles.length - 1];
    const cx = (ax + bx) / 2, cy = (ay + by) / 2;
    this.call('airstrikeMark', { enemy: !this.mineTeam(this.unit(ev.owner)?.team) });
    this.feed(`Airstrike marked to the ${compass(R.myRef(), cx, cy)}: clear the red line`);
    const cam = R._pointCam('blast', this.wx(cx), this.wz(cy), 12);
    for (const [x, y] of tiles) R.fx.ring(this.wx(x), this.gy(x, y) + 0.08, this.wz(y), 0.2, 0.7, RED, 0.6, 0.9);
    R._text(cx, cy, 'AIRSTRIKE INBOUND', '#ff6a55', 1.15, 1.4);
    await R._wait(900);
    if (g !== R.gen) return;
    if (cam) R._camRelease('blast');
  }

  async _airstrike(ev) {
    const R = this.R, g = R.gen;
    let tiles = tilesOf(ev.tiles, R.S);
    let key = ev.id ?? ev.markId;
    if (key === undefined || !this.marks.has(key)) {
      for (const [k, m] of this.marks) if (!tiles.length || (m.tiles[0][0] === tiles[0][0] && m.tiles[0][1] === tiles[0][1])) { key = k; if (!tiles.length) tiles = m.tiles; break; }
    }
    if (!tiles.length) return;
    const [ax, ay] = tiles[0], [bx, by] = tiles[tiles.length - 1];
    const A = new THREE.Vector3(this.wx(ax), 0, this.wz(ay)), B = new THREE.Vector3(this.wx(bx), 0, this.wz(by));
    const dir = B.clone().sub(A); const L = dir.length() || 1; dir.divideScalar(L);
    const cx = (A.x + B.x) / 2, cz = (A.z + B.z) / 2;
    R._blast = { x: cx, z: cz };
    const vis = R.spectator || tiles.some(([x, y]) => this.vis(x, y));
    if (!vis || R._fast) {
      this.marks.delete(key);
      for (const [x, y] of tiles) if (vis) R.fx.explosion(this.wx(x), this.wz(y), 1.2, R._flooded(x, y));
      this.call('explosion', 1);
      if (!vis) this.feed(`Airstrike to the ${compass(R.myRef(), (ax + bx) / 2, (ay + by) / 2)}`);
      return;
    }
    // cinematic: pull wide on the run line, jets scream in low, bombs walk the line
    const cam = R._cine;
    const dir5 = cam && typeof R.cineBegin === 'function';
    if (dir5) {
      await R.cineBegin({ kind: 'airstrike', name: 'AIRSTRIKE', sub: 'Danger close', tiles, light: true });
      if (g !== R.gen) return;
      await R._sleepReal((R.pacing?.cine.pre ?? 400) * 0.4);
      if (g !== R.gen) return;
      R.director.slowmo(Math.max(0.75, R.pacing?.slow ?? 0.75));
    } else if (cam) {
      R._camPush('setpiece');
      R.goal.set(cx, 0, cz); R.followId = null;
      R.viewGoal = Math.max(10, R._fitView(A, B, 5, 6));
      R.elevGoal = 0.6;
    }
    this.call('jetsFlyby', R._far((ax + bx) / 2, (ay + by) / 2));
    const jskin = R.cos?.[ev.owner ?? this.marks.get(key)?.owner]?.streakSkin;
    const jets = [this.add(skinned('airstrike', jskin, makeJet)), this.add(skinned('airstrike', jskin, makeJet))];
    const yaw = Math.atan2(dir.x, dir.z);
    for (const j of jets) j.rotation.y = yaw;
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const start = A.clone().addScaledVector(dir, -16), end = B.clone().addScaledVector(dir, 22);
    const runMs = 1500;
    let next = 0;
    const span = end.clone().sub(start);
    const tA = 16 / span.length(), tB = (16 + L) / span.length();
    await R._anim(runMs, (t) => {
      jets.forEach((j, i) => {
        const o = (i ? 1 : -1) * 0.9, lag = i * 0.04;
        const tt = Math.max(0, t - lag);
        j.position.copy(start).addScaledVector(span, tt).addScaledVector(side, o);
        j.position.y = 4.2 + i * 0.4 + Math.sin(tt * Math.PI) * 0.6;
        j.rotation.z = Math.sin(tt * 6 + i) * 0.08;
        if (Math.random() < 0.9) R.fx.alpha.spawn(j.position.x - dir.x * 1.2, j.position.y, j.position.z - dir.z * 1.2, 0, 0, 0, 1.4, 0.08, 0.32, 0.9, 0.92, 0.94, 0.5, 0.3, -0.05, 0, 1.2);
      });
      // bombs: one per tile as the lead jet passes over it
      while (next < tiles.length && t >= tA + (tB - tA) * (next / Math.max(1, tiles.length - 1)) - 0.02) {
        const [x, y] = tiles[next];
        const i = next;
        R.fx.timed(0.22 + i * 0.015, (q) => {
          if (q < 1 || g !== R.gen) return;
          const px = this.wx(x), pz = this.wz(y);
          R.fx.explosion(px, pz, 1.0, R._flooded(x, y));
          R.fx.flashLight(px, 1.5, pz, 0xff8a3a, 40, 0.5, 8);
          R.fx.debrisBurst(px, 0.3, pz, [0x3d3a33, 0x6b6253, 0x8d7f63], 10, 1.4);
          for (let k = 0; k < R.fx._n(12); k++) R.fx.alpha.spawn(px + (Math.random() - 0.5) * 0.6, 0.6, pz + (Math.random() - 0.5) * 0.6, (Math.random() - 0.5), 1.8 + Math.random() * 1.6, (Math.random() - 0.5), 2.4 + Math.random(), 0.5, 1.8, 0.2, 0.19, 0.18, 0.7, 0.8, -0.2, 0, 1.2);
          R.fx.shake = Math.min(1.2, R.fx.shake + 0.35);
          if (i === 0) this.call('airstrike', R._far(x, y));
        });
        next++;
      }
    });
    for (const j of jets) this.drop(j);
    this.marks.delete(key);
    if (g !== R.gen) return;
    await R._wait(650);
    if (g !== R.gen) return;
    R.hitStop = 0.05;
    if (dir5) { R.slowGoal = 1; if (!R.cineManaged) await R.cineEnd(R.pacing?.cine.post ?? 800); return; }
    if (cam) { const s = R.camStack[R.camStack.length - 1]; if (s && s.tag === 'setpiece') s.until = Math.min(s.until, R.playT + 1.6); }
  }

  _addSentry(id, x, y, team) {
    if (this.sentries.has(id)) return this.sentries.get(id);
    const o = makeSentry(team >= 0 ? this.R.teamColor(team) : '#ff3a2a');
    o.position.set(this.wx(x), this.gy(x, y), this.wz(y));
    // face the map centre by default
    const yaw0 = Math.atan2(-o.position.x, -o.position.z);
    o.userData.yaw.rotation.y = yaw0;
    this.group.add(o);
    const s = { o, x, y, team, yaw0, yawGoal: yaw0, ph: Math.random() * 6, busy: false };
    this.sentries.set(id, s);
    return s;
  }

  async _sentry(ev) {
    const R = this.R, g = R.gen;
    const team = ev.team ?? this.unit(ev.owner ?? ev.id)?.team ?? -1;
    const id = ev.sentryId ?? ev.sid ?? ev.id ?? `${ev.x},${ev.y}`;
    const s = this._addSentry(id, ev.x, ev.y, team);
    if (Array.isArray(ev.dir) && (ev.dir[0] || ev.dir[1])) { s.yaw0 = s.yawGoal = Math.atan2(ev.dir[0], ev.dir[1]); s.o.userData.yaw.rotation.y = s.yaw0; }
    const show = this.vis(ev.x, ev.y) || this.mineTeam(team) || R.spectator;
    if (!show) return;
    const cam = R._pointCam('blast', this.wx(ev.x), this.wz(ev.y), 9);
    this.call('sentryDeploy');
    const y0 = s.o.position.y;
    s.o.scale.set(1, 0.01, 1);
    await R._anim(480, (t) => {
      s.o.position.y = y0 + (1 - easeOutCubic(t)) * 2.5;
      s.o.scale.set(1, Math.max(0.01, easeOutBack(t)), 1);
    });
    if (g !== R.gen) return;
    s.o.position.y = y0;
    R.fx.dust(s.o.position.x, s.o.position.z, 10, 0.78, 0.72, 0.6, 0.05, 1.3);
    R.fx.ring(s.o.position.x, y0 + 0.07, s.o.position.z, 0.2, 1.6, new THREE.Color(this.colorOf(team)).getHex(), 0.6, 1.1);
    R._text(ev.x, ev.y, 'SENTRY ONLINE', '#efe7d4', 0.9, 1.4);
    await R._wait(420);
    if (g !== R.gen) return;
    if (cam) R._camRelease('blast');
  }

  async _sentryShot(ev) {
    const R = this.R, g = R.gen;
    let s = this.sentries.get(ev.sentryId ?? ev.sid ?? ev.id);
    if (!s && this.sentries.size === 1) s = [...this.sentries.values()][0];
    const tid = ev.target ?? ev.to;
    const t = this.unit(tid);
    if (!s || !t) return;
    const hitting = ev.result ? ev.result !== 'miss' : ev.hit ?? (ev.dmg || 0) > 0;
    if (hitting && ev.dmg) R.disp[tid].hp = Math.max(0, R.disp[tid].hp - ev.dmg);
    const vis = this.vis(s.x, s.y) || R._unitSeen(tid);
    if (!vis) { R._drawLabel(t); this.call('shot', 1, 'LMG'); return; }
    const B = R.views[tid].root.position;
    s.busy = true;
    s.yawGoal = Math.atan2(B.x - s.o.position.x, B.z - s.o.position.z);
    const cam = R._actionCam(s.o.position, B, false);
    await R._wait(260);
    if (g !== R.gen) return;
    const col = new THREE.Color(this.colorOf(s.team));
    for (let i = 0; i < 3; i++) {
      s.o.userData.muzzle.getWorldPosition(_v);
      const dx = B.x - _v.x, dz = B.z - _v.z, L = Math.hypot(dx, dz) || 1;
      const ix = hitting ? B.x : B.x + (Math.random() - 0.5) * 1.4, iz = hitting ? B.z : B.z + (Math.random() - 0.5) * 1.4, iy = hitting ? B.y + 0.6 : 0.1;
      this.call('sentryShot', R._far(s.x, s.y));
      R.fx.muzzle(_v.x, _v.y, _v.z, dx / L, dz / L, 0.7);
      R.fx.tracer(_v.x, _v.y, _v.z, ix, iy, iz, col, 0.028, 0.12);
      s.o.userData.barrel.position.z = -0.06;
      await R._wait(80);
      if (g !== R.gen) return;
      if (hitting) R.fx.hitFlash(ix, iy, iz, 0.6, dx / L, dz / L); else R.fx.dust(ix, iz, 3);
    }
    if (hitting) { this.call('hit', false); R.views[tid].doFlinch(1); if (ev.dmg) R._textAt(tid, '-' + ev.dmg, '#ff6a55', 1.1); }
    else { this.call('miss'); R._textAt(tid, 'MISS', '#c9d2d0', 0.9); }
    R._drawLabel(t);
    await R._wait(320);
    s.busy = false;
    if (g !== R.gen) return;
    if (cam) R._camRelease('shot');
  }

  async _sentryEnd(ev) {
    const R = this.R, g = R.gen;
    const id = ev.sentryId ?? ev.sid ?? ev.id;
    const s = this.sentries.get(id);
    if (!s) return;
    this.sentries.delete(id);
    const show = this.vis(s.x, s.y) || this.mineTeam(s.team);
    const p = s.o.position;
    if (ev.type === 'sentry_destroyed' && show) {
      this.call('explosion', R._far(s.x, s.y));
      R.fx.explosion(p.x, p.z, 0.9, false);
      R.fx.debrisBurst(p.x, 0.5, p.z, [0x5b6468, 0x2d3234, 0x1d2022], 14, 1.2);
      disposeModel(s.o);
      await R._wait(300);
      return;
    }
    if (!show) { disposeModel(s.o); return; }
    this.temp.add(s.o);
    await R._anim(400, (t) => { s.o.scale.set(1, Math.max(0.01, 1 - t), 1); });
    this.drop(s.o);
    if (g !== R.gen) return;
    R.fx.dust(p.x, p.z, 6);
  }

  async _gunshipStart(ev) {
    const R = this.R, g = R.gen;
    const team = ev.team ?? this.unit(ev.id)?.team ?? -1;
    if (this.gunships.has(team)) return;
    const skin = R.cos?.[ev.owner ?? ev.id]?.streakSkin;
    const o = skinned('gunship', skin, () => makeGunship(0x4e575a));
    this.group.add(o);
    // orbit over the owning squad (or the map centre)
    let cx = 0, cz = 0, n = 0;
    for (const id of this.st.teams[team]?.members || []) { const d = R.disp[id]; if (d?.alive) { cx += this.wx(d.x); cz += this.wz(d.y); n++; } }
    if (n) { cx /= n; cz /= n; }
    cx *= 0.5; cz *= 0.5;
    const gs = { o, cx, cz, r: 11, a: Math.random() * 6, leaving: false, lt: 0, team, tracer: CFX.streakLook?.(skin)?.tracer ?? null };
    this.gunships.set(team, gs);
    this.call('gunshipStart');
    this.feed(this.mineTeam(team) ? 'Gunship on station' : 'Enemy gunship overhead');
    if (!R._cine) return;
    R._camPush('streak');
    R.goal.set(cx, 0, cz); R.followId = null; R.viewGoal = Math.max(R.viewGoal, 24);
    await R._wait(1400);
    if (g !== R.gen) return;
    R._camRelease('streak');
  }

  async _gunshipShot(ev) {
    const R = this.R, g = R.gen;
    const tid = ev.target ?? ev.to;
    const t = this.unit(tid);
    if (!t) return;
    let gs = this.gunships.get(ev.team ?? this.unit(ev.id)?.team);
    if (!gs) gs = [...this.gunships.values()][0];
    const hitting = ev.result ? ev.result !== 'miss' : ev.hit ?? (ev.dmg || 0) > 0;
    const tVis = R._unitSeen(tid);
    if (!tVis) { this.call('explosion', 1); return; }
    const B = R.views[tid].root.position;
    const cam = R._pointCam('blast', B.x, B.z, 10);
    await R._wait(200);
    if (g !== R.gen) return;
    const ix = hitting ? B.x : B.x + (Math.random() - 0.5) * 1.6, iz = hitting ? B.z : B.z + (Math.random() - 0.5) * 1.6;
    // a short walking burst of 25mm, then the heavy round
    for (let i = 0; i < 4; i++) {
      if (gs) gs.o.userData.muzzle.getWorldPosition(_v); else _v.set(B.x - 8, 10, B.z - 8);
      const px = ix + (Math.random() - 0.5) * 1.2, pz = iz + (Math.random() - 0.5) * 1.2;
      R.fx.tracer(_v.x, _v.y, _v.z, px, 0.1, pz, _c.set(gs?.tracer ?? 0xffd27a), 0.05, 0.18);
      R.fx.add.spawn(_v.x, _v.y, _v.z, 0, 0, 0, 0.1, 0.4, 0.8, 6, 4.6, 2.4, 1, 0, 0, 0, 1.2);
      this.call('gunshipCannon', R._far(R.disp[tid].x, R.disp[tid].y));
      await R._wait(90);
      if (g !== R.gen) return;
      if (R._floodedWorld(px, pz)) R.fx.splash(px, pz, 0.7); else { R.fx.dust(px, pz, 5, 0.7, 0.64, 0.55, 0.1, 1); R.fx.sparks(px, 0.15, pz, 6, 6, 3.6, 1.6, 4); }
    }
    if (gs) gs.o.userData.muzzle.getWorldPosition(_v);
    R.fx.tracer(_v.x, _v.y, _v.z, ix, hitting ? B.y + 0.4 : 0.1, iz, new THREE.Color(0xfff0b0), 0.11, 0.25);
    await R._wait(120);
    if (g !== R.gen) return;
    R.fx.explosion(ix, iz, 0.9, R._floodedWorld(ix, iz));
    this.call('explosion', R._far(R.disp[tid].x, R.disp[tid].y));
    if (hitting) R.views[tid].doFlinch(1);
    else R._textAt(tid, 'MISS', '#c9d2d0', 0.9);
    await R._wait(420);
    if (g !== R.gen) return;
    if (cam) R._camRelease('blast');
  }

  _gunshipEnd(ev) {
    const team = ev.team ?? this.unit(ev.id)?.team;
    const gs = this.gunships.get(team) || (this.gunships.size === 1 ? [...this.gunships.values()][0] : null);
    if (!gs) return;
    this.gunships.delete(gs.team);
    this.call('gunshipEnd');
    gs.leaving = true;
    this.temp.add(gs.o);
    const o = gs.o;
    this.R.fx.timed(3, (t) => {
      gs.a += 0.004; gs.lt += 0.016;
      o.position.y = 10 + t * 6;
      o.position.x += Math.sin(o.rotation.y) * 0.4; o.position.z += Math.cos(o.rotation.y) * 0.4;
      if (t >= 1) this.drop(o);
    });
  }

  // ---------- boats ----------
  _addBoat(v) {
    if (this.boats.has(v.id)) return this.boats.get(v.id);
    const o = makeBoat();
    o.position.set(this.wx(v.x), WATER_Y - 0.02, this.wz(v.y));
    o.rotation.y = Math.atan2(-o.position.x, -o.position.z) + Math.PI; // bow out to sea
    this.group.add(o);
    const b = { o, id: v.id, x: v.x, y: v.y, seats: [...(v.seats || [])], hp: v.hp, ph: Math.random() * 6, moving: false };
    this.boats.set(v.id, b);
    for (const id of b.seats) this.aboard.set(id, v.id);
    return b;
  }

  _boatOf(ev) {
    const vid = ev.vehicle ?? ev.vid ?? ev.boat;
    if (vid !== undefined && this.boats.has(vid)) return this.boats.get(vid);
    for (const v of this.st.vehicles || []) if (v.seats?.includes(ev.id) && this.boats.has(v.id)) return this.boats.get(v.id);
    if (Number.isFinite(ev.x)) for (const b of this.boats.values()) if (b.x === ev.x && b.y === ev.y) return b;
    return null;
  }

  async _board(ev) {
    const R = this.R, g = R.gen;
    let b = this._boatOf(ev);
    if (!b) { const sv = (this.st.vehicles || []).find((v) => v.id === (ev.vehicle ?? ev.vid)); if (sv) b = this._addBoat(sv); }
    if (!b || !this.unit(ev.id)) return;
    if (!b.seats.includes(ev.id)) b.seats.push(ev.id);
    this.aboard.set(ev.id, b.id);
    const v = R.views[ev.id], d = R.disp[ev.id];
    d.x = b.x; d.y = b.y;
    if (!this._boatVisible(b)) return;
    this.call('board');
    const seat = b.o.userData.seats[Math.min(b.seats.indexOf(ev.id), 3)];
    b.o.updateMatrixWorld(true);
    _w.copy(seat).applyMatrix4(b.o.matrixWorld);
    const a = v.root.position.clone();
    b.hop = ev.id;
    await R._anim(320, (t) => {
      v.root.position.set(lerp(a.x, _w.x, t), lerp(a.y, _w.y, t) + Math.sin(t * Math.PI) * 0.45, lerp(a.z, _w.z, t));
    });
    b.hop = null;
    if (g !== R.gen) return;
    b.roll = 0.12;
    R.fx.timed(0.6, (t) => { b.roll = 0.12 * (1 - t) * Math.cos(t * 12); });
    R.fx.splash(_w.x, _w.z, 0.45);
    if (this.unit(ev.id).team === R.myTeam) R.refreshFog(); else R._syncUnitVisibility(this.unit(ev.id));
  }

  async _disembark(ev) {
    const R = this.R, g = R.gen;
    const b = this._boatOf(ev) || this.boats.get(this.aboard.get(ev.id));
    const u = this.unit(ev.id);
    if (!u) return;
    this.aboard.delete(ev.id);
    if (b) b.seats = b.seats.filter((id) => id !== ev.id);
    const v = R.views[ev.id], d = R.disp[ev.id];
    const x = ev.x ?? d.x, y = ev.y ?? d.y;
    d.x = x; d.y = y;
    const goal = new THREE.Vector3(this.wx(x), this.gy(x, y), this.wz(y));
    const show = (b && this._boatVisible(b)) || this.vis(x, y) || u.team === R.myTeam;
    if (show) {
      this.call('disembark');
      const a = v.root.position.clone();
      v.faceTo(goal.x, goal.z);
      await R._anim(340, (t) => v.root.position.set(lerp(a.x, goal.x, t), lerp(a.y, goal.y, t) + Math.sin(t * Math.PI) * 0.5, lerp(a.z, goal.z, t)));
      if (g !== R.gen) return;
      if (R._flooded(x, y)) R.fx.splash(goal.x, goal.z, 0.6); else R.fx.dust(goal.x, goal.z, 5);
    }
    v.root.position.copy(goal);
    if (u.team === R.myTeam) R.refreshFog(); else R._syncUnitVisibility(u);
  }

  async _boatMove(ev) {
    const R = this.R, g = R.gen;
    const b = this.boats.get(ev.id ?? ev.vehicle) || this._boatOf(ev);
    const path = ev.path || [];
    if (!b || path.length < 2) { if (b && path.length) { const [x, y] = path[path.length - 1]; this._placeBoat(b, x, y); } return; }
    const mine = b.seats.some((id) => this.unit(id)?.team === R.myTeam);
    const anyVis = mine || R.spectator || path.some(([x, y]) => this.vis(x, y));
    const [ex, ey] = path[path.length - 1];
    if (!anyVis) { this._placeBoat(b, ex, ey); return; }
    this.call('boatEngine', 'start', { id: b.id, far: mine ? 0 : R._far(b.x, b.y) }); this.call('boatMove'); this.call('wake');
    b.moving = true;
    const cine = R._cine;
    if (cine) { R._camPush('boat'); R.followId = null; R.viewGoal = Math.max(R.viewGoal, 13); }
    const pts = path.map(([x, y]) => new THREE.Vector3(this.wx(x), WATER_Y - 0.02, this.wz(y)));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.3);
    const len = curve.getLength();
    const tan = new THREE.Vector3();
    let lastStep = 0;
    await R._anim(Math.max(500, len * 135), (t) => {
      const e = easeInOutCubic(t);
      curve.getPointAt(e, b.o.position);
      curve.getTangentAt(Math.min(0.999, Math.max(0.001, e)), tan);
      const yaw = Math.atan2(tan.x, tan.z);
      let dy = yaw - b.o.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      b.o.rotation.y += dy * 0.35;
      b.pitch = -0.08 * Math.sin(Math.min(1, t * 4) * Math.PI / 2) * (1 - t * 0.6);
      b.roll = -dy * 0.8;
      const p = b.o.position;
      if (cine && this.camFree) R.goal.set(p.x, 0, p.z);
      // wake: V of foam behind the stern + spray at the bow
      const sx = p.x - tan.x * 0.65, sz = p.z - tan.z * 0.65;
      for (let k = 0; k < 2; k++) {
        const s = k ? 1 : -1;
        R.fx.alpha.spawn(sx, WATER_Y + 0.03, sz, -tan.x * 0.6 + tan.z * s * 0.9, 0.05, -tan.z * 0.6 - tan.x * s * 0.9, 1.4, 0.12, 0.42, 0.93, 0.98, 0.98, 0.7, 1.4, 0, 0, 1.3);
      }
      if (Math.random() < 0.7) R.fx.alpha.spawn(p.x + tan.x * 0.6, WATER_Y + 0.15, p.z + tan.z * 0.6, tan.z * (Math.random() - 0.5) * 2, 1 + Math.random(), -tan.x * (Math.random() - 0.5) * 2, 0.45, 0.05, 0.03, 0.92, 0.97, 1, 0.8, 0.5, 9, 0.5, 1);
      // passengers' displayed tile follows the boat (fog of war, visibility)
      const step = Math.min(path.length - 1, Math.floor(e * (path.length - 1) + 0.5));
      if (step !== lastStep) {
        lastStep = step;
        const [x, y] = path[step];
        b.x = x; b.y = y;
        for (const id of b.seats) { const d = R.disp[id]; if (d) { d.x = x; d.y = y; } }
        if (mine) R.refreshFog(); else for (const id of b.seats) R._syncUnitVisibility(this.unit(id));
      }
    });
    b.moving = false; b.pitch = 0; b.roll = 0;
    this.call('boatEngine', 'stop', { id: b.id, far: mine ? 0 : R._far(ex, ey) });
    this._placeBoat(b, ex, ey);
    if (g !== R.gen) return;
    if (cine) R._camRelease('boat');
  }

  _placeBoat(b, x, y) {
    const R = this.R;
    b.x = x; b.y = y;
    b.o.position.set(this.wx(x), WATER_Y - 0.02, this.wz(y));
    for (const id of b.seats) { const d = R.disp[id]; if (d) { d.x = x; d.y = y; } }
    if (b.seats.some((id) => this.unit(id)?.team === R.myTeam)) R.refreshFog(); else for (const id of b.seats) { const u = this.unit(id); if (u) R._syncUnitVisibility(u); }
  }

  async _vehicleDamage(ev) {
    const R = this.R;
    const b = this.boats.get(ev.id ?? ev.vehicle);
    if (!b) return;
    b.hp = ev.hp ?? (b.hp ?? 12) - (ev.dmg || 0);
    if (!this._boatVisible(b)) return;
    const p = b.o.position;
    R.fx.sparks(p.x, 0.35, p.z, 10, 5, 3.6, 1.6, 3.5);
    R.fx.hitFlash(p.x, 0.35, p.z, 0.8);
    R._text(b.x, b.y, `-${ev.dmg || 1}`, '#ffa060', 1.0, 0.9);
    b.roll = 0.18;
    R.fx.timed(0.5, (t) => { b.roll = 0.18 * (1 - t) * Math.cos(t * 14); });
    await R._wait(200);
  }

  async _vehicleDestroyed(ev) {
    const R = this.R, g = R.gen;
    const b = this.boats.get(ev.id ?? ev.vehicle);
    if (!b) return;
    this.boats.delete(b.id);
    const riders = b.seats.slice();
    for (const id of riders) this.aboard.delete(id);
    const show = this._boatVisible(b);
    const p = b.o.position.clone();
    // riders end up in the water on the boat's tile
    const place = () => {
      for (const id of riders) {
        const v = R.views[id], d = R.disp[id];
        if (!v || !d) continue;
        d.x = b.x; d.y = b.y;
        v.root.position.set(this.wx(b.x) + (Math.random() - 0.5) * 0.3, this.gy(b.x, b.y), this.wz(b.y) + (Math.random() - 0.5) * 0.3);
      }
    };
    if (!show) { disposeModel(b.o); place(); return; }
    const cam = R._pointCam('blast', p.x, p.z, 9);
    this.call('explosion', R._far(b.x, b.y));
    R.fx.explosion(p.x, p.z, 1.5, true);
    R.fx.debrisBurst(p.x, 0.4, p.z, [0x40474a, 0x2a3134, 0xd9d2bf], 18, 1.4);
    R.fx.flashLight(p.x, 1.2, p.z, 0xff7a3a, 34, 0.5, 8);
    R.hitStop = 0.06;
    for (const id of riders) { const v = R.views[id]; if (v?.root.visible) v.doFlinch(1); }
    place();
    this.temp.add(b.o);
    R.fx.timed(2.6, (t) => {
      b.o.position.y = WATER_Y - 0.02 - t * 0.9;
      b.o.rotation.z = t * 1.2; b.o.rotation.x = t * 0.4;
      if (Math.random() < 0.5) R.fx.alpha.spawn(p.x, 0.3, p.z, 0.1, 0.8, 0, 1.8, 0.2, 0.7, 0.15, 0.14, 0.13, 0.6, 0.5, -0.1, 0, 1.2);
      if (t >= 1) this.drop(b.o);
    });
    R._text(b.x, b.y, 'BOAT DESTROYED', '#ff8a5a', 1.0, 1.3);
    await R._wait(520);
    if (g !== R.gen) return;
    if (cam) { const s = R.camStack[R.camStack.length - 1]; if (s && s.tag === 'blast') s.until = Math.min(s.until, R.playT + 1.0); }
  }

  // ---------- stage events ----------
  _warnStart(kind, tiles, silent = false) {
    if (this.warn?.prop) this.drop(this.warn.prop);
    this.warn = { kind, tiles, t: 0, prop: null };
    const R = this.R;
    if (!tiles.length) return;
    // a landmark that foreshadows the set piece
    const geo = this._laneGeo(tiles);
    if (kind === 'tower') {
      const tw = this.add(makeTower(Math.min(11, Math.max(7, geo.len + 1))));
      tw.position.set(geo.start.x - geo.dir.x * 1.6, -0.6, geo.start.z - geo.dir.z * 1.6);
      tw.rotation.y = Math.atan2(geo.dir.x, geo.dir.z);
      this.warn.prop = tw;
    } else if (kind === 'ship') {
      const sh = this.add(makeShip(12));
      sh.position.set(geo.start.x - geo.dir.x * 16, WATER_Y, geo.start.z - geo.dir.z * 16);
      sh.rotation.y = Math.atan2(geo.dir.x, geo.dir.z);
      this.warn.prop = sh;
    }
    void silent; void R;
  }

  /** Lane geometry: entry point from the nearest map edge, direction, length. */
  _laneGeo(tiles) {
    const R = this.R, S = R.S;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of tiles) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const alongX = x1 - x0 >= y1 - y0;
    // enter from the side closest to the map edge
    let dir;
    if (alongX) dir = cx < S / 2 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(-1, 0, 0);
    else dir = cy < S / 2 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 0, -1);
    const len = (alongX ? x1 - x0 : y1 - y0) + 1;
    const start = new THREE.Vector3(alongX ? (dir.x > 0 ? this.wx(x0) - 0.5 : this.wx(x1) + 0.5) : this.wx(cx), 0, alongX ? this.wz(cy) : (dir.z > 0 ? this.wz(y0) - 0.5 : this.wz(y1) + 0.5));
    const width = (alongX ? y1 - y0 : x1 - x0) + 1;
    return { start, dir, len, width, cx: this.wx(cx), cz: this.wz(cy), alongX };
  }

  async _stageWarn(ev) {
    const R = this.R, g = R.gen;
    const kind = stageKind(ev.kind, this.st.stage);
    const tiles = tilesOf(ev.tiles, R.S);
    this._warnStart(kind, tiles);
    const geo = tiles.length ? this._laneGeo(tiles) : null;
    const title = { ship: 'SHIP ADRIFT', redtide: 'RED TIDE RISING', collapse: 'PLATFORM FAILING', tower: 'TOWER UNSTABLE', wave: 'ROGUE WAVE' }[kind];
    this.call('stageEventWarn', kind);
    this.feed(`Warning: ${title.toLowerCase()} next round`);
    if (!geo) return;
    // 5.1: a letterboxed flyover of the danger area (the set piece hits next round)
    const cine = R._cine && typeof R.cineBegin === 'function';
    const P = R.pacing || { cine: { warnFly: 1500, post: 800 } };
    if (cine) {
      await R.cineBegin({ kind: 'warn', name: title, sub: 'Next round · clear the danger zone', tiles, light: true });
      if (g !== R.gen) return;
    }
    const cam = cine ? false : R._pointCam('setpiece', geo.cx, geo.cz, 15);
    // a beat of foreshadowing per kind
    if (kind === 'redtide') this._setRedTide(tiles.slice(0, Math.ceil(tiles.length * 0.25)), false, 0.5);
    if (kind === 'collapse') for (const [x, y] of tiles) if (Math.random() < 0.4) R.fx.sparks(this.wx(x), 0.1, this.wz(y), 5, 5, 3.4, 1.6, 2);
    if (kind === 'wave') for (let i = 0; i < 3; i++) R.fx.ring(geo.start.x - geo.dir.x * (4 + i * 2), WATER_Y + 0.02, geo.start.z - geo.dir.z * (4 + i * 2), 1, geo.width * 1.2, 0xdff4ee, 1.4, 0.5);
    if (kind === 'tower' && this.warn?.prop) { const tw = this.warn.prop; R.fx.timed(1.6, (t) => { tw.rotation.x = Math.sin(t * 20) * 0.015 * (1 - t); }); }
    for (const [x, y] of tiles) if (Math.random() < 0.5) R.fx.ring(this.wx(x), this.gy(x, y) + 0.08, this.wz(y), 0.2, 0.75, 0xffb04a, 0.5, 1.1);
    R._text(Math.round((geo.cx + R.S / 2 - 0.5)), Math.round((geo.cz + R.S / 2 - 0.5)), title, '#ffb04a', 1.25, 1.6);
    R.fx.shake = Math.max(R.fx.shake, 0.25);
    if (cine) {
      // fly the lane: push in at its start, glide to its end, pull back out
      const wide = R.viewGoal;
      const A = geo.start.clone(), B = geo.start.clone().addScaledVector(geo.dir, Math.max(1, geo.len - 1));
      if (this.camFree) { R.goal.set(A.x, 0, A.z); R.viewGoal = Math.max(9, wide * 0.72); }
      await R.cameraArrive(700);
      if (g !== R.gen) return;
      await R._anim(P.cine.warnFly, (t) => { if (this.camFree) R.goal.set(lerp(A.x, B.x, easeInOutCubic(t)), 0, lerp(A.z, B.z, easeInOutCubic(t))); });
      if (g !== R.gen) return;
      if (this.camFree) { R.goal.set(geo.cx, 0, geo.cz); R.viewGoal = wide; }
      await R.cameraArrive(800);
      if (g !== R.gen) return;
      if (!R.cineManaged) await R.cineEnd(P.cine.post * 0.5);
      return;
    }
    await R._wait(1500);
    if (g !== R.gen) return;
    if (cam) R._camRelease('setpiece');
  }

  async _stageEvent(ev) {
    const R = this.R, g = R.gen;
    const kind = stageKind(ev.kind, this.st.stage);
    const tiles = tilesOf(ev.tiles, R.S).length ? tilesOf(ev.tiles, R.S) : this.warn?.tiles || [];
    const prop = this.warn?.prop || null;
    this.warn = null;
    if (!tiles.length) return;
    const geo = this._laneGeo(tiles);
    this.call('stageEvent', kind);
    const cine = R._cine && !R._fast;
    const P = R.pacing || { cine: { pre: 600, post: 1200 }, slow: 0.6 };
    const dir5 = cine && typeof R.cineBegin === 'function';
    if (dir5) {
      // 5.1: everything stops. Bars in, title card, pull out over the whole affected area.
      const title = { ship: 'SHIP ADRIFT', redtide: 'RED TIDE', collapse: 'PLATFORM COLLAPSE', tower: 'TOWER DOWN', wave: 'ROGUE WAVE' }[kind];
      const sub = { ship: 'A container ship ploughs the harbor', redtide: 'Toxic algae floods the kelp', collapse: 'The rig deck is giving way', tower: 'The spire is coming down', wave: 'A wall of water sweeps inland' }[kind] || '';
      await R.cineBegin({ kind, name: title, sub, tiles });
      if (g !== R.gen) return;
      await R._sleepReal(P.cine.pre);
      if (g !== R.gen) return;
      R.director.slowmo(); // the set piece plays in slow motion
      // slow dolly in while it happens
      const v0 = R.viewGoal;
      R.fx.timed(6, (t) => { if (g === R.gen && R.inCinematic && this.camFree) R.viewGoal = v0 * (1 - 0.14 * easeInOutCubic(t)); });
    } else if (cine) {
      R._camPush('setpiece');
      R.followId = null;
      R.goal.set(geo.cx, 0, geo.cz);
      R.viewGoal = Math.max(13, Math.min(26, geo.len * 1.2 + 6));
      R.elevGoal = 0.55;
    }
    try {
      if (kind === 'ship') await this._spShip(tiles, geo, prop, cine);
      else if (kind === 'redtide') await this._spRedTide(tiles, geo);
      else if (kind === 'collapse') await this._spCollapse(tiles, geo);
      else if (kind === 'tower') await this._spTower(tiles, geo, prop, cine);
      else await this._spWave(tiles, geo, cine);
    } finally {
      if (prop && prop.parent && kind !== 'ship' && kind !== 'tower') this.drop(prop);
    }
    if (g !== R.gen) return;
    if (dir5) {
      R.slowGoal = 1;
      R.hitStop = 0.06;
      R.fx.shake = Math.max(R.fx.shake, 0.6);
      // the aftermath (damage, knockback, rubble) plays inside the cinematic when the match
      // controller manages it; on its own (attract loop, debug) we close it ourselves
      if (!R.cineManaged) await R.cineEnd(P.cine.post);
      return;
    }
    if (cine) { const s = R.camStack[R.camStack.length - 1]; if (s && s.tag === 'setpiece') s.until = Math.min(s.until, R.playT + 1.8); }
  }

  /** Harbor: a container ship ploughs the lane, cover bursting at its bow. */
  async _spShip(tiles, geo, prop, cine) {
    const R = this.R, g = R.gen;
    const ship = prop || this.add(makeShip(12));
    ship.rotation.y = Math.atan2(geo.dir.x, geo.dir.z);
    const from = geo.start.clone().addScaledVector(geo.dir, -12), to = geo.start.clone().addScaledVector(geo.dir, geo.len + 10);
    const order = tiles.slice().sort((a, b) => (this.wx(a[0]) * geo.dir.x + this.wz(a[1]) * geo.dir.z) - (this.wx(b[0]) * geo.dir.x + this.wz(b[1]) * geo.dir.z));
    let hit = 0;
    R.fx.shake = Math.max(R.fx.shake, 0.4);
    this.call('shipHorn');
    await R._anim(3600, (t) => {
      const e = t;
      ship.position.copy(from).lerp(to, e);
      ship.position.y = WATER_Y - 0.1 + Math.sin(t * 9) * 0.05;
      ship.rotation.z = Math.sin(t * 7) * 0.02;
      const bow = ship.position.clone().addScaledVector(geo.dir, 7);
      if (cine && this.camFree) R.goal.set(lerp(geo.cx, bow.x, 0.5), 0, lerp(geo.cz, bow.z, 0.5));
      // bow wave
      for (let k = 0; k < 3; k++) {
        const s = k - 1;
        R.fx.alpha.spawn(bow.x + geo.dir.z * s * 1.2, WATER_Y + 0.2, bow.z - geo.dir.x * s * 1.2, geo.dir.z * s * 3 + geo.dir.x * 2, 2 + Math.random() * 2, -geo.dir.x * s * 3 + geo.dir.z * 2, 0.8, 0.15, 0.5, 0.92, 0.97, 1, 0.8, 0.8, 6, 0.4, 1.2);
      }
      R.fx.shake = Math.max(R.fx.shake, 0.18);
      while (hit < order.length) {
        const [x, y] = order[hit];
        const along = (this.wx(x) - bow.x) * geo.dir.x + (this.wz(y) - bow.z) * geo.dir.z;
        if (along > 0) break;
        hit++;
        const px = this.wx(x), pz = this.wz(y);
        R.fx.debrisBurst(px, 0.5, pz, R.props.debrisColors(y * R.S + x, R.props.cover[y * R.S + x] || 1), 8, 1.6);
        R.fx.dust(px, pz, 8, 0.75, 0.7, 0.62, 0.2, 1.8);
        if (Math.random() < 0.4) this.call('explosion', R._far(x, y) * 0.6 + 0.4);
      }
    });
    this.drop(ship);
    if (g !== R.gen) return;
    await R._wait(200);
  }

  _setRedTide(tiles, instant = false, k = 1) {
    const R = this.R;
    if (!tiles) { this.redTide = null; R.fields?.setMask(null); return; }
    const S = R.S, m = new Float32Array(S * S);
    for (const [x, y] of tiles) if (x >= 0 && y >= 0 && x < S && y < S) m[y * S + x] = k;
    R.fields.setMask(m);
    this.redTide = { tiles }; // cleared by stage_event_end
    if (instant) this.redTideK = 1;
  }

  /** Kelp: a toxic red-algae band spreads from one end of the band to the other. */
  async _spRedTide(tiles, geo) {
    const R = this.R, g = R.gen;
    const S = R.S;
    const order = tiles.slice().sort((a, b) => (a[0] * geo.dir.x + a[1] * geo.dir.z) - (b[0] * geo.dir.x + b[1] * geo.dir.z));
    const m = new Float32Array(S * S);
    this.redTide = { tiles };
    this.call('redTide');
    let n = 0;
    await R._anim(2200, (t) => {
      const want = Math.floor(t * order.length);
      while (n < want) {
        const [x, y] = order[n++];
        m[y * S + x] = 1;
        if (n % 3 === 0) R.fx.ring(this.wx(x), WATER_Y + 0.03, this.wz(y), 0.2, 1.2, 0xc8261c, 0.9, 0.7);
      }
      R.fields.setMask(m);
    });
    for (const [x, y] of order) m[y * S + x] = 1;
    R.fields.setMask(m);
    if (g !== R.gen) return;
    R._text(Math.round(geo.cx + S / 2 - 0.5), Math.round(geo.cz + S / 2 - 0.5), 'RED TIDE', '#ff6a55', 1.3, 1.4);
    await R._wait(500);
  }

  /** Rig: deck sections shear off and drop into the sea. */
  async _spCollapse(tiles, geo) {
    const R = this.R, g = R.gen;
    this.call('collapse');
    // creak: sparks and dust along the fault line
    for (let i = 0; i < 6; i++) {
      const [x, y] = tiles[(Math.random() * tiles.length) | 0];
      R.fx.sparks(this.wx(x), 0.05, this.wz(y), 8, 5, 3.4, 1.6, 3);
      R.fx.dust(this.wx(x), this.wz(y), 4);
      R.fx.shake = Math.max(R.fx.shake, 0.3);
      await R._wait(110);
      if (g !== R.gen) return;
    }
    const order = tiles.slice().sort((a, b) => (a[0] * geo.dir.x + a[1] * geo.dir.z) - (b[0] * geo.dir.x + b[1] * geo.dir.z));
    // the slabs tilt and fall (terrain instances animate; terrain_change events make it permanent)
    await R._anim(1400, (t) => {
      order.forEach(([x, y], i) => {
        const lt = clamp((t - (i / order.length) * 0.5) / 0.5, 0, 1);
        R.dropTile(x, y, lt);
      });
      if (Math.random() < 0.5) { const [x, y] = order[(Math.random() * order.length) | 0]; R.fx.debrisBurst(this.wx(x), 0, this.wz(y), [0x6f6d66, 0x4e2617, 0x3a3d40], 3, 0.8); }
      R.fx.shake = Math.max(R.fx.shake, 0.35);
    });
    if (g !== R.gen) return;
    for (const [x, y] of order) {
      R.setTileTerrain(x, y, 2);
      R.fx.splash(this.wx(x), this.wz(y), 1.4);
    }
    this.call('explosion', 0.5);
    await R._wait(400);
  }

  /** Spire: the tower creaks, then falls across the lane. */
  async _spTower(tiles, geo, prop, cine) {
    const R = this.R, g = R.gen;
    let tw = prop;
    if (!tw) {
      tw = this.add(makeTower(Math.min(11, Math.max(7, geo.len + 1))));
      tw.position.set(geo.start.x - geo.dir.x * 1.6, -0.6, geo.start.z - geo.dir.z * 1.6);
      tw.rotation.y = Math.atan2(geo.dir.x, geo.dir.z);
    }
    tw.rotation.order = 'YXZ';
    this.call('towerCreak');
    await R._anim(700, (t) => { tw.rotation.x = Math.sin(t * 30) * 0.02 + t * 0.08; if (Math.random() < 0.3) R.fx.debrisBurst(tw.position.x, 4 + Math.random() * 3, tw.position.z, [0x5c6070, 0x161a26], 2, 0.6); });
    if (g !== R.gen) return;
    // fall: accelerate about the base pivot toward +z (lane direction)
    let landed = false;
    await R._anim(1300, (t) => {
      tw.rotation.x = 0.08 + (Math.PI / 2 - 0.08) * t * t;
      if (cine && !landed && this.camFree) {
        _v.set(0, 6, 0).applyEuler(tw.rotation).add(tw.position);
        R.goal.set(lerp(geo.cx, _v.x, 0.3), 0, lerp(geo.cz, _v.z, 0.3));
      }
    });
    if (g !== R.gen) return;
    landed = true;
    // impact: dust wall along the lane, debris, huge shake
    this.call('explosion', 0.3);
    R.fx.shake = 1.2;
    R.hitStop = 0.08;
    const order = tiles.slice().sort((a, b) => (a[0] * geo.dir.x + a[1] * geo.dir.z) - (b[0] * geo.dir.x + b[1] * geo.dir.z));
    order.forEach(([x, y], i) => {
      R.fx.timed(i * 0.04 + 0.001, (q) => {
        if (q < 1 || g !== R.gen) return;
        const px = this.wx(x), pz = this.wz(y);
        this._dustPlume(px, pz, 1.2);
        R.fx.debrisBurst(px, 0.6, pz, [0x5c6070, 0x6a6878, 0x161a26], 8, 1.3);
        if (R._flooded(x, y)) R.fx.splash(px, pz, 1.6);
      });
    });
    await R._wait(250);
    // the fallen tower breaks up into the rubble bridge
    const t0 = tw.position.y;
    R.fx.timed(1.6, (t) => { tw.position.y = t0 - t * 1.6; if (t >= 1) this.drop(tw); });
    await R._wait(500);
  }

  /** Surge: a curling wall of water sweeps the band inland. */
  async _spWave(tiles, geo, cine) {
    const R = this.R, g = R.gen;
    const w = geo.width + 4;
    const wave = this.add(makeWave(w));
    const dir = geo.dir;
    wave.rotation.y = Math.atan2(dir.x, dir.z);
    const from = geo.start.clone().addScaledVector(dir, -6), to = geo.start.clone().addScaledVector(dir, geo.len + 1.5);
    const along = new THREE.Vector3(geo.alongX ? 0 : 1, 0, geo.alongX ? 1 : 0);
    // center the sheet across the band
    const off = geo.alongX ? geo.cz - geo.start.z : geo.cx - geo.start.x;
    from.addScaledVector(along, off); to.addScaledVector(along, off);
    this.call('wave');
    await R._anim(1900, (t) => {
      const e = easeInOutCubic(t);
      wave.position.copy(from).lerp(to, e);
      wave.position.y = WATER_Y - 0.2;
      const sc = t < 0.15 ? t / 0.15 : t > 0.8 ? 1 - (t - 0.8) / 0.2 * 0.85 : 1;
      wave.scale.set(1, Math.max(0.05, sc) * (0.8 + 0.4 * (geo.width > 3 ? 1 : 0.6)), 1);
      wave.material.uniforms.uT.value = t * 4;
      wave.material.uniforms.uA.value = t > 0.85 ? 1 - (t - 0.85) / 0.15 : 1;
      const p = wave.position;
      if (cine && this.camFree) R.goal.set(lerp(geo.cx, p.x, 0.4), 0, lerp(geo.cz, p.z, 0.4));
      for (let k = 0; k < 4; k++) {
        const o = (Math.random() - 0.5) * w;
        R.fx.alpha.spawn(p.x + along.x * o, 1.6 * sc, p.z + along.z * o, dir.x * 3 + (Math.random() - 0.5), 1.5 + Math.random() * 2, dir.z * 3 + (Math.random() - 0.5), 0.9, 0.18, 0.6, 0.92, 0.97, 1, 0.85, 0.8, 6, 0.4, 1.2);
      }
      R.fx.shake = Math.max(R.fx.shake, 0.3);
    });
    this.drop(wave);
    if (g !== R.gen) return;
    for (const [x, y] of tiles) if (Math.random() < 0.5) R.fx.splash(this.wx(x), this.wz(y), 1.2);
    await R._wait(200);
  }

  /** Big billowing dust plume (collapse / impact). */
  _dustPlume(x, z, k = 1) {
    const R = this.R, A = R.fx.alpha;
    for (let i = 0; i < R.fx._n(24 * k); i++) {
      const a = Math.random() * 6.28, s = 0.6 + Math.random() * 1.4;
      const gcol = 0.62 + Math.random() * 0.12;
      A.spawn(x + Math.cos(a) * 0.3, 0.2 + Math.random() * 0.4, z + Math.sin(a) * 0.3, Math.cos(a) * s, 0.8 + Math.random() * 1.8, Math.sin(a) * s,
        2.8 + Math.random() * 2.2, 0.5, 2.0 + Math.random() * 1.4, gcol, gcol * 0.95, gcol * 0.86, 0.9, 1.2, -0.12, 0, 1.1);
    }
  }

  async _knockback(ev) {
    const R = this.R, g = R.gen;
    const u = this.unit(ev.id);
    if (!u) return;
    const path = ev.path || (Number.isFinite(ev.x) ? [[R.disp[ev.id].x, R.disp[ev.id].y], [ev.x, ev.y]] : null);
    if (!path || !path.length) return;
    const v = R.views[ev.id], d = R.disp[ev.id];
    const [ex, ey] = path[path.length - 1];
    const vis = u.team === R.myTeam || path.some(([x, y]) => R._seenAt(ev.id, x, y));
    if (!vis) { d.x = ex; d.y = ey; v.root.position.set(this.wx(ex), this.gy(ex, ey), this.wz(ey)); R._syncUnitVisibility(u); return; }
    v.root.visible = true;
    v.doFlinch(1);
    v.setHunker(false);
    const pts = path.map(([x, y]) => new THREE.Vector3(this.wx(x), this.gy(x, y), this.wz(y)));
    if (pts.length === 1) pts.unshift(v.root.position.clone());
    await R._anim(220 + pts.length * 110, (t) => {
      const f = t * (pts.length - 1), i = Math.min(pts.length - 2, Math.floor(f)), q = f - i;
      const a = pts[i], b = pts[i + 1];
      v.root.position.set(lerp(a.x, b.x, q), lerp(a.y, b.y, q) + Math.sin(q * Math.PI) * 0.35 * (1 - t * 0.5), lerp(a.z, b.z, q));
      if (Math.random() < 0.5) { if (R._floodedWorld(v.root.position.x, v.root.position.z)) R.fx.splash(v.root.position.x, v.root.position.z, 0.4); else R.fx.dust(v.root.position.x, v.root.position.z, 2); }
    });
    if (g !== R.gen) return;
    d.x = ex; d.y = ey;
    v.root.position.set(this.wx(ex), this.gy(ex, ey), this.wz(ey));
    if (R._flooded(ex, ey)) R.fx.splash(v.root.position.x, v.root.position.z, 0.9); else R.fx.slump(v.root.position.x, v.root.position.z, false);
    if (u.team === R.myTeam) R.refreshFog(); else R._syncUnitVisibility(u);
  }

  async _buildingCollapse(ev) {
    const R = this.R, g = R.gen;
    const tiles = tilesOf(ev.tiles, R.S);
    if (!tiles.length) return;
    let cx = 0, cy = 0;
    for (const [x, y] of tiles) { cx += x; cy += y; }
    cx /= tiles.length; cy /= tiles.length;
    const vis = R.spectator || tiles.some(([x, y]) => this.vis(x, y));
    if (!vis || R._fast) {
      for (const [x, y] of tiles) if (R.props.cover[y * R.S + x] === 2) R.props.setCover(x, y, 1);
      if (!vis) { this.call('buildingCollapse', 1); this.feed(`A building collapsed to the ${compass(R.myRef(), cx, cy)}`); }
      return;
    }
    const dir5 = R._cine && typeof R.cineBegin === 'function';
    if (dir5) { await R.cineBegin({ kind: 'building', name: 'BUILDING COLLAPSE', tiles, light: true }); if (g !== R.gen) return; }
    const cam = dir5 ? false : R._pointCam('blast', this.wx(cx), this.wz(cy), 11);
    this.call('buildingCollapse', R._far(cx, cy));
    // rumble: shaking dust off the walls
    for (let i = 0; i < 5; i++) {
      const [x, y] = tiles[(Math.random() * tiles.length) | 0];
      R.fx.dust(this.wx(x), this.wz(y), 5, 0.75, 0.7, 0.62, 0.9, 0.8);
      R.fx.shake = Math.max(R.fx.shake, 0.3 + i * 0.05);
      await R._wait(90);
      if (g !== R.gen) return;
    }
    R._text(Math.round(cx), Math.round(cy), 'COLLAPSE!', '#ffb35a', 1.2, 1.9);
    const order = tiles.slice().sort(() => Math.random() - 0.5);
    for (let i = 0; i < order.length; i++) {
      const [x, y] = order[i];
      const px = this.wx(x), pz = this.wz(y);
      const k = y * R.S + x;
      const from = R.props.cover[k];
      if (from === 2) R.props.setCover(x, y, 1);
      R.fx.debrisBurst(px, 0.9, pz, R.props.debrisColors(k, 2), 10, 1.2);
      this._dustPlume(px, pz, 1);
      R.fx.shake = Math.min(1.2, R.fx.shake + 0.12);
      if (i % 3 === 0) await R._wait(60);
      if (g !== R.gen) return;
    }
    R.hitStop = 0.05;
    // the dust cloud rolls outward
    R.fx.ring(this.wx(cx), 0.1, this.wz(cy), 0.5, 4.5, 0xd8cdb0, 1.4, 0.6);
    await R._wait(600);
    if (g !== R.gen) return;
    if (dir5) { if (!R.cineManaged) await R.cineEnd(R.pacing?.cine.post ?? 800); return; }
    if (cam) { const s = R.camStack[R.camStack.length - 1]; if (s && s.tag === 'blast') s.until = Math.min(s.until, R.playT + 1.2); }
  }

  // ---------- the Pit ----------
  async _pitEnter(ev) {
    const R = this.R, g = R.gen;
    const u = this.unit(ev.id);
    if (!u) return;
    this.feed(`${u.name} drops into the Pit`);
    const v = R.views[ev.id];
    if (!v.root.visible && u.team !== R.myTeam) return;
    const p = v.root.position;
    this.call('pitEnter');
    R.fx.ring(p.x, p.y + 0.06, p.z, 0.2, 1.2, 0xff2a3a, 0.9, 1.4);
    for (let i = 0; i < R.fx._n(24); i++) {
      const a = Math.random() * 6.28, r = 0.2 + Math.random() * 0.4;
      R.fx.add.spawn(p.x + Math.cos(a) * r, p.y + 0.1, p.z + Math.sin(a) * r, -Math.sin(a) * 1.5, -0.6 - Math.random(), Math.cos(a) * 1.5, 0.9, 0.08, 0.02, 4, 0.6, 0.8, 1, 0.5, 0, 0.6, 1);
    }
    R._textAt(ev.id, 'TO THE PIT', '#ff5a6a', 1.0, 0.2);
    await R._wait(600);
    if (g !== R.gen) return;
  }

  async _redeploy(ev) {
    const R = this.R, g = R.gen;
    const u = this.unit(ev.id);
    if (!u) return;
    const v = R.views[ev.id], d = R.disp[ev.id];
    const x = ev.x ?? u.x, y = ev.y ?? u.y;
    d.x = x; d.y = y; d.alive = true; d.downed = false; d.hp = ev.hp ?? u.hp ?? 6; d.bleed = 0;
    v.revive();
    v.corpse = false;
    v.setReveal?.(false);
    const goal = new THREE.Vector3(this.wx(x), this.gy(x, y), this.wz(y));
    v.root.position.copy(goal);
    R._drawLabel(u);
    this.feed(`${u.name} redeploys`);
    const show = u.team === R.myTeam || R.spectator || this.vis(x, y);
    if (!show || R._fast) { if (u.team === R.myTeam) R.refreshFog(); else R._syncUnitVisibility(u); return; }
    const cam = R._pointCam('supply', goal.x, goal.z, 10);
    this.call('redeploy');
    v.root.visible = true;
    const ctl = R.cfx.dropIn('parachute', v, goal, { from: { x: 0, z: -1 } });
    await R._anim(ctl.dur * 1000, (t) => ctl.update(t * ctl.dur));
    ctl.end();
    if (g !== R.gen) return;
    R.fx.ring(goal.x, goal.y + 0.07, goal.z, 0.2, 1.6, new THREE.Color(R.teamColor(u.team)).getHex(), 0.7, 1.1);
    R._textAt(ev.id, 'REDEPLOYED', '#7fe9ff', 1.0);
    if (u.team === R.myTeam) R.refreshFog(); else R._syncUnitVisibility(u);
    await R._wait(400);
    if (g !== R.gen) return;
    if (cam) R._camRelease('supply');
  }
}
