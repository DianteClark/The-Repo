// Online lobby UI: host or join by code, roster with class badges and ready state, squads,
// mode (host; the stage is always random), start, kick, leave. Mounts into a container the UI provides (#onlineRoot).
//
//   import { mountLobby, joinCodeFromUrl } from './online/lobby.js';
//   const lobby = mountLobby(document.getElementById('onlineRoot'), {
//     profile: () => ({ name, cls, tier, level, loadout, cosmetics, card, emblem }),
//     onStart: ({ kind, net, lobby }) => { /* createMatch(kind, { R, sfx, ui, net }) and show the HUD */ },
//     onExit: () => { /* back to the hub */ },
//     intent: 'host' | 'join' | null,  code: 'ABC234' (prefill join),
//     sfx, // optional: uiClick(), uiError()
//   });
//   lobby.showHost(); lobby.showJoin(code); lobby.returnToLobby(); lobby.leave(); lobby.destroy();
//   lobby.session → the live net session (host or client) or null
//
// After a match ends, call lobby.returnToLobby() to show the roster again (same session, same code).

import { hostSession, joinSession, squadSizes, savedSession } from '../../net/session.js';
import { normalizeCode, CODE_LENGTH } from '../../net/codes.js';
import { transportKind } from '../../net/transport.js';
import * as K from '../../sim/constants.js';

let badgeSVG = null;
import('../ui/badges.js').then((m) => { badgeSVG = m.badgeSVG || null; }).catch(() => {});

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** ?join=CODE in the page URL, normalised (or null). */
export function joinCodeFromUrl(search = globalThis.location?.search || '') {
  try { return normalizeCode(new URLSearchParams(search).get('join') || ''); } catch { return null; }
}

/** The invite link for a code (keeps the page path, e.g. /The-Repo/, and ?net=loop when testing). */
export function inviteUrl(code) {
  const l = globalThis.location;
  if (!l) return `?join=${code}`;
  const q = new URLSearchParams();
  q.set('join', code);
  if (transportKind() === 'loop') q.set('net', 'loop');
  return `${l.origin}${l.pathname}?${q}`;
}

