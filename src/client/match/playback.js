// Event playback through the renderer: one ordered queue, the 8 s safety timeout per event,
// camera follow, fast-forward, and spectator speed that really scales everything we control.
//
// Why 1×/2×/4× used to look the same (measured; see the NET report):
//  - spectator R.speed was botSpeed(1.8) × specSpeed, so 2× (3.6) and 4× (7.2) both crossed the
//    renderer's "speed > 3 → snap moves" threshold and looked identical;
//  - the gaps between bot turns (90–220 ms), the per-turn pauses and the follow-camera glide were
//    fixed real-time costs that dominated once the animations themselves got short.
//  - renderer-side (GFX-WORLD): camera holds use HOLD/min(1, speed) so they never shorten above 1×,
//    hit-stop runs on the real clock, and the camera glide (damp) ignores speed.
// Now: R.speed = SPEC_RATE[x] (1.5 / 2.9 / 5.8: 1× and 2× animate moves, 4× snaps them), every delay
// we own is divided by the same factor, and at ≥2× the follow camera jumps instead of gliding.

export const SPEC_SPEEDS = [1, 2, 4];
const SPEC_RATE = { 1: 1.5, 2: 2.9, 4: 5.8 }; // 2× stays under the renderer's speed>3 'snap moves' threshold
const EVENT_TIMEOUT = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export function actorOf(ev) {
  switch (ev.type) {
    case 'move': case 'grenade': case 'breach': case 'overwatch': case 'heal': case 'hunker': case 'crate':
    case 'smoke': case 'scan': case 'patch': case 'barrel_shot': case 'reload': case 'swap': case 'semtex': case 'knife':
    case 'flashbang': case 'stim': case 'deploy_cover': case 'suppress': case 'streak_used':
      return ev.id ?? null;
    case 'revive': return ev.by ?? ev.id;
    case 'shot': return ev.from;
    default: return null;
  }
}

