// Shop / locker / armory previews: renderPreview(canvas, opts) draws a looping
// little vignette into any 2D <canvas>. Every preview shares ONE offscreen
// WebGL renderer (no WebGL context per card): each frame the host renders the
// visible previews one after another into a corner of its own canvas and
// blits the result into the card's 2D canvas. Off-screen cards are skipped,
// and cards render at most 30 fps (FPS below; halved when many are visible).
//
// opts.kind (default: inferred as in 3.0 — dropIn → 'dropin', killFx → 'killfx', else 'unit'):
//   'unit'    { cls, skin, color?, weapon?, attachments?, camo?, charm?, spin? }  turntable soldier
//   'killfx'  { killFx, cls?, skin?, color? }    stand, take the hit, effect, respawn
//   'dropin'  { dropIn, cls?, skin?, color? }    arrival on repeat
//   'emote'   { emote, cls?, skin?, color? }     victory emote loop
//   'weapon'  { weapon, attachments?, camo?, charm? }  slow turntable of the gun (camo previews)
//   'charm'   { charm }                          close-up of the charm swinging
//   'tracer'  { tracer, color? }                 a burst of fire with the tracer cosmetic
//   'streak'  { streakSkin, streak? ('gunship'|'uav'|'cuav'|'airstrike'|'sentry'|'care') }
// color: '#rrggbb' squad colour (default amber). Call again with new opts to update in place.

import * as THREE from 'three';
import { SoldierView } from './units.js';
import { Fx } from './fx.js';
import { CosmeticFx, buildStreakModel, tickStreakModel } from './cosmeticfx.js';
import { WeaponModel, charmGeo, propMaterial } from './weapons.js';
import { tickCamos } from './camos.js';
import { findCosmetic } from '../../shared/cosmetics.js';

const MAX_PX = 384;
const FPS = 30;
let host = null;

function getHost() {
  if (host) return host;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = MAX_PX;
  let gl;
  try {
    gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
  } catch { return null; }
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  gl.setPixelRatio(1);
  gl.setSize(MAX_PX, MAX_PX, false);
  gl.setClearColor(0x000000, 0);
  host = { gl, canvas, size: MAX_PX, entries: new Map(), raf: 0, last: 0, acc: 0, t: 0 };
  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  return host;
}

function colorHex(c) {
  if (typeof c === 'number') return c;
  if (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c)) return parseInt(c.replace('#', ''), 16);
  return 0xffb000;
}
function inferKind(o) {
  if (o.kind) return String(o.kind).toLowerCase().replace(/[-_ ]/g, '');
  if (o.dropIn && o.dropIn !== 'default') return 'dropin';
  if (o.killFx && o.killFx !== 'default') return 'killfx';
  if (o.dropIn) return 'dropin';
  return 'unit';
}

