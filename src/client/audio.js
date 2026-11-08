// Tidefall audio: "a war heard over a hijacked radio net".
// Everything is synthesized with the Web Audio API (no audio files).
//
// Graph:
//   voices ─┬─ sfxBus ─────────────────────┐
//           ├─ radioBus (band-limit+drive) ┤
//           ├─ reverb send ─ Convolver ────┤
//           └─ echo send ─ tape delay ─────┤
//                                          ▼
//                          pre ─ hp ─ glue comp ──┐
//   score/menu ─ musicIn ─ duck ─┐                │
//   ambience ─ ambIn ─ ambDuck ──┼─ bedBus ───────┤   (beds skip the glue comp,
//   stingers ─ stingerIn ────────┘                │    so its auto make-up gain
//                                                 ▼    can't inflate them)
//                         sum ─ limiter ─ soft clip ─ volume ─ destination
//
// The master path has a "deafen" stage (high-pass + gain dip, flashbang) right
// before the limiter; the ear-ringing tone enters after it so it stays clear.
//
// Public API (docs/V1_SPEC.md §3, docs/V5_SPEC.md §11). Every method is a no-op
// before resume(), while muted, or if Web Audio is unavailable.
//
// 5.0 additions live in mixins: sfx/weapons.js (shot/reload/emptyClick/swap),
// sfx/gear.js (equipment, killstreaks, radio callouts), sfx/world.js (boats,
// collapse, stage events, redeploy), sfx/feedback.js (hitmarker, medals,
// fanfares, UI). Music loops: sfx/menu.js (theme v2), sfx/hub.js, sfx/pit.js.

import { makeNoise, makeCrackle, makeImpulse, softClipCurve, driveCurve } from './sfx/buffers.js';
import { Score } from './sfx/music.js';
import { MenuTheme } from './sfx/menu.js';
import { Ambience } from './sfx/ambience.js';
import { HubBed } from './sfx/hub.js';
import { PitTheme } from './sfx/pit.js';
import { WeaponSfx } from './sfx/weapons.js';
import { GearSfx } from './sfx/gear.js';
import { WorldSfx } from './sfx/world.js';
import { FeedbackSfx } from './sfx/feedback.js';

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
  hit: { cap: 3, gap: 0.03 },
  radio: { cap: 2, gap: 0.05 },
  stinger: { cap: 2, gap: 0.05 },
  misc: { cap: 6, gap: 0.01 },
};
const BASE_GAIN = 0.9;

const clamp01 = (x) => { const v = Number(x); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; };
const isNum = (x) => x !== null && x !== '' && typeof x !== 'boolean' && Number.isFinite(Number(x));
const rnd = (a, b) => a + Math.random() * (b - a);

