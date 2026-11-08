// Tidefall 5.1 action director: pacing presets, event framing, camera arrival,
// letterbox cinematics and the squad-focus beat.
//
// The match controller (src/client/match/playback.js) owns WHEN things play;
// the director owns WHERE the camera is while they do:
//
//   await R.stage(ev, {mine})   frame the event (actor, actor+target, the blast / line)
//                               and resolve once the camera has ARRIVED (bounded wait)
//   await R.squadFocus(team, unitId)   "Squad 7 is moving": frame the squad's first actor
//   R.cineBegin({kind, name, tiles, light}) / await R.cineEnd()   letterboxed set pieces
//   R.setPacing('cinematic'|'normal'|'fast'), R.getPacing() → name, R.pacing → preset
//   R.onCinematic = ({phase:'start'|'end', kind, name, sub}) => …   (UI banner hook)
//   R.onFocus = ({team, unitId, name}) => …                          (UI "Squad 7 is moving")
//
// Fog of war: the director never frames something the viewer can't see; the
// controller only stages visible events, unseen ones stay instant.

import * as THREE from 'three';
import { clamp, lerp } from './util.js';
import { PACING, PACING_NAMES, eventClass } from './pacing.js';

export { PACING, PACING_NAMES, eventClass };

const LETTER = 0.11; // letterbox bar height (fraction of the screen, each)
const TITLES = {
  ship: 'SHIP ADRIFT', redtide: 'RED TIDE', collapse: 'PLATFORM COLLAPSE', tower: 'TOWER DOWN', wave: 'ROGUE WAVE',
  airstrike: 'AIRSTRIKE', building: 'BUILDING COLLAPSE',
};

