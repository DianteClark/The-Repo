// Weapon voices: one per category, a signature for each legendary, suppressed
// variants, reloads, empty click and swap. Mixed into Sfx.prototype, so `this`
// is the engine (voice allocation, _noise/_osc layers, ducking).

const clamp01 = (x) => { const v = Number(x); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; };
const rnd = (a, b) => a + Math.random() * (b - a);

export const WEAPON_CATS = ['ar', 'smg', 'lmg', 'shotgun', 'dmr', 'sniper', 'carbine', 'pistol', 'mpistol', 'launcher'];
export const LEGENDARIES = ['tidebreaker', 'maw', 'undertow', 'lantern', 'riptide', 'leviathan', 'siren'];
const LEG_FOR_CAT = { sniper: 'tidebreaker', shotgun: 'maw', lmg: 'undertow', dmr: 'lantern', smg: 'riptide', launcher: 'leviathan' };
const LEG_FOR_CAT2 = { carbine: 'siren' };
const CAT_OF_LEG = { tidebreaker: 'sniper', maw: 'shotgun', undertow: 'lmg', lantern: 'dmr', riptide: 'smg', leviathan: 'launcher', siren: 'carbine' };

// The sim's weapon tables (id → {cat, legendary?}), loaded in the background
// so plain ids like 'kestrel' resolve; keyword matching covers the meantime.
let SIM = null, simTried = false;
function loadSim() {
  if (simTried) return;
  simTried = true;
  try {
    import(new URL('../../sim/weapons.js', import.meta.url).href).then((m) => {
      SIM = Object.assign(Object.create(null), m.WEAPONS || {}, m.SECONDARIES || {}, m.LEGENDARIES || {});
    }, () => {});
  } catch { /* no dynamic import: keyword matching only */ }
}
if (typeof window !== 'undefined') loadSim();

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function catFromWord(s) {
  if (!s) return null;
  if (WEAPON_CATS.includes(s)) return s;
  if (s.includes('machinepistol') || s.includes('autopistol') || s === 'mp' || s === 'mpistol') return 'mpistol';
  if (s.includes('pistol') || s.includes('sidearm') || s.includes('handgun') || s.includes('revolver')) return 'pistol';
  if (s.includes('launcher') || s.includes('rocket') || s.includes('rpg') || s.includes('bazooka')) return 'launcher';
  if (s.includes('lmg') || s.includes('lightmachine') || s.includes('machinegun')) return 'lmg';
  if (s.includes('smg') || s.includes('submachine') || s.includes('medic')) return 'smg';
  if (s.includes('shot')) return 'shotgun';
  if (s.includes('dmr') || s.includes('marksman')) return 'dmr';
  if (s.includes('sniper') || s.includes('longrifle') || s.includes('rail')) return 'sniper';
  if (s.includes('carbine') || s.includes('recon')) return 'carbine';
  if (s === 'ar' || s.startsWith('ar') && /^ar\d/.test(s) || s.includes('assault') || s.includes('rifle')) return 'ar';
  return null;
}

function legendFromWord(s) {
  if (!s) return null;
  for (const l of LEGENDARIES) if (s.includes(l)) return l;
  return null;
}

/**
 * Resolve anything the game might pass (category name/id, weapon id or name,
 * a weapon def object) to { cat, legend }.
 */
export function resolveWeapon(w) {
  let cat = null, legend = null;
  if (w && typeof w === 'object') {
    legend = legendFromWord(norm(w.legend)) || legendFromWord(norm(w.id)) || legendFromWord(norm(w.name));
    const byId = catFromWord(norm(w.id));
    const special = Array.isArray(w.special) ? w.special : [];
    cat = byId === 'mpistol' ? 'mpistol'
      : catFromWord(norm(w.cat ?? w.category ?? w.kind)) || byId || catFromWord(norm(w.name));
    if (cat === 'pistol' && special.includes('burst')) cat = 'mpistol';
    if (!legend && (w.legendary === true || w.gold === true)) legend = LEG_FOR_CAT[cat] || LEG_FOR_CAT2[cat] || 'gold';
  } else {
    const s = norm(w ?? 'ar');
    legend = legendFromWord(s);
    if (!legend && SIM) {
      const def = SIM[w] ?? SIM[s] ?? SIM[String(w).toLowerCase()];
      if (def && typeof def === 'object') return resolveWeapon(def);
    }
    cat = catFromWord(s);
    if (!cat && !legend) loadSim();
  }
  if (legend && legend !== 'gold') cat = CAT_OF_LEG[legend];
  return { cat: cat || 'ar', legend };
}

