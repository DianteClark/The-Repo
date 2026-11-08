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

export const MAX_PLAYERS = 16;
export const RECONNECT_MS = 60000;
export const HEARTBEAT_MS = 2000;
export const DEAD_MS = 9000;
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
export async function hostSession({ profile, settings = {}, kind = transportKind(), code = null } = {}) {
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
  const lastSeen = new Map();
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
    // After a mode change: keep squads where they fit, re-seat the rest.
    const sizes = squadSizes(st.mode);
    const seen = new Map();
    for (const p of players.values()) {
      const c = seen.get(p.squad) || 0;
      if (p.squad >= sizes.length || c >= sizes[p.squad]) p.squad = -1;
      else seen.set(p.squad, c + 1);
    }
    for (const p of players.values()) if (p.squad < 0) p.squad = freeSquad();
  }

  function attach(conn) {
    let pid = null;
    const timeout = setTimeout(() => { if (!pid) conn.close(); }, 8000);
    conn.onMessage((raw) => {
      const m = decode(raw);
      if (!m || typeof m.t !== 'string') return;
      if (pid) lastSeen.set(pid, Date.now());
      if (!pid) {
        if (m.t !== 'hello') return;
        clearTimeout(timeout);
        if (m.v !== PROTO) { conn.send(encode({ t: 'closed', reason: 'version', msg: 'This game is on a different version. Refresh both devices.' })); setTimeout(() => conn.close(), 200); return; }
        // Reconnect with a token?
        const back = m.token && tokens.get(m.token);
        if (back && players.has(back)) {
          if (banned.has(back)) { conn.send(encode({ t: 'kicked', reason: 'You were removed from this lobby.' })); setTimeout(() => conn.close(), 200); return; }
          pid = back;
          const old = conns.get(pid);
          if (old && old !== conn) { conns.delete(pid); old.close(); }
          const p = players.get(pid);
          p.connected = true; p.goneAt = 0;
          conns.set(pid, conn);
          lastSeen.set(pid, Date.now());
          conn.send(encode({ t: 'welcome', pid, token: m.token, lobby: publicLobby(), rejoin: true }));
          broadcastLobby();
          ev.emit('rejoin', pid);
          ev.emit('status', `${p.name} reconnected`, 'ok');
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
        lastSeen.set(pid, Date.now());
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
    } else {
      p.connected = false;
      p.goneAt = Date.now();
      ev.emit('status', `${p.name} lost connection. Holding their slot for 60 s.`, 'warn');
      ev.emit('disconnect', pid);
    }
    broadcastLobby();
  }

  endpoint.onConnection(attach);

  const hb = setInterval(() => {
    const now = Date.now();
    for (const [pid, c] of conns) {
      c.send(encode({ t: 'ping', ts: now }));
      if (now - (lastSeen.get(pid) || now) > DEAD_MS) drop(pid, 'lost', false);
    }
    for (const p of [...players.values()]) {
      if (p.isHost || p.connected || !p.goneAt) continue;
      if (now - p.goneAt >= RECONNECT_MS) {
        if (inMatch) { if (!p.expired) { p.expired = true; ev.emit('gone', p.pid, 'timeout'); } }
        else { players.delete(p.pid); broadcastLobby(); }
      }
    }
  }, HEARTBEAT_MS);

  const close = (reason = 'host_left', msg = 'The host closed the game.') => {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    for (const [pid, c] of conns) { c.send(encode({ t: 'closed', reason, msg })); setTimeout(() => c.close(), 120); void pid; }
    setTimeout(() => endpoint.close(), 200);
    ev.emit('closed', reason);
  };
  const onUnload = () => close('host_left', 'The host left the game.');
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
    close(reason, msg) { globalThis.removeEventListener?.('pagehide', onUnload); close(reason, msg); },
  };
  return api;
}

// ================================================================== client

const SESSION_KEY = 'tidefall.net.session';
function saveSession(s) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* ignore */ } }
export function savedSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } }
export function clearSavedSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } }

