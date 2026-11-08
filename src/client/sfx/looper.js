// Base for scheduled music loops (menu theme, hub/store bed, Pit theme).
// Subclasses set this.STEP (seconds per step) and implement
//   _build(n, t)    — optional continuous nodes; push every source to n.srcs
//   _stepAt(step,t) — schedule the notes of one step
// The look-ahead scheduler runs on a 50 ms interval (real-time) or through
// pump(horizon) (offline renders). stop() fades, then releases everything.

export class Looper {
  constructor(eng, { level = 1, fadeIn = 1.5, dest = 'musicIn', rev = 0.3, revDest = 'musicRevIn', echoDest = 'musicEchoIn' } = {}) {
    this.eng = eng;
    this.level = level;
    this.fadeIn = fadeIn;
    this.destKey = dest; this.revKey = revDest; this.echoKey = echoDest; this.revLvl = rev;
    this.playing = false;
    this.stopping = false;
    this.nodes = null;
    this.timer = null;
    this.rand = Math.random;
    this.STEP = 0.25;
  }

  /**
   * Instrument context for sfx/inst.js. Its ctx wrapper records every note
   * source so stop() can cut long notes (pads) instead of letting them ring on.
   */
  get I() {
    const n = this.nodes, e = this.eng;
    if (!n) return { ctx: e.ctx, buf: e.buf, rand: this.rand };
    if (!n.I) {
      const ctx = e.ctx, notes = n.notes;
      const reg = (node) => { notes.push([node, ctx.currentTime]); return node; };
      n.I = {
        buf: e.buf, rand: this.rand,
        ctx: {
          get currentTime() { return ctx.currentTime; },
          get sampleRate() { return ctx.sampleRate; },
          createOscillator: () => reg(ctx.createOscillator()),
          createBufferSource: () => reg(ctx.createBufferSource()),
          createGain: () => ctx.createGain(),
          createBiquadFilter: () => ctx.createBiquadFilter(),
          createStereoPanner: ctx.createStereoPanner ? () => ctx.createStereoPanner() : undefined,
        },
      };
    }
    return n.I;
  }

  /** Stop every recorded note source at time t. */
  _cutNotes(n, t) {
    for (const [s] of n.notes) { try { s.stop(t); } catch { /* not started / stopped */ } }
    n.notes.length = 0;
  }

  start(fade = this.fadeIn) {
    const e = this.eng, ctx = e.ctx;
    if (!ctx) return;
    if (this.playing && !this.stopping) return; // already running
    if (this.nodes) this._kill(this.nodes, 0.08); // restarting during a fade-out
    this.playing = true;
    this.stopping = false;
    const t = ctx.currentTime + 0.05;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(this.level, t + Math.max(0.05, fade));
    out.connect(e[this.destKey]);
    const rev = ctx.createGain(); rev.gain.value = this.revLvl;
    out.connect(rev).connect(e[this.revKey]);
    const echo = ctx.createGain(); echo.gain.value = 1;
    if (this.echoKey && e[this.echoKey]) echo.connect(e[this.echoKey]);
    const n = { out, rev, echo, srcs: [], notes: [], timer: null };
    this.nodes = n;
    try { this._build?.(n, t); } catch { /* keep the scheduler alive */ }
    this.step = 0;
    this.nextT = t + 0.1;
    this.endAt = Infinity;
    this._onStart?.(t);
    if (!e.offline) {
      n.timer = setInterval(() => this.pump(), 50);
      this.timer = n.timer;
    }
  }

  stop(fade = 1.5) {
    const e = this.eng, ctx = e.ctx;
    if (!this.playing || !ctx || this.stopping || !this.nodes) return;
    this.stopping = true;
    const t = ctx.currentTime;
    this.endAt = t + fade;
    const n = this.nodes;
    const g = n.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + fade);
    for (const s of n.srcs) { try { s.stop(t + fade + 0.05); } catch { /* stopped */ } }
    for (const [s] of n.notes) { try { s.stop(t + fade + 0.05); } catch { /* stopped */ } }
    this._onStop?.(t, fade);
    if (e.offline) return;
    setTimeout(() => {
      if (this.nodes === n) { this.playing = false; this.stopping = false; this.nodes = null; this.timer = null; }
      this._kill(n, 0);
    }, (fade + 0.4) * 1000);
  }

  /** Smoothly change the loop's output level (e.g. under the Pit theme). */
  setLevel(v, tc = 0.6) {
    const n = this.nodes, ctx = this.eng.ctx;
    if (!n || !ctx || this.stopping) return;
    const t = ctx.currentTime, g = n.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.setTargetAtTime(Math.max(0, v) * this.level, t, tc);
  }

  _kill(n, fade) {
    if (n.timer) clearInterval(n.timer);
    n.timer = null;
    const ctx = this.eng.ctx;
    if (fade > 0 && ctx) {
      const t = ctx.currentTime, g = n.out.gain;
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + fade);
      for (const s of n.srcs) { try { s.stop(t + fade + 0.02); } catch { /* stopped */ } }
      this._cutNotes(n, t + fade + 0.02);
      setTimeout(() => this._disc(n), (fade + 2.5) * 1000);
    } else {
      if (ctx) for (const s of n.srcs) { try { s.stop(); } catch { /* stopped */ } }
      if (ctx) this._cutNotes(n, 0);
      this._disc(n);
    }
  }

  _disc(n) {
    try { n.out.disconnect(); n.rev.disconnect(); n.echo.disconnect(); } catch { /* gone */ }
  }

  pump(horizon) {
    const e = this.eng, ctx = e.ctx;
    if (!this.playing || !ctx || !this.nodes) return;
    if (horizon === undefined && ctx.state !== 'running') return;
    const until = Math.min(horizon ?? ctx.currentTime + 0.3, this.endAt);
    if (this.nextT < ctx.currentTime - 0.5) this.nextT = ctx.currentTime + 0.05;
    const notes = this.nodes.notes;
    if (notes.length > 400) { // forget notes that have certainly ended
      const old = ctx.currentTime - 15;
      let w = 0;
      for (const x of notes) if (x[1] > old) notes[w++] = x;
      notes.length = w;
    }
    while (this.nextT < until) {
      if (e.canPlay()) { try { this._stepAt(this.step, this.nextT); } catch { /* never break the loop */ } }
      this.step++;
      this.nextT += this.STEP;
    }
  }
}