// Per-category voice parameters.
//   crack [f, vol, d]  body [f, f2, vol, d]  thump [f, f2, vol, d, glide]
//   mech [f, vol] tiny square transient   ring [f, vol, d]   tail [vol, d, f] brown
//   burst rounds per call, rate seconds between rounds
const GUN = {
  ar:      { crack: [2600, 0.85, 0.045], body: [1100, 300, 0.6, 0.14], thump: [150, 48, 0.7, 0.13, 0.09], mech: [2900, 0.06], tail: [0.18, 0.35, 600], gain: 0.95, rev: 0.12, echo: 0.1, duck: [0.3, 0.08, 0.35], burst: 3, rate: 0.085 },
  smg:     { crack: [3200, 0.8, 0.03], body: [1500, 600, 0.45, 0.08], thump: [210, 80, 0.45, 0.07, 0.05], mech: [3400, 0.05], tail: [0.1, 0.22, 700], gain: 0.85, rev: 0.1, echo: 0.05, duck: [0.25, 0.06, 0.3], burst: 4, rate: 0.058 },
  lmg:     { crack: [2200, 0.85, 0.05], body: [900, 240, 0.7, 0.17], thump: [118, 40, 0.85, 0.16, 0.1], mech: [2500, 0.07], tail: [0.28, 0.5, 500], gain: 0.85, rev: 0.15, echo: 0.12, duck: [0.4, 0.1, 0.4], burst: 5, rate: 0.1 },
  dmr:     { crack: [2400, 0.9, 0.05], body: [1200, 280, 0.65, 0.2], thump: [130, 40, 0.8, 0.2, 0.12], ring: [2100, 0.05, 0.16], tail: [0.3, 0.6, 550], gain: 0.9, rev: 0.18, echo: 0.3, duck: [0.38, 0.12, 0.4], burst: 1, rate: 0.2 },
  carbine: { crack: [2900, 0.85, 0.04], body: [1300, 350, 0.55, 0.11], thump: [165, 55, 0.6, 0.11, 0.08], ring: [2300, 0.05, 0.06], tail: [0.12, 0.3, 650], gain: 0.95, rev: 0.12, echo: 0.1, duck: [0.3, 0.08, 0.35], burst: 2, rate: 0.12 },
  pistol:  { crack: [3000, 0.75, 0.035], body: [1400, 500, 0.45, 0.08], thump: [190, 70, 0.5, 0.08, 0.06], mech: [3600, 0.05], tail: [0.07, 0.2, 700], gain: 0.85, rev: 0.12, echo: 0.08, duck: [0.22, 0.06, 0.3], burst: 2, rate: 0.17 },
  mpistol: { crack: [3500, 0.7, 0.025], body: [1700, 700, 0.4, 0.06], thump: [230, 90, 0.4, 0.06, 0.04], mech: [3900, 0.05], tail: [0.07, 0.18, 750], gain: 0.8, rev: 0.1, echo: 0.04, duck: [0.22, 0.06, 0.3], burst: 4, rate: 0.048 },
};

