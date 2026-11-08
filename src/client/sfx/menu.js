// Tidefall title theme v2: "Signal Fire". D minor, 96 BPM, radio-lead anthem.
//
// Two 8-bar halves:
//   verse  i–VI–III–VII | i–VI–III–V   (Dm Bb F C | Dm Bb F A) — the "A–D–E–F" hook
//   chorus VI–III–VII–i | VI–III–V–i   (Bb F C Dm | Bb F A Dm) — dotted anthem line
// Form: intro → verse → chorus → break → chorus → (verse → chorus → break → chorus)…
// The intro is a sub swell under bells and a ticking clock; each chorus lands on
// a taiko hit + crash with brass swells, octave lead and a 16th arp; the break
// strips back to bells and pad and ends in a riser and snare roll.

import { Looper } from './looper.js';
import { mtof, pad, brass, bass, lead, bell, pluck, kick, snare, hat, clap, tom, crash, riser } from './inst.js';

const BPM = 96;
const STEP = 60 / BPM / 2; // one 8th note
const BAR = 8;
const _ = null;

const VERSE_MEL = [
  [69, 74, 76, 77, _, 76, 74, _],   // Dm: A D E F . E D .   (the hook)
  [70, _, 74, _, 77, 76, 74, _],    // Bb
  [72, 77, 79, 81, _, 79, 77, _],   // F
  [79, _, 76, _, 72, _, _, _],      // C
  [69, 74, 76, 77, _, 76, 74, _],   // Dm (hook again)
  [70, _, 74, _, 77, 79, 81, _],    // Bb: rising answer
  [81, _, 79, 77, 76, _, 77, _],    // F
  [76, _, 73, _, 69, _, _, _],      // A: pulls back to Dm
];
const VERSE_CH = [[50, 53, 57], [46, 50, 53], [53, 57, 60], [48, 52, 55], [50, 53, 57], [46, 50, 53], [53, 57, 60], [45, 49, 52]];
const VERSE_ROOT = [38, 34, 41, 36, 38, 34, 41, 33];

const CHORUS_MEL = [
  [74, _, _, 77, _, 76, 74, _],     // Bb: D . . F . E D .
  [72, _, _, 77, _, _, 81, _],      // F:  C . . F . . A .
  [79, _, _, 76, _, 74, 72, _],     // C:  G . . E . D C .
  [74, _, _, _, 69, _, 74, _],      // Dm: D . . . A . D .
  [74, _, _, 77, _, 76, 74, _],     // Bb
  [72, _, _, 77, _, _, 84, _],      // F:  … up to the high C
  [81, _, _, 79, _, 76, 73, _],     // A:  A . . G . E C# .
  [74, _, _, _, _, _, _, _],        // Dm: home
];
const CHORUS_CH = [[46, 50, 53], [45, 48, 53], [48, 52, 55], [50, 53, 57], [46, 50, 53], [45, 48, 53], [45, 49, 52], [50, 53, 57]];
const CHORUS_ROOT = [34, 41, 36, 38, 34, 41, 33, 38];
const ARP_PAT = [0, 2, 1, 2, 0, 2, 1, 2];

const FORM_LOOP = ['verse', 'chorus', 'break', 'chorus'];

export class MenuTheme extends Looper {
  constructor(eng) {
    super(eng, { level: 2.3, fadeIn: 1.5, rev: 0.3 });
    this.STEP = STEP;
  }

  _onStart(t) {
    // Sync the shared tape echo to a dotted 8th while the theme plays.
    this.eng.echoDelay?.delayTime.setTargetAtTime(STEP * 1.5, t, 0.3);
  }

  _onStop(t, fade) {
    this.eng.echoDelay?.delayTime.setTargetAtTime(0.34, t + fade, 0.3);
  }

  section(barN) {
    const sec = Math.floor(barN / 8);
    return sec === 0 ? 'intro' : FORM_LOOP[(sec - 1) % FORM_LOOP.length];
  }

