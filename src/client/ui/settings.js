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
};

let data = { ...DEFAULTS };
try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const saved = JSON.parse(raw);
    // Only keep known keys with the right type, so a corrupt or old save can't break the UI.
    for (const k of Object.keys(DEFAULTS)) {
      if (saved && typeof saved[k] === typeof DEFAULTS[k]) data[k] = saved[k];
    }
  }
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
