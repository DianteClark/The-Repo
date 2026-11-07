// Haptic feedback via navigator.vibrate, gated by the haptics setting.
// Every call is safe on devices without vibration (desktop, iOS Safari).

import { settings } from './settings.js';

export const hapticsSupported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

const PATTERNS = {
  tap: 8,
  turn: [18, 60, 18],
  hit: [35],           // you were hit
  graze: [14],
  hitDealt: [10],      // your shot connected
  kill: [20, 40, 70],
  downed: [90, 60, 90, 60, 160],
  revive: [20, 30, 20, 30, 40],
  explosion: [60, 30, 30],
  error: [12, 40, 12],
  win: [40, 60, 40, 60, 200],
};

let lastAt = 0;
export function buzz(kind) {
  if (!hapticsSupported || !settings.haptics || document.hidden) return;
  const p = PATTERNS[kind] ?? kind;
  const now = performance.now();
  // Don't let rapid events (grenade splash on 3 units) stack into one long buzz.
  if (now - lastAt < 70 && kind !== 'kill' && kind !== 'downed') return;
  lastAt = now;
  try { navigator.vibrate(p); } catch { /* ignore */ }
}
