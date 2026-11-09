// Online sessions: the lobby roster, heartbeats, reconnects and kicks, on top of a transport.
// The match itself (sim, redaction, turns) lives in src/client/match/; it talks through
// host.send / host.onMessage and client.send / client.onMessage.
//
// Protocol (all messages are JSON objects with a `t` field; see docs in src/net/index.js):
//   client → host: hello, profile, ready, squad, leave, pong, act, end, turn_ack, idle, resync
//   host → client: welcome, lobby, kicked, closed, ping, start, batch, turn, turn_end, result, status, over

import { makeCode, normalizeCode, token } from './codes.js';
import { openTransport, transportKind } from './transport.js';
import { encode, decode, PROTO } from './wire.js';
import { createLiveness, backoff, HEARTBEAT_MS, DEAD_MS, PROBE_MS } from './liveness.js';
import { every } from './ticker.js';

export { HEARTBEAT_MS, DEAD_MS };
export const MAX_PLAYERS = 16;
export const RECONNECT_MS = 120000; // the host holds a dropped player's slot this long (auto-overwatch meanwhile)
export const CLIENT_GIVEUP_MS = 240000; // a client keeps trying to get back this long before giving up
const TEAM_SIZE = { solos: 1, duos: 2, trios: 3, quads: 4 };

/** Squad slots for a mode, matching the sim's team layout (16 players; trios: 5 trios + a lone wolf). */
export function squadSizes(mode, total = MAX_PLAYERS) {
  const n = TEAM_SIZE[mode] || 1;
  const sizes = [];
  for (let i = 0; i < Math.floor(total / n); i++) sizes.push(n);
  if (total % n) sizes.push(total % n);
  return sizes;
}

function emitter() {
  const m = new Map();
  return {
    on(ev, fn) { if (!m.has(ev)) m.set(ev, new Set()); m.get(ev).add(fn); return () => m.get(ev)?.delete(fn); },
    emit(ev, ...a) { for (const f of [...(m.get(ev) || [])]) { try { f(...a); } catch (e) { console.warn('[net]', ev, e); } } },
  };
}