let pedGeo = null, pedMat = null, pedRingGeo = null, pedRingMat = null, dummyGeo = null, dummyMat = null;
function shared() {
  if (pedGeo) return;
  pedGeo = new THREE.CylinderGeometry(0.75, 0.8, 0.08, 40); pedGeo.translate(0, -0.04, 0);
  pedMat = new THREE.MeshStandardMaterial({ color: 0x24363b, roughness: 0.85, metalness: 0.1 });
  pedRingGeo = new THREE.RingGeometry(0.74, 0.79, 64); pedRingGeo.rotateX(-Math.PI / 2);
  pedRingMat = new THREE.MeshBasicMaterial({ color: 0x8fb4b8, transparent: true, opacity: 0.55 });
  dummyGeo = new THREE.BoxGeometry(0.5, 0.7, 0.08); dummyGeo.translate(0, 0.75, 0);
  dummyMat = new THREE.MeshStandardMaterial({ color: 0xb0582f, roughness: 0.8 });
  for (const o of [pedGeo, pedMat, pedRingGeo, pedRingMat, dummyGeo, dummyMat]) o.userData.shared = true;
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

class PreviewStage {
  constructor(canvas) {
    shared();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.05, 80);
    const hemi = new THREE.HemisphereLight(0xcfe4ea, 0x3a3028, 1.5);
    const key = new THREE.DirectionalLight(0xffdcae, 2.8); key.position.set(-2, 3.2, 2.6);
    const rim = new THREE.DirectionalLight(0x9fd8ff, 2.0); rim.position.set(2.2, 2, -3);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6); fill.position.set(1.5, 0.5, 3);
    this.scene.add(hemi, key, rim, fill);
    this.ped = new THREE.Group();
    const disc = new THREE.Mesh(pedGeo, pedMat);
    const ring = new THREE.Mesh(pedRingGeo, pedRingMat); ring.position.y = 0.002;
    this.ped.add(disc, ring);
    this.scene.add(this.ped);
    this.content = new THREE.Group();
    this.scene.add(this.content);
    this.fx = new Fx(this.scene, this.scene, { add: 600, alpha: 500, debris: 40, texts: 0, scale: 0.8 });
    this.cfx = new CosmeticFx(this.fx, this.scene, { flash: (k) => { this.flash = Math.max(this.flash, k); } });
    this.flash = 0;
    this.view = null; this.key = ''; this.model = null; this.extra = [];
    this.t = 0; this.loopT = 0; this.phase = 'idle'; this.ctl = null;
  }

  _clearContent() {
    if (this.ctl) { try { this.ctl.end(); } catch { /* ignore */ } this.ctl = null; }
    this.fx.clear(); this.cfx.clear();
    if (this.view) { this.view.stopEmote(); this.view.root.parent?.remove(this.view.root); this.view.dispose(); this.view = null; }
    if (this.target) { this.target.root.parent?.remove(this.target.root); this.target.dispose(); this.target = null; }
    for (const o of this.extra) { o.parent?.remove(o); o.traverse?.((c) => { if (c.geometry && !c.geometry.userData?.shared) c.geometry.dispose(); }); }
    this.extra = [];
    this.model = null;
    this.content.clear();
  }

  _soldier(o, cls) {
    const v = new SoldierView({ id: 0, cls: cls || o.cls || 'assault', isLoneWolf: false, hunkered: false, downed: false },
      { color: colorHex(o.color), skin: o.skin || 'default', camo: o.camo, charm: o.charm, weapon: o.weapon, attachments: o.attachments, cos: { emote: o.emote } });
    v.ring.visible = true;
    this.content.add(v.root);
    return v;
  }

  setOpts(o) {
    this.opts = o;
    const kind = inferKind(o);
    const key = [kind, o.cls, o.skin, colorHex(o.color), typeof o.weapon === 'object' ? o.weapon?.id : o.weapon, JSON.stringify(o.attachments || {}), o.camo, o.charm, o.killFx, o.dropIn, o.emote, o.tracer, o.streakSkin, o.streak].join('|');
    if (key === this.key) return;
    this.key = key; this.kind = kind;
    this._clearContent();
    this.ped.visible = true;
    this.t = 0; this.loopT = 0; this.phase = 'idle';
    const cam = this.camera;
    switch (kind) {
      case 'weapon': {
        this.ped.visible = false;
        const m = (this.model = new WeaponModel({ weapon: o.weapon, attachments: o.attachments || {}, camo: o.camo, charm: o.charm }));
        const len = m.length, mz = m.muzzle.position.z;
        const s = 1.12 / Math.max(0.45, len);
        m.group.scale.setScalar(s);
        this.pivot = new THREE.Group(); this.pivot.add(m.group);
        m.group.position.set(0, -0.04 * s, -((mz - 0.25) / 2) * s);
        this.content.add(this.pivot);
        cam.fov = 26; cam.position.set(0, 0.55, 3.6); cam.lookAt(0, 0, 0);
        break;
      }
      case 'charm': {
        this.ped.visible = false;
        const g = new THREE.Group();
        const hook = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.018, 6, 16), propMaterial());
        hook.position.y = 0.02; g.add(hook); this.extra.push(hook);
        const c = new THREE.Mesh(charmGeo(o.charm && o.charm !== 'default' ? o.charm : 'tags'), propMaterial());
        c.scale.setScalar(9);
        this.charmMesh = c; g.add(c);
        g.position.y = 0.42;
        this.content.add(g);
        cam.fov = 24; cam.position.set(0, 0.1, 2.6); cam.lookAt(0, 0.05, 0);
        break;
      }
      case 'tracer': {
        this.ped.visible = false;
        const m = (this.model = new WeaponModel({ weapon: 'tr7', attachments: { optic: 'reflex' }, camo: 'none' }));
        const d = new THREE.Mesh(dummyGeo, dummyMat); d.position.set(0.45, 0.05, -3.2);
        m.group.position.set(-0.42, 0.42, 1.25); m.group.scale.setScalar(1.6);
        m.group.lookAt(d.position.x, 0.85, d.position.z);
        this.content.add(m.group, d); this.dummy = d;
        cam.fov = 32; cam.position.set(0.15, 0.95, 3.2); cam.lookAt(0.0, 0.62, -1.0);
        break;
      }
      case 'streak': {
        this.ped.visible = false;
        const sk = o.streakSkin || 'default';
        const it = findCosmetic('streakSkin', sk);
        const kindS = o.streak || (it && it.streak !== 'all' ? it.streak : 'gunship');
        const m = buildStreakModel(kindS, sk);
        const air = kindS !== 'sentry' && kindS !== 'care';
        const scale = { gunship: 0.5, uav: 0.8, cuav: 1.6, airstrike: 0.62, sentry: 1.2, care: 1.4 }[kindS] || 0.6;
        m.scale.setScalar(scale);
        this.pivot = new THREE.Group(); this.pivot.add(m); this.model = m; this.air = air;
        if (!air) { this.ped.visible = true; m.position.y = 0; }
        this.content.add(this.pivot);
        // frame the model's bounding sphere
        const sph = new THREE.Box3().setFromObject(m).getBoundingSphere(new THREE.Sphere());
        const half = Math.atan(Math.tan((28 / 2) * Math.PI / 180) * 0.78); // fit the narrow (portrait) axis
        const dist = sph.radius / Math.sin(half) * 0.92;
        cam.fov = 28; cam.position.set(0, sph.center.y + dist * 0.38, dist * 0.93); cam.lookAt(0, sph.center.y * (air ? 1 : 0.8), 0);
        break;
      }
      case 'killfx': case 'dropin': case 'emote': {
        this.view = this._soldier(o);
        this.view.root.rotation.y = 0.5;
        const wide = kind !== 'emote';
        cam.fov = 28; cam.position.set(0, wide ? 1.55 : 1.25, wide ? 4.4 : 3.6); cam.lookAt(0, wide ? 0.7 : 0.6, 0);
        if (kind === 'emote') { this.view.root.rotation.y = 0.25; this.view.playEmote(o.emote || 'default', { fx: this.fx }); this.view.update(0.016, 0); }
        if (kind === 'emote' && (o.emote === 'fireworks')) { cam.position.set(0, 1.6, 4.6); cam.lookAt(0, 1.1, 0); }
        break;
      }
      default: { // unit
        this.view = this._soldier(o);
        this.view.root.rotation.y = 0.5;
        cam.fov = 28; cam.position.set(0, 1.15, 3.2); cam.lookAt(0, 0.52, 0);
      }
    }
    cam.updateProjectionMatrix();
  }

  step(dt) {
    this.t += dt; this.loopT += dt;
    const v = this.view, o = this.opts, k = this.kind;
    if (k === 'unit') {
      if (o.spin !== false) v.root.rotation.y = 0.5 + this.t * 0.7;
    } else if (k === 'killfx') {
      if (this.phase === 'idle' && this.loopT > 0.9) {
        this.phase = 'dead';
        v.doFlinch(1, 0, -1);
        v.die(1, 'back');
        this.cfx.killEffect(o.killFx, v);
      }
      if (this.phase === 'dead' && this.loopT > 3.4) { this.fx.clear(); this.cfx.clear(); v.revive(); v.root.position.set(0, 0, 0); v.root.rotation.set(0, 0.5, 0); this.loopT = 0; this.phase = 'idle'; }
    } else if (k === 'dropin') {
      if (!this.ctl && this.phase === 'idle') {
        this.ctl = this.cfx.dropIn(o.dropIn || 'default', v, new THREE.Vector3(0, 0, 0), { h: 0.3, from: { x: 0.7, z: 0.7 } });
        this.phase = 'run'; this.loopT = 0;
      }
      if (this.ctl) {
        this.ctl.update(this.loopT);
        if (this.loopT >= this.ctl.dur) { this.ctl.end(); this.ctl = null; this.phase = 'hold'; this.loopT = 0; }
      } else if (this.phase === 'hold' && this.loopT > 1.1) { this.fx.clear(); this.cfx.clear(); v.revive(); v.root.rotation.set(0, 0.5, 0); this.phase = 'idle'; }
    } else if (k === 'emote') {
      v.root.rotation.y = 0.25 + Math.sin(this.t * 0.4) * 0.25;
    } else if (k === 'weapon') {
      this.pivot.rotation.set(Math.sin(this.t * 0.6) * 0.06, -Math.PI / 2 + 0.35 + Math.sin(this.t * 0.45) * 0.55, 0);
      this.model.update(dt, this.t);
    } else if (k === 'charm') {
      const c = this.charmMesh;
      c.rotation.set(Math.sin(this.t * 2.2) * 0.25, this.t * 0.9, Math.sin(this.t * 1.7) * 0.3);
      if (o.charm === 'gem') c.rotation.y = this.t * 2;
    } else if (k === 'tracer') {
      // 3-round burst every second
      const ph = this.loopT % 1.0;
      const shot = Math.floor(ph / 0.12);
      const m = this.model;
      if (ph < 0.36 && shot !== this._lastShot) {
        this._lastShot = shot;
        m.group.updateMatrixWorld(true);
        m.muzzle.getWorldPosition(_v);
        const D = this.dummy.position;
        _v2.set(D.x + (Math.random() - 0.5) * 0.3, 0.8 + (Math.random() - 0.5) * 0.35, D.z + 0.05);
        const dx = _v2.x - _v.x, dz = _v2.z - _v.z, l = Math.hypot(dx, dz) || 1;
        this.fx.muzzle(_v.x, _v.y, _v.z, dx / l, dz / l, 0.5);
        this.cfx.tracer(o.tracer || 'default', _v.x, _v.y, _v.z, _v2.x, _v2.y, _v2.z, colorHex(o.color), 0.05, 0.35);
        this.fx.sparks(_v2.x, _v2.y, _v2.z + 0.06, 8, 5, 3.2, 1.4, 3);
        this.kick = 1;
      }
      this.kick = Math.max(0, (this.kick || 0) - dt * 8);
      m.group.position.set(-0.42, 0.42, 1.25 + this.kick * 0.04);
      if (ph > 0.4) this._lastShot = -1;
    } else if (k === 'streak') {
      const m = this.model;
      this.pivot.rotation.y = 0.6 + this.t * 0.5;
      if (this.air) { m.position.y = Math.sin(this.t * 1.6) * 0.05; m.rotation.z = Math.sin(this.t * 1.1) * 0.05; }
      tickStreakModel(m, this.t);
    }
    if (v) v.update(dt, this.t);
    this.fx.update(dt, null);
    this.flash = Math.max(0, this.flash - dt * 3);
  }

  dispose() {
    this._clearContent();
    this.fx.dispose();
    this.scene.traverse((o) => { if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose(); if (o.material && !o.material.userData?.shared && !Array.isArray(o.material)) o.material.dispose(); });
  }
}

