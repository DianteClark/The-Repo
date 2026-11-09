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
.tfo .squads{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--sqmin,210px),1fr));gap:8px}
.tfo .squads.solo{--sqmin:180px}
.tfo .sq{border:1px solid var(--line,rgba(160,220,215,.14));border-radius:12px;padding:6px 8px 8px;background:rgba(0,0,0,.18);min-width:0}
.tfo .sq.mine{border-color:rgba(255,176,0,.55)}
.tfo .sq header{display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:28px;font:700 12px/1 var(--head,sans-serif);letter-spacing:.12em;text-transform:uppercase;color:var(--muted,#8fa5a2);margin-bottom:2px}
.tfo .pl{display:grid;grid-template-columns:8px 40px minmax(0,1fr);align-items:center;column-gap:8px;row-gap:6px;padding:6px;border-radius:9px;background:rgba(255,255,255,.03);margin-top:4px;min-height:52px;box-sizing:border-box}
.tfo .pl.me{background:rgba(255,176,0,.10)}
.tfo .pl .tbd{width:40px;height:40px;display:flex;align-items:center;justify-content:center;align-self:center;justify-self:center;line-height:0}
.tfo .pl .tbd svg{width:36px;height:36px;display:block;margin:0;flex:none}
.tfo .pl .who{min-width:0}
.tfo .pl .nm{font:700 15px/1.1 var(--head,sans-serif);letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tfo .pl .cl{display:flex;align-items:center;gap:6px;margin-top:3px;font-size:11px;color:var(--muted,#8fa5a2);white-space:nowrap;overflow:hidden;min-width:0}
.tfo .pl .cl > span:last-child{overflow:hidden;text-overflow:ellipsis;min-width:0}
.tfo .pl .cl .chip{flex:none;padding:3px 5px;font-size:9px}
.tfo .pl .ctl{grid-column:2/-1;display:flex;gap:6px;align-items:center}
.tfo .pl .ctl select{flex:1;min-height:32px;min-width:0;padding:4px 8px;font-size:12px}
.tfo .chip{font:700 10px/1 var(--head,sans-serif);letter-spacing:.12em;text-transform:uppercase;padding:4px 6px;border-radius:6px;border:1px solid var(--line-hi,rgba(160,220,215,.28));color:var(--muted,#8fa5a2);white-space:nowrap}
.tfo .chip.rd{color:#08151a;background:var(--cyan,#7fe9ff);border-color:transparent}
.tfo .chip.host{color:#1c1300;background:var(--amber,#ffb000);border-color:transparent}
.tfo .tdot{width:8px;height:8px;border-radius:50%;background:#3ee08f;flex:none}
.tfo .tdot.off{background:var(--danger,#ff5a4f);animation:tfoPulse 1s infinite}
.tfo .slot{display:grid;grid-template-columns:8px 40px minmax(0,1fr);align-items:center;column-gap:8px;padding:4px 6px;margin-top:4px;min-height:40px;box-sizing:border-box;border-radius:9px;border:1px dashed var(--line,rgba(160,220,215,.14));color:var(--dim,#5f7473);font-size:12px}
.tfo .slot .bi{grid-column:2;width:28px;height:28px;justify-self:center;border-radius:50%;border:1px dashed currentColor;display:grid;place-items:center;font:800 10px/1 var(--head,sans-serif);letter-spacing:.05em}
.tfo .sum{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline;margin:0 0 10px}
.tfo .sum b{font:800 22px/1 var(--head,sans-serif);color:var(--text,#e9e5d8)}
.tfo .sum span{font-size:12px;color:var(--muted,#8fa5a2)}
.tfo .tseg{display:flex;flex-wrap:wrap;gap:6px}
.tfo .tseg .b{min-height:36px;padding:6px 12px;font-size:13px}
.tfo .tseg .b.on{background:linear-gradient(180deg,#ffc23a,var(--amber,#ffb000));color:#1c1300;border-color:transparent}
.tfo .recon{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,176,0,.45);background:rgba(60,40,0,.35);color:var(--amber,#ffb000);font-weight:700}
.tfo .fail{text-align:center;display:flex;flex-direction:column;gap:12px;align-items:stretch}
.tfo .fail p{margin:0}
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set(['network', 'timeout', 'not_found']);

/** "Duos · 8 squads × 2", "Trios · 5 squads × 3 + lone wolf". */
export function modeLayout(mode, total = 16) {
  const sizes = squadSizes(mode, total);
  const n = sizes[0] || 1;
  const full = sizes.filter((x) => x === n).length;
  const rest = sizes.filter((x) => x !== n);
  const name = MODES().find((m) => m.key === mode)?.name || mode;
  if (n === 1) return `${name} · ${total} players, every one for themselves`;
  return `${name} · ${full} squads × ${n}${rest.length ? ` + ${rest.length === 1 && rest[0] === 1 ? 'lone wolf' : rest.join(', ')}` : ''}`;
}

export function mountLobby(root, cfg = {}) {
  injectStyle();
  const el = document.createElement('div');
  el.className = 'tfo';
  root.appendChild(el);
  const sfx = cfg.sfx || {};
  const click = () => { try { sfx.uiClick?.(); } catch { /* ignore */ } };
  const err = () => { try { sfx.uiError?.(); } catch { /* ignore */ } };
  const profile = () => (typeof cfg.profile === 'function' ? cfg.profile() : cfg.profile) || { name: 'Player', cls: 'assault' };
  let net = null;
  let screen = 'home'; // home | join | lobby | failed | match
  let status = { msg: '', level: '' };
  let busy = false;
  let offs = [];
  let destroyed = false;
  let gen = 0; // bumps on every Back/leave: a join/host still in flight is abandoned (and left)
  let fail = null; // {title, msg, retry: 'join'|'host'|null, code}
  let escArmed = 0;
  let lastCode = cfg.code || '';

  const setStatus = (msg, level = '') => { status = { msg, level }; const s = el.querySelector('.status'); if (s) { s.textContent = msg; s.className = 'status ' + level; } };

  function render() {
    if (destroyed) return;
    if (screen === 'home') renderHome();
    else if (screen === 'join') renderJoin(lastCode);
    else if (screen === 'lobby') renderLobby();
    else if (screen === 'failed') renderFailed();
    else if (screen === 'match') el.innerHTML = '';
  }

  // While a client is reconnecting in the lobby: "Reconnecting… 12s" with a Retry button.
  const reconTick = setInterval(() => {
    if (destroyed || screen !== 'lobby' || !net) return;
    const r = net.reconnecting;
    const box = el.querySelector('.recon');
    if (!!r !== !!box) { render(); return; }
    if (r && box) box.querySelector('[data-s]').textContent = `${Math.max(0, Math.round((Date.now() - r.since) / 1000))}s`;
  }, 1000);

  function renderHome() {
    const prev = savedSession();
    const rejoin = prev && Date.now() - (prev.at || 0) < 2 * 3600e3 ? prev.code : null;
    el.innerHTML = `
      <div class="row"><h2 class="grow">Play online</h2><button class="b ghost sm" data-a="back">Back to hub</button></div>
      ${rejoin ? `<button class="b cy" data-a="rejoin" data-code="${esc(rejoin)}">Rejoin game ${esc(rejoin)}</button>` : ''}
      <div class="big2">
        <button class="b pri" data-a="host">Host<small>Get a code, invite your squad</small></button>
        <button class="b cy" data-a="join">Join<small>Enter a 6-letter code</small></button>
      </div>
      <p class="note">Up to 16 players, bots fill the rest. Direct peer-to-peer (no relay server): a few cellular networks block it. If a friend can't connect, one of you on Wi-Fi usually fixes it.</p>
      <div class="status ${status.level}">${esc(status.msg)}</div>`;
  }

  function renderJoin(prefill = '') {
    el.innerHTML = `
      <div class="row"><h2 class="grow">Join with code</h2><button class="b ghost sm" data-a="back">Back to hub</button></div>
      <div class="card">
        <input class="codein" id="tfoCode" maxlength="${CODE_LENGTH + 2}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABC234" value="${esc(prefill)}" aria-label="Game code">
        <div class="row" style="margin-top:12px"><button class="b pri grow" data-a="dojoin" ${busy ? 'disabled' : ''}>${busy ? 'Connecting…' : 'Join'}</button></div>
      </div>
      <p class="note">Direct peer-to-peer: a few cellular networks block it. We retry automatically; if it still fails, one of you on Wi-Fi usually fixes it.</p>
      <div class="status ${status.level}">${esc(status.msg)}</div>`;
    const inp = el.querySelector('#tfoCode');
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') doJoin();
      else if (e.key === 'Escape') { e.preventDefault(); api.back(); }
    });
    inp.addEventListener('input', () => { inp.value = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); lastCode = inp.value; });
    if (!busy) setTimeout(() => { if (el.contains(inp)) inp.focus(); }, 50);
  }

  function renderFailed() {
    const f = fail || { title: 'Disconnected', msg: status.msg || 'The connection ended.' };
    el.innerHTML = `
      <div class="row"><h2 class="grow">${esc(f.title)}</h2><button class="b ghost sm" data-a="back">Back to hub</button></div>
      <div class="card fail">
        <p>${esc(f.msg)}</p>
        ${f.hint ? `<p class="note">${esc(f.hint)}</p>` : ''}
        ${f.retry ? `<button class="b pri" data-a="retry">${f.retry === 'host' ? 'Try again' : `Retry${f.code ? ` ${esc(f.code)}` : ''}`}</button>` : ''}
        <button class="b ghost" data-a="back">Back to hub</button>
      </div>
      <div class="status ${status.level}">${esc(status.msg && status.msg !== f.msg ? status.msg : '')}</div>`;
  }

  function playerRow(p, { isHost, myPid, squadOpts, solo }) {
    const tag = p.isHost ? '<span class="chip host">Host</span>' : p.ready ? '<span class="chip rd">Ready</span>' : '<span class="chip">Not ready</span>';
    const ctl = isHost && solo ? (p.isHost ? '' : `<div class="ctl"><button class="b sm danger grow" data-a="kick" data-pid="${esc(p.pid)}" aria-label="Kick ${esc(p.name)}">Kick</button></div>`)
      : isHost ? `<div class="ctl"><select data-move="${esc(p.pid)}" aria-label="Squad for ${esc(p.name)}">${squadOpts(p.squad)}</select>${p.isHost ? '' : `<button class="b sm danger" data-a="kick" data-pid="${esc(p.pid)}" aria-label="Kick ${esc(p.name)}">Kick</button>`}</div>` : '';
    return `
      <div class="pl${p.pid === myPid ? ' me' : ''}" data-pid="${esc(p.pid)}">
        <span class="tdot${p.connected ? '' : ' off'}" title="${p.connected ? 'Connected' : 'Reconnecting'}"></span>
        <span class="tbd">${badgeSVG ? badgeSVG(p.cls, p.tier || 0, { size: 36, title: false }) : ''}</span>
        <span class="who"><div class="nm">${esc(p.name)}${p.pid === myPid ? ' (you)' : ''}</div><div class="cl">${tag}<span>${esc(className(p.cls))}${p.level ? ` · Lv ${p.level}` : ''}${p.connected ? '' : ' · reconnecting'}</span></div></span>
        ${ctl}
      </div>`;
  }

  function renderLobby() {
    const L = net?.lobby;
    if (!L) return;
    const isHost = net.kind === 'host';
    const myPid = net.pid;
    const me = L.players.find((p) => p.pid === myPid);
    const sizes = L.sizes || squadSizes(L.settings.mode);
    const total = sizes.reduce((a, b) => a + b, 0);
    const bySquad = sizes.map(() => []);
    for (const p of L.players) if (p.squad >= 0 && p.squad < sizes.length) bySquad[p.squad].push(p);
    const humans = L.players.length;
    const bots = Math.max(0, total - humans);
    const can = isHost ? net.canStart() : null;
    const solo = Math.max(...sizes) === 1;
    const squadOpts = (cur) => sizes.map((n, i) => `<option value="${i}" ${i === cur ? 'selected' : ''}>${solo ? 'Slot' : 'Squad'} ${i + 1}</option>`).join('');
    const r = net.reconnecting;
    el.innerHTML = `
      <div class="row"><h2 class="grow">${isHost ? 'Your lobby' : 'Lobby'}</h2><button class="b ghost sm" data-a="leave">${isHost ? 'Close lobby' : 'Leave'}</button></div>
      ${r ? `<div class="recon" role="status"><span class="grow">Reconnecting… <span data-s>${Math.round((Date.now() - r.since) / 1000)}s</span></span><button class="b sm" data-a="retrynow">Retry now</button></div>` : ''}
      <div class="card">
        <h3>Invite code</h3>
        <div class="row"><div class="code grow" data-code>${esc(L.code)}</div></div>
        <div class="row" style="margin-top:10px">
          <button class="b sm" data-a="copy">Copy code</button>
          <button class="b sm" data-a="copylink">Copy link</button>
          ${navigator.share ? '<button class="b sm cy" data-a="share">Share</button>' : ''}
        </div>
        <p class="note" style="margin:10px 0 0">Friends open the link or enter the code under Join. Direct peer-to-peer: a few cellular networks block it; Wi-Fi on either side usually fixes that.</p>
      </div>
      <div class="card">
        <div class="sum" data-sum><b>${humans} / ${total} players</b><span>· ${bots} bot${bots === 1 ? '' : 's'} fill the rest</span><span class="grow"></span><span data-layout>${esc(modeLayout(L.settings.mode, total))}</span></div>
        ${isHost ? `<div class="tseg" role="radiogroup" aria-label="Mode" style="margin-bottom:10px">${MODES().map((m) => `<button class="b ghost${m.key === L.settings.mode ? ' on' : ''}" role="radio" aria-checked="${m.key === L.settings.mode}" data-a="mode" data-m="${m.key}">${esc(m.name)}</button>`).join('')}</div>` : ''}
        <div class="squads${solo ? ' solo' : ''}">${bySquad.map((list, i) => `
          <div class="sq${list.some((p) => p.pid === myPid) ? ' mine' : ''}" data-squad="${i}">
            <header><span>${solo ? 'Slot' : sizes[i] === 1 && sizes.length > 1 && sizes[0] > 1 ? 'Lone wolf' : 'Squad'} ${solo || !(sizes[i] === 1 && sizes[0] > 1) ? i + 1 : ''}</span>${!isHost && me && me.squad !== i && list.length < sizes[i] ? `<button class="b sm ghost" data-a="squad" data-s="${i}">Join</button>` : `<span>${list.length}/${sizes[i]}</span>`}</header>
            ${list.map((p) => playerRow(p, { isHost, myPid, squadOpts, solo })).join('')}
            ${Array.from({ length: Math.max(0, sizes[i] - list.length) }, () => '<div class="slot"><span class="bi">BOT</span><span>Bot fill</span></div>').join('')}
          </div>`).join('')}
        </div>
        <p class="note" style="margin:10px 0 0">${isHost ? 'Change the mode any time before you start. ' : ''}Empty slots are played by bots. The stage wheel picks the map at drop-in.</p>
      </div>
      <div class="status ${status.level}">${esc(status.msg)}</div>
      <div class="foot">
        <button class="b ghost" data-a="leave">${isHost ? 'Close lobby' : 'Leave'}</button>
        ${isHost ? `<button class="b pri" data-a="start" ${can.ok && !busy ? '' : 'disabled'} title="${esc(can.reason || '')}">Start match</button>`
    : `<button class="b ${me?.ready ? 'cy' : 'pri'}" data-a="ready">${me?.ready ? 'Ready ✓' : 'Ready up'}</button>`}
      </div>`;
    if (isHost && !can.ok && !status.msg) setStatus(can.reason, '');
  }

  // ---------------------------------------------------------------- actions

  function showFail(f) {
    fail = f;
    screen = 'failed';
    status = { msg: '', level: '' };
    render();
  }

  async function doHost() {
    if (busy) return;
    busy = true;
    const my = ++gen;
    fail = null;
    screen = 'home';
    status = { msg: 'Creating a lobby…', level: '' };
    render();
    let made = null, last = null;
    for (let i = 0; i < 3 && !made; i++) {
      try {
        made = await hostSession({ profile: profile(), settings: { mode: cfg.mode || 'duos', stage: 'random' } }); // 5.1: always random, the stage wheel reveals it
      } catch (e) {
        last = e;
        if (my !== gen || destroyed || e.code !== 'network') break;
        setStatus(`Matchmaking didn't answer. Trying again (${i + 2}/3)…`, 'warn');
        await sleep(1200 * (i + 1));
      }
      if (my !== gen || destroyed) { try { made?.close('host_left', 'The host closed the lobby.'); } catch { /* ignore */ } busy = false; return; }
    }
    busy = false;
    if (!made) {
      err();
      showFail({ title: "Couldn't host", msg: last?.code === 'network' ? 'Could not reach the matchmaking server. Check your connection.' : (last?.message || 'Could not create a lobby.'), retry: 'host' });
      return;
    }
    net = made;
    wire();
    screen = 'lobby';
    status = { msg: 'Lobby open. Share the code.', level: 'ok' };
    render();
  }

  async function doJoin(codeArg) {
    if (busy) return;
    const raw = codeArg ?? el.querySelector('#tfoCode')?.value ?? lastCode ?? '';
    const code = normalizeCode(raw);
    if (!code) { setStatus(`Codes are ${CODE_LENGTH} letters and numbers.`, 'error'); err(); return; }
    lastCode = code;
    busy = true;
    const my = ++gen;
    fail = null;
    screen = 'join';
    status = { msg: 'Connecting…', level: '' };
    render();
    const TRIES = 4;
    let joined = null, last = null;
    for (let i = 0; i < TRIES && !joined; i++) {
      try {
        const prev = savedSession();
        joined = await joinSession({ code, profile: profile(), token: prev?.code === code ? prev.token : null });
      } catch (e) {
        last = e;
        if (my !== gen || destroyed) break;
        // not_found twice in a row is a wrong code (or the host left); network trouble gets every try.
        if (!RETRYABLE.has(e.code) || (e.code === 'not_found' && i >= 1) || i === TRIES - 1) break;
        setStatus(`${e.code === 'not_found' ? 'Looking for the host' : 'Still trying to reach the host'}… (attempt ${i + 2} of ${TRIES})`, 'warn');
        await sleep(backoffMs(i));
      }
      if (my !== gen || destroyed) break;
    }
    busy = false;
    if (my !== gen || destroyed) { try { joined?.leave(); } catch { /* ignore */ } return; }
    if (!joined) {
      err();
      const c = last?.code;
      const msg = c === 'not_found' ? 'No game with that code. Check it with the host (codes expire when the host closes the lobby).'
        : c === 'timeout' || c === 'network' ? 'Could not reach the host.'
          : c === 'kicked' ? 'The host removed you from that lobby.'
            : last?.message || 'Could not join.';
      showFail({ title: "Couldn't join", msg, code, retry: c === 'kicked' || c === 'started' || c === 'full' || c === 'version' ? null : 'join',
        hint: c === 'timeout' || c === 'network' ? 'Direct peer-to-peer did not get through. Cellular networks sometimes block it; switching either device to Wi-Fi usually fixes it.' : '' });
      return;
    }
    net = joined;
    wire();
    screen = 'lobby';
    status = { msg: 'Joined. Ready up when you are set.', level: 'ok' };
    render();
  }
  const backoffMs = (i) => [800, 1800, 3500, 5000][i] || 5000;

  function wire() {
    for (const o of offs) o();
    offs = [];
    const mine = net;
    offs.push(net.on('lobby', () => { if (screen === 'lobby') render(); }));
    offs.push(net.on('status', (msg, level) => { if (screen === 'lobby') setStatus(msg, level); }));
    offs.push(net.on('closed', (info) => {
      if (net !== mine) return;
      net = null;
      for (const o of offs) o();
      offs = [];
      if (info?.reason === 'left') return; // we left on purpose: whoever called leave() moves on
      const f = closedInfo(info, mine);
      if (screen === 'match') { fail = f; screen = 'failed'; return; } // the match controller reports it in-game; returnToLobby shows it
      showFail(f);
    }));
    if (net.kind === 'client') {
      offs.push(net.onMessage((m) => {
        if (m.t === 'start' && screen !== 'match') startMatch('client');
      }));
      offs.push(net.on('connection', (on) => { if (screen === 'lobby') { render(); setStatus(on ? 'Back in the lobby' : 'Connection lost. Reconnecting…', on ? 'ok' : 'warn'); } }));
      // Rejoined mid-match (page reload or network swap): the host resends 'start'.
    }
  }

  function closedInfo(info, s) {
    const r = info?.reason;
    if (r === 'kicked') return { title: 'Removed', msg: info.msg || 'The host removed you from the lobby.', retry: null };
    if (r === 'host_left' || r === 'closed') return { title: 'Lobby closed', msg: info.msg || 'The host closed the game.', retry: null };
    if (r === 'lost') return { title: 'Connection lost', msg: info.msg || 'Lost connection to the host.', retry: 'join', code: s?.code, hint: 'Your slot is held for a while: Retry puts you back in the same squad (and the same match).' };
    return { title: 'Disconnected', msg: info?.msg || 'The connection ended.', retry: s?.kind === 'client' ? 'join' : null, code: s?.code };
  }

  function startMatch(kind) {
    screen = 'match';
    render();
    try { cfg.onStart?.({ kind, net, lobby: net.lobby }); } catch (e) { console.error('[lobby] onStart', e); }
  }

  async function copy(text, label) {
    try { await navigator.clipboard.writeText(text); setStatus(`${label} copied`, 'ok'); } catch { setStatus(text, ''); }
  }

  /** End the session (if any) without leaving this UI. */
  function endSession() {
    gen++;
    busy = false;
    const n = net;
    net = null;
    for (const o of offs) o();
    offs = [];
    if (n && !n.closed) { try { if (n.kind === 'host') n.close('host_left', 'The host closed the lobby.'); else n.leave(); } catch (e) { console.warn('[lobby] leave', e); } }
  }
  function toHub() { endSession(); cfg.onExit?.(); }

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
      case 'back': case 'leave': toHub(); break;
      case 'home': endSession(); status = { msg: '', level: '' }; screen = 'home'; render(); break;
      case 'host': doHost(); break;
      case 'join': status = { msg: '', level: '' }; screen = 'join'; renderJoin(cfg.code || ''); break;
      case 'dojoin': doJoin(); break;
      case 'rejoin': doJoin(b.dataset.code); break;
      case 'retry': if (fail?.retry === 'host') doHost(); else doJoin(fail?.code || lastCode); break;
      case 'retrynow': net?.retryNow?.(); setStatus('Retrying…', 'warn'); break;
      case 'mode': if (net?.kind === 'host') net.setSettings({ mode: b.dataset.m }); break;
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
      default:
    }
  });

  const api = {
    get session() { return net; },
    get screen() { return screen; },
    showHome() { screen = 'home'; render(); },
    showHost() { if (net) { screen = 'lobby'; render(); } else doHost(); },
    showJoin(code = '') { lastCode = code || ''; screen = 'join'; status = { msg: '', level: '' }; renderJoin(code); if (normalizeCode(code)) doJoin(code); },
    /** After a match: back to the roster (same session), or the "connection lost / closed" screen. */
    returnToLobby() { screen = net && !net.closed ? 'lobby' : (fail ? 'failed' : 'home'); render(); },
    /** Escape / hardware back: leave to the hub (a host with players in the lobby presses twice). */
    back() {
      if (screen === 'match') return false;
      if (screen === 'lobby' && net?.kind === 'host' && net.lobby.players.length > 1 && Date.now() - escArmed > 2500) {
        escArmed = Date.now();
        setStatus('Press Esc again to close the lobby for everyone.', 'warn');
        return true;
      }
      toHub();
      return true;
    },
    /** Leave the session (host: closes the lobby for everyone) and show the online home. */
    leave() {
      endSession();
      fail = null;
      screen = 'home';
      status = { msg: '', level: '' };
      render();
    },
    /** Push an updated profile (class, loadout, callsign) to the lobby. */
    updateProfile(p = profile()) { net?.updateProfile(p); },
    /** Remove the UI. Also ends a session that is still open (never leaves a lobby running headless). */
    destroy() { if (destroyed) return; endSession(); destroyed = true; clearInterval(reconTick); for (const o of offs) o(); el.remove(); },
  };

  const urlCode = cfg.code ? normalizeCode(cfg.code) : joinCodeFromUrl();
  if (cfg.intent === 'host') api.showHost();
  else if (cfg.intent === 'join' || urlCode) api.showJoin(urlCode || '');
  else render();
  return api;
}