export function createPlayer({ R, ui = {}, getState, getMyTeam, opts = {} }) {
  const Rcall = (name, ...a) => {
    const fn = R?.[name];
    if (typeof fn !== 'function') return undefined;
    try { return fn.apply(R, a); } catch (e) { console.warn('[match] R.' + name, e); return undefined; }
  };
  const hook = (name, ...a) => { try { return ui?.[name]?.(...a); } catch (e) { console.warn('[match] ui.' + name, e); return undefined; } };

  let queue = Promise.resolve();
  let gen = 0;
  const P = {
    ff: false, // fast-forward: skip animations entirely
    spec: 2, // spectator speed multiplier
    spectating: false,
    myTurn: false,
    follow: opts.follow !== false,
    botSpeed: opts.botSpeed || 'fast',
    pending: 0,
  };

  /** The factor every delay we own is divided by. */
  P.rate = () => (P.ff || opts.pace === false ? 1000 : P.spectating ? SPEC_RATE[P.spec] || P.spec : P.botSpeed === 'normal' ? 1 : 1.35);
  P.applySpeed = () => {
    if (!R) return;
    if (P.spectating) R.speed = SPEC_RATE[P.spec] || P.spec;
    else if (P.myTurn) R.speed = 1.15;
    else R.speed = P.botSpeed === 'normal' ? 1.2 : 1.8;
  };
  P.delay = (ms) => (P.ff ? Promise.resolve() : sleep(ms / P.rate()));

  const tileVisible = (x, y) => {
    if (typeof R?.visibleToMe === 'function') { try { return !!R.visibleToMe(x, y); } catch { /* fall through */ } }
    return true;
  };
  const unitVisible = (st, id) => {
    const u = st.units[id];
    if (!u || u.hidden) return false;
    if (u.team === getMyTeam()) return true;
    if (typeof R?.isUnitVisible === 'function') { try { return !!R.isUnitVisible(id); } catch { /* fall through */ } }
    return true;
  };

  P.isVisible = (ev) => {
    const st = getState();
    if (!st) return false;
    const mt = getMyTeam();
    const mine = (id) => st.units[id]?.team === mt;
    switch (ev.type) {
      case 'move': return mine(ev.id) || (ev.path || []).some(([x, y]) => tileVisible(x, y));
      case 'shot': return mine(ev.from) || mine(ev.to) || unitVisible(st, ev.from) || unitVisible(st, ev.to);
      case 'grenade': case 'breach': case 'smoke': case 'barrel_shot': case 'semtex': case 'flashbang': case 'knife':
        return mine(ev.id) || tileVisible(ev.x, ev.y);
      case 'barrel': case 'cover_change': case 'ping': return Number.isFinite(ev.x) && tileVisible(ev.x, ev.y);
      case 'flare': case 'flare_end': case 'zone_shrink': case 'supply_drop': case 'airstrike': case 'airstrike_mark':
      case 'stage_event': case 'stage_event_warn': case 'care_package': case 'redeploy': return true;
      case 'scan': return mine(ev.id) || (ev.revealed || []).some((id) => mine(id));
      default: {
        const id = ev.id ?? ev.target;
        return Number.isInteger(id) ? unitVisible(st, id) : false;
      }
    }
  };

  function followFor(ev) {
    const a = actorOf(ev);
    const st = getState();
    if (a === null || !st?.units[a]) return;
    const instant = P.spectating && P.spec >= 2;
    const d = R?.disp?.[a] || st.units[a];
    if (ev.type === 'move' && !instant) {
      if (typeof R?.setFollow === 'function') Rcall('setFollow', a);
      else { const [x, y] = ev.path[ev.path.length - 1]; Rcall('focus', x, y); }
    } else if (ev.type === 'move') {
      const [x, y] = ev.path[ev.path.length - 1]; Rcall('focus', x, y, true);
    } else if (ev.type === 'shot') {
      const t = R?.disp?.[ev.to] || st.units[ev.to];
      const sx = ev.fx ?? d.x, sy = ev.fy ?? d.y;
      Rcall('focus', (sx + t.x) / 2, (sy + t.y) / 2, instant);
    } else if (Number.isFinite(ev.x) && Number.isFinite(ev.y)) Rcall('focus', ev.x, ev.y, instant);
    else Rcall('focus', d.x, d.y, instant);
  }

  /** Play one event on the renderer (with the safety timeout). */
  P.playOne = async (ev) => {
    if (!R || typeof R.playEvent !== 'function') return;
    try {
      const p = R.playEvent(ev);
      if (p && typeof p.then === 'function') {
        let t;
        await Promise.race([p, new Promise((r) => { t = setTimeout(r, EVENT_TIMEOUT); })]);
        clearTimeout(t);
      }
    } catch (e) { console.warn('[match] playEvent ' + ev.type, e); }
  };

  /**
   * Queue a batch. Resolves (true if anything was visible) when it has played.
   * hooks: {before(ev), after(), pre(), meta}
   */
  P.enqueue = (events, hooks = {}) => {
    const g = gen;
    P.pending++;
    const run = async () => {
      let shown = false;
      try {
        if (g !== gen) return false;
        await hooks.pre?.();
        for (const ev of events || []) {
          if (g !== gen) return shown;
          let visible = false;
          if (!P.ff) {
            hooks.before?.(ev);
            visible = P.isVisible(ev);
            if (visible) shown = true;
            if (visible && P.follow && !P.myTurn) followFor(ev);
            hook('onEventStart', ev);
            await P.playOne(ev);
            if (g !== gen) return shown;
          }
          hook('onEvent', ev, { ff: P.ff, visible });
        }
        await hooks.after?.();
        if (!P.ff) { if (!P.myTurn) Rcall('setFollow', null); hook('onState'); }
      } catch (e) { console.warn('[match] playback', e); }
      return shown;
    };
    const p = queue.then(run).finally(() => { P.pending--; });
    queue = p.catch(() => {});
    return p;
  };
  /** Queue an arbitrary step after everything already queued. */
  P.then = (fn) => {
    const g = gen;
    P.pending++;
    const p = queue.then(() => (g === gen ? fn() : undefined)).finally(() => { P.pending--; });
    queue = p.catch(() => {});
    return p;
  };
  P.idle = () => queue;
  P.stop = () => { gen++; queue = Promise.resolve(); P.pending = 0; };
  P.Rcall = Rcall;
  P.hook = hook;
  return P;
}
