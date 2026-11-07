// Tidefall renderer: stylized 2.5D isometric diorama (Three.js, orthographic
// camera that snaps in 90° steps). Reads sim state and keeps its own
// "displayed" copy (positions, HP, cover, downed) so animation and fog of war
// stay in sync with what the player has actually been shown.
//
// Visual stack: ACES tone mapping, warm key light with soft shadows,
// hemisphere fill, a lighting/weather arc driven by the tide stage (golden
// morning → overcast → storm front → night storm), drifting cloud shadows,
// stylized SDF water, merged low-poly cover props + open-ground clutter,
// animated soldiers, gulls, pooled particles, bloom + grade/vignette (+ tilt
// shift depth of field for the title-screen showcase) post.
//
// Lifecycle rules (2.0 audit):
//  - every event handler captures `gen` and bails after each await if a new
//    game / snap happened (setGame, syncFromState bump it);
//  - pending animations are always resolved (flushed) instead of dropped, and
//    resolve immediately while the tab is hidden, so playEvent never hangs;
//  - camera "holds" (target framing, action cams) are tagged stack entries
//    with an expiry, released by tag, so follow / cinematic / user pan /
//    setSelectedTarget never fight or leave the camera (or slow-mo) stuck;
//  - no setTimeout: all timing runs on the render clock.

import * as THREE from 'three';
// Namespace imports: a missing export (sim landing mid-way) must never break module linking.
import * as Rules from '../sim/rules.js';
import * as SimC from '../sim/constants.js';
import { squadColor, squadColorHex } from '../shared/colors.js';
import { randomLoadout, sanitizeLoadout } from '../shared/cosmetics.js';
import { TEAM, makeMood, moodAt } from './gfx/palette.js';
import { stageLook, buildKelp, buildSpill, buildStageScenery } from './gfx/stages.js';
import { CosmeticFx } from './gfx/cosmeticfx.js';
import { renderPreview as _renderPreview, stopPreview as _stopPreview, stopAllPreviews } from './gfx/preview.js';
import { rng as makeRng } from './gfx/util.js';
import { WorldFields } from './gfx/fields.js';
import { classifyTiles, buildTerrain, tileTop } from './gfx/terrain.js';
import { buildWater } from './gfx/water.js';
import { PropField, buildDecor } from './gfx/props.js';
import { SoldierView, updateUnitShared, XRAY_LAYER } from './gfx/units.js';
import { Fx } from './gfx/fx.js';
import { Overlays, Label } from './gfx/overlays.js';
import { makeCrate, makeChute, updatePickupShared, buildScenery } from './gfx/pickups.js';
import { Ambient } from './gfx/ambient.js';
import { loadPostModules, createComposer } from './gfx/post.js';
import { clamp, damp, compass, easeInOutCubic, easeOutCubic, lerp } from './gfx/util.js';

const VIEW_MIN = 5.5, VIEW_MAX = 34;
const ELEV = 0.68; // ~39°
const CAM_D = 60;
const TEXT = { hit: '#ff6a55', graze: '#ffd9a0', miss: '#c9d2d0', heal: '#7fe9ff', tide: '#6fd6e8', info: '#efe7d4', signal: '#7fe9ff', kill: '#ffffff', down: '#efe7d4' };
const HOLD = { select: Infinity, shot: 3, kill: 6, blast: 3.2, supply: 4.5, scan: 3.6, revive: 2.5 };

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _ndc = new THREE.Vector2();
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _col = new THREE.Color();
const _lv = new THREE.Vector3(), _lm = new THREE.Matrix4(), _li = new THREE.Matrix4();

