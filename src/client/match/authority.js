// The authoritative match controller: runs the sim. kind 'local' (solo vs bots) or 'host'
// (online host: also validates remote players' actions and broadcasts fog-filtered views).

import { turnModel } from './turns.js';
import { createPlayer, SPEC_SPEEDS } from './playback.js';
import { createTeamMemory, teamView, redactSnapshot } from '../../net/redact.js';
import { squadSizes } from '../../net/session.js';

const TURN_MS = 20000;
const ACK_BACKSTOP_MS = 12000; // a remote turn's clock starts on the client's ack, or after this
const REMOTE_BUSY_CAP_MS = 8000; // the clock is frozen while a remote action animates, at most this long
const standing = (u) => !!u && u.alive && !u.downed;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createAuthority(kind, { G, AI, R, sfx, ui = {}, opts = {}, net = null }) {
  const model = turnModel(G);
  const turnMs = (opts.turnSeconds || G.TURN_SECONDS || 20) * 1000 || TURN_MS;
  const player = createPlayer({ R, ui, getState: () => view.state, getMyTeam: () => view.team, opts });
  const { hook, Rcall } = player;
  const humans = new Map(); // unitId → {pid, local, name}
  const clients = new Map(); // pid → {unitId, team, mem, hash, scope}
  const turns = new Map(); // unitId → open turn
  const placeByTeam = new Map();
  let state = null;
  let myUnitId = -1;
  let myTeam = -1;
  let running = false;
  let over = false;
  let stopped = false;
  let timer = 0;
  let endResolve = null;
  let lastActiveSig = '';
  let summary = null;
  const view = { state: null, team: -1 }; // what this device's renderer shows (main match or a Pit duel)
  const offs = [];

  // ---------------------------------------------------------------- setup

  function template(cls, loadout, loneWolf, name) {
    try {
      const t = G.createGame({
        mode: loneWolf ? 'trios' : 'solos', volunteerLoneWolf: !!loneWolf, playerClass: cls, callsign: name, seed: 1, stage: 'harbor',
        ...(loadout ? { players: [{ name, loadout, isHuman: true }], loadout } : {}),
      });
      return t.units.find((u) => u.isPlayer) || t.units.find((u) => u.isHuman) || null;
    } catch { return null; }
  }
  /** Turn a bot slot into a human's unit (old sims without opts.players). */
  function adopt(u, p) {
    const t = (p.cls && p.cls !== u.cls) || p.loadout ? template(p.cls || u.cls, p.loadout, u.isLoneWolf, p.name) : null;
    if (t) {
      for (const k of Object.keys(t)) {
        if (['id', 'team', 'name', 'x', 'y', 'isPlayer', 'isLoneWolf', 'alive', 'ap'].includes(k)) continue;
        u[k] = structuredClone(t[k]);
      }
    }
    u.name = p.name;
    u.isHuman = true;
    u.pid = p.pid;
  }

  function setupSolo() {
    const loadout = opts.loadout || null;
    state = G.createGame({
      mode: opts.mode || 'solos', playerClass: opts.cls, callsign: opts.callsign || 'You', stage: opts.stage || 'random',
      volunteerLoneWolf: !!opts.loneWolf, seed: opts.seed,
      ...(loadout ? { loadout, players: [{ name: opts.callsign || 'You', loadout, isHuman: true }] } : {}),
    });
    const me = state.units.find((u) => u.isPlayer) || state.units.find((u) => u.isHuman);
    myUnitId = me ? me.id : -1;
    myTeam = me ? me.team : -1;
    if (me) humans.set(me.id, { pid: 'local', local: true, name: opts.callsign || me.name });
  }

  function setupHost() {
    const lp = net.players();
    const mode = net.lobby.settings.mode;
    const stage = net.lobby.settings.stage;
    const sizes = squadSizes(mode);
    const lw = mode === 'trios' && sizes[sizes.length - 1] === 1 ? sizes.length - 1 : -1;
    const hostP = lp.find((p) => p.isHost);
    // Host first: the sim honours volunteerLoneWolf for the first human only.
    const ordered = [hostP, ...lp.filter((p) => !p.isHost)];
    const tag = (p) => `\u0001${p.pid}\u0001`;
    state = G.createGame({
      mode, stage, seed: opts.seed, playerClass: hostP.cls, callsign: hostP.name, volunteerLoneWolf: hostP.squad === lw,
      loadout: hostP.loadout || undefined,
      players: ordered.map((p) => ({ name: tag(p), loadout: p.loadout || { cls: p.cls }, cls: p.cls, isHuman: true, squad: p.squad })),
    });
    // Did the sim seat the humans itself (5.0 opts.players)? Map them back by their tagged names.
    const seated = [];
    for (const u of state.units) {
      const p = typeof u.name === 'string' && lp.find((x) => u.name === tag(x));
      if (p) { u.name = p.name; u.pid = p.pid; seated.push(u); }
    }
    if (seated.length === lp.length) {
      for (const u of seated) humans.set(u.id, { pid: u.pid, local: u.pid === hostP.pid, name: u.name });
    } else {
      const hostUnit = state.units.find((u) => u.isPlayer) || state.units[state.teams[0].members[0]];
      const map = sizes.map((_, i) => i);
      if (hostUnit.team !== hostP.squad && sizes[hostUnit.team] === sizes[hostP.squad]) { map[hostP.squad] = hostUnit.team; map[hostUnit.team] = hostP.squad; }
      const taken = new Set([hostUnit.id]);
      adopt(hostUnit, hostP);
      hostUnit.isPlayer = true;
      humans.set(hostUnit.id, { pid: hostP.pid, local: true, name: hostP.name });
      for (const p of lp) {
        if (p.isHost) continue;
        const team = state.teams[map[p.squad]] || state.teams.find((t) => t.members.some((id) => !taken.has(id)));
        const u = team && team.members.map((id) => state.units[id]).find((x) => !taken.has(x.id));
        if (!u) continue;
        taken.add(u.id);
        adopt(u, p);
        u.isPlayer = false;
        humans.set(u.id, { pid: p.pid, local: false, name: p.name });
      }
    }
    for (const [id, h] of humans) {
      if (h.local) { myUnitId = id; myTeam = state.units[id].team; continue; }
      clients.set(h.pid, { unitId: id, team: state.units[id].team, mem: createTeamMemory(state, state.units[id].team), hash: '' });
    }
  }

  // ---------------------------------------------------------------- broadcasting

  const cosmetics = () => {
    const c = {};
    if (net) for (const [id, h] of humans) { const p = net.player(h.pid); if (p?.cosmetics) c[id] = p.cosmetics; }
    else if (opts.cosmetics && myUnitId >= 0) c[myUnitId] = opts.cosmetics;
    return c;
  };
  const names = () => { const n = {}; for (const [id, h] of humans) n[id] = h.name; return n; };

  function startMsg(pid) {
    const c = clients.get(pid);
    c.mem = createTeamMemory(state, c.team); // a fresh mirror starts from a fresh memory
    const { snap } = teamView(state, [], c.mem, { myUnitId: c.unitId });
    return { t: 'start', unitId: c.unitId, team: c.team, snap, cosmetics: cosmetics(), names: names(), turnMs, mode: state.mode, stage: state.stage };
  }

  function broadcast(events, scope = null) {
    if (!net || !clients.size) return;
    for (const [pid, c] of clients) {
      if (!net.isConnected(pid)) continue;
      if (scope) {
        if (c.scope?.id !== scope.id) continue;
        const r = teamView(scope.state, events, c.scope.mem, { myUnitId: c.scope.unitId });
        net.send(pid, { t: 'batch', scope: scope.id, events: r.events, snap: r.snap });
        continue;
      }
      const r = teamView(state, events, c.mem, { myUnitId: c.unitId });
      const hash = JSON.stringify([r.snap.units, r.snap.crates, r.snap.zone, r.snap.round]);
      if (!r.events.length && hash === c.hash) continue;
      c.hash = hash;
      net.send(pid, { t: 'batch', events: r.events, snap: r.snap });
    }
  }

  /** Apply sim events everywhere: remote views now, local playback queued. Resolves when played here. */
  function emit(events, scope = null) {
    if (!events?.length) return Promise.resolve(false);
    for (const ev of events) if (ev.type === 'team_out' && Number.isInteger(ev.team)) placeByTeam.set(ev.team, ev.place);
    broadcast(events, scope);
    // Events from a Pit duel I'm not in, or main-match events while I'm watching a duel: no playback here.
    if ((scope && view.state !== scope.state) || (!scope && view.state !== state)) {
      for (const ev of events) hook('onEvent', ev, { ff: true, visible: false, scope: scope?.id });
      return Promise.resolve(false);
    }
    return player.enqueue(events).then((shown) => { updateSpectating(); return shown; });
  }

  // ---------------------------------------------------------------- turns

  const isLocal = (id) => !!humans.get(id)?.local;

  function openTurn(u, world) {
    const h = humans.get(world.humanOf ? world.humanOf(u.id) : u.id);
    const t = {
      unitId: u.id, team: u.team, pid: h?.pid, local: !!h?.local, world,
      total: turnMs, deadline: Infinity, busy: false, busyAt: 0, paused: 0, acked: false, openedAt: performance.now(), lastTick: 99, done: false,
    };
    let resolve;
    t.closed = new Promise((r) => { resolve = r; });
    t.resolve = resolve;
    turns.set(u.id, t);
    if (t.local) {
      t.acked = true;
      t.deadline = performance.now() + t.total;
      player.myTurn = true;
      player.applySpeed();
      Rcall('setFollow', null);
      Rcall('focus', u.x, u.y);
      sfx?.turn?.();
      hook('onTurnStart', { unitId: u.id, deadline: t.deadline, total: t.total, pit: world.pit || null });
    } else if (net) {
      const c = clients.get(t.pid);
      if (!net.isConnected(t.pid)) { autoOverwatch(t, 'disconnected'); return t; }
      net.send(t.pid, { t: 'turn', unitId: world.pit ? c?.scope?.unitId ?? u.id : u.id, ms: t.total, scope: world.pit ? world.id : undefined });
    }
    return t;
  }

  function closeTurn(t, reason = 'done') {
    if (t.done) return;
    t.done = true;
    turns.delete(t.unitId);
    if (t.local) {
      player.myTurn = false;
      player.applySpeed();
      hook('onTurnEnd', { unitId: t.unitId, reason });
    } else if (net && t.pid) net.send(t.pid, { t: 'turn_end', unitId: t.unitId, reason });
    t.resolve(reason);
  }

  async function doAct(t, action) {
    if (!t || t.done) return { ok: false, error: 'Not your turn' };
    if (t.busy) return { ok: false, error: 'Busy' };
    if (!action || typeof action.type !== 'string') return { ok: false, error: 'Unknown action' };
    const st = t.world.state;
    let r;
    try { r = G.act(st, t.unitId, action); } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
    if (!r || !r.ok) return { ok: false, error: r?.error || 'Not possible', events: [] };
    t.busy = true;
    t.busyAt = performance.now();
    const p = emit(r.events, t.world.pit ? t.world : null);
    const u = st.units[t.unitId];
    const finished = !standing(u) || u.ap <= 0 || st.winner !== null;
    if (t.local) {
      await p;
      t.busy = false;
      if (finished) closeTurn(t);
    } else {
      // remote: the clock stays frozen until the client reports its playback finished ('idle')
      t.remoteBusyUntil = performance.now() + REMOTE_BUSY_CAP_MS;
      if (finished) closeTurn(t);
    }
    return { ok: true, events: r.events };
  }

  async function autoOverwatch(t, reason = 'timeout') {
    if (t.done || t.autoing) return;
    t.autoing = true;
    t.busy = false;
    if (t.local) { hook('onStatus', reason === 'timeout' ? 'Time! Auto-overwatch.' : 'Auto-overwatch', 'warn'); }
    const u = t.world.state.units[t.unitId];
    let r = u && u.ap > 0 ? await doAct(t, { type: 'overwatch' }) : { ok: false };
    if (!r.ok && !t.done) r = await doAct(t, { type: 'hold' });
    if (!t.done) closeTurn(t, reason);
  }

  function tick() {
    const now = performance.now();
    for (const t of [...turns.values()]) {
      if (t.done) continue;
      if (!t.local) {
        if (net && !net.isConnected(t.pid)) { autoOverwatch(t, 'disconnected'); continue; }
        if (!t.acked) {
          if (now - t.openedAt > ACK_BACKSTOP_MS) { t.acked = true; t.deadline = now + t.total; }
          continue;
        }
        if (t.busy) {
          const dt = now - (t.busyAt || now);
          t.deadline += dt; t.busyAt = now;
          if (now > (t.remoteBusyUntil || 0)) t.busy = false;
          continue;
        }
      } else {
        if (t.paused) { t.deadline += now - t.paused; t.paused = now; }
        if (t.busy) { t.deadline += now - (t.busyAt || now); t.busyAt = now; }
        const left = Math.max(0, (t.deadline - now) / 1000);
        const whole = Math.ceil(left);
        if (whole !== t.lastTick) {
          t.lastTick = whole;
          if (whole <= 5 && whole > 0) sfx?.tick?.(true);
          else if (whole <= 10 && whole > 0) sfx?.tick?.(false);
        }
        hook('onTick', { unitId: t.unitId, left, total: t.total / 1000, deadline: t.deadline });
      }
      if (now >= t.deadline && !t.busy && !t.paused && !opts.noTimer) autoOverwatch(t, 'timeout');
    }
  }

  // ---------------------------------------------------------------- the loop

  const humanIn = (id) => humans.has(id);

  async function playSquadStep(world, active) {
    const st = world.state;
    // Bots act first (visible ones animate, invisible ones resolve instantly), then human turns open.
    for (const t of active) {
      for (const id of st.teams[t].members) {
        if (stopped || st.winner !== null) return;
        const u = st.units[id];
        if (!standing(u) || world.isHuman(id)) continue;
        if (kind === 'local' && !player.ff) while (globalThis.document?.hidden && !stopped) await sleep(400);
        let evs = [];
        try { evs = AI.botTakeTurn(st, id) || []; } catch (e) { console.warn('[match] bot', e); }
        const shown = await emit(evs, world.pit ? world : null);
        if (shown) await player.delay(player.botSpeed === 'normal' ? 220 : 120);
      }
    }
    if (stopped || st.winner !== null) return;
    const open = new Map(); // team → [turn]
    for (const t of active) {
      const list = [];
      for (const id of st.teams[t].members) {
        const u = st.units[id];
        if (world.isHuman(id) && standing(u) && u.ap > 0) list.push(openTurn(u, world));
      }
      open.set(t, list);
    }
    // Each squad ends when its humans are done; bot-only squads end right away.
    await Promise.all([...open].map(async ([t, list]) => {
      await Promise.all(list.map((x) => x.closed));
      if (stopped || st.winner !== null) return;
      const evs = world.model.endTeam(st, t);
      await emit(evs, world.pit ? world : null);
    }));
  }

  function stepHook(active) {
    const sig = `${state.round}|${active.join(',')}`;
    if (sig === lastActiveSig) return;
    lastActiveSig = sig;
    const eng = model.engagements(state);
    hook('onStep', { active: [...active], engagements: eng, round: state.round });
    if (net) {
      for (const [pid, c] of clients) {
        net.send(pid, { t: 'step', active: active.filter((x) => x === c.team || eng.some((g) => g.includes(c.team) && g.includes(x))), activeCount: active.length, engagements: eng.filter((g) => g.includes(c.team)), round: state.round });
      }
    }
  }

  const mainWorld = () => ({ id: 'main', state, model, isHuman: humanIn, pit: null });

  async function run() {
    running = true;
    player.applySpeed();
    await emit(state.startEvents || []);
    let guard = 0;
    while (!stopped && state.winner === null && guard++ < 100000) {
      const active = model.active(state);
      if (!active.length) break;
      stepHook(active);
      await runPit();
      if (stopped || state.winner !== null) break;
      const before = `${state.round}|${state.turnPos}|${state.turnSerial}|${active}`;
      await playSquadStep(mainWorld(), active);
      if (stopped) return;
      updateSpectating();
      // Safety: the sim must advance after every active squad ended.
      if (state.winner === null && `${state.round}|${state.turnPos}|${state.turnSerial}|${model.active(state)}` === before) {
        console.warn('[match] sim did not advance; forcing');
        for (const t of model.active(state)) await emit(model.endTeam(state, t));
      }
      if (player.ff) await sleep(0); else await player.delay(60);
    }
    if (stopped) return;
    await player.idle();
    finish();
  }

  function updateSpectating() {
    if (!state) return;
    const me = state.units[myUnitId];
    const spec = view.state === state && (!me || !me.alive); // in my Pit duel I'm playing, not spectating
    if (spec !== player.spectating) { player.spectating = spec; player.applySpeed(); hook('onState'); }
  }

  function summaryFor(team, unitId) {
    const place = state.winner === team ? 1 : placeByTeam.get(team) ?? null;
    const u = state.units[unitId];
    return {
      winner: state.winner, myTeam: team, myUnitId: unitId, place, round: state.round, squads: state.teams.length,
      kills: u?.kills ?? 0, alive: !!u?.alive, names: names(), reason: 'over',
    };
  }

  function finish() {
    if (over) return;
    over = true;
    clearInterval(timer);
    if (player.ff) Rcall('syncFromState');
    if (net) {
      for (const [pid, c] of clients) net.send(pid, { t: 'over', summary: summaryFor(c.team, c.unitId) });
      net.endMatch?.();
    }
    summary = summaryFor(myTeam, myUnitId);
    hook('onMatchEnd', summary);
    endResolve?.(summary);
  }

  // ---------------------------------------------------------------- The Pit (feature-detected; SIM-2)

  async function runPit() {
    if (typeof G.pitDuels !== 'function' || !state.pit) return;
    let duels = [];
    try { duels = G.pitDuels(state) || []; } catch { return; }
    for (const d of duels) {
      if (stopped) return;
      if (!d?.state || d.done || (d.state.winner !== null && d.state.winner !== undefined)) continue;
      const humanIn = [d.a, d.b].some((id) => Number.isInteger(id) && humans.has(id));
      if (!humanIn) continue;
      // A human whose client is gone can't play it: the sim auto-plays it below.
      if ([d.a, d.b].every((id) => !humans.has(id) || (!humans.get(id).local && net && !net.isConnected(humans.get(id).pid)))) continue;
      await runDuel(d);
    }
    try {
      // Bot-only duels (and humans who can't play theirs), then collect finished duels.
      const lost = [...humans].some(([, h]) => !h.local && net && !net.isConnected(h.pid));
      const evs = G.resolvePitBots?.(state, { humans: lost }) || [];
      if (evs.length) await emit(evs);
      const more = G.settlePit?.(state) || [];
      if (more.length) await emit(more);
    } catch (e) { console.warn('[match] resolvePitBots', e); }
  }

  async function runDuel(d) {
    const ds = d.state;
    const dm = turnModel(G);
    // duel.units maps main unit id → duel unit id; the Warden maps to nobody.
    const back = new Map(Object.entries(d.units || {}).map(([m, du]) => [du, +m]));
    const mainOf = (id) => (back.has(id) ? back.get(id) : ds.units[id]?.srcId ?? null);
    const duelOf = (mainId) => (d.units && d.units[mainId] !== undefined ? d.units[mainId] : (G.duelUnitFor?.(d, mainId)?.id ?? -1));
    const world = {
      id: 'pit:' + d.id, state: ds, model: dm, pit: d,
      isHuman: (id) => { const m = mainOf(id); return m !== null && humans.has(m); },
      humanOf: (id) => mainOf(id),
    };
    const iAmIn = humans.get(d.a)?.local || humans.get(d.b)?.local;
    const myDuelId = iAmIn ? duelOf(myUnitId) : -1;
    for (const [pid, c] of clients) {
      if (c.unitId !== d.a && c.unitId !== d.b) continue;
      const did = duelOf(c.unitId);
      c.scope = { id: world.id, state: ds, unitId: did, mem: createTeamMemory(ds, ds.units[did]?.team ?? -1) };
      const { snap } = teamView(ds, [], c.scope.mem, { myUnitId: did });
      net.send(pid, { t: 'pit', phase: 'start', scope: world.id, duelId: d.id, unitId: did, team: ds.units[did]?.team, snap, a: d.a, b: d.b, warden: !!d.warden });
    }
    if (iAmIn) {
      player.ff = false; // skipped while waiting in the Pit queue: my own duel (and redeploy) plays for real
      await player.idle();
      view.state = ds; view.team = ds.units[myDuelId]?.team ?? -1;
      Rcall('setGame', ds, view.team, { cosmetics: {} });
      Rcall('setSpectator', false);
      updateSpectating();
    }
    hook('onPit', { phase: 'start', duelId: d.id, duelState: ds, a: d.a, b: d.b, warden: !!d.warden, mine: !!iAmIn, myDuelUnitId: myDuelId });
    if (ds.startEvents?.length) { await emit(ds.startEvents, world); ds.startEvents = []; }
    let guard = 0;
    while (!stopped && (ds.winner === null || ds.winner === undefined) && guard++ < 500) {
      const active = dm.active(ds);
      if (!active.length) break;
      await playSquadStep(world, active);
    }
    if (stopped) return;
    if (ds.winner === null || ds.winner === undefined) { try { G.resolvePitBots?.(state, { humans: true }); } catch { /* ignore */ } }
    const winnerMain = Number.isInteger(ds.winner) ? mainOf(ds.units.find((u) => u.team === ds.winner)?.id) : null;
    for (const [pid, c] of clients) {
      if (c.scope?.id !== world.id) continue;
      const won = Number.isInteger(ds.winner) && ds.units[c.scope.unitId]?.team === ds.winner;
      c.scope = null;
      net.send(pid, { t: 'pit', phase: 'end', scope: world.id, duelId: d.id, winner: ds.winner, won });
    }
    const myWon = iAmIn && Number.isInteger(ds.winner) && ds.units[myDuelId]?.team === ds.winner;
    if (iAmIn) {
      await player.idle();
      view.state = state; view.team = myTeam;
      Rcall('setGame', state, myTeam, { cosmetics: cosmetics() });
      Rcall('syncFromState');
    }
    // pit_result (and the loser's team_out) arrive on the main stream; the redeploy at next round start.
    try { const evs = G.settlePit?.(state) || []; if (evs.length) await emit(evs); } catch (e) { console.warn('[match] settlePit', e); }
    updateSpectating();
    hook('onPit', { phase: 'end', duelId: d.id, duelState: ds, winner: ds.winner, winnerUnitId: winnerMain, won: !!myWon, mine: !!iAmIn });
  }

  // ---------------------------------------------------------------- net wiring (host)

  function wireNet() {
    offs.push(net.onMessage((pid, m) => {
      const c = clients.get(pid);
      if (!c) return;
      const t = [...turns.values()].find((x) => x.pid === pid && !x.done);
      switch (m.t) {
        case 'act': {
          if (!t) { net.send(pid, { t: 'result', seq: m.seq, ok: false, error: 'Not your turn' }); return; }
          const action = m.action && typeof m.action === 'object' ? { ...m.action } : null;
          doAct(t, action).then((r) => net.send(pid, { t: 'result', seq: m.seq, ok: r.ok, error: r.error }));
          return;
        }
        case 'end':
          if (t && !t.busy) doAct(t, { type: 'hold' }).then(() => { if (!t.done) closeTurn(t, 'ended'); });
          else if (t) setTimeout(() => { if (!t.done) doAct(t, { type: 'hold' }).then(() => { if (!t.done) closeTurn(t, 'ended'); }); }, 300);
          return;
        case 'turn_ack': if (t && !t.acked) { t.acked = true; t.deadline = performance.now() + t.total; } return;
        case 'idle': if (t) { t.busy = false; } return;
        case 'resync': sendResync(pid); return;
        default:
      }
    }));
    offs.push(net.on('rejoin', (pid) => { if (clients.has(pid) && running) sendResync(pid); }));
    offs.push(net.on('disconnect', (pid) => {
      const name = net.player(pid)?.name || 'A player';
      hook('onStatus', `${name} disconnected. Their unit holds overwatch for up to 60 s.`, 'warn');
    }));
    offs.push(net.on('gone', (pid) => {
      const c = clients.get(pid);
      if (!c) return;
      humans.delete(c.unitId);
      clients.delete(pid);
      hook('onStatus', `${net.player(pid)?.name || 'A player'} left. A bot takes over.`, 'warn');
      const t = turns.get(c.unitId);
      if (t) autoOverwatch(t, 'left');
    }));
    offs.push(net.on('status', (msg, level) => hook('onStatus', msg, level)));
  }

  function sendResync(pid) {
    const c = clients.get(pid);
    if (!c) return;
    net.send(pid, startMsg(pid));
    if (over) { net.send(pid, { t: 'over', summary: summaryFor(c.team, c.unitId) }); return; }
    const t = turns.get(c.unitId);
    if (t && !t.done) {
      const left = t.acked ? Math.max(1000, t.deadline - performance.now()) : t.total;
      net.send(pid, { t: 'turn', unitId: c.unitId, ms: left });
    }
  }

  // ---------------------------------------------------------------- public API

  if (kind === 'host') setupHost(); else setupSolo();
  view.state = state; view.team = myTeam;

  const api = {
    kind,
    get state() { return state; },
    get view() { return view.state; },
    get myTeam() { return myTeam; },
    get myUnitId() { return myUnitId; },
    get over() { return over; },
    get summary() { return summary; },
    get speed() { return player.spec; },
    get fastForwarding() { return player.ff; },
    get spectating() { return player.spectating; },
    get turn() {
      const t = turns.get(myUnitId) || [...turns.values()].find((x) => x.local);
      return t ? { unitId: t.unitId, deadline: t.deadline, total: t.total, busy: t.busy, left: Math.max(0, (t.deadline - performance.now()) / 1000) } : null;
    },
    /** Names of human players by unit id (bots use unit.name). */
    get names() { return names(); },
    /** Human players: [{unitId, pid, name, team, connected, local}] */
    get players() {
      return [...humans].map(([id, h]) => ({ unitId: id, pid: h.pid, name: h.name, team: state.units[id].team, local: h.local, connected: h.local || !net || net.isConnected(h.pid) }));
    },
    set follow(on) { player.follow = !!on; },
    set botSpeed(v) { player.botSpeed = v; player.applySpeed(); },

    start() {
      if (running) return api.done;
      Rcall('setGame', state, myTeam, { cosmetics: cosmetics() });
      Rcall('setSpectator', false);
      Rcall('setFollow', null);
      if (net) {
        net.beginMatch?.();
        for (const pid of clients.keys()) net.send(pid, startMsg(pid));
        wireNet();
      }
      timer = setInterval(tick, 100);
      const intro = Promise.resolve(hook('onIntro', api)).catch(() => {});
      intro.then(() => { if (!stopped) run().catch((e) => { console.error('[match] loop', e); hook('onStatus', 'Match error: ' + (e?.message || e), 'error'); }); });
      return api.done;
    },
    done: null,

    /** The local player's action. Resolves after its events have played. */
    act(action) {
      const t = [...turns.values()].find((x) => x.local);
      if (!t) return Promise.resolve({ ok: false, error: 'Not your turn' });
      return doAct(t, action);
    },
    endTurn() {
      const t = [...turns.values()].find((x) => x.local);
      if (!t || t.busy) return Promise.resolve({ ok: false, error: t ? 'Busy' : 'Not your turn' });
      return doAct(t, { type: 'hold' }).then((r) => { if (!t.done) closeTurn(t, 'ended'); return r; });
    },
    /** Pause my clock (solo only; online clocks never stop). Returns true if paused. */
    pause() { if (kind !== 'local') return false; const t = [...turns.values()].find((x) => x.local); if (t && !t.paused) t.paused = performance.now(); return !!t; },
    resume() { const t = [...turns.values()].find((x) => x.local); if (t) t.paused = 0; },
    setSpeed(x) {
      player.spec = SPEC_SPEEDS.includes(x) ? x : 2;
      player.applySpeed();
      return player.spec;
    },
    /** Skip the remaining animations (spectating). Online, other players' turns still run at their pace. */
    fastForward() {
      const me = state.units[myUnitId];
      if (me && me.alive) return false; // only once out of the match (spectating)
      player.ff = true;
      return true;
    },
    leave(reason = 'left') {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      player.stop();
      for (const t of [...turns.values()]) { t.done = true; t.resolve('left'); }
      turns.clear();
      for (const off of offs) { try { off(); } catch { /* ignore */ } }
      if (net && kind === 'host') net.close?.('host_left', 'The host left the match.');
      endResolve?.(summary || { reason, place: null, winner: state?.winner ?? null });
    },
    /** Debug/test helpers */
    _debug: { turns, humans, clients, player, get stateRef() { return state; } },
  };
  api.done = new Promise((r) => { endResolve = r; });
  return api;
}
