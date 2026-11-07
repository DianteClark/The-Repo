// 2.5D isometric renderer (Three.js, orthographic camera, rotates in 90° steps).
// Reads sim state; keeps its own "displayed" positions so animations and fog
// stay in sync with what the player has actually been shown.

import * as THREE from 'three';
import { canSeeTile } from '../sim/rules.js';
import { SIGHT } from '../sim/constants.js';

const C = {
  bg: 0x14232a,
  ground: new THREE.Color(0x56675f),
  groundAlt: new THREE.Color(0x5c6d64),
  half: 0x8a5a3c,
  full: 0xc6bda6,
  water: 0x2a87a0,
  amber: 0xffb000,
  magenta: 0xff3fa4,
  cyan: 0x7fe9ff,
  move1: new THREE.Color(0x3fb0c4),
  move2: new THREE.Color(0xc4a640),
  tide: new THREE.Color(0x2f6670),
  fogDark: 0.42,
};
const CLASS_BODY = { assault: 0x5f7d84, marksman: 0x8d8660, breacher: 0x5d6680 };

export class Renderer {
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.hooks = hooks; // onTileTap(x,y), onUnitTap(id), onFeed(msg), sfx
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(C.bg);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -200, 400);
    this.viewSize = 15;
    this.camAngle = 0;
    this.camAngleGoal = 0;
    this.target = new THREE.Vector3();
    this.targetGoal = new THREE.Vector3();
    this.speed = 1;
    this.anims = [];
    this.world = null;

    this.scene.add(new THREE.HemisphereLight(0xe4efe9, 0x26363a, 1.25));
    const sun = new THREE.DirectionalLight(0xffe0b5, 1.7);
    sun.position.set(12, 22, 6);
    this.scene.add(sun);

    this.raycaster = new THREE.Raycaster();
    this._setupInput();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this._last = performance.now();
    const loop = (now) => { this._frame(now); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  // ---------- setup ----------

  setGame(state, myTeam) {
    if (this.world) { this.scene.remove(this.world); this._dispose(this.world); }
    this.anims = [];
    this.state = state;
    this.myTeam = myTeam;
    this.spectator = myTeam < 0;
    this.highlight = null;
    const S = (this.S = state.map.size);
    this.world = new THREE.Group();
    this.scene.add(this.world);

    const n = S * S;
    const m4 = new THREE.Matrix4();
    // Ground tiles
    this.tiles = new THREE.InstancedMesh(new THREE.BoxGeometry(0.96, 0.3, 0.96), new THREE.MeshLambertMaterial(), n);
    this.baseColor = [];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const k = y * S + x;
      m4.makeTranslation(this.wx(x), -0.15, this.wz(y));
      this.tiles.setMatrixAt(k, m4);
      this.baseColor[k] = ((x + y) % 2 ? C.ground : C.groundAlt).clone().offsetHSL(0, 0, (hash(k) - 0.5) * 0.04);
    }
    this.world.add(this.tiles);

    // Cover
    const cover = state.map.cover;
    const halfIdx = [], fullIdx = [];
    for (let k = 0; k < n; k++) { if (cover[k] === 1) halfIdx.push(k); else if (cover[k] === 2) fullIdx.push(k); }
    const half = new THREE.InstancedMesh(new THREE.BoxGeometry(0.78, 0.55, 0.78), new THREE.MeshLambertMaterial(), Math.max(1, halfIdx.length));
    const full = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), Math.max(1, fullIdx.length));
    const col = new THREE.Color();
    halfIdx.forEach((k, i) => {
      const x = k % S, y = (k / S) | 0;
      m4.makeRotationY((hash(k) - 0.5) * 0.5).setPosition(this.wx(x), 0.275, this.wz(y));
      half.setMatrixAt(i, m4);
      half.setColorAt(i, col.set(C.half).offsetHSL(0, 0, (hash(k + 7) - 0.5) * 0.1));
    });
    fullIdx.forEach((k, i) => {
      const x = k % S, y = (k / S) | 0;
      const h = state.map.wallHeight[k];
      m4.makeScale(1, h, 1).setPosition(this.wx(x), h / 2, this.wz(y));
      full.setMatrixAt(i, m4);
      full.setColorAt(i, col.set(C.full).offsetHSL(0, 0, (hash(k + 3) - 0.5) * 0.08));
    });
    this.world.add(half, full);
    this.fullMesh = full;

    // Water (the Surge) — one instance per tile, scaled to 0 when dry.
    this.water = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 0.14, 1),
      new THREE.MeshLambertMaterial({ color: C.water, transparent: true, opacity: 0.85 }), n);
    this.waterLevel = new Float32Array(n); // 0..1 animated
    this.waterGoal = new Float32Array(n);
    this.world.add(this.water);

    // Zone rings: white foam = current edge, cyan = next edge.
    this.ringNow = makeCircle(0xffffff, 0.9);
    this.ringNext = makeCircle(C.cyan, 0.7);
    this.world.add(this.ringNow, this.ringNext);

    // Crates
    this.crateMeshes = new Map();
    for (const c of state.crates) if (!c.taken) this._addCrate(c);

    // Units
    this.disp = state.units.map((u) => ({ x: u.x, y: u.y, alive: u.alive }));
    this.unitObjs = state.units.map((u) => this._makeUnit(u));

    // "You" marker
    this.marker = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.34, 4), new THREE.MeshBasicMaterial({ color: C.amber }));
    this.marker.rotation.x = Math.PI;
    this.world.add(this.marker);

    this.fx = new THREE.Group();
    this.world.add(this.fx);

    this._updateZone(true);
    this.refreshFog();
    const me = state.units.find((u) => u.isPlayer) || state.units[0];
    this.focus(me.x, me.y, true);
  }

  wx(x) { return x - this.S / 2 + 0.5; }
  wz(y) { return y - this.S / 2 + 0.5; }

  _makeUnit(u) {
    const g = new THREE.Group();
    const mine = u.team === this.myTeam;
    const teamCol = mine ? C.amber : C.magenta;
    const bodyMat = new THREE.MeshLambertMaterial({ color: CLASS_BODY[u.cls] });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x2a2f33 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.29, 0.6, 10), bodyMat);
    body.position.y = 0.36;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), new THREE.MeshLambertMaterial({ color: 0xd9c6a8 }));
    head.position.y = 0.82;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.08), new THREE.MeshBasicMaterial({ color: teamCol }));
    visor.position.set(0, 0.85, 0.13);
    g.add(body, head, visor);
    // Class silhouettes
    if (u.cls === 'assault') {
      const pack = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.34, 0.16), darkMat);
      pack.position.set(0, 0.5, -0.24);
      const gun = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.55), darkMat);
      gun.position.set(0.22, 0.5, 0.22);
      g.add(pack, gun);
    } else if (u.cls === 'marksman') {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.75, 6), darkMat);
      mast.position.set(-0.14, 1.05, -0.12);
      const gun = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.95), darkMat);
      gun.position.set(0.22, 0.55, 0.3);
      g.add(mast, gun);
    } else {
      const shield = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.62, 0.08), new THREE.MeshLambertMaterial({ color: 0x7a7f87 }));
      shield.position.set(0, 0.42, 0.32);
      g.add(shield);
    }
    // Team ring (lone wolf gets a double ring)
    const ringMat = new THREE.MeshBasicMaterial({ color: teamCol, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.33, 0.44, 28), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    g.add(ring);
    if (u.isLoneWolf) {
      const r2 = new THREE.Mesh(new THREE.RingGeometry(0.48, 0.52, 28), ringMat);
      r2.rotation.x = -Math.PI / 2;
      r2.position.y = 0.03;
      g.add(r2);
    }
    // Label
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 72;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    label.scale.set(1.7, 0.48, 1);
    label.position.y = 1.45;
    label.renderOrder = 10;
    g.add(label);
    g.position.set(this.wx(u.x), 0, this.wz(u.y));
    g.userData.unitId = u.id;
    this.world.add(g);
    const obj = { g, label, canvas, tex, body };
    this._drawLabel(u, obj);
    return obj;
  }

  _drawLabel(u, obj = this.unitObjs[u.id]) {
    const ctx = obj.canvas.getContext('2d');
    const mine = u.team === this.myTeam;
    ctx.clearRect(0, 0, 256, 72);
    ctx.font = 'bold 24px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(10,18,22,0.75)';
    roundRect(ctx, 18, 2, 220, 66, 12); ctx.fill();
    ctx.fillStyle = mine ? '#ffb000' : '#ff3fa4';
    const tag = mine ? u.name : `S${u.team + 1} · ${u.name}`;
    ctx.fillText(tag + (u.overwatch ? '  👁' : ''), 128, 28);
    // HP pips
    const w = 196, x0 = 30, y0 = 40, n = u.maxHp;
    const gap = 2, pw = (w - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = i < u.hp ? (mine ? '#ffb000' : '#ff3fa4') : 'rgba(255,255,255,0.15)';
      ctx.fillRect(x0 + i * (pw + gap), y0, pw, 12);
    }
    if (u.armor > 0) {
      ctx.fillStyle = '#7fe9ff';
      ctx.font = 'bold 16px system-ui, sans-serif';
      ctx.fillText('◆'.repeat(Math.min(4, u.armor)), 128, 66);
    }
    obj.tex.needsUpdate = true;
  }

  _addCrate(c) {
    const g = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.32, 0.42),
      new THREE.MeshLambertMaterial({ color: 0x3d8c99, emissive: 0x0f4a55 }));
    box.position.y = 0.16;
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.06, 0.44), new THREE.MeshBasicMaterial({ color: C.cyan }));
    band.position.y = 0.2;
    g.add(box, band);
    g.position.set(this.wx(c.x), 0, this.wz(c.y));
    this.world.add(g);
    this.crateMeshes.set(c.id, g);
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

  setSpectator(on) { this.spectator = on; this.refreshFog(); }

  refreshFog() {
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
    for (const u of st.units) this._syncUnitVisibility(u);
    this._paintTiles();
  }

  _syncUnitVisibility(u) {
    const d = this.disp[u.id];
    const o = this.unitObjs[u.id];
    o.g.visible = d.alive && (u.team === this.myTeam || this.fogMask[d.y * this.S + d.x] === 1);
  }

  setHighlights(map) { this.highlight = map; this._paintTiles(); }

  _paintTiles() {
    const S = this.S, z = this.state.zone, col = new THREE.Color();
    for (let k = 0; k < S * S; k++) {
      const x = k % S, y = (k / S) | 0;
      col.copy(this.baseColor[k]);
      const dz = Math.hypot(x - z.x, y - z.y);
      if (dz <= z.r && dz > z.next) col.lerp(C.tide, 0.45);
      const h = this.highlight && this.highlight.get(k);
      if (h === 1) col.lerp(C.move1, 0.6);
      else if (h === 2) col.lerp(C.move2, 0.55);
      if (!this.fogMask[k]) col.multiplyScalar(C.fogDark);
      this.tiles.setColorAt(k, col);
    }
    this.tiles.instanceColor.needsUpdate = true;
  }

  _updateZone(instant) {
    const S = this.S, z = this.state.zone;
    for (let k = 0; k < S * S; k++) {
      const x = k % S, y = (k / S) | 0;
      this.waterGoal[k] = Math.hypot(x - z.x, y - z.y) > z.r ? 1 : 0;
      if (instant) this.waterLevel[k] = this.waterGoal[k];
    }
    this.ringNow.scale.setScalar(Math.max(0.01, z.r));
    this.ringNext.scale.setScalar(Math.max(0.01, z.next));
    this.ringNow.position.set(this.wx(z.x), 0.06, this.wz(z.y));
    this.ringNext.position.set(this.wx(z.x), 0.05, this.wz(z.y));
    this._paintWater(0);
    if (this.tiles.instanceColor) this._paintTiles();
  }

  _paintWater(t) {
    const S = this.S, m4 = new THREE.Matrix4();
    for (let k = 0; k < S * S; k++) {
      const lvl = this.waterLevel[k];
      const x = k % S, y = (k / S) | 0;
      if (lvl <= 0.001) m4.makeScale(0, 0, 0);
      else m4.makeScale(1, lvl, 1).setPosition(this.wx(x), 0.07 * lvl + Math.sin(t * 1.6 + x * 0.6 + y * 0.4) * 0.03, this.wz(y));
      this.water.setMatrixAt(k, m4);
    }
    this.water.instanceMatrix.needsUpdate = true;
  }

  /** Snap everything to the sim state (used after fast-forward). */
  syncFromState() {
    const st = this.state;
    st.units.forEach((u, i) => {
      this.disp[i] = { x: u.x, y: u.y, alive: u.alive };
      this.unitObjs[i].g.position.set(this.wx(u.x), 0, this.wz(u.y));
      this._drawLabel(u);
    });
    for (const c of st.crates) {
      if (c.taken && this.crateMeshes.has(c.id)) { this.world.remove(this.crateMeshes.get(c.id)); this.crateMeshes.delete(c.id); }
      else if (!c.taken && !this.crateMeshes.has(c.id)) this._addCrate(c);
    }
    this._updateZone(true);
    this.refreshFog();
  }

  // ---------- camera ----------

  focus(x, y, instant = false) {
    this.targetGoal.set(this.wx(x), 0, this.wz(y));
    if (instant) this.target.copy(this.targetGoal);
  }
  rotate(dir) { this.camAngleGoal += dir; }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.gl.setSize(w, h, false);
    this.aspect = w / h;
    // Portrait phones get a slightly wider view.
    this.viewScale = this.aspect < 1 ? 1.25 : 1;
    this._updateCamera();
  }

  _updateCamera() {
    const v = this.viewSize * this.viewScale;
    this.camera.left = (-v * this.aspect) / 2;
    this.camera.right = (v * this.aspect) / 2;
    this.camera.top = v / 2;
    this.camera.bottom = -v / 2;
    this.camera.updateProjectionMatrix();
    const a = Math.PI / 4 + this.camAngle * (Math.PI / 2);
    const e = 0.62; // elevation (~35°)
    const d = 60;
    this.camera.position.set(
      this.target.x + Math.cos(a) * Math.cos(e) * d,
      this.target.y + Math.sin(e) * d,
      this.target.z + Math.sin(a) * Math.cos(e) * d);
    this.camera.lookAt(this.target);
  }

  // ---------- input ----------

  _setupInput() {
    const el = this.canvas;
    const pts = new Map();
    let dragged = false, pinch0 = 0, view0 = 0;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
      if (pts.size === 1) dragged = false;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
        view0 = this.viewSize;
        dragged = true;
      }
    });
    el.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch0 > 0) this.viewSize = clamp(view0 * (pinch0 / d), 6, 34);
        return;
      }
      if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 8) dragged = true;
      if (dragged) this._pan(dx, dy);
    });
    const up = (e) => {
      const p = pts.get(e.pointerId);
      pts.delete(e.pointerId);
      if (p && !dragged && pts.size === 0) this._tap(e.clientX, e.clientY);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', (e) => pts.delete(e.pointerId));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.viewSize = clamp(this.viewSize * (1 + Math.sign(e.deltaY) * 0.1), 6, 34);
    }, { passive: false });
  }

  _pan(dx, dy) {
    const k = (this.viewSize * this.viewScale) / window.innerHeight;
    const a = Math.PI / 4 + this.camAngle * (Math.PI / 2);
    // camera right & forward on the ground plane
    const rx = -Math.sin(a), rz = Math.cos(a);
    const fx = -Math.cos(a), fz = -Math.sin(a);
    const fy = 1 / Math.sin(0.62);
    this.targetGoal.x -= (rx * dx - fx * dy * fy) * k;
    this.targetGoal.z -= (rz * dx - fz * dy * fy) * k;
    this.target.copy(this.targetGoal);
  }

  _tap(cx, cy) {
    if (!this.state) return;
    const ndc = new THREE.Vector2((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const groups = this.unitObjs.filter((o) => o.g.visible).map((o) => o.g);
    const hit = this.raycaster.intersectObjects(groups, true).find((h) => !(h.object instanceof THREE.Sprite));
    if (hit) {
      let o = hit.object;
      while (o && o.userData.unitId === undefined) o = o.parent;
      if (o) { this.hooks.onUnitTap?.(o.userData.unitId); return; }
    }
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, p)) return;
    const x = Math.floor(p.x + this.S / 2), y = Math.floor(p.z + this.S / 2);
    if (x >= 0 && y >= 0 && x < this.S && y < this.S) this.hooks.onTileTap?.(x, y);
  }

  // ---------- animation ----------

  _anim(dur, fn) {
    return new Promise((resolve) => {
      this.anims.push({ t0: performance.now(), dur: Math.max(1, dur / this.speed), fn, resolve });
    });
  }

  _frame(now) {
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i];
      const t = Math.min(1, (now - a.t0) / a.dur);
      a.fn(t);
      if (t >= 1) { this.anims.splice(i, 1); a.resolve(); }
    }
    if (this.state) {
      // camera easing
      this.target.lerp(this.targetGoal, 1 - Math.pow(0.001, dt));
      this.camAngle += (this.camAngleGoal - this.camAngle) * (1 - Math.pow(0.0005, dt));
      // water rise/fall + bob
      let changed = false;
      for (let k = 0; k < this.waterLevel.length; k++) {
        const g = this.waterGoal[k], l = this.waterLevel[k];
        if (Math.abs(g - l) > 0.001) { this.waterLevel[k] = l + (g - l) * Math.min(1, dt * 2.5); changed = true; }
      }
      this._waterT = (this._waterT || 0) + dt;
      if (changed || Math.floor(this._waterT * 10) !== Math.floor((this._waterT - dt) * 10)) this._paintWater(this._waterT);
      // "you" marker
      const me = this.state.units.find((u) => u.isPlayer);
      if (me && this.disp[me.id].alive) {
        const g = this.unitObjs[me.id].g.position;
        this.marker.visible = true;
        this.marker.position.set(g.x, 2.05 + Math.sin(now / 250) * 0.08, g.z);
      } else this.marker.visible = false;
      // labels face camera automatically (sprites); keep crates spinning slowly
      for (const g of this.crateMeshes.values()) g.rotation.y += dt * 0.6;
    }
    this._updateCamera();
    this.gl.render(this.scene, this.camera);
  }

  _floatText(x, y, text, color, h = 1.9) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = '900 40px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(10,18,22,0.9)';
    ctx.strokeText(text, 128, 46);
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 46);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    s.renderOrder = 20;
    s.scale.set(2, 0.5, 1);
    s.position.set(this.wx(x), h, this.wz(y));
    this.fx.add(s);
    this._anim(1100, (t) => {
      s.position.y = h + t * 0.8;
      s.material.opacity = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      if (t >= 1) { this.fx.remove(s); tex.dispose(); s.material.dispose(); }
    });
  }

  _ping(x, y) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, side: THREE.DoubleSide, depthTest: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(this.wx(x), 0.1, this.wz(y));
    this.fx.add(ring);
    this._anim(1400, (t) => {
      ring.scale.setScalar(0.5 + t * 2.5);
      ring.material.opacity = 0.7 * (1 - t);
      if (t >= 1) { this.fx.remove(ring); ring.geometry.dispose(); ring.material.dispose(); }
    });
  }

  _face(id, x, y) {
    const d = this.disp[id];
    const g = this.unitObjs[id].g;
    if (x === d.x && y === d.y) return;
    g.rotation.y = Math.atan2(this.wx(x) - this.wx(d.x), this.wz(y) - this.wz(d.y));
  }

  /** Play one sim event. Resolves when its animation is done. */
  async playEvent(ev) {
    const st = this.state;
    const sfx = this.hooks.sfx;
    switch (ev.type) {
      case 'move': {
        const u = st.units[ev.id];
        const mine = u.team === this.myTeam;
        const anyVisible = mine || ev.path.some(([x, y]) => this.visibleToMe(x, y));
        const o = this.unitObjs[ev.id];
        if (!anyVisible) {
          const [ex, ey] = ev.path[ev.path.length - 1];
          this.disp[ev.id].x = ex; this.disp[ev.id].y = ey;
          o.g.position.set(this.wx(ex), 0, this.wz(ey));
          this._syncUnitVisibility(u);
          return;
        }
        for (let i = 1; i < ev.path.length; i++) {
          const [ax, ay] = ev.path[i - 1], [bx, by] = ev.path[i];
          this._face(ev.id, bx, by);
          const vis = mine || this.visibleToMe(ax, ay) || this.visibleToMe(bx, by);
          o.g.visible = vis;
          if (vis) sfx?.step();
          await this._anim(vis ? 120 : 1, (t) => {
            o.g.position.set(this.wx(ax + (bx - ax) * t), Math.sin(t * Math.PI) * 0.06, this.wz(ay + (by - ay) * t));
          });
          this.disp[ev.id].x = bx; this.disp[ev.id].y = by;
        }
        if (mine) this.refreshFog(); else this._syncUnitVisibility(u);
        return;
      }
      case 'overwatch': {
        const u = st.units[ev.id];
        this._drawLabel(u);
        if (u.team === this.myTeam || this.unitObjs[ev.id].g.visible) {
          this._floatText(this.disp[ev.id].x, this.disp[ev.id].y, 'OVERWATCH', '#7fe9ff');
          await this._anim(250, () => {});
        }
        return;
      }
      case 'overwatch_trigger': {
        const shooter = st.units[ev.id], target = st.units[ev.target];
        this._drawLabel(shooter);
        if (target.team === this.myTeam || shooter.team === this.myTeam || this.unitObjs[ev.target].g.visible) {
          sfx?.tripwire();
          await this._anim(380, () => {});
        }
        return;
      }
      case 'shot': {
        const s = st.units[ev.from], t = st.units[ev.to];
        const ds = this.disp[ev.from], dt = this.disp[ev.to];
        const sVis = s.team === this.myTeam || this.visibleToMe(ds.x, ds.y);
        const tVis = t.team === this.myTeam || this.visibleToMe(dt.x, dt.y);
        if (!sVis && !tVis) {
          // Heard, not seen: a rough ping where the shot came from.
          const px = Math.round(ds.x / 3) * 3 + 1, py = Math.round(ds.y / 3) * 3 + 1;
          this._ping(px, py);
          sfx?.shot(1);
          this.hooks.onFeed?.(`Gunfire to the ${compass(this.myRef(), px, py)}`);
          return;
        }
        this._face(ev.from, dt.x, dt.y);
        this.unitObjs[ev.from].g.visible = true;
        const near = this.myRef();
        const far = Math.min(1, Math.hypot(ds.x - near.x, ds.y - near.y) / 16);
        sfx?.shot(far);
        const a = new THREE.Vector3(this.wx(ds.x), 0.6, this.wz(ds.y));
        let b = new THREE.Vector3(this.wx(dt.x), 0.6, this.wz(dt.y));
        if (ev.result === 'miss') b.add(new THREE.Vector3(0.6, 0.3, -0.5));
        const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
          color: s.team === this.myTeam ? C.amber : C.magenta, transparent: true }));
        this.fx.add(line);
        await this._anim(220, (k) => { line.material.opacity = 1 - k * 0.5; });
        this.fx.remove(line); geo.dispose(); line.material.dispose();
        const tg = this.unitObjs[ev.to].g;
        if (ev.result === 'miss') {
          sfx?.miss();
          this._floatText(dt.x, dt.y, 'MISS', '#e7e3d6');
        } else {
          sfx?.hit(ev.result === 'graze');
          this._floatText(dt.x, dt.y, `${ev.result === 'graze' ? 'GRAZE' : 'HIT'} -${ev.dmg}`, ev.result === 'graze' ? '#ffd27a' : '#ff5a4f');
          const ox = tg.position.x;
          await this._anim(200, (k) => { tg.position.x = ox + Math.sin(k * 30) * 0.06 * (1 - k); });
          tg.position.x = ox;
        }
        this._drawLabel(t);
        this._drawLabel(s);
        await this._anim(200, () => {});
        if (!sVis) this._syncUnitVisibility(s);
        return;
      }
      case 'death': {
        const u = st.units[ev.id];
        const o = this.unitObjs[ev.id];
        const wasVisible = o.g.visible;
        this._drawLabel(u);
        if (wasVisible) {
          sfx?.death();
          const r0 = o.g.rotation.z;
          await this._anim(450, (k) => { o.g.rotation.z = r0 + k * 1.45; o.g.position.y = -k * 0.15; });
          await this._anim(300, () => {});
        }
        this.disp[ev.id].alive = false;
        o.g.visible = false;
        if (u.team === this.myTeam) this.refreshFog();
        return;
      }
      case 'crate': {
        const g = this.crateMeshes.get(ev.crate);
        if (g) { this.world.remove(g); this.crateMeshes.delete(ev.crate); }
        const u = st.units[ev.id];
        this._drawLabel(u);
        if (u.team === this.myTeam) {
          sfx?.pickup();
          this._floatText(this.disp[ev.id].x, this.disp[ev.id].y, '+' + ev.item.toUpperCase(), '#7fe9ff');
          await this._anim(300, () => {});
        }
        return;
      }
      case 'crate_drop':
        this._addCrate(ev.crate);
        return;
      case 'heal': {
        const u = st.units[ev.id];
        this._drawLabel(u);
        if (this.unitObjs[ev.id].g.visible) {
          this._floatText(this.disp[ev.id].x, this.disp[ev.id].y, '+' + ev.amount, '#7fe9ff');
          await this._anim(300, () => {});
        }
        return;
      }
      case 'zone_damage': {
        const u = st.units[ev.id];
        this._drawLabel(u);
        if (this.unitObjs[ev.id].g.visible) {
          this._floatText(this.disp[ev.id].x, this.disp[ev.id].y, `TIDE -${ev.dmg}`, '#5fc8e0');
          await this._anim(250, () => {});
        }
        return;
      }
      case 'zone_shrink':
        sfx?.tide();
        this._updateZone(false);
        await this._anim(700, () => {});
        return;
      case 'turn_start':
        for (const id of st.teams[ev.team].members) this._drawLabel(st.units[id]);
        return;
      default:
        return;
    }
  }

  myRef() {
    const me = this.state.units.find((u) => u.isPlayer && this.disp[u.id].alive)
      || this.state.units.find((u) => u.team === this.myTeam && this.disp[u.id].alive);
    if (me) return this.disp[me.id];
    return { x: this.S / 2, y: this.S / 2 };
  }

  _dispose(obj) {
    obj.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.map?.dispose(); m.dispose(); });
    });
  }
}

function makeCircle(color, opacity) {
  const pts = [];
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
  }
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hash(k) {
  let h = (k * 2654435761) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return (h % 1000) / 1000;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function compass(from, x, y) {
  const a = Math.atan2(y - from.y, x - from.x); // map y grows "south"
  const dirs = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
  return dirs[(Math.round(a / (Math.PI / 4)) + 8) % 8];
}
