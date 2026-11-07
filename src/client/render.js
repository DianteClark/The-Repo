// Tidefall renderer: stylized 2.5D isometric diorama (Three.js, orthographic
// camera that snaps in 90° steps). Reads sim state and keeps its own
// "displayed" copy (positions, HP, cover) so animation and fog of war stay in
// sync with what the player has actually been shown.
//
// Visual stack: ACES tone mapping, warm key light with soft shadows,
// hemisphere fill, golden-hour → storm grading driven by the tide stage,
// stylized SDF water for the ocean and the rising tide, merged low-poly cover
// props, animated soldiers, pooled particles, bloom + grade/vignette post.

import * as THREE from 'three';
import { canSeeTile, tileCoverDirs } from '../sim/rules.js';
import { SIGHT } from '../sim/constants.js';
import { TEAM, makeMood, moodAt } from './gfx/palette.js';
import { WorldFields, WATER_Y } from './gfx/fields.js';
import { classifyTiles, buildTerrain, tileTop } from './gfx/terrain.js';
import { buildWater } from './gfx/water.js';
import { PropField } from './gfx/props.js';
import { SoldierView } from './gfx/units.js';
import { Fx } from './gfx/fx.js';
import { Overlays, Label } from './gfx/overlays.js';
import { makeCrate, makeChute, updatePickupShared, buildScenery } from './gfx/pickups.js';
import { loadPostModules, createComposer } from './gfx/post.js';
import { clamp, damp, compass, easeInOutCubic, easeOutCubic, lerp } from './gfx/util.js';

const VIEW_MIN = 5.5, VIEW_MAX = 34;
const ELEV = 0.68; // ~39°
const CAM_D = 60;
const TEXT = { hit: '#ff6a55', graze: '#ffd9a0', miss: '#c9d2d0', heal: '#7fe9ff', tide: '#6fd6e8', info: '#efe7d4', signal: '#7fe9ff', kill: '#ffffff' };

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _ndc = new THREE.Vector2();
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