export class Director {
  constructor(R) {
    this.R = R;
    this.preset = PACING.cinematic;
    this.waiters = [];
    this.cine = null; // {kind, name, light, k, goal, saved}
    this.barK = 0; this.barGoal = 0;
    // letterbox bars: two clip-space quads drawn on top (work without post too)
    const mat = new THREE.ShaderMaterial({
      uniforms: { uK: { value: 0 }, uA: { value: 1 } },
      vertexShader: 'uniform float uK; void main(){ vec2 p = position.xy; gl_Position = vec4(p.x, 1.0 - (0.5 - p.y) * uK * 2.0, 0.0, 1.0); }',
      fragmentShader: 'uniform float uA; void main(){ gl_FragColor = vec4(0.012, 0.016, 0.02, uA); }',
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    });
    const geo = new THREE.PlaneGeometry(2, 1);
    this.barTop = new THREE.Mesh(geo, mat);
    const mat2 = mat.clone();
    mat2.vertexShader = 'uniform float uK; void main(){ vec2 p = position.xy; gl_Position = vec4(p.x, -1.0 + (p.y + 0.5) * uK * 2.0, 0.0, 1.0); }';
    mat2.fragmentShader = 'uniform float uA; void main(){ gl_FragColor = vec4(0.012, 0.016, 0.02, uA); }';
    this.barBot = new THREE.Mesh(geo, mat2);
    for (const m of [this.barTop, this.barBot]) {
      m.frustumCulled = false; m.renderOrder = 1001; m.visible = false;
      m.material.userData.shared = true; m.geometry.userData.shared = true;
    }
    // fallback title card (only drawn when no UI hook listens to onCinematic)
    this.titleCv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (this.titleCv) { this.titleCv.width = 1024; this.titleCv.height = 192; }
    this.titleTex = this.titleCv ? new THREE.CanvasTexture(this.titleCv) : null;
    if (this.titleTex) this.titleTex.colorSpace = THREE.SRGBColorSpace;
    this.title = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.titleTex }, uA: { value: 0 }, uS: { value: new THREE.Vector2(1, 0.2) }, uY: { value: 0.66 } },
      vertexShader: 'uniform vec2 uS; uniform float uY; varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.x * uS.x * 2.0, uY + position.y * uS.y * 2.0, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D uMap; uniform float uA; varying vec2 vUv; void main(){ vec4 c = texture2D(uMap, vUv); gl_FragColor = vec4(c.rgb, c.a * uA); }',
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    }));
    this.title.frustumCulled = false; this.title.renderOrder = 1002; this.title.visible = false;
    this.title.material.userData.shared = true; this.title.geometry.userData.shared = true;
    this.titleK = 0; this.titleGoal = 0;
    this.log = []; // debug timeline: [{t, what, …}] (last 200)
  }

  /** (Re)attach the screen-space meshes to the renderer's overlay scene (after setGame cleared it). */
  attach(overlay) { overlay.add(this.barTop, this.barBot, this.title); }

  setPacing(name) {
    const p = PACING[name];
    if (!p) return this.preset.name;
    this.preset = p;
    return p.name;
  }

  note(what, extra) {
    const R = this.R;
    this.log.push({ t: Math.round(performance.now()), what, ...extra, cam: [+R.target.x.toFixed(2), +R.target.z.toFixed(2), +R.view.toFixed(2)] });
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
  }

  // ---------- framing ----------

  /** Tile-space points of interest for an event (+ padding in tiles). null: nothing to frame. */
  pointsOf(ev) {
    const R = this.R, st = R.state;
    if (!st) return null;
    const pts = [];
    const unit = (id) => {
      if (!Number.isInteger(id) || !st.units[id]) return;
      const v = R.views[id];
      if (!v || (!v.root.visible && st.units[id].team !== R.myTeam && !R.spectator)) return;
      const d = R.disp[id];
      if (d && Number.isFinite(d.x)) pts.push([d.x, d.y]);
    };
    const pt = (x, y) => { if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]); };
    const tiles = (list) => {
      for (const t of list || []) {
        if (Array.isArray(t)) pt(t[0], t[1]);
        else if (t && typeof t === 'object') pt(t.x, t.y);
        else if (Number.isFinite(t)) pt(t % R.S, (t / R.S) | 0);
      }
    };
    let pad = 1.6;
    switch (ev.type) {
      case 'shot': {
        if (Number.isFinite(ev.fx)) pt(ev.fx, ev.fy); else unit(ev.from);
        unit(ev.to); pad = 1.8; break;
      }
      case 'shot_sentry': case 'shot_vehicle': {
        unit(ev.from);
        const s = ev.sentry !== undefined ? R.bf?.sentries?.get(ev.sentry) : R.bf?.boats?.get?.(ev.vehicle);
        if (s) pt(s.x, s.y);
        break;
      }
      case 'move': case 'boat_move': {
        if (ev.type === 'move') unit(ev.id);
        for (const p of ev.path || []) pt(p[0], p[1]);
        pad = 1.4; break;
      }
      case 'sentry_shot': {
        const s = R.bf?.sentries?.get(ev.id); if (s) pt(s.x, s.y);
        unit(ev.target); break;
      }
      case 'gunship_shot': unit(ev.target); pad = 2.4; break;
      case 'grenade': case 'smoke': case 'semtex': case 'flashbang': case 'rocket': case 'breach': case 'barrel_shot':
      case 'claymore': case 'deploy_cover': case 'decoy': case 'knife': case 'suppress': case 'overwatch_trigger':
        unit(ev.id); unit(ev.target); pt(ev.x, ev.y);
        pad = 1.6 + (Number(ev.radius) || (ev.type === 'smoke' ? 2 : 1));
        break;
      case 'revive': case 'patch': unit(ev.by); unit(ev.id); unit(ev.target); break;
      case 'airstrike_mark': case 'airstrike': case 'stage_event_warn': case 'stage_event': case 'building_collapse':
        tiles(ev.tiles); pad = 2.2; break;
      case 'knockback': unit(ev.id); for (const p of ev.path || []) pt(p[0], p[1]); break;
      case 'damage': case 'death': case 'downed': case 'zone_damage': case 'bleed_out': unit(ev.id); pad = 2; break;
      case 'cover_change': case 'barrel': case 'claymore_trigger': case 'claymore_blast': pt(ev.x, ev.y); unit(ev.target); break;
      case 'care_package': pt(ev.crate?.x ?? ev.x, ev.crate?.y ?? ev.y); pad = 3; break;
      case 'uav': unit(ev.id); pad = 4; break;
      default:
        unit(ev.id ?? ev.from ?? ev.by);
        unit(ev.target ?? ev.to);
        pt(ev.x, ev.y);
    }
    if (!pts.length) return null;
    return { pts, pad };
  }

  /** Center (world) + view (renderer units) that frame tile points with padding. */
  fit(pts, pad) {
    const R = this.R;
    const ang = Math.PI / 4 + R.camAngleGoal * (Math.PI / 2);
    const ca = Math.cos(ang), sa = Math.sin(ang), se = Math.sin(R.elevGoal);
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (const [x, y] of pts) {
      const wx = R.wx(x), wz = R.wz(y);
      const u = -sa * wx + ca * wz; // screen right
      const v = ca * wx + sa * wz; // screen depth
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
    // back to world: u = -sa x + ca z, v = ca x + sa z  →  x = -sa u + ca v, z = ca u + sa v
    let cx = -sa * uc + ca * vc, cz = ca * uc + sa * vc;
    const portrait = R.aspect < 1;
    const w = (u1 - u0) + pad * 2 * (portrait ? 1.1 : 1);
    const h = ((v1 - v0) * se + 1.4 + pad * 2 * se * (portrait ? 1.6 : 1.25)) * (portrait ? 1.15 : 1.05);
    const view = Math.max(w / R.aspect, h) / R.viewScale;
    // the HUD sits along the bottom: aim a little low so the action reads a little high
    const bias = (portrait ? 0.08 : 0.04) * view * R.viewScale / Math.max(0.3, se);
    cx += ca * bias; cz += sa * bias;
    return { cx, cz, view };
  }

  /** Are these world points comfortably inside the camera's current (goal) view? */
  _contains(pts, view, center) {
    const R = this.R;
    const ang = Math.PI / 4 + R.camAngleGoal * (Math.PI / 2);
    const ca = Math.cos(ang), sa = Math.sin(ang), se = Math.sin(R.elevGoal);
    const V = view * R.viewScale, W = V * R.aspect;
    const uc = -sa * center.x + ca * center.z, vc = ca * center.x + sa * center.z;
    for (const [x, y] of pts) {
      const wx = R.wx(x), wz = R.wz(y);
      const du = (-sa * wx + ca * wz) - uc, dv = ((ca * wx + sa * wz) - vc) * se;
      // safe area: 72% wide, clear of the top bar and (more) of the bottom HUD (+ = down the screen)
      if (Math.abs(du) > W * 0.36) return false;
      if (R.aspect < 1 ? (dv > V * 0.2 || dv < -V * 0.38) : (dv > V * 0.3 || dv < -V * 0.36)) return false;
    }
    return true;
  }

  /** An event was framed by the director in the last moment (action cams keep its centre). */
  get framedRecently() { return this.R.realTime - (this._framedT ?? -99) < 3; }

  /** The user is steering the camera right now (or just did): don't take it. */
  get userBusy() {
    const R = this.R;
    return !!R.dragging || R.realTime - R.userCamT < 1.2;
  }

  /**
   * Frame an event before it plays. Returns a promise that resolves when the
   * camera has arrived (or after the preset's max wait). opts.mine: my own
   * action (snappier); opts.force: reframe even if already in view.
   */
  stage(ev, opts = {}) {
    const R = this.R;
    if (!R.state || R.showcase) return Promise.resolve(false);
    const P = this.preset;
    const cls = eventClass(ev);
    const F = this.pointsOf(ev);
    if (!F) return Promise.resolve(false);
    if (this.userBusy && !opts.force) { this.note('stage-skip-user', { type: ev.type }); return Promise.resolve(false); }
    const f = this.fit(F.pts, F.pad);
    const base = R.baseView;
    this._framedT = R.realTime; // the action cams keep this framing (no re-centre)
    // action framing: a touch closer than the overview, but always wide enough to fit everything
    const want = clamp(Math.max(f.view, base * (opts.mine ? Math.max(P.zoom, 0.9) : P.zoom)), 8, Math.max(base * 1.25, f.view));
    const curView = R.viewGoal;
    const inView = this._contains(F.pts, curView, R.goal) && curView <= want * 1.45 && curView >= f.view * 0.98;
    if (cls === 'conseq' || cls === 'minor' || opts.mine || cls === 'move') {
      // consequences / small beats / my own actions: only move if something would be off-screen
      if (inView && !opts.force) return Promise.resolve(false);
    } else if (inView && Math.abs(curView - want) < want * 0.2 && Math.hypot(R.goal.x - f.cx, R.goal.z - f.cz) < want * 0.1 && !opts.force) return Promise.resolve(false);
    // a fresh framing becomes the new base: drop stale action-cam holds
    this.clearHolds();
    R.followId = null;
    R.vel.set(0, 0, 0);
    R.goal.set(f.cx, 0, f.cz);
    R.viewGoal = want;
    R.elevGoal = R._elevBase;
    // long walks that don't fit: frame the start and follow the walker
    if (cls === 'move' && f.view > base * 1.3 && Number.isInteger(ev.id)) {
      const d = R.disp[ev.id];
      R.goal.set(R.wx(d.x), 0, R.wz(d.y));
      R.viewGoal = clamp(base * P.zoom, 8, base * 1.1);
      R.followId = ev.id; // the glide ends on the walker, then rides with it
    }
    this.note('stage', { type: ev.type, goal: [+R.goal.x.toFixed(2), +R.goal.z.toFixed(2), +R.viewGoal.toFixed(2)] });
    return this.arrive(opts.mine ? P.myArrive : P.arrive).then((ok) => { this.note('arrived', { type: ev.type, ok }); return true; });
  }

  /** Resolve once the camera target/zoom reach their goals (or after maxMs real time). */
  arrive(maxMs = 1200) {
    const R = this.R;
    if (R._hidden || !R.state) return Promise.resolve(true);
    if (this._arrived()) return Promise.resolve(true);
    return new Promise((resolve) => { this.waiters.push({ until: R.realTime + maxMs / 1000 / Math.max(1, R.specMul || 1), resolve }); });
  }

  _arrived() {
    const R = this.R;
    const d = Math.hypot(R.target.x - R.goal.x, R.target.z - R.goal.z);
    return d < 0.22 + R.view * 0.012 && Math.abs(R.view - R.viewGoal) < 0.25 + R.viewGoal * 0.02;
  }

  clearHolds() {
    const R = this.R;
    if (R.camStack.length) R.camStack.length = 0;
    if (!this.cine) R.slowGoal = 1;
  }

  // ---------- squad focus ----------

  /** "Squad N is moving": frame the squad's first actor and tag it. Resolves after the beat. */
  async squadFocus(team, unitId, ms) {
    const R = this.R;
    const st = R.state;
    if (!st || !st.teams[team]) return;
    const P = this.preset;
    const name = `Squad ${team + 1}`;
    try { R.onFocus?.({ team, unitId, name }); } catch (e) { console.warn('onFocus', e); }
    try { R.hooks?.onFocus?.({ team, unitId, name }); } catch { /* ignore */ }
    if (!(ms > 0)) return;
    const v = R.views[unitId], d = R.disp[unitId];
    if (!v || !d) return;
    this.note('squad', { team, unitId });
    if (!this.userBusy) {
      this.clearHolds();
      R.followId = null;
      R.goal.set(R.wx(d.x), 0, R.wz(d.y));
      R.viewGoal = clamp(R.baseView * P.zoom, 8, R.baseView);
      await this.arrive(P.arrive * 0.8); // the glide is part of the beat
    }
    const p = v.root.position;
    const col = R.teamColor(team);
    if (typeof R.onFocus !== 'function') R._textAt(unitId, name.toUpperCase(), col, 0.95, 0.45); // the UI shows its own tag when it listens
    R.fx.ring(p.x, p.y + 0.07, p.z, 0.2, 1.5, new THREE.Color(col).getHex(), 0.9, 1.0);
    for (const id of st.teams[team].members) {
      if (id === unitId) continue;
      const w = R.views[id];
      if (w?.root.visible && R.disp[id]?.alive) R.fx.ring(w.root.position.x, w.root.position.y + 0.07, w.root.position.z, 0.2, 1.0, new THREE.Color(col).getHex(), 0.6, 0.8);
    }
    await R._sleepReal(ms * 0.6);
  }

  // ---------- cinematics ----------

  /**
   * Letterboxed set piece. kind: stage kind ('ship'…), 'airstrike', 'building', 'warn'.
   * Frames the tiles wide (bounded wait), shows bars + title, notifies the UI.
   */
  async cineBegin({ kind, name, sub = '', tiles = null, light = false, frame = true } = {}) {
    const R = this.R;
    if (!R.state) return;
    if (this.cine) this._endNow();
    const P = this.preset;
    this.cine = { kind, name, light, saved: { goal: R.goal.clone(), view: R.viewGoal, userT: R.userCamT } };
    this.clearHolds();
    this.barGoal = light ? 0.7 : 1;
    this.note('cine-start', { kind, name });
    const payload = { phase: 'start', kind, name: name || TITLES[kind] || String(kind || '').toUpperCase(), sub, light };
    let heard = false;
    try { if (typeof R.onCinematic === 'function') { heard = true; R.onCinematic(payload); } } catch (e) { console.warn('onCinematic', e); }
    try { if (typeof R.hooks?.onCinematic === 'function') { heard = true; R.hooks.onCinematic(payload); } } catch { /* ignore */ }
    if (!heard) this._drawTitle(payload.name, sub, light);
    if (frame && tiles?.length) {
      const f = this.fit(tiles, light ? 2.5 : 3.5);
      R.followId = null;
      R.goal.set(f.cx, 0, f.cz);
      R.viewGoal = clamp(Math.max(f.view, R.baseView * (light ? 0.95 : 1.1)), 9, 44);
      R.elevGoal = light ? R._elevBase - 0.04 : R._elevBase - 0.1;
      this.cine.frame = { goal: R.goal.clone(), view: R.viewGoal };
      await this.arrive(P.arrive + 400);
    }
  }

  /** End the set piece: hold, bars out, restore the camera (unless the user took it). */
  async cineEnd(holdMs) {
    const R = this.R;
    const c = this.cine;
    if (!c) return;
    const P = this.preset;
    if (holdMs > 0) await R._sleepReal(c.light ? holdMs * 0.6 : holdMs);
    if (this.cine !== c) return;
    this._endNow();
    if (R.userCamT === c.saved.userT && !R.dragging) {
      R.goal.copy(c.saved.goal); R.viewGoal = c.saved.view;
    }
    R.elevGoal = R._elevBase;
    await this.arrive(P.arrive * 0.6);
  }

  _endNow() {
    const R = this.R, c = this.cine;
    if (!c) return;
    this.cine = null;
    this.barGoal = 0; this.titleGoal = 0;
    R.slowGoal = 1;
    this.note('cine-end', { kind: c.kind });
    const payload = { phase: 'end', kind: c.kind, name: c.name };
    try { R.onCinematic?.(payload); } catch { /* ignore */ }
    try { R.hooks?.onCinematic?.(payload); } catch { /* ignore */ }
  }

  /** Slow motion for the duration of a set piece (released by cineEnd / the next staged action). */
  slowmo(k) { if (this.cine) this.R.slowGoal = k ?? this.preset.slow; }

  _drawTitle(name, sub, light) {
    const cv = this.titleCv;
    if (!cv) return;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const font = (w, px) => `${w} ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    let px = light ? 78 : 96;
    g.font = font(900, px);
    while (g.measureText(name).width > 960 && px > 40) { px -= 4; g.font = font(900, px); }
    g.lineWidth = 10; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineJoin = 'round';
    g.strokeText(name, 512, sub ? 78 : 96);
    g.fillStyle = light ? '#ffd9a0' : '#ffb04a';
    g.fillText(name, 512, sub ? 78 : 96);
    if (sub) {
      g.font = font(700, 34);
      g.lineWidth = 6; g.strokeText(sub, 512, 150);
      g.fillStyle = '#efe7d4'; g.fillText(sub, 512, 150);
    }
    this.titleTex.needsUpdate = true;
    this.titleGoal = 1;
  }

  /** Per-frame: camera arrival waiters, letterbox and title animation. */
  update(realDt) {
    const R = this.R;
    if (this.waiters.length) {
      const ok = this._arrived() || R._hidden || !R.state;
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i];
        if (ok || R.realTime >= w.until) { this.waiters.splice(i, 1); w.resolve(ok); }
      }
    }
    this.barK += (this.barGoal - this.barK) * (1 - Math.exp(-realDt * 5));
    if (Math.abs(this.barK - this.barGoal) < 0.002) this.barK = this.barGoal;
    const on = this.barK > 0.003;
    this.barTop.visible = this.barBot.visible = on;
    if (on) {
      const h = LETTER * this.barK;
      this.barTop.material.uniforms.uK.value = h;
      this.barBot.material.uniforms.uK.value = h;
    }
    this.titleK += (this.titleGoal - this.titleK) * (1 - Math.exp(-realDt * 6));
    this.title.visible = this.titleK > 0.01;
    if (this.title.visible) {
      const U = this.title.material.uniforms;
      U.uA.value = clamp(this.titleK, 0, 1);
      const wFrac = R.aspect < 1 ? 0.46 : 0.3; // half-width in clip units
      U.uS.value.set(wFrac, wFrac * R.aspect * (192 / 1024));
      U.uY.value = lerp(0.9, 0.7, this.titleK) - (R.aspect < 1 ? 0.08 : 0);
    }
  }

  /** Wake any waiters (new game / teardown). */
  flush() {
    const w = this.waiters; this.waiters = [];
    for (const x of w) x.resolve(false);
    this.cine = null; this.barGoal = 0; this.barK = 0; this.titleGoal = 0; this.titleK = 0;
  }
}

export function stageTitle(kind) { return TITLES[kind] || String(kind || '').toUpperCase(); }
