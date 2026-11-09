// A repeating timer for heartbeats that isn't starved like main-thread timers are.
// Browsers clamp/align main-thread setInterval in background tabs (down to once a minute after a
// while in Chrome); dedicated workers keep their timers. The worker only posts "tick": the work
// still runs on the main thread, but the moment it is free, not a minute later.
// Falls back to setInterval (Node tests, browsers without Worker/Blob URLs).

export function every(ms, fn) {
  let w = null, url = null, iv = 0;
  try {
    if (typeof Worker === 'function' && typeof Blob === 'function' && globalThis.URL?.createObjectURL && globalThis.document) {
      url = URL.createObjectURL(new Blob([`setInterval(()=>postMessage(0),${ms | 0})`], { type: 'text/javascript' }));
      w = new Worker(url);
      w.onmessage = () => { try { fn(); } catch (e) { console.warn('[net] tick', e); } };
      w.onerror = () => { stopWorker(); iv = setInterval(fn, ms); };
    }
  } catch { w = null; }
  function stopWorker() { try { w?.terminate(); } catch { /* ignore */ } w = null; if (url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } url = null; } }
  if (!w) iv = setInterval(fn, ms);
  return () => { stopWorker(); clearInterval(iv); };
}
