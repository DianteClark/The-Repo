// Hub / store ambience bed: the squad's hideout between matches.
//   room tone + generator hum, slow evolving chord pads (8 s each),
//   distant radio chatter, armoury clanks, muffled gulls and surf.
//   'store' variant: warmer major-7 pads and glassy bell sparkles.

import { Looper } from './looper.js';
import { mtof, pad, bell, env } from './inst.js';

const HUB_CH = [[50, 53, 57, 60, 64], [46, 50, 53, 57, 62], [41, 48, 52, 57, 60], [48, 52, 55, 57, 62]]; // Dm9 Bbmaj7 Fmaj7 C6/9
const STORE_CH = [[41, 48, 52, 55, 57], [46, 50, 53, 57, 60], [43, 50, 53, 57, 62], [48, 52, 55, 59, 62]]; // Fmaj9 Bbmaj7 Gm9 Cmaj7
const SPARKLE = [74, 77, 81, 84, 86, 89, 93];

export class HubBed extends Looper {
  constructor(eng) {
    super(eng, { level: 1.6, fadeIn: 2.0, rev: 0.4 });
    this.STEP = 0.5;
    this.kind = 'hub';
  }

  setKind(k) { this.kind = k === 'store' ? 'store' : 'hub'; }

  _build(n, t) {
    const e = this.eng, ctx = e.ctx;
    // Room tone.
    const rs = ctx.createBufferSource(); rs.buffer = e.buf.brown; rs.loop = true;
    const rl = ctx.createBiquadFilter(); rl.type = 'lowpass'; rl.frequency.value = 280;
    const rg = ctx.createGain(); rg.gain.value = 0.05;
    rs.connect(rl).connect(rg).connect(n.out);
    // Generator hum with a slow beating.
    const hg = ctx.createGain(); hg.gain.value = 0.012;
    for (const [f, a] of [[55, 1], [110.4, 0.5], [165, 0.2]]) {
      const o = ctx.createOscillator(); o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = a;
      o.connect(g).connect(hg); n.srcs.push(o);
    }
    hg.connect(n.out);
    // Distant surf through the walls.
    const ss = ctx.createBufferSource(); ss.buffer = e.buf.pink; ss.loop = true;
    const sl = ctx.createBiquadFilter(); sl.type = 'lowpass'; sl.frequency.value = 450;
    const sg = ctx.createGain(); sg.gain.value = 0.02;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.09;
    const la = ctx.createGain(); la.gain.value = 0.015;
    lfo.connect(la).connect(sg.gain);
    ss.connect(sl).connect(sg).connect(n.out);
    n.srcs.push(rs, ss, lfo);
    for (const s of n.srcs) { if (s.buffer) s.start(t, this.rand() * 1.5); else s.start(t); }
  }

  _stepAt(step, t) {
    const n = this.nodes, I = this.I, r = this.rand, e = this.eng;
    const store = this.kind === 'store';
    const chords = store ? STORE_CH : HUB_CH;
    if (step % 16 === 0) {
      const ch = chords[(step / 16) % chords.length];
      ch.forEach((m, i) => pad(I, n.out, mtof(m), t, 10, i === 0 ? 0.03 : 0.014,
        { cut: store ? 1500 : 900, att: 3, rel: 3.5, det: 6, type: i === 0 ? 'triangle' : 'sawtooth' }));
    }
    if (store) {
      if (step % 2 === 0 && r() < 0.35) bell(I, n.out, mtof(SPARKLE[Math.floor(r() * SPARKLE.length)]), t, 0.03, n.echo, 2.2);
    } else if (step % 4 === 0 && r() < 0.18) {
      bell(I, n.out, mtof(SPARKLE[Math.floor(r() * 4)]), t, 0.022, n.echo, 2.4);
    }
    // Radio chatter from the next room.
    if (step % 8 === 4 && r() < 0.3) {
      const g = e.ctx.createGain(); g.gain.value = 0.18;
      const lp = e.ctx.createBiquadFilter(); lp.type = 'bandpass'; lp.frequency.value = 1300; lp.Q.value = 1.2;
      g.connect(lp).connect(n.out);
      e._squelch(t, 0.04, g, 0.12);
      e._babble(t + 0.06, g, { syl: 3 + Math.floor(r() * 4), f0: 110 + r() * 50, vol: 0.18, seed: Math.floor(r() * 1e6) });
    }
    // Armoury clank.
    if (step % 6 === 3 && r() < 0.16) this._clank(t);
    // Muffled gull.
    if (!store && step % 12 === 7 && r() < 0.3) this._gull(t);
  }

  _clank(t) {
    const ctx = this.eng.ctx, n = this.nodes;
    const g = ctx.createGain(); g.gain.value = 0.05;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
    g.connect(lp).connect(n.out);
    const rs = ctx.createGain(); rs.gain.value = 1.2; g.connect(rs).connect(n.rev);
    for (const [f, d] of [[620, 0.5], [1490, 0.3], [2310, 0.2]]) {
      const o = ctx.createOscillator(); o.frequency.value = f * (0.95 + this.rand() * 0.1);
      const og = ctx.createGain(); env(og, t, 0.001, 0.6, d);
      o.connect(og).connect(g); o.start(t); o.stop(t + d + 0.05);
    }
  }

  _gull(t) {
    const ctx = this.eng.ctx, n = this.nodes;
    for (let i = 0; i < 2; i++) {
      const t0 = t + i * 0.32;
      const o = ctx.createOscillator(); o.type = 'triangle';
      o.frequency.setValueAtTime(1500, t0); o.frequency.exponentialRampToValueAtTime(950, t0 + 0.22);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1300;
      const g = ctx.createGain(); env(g, t0, 0.02, 0.012, 0.22);
      o.connect(lp).connect(g).connect(n.out); o.start(t0); o.stop(t0 + 0.3);
    }
  }
}