export class Renderer {
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.hooks = hooks; // sfx, onTileTap(x,y), onUnitTap(id), onTileHover(x,y)|null, onFeed(msg)
    const gl = (this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }));
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.0;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.overlay = new THREE.Scene();
    this.mood = makeMood();
    moodAt(0, this.mood);
    this.scene.background = this.mood.bg.clone();
    this.scene.fog = new THREE.Fog(this.mood.fog.clone(), CAM_D - 6, CAM_D + 60);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 400);

    // lights
    this.hemi = new THREE.HemisphereLight(this.mood.sky, this.mood.ground, this.mood.hemiI);
    this.sun = new THREE.DirectionalLight(this.mood.sun, this.mood.sunI);
    this.sunDir = new THREE.Vector3(-0.62, 0.62, 0.48).normalize();
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.025;
    this.scene.add(this.hemi, this.sun, this.sun.target);

    // camera state
    this.target = new THREE.Vector3();
    this.goal = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.view = 14; this.viewGoal = 14;
    this.camAngle = 0; this.camAngleGoal = 0;
    this.elev = ELEV; this.elevGoal = ELEV;
    this.followId = null;
    this.camStack = [];
    this.userCamT = 0;
    this.shakeT = 0;

    this.speed = 1;
    this.cinematic = true;
    this.timeScale = 1; this.slowGoal = 1; this.hitStop = 0;
    this.time = 0; this.realTime = 0;
    this.anims = [];
    this.world = null;
    this.state = null;
    this.highlight = null;
    this.unitObjs = [];
    this.storm = 0; this.stormGoal = 0;
    this.lightningT = 8;

    this.raycaster = new THREE.Raycaster();
    this._posOf = (id) => (this.isUnitVisible(id) ? this.views[id].root.position : null);
    this.hoverPx = null; this.hoverTile = -1;

    this._initQuality();
    this._setupInput();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this._last = performance.now();
    const loop = (now) => { this._frame(now); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  // ---------- quality ----------

  _initQuality() {
    this.mobile = matchMedia('(pointer: coarse)').matches || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    const q = new URLSearchParams(location.search).get('gfx');
    let gpu = '';
    try {
      const ctx = this.gl.getContext();
      const ext = ctx.getExtension('WEBGL_debug_renderer_info');
      gpu = ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
    } catch { /* ignore */ }
    this.gpu = gpu;
    const weakGpu = /SwiftShader|llvmpipe|softpipe|Mali-[4T]|Adreno \(TM\) [2-5]\d\d|PowerVR SGX|Intel\(R\) HD Graphics [2-5]/i.test(gpu);
    const mem = navigator.deviceMemory || 8, cores = navigator.hardwareConcurrency || 8;
    const auto = weakGpu || mem <= 2 || (this.mobile && cores <= 4) ? 'low' : 'high';
    this.qualityPinned = q === 'low' || q === 'high';
    this.perf = { frames: 0, time: 0, bad: 0, warm: 0, prCap: 2 };
    this.autoQuality = auto;
    this.setQuality(this.qualityPinned ? q : auto, true);
  }

  /** 'high' | 'low'. Manual calls pin the quality (auto-downgrade stops). */
  setQuality(q, _auto = false) {
    if (!_auto) this.qualityPinned = true;
    q = q === 'low' ? 'low' : 'high';
    this.quality = q;
    const high = q === 'high';
    const dpr = window.devicePixelRatio || 1;
    this.pixelRatio = Math.min(dpr, high ? this.perf.prCap : 1.25);
    this.gl.setPixelRatio(this.pixelRatio);
    const shadows = high;
    if (this.gl.shadowMap.enabled !== shadows) {
      this.gl.shadowMap.enabled = shadows;
      this.scene.traverse((o) => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; }); });
    }
    this.sun.castShadow = shadows;
    const ms = this.mobile ? 1024 : 2048;
    if (this.sun.shadow.mapSize.x !== ms) {
      this.sun.shadow.mapSize.set(ms, ms);
      this.sun.shadow.map?.dispose(); this.sun.shadow.map = null;
    }
    this.fx?.setScale(high ? 1 : 0.6);
    if (high) {
      const want = ++this._postReq || (this._postReq = 1);
      loadPostModules().then((M) => {
        if (!M || this.quality !== 'high' || want !== this._postReq) return;
        if (!this.post) this.post = createComposer(M, this.gl, this.scene, this.camera, { samples: 4 });
        this.resize();
      });
    } else {
      this._postReq = (this._postReq || 0) + 1;
      if (this.post) { this.post.composer.dispose?.(); this.post.rt.dispose(); this.post = null; }
    }
    this.resize();
  }

  /** Return to automatic quality selection (unpins). */
  setAutoQuality() {
    this.qualityPinned = false;
    this.perf.bad = 0; this.perf.warm = 0; this.perf.prCap = 2;
    this.setQuality(this.autoQuality, true);
  }

  /** Camera yaw around the vertical axis (radians), for the minimap. */
  cameraYaw() { return Math.PI / 4 + this.camAngle * (Math.PI / 2); }

  _perfTick(realDt) {
    if (this.qualityPinned || !this.state) return;
    const p = this.perf;
    p.warm += realDt;
    if (p.warm < 2.5) return;
    p.frames++; p.time += realDt;
    if (p.time < 2.5) return;
    const fps = p.frames / p.time;
    p.frames = 0; p.time = 0;
    if (fps < 40) p.bad++; else p.bad = 0;
    if (p.bad >= 2 && this.quality === 'high') {
      p.bad = 0; p.warm = 0;
      if (this.pixelRatio > 1.25) { p.prCap = 1.25; this.setQuality('high', true); } else this.setQuality('low', true);
    }
  }

  setCinematic(on) { this.cinematic = !!on; }

  // ---------- setup ----------

  setGame(state, myTeam) {
    if (this.world) this._teardown();
    this.anims = [];
    this.state = state;
    this.myTeam = myTeam;
    this.spectator = myTeam < 0;
    this.highlight = null;
    this.followId = null;
    this.camStack = [];
    this.timeScale = this.slowGoal = 1; this.hitStop = 0;
    const S = (this.S = state.map.size);
    this.r0 = state.zone.r;
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.fields = new WorldFields(S);
    const wx = (x) => this.wx(x), wz = (y) => this.wz(y);

    this.cls = classifyTiles(state.map, state.seed || 1);
    this.terrain = buildTerrain(state.map, this.fields, this.cls, wx, wz);
    this.world.add(this.terrain.group);
    this.water = buildWater(this.fields, S, this.quality === 'high' ? 160 : 90);
    this.world.add(this.water.mesh);
    this.props = new PropField(state.map, this.cls, this.fields, wx, wz, state.seed || 1);
    this.world.add(this.props.group);
    this.scenery = buildScenery(S, state.seed || 1, this.fields);
    this.world.add(this.scenery);

    this.fx = new Fx(this.world, this.overlay, { scale: this.quality === 'high' ? 1 : 0.6 });
    this.fx.floodedAt = (x, z) => this._floodedWorld(x, z);
    this.ov = new Overlays(this.world, this.overlay, wx, wz, S);

    // shadow camera covers the whole map
    const sc = this.sun.shadow.camera;
    const ext = S * 0.74;
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 140;
    sc.updateProjectionMatrix();
    this.sun.position.copy(this.sunDir).multiplyScalar(60);
    this.sun.target.position.set(0, 0, 0);
    this.fields.uniforms.uSunDir.value.copy(this.sunDir);

    // crates
    this.crateMeshes = new Map();
    for (const c of state.crates) if (!c.taken) this._addCrate(c);

    // units
    this.disp = state.units.map((u) => ({ x: u.x, y: u.y, alive: u.alive, hp: u.hp }));
    this.views = state.units.map((u) => {
      const v = new SoldierView(u, u.team === myTeam);
      v.root.position.set(this.wx(u.x), this._groundY(u.x, u.y), this.wz(u.y));
      v.root.rotation.y = Math.atan2(this.wx(S / 2) - v.root.position.x, this.wz(S / 2) - v.root.position.z);
      v.setOverwatch(!!u.overwatch);
      if (u.hunkered) { v.hunk = 1; }
      this.world.add(v.root);
      return v;
    });
    this.unitObjs = this.views.map((v) => ({ g: v.root })); // legacy shim
    this.labels = state.units.map(() => new Label(this.overlay));

    // "you" marker
    const mg = new THREE.ConeGeometry(0.15, 0.3, 4);
    mg.rotateX(Math.PI);
    this.marker = new THREE.Mesh(mg, new THREE.MeshBasicMaterial({ color: new THREE.Color(TEAM.amber).multiplyScalar(1.5), toneMapped: false }));
    this.marker.renderOrder = 21;
    this.overlay.add(this.marker);

    this.selTarget = null; this.targets = null;
    this._updateZone(true);
    this.storm = this.stormGoal;
    this.refreshFog(true);
    for (const u of state.units) this._drawLabel(u);
    const me = state.units.find((u) => u.isPlayer) || state.units[0];
    this.focus(me.x, me.y, true);
    this.view = this.viewGoal = this.aspect < 1 ? 13 : 14;
    this.perf.warm = 0;
  }

  _teardown() {
    this.fx?.clear();
    this.scene.remove(this.world);
    for (const l of this.labels || []) { this.overlay.remove(l.s); l.tex.dispose(); l.s.material.dispose(); }
    for (const v of this.views || []) v.dispose();
    this.overlay.clear();
    this.props?.dispose();
    this.world.traverse((o) => {
      if (o.isInstancedMesh || o.isMesh || o.isLineSegments) o.geometry?.dispose?.();
    });
    this.world = null;
  }

  wx(x) { return x - this.S / 2 + 0.5; }
  wz(y) { return y - this.S / 2 + 0.5; }
  _groundY(x, y) { return tileTop(this.cls.type[y * this.S + x]); }
  _floodedWorld(px, pz) {
    const x = Math.floor(px + this.S / 2), y = Math.floor(pz + this.S / 2);
    if (x < 0 || y < 0 || x >= this.S || y >= this.S) return true;
    return !!this.fields.flooded[y * this.S + x];
  }
  _flooded(x, y) { return !!this.fields.flooded[y * this.S + x]; }

  _addCrate(c, pop = false) {
    if (this.crateMeshes.has(c.id)) return;
    const g = makeCrate(c.type);
    g.position.set(this.wx(c.x), this._groundY(c.x, c.y), this.wz(c.y));
    this.world.add(g);
    this.crateMeshes.set(c.id, g);
    if (pop) {
      g.scale.setScalar(0.01);
      this.fx.timed(0.45, (t) => g.scale.setScalar(Math.max(0.01, 1 + Math.sin(t * Math.PI) * 0.25 * (1 - t) - (1 - t) * (1 - t))));
    }
    return g;
  }
  _removeCrate(id) {
    const g = this.crateMeshes.get(id);
    if (g) { this.world.remove(g); this.crateMeshes.delete(id); }
  }

  // ---------- labels ----------

  _drawLabel(u) {
    const l = this.labels?.[u.id];
    if (!l) return;
    l.draw(u, u.team === this.myTeam, Math.max(0, this.disp[u.id].hp), { ow: !!u.overwatch, hk: !!u.hunkered, lw: !!u.isLoneWolf });
  }

  // ---------- fog / highlights / zone ----------

  visibleToMe(x, y) {
    if (this.spectator) return true;
    for (const u of this.state.units) {
      if (u.team !== this.myTeam) continue;
      const d = this.disp[u.id];
      if (d.alive && canSeeTile(this.state.map, d.x, d.y, x, y)) return true;
    }
    return false;
  }

  isUnitVisible(id) {
    const v = this.views?.[id];
    return !!v && v.root.visible && this.disp[id].alive;
  }

  setSpectator(on) { this.spectator = on; this.refreshFog(); }

  refreshFog(instant = false) {
    const S = this.S, st = this.state;
    if (!this.spectator && !st.units.some((u) => u.team === this.myTeam && this.disp[u.id].alive)) this.spectator = true;
    const fog = (this.fogMask = new Uint8Array(S * S));
    if (this.spectator) fog.fill(1);
    else {
      for (const u of st.units) {
        if (u.team !== this.myTeam) continue;
        const d = this.disp[u.id];
        if (!d.alive) continue;
        for (let y = Math.max(0, d.y - SIGHT); y <= Math.min(S - 1, d.y + SIGHT); y++) {
          for (let x = Math.max(0, d.x - SIGHT); x <= Math.min(S - 1, d.x + SIGHT); x++) {
            const k = y * S + x;
            if (!fog[k] && canSeeTile(st.map, d.x, d.y, x, y)) fog[k] = 1;
          }
        }
      }
    }
    this.fields.setFog(fog, instant);
    for (const u of st.units) this._syncUnitVisibility(u);
  }

  _syncUnitVisibility(u) {
    const d = this.disp[u.id];
    const v = this.views[u.id];
    const seen = u.team === this.myTeam || this.fogMask[d.y * this.S + d.x] === 1;
    v.root.visible = d.alive ? seen : !!v.corpse && seen;
  }

  setHighlights(map) { this.highlight = map; this.ov?.setHighlights(map); }

  setPathPreview(path, cost = 1) {
    if (!this.ov) return;
    if (!path || path.length < 2) { this.ov.setPath(null); return; }
    const [ex, ey] = path[path.length - 1];
    this.ov.setPath(path, cost, tileCoverDirs(this.state.map, ex, ey));
  }

  setAoePreview(a) {
    if (!this.ov) return;
    this.ov.setAoe(a || null);
  }

  setTargetMarkers(list) {
    this.targets = list && list.length ? list : null;
    this.ov?.setTargets(this.targets && this.targets.map((t) => ({ ...t, sel: t.id === this.selTarget || !!t.selected })));
  }

  setSelectedTarget(id) {
    const prev = this.selTarget;
    this.selTarget = id ?? null;
    this.ov?.markSelected(this.selTarget);
    if (this.selTarget !== null && this.views[this.selTarget]) {
      const me = this._activeUnit();
      if (prev === null) this._camPush();
      if (me) {
        const a = this.views[me.id].root.position, b = this.views[this.selTarget].root.position;
        this.goal.set((a.x + b.x) / 2, 0, (a.z + b.z) / 2);
        this.viewGoal = Math.max(8, this._fitView(a, b, 3, 4.5));
        this.followId = null;
      }
    } else if (prev !== null) this._camPop();
  }

  _playerUnit() {
    const us = this.state.units;
    for (let i = 0; i < us.length; i++) if (us[i].isPlayer) return us[i];
    return null;
  }

  _activeUnit() {
    if (!this.state) return null;
    return this.state.units.find((u) => u.isPlayer && this.disp[u.id].alive)
      || this.state.units.find((u) => u.team === this.myTeam && this.disp[u.id].alive) || null;
  }

  _updateZone(instant) {
    const S = this.S, z = this.state.zone;
    this.fields.setTide((x, y) => Math.hypot(x - z.x, y - z.y) > z.r, instant);
    const warn = new Uint8Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - z.x, y - z.y);
      warn[y * S + x] = d <= z.r && d > z.next ? 1 : 0;
    }
    this.fields.setWarn(warn);
    this.stormGoal = clamp((this.r0 - z.r) / Math.max(1, this.r0 * 0.8), 0, 1);
    if (!instant) {
      const U = this.fields.uniforms.uTideMix;
      this.fx.timed(1.8, (t) => { U.value = easeInOutCubic(t); });
    }
  }

  /** Snap everything to the sim state (used after fast-forward). */
  syncFromState() {
    const st = this.state;
    this.anims.length = 0;
    this.fx.clear();
    this.timeScale = this.slowGoal = 1; this.hitStop = 0;
    st.units.forEach((u, i) => {
      this.disp[i] = { x: u.x, y: u.y, alive: u.alive, hp: u.hp };
      const v = this.views[i];
      v.revive();
      v.root.position.set(this.wx(u.x), this._groundY(u.x, u.y), this.wz(u.y));
      v.walkGoal = 0; v.setOverwatch(!!u.overwatch); v.setHunker(!!u.hunkered);
      if (!u.alive) { v.die(); v.deathT = 5; v.corpse = false; }
      this._drawLabel(u);
    });
    for (const c of st.crates) {
      if (c.taken) this._removeCrate(c.id);
      else this._addCrate(c);
    }
    const S = this.S;
    for (let k = 0; k < S * S; k++) if (this.props.cover[k] !== st.map.cover[k]) this.props.setCover(k % S, (k / S) | 0, st.map.cover[k]);
    this._updateZone(true);
    this.refreshFog(true);
  }

  // ---------- camera ----------

  focus(x, y, instant = false) {
    this.goal.set(this.wx(x), 0, this.wz(y));
    this.followId = null;
    this.vel.set(0, 0, 0);
    if (instant) this.target.copy(this.goal);
  }
  rotate(dir) { this.camAngleGoal += dir; }
  zoomBy(f) { this.viewGoal = clamp(this.viewGoal * f, VIEW_MIN, VIEW_MAX); this.userCamT = this.realTime; }
  setFollow(id) { this.followId = id ?? null; if (id !== null && id !== undefined) this.vel.set(0, 0, 0); }

  _camPush() {
    this.camStack.push({ goal: this.goal.clone(), view: this.viewGoal, elev: this.elevGoal, follow: this.followId, userT: this.userCamT });
  }
  _camPop() {
    const s = this.camStack.pop();
    if (!s) return;
    this.elevGoal = s.elev;
    if (this.userCamT !== s.userT) return; // the player took the camera, leave it
    this.goal.copy(s.goal); this.viewGoal = s.view; this.followId = s.follow;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.gl.setSize(w, h, false);
    this.aspect = w / h;
    this.viewScale = this.aspect < 1 ? 1.3 : 1;
    if (this.post) {
      this.post.composer.setPixelRatio(this.pixelRatio);
      this.post.composer.setSize(w, h);
      this.post.grade.uniforms.uAspect.value = this.aspect;
    }
    this._updateCamera(0);
  }

  _updateCamera(dt) {
    if (this.followId !== null && this.views?.[this.followId]) {
      const p = this.views[this.followId].root.position;
      this.goal.set(p.x, 0, p.z);
    }
    if (!this.dragging && dt > 0 && this.vel.lengthSq() > 1e-5) {
      this.goal.addScaledVector(this.vel, dt);
      this.vel.multiplyScalar(Math.exp(-5 * dt));
    }
    if (this.S) {
      const lim = this.S / 2 + 2;
      this.goal.x = clamp(this.goal.x, -lim, lim);
      this.goal.z = clamp(this.goal.z, -lim, lim);
    }
    if (dt > 0) {
      if (!this.dragging) this.target.lerp(this.goal, damp(this.followId !== null ? 9 : 7, dt));
      this.view += (this.viewGoal - this.view) * damp(9, dt);
      this.camAngle += (this.camAngleGoal - this.camAngle) * damp(8, dt);
      this.elev += (this.elevGoal - this.elev) * damp(5, dt);
    }
    const v = this.view * this.viewScale;
    const c = this.camera;
    c.left = (-v * this.aspect) / 2; c.right = (v * this.aspect) / 2; c.top = v / 2; c.bottom = -v / 2;
    c.updateProjectionMatrix();
    const a = Math.PI / 4 + this.camAngle * (Math.PI / 2);
    const e = this.elev;
    let sx = 0, sy = 0;
    const sh = this.fx ? this.fx.shake : 0;
    if (sh > 0) {
      const k = sh * sh * 0.35 * Math.min(1, this.view / 12);
      sx = (Math.sin(this.realTime * 61) + Math.sin(this.realTime * 37)) * k;
      sy = (Math.cos(this.realTime * 53) + Math.sin(this.realTime * 29)) * k;
    }
    const t = this.target;
    c.position.set(t.x + Math.cos(a) * Math.cos(e) * CAM_D, t.y + Math.sin(e) * CAM_D, t.z + Math.sin(a) * Math.cos(e) * CAM_D);
    _v1.set(t.x, t.y, t.z);
    c.lookAt(_v1);
    if (sx || sy) { c.translateX(sx); c.translateY(sy); }
    c.updateMatrixWorld();
  }

  // ---------- input ----------

  _groundAt(cx, cy, out) {
    const r = this.canvas.getBoundingClientRect();
    _ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(_ndc, this.camera);
    return this.raycaster.ray.intersectPlane(_plane, out);
  }

  _setupInput() {
    const el = this.canvas;
    const pts = new Map();
    let dragged = false, pinch0 = 0, view0 = 0, t0 = 0;
    const grab = new THREE.Vector3(), cur = new THREE.Vector3();
    let lastMoveT = 0;
    const startGrab = (x, y) => { this._updateCamera(0); if (!this._groundAt(x, y, grab)) grab.set(0, 0, 0); };
    const mid = () => { const [a, b] = [...pts.values()]; return [(a.x + b.x) / 2, (a.y + b.y) / 2, Math.hypot(a.x - b.x, a.y - b.y)]; };
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
      if (pts.size === 1) { dragged = false; t0 = performance.now(); startGrab(e.clientX, e.clientY); this.vel.set(0, 0, 0); }
      if (pts.size === 2) {
        const [mx, my, d] = mid();
        pinch0 = d; view0 = this.viewGoal; dragged = true;
        startGrab(mx, my);
      }
    });
    el.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) {
        if (e.pointerType === 'mouse') this.hoverPx = [e.clientX, e.clientY];
        return;
      }
      p.x = e.clientX; p.y = e.clientY;
      let gx, gy;
      if (pts.size >= 2) {
        const [mx, my, d] = mid();
        if (pinch0 > 0) { this.viewGoal = this.view = clamp(view0 * (pinch0 / Math.max(1, d)), VIEW_MIN, VIEW_MAX); }
        gx = mx; gy = my;
      } else {
        if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 8) dragged = true;
        if (!dragged) return;
        gx = e.clientX; gy = e.clientY;
      }
      this.dragging = true;
      this.followId = null;
      this.userCamT = this.realTime;
      this._updateCamera(0);
      if (this._groundAt(gx, gy, cur)) {
        const dx = grab.x - cur.x, dz = grab.z - cur.z;
        this.target.x += dx; this.target.z += dz;
        this.goal.copy(this.target);
        const now = performance.now(), dtm = Math.max(1, now - lastMoveT) / 1000;
        lastMoveT = now;
        this.vel.set(lerp(this.vel.x, dx / dtm, 0.35), 0, lerp(this.vel.z, dz / dtm, 0.35));
        this._updateCamera(0);
      }
    });
    const up = (e) => {
      const p = pts.get(e.pointerId);
      pts.delete(e.pointerId);
      if (pts.size === 1) { const [q] = pts.values(); startGrab(q.x, q.y); }
      if (pts.size === 0) {
        this.dragging = false;
        if (performance.now() - lastMoveT > 90) this.vel.set(0, 0, 0);
        const vmax = 40;
        if (this.vel.length() > vmax) this.vel.setLength(vmax);
        if (p && !dragged && performance.now() - t0 < 700) this._tap(e.clientX, e.clientY);
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); if (!pts.size) this.dragging = false; });
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !pts.size) { this.hoverPx = null; this._setHover(-1); } });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.exp(clamp(e.deltaY, -120, 120) * 0.0018);
      const nv = clamp(this.viewGoal * f, VIEW_MIN, VIEW_MAX);
      if (this._groundAt(e.clientX, e.clientY, cur)) {
        const k = 1 - nv / this.viewGoal;
        this.goal.x += (cur.x - this.goal.x) * k;
        this.goal.z += (cur.z - this.goal.z) * k;
      }
      this.viewGoal = nv;
      this.followId = null;
      this.userCamT = this.realTime;
    }, { passive: false });
  }

  _tileAt(cx, cy) {
    if (!this._groundAt(cx, cy, _v2)) return -1;
    const x = Math.floor(_v2.x + this.S / 2), y = Math.floor(_v2.z + this.S / 2);
    if (x < 0 || y < 0 || x >= this.S || y >= this.S) return -1;
    return y * this.S + x;
  }

  _setHover(k) {
    if (k === this.hoverTile) return;
    this.hoverTile = k;
    if (k < 0) { this.ov?.setHover(null); this.hooks.onTileHover?.(null); return; }
    const x = k % this.S, y = (k / this.S) | 0;
    this.ov?.setHover(x, y);
    this.hooks.onTileHover?.(x, y);
  }

  _tap(cx, cy) {
    if (!this.state) return;
    const r = this.canvas.getBoundingClientRect();
    _ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(_ndc, this.camera);
    const roots = [];
    for (let i = 0; i < this.views.length; i++) if (this.views[i].root.visible && this.disp[i].alive) roots.push(this.views[i].pose);
    const hit = this.raycaster.intersectObjects(roots, true)[0];
    if (hit) {
      let o = hit.object;
      while (o && o.userData.unitId === undefined) o = o.parent;
      if (o) { this.hooks.onUnitTap?.(o.userData.unitId); return; }
    }
    const k = this._tileAt(cx, cy);
    if (k >= 0) this.hooks.onTileTap?.(k % this.S, (k / this.S) | 0);
  }

  // ---------- animation core ----------

  _anim(ms, fn) {
    return new Promise((resolve) => {
      this.anims.push({ t: 0, dur: Math.max(0.001, ms / 1000 / this.speed), fn, resolve });
    });
  }
  _wait(ms) { return this._anim(ms, null); }
  get _fast() { return this.speed > 1.6; }

  _frame(now) {
    const realDt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    this.realTime += realDt;
    if (this.hitStop > 0) { this.hitStop -= realDt; this.timeScale = 0.03; } else this.timeScale += (this.slowGoal - this.timeScale) * damp(10, realDt);
    const dt = realDt * this.timeScale;
    this.time += dt;
    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i];
      a.t += dt;
      const t = Math.min(1, a.t / a.dur);
      if (a.fn) a.fn(t);
      if (t >= 1) { this.anims.splice(i, 1); a.resolve(); }
    }
    if (this.state && this.world) {
      this._perfTick(realDt);
      const U = this.fields.uniforms;
      U.uTime.value = this.time;
      this.fields.update(realDt);
      // mood / storm grading
      this.storm += (this.stormGoal - this.storm) * damp(0.8, realDt);
      U.uStorm.value = this.storm;
      moodAt(this.storm, this.mood);
      this._lightning(realDt);
      const flash = this._flash || 0;
      this.sun.color.copy(this.mood.sun); this.sun.intensity = this.mood.sunI;
      this.hemi.color.copy(this.mood.sky); this.hemi.groundColor.copy(this.mood.ground); this.hemi.intensity = this.mood.hemiI + flash * 3;
      this.scene.fog.color.copy(this.mood.fog);
      this.scene.background.copy(this.mood.bg);
      this.gl.toneMappingExposure = this.mood.exposure;
      U.uSunCol.value.copy(this.mood.sun);
      U.uSkyCol.value.copy(this.mood.sky);
      const wu = this.water.uniforms;
      wu.uFogColor.value.copy(this.mood.fog);
      wu.uFogNear.value = this.scene.fog.near; wu.uFogFar.value = this.scene.fog.far;
      if (this.post) {
        const g = this.post.grade.uniforms;
        g.uStorm.value = this.storm; g.uTime.value = this.realTime % 100; g.uFlash.value = flash * 0.25;
        g.uDesat.value = 0.75 * (1 - clamp(this.timeScale * 1.4, 0, 1));
      }
      if (this.storm > 0.45 && !this._fast) this._rain(realDt);
      // units
      for (let i = 0; i < this.views.length; i++) {
        const v = this.views[i];
        if (v.root.visible) v.update(dt, this.time);
      }
      this.fx.update(dt, null);
      updatePickupShared(this.time);
      for (const g of this.crateMeshes.values()) {
        const ud = g.userData;
        ud.spin.rotation.y += dt * 0.7;
        ud.spin.position.y = 0.06 + Math.sin(this.time * 2.2 + ud.phase) * 0.04;
      }
      this._updateOverlays();
      if (this.hoverPx && !this.dragging) { this._setHover(this._tileAt(this.hoverPx[0], this.hoverPx[1])); }
    }
    this._updateCamera(realDt);
    if (this.post) this.post.composer.render(realDt);
    else this.gl.render(this.scene, this.camera);
    this.gl.autoClear = false;
    this.gl.clearDepth();
    this.gl.render(this.overlay, this.camera);
    this.gl.autoClear = true;
  }

  _lightning(dt) {
    this._flash = Math.max(0, (this._flash || 0) - dt * 4);
    if (this.storm < 0.6) return;
    this.lightningT -= dt;
    if (this.lightningT <= 0) {
      this.lightningT = 6 + Math.random() * 10;
      this._flash = 1;
      setTimeout(() => { this._flash = 0.7; }, 120);
    }
  }

  _rain(dt) {
    const n = Math.floor((this.storm - 0.45) * 160 * dt * (this.quality === 'high' ? 1 : 0.5) + Math.random());
    const span = this.view * 0.9;
    for (let i = 0; i < n; i++) {
      const x = this.target.x + (Math.random() - 0.5) * span * 2, z = this.target.z + (Math.random() - 0.5) * span * 2;
      this.fx.alpha.spawn(x, 6 + Math.random() * 3, z, -2, -22, 1, 0.38, 0.025, 0.025, 0.75, 0.85, 0.9, 0.32, 0, 0, 1.6, 1);
    }
  }

  _updateOverlays() {
    const lscale = clamp(this.view / 14, 0.85, 1.7) * (this.aspect < 1 ? 1.25 : 1);
    for (let i = 0; i < this.views.length; i++) {
      const v = this.views[i], l = this.labels[i];
      const show = v.root.visible && this.disp[i].alive && !v.dead;
      l.s.visible = show;
      if (show) {
        const p = v.root.position;
        l.s.position.set(p.x, p.y + 1.18 - v.hunk * 0.14, p.z);
        l.s.scale.set(1.45 * lscale, 0.476 * lscale, 1);
      }
    }
    const me = this._playerUnit();
    if (me && this.disp[me.id].alive && this.views[me.id].root.visible) {
      const p = this.views[me.id].root.position;
      this.marker.visible = true;
      this.marker.position.set(p.x, p.y + 1.18 + 0.62 * lscale + Math.sin(this.realTime * 4) * 0.06, p.z);
      this.marker.rotation.y += 0.03;
    } else this.marker.visible = false;
    this.ov.updateBadges(this._posOf);
    if (this.selTarget !== null && this.isUnitVisible(this.selTarget)) {
      const a = this._activeUnit();
      this.ov.setAim(a ? this.views[a.id].root.position : null, this.views[this.selTarget].root.position);
    } else this.ov.setAim(null);
    this.ov.update(this.realTime - (this._ovT || 0));
    this._ovT = this.realTime;
  }

  // ---------- helpers ----------

  _ping(x, y) {
    this.fx.ring(this.wx(x), 0.15, this.wz(y), 0.6, 3.2, 0xd8e6e2, 1.4, 0.8);
    this.fx.ring(this.wx(x), 0.15, this.wz(y), 0.2, 2.0, 0xd8e6e2, 1.0, 0.6);
  }

  _far(x, y) {
    const n = this.myRef();
    return Math.min(1, Math.hypot(x - n.x, y - n.y) / 16);
  }

  _text(x, y, text, color, big = 1, h = 1.35) {
    this.fx.floatText(this.wx(x), h, this.wz(y), text, color, big);
  }

  _face(id, x, y, instant) { this.views[id].faceTo(this.wx(x), this.wz(y), instant); }

  /** View size that fits world points a and b on screen with padding (tiles). */
  _fitView(a, b, padW, padH) {
    const ang = Math.PI / 4 + this.camAngleGoal * (Math.PI / 2);
    const dx = b.x - a.x, dz = b.z - a.z;
    const w = Math.abs(-Math.sin(ang) * dx + Math.cos(ang) * dz);
    const h = Math.abs(Math.cos(ang) * dx + Math.sin(ang) * dz) * Math.sin(this.elevGoal) + 1.2;
    const v = Math.max((w + padW) / this.aspect, h + padH);
    return clamp(v / this.viewScale, VIEW_MIN + 1, VIEW_MAX);
  }

  /** Frame two world points for an action cam. */
  _actionCam(a, b, kill) {
    if (!this.cinematic || this._fast) return false;
    this._camPush();
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    void d;
    if (kill) {
      this.elevGoal = 0.5;
      this.goal.set(lerp(a.x, b.x, 0.55), 0, lerp(a.z, b.z, 0.55));
      this.viewGoal = Math.max(6.5, this._fitView(a, b, 2.2, 2.6));
    } else {
      this.elevGoal = 0.6;
      this.goal.set((a.x + b.x) / 2, 0, (a.z + b.z) / 2);
      this.viewGoal = Math.max(8, this._fitView(a, b, 3, 3.5));
    }
    this.followId = null;
    return true;
  }

  _lookAtEvent(x, y) {
    // gently bring an off-screen event into view (only if far from the current target)
    if (!this.cinematic || this._fast) return;
    const wx = this.wx(x), wz = this.wz(y);
    if (Math.hypot(wx - this.target.x, wz - this.target.z) > this.view * 0.45) { this.goal.set(wx, 0, wz); this.followId = null; }
  }

  myRef() {
    const me = this.state.units.find((u) => u.isPlayer && this.disp[u.id].alive)
      || this.state.units.find((u) => u.team === this.myTeam && this.disp[u.id].alive);
    if (me) return this.disp[me.id];
    return { x: this.S / 2, y: this.S / 2 };
  }

  _weaponOf(u) { return u.weapon?.name || ({ assault: 'Rifle', marksman: 'Long Rifle', breacher: 'Shotgun' })[u.cls]; }

  _hp(id, delta) {
    const d = this.disp[id], u = this.state.units[id];
    d.hp = clamp(d.hp + delta, 0, u.maxHp);
    this._drawLabel(u);
  }

  // ---------- events ----------

  /** Play one sim event. Resolves when its animation is done. */
  async playEvent(ev) {
    if (!this.state) return;
    const st = this.state;
    const sfx = this.hooks.sfx;
    switch (ev.type) {
      case 'move': return this._evMove(ev);
      case 'shot': return this._evShot(ev);
      case 'death': return this._evDeath(ev);
      case 'grenade': return this._evGrenade(ev);
      case 'damage': return this._evDamage(ev);
      case 'cover_change': return this._evCover(ev);
      case 'breach': return this._evBreach(ev);
      case 'supply_drop': return this._evSupply(ev);
      case 'overwatch': {
        const u = st.units[ev.id], v = this.views[ev.id];
        v.setOverwatch(true);
        this._drawLabel(u);
        if (u.team === this.myTeam || v.root.visible) {
          const d = this.disp[ev.id];
          this._text(d.x, d.y, 'OVERWATCH', TEXT.signal, 0.8);
          this.fx.ring(v.root.position.x, 0.08, v.root.position.z, 0.3, 1.6, TEAM.cyan, 0.6, 1);
          await this._wait(380);
        }
        return;
      }
      case 'overwatch_trigger': {
        const shooter = st.units[ev.id], target = st.units[ev.target];
        this.views[ev.id].setOverwatch(false);
        this._drawLabel(shooter);
        if (target.team === this.myTeam || shooter.team === this.myTeam || this.views[ev.target].root.visible) {
          sfx?.tripwire();
          const d = this.disp[ev.target];
          this._text(d.x, d.y, 'REACTION!', TEXT.signal, 0.85, 1.6);
          this._face(ev.id, d.x, d.y);
          await this._wait(380);
        }
        return;
      }
      case 'hunker': {
        const u = st.units[ev.id], v = this.views[ev.id];
        v.setHunker(true);
        this._drawLabel(u);
        if (u.team === this.myTeam || v.root.visible) {
          sfx?.hunker?.();
          const d = this.disp[ev.id];
          this._text(d.x, d.y, 'HUNKER DOWN', TEXT.info, 0.8);
          this.fx.dust(v.root.position.x, v.root.position.z, 8, 0.78, 0.7, 0.56, 0.05, 1.2);
          await this._wait(420);
        }
        return;
      }
      case 'crate': {
        const g = this.crateMeshes.get(ev.crate);
        const u = st.units[ev.id];
        const vis = u.team === this.myTeam || this.views[ev.id].root.visible;
        if (g && vis) this.fx.pickupBurst(g.position.x, g.position.z);
        this._removeCrate(ev.crate);
        this._drawLabel(u);
        if (u.team === this.myTeam) {
          sfx?.pickup();
          const d = this.disp[ev.id];
          const name = { cache: 'SUPPLY CACHE', frag: '+FRAG', medkit: '+MEDKIT', armor: '+ARMOR', scope: '+SCOPE', barrel: '+BARREL' }[ev.item] || '+' + String(ev.item).toUpperCase();
          this._text(d.x, d.y, name, TEXT.signal, 0.9);
          await this._wait(350);
        }
        return;
      }
      case 'crate_drop':
        this._addCrate(ev.crate, true);
        return;
      case 'heal': {
        const u = st.units[ev.id], v = this.views[ev.id];
        this._hp(ev.id, ev.amount);
        if (v.root.visible) {
          const d = this.disp[ev.id];
          this._text(d.x, d.y, '+' + ev.amount, TEXT.heal, 1);
          const p = v.root.position;
          for (let i = 0; i < 14; i++) this.fx.add.spawn(p.x + (Math.random() - 0.5) * 0.5, 0.2 + Math.random() * 0.6, p.z + (Math.random() - 0.5) * 0.5, 0, 0.8 + Math.random(), 0, 0.8, 0.06, 0.02, 1.2, 3.4, 4, 1, 1, 0, 0.8, 1);
          await this._wait(380);
        }
        void u;
        return;
      }
      case 'zone_damage': {
        const v = this.views[ev.id];
        this._hp(ev.id, -ev.dmg);
        if (v.root.visible) {
          const d = this.disp[ev.id];
          this._text(d.x, d.y, `TIDE -${ev.dmg}`, TEXT.tide, 0.9);
          v.doFlinch(0.6);
          this.fx.splash(v.root.position.x, v.root.position.z, 1.2);
          await this._wait(320);
        }
        return;
      }
      case 'zone_shrink':
        sfx?.tide();
        this._updateZone(false);
        this.fx.shake = Math.max(this.fx.shake, 0.3);
        await this._wait(900);
        return;
      case 'turn_start':
        for (const id of st.teams[ev.team].members) {
          const u = st.units[id];
          if (u.alive) this.disp[id].hp = u.hp;
          this.views[id].setOverwatch(!!u.overwatch && u.alive);
          this.views[id].setHunker(!!u.hunkered && u.alive);
          this._drawLabel(u);
        }
        return;
      case 'game_over':
        this.slowGoal = 1;
        return;
      default:
        return;
    }
  }

  async _evMove(ev) {
    const st = this.state, sfx = this.hooks.sfx;
    const u = st.units[ev.id];
    const mine = u.team === this.myTeam;
    const v = this.views[ev.id];
    if (ev.path.length < 2) return;
    const anyVisible = mine || ev.path.some(([x, y]) => this.visibleToMe(x, y));
    v.setHunker(false);
    if (!anyVisible || this.speed > 3) {
      const [ex, ey] = ev.path[ev.path.length - 1];
      const [px, py] = ev.path[ev.path.length - 2];
      this.disp[ev.id].x = ex; this.disp[ev.id].y = ey;
      v.root.position.set(this.wx(ex), this._groundY(ex, ey), this.wz(ey));
      v.faceTo(this.wx(ex) + (ex - px), this.wz(ey) + (ey - py), true);
      if (mine) this.refreshFog(); else this._syncUnitVisibility(u);
      return;
    }
    v.walkGoal = 1;
    for (let i = 1; i < ev.path.length; i++) {
      const [ax, ay] = ev.path[i - 1], [bx, by] = ev.path[i];
      this._face(ev.id, bx, by);
      const vis = mine || this.visibleToMe(ax, ay) || this.visibleToMe(bx, by);
      v.root.visible = vis;
      const diag = ax !== bx && ay !== by;
      const ya = this._groundY(ax, ay), yb = this._groundY(bx, by);
      await this._anim(vis ? (diag ? 175 : 140) : 1, (t) => {
        v.root.position.set(this.wx(ax + (bx - ax) * t), lerp(ya, yb, t), this.wz(ay + (by - ay) * t));
      });
      this.disp[ev.id].x = bx; this.disp[ev.id].y = by;
      if (vis) {
        sfx?.step();
        const p = v.root.position;
        if (this._flooded(bx, by)) this.fx.splash(p.x, p.z, 0.55);
        else this.fx.dust(p.x, p.z, 3);
      }
      if (mine && (i % 2 === 0 || i === ev.path.length - 1)) this.refreshFog();
    }
    v.walkGoal = 0;
    if (mine) this.refreshFog(); else this._syncUnitVisibility(u);
  }

  _coverTileBetween(tx, ty, sx, sy) {
    const map = this.state.map, S = this.S;
    const ddx = sx - tx, ddy = sy - ty;
    let best = null, bc = 0;
    const consider = (x, y) => {
      if (x < 0 || y < 0 || x >= S || y >= S) return;
      const c = this.props.cover[y * S + x];
      if (c > bc) { bc = c; best = [x, y]; }
    };
    if (ddx !== 0 && Math.abs(ddx) * 2 >= Math.abs(ddy)) consider(tx + Math.sign(ddx), ty);
    if (ddy !== 0 && Math.abs(ddy) * 2 >= Math.abs(ddx)) consider(tx, ty + Math.sign(ddy));
    void map;
    return best ? [best[0], best[1], bc] : null;
  }

  async _evShot(ev) {
    const st = this.state, sfx = this.hooks.sfx;
    const s = st.units[ev.from], t = st.units[ev.to];
    const ds = this.disp[ev.from], dt = this.disp[ev.to];
    const vs = this.views[ev.from], vt = this.views[ev.to];
    const sVis = s.team === this.myTeam || this.visibleToMe(ds.x, ds.y);
    const tVis = t.team === this.myTeam || this.visibleToMe(dt.x, dt.y);
    const hitting = ev.result !== 'miss';
    if (hitting) dt.hp -= ev.dmg;
    if (!sVis && !tVis) {
      // Heard, not seen: a rough ping where the shot came from.
      const px = Math.round(ds.x / 3) * 3 + 1, py = Math.round(ds.y / 3) * 3 + 1;
      this._ping(px, py);
      sfx?.shot(1, this._weaponOf(s));
      this.hooks.onFeed?.(`Gunfire to the ${compass(this.myRef(), px, py)}`);
      this._drawLabel(t);
      return;
    }
    const kill = hitting && dt.hp <= 0 && dt.alive;
    const weapon = this._weaponOf(s);
    const shotgun = s.cls === 'breacher' || weapon === 'Shotgun';
    const marks = s.cls === 'marksman';
    vs.root.visible = true;
    vs.setHunker(false);
    this._face(ev.from, dt.x, dt.y);
    const A = vs.root.position, B = vt.root.position;
    const cam = this._actionCam(A, B, kill);
    vs.aimGoal = 1;
    await this._wait(cam ? (kill ? 420 : 300) : 180);
    if (ev.ability === 'aimed') {
      vs.muzzle.getWorldPosition(_v1);
      this.fx.add.spawn(_v1.x, _v1.y, _v1.z, 0, 0, 0, 0.45, 0.1, 0.9, 5, 5, 5, 1, 0, 0, 0, 2.5);
      this._text(ds.x, ds.y, 'AIMED SHOT', TEXT.info, 0.75, 1.55);
      await this._wait(320);
    }
    if (ev.flank && tVis) this._text(dt.x, dt.y, 'FLANKED', TEXT.info, 0.7, 1.9);
    if (kill && cam) this.slowGoal = 0.32;
    sfx?.shot(this._far(ds.x, ds.y), weapon);
    vs.muzzle.getWorldPosition(_v1);
    const mx = _v1.x, my = _v1.y, mz = _v1.z;
    const dirx = B.x - A.x, dirz = B.z - A.z, dl = Math.hypot(dirx, dirz) || 1;
    const nx = dirx / dl, nz = dirz / dl;
    this.fx.muzzle(mx, my, mz, nx, nz, shotgun ? 1.4 : marks ? 1.2 : 1);
    vs.doRecoil(shotgun ? 1.3 : 1);
    const col = new THREE.Color(s.team === this.myTeam ? TEAM.amber : TEAM.magenta);
    // impact point
    let ix = B.x, iy = B.y + 0.6 - vt.hunk * 0.15, iz = B.z;
    let missKind = null;
    if (!hitting) {
      const ct = ev.cover > 0 ? this._coverTileBetween(dt.x, dt.y, ds.x, ds.y) : null;
      if (ct && Math.random() < 0.75) {
        ix = this.wx(ct[0]) - nx * 0.3; iz = this.wz(ct[1]) - nz * 0.3; iy = ct[2] === 2 ? 0.55 + Math.random() * 0.4 : 0.3 + Math.random() * 0.15;
        missKind = 'cover';
      } else {
        const side = Math.random() < 0.5 ? -1 : 1;
        ix = B.x - nz * side * 0.55 + nx * 1.6; iz = B.z + nx * side * 0.55 + nz * 1.6; iy = 0.05;
        missKind = 'ground';
      }
    }
    const width = marks ? 0.05 : shotgun ? 0.025 : 0.035;
    this.fx.tracer(mx, my, mz, ix, iy, iz, col, width * (ev.ability === 'aimed' ? 1.6 : 1));
    if (shotgun) {
      for (let i = 0; i < 4; i++) {
        const j = (Math.random() - 0.5) * 0.5;
        this.fx.tracer(mx, my, mz, ix - nz * j, iy + (Math.random() - 0.5) * 0.3, iz + nx * j, col, 0.018, 0.12);
      }
    }
    await this._wait(Math.min(160, 30 + dl * 9));
    if (hitting) {
      const graze = ev.result === 'graze';
      sfx?.hit(graze);
      this.fx.hitFlash(ix, iy, iz, graze ? 0.6 : 1);
      vt.doFlinch(graze ? 0.55 : 1);
      if (tVis) this._text(dt.x, dt.y, (graze ? 'GRAZE ' : '') + '-' + ev.dmg, graze ? TEXT.graze : TEXT.hit, graze ? 0.85 : kill ? 1.35 : 1.15);
      if (kill) { this.hitStop = cam ? 0.14 : 0.07; this.fx.shake = Math.max(this.fx.shake, 0.35); }
    } else {
      sfx?.miss();
      if (missKind === 'cover') {
        this.fx.sparks(ix, iy, iz, 12, 5, 3.6, 2, 3.5);
        this.fx.dust(ix, iz, 4, 0.72, 0.7, 0.64, iy - 0.1, 0.7);
        this.fx.debrisBurst(ix, iy, iz, [0x9b9a90, 0xcbbd9c], 4, 0.5);
      } else if (this._floodedWorld(ix, iz)) this.fx.splash(ix, iz, 0.6);
      else this.fx.dust(ix, iz, 6, 0.78, 0.7, 0.56, 0.05, 0.8);
      if (tVis) this._text(dt.x, dt.y, 'MISS', TEXT.miss, 0.9);
    }
    this._drawLabel(t);
    this._drawLabel(s);
    await this._wait(kill ? 200 : 380);
    vs.aimGoal = 0;
    if (!kill && cam) { this._camPop(); this.slowGoal = 1; }
    if (kill && cam) this._killCam = true;
    if (!sVis) this._syncUnitVisibility(s);
  }

  async _evDeath(ev) {
    const st = this.state, sfx = this.hooks.sfx;
    const u = st.units[ev.id];
    const v = this.views[ev.id];
    const d = this.disp[ev.id];
    const wasVisible = v.root.visible;
    d.hp = 0;
    this._drawLabel(u);
    if (wasVisible && !(this.speed > 3)) {
      sfx?.death();
      if (ev.by !== null && ev.by !== undefined && this.views[ev.by]) {
        // fall away from the killer
        const k = this.views[ev.by].root.position;
        v.faceTo(k.x, k.z, true);
      }
      v.die();
      v.corpse = true;
      if (this._killCam) this.slowGoal = 0.45;
      const p = v.root.position;
      await this._wait(380);
      if (this._flooded(d.x, d.y)) this.fx.splash(p.x, p.z, 1.3); else this.fx.dust(p.x, p.z, 10, 0.78, 0.7, 0.56, 0.05, 1.4);
      await this._wait(this._killCam ? 520 : 320);
      // the corpse lingers, then sinks away
      this.fx.timed(5, (t) => {
        if (t > 0.75) v.root.position.y = -((t - 0.75) / 0.25) * 0.5;
        if (t >= 1) { v.corpse = false; v.root.visible = false; }
      });
    }
    if (this._killCam) {
      this._killCam = false;
      this.slowGoal = 1;
      this._camPop();
    }
    d.alive = false;
    if (!wasVisible) v.root.visible = false;
    if (u.team === this.myTeam) this.refreshFog();
  }

  async _evGrenade(ev) {
    const st = this.state, sfx = this.hooks.sfx;
    const u = st.units[ev.id];
    const v = this.views[ev.id];
    const d = this.disp[ev.id];
    const sVis = u.team === this.myTeam || this.visibleToMe(d.x, d.y);
    const tVis = this.visibleToMe(ev.x, ev.y);
    this._blast = { x: this.wx(ev.x), z: this.wz(ev.y) };
    if (!sVis && !tVis) {
      sfx?.explosion(1);
      this._ping(ev.x, ev.y);
      this.hooks.onFeed?.(`Explosion to the ${compass(this.myRef(), ev.x, ev.y)}`);
      return;
    }
    const tx = this.wx(ev.x), tz = this.wz(ev.y);
    const cam = this.cinematic && !this._fast;
    if (cam) { this._camPush(); const a = v.root.position; this.goal.set((a.x + tx) / 2, 0, (a.z + tz) / 2); this.followId = null; }
    if (sVis) { this._face(ev.id, ev.x, ev.y); v.setHunker(false); }
    await this._wait(200);
    sfx?.grenadeThrow?.();
    if (sVis) v.doRecoil(1.4);
    const a = v.root.position;
    const ax = a.x, ay = a.y + 0.95, az = a.z;
    const dist = Math.hypot(tx - ax, tz - az);
    const peak = 1.6 + dist * 0.28;
    const nade = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 0), new THREE.MeshStandardMaterial({ color: 0x3b4436, roughness: 0.6 }));
    nade.castShadow = true;
    this.world.add(nade);
    const dur = 420 + dist * 45;
    await this._anim(dur, (t) => {
      const x = lerp(ax, tx, t), z = lerp(az, tz, t), y = lerp(ay, 0.12, t) + Math.sin(t * Math.PI) * peak;
      nade.position.set(x, y, z);
      nade.rotation.set(t * 14, t * 9, 0);
      if (Math.random() < 0.6) this.fx.alpha.spawn(x, y, z, 0, 0.2, 0, 0.5, 0.06, 0.18, 0.75, 0.74, 0.7, 0.4, 2, 0, 0, 1.2);
      if (Math.random() < 0.5) this.fx.add.spawn(x, y, z, 0, 0, 0, 0.12, 0.08, 0.02, 5, 3, 1, 1, 0, 0, 0, 1);
    });
    this.world.remove(nade); nade.geometry.dispose(); nade.material.dispose();
    sfx?.explosion(this._far(ev.x, ev.y));
    this.fx.explosion(tx, tz, ev.radius || 1.5, this._flooded(ev.x, ev.y));
    this.hitStop = 0.05;
    await this._wait(380);
    if (cam) { this._grenadeCam = true; this._endBlastCamSoon(); }
  }

  async _evDamage(ev) {
    const st = this.state;
    const u = st.units[ev.id], v = this.views[ev.id], d = this.disp[ev.id];
    this._hp(ev.id, -ev.dmg);
    if (v.root.visible) {
      v.doFlinch(1);
      const p = v.root.position;
      this.fx.hitFlash(p.x, 0.6, p.z, 0.8);
      if (this._blast && ev.source === 'explosion') {
        const bx = p.x - this._blast.x, bz = p.z - this._blast.z, L = Math.hypot(bx, bz);
        if (L > 0.05) v.faceTo(p.x - bx, p.z - bz);
      }
      this._text(d.x, d.y, '-' + ev.dmg, TEXT.hit, 1.15);
      await this._wait(160);
    }
    void u;
    this._endBlastCamSoon();
  }

  async _evCover(ev) {
    const { x, y, from, to } = ev;
    const k = y * this.S + x;
    const prev = this.props.cover[k];
    const fromC = from ?? prev;
    const changed = this.props.setCover(x, y, to);
    if (changed && this.visibleToMe(x, y) && !(this.speed > 3)) {
      const wx = this.wx(x), wz = this.wz(y);
      const cols = this.props.debrisColors(k, fromC);
      const big = fromC === 2;
      this.fx.debrisBurst(wx, big ? 0.6 : 0.3, wz, cols, big ? 22 : 14, big ? 1.1 : 0.8);
      this.fx.dust(wx, wz, big ? 14 : 9, 0.72, 0.68, 0.6, 0.2, big ? 2 : 1.4);
      this.fx.shake = Math.max(this.fx.shake, big ? 0.35 : 0.2);
      await this._wait(140);
    }
    this._endBlastCamSoon();
  }

  _endBlastCamSoon() {
    if (!this._grenadeCam) return;
    clearTimeout(this._gcT);
    this._gcT = setTimeout(() => { if (this._grenadeCam) { this._grenadeCam = false; this._camPop(); } }, 700 / this.speed);
  }

  async _evBreach(ev) {
    const st = this.state, sfx = this.hooks.sfx;
    const u = st.units[ev.id], v = this.views[ev.id], d = this.disp[ev.id];
    const vis = u.team === this.myTeam || this.visibleToMe(d.x, d.y) || this.visibleToMe(ev.x, ev.y);
    this._blast = { x: this.wx(ev.x), z: this.wz(ev.y) };
    if (!vis) { sfx?.breach?.(); this._ping(ev.x, ev.y); this.hooks.onFeed?.(`Breach charge to the ${compass(this.myRef(), ev.x, ev.y)}`); return; }
    this._face(ev.id, ev.x, ev.y);
    v.setHunker(false);
    v.root.visible = true;
    const p = v.root.position, ox = p.x, oz = p.z;
    const tx = this.wx(ev.x), tz = this.wz(ev.y);
    const dx = (tx - ox), dz = (tz - oz);
    // wind up, then shield-bash lunge
    v.hunkGoal = 0.6;
    await this._wait(220);
    v.hunkGoal = 0;
    await this._anim(120, (t) => { p.x = ox + dx * 0.32 * easeOutCubic(t); p.z = oz + dz * 0.32 * easeOutCubic(t); });
    sfx?.breach?.();
    this.fx.explosion(lerp(ox, tx, 0.7), lerp(oz, tz, 0.7), 0.9, this._flooded(ev.x, ev.y));
    this.fx.flashLight(tx, 0.8, tz, 0xfff0d0, 40, 0.25, 6);
    v.doRecoil(1.5);
    this.hitStop = 0.06;
    await this._anim(260, (t) => { p.x = ox + dx * 0.32 * (1 - easeOutCubic(t)); p.z = oz + dz * 0.32 * (1 - easeOutCubic(t)); });
    p.x = ox; p.z = oz;
  }

  async _evSupply(ev) {
    const c = ev.crate;
    if (!c) return;
    const g = this._addCrate({ ...c, type: c.type || 'cache' });
    if (!g) return;
    const sfx = this.hooks.sfx;
    const fx = this.wx(c.x), fz = this.wz(c.y), gy = this._groundY(c.x, c.y);
    this.hooks.onFeed?.(`Supply drop to the ${compass(this.myRef(), c.x, c.y)}`);
    if (this._fast) return;
    const cam = this.cinematic;
    if (cam) { this._camPush(); this.goal.set(fx, 0, fz); this.followId = null; }
    const chute = makeChute();
    g.add(chute);
    const H = 13;
    g.position.y = gy + H;
    sfx?.stinger?.('round');
    await this._anim(1500, (t) => {
      const e = t * t * (0.4 + 0.6 * t);
      g.position.y = gy + H * (1 - e);
      g.rotation.y = Math.sin(t * 6) * 0.2;
      g.rotation.z = Math.sin(t * 9) * 0.06 * (1 - t);
      if (Math.random() < 0.5) this.fx.alpha.spawn(fx, g.position.y + 0.3, fz, 0, 0.4, 0, 1.2, 0.12, 0.4, 0.85, 0.88, 0.86, 0.35, 1, 0, 0, 1.2);
    });
    g.position.y = gy; g.rotation.set(0, 0, 0);
    this.fx.dust(fx, fz, 18, 0.78, 0.72, 0.6, 0.05, 2.4);
    this.fx.ring(fx, 0.08, fz, 0.3, 2.6, 0xeaf3ef, 0.6, 1.2);
    this.fx.ring(fx, 0.09, fz, 0.2, 1.8, TEAM.cyan, 0.7, 1.4);
    if (this._flooded(c.x, c.y)) this.fx.splash(fx, fz, 2);
    this.fx.shake = Math.max(this.fx.shake, 0.45);
    this.fx.flashLight(fx, 1, fz, TEAM.cyan, 20, 0.4, 6);
    sfx?.explosion?.(this._far(c.x, c.y));
    // the chute collapses and drifts off
    const cm = chute.material;
    this.fx.timed(1.4, (t) => {
      chute.position.set(t * 0.8, -t * 1.2, t * 0.4);
      chute.rotation.z = t * 0.9;
      cm.opacity = 1 - t;
      if (t >= 1) { g.remove(chute); cm.dispose(); }
    });
    await this._wait(650);
    if (cam) this._camPop();
  }
}

void WATER_Y;
