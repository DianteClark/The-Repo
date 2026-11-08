// Player settings, persisted in localStorage. Pure data + change listeners.

const KEY = 'tidefall.settings.v1';

const DEFAULTS = {
  volume: 0.7,        // 0..1
  muted: false,
  quality: 'auto',    // 'auto' | 'high' | 'low'
  cinematic: true,    // action cam on shots and kills
  timer: 'ring',      // 'ring' | 'bar'
  botSpeed: 'fast',   // 'normal' | 'fast'
  follow: true,       // camera follows whoever is acting
  mode: 'solos',
  cls: 'assault',
  loneWolf: false,
  seenHowTo: false,
  seenTutorial: false, // first-launch tips on the title screen
  haptics: true,       // navigator.vibrate on hits, kills and turn start
  callsign: '',        // shown on squad cards and the end screen
  stage: 'random',     // stage key or 'random'
  coverFade: true,     // fade cover props while picking a move
  // 5.0
  colorPreset: 'standard', // squad colours: 'standard' | 'deutan' | 'protan' | 'tritan' | 'high'
  textSize: 'm',       // 's' | 'm' | 'l' | 'xl'
  motion: 'auto',      // reduced motion: 'auto' (follow the OS) | 'reduced' | 'full'
  hitmarkers: true,    // hitmarker + XP popups
  playMode: 'solo',    // last hub play choice: 'solo' | 'host' | 'join'
  // 5.1
  pacing: 'cinematic', // camera / action rhythm: 'cinematic' | 'normal' | 'fast' (R.setPacing)
};

const ENUMS = {
  quality: ['auto', 'high', 'low'], timer: ['ring', 'bar'], botSpeed: ['normal', 'fast'],
  colorPreset: ['standard', 'deutan', 'protan', 'tritan', 'high'], textSize: ['s', 'm', 'l', 'xl'], motion: ['auto', 'reduced', 'full'],
  playMode: ['solo', 'host', 'join'],
  pacing: ['cinematic', 'normal', 'fast'],
};
/** Only keep known keys with the right type and range, so a corrupt or old save can't break the UI. */
export function sanitizeSettings(saved) {
  const out = { ...DEFAULTS };
  if (!saved || typeof saved !== 'object') return out;
  for (const k of Object.keys(DEFAULTS)) {
    const v = saved[k];
    if (typeof v !== typeof DEFAULTS[k]) continue;
    if (ENUMS[k] && !ENUMS[k].includes(v)) continue;
    if (k === 'volume' && !(v >= 0 && v <= 1)) continue;
    if (typeof v === 'string' && v.length > 40) continue;
    out[k] = v;
  }
  return out;
}
let data = { ...DEFAULTS };
try {
  const raw = localStorage.getItem(KEY);
  if (raw) data = sanitizeSettings(JSON.parse(raw));
} catch { /* private mode etc. */ }

const listeners = new Set();

export const settings = new Proxy(data, {
  set(obj, k, v) {
    if (obj[k] === v) return true;
    obj[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(obj)); } catch { /* ignore */ }
    for (const fn of listeners) fn(k, v);
    return true;
  },
});

export function onSettingChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