export class Sfx {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.volume = 1;
    this.offline = false;
    this.voices = [];
    this.catLast = Object.create(null);
    this._wantMusic = null; // 'menu' | 'match' | null
    this._intensity = 0.15;
    this._ambience = { stage: 0, rain: 0 };
    this._muteToken = 0;
    this._duckUntil = 0;
    this._duckLevel = 1;
    this._stepAlt = 0;
    this.score = null;
    this._loops = Object.create(null);
    this._pitOn = false;
    this._hubKind = 'hub';
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
      if (this.muted) this._applyOut(); // keep a muted context suspended
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
    const sum = ctx.createGain(); sum.gain.value = 1;
    const makeup = ctx.createGain(); makeup.gain.value = 1.25;
    const clip = ctx.createWaveShaper(); clip.curve = softClipCurve(); clip.oversample = '2x';
    const out = ctx.createGain(); out.gain.value = this._outGain();
    // Deafen stage (flashbang): transparent until deafen() sweeps it.
    const deafHp = ctx.createBiquadFilter(); deafHp.type = 'highpass'; deafHp.frequency.value = 10; deafHp.Q.value = 0.7;
    const deafG = ctx.createGain(); deafG.gain.value = 1;
    const ringIn = ctx.createGain(); ringIn.gain.value = 1;
    pre.connect(hp).connect(glue).connect(sum);
    sum.connect(deafHp).connect(deafG).connect(lim);
    ringIn.connect(lim);
    lim.connect(makeup).connect(clip).connect(out).connect(ctx.destination);
    this.deafHp = deafHp; this.deafG = deafG; this.ringIn = ringIn;
    // Music, ambience and stingers join after the glue compressor.
    const bed = ctx.createGain(); bed.gain.value = 1;
    bed.connect(sum);
    this.pre = pre; this.master = out; this.limiter = lim; this.glue = glue; this.bedBus = bed;

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
    this.echoDelay = dl;
    const fb = ctx.createGain(); fb.gain.value = 0.33;
    const eLp = ctx.createBiquadFilter(); eLp.type = 'lowpass'; eLp.frequency.value = 2300;
    const eHp = ctx.createBiquadFilter(); eHp.type = 'highpass'; eHp.frequency.value = 220;
    const eOut = ctx.createGain(); eOut.gain.value = 0.32;
    this.echoIn.connect(dl).connect(eLp).connect(eHp).connect(fb).connect(dl);
    eHp.connect(eOut).connect(pre);
    const eRev = ctx.createGain(); eRev.gain.value = 0.25; eOut.connect(eRev).connect(this.reverbIn);

    // Music bus (ducked), ambience bus (lightly ducked), stinger bus (not ducked).
    this.musicIn = ctx.createGain(); this.musicIn.gain.value = 0.26;
    this.musicDuck = ctx.createGain(); this.musicDuck.gain.value = 1;
    this.musicIn.connect(this.musicDuck).connect(bed);
    this.ambIn = ctx.createGain(); this.ambIn.gain.value = 0.36;
    this.ambLevel = ctx.createGain(); this.ambLevel.gain.value = 1;
    this.ambDuck = ctx.createGain(); this.ambDuck.gain.value = 1;
    this.ambIn.connect(this.ambLevel).connect(this.ambDuck).connect(bed);
    this.stingerIn = ctx.createGain(); this.stingerIn.gain.value = 0.55;
    this.stingerIn.connect(bed);
    // Effect sends for the beds, scaled with their bus level so trimming a bus
    // trims its reverb/echo too.
    const send = (lvl, dest) => { const g = ctx.createGain(); g.gain.value = lvl; g.connect(dest); return g; };
    this.musicRevIn = send(this.musicIn.gain.value, this.reverbIn);
    this.musicEchoIn = send(this.musicIn.gain.value, this.echoIn);
    this.ambRevIn = send(this.ambIn.gain.value, this.reverbIn);
    this.stingerRevIn = send(this.stingerIn.gain.value, this.reverbIn);
    this.stingerEchoIn = send(this.stingerIn.gain.value, this.echoIn);

