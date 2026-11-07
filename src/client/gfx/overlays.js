// Tactical overlays: move-range tiles with region outlines, path preview with
// destination cover shields, grenade AOE, enemy hit-% badges, aim line +
// reticle, hover cursor, and per-unit name/HP labels.

import * as THREE from 'three';
import { TEAM, P } from './palette.js';
import { roundRect } from './util.js';

const Y = 0.125; // above the water line

const TILE_VERT = /* glsl */`
attribute float aEdge;
varying vec2 vUv;
varying float vEdge;
varying vec3 vCol;
void main() {
  vUv = uv;
  vEdge = aEdge;
  vCol = vec3(1.0);
  #ifdef USE_INSTANCING_COLOR
    vCol = instanceColor;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const TILE_FRAG = /* glsl */`
uniform float uTime;
uniform float uFill;
varying vec2 vUv;
varying float vEdge;
varying vec3 vCol;
float bit(float m, float b) { return mod(floor(m / b), 2.0); }
void main() {
  vec2 u = vUv;
  // edges without a same-kind neighbour get a bright outline: E(+x)=1, W=2, S(+z)=4, N=8
  float e = 1e3;
  if (bit(vEdge, 1.0) < 0.5) e = min(e, 1.0 - u.x);
  if (bit(vEdge, 2.0) < 0.5) e = min(e, u.x);
  if (bit(vEdge, 4.0) < 0.5) e = min(e, 1.0 - u.y);
  if (bit(vEdge, 8.0) < 0.5) e = min(e, u.y);
  float outline = 1.0 - smoothstep(0.03, 0.075, e);
  float inner = min(min(u.x, 1.0 - u.x), min(u.y, 1.0 - u.y));
  float grid = (1.0 - smoothstep(0.0, 0.035, inner)) * 0.35;
  float pulse = 0.85 + 0.15 * sin(uTime * 3.0);
  float a = max(outline * 0.95 * pulse, uFill + grid * 0.5);
  gl_FragColor = vec4(vCol * (1.0 + outline * 0.8), a);
}`;

function tileMesh(cap, fill) {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  // uv.y must grow toward +z after rotation: PlaneGeometry v grows with +y → -z, flip
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  geo.setAttribute('aEdge', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uFill: { value: fill } },
    vertexShader: TILE_VERT, fragmentShader: TILE_FRAG, transparent: true, depthWrite: false,
  });
  const m = new THREE.InstancedMesh(geo, mat, cap);
  m.count = 0;
  m.setColorAt(0, new THREE.Color());
  m.renderOrder = 4;
  m.frustumCulled = false;
  return m;
}

function shieldTex(full) {
  const c = document.createElement('canvas'); c.width = c.height = 96;
  const g = c.getContext('2d');
  const path = () => {
    g.beginPath(); g.moveTo(48, 8); g.lineTo(84, 20); g.lineTo(80, 54); g.quadraticCurveTo(70, 78, 48, 90);
    g.quadraticCurveTo(26, 78, 16, 54); g.lineTo(12, 20); g.closePath();
  };
  g.lineJoin = 'round';
  path(); g.fillStyle = 'rgba(10,18,22,0.75)'; g.fill();
  g.save(); path(); g.clip();
  g.fillStyle = '#eef6f2';
  if (full) g.fillRect(0, 0, 96, 96); else g.fillRect(0, 50, 96, 46);
  g.restore();
  path(); g.lineWidth = 7; g.strokeStyle = '#eef6f2'; g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Overlays {
  constructor(world, overlay, wx, wz, S) {
    this.world = world; this.overlay = overlay; this.wx = wx; this.wz = wz; this.S = S;
    this.time = 0;
    this.hl = tileMesh(S * S, 0.1);
    this.hl.position.y = Y;
    world.add(this.hl);
    this.aoeTiles = tileMesh(64, 0.3);
    this.aoeTiles.position.y = Y + 0.005;
    world.add(this.aoeTiles);

    // path: instanced dashes + end ring
    const dg = new THREE.CircleGeometry(0.075, 10); dg.rotateX(-Math.PI / 2);
    this.dash = new THREE.InstancedMesh(dg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false }), 256);
    this.dash.count = 0; this.dash.renderOrder = 5; this.dash.frustumCulled = false;
    this.dash.setColorAt(0, new THREE.Color());
    world.add(this.dash);
    const rg = new THREE.RingGeometry(0.28, 0.4, 32); rg.rotateX(-Math.PI / 2);
    this.endRing = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false }));
    this.endRing.visible = false; this.endRing.renderOrder = 5;
    world.add(this.endRing);
    this.shieldTex = [null, shieldTex(false), shieldTex(true)];
    this.shields = [];
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.shieldTex[2], transparent: true, depthTest: false, toneMapped: false }));
      s.visible = false; s.scale.set(0.42, 0.42, 1); s.renderOrder = 25;
      overlay.add(s); this.shields.push(s);
    }

    // AOE ring
    const ag = new THREE.RingGeometry(0.94, 1, 64); ag.rotateX(-Math.PI / 2);
    this.aoeRing = new THREE.Mesh(ag, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false }));
    this.aoeRing.visible = false; this.aoeRing.renderOrder = 6;
    const ad = new THREE.CircleGeometry(1, 48); ad.rotateX(-Math.PI / 2);
    this.aoeDisc = new THREE.Mesh(ad, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, opacity: 0.12 }));
    this.aoeDisc.visible = false; this.aoeDisc.renderOrder = 5;
    world.add(this.aoeRing, this.aoeDisc);
    this.aoe = null;

    // hover cursor
    const hg = new THREE.EdgesGeometry(new THREE.PlaneGeometry(0.96, 0.96)); hg.rotateX(-Math.PI / 2);
    this.hover = new THREE.LineSegments(hg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }));
    this.hover.visible = false; this.hover.renderOrder = 6;
    world.add(this.hover);

    // aim line + reticle
    const lg = new THREE.PlaneGeometry(1, 1); lg.translate(0, 0.5, 0); lg.rotateX(-Math.PI / 2); // along -z
    this.aimMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uLen: { value: 1 }, uCol: { value: new THREE.Color(TEAM.magenta).multiplyScalar(1.4) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform float uTime, uLen; uniform vec3 uCol; varying vec2 vUv;
        void main(){ float d = fract(vUv.y * uLen * 2.5 - uTime * 2.0); float a = step(0.45, d) * (1.0 - abs(vUv.x - 0.5) * 2.0);
        a *= smoothstep(0.0, 0.08, vUv.y) * smoothstep(1.0, 0.85, vUv.y); gl_FragColor = vec4(uCol, a); }`,
      transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    });
    this.aimLine = new THREE.Mesh(lg, this.aimMat);
    this.aimLine.visible = false; this.aimLine.renderOrder = 8;
    world.add(this.aimLine);
    const retG = new THREE.RingGeometry(0.5, 0.58, 4, 1, 0, Math.PI * 2); retG.rotateX(-Math.PI / 2);
    this.reticle = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const seg = new THREE.RingGeometry(0.5, 0.6, 8, 1, i * Math.PI / 2 + 0.25, Math.PI / 2 - 0.5); seg.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(seg, new THREE.MeshBasicMaterial({ color: new THREE.Color(TEAM.magenta).multiplyScalar(1.6), transparent: true, depthWrite: false, depthTest: false }));
      m.renderOrder = 8;
      this.reticle.add(m);
    }
    this.reticle.visible = false;
    world.add(this.reticle);

    // target badges
    this.badges = [];
    for (let i = 0; i < 16; i++) {
      const c = document.createElement('canvas'); c.width = 160; c.height = 72;
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false }));
      s.visible = false; s.scale.set(0.95, 0.43, 1); s.renderOrder = 26; s.center.set(0.5, 0);
      overlay.add(s);
      this.badges.push({ s, c, tex, id: -1, chance: -1, sel: false });
    }
  }

  // ---------- move range ----------
  setHighlights(map) {
    const S = this.S, m = this.hl;
    if (!map || !map.size) { m.count = 0; return; }
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    const c1 = new THREE.Color(P.move1), c2 = new THREE.Color(P.move2);
    const edge = m.geometry.attributes.aEdge.array;
    let i = 0;
    for (const [k, v] of map) {
      const x = k % S, y = (k / S) | 0;
      m4.makeTranslation(this.wx(x), 0, this.wz(y));
      m.setMatrixAt(i, m4);
      m.setColorAt(i, col.copy(v === 1 ? c1 : c2));
      const same = (dx, dy) => {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= S || ny >= S) return 0;
        return map.get(ny * S + nx) === v ? 1 : 0;
      };
      edge[i] = same(1, 0) * 1 + same(-1, 0) * 2 + same(0, 1) * 4 + same(0, -1) * 8;
      i++;
    }
    m.count = i;
    m.instanceMatrix.needsUpdate = true;
    m.instanceColor.needsUpdate = true;
    m.geometry.attributes.aEdge.needsUpdate = true;
  }

  // ---------- path ----------
  setPath(path, cost, coverDirs) {
    const d = this.dash;
    for (const s of this.shields) s.visible = false;
    if (!path || path.length < 2) { d.count = 0; this.endRing.visible = false; return; }
    const col = new THREE.Color(cost === 2 ? P.move2 : P.move1).multiplyScalar(1.3);
    const m4 = new THREE.Matrix4();
    let n = 0;
    for (let i = 1; i < path.length; i++) {
      const [ax, ay] = path[i - 1], [bx, by] = path[i];
      const L = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(2, Math.round(L * 4));
      for (let s = i === 1 ? 1 : 0; s < steps; s++) {
        if (n >= 255) break;
        const t = s / steps;
        m4.makeTranslation(this.wx(ax + (bx - ax) * t), Y + 0.01, this.wz(ay + (by - ay) * t));
        d.setMatrixAt(n, m4);
        d.setColorAt(n, col);
        n++;
      }
    }
    d.count = n;
    d.instanceMatrix.needsUpdate = true; d.instanceColor.needsUpdate = true;
    const [ex, ey] = path[path.length - 1];
    this.endRing.position.set(this.wx(ex), Y + 0.012, this.wz(ey));
    this.endRing.material.color.copy(col);
    this.endRing.visible = true;
    // cover shields at destination: [E, W, S, N]
    if (coverDirs) {
      const off = [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]];
      coverDirs.forEach((c, i) => {
        if (!c) return;
        const s = this.shields[i];
        s.material.map = this.shieldTex[c];
        s.position.set(this.wx(ex) + off[i][0] * 0.9, 0.55, this.wz(ey) + off[i][1] * 0.9);
        s.visible = true;
      });
    }
  }

  // ---------- AOE ----------
  setAoe(a, coverAt) {
    this.aoe = a;
    const m = this.aoeTiles;
    if (!a) { m.count = 0; this.aoeRing.visible = this.aoeDisc.visible = false; return; }
    const S = this.S, m4 = new THREE.Matrix4();
    const col = new THREE.Color(a.valid ? 0xffc890 : 0x9aa4a6);
    const R = Math.ceil(a.radius);
    const inside = (x, y) => x >= 0 && y >= 0 && x < S && y < S && Math.hypot(x - a.x, y - a.y) <= a.radius;
    const edge = m.geometry.attributes.aEdge.array;
    let i = 0;
    for (let y = a.y - R; y <= a.y + R; y++) for (let x = a.x - R; x <= a.x + R; x++) {
      if (!inside(x, y) || i >= 64) continue;
      m4.makeTranslation(this.wx(x), coverAt && coverAt(x, y) ? 0.6 : 0, this.wz(y));
      m.setMatrixAt(i, m4); m.setColorAt(i, col);
      edge[i] = (inside(x + 1, y) ? 1 : 0) + (inside(x - 1, y) ? 2 : 0) + (inside(x, y + 1) ? 4 : 0) + (inside(x, y - 1) ? 8 : 0);
      i++;
    }
    m.count = i;
    m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; m.geometry.attributes.aEdge.needsUpdate = true;
    for (const o of [this.aoeRing, this.aoeDisc]) {
      o.visible = true;
      o.position.set(this.wx(a.x), Y + 0.02, this.wz(a.y));
      o.scale.setScalar(a.radius + 0.08);
      o.material.color.copy(col).multiplyScalar(a.valid ? 1.6 : 1);
    }
  }

  setHover(x, y) {
    if (x === null || x === undefined) { this.hover.visible = false; return; }
    this.hover.visible = true;
    this.hover.position.set(this.wx(x), Y + 0.015, this.wz(y));
  }

  // ---------- targets ----------
  setTargets(list) {
    for (const b of this.badges) { b.s.visible = false; b.id = -1; }
    if (!list) return;
    list.slice(0, this.badges.length).forEach((t, i) => {
      const b = this.badges[i];
      b.id = t.id;
      if (b.chance !== t.chance || b.sel !== !!t.sel) { b.chance = t.chance; b.sel = !!t.sel; this._drawBadge(b); }
    });
  }

  markSelected(id) {
    for (const b of this.badges) {
      const sel = b.id === id && id !== null;
      if (b.id >= 0 && b.sel !== sel) { b.sel = sel; this._drawBadge(b); }
    }
  }

  _drawBadge(b) {
    const g = b.c.getContext('2d');
    g.clearRect(0, 0, 160, 72);
    roundRect(g, 6, 6, 148, 52, 14);
    g.fillStyle = b.sel ? '#ff3fa4' : 'rgba(12,20,24,0.88)'; g.fill();
    g.lineWidth = 4; g.strokeStyle = '#ff3fa4'; g.stroke();
    g.beginPath(); g.moveTo(68, 58); g.lineTo(80, 70); g.lineTo(92, 58); g.closePath();
    g.fillStyle = '#ff3fa4'; g.fill();
    g.font = '900 38px system-ui, -apple-system, "Segoe UI", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = b.sel ? '#140a10' : '#ffffff';
    g.fillText(b.chance + '%', 80, 33);
    b.tex.needsUpdate = true;
  }

  /** posOf(id) → THREE.Vector3|null (world position of unit feet), visible check. */
  updateBadges(posOf) {
    for (const b of this.badges) {
      if (b.id < 0) continue;
      const p = posOf(b.id);
      if (!p) { b.s.visible = false; continue; }
      b.s.visible = true;
      b.s.position.set(p.x, 1.62 + Math.sin(this.time * 4 + b.id) * 0.03, p.z);
      const k = b.sel ? 1.15 : 1;
      b.s.scale.set(0.95 * k, 0.43 * k, 1);
    }
  }

  setAim(a, b) {
    if (!a || !b) { this.aimLine.visible = false; this.reticle.visible = false; return; }
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
    this.aimLine.visible = true;
    this.aimLine.position.set(a.x, 0.7, a.z);
    this.aimLine.rotation.set(0, Math.atan2(-dx, -dz), 0);
    this.aimLine.scale.set(0.07, 1, L);
    this.aimMat.uniforms.uLen.value = L;
    this.reticle.visible = true;
    this.reticle.position.set(b.x, Y + 0.03, b.z);
  }

  update(dt) {
    this.time += dt;
    this.hl.material.uniforms.uTime.value = this.time;
    this.aoeTiles.material.uniforms.uTime.value = this.time;
    this.aimMat.uniforms.uTime.value = this.time;
    if (this.endRing.visible) this.endRing.scale.setScalar(1 + Math.sin(this.time * 5) * 0.08);
    if (this.reticle.visible) { this.reticle.rotation.y += dt * 1.2; this.reticle.scale.setScalar(1 + Math.sin(this.time * 6) * 0.05); }
    if (this.aoeRing.visible) this.aoeRing.material.opacity = 0.7 + Math.sin(this.time * 6) * 0.3;
  }
}

