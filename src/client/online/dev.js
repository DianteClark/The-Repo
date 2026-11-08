// Dev / test harness for NET (not shipped in the app shell, no precache needed):
//   src/client/online/dev.html?net=loop&gfx=low          lobby (host / join), then a minimal match HUD
//   src/client/online/dev.html?solo&gfx=low              solo vs bots through createMatch('local')
// Exposes window.__net for Playwright.
import { mountLobby } from './lobby.js';
import { createMatch } from '../match/index.js';
import * as G from '../../sim/game.js';

const $ = (id) => document.getElementById(id);
const P = new URLSearchParams(location.search);
const log = (...a) => { const d = document.createElement('div'); d.textContent = a.join(' '); $('devLog').prepend(d); while ($('devLog').children.length > 60) $('devLog').lastChild.remove(); };

let R = null;
try {
  const RM = await import('../render.js');
  R = new RM.Renderer($('scene'), { sfx: null, onTileTap: () => {}, onUnitTap: () => {}, onTileHover: () => {}, onFeed: () => {} });
} catch (e) { log('renderer failed', e.message); }

const W = window.__net = { match: null, lobby: null, events: 0, turns: 0, log: [], myTurn: false, ended: null, statuses: [], R };
const ui = {
  onIntro: () => (R?.playDropIn ? Promise.race([Promise.resolve(R.playDropIn()), new Promise((r) => setTimeout(r, 50))]).then(() => R.skipDropIn?.()) : null),
  onEvent: (ev) => { W.events++; if (ev.type === 'round_start') (W.rounds ||= []).push([ev.round, performance.now()]); if (['death', 'team_out', 'game_over', 'ping', 'round_start'].includes(ev.type)) log(ev.type, JSON.stringify(ev).slice(0, 80)); },
  onTurnStart: (t) => { W.myTurn = true; W.turns++; log('MY TURN', t.unitId); hudInfo(); },
  onTurnEnd: (t) => { W.myTurn = false; log('turn end', t.reason); hudInfo(); },
  onTick: (t) => { W.left = t.left; hudInfo(); },
  onStep: (s) => { W.step = s; },
  onMatchEnd: (s) => { W.ended = s; log('MATCH END', JSON.stringify(s)); hudInfo(); },
  onStatus: (m, l) => { W.statuses.push(m); log('status', l, m); },
  onConnection: (on) => log('connection', on),
  onState: () => hudInfo(),
};
function hudInfo() {
  const m = W.match;
  if (!m?.state) return;
  const u = m.state.units[m.myUnitId];
  $('devInfo').textContent = `${m.kind} · team ${m.myTeam} · unit ${m.myUnitId} ${u ? `${u.cls} hp ${u.hp} ap ${u.ap}` : ''} · round ${m.state.round} · ${W.myTurn ? `YOUR TURN ${Math.ceil(W.left ?? 20)}s` : m.spectating ? `spectating ${m.speed}×` : 'waiting'} · hidden ${m.state.units.filter((x) => x.hidden).length}`;
}

function startMatch(kind, net, opts = {}) {
  $('devHud').classList.remove('hidden');
  $('onlineRoot').style.display = 'none';
  const m = createMatch(kind, { R, sfx: null, ui, net, opts: { noTimer: P.has('notimer'), ...opts } });
  W.match = m;
  m.start().then((s) => { W.ended = W.ended || s; });
  return m;
}

// Actions the tests (and the buttons) use
W.move = async () => {
  const m = W.match; const st = m.state; const u = st.units[m.myUnitId];
  if (!W.myTurn) return 'not my turn';
  const reach = G.moveOptions(st, u);
  const opts = [...reach.entries()].filter(([, n]) => n.d > 0 && n.d <= u.move);
  if (!opts.length) return 'nothing reachable';
  const [k] = opts[Math.floor(Math.random() * opts.length)];
  const S = st.map.size;
  const r = await m.act({ type: 'move', x: k % S, y: (k / S) | 0 });
  return r.ok ? `moved ${k % S},${(k / S) | 0}` : 'fail ' + r.error;
};
W.shoot = async () => {
  const m = W.match; const st = m.state; const u = st.units[m.myUnitId];
  if (!W.myTurn) return 'not my turn';
  const t = st.units.find((o) => o.alive && !o.hidden && o.team !== u.team && G.shotPreview?.(st, u, o));
  if (!t) return 'no target';
  const r = await m.act({ type: 'shoot', targetId: t.id });
  return r.ok ? 'shot ' + t.id : 'fail ' + r.error;
};
W.overwatch = async () => { if (!W.myTurn) return 'not my turn'; const r = await W.match.act({ type: 'overwatch' }); if (!r.ok) await W.match.endTurn(); return r.ok ? 'ow' : r.error; };
W.end = async () => (await W.match.endTurn()).ok;
W.autoplay = async () => {
  if (!W.myTurn) return 'waiting';
  const a = await W.shoot();
  if (a.startsWith('shot')) return a;
  const b = await W.move();
  if (W.myTurn) await W.overwatch();
  return b;
};

$('devHud').addEventListener('click', async (e) => {
  const a = e.target.dataset?.a; if (!a) return;
  if (a === 'move') log(await W.move());
  if (a === 'shoot') log(await W.shoot());
  if (a === 'ow') log(await W.overwatch());
  if (a === 'end') log(await W.end());
  if (a[0] === 's') { W.match.setSpeed(+a.slice(1)); log('speed', a.slice(1)); }
  if (a === 'ff') log('ff', W.match.fastForward());
  if (a === 'leave') { W.match.leave(); $('onlineRoot').style.display = ''; W.lobby?.returnToLobby(); }
});

if (P.has('solo')) {
  const m = startMatch('local', null, { mode: P.get('mode') || 'solos', stage: P.get('stage') || 'harbor', cls: 'recon', callsign: 'Solo', seed: +(P.get('seed') || 5) });
  if (P.has('spectate')) {
    // Speed test: my unit is out from the start, so everything plays as a spectator.
    const u = m.state.units[m.myUnitId];
    u.alive = false; u.hp = 0;
    m.state.eliminated.push(u.team);
    R?.syncFromState?.();
    m.setSpeed(+(P.get('speed') || 1));
    W.t0 = performance.now();
  }
} else {
  W.lobby = mountLobby($('onlineRoot'), {
    profile: () => ({ name: P.get('name') || (P.has('join') ? 'Joiner' : 'Hoster'), cls: P.get('cls') || 'medic', tier: 2, level: 7 }),
    onStart: ({ kind, net }) => { log('start', kind); startMatch(kind, net, { seed: +(P.get('seed') || 3) }); },
    onExit: () => log('exit'),
    intent: P.get('intent'),
  });
}
