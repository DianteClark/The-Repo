// Squad colours for the HUD. The palette lives in src/shared/colors.js
// (Graphics); this adapter imports it dynamically and falls back to a local
// copy of the same rules, so the HUD never breaks if that file is missing.
// Your squad is always amber; 15 other saturated hues avoid amber and cyan.

const AMBER = '#ffb000';

function hsl(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

// 15 hues around the wheel, skipping 30–55° (amber) and 175–200° (cyan).
const FALLBACK_PALETTE = (() => {
  const ok = (h) => !(h >= 30 && h <= 55) && !(h >= 175 && h <= 200);
  // Spread: take evenly spaced samples from the allowed hues.
  const allowed = [];
  for (let h = 0; h < 360; h++) if (ok(h)) allowed.push(h);
  const out = [];
  for (let i = 0; i < 15; i++) out.push(allowed[Math.floor((i * allowed.length) / 15)]);
  // Interleave so neighbouring team ids get contrasting hues.
  const order = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7];
  return order.map((i) => hsl(out[i], 88, i % 2 ? 62 : 56));
})();

let impl = null;
let palette = FALLBACK_PALETTE;
try {
  const m = await import('../../shared/colors.js');
  if (typeof m.squadColor === 'function') impl = m.squadColor;
  if (Array.isArray(m.SQUAD_PALETTE) && m.SQUAD_PALETTE.length) palette = m.SQUAD_PALETTE;
} catch (e) { console.warn('[tidefall] squad colours: using the built-in palette', e?.message || e); }

const valid = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

/** Colour of team `t` as seen by `myTeam`. Always '#rrggbb'. */
export function squadColor(t, myTeam) {
  if (t === myTeam) return AMBER;
  if (impl) {
    try { const c = impl(t, myTeam); if (valid(c)) return c; } catch { /* fall back */ }
  }
  if (t === null || t === undefined || t < 0) return '#ff3fa4';
  // Skip the player's own slot so every enemy keeps a stable, distinct colour.
  const idx = myTeam >= 0 && t > myTeam ? t - 1 : t;
  return palette[((idx % palette.length) + palette.length) % palette.length];
}

/** Inline style that sets the --sq custom property (used by the HUD CSS). */
export const sqStyle = (t, myTeam) => `--sq:${squadColor(t, myTeam)}`;