const STYLE = `
.tfo{position:relative;display:flex;flex-direction:column;gap:14px;max-width:760px;margin:0 auto;padding:18px 16px calc(18px + var(--sb,0px));color:var(--text,#e9e5d8);font:14px/1.35 var(--body,system-ui);user-select:none}
.tfo h2{margin:0;font:800 26px/1 var(--head,sans-serif);letter-spacing:.06em;text-transform:uppercase}
.tfo h3{margin:0 0 8px;font:700 13px/1 var(--head,sans-serif);letter-spacing:.14em;text-transform:uppercase;color:var(--muted,#8fa5a2)}
.tfo .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.tfo .grow{flex:1}
.tfo .card{background:var(--glass,rgba(12,28,34,.78));border:1px solid var(--line,rgba(160,220,215,.14));border-radius:var(--r,14px);padding:14px;backdrop-filter:blur(8px)}
.tfo .b{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:10px 18px;border-radius:12px;border:1px solid var(--line-hi,rgba(160,220,215,.28));background:var(--glass-hi,rgba(20,44,52,.86));color:var(--text,#e9e5d8);font:700 15px/1 var(--head,sans-serif);letter-spacing:.08em;text-transform:uppercase;cursor:pointer;transition:transform .12s var(--ease,ease),background .2s}
.tfo .b:active{transform:scale(.97)}
.tfo .b:disabled{opacity:.45;cursor:default}
.tfo .b.pri{background:linear-gradient(180deg,#ffc23a,var(--amber,#ffb000));color:#1c1300;border-color:transparent}
.tfo .b.cy{border-color:rgba(127,233,255,.45);color:var(--cyan,#7fe9ff)}
.tfo .b.ghost{background:transparent}
.tfo .b.sm{min-height:32px;padding:6px 10px;font-size:12px;border-radius:9px}
.tfo .b.danger{color:var(--danger,#ff5a4f);border-color:rgba(255,90,79,.4)}
.tfo .big2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.tfo .big2 .b{min-height:120px;flex-direction:column;font-size:20px}
.tfo .big2 .b small{font:500 12px/1.3 var(--body,system-ui);letter-spacing:0;text-transform:none;opacity:.75}
.tfo .code{font:800 clamp(40px,11vw,68px)/1 var(--head,monospace);letter-spacing:.18em;color:var(--amber,#ffb000);text-shadow:0 0 24px rgba(255,176,0,.35);user-select:text;-webkit-user-select:text}
.tfo .codein{width:100%;font:800 34px/1 var(--head,monospace);letter-spacing:.3em;text-align:center;text-transform:uppercase;padding:14px 8px;border-radius:12px;border:1px solid var(--line-hi,rgba(160,220,215,.28));background:rgba(0,0,0,.25);color:var(--amber,#ffb000);outline:none;user-select:text;-webkit-user-select:text}
.tfo .codein:focus{border-color:var(--amber,#ffb000)}
.tfo .note{font-size:12px;color:var(--muted,#8fa5a2)}
.tfo .status{min-height:20px;font-size:13px;color:var(--muted,#8fa5a2)}
.tfo .status.warn{color:var(--amber,#ffb000)} .tfo .status.error{color:var(--danger,#ff5a4f)} .tfo .status.ok{color:var(--cyan,#7fe9ff)}
.tfo .squads{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.tfo .sq{border:1px solid var(--line,rgba(160,220,215,.14));border-radius:12px;padding:8px;background:rgba(0,0,0,.18)}
.tfo .sq.mine{border-color:rgba(255,176,0,.55)}
.tfo .sq header{display:flex;align-items:center;justify-content:space-between;font:700 12px/1 var(--head,sans-serif);letter-spacing:.12em;text-transform:uppercase;color:var(--muted,#8fa5a2);margin-bottom:6px}
.tfo .pl{display:flex;align-items:center;gap:8px;padding:6px;border-radius:9px;background:rgba(255,255,255,.03);margin-top:4px}
.tfo .pl.me{background:rgba(255,176,0,.10)}
.tfo .pl .bd{width:34px;height:34px;flex:none;display:grid;place-items:center}
.tfo .pl .bd svg{width:34px;height:34px}
.tfo .pl .nm{font:700 15px/1.1 var(--head,sans-serif);letter-spacing:.04em}
.tfo .pl .cl{font-size:11px;color:var(--muted,#8fa5a2)}
.tfo .chip{font:700 10px/1 var(--head,sans-serif);letter-spacing:.12em;text-transform:uppercase;padding:4px 6px;border-radius:6px;border:1px solid var(--line-hi,rgba(160,220,215,.28));color:var(--muted,#8fa5a2)}
.tfo .chip.rd{color:#08151a;background:var(--cyan,#7fe9ff);border-color:transparent}
.tfo .chip.host{color:#1c1300;background:var(--amber,#ffb000);border-color:transparent}
.tfo .dot{width:8px;height:8px;border-radius:50%;background:#3ee08f;flex:none}
.tfo .dot.off{background:var(--danger,#ff5a4f);animation:tfoPulse 1s infinite}
.tfo .slot{padding:9px 6px;margin-top:4px;border-radius:9px;border:1px dashed var(--line,rgba(160,220,215,.14));color:var(--dim,#5f7473);font-size:12px;text-align:center}
.tfo select{min-height:40px;padding:6px 10px;border-radius:10px;background:var(--glass-hi,rgba(20,44,52,.86));color:var(--text,#e9e5d8);border:1px solid var(--line-hi,rgba(160,220,215,.28));font:600 14px/1 var(--body,system-ui)}
.tfo .foot{position:sticky;bottom:0;display:flex;gap:10px;padding-top:6px;background:linear-gradient(transparent,var(--bg,#0b171c) 35%)}
.tfo .foot .b{flex:1}
@keyframes tfoPulse{50%{opacity:.35}}
`;

function injectStyle() {
  if (document.getElementById('tfo-style')) return;
  const s = document.createElement('style');
  s.id = 'tfo-style';
  s.textContent = STYLE;
  document.head.appendChild(s);
}

const MODES = () => Object.entries(K.MODES || { solos: { name: 'Solos' } }).map(([key, m]) => ({ key, name: m.name || key }));
const className = (cls) => K.CLASSES?.[cls]?.name || cls || '';

