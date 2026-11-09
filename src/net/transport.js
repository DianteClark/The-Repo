// Transports: PeerJS (WebRTC data channels via the public PeerJS broker) and a loopback over
// BroadcastChannel for same-browser testing (?net=loop). Both expose the same small interface:
//
//   const T = await openTransport('peer' | 'loop')
//   const host = await T.host(code)          // throws {code:'taken'|'network'|'unsupported'}
//   host.onConnection((conn) => …); host.close()
//   const conn = await T.connect(code)       // throws {code:'not_found'|'timeout'|'network'}
//   conn.send(obj); conn.onMessage(fn); conn.onClose(fn); conn.close(); conn.id; conn.closed
//   conn.onState(fn)   'unstable' (ICE path interrupted, may recover) | 'stable'
//   conn.path          debug: selected candidate pair {local, remote, protocol, family, relay}
//   conn.blackhole     test hook: true = silently drop traffic both ways without closing (a dead path)
//
// Messages are plain JSON values (see wire.js for typed arrays).

import { peerIdFor, token } from './codes.js';
import { rtcConfig, iceServers, describePath } from './ice.js';
import { frames, reassembler } from './frame.js';
import { backoff } from './liveness.js';

export const PEERJS_URL = 'https://esm.sh/peerjs@1.5.4';
/** @deprecated use iceServers() from ice.js */
export const ICE = iceServers();
export const ICE_GRACE_MS = 12000; // ICE 'disconnected' is often transient on phones: wait this long before giving up on the path

const err = (code, message) => Object.assign(new Error(message || code), { code });

/** Which transport this page should use: ?net=loop selects the loopback. */
export function transportKind(search = globalThis.location?.search || '') {
  try { return new URLSearchParams(search).get('net') === 'loop' ? 'loop' : 'peer'; } catch { return 'peer'; }
}

export async function openTransport(kind = transportKind()) {
  return kind === 'loop' ? loopTransport() : peerTransport();
}

// A tiny listener set helper
function emitter() {
  const fns = new Set();
  return { on(fn) { fns.add(fn); return () => fns.delete(fn); }, emit(...a) { for (const f of [...fns]) { try { f(...a); } catch (e) { console.warn('[net]', e); } } } };
}

function makeConn(id, sendRaw, closeRaw) {
  const msg = emitter(), cls = emitter(), stt = emitter();
  let closed = false;
  const conn = {
    id,
    path: null,
    blackhole: false,
    get closed() { return closed; },
    send(obj) { if (closed) return false; if (conn.blackhole) return true; try { return sendRaw(obj) !== false; } catch (e) { console.warn('[net] send', e); return false; } },
    onMessage: (fn) => msg.on(fn),
    onClose: (fn) => cls.on(fn),
    onState: (fn) => stt.on(fn),
    close() { if (closed) return; closed = true; try { closeRaw(); } catch { /* ignore */ } cls.emit('local'); },
    _recv(d) { if (!closed && !conn.blackhole) msg.emit(d); },
    _state(s) { if (!closed) stt.emit(s); },
    _closed(reason = 'remote') { if (closed) return; closed = true; cls.emit(reason); },
  };
  return conn;
}

// ------------------------------------------------------------------ loopback (BroadcastChannel)

