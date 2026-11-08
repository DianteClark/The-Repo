// Event playback through the renderer: one ordered queue, the 8 s safety timeout per event,
// the 5.1 action director (staging + pacing), fast-forward, and spectator speed.
//
// 5.1 pacing ("you miss everything in the blink of an eye"):
//  - every VISIBLE event is staged: the renderer's director frames it (actor, actor+target, the
//    blast / line) and we wait for the camera to ARRIVE (R.stage resolves) before it animates;
//  - then a beat of anticipation (lead), the action, and a hold to read the result. A chain of
//    consequences (damage → downed → death) plays straight through and the hold comes after it;
//  - one event at a time, never two at once; unseen events stay instant (fog of war);
//  - a new squad's first visible action gets a short "Squad N is moving" focus beat;
//  - set pieces (stage events, airstrikes, building collapses) are letterboxed cinematics: the
//    renderer opens them, we keep them open through their consequences, then hold and close.
// Numbers live in the renderer's pacing preset (R.pacing; presets in gfx/pacing.js):
// R.setPacing('cinematic' | 'normal' | 'fast'). Spectator 1×/2×/4× multiplies on top: animation
// speed × mul, every beat we own ÷ mul.

import { PACING, eventClass } from '../gfx/pacing.js';

export const SPEC_SPEEDS = [1, 2, 4];
const SPEC_MUL = { 1: 1, 2: 2, 4: 4 };
const EVENT_TIMEOUT = 8000;
const SET_TIMEOUT = 20000; // set pieces run long (slow-mo + holds)

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export function actorOf(ev) {
  switch (ev.type) {
    case 'move': case 'grenade': case 'breach': case 'overwatch': case 'heal': case 'hunker': case 'crate':
    case 'smoke': case 'scan': case 'patch': case 'barrel_shot': case 'reload': case 'swap': case 'semtex': case 'knife':
    case 'flashbang': case 'stim': case 'deploy_cover': case 'suppress': case 'streak_used':
      return ev.id ?? null;
    case 'revive': return ev.by ?? ev.id;
    case 'boat_move': return Number.isInteger(ev.driver) ? ev.driver : null;
    case 'shot': case 'shot_sentry': case 'shot_vehicle': return ev.from;
    case 'rocket': case 'decoy': case 'claymore': case 'repair': case 'overwatch_trigger': case 'board': case 'disembark':
      return Number.isInteger(ev.id) ? ev.id : null;
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
    botSpeed: opts.botSpeed || 'fast', // legacy (5.0 setting); the pacing preset replaces it
    pending: 0,
    lastTeam: null, // the squad whose actions we're showing (for the "Squad N is moving" beat)
    lastActor: null,
    timeline: [], // debug: [{t, ev, phase}] (last 300)
    // 5.2: units whose death has PLAYED here (spectating flips on this, never on the sim's
    // already-resolved state: "Skip to results" must not show before the death animation).
    dead: new Set(),
  };
  /** Has this unit's death been played (or is nothing left to play and the sim says it's dead)? */
  P.playedDead = (st, id) => {
    const u = st?.units?.[id];
    if (!u) return true;
    if (u.alive) return false;
    return P.dead.has(id) || P.pending === 0 || P.ff;
  };

  /** The active pacing preset (the renderer owns it: R.setPacing / R.getPacing). */
  P.preset = () => R?.pacing || PACING[opts.pacing] || PACING.cinematic;
  /** Spectator multiplier: animation speed × mul, every beat we own ÷ mul. */
  P.mul = () => (P.spectating ? SPEC_MUL[P.spec] || P.spec || 1 : 1);
  /** The factor every delay we own is divided by. */
  P.rate = () => (P.ff || opts.pace === false ? 1000 : P.mul());
  P.applySpeed = () => {
    if (!R) return;
    const pre = P.preset();
    const mul = P.mul();
    R.specMul = mul;
    R.speed = (P.myTurn && !P.spectating ? pre.animMine : pre.anim) * mul;
  };
  P.delay = (ms) => (P.ff || !(ms > 0) ? Promise.resolve() : sleep(ms / P.rate()));
  const note = (ev, phase, extra) => {
    P.timeline.push({ t: Math.round(performance.now()), type: ev?.type, phase, ...extra });
    if (P.timeline.length > 300) P.timeline.splice(0, P.timeline.length - 300);
  };

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
      case 'building_collapse': return (ev.tiles || []).some((t) => (Array.isArray(t) ? tileVisible(t[0], t[1]) : t && typeof t === 'object' ? tileVisible(t.x, t.y) : false)) || P.spectating;
      case 'scan': return mine(ev.id) || (ev.revealed || []).some((id) => mine(id));
      case 'boat_move': return mine(ev.driver) || (ev.path || []).some(([x, y]) => tileVisible(x, y));
      case 'sentry_shot': case 'gunship_shot': return Number.isInteger(ev.target) && unitVisible(st, ev.target);
      case 'shot_sentry': case 'shot_vehicle': return Number.isInteger(ev.from) && unitVisible(st, ev.from);
      default: {
        const id = ev.id ?? ev.target;
        return Number.isInteger(id) ? unitVisible(st, id) : false;
      }
    }
  };

  /** Pre-5.1 fallback when the renderer has no director (keeps old renderers working). */
  function followFor(ev) {
    const a = actorOf(ev);
    const st = getState();
    if (a === null || !st?.units[a]) return;
    const d = R?.disp?.[a] || st.units[a];
    if (ev.type === 'move') { const [x, y] = ev.path[ev.path.length - 1]; Rcall('focus', x, y); } else if (Number.isFinite(ev.x) && Number.isFinite(ev.y)) Rcall('focus', ev.x, ev.y);
    else Rcall('focus', d.x, d.y);
  }

  /** Play one event on the renderer (with the safety timeout). */
  P.playOne = async (ev) => {
    if (!R || typeof R.playEvent !== 'function') return;
    try {
      const p = R.playEvent(ev);
      if (p && typeof p.then === 'function') {
        let t;
        const cap = eventClass(ev) === 'set' ? SET_TIMEOUT : EVENT_TIMEOUT;
        await Promise.race([p, new Promise((r) => { t = setTimeout(r, cap); })]);
        clearTimeout(t);
      }
    } catch (e) { console.warn('[match] playEvent ' + ev.type, e); }
  };

  const teamOfActor = (st, ev) => {
    const a = actorOf(ev);
    return a !== null && st?.units[a] ? st.units[a].team : null;
  };

  /** Stage + pace one visible event. Returns the hold owed after it (ms, before ÷ rate). */
  async function direct(ev, g, batchMine) {
    const st = getState();
    const pre = P.preset();
    const cls = eventClass(ev);
    const a = actorOf(ev);
    const team = teamOfActor(st, ev);
    const mt = getMyTeam();
    // my own action, or its consequences / reactions (an overwatch shot at me while I move)
    const mine = (P.myTurn && team === mt && !P.spectating) || batchMine;
    const director = typeof R?.stage === 'function';
    if (cls === 'none') return 0;
    // my turn is open (online: someone else acts meanwhile): the camera is mine, keep it quick
    if (P.myTurn && !mine) return cls === 'major' ? pre.holdMinor : 0;
    // a new squad takes the stage: brief focus beat (not for my own squad, not mid-chain)
    if (team !== null && team !== P.lastTeam && (cls === 'major' || cls === 'move' || cls === 'minor')) {
      const fresh = P.lastTeam !== null || !P.myTurn;
      P.lastTeam = team;
      if (fresh && !mine && team !== mt && P.follow && director && a !== null) {
        note(ev, 'squad', { team });
        await R.squadFocus(team, a, pre.squad);
        if (g !== gen) return 0;
      }
    } else if (a !== null && a !== P.lastActor && P.lastActor !== null && !mine && (cls === 'major' || cls === 'move')) {
      await P.delay(pre.gap); // a beat between two soldiers' turns
      if (g !== gen) return 0;
    }
    if (a !== null) P.lastActor = a;
    // frame it and wait for the camera to arrive
    if (cls !== 'set' && (P.follow || mine)) {
      if (director) { note(ev, 'stage'); await R.stage(ev, { mine }); } else if (!P.myTurn) followFor(ev);
      if (g !== gen) return 0;
    }
    const lead = mine ? (cls === 'major' ? pre.myLead : 0)
      : cls === 'major' ? pre.lead : cls === 'minor' || cls === 'move' ? pre.leadMinor : 0;
    await P.delay(lead);
    const hold = mine ? (cls === 'major' ? pre.myHold : cls === 'conseq' ? pre.myHold * 0.6 : pre.myHold * 0.3)
      : cls === 'major' ? pre.hold : cls === 'conseq' ? pre.holdConseq : cls === 'set' ? 0 : pre.holdMinor;
    return hold;
  }

  /**
   * Queue a batch. Resolves (true if anything was visible) when it has played.
   * hooks: {before(ev), after(), pre(), meta}
   */
  P.enqueue = (events, hooks = {}) => {
    const g = gen;
    P.pending++;
    const run = async () => {
      let shown = false;
      let owed = 0; // hold carried through a chain of consequences
      let cine = false; // a set piece is open (closed after its consequences)
      const R_ = R;
      const closeCine = async () => {
        if (!cine) return;
        cine = false;
        if (R_) R_.cineManaged = false;
        if (R_?.inCinematic && typeof R_.cineEnd === 'function') { note(null, 'cine-end'); await R_.cineEnd(P.ff ? 0 : P.preset().cine.post); }
      };
      try {
        if (g !== gen) return false;
        await hooks.pre?.();
        const list = events || [];
        // a batch my action caused (during my turn): everything in it is paced as mine
        let batchMine = false;
        if (P.myTurn && !P.spectating) {
          const st = getState();
          const first = list.find((e) => actorOf(e) !== null);
          batchMine = !!first && teamOfActor(st, first) === getMyTeam();
        }
        for (let i = 0; i < list.length; i++) {
          const ev = list[i];
          if (g !== gen) return shown;
          let visible = false;
          if (!P.ff) {
            hooks.before?.(ev);
            if (ev.type === 'round_start' || ev.type === 'step_start') { P.lastTeam = null; P.lastActor = null; }
            P.applySpeed();
            visible = P.isVisible(ev);
            const cls = eventClass(ev);
            // a set piece stays open through its consequences; anything else closes it first
            if (cine && cls !== 'conseq' && cls !== 'none') await closeCine();
            if (visible) shown = true;
            let hold = 0;
            if (visible) {
              hold = await direct(ev, g, batchMine);
              if (g !== gen) return shown;
            }
            if (cls === 'set' && visible && R) { R.cineManaged = true; cine = true; }
            hook('onEventStart', ev);
            note(ev, 'start', { visible });
            await P.playOne(ev);
            note(ev, 'end');
            if (g !== gen) return shown;
            // hold to read the result: after the whole chain (shot → damage → downed → death)
            owed = Math.max(owed, hold);
            const nx = list[i + 1];
            const chain = nx && eventClass(nx) === 'conseq' && visible;
            if (!chain && owed > 0) { await P.delay(owed); owed = 0; if (g !== gen) return shown; }
          }
          if (ev.type === 'death' && Number.isInteger(ev.id)) P.dead.add(ev.id);
          else if (ev.type === 'redeploy' && Number.isInteger(ev.id)) P.dead.delete(ev.id);
          hook('onEvent', ev, { ff: P.ff, visible });
        }
        if (owed > 0) await P.delay(owed);
        await closeCine();
        await hooks.after?.();
        if (!P.ff) { if (!P.myTurn) Rcall('setFollow', null); hook('onState'); }
      } catch (e) { console.warn('[match] playback', e); } finally { if (cine && R) { R.cineManaged = false; if (R.inCinematic) Rcall('cineEnd', 0); } }
      return shown;
    };
    const p = queue.then(run).finally(() => { P.pending--; if (P.pending === 0) hook('onIdle'); });
    queue = p.catch(() => {});
    return p;
  };
  /** Queue an arbitrary step after everything already queued. */
  P.then = (fn) => {
    const g = gen;
    P.pending++;
    const p = queue.then(() => (g === gen ? fn() : undefined)).finally(() => { P.pending--; if (P.pending === 0) hook('onIdle'); });
    queue = p.catch(() => {});
    return p;
  };
  P.idle = () => queue;
  P.stop = () => { gen++; queue = Promise.resolve(); P.pending = 0; P.lastTeam = null; P.lastActor = null; P.dead.clear(); };
  P.Rcall = Rcall;
  P.hook = hook;
  return P;
}
