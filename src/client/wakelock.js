// Keeps the screen awake during a match (Screen Wake Lock API: Chrome/Edge,
// Safari 16.4+). Browsers drop the lock when the tab is hidden, so we re-take
// it when the tab comes back.

let lock = null;
let wanted = false;

async function acquire() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    }
  } catch {
    lock = null; // e.g. low battery mode; nothing else we can do in-browser
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
