// Tiny synthesized SFX (no audio files yet). Browsers only allow audio after
// a user gesture, so resume() is called from the Deploy button.

export class Sfx {
  constructor() { this.ctx = null; this.muted = false; }

  resume() {
    try {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
        const len = this.ctx.sampleRate;
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      this.ctx.resume();
    } catch { this.ctx = null; }
  }

  toggle() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  _ok() { return this.ctx && !this.muted && this.ctx.state === 'running'; }

  tone(freq, dur, { type = 'sine', vol = 0.2, slide = null, delay = 0 } = {}) {
    if (!this._ok()) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  noise(dur, { vol = 0.3, freq = 3000, q = 0.7, delay = 0 } = {}) {
    if (!this._ok()) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  // far: 0 = right next to you, 1 = distant/unseen (muffled)
  shot(far = 0) {
    this.noise(0.18 + far * 0.25, { vol: 0.5 * (1 - far * 0.6), freq: 4200 - far * 3700 });
    this.tone(120 - far * 40, 0.12, { type: 'square', vol: 0.12 * (1 - far * 0.7), slide: 50 });
  }
  hit(graze) { this.tone(graze ? 300 : 200, 0.08, { type: 'triangle', vol: 0.18, slide: 90 }); }
  miss() { this.tone(1800, 0.12, { type: 'sine', vol: 0.05, slide: 900 }); }
  step() { this.noise(0.04, { vol: 0.05, freq: 900 }); }
  pickup() { this.tone(660, 0.08, { vol: 0.12 }); this.tone(990, 0.12, { vol: 0.12, delay: 0.07 }); }
  tripwire() { this.tone(2400, 0.09, { type: 'square', vol: 0.08 }); this.tone(1800, 0.14, { type: 'square', vol: 0.08, delay: 0.09 }); }
  death() { this.noise(0.5, { vol: 0.25, freq: 2500, q: 4 }); this.tone(400, 0.4, { type: 'sawtooth', vol: 0.05, slide: 60 }); }
  tide() { this.noise(1.6, { vol: 0.35, freq: 250 }); this.tone(55, 1.4, { type: 'sine', vol: 0.25, slide: 80 }); }
  turn() { this.noise(0.12, { vol: 0.15, freq: 5000, q: 6 }); this.tone(520, 0.12, { vol: 0.12, delay: 0.1 }); this.tone(780, 0.18, { vol: 0.12, delay: 0.2 }); }
  tick(urgent) { this.tone(urgent ? 1200 : 800, 0.03, { type: 'square', vol: urgent ? 0.07 : 0.03 }); }
}
