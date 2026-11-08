// Shared synth instruments for the scheduled music loops (menu theme, hub bed,
// Pit theme). Every function builds short-lived nodes that stop themselves, so
// nothing here needs explicit cleanup. `I` is { ctx, buf, rand } and `dest` is
// the node to feed.

export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function env(g, t, a, peak, d) {
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + Math.max(0.0005, a));
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}

/** Two detuned saws through a low-pass, slow attack/release. */
export function pad(I, dest, f, t, dur, vol, { cut = 900, cut2 = null, att = 0.45, rel = 0.5, det = 9, type = 'sawtooth', q = 0.7 } = {}) {
  const ctx = I.ctx;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = q;
  lp.frequency.setValueAtTime(cut, t);
  if (cut2) lp.frequency.exponentialRampToValueAtTime(cut2, t + dur * 0.7);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + Math.min(att, dur * 0.4));
  g.gain.setValueAtTime(vol, t + Math.max(dur - rel, dur * 0.5));
  g.gain.linearRampToValueAtTime(0, t + dur);
  lp.connect(g).connect(dest);
  for (const d of det ? [-det, det] : [0]) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = d;
    o.connect(lp); o.start(t); o.stop(t + dur + 0.02);
  }
  return g;
}

/** Brass-like stab/swell: 3 saws, filter envelope opening on the attack. */
export function brass(I, dest, f, t, dur, vol, { open = 2600, base = 500 } = {}) {
  const ctx = I.ctx;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.4;
  lp.frequency.setValueAtTime(base, t);
  lp.frequency.exponentialRampToValueAtTime(open, t + 0.09);
  lp.frequency.setTargetAtTime(base * 1.6, t + 0.12, dur * 0.4);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.05);
  g.gain.setTargetAtTime(vol * 0.7, t + 0.08, 0.2);
  g.gain.setValueAtTime(vol * 0.7, t + Math.max(0.1, dur - 0.15));
  g.gain.linearRampToValueAtTime(0, t + dur);
  lp.connect(g).connect(dest);
  for (const d of [-11, 0, 12]) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = d;
    o.connect(lp); o.start(t); o.stop(t + dur + 0.02);
  }
  return g;
}

export function bass(I, dest, f, t, d, vol, { cut = 900, q = 4 } = {}) {
  const ctx = I.ctx;
  const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
  const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = f;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = q;
  lp.frequency.setValueAtTime(cut, t); lp.frequency.exponentialRampToValueAtTime(180, t + Math.min(d, 0.25));
  const g = ctx.createGain();
  env(g, t, 0.004, vol, d);
  const sg = ctx.createGain(); sg.gain.value = 0.8;
  o.connect(lp).connect(g); sub.connect(sg).connect(g);
  g.connect(dest);
  o.start(t); sub.start(t); o.stop(t + d + 0.03); sub.stop(t + d + 0.03);
}

/** Radio lead: square+saw through a band-pass, delayed vibrato; optional echo send. */
export function lead(I, dest, f, t, d, vol, echo = null, { bp = 1500, oct = false } = {}) {
  const ctx = I.ctx;
  const bpf = ctx.createBiquadFilter(); bpf.type = 'bandpass'; bpf.frequency.value = bp; bpf.Q.value = 0.7;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3400;
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
  const layers = [['square', -6, 0.5, 1], ['sawtooth', 6, 0.5, 1]];
  if (oct) layers.push(['sawtooth', 0, 0.3, 0.5]);
  for (const [type, det, lvl, mul] of layers) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = f * mul; o.detune.value = det;
    va.connect(o.frequency);
    const og = ctx.createGain(); og.gain.value = lvl;
    o.connect(og).connect(bpf);
    o.start(t); o.stop(end);
  }
  vib.start(t); vib.stop(end);
  bpf.connect(lp).connect(g).connect(dest);
  if (echo) { const es = ctx.createGain(); es.gain.value = 0.45; g.connect(es).connect(echo); }
}

export function bell(I, dest, f, t, vol, echo = null, dur = 1.4) {
  const ctx = I.ctx;
  const g = ctx.createGain();
  env(g, t, 0.004, vol, dur);
  for (const [m, a] of [[1, 1], [2.76, 0.16], [5.4, 0.05]]) {
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * m;
    const ga = ctx.createGain(); ga.gain.value = a;
    o.connect(ga).connect(g); o.start(t); o.stop(t + dur + 0.05);
  }
  g.connect(dest);
  if (echo) { const es = ctx.createGain(); es.gain.value = 0.35; g.connect(es).connect(echo); }
}