    this.score = new Score(this);
    this.score.setIntensity(this._intensity);
    this.menu = new MenuTheme(this);
    this.amb = new Ambience(this);
    this.amb.set(this._ambience);
    this.hub = new HubBed(this);
    this.pit = new PitTheme(this);
    this._loops = Object.create(null);
    if (this._wantMusic === 'match') this._startMatchMusic();
    else if (this._wantMusic === 'menu') this._startMenuMusic();
    else if (this._wantMusic === 'hub') this._startHubMusic();
  }

  _installUnlock() {
    if (typeof document === 'undefined' || this._unlockInstalled) return;
    this._unlockInstalled = true;
    const kick = () => {
      const c = this.ctx;
      if (c && !this.muted && c.state !== 'running' && c.state !== 'closed') {
        const p = c.resume(); if (p && p.catch) p.catch(() => {});
      }
    };
    for (const ev of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(ev, kick, { passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
  }

  _outGain() { return this.muted ? 0 : this.volume * BASE_GAIN; }

  _applyOut() {
    if (!this.master) return;
    const ctx = this.ctx, t = ctx.currentTime, g = this.master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this._outGain(), t + 0.05);
    if (this.offline) return;
    // While muted, suspend the context (saves battery; the drones stop costing CPU).
    const token = ++this._muteToken;
    if (this.muted) {
      setTimeout(() => {
        if (token === this._muteToken && this.muted && ctx.state === 'running') ctx.suspend().catch(() => {});
      }, 120);
    } else if (ctx.state === 'suspended') {
      const p = ctx.resume(); if (p && p.catch) p.catch(() => {});
    }
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
    if (!isNum(v)) return; // ignore garbage rather than silently muting
    this.volume = clamp01(v);
    try { this._applyOut(); } catch { /* ignore */ }
  }

  setIntensity(x) {
    if (!isNum(x)) return;
    this._intensity = clamp01(x);
    this.score?.setIntensity(this._intensity);
  }

  /** Match score (+ world ambience). Crossfades from the menu theme if it is playing. */
  startMusic() {
    this._wantMusic = 'match';
    if (this.ctx) this._startMatchMusic();
  }

  /** Title theme. Crossfades from the match score if it is playing. */
  startMenuMusic() {
    this._wantMusic = 'menu';
    if (this.ctx) this._startMenuMusic();
  }

  /**
   * Hub / store ambience bed (between matches). kind: 'hub' | 'store'.
   * Crossfades from the menu theme or match score.
   */
  startHubMusic(kind = 'hub') {
    this._wantMusic = 'hub';
    this._hubKind = kind === 'store' ? 'store' : 'hub';
    if (this.ctx) this._startHubMusic();
  }

  startStoreMusic() { this.startHubMusic('store'); }

  /** The Pit's duel theme over a dipped match score. pitTheme(false) ends it. */
  pitTheme(on = true) {
    this._pitOn = on !== false;
    if (!this.ctx) return;
    try {
      if (this._pitOn) {
        this.pit.start();
        this.score?.setLevel?.(0.15);
        this._rampParam(this.ambLevel?.gain, 0.35, 0.6);
      } else {
        this.pit.stop(1.5);
        this.score?.setLevel?.(1, 1.2);
        this._rampParam(this.ambLevel?.gain, 1, 1.2);
      }
    } catch { /* ignore */ }
  }

  startPitTheme() { this.pitTheme(true); }
  stopPitTheme() { this.pitTheme(false); }

  /** Stops score, menu theme, hub bed, Pit theme, ambience and SFX loops (all timers). */
  stopMusic() {
    this._wantMusic = null;
    this._pitOn = false;
    try { this.score?.stop(); } catch { /* ignore */ }
    try { this.menu?.stop(); } catch { /* ignore */ }
    try { this.amb?.stop(); } catch { /* ignore */ }
    try { this.hub?.stop(); } catch { /* ignore */ }
    try { this.pit?.stop(); } catch { /* ignore */ }
    try { this._rampParam(this.ambLevel?.gain, 1, 0.1); } catch { /* ignore */ }
    this.stopLoops();
  }

  /** Everything: music, loops, and any voices still ringing. */
  stopAll() {
    this.stopMusic();
    const c = this.ctx;
    if (!c) return;
    for (const v of this.voices) this._steal(v, c.currentTime);
  }

  _rampParam(p, v, tc) {
    if (!p || !this.ctx) return;
    const t = this.ctx.currentTime;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.setTargetAtTime(v, t, tc);
  }

  /** stage: 0 = early (waves, wind, gulls) .. 1 = late (storm); rain: 0..1. */
  setAmbience(opts = {}) {
    const a = this._ambience;
    if (opts && isNum(opts.stage)) a.stage = clamp01(opts.stage);
    if (opts && isNum(opts.rain)) a.rain = clamp01(opts.rain);
    try { this.amb?.set(a); } catch { /* ignore */ }
  }

  _startMatchMusic() {
    try {
      this.menu.stop(2.5);
      this.hub.stop(2.5);
      this.score.start();
      this.amb.start();
      if (this._pitOn) this.pitTheme(true);
    } catch { /* ignore */ }
  }

  _leaveMatch(fade) {
    this._pitOn = false;
    this.score.stop(fade);
    this.amb.stop(fade);
    this.pit.stop(fade);
    this._rampParam(this.ambLevel.gain, 1, 0.5);
    this.stopLoops(fade);
  }

  _startMenuMusic() {
    try {
      this._leaveMatch(2.0);
      this.hub.stop(2.0);
      this.menu.start();
    } catch { /* ignore */ }
  }

  _startHubMusic() {
    try {
      this._leaveMatch(2.0);
      this.menu.stop(2.5);
      this.hub.setKind(this._hubKind);
      this.hub.start();
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------ SFX loops

  /**
   * Start a keyed continuous SFX loop (boat engine, gunship drone). build(n, t)
   * creates nodes into n.out and pushes every source to n.srcs (started here).
   * Loops auto-stop after `max` seconds so a missed stop can never leak.
   * Like one-shots they only start while audible; once running they keep going
   * (silently, context suspended) through a mute.
   */
  _loopStart(key, build, { fade = 0.5, max = 300, gain = 1, far = 0 } = {}) {
    const ctx = this.ctx;
    if (this._loops[key]) return this._loops[key];
    if (!this.canPlay()) return null; // like every SFX: nothing starts while muted
    const t = ctx.currentTime + 0.02;
    const fr = clamp01(far);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(gain * (1 - 0.6 * fr), t + Math.max(0.02, fade));
    let tail = out;
    if (fr > 0.02) {
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.value = 700 + 15000 * Math.pow(1 - fr, 2.2);
      out.connect(lp); tail = lp;
    }
    tail.connect(this.sfxBus);
    const rs = ctx.createGain(); rs.gain.value = 0.12 + 0.3 * fr;
    tail.connect(rs).connect(this.reverbIn);
    const n = { key, out, tail, rs, srcs: [], timer: null };
    try { build(n, t); } catch { try { out.disconnect(); tail.disconnect(); rs.disconnect(); } catch { /* gone */ } return null; }
    const life = Math.max(1, max);
    for (const s of n.srcs) {
      try { if (s.buffer) s.start(t, Math.random() * 1.5); else s.start(t); s.stop(t + life); } catch { /* ignore */ }
    }
    if (!this.offline) n.timer = setTimeout(() => this._loopStop(key, 0.3), life * 1000);
    this._loops[key] = n;
    return n;
  }

  _loopStop(key, fade = 0.6) {
    const n = this._loops[key], ctx = this.ctx;
    if (!n || !ctx) return;
    delete this._loops[key];
    if (n.timer) clearTimeout(n.timer);
    const t = ctx.currentTime, f = Math.max(0.02, Number(fade) || 0.02);
    try {
      const g = n.out.gain;
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + f);
      for (const s of n.srcs) { try { s.stop(t + f + 0.05); } catch { /* stopped */ } }
    } catch { /* ignore */ }
    if (!this.offline) setTimeout(() => { try { n.out.disconnect(); n.tail.disconnect(); n.rs.disconnect(); } catch { /* gone */ } }, (f + 0.3) * 1000);
  }

  /** Stop every SFX loop (boats, gunship). */
  stopLoops(fade = 0.4) {
    for (const k of Object.keys(this._loops || {})) this._loopStop(k, fade);
  }

  /** Keys of running SFX loops (diagnostics/tests). */
  get activeLoops() { return Object.keys(this._loops || {}); }

  // ---------------------------------------------------------------- deafen

  /**
   * Flashbang deafness for the local player: ear ringing plus the whole mix
   * pushed through a high-pass and dipped, recovering over `sec` seconds.
   */
  deafen(sec = 3, amount = 1) {
    this._safe(() => {
      const ctx = this.ctx, t = ctx.currentTime;
      const d = isNum(sec) ? Math.min(8, Math.max(0.5, Number(sec))) : 3;
      const amt = isNum(amount) ? Math.max(0.1, clamp01(amount)) : 1;
      const hp = this.deafHp.frequency, g = this.deafG.gain;
      hp.cancelScheduledValues(t); hp.setValueAtTime(Math.max(10, hp.value), t);
      hp.exponentialRampToValueAtTime(300 + 2200 * amt, t + 0.03);
      hp.setValueAtTime(300 + 2200 * amt, t + d * 0.35);
      hp.exponentialRampToValueAtTime(10, t + d);
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(1 - 0.75 * amt, t + 0.03);
      g.setValueAtTime(1 - 0.75 * amt, t + d * 0.3);
      g.linearRampToValueAtTime(1, t + d);
      // Tinnitus: two close sines beating, fading with the deafness.
      const rg = ctx.createGain();
      rg.gain.setValueAtTime(0.0001, t);
      rg.gain.exponentialRampToValueAtTime(0.06 * amt, t + 0.04);
      rg.gain.setValueAtTime(0.06 * amt, t + d * 0.25);
      rg.gain.exponentialRampToValueAtTime(0.0001, t + d);
      rg.connect(this.ringIn);
      for (const [f, a] of [[3520, 1], [3547, 0.7], [7040, 0.12]]) {
        const o = ctx.createOscillator(); o.frequency.value = f;
        const og = ctx.createGain(); og.gain.value = a;
        o.connect(og).connect(rg); o.start(t); o.stop(t + d + 0.05);
      }
      if (!this.offline) setTimeout(() => { try { rg.disconnect(); } catch { /* gone */ } }, (d + 0.5) * 1000);
      this._duck(0.7 * amt, d * 0.4, d * 0.4);
    });
  }

  stinger(kind) {
    if (!this.canPlay()) return;
    try {
      const k = ['victory', 'defeat', 'round', 'tide', 'downed'].includes(kind) ? kind : 'round';
      const len = this.score.stinger(k);
      this._duck(k === 'round' || k === 'downed' ? 0.5 : 0.8, len * 0.7, 0.8);
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

    // Prune finished voices in place (and release their graph).
    const vs = this.voices;
    let w = 0, inCat = 0, oldestCat = null;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      if (v.end > now) {
        vs[w++] = v;
        if (v.cat === cat) { inCat++; if (!oldestCat) oldestCat = v; }
      } else this._release(v);
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
    const v = { cat, t, end: t + dur + 0.05, out, tail, srcs: [] };
    vs.push(v);
    this._scheduleSweep();
    return v;
  }

  _release(v) {
    try { v.out.disconnect(); if (v.tail !== v.out) v.tail.disconnect(); } catch { /* gone */ }
  }

  /** After a burst of sounds, release finished voices even if nothing else plays. */
  _scheduleSweep() {
    if (this._sweepTimer || this.offline) return;
    this._sweepTimer = setTimeout(() => {
      this._sweepTimer = null;
      const now = this.ctx ? this.ctx.currentTime : Infinity;
      const vs = this.voices;
      let w = 0;
      for (let i = 0; i < vs.length; i++) { if (vs[i].end > now) vs[w++] = vs[i]; else this._release(vs[i]); }
      vs.length = w;
      if (w) this._scheduleSweep();
    }, 2500);
  }

  /** Number of live voices (diagnostics/tests). */
  get activeVoices() {
    const now = this.ctx ? this.ctx.currentTime : 0;
    let n = 0; for (const v of this.voices) if (v.end > now) n++;
    return n;
  }

  _steal(v, now) {
    try {
      const g = v.out.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + 0.02);
      for (const s of v.srcs) { try { s.stop(now + 0.03); } catch { /* stopped */ } }
    } catch { /* ignore */ }
    v.end = now + 0.05; // released once the fade is done
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
    if (t + a + d + 0.08 > v.end) v.end = t + a + d + 0.08;
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
    if (t + a + d + 0.08 > v.end) v.end = t + a + d + 0.08;
    return g;
  }

  /** Sidechain-style music duck. depth 0..1, hold seconds. */
  _duck(depth, hold = 0.15, release = 0.45) {
    const g = this.musicDuck?.gain;
    if (!g) return;
    const now = this.ctx.currentTime;
    const target = 1 - depth;
    if (now < this._duckUntil && target >= this._duckLevel) return; // already ducked deeper
    for (const [p, tg] of [[g, target], [this.ambDuck.gain, 1 - depth * 0.4]]) {
      p.cancelScheduledValues(now);
      p.setValueAtTime(Math.max(0.0001, p.value), now);
      p.setTargetAtTime(tg, now, 0.012);
      p.setTargetAtTime(1, now + hold, release);
    }
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


  // ------------------------------------------------------------ SFX: 2.0

  /** Smoke grenade: canister pop, then a long pressurised hiss and a soft billow. */
  smoke() {
    this._safe(() => {
      const v = this._voice({ cat: 'misc', dur: 2.6, gain: 0.8, rev: 0.2 });
      if (!v) return;
      this._osc(v, { f: 260, f2: 90, a: 0.001, d: 0.09, vol: 0.5 });
      this._noise(v, { a: 0.0005, d: 0.03, vol: 0.4, type: 'bandpass', f: 1800, q: 1.4 });
      this._noise(v, { at: 0.05, a: 0.08, d: 2.0, vol: 0.32, type: 'bandpass', f: 4200, f2: 2400, q: 0.9, pan: -0.25, panTo: 0.25 });
      this._noise(v, { at: 0.08, a: 0.25, d: 1.6, vol: 0.06, type: 'highpass', f: 7000 });
      this._noise(v, { buf: 'brown', at: 0.1, a: 0.3, d: 1.4, vol: 0.4, type: 'lowpass', f: 320, f2: 160 });
    });
  }

  /** A teammate back on the net: squelch, rising chime, a strong heartbeat. */
  revive() {
    this._safe(() => {
      const v = this._voice({ cat: 'misc', dur: 1.4, bus: 'radio', gain: 0.9, rev: 0.25, echo: 0.15 });
      if (!v) return;
      v.srcs.push(this._squelch(v.t, 0.06, v.out, 0.22));
      [[0.08, 587.33], [0.2, 880], [0.32, 1174.7]].forEach(([at, f], i) =>
        this._osc(v, { type: 'triangle', at, f, a: 0.004, d: 0.25 + i * 0.15, vol: 0.2 }));
      this._osc(v, { at: 0.32, f: 1760, a: 0.02, d: 0.6, vol: 0.05, det: 5 });
      const h = this._voice({ cat: 'misc', dur: 0.8, gain: 0.8, rev: 0.05 });
      if (h) for (const at of [0.05, 0.22]) this._osc(h, { at, f: 75, f2: 42, a: 0.004, d: 0.18, vol: at < 0.1 ? 0.7 : 0.45 });
    });
  }

  /** A soldier goes down (not dead yet): impact, falling groan, warbling comms. */
  downed() {
    this._safe(() => {
      const v = this._voice({ cat: 'misc', dur: 1.3, gain: 0.85, rev: 0.12 });
      if (!v) return;
      this._osc(v, { f: 140, f2: 40, a: 0.002, d: 0.3, vol: 0.6 });
      this._noise(v, { buf: 'brown', a: 0.002, d: 0.25, vol: 0.5, type: 'lowpass', f: 500 });
      this._noise(v, { buf: 'pink', at: 0.04, a: 0.01, d: 0.12, vol: 0.15, type: 'bandpass', f: 1500, q: 1.2 });
      const r = this._voice({ cat: 'misc', dur: 1.2, bus: 'radio', gain: 0.8, rev: 0.15 });
      if (r) {
        // Warble: tone with fast vibrato, sliding down, over thin static.
        const ctx = this.ctx, t = r.t + 0.12;
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        o.frequency.setValueAtTime(700, t); o.frequency.exponentialRampToValueAtTime(260, t + 0.8);
        const lfo = ctx.createOscillator(); lfo.frequency.value = 11;
        const la = ctx.createGain(); la.gain.value = 40;
        lfo.connect(la).connect(o.frequency);
        const g = ctx.createGain();
        this._env(g, t, 0.03, 0.06, 0.8);
        o.connect(g).connect(r.out);
        o.start(t); lfo.start(t); o.stop(t + 0.9); lfo.stop(t + 0.9);
        r.srcs.push(o, lfo);
        this._noise(r, { at: 0.1, a: 0.05, d: 0.8, vol: 0.08, type: 'bandpass', f: 2200, q: 1 });
      }
      this._duck(0.45, 0.4, 0.6);
    });
  }

  /** Medic patch: velcro rip, a spray hiss, a gentle up-chime. */
  patch() {
    this._safe(() => {
      const v = this._voice({ cat: 'misc', dur: 1.0, gain: 0.9, rev: 0.15 });
      if (!v) return;
      this._noise(v, { buf: 'crackle', a: 0.005, d: 0.18, vol: 0.4, type: 'highpass', f: 2200, rate: 1.4 });
      this._noise(v, { buf: 'pink', a: 0.01, d: 0.16, vol: 0.18, type: 'bandpass', f: 2600, q: 1.5 });
      this._noise(v, { at: 0.22, a: 0.02, d: 0.25, vol: 0.12, type: 'highpass', f: 5000 });
      this._osc(v, { type: 'triangle', at: 0.3, f: 659.25, a: 0.005, d: 0.2, vol: 0.13 });
      this._osc(v, { type: 'triangle', at: 0.4, f: 987.77, a: 0.005, d: 0.45, vol: 0.13 });
    });
  }

  /** Recon scan: a sonar ping with long echo, a sweep, and data chirps. */
  scan() {
    this._safe(() => {
      const v = this._voice({ cat: 'misc', dur: 2.0, gain: 0.8, rev: 0.4, echo: 0.55 });
      if (!v) return;
      this._osc(v, { f: 1320, a: 0.002, d: 0.9, vol: 0.2 });
      this._osc(v, { f: 2640, a: 0.002, d: 0.3, vol: 0.04 });
      this._noise(v, { a: 0.15, d: 0.6, vol: 0.08, type: 'bandpass', f: 600, f2: 4000, q: 4, pan: -0.6, panTo: 0.6 });
      const d = this._voice({ cat: 'misc', dur: 1.2, bus: 'radio', gain: 0.7, rev: 0.05 });
      if (d) for (let i = 0; i < 7; i++) {
        this._osc(d, { type: 'square', at: 0.35 + i * 0.055, f: [1800, 2400, 1500, 2700, 2100, 3000, 1650][i], a: 0.001, d: 0.025, vol: 0.06 });
      }
    });
  }

  /** Bleed out: a slowing, fading heartbeat, a long tone, then the line goes dead. */
  bleedOut() {
    this._safe(() => {
      const v = this._voice({ cat: 'misc', dur: 2.6, gain: 0.85, rev: 0.15 });
      if (!v) return;
      [[0, 0.6], [0.7, 0.42], [1.55, 0.25]].forEach(([at, vol]) => {
        this._osc(v, { at, f: 70, f2: 40, a: 0.004, d: 0.2, vol });
        this._osc(v, { at: at + 0.17, f: 62, f2: 38, a: 0.004, d: 0.18, vol: vol * 0.6 });
      });
      const r = this._voice({ cat: 'misc', dur: 2.8, bus: 'radio', gain: 0.8, rev: 0.1 });
      if (r) {
        this._osc(r, { at: 1.9, f: 988, a: 0.01, d: 0.5, vol: 0.06 });
        r.srcs.push(...this._static(r.t + 2.1, 0.3, 0.2, r.out));
        this._click(r, 2.42, 1600, 0.3);
      }
      this._duck(0.5, 2.0, 0.8);
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

// 5.0 voices (shot() now lives in sfx/weapons.js).
Object.assign(Sfx.prototype, WeaponSfx, GearSfx, WorldSfx, FeedbackSfx);

export { Sfx as TidefallAudio };
export default Sfx;
