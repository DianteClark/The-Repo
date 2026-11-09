// Liveness bookkeeping for online sessions (pure logic, unit-tested in liveness.test.mjs).
//
// Phones are hostile to heartbeats: a backgrounded or locked tab gets its timers throttled or
// frozen, and a busy main thread (a host playing a cinematic) can stall for seconds. So:
//   - ANY message counts as proof of life, not just pongs;
//   - a peer is only declared silent after DEAD_MS (30 s) without anything from it;
//   - when OUR OWN timers were frozen (tab hidden, CPU starved), we don't blame the other side:
//     a tick that comes far too late resets everyone's clock (grace) instead of dropping them.

export const HEARTBEAT_MS = 3000; // keepalive period (also keeps carrier NAT mappings warm)
export const DEAD_MS = 30000; // silence before a peer is treated as dropped
export const PROBE_MS = 6000; // after we resume, how long to wait for any message before reconnecting
export const FROZEN_MS = 8000; // a tick this late means our own page was frozen/throttled

/**
 * createLiveness({deadMs, frozenMs, now})
 *   seen(id)          any message from id
 *   silence(id)       ms since the last message from id
 *   dead(id)          silence(id) > deadMs
 *   tick()            call every heartbeat: returns {frozen, gap}; when frozen, every clock is reset
 *   grace()           reset everyone's clock (e.g. on visibilitychange → visible)
 *   forget(id)
 */
export function createLiveness({ deadMs = DEAD_MS, frozenMs = FROZEN_MS, now = () => Date.now() } = {}) {
  const last = new Map();
  let lastTick = now();
  const api = {
    seen(id) { last.set(id, now()); },
    silence(id) { return last.has(id) ? now() - last.get(id) : 0; },
    dead(id) { return api.silence(id) > deadMs; },
    forget(id) { last.delete(id); },
    grace() { const t = now(); for (const k of last.keys()) last.set(k, t); },
    tick() {
      const t = now();
      const gap = t - lastTick;
      lastTick = t;
      const frozen = gap > frozenMs;
      if (frozen) api.grace();
      return { frozen, gap };
    },
    ids: () => [...last.keys()],
  };
  return api;
}

/** Reconnect backoff: 0.5 s, 1 s, 2 s, 4 s, then every 6 s (with a little jitter). */
export function backoff(attempt, rand = Math.random) {
  const base = Math.min(6000, 500 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.85 + rand() * 0.3));
}
