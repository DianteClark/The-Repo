// Tidefall title theme: a hooky, radio-lead tune in D minor at 96 BPM.
//
// 8-bar loop over i–VI–III–VII | i–VI–III–V (Dm Bb F C | Dm Bb F A).
// The hook is the rising "A–D–E–F" figure that opens bars 1 and 5.
// Arrangement cycles: soft (bells + pad + bass) → full (drums + radio lead)
// → full → breakdown (pad + bells), then back to full.

const BPM = 96;
const STEP = 60 / BPM / 2; // one 8th note
const BAR = 8;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const _ = null;

const MELODY = [
  [69, 74, 76, 77, _, 76, 74, _],   // Dm: A D E F . E D .
  [70, _, 74, _, 77, 76, 74, _],    // Bb: Bb . D . F E D .
  [72, 77, 79, 81, _, 79, 77, _],   // F:  C F G A . G F .
  [79, _, 76, _, 72, _, _, _],      // C:  G . E . C . . .
  [69, 74, 76, 77, _, 76, 74, _],   // Dm (hook again)
  [70, _, 74, _, 77, 79, 81, _],    // Bb: rising answer
  [81, _, 79, 77, 76, _, 77, _],    // F
  [76, _, 73, _, 69, _, _, _],      // A:  E . C# . A  (pulls back to Dm)
];
const CHORDS = [
  [50, 53, 57], [46, 50, 53], [53, 57, 60], [48, 52, 55],
  [50, 53, 57], [46, 50, 53], [53, 57, 60], [45, 49, 52],
];
const ROOTS = [38, 34, 41, 36, 38, 34, 41, 33];
const BASS_FULL = [0, 0, 12, 0, 0, 0, 12, 0];
const SECTIONS = ['soft', 'full', 'full', 'break'];

export class MenuTheme {
  constructor(eng) {
    this.eng = eng;
    this.playing = false;
    this.nodes = null;
    this.timer = null;
    this.rand = Math.random;
  }

  start() {
    const e = this.eng, ctx = e.ctx;
    if (!ctx) return;
    if (this.playing && !this.stopping) return; // already running
    if (this.nodes) this._kill(this.nodes, 0.08); // restarting during a fade-out
    this.playing = true;
    this.stopping = false;
    const t = ctx.currentTime + 0.05;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(3, t + 1.5); // the menu has no SFX to sit under
    out.connect(e.musicIn);
    const rev = ctx.createGain(); rev.gain.value = 0.3;
    out.connect(rev).connect(e.musicRevIn);
    const echo = ctx.createGain(); echo.gain.value = 1;
    echo.connect(e.musicEchoIn);
    this.nodes = { out, rev, echo, timer: null };
    // Sync the shared tape echo to a dotted 8th at 96 BPM while the theme plays.
    e.echoDelay?.delayTime.setTargetAtTime(STEP * 1.5, t, 0.3);
    this.step = 0;
    this.nextT = t + 0.1;
    this.endAt = Infinity;
    if (!e.offline) {
      const n = this.nodes;
      n.timer = setInterval(() => this.pump(), 50);
      this.timer = n.timer;
    }
  }