const cleanName = (s) => String(s || '').replace(/[^\p{L}\p{N} _.\-']/gu, '').trim().slice(0, 16) || 'Player';
const cleanProfile = (p = {}) => ({
  name: cleanName(p.name),
  cls: typeof p.cls === 'string' ? p.cls.slice(0, 16) : 'assault',
  tier: Math.max(0, Math.min(4, p.tier | 0)),
  level: Math.max(0, Math.min(1000, p.level | 0)),
  loadout: p.loadout && typeof p.loadout === 'object' ? p.loadout : null,
  cosmetics: p.cosmetics && typeof p.cosmetics === 'object' ? p.cosmetics : null,
  card: p.card ?? null, emblem: p.emblem ?? null,
});

// ================================================================== host

/**
 * Host a lobby. profile: {name, cls, tier, loadout, cosmetics}. settings: {mode, stage}.
 * Resolves once the code is registered with the broker (or loopback).
 */
export async function hostSession({ profile, settings = {}, kind = transportKind(), code = null, liveness = {} } = {}) {
  const T = await openTransport(kind);
  let endpoint = null;
  for (let i = 0; i < 6 && !endpoint; i++) {
    const c = code || makeCode();
    try { endpoint = await T.host(c); code = c; } catch (e) { if (e.code !== 'taken' || i === 5) throw e; code = null; }
  }
  const ev = emitter();
  const hostPid = 'H';
  const players = new Map(); // pid → player
  const conns = new Map(); // pid → conn
  const tokens = new Map(); // token → pid
  const banned = new Set();
  const deadMs = liveness.deadMs ?? DEAD_MS;
  const holdMs = liveness.holdMs ?? RECONNECT_MS;
  const live = createLiveness({ deadMs });
  let nextPid = 1;
  let closed = false;
  let inMatch = false;
  const st = { mode: settings.mode || 'solos', stage: settings.stage || 'random' };

  const me = { pid: hostPid, ...cleanProfile(profile), ready: true, squad: 0, connected: true, isHost: true, token: null };
  players.set(hostPid, me);

  const publicLobby = () => ({
    code, hostPid, inMatch, settings: { ...st }, sizes: squadSizes(st.mode),
    players: [...players.values()].map((p) => ({
      pid: p.pid, name: p.name, cls: p.cls, tier: p.tier, level: p.level, ready: p.ready, squad: p.squad,
      connected: p.connected, isHost: !!p.isHost, card: p.card, emblem: p.emblem, ping: p.ping ?? null,
    })),
  });
  const sendTo = (pid, msg) => { const c = conns.get(pid); return c ? c.send(encode(msg)) : false; };
  const broadcastLobby = () => {
    const lobby = publicLobby();
    for (const pid of conns.keys()) sendTo(pid, { t: 'lobby', lobby });
    ev.emit('lobby', lobby);
  };

  function freeSquad(prefer = -1) {
    const sizes = squadSizes(st.mode);
    const count = (s) => [...players.values()].filter((p) => p.squad === s).length;
    if (prefer >= 0 && prefer < sizes.length && count(prefer) < sizes[prefer]) return prefer;
    // Fill squads that already have humans first (friends together), then empty ones.
    for (let s = 0; s < sizes.length; s++) if (count(s) > 0 && count(s) < sizes[s]) return s;
    for (let s = 0; s < sizes.length; s++) if (count(s) < sizes[s]) return s;
    return -1;
  }
  function reflowSquads() {
    // After a mode change: re-seat everyone in join order, filling squads that already have
    // humans first, so friends end up together (Solos → Duos puts the first two in Squad 1).
    for (const p of players.values()) p.squad = -1;
    for (const p of players.values()) p.squad = freeSquad();
  }

  function attach(conn) {
    let pid = null;
    const timeout = setTimeout(() => { if (!pid) conn.close(); }, 8000);
    conn.onMessage((raw) => {
      const m = decode(raw);
      if (!m || typeof m.t !== 'string') return;
      if (pid) {
        live.seen(pid);
        // Silent for a while but the same connection is talking again: back in, no reconnect needed.
        const sp = players.get(pid);
        if (sp && !sp.connected && !sp.left && conns.get(pid) === conn) revive(pid);
      }
      if (!pid) {
        if (m.t !== 'hello') return;
        clearTimeout(timeout);
        if (m.v !== PROTO) { conn.send(encode({ t: 'closed', reason: 'version', msg: 'This game is on a different version. Refresh both devices.' })); setTimeout(() => conn.close(), 200); return; }
        // Reconnect with a token?
        const back = m.token && tokens.get(m.token);
        if (back && players.has(back) && !players.get(back).left) {
          if (banned.has(back)) { conn.send(encode({ t: 'kicked', reason: 'You were removed from this lobby.' })); setTimeout(() => conn.close(), 200); return; }
          pid = back;
          const old = conns.get(pid);
          if (old && old !== conn) { conns.delete(pid); old.close(); }
          const p = players.get(pid);
          const wasOut = !p.connected;
          p.connected = true; p.goneAt = 0; p.expired = false;
          conns.set(pid, conn);
          live.seen(pid);
          conn.send(encode({ t: 'welcome', pid, token: m.token, lobby: publicLobby(), rejoin: true }));
          broadcastLobby();
          ev.emit('rejoin', pid);
          if (wasOut) ev.emit('status', `${p.name} is back`, 'ok');
          return;
        }
        if (inMatch) { conn.send(encode({ t: 'closed', reason: 'started', msg: 'That match has already started.' })); setTimeout(() => conn.close(), 200); return; }
        if (players.size >= MAX_PLAYERS) { conn.send(encode({ t: 'closed', reason: 'full', msg: 'That lobby is full.' })); setTimeout(() => conn.close(), 200); return; }
        const squad = freeSquad();
        if (squad < 0) { conn.send(encode({ t: 'closed', reason: 'full', msg: 'That lobby is full.' })); setTimeout(() => conn.close(), 200); return; }
        pid = 'P' + nextPid++;
        const tok = token();
        tokens.set(tok, pid);
        players.set(pid, { pid, ...cleanProfile(m.profile), ready: false, squad, connected: true, isHost: false, token: tok });
        conns.set(pid, conn);
        live.seen(pid);
        conn.send(encode({ t: 'welcome', pid, token: tok, lobby: publicLobby() }));
        broadcastLobby();
        ev.emit('join', pid);
        ev.emit('status', `${players.get(pid).name} joined`, 'ok');
        return;
      }
      const p = players.get(pid);
      if (!p) return;
      switch (m.t) {
        case 'pong': p.ping = Math.max(0, Date.now() - (m.ts || Date.now())); break;
        case 'ping': conn.send(encode({ t: 'pong', ts: m.ts })); break;
        case 'profile': if (!inMatch) { Object.assign(p, cleanProfile({ ...p, ...m.profile })); broadcastLobby(); } break;
        case 'ready': if (!inMatch) { p.ready = !!m.on; broadcastLobby(); } break;
        case 'squad': {
          if (inMatch) break;
          const s = m.squad | 0;
          const sizes = squadSizes(st.mode);
          if (s >= 0 && s < sizes.length && [...players.values()].filter((o) => o.squad === s && o !== p).length < sizes[s]) { p.squad = s; broadcastLobby(); }
          break;
        }
        case 'leave': drop(pid, 'left', true); break;
        default: ev.emit('message', pid, m);
      }
    });
    conn.onClose(() => { if (pid && conns.get(pid) === conn) drop(pid, 'lost', false); });
  }

  /** A player's connection is gone. `final`: they left on purpose (no reconnect window). */
  function drop(pid, why, final) {
    const p = players.get(pid);
    if (!p) return;
    const c = conns.get(pid);
    conns.delete(pid);
    if (c && !c.closed) c.close();
    if (final || !inMatch && why === 'kicked') {
      if (inMatch) { p.connected = false; p.goneAt = Date.now() - RECONNECT_MS; p.left = true; ev.emit('gone', pid, why); }
      else players.delete(pid);
      ev.emit('status', `${p.name} ${why === 'kicked' ? 'was removed' : 'left'}`, 'warn');
    } else if (p.connected) {
      p.connected = false;
      p.goneAt = Date.now();
      ev.emit('status', `${p.name} lost connection. Holding their slot for ${Math.round(holdMs / 1000)} s.`, 'warn');
      ev.emit('disconnect', pid);
    }
    broadcastLobby();
  }

  /** Nothing heard for deadMs: mark them away (their unit auto-overwatches) but keep the connection
   *  open — a phone that was only backgrounded resumes on the same channel. */
  function softDrop(pid) {
    const p = players.get(pid);
    if (!p || !p.connected) return;
    p.connected = false;
    p.goneAt = Date.now();
    ev.emit('status', `${p.name} is not responding. Holding their slot for ${Math.round(holdMs / 1000)} s.`, 'warn');
    ev.emit('disconnect', pid);
    broadcastLobby();
  }
  function revive(pid) {
    const p = players.get(pid);
    if (!p) return;
    p.connected = true; p.goneAt = 0; p.expired = false;
    broadcastLobby();
    ev.emit('rejoin', pid);
    ev.emit('status', `${p.name} is back`, 'ok');
  }

  endpoint.onConnection(attach);

  // Heartbeat: a worker-driven tick (not clamped like main-thread timers in a background tab).
  // If OUR tick was late (host page frozen / CPU-starved), nobody gets blamed for the silence.
  const beat = () => {
    if (closed) return;
    const { frozen } = live.tick();
    const now = Date.now();
    for (const [pid, c] of [...conns]) {
      c.send(encode({ t: 'ping', ts: now }));
      const p = players.get(pid);
      if (!p || frozen) continue;
      if (p.connected && live.dead(pid)) softDrop(pid);
      else if (!p.connected && live.silence(pid) > deadMs + holdMs) { conns.delete(pid); c.close(); }
    }
    for (const p of [...players.values()]) {
      if (p.isHost || p.connected || !p.goneAt) continue;
      if (now - p.goneAt >= holdMs) {
        if (inMatch) { if (!p.expired) { p.expired = true; ev.emit('gone', p.pid, 'timeout'); } }
        else { players.delete(p.pid); conns.get(p.pid)?.close(); conns.delete(p.pid); broadcastLobby(); }
      }
    }
  };
  const stopBeat = every(liveness.heartbeatMs ?? HEARTBEAT_MS, beat);
  const onVisible = () => { if (globalThis.document?.visibilityState !== 'hidden') { live.grace(); beat(); } };
  globalThis.document?.addEventListener?.('visibilitychange', onVisible);
  globalThis.addEventListener?.('pageshow', onVisible);

  const close = (reason = 'host_left', msg = 'The host closed the game.') => {
    if (closed) return;
    closed = true;
    stopBeat();
    globalThis.document?.removeEventListener?.('visibilitychange', onVisible);
    globalThis.removeEventListener?.('pageshow', onVisible);
    globalThis.removeEventListener?.('pagehide', onUnload);
    for (const [pid, c] of conns) { c.send(encode({ t: 'closed', reason, msg })); setTimeout(() => c.close(), 120); void pid; }
    setTimeout(() => endpoint.close(), 200);
    ev.emit('closed', reason);
  };
  // A real unload ends the game; a page put in the back/forward cache (persisted) may come back.
  const onUnload = (e) => { if (!e?.persisted) close('host_left', 'The host left the game.'); };
  globalThis.addEventListener?.('pagehide', onUnload);

  const api = {
    kind: 'host',
    transport: T.kind,
    get code() { return code; },
    get pid() { return hostPid; },
    get lobby() { return publicLobby(); },
    get inMatch() { return inMatch; },
    get closed() { return closed; },
    players: () => [...players.values()].map((p) => ({ ...p, token: undefined })),
    player: (pid) => players.get(pid) || null,
    isConnected: (pid) => pid === hostPid || !!players.get(pid)?.connected,
    on: ev.on,
    onMessage: (fn) => ev.on('message', fn),
    send: (pid, msg) => sendTo(pid, msg),
    broadcast(fnOrMsg) { for (const pid of conns.keys()) sendTo(pid, typeof fnOrMsg === 'function' ? fnOrMsg(pid) : fnOrMsg); },
    setSettings(s = {}) {
      if (inMatch) return;
      if (s.mode && TEAM_SIZE[s.mode]) { st.mode = s.mode; reflowSquads(); }
      if (s.stage) st.stage = String(s.stage);
      broadcastLobby();
    },
    setSquad(pid, squad) {
      const p = players.get(pid);
      const sizes = squadSizes(st.mode);
      if (!p || inMatch || squad < 0 || squad >= sizes.length) return false;
      const others = [...players.values()].filter((o) => o.squad === squad && o !== p);
      if (others.length >= sizes[squad]) {
        // Full: swap with the last one there.
        const o = others[others.length - 1];
        o.squad = p.squad;
      }
      p.squad = squad;
      broadcastLobby();
      return true;
    },
    updateProfile(pr) { Object.assign(me, cleanProfile({ ...me, ...pr })); broadcastLobby(); },
    kick(pid) {
      if (pid === hostPid || !players.has(pid)) return;
      banned.add(pid);
      sendTo(pid, { t: 'kicked', reason: 'The host removed you from the lobby.' });
      setTimeout(() => drop(pid, 'kicked', true), 150);
    },
    canStart() {
      const ps = [...players.values()];
      const notReady = ps.filter((p) => !p.isHost && p.connected && !p.ready);
      if (notReady.length) return { ok: false, reason: `Waiting for ${notReady.map((p) => p.name).join(', ')} to ready up` };
      return { ok: true };
    },
    /** Mark the lobby as in a match: joins close, reconnects keep working. */
    beginMatch() { inMatch = true; broadcastLobby(); },
    endMatch() { inMatch = false; for (const p of players.values()) { if (!p.isHost) p.ready = false; } for (const [pid, p] of players) if (!p.connected && !p.isHost) players.delete(pid); broadcastLobby(); },
    close(reason, msg) { close(reason, msg); },
    /** Test hook: the host disappears without a goodbye (crash, phone died). */
    _vanish() { closed = true; stopBeat(); endpoint.close(); },
    /** Test hook: how long since pid was last heard from. */
    _silence: (pid) => live.silence(pid),
  };
  return api;
}

// ================================================================== client

const SESSION_KEY = 'tidefall.net.session';
function saveSession(s) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* ignore */ } }
export function savedSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } }
export function clearSavedSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } }

/**
 * Join a lobby by code. Resolves after the host's welcome.
 * Robustness: any message is proof of life; after DEAD_MS of silence, or a closed channel, the
 * client rejoins with its token automatically (backoff, no user action) for CLIENT_GIVEUP_MS.
 * Coming back to the page (visibilitychange / pageshow / focus) or the network (online) probes the
 * link at once and reconnects if it is dead. Events: lobby, message, status(msg, level),
 * connection(bool), reconnecting({since, attempt}), closed({reason, msg, retry?}).
 */
export async function joinSession({ code, profile, kind = transportKind(), token: tok = null, liveness = {} } = {}) {
  const c = normalizeCode(code);
  if (!c) throw Object.assign(new Error('That code is not valid'), { code: 'bad_code' });
  const T = await openTransport(kind);
  const ev = emitter();
  const deadMs = liveness.deadMs ?? DEAD_MS;
  const probeMs = liveness.probeMs ?? PROBE_MS;
  const giveUpMs = liveness.giveUpMs ?? CLIENT_GIVEUP_MS;
  const live = createLiveness({ deadMs });
  let conn = null;
  let pid = null;
  let lobby = null;
  let closed = false;
  let reconnecting = false;
  let reconnectSince = 0;
  let attempt = 0;
  let probe = null; // {until, since}: after a resume, wait this long for any message
  let wakeNap = null;
  let prof = cleanProfile(profile);
  let myToken = tok || (savedSession()?.code === c ? savedSession().token : null);
  // Match messages that arrive before a match controller subscribes (from 'start' on) are kept here.
  let backlogOn = true;
  let backlog = [];

  const send = (msg) => (conn && !conn.closed ? conn.send(encode(msg)) : false);
  const FATAL = new Set(['kicked', 'started', 'version', 'full', 'host_left', 'closed']);

  async function connectOnce() {
    const cn = await T.connect(c);
    let ok = false;
    try {
      const welcome = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(Object.assign(new Error('The host did not answer'), { code: 'timeout' })), 10000);
        cn.onMessage((raw) => {
          const m = decode(raw);
          if (!m) return;
          if (conn && conn !== cn && ok) return; // superseded
          live.seen('host');
          if (probe) probe = null;
          if (m.t === 'welcome') { clearTimeout(t); resolve(m); return; }
          if (m.t === 'closed' || m.t === 'kicked') { clearTimeout(t); reject(Object.assign(new Error(m.msg || m.reason), { code: m.t === 'kicked' ? 'kicked' : m.reason || 'closed' })); }
          handle(m);
        });
        cn.onClose(() => { clearTimeout(t); reject(Object.assign(new Error('Connection closed'), { code: 'network' })); });
      });
      cn.send(encode({ t: 'hello', v: PROTO, profile: prof, token: myToken }));
      const w = await welcome;
      ok = true;
      const old = conn;
      conn = cn;
      if (old && old !== cn) old.close();
      pid = w.pid;
      myToken = w.token;
      lobby = w.lobby;
      saveSession({ code: c, token: myToken, pid, at: Date.now() });
      cn.onClose(() => { if (conn === cn) lost('closed'); });
      ev.emit('lobby', lobby);
      if (w.rejoin) ev.emit('rejoin', w);
      return w;
    } finally {
      if (!ok) cn.close();
    }
  }

  function handle(m) {
    switch (m.t) {
      case 'ping': send({ t: 'pong', ts: m.ts }); return;
      case 'pong': return;
      case 'lobby': lobby = m.lobby; ev.emit('lobby', lobby); return;
      case 'kicked': end({ reason: 'kicked', msg: m.reason || 'You were removed from the lobby.' }, true); return;
      case 'closed': end({ reason: m.reason || 'host_left', msg: m.msg || 'The host left the game.' }, true); return;
      default:
        if (backlogOn) { if (m.t === 'start') backlog = []; backlog.push(m); }
        ev.emit('message', m);
    }
  }

  function end(info, forget) {
    if (closed) return;
    closed = true;
    stopBeat();
    unlisten();
    if (forget) clearSavedSession();
    const cn = conn; conn = null;
    cn?.close();
    T.dispose?.();
    ev.emit('closed', info);
  }

  const nap = (ms) => new Promise((r) => { const t = setTimeout(() => { wakeNap = null; r(); }, ms); wakeNap = () => { clearTimeout(t); wakeNap = null; r(); }; });

  async function lost(why = 'silent') {
    if (closed || reconnecting) return;
    reconnecting = true;
    reconnectSince = Date.now();
    attempt = 0;
    probe = null;
    const old = conn; conn = null;
    old?.close();
    ev.emit('status', 'Connection lost. Reconnecting…', 'warn');
    ev.emit('connection', false);
    ev.emit('reconnecting', { since: reconnectSince, attempt, why });
    while (!closed && Date.now() - reconnectSince < giveUpMs) {
      try {
        await connectOnce();
        reconnecting = false;
        ev.emit('status', 'Reconnected', 'ok');
        ev.emit('connection', true);
        return;
      } catch (e) {
        if (FATAL.has(e.code)) { reconnecting = false; end({ reason: e.code, msg: e.message }, true); return; }
        attempt++;
        ev.emit('reconnecting', { since: reconnectSince, attempt, why: e.code || 'network' });
        await nap(backoff(attempt));
      }
    }
    reconnecting = false;
    // Keep the saved token: the lobby offers Retry, and a reload rejoins the same slot.
    end({ reason: 'lost', msg: 'Lost connection to the host.', retry: true }, false);
  }

  await connectOnce();

  // Keepalive both ways (also keeps the carrier's NAT mapping warm), on a worker-driven tick.
  const beat = () => {
    if (closed) return;
    const { frozen } = live.tick();
    if (reconnecting) return;
    send({ t: 'ping', ts: Date.now() });
    const now = Date.now();
    if (frozen) { startProbe(); return; } // our own page was asleep: check before blaming the host
    if (probe && now > probe.until) { lost('probe'); return; }
    if (live.dead('host')) lost('silent');
  };
  function startProbe() {
    if (closed || reconnecting) return;
    if (!conn || conn.closed) { lost('closed'); return; }
    probe = { until: Date.now() + probeMs };
    live.grace(); // the silence was ours
    send({ t: 'ping', ts: Date.now() });
  }
  const stopBeat = every(liveness.heartbeatMs ?? HEARTBEAT_MS, beat);
  const wake = () => {
    if (closed) return;
    if (globalThis.document?.visibilityState === 'hidden') return;
    if (reconnecting) { wakeNap?.(); return; } // retry right now
    startProbe();
  };
  const onOnline = () => { if (reconnecting) wakeNap?.(); else startProbe(); };
  const doc = globalThis.document;
  doc?.addEventListener?.('visibilitychange', wake);
  globalThis.addEventListener?.('pageshow', wake);
  globalThis.addEventListener?.('focus', wake);
  globalThis.addEventListener?.('online', onOnline);
  function unlisten() {
    doc?.removeEventListener?.('visibilitychange', wake);
    globalThis.removeEventListener?.('pageshow', wake);
    globalThis.removeEventListener?.('focus', wake);
    globalThis.removeEventListener?.('online', onOnline);
  }

  return {
    kind: 'client',
    transport: T.kind,
    code: c,
    get pid() { return pid; },
    get lobby() { return lobby; },
    get closed() { return closed; },
    get connected() { return !!conn && !conn.closed && !reconnecting; },
    get reconnecting() { return reconnecting ? { since: reconnectSince, attempt } : null; },
    get path() { return conn?.path || null; },
    on: ev.on,
    onMessage: (fn) => ev.on('message', fn),
    send,
    /** Messages since the last 'start' that nobody consumed yet; stops collecting until resumeBacklog(). */
    takeBacklog() { const b = backlog; backlog = []; backlogOn = false; return b; },
    resumeBacklog() { backlog = []; backlogOn = true; },
    setReady: (on) => send({ t: 'ready', on: !!on }),
    setSquad: (squad) => send({ t: 'squad', squad }),
    updateProfile(p) { prof = cleanProfile({ ...prof, ...p }); send({ t: 'profile', profile: prof }); },
    /** Try to get back now (skips the current backoff wait). */
    retryNow() { if (reconnecting) wakeNap?.(); else startProbe(); },
    leave() {
      if (closed) return;
      send({ t: 'leave' });
      const cn = conn;
      closed = true;
      stopBeat();
      unlisten();
      clearSavedSession();
      conn = null;
      setTimeout(() => { cn?.close(); T.dispose?.(); }, 120);
      ev.emit('closed', { reason: 'left', msg: 'You left the game.' });
    },
    /** Test hook: drop the connection as if the network failed (reconnect kicks in). */
    _simulateDrop() { lost('test'); },
    /** Test hook: the link goes silent (no close) for ms, both ways, like a frozen/backgrounded phone. */
    _simulateStall(ms) { const cn = conn; if (!cn) return; cn.blackhole = true; setTimeout(() => { cn.blackhole = false; }, ms); },
    /** Test hook: pretend our page was frozen and just woke up. */
    _simulateResume() { startProbe(); },
  };
}