function frame(now) {
  const H = host;
  H.raf = 0;
  if (!H.entries.size) return;
  H.raf = requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - (H.last || now)) / 1000);
  H.last = now;
  H.acc += dt;
  // many cards on screen (store grid): drop to half rate to stay cheap on phones
  let visible = 0;
  const rects = [];
  for (const [canvas] of H.entries) {
    if (!canvas.isConnected) { rects.push(null); continue; }
    const r = canvas.getBoundingClientRect();
    const on = !(r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth);
    rects.push(on ? r : null);
    if (on) visible++;
  }
  const fps = visible > 8 ? FPS / 2 : FPS;
  if (H.acc < 1 / fps) return;
  const step = Math.min(0.1, H.acc);
  H.acc = 0;
  H.t += step;
  tickCamos(H.t);
  const gl = H.gl;
  if (gl.getContext().isContextLost?.()) return;
  let i = 0;
  for (const [canvas, st] of [...H.entries]) {
    const r = rects[i++];
    if (!canvas.isConnected) { stopPreview(canvas); continue; }
    if (!r) continue;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(16, Math.min(MAX_PX, Math.round(r.width * dpr))), h = Math.max(16, Math.min(MAX_PX, Math.round(r.height * dpr)));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    st.step(step);
    st.camera.aspect = w / h; st.camera.updateProjectionMatrix();
    gl.toneMappingExposure = 1 + st.flash * 0.8;
    gl.setViewport(0, 0, w, h); gl.setScissor(0, 0, w, h); gl.setScissorTest(true);
    gl.clear();
    gl.render(st.scene, st.camera);
    gl.setScissorTest(false);
    st.ctx.clearRect(0, 0, w, h);
    st.ctx.drawImage(H.canvas, 0, H.size - h, w, h, 0, 0, w, h);
  }
}

