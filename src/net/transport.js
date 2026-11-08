// Transports: PeerJS (WebRTC data channels via the public PeerJS broker) and a loopback over
// BroadcastChannel for same-browser testing (?net=loop). Both expose the same small interface:
//
//   const T = await openTransport('peer' | 'loop')
//   const host = await T.host(code)          // throws {code:'taken'|'network'|'unsupported'}
//   host.onConnection((conn) => …); host.close()
//   const conn = await T.connect(code)       // throws {code:'not_found'|'timeout'|'network'}
//   conn.send(obj); conn.onMessage(fn); conn.onClose(fn); conn.close(); conn.id; conn.open
//
// Messages are plain JSON values (see wire.js for typed arrays).

import { peerIdFor, token } from './codes.js';

export const PEERJS_URL = 'https://esm.sh/peerjs@1.5.4';
export const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

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
  const msg = emitter(), cls = emitter();
  let closed = false;
  const conn = {
    id,
    get closed() { return closed; },
    send(obj) { if (closed) return false; try { sendRaw(obj); return true; } catch (e) { console.warn('[net] send', e); return false; } },
    onMessage: (fn) => msg.on(fn),
    onClose: (fn) => cls.on(fn),
    close() { if (closed) return; closed = true; try { closeRaw(); } catch { /* ignore */ } cls.emit('local'); },
    _recv(d) { if (!closed) msg.emit(d); },
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
          const conn = makeConn(d.cid, (obj) => ch.postMessage({ s: 'h', d: obj }), () => { ch.postMessage({ s: 'h', close: true }); ch.close(); });
          ch.onmessage = (ev) => {
            if (ev.data?.s !== 'c') return;
            if (ev.data.close) { live.delete(d.cid); conn._closed('remote'); ch.close(); return; }
            conn._recv(ev.data.d);
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
      const conn = makeConn(cid, (obj) => ch.postMessage({ s: 'c', d: obj }), () => { ch.postMessage({ s: 'c', close: true }); ch.close(); });
      ch.onmessage = (ev) => {
        if (ev.data?.s !== 'h') return;
        if (ev.data.close) { conn._closed('remote'); ch.close(); return; }
        conn._recv(ev.data.d);
      };
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => { bus.close(); ch.close(); reject(err('not_found', 'No game with that code')); }, timeout);
        bus.onmessage = (e) => { if (e.data?.k === 'accept' && e.data.cid === cid) { clearTimeout(t); bus.close(); resolve(); } };
        bus.postMessage({ k: 'conn', id, cid });
      });
      return conn;
    },
  };
}

// ------------------------------------------------------------------ PeerJS

let peerLib = null;
async function loadPeer() {
  if (peerLib) return peerLib;
  try {
    const m = await import(/* @vite-ignore */ PEERJS_URL);
    peerLib = m.Peer || m.default?.Peer || m.default;
  } catch (e) { throw err('network', 'Could not load the online module. Check your connection.'); }
  if (typeof peerLib !== 'function') throw err('network', 'Online module failed to load');
  return peerLib;
}

function wrapData(dc) {
  const conn = makeConn(dc.peer + ':' + (dc.connectionId || token(4)), (obj) => dc.send(obj), () => dc.close());
  dc.on('data', (d) => conn._recv(d));
  dc.on('close', () => conn._closed('remote'));
  dc.on('error', () => conn._closed('error'));
  // Chrome can drop a data channel without 'close': watch the ICE state too.
  const pc = dc.peerConnection;
  if (pc) pc.addEventListener?.('iceconnectionstatechange', () => { if (['failed', 'closed'].includes(pc.iceConnectionState)) conn._closed('ice'); });
  return conn;
}

function peerTransport() {
  const opts = { debug: 1, config: { iceServers: ICE } };
  return {
    kind: 'peer',
    async host(code) {
      const Peer = await loadPeer();
      const peer = new Peer(peerIdFor(code), opts);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(err('network', 'The matchmaking broker did not answer')), 12000);
        peer.on('open', () => { clearTimeout(t); resolve(); });
        peer.on('error', (e) => { clearTimeout(t); reject(err(e?.type === 'unavailable-id' ? 'taken' : 'network', e?.message)); });
      });
      const conns = emitter();
      peer.on('connection', (dc) => {
        const ready = () => conns.emit(wrapData(dc));
        if (dc.open) ready(); else dc.on('open', ready);
      });
      // Lost the broker (not the players): try to re-register so new joins keep working.
      peer.on('disconnected', () => { setTimeout(() => { try { if (!peer.destroyed) peer.reconnect(); } catch { /* ignore */ } }, 1500); });
      return { id: peer.id, onConnection: (fn) => conns.on(fn), close() { try { peer.destroy(); } catch { /* ignore */ } } };
    },
    async connect(code, { timeout = 15000 } = {}) {
      const Peer = await loadPeer();
      const peer = new Peer(opts);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(err('network', 'The matchmaking broker did not answer')), 12000);
        peer.on('open', () => { clearTimeout(t); resolve(); });
        peer.on('error', (e) => { clearTimeout(t); reject(err('network', e?.message)); });
      });
      const dc = peer.connect(peerIdFor(code), { reliable: true, serialization: 'json' });
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(err('timeout', 'Could not reach the host. Some cellular networks block peer-to-peer; try Wi-Fi.')), timeout);
        dc.on('open', () => { clearTimeout(t); resolve(); });
        peer.on('error', (e) => { clearTimeout(t); reject(err(e?.type === 'peer-unavailable' ? 'not_found' : 'network', e?.message)); });
        dc.on('error', (e) => { clearTimeout(t); reject(err('network', e?.message)); });
      });
      const conn = wrapData(dc);
      conn.onClose(() => setTimeout(() => { try { peer.destroy(); } catch { /* ignore */ } }, 50));
      return conn;
    },
  };
}
