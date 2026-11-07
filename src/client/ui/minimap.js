// Canvas minimap. Rotated to match the isometric camera, so "up" on the
// minimap is "up" on screen. Shows terrain, the tide, the current and next
// safe ring, crates, your squad and every enemy you can currently see,
// each enemy squad in its own colour. Stage layers: kelp, shallows, barrels.

import { squadColor } from './squads.js';

/** Centre of the next safe ring (the zone may drift on some stages). */
export function nextZone(z) {
  if (!z) return { x: 0, y: 0, r: 0 };
  const n = z.next;
  const r = typeof n === 'number' ? n : (n?.r ?? z.r);
  const x = n && typeof n === 'object' && Number.isFinite(n.x) ? n.x : Number.isFinite(z.nx) ? z.nx : Number.isFinite(z.nextX) ? z.nextX : z.x;
  const y = n && typeof n === 'object' && Number.isFinite(n.y) ? n.y : Number.isFinite(z.ny) ? z.ny : Number.isFinite(z.nextY) ? z.nextY : z.y;
  return { x, y, r };
}

const COL = {
  bg: '#0a1519',
  land: '#2c3d3c',
  landFog: '#1b2829',
  half: '#6b4a35',
  full: '#9a937f',
  water: '#1d5f70',
  kelp: '#2f6b47',
  shallow: '#2c5a5f',
  barrel: '#ff5a3c',
  ring: 'rgba(240,248,245,0.9)',
  next: '#7fe9ff',
  crate: '#7fe9ff',
  me: '#ffb000',
  enemy: '#ff3fa4',
  cam: 'rgba(231,227,214,0.75)',
};

