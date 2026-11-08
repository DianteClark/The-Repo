// The client match controller: a redacted mirror of the host's state, fed by fog-filtered event
// batches. Never runs the sim; sends actions to the host and plays what comes back.

import { createPlayer, SPEC_SPEEDS } from './playback.js';
import { PARK } from '../../net/redact.js';


/** Replace `dst`'s contents with `src` in place (the renderer keeps a reference to dst). */
function assignInPlace(dst, src) {
  for (const k of Object.keys(dst)) if (!(k in src)) delete dst[k];
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (k === 'map' && dst.map && v) {
      for (const mk of Object.keys(v)) {
        const mv = v[mk];
        if (ArrayBuffer.isView(mv) && ArrayBuffer.isView(dst.map[mk]) && dst.map[mk].length === mv.length) dst.map[mk].set(mv);
        else dst.map[mk] = mv;
      }
    } else if (k === 'units' && Array.isArray(dst.units) && Array.isArray(v) && dst.units.length === v.length) {
      v.forEach((u, i) => {
        const d = dst.units[i];
        for (const uk of Object.keys(d)) if (!(uk in u)) delete d[uk];
        Object.assign(d, u);
      });
    } else dst[k] = v;
  }
}

export function createRemote({ R, sfx, ui = {}, opts = {}, net }) {
  const player = createPlayer({ R, ui, getState: () => view.state, getMyTeam: () => view.team, opts });
  const { hook, Rcall } = player;
  let mirror = null;
  let myUnitId = -1;
  let myTeam = -1;
  let names = {};
  let cosmetics = {};
  let turnMs = 20000;
  let turn = null; // {unitId, deadline, total, busy}
  let over = false;
  let stopped = false;
  let started = false;
  let summary = null;
  let seq = 0;
  let timer = 0;
  let endResolve = null;
  let startResolve = null;
  const waiting = new Map(); // seq → resolve
  const offs = [];
  const view = { state: null, team: -1 };
  const scopes = new Map(); // pit scope id → {mirror, unitId, team}

  // ---------------------------------------------------------------- renderer reconciliation

  /** Move the renderer's displayed unit without animation (feature-detected renderer internals). */
  function setDisp(id, u, x, y) {
    const d = R?.disp?.[id], v = R?.views?.[id];
    if (!d || !v) return false;
    d.x = x; d.y = y;
    if (u) { d.alive = !!u.alive; d.downed = !!u.downed; if (Number.isFinite(u.hp)) d.hp = u.hp; }
    if (x !== PARK && typeof R.wx === 'function') {
      let gy = v.root.position.y;
      try { const g = R._groundY?.(x, y); if (Number.isFinite(g)) gy = g; } catch { /* ignore */ }
      v.root.position.set(R.wx(x), gy, R.wz(y));
    } else v.root.visible = false;
    return true;
  }
  /** After a batch: hidden units parked, everyone where the mirror says. */
  function reconcile(st, crateDiff) {
    if (!R || !st) return;
    if (crateDiff || !R.disp || !R.views) { Rcall('syncFromState'); return; }
    let moved = false;
    st.units.forEach((u, i) => {
      const d = R.disp[i];
      if (!d) return;
      const x = u.hidden ? PARK : u.x, y = u.hidden ? PARK : u.y;
      if (d.x !== x || d.y !== y || (!u.hidden && d.alive !== u.alive)) { setDisp(i, u, x, y); moved = true; }
    });
    if (moved) Rcall('refreshFog');
  }

  // ---------------------------------------------------------------- batches

  function playBatch(m) {
    const scope = m.scope ? scopes.get(m.scope) : null;
    const target = scope ? scope.mirror : mirror;
    if (!target) return Promise.resolve();
    return player.enqueue(m.events || [], {
      pre: () => {
        const wasHidden = new Set(target.units.filter((u) => u.hidden).map((u) => u.id));
        const crates = new Set((target.crates || []).map((c) => c.id));
        if (m.snap) assignInPlace(target, m.snap);
        if (view.state !== target) return;
        // Units that came into view without an event moving them: put them where they are now,
        // so the renderer's fog reveals them exactly when my squad's view reaches them.
        const movers = new Set((m.events || []).filter((e) => e.type === 'move').map((e) => e.id));
        for (const u of target.units) if (wasHidden.has(u.id) && !u.hidden && !movers.has(u.id)) setDisp(u.id, u, u.x, u.y);
        const now = new Set((target.crates || []).map((c) => c.id));
        const explained = new Set((m.events || []).flatMap((e) => [e.crate?.id ?? e.crate, e.type === 'crate' ? e.crate : null]).filter((x) => x !== undefined && x !== null));
        m._crateDiff = [...crates].some((id) => !now.has(id) && !explained.has(id)) || [...now].some((id) => !crates.has(id) && !explained.has(id));
      },
      before: (ev) => {
        // A shooter/thrower in the fog is shown where it fired from, for the shot.
        if (Number.isFinite(ev.fx) && view.state === target) {
          const id = ev.from ?? ev.id;
          if (Number.isInteger(id)) setDisp(id, target.units[id], ev.fx, ev.fy);
        }
      },
      after: () => { if (view.state === target) reconcile(target, m._crateDiff); },
    });
  }

  function openTurn(m) {
    return player.then(() => {
      if (stopped || over) return;
      turn = { unitId: m.unitId, total: m.ms, deadline: performance.now() + m.ms, busy: false, lastTick: 99, scope: m.scope || null };
      net.send({ t: 'turn_ack' });
      player.myTurn = true;
      player.applySpeed();
      const u = view.state?.units[m.unitId];
      Rcall('setFollow', null);
      if (u && !u.hidden) Rcall('focus', u.x, u.y);
      sfx?.turn?.();
      hook('onTurnStart', { unitId: m.unitId, deadline: turn.deadline, total: turn.total, pit: m.scope || null });
    });
  }
  function closeTurn(reason) {
    if (!turn) return;
    turn = null;
    player.myTurn = false;
    player.applySpeed();
    hook('onTurnEnd', { unitId: myUnitId, reason });
  }

  function applyStart(m) {
    const first = !mirror;
    myUnitId = m.unitId; myTeam = m.team;
    names = m.names || {}; cosmetics = m.cosmetics || {}; turnMs = m.ms || m.turnMs || turnMs;
    if (first) mirror = m.snap;
    else assignInPlace(mirror, m.snap);
    view.state = mirror; view.team = myTeam;
    Rcall('setGame', mirror, myTeam, { cosmetics });
    Rcall('setSpectator', false);
    if (!first) { turn = null; player.myTurn = false; Rcall('syncFromState'); hook('onState'); hook('onStatus', 'Back in the match', 'ok'); }
    startResolve?.();
  }

  const early = []; // messages before start() ran
  function onMessage(m) {
    if (stopped) return;
    if (!started || !mirror) {
      if (m.t === 'start') { pendingStart = m; startResolve?.(); } else early.push(m);
      return;
    }
    switch (m.t) {
      case 'start': player.then(() => applyStart(m)); return;
      case 'batch': playBatch(m); return;
      case 'turn': openTurn(m); return;
      case 'turn_end': player.then(() => closeTurn(m.reason)); return;
      case 'result': {
        // The host answered: stop the no-answer clock now, resolve once the action's events have played.
        const r = waiting.get(m.seq);
        r?.got?.();
        player.then(() => { waiting.delete(m.seq); r?.({ ok: !!m.ok, error: m.error }); });
        return;
      }
      case 'step': hook('onStep', { active: m.active || [], activeCount: m.activeCount, engagements: m.engagements || [], round: m.round }); return;
      case 'status': hook('onStatus', m.msg, m.level || 'info'); return;
      case 'pit': player.then(() => pit(m)); return;
      case 'over': player.then(() => finish(m.summary)); return;
      default:
    }
  }

  function pit(m) {
    if (m.phase === 'start') {
      player.ff = false; // my own duel plays for real even after "skip to results"
      const s = { mirror: m.snap, unitId: m.unitId, team: m.team };
      scopes.set(m.scope, s);
      view.state = s.mirror; view.team = s.team;
      Rcall('setGame', s.mirror, s.team, { cosmetics: {} });
      hook('onPit', { phase: 'start', duelId: m.duelId, duelState: s.mirror, a: m.a, b: m.b, warden: !!m.warden, mine: true, myDuelUnitId: m.unitId });
    } else {
      scopes.delete(m.scope);
      view.state = mirror; view.team = myTeam;
      Rcall('setGame', mirror, myTeam, { cosmetics });
      Rcall('syncFromState');
      hook('onPit', { phase: 'end', duelId: m.duelId, winner: m.winner, won: !!m.won, mine: true });
    }
  }

  function finish(s) {
    if (over) return;
    over = true;
    clearInterval(timer);
    closeTurn('over');
    summary = { ...(s || {}), names };
    hook('onMatchEnd', summary);
    endResolve?.(summary);
  }

  function tick() {
    const me = mirror?.units?.[myUnitId];
    const spec = !!mirror && view.state === mirror && (!me || !me.alive);
    if (spec !== player.spectating) { player.spectating = spec; player.applySpeed(); hook('onState'); }
    if (!turn) return;
    const now = performance.now();
    if (turn.busy) { turn.deadline += now - (turn.busyAt || now); turn.busyAt = now; }
    const left = Math.max(0, (turn.deadline - now) / 1000);
    const whole = Math.ceil(left);
    if (whole !== turn.lastTick) {
      turn.lastTick = whole;
      if (whole <= 5 && whole > 0) sfx?.tick?.(true);
      else if (whole <= 10 && whole > 0) sfx?.tick?.(false);
    }
    hook('onTick', { unitId: turn.unitId, left, total: turn.total / 1000, deadline: turn.deadline });
  }

  let pendingStart = opts.start || null; // the lobby may hand over the 'start' message it received
  const backlog = net.takeBacklog?.() || [];
  offs.push(net.onMessage(onMessage));
  offs.push(() => net.resumeBacklog?.());
  offs.push(net.on('status', (msg, level) => hook('onStatus', msg, level)));
  offs.push(net.on('connection', (on) => { hook('onConnection', on); if (on) net.send({ t: 'resync' }); }));
  offs.push(net.on('closed', (info) => {
    if (over || stopped) return;
    hook('onStatus', info?.msg || 'The match ended.', 'error');
    finish({ reason: info?.reason || 'closed', msg: info?.msg, place: null, winner: null, myTeam });
  }));

  for (const m of backlog) onMessage(m);

  const api = {
    kind: 'client',
    get state() { return mirror; },
    get view() { return view.state; },
    get myTeam() { return myTeam; },
    get myUnitId() { return myUnitId; },
    get over() { return over; },
    get summary() { return summary; },
    get speed() { return player.spec; },
    get spectating() { return player.spectating; },
    get fastForwarding() { return player.ff; },
    get turn() { return turn ? { unitId: turn.unitId, deadline: turn.deadline, total: turn.total, busy: turn.busy, left: Math.max(0, (turn.deadline - performance.now()) / 1000) } : null; },
    get names() { return names; },
    get players() {
      const lp = net.lobby?.players || [];
      return Object.entries(names).map(([id, name]) => ({ unitId: +id, name, team: mirror?.units[id]?.team, local: +id === myUnitId, connected: lp.find((p) => p.name === name)?.connected ?? true }));
    },
    get connected() { return net.connected; },
    set follow(on) { player.follow = !!on; },
    set botSpeed(v) { player.botSpeed = v; player.applySpeed(); },

    async start() {
      if (started) return api.done;
      started = true;
      if (!pendingStart) await new Promise((r) => { startResolve = r; setTimeout(r, 15000); });
      if (!pendingStart && !mirror) { hook('onStatus', 'The host did not start the match.', 'error'); finish({ reason: 'no_start' }); return api.done; }
      if (pendingStart) { const m = pendingStart; pendingStart = null; applyStart(m); }
      timer = setInterval(tick, 100);
      player.applySpeed();
      const intro = Promise.resolve(hook('onIntro', api)).catch(() => {});
      player.then(() => intro); // nothing plays until the UI's intro is over
      for (const m of early.splice(0)) onMessage(m);
      return api.done;
    },
    done: null,

    act(action) {
      if (!turn) return Promise.resolve({ ok: false, error: 'Not your turn' });
      if (turn.busy) return Promise.resolve({ ok: false, error: 'Busy' });
      const s = ++seq;
      turn.busy = true; turn.busyAt = performance.now();
      const t = turn;
      return new Promise((resolve) => {
        const to = setTimeout(() => { if (waiting.has(s)) { waiting.delete(s); t.busy = false; resolve({ ok: false, error: 'No answer from the host' }); } }, 10000);
        const done = (r) => {
          clearTimeout(to);
          t.busy = false;
          net.send({ t: 'idle', seq: s });
          resolve(r);
        };
        done.got = () => clearTimeout(to);
        waiting.set(s, done);
        if (!net.send({ t: 'act', seq: s, action })) { waiting.delete(s); clearTimeout(to); t.busy = false; resolve({ ok: false, error: 'Not connected' }); }
      });
    },
    endTurn() {
      if (!turn) return Promise.resolve({ ok: false, error: 'Not your turn' });
      net.send({ t: 'end' });
      return Promise.resolve({ ok: true });
    },
    pause() { return false; },
    resume() {},
    setSpeed(x) { player.spec = SPEC_SPEEDS.includes(x) ? x : 2; player.applySpeed(); return player.spec; },
    fastForward() {
      const me = mirror?.units?.[myUnitId];
      if (me && me.alive) return false;
      player.ff = true;
      return true;
    },
    leave() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      player.stop();
      for (const off of offs) { try { off(); } catch { /* ignore */ } }
      net.leave?.();
      endResolve?.(summary || { reason: 'left', place: null });
    },
    _debug: { player, scopes, get mirror() { return mirror; } },
  };
  api.done = new Promise((r) => { endResolve = r; });
  return api;
}