  _stepAt(step, t) {
    const n = this.nodes, I = this.I, out = n.out;
    const s = step % BAR;
    const barN = Math.floor(step / BAR);
    const bar = barN % 8;
    const sec = this.section(barN);
    const chorus = sec === 'chorus';
    const mel = chorus ? CHORUS_MEL : VERSE_MEL;
    const chords = chorus ? CHORUS_CH : VERSE_CH;
    const roots = chorus ? CHORUS_ROOT : VERSE_ROOT;
    const barLen = BAR * STEP;
    const nextSec = this.section(barN + 1);

    // ---- harmony ----
    if (s === 0) {
      const ch = chords[bar];
      if (sec === 'intro') {
        for (const m of ch) pad(I, out, mtof(m), t, barLen + 0.4, 0.016, { cut: 500 + bar * 90 });
        if (bar === 0) this._swell(t, mtof(26), barLen * 4);
        if (bar === 4) this._swell(t, mtof(26), barLen * 4);
        if (bar === 0) this.eng._squelch(t, 0.06, out, 0.03);
      } else if (chorus) {
        for (const m of ch) brass(I, out, mtof(m), t, barLen * 0.98, 0.016);
        for (const m of ch) pad(I, out, mtof(m + 12), t, barLen + 0.3, 0.008, { cut: 2400 });
        if (bar === 0) { crash(I, out, t, 0.08); tom(I, out, t, 0.5, 55, 1.0); }
        if (bar === 4) crash(I, out, t, 0.05);
      } else if (sec === 'break') {
        for (const m of ch) pad(I, out, mtof(m), t, barLen + 0.4, 0.024, { cut: 700 });
      } else {
        for (const m of ch) pad(I, out, mtof(m), t, barLen + 0.4, 0.02, { cut: 1000 });
        if (bar === 0) this.eng._squelch(t, 0.05, out, 0.03);
      }
    }

    // ---- bass ----
    const root = roots[bar];
    if (chorus) bass(I, out, mtof(root + (s % 2 ? 12 : 0)), t, STEP * 0.85, s % 4 === 0 ? 0.15 : 0.1, { cut: 1100 });
    else if (sec === 'verse') bass(I, out, mtof(root + (s === 6 ? 12 : 0)), t, STEP * 0.9, s % 4 === 0 ? 0.13 : 0.085);
    else if ((sec === 'break' || sec === 'intro') && s === 0) bass(I, out, mtof(root), t, barLen * 0.9, 0.08, { cut: 500, q: 1 });

    // ---- melody ----
    const note = mel[bar][s];
    if (note !== null) {
      let len = 1;
      while (s + len < BAR && mel[bar][s + len] === null && len < 4) len++;
      const d = len * STEP;
      if (chorus) {
        lead(I, out, mtof(note), t, d * 0.95, 0.05, n.echo, { oct: true, bp: 1700 });
        bell(I, out, mtof(note + 12), t, 0.014, n.echo);
      } else if (sec === 'verse') {
        lead(I, out, mtof(note), t, d * 0.95, 0.05, n.echo);
        bell(I, out, mtof(note + 12), t, 0.012);
      } else if (sec === 'intro') {
        if (bar < 4 ? bar % 2 === 0 : true) bell(I, out, mtof(note), t, 0.05, n.echo, 1.8);
      } else {
        bell(I, out, mtof(note), t, 0.045, n.echo, 1.8);
      }
    }

    // ---- arp (chorus: 16ths) ----
    if (chorus) {
      const ch = chords[bar];
      for (let k = 0; k < 2; k++) {
        const idx = ARP_PAT[(s * 2 + k) % 8];
        pluck(I, out, mtof(ch[idx] + 24), t + k * STEP / 2, 0.026, 1800 + 1200 * (s / 8));
      }
    }

    // ---- drums ----
    if (sec === 'verse') {
      if (s === 0 || s === 3 || (s === 7 && bar % 2 === 1)) kick(I, out, t, 0.5);
      if (s === 4) clap(I, out, t, 0.13, n.rev);
      hat(I, out, t, s % 2 ? 0.032 : 0.016);
      if (bar === 7 && s >= 6) snare(I, out, t, 0.08);
    } else if (chorus) {
      if (s === 0 || s === 3 || s === 4 || (s === 7 && bar % 2 === 1)) kick(I, out, t, 0.55);
      if (s === 2 || s === 6) { snare(I, out, t, 0.17, n.rev); clap(I, out, t, 0.06); }
      hat(I, out, t, s % 2 ? 0.035 : 0.018);
      hat(I, out, t + STEP / 2, 0.012);
      // Taiko fills at the end of each half.
      if ((bar === 3 || bar === 7) && s >= 5) tom(I, out, t, 0.32, s === 5 ? 110 : s === 6 ? 90 : 72, 0.4);
      if (bar % 2 === 0 && s === 0) tom(I, out, t, 0.3, 62, 0.7);
    } else if (sec === 'intro') {
      if (s % 2 === 0) hat(I, out, t, s % 4 === 0 ? 0.02 : 0.01, 0.02); // clock tick
      if (bar >= 4 && (s === 0)) tom(I, out, t, 0.2 + (bar - 4) * 0.05, 60, 0.9);
    } else if (sec === 'break') {
      if (s % 2 === 1) hat(I, out, t, 0.01);
      if (bar === 7) { // snare roll in 16ths, building
        snare(I, out, t, 0.04 + s * 0.012);
        snare(I, out, t + STEP / 2, 0.045 + s * 0.012);
      }
    }
    // Riser into every chorus.
    if (s === 0 && bar === 7 && nextSec === 'chorus') riser(I, out, t, barLen, 0.08);
  }

  /** Sub swell with a slow filter open: the "horizon" under the intro. */
  _swell(t, f, dur) {
    pad(this.I, this.nodes.out, f, t, dur, 0.09, { cut: 120, cut2: 600, att: dur * 0.4, rel: dur * 0.3, det: 5 });
    pad(this.I, this.nodes.out, f * 1.5, t, dur, 0.03, { cut: 200, cut2: 900, att: dur * 0.5, rel: dur * 0.3, det: 7 });
  }
}
