// Liveness, framing and automatic reconnect. Run: node --test src/net/liveness.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveness, backoff, DEAD_MS, HEARTBEAT_MS } from './liveness.js';
import { frames, reassembler, FRAME_CHARS } from './frame.js';
import { hostSession, joinSession, squadSizes } from './session.js';
import { createMatch } from '../client/match/index.js';
import { iceServers, rtcConfig, STUN, RELAY } from './ice.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(20); } };

test('liveness defaults are phone-tolerant', () => {
  assert.ok(DEAD_MS >= 25000, 'silence before a drop is at least 25 s');
  assert.ok(HEARTBEAT_MS <= DEAD_MS / 5);
});

test('liveness: any message resets the clock; dead only after deadMs', () => {
  let t = 0;
  const L = createLiveness({ deadMs: 30000, frozenMs: 8000, now: () => t });
  L.seen('a');
  t = 29000; L.tick(); assert.equal(L.dead('a'), false);
  L.seen('a');
  t = 58000; assert.equal(L.dead('a'), false);
  t = 59500; assert.equal(L.dead('a'), true);
});

test('liveness: our own frozen timers never blame the peer (grace on a late tick)', () => {
  let t = 0;
  const L = createLiveness({ deadMs: 30000, frozenMs: 8000, now: () => t });
  L.seen('a');
  for (t = 3000; t <= 15000; t += 3000) assert.equal(L.tick().frozen, false);
  t = 75000; // page was suspended for a minute
  const r = L.tick();
  assert.equal(r.frozen, true);
  assert.equal(L.dead('a'), false, 'reset by the grace');
  assert.equal(L.silence('a'), 0);
});

test('backoff grows then caps', () => {
  const r = () => 0.5;
  assert.ok(backoff(0, r) <= 600);
  assert.ok(backoff(1, r) < backoff(3, r));
  assert.ok(backoff(20, r) <= 6000 * 1.15);
});

test('frames: big messages are chunked under the PeerJS 16 KB limit and reassembled', () => {
  const big = { t: 'batch', snap: { map: 'x'.repeat(130000), units: Array.from({ length: 64 }, (_, i) => ({ id: i, n: 'é✓' + i })) } };
  const f = frames(big);
  assert.ok(f.length > 5);
  for (const s of f) assert.ok(new TextEncoder().encode(s).length < 16300, 'each frame fits');
  const small = frames({ t: 'ping', ts: 1 });
  assert.equal(small.length, 1);
  const rx = reassembler();
  // interleave a small message between chunks of a big one
  let got = [];
  f.forEach((s, i) => { const m = rx.push(s); if (m !== undefined) got.push(m); if (i === 2) got.push(rx.push(small[0])); });
  assert.deepEqual(got[0], { t: 'ping', ts: 1 });
  assert.deepEqual(got[1], big);
  assert.equal(rx.pending, 0);
  assert.equal(rx.push('~zz:5:3:junk'), undefined, 'bad header ignored');
  assert.equal(rx.push('not json'), undefined);
  assert.equal(FRAME_CHARS * 3 < 65536, true);
});