  stop(fade = 1.5) {
    const ctx = this.eng.ctx;
    if (!this.playing || !ctx || this.stopping) return;
    this.stopping = true;
    const t = ctx.currentTime;
    this.endAt = t + fade;
    const g = this.nodes.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + fade);
    this.eng.echoDelay?.delayTime.setTargetAtTime(0.34, t + fade, 0.3);
    const n = this.nodes;
    if (this.eng.offline) return;
    setTimeout(() => {
      if (this.nodes === n) { this.playing = false; this.stopping = false; this.nodes = null; }
      this._kill(n, 0);
    }, (fade + 0.4) * 1000);
  }

  _kill(n, fade) {
    if (n.timer) clearInterval(n.timer);
    n.timer = null;
    if (fade > 0 && this.eng.ctx) {
      const t = this.eng.ctx.currentTime, g = n.out.gain;
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + fade);
      setTimeout(() => this._disc(n), (fade + 2.5) * 1000);
    } else this._disc(n);
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
    while (this.nextT < until) {
      if (e.canPlay()) this._stepAt(this.step, this.nextT);
      this.step++;
      this.nextT += STEP;
    }
  }

  _stepAt(step, t) {
    const n = this.nodes;
    const s = step % BAR;
    const barN = Math.floor(step / BAR);
    const bar = barN % 8;
    const cycle = Math.floor(barN / 8);
    const sec = cycle === 0 ? 'soft' : SECTIONS[1 + ((cycle - 1) % 3)];
    const full = sec === 'full';

    if (s === 0) {
      for (const m of CHORDS[bar]) this._pad(mtof(m), t, BAR * STEP + 0.4, full ? 0.022 : 0.03);
      if (bar === 0) this.eng._squelch(t, 0.05, n.out, 0.03); // radio-net flavour on each loop
    }
    // Bass
    const root = ROOTS[bar];
    if (full) this._bass(mtof(root + BASS_FULL[s]), t, STEP * 0.9, s % 4 === 0 ? 0.14 : 0.1);
    else if (sec === 'soft' && (s === 0 || s === 4)) this._bass(mtof(root), t, STEP * 3.6, 0.11);
    // Melody
    const note = MELODY[bar][s];
    if (note !== null) {
      let len = 1;
      while (s + len < BAR && MELODY[bar][s + len] === null && len < 3) len++;
      const d = len * STEP;
      if (full) {
        this._lead(mtof(note), t, d * 0.95, 0.055);
        this._bell(mtof(note + 12), t, 0.018);
      } else {
        this._bell(mtof(note), t, 0.06);
      }
    }
    // Drums
    if (full) {
      if (s === 0 || s === 4 || (s === 7 && bar % 2 === 1)) this._kick(t, 0.5);
      if (s === 2 || s === 6) this._snare(t, 0.16);
      if (s % 2 === 1) this._hat(t, 0.035);
      else this._hat(t, 0.015);
    } else if (sec === 'break' && s % 2 === 1) {
      this._hat(t, 0.012);
    }
  }

  // ---- instruments ----

  _env(g, t, a, peak, d) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  _pad(f, t, dur, vol) {
    const ctx = this.eng.ctx;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.45);
    g.gain.setValueAtTime(vol, t + dur - 0.5);
    g.gain.linearRampToValueAtTime(0, t + dur);
    lp.connect(g).connect(this.nodes.out);
    for (const det of [-9, 9]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      o.connect(lp); o.start(t); o.stop(t + dur + 0.02);
    }
  }

  _bass(f, t, d, vol) {
    const ctx = this.eng.ctx;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
    const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = f;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 4;
    lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(180, t + Math.min(d, 0.25));
    const g = ctx.createGain();
    this._env(g, t, 0.004, vol, d);
    const sg = ctx.createGain(); sg.gain.value = 0.8;
    o.connect(lp).connect(g); sub.connect(sg).connect(g);
    g.connect(this.nodes.out);
    o.start(t); sub.start(t); o.stop(t + d + 0.03); sub.stop(t + d + 0.03);
  }

  /** Radio lead: square+saw through a band-pass, delayed vibrato, sent to tape echo. */
  _lead(f, t, d, vol) {
    const ctx = this.eng.ctx, n = this.nodes;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.setTargetAtTime(vol * 0.7, t + 0.05, 0.1);
    g.gain.setTargetAtTime(0, t + d, 0.04);
    const vib = ctx.createOscillator(); vib.frequency.value = 5.5;
    const va = ctx.createGain();
    va.gain.setValueAtTime(0, t); va.gain.linearRampToValueAtTime(f * 0.012, t + Math.min(0.3, d));
    vib.connect(va);
    const end = t + d + 0.25;
    for (const [type, det, lvl] of [['square', -6, 0.5], ['sawtooth', 6, 0.5]]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = det;
      va.connect(o.frequency);
      const og = ctx.createGain(); og.gain.value = lvl;
      o.connect(og).connect(bp);
      o.start(t); o.stop(end);
    }
    vib.start(t); vib.stop(end);
    bp.connect(lp).connect(g).connect(n.out);
    const es = ctx.createGain(); es.gain.value = 0.45;
    g.connect(es).connect(n.echo);
  }

  _bell(f, t, vol) {
    const ctx = this.eng.ctx, n = this.nodes;
    const g = ctx.createGain();
    this._env(g, t, 0.004, vol, 1.4);
    for (const [m, a] of [[1, 1], [2.76, 0.16], [5.4, 0.05]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * m;
      const ga = ctx.createGain(); ga.gain.value = a;
      o.connect(ga).connect(g); o.start(t); o.stop(t + 1.45);
    }
    g.connect(n.out);
    const es = ctx.createGain(); es.gain.value = 0.35;
    g.connect(es).connect(n.echo);
  }

  _kick(t, vol) {
    const ctx = this.eng.ctx;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ctx.createGain();
    this._env(g, t, 0.002, vol, 0.28);
    o.connect(g).connect(this.nodes.out);
    o.start(t); o.stop(t + 0.3);
  }

  _snare(t, vol) {
    const ctx = this.eng.ctx, n = this.nodes;
    const s = ctx.createBufferSource(); s.buffer = this.eng.buf.white;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.8;
    const g = ctx.createGain();
    this._env(g, t, 0.001, vol, 0.16);
    s.connect(bp).connect(g).connect(n.out);
    const rs = ctx.createGain(); rs.gain.value = 0.6; g.connect(rs).connect(n.rev);
    s.start(t, this.rand() * 1.5); s.stop(t + 0.2);
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(200, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.06);
    const og = ctx.createGain();
    this._env(og, t, 0.001, vol * 0.8, 0.07);
    o.connect(og).connect(n.out); o.start(t); o.stop(t + 0.1);
  }

  _hat(t, vol) {
    const ctx = this.eng.ctx;
    const s = ctx.createBufferSource(); s.buffer = this.eng.buf.white;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7500;
    const g = ctx.createGain();
    this._env(g, t, 0.001, vol, 0.035);
    s.connect(hp).connect(g).connect(this.nodes.out);
    s.start(t, this.rand() * 1.5); s.stop(t + 0.05);
  }
}
