// The Pit: a tense 1v1 duel theme. D Phrygian at 112 BPM, 16-bar build.
//   bars 0–3   palm-muted D/Eb ostinato + clock + heartbeat
//   bars 4–7   + taiko on 1 and the "and" of 2
//   bars 8–11  + tremolo strings (minor-2nd cluster)
//   bars 12–15 + brass stabs, hats, riser into the loop
// Looped; the tension never resolves until stop().

import { Looper } from './looper.js';
import { mtof, pluck, kick, hat, tom, tremolo, brass, riser, pad } from './inst.js';

const BPM = 112;
const STEP = 60 / BPM / 4; // 16th
const OST = [0, 0, 12, 0, 1, 0, 0, 13, 0, 0, 12, 0, 1, 0, 3, 1];
const STABS = [[46, 50, 53], [44, 48, 51], [45, 49, 52], [43, 46, 50]]; // Bb, Ab, A, Gm

export class PitTheme extends Looper {
  constructor(eng) {
    super(eng, { level: 2.4, fadeIn: 0.8, rev: 0.25 });
    this.STEP = STEP;
  }

  _build(n, t) {
    // Low drone under everything: D1 with a slowly opening filter.
    const ctx = this.eng.ctx;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 160; lp.Q.value = 2;
    const g = ctx.createGain(); g.gain.value = 0.05;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const la = ctx.createGain(); la.gain.value = 70;
    lfo.connect(la).connect(lp.frequency);
    lp.connect(g).connect(n.out);
    for (const d of [-8, 8]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(26); o.detune.value = d;
      o.connect(lp); n.srcs.push(o);
    }
    n.srcs.push(lfo);
    for (const s of n.srcs) s.start(t);
  }

  _stepAt(step, t) {
    const n = this.nodes, I = this.I, out = n.out;
    const s = step % 16;
    const bar = Math.floor(step / 16) % 16;
    const barLen = 16 * STEP;
    // Ostinato.
    const iv = OST[s];
    pluck(I, out, mtof(38 + iv), t, s % 4 === 0 ? 0.11 : 0.075, 500 + bar * 70, 0.11);
    // Clock on 8ths, accent on beats.
    if (s % 2 === 0) hat(I, out, t, s % 4 === 0 ? 0.03 : 0.015, 0.02);
    // Heartbeat on beats 1 and 3.
    if (s === 0 || s === 8) { kick(I, out, t, 0.32, 70, 38, 0.22); kick(I, out, t + 0.16, 0.2, 70, 38, 0.2); }
    if (bar >= 4) {
      if (s === 0) tom(I, out, t, 0.38, 70, 0.6);
      if (s === 6) tom(I, out, t, 0.26, 92, 0.4);
      if (bar % 4 === 3 && s >= 12) tom(I, out, t, 0.18 + (s - 12) * 0.04, 110 - (s - 12) * 8, 0.3);
    }
    if (bar >= 8 && s === 0 && bar % 2 === 0) {
      tremolo(I, out, mtof(62), t, barLen * 2, 0.022);
      tremolo(I, out, mtof(63), t, barLen * 2, 0.016);
      if (bar >= 12) tremolo(I, out, mtof(69), t, barLen * 2, 0.012);
    }
    if (bar >= 12) {
      if (s === 0 || s === 10) for (const m of STABS[bar % 4]) brass(I, out, mtof(m), t, 0.35, 0.018);
      if (s % 2 === 1) hat(I, out, t, 0.012);
      if (bar === 15 && s === 0) riser(I, out, t, barLen, 0.06);
    }
    if (bar === 0 && s === 0) pad(I, out, mtof(50), t, barLen * 4, 0.012, { cut: 600, att: 2 });
  }
}