/** Join a lobby by code. Resolves after the host's welcome. */
export async function joinSession({ code, profile, kind = transportKind(), token: tok = null } = {}) {
  const c = normalizeCode(code);
  if (!c) throw Object.assign(new Error('That code is not valid'), { code: 'bad_code' });
  const T = await openTransport(kind);
  const ev = emitter();
  let conn = null;
  let pid = null;
  let lobby = null;
  let closed = false;
  let lastMsg = Date.now();
  let reconnecting = false;
  let prof = cleanProfile(profile);
  let myToken = tok || (savedSession()?.code === c ? savedSession().token : null);
  // Match messages that arrive before a match controller subscribes (from 'start' on) are kept here.
  let backlogOn = true;
  let backlog = [];

  const send = (msg) => (conn && !conn.closed ? conn.send(encode(msg)) : false);

  async function connectOnce() {
    const cn = await T.connect(c);
    const welcome = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(Object.assign(new Error('The host did not answer'), { code: 'timeout' })), 8000);
      cn.onMessage((raw) => {
        const m = decode(raw);
        if (!m) return;
        lastMsg = Date.now();
        if (m.t === 'welcome') { clearTimeout(t); resolve(m); return; }
        if (m.t === 'closed' || m.t === 'kicked') { clearTimeout(t); reject(Object.assign(new Error(m.msg || m.reason), { code: m.t === 'kicked' ? 'kicked' : m.reason })); }
        handle(m);
      });
      cn.onClose(() => { clearTimeout(t); reject(Object.assign(new Error('Connection closed'), { code: 'network' })); });
    });
    cn.send(encode({ t: 'hello', v: PROTO, profile: prof, token: myToken }));
    const w = await welcome;
    conn = cn;
    pid = w.pid;
    myToken = w.token;
    lobby = w.lobby;
    saveSession({ code: c, token: myToken, pid, at: Date.now() });
    cn.onClose(() => { if (conn === cn) lost(); });
    ev.emit('lobby', lobby);
    if (w.rejoin) ev.emit('rejoin', w);
    return w;
  }

  function handle(m) {
    switch (m.t) {
      case 'ping': send({ t: 'pong', ts: m.ts }); return;
      case 'pong': return;
      case 'lobby': lobby = m.lobby; ev.emit('lobby', lobby); return;
      case 'kicked': closed = true; clearSavedSession(); ev.emit('closed', { reason: 'kicked', msg: m.reason || 'You were removed from the lobby.' }); conn?.close(); return;
      case 'closed': closed = true; clearSavedSession(); ev.emit('closed', { reason: m.reason || 'host_left', msg: m.msg || 'The host left the game.' }); conn?.close(); return;
      default:
        if (backlogOn) { if (m.t === 'start') backlog = []; backlog.push(m); }
        ev.emit('message', m);
    }
  }

  async function lost() {
    if (closed || reconnecting) return;
    reconnecting = true;
    const since = Date.now();
    ev.emit('status', 'Connection lost. Reconnecting…', 'warn');
    ev.emit('connection', false);
    while (!closed && Date.now() - since < RECONNECT_MS) {
      try {
        await connectOnce();
        reconnecting = false;
        ev.emit('status', 'Reconnected', 'ok');
        ev.emit('connection', true);
        return;
      } catch (e) {
        if (e.code === 'kicked' || e.code === 'started' || e.code === 'version' || e.code === 'full') { closed = true; ev.emit('closed', { reason: e.code, msg: e.message }); return; }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    reconnecting = false;
    if (!closed) {
      closed = true;
      ev.emit('closed', { reason: 'lost', msg: 'Lost connection to the host.' });
    }
  }

  await connectOnce();

  const hb = setInterval(() => {
    if (closed) { clearInterval(hb); return; }
    if (!reconnecting && Date.now() - lastMsg > DEAD_MS) { const old = conn; conn = null; old?.close(); lost(); }
  }, 1000);

  return {
    kind: 'client',
    transport: T.kind,
    code: c,
    get pid() { return pid; },
    get lobby() { return lobby; },
    get closed() { return closed; },
    get connected() { return !!conn && !conn.closed && !reconnecting; },
    on: ev.on,
    onMessage: (fn) => ev.on('message', fn),
    send,
    /** Messages since the last 'start' that nobody consumed yet; stops collecting until resumeBacklog(). */
    takeBacklog() { const b = backlog; backlog = []; backlogOn = false; return b; },
    resumeBacklog() { backlog = []; backlogOn = true; },
    setReady: (on) => send({ t: 'ready', on: !!on }),
    setSquad: (squad) => send({ t: 'squad', squad }),
    updateProfile(p) { prof = cleanProfile({ ...prof, ...p }); send({ t: 'profile', profile: prof }); },
    leave() {
      if (closed) return;
      closed = true;
      clearInterval(hb);
      send({ t: 'leave' });
      clearSavedSession();
      setTimeout(() => conn?.close(), 120);
      ev.emit('closed', { reason: 'left', msg: 'You left the game.' });
    },
    /** Test hook: drop the connection as if the network failed (reconnect kicks in). */
    _simulateDrop() { const old = conn; conn = null; old?.close(); lost(); },
  };
}
