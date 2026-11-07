// Shop / locker previews: renderPreview(canvas, opts) draws a looping little
// vignette of a soldier into any 2D <canvas>. Every preview shares ONE
// offscreen WebGL renderer (no WebGL context per card): each frame the host
// renders the visible previews one after another into a corner of its own
// canvas and blits the result into the card's 2D canvas.
//
// opts: { cls, skin, killFx?, dropIn?, color? ('#rrggbb' squad colour, default amber), spin? (default true) }
// Loops: plain → turntable; killFx → stand, take the hit, effect, respawn; dropIn → arrival on repeat.

import * as THREE from 'three';
import { SoldierView } from './units.js';
import { Fx } from './fx.js';
import { CosmeticFx } from './cosmeticfx.js';

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
  host = { gl, canvas, size: MAX_PX, entries: new Map(), raf: 0, last: 0, acc: 0 };
  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  return host;
}

function colorHex(c) {
  if (typeof c === 'number') return c;
  if (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c)) return parseInt(c.replace('#', ''), 16);
  return 0xffb000;
}

class PreviewStage {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 60);
    const hemi = new THREE.HemisphereLight(0xbfd8e0, 0x3a3028, 1.4);
    const key = new THREE.DirectionalLight(0xffd2a0, 2.6); key.position.set(-2, 3, 2.5);
    const rim = new THREE.DirectionalLight(0x9fd8ff, 1.6); rim.position.set(2, 2, -3);
    this.scene.add(hemi, key, rim);
    // pedestal: soft disc + thin ring
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.75, 40), new THREE.MeshStandardMaterial({ color: 0x24363b, roughness: 0.9 }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = -0.005;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.72, 0.76, 48), new THREE.MeshBasicMaterial({ color: 0x6f8a8c, transparent: true, opacity: 0.6 }));
    ring.rotation.x = -Math.PI / 2;
    this.scene.add(disc, ring);
    this.fx = new Fx(this.scene, this.scene, { add: 500, alpha: 500, debris: 40, texts: 0, scale: 0.8 });
    this.cfx = new CosmeticFx(this.fx, this.scene, { flash: (k) => { this.flash = Math.max(this.flash, k); } });
    this.flash = 0;
    this.view = null; this.key = '';
    this.t = 0; this.loopT = 0; this.phase = 'idle'; this.ctl = null;
  }

  setOpts(o) {
    this.opts = o;
    const key = [o.cls, o.skin, colorHex(o.color)].join('|');
    if (key !== this.key) {
      this.key = key;
      if (this.view) { this.scene.remove(this.view.root); this.view.dispose(); }
      this.view = new SoldierView({ id: 0, cls: o.cls || 'assault', isLoneWolf: false, hunkered: false, downed: false }, { color: colorHex(o.color), skin: o.skin || 'default' });
      this.view.ring.visible = true;
      this.scene.add(this.view.root);
    }
    const mode = o.dropIn && o.dropIn !== 'default' ? 'drop' : o.killFx && o.killFx !== 'default' ? 'kill' : o.dropIn ? 'drop' : 'spin';
    if (mode !== this.mode || o.dropIn !== this._d || o.killFx !== this._k) { this.mode = mode; this._d = o.dropIn; this._k = o.killFx; this._reset(); }
    const wide = mode !== 'spin';
    this.camera.position.set(0, wide ? 1.55 : 1.15, wide ? 4.4 : 3.2);
    this.camera.lookAt(0, wide ? 0.7 : 0.52, 0);
  }

  _reset() {
    this.fx.clear(); this.cfx.clear();
    if (this.ctl) { this.ctl.end(); this.ctl = null; }
    const v = this.view;
    v.revive(); v.ring.visible = true;
    v.root.position.set(0, 0, 0);
    v.root.rotation.set(0, 0.5, 0);
    this.loopT = 0; this.phase = 'idle';
  }

  step(dt) {
    this.t += dt; this.loopT += dt;
    const v = this.view, o = this.opts;
    if (this.mode === 'spin') {
      if (o.spin !== false) v.root.rotation.y = 0.5 + this.t * 0.7;
    } else if (this.mode === 'kill') {
      // 0–0.9 idle, 0.9 the hit + effect + fall, 3.4 respawn
      if (this.phase === 'idle' && this.loopT > 0.9) {
        this.phase = 'dead';
        v.doFlinch(1, 0, -1);
        v.die(1);
        this.cfx.killEffect(o.killFx, v);
      }
      if (this.phase === 'dead' && this.loopT > 3.4) this._reset();
    } else if (this.mode === 'drop') {
      if (!this.ctl && this.phase === 'idle') {
        this.ctl = this.cfx.dropIn(o.dropIn || 'default', v, new THREE.Vector3(0, 0, 0), { h: 0.3, from: { x: 0.7, z: 0.7 } });
        this.phase = 'run'; this.loopT = 0;
      }
      if (this.ctl) {
        this.ctl.update(this.loopT);
        if (this.loopT >= this.ctl.dur) { this.ctl.end(); this.ctl = null; this.phase = 'hold'; this.loopT = 0; }
      } else if (this.phase === 'hold' && this.loopT > 1.1) { this.fx.clear(); this.cfx.clear(); this.phase = 'idle'; }
    }
    v.update(dt, this.t);
    this.fx.update(dt, null);
    this.flash = Math.max(0, this.flash - dt * 3);
  }

  dispose() {
    if (this.ctl) { try { this.ctl.end(); } catch { /* ignore */ } }
    this.cfx.clear();
    this.fx.dispose();
    this.view?.dispose();
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
  if (H.acc < 1 / FPS) return;
  const step = Math.min(0.1, H.acc);
  H.acc = 0;
  const gl = H.gl;
  if (gl.getContext().isContextLost?.()) return;
  for (const [canvas, st] of H.entries) {
    if (!canvas.isConnected) { stopPreview(canvas); continue; }
    const r = canvas.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
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
  st.setOpts({ ...opts });
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