/** Plucked saw arp note. */
export function pluck(I, dest, f, t, vol, cutoff = 2200, d = 0.17) {
  const ctx = I.ctx;
  const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 6;
  lp.frequency.setValueAtTime(cutoff, t);
  lp.frequency.exponentialRampToValueAtTime(140, t + d);
  const g = ctx.createGain();
  env(g, t, 0.003, vol, d);
  o.connect(lp).connect(g).connect(dest);
  o.start(t); o.stop(t + d + 0.03);
}

export function kick(I, dest, t, vol, f0 = 110, f1 = 42, d = 0.28) {
  const ctx = I.ctx;
  const o = ctx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + 0.12);
  const g = ctx.createGain();
  env(g, t, 0.002, vol, d);
  o.connect(g).connect(dest);
  o.start(t); o.stop(t + d + 0.02);
}

function noiseHit(I, dest, t, vol, d, type, f, q = 0.8, buf = 'white', f2 = null) {
  const ctx = I.ctx;
  const s = ctx.createBufferSource(); s.buffer = I.buf[buf];
  const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f, t); fl.Q.value = q;
  if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + d);
  const g = ctx.createGain();
  env(g, t, 0.001, vol, d);
  s.connect(fl).connect(g).connect(dest);
  s.start(t, I.rand() * 1.2); s.stop(t + d + 0.03);
  return g;
}

export function snare(I, dest, t, vol, rev = null) {
  const g = noiseHit(I, dest, t, vol, 0.17, 'bandpass', 1900);
  if (rev) { const rs = I.ctx.createGain(); rs.gain.value = 0.6; g.connect(rs).connect(rev); }
  const ctx = I.ctx;
  const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(200, t);
  o.frequency.exponentialRampToValueAtTime(150, t + 0.06);
  const og = ctx.createGain();
  env(og, t, 0.001, vol * 0.8, 0.07);
  o.connect(og).connect(dest); o.start(t); o.stop(t + 0.1);
}

export function hat(I, dest, t, vol, d = 0.035) { noiseHit(I, dest, t, vol, d, 'highpass', 7500); }

export function clap(I, dest, t, vol, rev = null) {
  for (const dt of [0, 0.011, 0.022]) noiseHit(I, dest, t + dt, vol * (dt ? 0.7 : 1), dt === 0.022 ? 0.12 : 0.02, 'bandpass', 1300, 1.2);
  if (rev) { const g = noiseHit(I, rev, t + 0.022, vol * 0.6, 0.2, 'bandpass', 1300, 1.2); void g; }
}

/** Big low drum (taiko/tom). */
export function tom(I, dest, t, vol, f = 90, d = 0.5) {
  const ctx = I.ctx;
  const o = ctx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(f * 1.6, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
  o.frequency.exponentialRampToValueAtTime(f * 0.8, t + d);
  const g = ctx.createGain();
  env(g, t, 0.003, vol, d);
  o.connect(g).connect(dest); o.start(t); o.stop(t + d + 0.02);
  noiseHit(I, dest, t, vol * 0.35, 0.08, 'lowpass', 1200, 0.7, 'pink');
}

export function crash(I, dest, t, vol, d = 1.8) {
  noiseHit(I, dest, t, vol, d, 'highpass', 5200, 0.5);
  noiseHit(I, dest, t, vol * 0.5, d * 0.6, 'bandpass', 3200, 0.6);
}

/** Noise riser sweeping up over `d` seconds (ends at t + d). */
export function riser(I, dest, t, d, vol) {
  const ctx = I.ctx;
  const s = ctx.createBufferSource(); s.buffer = I.buf.white; s.loop = true;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2.5;
  f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(6000, t + d);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + d);
  g.gain.linearRampToValueAtTime(0, t + d + 0.03);
  s.connect(f).connect(g).connect(dest); s.start(t); s.stop(t + d + 0.05);
}

/** Tremolo strings: saws through a band-limit with fast amplitude flutter. */
export function tremolo(I, dest, f, t, dur, vol, rate = 11) {
  const ctx = I.ctx;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 180;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.3);
  g.gain.setValueAtTime(vol, t + dur - 0.3); g.gain.linearRampToValueAtTime(0, t + dur);
  const tr = ctx.createGain(); tr.gain.value = 0.6;
  const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = rate;
  const la = ctx.createGain(); la.gain.value = 0.4;
  lfo.connect(la).connect(tr.gain);
  lp.connect(hp).connect(tr).connect(g).connect(dest);
  for (const d of [-7, 7]) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = d;
    o.connect(lp); o.start(t); o.stop(t + dur + 0.02);
  }
  lfo.start(t); lfo.stop(t + dur + 0.02);
}
