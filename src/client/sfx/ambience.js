// World ambience for Tidefall: the drowned archipelago.
//   stage 0 (early): rolling waves, light wind, gulls.
//   stage 1 (late):  waves thin out, wind howls, low storm rumble, thunder.
//   rain 0..1:       rain hiss + drop crackle.
// Loops run only between start() and stop(); one-shots (gulls, thunder) come
// from a light scheduler that stops with them.

import { makeNoise } from './buffers.js';

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Ambience {
  constructor(eng) {
    this.eng = eng;
    this.playing = false;
    this.p = { stage: 0, rain: 0 };
    this.nodes = null;
    this.timer = null;
    this.rand = Math.random;
  }

  set(p) {
    this.p = { stage: p.stage ?? this.p.stage, rain: p.rain ?? this.p.rain };
    if (this.playing) this._levels(this.eng.ctx.currentTime, 1.5);
  }

  _bufs() {
    const e = this.eng, ctx = e.ctx;
    // Longer beds than the SFX noise so the loops don't audibly repeat.
    if (!e.buf.brownLong) {
      e.buf.brownLong = makeNoise(ctx, 'brown', 6, 31);
      e.buf.pinkLong = makeNoise(ctx, 'pink', 5, 37);
      e.buf.whiteLong = makeNoise(ctx, 'white', 4, 41);
    }
    return e.buf;
  }

  start() {
    const e = this.eng, ctx = e.ctx;
    if (!ctx || this.playing) return;
    this.playing = true;
    const B = this._bufs();
    const t = ctx.currentTime + 0.05;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(1, t + 3);
    out.connect(e.ambIn);
    const n = { out, srcs: [], oscs: [] };
    const loop = (buf, rate = 1) => {
      const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate;
      n.srcs.push(s); return s;
    };
    const lfo = (freq, amt, param) => {
      const o = ctx.createOscillator(); o.frequency.value = freq;
      const g = ctx.createGain(); g.gain.value = amt;
      o.connect(g).connect(param);
      n.oscs.push(o);
      return o;
    };
    const level = (v) => { const g = ctx.createGain(); g.gain.value = v; g.connect(out); return g; };

    // Waves: two swelling brown-noise beds, panned apart, different periods.
    n.waves = level(0);
    for (const [pan, rate, per] of [[-0.55, 1, 0.071], [0.55, 0.93, 0.113]]) {
      const s = loop(B.brownLong, rate);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.6;
      lfo(per, 260, lp.frequency);
      const g = ctx.createGain(); g.gain.value = 0.5;
      lfo(per, 0.45, g.gain);
      s.connect(lp).connect(g);
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p).connect(n.waves);
      } else g.connect(n.waves);
    }
    // Wind: band-passed pink noise with slow gusts.
    n.wind = level(0);
    {
      const s = loop(B.pinkLong);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 480; bp.Q.value = 0.9;
      lfo(0.043, 260, bp.frequency);
      const g = ctx.createGain(); g.gain.value = 0.6;
      lfo(0.09, 0.35, g.gain);
      s.connect(bp).connect(g).connect(n.wind);
    }
    // Rain: hiss + drops.
    n.rain = level(0);
    {
      const s = loop(B.whiteLong);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1600;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7500;
      const g = ctx.createGain(); g.gain.value = 0.5;
      s.connect(hp).connect(lp).connect(g).connect(n.rain);
      const d = loop(B.crackle, 1.3);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3300; bp.Q.value = 0.7;
      const dg = ctx.createGain(); dg.gain.value = 0.35;
      d.connect(bp).connect(dg).connect(n.rain);
    }
    // Storm: sub rumble.
    n.storm = level(0);
    {
      const s = loop(B.brownLong, 0.6);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 110;
      const g = ctx.createGain(); g.gain.value = 0.9;
      lfo(0.05, 0.4, g.gain);
      s.connect(lp).connect(g).connect(n.storm);
    }
    for (const s of n.srcs) s.start(t, this.rand() * 2);
    for (const o of n.oscs) o.start(t);
    this.nodes = n;
    this._levels(t, 0.01);
    this.nextT = t + 1;
    if (!e.offline) this.timer = setInterval(() => this.pump(), 250);
  }

  _levels(t, tc) {
    const n = this.nodes; if (!n) return;
    const { stage, rain } = this.p;
    const storm = smooth(0.55, 1, Math.max(stage, rain * 0.9));
    n.waves.gain.setTargetAtTime(0.32 * (1 - 0.55 * stage), t, tc);
    n.wind.gain.setTargetAtTime(0.06 + 0.16 * stage + 0.1 * storm, t, tc);
    n.rain.gain.setTargetAtTime(0.16 * rain, t, tc);
    n.storm.gain.setTargetAtTime(0.35 * storm, t, tc);
  }

  stop(fade = 1.5) {
    const ctx = this.eng.ctx;
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
    for (const s of n.srcs) { try { s.stop(t + fade + 0.05); } catch { /* stopped */ } }
    for (const o of n.oscs) { try { o.stop(t + fade + 0.05); } catch { /* stopped */ } }
    const kill = () => { try { n.out.disconnect(); } catch { /* gone */ } };
    if (this.eng.offline) return;
    setTimeout(kill, (fade + 0.3) * 1000);
  }

  /** Schedule one-shots (gulls, thunder) up to `horizon`. */
  pump(horizon) {
    const e = this.eng, ctx = e.ctx;
    if (!this.playing || !ctx) return;
    if (horizon === undefined && ctx.state !== 'running') return;
    const until = horizon ?? ctx.currentTime + 0.5;
    if (this.nextT < ctx.currentTime - 1) this.nextT = ctx.currentTime + 0.1;
    const { stage, rain } = this.p;
    const gullRate = 0.14 * Math.pow(1 - stage, 2) * (1 - rain);      // per second
    const thunderRate = 0.045 * smooth(0.55, 1, Math.max(stage, rain * 0.9));
    const dt = 0.25;
    while (this.nextT < until) {
      const t = this.nextT;
      if (e.canPlay()) {
        if (this.rand() < gullRate * dt) this._gull(t);
        if (this.rand() < thunderRate * dt) this._thunder(t);
      }
      this.nextT += dt;
    }
  }

  _send(node, amt) {
    const g = this.eng.ctx.createGain(); g.gain.value = amt;
    node.connect(g).connect(this.eng.ambRevIn);
  }

  _gull(t0) {
    const ctx = this.eng.ctx, n = this.nodes, r = this.rand;
    const calls = 2 + Math.floor(r() * 3);
    const base = 1300 + r() * 500;
    const vol = 0.025 + r() * 0.03;
    const bus = ctx.createGain(); bus.gain.value = 1;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3500 + r() * 2000;
    bus.connect(lp);
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner(); p.pan.value = r() * 1.6 - 0.8; lp.connect(p).connect(n.out);
    } else lp.connect(n.out);
    this._send(lp, 0.5);
    for (let i = 0; i < calls; i++) {
      const t = t0 + i * (0.22 + r() * 0.1);
      const f = base * (1 - i * 0.04);
      const o = ctx.createOscillator(); o.type = 'triangle';
      o.frequency.setValueAtTime(f * 0.8, t);
      o.frequency.exponentialRampToValueAtTime(f * 1.35, t + 0.05);
      o.frequency.exponentialRampToValueAtTime(f * 0.75, t + 0.22);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
      o.connect(g).connect(bus);
      o.start(t); o.stop(t + 0.26);
    }
  }

  _thunder(t) {
    const ctx = this.eng.ctx, n = this.nodes, r = this.rand;
    const near = r();
    const s = ctx.createBufferSource(); s.buffer = this.eng.buf.brownLong; s.loop = true;
    s.playbackRate.value = 0.7 + r() * 0.3;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(300 + near * 600, t);
    lp.frequency.exponentialRampToValueAtTime(70, t + 4);
    const g = ctx.createGain();
    const a = 0.15 + (1 - near) * 0.6;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35 + 0.35 * near, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + 3.5 + r() * 1.5);
    s.connect(lp).connect(g).connect(n.out);
    this._send(g, 0.35);
    s.start(t, r() * 3); s.stop(t + a + 5.2);
    if (near > 0.7) { // close strike: a crack first
      const c = ctx.createBufferSource(); c.buffer = this.eng.buf.crackle;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1500;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0, t); cg.gain.linearRampToValueAtTime(0.25, t + 0.01);
      cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      c.connect(hp).connect(cg).connect(n.out);
      c.start(t, r()); c.stop(t + 0.65);
    }
  }
}
