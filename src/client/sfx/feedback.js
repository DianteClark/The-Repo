// Player feedback: hitmarkers, kill confirms, medals, progression fanfares,
// engagement sting and UI. Mixed into Sfx.prototype (`this` is the engine).

import { hashStr } from './gear.js';

const semi = (n) => Math.pow(2, n / 12);
const D5 = 587.33;

// Medal motifs: semitone offsets from D5 + a "weight" (0 small … 2 big).
const MEDALS = {
  firstblood: [[0, 7, 12], 1], doublekill: [[0, 4], 0], triplekill: [[0, 4, 7], 1], multikill: [[0, 4, 7, 12], 2],
  longshot: [[0, 12, 7], 1], headshot: [[7, 12], 0], revenge: [[0, 3, 7], 1], payback: [[0, 3, 7], 1],
  collateral: [[0, 5, 10], 1], savior: [[0, 5, 9], 1], comeback: [[0, 3, 5, 7], 1], survivor: [[0, 7, 12, 16], 2],
  champion: [[0, 4, 7, 12, 16], 2], streak: [[0, 7, 9, 12], 1], assist: [[0, 5], 0], buzzer: [[0, 7], 0],
};
const GENERIC = [[[0, 4, 7], 1], [[0, 5, 9], 1], [[0, 7, 12], 1], [[0, 3, 7, 10], 1], [[0, 4], 0]];

