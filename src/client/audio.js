// Tidefall audio: "a war heard over a hijacked radio net".
// Everything is synthesized with the Web Audio API (no audio files).
//
// Graph:
//   voices ─┬─ sfxBus ──────────────────────────┐
//           ├─ radioBus (band-limit + drive) ───┤
//           ├─ reverb send ─ Convolver ─────────┤
//           └─ echo send ─ tape delay loop ─────┤
//   music ── musicIn ─ duck gain ───────────────┤
//   stingers ── stingerIn ──────────────────────┤
//                                               ▼
//                pre ─ glue comp ─ limiter ─ soft clip ─ volume ─ destination
//
// Public API (docs/V1_SPEC.md §3). Every method is a no-op before resume(),
// while muted, or if Web Audio is unavailable.

import { makeNoise, makeCrackle, makeImpulse, softClipCurve, driveCurve } from './sfx/buffers.js';
import { Score } from './sfx/music.js';

const MAX_VOICES = 40;
// Per-category concurrency caps and the minimum spacing between voices of the
// same category (closer requests get staggered into a flam instead of stacking).
const CATS = {
  shot: { cap: 6, gap: 0.018 },
  impact: { cap: 5, gap: 0.015 },
  boom: { cap: 3, gap: 0.04 },
  step: { cap: 3, gap: 0.03 },
  ui: { cap: 3, gap: 0.012 },
  tick: { cap: 2, gap: 0.03 },
  tell: { cap: 2, gap: 0.05 },
  misc: { cap: 6, gap: 0.01 },
};
const BASE_GAIN = 0.9;

const clamp01 = (x) => { const v = Number(x); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; };
const rnd = (a, b) => a + Math.random() * (b - a);

function weaponKind(w) {
  const s = String(w ?? 'rifle').toLowerCase().replace(/[\s_-]/g, '');
  if (s.includes('long') || s.includes('sniper') || s.includes('marks')) return 'longrifle';
  if (s.includes('shot')) return 'shotgun';
  return 'rifle';
}

