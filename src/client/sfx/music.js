// Adaptive procedural score for Tidefall.
//
// A minimal, tense ambient/electronic bed in D minor at 84 BPM:
//   drone   — always on; detuned saws + sub through a slowly breathing low-pass
//   motif   — sparse bell phrases with tape echo (density rises with intensity)
//   pulse   — clock ticks + syncopated low sine pulse   (intensity ~0.2 → 0.6)
//   arp     — filtered saw bass arpeggio                (intensity ~0.45 → 0.8)
//   heart   — lub-dub heartbeat + minor-2nd tension pad (intensity ~0.72 → 1)
// plus a very quiet tape-hiss bed. setIntensity() blends the layers smoothly.

const BPM = 84;
const STEP = 60 / BPM / 4; // one 16th note
const D2 = 73.416;
const semi = (n) => Math.pow(2, n / 12);
// Root progression, changes every 4 bars: D, D, Bb, C.
const ROOTS = [0, 0, -4, -2];
// D natural minor degrees for the motif (relative to D4).
const SCALE = [0, 2, 3, 5, 7, 8, 10, 12, 14, 15];
// The seed motif (scale indices) that phrases are varied from.
const MOTIF = [7, 4, 6, 3];
const ARP = [0, 0, 12, 0, 7, 0, 10, 0, 0, 12, 0, 3, 7, 0, 10, 12];

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Score {
  /** eng: the Sfx engine (provides ctx, buses, buffers, canPlay()). */
  constructor(eng) {
    this.eng = eng;
    this.playing = false;
    this.target = 0.15;
    this.I = 0.15;
    this.timer = null;
    this.nodes = null;
    this.rand = Math.random;
  }

  setIntensity(x) {
    const v = Number(x);
    this.target = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : this.target;
  }

  start() {
    const e = this.eng, ctx = e.ctx;
    if (!ctx || this.playing) return;
    this.playing = true;
    const t = ctx.currentTime + 0.05;

    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(1, t + 3); // fade in
    out.connect(e.musicIn);
    const send = ctx.createGain();
    send.gain.value = 0.35;
    out.connect(send).connect(e.reverbIn);

    const layer = (v) => { const g = ctx.createGain(); g.gain.value = v; g.connect(out); return g; };
    const n = {
      out, send,
      drone: layer(0.2), motif: layer(0.5), pulse: layer(0), arp: layer(0), heart: layer(0), pad: layer(0),
      oscs: [], srcs: [],
    };

    // --- Drone ---
    const dlp = ctx.createBiquadFilter();
    dlp.type = 'lowpass'; dlp.frequency.value = 260; dlp.Q.value = 1.6;
    dlp.connect(n.drone);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.055;
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 110;
    lfo.connect(lfoAmt).connect(dlp.frequency);
    n.oscs.push(lfo);
    n.droneOsc = [];
    const mk = (type, f, det, vol, dest) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = det;
      const g = ctx.createGain(); g.gain.value = vol;
      o.connect(g).connect(dest); n.oscs.push(o); return o;
    };
    n.droneOsc.push({ o: mk('sawtooth', D2, -6, 0.22, dlp), mul: 1 });
    n.droneOsc.push({ o: mk('sawtooth', D2, 7, 0.22, dlp), mul: 1 });
    n.droneOsc.push({ o: mk('sawtooth', D2 * 1.5, -3, 0.12, dlp), mul: 1.5 });
    n.droneOsc.push({ o: mk('sine', D2 / 2, 0, 0.55, n.drone), mul: 0.5 });
    n.dlp = dlp;

    // --- Tension pad: A4 + Bb4 cluster with slow tremolo, kept very quiet ---
    const plp = ctx.createBiquadFilter(); plp.type = 'lowpass'; plp.frequency.value = 1400;
    const trem = ctx.createGain(); trem.gain.value = 0.5;
    plp.connect(trem).connect(n.pad);
    const tl = ctx.createOscillator(); tl.frequency.value = 5.2;
    const tla = ctx.createGain(); tla.gain.value = 0.35;
    tl.connect(tla).connect(trem.gain);
    n.oscs.push(tl);
    mk('triangle', 440, 0, 0.5, plp);
    mk('triangle', 466.16, 0, 0.4, plp);

    // --- Tape hiss bed, with slow "wow" in level ---
    const hs = ctx.createBufferSource(); hs.buffer = e.buf.pink; hs.loop = true;
    const hhp = ctx.createBiquadFilter(); hhp.type = 'highpass'; hhp.frequency.value = 2600;
    const hlp = ctx.createBiquadFilter(); hlp.type = 'lowpass'; hlp.frequency.value = 9000;
    const hg = ctx.createGain(); hg.gain.value = 0.012;
    const wow = ctx.createOscillator(); wow.frequency.value = 0.23;
    const wowA = ctx.createGain(); wowA.gain.value = 0.004;
    wow.connect(wowA).connect(hg.gain);
    hs.connect(hhp).connect(hlp).connect(hg).connect(out);
    n.srcs.push(hs); n.oscs.push(wow);

    for (const o of n.oscs) o.start(t);
    hs.start(t, this.rand() * 1.5);
    this.nodes = n;
    this.step = 0;
    this.nextT = t + 0.1;
    this.bar = 0;
    this.rootIdx = -1;
    this._applyLayers(t, 0.01);
    if (!e.offline) {
      this.timer = setInterval(() => this.pump(), 50);
    }
  }

  stop(fade = 1.5) {
    const e = this.eng, ctx = e.ctx;
    if (!this.playing || !ctx) return;
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const n = this.nodes;
    this.nodes = null;
    const t = ctx.currentTime;
    n.out.gain.cancelScheduledValues(t);
    n.out.gain.setValueAtTime(n.out.gain.value, t);
    n.out.gain.linearRampToValueAtTime(0, t + fade);
    for (const o of n.oscs.concat(n.srcs)) { try { o.stop(t + fade + 0.05); } catch { /* already stopped */ } }
    setTimeout(() => { try { n.out.disconnect(); n.send.disconnect(); } catch { /* gone */ } }, (fade + 0.3) * 1000);
  }

  /** Schedule notes up to `horizon` (defaults to now + 0.25s). */
  pump(horizon) {
    const e = this.eng, ctx = e.ctx;
    if (!this.playing || !ctx) return;
    const until = horizon ?? ctx.currentTime + 0.25;
    // If the tab slept, skip ahead instead of firing a burst of stale notes.
    if (this.nextT < ctx.currentTime - 0.5) this.nextT = ctx.currentTime + 0.05;
    while (this.nextT < until) {
      this._stepAt(this.step, this.nextT);
      this.step++;
      this.nextT += STEP;
    }
  }

  _applyLayers(t, tc = 0.6) {
    const n = this.nodes, I = this.I;
    const set = (p, v) => p.setTargetAtTime(v, t, tc);
    set(n.drone.gain, 0.2 - 0.05 * I);
    set(n.motif.gain, 0.35 + 0.35 * smooth(0.1, 0.6, I));
    set(n.pulse.gain, 0.6 * smooth(0.2, 0.6, I));
    set(n.arp.gain, 0.5 * smooth(0.45, 0.8, I));
    set(n.heart.gain, 0.9 * smooth(0.72, 0.95, I));
    set(n.pad.gain, 0.05 * smooth(0.75, 1, I));
    set(n.dlp.frequency, 240 + 520 * I);
  }

  _stepAt(step, t) {
    const e = this.eng, n = this.nodes;
    // Ease intensity toward its target (~3 s time constant).
    this.I += (this.target - this.I) * 0.06;
    const I = this.I;
    const s16 = step % 16;
    if (s16 === 0) {
      this.bar = Math.floor(step / 16);
      this._applyLayers(t);
      const ri = Math.floor(this.bar / 4) % ROOTS.length;
      if (ri !== this.rootIdx) {
        this.rootIdx = ri;
        const f = D2 * semi(ROOTS[ri]);
        for (const d of n.droneOsc) d.o.frequency.setTargetAtTime(f * d.mul, t, 0.8);
      }
    }
    if (!e.canPlay()) return; // muted: keep time, schedule nothing
    const root = D2 * semi(ROOTS[Math.max(0, this.rootIdx)]);
    const r = this.rand;

    // Motif: a phrase at the top of some bars.
    if (s16 === 0 && this.bar % 2 === 0 && r() < 0.3 + 0.35 * I) this._phrase(t, I);

    // Pulse: clock ticks on 8ths (accented on beats) + a syncopated low pulse.
    if (I > 0.15) {
      if (step % 2 === 0) this._tick(t, s16 % 4 === 0 ? 0.05 : 0.025, n.pulse);
      if (s16 === 0 || s16 === 6 || s16 === 10) this._blip(root * 2, t, 0.16, 0.22, n.pulse);
    }
    // Arp: 16th-note filtered saw; denser with intensity.
    if (I > 0.4) {
      const iv = ARP[s16];
      const dense = I > 0.82 || s16 % 2 === 0 || iv !== 0;
      if (dense) this._pluck(root * 2 * semi(iv), t, 260 + 1700 * I, n.arp);
    }
    // Heartbeat: lub-dub every beat; shaker 16ths at the very top.
    if (I > 0.65 && s16 % 4 === 0) {
      this._kick(t, 0.55, n.heart);
      this._kick(t + 0.16, 0.35, n.heart);
    }
    if (I > 0.88) this._tick(t, s16 % 2 ? 0.012 : 0.02, n.heart, 7000);
  }

  // ---- note voices (all short-lived; each cleans itself up via stop()) ----

  _env(g, t, a, peak, d) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  _phrase(t, I) {
    const r = this.rand;
    const len = 2 + Math.floor(r() * (2 + I * 2));
    const shift = [0, 0, 1, -1, 2][Math.floor(r() * 5)];
    const gap = (r() < 0.5 ? 3 : 4) * STEP;
    for (let i = 0; i < len; i++) {
      let idx = MOTIF[i % MOTIF.length] + shift;
      if (r() < 0.25) idx += r() < 0.5 ? -1 : 1;
      idx = Math.max(0, Math.min(SCALE.length - 1, idx));
      const f = 293.66 * semi(SCALE[idx]);
      this._bell(f, t + i * gap, 0.07 * (1 - i * 0.12));
    }
  }

  _bell(f, t, vol) {
    const ctx = this.eng.ctx, n = this.nodes;
    const g = ctx.createGain();
    this._env(g, t, 0.006, vol, 1.8);
    const o1 = ctx.createOscillator(); o1.type = 'triangle'; o1.frequency.value = f;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2.76; // inharmonic shimmer
    const g2 = ctx.createGain(); g2.gain.value = 0.18;
    o1.connect(g); o2.connect(g2).connect(g);
    g.connect(n.motif);
    const echo = ctx.createGain(); echo.gain.value = 0.5;
    g.connect(echo).connect(this.eng.echoIn);
    o1.start(t); o2.start(t); o1.stop(t + 1.9); o2.stop(t + 1.9);
  }

  _tick(t, vol, dest, f = 5200) {
    const ctx = this.eng.ctx;
    const s = ctx.createBufferSource(); s.buffer = this.eng.buf.white;
    const hp = ctx.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = f; hp.Q.value = 1.2;
    const g = ctx.createGain();
    this._env(g, t, 0.001, vol, 0.03);
    s.connect(hp).connect(g).connect(dest);
    s.start(t, this.rand() * 1.5); s.stop(t + 0.05);
  }

  _blip(f, t, vol, d, dest) {
    const ctx = this.eng.ctx;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const g = ctx.createGain();
    this._env(g, t, 0.004, vol, d);
    o.connect(g).connect(dest);
    o.start(t); o.stop(t + d + 0.02);
  }

  _pluck(f, t, cutoff, dest) {
    const ctx = this.eng.ctx;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 6;
    lp.frequency.setValueAtTime(cutoff, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.16);
    const g = ctx.createGain();
    this._env(g, t, 0.003, 0.12, 0.17);
    o.connect(lp).connect(g).connect(dest);
    o.start(t); o.stop(t + 0.2);
  }

  _kick(t, vol, dest) {
    const ctx = this.eng.ctx;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.14);
    const g = ctx.createGain();
    this._env(g, t, 0.005, vol, 0.22);
    o.connect(g).connect(dest);
    o.start(t); o.stop(t + 0.25);
  }

  // ---- stingers (played on the un-ducked stinger bus) ----

  stinger(kind) {
    const e = this.eng, ctx = e.ctx;
    const t = ctx.currentTime + 0.02;
    const out = ctx.createGain(); out.gain.value = 1;
    out.connect(e.stingerIn);
    const rs = ctx.createGain(); rs.gain.value = 0.45;
    out.connect(rs).connect(e.reverbIn);
    const pad = (f, t0, dur, vol, cutFrom, cutTo, type = 'sawtooth', det = 8) => {
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.2;
      lp.frequency.setValueAtTime(cutFrom, t0);
      lp.frequency.exponentialRampToValueAtTime(cutTo, t0 + dur * 0.6);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + Math.min(0.35, dur * 0.25));
      g.gain.setValueAtTime(vol, t0 + dur * 0.55);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      lp.connect(g).connect(out);
      for (const d of [-det, det]) {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = d;
        o.connect(lp); o.start(t0); o.stop(t0 + dur + 0.05);
      }
    };
    const bell = (f, t0, vol) => {
      const g = ctx.createGain();
      this._env(g, t0, 0.005, vol, 2.2);
      g.connect(out);
      const ec = ctx.createGain(); ec.gain.value = 0.4; g.connect(ec).connect(e.echoIn);
      for (const [m, a] of [[1, 1], [2.76, 0.2], [5.4, 0.06]]) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * m;
        const ga = ctx.createGain(); ga.gain.value = a;
        o.connect(ga).connect(g); o.start(t0); o.stop(t0 + 2.3);
      }
    };
    const D3 = 146.83;
    let len = 3;
    if (kind === 'victory') {
      // D minor resolving up to D major, bright bells on top.
      pad(D3, t, 1.2, 0.06, 300, 1400);
      pad(D3 * semi(3), t, 1.2, 0.04, 300, 1400);
      pad(D3, t + 0.9, 3.2, 0.07, 400, 3000);
      pad(D3 * semi(4), t + 0.9, 3.2, 0.05, 400, 3000);
      pad(D3 * semi(7), t + 0.9, 3.2, 0.05, 400, 3000);
      pad(D3 / 2, t + 0.9, 3.2, 0.08, 200, 600, 'triangle', 0);
      [0, 4, 7, 12].forEach((s, i) => bell(587.33 * semi(s), t + 0.9 + i * 0.14, 0.09));
      len = 4.5;
    } else if (kind === 'defeat') {
      // Sinking minor line with the filter closing, then the signal drops.
      [[7, 0], [3, 0.6], [0, 1.2]].forEach(([s, dt]) => pad(D3 * semi(s), t + dt, 1.6, 0.06, 1800, 220));
      pad(D3 / 2, t, 3.0, 0.07, 400, 120, 'triangle', 0);
      e._static(t + 2.4, 0.35, 0.12, out);
      len = 3.5;
    } else if (kind === 'round') {
      e._squelch(t, 0.08, out);
      pad(D3 / 2, t + 0.06, 1.1, 0.07, 300, 900);
      pad(D3 * 0.75, t + 0.06, 1.1, 0.05, 300, 900);
      bell(587.33, t + 0.08, 0.06);
      bell(880, t + 0.3, 0.05);
      len = 2.5;
    } else { // 'tide'
      pad(D2, t, 2.8, 0.09, 150, 900);
      pad(D2 * 1.5, t + 0.15, 2.6, 0.06, 150, 900);
      pad(D2 * semi(-4) * 2, t + 1.0, 1.8, 0.04, 300, 1200);
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(30, t); o.frequency.linearRampToValueAtTime(46, t + 2.2);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.35, t + 1.2);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 3.0);
      o.connect(g).connect(out); o.start(t); o.stop(t + 3.1);
      len = 3.2;
    }
    setTimeout(() => { try { out.disconnect(); } catch { /* gone */ } }, (len + 3) * 1000);
    return len;
  }
}
