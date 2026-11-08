// Equipment, killstreaks and the synthesized "radio callout" voice.
// Mixed into Sfx.prototype (`this` is the engine).

const clamp01 = (x) => { const v = Number(x); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; };
const rnd = (a, b) => a + Math.random() * (b - a);

function seeded(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
export function hashStr(str) {
  let h = 2166136261;
  for (const c of String(str)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

// Vowel formants (F1, F2) for the radio "voice".
const VOWELS = [[730, 1090], [530, 1840], [300, 2250], [570, 840], [330, 1000], [660, 1700]];

// Each streak's radio callout: a tone motif (Hz) and a fixed "sentence".
const CALLOUTS = {
  uav:        { notes: [1200, 1600, 2000], syl: 5 },
  counteruav: { notes: [2000, 1600, 1200], syl: 5 },
  care:       { notes: [880, 660, 880], syl: 6 },
  airstrike:  { notes: [1400, 1400, 1050], syl: 6 },
  jets:       { notes: [1800, 1350], syl: 4 },
  sentry:     { notes: [1000, 1500], syl: 4 },
  gunship:    { notes: [700, 933, 1400], syl: 7 },
  gunshipend: { notes: [1400, 933, 700], syl: 4 },
  incoming:   { notes: [1500, 1000, 1500, 1000], syl: 3 },
  stage:      { notes: [600, 800, 600], syl: 5 },
  redeploy:   { notes: [990, 1320, 1760], syl: 4 },
};

const asOpts = (o) => (o && typeof o === 'object' ? o : { enemy: o === true });

export const GearSfx = {
  // ------------------------------------------------------------ radio voice

  /**
   * Formant-filtered buzz shaped into syllables: unintelligible radio speech.
   * Deterministic per seed, so a callout always "says" the same thing.
   * Returns { len, srcs }.
   */
  _babble(t, dest, { syl = 5, f0 = 125, vol = 0.2, seed = 1 } = {}) {
    const ctx = this.ctx, r = seeded(seed);
    const src = ctx.createOscillator(); src.type = 'sawtooth';
    src.frequency.setValueAtTime(f0, t);
    const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.Q.value = 5;
    const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.Q.value = 7;
    const g2 = ctx.createGain(); g2.gain.value = 0.7;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t);
    const mk = ctx.createGain(); mk.gain.value = 3.2; // formant filters eat a lot of level
    src.connect(f1).connect(g); src.connect(f2).connect(g2).connect(g);
    g.connect(mk).connect(dest);
    const srcs = [src];
    let tt = t;
    const n = Math.max(1, Math.min(12, syl | 0));
    for (let i = 0; i < n; i++) {
      const d = 0.07 + r() * 0.1;
      const [a, b] = VOWELS[Math.floor(r() * VOWELS.length)];
      f1.frequency.setTargetAtTime(a, tt, 0.012);
      f2.frequency.setTargetAtTime(b, tt, 0.012);
      const inflect = i === n - 1 ? 0.82 : 1 + (r() - 0.5) * 0.28;
      src.frequency.setTargetAtTime(f0 * inflect, tt, 0.03);
      g.gain.setTargetAtTime(vol, tt, 0.01);
      g.gain.setTargetAtTime(0, tt + d, 0.016);
      if (r() < 0.55) { // consonant
        const s = ctx.createBufferSource(); s.buffer = this.buf.white;
        const hf = ctx.createBiquadFilter(); hf.type = 'highpass'; hf.frequency.value = 2500 + r() * 2000;
        const cg = ctx.createGain();
        cg.gain.setValueAtTime(0, tt); cg.gain.linearRampToValueAtTime(vol * 0.9, tt + 0.004);
        cg.gain.exponentialRampToValueAtTime(0.0001, tt + 0.035);
        s.connect(hf).connect(cg).connect(dest);
        s.start(tt, r()); s.stop(tt + 0.05); srcs.push(s);
      }
      tt += d + 0.025 + (r() < 0.25 ? 0.1 : r() * 0.04);
    }
    src.start(t); src.stop(tt + 0.08);
    return { len: tt - t, srcs };
  },

  /**
   * A radio callout for a streak/event: squelch, the key's tone motif, a short
   * burst of radio "speech", then a roger beep. opts: { enemy } or boolean.
   */
  radioCallout(key = 'uav', opts) {
    this._safe(() => {
      const o = asOpts(opts);
      const k = String(key ?? 'uav').toLowerCase().replace(/[^a-z]/g, '');
      const sig = CALLOUTS[k] || { notes: [1100, 1400], syl: 4 };
      const enemy = !!o.enemy;
      const v = this._voice({ cat: 'radio', dur: 2.4, bus: 'radio', gain: 0.9, rev: 0.06, echo: 0.08, far: o.far ?? 0 });
      if (!v) return;
      v.srcs.push(this._squelch(v.t, 0.05, v.out, 0.24));
      const tr = enemy ? 0.75 : 1;
      sig.notes.forEach((f, i) => {
        const at = 0.06 + i * 0.075;
        this._osc(v, { type: 'square', at, f: f * tr, a: 0.002, d: 0.05, vol: 0.06 });
        this._osc(v, { at, f: f * tr * 0.5, a: 0.002, d: 0.05, vol: 0.08 });
      });
      const bt = v.t + 0.1 + sig.notes.length * 0.075;
      const { len, srcs } = this._babble(bt, v.out, { syl: sig.syl, f0: enemy ? 92 : 128, vol: 0.12, seed: hashStr(k) + (enemy ? 99 : 0) });
      v.srcs.push(...srcs);
      // Thin static bed under the speech.
      this._noise(v, { at: bt - v.t, a: 0.02, d: len, vol: enemy ? 0.05 : 0.03, type: 'bandpass', f: 2200, q: 0.8 });
      const end = bt - v.t + len + 0.03;
      if (enemy) {
        this._osc(v, { type: 'square', at: end, f: 600, a: 0.002, d: 0.06, vol: 0.06 });
        this._osc(v, { type: 'square', at: end + 0.09, f: 450, a: 0.002, d: 0.08, vol: 0.06 });
      } else {
        this._osc(v, { type: 'sine', at: end, f: 1000, a: 0.002, d: 0.07, vol: 0.12 });
      }
      v.srcs.push(this._squelch(v.t + end + 0.1, 0.035, v.out, 0.18));
      if (v.t + end + 0.3 > v.end) v.end = v.t + end + 0.3;
      this._duck(0.35, end, 0.4);
    });
  },

  // -------------------------------------------------------------- equipment

  /** Semtex lands and sticks: wet splat, then an accelerating arming beep. */
  semtexStick(far = 0) {
    this._safe(() => {
      const v = this._voice({ cat: 'misc', dur: 1.4, far: clamp01(far), gain: 0.9, rev: 0.08 });
      if (!v) return;
      this._noise(v, { buf: 'pink', a: 0.002, d: 0.09, vol: 0.4, type: 'bandpass', f: 650, q: 1.3 });
      this._osc(v, { f: 130, f2: 70, a: 0.002, d: 0.08, vol: 0.4 });
      this._noise(v, { buf: 'crackle', at: 0.03, a: 0.01, d: 0.14, vol: 0.2, type: 'bandpass', f: 1800, q: 1 });
      [0.2, 0.55, 0.8, 0.98, 1.12].forEach((at, i) => this._beep(v, at, 2600 + i * 120, 0.08));
    });
  },

  /** A single semtex/claymore arming beep (urgent = higher, doubled). */
  semtexBeep(urgent = false) {
    this._safe(() => {
      const v = this._voice({ cat: 'tick', dur: 0.2, gain: 0.9, rev: 0.04 });
      if (!v) return;
      this._beep(v, 0, urgent ? 3100 : 2600, 0.16);
      if (urgent) this._beep(v, 0.08, 3100, 0.16);
    });
  },

  _beep(v, at, f, vol) {
    this._osc(v, { type: 'square', at, f, a: 0.001, d: 0.035, vol: vol * 0.5 });
    this._osc(v, { at, f: f * 2, a: 0.001, d: 0.03, vol: vol * 0.3 });
  },

  /** Claymore planted: legs pressed into the ground, arming chirp. */
  claymorePlace() {
    this._safe(() => {
      const v = this._voice({ cat: 'misc', dur: 0.8, gain: 0.85, rev: 0.05 });
      if (!v) return;
      this._click(v, 0, 1500, 0.3); this._click(v, 0.09, 1700, 0.3);
      this._noise(v, { buf: 'pink', at: 0.02, a: 0.01, d: 0.12, vol: 0.18, type: 'lowpass', f: 700 });
      this._beep(v, 0.35, 2200, 0.07); this._beep(v, 0.45, 2900, 0.07);
    });
  },

  /** Claymore triggered: tripwire clack, then the directional blast. */
  claymoreTrigger(far = 0) {
    this._safe(() => {
      const fr = clamp01(far);
      const v = this._voice({ cat: 'boom', dur: 1.8, far: fr, gain: 0.75, rev: 0.25, echo: 0.2 });
      if (!v) return;
      this._click(v, 0, 2200, 0.4);
      this._beep(v, 0.03, 3300, 0.1);
      const b = 0.17;
      this._noise(v, { at: b, a: 0.0005, d: 0.06, vol: 0.85, type: 'highpass', f: 1800 });
      this._osc(v, { at: b, f: 90, f2: 30, a: 0.002, d: 0.6, glide: 0.4, vol: 1.0 });
      this._noise(v, { at: b, buf: 'brown', a: 0.003, d: 0.9, vol: 0.8, type: 'lowpass', f: 2400, f2: 200 });
      // Ball bearings: a dense crackle spray.
      this._noise(v, { at: b + 0.01, buf: 'crackle', a: 0.005, d: 0.5, vol: 0.55, type: 'highpass', f: 2500, rate: 1.4, pan: -0.3, panTo: 0.4 });
      this._duck(0.7, 0.5, 0.8);
    });
  },

  /** Throwing knife leaves the hand: spinning whoosh. */
  knifeThrow() {
    this._safe(() => {
      const v = this._voice({ cat: 'misc', dur: 0.6, gain: 1.6, rev: 0.06 });
      if (!v) return;
      this._metal(v, 0, 3300, 0.025);
      for (let i = 0; i < 5; i++) {
        const at = 0.03 + i * 0.065;
        const pan = -0.5 + i * 0.25;
        this._noise(v, { at, a: 0.02, d: 0.04, vol: 0.22 - i * 0.025, type: 'bandpass', f: 1800 + i * 300, q: 2.5, pan });
      }
    });
  },

  /** Knife lands. flesh=true: thunk into a body; false: tink off something hard. */
  knifeHit(flesh = true) {
    this._safe(() => {
      const v = this._voice({ cat: 'impact', dur: 0.5, gain: 0.9, rev: 0.08 });
      if (!v) return;
      if (flesh !== false) {
        this._osc(v, { f: 160, f2: 70, a: 0.001, d: 0.09, vol: 0.6 });
        this._noise(v, { buf: 'pink', a: 0.001, d: 0.07, vol: 0.4, type: 'bandpass', f: 900, q: 1.4 });
        this._noise(v, { buf: 'crackle', at: 0.01, a: 0.005, d: 0.08, vol: 0.15, type: 'bandpass', f: 1500 });
        this._metal(v, 0.005, 2800, 0.02);
      } else {
        this._metal(v, 0, 3100, 0.09);
        this._osc(v, { f: 260, f2: 160, a: 0.001, d: 0.05, vol: 0.3 });
        this._noise(v, { a: 0.0005, d: 0.02, vol: 0.3, type: 'highpass', f: 3500 });
      }
    });
  },

  /**
   * Flashbang. deafen=true (the local player was caught in it): ringing ears and
   * the whole mix ducked through a high-pass for ~3 s.
   * Also accepts flashbang({deafen, far}).
   */
  flashbang(deafen = false, far = 0) {
    this._safe(() => {
      let dz = deafen, fr = far;
      if (deafen && typeof deafen === 'object') { dz = !!deafen.deafen; fr = deafen.far ?? 0; }
      fr = clamp01(fr);
      const v = this._voice({ cat: 'boom', dur: 1.2, far: fr, gain: 0.8, rev: 0.3, echo: 0.2 });
      if (!v) return;
      this._noise(v, { a: 0.0003, d: 0.22, vol: 0.9, type: 'highpass', f: 1000 });
      this._osc(v, { type: 'square', f: 2100, f2: 900, a: 0.0005, d: 0.03, vol: 0.15 });
      this._osc(v, { f: 140, f2: 45, a: 0.001, d: 0.2, vol: 0.8 });
      this._noise(v, { buf: 'crackle', at: 0.02, a: 0.01, d: 0.5, vol: 0.25, type: 'highpass', f: 3000 });
      this._duck(0.6, 0.3, 0.6);
      if (dz === true) this.deafen(3.2, 1);
    });
  },

  /** Stim shot: injector click, pneumatic hiss, quickening heartbeat. */
  stim() {
    this._safe(() => {
      const v = this._voice({ cat: 'misc', dur: 1.6, gain: 0.85, rev: 0.12 });
      if (!v) return;
      this._click(v, 0, 2400, 0.35);
      this._noise(v, { at: 0.02, a: 0.005, d: 0.25, vol: 0.3, type: 'highpass', f: 4500 });
      this._osc(v, { type: 'triangle', at: 0.25, f: 440, f2: 1320, a: 0.05, d: 0.7, glide: 0.6, vol: 0.06 });
      [0.3, 0.62, 0.88, 1.1].forEach((at, i) => {
        this._osc(v, { at, f: 72, f2: 42, a: 0.003, d: 0.15, vol: 0.4 + i * 0.08 });
        this._osc(v, { at: at + 0.13, f: 64, f2: 40, a: 0.003, d: 0.12, vol: 0.25 + i * 0.05 });
      });
    });
  },

  /** Decoy: a scatter of fake distant gunfire. */
  decoy() {
    this._safe(() => {
      const v = this._voice({ cat: 'shot', dur: 1.6, far: 0.55, gain: 0.8, rev: 0.25, echo: 0.2 });
      if (!v) return;
      const P = { crack: [2600, 0.7, 0.04], body: [1100, 300, 0.5, 0.12], thump: [150, 48, 0.5, 0.12, 0.09], mech: null };
      let at = 0;
      for (let b = 0; b < 3; b++) {
        for (let i = 0; i < 3; i++) { this._round(v, at, P, rnd(0.95, 1.05), 0.85); at += 0.085; }
        at += rnd(0.2, 0.35);
      }
    });
  },

  // ------------------------------------------------------------ killstreaks

  /** UAV online: callout, then a rotating radar sweep with pings. */
  uavOnline(opts) {
    this._safe(() => {
      const o = asOpts(opts);
      this.radioCallout('uav', o);
      const v = this._voice({ cat: 'misc', dur: 3.2, gain: 0.7, rev: 0.4, echo: 0.4 });
      if (!v) return;
      const t0 = 0.9;
      this._osc(v, { type: 'sawtooth', at: t0, f: 140, f2: 150, a: 0.6, d: 1.8, vol: 0.02 }); // drone overhead
      this._noise(v, { at: t0, a: 0.4, d: 1.6, vol: 0.06, type: 'bandpass', f: 500, f2: 4000, q: 5, pan: -0.8, panTo: 0.8 });
      [0, 0.55, 1.1].forEach((dt, i) => {
        this._osc(v, { at: t0 + dt, f: 1800 + i * 200, a: 0.002, d: 0.45, vol: 0.09 });
        this._osc(v, { at: t0 + dt, f: 3600 + i * 400, a: 0.002, d: 0.15, vol: 0.02 });
      });
    });
  },

  /** Counter-UAV: callout, then jamming warble. */
  counterUav(opts) {
    this._safe(() => {
      const o = asOpts(opts);
      this.radioCallout('counteruav', o);
      const v = this._voice({ cat: 'misc', dur: 2.6, bus: 'radio', gain: 0.7, rev: 0.1 });
      if (!v) return;
      const ctx = this.ctx, t = v.t + 0.9;
      const s = ctx.createBufferSource(); s.buffer = this.buf.white; s.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 1.5;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.18, t + 0.1); g.gain.setValueAtTime(0.18, t + 1.2); g.gain.linearRampToValueAtTime(0, t + 1.5);
      const am = ctx.createGain(); am.gain.value = 0.5;
      const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 13;
      const la = ctx.createGain(); la.gain.value = 0.5; lfo.connect(la).connect(am.gain);
      s.connect(f).connect(am).connect(g).connect(v.out);
      s.start(t); s.stop(t + 1.55); lfo.start(t); lfo.stop(t + 1.55);
      v.srcs.push(s, lfo);
      this._osc(v, { type: 'sawtooth', at: 0.9, f: 800, f2: 300, a: 0.05, d: 1.3, glide: 1.2, vol: 0.04 });
    });
  },

  /** Care package: callout, flare ignition + hiss, cargo plane pass, crate thud. */
  carePackage(far = 0) {
    this._safe(() => {
      const fr = clamp01(far);
      this.radioCallout('care');
      const v = this._voice({ cat: 'misc', dur: 4.6, far: fr, gain: 0.8, rev: 0.2 });
      if (!v) return;
      // Flare.
      const f0 = 0.6;
      this._noise(v, { at: f0, a: 0.001, d: 0.04, vol: 0.4, type: 'bandpass', f: 1500, q: 1.2 });
      this._noise(v, { at: f0 + 0.03, a: 0.08, d: 2.4, vol: 0.18, type: 'bandpass', f: 3200, f2: 2400, q: 0.8 });
      this._noise(v, { buf: 'crackle', at: f0 + 0.05, a: 0.1, d: 2.2, vol: 0.12, type: 'highpass', f: 2500 });
      // Plane: prop drone with doppler, crossing.
      this._plane(v, 1.0, 2.4, 0.22);
      this._crateLand(v, 3.4);
    });
  },

  /** Crate impact on its own (e.g. when the drop lands next step). */
  crateLand(far = 0) {
    this._safe(() => {
      const v = this._voice({ cat: 'boom', dur: 1.6, far: clamp01(far), gain: 0.8, rev: 0.2 });
      if (v) this._crateLand(v, 0.35);
    });
  },

  _crateLand(v, a) {
    this._noise(v, { at: a - 0.35, a: 0.3, d: 0.08, vol: 0.12, type: 'bandpass', f: 600, f2: 1600, q: 1.5 }); // air rush
    this._osc(v, { at: a, f: 75, f2: 30, a: 0.002, d: 0.45, vol: 0.9 });
    this._noise(v, { at: a, buf: 'brown', a: 0.003, d: 0.6, vol: 0.6, type: 'lowpass', f: 1200, f2: 180 });
    this._noise(v, { at: a + 0.02, buf: 'crackle', a: 0.02, d: 0.5, vol: 0.25, type: 'bandpass', f: 2000 });
    this._metal(v, a + 0.01, 620, 0.12);
    this._metal(v, a + 0.18, 780, 0.06);
    this._duck(0.5, a + 0.3, 0.5);
  },

  /** Prop plane pass inside voice v (at, dur seconds, level). */
  _plane(v, at, dur, vol) {
    const ctx = this.ctx, t = v.t + at;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(300, t);
    lp.frequency.linearRampToValueAtTime(1100, t + dur * 0.5); lp.frequency.linearRampToValueAtTime(300, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + dur * 0.5); g.gain.linearRampToValueAtTime(0, t + dur);
    const chop = ctx.createGain(); chop.gain.value = 0.6;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 28;
    const la = ctx.createGain(); la.gain.value = 0.4; lfo.connect(la).connect(chop.gain);
    let dst = v.out;
    if (ctx.createStereoPanner) {
      const pn = ctx.createStereoPanner(); pn.pan.setValueAtTime(-0.8, t); pn.pan.linearRampToValueAtTime(0.8, t + dur);
      pn.connect(v.out); dst = pn;
    }
    lp.connect(chop).connect(g).connect(dst);
    for (const [f, det] of [[96, -5], [97, 6], [144, 0]]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(f * 1.06, t); o.frequency.linearRampToValueAtTime(f * 0.94, t + dur);
      o.detune.value = det; o.connect(lp); o.start(t); o.stop(t + dur + 0.02); v.srcs.push(o);
    }
    lfo.start(t); lfo.stop(t + dur + 0.02); v.srcs.push(lfo);
    if (t + dur + 0.1 > v.end) v.end = t + dur + 0.1;
  },

  /** Jet pass inside voice v. dir: 1 = left→right. */
  _jet(v, at, dir = 1, vol = 0.4, dur = 1.7) {
    const mid = at + dur * 0.45;
    this._noise(v, { at, a: dur * 0.45, d: dur * 0.55, vol, type: 'bandpass', f: 700, f2: 2600, q: 0.7, sweep: 0.45, pan: -0.9 * dir, panTo: 0.9 * dir });
    this._noise(v, { at: mid - 0.05, a: 0.05, d: dur * 0.5, vol: vol * 0.8, type: 'lowpass', f: 2200, f2: 500, pan: 0.2 * dir, panTo: 0.9 * dir });
    this._osc(v, { type: 'sawtooth', at, f: 2200, f2: 900, a: dur * 0.45, d: dur * 0.5, glide: dur * 0.9, vol: 0.012 });
    this._noise(v, { buf: 'brown', at: mid - 0.1, a: 0.1, d: 1.2, vol: vol * 0.9, type: 'lowpass', f: 400 });
  },

  /** Jets screaming overhead. */
  jetsFlyby(far = 0) {
    this._safe(() => {
      const v = this._voice({ cat: 'boom', dur: 3.2, far: clamp01(far), gain: 0.75, rev: 0.25, echo: 0.15 });
      if (!v) return;
      this._jet(v, 0, 1, 0.45);
      this._jet(v, 0.35, -1, 0.35);
      this._duck(0.6, 1.4, 0.8);
    });
  },

  /** Airstrike telegraphed: callout + klaxon. enemy=true for an incoming strike. */
  airstrikeMark(opts) {
    this._safe(() => {
      const o = asOpts(opts);
      this.radioCallout(o.enemy ? 'incoming' : 'airstrike', o);
      const v = this._voice({ cat: 'tell', dur: 2.2, gain: 0.8, rev: 0.15, echo: 0.1 });
      if (!v) return;
      for (let i = 0; i < 3; i++) {
        const at = 1.0 + i * 0.36;
        this._osc(v, { type: 'square', at, f: 880, a: 0.005, d: 0.15, vol: 0.05 });
        this._osc(v, { type: 'square', at: at + 0.17, f: 660, a: 0.005, d: 0.15, vol: 0.05 });
      }
    });
  },

  /** Airstrike hits: jets, falling whistles, then a walking line of impacts. */
  airstrike(far = 0) {
    this._safe(() => {
      const fr = clamp01(far);
      const v = this._voice({ cat: 'boom', dur: 4.0, far: fr, gain: 0.7, rev: 0.32, echo: 0.25 });
      if (!v) return;
      this._jet(v, 0, 1, 0.3, 1.4);
      for (let i = 0; i < 4; i++) {
        const w = 0.35 + i * 0.12;
        this._osc(v, { at: w, f: 2600 - i * 150, f2: 450, a: 0.05, d: 0.75, glide: 0.8, vol: 0.035 });
        const b = 1.15 + i * 0.2 + rnd(0, 0.04);
        const pan = -0.6 + i * 0.4;
        this._osc(v, { at: b, f: 70, f2: 26, a: 0.003, d: 0.8, glide: 0.5, vol: 0.75 });
        this._noise(v, { at: b, a: 0.001, d: 0.05, vol: 0.5, type: 'highpass', f: 1500, pan });
        this._noise(v, { at: b, buf: 'brown', a: 0.004, d: 1.0, vol: 0.6, type: 'lowpass', f: 2000, f2: 160, pan });
        this._noise(v, { at: b + 0.08, buf: 'crackle', a: 0.04, d: 0.8, vol: 0.25, type: 'bandpass', f: 2800, f2: 1400, pan });
      }
      this._duck(0.8, 2.4, 1.0);
    });
  },

  /** Sentry deploy: callout, servo unfold, clunks, online beep-boop. */
  sentryDeploy(opts) {
    this._safe(() => {
      const o = asOpts(opts);
      this.radioCallout('sentry', o);
      const v = this._voice({ cat: 'misc', dur: 1.8, gain: 0.85, rev: 0.1 });
      if (!v) return;
      this._thud(v, 0, 110, 0.5); this._click(v, 0, 1300, 0.35);
      this._osc(v, { type: 'sawtooth', at: 0.15, f: 260, f2: 620, a: 0.05, d: 0.45, glide: 0.45, vol: 0.035 });
      this._noise(v, { at: 0.15, a: 0.05, d: 0.45, vol: 0.06, type: 'bandpass', f: 1500, f2: 2600, q: 3 });
      this._click(v, 0.65, 1700, 0.35); this._metal(v, 0.65, 1500, 0.05);
      this._click(v, 0.8, 1500, 0.3);
      this._osc(v, { at: 1.0, f: 1200, a: 0.003, d: 0.08, vol: 0.09 });
      this._osc(v, { at: 1.11, f: 1800, a: 0.003, d: 0.14, vol: 0.09 });
    });
  },

  /** Sentry fires: servo twitch + a mechanical 3-round burst. */
  sentryShot(far = 0) {
    this._safe(() => {
      const v = this._voice({ cat: 'shot', dur: 0.6, far: clamp01(far), gain: 0.85, rev: 0.12, echo: 0.08 });
      if (!v) return;
      this._osc(v, { type: 'sawtooth', f: 500, f2: 700, a: 0.01, d: 0.08, vol: 0.02 });
      const P = { crack: [3000, 0.75, 0.035], body: [1300, 400, 0.5, 0.09], thump: [170, 60, 0.55, 0.09, 0.06], mech: [4200, 0.08] };
      for (let i = 0; i < 3; i++) this._round(v, 0.06 + i * 0.07, P, rnd(0.97, 1.03), i ? 0.85 : 1);
      this._duck(0.25, 0.2, 0.3);
    });
  },

  /** Gunship called in: callout + the orbiting drone loop. */
  gunshipStart(opts) {
    if (!this.ctx) return;
    const o = asOpts(opts);
    this.radioCallout('gunship', o);
    this.gunshipLoop();
  },

  /** Ensure the gunship drone is orbiting (idempotent). Auto-stops after 120 s. */
  gunshipLoop() {
    if (this._loops?.gunship) return;
    this._loopStart('gunship', (n, t) => {
      const ctx = this.ctx;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.8;
      const g = ctx.createGain(); g.gain.value = 0.06;
      const orbit = ctx.createGain(); orbit.gain.value = 0.7;
      const ol = ctx.createOscillator(); ol.frequency.value = 0.09;
      const oa = ctx.createGain(); oa.gain.value = 0.3; ol.connect(oa).connect(orbit.gain);
      const fl = ctx.createOscillator(); fl.frequency.value = 0.09;
      const fa = ctx.createGain(); fa.gain.value = 160; fl.connect(fa).connect(lp.frequency);
      let dst = n.out;
      if (ctx.createStereoPanner) {
        const pn = ctx.createStereoPanner(); const pl = ctx.createOscillator(); pl.frequency.value = 0.09;
        const pa = ctx.createGain(); pa.gain.value = 0.6; pl.connect(pa).connect(pn.pan); pn.connect(n.out); dst = pn; n.srcs.push(pl);
      }
      lp.connect(orbit).connect(g).connect(dst);
      for (const [f, det, type] of [[72, -4, 'sawtooth'], [73.2, 5, 'sawtooth'], [108, 0, 'sawtooth'], [36, 0, 'sine']]) {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = det;
        o.connect(lp); n.srcs.push(o);
      }
      const s = ctx.createBufferSource(); s.buffer = this.buf.brown; s.loop = true;
      const sl = ctx.createBiquadFilter(); sl.type = 'lowpass'; sl.frequency.value = 220;
      const sg = ctx.createGain(); sg.gain.value = 0.5;
      s.connect(sl).connect(sg).connect(orbit);
      n.srcs.push(ol, fl, s);
    }, { fade: 2.5, max: 120, gain: 1 });
  },

  /** Gunship 105 mm: the thump from above, the shell's rush, the impact. */
  gunshipCannon(far = 0) {
    this._safe(() => {
      const fr = clamp01(far);
      const v = this._voice({ cat: 'boom', dur: 2.0, far: fr, gain: 0.7, rev: 0.35, echo: 0.3 });
      if (!v) return;
      this._osc(v, { f: 60, f2: 30, a: 0.004, d: 0.35, vol: 0.45 });
      this._noise(v, { buf: 'brown', a: 0.005, d: 0.4, vol: 0.35, type: 'lowpass', f: 500 });
      this._noise(v, { at: 0.1, a: 0.3, d: 0.06, vol: 0.2, type: 'bandpass', f: 900, f2: 2600, q: 1.2 });
      const b = 0.48;
      this._osc(v, { at: b, f: 80, f2: 28, a: 0.002, d: 0.7, glide: 0.5, vol: 0.85 });
      this._noise(v, { at: b, a: 0.0008, d: 0.05, vol: 0.6, type: 'highpass', f: 1600 });
      this._noise(v, { at: b, buf: 'brown', a: 0.003, d: 1.0, vol: 0.75, type: 'lowpass', f: 2200, f2: 180 });
      this._noise(v, { at: b + 0.06, buf: 'crackle', a: 0.03, d: 0.7, vol: 0.3, type: 'bandpass', f: 2600 });
      this._duck(0.7, 0.8, 0.8);
    });
  },

  /** Gunship leaves: short callout and the drone fades out. */
  gunshipEnd(opts) {
    this.radioCallout('gunshipend', asOpts(opts));
    this._loopStop('gunship', 3.5);
  },
};
