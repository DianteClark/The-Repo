// Procedural buffers for the Tidefall soundscape. Everything here is generated
// once per AudioContext and then reused by every voice (no per-sound buffers).

// Small deterministic PRNG so the impulse response / noise beds are stable
// between sessions (the "room" always sounds the same).
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** kind: 'white' | 'pink' | 'brown'. Mono, normalised to about ±1. */
export function makeNoise(ctx, kind, seconds, seed = 1) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const r = rng(seed);
  if (kind === 'white') {
    for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
  } else if (kind === 'pink') {
    // Paul Kellet's economy pink filter.
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = r() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    }
  } else {
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (r() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
  }
  normalise(d, 0.95);
  // Short crossfade at the loop point so looping beds don't click.
  const xf = Math.min(512, len >> 3);
  for (let i = 0; i < xf; i++) {
    const k = i / xf;
    d[i] = d[i] * k + d[len - xf + i] * (1 - k);
  }
  return buf;
}

/** Sparse random impulses: debris, static crackle, gear rustle. */
export function makeCrackle(ctx, seconds, density = 0.0025, seed = 7) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const r = rng(seed);
  for (let i = 0; i < len; i++) {
    if (r() < density) {
      const amp = (0.3 + r() * 0.7) * (r() < 0.5 ? -1 : 1);
      const n = 2 + Math.floor(r() * 30); // each grain a tiny decaying burst
      for (let j = 0; j < n && i + j < len; j++) d[i + j] += amp * (1 - j / n) * (r() * 2 - 1);
    }
  }
  normalise(d, 0.95);
  return buf;
}

/**
 * Stereo convolution impulse: a few early reflections (concrete, sheet metal)
 * then an exponentially decaying tail that darkens over time.
 */
export function makeImpulse(ctx, seconds = 2.4, decay = 3.0, seed = 11) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const r = rng(seed + ch * 101);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      // Damping: the one-pole low-pass closes as the tail ages.
      const a = 0.85 - 0.75 * Math.min(1, t / seconds);
      lp += a * ((r() * 2 - 1) - lp);
      const fadeIn = Math.min(1, t / 0.012);
      d[i] = lp * Math.exp(-t * decay) * fadeIn;
    }
    // Early reflections, slightly different per ear for width.
    const taps = [0.011, 0.019, 0.027, 0.041, 0.058, 0.077];
    for (let k = 0; k < taps.length; k++) {
      const i = Math.floor((taps[k] + (ch ? 0.0031 * (k + 1) : 0)) * sr);
      if (i < len) d[i] += (0.55 - k * 0.07) * (r() < 0.5 ? -1 : 1);
    }
  }
  // Normalise both channels together so the reverb return level is predictable.
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  const g = 0.5 / (peak || 1);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] *= g;
  }
  return buf;
}

/** Linear up to `knee`, then a tanh shoulder that never reaches ±ceiling. */
export function softClipCurve(n = 2048, knee = 0.6, ceiling = 0.97) {
  const c = new Float32Array(n);
  const room = ceiling - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const ax = Math.abs(x);
    const y = ax <= knee ? ax : knee + room * Math.tanh((ax - knee) / room);
    c[i] = Math.sign(x) * y;
  }
  return c;
}

/** Gentle saturation for the "radio" bus. */
export function driveCurve(n = 1024, amount = 2.2) {
  const c = new Float32Array(n);
  const norm = Math.tanh(amount);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * amount) / norm;
  }
  return c;
}

function normalise(d, to) {
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0) {
    const g = to / peak;
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
}