export class Sfx {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.volume = 1;
    this.offline = false;
    this.voices = [];
    this.catLast = Object.create(null);
    this._wantMusic = false;
    this._intensity = 0.15;
    this._duckUntil = 0;
    this._duckLevel = 1;
    this._stepAlt = 0;
    this.score = null;
  }

  // ------------------------------------------------------------------ setup

  /** Create/unlock the AudioContext. Call from a user gesture (iOS needs it). */
  resume() {
    try {
      if (!this.ctx) {
        const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
        if (!AC) return;
        let ctx;
        try { ctx = new AC({ latencyHint: 'interactive' }); } catch { ctx = new AC(); }
        this._attach(ctx);
        this._installUnlock();
      }
      const ctx = this.ctx;
      if (ctx.state !== 'running') {
        const p = ctx.resume();
        if (p && p.catch) p.catch(() => {});
      }
      // Old iOS: playing a buffer inside the gesture is what actually unlocks output.
      if (!this._unlocked) {
        this._unlocked = true;
        const b = ctx.createBufferSource();
        b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        b.connect(ctx.destination);
        (b.start || b.noteOn).call(b, 0);
      }
    } catch {
      this.ctx = null;
    }
  }

  /**
   * Build the graph on an existing context. Used by resume(); tests also use it
   * with an OfflineAudioContext to render and measure sounds.
   */
  _attach(ctx, { offline = false } = {}) {
    this.ctx = ctx;
    this.offline = offline;
    const sr = ctx.sampleRate;
    this.buf = {
      white: makeNoise(ctx, 'white', 2, 3),
      pink: makeNoise(ctx, 'pink', 2, 5),
      brown: makeNoise(ctx, 'brown', 2, 9),
      crackle: makeCrackle(ctx, 2, 0.0022, 13),
    };
    void sr;

    // Master chain.
    const pre = ctx.createGain(); pre.gain.value = 0.8;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 24; hp.Q.value = 0.6;
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -18; glue.knee.value = 10; glue.ratio.value = 3;
    glue.attack.value = 0.005; glue.release.value = 0.2;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20;
    lim.attack.value = 0.001; lim.release.value = 0.09;
    const makeup = ctx.createGain(); makeup.gain.value = 1.25;
    const clip = ctx.createWaveShaper(); clip.curve = softClipCurve(); clip.oversample = '2x';
    const out = ctx.createGain(); out.gain.value = this._outGain();
    pre.connect(hp).connect(glue).connect(lim).connect(makeup).connect(clip).connect(out).connect(ctx.destination);
    this.pre = pre; this.master = out; this.limiter = lim; this.glue = glue;

    // SFX bus (dry, punchy).
    this.sfxBus = ctx.createGain(); this.sfxBus.gain.value = 1;
    this.sfxBus.connect(pre);

    // Radio bus: band-limited, lightly driven.
    const rIn = ctx.createGain(); rIn.gain.value = 1;
    const rHp = ctx.createBiquadFilter(); rHp.type = 'highpass'; rHp.frequency.value = 380;
    const rLp = ctx.createBiquadFilter(); rLp.type = 'lowpass'; rLp.frequency.value = 3400; rLp.Q.value = 1.1;
    const rDr = ctx.createWaveShaper(); rDr.curve = driveCurve();
    const rOut = ctx.createGain(); rOut.gain.value = 0.8;
    rIn.connect(rHp).connect(rLp).connect(rDr).connect(rOut).connect(pre);
    this.radioBus = rIn;

    // Shared convolution reverb.
    this.reverbIn = ctx.createGain(); this.reverbIn.gain.value = 1;
    const conv = ctx.createConvolver(); conv.normalize = false; conv.buffer = makeImpulse(ctx, 2.6, 2.6, 21);
    const revLp = ctx.createBiquadFilter(); revLp.type = 'lowpass'; revLp.frequency.value = 5200;
    const revHp = ctx.createBiquadFilter(); revHp.type = 'highpass'; revHp.frequency.value = 120;
    const revOut = ctx.createGain(); revOut.gain.value = 0.16;
    this.reverbIn.connect(revHp).connect(conv).connect(revLp).connect(revOut).connect(pre);

    // Tape echo: feedback delay with filtering in the loop.
    this.echoIn = ctx.createGain(); this.echoIn.gain.value = 1;
    const dl = ctx.createDelay(1.5); dl.delayTime.value = 0.34;
    const fb = ctx.createGain(); fb.gain.value = 0.33;
    const eLp = ctx.createBiquadFilter(); eLp.type = 'lowpass'; eLp.frequency.value = 2300;
    const eHp = ctx.createBiquadFilter(); eHp.type = 'highpass'; eHp.frequency.value = 220;
    const eOut = ctx.createGain(); eOut.gain.value = 0.32;
    this.echoIn.connect(dl).connect(eLp).connect(eHp).connect(fb).connect(dl);
    eHp.connect(eOut).connect(pre);
    const eRev = ctx.createGain(); eRev.gain.value = 0.25; eOut.connect(eRev).connect(this.reverbIn);

    // Music bus (ducked) and stinger bus (not ducked).
    this.musicIn = ctx.createGain(); this.musicIn.gain.value = 0.15;
    this.musicDuck = ctx.createGain(); this.musicDuck.gain.value = 1;
    this.musicIn.connect(this.musicDuck).connect(pre);
    this.stingerIn = ctx.createGain(); this.stingerIn.gain.value = 0.3;
    this.stingerIn.connect(pre);

    this.score = new Score(this);
    this.score.setIntensity(this._intensity);
    if (this._wantMusic) this.score.start();
  }

  _installUnlock() {
    if (typeof document === 'undefined' || this._unlockInstalled) return;
    this._unlockInstalled = true;
    const kick = () => {
      const c = this.ctx;
      if (c && c.state !== 'running' && c.state !== 'closed') {
        const p = c.resume(); if (p && p.catch) p.catch(() => {});
      }
    };
    for (const ev of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(ev, kick, { passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
  }

  _outGain() { return this.muted ? 0 : this.volume * BASE_GAIN; }

  _applyOut() {
    if (!this.master) return;
    const t = this.ctx.currentTime, g = this.master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this._outGain(), t + 0.05);
  }

  /** True when a new sound may be scheduled. */
  canPlay() {
    const c = this.ctx;
    return !!c && !this.muted && this.volume > 0 && (this.offline || c.state === 'running');
  }

  // ------------------------------------------------------------ public: bus

  toggle() {
    this.muted = !this.muted;
    try { this._applyOut(); } catch { /* ignore */ }
    return this.muted;
  }

  setMuted(m) { if (!!m !== this.muted) this.toggle(); return this.muted; }

  setVolume(v) {
    this.volume = clamp01(v);
    try { this._applyOut(); } catch { /* ignore */ }
  }

  setIntensity(x) {
    this._intensity = clamp01(x);
    this.score?.setIntensity(this._intensity);
  }

  startMusic() {
    this._wantMusic = true;
    try { if (this.score) this.score.start(); } catch { /* ignore */ }
  }

  stopMusic() {
    this._wantMusic = false;
    try { this.score?.stop(); } catch { /* ignore */ }
  }

  stinger(kind) {
    if (!this.canPlay()) return;
    try {
      const k = ['victory', 'defeat', 'round', 'tide'].includes(kind) ? kind : 'round';
      const len = this.score.stinger(k);
      this._duck(k === 'round' ? 0.5 : 0.8, len * 0.7, 0.8);
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------- voice machinery

  /**
   * Allocate a voice: a gain node feeding the chosen bus, optionally through a
   * distance low-pass, plus reverb/echo sends. Returns null if dropped.
   * opts: { cat, dur, far, gain, rev, echo, bus:'sfx'|'radio' }
   */
  _voice(o) {
    if (!this.canPlay()) return null;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const cat = CATS[o.cat] ? o.cat : 'misc';
    const spec = CATS[cat];

    // Prune finished voices in place.
    const vs = this.voices;
    let w = 0, inCat = 0, oldestCat = null;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      if (v.end > now) {
        vs[w++] = v;
        if (v.cat === cat) { inCat++; if (!oldestCat) oldestCat = v; }
      }
    }
    vs.length = w;

    let t = now + 0.006;
    const last = this.catLast[cat] ?? -1;
    if (t < last + spec.gap) {
      t = last + spec.gap;
      if (t - now > 0.12) return null; // too crowded: drop rather than lag
    }
    if (inCat >= spec.cap && oldestCat) this._steal(oldestCat, now);
    else if (vs.length >= MAX_VOICES) this._steal(vs[0], now);
    this.catLast[cat] = t;

    const far = clamp01(o.far ?? 0);
    const dur = o.dur ?? 0.5;
    const out = ctx.createGain();
    out.gain.value = (o.gain ?? 1) * (1 - 0.72 * far);
    let tail = out;
    if (far > 0.02) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 700 + 15000 * Math.pow(1 - far, 2.2);
      lp.Q.value = 0.5;
      out.connect(lp);
      tail = lp;
    }
    tail.connect(o.bus === 'radio' ? this.radioBus : this.sfxBus);
    const rev = (o.rev ?? 0.1) + 0.4 * far;
    if (rev > 0.001) {
      const s = ctx.createGain(); s.gain.value = rev;
      tail.connect(s).connect(this.reverbIn);
    }
    if (o.echo) {
      const s = ctx.createGain(); s.gain.value = o.echo * (0.6 + 0.4 * far);
      tail.connect(s).connect(this.echoIn);
    }
    const v = { cat, t, end: t + dur + 0.05, out, srcs: [] };
    vs.push(v);
    return v;
  }

  _steal(v, now) {
    try {
      const g = v.out.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + 0.02);
      for (const s of v.srcs) { try { s.stop(now + 0.03); } catch { /* stopped */ } }
    } catch { /* ignore */ }
    v.end = now; // pruned on next allocation
  }

  /** ADSR-less percussive envelope on a gain param. */
  _env(g, t, a, peak, d) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + Math.max(0.0005, a));
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  _dest(v, pan) {
    if (!pan || !this.ctx.createStereoPanner) return v.out;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(v.out);
    return p;
  }

  /**
   * Filtered noise layer.
   * { buf, at, a, d, vol, type, f, f2, q, rate, pan, panTo, dest }
   */
  _noise(v, p) {
    const ctx = this.ctx;
    const t = v.t + (p.at ?? 0);
    const s = ctx.createBufferSource();
    s.buffer = this.buf[p.buf ?? 'white'];
    s.playbackRate.value = p.rate ?? 1;
    const f = ctx.createBiquadFilter();
    f.type = p.type ?? 'lowpass';
    f.Q.value = p.q ?? 0.7;
    f.frequency.setValueAtTime(p.f ?? 2000, t);
    const a = p.a ?? 0.001, d = p.d ?? 0.1;
    if (p.f2) f.frequency.exponentialRampToValueAtTime(p.f2, t + a + d * (p.sweep ?? 1));
    const g = ctx.createGain();
    this._env(g, t, a, p.vol ?? 0.3, d);
    let dest = p.dest ?? v.out;
    if ((p.pan || p.panTo !== undefined) && ctx.createStereoPanner) {
      const pn = ctx.createStereoPanner();
      pn.pan.setValueAtTime(p.pan ?? 0, t);
      if (p.panTo !== undefined) pn.pan.linearRampToValueAtTime(p.panTo, t + a + d);
      pn.connect(dest);
      dest = pn;
    }
    s.connect(f).connect(g).connect(dest);
    const len = s.buffer.duration;
    s.start(t, Math.random() * Math.max(0, len - (a + d) * (p.rate ?? 1) - 0.05));
    s.stop(t + a + d + 0.02);
    v.srcs.push(s);
    return g;
  }

  /** Oscillator layer. { type, at, a, d, vol, f, f2, glide, det, dest } */
  _osc(v, p) {
    const ctx = this.ctx;
    const t = v.t + (p.at ?? 0);
    const o = ctx.createOscillator();
    o.type = p.type ?? 'sine';
    o.frequency.setValueAtTime(p.f, t);
    if (p.det) o.detune.value = p.det;
    const a = p.a ?? 0.002, d = p.d ?? 0.1;
    if (p.f2) o.frequency.exponentialRampToValueAtTime(p.f2, t + (p.glide ?? a + d));
    const g = ctx.createGain();
    this._env(g, t, a, p.vol ?? 0.2, d);
    o.connect(g).connect(p.dest ?? v.out);
    o.start(t);
    o.stop(t + a + d + 0.02);
    v.srcs.push(o);
    return g;
  }

  /** Sidechain-style music duck. depth 0..1, hold seconds. */
  _duck(depth, hold = 0.15, release = 0.45) {
    const g = this.musicDuck?.gain;
    if (!g) return;
    const now = this.ctx.currentTime;
    const target = 1 - depth;
    if (now < this._duckUntil && target >= this._duckLevel) return; // already ducked deeper
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0.0001, g.value), now);
    g.setTargetAtTime(target, now, 0.012);
    g.setTargetAtTime(1, now + hold, release);
    this._duckLevel = target;
    this._duckUntil = now + hold;
  }

  /** Relay click: a tiny mechanical transient. */
  _click(v, at, f = 3800, vol = 0.25) {
    this._noise(v, { at, a: 0.0005, d: 0.009, vol: vol * 1.6, type: 'bandpass', f, q: 1.1 });
    this._osc(v, { at, type: 'square', f: f * 0.42, a: 0.0005, d: 0.012, vol: vol * 0.3 });
  }

  /** Radio squelch: band-passed noise burst with a carrier click. Uses any dest. */
  _squelch(t, dur, dest, vol = 0.3) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource(); s.buffer = this.buf.white;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2600; f.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.004);
    g.gain.setValueAtTime(vol * 0.8, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.006); // hard-ish cut, radio style
    s.connect(f).connect(g).connect(dest);
    s.start(t, Math.random()); s.stop(t + dur + 0.02);
    return s;
  }

  /** Crackly static burst ending in an abrupt cut. */
  _static(t, dur, vol, dest) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource(); s.buffer = this.buf.white;
    const c = ctx.createBufferSource(); c.buffer = this.buf.crackle;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.setValueAtTime(vol, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.004);
    const cg = ctx.createGain(); cg.gain.value = 1.6;
    s.connect(f); c.connect(cg).connect(f);
    f.connect(g).connect(dest);
    s.start(t, Math.random()); c.start(t, Math.random());
    s.stop(t + dur + 0.02); c.stop(t + dur + 0.02);
    return [s, c];
  }

  _safe(fn) {
    if (!this.canPlay()) return;
    try { fn(); } catch { /* audio must never break the game */ }
  }

  // ------------------------------------------------------------ SFX: combat

  /** far: 0 = next to you, 1 = distant/unseen. weapon: 'rifle'|'longrifle'|'shotgun'. */
  shot(far = 0, weapon = 'rifle') {
    this._safe(() => {
      const kind = weaponKind(weapon);
      const fr = clamp01(far);
      const p = rnd(0.94, 1.06);
      if (kind === 'longrifle') {
        const v = this._voice({ cat: 'shot', dur: 1.1, far: fr, gain: 0.85, rev: 0.22, echo: 0.42 });
        if (!v) return;
        this._noise(v, { a: 0.0005, d: 0.05, vol: 0.9, type: 'highpass', f: 2200 * p, q: 0.8 });
        this._noise(v, { a: 0.0008, d: 0.09, vol: 0.6, type: 'bandpass', f: 3000 * p, q: 1.6 });
        this._noise(v, { a: 0.002, d: 0.38, vol: 0.7, type: 'lowpass', f: 1400 * p, f2: 260, q: 0.9 });
        this._osc(v, { f: 110 * p, f2: 34, a: 0.001, d: 0.32, glide: 0.2, vol: 0.85 });
        this._noise(v, { buf: 'brown', at: 0.02, a: 0.03, d: 0.8, vol: 0.35, type: 'lowpass', f: 500, f2: 120 });
        // Bolt cycle: two relay-like clicks.
        this._click(v, 0.62, 2400, 0.12);
        this._click(v, 0.78, 1800, 0.14);
        this._duck(0.45, 0.2, 0.5);
      } else if (kind === 'shotgun') {
        const v = this._voice({ cat: 'shot', dur: 0.95, far: fr, gain: 0.9, rev: 0.16 });
        if (!v) return;
        // Two detuned layers panned wide and offset a few ms for width.
        this._noise(v, { a: 0.001, d: 0.24, vol: 0.75, type: 'lowpass', f: 2600 * p, f2: 300, q: 0.6, pan: -0.45 });
        this._noise(v, { at: 0.006, a: 0.001, d: 0.26, vol: 0.75, type: 'lowpass', f: 2300 * p, f2: 280, q: 0.6, pan: 0.45, rate: 0.9 });
        this._noise(v, { a: 0.0005, d: 0.035, vol: 0.5, type: 'highpass', f: 1600 });
        this._osc(v, { f: 85 * p, f2: 30, a: 0.002, d: 0.32, glide: 0.25, vol: 1.0 });
        this._noise(v, { buf: 'brown', a: 0.004, d: 0.45, vol: 0.5, type: 'lowpass', f: 380 });
        // Pump: ka-chunk.
        this._noise(v, { at: 0.5, a: 0.001, d: 0.03, vol: 0.18, type: 'bandpass', f: 1500, q: 3 });
        this._noise(v, { at: 0.62, a: 0.001, d: 0.045, vol: 0.22, type: 'bandpass', f: 850, q: 3 });
        this._duck(0.45, 0.15, 0.45);
      } else {
        const v = this._voice({ cat: 'shot', dur: 0.45, far: fr, gain: 1.0, rev: 0.12, echo: 0.08 });
        if (!v) return;
        this._noise(v, { a: 0.0004, d: 0.045, vol: 0.85, type: 'highpass', f: 2600 * p, q: 0.9 });
        this._noise(v, { a: 0.001, d: 0.14, vol: 0.6, type: 'lowpass', f: 1100 * p, f2: 300, q: 1 });
        this._osc(v, { f: 150 * p, f2: 48, a: 0.001, d: 0.13, glide: 0.09, vol: 0.7 });
        this._osc(v, { type: 'square', f: 2900 * p, a: 0.0003, d: 0.006, vol: 0.06 });
        this._duck(0.3, 0.08, 0.35);
      }
    });
  }

  hit(graze = false) {
    this._safe(() => {
      const v = this._voice({ cat: 'impact', dur: 0.3, gain: graze ? 0.95 : 0.6, rev: 0.06 });
      if (!v) return;
      if (graze) {
        this._noise(v, { a: 0.001, d: 0.06, vol: 0.4, type: 'bandpass', f: 2600, q: 2 });
        this._osc(v, { type: 'triangle', f: 1650 * rnd(0.95, 1.05), f2: 1400, a: 0.001, d: 0.18, vol: 0.12 });
        this._osc(v, { f: 220, f2: 120, a: 0.001, d: 0.06, vol: 0.3 });
      } else {
        this._noise(v, { a: 0.001, d: 0.05, vol: 0.6, type: 'bandpass', f: 1100 * rnd(0.9, 1.1), q: 1.4 });
        this._noise(v, { buf: 'brown', a: 0.002, d: 0.12, vol: 0.5, type: 'lowpass', f: 600 });
        this._osc(v, { f: 190, f2: 62, a: 0.001, d: 0.12, vol: 0.75 });
      }
    });
  }

  miss() {
    this._safe(() => {
      const v = this._voice({ cat: 'impact', dur: 0.55, gain: 1.6, rev: 0.18 });
      if (!v) return;
      const side = Math.random() < 0.5 ? -1 : 1;
      const f0 = rnd(3000, 3800);
      // Ricochet whizz: sweeping tone with a noise shadow, crossing the stereo field.
      this._osc(v, { type: 'triangle', f: f0, f2: f0 * 0.32, a: 0.004, d: 0.42, vol: 0.16, dest: this._dest(v, side * 0.6) });
      this._osc(v, { f: f0 * 1.5, f2: f0 * 0.5, a: 0.004, d: 0.3, vol: 0.05, det: 15, dest: this._dest(v, side * 0.3) });
      this._noise(v, { a: 0.01, d: 0.3, vol: 0.18, type: 'bandpass', f: 5000, f2: 1400, q: 3, pan: side * 0.7, panTo: -side * 0.6 });
      this._noise(v, { a: 0.0008, d: 0.03, vol: 0.25, type: 'bandpass', f: 2200, q: 2, pan: side * 0.5 });
    });
  }

  death() {
    this._safe(() => {
      const v = this._voice({ cat: 'misc', dur: 1.0, bus: 'radio', gain: 0.9, rev: 0.1 });
      if (!v) return;
      // Body drop, then the comms line fills with static and is cut dead.
      this._osc(v, { f: 120, f2: 45, a: 0.003, d: 0.25, vol: 0.5 });
      v.srcs.push(...this._static(v.t + 0.05, 0.5, 0.35, v.out));
      this._osc(v, { type: 'sawtooth', at: 0.05, f: 620, f2: 180, a: 0.02, d: 0.45, vol: 0.05 });
      this._click(v, 0.56, 1600, 0.35); // the cut-off
      this._duck(0.5, 0.5, 0.6);
    });
  }

  explosion(far = 0) {
    this._safe(() => {
      const fr = clamp01(far);
      const v = this._voice({ cat: 'boom', dur: 2.0, far: fr, gain: 0.75, rev: 0.3, echo: 0.25 });
      if (!v) return;
      this._osc(v, { f: 75, f2: 26, a: 0.003, d: 0.9, glide: 0.6, vol: 1.0 });
      this._osc(v, { f: 52, f2: 30, a: 0.01, d: 1.1, vol: 0.4 });
      this._noise(v, { a: 0.001, d: 0.05, vol: 0.7, type: 'highpass', f: 1500 });
      this._noise(v, { buf: 'brown', a: 0.004, d: 1.3, vol: 0.9, type: 'lowpass', f: 2200, f2: 160, q: 0.7, sweep: 0.7 });
      this._noise(v, { a: 0.002, d: 0.5, vol: 0.4, type: 'lowpass', f: 3500, f2: 400, pan: -0.3 });
      this._noise(v, { at: 0.01, a: 0.002, d: 0.5, vol: 0.4, type: 'lowpass', f: 3200, f2: 380, pan: 0.3 });
      // Debris crackle falling back down.
      this._noise(v, { buf: 'crackle', at: 0.09, a: 0.05, d: 1.3, vol: 0.45, type: 'bandpass', f: 3200, f2: 1400, q: 0.8 });
      this._noise(v, { buf: 'crackle', at: 0.2, a: 0.08, d: 0.9, vol: 0.3, type: 'highpass', f: 1800, rate: 0.7, pan: 0.4 });
      this._duck(0.75, 0.6, 0.9);
    });
  }

  grenadeThrow() {
    this._safe(() => {
      const v = this._voice({ cat: 'misc', dur: 0.6, gain: 2.0, rev: 0.1 });
      if (!v) return;
      // Pin pull + spoon flick.
      this._osc(v, { type: 'triangle', f: 4200, a: 0.0005, d: 0.012, vol: 0.18 });
      this._osc(v, { type: 'triangle', at: 0.045, f: 6200, a: 0.0005, d: 0.009, vol: 0.12 });
      this._osc(v, { at: 0.11, f: 2850, f2: 2700, a: 0.001, d: 0.12, vol: 0.06 });
      // Whoosh past.
      const w = this._noise(v, { at: 0.14, a: 0.12, d: 0.26, vol: 0.4, type: 'bandpass', f: 450, f2: 1900, q: 1.6, sweep: 0.5, pan: -0.4, panTo: 0.5 });
      void w;
    });
  }

  breach() {
    this._safe(() => {
      const v = this._voice({ cat: 'boom', dur: 1.6, gain: 0.7, rev: 0.25, echo: 0.15 });
      if (!v) return;
      // Metal clank: inharmonic partials decaying at different rates.
      const partials = [[410, 0.25, 0.5], [1127, 0.14, 0.35], [1873, 0.1, 0.25], [2659, 0.06, 0.18], [3490, 0.04, 0.1]];
      for (const [f, vol, d] of partials) this._osc(v, { f: f * rnd(0.98, 1.02), a: 0.0008, d, vol });
      this._noise(v, { a: 0.0005, d: 0.03, vol: 0.5, type: 'bandpass', f: 3000, q: 1.5 });
      // Charge goes off.
      const b = 0.14;
      this._osc(v, { at: b, f: 95, f2: 32, a: 0.002, d: 0.55, glide: 0.4, vol: 0.95 });
      this._noise(v, { at: b, a: 0.001, d: 0.04, vol: 0.6, type: 'highpass', f: 1800 });
      this._noise(v, { at: b, buf: 'brown', a: 0.003, d: 0.8, vol: 0.8, type: 'lowpass', f: 2000, f2: 200 });
      this._noise(v, { at: b + 0.05, buf: 'crackle', a: 0.03, d: 0.7, vol: 0.35, type: 'bandpass', f: 2600, q: 0.8 });
      this._duck(0.65, 0.45, 0.7);
    });
  }

  hunker() {
    this._safe(() => {
      const v = this._voice({ cat: 'misc', dur: 0.6, gain: 0.75, rev: 0.06 });
      if (!v) return;
      // Gear rustle: a few quick pink-noise shuffles + crackle (straps, buckles).
      const n = 3 + Math.floor(Math.random() * 2);
      for (let i = 0; i < n; i++) {
        this._noise(v, { buf: 'pink', at: i * rnd(0.045, 0.07), a: 0.008, d: rnd(0.04, 0.07), vol: rnd(0.16, 0.24), type: 'bandpass', f: rnd(1200, 2400), q: 1.2 });
      }
      this._noise(v, { buf: 'crackle', a: 0.02, d: 0.22, vol: 0.12, type: 'highpass', f: 3000 });
      // Body thud into cover.
      this._osc(v, { at: 0.26, f: 115, f2: 48, a: 0.002, d: 0.18, vol: 0.6 });
      this._noise(v, { at: 0.26, buf: 'brown', a: 0.002, d: 0.14, vol: 0.45, type: 'lowpass', f: 380 });
    });
  }

  // ---------------------------------------------------- SFX: movement/world

  step() {
    this._safe(() => {
      const v = this._voice({ cat: 'step', dur: 0.12, gain: 0.9, rev: 0.03 });
      if (!v) return;
      this._stepAlt ^= 1;
      const pan = this._stepAlt ? -0.12 : 0.12;
      this._noise(v, { buf: 'pink', a: 0.002, d: rnd(0.03, 0.05), vol: rnd(0.16, 0.24), type: 'lowpass', f: rnd(500, 1200), q: 0.8, pan });
      this._noise(v, { a: 0.001, d: 0.012, vol: rnd(0.03, 0.06), type: 'highpass', f: 4000, pan });
      this._osc(v, { f: rnd(80, 100), f2: 55, a: 0.002, d: 0.05, vol: 0.18 });
      // Occasional wet splash (it's a drowned world).
      if (Math.random() < 0.18) this._noise(v, { at: 0.012, a: 0.005, d: 0.07, vol: 0.06, type: 'bandpass', f: 2600, f2: 1200, q: 1.5 });
    });
  }

  pickup() {
    this._safe(() => {
      const v = this._voice({ cat: 'misc', dur: 1.1, gain: 0.6, rev: 0.35, echo: 0.2 });
      if (!v) return;
      this._osc(v, { type: 'triangle', f: 880, a: 0.003, d: 0.14, vol: 0.28 });
      this._osc(v, { type: 'triangle', at: 0.075, f: 1318.5, a: 0.003, d: 0.32, vol: 0.28 });
      // Shimmer: high partials, slightly detuned.
      this._osc(v, { at: 0.075, f: 2637, a: 0.03, d: 0.6, vol: 0.05, det: 6 });
      this._osc(v, { at: 0.1, f: 3520, a: 0.04, d: 0.7, vol: 0.035, det: -7 });
      this._osc(v, { at: 0.12, f: 5274, a: 0.05, d: 0.6, vol: 0.02 });
      this._noise(v, { at: 0.075, a: 0.02, d: 0.4, vol: 0.04, type: 'highpass', f: 7000 });
    });
  }

  /** Overwatch / tripwire tell. Mid-band, square-ish, designed to cut through. */
  tripwire() {
    this._safe(() => {
      const v = this._voice({ cat: 'tell', dur: 0.7, bus: 'radio', gain: 1, rev: 0.05, echo: 0.12 });
      if (!v) return;
      v.srcs.push(this._squelch(v.t, 0.03, v.out, 0.25));
      // dit-dit-dah alarm, alternating two tones a tritone apart.
      const seq = [[0.04, 1480, 0.06], [0.12, 2093, 0.06], [0.2, 1480, 0.06], [0.28, 2093, 0.2]];
      for (const [at, f, d] of seq) {
        this._osc(v, { type: 'square', at, f, a: 0.002, d, vol: 0.12 });
        this._osc(v, { type: 'sine', at, f: f / 2, a: 0.002, d, vol: 0.12 });
      }
      this._duck(0.55, 0.45, 0.4);
    });
  }

  tide() {
    this._safe(() => {
      const v = this._voice({ cat: 'misc', dur: 3.6, gain: 0.45, rev: 0.3 });
      if (!v) return;
      // Sub-bass swell.
      const ctx = this.ctx, t = v.t;
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(34, t); o.frequency.linearRampToValueAtTime(52, t + 1.6);
      o.frequency.linearRampToValueAtTime(40, t + 3.3);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.7, t + 1.1);
      g.gain.setTargetAtTime(0, t + 1.7, 0.5);
      o.connect(g).connect(v.out); o.start(t); o.stop(t + 3.5); v.srcs.push(o);
      // Wash: brown noise with a rising/falling filter, slow stereo drift.
      const s = ctx.createBufferSource(); s.buffer = this.buf.brown; s.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 0.8;
      f.frequency.setValueAtTime(180, t);
      f.frequency.exponentialRampToValueAtTime(1500, t + 1.3);
      f.frequency.exponentialRampToValueAtTime(260, t + 3.3);
      const wg = ctx.createGain();
      wg.gain.setValueAtTime(0, t); wg.gain.linearRampToValueAtTime(0.55, t + 1.2);
      wg.gain.setTargetAtTime(0, t + 1.6, 0.6);
      let dst = v.out;
      if (ctx.createStereoPanner) {
        const pn = ctx.createStereoPanner();
        pn.pan.setValueAtTime(-0.5, t); pn.pan.linearRampToValueAtTime(0.5, t + 3.2);
        pn.connect(v.out); dst = pn;
      }
      s.connect(f).connect(wg).connect(dst); s.start(t, Math.random()); s.stop(t + 3.5); v.srcs.push(s);
      // Foam hiss on the crest.
      this._noise(v, { buf: 'pink', at: 0.8, a: 0.5, d: 1.4, vol: 0.12, type: 'highpass', f: 3000 });
      this._duck(0.55, 1.6, 1.0);
    });
  }

  // ------------------------------------------------------------ SFX: turn/UI

  turn() {
    this._safe(() => {
      const v = this._voice({ cat: 'misc', dur: 0.9, bus: 'radio', gain: 0.9, rev: 0.12 });
      if (!v) return;
      v.srcs.push(this._squelch(v.t, 0.09, v.out, 0.3));
      this._click(v, 0.095, 1400, 0.3);
      // Chime (outside the radio band-limit would be nicer, but on-radio keeps it cohesive).
      this._osc(v, { at: 0.13, f: 1174.7, a: 0.004, d: 0.25, vol: 0.2 });
      this._osc(v, { at: 0.24, f: 1760, a: 0.004, d: 0.45, vol: 0.18 });
      this._osc(v, { at: 0.24, f: 880, a: 0.004, d: 0.45, vol: 0.08 });
    });
  }

  tick(urgent = false) {
    this._safe(() => {
      const v = this._voice({ cat: 'tick', dur: 0.15, gain: urgent ? 0.9 : 0.8, rev: 0.03 });
      if (!v) return;
      if (urgent) {
        this._click(v, 0, 2600, 0.35);
        this._osc(v, { type: 'square', f: 1760, a: 0.001, d: 0.035, vol: 0.07 });
        this._osc(v, { f: 220, f2: 150, a: 0.001, d: 0.06, vol: 0.3 });
        this._click(v, 0.07, 2000, 0.2);
      } else {
        this._click(v, 0, 3200, 0.22);
      }
    });
  }

  uiClick() {
    this._safe(() => {
      const v = this._voice({ cat: 'ui', dur: 0.06, gain: 0.5, rev: 0.02 });
      if (!v) return;
      this._click(v, 0, 4200, 0.3);
      this._osc(v, { f: 1850, a: 0.001, d: 0.02, vol: 0.08 });
    });
  }

  uiHover() {
    this._safe(() => {
      const v = this._voice({ cat: 'ui', dur: 0.04, gain: 0.8, rev: 0 });
      if (!v) return;
      this._osc(v, { f: 2600, a: 0.002, d: 0.02, vol: 0.09 });
      this._noise(v, { a: 0.0005, d: 0.008, vol: 0.12, type: 'highpass', f: 6000 });
    });
  }

  uiError() {
    this._safe(() => {
      const v = this._voice({ cat: 'ui', dur: 0.3, bus: 'radio', gain: 0.35, rev: 0.02 });
      if (!v) return;
      for (const at of [0, 0.11]) {
        this._osc(v, { type: 'sawtooth', at, f: 150, a: 0.002, d: 0.075, vol: 0.18 });
        this._osc(v, { type: 'square', at, f: 151.5, a: 0.002, d: 0.075, vol: 0.08 });
      }
    });
  }
}

export { Sfx as TidefallAudio };
export default Sfx;