export const WeaponSfx = {
  /**
   * far: 0 = next to you … 1 = distant/unseen.
   * weapon: category ('AR','SMG','LMG','Shotgun','DMR','Sniper','Carbine','Pistol',
   *   'Machine Pistol','Launcher'), a legacy kind ('rifle','longrifle'), a legendary
   *   ('Tidebreaker','Maw','Undertow','Lantern','Riptide','Leviathan'), a weapon id,
   *   or a weapon def object {id, cat, legendary}.
   * opts: { suppressed, legendary, burst }  (burst overrides rounds per call)
   */
  shot(far = 0, weapon = 'ar', opts = {}) {
    this._safe(() => {
      const o = opts && typeof opts === 'object' ? opts : {};
      let { cat, legend } = resolveWeapon(weapon);
      if (!legend && o.legendary) legend = LEG_FOR_CAT[cat] || LEG_FOR_CAT2[cat] || 'gold';
      const fr = clamp01(far);
      const wSup = weapon && typeof weapon === 'object' && (weapon.suppressed || weapon.silent);
      const sup = !!(o.suppressed || wSup) && cat !== 'launcher' && !legend;
      const burst = Number.isFinite(Number(o.burst)) && o.burst !== null && o.burst !== ''
        ? Math.max(1, Math.min(8, Math.round(Number(o.burst)))) : null;
      if (cat === 'launcher') return this._launcher(fr, legend === 'leviathan');
      if (cat === 'shotgun') return this._shotgun(fr, sup, legend);
      if (cat === 'sniper') return this._sniper(fr, sup, legend);
      this._auto(cat, fr, sup, legend, burst);
    });
  },

  _auto(cat, fr, sup, legend, burstOverride) {
    const P = GUN[cat] || GUN.ar;
    const n = burstOverride ?? (legend === 'riptide' ? 5 : P.burst);
    const span = (n - 1) * P.rate;
    const tailD = P.tail ? P.tail[1] : 0.2;
    const v = this._voice({ cat: 'shot', dur: span + 0.3 + tailD, far: fr, gain: P.gain * (sup ? 0.75 : 1),
      rev: sup ? 0.05 : P.rev, echo: sup ? 0 : P.echo });
    if (!v) return;
    for (let i = 0; i < n; i++) {
      const at = i * P.rate * rnd(0.97, 1.03);
      const p = rnd(0.95, 1.05);
      const acc = i === 0 ? 1 : rnd(0.8, 0.92);
      if (sup) this._suppressedRound(v, at, P, p, acc);
      else this._round(v, at, P, p, acc);
      if (legend === 'undertow') {
        this._osc(v, { at: at + 0.01, f: 320 * p, f2: 70, a: 0.002, d: 0.14, glide: 0.1, vol: 0.18 });
      }
    }
    if (P.tail && !sup) this._noise(v, { buf: 'brown', at: span + 0.01, a: 0.02, d: P.tail[1], vol: P.tail[0], type: 'lowpass', f: P.tail[2], f2: 140 });
    if (legend === 'undertow') {
      // Drag of the current: watery low wobble after the burst.
      this._noise(v, { buf: 'pink', at: span + 0.03, a: 0.06, d: 0.6, vol: 0.22, type: 'bandpass', f: 700, f2: 180, q: 3 });
      this._osc(v, { at: span + 0.02, f: 90, f2: 45, a: 0.05, d: 0.6, vol: 0.3 });
    }
    if (legend === 'lantern') {
      this._noise(v, { at: 0.02, a: 0.03, d: 0.9, vol: 0.14, type: 'highpass', f: 6000 }); // flare sizzle
      this._noise(v, { at: 0.01, a: 0.005, d: 0.2, vol: 0.25, type: 'bandpass', f: 800, f2: 2400, q: 2 }); // ignition fwump
      this._osc(v, { at: 0.03, f: 1568, a: 0.003, d: 1.0, vol: 0.06 });
      this._osc(v, { at: 0.03, f: 2349, a: 0.003, d: 0.8, vol: 0.035, det: 6 });
    }
    if (legend === 'siren') {
      // Tracer rounds: a rising siren whistle chasing each burst.
      this._osc(v, { type: 'triangle', at: 0.02, f: 900, f2: 1900, a: 0.03, d: 0.35, glide: 0.3, vol: 0.05 });
      this._osc(v, { at: 0.06, f: 1350, f2: 2700, a: 0.03, d: 0.3, glide: 0.28, vol: 0.025 });
    }
    if (legend === 'riptide') {
      this._noise(v, { at: 0.02, a: 0.12, d: 0.35, vol: 0.28, type: 'bandpass', f: 400, f2: 3200, q: 4, pan: -0.7, panTo: 0.7 });
      this._osc(v, { type: 'triangle', at: 0.02, f: 600, f2: 1900, a: 0.08, d: 0.3, vol: 0.04 });
    }
    if (legend) this._gold(v, 0.02);
    const [dd, dh, dr] = P.duck;
    this._duck(sup ? dd * 0.4 : dd, dh + span, dr);
  },

  /** One supersonic round: crack, body, thump, action. */
  _round(v, at, P, p, acc) {
    const [cf, cv, cd] = P.crack, [bf, bf2, bv, bd] = P.body, [tf, tf2, tv, td, tg] = P.thump;
    this._noise(v, { at, a: 0.0004, d: cd, vol: cv * acc, type: 'highpass', f: cf * p, q: 0.9 });
    this._noise(v, { at, a: 0.001, d: bd, vol: bv * acc, type: 'lowpass', f: bf * p, f2: bf2, q: 1 });
    this._osc(v, { at, f: tf * p, f2: tf2, a: 0.001, d: td, glide: tg, vol: tv * acc });
    if (P.mech) this._osc(v, { type: 'square', at, f: P.mech[0] * p, a: 0.0003, d: 0.006, vol: P.mech[1] });
    if (P.ring) this._osc(v, { type: 'triangle', at, f: P.ring[0] * p, a: 0.0005, d: P.ring[2], vol: P.ring[1] });
  },

  /** Suppressed round: a "pfft", a soft thump and the action cycling. */
  _suppressedRound(v, at, P, p, acc) {
    this._noise(v, { at, a: 0.001, d: 0.05, vol: 0.55 * acc, type: 'bandpass', f: 1300 * p, q: 1.1 });
    this._noise(v, { at, a: 0.0005, d: 0.015, vol: 0.12, type: 'highpass', f: 5200 });
    this._osc(v, { at, f: P.thump[0] * 0.8 * p, f2: P.thump[1], a: 0.002, d: P.thump[3] * 0.8, vol: P.thump[2] * 0.35 });
    this._click(v, at + 0.018, 3000 * p, 0.16);
    this._click(v, at + 0.04, 2200 * p, 0.1);
  },

  /** Gold shimmer shared by every legendary. */
  _gold(v, at) {
    this._osc(v, { at, f: 2637, a: 0.01, d: 0.6, vol: 0.035, det: 7 });
    this._osc(v, { at: at + 0.03, f: 3951, a: 0.02, d: 0.5, vol: 0.022, det: -6 });
    this._noise(v, { at, a: 0.02, d: 0.4, vol: 0.04, type: 'highpass', f: 8000 });
  },

  _sniper(fr, sup, legend) {
    const p = rnd(0.94, 1.06);
    const rail = legend === 'tidebreaker';
    const v = this._voice({ cat: 'shot', dur: 1.5, far: fr, gain: sup ? 0.65 : 0.85, rev: sup ? 0.08 : 0.22, echo: sup ? 0.05 : 0.42 });
    if (!v) return;
    if (sup) {
      // Still supersonic: a thinner crack, the "pfft", and the bolt.
      this._noise(v, { a: 0.0005, d: 0.03, vol: 0.4, type: 'highpass', f: 3500 * p, q: 0.8 });
      this._noise(v, { a: 0.001, d: 0.07, vol: 0.55, type: 'bandpass', f: 1100 * p, q: 1.1 });
      this._osc(v, { f: 90 * p, f2: 34, a: 0.002, d: 0.18, vol: 0.35 });
    } else {
      this._noise(v, { a: 0.0005, d: 0.05, vol: 0.9, type: 'highpass', f: 2200 * p, q: 0.8 });
      this._noise(v, { a: 0.0008, d: 0.09, vol: 0.6, type: 'bandpass', f: 3000 * p, q: 1.6 });
      this._noise(v, { a: 0.002, d: 0.38, vol: 0.7, type: 'lowpass', f: 1400 * p, f2: 260, q: 0.9 });
      this._osc(v, { f: 110 * p, f2: 34, a: 0.001, d: 0.32, glide: 0.2, vol: 0.85 });
      this._noise(v, { buf: 'brown', at: 0.02, a: 0.03, d: 0.8, vol: 0.35, type: 'lowpass', f: 500, f2: 120 });
    }
    if (rail) {
      // Railgun: FM zap, a ringing coil, ozone hiss, then the capacitor recharging.
      this._osc(v, { type: 'square', f: 4200, f2: 180, a: 0.001, d: 0.25, glide: 0.22, vol: 0.07 });
      this._osc(v, { f: 1800, f2: 1500, a: 0.002, d: 0.7, vol: 0.08, det: 9 });
      this._osc(v, { f: 2710, f2: 2300, a: 0.002, d: 0.5, vol: 0.05, det: -9 });
      this._noise(v, { a: 0.003, d: 0.32, vol: 0.28, type: 'bandpass', f: 8000, f2: 1500, q: 1.6, pan: -0.5, panTo: 0.5 });
      this._osc(v, { type: 'sawtooth', at: 0.45, f: 300, f2: 2400, a: 0.4, d: 0.35, glide: 0.75, vol: 0.025 });
      this._click(v, 1.2, 3000, 0.12);
      this._gold(v, 0.02);
    } else {
      // Bolt cycle.
      this._click(v, 0.62, 2400, 0.12);
      this._click(v, 0.78, 1800, 0.14);
    }
    this._duck(sup ? 0.2 : 0.45, 0.2, 0.5);
  },

  _shotgun(fr, sup, legend) {
    const p = rnd(0.94, 1.06);
    const maw = legend === 'maw';
    const v = this._voice({ cat: 'shot', dur: 1.1, far: fr, gain: sup ? 0.65 : maw ? 0.8 : 0.9, rev: sup ? 0.06 : 0.16 });
    if (!v) return;
    if (sup) {
      this._noise(v, { a: 0.001, d: 0.09, vol: 0.6, type: 'bandpass', f: 900 * p, q: 0.9 });
      this._osc(v, { f: 80 * p, f2: 32, a: 0.002, d: 0.2, vol: 0.5 });
    } else {
      // Two detuned layers panned wide and offset a few ms for width.
      this._noise(v, { a: 0.001, d: 0.24, vol: 0.75, type: 'lowpass', f: 2600 * p, f2: 300, q: 0.6, pan: -0.45 });
      this._noise(v, { at: 0.006, a: 0.001, d: 0.26, vol: 0.75, type: 'lowpass', f: 2300 * p, f2: 280, q: 0.6, pan: 0.45, rate: 0.9 });
      this._noise(v, { a: 0.0005, d: 0.035, vol: 0.5, type: 'highpass', f: 1600 });
      this._osc(v, { f: 85 * p, f2: 30, a: 0.002, d: 0.32, glide: 0.25, vol: 1.0 });
      this._noise(v, { buf: 'brown', a: 0.004, d: 0.45, vol: 0.5, type: 'lowpass', f: 380 });
    }
    if (maw) {
      // The Maw growls: detuned low saws and shredding metal.
      this._osc(v, { type: 'sawtooth', f: 58, f2: 34, a: 0.004, d: 0.5, vol: 0.14 });
      this._osc(v, { type: 'sawtooth', f: 61, f2: 36, a: 0.004, d: 0.45, vol: 0.12 });
      this._noise(v, { buf: 'crackle', at: 0.02, a: 0.01, d: 0.45, vol: 0.45, type: 'bandpass', f: 2600, f2: 1100, q: 0.9 });
      this._gold(v, 0.03);
    }
    // Pump: ka-chunk.
    this._noise(v, { at: 0.5, a: 0.001, d: 0.03, vol: maw ? 0.26 : 0.18, type: 'bandpass', f: 1500, q: 3 });
    this._noise(v, { at: 0.62, a: 0.001, d: 0.045, vol: maw ? 0.3 : 0.22, type: 'bandpass', f: 850, q: 3 });
    this._duck(sup ? 0.2 : 0.45, 0.15, 0.45);
  },

  _launcher(fr, leviathan) {
    const v = this._voice({ cat: 'shot', dur: leviathan ? 1.8 : 1.4, far: fr, gain: 0.8, rev: 0.22, echo: 0.2 });
    if (!v) return;
    // Ignition pop + back-blast.
    this._noise(v, { a: 0.0005, d: 0.03, vol: 0.7, type: 'highpass', f: 1500 });
    this._osc(v, { f: 92, f2: 40, a: 0.002, d: 0.25, vol: 0.8 });
    this._noise(v, { buf: 'brown', a: 0.003, d: 0.5, vol: 0.6, type: 'lowpass', f: 900, f2: 200 });
    // Rocket motor whooshing away.
    this._noise(v, { at: 0.02, a: 0.03, d: 0.95, vol: 0.45, type: 'bandpass', f: 1200, f2: 3400, q: 1, sweep: 0.6, pan: 0, panTo: 0.6 });
    this._noise(v, { at: 0.03, a: 0.05, d: 1.0, vol: 0.14, type: 'highpass', f: 3000, pan: 0.1, panTo: 0.7 });
    this._osc(v, { type: 'sawtooth', at: 0.03, f: 160, f2: 110, a: 0.05, d: 0.8, vol: 0.04 });
    if (leviathan) {
      // A deep roar and a whale-like moan.
      this._osc(v, { type: 'sawtooth', f: 70, f2: 44, a: 0.02, d: 1.0, vol: 0.12 });
      this._osc(v, { f: 220, f2: 140, a: 0.1, d: 1.2, glide: 1.1, vol: 0.09 });
      this._osc(v, { f: 330, f2: 205, a: 0.15, d: 1.1, glide: 1.0, vol: 0.04 });
      this._gold(v, 0.03);
    }
    this._duck(0.5, 0.3, 0.5);
  },

  // -------------------------------------------------------- handling

  /** Reload for a category (or weapon id/name/def). */
  reload(weapon = 'ar') {
    this._safe(() => {
      const { cat } = resolveWeapon(weapon);
      const v = this._voice({ cat: 'misc', dur: 1.4, gain: 0.9, rev: 0.08 });
      if (!v) return;
      const p = rnd(0.95, 1.05);
      const magOut = (at) => { this._click(v, at, 1800 * p, 0.3); this._slide(v, at + 0.01, 0.08, 1300, 0.12); };
      const magIn = (at) => { this._slide(v, at - 0.07, 0.07, 1100, 0.1); this._click(v, at, 1400 * p, 0.45); this._thud(v, at, 170, 0.35); };
      const charge = (at) => { this._slide(v, at, 0.07, 1700, 0.16); this._click(v, at + 0.08, 2600 * p, 0.35); this._metal(v, at + 0.08, 1900, 0.05); };
      switch (cat) {
        case 'pistol':
          magOut(0); magIn(0.36); this._click(v, 0.6, 2800, 0.35); this._metal(v, 0.6, 2100, 0.05); break;
        case 'smg': case 'mpistol':
          magOut(0); magIn(0.32); charge(0.55); break;
        case 'lmg':
          this._click(v, 0, 1500, 0.35); this._metal(v, 0.01, 900, 0.06);
          this._noise(v, { buf: 'crackle', at: 0.18, a: 0.05, d: 0.4, vol: 0.3, type: 'bandpass', f: 3000, q: 0.9 });
          this._thud(v, 0.78, 150, 0.45); this._click(v, 0.78, 1200, 0.5); charge(1.0); break;
        case 'shotgun':
          for (const at of [0, 0.22, 0.44, 0.66]) { this._slide(v, at, 0.05, 2000, 0.1); this._click(v, at + 0.05, 2400 * rnd(0.95, 1.05), 0.3); }
          this._noise(v, { at: 0.95, a: 0.001, d: 0.03, vol: 0.2, type: 'bandpass', f: 1500, q: 3 });
          this._noise(v, { at: 1.07, a: 0.001, d: 0.045, vol: 0.24, type: 'bandpass', f: 850, q: 3 });
          break;
        case 'sniper':
          this._click(v, 0, 2600, 0.3); this._slide(v, 0.08, 0.09, 1500, 0.15);
          magOut(0.3); magIn(0.62);
          this._slide(v, 0.85, 0.08, 1900, 0.15); this._click(v, 0.95, 2200, 0.35); this._metal(v, 0.95, 1700, 0.05); break;
        case 'launcher':
          this._slide(v, 0, 0.35, 600, 0.2);
          this._thud(v, 0.42, 120, 0.55); this._click(v, 0.42, 1100, 0.5);
          this._osc(v, { at: 0.7, f: 2200, a: 0.002, d: 0.05, vol: 0.06 });
          this._osc(v, { at: 0.8, f: 2900, a: 0.002, d: 0.07, vol: 0.06 }); break;
        default: // ar, carbine, dmr
          magOut(0);
          this._noise(v, { buf: 'crackle', at: 0.1, a: 0.01, d: 0.12, vol: 0.18, type: 'bandpass', f: 2800 });
          magIn(0.45); this._click(v, 0.56, 1900, 0.2);
          charge(cat === 'dmr' ? 0.85 : 0.78);
      }
    });
  },

  /** Dry fire on an empty magazine. */
  emptyClick() {
    this._safe(() => {
      const v = this._voice({ cat: 'ui', dur: 0.2, gain: 0.9, rev: 0.04 });
      if (!v) return;
      this._click(v, 0, 2600, 0.45);
      this._metal(v, 0.002, 3200, 0.03);
      this._noise(v, { at: 0.01, a: 0.002, d: 0.05, vol: 0.05, type: 'bandpass', f: 5000, q: 4 });
    });
  },

  /** Swap primary/secondary: sling rustle and a grip clack. */
  swap() {
    this._safe(() => {
      const v = this._voice({ cat: 'misc', dur: 0.5, gain: 0.85, rev: 0.05 });
      if (!v) return;
      this._noise(v, { buf: 'pink', a: 0.01, d: 0.07, vol: 0.2, type: 'bandpass', f: 1600, q: 1.2, pan: -0.2 });
      this._noise(v, { buf: 'pink', at: 0.07, a: 0.01, d: 0.06, vol: 0.18, type: 'bandpass', f: 2100, q: 1.2, pan: 0.2 });
      this._noise(v, { buf: 'crackle', at: 0.02, a: 0.01, d: 0.14, vol: 0.12, type: 'highpass', f: 3000 });
      this._click(v, 0.16, 1600, 0.35);
      this._thud(v, 0.16, 140, 0.3);
      this._metal(v, 0.17, 2500, 0.03);
    });
  },

  // -------------------------------------------------------- primitives

  /** Metal sliding on metal. */
  _slide(v, at, d, f, vol) {
    this._noise(v, { at, a: d * 0.3, d: d * 0.7, vol, type: 'bandpass', f, f2: f * 1.6, q: 2.2 });
  },

  _thud(v, at, f, vol) {
    this._osc(v, { at, f, f2: f * 0.5, a: 0.001, d: 0.06, vol });
  },

  /** Small inharmonic metal ring. */
  _metal(v, at, f, vol) {
    this._osc(v, { at, f, a: 0.0008, d: 0.12, vol });
    this._osc(v, { at, f: f * 2.32, a: 0.0008, d: 0.07, vol: vol * 0.6 });
    this._osc(v, { at, f: f * 3.91, a: 0.0008, d: 0.04, vol: vol * 0.35 });
  },
};
