// World audio: boats, building collapse, stage events ("Levolution"),
// redeploy. Mixed into Sfx.prototype (`this` is the engine).

const clamp01 = (x) => { const v = Number(x); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; };
const rnd = (a, b) => a + Math.random() * (b - a);

const STAGE_KINDS = ['harbor', 'kelp', 'rig', 'spire', 'surge'];
function stageKind(k) {
  const s = String(k ?? '').toLowerCase();
  for (const x of STAGE_KINDS) if (s.includes(x)) return x;
  if (s.includes('ship') || s.includes('container')) return 'harbor';
  if (s.includes('tide') || s.includes('algae') || s.includes('toxic')) return 'kelp';
  if (s.includes('platform')) return 'rig';
  if (s.includes('tower')) return 'spire';
  if (s.includes('wave')) return 'surge';
  return 'generic';
}

const IDLE = 34, THROTTLE = 62;

export const WorldSfx = {
  // ------------------------------------------------------------------ boats

  /**
   * Boat engine. mode: 'start' (pull-cord + idle loop), 'loop' (ensure idle
   * loop, no crank), 'rev'/'move' (throttle up for opts.dur s, with wake),
   * 'stop' (sputter out). opts: { id, far, dur }. Loops auto-stop after 10 min.
   */
  boatEngine(mode = 'start', opts = {}) {
    if (!this.ctx) return;
    try {
      const o = opts && typeof opts === 'object' ? opts : {};
      const key = 'boat:' + String(o.id ?? 0);
      const m = String(mode ?? 'start').toLowerCase();
      const far = clamp01(o.far ?? 0);
      if (m === 'stop' || m === 'off' || m === 'end') {
        if (this._loops?.[key]) {
          this._safe(() => {
            const v = this._voice({ cat: 'misc', dur: 0.8, far, gain: 0.7, rev: 0.1 });
            if (v) for (const at of [0, 0.13, 0.3]) this._noise(v, { at, a: 0.005, d: 0.06, vol: 0.25, type: 'lowpass', f: 600 });
          });
        }
        this._loopStop(key, 0.8);
        return;
      }
      if (m === 'start' || m === 'on') {
        this._safe(() => {
          const v = this._voice({ cat: 'misc', dur: 1.0, far, gain: 0.8, rev: 0.08 });
          if (!v) return;
          this._noise(v, { a: 0.18, d: 0.08, vol: 0.18, type: 'bandpass', f: 900, f2: 2200, q: 2 }); // cord
          for (const [at, vol] of [[0.32, 0.3], [0.42, 0.22], [0.5, 0.35]]) {
            this._osc(v, { at, f: 60, f2: 40, a: 0.003, d: 0.06, vol });
            this._noise(v, { at, a: 0.002, d: 0.05, vol: vol * 0.6, type: 'lowpass', f: 900 });
          }
        });
      }
      const n = this._boatLoop(key, far);
      if (n && (m === 'rev' || m === 'move' || m === 'throttle')) {
        const dur = Math.max(0.3, Math.min(8, Number(o.dur) || 1.6));
        const t = this.ctx.currentTime;
        n.rpm(THROTTLE, t, 0.12);
        n.rpm(IDLE, t + dur, 0.4);
        this.wake(far, dur + 0.4);
      }
    } catch { /* never break the game */ }
  },

  /** Boat moving: throttle + wake. */
  boatMove(far = 0, dur = 1.6, id = 0) { this.boatEngine('rev', { far, dur, id }); },

  _boatLoop(key, far) {
    if (this._loops?.[key]) return this._loops[key];
    if (Object.keys(this._loops || {}).filter((k) => k.startsWith('boat:')).length >= 4) return null;
    return this._loopStart(key, (n, t) => {
      const ctx = this.ctx;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 650; lp.Q.value = 1.2;
      const chop = ctx.createGain(); chop.gain.value = 0.55;
      const g = ctx.createGain(); g.gain.value = 0.12;
      lp.connect(chop).connect(g).connect(n.out);
      const saw = ctx.createOscillator(); saw.type = 'sawtooth'; saw.frequency.value = IDLE;
      const sq = ctx.createOscillator(); sq.type = 'square'; sq.frequency.value = IDLE * 2;
      const sqg = ctx.createGain(); sqg.gain.value = 0.3;
      saw.connect(lp); sq.connect(sqg).connect(lp);
      const lfo = ctx.createOscillator(); lfo.frequency.value = IDLE / 2;
      const la = ctx.createGain(); la.gain.value = 0.45; lfo.connect(la).connect(chop.gain);
      // Mechanical whine.
      const ns = ctx.createBufferSource(); ns.buffer = this.buf.white; ns.loop = true;
      const nb = ctx.createBiquadFilter(); nb.type = 'bandpass'; nb.frequency.value = 1100; nb.Q.value = 3;
      const ng = ctx.createGain(); ng.gain.value = 0.05;
      ns.connect(nb).connect(ng).connect(chop);
      // Water lapping against the hull.
      const ws = ctx.createBufferSource(); ws.buffer = this.buf.pink; ws.loop = true;
      const wl = ctx.createBiquadFilter(); wl.type = 'lowpass'; wl.frequency.value = 500;
      const wg = ctx.createGain(); wg.gain.value = 0.05;
      ws.connect(wl).connect(wg).connect(n.out);
      n.srcs.push(saw, sq, lfo, ns, ws);
      n.rpm = (f, at, tc) => {
        for (const [p, mul] of [[saw.frequency, 1], [sq.frequency, 2], [lfo.frequency, 0.5]]) p.setTargetAtTime(f * mul, at, tc);
        lp.frequency.setTargetAtTime(f > IDLE ? 1400 : 650, at, tc);
        nb.frequency.setTargetAtTime(f > IDLE ? 2000 : 1100, at, tc);
        ng.gain.setTargetAtTime(f > IDLE ? 0.12 : 0.05, at, tc);
      };
    }, { fade: 0.6, max: 600, gain: 1, far });
  },

  /** Boat wake: hull slap, spray and a wash trailing behind. */
  wake(far = 0, dur = 1.6) {
    this._safe(() => {
      const d = Math.max(0.4, Math.min(8, Number(dur) || 1.6));
      const v = this._voice({ cat: 'misc', dur: d + 0.8, far: clamp01(far), gain: 0.75, rev: 0.15 });
      if (!v) return;
      this._noise(v, { buf: 'pink', a: d * 0.3, d: d * 0.7, vol: 0.3, type: 'bandpass', f: 1300, q: 0.8, pan: -0.3, panTo: 0.3 });
      this._noise(v, { buf: 'brown', a: d * 0.3, d: d * 0.8, vol: 0.35, type: 'lowpass', f: 500 });
      this._noise(v, { at: 0.1, a: 0.1, d: d * 0.6, vol: 0.08, type: 'highpass', f: 4500 });
      for (let i = 0; i < Math.round(d * 3); i++) {
        const at = rnd(0, d);
        this._noise(v, { at, a: 0.005, d: 0.08, vol: 0.12, type: 'bandpass', f: rnd(500, 1100), q: 1.5 });
      }
    });
  },

  // ---------------------------------------------------------- destruction

  /** A building gives way: snap, metal groan, rumble, debris cascade, dust. */
  buildingCollapse(far = 0) {
    this._safe(() => {
      const fr = clamp01(far);
      const v = this._voice({ cat: 'boom', dur: 4.8, far: fr, gain: 0.7, rev: 0.35, echo: 0.15 });
      if (!v) return;
      this._noise(v, { a: 0.0005, d: 0.06, vol: 0.6, type: 'highpass', f: 1800 });
      this._osc(v, { f: 95, f2: 40, a: 0.002, d: 0.3, vol: 0.6 });
      // Groan: slow, wavering metal.
      this._osc(v, { type: 'sawtooth', at: 0.1, f: 90, f2: 62, a: 0.3, d: 1.1, glide: 1.3, vol: 0.05 });
      this._noise(v, { at: 0.1, a: 0.3, d: 1.0, vol: 0.12, type: 'bandpass', f: 420, f2: 300, q: 6 });
      // The fall.
      this._osc(v, { at: 0.9, f: 55, f2: 24, a: 0.05, d: 2.2, glide: 1.5, vol: 0.9 });
      this._noise(v, { at: 0.85, buf: 'brown', a: 0.15, d: 3.0, vol: 0.9, type: 'lowpass', f: 1400, f2: 120, sweep: 0.8 });
      for (let i = 0; i < 6; i++) {
        const at = 0.9 + i * rnd(0.18, 0.32);
        this._noise(v, { at, buf: 'crackle', a: 0.01, d: rnd(0.3, 0.6), vol: 0.35, type: 'bandpass', f: rnd(1200, 3200), q: 0.8, pan: rnd(-0.6, 0.6) });
        this._osc(v, { at, f: rnd(70, 110), f2: 40, a: 0.002, d: 0.15, vol: 0.3 });
      }
      this._noise(v, { at: 1.8, a: 0.6, d: 2.0, vol: 0.06, type: 'highpass', f: 5000 }); // dust
      this._duck(0.8, 2.5, 1.2);
    });
  },

  // ------------------------------------------------------------ stage events

  /** One round of warning before a stage event: a siren for that kind. */
  stageEventWarn(kind) {
    this._safe(() => {
      const k = stageKind(kind);
      this.radioCallout('stage');
      const v = this._voice({ cat: 'tell', dur: 4.2, gain: 0.75, rev: 0.35, echo: 0.2 });
      if (!v) return;
      const at0 = 0.9;
      if (k === 'harbor') {
        this._horn(v, at0, 1.4, 0.16); this._horn(v, at0 + 1.8, 1.0, 0.13);
      } else if (k === 'kelp') {
        // Biohazard warble + geiger crackle.
        for (let i = 0; i < 6; i++) this._osc(v, { type: 'triangle', at: at0 + i * 0.4, f: i % 2 ? 1300 : 900, f2: i % 2 ? 900 : 1300, a: 0.02, d: 0.36, glide: 0.36, vol: 0.06 });
        this._noise(v, { buf: 'crackle', at: at0, a: 0.2, d: 2.2, vol: 0.18, type: 'highpass', f: 2000, rate: 0.6 });
      } else if (k === 'rig') {
        // Alarm bell + structural groan.
        for (let i = 0; i < 18; i++) this._metal(v, at0 + i * 0.09, 2300, 0.05);
        this._osc(v, { type: 'sawtooth', at: at0 + 1.7, f: 70, f2: 52, a: 0.3, d: 1.2, vol: 0.05 });
      } else if (k === 'spire' || k === 'surge' || k === 'generic') {
        this._siren(v, at0, k === 'surge' ? 3.0 : 2.6, k === 'surge' ? 0.07 : 0.06);
        if (k === 'surge') this._noise(v, { buf: 'brown', at: at0, a: 1.5, d: 1.5, vol: 0.3, type: 'lowpass', f: 300 });
        if (k === 'spire') this._noise(v, { at: at0 + 1.2, a: 0.3, d: 0.9, vol: 0.12, type: 'bandpass', f: 380, q: 7 });
      }
      this._duck(0.5, 2.5, 1.0);
    });
  },

  /** The stage event itself: the set piece for that map. */
  stageEvent(kind) {
    this._safe(() => {
      const k = stageKind(kind);
      const v = this._voice({ cat: 'boom', dur: 6.5, gain: 0.7, rev: 0.4, echo: 0.2 });
      if (!v) return;
      if (k === 'harbor') {
        this._horn(v, 0, 2.2, 0.2);
        // Hull grinding along the quay.
        this._noise(v, { at: 0.4, a: 0.4, d: 3.4, vol: 0.4, type: 'bandpass', f: 900, f2: 280, q: 2.5 });
        this._noise(v, { buf: 'crackle', at: 0.5, a: 0.3, d: 3.2, vol: 0.3, type: 'bandpass', f: 1800, q: 0.8, pan: -0.5, panTo: 0.5 });
        this._osc(v, { type: 'sawtooth', at: 0.4, f: 48, f2: 36, a: 0.5, d: 3.2, vol: 0.06 });
        for (const at of [1.5, 2.15, 2.7]) this._clang(v, at);
      } else if (k === 'kelp') {
        // The Red Tide blooms: bubbling, a toxic hiss, a sour drone.
        for (let i = 0; i < 24; i++) this._osc(v, { at: rnd(0, 3.5), f: rnd(200, 600), f2: rnd(600, 1200), a: 0.005, d: 0.06, vol: 0.06 });
        this._noise(v, { at: 0.2, a: 1.2, d: 2.6, vol: 0.18, type: 'bandpass', f: 2600, q: 0.7 });
        this._osc(v, { type: 'sawtooth', f: 73.4, a: 1.0, d: 3.5, vol: 0.04 });
        this._osc(v, { type: 'sawtooth', f: 77.8, a: 1.0, d: 3.5, vol: 0.035 });
        this._noise(v, { buf: 'brown', a: 0.8, d: 3.0, vol: 0.3, type: 'lowpass', f: 260 });
      } else if (k === 'rig') {
        this._noise(v, { a: 0.0005, d: 0.08, vol: 0.6, type: 'highpass', f: 1600 }); // snap
        this._osc(v, { type: 'sawtooth', at: 0.05, f: 80, f2: 45, a: 0.2, d: 1.3, glide: 1.4, vol: 0.06 });
        this._clang(v, 0.9); this._clang(v, 1.2);
        this._boom(v, 1.4, 0.9);
        this._splash(v, 1.6, 2.6);
      } else if (k === 'spire') {
        this._noise(v, { a: 0.0005, d: 0.1, vol: 0.6, type: 'highpass', f: 1500 }); // crack
        this._noise(v, { at: 0.1, a: 0.6, d: 1.4, vol: 0.14, type: 'bandpass', f: 320, f2: 220, q: 7 }); // creak
        this._noise(v, { at: 1.0, a: 1.0, d: 0.2, vol: 0.3, type: 'bandpass', f: 400, f2: 1800, q: 1, pan: -0.6, panTo: 0.6 }); // fall
        this._boom(v, 2.2, 1.0);
        for (let i = 0; i < 6; i++) this._noise(v, { at: 2.3 + i * rnd(0.15, 0.3), buf: 'crackle', a: 0.01, d: 0.5, vol: 0.3, type: 'bandpass', f: rnd(1300, 3000), pan: rnd(-0.6, 0.6) });
      } else if (k === 'surge') {
        // Rogue wave: approaching roar, the crash, the wash receding.
        this._noise(v, { buf: 'brown', a: 1.8, d: 0.3, vol: 0.7, type: 'lowpass', f: 200, f2: 1500, sweep: 1 });
        this._noise(v, { buf: 'pink', at: 0.6, a: 1.3, d: 0.3, vol: 0.25, type: 'bandpass', f: 600, f2: 2000, q: 0.7 });
        this._boom(v, 2.0, 0.7);
        this._noise(v, { at: 2.0, a: 0.01, d: 0.8, vol: 0.5, type: 'lowpass', f: 6000, f2: 1500 });
        this._splash(v, 2.05, 3.2);
      } else {
        this._boom(v, 0, 0.9);
        this._noise(v, { buf: 'brown', a: 0.1, d: 3, vol: 0.6, type: 'lowpass', f: 900, f2: 140 });
      }
      this._duck(0.85, 4.0, 1.5);
    });
  },

  _boom(v, at, vol) {
    this._osc(v, { at, f: 65, f2: 24, a: 0.003, d: 1.2, glide: 0.8, vol });
    this._noise(v, { at, a: 0.001, d: 0.06, vol: vol * 0.6, type: 'highpass', f: 1500 });
    this._noise(v, { at, buf: 'brown', a: 0.004, d: 1.8, vol: vol * 0.9, type: 'lowpass', f: 1800, f2: 140, sweep: 0.7 });
    this._noise(v, { at: at + 0.08, buf: 'crackle', a: 0.05, d: 1.2, vol: vol * 0.35, type: 'bandpass', f: 2800, f2: 1300 });
  },

  _splash(v, at, d) {
    this._noise(v, { at, buf: 'pink', a: 0.02, d, vol: 0.45, type: 'lowpass', f: 4000, f2: 600, pan: -0.3, panTo: 0.3 });
    this._noise(v, { at: at + 0.1, a: 0.2, d: d * 0.8, vol: 0.1, type: 'highpass', f: 4000 });
  },

  _clang(v, at) {
    for (const [f, vol, d] of [[180, 0.3, 0.9], [417, 0.14, 0.6], [733, 0.08, 0.4], [1130, 0.05, 0.3]]) this._osc(v, { at, f: f * rnd(0.97, 1.03), a: 0.001, d, vol });
    this._noise(v, { at, a: 0.001, d: 0.1, vol: 0.4, type: 'bandpass', f: 1200, q: 1 });
    this._osc(v, { at, f: 70, f2: 35, a: 0.002, d: 0.3, vol: 0.5 });
  },

  /** Ship horn: a low, slightly sour chord. */
  _horn(v, at, d, vol) {
    for (const [f, k] of [[69, 1], [87, 0.6], [104, 0.5]]) {
      this._osc(v, { type: 'sawtooth', at, f, a: 0.12, d, vol: vol * k * 0.4 });
      this._osc(v, { type: 'square', at, f: f * 2, a: 0.12, d, vol: vol * k * 0.08 });
    }
  },

  /** Air-raid style siren: rise, hold, fall. */
  _siren(v, at, d, vol) {
    const ctx = this.ctx, t = v.t + at;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + d * 0.3);
    g.gain.setValueAtTime(vol, t + d * 0.7); g.gain.linearRampToValueAtTime(0, t + d);
    lp.connect(g).connect(v.out);
    for (const [type, mul] of [['sawtooth', 1], ['square', 1.5]]) {
      const o = ctx.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(260 * mul, t);
      o.frequency.exponentialRampToValueAtTime(680 * mul, t + d * 0.4);
      o.frequency.setValueAtTime(680 * mul, t + d * 0.65);
      o.frequency.exponentialRampToValueAtTime(300 * mul, t + d);
      const og = ctx.createGain(); og.gain.value = mul === 1 ? 1 : 0.35;
      o.connect(og).connect(lp); o.start(t); o.stop(t + d + 0.02); v.srcs.push(o);
    }
    if (t + d + 0.1 > v.end) v.end = t + d + 0.1;
  },

  // ---------------------------------------------------------------- the Pit

  /** Back from the Pit: radio chirp, wind rush, chute snap, boots down. */
  redeploy() {
    this._safe(() => {
      this.radioCallout('redeploy');
      const v = this._voice({ cat: 'misc', dur: 2.8, gain: 0.85, rev: 0.15 });
      if (!v) return;
      this._noise(v, { at: 0.5, a: 0.3, d: 0.9, vol: 0.4, type: 'bandpass', f: 3000, f2: 700, q: 0.8, pan: -0.3, panTo: 0.3 });
      this._noise(v, { at: 1.15, a: 0.002, d: 0.08, vol: 0.4, type: 'bandpass', f: 900, q: 1 }); // chute snap
      this._osc(v, { at: 1.15, f: 110, f2: 60, a: 0.002, d: 0.12, vol: 0.4 });
      this._noise(v, { buf: 'pink', at: 1.2, a: 0.1, d: 0.6, vol: 0.15, type: 'bandpass', f: 1400, q: 0.7 }); // canopy flutter
      this._osc(v, { at: 1.95, f: 120, f2: 48, a: 0.002, d: 0.2, vol: 0.65 }); // landing
      this._noise(v, { at: 1.95, buf: 'pink', a: 0.002, d: 0.14, vol: 0.3, type: 'lowpass', f: 800 });
    });
  },

  /** Enter the Pit (pit_enter): a heavy gate and a descending drone. */
  pitEnter() {
    this._safe(() => {
      const v = this._voice({ cat: 'misc', dur: 2.6, gain: 0.8, rev: 0.4, echo: 0.2 });
      if (!v) return;
      this._clang(v, 0);
      this._osc(v, { type: 'sawtooth', at: 0.2, f: 110, f2: 55, a: 0.3, d: 1.8, glide: 1.8, vol: 0.05 });
      this._osc(v, { at: 0.2, f: 55, f2: 36, a: 0.3, d: 1.8, vol: 0.22 });
      this._duck(0.5, 1.5, 0.8);
    });
  },
};
