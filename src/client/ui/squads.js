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

// Colourblind presets (5.0): enemy palettes that stay distinct under each
// deficiency by leaning on lightness as well as hue. Amber (you) and cyan
// (signals) stay reserved in every preset.
export const PRESET_PALETTES = {
  // Red-green safe: blues, purples, magentas, yellows, whites at varied lightness.
  deutan: ['#3d6bff', '#ff4fd8', '#f5f06a', '#9b6bff', '#ffffff', '#1f3fa8', '#ff9fe8', '#c9c400', '#6a3df0', '#b8c9ff', '#a8008a', '#e6e6a0', '#5a8cff', '#d78cff', '#8a8a8a'],
  protan: ['#2f6dff', '#ff66e0', '#e8e04a', '#a070ff', '#f2f2f2', '#203d9c', '#ffb0ef', '#b3ae00', '#7340f5', '#a9bdff', '#b0129a', '#d9d98f', '#4e7fff', '#cf8aff', '#7d7d7d'],
  // Blue-yellow safe: reds, pinks, teals and greys.
  tritan: ['#ff3b3b', '#ff8fb0', '#00a37a', '#c40050', '#ffffff', '#ff7a5c', '#7a0018', '#5fd6b0', '#e05a8a', '#b3b3b3', '#a83250', '#00664c', '#ffb3c2', '#ff5f8f', '#5c5c5c'],
  // High contrast: maximal lightness spread.
  high: ['#ff2d55', '#ffffff', '#3d5afe', '#e040fb', '#00e676', '#ff6d00', '#c6ff00', '#7c4dff', '#ff80ab', '#18ffff', '#9e9e9e', '#ffea00', '#d50000', '#304ffe', '#76ff03'],
};
let preset = 'standard';
/** Switch the enemy palette ('standard' uses the shared Graphics palette). */
export function setColorPreset(p) { preset = PRESET_PALETTES[p] ? p : 'standard'; }
export const activePalette = () => PRESET_PALETTES[preset] || palette;

/** Colour of team `t` as seen by `myTeam`. Always '#rrggbb'. */
export function squadColor(t, myTeam) {
  if (t === myTeam) return AMBER;
  if (PRESET_PALETTES[preset] && t !== null && t !== undefined && t >= 0) {
    const pal = PRESET_PALETTES[preset];
    const idx = myTeam >= 0 && t > myTeam ? t - 1 : t;
    return pal[idx % pal.length];
  }
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