export function mountLobby(root, cfg = {}) {
  injectStyle();
  const el = document.createElement('div');
  el.className = 'tfo';
  root.appendChild(el);
  const sfx = cfg.sfx || {};
  const click = () => { try { sfx.uiClick?.(); } catch { /* ignore */ } };
  const profile = () => (typeof cfg.profile === 'function' ? cfg.profile() : cfg.profile) || { name: 'Player', cls: 'assault' };
  let net = null;
  let screen = 'home';
  let status = { msg: '', level: '' };
  let busy = false;
  let offs = [];
  let destroyed = false;

  const setStatus = (msg, level = '') => { status = { msg, level }; const s = el.querySelector('.status'); if (s) { s.textContent = msg; s.className = 'status ' + level; } };

  function render() {
    if (destroyed) return;
    if (screen === 'home') renderHome();
    else if (screen === 'join') renderJoin();
    else if (screen === 'lobby') renderLobby();
    else if (screen === 'match') el.innerHTML = '';
  }

  function renderHome() {
    const prev = savedSession();
    const rejoin = prev && Date.now() - (prev.at || 0) < 2 * 3600e3 ? prev.code : null;
    el.innerHTML = `
      <div class="row"><h2 class="grow">Play online</h2><button class="b ghost sm" data-a="back">Back</button></div>
      ${rejoin ? `<button class="b cy" data-a="rejoin" data-code="${esc(rejoin)}">Rejoin game ${esc(rejoin)}</button>` : ''}
      <div class="big2">
        <button class="b pri" data-a="host">Host<small>Get a code, invite your squad</small></button>
        <button class="b cy" data-a="join">Join<small>Enter a 6-letter code</small></button>
      </div>
      <p class="note">Up to 16 players, bots fill the rest. Peer-to-peer: some cellular networks may block it. If joining fails, try Wi-Fi.</p>
      <div class="status ${status.level}">${esc(status.msg)}</div>`;
  }

  function renderJoin(prefill = '') {
    el.innerHTML = `
      <div class="row"><h2 class="grow">Join with code</h2><button class="b ghost sm" data-a="home">Back</button></div>
      <div class="card">
        <input class="codein" id="tfoCode" maxlength="${CODE_LENGTH + 2}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABC234" value="${esc(prefill)}" aria-label="Game code">
        <div class="row" style="margin-top:12px"><button class="b pri grow" data-a="dojoin">Join</button></div>
      </div>
      <p class="note">Some cellular networks may block peer-to-peer connections. If joining fails, try Wi-Fi.</p>
      <div class="status ${status.level}">${esc(status.msg)}</div>`;
    const inp = el.querySelector('#tfoCode');
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); e.stopPropagation(); });
    inp.addEventListener('input', () => { inp.value = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    setTimeout(() => inp.focus(), 50);
  }

  function renderLobby() {
    const L = net?.lobby;
    if (!L) return;
    const isHost = net.kind === 'host';
    const myPid = net.pid;
    const me = L.players.find((p) => p.pid === myPid);
    const sizes = L.sizes || squadSizes(L.settings.mode);
    const bySquad = sizes.map(() => []);
    for (const p of L.players) if (p.squad >= 0 && p.squad < sizes.length) bySquad[p.squad].push(p);
    const can = isHost ? net.canStart() : null;
    const modeName = MODES().find((m) => m.key === L.settings.mode)?.name || L.settings.mode;
    const showSquads = bySquad.map((list, i) => ({ list, i })).filter(({ list, i }) => list.length || (sizes[i] > 1 && i < Math.max(2, bySquad.filter((l) => l.length).length + 1)));
    const squadOpts = (cur) => sizes.map((n, i) => `<option value="${i}" ${i === cur ? 'selected' : ''}>Squad ${i + 1}</option>`).join('');
    el.innerHTML = `
      <div class="row"><h2 class="grow">${isHost ? 'Your lobby' : 'Lobby'}</h2><span class="chip">${L.players.length}/16</span></div>
      <div class="card">
        <h3>Invite code</h3>
        <div class="row"><div class="code grow" data-code>${esc(L.code)}</div></div>
        <div class="row" style="margin-top:10px">
          <button class="b sm" data-a="copy">Copy code</button>
          <button class="b sm" data-a="copylink">Copy link</button>
          ${navigator.share ? '<button class="b sm cy" data-a="share">Share</button>' : ''}
        </div>
        <p class="note" style="margin:10px 0 0">Friends open the link or enter the code under Join. Some cellular networks may block peer-to-peer; Wi-Fi is safest.</p>
      </div>
      <div class="card">
        <div class="row" style="margin-bottom:10px">
          <h3 class="grow" style="margin:0">Match</h3>
          ${isHost ? `<select data-set="mode" aria-label="Mode">${MODES().map((m) => `<option value="${m.key}" ${m.key === L.settings.mode ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`
    : `<span class="chip">${esc(modeName)}</span>`}
        </div>
        <div class="squads">${showSquads.map(({ list, i }) => `
          <div class="sq${list.some((p) => p.pid === myPid) ? ' mine' : ''}">
            <header><span>Squad ${i + 1}</span>${!isHost && me && me.squad !== i && list.length < sizes[i] ? `<button class="b sm ghost" data-a="squad" data-s="${i}">Join</button>` : `<span>${list.length}/${sizes[i]}</span>`}</header>
            ${list.map((p) => `
              <div class="pl${p.pid === myPid ? ' me' : ''}" data-pid="${esc(p.pid)}">
                <span class="dot${p.connected ? '' : ' off'}" title="${p.connected ? 'Connected' : 'Reconnecting'}"></span>
                <span class="bd">${badgeSVG ? badgeSVG(p.cls, p.tier || 0, { size: 34, title: false }) : ''}</span>
                <span class="grow"><div class="nm">${esc(p.name)}</div><div class="cl">${esc(className(p.cls))}${p.level ? ` · Lv ${p.level}` : ''}${p.connected ? '' : ' · reconnecting'}</div></span>
                ${p.isHost ? '<span class="chip host">Host</span>' : p.ready ? '<span class="chip rd">Ready</span>' : '<span class="chip">Not ready</span>'}
                ${isHost && !p.isHost ? `<select data-move="${esc(p.pid)}" aria-label="Squad">${squadOpts(p.squad)}</select><button class="b sm danger" data-a="kick" data-pid="${esc(p.pid)}" aria-label="Kick ${esc(p.name)}">Kick</button>` : ''}
                ${isHost && p.isHost ? `<select data-move="${esc(p.pid)}" aria-label="Squad">${squadOpts(p.squad)}</select>` : ''}
              </div>`).join('')}
            ${Array.from({ length: Math.max(0, sizes[i] - list.length) }, () => '<div class="slot">Bot</div>').join('')}
          </div>`).join('')}
        </div>
        <p class="note" style="margin:10px 0 0">Empty slots are filled by bots. ${sizes.length} squads in ${esc(modeName)}. The stage wheel picks the map at drop-in.</p>
      </div>
      <div class="status ${status.level}">${esc(status.msg)}</div>
      <div class="foot">
        <button class="b ghost" data-a="leave">Leave</button>
        ${isHost ? `<button class="b pri" data-a="start" ${can.ok && !busy ? '' : 'disabled'} title="${esc(can.reason || '')}">Start match</button>`
    : `<button class="b ${me?.ready ? 'cy' : 'pri'}" data-a="ready">${me?.ready ? 'Ready ✓' : 'Ready up'}</button>`}
      </div>`;
    if (isHost && !can.ok && !status.msg) setStatus(can.reason, '');
  }

  // ---------------------------------------------------------------- actions

  async function doHost() {
    if (busy) return;
    busy = true;
    setStatus('Creating a lobby…');
    try {
      net = await hostSession({ profile: profile(), settings: { mode: cfg.mode || 'duos', stage: 'random' } }); // 5.1: always random, the stage wheel reveals it
      wire();
      screen = 'lobby';
      status = { msg: 'Lobby open. Share the code.', level: 'ok' };
    } catch (e) {
      status = { msg: e.code === 'network' ? 'Could not reach the matchmaking server. Check your connection.' : (e.message || 'Could not create a lobby'), level: 'error' };
      try { sfx.uiError?.(); } catch { /* ignore */ }
    }
    busy = false;
    render();
  }

  async function doJoin(codeArg) {
    if (busy) return;
    const raw = codeArg ?? el.querySelector('#tfoCode')?.value ?? '';
    const code = normalizeCode(raw);
    if (!code) { setStatus(`Codes are ${CODE_LENGTH} letters and numbers.`, 'error'); try { sfx.uiError?.(); } catch { /* ignore */ } return; }
    busy = true;
    setStatus('Connecting…');
    const btn = el.querySelector('[data-a="dojoin"]');
    if (btn) btn.disabled = true;
    try {
      const prev = savedSession();
      net = await joinSession({ code, profile: profile(), token: prev?.code === code ? prev.token : null });
      wire();
      screen = 'lobby';
      status = { msg: 'Joined. Ready up when you are set.', level: 'ok' };
    } catch (e) {
      const msg = e.code === 'not_found' ? 'No game with that code. Check it with the host.'
        : e.code === 'timeout' ? 'Could not reach the host. Some cellular networks block peer-to-peer; try Wi-Fi.'
          : e.code === 'kicked' ? 'The host removed you from that lobby.'
            : e.message || 'Could not join';
      status = { msg, level: 'error' };
      try { sfx.uiError?.(); } catch { /* ignore */ }
      busy = false;
      renderJoin(code);
      return;
    }
    busy = false;
    render();
  }

  function wire() {
    for (const o of offs) o();
    offs = [];
    offs.push(net.on('lobby', () => { if (screen === 'lobby') render(); }));
    offs.push(net.on('status', (msg, level) => { if (screen === 'lobby') setStatus(msg, level); }));
    offs.push(net.on('closed', (info) => {
      net = null;
      for (const o of offs) o();
      offs = [];
      if (screen === 'match') { screen = 'home'; status = { msg: info?.msg || 'Disconnected', level: 'error' }; return; } // the match controller reports it in-game
      screen = 'home';
      status = { msg: info?.msg || 'Disconnected', level: info?.reason === 'left' ? '' : 'error' };
      render();
    }));
    if (net.kind === 'client') {
      offs.push(net.onMessage((m) => {
        if (m.t === 'start' && screen !== 'match') startMatch('client');
      }));
      offs.push(net.on('connection', (on) => { if (screen === 'lobby') setStatus(on ? 'Reconnected' : 'Connection lost. Reconnecting…', on ? 'ok' : 'warn'); }));
      // Rejoined mid-match (page reload or network swap): the host resends 'start'.
    }
  }

  function startMatch(kind) {
    screen = 'match';
    render();
    try { cfg.onStart?.({ kind, net, lobby: net.lobby }); } catch (e) { console.error('[lobby] onStart', e); }
  }

  async function copy(text, label) {
    try { await navigator.clipboard.writeText(text); setStatus(`${label} copied`, 'ok'); } catch { setStatus(text, ''); }
  }

  el.addEventListener('change', (e) => {
    const t = e.target;
    if (!net) return;
    if (t.dataset.set) { click(); net.setSettings({ [t.dataset.set]: t.value }); }
    if (t.dataset.move !== undefined) { click(); net.setSquad(t.dataset.move, +t.value); }
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (!b || b.disabled) return;
    click();
    const a = b.dataset.a;
    switch (a) {
      case 'back': cfg.onExit?.(); break;
      case 'home': status = { msg: '', level: '' }; screen = 'home'; render(); break;
      case 'host': doHost(); break;
      case 'join': status = { msg: '', level: '' }; screen = 'join'; renderJoin(cfg.code || ''); break;
      case 'dojoin': doJoin(); break;
      case 'rejoin': screen = 'join'; renderJoin(b.dataset.code); doJoin(b.dataset.code); break;
      case 'copy': copy(net.lobby.code, 'Code'); break;
      case 'copylink': copy(inviteUrl(net.lobby.code), 'Invite link'); break;
      case 'share':
        navigator.share?.({ title: 'Tidefall', text: `Join my Tidefall squad. Code ${net.lobby.code}`, url: inviteUrl(net.lobby.code) }).catch(() => {});
        break;
      case 'ready': { const me = net.lobby.players.find((p) => p.pid === net.pid); net.setReady(!me?.ready); break; }
      case 'squad': net.setSquad(+b.dataset.s); break;
      case 'kick': net.kick(b.dataset.pid); break;
      case 'start': {
        const c = net.canStart();
        if (!c.ok) { setStatus(c.reason, 'warn'); break; }
        startMatch('host');
        break;
      }
      case 'leave': api.leave(); break;
      default:
    }
  });

  const api = {
    get session() { return net; },
    get screen() { return screen; },
    showHome() { screen = 'home'; render(); },
    showHost() { if (net) { screen = 'lobby'; render(); } else { screen = 'home'; render(); doHost(); } },
    showJoin(code = '') { screen = 'join'; status = { msg: '', level: '' }; renderJoin(code); if (normalizeCode(code)) doJoin(code); },
    /** After a match: back to the roster (same session) or home if the session is gone. */
    returnToLobby() { screen = net && !net.closed ? 'lobby' : 'home'; render(); },
    leave() {
      if (net) { if (net.kind === 'host') net.close('host_left', 'The host closed the lobby.'); else net.leave(); }
      net = null;
      screen = 'home';
      status = { msg: '', level: '' };
      render();
    },
    /** Push an updated profile (class, loadout, callsign) to the lobby. */
    updateProfile(p = profile()) { net?.updateProfile(p); },
    destroy() { destroyed = true; for (const o of offs) o(); el.remove(); },
  };

  const urlCode = cfg.code ? normalizeCode(cfg.code) : joinCodeFromUrl();
  if (cfg.intent === 'host') api.showHost();
  else if (cfg.intent === 'join' || urlCode) api.showJoin(urlCode || '');
  else render();
  return api;
}