/** Shop / locker previews (one shared offscreen WebGL context for every card). */
export const renderPreview = _renderPreview;
export const stopPreview = _stopPreview;
export { stopAllPreviews };

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

    this.speed = 1;
    this.cinematic = true;
    this.showcase = false;
    this.timeScale = 1; this.slowGoal = 1; this.hitStop = 0;
    this.time = 0; this.realTime = 0;
    this.anims = [];
    this.gen = 0;
    this.world = null;
    this.state = null;
    this.highlight = null;
    this.unitObjs = [];
    this.views = [];
    this.storm = 0; this.stormGoal = 0;
    this.lightningT = 8; this._flash = 0; this._flash2 = -1;
    this.reveals = new Map(); // team -> Set(unitIds)
    this.dsmokes = []; // displayed smoke clouds (sim format), for visibility
    this.dflares = []; // displayed night flares [{id, team}]
    this.beacons = new Map(); // unit id -> flare beacon objects
    this.coverFade = 0; this.coverFadeGoal = 0;
    this._dropIn = null;
    this.look = stageLook('harbor');
    this.cos = [];
    this._hidden = typeof document !== 'undefined' && document.hidden;

    this.raycaster = new THREE.Raycaster();
    this._posOf = (id) => (this._tileBadges?.has(id) ? this._tileBadges.get(id) : this.isUnitVisible(id) ? this.views[id].root.position : null);
    this._posOfAny = (id) => (this.views[id] && this.views[id].root.visible && this.disp[id]?.alive ? this.views[id].root.position : null);
    this.hoverPx = null; this.hoverTile = -1;

    this._initQuality();
    this._setupInput();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      this._hidden = document.hidden;
      if (this._hidden) this._flushAnims();
      this._last = performance.now();
    });
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
    // 3.0 (44×44 maps): phones only start on high when they are clearly strong.
    const auto = weakGpu || mem <= 3 || (this.mobile && (cores <= 6 || mem < 6)) ? 'low' : 'high';
    this.qualityPinned = q === 'low' || q === 'high';
    // prCap: pixel-ratio ceiling. Auto steps: high@2 → high@1.25 → low@1.25 → low@1 → low@0.8
    this.perf = { frames: 0, time: 0, bad: 0, warm: 0, prCap: this.mobile ? 1.5 : 2, lowCap: 1.25 };
    this.autoQuality = auto;
    this.setQuality(this.qualityPinned ? q : auto, true);
  }

  /** 'high' | 'low'. Manual calls pin the quality (auto-downgrade stops). */
  setQuality(q, _auto = false) {
    if (!_auto) { this.qualityPinned = true; this.perf.prCap = this.mobile ? 1.5 : 2; this.perf.lowCap = 1.25; }
    q = q === 'low' ? 'low' : 'high';
    this.quality = q;
    const high = q === 'high';
    const dpr = window.devicePixelRatio || 1;
    this.pixelRatio = Math.min(dpr, high ? this.perf.prCap : this.perf.lowCap);
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
    this.ambient?.setQuality(high);
    this.sun.shadow.camera.userData.ext = 0; // refit
    if (high) {
      const want = (this._postReq = (this._postReq || 0) + 1);
      loadPostModules().then((M) => {
        if (!M || this.quality !== 'high' || want !== this._postReq) return;
        if (!this.post) this.post = createComposer(M, this.gl, this.scene, this.camera, { samples: this.mobile ? 2 : 4 });
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
    this.perf.bad = 0; this.perf.warm = 0; this.perf.prCap = this.mobile ? 1.5 : 2; this.perf.lowCap = 1.25;
    this.setQuality(this.autoQuality, true);
  }

  /** Camera yaw around the vertical axis (radians), for the minimap. */
  cameraYaw() { return Math.PI / 4 + this.camAngle * (Math.PI / 2); }

  _perfTick(realDt) {
    if (this.qualityPinned || !this.state || this._hidden) return;
    const p = this.perf;
    p.warm += realDt;
    if (p.warm < 2) return;
    p.frames++; p.time += realDt;
    if (p.time < 2) return;
    const fps = p.frames / p.time;
    p.frames = 0; p.time = 0;
    // tighter in 3.0: bigger maps, so step down sooner (two 2 s windows under 48 fps)
    if (fps < 48) p.bad++; else p.bad = 0;
    if (p.bad < 2) return;
    p.bad = 0; p.warm = 0;
    if (this.quality === 'high') {
      if (this.pixelRatio > 1.25) { p.prCap = 1.25; this.setQuality('high', true); } else this.setQuality('low', true);
    } else if (fps < 36 && p.lowCap > 0.75) {
      p.lowCap = p.lowCap > 1 ? 1 : p.lowCap > 0.85 ? 0.85 : 0.75;
      this.setQuality('low', true);
    }
  }

  setCinematic(on) { this.cinematic = !!on; }
  get _cine() { return this.cinematic && !this.showcase && !this._fast; }

  // ---------- setup ----------

  /**
   * opts.cosmetics: { [unitId]: { skin, killFx, dropIn } } (UI passes the player's
   * loadout; every other unit gets a random, seed-stable loadout).
   */
  setGame(state, myTeam, opts = {}) {
    if (this.world) this._teardown();
    this.gen++;
    this._flushAnims();
    this._endDropIn(true);
    this.state = state;
    this.myTeam = myTeam;
    this.spectator = myTeam < 0;
    this.highlight = null;
    this.followId = null;
    this.camStack = [];
    this.timeScale = this.slowGoal = 1; this.hitStop = 0;
    this.reveals = new Map();
    this.hoverTile = -1;
    this._flash = 0; this._flash2 = -1; this.lightningT = 8;
    const S = (this.S = state.map.size);
    const seed = state.seed || 1;
    this.look = stageLook(state.stage);
    this.dzone = { ...state.zone };
    this.r0 = state.zone.r;
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.fields = new WorldFields(S);
    this.fields.uniforms.uFogDark.value = this.look.fogDark;
    const wx = (x) => this.wx(x), wz = (y) => this.wz(y);

    this.cls = classifyTiles(state.map, seed, this.look);
    this.terrain = buildTerrain(state.map, this.fields, this.cls, wx, wz, this.look);
    this.world.add(this.terrain.group);
    this.water = buildWater(this.fields, S, this.quality === 'high' ? 160 : 90, this.look);
    this.world.add(this.water.mesh);
    this.props = new PropField(state.map, this.cls, this.fields, wx, wz, seed, this.look);
    this.world.add(this.props.group);
    this.coverFade = this.coverFadeGoal = 0;
    this.decor = buildDecor(state.map, this.cls, this.fields, wx, wz, seed);
    if (this.decor) this.world.add(this.decor);
    this.scenery = buildScenery(S, seed, this.fields);
    this.world.add(this.scenery);
    this.kelp = buildKelp(state.map, this.cls, this.fields, wx, wz, (x, y) => this._groundY(x, y), seed);
    if (this.kelp) this.world.add(this.kelp.mesh);
    this.spill = buildSpill(this.props.spill);
    if (this.spill) this.world.add(this.spill);
    this.stageScenery = buildStageScenery(this.look, S, seed, this.fields);
    if (this.stageScenery) this.world.add(this.stageScenery.group);
    this.ambient = new Ambient(this.world, S, seed, this.quality === 'high', this.look);

    this.fx = new Fx(this.world, this.overlay, { scale: this.quality === 'high' ? 1 : 0.6 });
    this.fx.floodedAt = (x, z) => this._floodedWorld(x, z);
    this.cfx = new CosmeticFx(this.fx, this.world, { flash: (k) => { this._flash = Math.max(this._flash, k); } });
    this.ov = new Overlays(this.world, this.overlay, wx, wz, S);

    // shadow camera covers the whole map
    const sc = this.sun.shadow.camera;
    const ext = S * 0.76;
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 150;
    sc.userData.ext = 0; // refit to the view every frame (_fitShadow)
    sc.updateProjectionMatrix();
    this.sun.target.position.set(0, 0, 0);
    this._applySun();

    // crates
    this.crateMeshes = new Map();
    this.crateList = [];
    for (const c of state.crates) if (!c.taken) this._addCrate(c);

    // units
    this.disp = state.units.map((u) => ({ x: u.x, y: u.y, alive: u.alive, hp: u.hp, downed: !!u.downed, bleed: u.bleed || 0 }));
    // cosmetics: given loadouts (the player's), random but seed-stable for everyone else
    const given = opts.cosmetics || {};
    const cr = makeRng((seed ^ 0xc05e71c5) >>> 0);
    this.cos = state.units.map((u) => {
      const rnd = randomLoadout(cr);
      return given[u.id] ? sanitizeLoadout(given[u.id]) : u.isPlayer ? sanitizeLoadout(null) : rnd;
    });
    this.dsmokes = (state.smokes || []).map((c) => ({ ...c }));
    this.dflares = (state.flares || []).map((f) => ({ ...f }));
    this.views = state.units.map((u) => {
      const v = new SoldierView(u, { color: squadColorHex(u.team, myTeam), skin: this.cos[u.id].skin });
      v.root.position.set(this.wx(u.x), this._groundY(u.x, u.y), this.wz(u.y));
      v.root.rotation.y = Math.atan2(this.wx(S / 2) - v.root.position.x, this.wz(S / 2) - v.root.position.z);
      if (u.hunkered) v.hunk = 1;
      if (u.downed) v.setDowned(true, u.bleed || 0);
      if (!u.alive) { v.die(); v.deathT = 5; v.corpse = false; v.root.visible = false; }
      this.world.add(v.root);
      return v;
    });
    for (const u of state.units) if (u.alive && u.overwatch) this._setOverwatchFacing(u.id, true);
    this.unitObjs = this.views.map((v) => ({ g: v.root })); // legacy shim (minimap, main.js)
    this.labels = state.units.map(() => new Label(this.overlay));

    // "you" marker
    const mg = new THREE.ConeGeometry(0.15, 0.3, 4);
    mg.rotateX(Math.PI);
    this.marker = new THREE.Mesh(mg, new THREE.MeshBasicMaterial({ color: new THREE.Color(TEAM.amber).multiplyScalar(1.5), toneMapped: false }));
    this.marker.renderOrder = 21;
    this.overlay.add(this.marker);

    this.selTarget = null; this.targets = null; this.reviveIds = null;
    this._vsObj = null;
    this.beacons = new Map();
    this._syncSmokes();
    this._syncFlares();
    this._syncReveals();
    this._updateZone(true);
    this.storm = this.stormGoal;
    this.refreshFog(true);
    for (const u of state.units) this._drawLabel(u);
    const me = state.units.find((u) => u.isPlayer) || state.units.find((u) => u.alive) || state.units[0];
    this.focus(me.x, me.y, true);
    this.view = this.viewGoal = this.aspect < 1 ? 13 : 14;
    this.perf.warm = 0;
    if (this.showcase) this._enterShowcase(true);
  }

  _teardown() {
    this.fx?.clear();
    this.cfx?.clear();
    this.scene.remove(this.world);
    for (const v of this.views || []) v.dispose();
    const seen = new Set();
    const disposeMat = (m) => {
      if (!m || seen.has(m) || m.userData?.shared) return;
      seen.add(m);
      for (const k of ['map', 'alphaMap']) if (m[k] && !m[k].userData?.shared) m[k].dispose();
      m.dispose();
    };
    const sweep = (root) => root.traverse((o) => {
      if (o.geometry && !o.geometry.userData?.shared && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(disposeMat);
    });
    sweep(this.world);
    sweep(this.overlay);
    for (const l of this.labels || []) l.tex.dispose();
    this.overlay.clear();
    this.props?.dispose();
    this.fields?.dispose?.();
    this.ambient = null;
    this.kelp = null; this.spill = null; this.stageScenery = null;
    this.beacons = new Map();
    this.world = null;
  }

  wx(x) { return x - this.S / 2 + 0.5; }
  wz(y) { return y - this.S / 2 + 0.5; }
  _groundY(x, y) { return tileTop(this.cls.type[y * this.S + x]); }
  /** Squad colour (#rrggbb) of a team as this player sees it. */
  teamColor(team) { return squadColor(team, this.myTeam); }
  _floodedWorld(px, pz) {
    const x = Math.floor(px + this.S / 2), y = Math.floor(pz + this.S / 2);
    if (x < 0 || y < 0 || x >= this.S || y >= this.S) return true;
    return !!this.fields.flooded[y * this.S + x];
  }
  _flooded(x, y) { return !!this.fields.flooded[y * this.S + x]; }

  _addCrate(c, pop = false) {
    if (this.crateMeshes.has(c.id)) return this.crateMeshes.get(c.id);
    const g = makeCrate(c.type);
    g.position.set(this.wx(c.x), this._groundY(c.x, c.y), this.wz(c.y));
    this.world.add(g);
    this.crateMeshes.set(c.id, g);
    this.crateList.push(g);
    if (pop) {
      g.scale.setScalar(0.01);
      this.fx.timed(0.45, (t) => g.scale.setScalar(Math.max(0.01, 1 + Math.sin(t * Math.PI) * 0.25 * (1 - t) - (1 - t) * (1 - t))));
    }
    return g;
  }
  _removeCrate(id) {
    const g = this.crateMeshes.get(id);
    if (!g) return;
    this.world.remove(g); this.crateMeshes.delete(id);
    const i = this.crateList.indexOf(g); if (i >= 0) this.crateList.splice(i, 1);
    if (g.userData.chute) { g.userData.chute.material.dispose(); g.userData.chute = null; }
  }

  // ---------- labels ----------

  _drawLabel(u) {
    const l = this.labels?.[u.id];
    if (!l) return;
    const d = this.disp[u.id];
    l.draw(u, u.team === this.myTeam, Math.max(0, d.hp), {
      col: this.teamColor(u.team),
      ow: !!u.overwatch && !d.downed, hk: !!u.hunkered && !d.downed, lw: !!u.isLoneWolf,
      dn: d.downed ? d.bleed : null, dnMax: 2,
    });
  }

  // ---------- fog / highlights / zone ----------

  // Visibility runs the sim's own rules (rules.teamSeesUnit / canSeeTile: sight,
  // night, smoke, kelp, scans, flares) against a *displayed* view of the state:
  // unit positions, cover, smoke clouds, reveals and flares as the player has
  // been shown them so far, so fog never leaks moves that haven't played yet.

  /** Proxy state for the sim's visibility helpers (prototype-chained to the real state). */
  _vs() {
    const st = this.state;
    let o = this._vsObj;
    if (!o || o.__src !== st) {
      o = Object.create(st);
      o.__src = st;
      o.map = Object.create(st.map);
      o.units = st.units.map((u) => Object.create(u));
      this._vsObj = o;
    }
    o.map.cover = this.props.cover;
    o.map.explosive = this.props.explosive;
    for (let i = 0; i < o.units.length; i++) {
      const pu = o.units[i], d = this.disp[i];
      pu.x = d.x; pu.y = d.y; pu.alive = d.alive; pu.downed = d.downed;
    }
    o.smokes = this.dsmokes;
    o.flares = this.dflares;
    const rv = [];
    for (const [team, ids] of this.reveals) rv.push({ team, ids: [...ids] });
    o.reveals = rv;
    return o;
  }

  _sight() { return Rules.sightOf ? Rules.sightOf(this.state.map) : SimC.SIGHT; }

  visibleToMe(x, y) {
    if (this.spectator) return true;
    if (!this.state) return false;
    return Rules.teamSeesTile(this._vs(), this.myTeam, x, y);
  }

  /** Does `team` see tile (x,y) with displayed positions (for facing logic). */
  _teamSees(team, x, y) { return Rules.teamSeesTile(this._vs(), team, x, y); }

  /** Would my squad see unit `id` right now (displayed state)? */
  _unitSeen(id, vs = this._vs()) {
    const u = this.state.units[id];
    if (this.spectator || u.team === this.myTeam) return true;
    const d = this.disp[id];
    if (!d.alive) return this.fogMask?.[d.y * this.S + d.x] === 1;
    return Rules.teamSeesUnit(vs, this.myTeam, vs.units[id]);
  }

  /** _unitSeen with the unit standing at (x,y). */
  _seenAt(id, x, y) {
    const d = this.disp[id], ox = d.x, oy = d.y;
    d.x = x; d.y = y;
    const r = this._unitSeen(id);
    d.x = ox; d.y = oy;
    return r;
  }

  isUnitVisible(id) {
    const v = this.views?.[id];
    return !!v && v.root.visible && !!this.disp?.[id]?.alive;
  }

  setSpectator(on) { this.spectator = !!on; if (this.state) this.refreshFog(); }

  refreshFog(instant = false) {
    const S = this.S, st = this.state;
    if (!this.spectator && !st.units.some((u) => u.team === this.myTeam && this.disp[u.id].alive)) this.spectator = true;
    const fog = (this.fogMask = new Uint8Array(S * S));
    const vs = this._vs();
    if (this.spectator) fog.fill(1);
    else {
      const R = Math.ceil(this._sight());
      for (const u of st.units) {
        if (u.team !== this.myTeam) continue;
        const d = this.disp[u.id];
        if (!d.alive || d.downed) continue; // downed units don't spot
        for (let y = Math.max(0, d.y - R); y <= Math.min(S - 1, d.y + R); y++) {
          for (let x = Math.max(0, d.x - R); x <= Math.min(S - 1, d.x + R); x++) {
            const k = y * S + x;
            if (!fog[k] && Rules.canSeeTile(vs.map, d.x, d.y, x, y)) fog[k] = 1;
          }
        }
      }
    }
    this.fields.setFog(fog, instant);
    for (const u of st.units) this._syncUnitVisibility(u, vs);
  }

  /** Re-run unit visibility only (smoke / flare / reveal changes don't move the fog). */
  _refreshUnits() { const vs = this._vs(); for (const u of this.state.units) this._syncUnitVisibility(u, vs); }

  _revealedToMe(id) {
    if (this.spectator) return false;
    const s = this.reveals.get(this.myTeam);
    return !!s && s.has(id);
  }

  _syncUnitVisibility(u, vs) {
    const d = this.disp[u.id];
    const v = this.views[u.id];
    if (this._dropIn && this._dropIn.pending.has(u.id)) return; // still in the air
    const seen = this._unitSeen(u.id, vs);
    v.root.visible = d.alive ? seen : !!v.corpse && seen && !v.derezzed;
    // revealed enemies: magenta X-ray outline
    let rev = false;
    if (d.alive && u.team !== this.myTeam) for (const s of this.reveals.values()) if (s.has(u.id)) { rev = this.spectator || this.reveals.get(this.myTeam) === s; if (rev) break; }
    v.setReveal(rev && v.root.visible);
  }

  setHighlights(map) { this.highlight = map; this.ov?.setHighlights(map); }

  setPathPreview(path, cost = 1) {
    if (!this.ov) return;
    if (!path || path.length < 2) { this.ov.setPath(null); return; }
    const [ex, ey] = path[path.length - 1];
    this.ov.setPath(path, cost, Rules.tileCoverDirs(this.state.map, ex, ey));
  }

  /** {x, y, radius, valid, kind?: 'frag'|'smoke'|'scan'} | null */
  setAoePreview(a) {
    if (!this.ov) return;
    this.ov.setAoe(a || null);
  }

  /** Pulsing revive markers over these (downed) unit ids, or null. */
  setReviveMarkers(ids) {
    this.reviveIds = ids && ids.length ? [...ids] : null;
    this.ov?.setRevive(this.reviveIds);
  }

  /**
   * [{id, chance, selected?}] for units. Tile targets (explosive barrels) may be
   * passed as {id: any non-unit key, x, y, chance}: the badge floats over the tile.
   */
  setTargetMarkers(list) {
    this.targets = list && list.length ? list : null;
    this._tileBadges = new Map();
    if (this.targets && this.state) for (const t of this.targets) {
      if (this.views[t.id] && typeof t.id === 'number') continue;
      if (Number.isFinite(t.x) && Number.isFinite(t.y)) this._tileBadges.set(t.id, new THREE.Vector3(this.wx(t.x), this._groundY(t.x, t.y) - 0.7, this.wz(t.y)));
    }
    this.ov?.setTargets(this.targets && this.targets.map((t) => ({ ...t, sel: t.id === this.selTarget || !!t.selected })));
  }

  setSelectedTarget(id) {
    if (!this.state) return;
    const prev = this.selTarget;
    this.selTarget = id ?? null;
    if (this.selTarget !== null && !this.views[this.selTarget]) this.selTarget = null;
    this.ov?.markSelected(this.selTarget);
    const me = this._activeUnit();
    if (this.selTarget !== null) {
      if (prev === null) this._camPush('select');
      if (me) {
        const mv = this.views[me.id];
        const a = mv.root.position, b = this.views[this.selTarget].root.position;
        // the soldier turns to the target and shoulders the weapon
        mv.faceTo(b.x, b.z); mv.aimGoal = 1; mv.setHunker(false);
        if (!this.showcase) {
          this.goal.set((a.x + b.x) / 2, 0, (a.z + b.z) / 2);
          this.viewGoal = Math.max(8, this._fitView(a, b, 3, 4.5));
          this.followId = null;
        }
      }
    } else if (prev !== null) {
      if (me && this.views[me.id]) { this.views[me.id].aimGoal = 0; this.views[me.id].setHunker(!!me.hunkered); }
      this._camRelease('select');
    }
  }

  _playerUnit() {
    const us = this.state.units;
    for (let i = 0; i < us.length; i++) if (us[i].isPlayer) return us[i];
    return null;
  }

  _activeUnit() {
    if (!this.state) return null;
    const us = this.state.units;
    for (let i = 0; i < us.length; i++) if (us[i].isPlayer && this.disp[i].alive && !this.disp[i].downed) return us[i];
    for (let i = 0; i < us.length; i++) if (us[i].team === this.myTeam && this.disp[i].alive && !this.disp[i].downed) return us[i];
    return null;
  }

  /** Tide from the displayed zone: current ring at (x,y), next ring at (nx,ny) (drifting on Surge Point). */
  _updateZone(instant) {
    const S = this.S, z = this.dzone || this.state.zone;
    const T = this.state.map.terrain;
    // flooded = outside the safe circle, or a shallow-water tile (terrain 2)
    this.fields.setTide((x, y) => Math.hypot(x - z.x, y - z.y) > z.r || (!!T && T[y * S + x] === 2), instant);
    const nx = z.nx ?? z.x, ny = z.ny ?? z.y;
    const warn = new Uint8Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - z.x, y - z.y);
      warn[y * S + x] = d <= z.r && Math.hypot(x - nx, y - ny) > z.next ? 1 : 0;
    }
    this.fields.setWarn(warn);
    const L = this.look;
    this.stormGoal = L.stormFloor + (1 - L.stormFloor) * clamp((this.r0 - z.r) / Math.max(1, this.r0 * 0.8), 0, 1) * L.stormGain;
    if (!instant) {
      const U = this.fields.uniforms.uTideMix;
      this.fx.timed(1.8, (t) => { U.value = easeInOutCubic(t); });
    }
  }

  _syncSmokes() {
    this.fx.clearAllSmoke();
    this.dsmokes = (this.state.smokes || []).map((c) => ({ ...c }));
    for (const c of this.dsmokes) this.fx.smokeCloud(c.id, this.wx(c.x), this.wz(c.y), c.radius || 1.5);
  }

  _syncFlares() {
    this.dflares = (this.state.flares || []).map((f) => ({ ...f }));
    for (const id of [...this.beacons.keys()]) this._removeBeacon(id);
    for (const f of this.dflares) this._addBeacon(f.id);
  }

  _syncReveals() {
    this.reveals = new Map();
    for (const r of this.state.reveals || []) {
      let s = this.reveals.get(r.team);
      if (!s) this.reveals.set(r.team, (s = new Set()));
      for (const id of r.ids || []) s.add(id);
    }
  }

  /** Snap everything to the sim state (used after fast-forward). */
  syncFromState() {
    if (!this.state) return;
    const st = this.state;
    this.gen++;
    this._flushAnims();
    this.fx.clear();
    this.camStack = [];
    this.timeScale = this.slowGoal = 1; this.hitStop = 0;
    this._endDropIn(true);
    this.cfx.clear();
    this.dzone = { ...st.zone };
    st.units.forEach((u, i) => {
      this.disp[i] = { x: u.x, y: u.y, alive: u.alive, hp: u.hp, downed: !!u.downed, bleed: u.bleed || 0 };
      const v = this.views[i];
      v.revive();
      v.root.position.set(this.wx(u.x), this._groundY(u.x, u.y), this.wz(u.y));
      v.setOverwatch(false); v.coneK = 0; v.cone.visible = false;
      v.setHunker(!!u.hunkered); v.hunk = u.hunkered ? 1 : 0;
      if (u.downed) { v.setDowned(true, u.bleed || 0); v.down = 1; v.pop = 0; }
      if (!u.alive) { v.die(); v.deathT = 5; v.corpse = false; }
    });
    for (const u of st.units) {
      if (u.alive && u.overwatch) this._setOverwatchFacing(u.id, true);
      this._drawLabel(u);
    }
    // crates: rebuild from scratch (drops may have been mid-air with a chute)
    for (const id of [...this.crateMeshes.keys()]) this._removeCrate(id);
    for (const c of st.crates) if (!c.taken) this._addCrate(c);
    const S = this.S;
    for (let k = 0; k < S * S; k++) if (this.props.cover[k] !== st.map.cover[k]) this.props.setCover(k % S, (k / S) | 0, st.map.cover[k]);
    if (st.map.explosive) for (let k = 0; k < S * S; k++) if (this.props.explosive[k] && !st.map.explosive[k]) this.props.detonate(k % S, (k / S) | 0);
    this._syncSmokes();
    this._syncFlares();
    this._syncReveals();
    this._updateZone(true);
    this.refreshFog(true);
    this.ov.setRevive(this.reviveIds);
  }

  // ---------- camera ----------

  focus(x, y, instant = false) {
    this.goal.set(this.wx(x), 0, this.wz(y));
    this.followId = null;
    this.vel.set(0, 0, 0);
    if (instant) this.target.copy(this.goal);
  }
  rotate(dir) { if (!this.showcase) this.camAngleGoal += dir; }
  zoomBy(f) { if (this.showcase) return; this.viewGoal = clamp(this.viewGoal * f, VIEW_MIN, VIEW_MAX); this.userCamT = this.realTime; }
  setFollow(id) { this.followId = id ?? null; if (id !== null && id !== undefined) this.vel.set(0, 0, 0); }

  /** Push a tagged camera hold; it auto-releases after HOLD[tag] seconds. */
  _camPush(tag) {
    this.camStack.push({
      tag, until: performance.now() / 1000 + (HOLD[tag] ?? 3) / Math.max(0.5, Math.min(1, this.speed || 1)),
      goal: this.goal.clone(), view: this.viewGoal, elev: this.elevGoal, follow: this.followId, userT: this.userCamT,
    });
  }
  _restore(s) {
    this.elevGoal = s.elev;
    if (this.userCamT !== s.userT || this.showcase) return; // the player took the camera: leave it
    this.goal.copy(s.goal); this.viewGoal = s.view; this.followId = s.follow;
  }
  /** Release the newest hold with this tag. If holds sit above it, they inherit its saved view. */
  _camRelease(tag) {
    for (let i = this.camStack.length - 1; i >= 0; i--) {
      const s = this.camStack[i];
      if (s.tag !== tag) continue;
      if (i === this.camStack.length - 1) { this.camStack.pop(); this._restore(s); } else {
        const up = this.camStack[i + 1];
        up.goal.copy(s.goal); up.view = s.view; up.elev = s.elev; up.follow = s.follow; up.userT = s.userT;
        this.camStack.splice(i, 1);
      }
      if (tag === 'kill' || tag === 'shot') this.slowGoal = 1;
      return true;
    }
    return false;
  }
  _camExpire() {
    // invariant: slow-mo only lives while an action-cam hold does
    if (this.slowGoal < 1) {
      let held = false;
      for (let i = 0; i < this.camStack.length; i++) { const t = this.camStack[i].tag; if (t === 'kill' || t === 'shot') { held = true; break; } }
      if (!held) this.slowGoal = 1;
    }
    const s = this.camStack[this.camStack.length - 1];
    if (s && performance.now() / 1000 > s.until) {
      this.camStack.pop(); this._restore(s);
      if (s.tag === 'kill' || s.tag === 'shot') this.slowGoal = 1;
    }
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
      this.post.grade.uniforms.uRes.value.set(w * this.pixelRatio, h * this.pixelRatio);
    }
    this._updateCamera(0);
  }

  _updateCamera(dt) {
    if (this.showcase && dt > 0 && this.state) this._showcaseCam(dt);
    else {
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

  // ---------- title-screen showcase ----------

  /** Cinematic slow orbit / dolly over the map for the title screen. */
  setMenuShowcase(on) {
    on = !!on;
    if (on === this.showcase) return;
    this.showcase = on;
    if (on) {
      this._scStash = { goal: this.goal.clone(), view: this.viewGoal, elev: this.elevGoal, ang: this.camAngleGoal, follow: this.followId };
      this._enterShowcase(false);
      if (!this.state) {
        // nothing to show yet: stage our own bot match on a random island
        const want = this.gen;
        import('../sim/game.js').then((G) => {
          if (!this.showcase || this.state || want !== this.gen) return;
          const st = G.createGame({ mode: 'quads', noHuman: true, stage: 'random' });
          this.setGame(st, -1);
        }).catch(() => { /* sim unavailable: ignore */ });
      }
    } else {
      const s = this._scStash;
      this.camAngleGoal = Math.round(this.camAngle);
      this.elevGoal = ELEV;
      if (s) { this.viewGoal = s.view; this.goal.copy(s.goal); }
      this.followId = null;
      this._applySun();
    }
  }

  _enterShowcase(fresh) {
    this.sc = { t: fresh ? 0 : (this.sc?.t || 0), wander: Math.random() * 100 };
    this.camStack = [];
    this.slowGoal = 1;
    if (this.S) { this.goal.set(0, 0, 0); this.target.set(0, 0, 0); }
  }

  _showcaseCam(dt) {
    const sc = this.sc || (this.sc = { t: 0, wander: 0 });
    sc.t += dt;
    const t = sc.t + sc.wander;
    // slow orbit, gentle dolly (zoom breathing), low dramatic elevation
    this.camAngle += dt * 0.035;
    this.camAngleGoal = this.camAngle;
    this.elev = 0.4 + Math.sin(t * 0.11) * 0.07;
    const base = this.aspect < 1 ? 12 : 13;
    this.view = base + Math.sin(t * 0.07) * 2.2;
    // drift toward the action (focus() from the attract loop) with a wander
    const L = this.S * 0.22;
    _v2.set(this.goal.x * 0.65 + Math.sin(t * 0.043) * L * 0.5, 0, this.goal.z * 0.65 + Math.sin(t * 0.031 + 1.3) * L * 0.5);
    this.target.lerp(_v2, damp(0.35, dt));
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
      if (this.showcase) return;
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
      if (this.showcase) return;
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
    if (!this.state || this.showcase) return;
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

  /** Tweens on the (slow-mo aware) game clock. Always resolves. */
  _anim(ms, fn) {
    if (this._hidden || !this.state) { if (fn) fn(1); return Promise.resolve(); }
    return new Promise((resolve) => {
      this.anims.push({ t: 0, dur: Math.max(0.001, ms / 1000 / Math.max(0.05, this.speed || 1)), fn, resolve });
    });
  }
  _wait(ms) { return this._anim(ms, null); }
  _flushAnims() {
    const list = this.anims;
    this.anims = [];
    for (const a of list) { try { if (a.fn) a.fn(1); } catch { /* stale */ } a.resolve(); }
  }
  get _fast() { return this.speed > 1.6; }

  _frame(now) {
    const realDt = Math.min(0.05, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    this.realTime += realDt;
    if (this.hitStop > 0) { this.hitStop -= realDt; this.timeScale = 0.03; } else this.timeScale += (this.slowGoal - this.timeScale) * damp(10, realDt);
    const dt = realDt * this.timeScale;
    this.time += dt;
    const list = this.anims;
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i];
      a.t += dt;
      const t = Math.min(1, a.t / a.dur);
      if (a.fn) a.fn(t);
      if (t >= 1) { list.splice(i, 1); a.resolve(); }
    }
    this._camExpire();
    if (this.state && this.world) {
      this._perfTick(realDt);
      const U = this.fields.uniforms;
      U.uTime.value = this.time;
      this.fields.update(realDt);
      // mood / storm grading
      this.storm += (this.stormGoal - this.storm) * damp(0.8, realDt);
      U.uStorm.value = this.storm;
      moodAt(this.storm, this.mood, this.look.mood);
      if (this.showcase) this._showcaseMood();
      this._lightning(realDt);
      const flash = this._flash;
      this._applySun();
      this.sun.color.copy(this.mood.sun); this.sun.intensity = this.mood.sunI;
      this.hemi.color.copy(this.mood.sky); this.hemi.groundColor.copy(this.mood.ground); this.hemi.intensity = this.mood.hemiI + flash * 3;
      this.scene.fog.color.copy(this.mood.fog);
      this.scene.fog.near = CAM_D - 6 - this.mood.haze * 10; this.scene.fog.far = CAM_D + 60 - this.mood.haze * 30;
      this.scene.background.copy(this.mood.bg);
      this.gl.toneMappingExposure = this.mood.exposure;
      U.uSunCol.value.copy(this.mood.sun);
      U.uSkyCol.value.copy(this.mood.sky);
      U.uCloud.value = this.mood.cloud;
      {
        const k = clamp(0.36 + this.mood.sunI * 0.16 + this.mood.hemiI * 0.12, 0.45, 1.05) + flash * 0.5;
        this.fx.setAmbient(k * (0.92 + this.mood.sun.r * 0.08), k * (0.94 + this.mood.sun.g * 0.06), k);
      }
      const wu = this.water.uniforms;
      wu.uFogColor.value.copy(this.mood.fog);
      wu.uFogNear.value = this.scene.fog.near; wu.uFogFar.value = this.scene.fog.far;
      if (this.post) {
        const g = this.post.grade.uniforms;
        g.uStorm.value = this.storm; g.uTime.value = this.realTime % 100; g.uFlash.value = flash * 0.25;
        g.uDesat.value = 0.75 * (1 - clamp(this.timeScale * 1.4, 0, 1));
        g.uTilt.value += ((this.showcase ? 1 : 0) - g.uTilt.value) * damp(3, realDt);
        this.post.bloom.strength = 0.55 + (this.showcase ? 0.25 : 0) + this.storm * 0.1;
      }
      const rainK = Math.max(this.look.rain, this.storm - 0.45);
      if (rainK > 0 && !this._fast) this._rain(realDt, rainK);
      // units
      updateUnitShared(this.time);
      for (let i = 0; i < this.views.length; i++) {
        const v = this.views[i];
        if (v.root.visible) v.update(dt, this.time);
      }
      this.fx.update(dt, null);
      this.ambient?.update(dt, this.time, this.storm);
      this.kelp?.update(this.time, this.storm);
      this.stageScenery?.update(this.time, this.storm);
      this._stepCoverFade(realDt);
      this._stepDropIn(realDt);
      this._updateBeacons();
      updatePickupShared(this.time);
      for (let i = 0; i < this.crateList.length; i++) {
        const ud = this.crateList[i].userData;
        ud.spin.rotation.y += dt * 0.7;
        ud.spin.position.y = 0.06 + Math.sin(this.time * 2.2 + ud.phase) * 0.04;
      }
      this._updateOverlays();
      if (this.hoverPx && !this.dragging && !this.showcase) { this._setHover(this._tileAt(this.hoverPx[0], this.hoverPx[1])); }
    }
    this._updateCamera(realDt);
    if (this.state && this.world) this._fitShadow();
    if (this.post) this.post.composer.render(realDt);
    else this.gl.render(this.scene, this.camera);
    this.gl.autoClear = false;
    this.gl.clearDepth();
    if (this._anyXray()) {
      // X-ray pass: revealed units' outlines on top of the world (through walls + fog)
      const bg = this.scene.background, fog = this.scene.fog;
      this.scene.background = null; this.scene.fog = null;
      this.camera.layers.set(XRAY_LAYER);
      this.gl.render(this.scene, this.camera);
      this.camera.layers.set(0);
      this.scene.background = bg; this.scene.fog = fog;
      this.gl.clearDepth();
    }
    this.gl.render(this.overlay, this.camera);
    this.gl.autoClear = true;
  }

  _anyXray() {
    for (let i = 0; i < this.views.length; i++) { const v = this.views[i]; if (v.xrayOn && v.root.visible) return true; }
    return false;
  }

  /** Sun direction: lower and further round as the storm builds; rim-lit in the showcase. */
  _applySun() {
    if (!this.S) return;
    let az, el;
    if (this.showcase) {
      const yaw = Math.PI / 4 + this.camAngle * (Math.PI / 2);
      az = yaw + Math.PI * 0.78; el = 0.36;
    } else {
      az = 2.48 + this.storm * 0.5; el = 0.74 - this.storm * 0.22;
    }
    this.sunDir.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
    this.sun.position.copy(this.sunDir).multiplyScalar(60);
    if (this.fields) this.fields.uniforms.uSunDir.value.copy(this.sunDir);
  }

  _showcaseMood() {
    const m = this.mood;
    m.sunI *= 1.25; m.exposure *= 1.06; m.hemiI *= 0.82;
    _col.setRGB(1.0, 0.72, 0.45);
    m.sun.lerp(_col, 0.35);
  }

  _lightning(dt) {
    this._flash = Math.max(0, this._flash - dt * 4);
    if (this._flash2 >= 0) { this._flash2 -= dt; if (this._flash2 < 0) this._flash = 0.75; }
    if (this.storm < 0.6 || !this.look.lightning) return;
    this.lightningT -= dt * this.look.lightning;
    if (this.lightningT <= 0) {
      this.lightningT = 5 + Math.random() * 9 * (1.6 - this.storm);
      this._flash = 1;
      this._flash2 = 0.12;
      if (Math.random() < 0.5) this.hooks.sfx?.thunder?.();
    }
  }

  _rain(dt, k = this.storm - 0.45) {
    const n = Math.floor(k * 170 * dt * (this.quality === 'high' ? 1 : 0.5) + Math.random());
    const span = this.view * 0.9;
    for (let i = 0; i < n; i++) {
      const x = this.target.x + (Math.random() - 0.5) * span * 2, z = this.target.z + (Math.random() - 0.5) * span * 2;
      this.fx.alpha.spawn(x, 6 + Math.random() * 3, z, -2.5, -22, 0.6, 0.38, 0.025, 0.025, 0.75, 0.85, 0.9, 0.32, 0, 0, 1.6, 1);
    }
    // ground splashes where it lands near the camera target
    if (this.quality === 'high' && Math.random() < k * 2) {
      const x = this.target.x + (Math.random() - 0.5) * span * 1.6, z = this.target.z + (Math.random() - 0.5) * span * 1.6;
      this.fx.add.spawn(x, 0.05, z, 0, 0.6, 0, 0.18, 0.04, 0.12, 0.5, 0.6, 0.65, 0.6, 0, 0, 0, 1.4);
    }
  }

  /**
   * Shadow frustum follows the view instead of covering the whole 44×44 map:
   * sharper shadows and a cheaper shadow pass. Snapped to shadow texels so
   * panning doesn't shimmer.
   */
  _fitShadow() {
    if (!this.sun.castShadow) return;
    const sc = this.sun.shadow.camera;
    const half = (this.view * this.viewScale * Math.max(1, this.aspect)) * (this.showcase ? 1.3 : 0.8) + 3;
    const ext = Math.min(this.S * 0.76, Math.ceil(half / 2) * 2);
    if (sc.userData.ext !== ext) {
      sc.userData.ext = ext;
      sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
      sc.updateProjectionMatrix();
    }
    // light-space snap
    _lm.lookAt(this.sunDir, _v2.set(0, 0, 0), _v1.set(0, 1, 0));
    _li.copy(_lm).invert();
    _lv.copy(this.target).applyMatrix4(_li);
    const texel = (2 * ext) / this.sun.shadow.mapSize.x;
    _lv.x = Math.round(_lv.x / texel) * texel; _lv.y = Math.round(_lv.y / texel) * texel;
    _lv.applyMatrix4(_lm);
    this.sun.target.position.copy(_lv);
    this.sun.position.copy(_lv).addScaledVector(this.sunDir, 60);
    this.sun.target.updateMatrixWorld();
  }

  // ---------- 3.0: cover fade ----------

  /**
   * Fade every cover prop to ~6% (150 ms) and show crisp ground footprints
   * with half / full shield glyphs, so movable tiles read clearly. Units,
   * crates and overlays stay solid. UI turns it on in Move mode.
   */
  setCoverFade(on) { this.coverFadeGoal = on ? 1 : 0; }

  _stepCoverFade(dt) {
    if (this.coverFade === this.coverFadeGoal) return;
    const step = dt / 0.15;
    this.coverFade = this.coverFadeGoal > this.coverFade ? Math.min(this.coverFadeGoal, this.coverFade + step) : Math.max(this.coverFadeGoal, this.coverFade - step);
    if (this._hidden) this.coverFade = this.coverFadeGoal;
    this.props.setFade(easeInOutCubic(this.coverFade));
  }

  // ---------- 3.0: night flares ----------

  _addBeacon(id) {
    if (this.beacons.has(id) || !this.views[id]) return;
    const B = this._beaconAssets || (this._beaconAssets = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d');
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,170,150,0.9)'); gr.addColorStop(1, 'rgba(255,60,70,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      const beamGeo = new THREE.CylinderGeometry(0.05, 0.16, 1, 10, 1, true); beamGeo.translate(0, 0.5, 0);
      const ringGeo = new THREE.RingGeometry(0.42, 0.52, 36); ringGeo.rotateX(-Math.PI / 2);
      const o = { tex, beamGeo, ringGeo };
      for (const k of ['tex', 'beamGeo', 'ringGeo']) o[k].userData.shared = true;
      return o;
    })());
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: B.tex, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    glow.renderOrder = 22;
    const beam = new THREE.Mesh(B.beamGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff4a4a).multiplyScalar(1.6), transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    beam.renderOrder = 7;
    const ring = new THREE.Mesh(B.ringGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff4a4a).multiplyScalar(1.6), transparent: true, depthWrite: false, toneMapped: false }));
    ring.renderOrder = 6;
    this.world.add(beam, ring); this.overlay.add(glow);
    this.beacons.set(id, { glow, beam, ring, t0: this.realTime });
  }

  _removeBeacon(id) {
    const b = this.beacons.get(id);
    if (!b) return;
    for (const o of [b.glow, b.beam, b.ring]) { o.parent?.remove(o); o.material.dispose(); }
    this.beacons.delete(id);
  }

  _updateBeacons() {
    for (const [id, b] of this.beacons) {
      const v = this.views[id];
      const show = v.root.visible && this.disp[id].alive && !this.showcase;
      b.glow.visible = b.beam.visible = b.ring.visible = show;
      if (!show) continue;
      const p = v.root.position, t = this.realTime - b.t0;
      const pulse = 0.75 + 0.25 * Math.sin(t * 7);
      const top = p.y + 1.25 - v.down * 0.42;
      const s = (0.9 + 0.2 * pulse) * clamp(this.view / 14, 0.85, 1.6) * (t < 0.3 ? easeOutCubic(t / 0.3) * 1.5 : 1);
      b.glow.position.set(p.x, top + 0.95 + Math.sin(t * 2.2) * 0.05, p.z);
      b.glow.scale.set(s, s, 1);
      b.beam.position.set(p.x, top, p.z); b.beam.scale.set(1, 6, 1);
      b.beam.material.opacity = 0.25 + 0.15 * pulse;
      b.ring.position.set(p.x, p.y + 0.04, p.z); b.ring.scale.setScalar(1 + ((t * 1.2) % 1) * 0.8);
      b.ring.material.opacity = 1 - ((t * 1.2) % 1);
    }
  }

  // ---------- 3.0: drop-ins ----------

  /**
   * Every unit arrives with its drop-in cosmetic (about 3 s in all; only units
   * the player can see are animated). Resolves when everyone has landed or on skipDropIn().
   */
  playDropIn() {
    if (!this.state || this._hidden) return Promise.resolve();
    this._endDropIn(true);
    const st = this.state, items = [], pending = new Set();
    const mineFirst = [...st.units].sort((a, b) => (b.team === this.myTeam) - (a.team === this.myTeam));
    let n = 0;
    for (const u of mineFirst) {
      const d = this.disp[u.id], v = this.views[u.id];
      if (!d.alive || !v.root.visible) continue;
      const goal = new THREE.Vector3(this.wx(d.x), this._groundY(d.x, d.y), this.wz(d.y));
      const L = Math.hypot(goal.x, goal.z);
      const from = L > 1 ? { x: goal.x / L, z: goal.z / L } : { x: 0, z: -1 };
      const id = this.cos[u.id]?.dropIn || 'default';
      const mine = u.team === this.myTeam;
      const t0 = mine ? Math.min(0.3, n++ * 0.12) : 0.25 + Math.random() * 0.45;
      v.root.visible = false;
      pending.add(u.id);
      items.push({ u, v, id, goal, from, t0, ctl: null, done: false });
    }
    if (!items.length) return Promise.resolve();
    const me = this._playerUnit();
    if (me) this.focus(this.disp[me.id].x, this.disp[me.id].y);
    return new Promise((resolve) => { this._dropIn = { t: 0, items, pending, resolve }; });
  }

  /** Finish the drop-in now (everyone snaps to the ground). */
  skipDropIn() { this._endDropIn(false); }

  _stepDropIn(dt) {
    const D = this._dropIn;
    if (!D) return;
    D.t += dt;
    let left = 0;
    for (const it of D.items) {
      if (it.done) continue;
      const lt = D.t - it.t0;
      if (lt < 0) { left++; continue; }
      if (!it.ctl) {
        it.v.root.visible = true;
        it.ctl = this.cfx.dropIn(it.id, it.v, it.goal, { from: it.from });
        if (it.u.team === this.myTeam) this.hooks.sfx?.step?.();
      }
      it.ctl.update(Math.min(lt, it.ctl.dur));
      if (lt >= it.ctl.dur) { this._finishDropItem(it, D); } else left++;
    }
    if (!left) this._endDropIn(false);
  }

  _finishDropItem(it, D) {
    if (it.done) return;
    it.done = true;
    if (!it.ctl) it.ctl = this.cfx.dropIn(it.id, it.v, it.goal, { from: it.from });
    it.ctl.end();
    D.pending.delete(it.u.id);
  }

  _endDropIn(silent) {
    const D = this._dropIn;
    if (!D) return;
    this._dropIn = null;
    for (const it of D.items) this._finishDropItem(it, D);
    if (!silent && this.state) this._refreshUnits();
    D.resolve();
  }

  /** Shop / locker preview into a 2D canvas (shared offscreen renderer). */
  renderPreview(canvas, opts) { return _renderPreview(canvas, opts); }
  stopPreview(canvas) { _stopPreview(canvas); }

  _updateOverlays() {
    const lscale = clamp(this.view / 14, 0.85, 1.7) * (this.aspect < 1 ? 1.25 : 1);
    const hideAll = this.showcase;
    for (let i = 0; i < this.views.length; i++) {
      const v = this.views[i], l = this.labels[i];
      const show = !hideAll && v.root.visible && this.disp[i].alive && !v.dead && !(this._dropIn && this._dropIn.pending.has(i));
      l.s.visible = show;
      if (show) {
        const p = v.root.position;
        l.s.position.set(p.x, p.y + 1.18 - v.hunk * 0.14 - v.down * 0.42, p.z);
        l.s.scale.set(1.45 * lscale, 0.476 * lscale, 1);
      }
    }
    const me = this._playerUnit();
    if (!hideAll && me && this.disp[me.id].alive && this.views[me.id].root.visible) {
      const p = this.views[me.id].root.position, v = this.views[me.id];
      this.marker.visible = true;
      this.marker.position.set(p.x, p.y + 1.18 - v.down * 0.42 + 0.62 * lscale + Math.sin(this.realTime * 4) * 0.06, p.z);
      this.marker.rotation.y += 0.03;
    } else this.marker.visible = false;
    this.ov.updateBadges(this._posOf);
    this.ov.updateRevive(this._posOfAny);
    const a = this.selTarget !== null && this.isUnitVisible(this.selTarget) ? this._activeUnit() : null;
    if (a) {
      const mv = this.views[a.id];
      // aim line starts at the weapon, not the feet
      mv.muzzleWorld(_v1);
      this.ov.setAim(_v1, this.views[this.selTarget].root.position);
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
  /** Floating text anchored above a unit view (follows hunker/downed height). */
  _textAt(id, text, color, big = 1, extra = 0) {
    const v = this.views[id], p = v.root.position;
    this.fx.floatText(p.x, p.y + 1.35 - v.hunk * 0.14 - v.down * 0.42 + extra, p.z, text, color, big);
  }

  _face(id, x, y, instant) { this.views[id].faceTo(this.wx(x), this.wz(y), instant); }

  /**
   * Overwatch facing: the nearest enemy the unit's team can see (displayed
   * positions), else keep the current facing (last move / aim direction).
   */
  _setOverwatchFacing(id, instant = false) {
    const st = this.state, u = st.units[id], d = this.disp[id];
    let best = null, bd = 1e9;
    for (const e of st.units) {
      if (e.team === u.team) continue;
      const de = this.disp[e.id];
      if (!de.alive || de.downed) continue;
      const dd = Math.hypot(de.x - d.x, de.y - d.y);
      if (dd >= bd) continue;
      const rev = this.reveals.get(u.team);
      if (!(rev && rev.has(e.id)) && !this._teamSees(u.team, de.x, de.y)) continue;
      best = de; bd = dd;
    }
    const v = this.views[id];
    if (best) v.faceTo(this.wx(best.x), this.wz(best.y), instant);
    v.setOverwatch(true);
    if (instant) { v.coneK = 1; v.cone.scale.set(1, 1, 1); }
  }

  /** View size that fits world points a and b on screen with padding (tiles). */
  _fitView(a, b, padW, padH) {
    const ang = Math.PI / 4 + this.camAngleGoal * (Math.PI / 2);
    const dx = b.x - a.x, dz = b.z - a.z;
    const w = Math.abs(-Math.sin(ang) * dx + Math.cos(ang) * dz);
    const h = Math.abs(Math.cos(ang) * dx + Math.sin(ang) * dz) * Math.sin(this.elevGoal) + 1.2;
    const v = Math.max((w + padW) / this.aspect, h + padH);
    return clamp(v / this.viewScale, VIEW_MIN + 1, VIEW_MAX);
  }

  /** Frame two world points for an action cam. Returns the hold tag or null. */
  _actionCam(a, b, kill) {
    if (!this._cine) return null;
    const tag = kill ? 'kill' : 'shot';
    this._camPush(tag);
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
    return tag;
  }

  _pointCam(tag, x, z, view) {
    if (!this._cine) return false;
    this._camPush(tag);
    this.goal.set(x, 0, z); this.followId = null;
    if (view) this.viewGoal = Math.max(this.viewGoal, view);
    return true;
  }

  myRef() {
    if (!this.state) return { x: 0, y: 0 };
    const me = this.state.units.find((u) => u.isPlayer && this.disp[u.id].alive)
      || this.state.units.find((u) => u.team === this.myTeam && this.disp[u.id].alive);
    if (me) return this.disp[me.id];
    return { x: this.S / 2, y: this.S / 2 };
  }

  _weaponOf(u) { return u.weapon?.name || ({ assault: 'Rifle', marksman: 'Long Rifle', breacher: 'Shotgun', medic: 'SMG', recon: 'Carbine' })[u.cls]; }
  /** Weapon family for audio: Audio 1.0 knows rifle / longrifle / shotgun (names also passed through). */

  _hp(id, delta) {
    const d = this.disp[id], u = this.state.units[id];
    d.hp = clamp(d.hp + delta, 0, u.maxHp);
    this._drawLabel(u);
  }

  _seen(id) {
    const u = this.state.units[id];
    return u.team === this.myTeam || this.views[id].root.visible;
  }

  // ---------- events ----------

  /** Play one sim event. Resolves when its animation is done (never hangs). */
  async playEvent(ev) {
    if (!this.state || !ev) return;
    const st = this.state;
    const sfx = this.hooks.sfx;
    const g = this.gen;
    if (ev.id !== undefined && ev.type !== 'smoke_clear' && typeof ev.id === 'number' && !st.units[ev.id] && ev.type !== 'crate_drop') return;
    switch (ev.type) {
      case 'move': return this._evMove(ev);
      case 'shot': return this._evShot(ev);
      case 'death': return this._evDeath(ev);
      case 'grenade': return this._evThrow(ev, 'frag');
      case 'smoke': return this._evThrow(ev, 'smoke');
      case 'damage': return this._evDamage(ev);
      case 'cover_change': return this._evCover(ev);
      case 'breach': return this._evBreach(ev);
      case 'supply_drop': return this._evSupply(ev);
      case 'downed': return this._evDowned(ev);
      case 'revive': return this._evRevive(ev);
      case 'bleed_out': return this._evBleedOut(ev);
      case 'patch': return this._evPatch(ev);
      case 'scan': return this._evScan(ev);
      case 'reveal_end': {
        this.reveals.delete(ev.team);
        this._refreshUnits();
        return;
      }
      case 'smoke_clear':
        this.fx.clearSmoke(ev.smokeId);
        this.dsmokes = this.dsmokes.filter((c) => c.id !== ev.smokeId);
        this._refreshUnits();
        return;
      case 'barrel_shot': return this._evBarrelShot(ev);
      case 'barrel': return this._evBarrel(ev);
      case 'flare': {
        const u = st.units[ev.id];
        if (!u) return;
        if (!this.dflares.some((f) => f.id === ev.id)) this.dflares.push({ id: ev.id, team: u.team });
        this._addBeacon(ev.id);
        this._refreshUnits();
        const v = this.views[ev.id];
        if (v.root.visible && u.team !== this.myTeam) {
          const p = v.root.position;
          this.fx.flashLight(p.x, p.y + 2, p.z, 0xff6a5a, 14, 0.5, 6);
          this.fx.ring(p.x, p.y + 0.06, p.z, 0.2, 1.4, 0xff4a4a, 0.5, 1.2);
          this._textAt(ev.id, 'FLARED', '#ff8a7a', 0.8, 0.35);
          await this._wait(260);
        }
        return;
      }
      case 'flare_end':
        this.dflares = this.dflares.filter((f) => f.id !== ev.id);
        this._removeBeacon(ev.id);
        this._refreshUnits();
        return;
      case 'overwatch': {
        const u = st.units[ev.id], v = this.views[ev.id];
        this._setOverwatchFacing(ev.id);
        this._drawLabel(u);
        if (this._seen(ev.id)) {
          v.aimGoal = 1;
          this._textAt(ev.id, 'OVERWATCH', TEXT.signal, 0.8);
          this.fx.ring(v.root.position.x, 0.08, v.root.position.z, 0.3, 1.6, TEAM.cyan, 0.6, 1);
          await this._wait(420);
          if (g !== this.gen) return;
          v.aimGoal = 0;
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
          this._textAt(ev.target, 'REACTION!', TEXT.signal, 0.85, 0.25);
          this._face(ev.id, d.x, d.y);
          this.views[ev.id].aimGoal = 1;
          await this._wait(380);
        }
        return;
      }
      case 'hunker': {
        const u = st.units[ev.id], v = this.views[ev.id];
        v.setHunker(true);
        this._drawLabel(u);
        if (this._seen(ev.id)) {
          sfx?.hunker?.();
          this._textAt(ev.id, 'HUNKER DOWN', TEXT.info, 0.8);
          this.fx.dust(v.root.position.x, v.root.position.z, 8, 0.78, 0.7, 0.56, 0.05, 1.2);
          await this._wait(420);
        }
        return;
      }
      case 'crate': {
        const gm = this.crateMeshes.get(ev.crate);
        const u = st.units[ev.id];
        const vis = this._seen(ev.id);
        if (gm && vis) this.fx.pickupBurst(gm.position.x, gm.position.z);
        this._removeCrate(ev.crate);
        this._drawLabel(u);
        if (u.team === this.myTeam) {
          sfx?.pickup();
          const name = { cache: 'SUPPLY CACHE', frag: '+FRAG', smoke: '+SMOKE', medkit: '+MEDKIT', armor: '+ARMOR', scope: '+SCOPE', barrel: '+BARREL' }[ev.item] || '+' + String(ev.item).toUpperCase();
          this._textAt(ev.id, name, TEXT.signal, 0.9);
          await this._wait(350);
        }
        return;
      }
      case 'crate_drop':
        if (ev.crate) this._addCrate(ev.crate, true);
        return;
      case 'heal': {
        const v = this.views[ev.id];
        this._hp(ev.id, ev.amount);
        if (v.root.visible) {
          this._textAt(ev.id, '+' + ev.amount, TEXT.heal, 1);
          const p = v.root.position;
          this.fx.healPulse(p.x, p.z, 0.8);
          await this._wait(380);
        }
        return;
      }
      case 'zone_damage': {
        const v = this.views[ev.id];
        this._hp(ev.id, -ev.dmg);
        if (v.root.visible) {
          this._textAt(ev.id, `TIDE -${ev.dmg}`, TEXT.tide, 0.9);
          v.doFlinch(0.6);
          this.fx.splash(v.root.position.x, v.root.position.z, 1.2);
          await this._wait(320);
        }
        return;
      }
      case 'zone_shrink': {
        sfx?.tide();
        const z = st.zone, dz = this.dzone || (this.dzone = { ...z });
        dz.r = ev.r ?? z.r; dz.next = ev.next ?? z.next;
        dz.x = ev.x ?? z.x; dz.y = ev.y ?? z.y;
        dz.nx = ev.nx ?? z.nx ?? dz.x; dz.ny = ev.ny ?? z.ny ?? dz.y;
        this._updateZone(false);
        this.fx.shake = Math.max(this.fx.shake, 0.3);
        await this._wait(900);
        return;
      }
      case 'turn_start':
        for (const id of st.teams[ev.team].members) {
          const u = st.units[id];
          const d = this.disp[id];
          if (u.alive && !u.downed) d.hp = u.hp;
          if (d.downed && u.alive) { d.bleed = u.bleed || 0; this.views[id].setBleed(d.bleed); }
          this.views[id].setOverwatch(!!u.overwatch && u.alive);
          this.views[id].setHunker(!!u.hunkered && u.alive);
          this._drawLabel(u);
        }
        // bleed counters of every downed unit (the sim ticks them at team-turn end)
        for (const u of st.units) {
          const d = this.disp[u.id];
          if (d.downed && u.alive && d.bleed !== (u.bleed || 0)) { d.bleed = u.bleed || 0; this.views[u.id].setBleed(d.bleed); this._drawLabel(u); }
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
    const st = this.state, sfx = this.hooks.sfx, g = this.gen;
    const u = st.units[ev.id];
    const mine = u.team === this.myTeam;
    const v = this.views[ev.id];
    if (!ev.path || ev.path.length < 2) return;
    const anyVisible = mine || ev.path.some(([x, y]) => this._seenAt(ev.id, x, y));
    v.setHunker(false);
    v.aimGoal = 0;
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
      const vis = mine || this._seenAt(ev.id, ax, ay) || this._seenAt(ev.id, bx, by);
      v.root.visible = vis;
      const diag = ax !== bx && ay !== by;
      const ya = this._groundY(ax, ay), yb = this._groundY(bx, by);
      await this._anim(vis ? (diag ? 175 : 140) : 1, (t) => {
        v.root.position.set(this.wx(ax + (bx - ax) * t), lerp(ya, yb, t), this.wz(ay + (by - ay) * t));
      });
      if (g !== this.gen) return;
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
    const S = this.S;
    const ddx = sx - tx, ddy = sy - ty;
    let best = null, bc = 0;
    const consider = (x, y) => {
      if (x < 0 || y < 0 || x >= S || y >= S) return;
      const c = this.props.cover[y * S + x];
      if (c > bc) { bc = c; best = [x, y]; }
    };
    if (ddx !== 0 && Math.abs(ddx) * 2 >= Math.abs(ddy)) consider(tx + Math.sign(ddx), ty);
    if (ddy !== 0 && Math.abs(ddy) * 2 >= Math.abs(ddx)) consider(tx, ty + Math.sign(ddy));
    return best ? [best[0], best[1], bc] : null;
  }

  async _evShot(ev) {
    const st = this.state, sfx = this.hooks.sfx, g = this.gen;
    const s = st.units[ev.from], t = st.units[ev.to];
    if (!s || !t) return;
    const ds = this.disp[ev.from], dt = this.disp[ev.to];
    const vs = this.views[ev.from], vt = this.views[ev.to];
    const sVis = this._unitSeen(ev.from);
    const tVis = this._unitSeen(ev.to);
    const hitting = ev.result !== 'miss';
    const wasDowned = dt.downed;
    if (hitting) dt.hp -= ev.dmg;
    // a kill: the hit finishes them (an execute on a downed unit always does). A downing hit is not.
    const kill = hitting && dt.alive && !ev.downed && (wasDowned || dt.hp <= 0);
    const downing = hitting && !!ev.downed;
    if (!sVis && !tVis) {
      // Heard, not seen: a rough ping where the shot came from.
      const px = Math.round(ds.x / 3) * 3 + 1, py = Math.round(ds.y / 3) * 3 + 1;
      this._ping(px, py);
      sfx?.shot(1, this._weaponOf(s));
      this.hooks.onFeed?.(`Gunfire to the ${compass(this.myRef(), px, py)}`);
      if (dt.hp < 0) dt.hp = 0;
      this._drawLabel(t);
      return;
    }
    const weapon = this._weaponOf(s);
    const shotgun = s.cls === 'breacher' || weapon === 'Shotgun';
    const marks = s.cls === 'marksman';
    const smg = s.cls === 'medic';
    vs.root.visible = true;
    vs.setHunker(false);
    this._face(ev.from, dt.x, dt.y);
    vs.aimGoal = 1;
    const A = vs.root.position, B = vt.root.position;
    const cam = this._actionCam(A, B, kill || downing);
    await this._wait(cam ? (kill ? 420 : 300) : 200);
    if (g !== this.gen) return;
    vs.settle(); // fully turned + shouldered before we sample the muzzle
    if (ev.ability === 'aimed') {
      vs.muzzleWorld(_v1);
      this.fx.add.spawn(_v1.x, _v1.y, _v1.z, 0, 0, 0, 0.45, 0.1, 0.9, 5, 5, 5, 1, 0, 0, 0, 2.5);
      this._textAt(ev.from, 'AIMED SHOT', TEXT.info, 0.75, 0.2);
      await this._wait(320);
      if (g !== this.gen) return;
      vs.settle();
    }
    if (ev.flank && tVis) this._textAt(ev.to, 'FLANKED', TEXT.info, 0.7, 0.55);
    if ((kill || downing) && cam) this.slowGoal = kill ? 0.32 : 0.5;
    vs.muzzleWorld(_v1);
    const mx = _v1.x, my = _v1.y, mz = _v1.z;
    // impact point (chest height; lower for hunkered / downed)
    let ix = B.x, iy = B.y + 0.6 - vt.hunk * 0.15 - vt.down * 0.3, iz = B.z;
    const dirx = ix - mx, dirz = iz - mz, dl = Math.hypot(dirx, dirz) || 1;
    const nx = dirx / dl, nz = dirz / dl;
    const bursts = smg ? 3 : 1;
    const col = new THREE.Color(this.teamColor(s.team));
    let missKind = null;
    if (!hitting) {
      const ct = ev.cover > 0 ? this._coverTileBetween(dt.x, dt.y, ds.x, ds.y) : null;
      if (ct && Math.random() < 0.75) {
        // the round smacks into the cover piece on the shooter's side of the target
        ix = this.wx(ct[0]) - nx * 0.3; iz = this.wz(ct[1]) - nz * 0.3; iy = ct[2] === 2 ? 0.55 + Math.random() * 0.4 : 0.3 + Math.random() * 0.15;
        missKind = 'cover';
      } else {
        // sails past: lands beyond the target, off to one side
        const side = Math.random() < 0.5 ? -1 : 1;
        ix = B.x - nz * side * 0.55 + nx * 1.6; iz = B.z + nx * side * 0.55 + nz * 1.6; iy = 0.05;
        missKind = 'ground';
      }
    }
    for (let b = 0; b < bursts; b++) {
      if (b > 0) { await this._wait(70); if (g !== this.gen) return; vs.muzzleWorld(_v1); }
      sfx?.shot(this._far(ds.x, ds.y), weapon);
      this.fx.muzzle(_v1.x, _v1.y, _v1.z, nx, nz, shotgun ? 1.4 : marks ? 1.2 : smg ? 0.75 : 1);
      this.fx.shell(_v1.x, _v1.y, _v1.z, nx, nz);
      vs.doRecoil(shotgun ? 1.3 : smg ? 0.6 : 1);
      const width = marks ? 0.05 : shotgun ? 0.025 : smg ? 0.026 : 0.035;
      const jx = b ? (Math.random() - 0.5) * 0.15 : 0, jy = b ? (Math.random() - 0.5) * 0.12 : 0;
      this.fx.tracer(_v1.x, _v1.y, _v1.z, ix + jx, iy + jy, iz - jx, col, width * (ev.ability === 'aimed' ? 1.6 : 1));
      if (shotgun) {
        for (let i = 0; i < 4; i++) {
          const j = (Math.random() - 0.5) * 0.5;
          this.fx.tracer(mx, my, mz, ix - nz * j, iy + (Math.random() - 0.5) * 0.3, iz + nx * j, col, 0.018, 0.12);
        }
      }
    }
    await this._wait(Math.min(160, 30 + dl * 9));
    if (g !== this.gen) return;
    if (hitting) {
      const graze = ev.result === 'graze';
      sfx?.hit(graze);
      this.fx.hitFlash(ix, iy, iz, graze ? 0.6 : kill ? 1.4 : 1, nx, nz);
      vt.doFlinch(graze ? 0.55 : 1, nx, nz);
      if (tVis) this._textAt(ev.to, (graze ? 'GRAZE ' : '') + '-' + ev.dmg, graze ? TEXT.graze : TEXT.hit, graze ? 0.85 : kill ? 1.35 : 1.15);
      if (kill || downing) {
        this.hitStop = cam ? 0.14 : 0.07;
        this.fx.shake = Math.max(this.fx.shake, 0.35);
        this.fx.ring(B.x, 0.08, B.z, 0.2, 1.4, 0xffffff, 0.35, 1.2);
      }
    } else {
      sfx?.miss();
      if (missKind === 'cover') {
        this.fx.sparks(ix, iy, iz, 12, 5, 3.6, 2, 3.5);
        this.fx.dust(ix, iz, 4, 0.72, 0.7, 0.64, iy - 0.1, 0.7);
        this.fx.debrisBurst(ix, iy, iz, [0x9b9a90, 0xcbbd9c], 4, 0.5);
      } else if (this._floodedWorld(ix, iz)) this.fx.splash(ix, iz, 0.6);
      else this.fx.dust(ix, iz, 6, 0.78, 0.7, 0.56, 0.05, 0.8);
      if (tVis) this._textAt(ev.to, 'MISS', TEXT.miss, 0.9);
    }
    if (dt.hp < 0) dt.hp = 0;
    this._drawLabel(t);
    this._drawLabel(s);
    await this._wait(kill ? 200 : 380);
    if (g !== this.gen) return;
    vs.aimGoal = 0;
    if (!kill) vs.doReload();
    // kill / downed cams are released by the death / downed events (or expire)
    if (cam === 'shot') this._camRelease('shot');
    if (!sVis) this._syncUnitVisibility(s);
  }

  async _evDeath(ev) {
    const st = this.state, sfx = this.hooks.sfx, g = this.gen;
    const u = st.units[ev.id];
    const v = this.views[ev.id];
    const d = this.disp[ev.id];
    const wasVisible = v.root.visible;
    const wasDowned = d.downed;
    d.hp = 0; d.downed = false;
    this._drawLabel(u);
    if (wasVisible && !(this.speed > 3)) {
      sfx?.death();
      let dir = Math.random() < 0.5 ? -1 : 1;
      if (ev.by !== null && ev.by !== undefined && this.views[ev.by] && ev.by !== ev.id) {
        // fall away from the killer
        const k = this.views[ev.by].root.position;
        v.faceTo(k.x, k.z, true);
        dir = (ev.id % 2) ? 1 : -1;
      }
      v.die(dir);
      v.corpse = true;
      if (this.camStack.some((s) => s.tag === 'kill')) this.slowGoal = 0.45;
      const p = v.root.position;
      // the killer's kill-effect cosmetic plays on the victim
      const by = ev.by !== null && ev.by !== undefined && ev.by !== ev.id ? ev.by : null;
      const kfx = by !== null ? this.cos[by]?.killFx : null;
      let fxLen = 0;
      if (kfx && kfx !== 'default') { await this._wait(120); if (g !== this.gen) return; fxLen = this.cfx.killEffect(kfx, v); }
      await this._wait(wasDowned ? 250 : 380);
      if (g !== this.gen) return;
      if (fxLen > 0.6 && !this._fast) { await this._wait(Math.min(700, (fxLen - 0.6) * 1000)); if (g !== this.gen) return; }
      this.fx.slump(p.x, p.z, this._flooded(d.x, d.y));
      this.fx.ring(p.x, 0.06, p.z, 0.2, 1.2, 0xe8e0cc, 0.5, 0.6);
      await this._wait(this.camStack.some((s) => s.tag === 'kill') ? 520 : 320);
      if (g !== this.gen) return;
      // the corpse lingers, then sinks away
      const gen = this.gen;
      const y0 = v.root.position.y;
      if (v.derezzed) { v.corpse = false; v.root.visible = false; }
      this.fx.timed(5, (t) => {
        if (gen !== this.gen) return;
        if (t > 0.75) v.root.position.y = y0 - ((t - 0.75) / 0.25) * 0.5;
        if (t >= 1) { v.corpse = false; v.root.visible = false; v.setReveal(false); }
      });
    }
    this._camRelease('kill');
    this.slowGoal = 1;
    d.alive = false;
    v.setReveal(false);
    if (!wasVisible) v.root.visible = false;
    if (u.team === this.myTeam) this.refreshFog();
    if (this.reviveIds?.includes(ev.id)) { this.reviveIds = this.reviveIds.filter((i) => i !== ev.id); this.ov.setRevive(this.reviveIds.length ? this.reviveIds : null); }
  }

  async _evDowned(ev) {
    const st = this.state, sfx = this.hooks.sfx, g = this.gen;
    const u = st.units[ev.id], v = this.views[ev.id], d = this.disp[ev.id];
    d.hp = 0; d.downed = true; d.bleed = u.bleed || 2;
    v.setDowned(true, d.bleed);
    this._drawLabel(u);
    if (u.team === this.myTeam) this.refreshFog();
    if (v.root.visible && !(this.speed > 3)) {
      if (ev.by !== null && ev.by !== undefined && this.views[ev.by] && ev.by !== ev.id) {
        const k = this.views[ev.by].root.position;
        v.faceTo(k.x, k.z);
      }
      sfx?.downed?.();
      if (u.team === this.myTeam) sfx?.stinger?.('downed');
      const p = v.root.position;
      await this._wait(260);
      if (g !== this.gen) return;
      this.fx.slump(p.x, p.z, this._flooded(d.x, d.y));
      this._textAt(ev.id, 'DOWNED', TEXT.down, 1.0, -0.1);
      this.fx.ring(p.x, 0.07, p.z, 0.3, 1.0, squadColorHex(u.team, this.myTeam), 0.6, 1.1);
      await this._wait(420);
      if (g !== this.gen) return;
    }
    this._camRelease('kill');
    this.slowGoal = 1;
  }

  async _evRevive(ev) {
    const st = this.state, sfx = this.hooks.sfx, g = this.gen;
    const u = st.units[ev.id], v = this.views[ev.id], d = this.disp[ev.id];
    const by = ev.by !== undefined && ev.by !== null ? ev.by : null;
    const vis = this._seen(ev.id);
    if (vis && by !== null && by !== ev.id && this.views[by]) {
      // the reviver turns to them and kneels in
      const vb = this.views[by], p = v.root.position;
      vb.faceTo(p.x, p.z); vb.setHunker(true); vb.aimGoal = 0;
      await this._wait(260);
      if (g !== this.gen) return;
    }
    d.downed = false; d.hp = ev.hp ?? u.hp; d.bleed = 0;
    v.setDowned(false);
    this._drawLabel(u);
    if (u.team === this.myTeam) this.refreshFog();
    if (this.reviveIds?.includes(ev.id)) { this.reviveIds = this.reviveIds.filter((i) => i !== ev.id); this.ov.setRevive(this.reviveIds.length ? this.reviveIds : null); }
    if (vis) {
      sfx?.revive?.();
      const p = v.root.position;
      this.fx.reviveShimmer(p.x, p.z);
      this._textAt(ev.id, `REVIVED +${d.hp}`, TEXT.heal, 1.0);
      await this._wait(620);
      if (g !== this.gen) return;
      if (by !== null && this.views[by]) this.views[by].setHunker(!!st.units[by].hunkered);
    }
  }

  async _evBleedOut(ev) {
    const g = this.gen;
    const v = this.views[ev.id];
    if (!v) return;
    if (v.root.visible) {
      this._textAt(ev.id, 'BLED OUT', TEXT.down, 0.9, -0.1);
      v.setBleed(0);
      v.doFlinch(0.4);
      await this._wait(500);
      if (g !== this.gen) return;
    }
  }

  async _evPatch(ev) {
    const st = this.state, sfx = this.hooks.sfx, g = this.gen;
    const m = this.views[ev.id], tid = ev.target ?? ev.id, tv = this.views[tid], td = this.disp[tid];
    if (!m || !tv) return;
    const vis = this._seen(ev.id) || this._seen(tid);
    const reviving = td.downed; // the revive event that follows restores HP + stands them up
    if (!reviving) this._hp(tid, ev.amount || 0);
    if (!vis) return;
    sfx?.patch?.();
    const self = tid === ev.id;
    if (!self) { m.faceTo(tv.root.position.x, tv.root.position.z); m.setHunker(true); }
    m.doReload();
    await this._wait(self ? 160 : 260);
    if (g !== this.gen) return;
    const a = m.root.position, b = tv.root.position;
    if (!self) this.fx.healStream(a.x, a.y + 0.75, a.z, b.x, b.y + 0.55, b.z, 18);
    await this._wait(self ? 80 : 320);
    if (g !== this.gen) return;
    this.fx.healPulse(b.x, b.z, 1.1);
    if (!reviving) this._textAt(tid, `PATCH +${ev.amount || 0}`, TEXT.heal, 1.0);
    await this._wait(reviving ? 160 : 420);
    if (g !== this.gen) return;
    if (!self && !reviving) m.setHunker(!!st.units[ev.id].hunkered);
  }

  async _evScan(ev) {
    const st = this.state, sfx = this.hooks.sfx, g = this.gen;
    const u = st.units[ev.id], v = this.views[ev.id];
    const mine = u.team === this.myTeam;
    const ids = ev.revealed || [];
    let s = this.reveals.get(u.team);
    if (!s) this.reveals.set(u.team, (s = new Set()));
    for (const id of ids) s.add(id);
    const tx = this.wx(ev.x), tz = this.wz(ev.y);
    const vis = mine || this._seen(ev.id) || this.visibleToMe(ev.x, ev.y);
    if (!vis) { for (const o of st.units) this._syncUnitVisibility(o); return; }
    sfx?.scan?.();
    if (this._seen(ev.id)) {
      v.faceTo(tx, tz); v.aimGoal = 0; v.doReload();
      // uplink pulse off the drone pack
      const p = v.root.position;
      this.fx.ring(p.x, 0.08, p.z, 0.2, 0.9, TEAM.cyan, 0.5, 1);
      for (let i = 0; i < 10; i++) this.fx.add.spawn(p.x, p.y + 0.95, p.z, (Math.random() - 0.5) * 0.4, 3 + Math.random() * 2, (Math.random() - 0.5) * 0.4, 0.5, 0.06, 0.02, 1.0, 3.0, 3.6, 1, 1, 0, 1.6, 1);
    }
    const cam = this._pointCam('scan', tx, tz, 12);
    await this._wait(280);
    if (g !== this.gen) return;
    this.fx.scanSweep(tx, tz, ev.radius || 5, 1.6);
    await this._wait(700);
    if (g !== this.gen) return;
    for (const o of st.units) this._syncUnitVisibility(o);
    if (mine || this.spectator) {
      for (const id of ids) {
        const p = this.views[id].root.position;
        this.fx.revealPing(p.x, p.z);
      }
      this._text(ev.x, ev.y, ids.length ? `${ids.length} CONTACT${ids.length > 1 ? 'S' : ''}` : 'NO CONTACTS', ids.length ? TEXT.signal : TEXT.info, 1.0, 0.9);
    }
    await this._wait(700);
    if (g !== this.gen) return;
    if (cam) this._camRelease('scan');
  }

  /** Frag grenade or smoke canister: wind-up, arc, then blast / bloom. */
  async _evThrow(ev, kind) {
    const st = this.state, sfx = this.hooks.sfx, g = this.gen;
    const u = st.units[ev.id];
    const v = this.views[ev.id];
    const d = this.disp[ev.id];
    const smoke = kind === 'smoke';
    const sVis = this._unitSeen(ev.id);
    const tVis = this.visibleToMe(ev.x, ev.y);
    if (smoke) {
      this.dsmokes = this.dsmokes.filter((c) => c.id !== ev.smokeId);
      this.dsmokes.push({ id: ev.smokeId, x: ev.x, y: ev.y, radius: ev.radius || 1.5, team: u.team });
    }
    const tx = this.wx(ev.x), tz = this.wz(ev.y);
    this._blast = smoke ? null : { x: tx, z: tz };
    if (!sVis && !tVis) {
      if (smoke) { this.fx.smokeCloud(ev.smokeId, tx, tz, ev.radius || 1.5); this._refreshUnits(); return; }
      sfx?.explosion(1);
      this._ping(ev.x, ev.y);
      this.hooks.onFeed?.(`Explosion to the ${compass(this.myRef(), ev.x, ev.y)}`);
      return;
    }
    const a0 = v.root.position;
    const cam = this._pointCam('blast', (a0.x + tx) / 2, (a0.z + tz) / 2);
    if (sVis) { this._face(ev.id, ev.x, ev.y); v.setHunker(false); v.aimGoal = 0; }
    await this._wait(200);
    if (g !== this.gen) return;
    sfx?.grenadeThrow?.();
    if (sVis) v.doRecoil(1.4);
    const ax = a0.x, ay = a0.y + 0.95, az = a0.z;
    const dist = Math.hypot(tx - ax, tz - az);
    const peak = 1.6 + dist * 0.28;
    const nade = this.fx.throwStart(kind);
    const dur = 420 + dist * 45;
    await this._anim(dur, (t) => {
      const x = lerp(ax, tx, t), z = lerp(az, tz, t), y = lerp(ay, 0.12, t) + Math.sin(t * Math.PI) * peak;
      nade.position.set(x, y, z);
      nade.rotation.set(t * 14, t * 9, 0);
      if (Math.random() < 0.6) this.fx.alpha.spawn(x, y, z, 0, 0.2, 0, smoke ? 0.9 : 0.5, 0.06, smoke ? 0.3 : 0.18, 0.75, 0.74, 0.7, 0.4, 2, 0, 0, 1.2);
      if (!smoke && Math.random() < 0.5) this.fx.add.spawn(x, y, z, 0, 0, 0, 0.12, 0.08, 0.02, 5, 3, 1, 1, 0, 0, 0, 1);
    });
    this.fx.throwEnd();
    if (g !== this.gen) return;
    if (smoke) {
      sfx?.smoke?.();
      this.fx.smokeCloud(ev.smokeId, tx, tz, ev.radius || 1.5);
      if (this._flooded(ev.x, ev.y)) this.fx.splash(tx, tz, 0.8);
      this._text(ev.x, ev.y, 'SMOKE', TEXT.info, 0.85, 1.6);
      await this._wait(520);
      if (g !== this.gen) return;
      this._refreshUnits(); // the cloud now hides whoever is inside
      if (g !== this.gen) return;
      if (cam) this._camRelease('blast');
      return;
    }
    sfx?.explosion(this._far(ev.x, ev.y));
    this.fx.explosion(tx, tz, ev.radius || 1.5, this._flooded(ev.x, ev.y));
    this.hitStop = 0.05;
    await this._wait(380);
    if (g !== this.gen) return;
    // the damage / cover events that follow keep the cam; it releases on its own shortly after
    if (cam) { const s = this.camStack[this.camStack.length - 1]; if (s && s.tag === 'blast') s.until = Math.min(s.until, performance.now() / 1000 + 1.1); }
  }

  _extendBlastHold() {
    const s = this.camStack[this.camStack.length - 1];
    if (s && s.tag === 'blast') s.until = Math.max(s.until, performance.now() / 1000 + 0.7);
  }

  async _evDamage(ev) {
    const g = this.gen;
    const v = this.views[ev.id];
    this._hp(ev.id, -ev.dmg);
    if (v.root.visible) {
      const p = v.root.position;
      let nx = 0, nz = 0;
      if (this._blast && (ev.source === 'explosion' || ev.source === 'barrel')) {
        const bx = p.x - this._blast.x, bz = p.z - this._blast.z, L = Math.hypot(bx, bz);
        if (L > 0.05) { nx = bx / L; nz = bz / L; }
      } else if (ev.by !== undefined && ev.by !== null && this.views[ev.by]) {
        const q = this.views[ev.by].root.position, L = Math.hypot(p.x - q.x, p.z - q.z) || 1;
        nx = (p.x - q.x) / L; nz = (p.z - q.z) / L;
      }
      v.doFlinch(1, nx, nz);
      this.fx.hitFlash(p.x, 0.6, p.z, 0.8, nx, nz);
      this._textAt(ev.id, '-' + ev.dmg, TEXT.hit, 1.15);
      await this._wait(160);
      if (g !== this.gen) return;
    }
    this._extendBlastHold();
  }

  async _evCover(ev) {
    const g = this.gen;
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
      if (g !== this.gen) return;
    }
    this._extendBlastHold();
  }

  async _evBreach(ev) {
    const st = this.state, sfx = this.hooks.sfx, g = this.gen;
    const u = st.units[ev.id], v = this.views[ev.id], d = this.disp[ev.id];
    const vis = this._unitSeen(ev.id) || this.visibleToMe(ev.x, ev.y);
    void d;
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
    if (g !== this.gen) return;
    v.hunkGoal = 0;
    await this._anim(120, (t) => { p.x = ox + dx * 0.32 * easeOutCubic(t); p.z = oz + dz * 0.32 * easeOutCubic(t); });
    if (g !== this.gen) return;
    sfx?.breach?.();
    this.fx.explosion(lerp(ox, tx, 0.7), lerp(oz, tz, 0.7), 0.9, this._flooded(ev.x, ev.y));
    this.fx.flashLight(tx, 0.8, tz, 0xfff0d0, 40, 0.25, 6);
    v.doRecoil(1.5);
    this.hitStop = 0.06;
    await this._anim(260, (t) => { p.x = ox + dx * 0.32 * (1 - easeOutCubic(t)); p.z = oz + dz * 0.32 * (1 - easeOutCubic(t)); });
    p.x = ox; p.z = oz;
  }

  /** Someone shoots an explosive barrel: tracer into the drum, then the barrel event blows it. */
  async _evBarrelShot(ev) {
    const st = this.state, sfx = this.hooks.sfx, g = this.gen;
    const s = st.units[ev.id];
    if (!s) return;
    const vs = this.views[ev.id], ds = this.disp[ev.id];
    const sVis = this._unitSeen(ev.id), tVis = this.visibleToMe(ev.x, ev.y);
    if (!sVis && !tVis) { sfx?.shot(1, this._weaponOf(s)); return; }
    const tx = this.wx(ev.x), tz = this.wz(ev.y);
    if (sVis) {
      vs.setHunker(false); this._face(ev.id, ev.x, ev.y); vs.aimGoal = 1;
      await this._wait(260);
      if (g !== this.gen) return;
      vs.settle();
      vs.muzzleWorld(_v1);
      const dx = tx - _v1.x, dz = tz - _v1.z, L = Math.hypot(dx, dz) || 1;
      sfx?.shot(this._far(ds.x, ds.y), this._weaponOf(s));
      this.fx.muzzle(_v1.x, _v1.y, _v1.z, dx / L, dz / L, 1);
      this.fx.tracer(_v1.x, _v1.y, _v1.z, tx, 0.3, tz, new THREE.Color(this.teamColor(s.team)), 0.04);
      vs.doRecoil(1);
      await this._wait(Math.min(160, 30 + L * 9));
      if (g !== this.gen) return;
      vs.aimGoal = 0;
    }
    this.fx.sparks(tx, 0.35, tz, 10, 5, 3, 1.5, 3);
  }

  /** An explosive barrel detonates (chains arrive as further barrel events). */
  async _evBarrel(ev) {
    const sfx = this.hooks.sfx, g = this.gen;
    const tx = this.wx(ev.x), tz = this.wz(ev.y);
    this._blast = { x: tx, z: tz };
    this.props.detonate(ev.x, ev.y);
    const vis = this.visibleToMe(ev.x, ev.y);
    if (!vis || this.speed > 3) {
      sfx?.explosion(1);
      if (!vis) { this._ping(ev.x, ev.y); this.hooks.onFeed?.(`Barrel blast to the ${compass(this.myRef(), ev.x, ev.y)}`); }
      return;
    }
    const held = this.camStack.length && this.camStack[this.camStack.length - 1].tag === 'blast';
    const cam = held ? false : this._pointCam('blast', tx, tz, 10);
    sfx?.explosion(this._far(ev.x, ev.y));
    const wet = this._flooded(ev.x, ev.y);
    this.fx.explosion(tx, tz, 1.5, wet);
    // fuel fireball column + flying drum parts
    const A = this.fx.add;
    for (let i = 0; i < this.fx._n(30); i++) {
      const a = Math.random() * Math.PI * 2, s = Math.random() * 1.2;
      A.spawn(tx + Math.cos(a) * 0.2, 0.4, tz + Math.sin(a) * 0.2, Math.cos(a) * s, 2.5 + Math.random() * 3.5, Math.sin(a) * s, 0.6 + Math.random() * 0.6, 0.4, 1.1, 5, 1.6 + Math.random(), 0.25, 1, 2.5, -1.2, 0, 1.5);
    }
    this.fx.debrisBurst(tx, 0.4, tz, [0xc8261c, 0x3a3d40, 0x2a2c2e], 14, 1.3);
    this.fx.flashLight(tx, 1.2, tz, 0xff7a3a, 34, 0.5, 8);
    this.fx.shake = Math.min(1, this.fx.shake + 0.4);
    this.hitStop = 0.06;
    this._text(ev.x, ev.y, 'BOOM', '#ff8a5a', 1.1, 1.5);
    await this._wait(300);
    if (g !== this.gen) return;
    this._extendBlastHold();
    if (cam) { const s = this.camStack[this.camStack.length - 1]; if (s && s.tag === 'blast') s.until = Math.min(s.until, performance.now() / 1000 + 1.4); }
  }

  async _evSupply(ev) {
    const c = ev.crate;
    if (!c) return;
    const g = this.gen;
    const gm = this._addCrate({ ...c, type: c.type || 'cache' });
    if (!gm) return;
    const sfx = this.hooks.sfx;
    const fx = this.wx(c.x), fz = this.wz(c.y), gy = this._groundY(c.x, c.y);
    this.hooks.onFeed?.(`Supply drop to the ${compass(this.myRef(), c.x, c.y)}`);
    if (this._fast) return;
    const cam = this._pointCam('supply', fx, fz);
    const chute = makeChute();
    gm.add(chute);
    gm.userData.chute = chute;
    const H = 13;
    gm.position.y = gy + H;
    sfx?.stinger?.('round');
    await this._anim(1500, (t) => {
      const e = t * t * (0.4 + 0.6 * t);
      gm.position.y = gy + H * (1 - e);
      gm.rotation.y = Math.sin(t * 6) * 0.2;
      gm.rotation.z = Math.sin(t * 9) * 0.06 * (1 - t);
      if (Math.random() < 0.5) this.fx.alpha.spawn(fx, gm.position.y + 0.3, fz, 0, 0.4, 0, 1.2, 0.12, 0.4, 0.85, 0.88, 0.86, 0.35, 1, 0, 0, 1.2);
    });
    gm.position.y = gy; gm.rotation.set(0, 0, 0);
    if (g !== this.gen) { gm.remove(chute); return; }
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
      if (t >= 1 && chute.parent) { gm.remove(chute); cm.dispose(); gm.userData.chute = null; }
    });
    await this._wait(650);
    if (g !== this.gen) return;
    if (cam) this._camRelease('supply');
  }
}