// ---------- unit labels ----------

export class Label {
  constructor(overlay) {
    this.c = document.createElement('canvas'); this.c.width = 256; this.c.height = 84;
    this.tex = new THREE.CanvasTexture(this.c); this.tex.colorSpace = THREE.SRGBColorSpace;
    this.s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthTest: false, toneMapped: false }));
    this.s.scale.set(1.45, 0.476, 1);
    this.s.center.set(0.5, 0);
    this.s.renderOrder = 20;
    overlay.add(this.s);
    this.key = '';
  }
  draw(u, mine, hp, status) {
    const key = [u.name, mine, hp, u.maxHp, u.armor, status.ow, status.hk, status.lw, u.team].join('|');
    if (key === this.key) return;
    this.key = key;
    const g = this.c.getContext('2d');
    g.clearRect(0, 0, 256, 84);
    const team = mine ? '#ffb000' : '#ff3fa4';
    const tag = mine ? u.name : `${u.name}`;
    g.font = '800 25px system-ui, -apple-system, "Segoe UI", sans-serif';
    const icons = (status.ow ? 1 : 0) + (status.hk ? 1 : 0);
    const tw = Math.min(200, g.measureText(tag).width + (mine ? 0 : 40) + icons * 28);
    const W = Math.max(150, tw + 34);
    const x0 = 128 - W / 2;
    roundRect(g, x0, 4, W, 70, 14);
    g.fillStyle = 'rgba(9,16,20,0.78)'; g.fill();
    g.fillStyle = team; roundRect(g, x0, 4, 8, 70, 4); g.fill();
    // name row
    g.textBaseline = 'middle'; g.textAlign = 'left';
    let cx = x0 + 18;
    if (!mine) {
      g.fillStyle = team; g.font = '900 19px system-ui, sans-serif';
      g.fillText('S' + (u.team + 1), cx, 25); cx += 36;
    }
    g.font = '800 25px system-ui, -apple-system, "Segoe UI", sans-serif';
    g.fillStyle = '#efe7d4';
    g.fillText(tag, cx, 26);
    cx += g.measureText(tag).width + 8;
    if (status.ow) { drawEye(g, cx + 12, 26); cx += 28; }
    if (status.hk) { drawShield(g, cx + 10, 26); cx += 26; }
    // HP pips
    const n = u.maxHp, pw0 = W - 34, gap = 3;
    const pw = (pw0 - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      g.fillStyle = i < hp ? team : 'rgba(255,255,255,0.14)';
      g.fillRect(x0 + 18 + i * (pw + gap), 46, pw, 14);
    }
    if (u.armor > 0) {
      g.fillStyle = '#efe7d4';
      for (let i = 0; i < Math.min(4, u.armor); i++) {
        const ax = x0 + 18 + i * 14, ay = 67;
        g.beginPath(); g.moveTo(ax + 5, ay - 4); g.lineTo(ax + 10, ay); g.lineTo(ax + 5, ay + 4); g.lineTo(ax, ay); g.closePath(); g.fill();
      }
    }
    this.tex.needsUpdate = true;
  }
  dispose() { this.overlay?.remove(this.s); this.tex.dispose(); this.s.material.dispose(); }
}

function drawEye(g, x, y) {
  g.save();
  g.strokeStyle = '#7fe9ff'; g.fillStyle = '#7fe9ff'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(x - 12, y); g.quadraticCurveTo(x, y - 11, x + 12, y); g.quadraticCurveTo(x, y + 11, x - 12, y); g.stroke();
  g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill();
  g.restore();
}
function drawShield(g, x, y) {
  g.save();
  g.fillStyle = '#efe7d4';
  g.beginPath(); g.moveTo(x, y - 11); g.lineTo(x + 9, y - 7); g.lineTo(x + 8, y + 3); g.quadraticCurveTo(x + 4, y + 9, x, y + 11);
  g.quadraticCurveTo(x - 4, y + 9, x - 8, y + 3); g.lineTo(x - 9, y - 7); g.closePath(); g.fill();
  g.restore();
}