/** Start (or update) a looping preview in a 2D canvas. Safe to call repeatedly with new opts. */
export function renderPreview(canvas, opts = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') return false;
  const H = getHost();
  if (!H) return false;
  let st = H.entries.get(canvas);
  if (!st) {
    try { st = new PreviewStage(canvas); } catch { return false; }
    H.entries.set(canvas, st);
  }
  try { st.setOpts({ ...opts }); } catch (e) { console.warn('renderPreview', e); return false; }
  if (!H.raf) { H.last = 0; H.raf = requestAnimationFrame(frame); }
  return true;
}

/** Stop a preview and free its scene (the shared renderer stays). */
export function stopPreview(canvas) {
  if (!host) return;
  const st = host.entries.get(canvas);
  if (!st) return;
  host.entries.delete(canvas);
  st.dispose();
  if (!host.entries.size && host.raf) { cancelAnimationFrame(host.raf); host.raf = 0; }
}

/** Stop every preview (e.g. when leaving the shop). */
export function stopAllPreviews() { if (host) for (const c of [...host.entries.keys()]) stopPreview(c); }

/** Kinds renderPreview understands (for UI feature checks). */
export const PREVIEW_KINDS = ['unit', 'weapon', 'killfx', 'dropin', 'emote', 'charm', 'tracer', 'streak'];