function loopTransport() {
  if (typeof BroadcastChannel !== 'function') throw err('unsupported', 'BroadcastChannel is not available');
  const LOBBY = 'tidefall-loop';
  return {
    kind: 'loop',
    async host(code) {
      const id = peerIdFor(code);
      const bus = new BroadcastChannel(LOBBY);
      // Is this code already hosted in another tab?
      const taken = await new Promise((resolve) => {
        const t = setTimeout(() => { bus.removeEventListener('message', on); resolve(false); }, 180);
        const on = (e) => { if (e.data?.k === 'taken' && e.data.id === id) { clearTimeout(t); bus.removeEventListener('message', on); resolve(true); } };
        bus.addEventListener('message', on);
        bus.postMessage({ k: 'probe', id });
      });
      if (taken) { bus.close(); throw err('taken', 'Code in use'); }
      const conns = emitter();
      const live = new Map();
      bus.onmessage = (e) => {
        const d = e.data;
        if (!d || d.id !== id) return;
        if (d.k === 'probe') bus.postMessage({ k: 'taken', id });
        else if (d.k === 'conn' && d.cid && !live.has(d.cid)) {
          const ch = new BroadcastChannel('tidefall-loop-' + d.cid);
          const rx = reassembler();
          const conn = makeConn(d.cid, (obj) => { for (const f of frames(obj)) ch.postMessage({ s: 'h', d: f }); }, () => { ch.postMessage({ s: 'h', close: true }); ch.close(); });
          ch.onmessage = (ev) => {
            if (ev.data?.s !== 'c') return;
            if (ev.data.close) { live.delete(d.cid); conn._closed('remote'); ch.close(); return; }
            const m = rx.push(ev.data.d);
            if (m !== undefined) conn._recv(m);
          };
          conn.onClose(() => live.delete(d.cid));
          live.set(d.cid, conn);
          bus.postMessage({ k: 'accept', id, cid: d.cid });
          conns.emit(conn);
        }
      };
      return {
        id,
        onConnection: (fn) => conns.on(fn),
        close() { for (const c of live.values()) c.close(); live.clear(); bus.close(); },
      };
    },
    async connect(code, { timeout = 4000 } = {}) {
      const id = peerIdFor(code);
      const cid = token(8);
      const bus = new BroadcastChannel(LOBBY);
      const ch = new BroadcastChannel('tidefall-loop-' + cid);
      const rx = reassembler();
      const conn = makeConn(cid, (obj) => { for (const f of frames(obj)) ch.postMessage({ s: 'c', d: f }); }, () => { ch.postMessage({ s: 'c', close: true }); ch.close(); });
      ch.onmessage = (ev) => {
        if (ev.data?.s !== 'h') return;
        if (ev.data.close) { conn._closed('remote'); ch.close(); return; }
        const m = rx.push(ev.data.d);
        if (m !== undefined) conn._recv(m);
      };
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => { bus.close(); ch.close(); reject(err('not_found', 'No game with that code')); }, timeout);
        bus.onmessage = (e) => { if (e.data?.k === 'accept' && e.data.cid === cid) { clearTimeout(t); bus.close(); resolve(); } };
        bus.postMessage({ k: 'conn', id, cid });
      });
      return conn;
    },
    dispose() {},
  };
}

// ------------------------------------------------------------------ PeerJS

let peerLib = null;
async function loadPeer() {
  if (peerLib) return peerLib;
  try {
    const m = await import(/* @vite-ignore */ PEERJS_URL);
    peerLib = m.Peer || m.default?.Peer || m.default;
  } catch (e) { peerLib = null; throw err('network', 'Could not load the online module. Check your connection.'); }
  if (typeof peerLib !== 'function') { peerLib = null; throw err('network', 'Online module failed to load'); }
  return peerLib;
}

const debugNet = () => { try { return /[?&](debug|netdebug)\b/.test(globalThis.location?.search || ''); } catch { return false; } };

/**
 * Wrap a PeerJS DataConnection opened with serialization 'raw': we frame JSON ourselves (frame.js),
 * because PeerJS 'json' drops anything ≥ 16 KB. Errors on an open channel are logged, not fatal;
 * ICE 'disconnected' is transient (wait ICE_GRACE_MS), 'failed'/'closed' end the connection.
 */
function wrapData(dc) {
  const rx = reassembler();
  const conn = makeConn(dc.peer + ':' + (dc.connectionId || token(4)), (obj) => {
    if (!dc.open) return false;
    for (const f of frames(obj)) dc.send(f);
    return true;
  }, () => dc.close());
  dc.on('data', (d) => { const m = rx.push(d); if (m !== undefined) conn._recv(m); });
  dc.on('close', () => conn._closed('remote'));
  dc.on('error', (e) => { console.warn('[net] channel', e?.type || '', e?.message || e); if (!dc.open) conn._closed('error'); });
  const pc = dc.peerConnection;
  let grace = 0;
  const onIce = () => {
    const s = pc.iceConnectionState;
    if (s === 'disconnected') {
      conn._state('unstable');
      if (!grace) grace = setTimeout(() => { grace = 0; if (['disconnected', 'failed'].includes(pc.iceConnectionState)) conn._closed('ice'); }, ICE_GRACE_MS);
    } else if (s === 'connected' || s === 'completed') {
      if (grace) { clearTimeout(grace); grace = 0; }
      conn._state('stable');
    } else if (s === 'failed' || s === 'closed') {
      if (grace) { clearTimeout(grace); grace = 0; }
      conn._closed('ice');
    }
  };
  pc?.addEventListener?.('iceconnectionstatechange', onIce);
  conn.onClose(() => { if (grace) clearTimeout(grace); pc?.removeEventListener?.('iceconnectionstatechange', onIce); });
  // Which path did ICE pick? (host / srflx / prflx / relay; IPv4 or IPv6)
  setTimeout(async () => {
    conn.path = await describePath(pc);
    if (conn.path && debugNet()) console.info('[net] path', conn.id, JSON.stringify(conn.path));
  }, 1500);
  return conn;
}

