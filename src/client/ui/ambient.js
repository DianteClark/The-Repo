// Title-screen ambience: drifting sea-spray motes and bokeh on a 2D canvas,
// plus pointer / tilt parallax exposed as CSS variables (--px, --py, -1..1).
// The loop only runs while start() is active and the tab is visible.

const TAU = Math.PI * 2;

export class Ambient {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.on = false;
    this.raf = 0;
    this.parts = [];
    this.px = 0; this.py = 0; // smoothed parallax
    this.tx = 0; this.ty = 0; // target parallax
    this.burst = 0;
    this._resize = () => this.resize();
    this._move = (e) => {
      if (e.pointerType === 'touch') return;
      this.tx = (e.clientX / innerWidth) * 2 - 1;
      this.ty = (e.clientY / innerHeight) * 2 - 1;
    };
    this._tilt = (e) => {
      if (e.gamma === null || e.beta === null) return;
      this.tx = Math.max(-1, Math.min(1, e.gamma / 25));
      this.ty = Math.max(-1, Math.min(1, (e.beta - 45) / 25));
    };
    this._vis = () => { if (document.hidden) this._stopLoop(); else if (this.on) this._startLoop(); };
    document.addEventListener('visibilitychange', this._vis);
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.dpr = dpr;
    this.w = innerWidth; this.h = innerHeight;
    this.c.width = Math.round(this.w * dpr); this.c.height = Math.round(this.h * dpr);
    const n = Math.round(Math.min(90, Math.max(36, (this.w * this.h) / 16000)));
    while (this.parts.length < n) this.parts.push(this._spawn(true));
    this.parts.length = n;
  }

  _spawn(anywhere) {
    const z = Math.random(); // depth 0 (far) .. 1 (near)
    const bokeh = Math.random() < 0.12;
    return {
      x: Math.random() * (this.w || innerWidth),
      y: anywhere ? Math.random() * (this.h || innerHeight) : (this.h || innerHeight) + 10,
      z, bokeh,
      r: bokeh ? 6 + z * 18 : 0.6 + z * 1.8,
      vx: 4 + z * 14 + Math.random() * 6,
      vy: -(6 + z * 22 + Math.random() * 10),
      ph: Math.random() * TAU,
      tw: 0.6 + Math.random() * 1.6,
      hue: Math.random() < 0.7 ? 'c' : Math.random() < 0.5 ? 'b' : 'a',
    };
  }

  /** A celebratory burst of motes (used when entering the loadout). */
  pulse() { this.burst = 1; }

  start() {
    if (this.on) return;
    this.on = true;
    this.resize();
    addEventListener('resize', this._resize);
    addEventListener('pointermove', this._move, { passive: true });
    addEventListener('deviceorientation', this._tilt, { passive: true });
    this.c.classList.add('on');
    this._startLoop();
  }

  stop() {
    if (!this.on) return;
    this.on = false;
    removeEventListener('resize', this._resize);
    removeEventListener('pointermove', this._move);
    removeEventListener('deviceorientation', this._tilt);
    this.c.classList.remove('on');
    this._stopLoop();
  }

  _startLoop() {
    if (this.raf || document.hidden) return;
    this.last = performance.now();
    const loop = (t) => { this.raf = requestAnimationFrame(loop); this._frame(t); };
    this.raf = requestAnimationFrame(loop);
  }
  _stopLoop() { cancelAnimationFrame(this.raf); this.raf = 0; }

  _frame(t) {
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    const k = 1 - Math.exp(-dt * 3);
    this.px += (this.tx - this.px) * k;
    this.py += (this.ty - this.py) * k;
    // Only the title screens use parallax; scope the vars there and write only on change.
    const px = this.px.toFixed(3), py = this.py.toFixed(3);
    if (px !== this._lpx || py !== this._lpy) {
      this._lpx = px; this._lpy = py;
      this.targets ||= [document.getElementById('splash'), document.getElementById('menu')].filter(Boolean);
      for (const el of this.targets) { el.style.setProperty('--px', px); el.style.setProperty('--py', py); }
    }
    if (this.reduced) { this.ctx.clearRect(0, 0, this.c.width, this.c.height); return; }
    this.burst = Math.max(0, this.burst - dt * 0.8);
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const boost = 1 + this.burst * 5;
    for (const p of this.parts) {
      p.x += p.vx * dt * boost;
      p.y += p.vy * dt * boost;
      p.ph += dt * p.tw;
      if (p.y < -30 || p.x > this.w + 30) Object.assign(p, this._spawn(false), { x: Math.random() * this.w * 1.1 - this.w * 0.1 });
      const ox = -this.px * (6 + p.z * 26), oy = -this.py * (4 + p.z * 16);
      const a = (p.bokeh ? 0.07 : 0.35 + p.z * 0.45) * (0.55 + 0.45 * Math.sin(p.ph));
      const col = p.hue === 'c' ? '127,233,255' : p.hue === 'b' ? '232,222,196' : '255,196,90';
      if (p.bokeh) {
        const g = ctx.createRadialGradient(p.x + ox, p.y + oy, 0, p.x + ox, p.y + oy, p.r);
        g.addColorStop(0, `rgba(${col},${a})`);
        g.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = g;
      } else ctx.fillStyle = `rgba(${col},${a})`;
      ctx.beginPath();
      ctx.arc(p.x + ox, p.y + oy, p.r, 0, TAU);
      ctx.fill();
    }
  }
}