export class Minimap {
  constructor(canvas, { onPick } = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.onPick = onPick;
    this.terrain = document.createElement('canvas');
    this.terrainSig = '';
    canvas.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const t = this.toTile(e.offsetX, e.offsetY);
      if (t) this.onPick?.(t.x, t.y);
    });
  }

  _yaw(R) {
    if (typeof R?.cameraYaw === 'function') return R.cameraYaw();
    const a = Math.PI / 4 + (R?.camAngle ?? 0) * (Math.PI / 2);
    return a;
  }

  _fit() {
    const r = this.cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; }
    this.cssW = r.width; this.dpr = dpr;
    return w;
  }

  _xf(S, size, yaw) {
    // tile (x,y) → canvas pixels; θ makes the camera's forward point up.
    const th = -yaw - (3 * Math.PI) / 2;
    const scale = (size / (S * Math.SQRT2)) * 0.98;
    return { th, scale, c: Math.cos(th), s: Math.sin(th), half: size / 2, mid: S / 2 };
  }

  toTile(px, py) {
    if (!this.last) return null;
    const { S, xf } = this.last;
    const X = px * this.dpr - xf.half, Y = py * this.dpr - xf.half;
    // inverse rotation
    const x = (X * xf.c + Y * xf.s) / xf.scale + xf.mid;
    const y = (-X * xf.s + Y * xf.c) / xf.scale + xf.mid;
    const tx = Math.floor(x), ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= S || ty >= S) return null;
    return { x: tx, y: ty };
  }

  _buildTerrain(state, fog) {
    const S = state.map.size;
    const t = this.terrain;
    t.width = S; t.height = S;
    const g = t.getContext('2d');
    const z = state.zone;
    const img = g.createImageData(S, S);
    const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const P = { land: hex(COL.land), fog: hex(COL.landFog), half: hex(COL.half), full: hex(COL.full), water: hex(COL.water), kelp: hex(COL.kelp), shallow: hex(COL.shallow) };
    const ter = state.map.terrain && state.map.terrain.length === S * S ? state.map.terrain : null;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const k = y * S + x;
      let c;
      if (Math.hypot(x - z.x, y - z.y) > z.r) c = P.water;
      else if (state.map.cover[k] === 2) c = P.full;
      else if (state.map.cover[k] === 1) c = P.half;
      else if (ter && ter[k] === 1) c = P.kelp;
      else if (ter && ter[k] === 2) c = P.shallow;
      else c = fog && !fog[k] ? P.fog : P.land;
      const i = k * 4;
      img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }

  draw(state, R) {
    if (!state || !this.cv.isConnected) return;
    const size = this._fit();
    const S = state.map.size;
    const ctx = this.ctx;
    const yaw = this._yaw(R);
    const xf = this._xf(S, size, yaw);
    this.last = { S, xf };

    const fog = R?.fogMask && R.fogMask.length === S * S ? R.fogMask : null;
    let fogSig = 0;
    if (fog) for (let i = 0; i < fog.length; i += 7) fogSig = (fogSig * 31 + fog[i]) | 0;
    let coverSig = 0;
    for (let i = 0; i < state.map.cover.length; i += 3) coverSig = (coverSig * 33 + state.map.cover[i]) | 0;
    const sig = `${state.seed}|${state.stage}|${state.zone.r}|${state.zone.x}|${state.zone.y}|${coverSig}|${fogSig}`;
    if (sig !== this.terrainSig) { this._buildTerrain(state, fog); this.terrainSig = sig; }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(xf.half, xf.half);
    ctx.rotate(xf.th);
    ctx.scale(xf.scale, xf.scale);
    ctx.translate(-xf.mid, -xf.mid);
    ctx.imageSmoothingEnabled = false;
    // frame
    ctx.fillStyle = COL.bg;
    ctx.fillRect(-0.6, -0.6, S + 1.2, S + 1.2);
    ctx.drawImage(this.terrain, 0, 0);

    const z = state.zone;
    const lw = 1 / xf.scale;
    ctx.lineWidth = lw * 1.6 * this.dpr;
    ctx.strokeStyle = COL.ring;
    ctx.beginPath(); ctx.arc(z.x + 0.5, z.y + 0.5, Math.max(0.01, z.r), 0, Math.PI * 2); ctx.stroke();
    const nz = nextZone(z);
    ctx.strokeStyle = COL.next;
    ctx.setLineDash([lw * 4 * this.dpr, lw * 3 * this.dpr]);
    ctx.beginPath(); ctx.arc(nz.x + 0.5, nz.y + 0.5, Math.max(0.01, nz.r), 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    if (Math.hypot(nz.x - z.x, nz.y - z.y) > 0.6) {
      // Drifting zone: an arrow from the current centre to the next one.
      ctx.strokeStyle = COL.next; ctx.fillStyle = COL.next;
      ctx.lineWidth = lw * 1.4 * this.dpr;
      const ax = z.x + 0.5, ay = z.y + 0.5, bx = nz.x + 0.5, by = nz.y + 0.5;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      const a = Math.atan2(by - ay, bx - ax), hl = 2.2;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx - Math.cos(a - 0.5) * hl, by - Math.sin(a - 0.5) * hl); ctx.lineTo(bx - Math.cos(a + 0.5) * hl, by - Math.sin(a + 0.5) * hl); ctx.closePath(); ctx.fill();
    }

    // explosive barrels (still standing)
    const ex = state.map.explosive;
    if (ex && ex.length === S * S) {
      ctx.fillStyle = COL.barrel;
      for (let k = 0; k < ex.length; k++) {
        if (!ex[k] || !state.map.cover[k]) continue;
        const x = k % S, y = (k / S) | 0;
        ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, 0.55, 0, Math.PI * 2); ctx.fill();
      }
    }

    // crates
    for (const c of state.crates) {
      if (c.taken) continue;
      const big = c.type === 'cache';
      ctx.fillStyle = COL.crate;
      const s = big ? 1.6 : 0.95;
      ctx.fillRect(c.x + 0.5 - s / 2, c.y + 0.5 - s / 2, s, s);
      if (big) { ctx.strokeStyle = COL.crate; ctx.lineWidth = lw * this.dpr; ctx.strokeRect(c.x - 0.6, c.y - 0.6, 2.2, 2.2); }
    }

    // units
    const myTeam = R?.myTeam ?? state.playerTeam;
    const visible = (u) => {
      if (u.team === myTeam) return true;
      if (typeof R?.isUnitVisible === 'function') return R.isUnitVisible(u.id);
      return !!R?.unitObjs?.[u.id]?.g?.visible;
    };
    for (const u of state.units) {
      if (!u.alive || !visible(u)) continue;
      const d = R?.disp?.[u.id] || u;
      const mine = u.team === myTeam;
      ctx.fillStyle = mine ? COL.me : squadColor(u.team, myTeam);
      ctx.beginPath();
      ctx.arc(d.x + 0.5, d.y + 0.5, u.isPlayer ? 1.25 : 0.95, 0, Math.PI * 2);
      ctx.fill();
      if (!mine) { ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = lw * 0.8 * this.dpr; ctx.stroke(); }
      if (u.isPlayer) {
        ctx.strokeStyle = '#1a1406'; ctx.lineWidth = lw * this.dpr; ctx.stroke();
      }
    }

    // camera centre
    const tgt = R?.target;
    if (tgt && Number.isFinite(tgt.x)) {
      const cx = tgt.x + S / 2, cy = tgt.z + S / 2;
      ctx.strokeStyle = COL.cam;
      ctx.lineWidth = lw * this.dpr;
      ctx.strokeRect(cx - 3, cy - 3, 6, 6);
    }
    ctx.restore();
  }
}