test('ice: STUN by default, relay slot empty, localStorage override', () => {
  assert.ok(STUN.length >= 3);
  assert.equal(RELAY.length, 0);
  assert.deepEqual(iceServers(), STUN);
  const cfg = rtcConfig();
  assert.ok(cfg.iceServers.length && cfg.iceCandidatePoolSize >= 1);
  const urls = STUN.flatMap((x) => [].concat(x.urls));
  for (const u of ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302', 'stun:stun3.l.google.com:19302', 'stun:stun4.l.google.com:19302', 'stun:stun.cloudflare.com:3478']) assert.ok(urls.includes(u), u);
  assert.ok(!urls.some((u) => /^turns?:/.test(u)), 'no relay by default');
  const store = { 'tidefall.ice': JSON.stringify([{ urls: 'stun:example.org:3478' }]) };
  globalThis.localStorage = { getItem: (k) => store[k] ?? null };
  try { assert.deepEqual(iceServers(), [{ urls: 'stun:example.org:3478' }]); } finally { delete globalThis.localStorage; }
});

const FAST = { deadMs: 1500, heartbeatMs: 200, probeMs: 600, giveUpMs: 6000 };

test('a short stall (phone backgrounded, busy host) is tolerated: no drop, no reconnect', async () => {
  const host = await hostSession({ kind: 'loop', profile: { name: 'Host' }, liveness: FAST });
  const cl = await joinSession({ kind: 'loop', code: host.code, profile: { name: 'Ann' }, liveness: FAST });
  let reconnects = 0, disconnects = 0;
  cl.on('connection', (on) => { if (!on) reconnects++; });
  host.on('disconnect', () => disconnects++);
  cl._simulateStall(900); // < deadMs
  await wait(1600);
  assert.equal(reconnects, 0);
  assert.equal(disconnects, 0);
  assert.equal(host.isConnected(cl.pid), true);
  host.close(); cl.leave();
});

test('a long silent stall: the client rejoins by itself into the same slot', async () => {
  const host = await hostSession({ kind: 'loop', profile: { name: 'Host' }, liveness: FAST });
  const cl = await joinSession({ kind: 'loop', code: host.code, profile: { name: 'Ann' }, liveness: FAST });
  const pid = cl.pid;
  const ups = [];
  cl.on('connection', (on) => ups.push(on));
  cl._simulateStall(60000); // the path is dead (no close event ever comes)
  await until(() => ups.includes(true), 8000);
  assert.deepEqual(ups.slice(0, 2), [false, true]);
  assert.equal(cl.pid, pid, 'same slot');
  await until(() => host.isConnected(pid));
  assert.equal(host.lobby.players.length, 2);
  host.close(); cl.leave();
});

test('host soft-drops a silent player and takes them back on the same channel', async () => {
  const host = await hostSession({ kind: 'loop', profile: { name: 'Host' }, liveness: FAST });
  // the client tolerates much longer than the host here, so it never reconnects: the same channel resumes
  const cl = await joinSession({ kind: 'loop', code: host.code, profile: { name: 'Ann' }, liveness: { ...FAST, deadMs: 20000 } });
  const st = [];
  host.on('status', (m) => st.push(m));
  cl._simulateStall(2600);
  await until(() => !host.isConnected(cl.pid), 4000);
  await until(() => host.isConnected(cl.pid), 4000);
  assert.ok(st.some((m) => /not responding/.test(m)));
  assert.ok(st.some((m) => /is back/.test(m)));
  host.close(); cl.leave();
});

test('coming back to the page probes the link and reconnects at once if it is dead', async () => {
  const host = await hostSession({ kind: 'loop', profile: { name: 'Host' }, liveness: { ...FAST, deadMs: 20000 } });
  const cl = await joinSession({ kind: 'loop', code: host.code, profile: { name: 'Ann' }, liveness: { ...FAST, deadMs: 20000 } });
  const ups = [];
  cl.on('connection', (on) => ups.push(on));
  cl._simulateStall(60000);
  const t0 = Date.now();
  cl._simulateResume();
  await until(() => ups.includes(true), 5000);
  assert.ok(Date.now() - t0 < 4000, 'reconnected well before the 20 s silence timeout');
  host.close(); cl.leave();
});

test('host gone for good: the client gives up with a retryable close and keeps its token', async () => {
  const host = await hostSession({ kind: 'loop', profile: { name: 'Host' }, liveness: FAST });
  const cl = await joinSession({ kind: 'loop', code: host.code, profile: { name: 'Ann' }, liveness: { ...FAST, giveUpMs: 2500 } });
  let info = null;
  cl.on('closed', (i) => { info = i; });
  // the host vanishes without saying goodbye (crash / phone died)
  host._vanish();
  await until(() => info, 12000);
  assert.equal(info.reason, 'lost');
  assert.equal(info.retry, true);
  host.close();
});

test('match: a player whose hold expired gets their unit back on rejoin; map deltas keep the mirror whole', async () => {
  const host = await hostSession({ kind: 'loop', profile: { name: 'Host', cls: 'recon' }, settings: { mode: 'duos' }, liveness: { ...FAST, holdMs: 800 } });
  const cl = await joinSession({ kind: 'loop', code: host.code, profile: { name: 'Cli', cls: 'breacher' } });
  cl.setReady(true);
  await until(() => host.canStart().ok);
  const statuses = [];
  let cTurns = 0;
  const hm = createMatch('host', { R: null, net: host, opts: { seed: 7, pace: false, noTimer: true }, ui: {
    onTurnStart: () => { setTimeout(() => hm.act({ type: 'hunker' }).then((r) => { if (!r.ok) hm.endTurn(); }), 1); },
    onStatus: (m) => statuses.push(m),
  } });
  const cm = createMatch('client', { R: null, net: cl, opts: { pace: false }, ui: {
    onTurnStart: () => { cTurns++; setTimeout(() => cm.act({ type: 'overwatch' }).then((r) => { if (!r.ok) cm.endTurn(); }), 1); },
  } });
  hm.start(); cm.start();
  await until(() => cTurns >= 1, 20000);
  // the mirror's map is complete and identical in shape to the host's
  for (const [k, v] of Object.entries(hm.state.map)) if (ArrayBuffer.isView(v)) assert.equal(cm.state.map[k]?.length, v.length, k);
  const myId = cm.myUnitId;
  cl._simulateStall(3500); // > host deadMs + holdMs: the bot takes over
  await until(() => statuses.some((m) => /bot takes over/i.test(m)), 8000);
  await until(() => statuses.some((m) => /back in control/i.test(m)) || !hm.state.units[myId].alive || hm.over, 15000);
  if (hm.state.units[myId].alive && !hm.over) assert.ok(hm._debug.humans.has(myId), 'human again');
  hm.leave(); cm.leave();
  host.close(); cl.leave(); // after the end, controllers keep the session for the lobby: close it here
});

test('lobby layout: every mode seats exactly 16 (Duos = 8 squads x 2, Trios = 5 x 3 + lone wolf)', () => {
  assert.deepEqual(squadSizes('solos'), Array(16).fill(1));
  assert.deepEqual(squadSizes('duos'), Array(8).fill(2));
  assert.deepEqual(squadSizes('trios'), [3, 3, 3, 3, 3, 1]);
  assert.deepEqual(squadSizes('quads'), Array(4).fill(4));
  for (const m of ['solos', 'duos', 'trios', 'quads']) assert.equal(squadSizes(m).reduce((a, b) => a + b, 0), 16, m);
});

test('host mode change before start re-seats players and keeps 16 slots', async () => {
  const host = await hostSession({ kind: 'loop', profile: { name: 'Host' }, settings: { mode: 'duos' }, liveness: FAST });
  const a = await joinSession({ kind: 'loop', code: host.code, profile: { name: 'Ann' }, liveness: FAST });
  await until(() => a.lobby?.players.length === 2);
  assert.equal(a.lobby.players.find((p) => p.name === 'Ann').squad, 0, 'friends grouped into the host squad');
  host.setSettings({ mode: 'solos' });
  await until(() => a.lobby.settings.mode === 'solos');
  assert.equal(a.lobby.sizes.length, 16);
  const sq = a.lobby.players.map((p) => p.squad);
  assert.equal(new Set(sq).size, 2, 'solos: one player per slot');
  host.setSettings({ mode: 'duos' });
  await until(() => a.lobby.settings.mode === 'duos');
  assert.deepEqual(a.lobby.players.map((p) => p.squad), [0, 0], 'back to duos: friends regrouped in squad 1');
  host.close(); a.leave();
});
