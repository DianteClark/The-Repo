// Online robustness over the loopback transport (BroadcastChannel, built into Node ≥18):
// lobby, kick, reconnect + resync mid-match, host leaving. Run: node --test src/net/session.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostSession, joinSession } from './session.js';
import { createMatch } from '../client/match/index.js';
import { normalizeCode, makeCode, CODE_ALPHABET } from './codes.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(20); } };

test('codes: 6 unambiguous characters, normalised input', () => {
  for (let i = 0; i < 200; i++) assert.ok(normalizeCode(makeCode()));
  assert.equal(normalizeCode(' acd-efh '), 'ACDEFH');
  assert.equal(normalizeCode('tidefall-ACDEFH'), 'ACDEFH');
  assert.equal(normalizeCode('ABCDE0'), null);
  for (const c of 'O0I1L5S8B2Z6GU') assert.ok(!CODE_ALPHABET.includes(c), c);
});

test('lobby: join, squads, ready, kick (and the kicked player cannot come back)', async () => {
  const host = await hostSession({ kind: 'loop', profile: { name: 'Host', cls: 'recon' }, settings: { mode: 'duos' } });
  const a = await joinSession({ kind: 'loop', code: host.code, profile: { name: 'Ann', cls: 'medic' } });
  const b = await joinSession({ kind: 'loop', code: host.code, profile: { name: 'Bob', cls: 'gunner' } });
  await until(() => host.lobby.players.length === 3);
  assert.equal(host.lobby.players.find((p) => p.name === 'Ann').squad, 0, 'friends fill the host squad first');
  assert.equal(host.canStart().ok, false);
  a.setReady(true); b.setReady(true);
  await until(() => host.canStart().ok);
  b.setSquad(3);
  await until(() => host.lobby.players.find((p) => p.name === 'Bob').squad === 3);
  let closed = null;
  b.on('closed', (i) => { closed = i; });
  host.kick(b.pid);
  await until(() => closed);
  assert.equal(closed.reason, 'kicked');
  await until(() => host.lobby.players.length === 2);
  await assert.rejects(joinSession({ kind: 'loop', code: host.code, profile: { name: 'Bob' }, token: 'nope' }).then(async (c) => { await wait(50); if (c.lobby.players.some((p) => p.name === 'Bob')) c.leave(); throw new Error('ok-new-player'); }), /ok-new-player/);
  host.close();
  a.leave();
});

test('match: client drops mid-match, auto-overwatch covers it, reconnect resyncs; host leaving ends it', async () => {
  const host = await hostSession({ kind: 'loop', profile: { name: 'Host', cls: 'recon' }, settings: { mode: 'duos', stage: 'harbor' } });
  const cl = await joinSession({ kind: 'loop', code: host.code, profile: { name: 'Cli', cls: 'breacher' } });
  cl.setReady(true);
  await until(() => host.canStart().ok);
  const statuses = [];
  let cTurns = 0, hTurns = 0, dropAt = 2, dropped = false, resynced = 0, clientEnd = null;
  const hm = createMatch('host', { R: null, net: host, opts: { seed: 5, pace: false, noTimer: true }, ui: {
    onTurnStart: () => { hTurns++; setTimeout(() => hm.act({ type: 'hunker' }).then((r) => { if (!r.ok) hm.endTurn(); }), 1); },
    onStatus: (m) => statuses.push(m),
  } });
  const cm = createMatch('client', { R: null, net: cl, opts: { pace: false }, ui: {
    onTurnStart: () => {
      cTurns++;
      if (cTurns === dropAt && !dropped) { dropped = true; cl._simulateDrop(); return; } // vanish mid-turn
      setTimeout(() => cm.act({ type: 'overwatch' }).then((r) => { if (!r.ok) cm.endTurn(); }), 1);
    },
    onStatus: (m) => { if (/Back in the match/.test(m)) resynced++; },
    onMatchEnd: (s) => { clientEnd = s; },
  } });
  hm.start(); cm.start();
  await until(() => resynced > 0, 30000);
  assert.ok(statuses.some((m) => /lost connection|disconnected/i.test(m)), 'host saw the drop');
  // the dropped turn was auto-overwatched; the client keeps playing afterwards
  const before = cTurns;
  await until(() => cTurns > before || hm.over || !cm.state.units[cm.myUnitId].alive, 30000);
  // mirror never shows a hidden enemy at its real tile
  for (const u of cm.state.units) if (u.hidden) assert.equal(u.x, -99);
  // the host leaves: the client gets a clear message and the match ends for it
  hm.leave();
  await until(() => clientEnd, 15000);
  assert.ok(['host_left', 'over'].includes(clientEnd.reason), clientEnd.reason);
  cm.leave();
});