function waitOpen(peer, ms, what = 'The matchmaking broker did not answer') {
  return new Promise((resolve, reject) => {
    if (peer.open) { resolve(); return; }
    const done = (f, v) => { clearTimeout(t); peer.off?.('open', onOpen); peer.off?.('error', onErr); f(v); };
    const onOpen = () => done(resolve);
    const onErr = (e) => done(reject, err(e?.type === 'unavailable-id' ? 'taken' : 'network', e?.message));
    const t = setTimeout(() => done(reject, err('network', what)), ms);
    peer.on('open', onOpen);
    peer.on('error', onErr);
  });
}

/**
 * Keep a Peer registered with the broker. Losing the signalling socket ('disconnected') does NOT
 * close data connections, so we only re-register (peer.reconnect()) with backoff; 'close' means
 * the peer was destroyed. Also retries as soon as the device reports it is back online.
 */
function keepRegistered(peer, label) {
  let tries = 0, timer = 0;
  const attempt = () => {
    timer = 0;
    if (peer.destroyed || !peer.disconnected) { tries = 0; return; }
    try { peer.reconnect(); } catch (e) { console.warn('[net] reconnect', label, e); }
    timer = setTimeout(attempt, backoff(++tries + 2)); // checks again; a successful 'open' resets
  };
  const schedule = (ms) => { if (!timer && !peer.destroyed) timer = setTimeout(attempt, ms); };
  peer.on('disconnected', () => { if (debugNet()) console.info('[net] broker lost', label); schedule(800); });
  peer.on('open', () => { tries = 0; if (timer) { clearTimeout(timer); timer = 0; } });
  peer.on('error', (e) => {
    // After open: broker/socket trouble. Data connections are unaffected; keep re-registering.
    if (['network', 'server-error', 'socket-error', 'socket-closed', 'unavailable-id'].includes(e?.type) && peer.disconnected) schedule(backoff(++tries + 1));
  });
  const online = () => { if (peer.disconnected && !peer.destroyed) { if (timer) clearTimeout(timer); timer = 0; attempt(); } };
  globalThis.addEventListener?.('online', online);
  peer.on('close', () => { globalThis.removeEventListener?.('online', online); if (timer) clearTimeout(timer); });
}

function peerTransport() {
  const opts = () => ({ debug: debugNet() ? 2 : 1, config: rtcConfig() });
  let cp = null; // the client's Peer, reused across reconnects (no new broker registration each time)
  async function clientPeer() {
    const Peer = await loadPeer();
    if (cp && !cp.destroyed) {
      if (cp.open) return cp;
      if (cp.disconnected) { try { cp.reconnect(); } catch { /* ignore */ } }
      try { await waitOpen(cp, 8000); return cp; } catch { try { cp.destroy(); } catch { /* ignore */ } cp = null; }
    }
    const p = new Peer(opts());
    cp = p;
    p.on('close', () => { if (cp === p) cp = null; });
    try { await waitOpen(p, 12000); } catch (e) { try { p.destroy(); } catch { /* ignore */ } if (cp === p) cp = null; throw e; }
    keepRegistered(p, 'client');
    return p;
  }
  return {
    kind: 'peer',
    async host(code) {
      const Peer = await loadPeer();
      const peer = new Peer(peerIdFor(code), opts());
      try { await waitOpen(peer, 12000); } catch (e) { try { peer.destroy(); } catch { /* ignore */ } throw e; }
      const conns = emitter();
      peer.on('connection', (dc) => {
        const ready = () => conns.emit(wrapData(dc));
        if (dc.open) ready(); else dc.on('open', ready);
      });
      keepRegistered(peer, 'host');
      return {
        id: peer.id,
        onConnection: (fn) => conns.on(fn),
        get registered() { return !!peer.open; },
        close() { try { peer.destroy(); } catch { /* ignore */ } },
      };
    },
    async connect(code, { timeout = 15000 } = {}) {
      const peer = await clientPeer();
      const dc = peer.connect(peerIdFor(code), { reliable: true, serialization: 'raw' });
      await new Promise((resolve, reject) => {
        const done = (f, v) => { clearTimeout(t); peer.off?.('error', onPeerErr); f(v); };
        const onPeerErr = (e) => done(reject, err(e?.type === 'peer-unavailable' ? 'not_found' : 'network', e?.message));
        const t = setTimeout(() => { try { dc.close(); } catch { /* ignore */ } done(reject, err('timeout', 'Could not reach the host.')); }, timeout);
        dc.on('open', () => done(resolve));
        peer.on('error', onPeerErr);
        dc.on('error', (e) => { if (!dc.open) done(reject, err('network', e?.message)); });
      });
      return wrapData(dc);
    },
    /** Tear down the client's Peer (leaving for good). */
    dispose() { try { cp?.destroy(); } catch { /* ignore */ } cp = null; },
  };
}
