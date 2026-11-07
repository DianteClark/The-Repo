// Keeps the screen awake during a match (Screen Wake Lock API: Chrome/Edge,
// Safari 16.4+). Browsers drop the lock when the tab is hidden, so we re-take
// it when the tab comes back.

let lock = null;
let wanted = false;
let pending = false;

async function acquire() {
  if (pending) return;
  pending = true;
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      const l = await navigator.wakeLock.request('screen');
      // allowSleep() may have been called while the request was pending.
      if (!wanted) { l.release().catch?.(() => {}); return; }
      lock = l;
      lock.addEventListener('release', () => { if (lock === l) lock = null; });
    }
  } catch {
    lock = null; // e.g. low battery mode; nothing else we can do in-browser
  } finally {
    pending = false;
  }
}

export function keepAwake() {
  wanted = true;
  if (!lock) acquire();
}

export function allowSleep() {
  wanted = false;
  lock?.release();
  lock = null;
}

export const wakeLockSupported = () => 'wakeLock' in navigator;

document.addEventListener('visibilitychange', () => {
  if (wanted && document.visibilityState === 'visible' && !lock) acquire();
});