export const FeedbackSfx = {
  /** Hit confirmed: crisp, dry tick. */
  hitmarker() {
    this._safe(() => {
      const v = this._voice({ cat: 'hit', dur: 0.08, gain: 0.8, rev: 0 });
      if (!v) return;
      this._noise(v, { a: 0.0003, d: 0.012, vol: 0.35, type: 'highpass', f: 4200 });
      this._osc(v, { type: 'triangle', f: 2900, a: 0.0005, d: 0.03, vol: 0.12 });
      this._osc(v, { f: 1450, a: 0.0005, d: 0.02, vol: 0.06 });
    });
  },

  /** Kill confirmed: a bright two-tone ding over a soft thump. */
  killConfirm() {
    this._safe(() => {
      const v = this._voice({ cat: 'hit', dur: 1.0, gain: 0.8, rev: 0.2, echo: 0.15 });
      if (!v) return;
      this._osc(v, { f: 140, f2: 70, a: 0.001, d: 0.1, vol: 0.35 });
      this._chime(v, 0, 1568, 0.16, 0.5);
      this._chime(v, 0.07, 2093, 0.14, 0.7);
    });
  },

  /** Medal stinger; the motif depends on the medal name. */
  medal(name = '') {
    this._safe(() => {
      const key = String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');
      const [notes, weight] = MEDALS[key] || GENERIC[hashStr(key) % GENERIC.length];
      const v = this._voice({ cat: 'stinger', dur: 1.8, gain: 0.75, rev: 0.3, echo: 0.2 });
      if (!v) return;
      const gap = 0.075;
      notes.forEach((s, i) => {
        const f = D5 * semi(s);
        this._chime(v, i * gap, f, 0.11, 0.6 + i * 0.1);
        this._osc(v, { type: 'square', at: i * gap, f: f / 2, a: 0.003, d: 0.08, vol: 0.025 });
      });
      const end = notes.length * gap;
      if (weight >= 1) this._shimmer(v, end, 0.8);
      if (weight >= 2) {
        this._osc(v, { at: 0, f: 110, f2: 55, a: 0.002, d: 0.3, vol: 0.4 });
        this._brassChord(v, end - 0.02, [0, 4, 7].map((s) => 293.66 * semi(s + notes[notes.length - 1] % 12)), 0.8, 0.025);
      }
      this._duck(0.3, 0.6, 0.5);
    });
  },

  /** Level up: rising arpeggio, bright chord, shimmer. */
  levelUp() {
    this._safe(() => {
      const v = this._voice({ cat: 'stinger', dur: 2.4, gain: 0.75, rev: 0.3, echo: 0.2 });
      if (!v) return;
      [0, 4, 7, 12, 16].forEach((s, i) => {
        this._chime(v, i * 0.07, D5 * semi(s) / 2, 0.1, 0.5);
        this._osc(v, { type: 'square', at: i * 0.07, f: D5 * semi(s) / 2, a: 0.003, d: 0.07, vol: 0.02 });
      });
      this._brassChord(v, 0.36, [293.66, 369.99, 440, 587.33], 1.3, 0.03);
      this._shimmer(v, 0.36, 1.2);
      this._osc(v, { at: 0.36, f: 146.83, a: 0.01, d: 1.2, vol: 0.12 });
      this._duck(0.45, 1.2, 0.8);
    });
  },

  /** Rank up: drum hit and a bigger three-chord brass cadence (Bb → C → D). */
  rankUp() {
    this._safe(() => {
      const v = this._voice({ cat: 'stinger', dur: 3.6, gain: 0.72, rev: 0.35, echo: 0.2 });
      if (!v) return;
      this._osc(v, { f: 120, f2: 45, a: 0.002, d: 0.5, vol: 0.6 });
      this._noise(v, { a: 0.002, d: 1.4, vol: 0.12, type: 'highpass', f: 5000 });
      const chords = [[233.08, 293.66, 349.23], [261.63, 329.63, 392], [293.66, 369.99, 440, 587.33]];
      chords.forEach((c, i) => this._brassChord(v, i * 0.32, c, i === 2 ? 1.9 : 0.3, i === 2 ? 0.032 : 0.028));
      this._osc(v, { at: 0.64, f: 73.42, a: 0.01, d: 1.8, vol: 0.25 });
      [0, 7, 12, 16, 19, 24].forEach((s, i) => this._chime(v, 0.64 + i * 0.06, D5 * semi(s), 0.06, 1.0));
      this._shimmer(v, 0.64, 1.8);
      this._duck(0.6, 2.0, 1.0);
    });
  },

  /** Camo unlocked: glassy pentatonic sparkle sweep + a shimmering chord. */
  camoUnlock() {
    this._safe(() => {
      const v = this._voice({ cat: 'stinger', dur: 2.6, gain: 0.72, rev: 0.4, echo: 0.3 });
      if (!v) return;
      this._noise(v, { a: 0.3, d: 0.3, vol: 0.12, type: 'bandpass', f: 2000, f2: 9000, q: 2, pan: -0.6, panTo: 0.6 });
      [0, 2, 4, 7, 9, 12, 14, 16].forEach((s, i) => this._chime(v, 0.05 + i * 0.045, D5 * semi(s), 0.06, 0.6));
      for (const s of [0, 4, 7, 11]) this._osc(v, { at: 0.45, f: D5 * semi(s), a: 0.05, d: 1.6, vol: 0.04, det: 6 });
      this._shimmer(v, 0.45, 1.6);
      this._duck(0.35, 1.0, 0.8);
    });
  },

  /** Engagement starts: braam, squelch and a heartbeat. */
  engagementStart() {
    this._safe(() => {
      const v = this._voice({ cat: 'stinger', dur: 2.6, gain: 0.75, rev: 0.3, echo: 0.1 });
      if (!v) return;
      const ctx = this.ctx, t = v.t;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2;
      lp.frequency.setValueAtTime(150, t); lp.frequency.exponentialRampToValueAtTime(1300, t + 0.25);
      lp.frequency.exponentialRampToValueAtTime(200, t + 1.8);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.16, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);
      lp.connect(g).connect(v.out);
      for (const [f, d] of [[36.71, -8], [36.71, 9], [73.42, 0], [77.78, 4]]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = d;
        o.connect(lp); o.start(t); o.stop(t + 1.95); v.srcs.push(o);
      }
      this._osc(v, { f: 55, f2: 30, a: 0.003, d: 0.6, vol: 0.6 });
      v.srcs.push(this._squelch(t, 0.05, v.out, 0.15));
      for (const at of [0.7, 0.88, 1.45, 1.63]) this._osc(v, { at, f: 70, f2: 40, a: 0.003, d: 0.16, vol: at === 0.7 || at === 1.45 ? 0.45 : 0.3 });
      this._duck(0.55, 1.2, 0.8);
    });
  },

  /** Panel / card swipe. */
  uiSwipe() {
    this._safe(() => {
      const v = this._voice({ cat: 'ui', dur: 0.2, gain: 1.1, rev: 0.03 });
      if (!v) return;
      this._noise(v, { a: 0.05, d: 0.1, vol: 0.18, type: 'bandpass', f: 700, f2: 3200, q: 1.4, sweep: 0.6, pan: -0.4, panTo: 0.4 });
      this._noise(v, { buf: 'pink', a: 0.03, d: 0.08, vol: 0.08, type: 'highpass', f: 2500 });
    });
  },

  /** Positive confirm (equip, purchase, ready-up). */
  uiConfirm() {
    this._safe(() => {
      const v = this._voice({ cat: 'ui', dur: 0.5, gain: 0.6, rev: 0.12 });
      if (!v) return;
      this._click(v, 0, 3800, 0.25);
      this._osc(v, { type: 'triangle', at: 0.01, f: 880, a: 0.002, d: 0.08, vol: 0.18 });
      this._osc(v, { type: 'triangle', at: 0.08, f: 1318.5, a: 0.002, d: 0.25, vol: 0.18 });
      this._osc(v, { at: 0.08, f: 2637, a: 0.01, d: 0.25, vol: 0.03 });
    });
  },

  // ---- helpers ----

  _chime(v, at, f, vol, d = 0.6) {
    this._osc(v, { at, f, a: 0.002, d, vol });
    this._osc(v, { at, f: f * 2.76, a: 0.002, d: d * 0.4, vol: vol * 0.15 });
    this._osc(v, { type: 'triangle', at, f: f * 2, a: 0.002, d: d * 0.5, vol: vol * 0.2 });
  },

  _shimmer(v, at, d) {
    this._osc(v, { at, f: 2349, a: 0.05, d, vol: 0.025, det: 7 });
    this._osc(v, { at: at + 0.04, f: 3520, a: 0.06, d: d * 0.8, vol: 0.018, det: -6 });
    this._noise(v, { at, a: 0.1, d: d * 0.8, vol: 0.035, type: 'highpass', f: 8000 });
  },

  /** Brass-ish chord: saws through an opening low-pass, inside voice v. */
  _brassChord(v, at, freqs, d, vol) {
    const ctx = this.ctx, t = v.t + at;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(500, t); lp.frequency.exponentialRampToValueAtTime(3000, t + 0.08);
    lp.frequency.setTargetAtTime(1200, t + 0.1, d * 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.03);
    g.gain.setTargetAtTime(vol * 0.7, t + 0.06, 0.15);
    g.gain.setValueAtTime(vol * 0.7, t + Math.max(0.08, d - 0.2));
    g.gain.linearRampToValueAtTime(0, t + d);
    lp.connect(g).connect(v.out);
    for (const f of freqs) for (const det of [-9, 9]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      o.connect(lp); o.start(t); o.stop(t + d + 0.02); v.srcs.push(o);
    }
    if (t + d + 0.1 > v.end) v.end = t + d + 0.1;
  },
};
