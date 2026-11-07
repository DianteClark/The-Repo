// Match controller: title → loadout → turns → end screen.
// The sim decides everything; this file feeds it player input, plays the
// resulting events back through the renderer and keeps the HUD honest.
//
// Defensive by design: Sim, Graphics and Audio are developed in parallel, so
// every optional sim helper and renderer/audio method is feature-checked.

import * as G from '../sim/game.js';
import * as AI from '../sim/ai.js';
import * as K from '../sim/constants.js';
import * as RU from '../sim/rules.js';
import { keepAwake, allowSleep } from './wakelock.js';
import { settings, onSettingChange } from './ui/settings.js';
import { ICON, SILHOUETTE } from './ui/icons.js';
import { Minimap } from './ui/minimap.js';
import {
  initMenu, openSheet, closeSheet, closeTopSheet, sheetOpen, onSheetClose, setMenuToast, CLASS_INFO,
} from './ui/menu.js';
import * as H from './ui/hud.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const { CLASSES, MODES } = K;
const TURN_SECONDS = K.TURN_SECONDS || 20;
const DEBUG = /[?&]debug\b/.test(location.search);

// ---------------------------------------------------------------- audio

const SFX_METHODS = new Set(['resume', 'toggle', 'setVolume', 'setIntensity', 'startMusic', 'stopMusic', 'stinger',
  'shot', 'hit', 'miss', 'death', 'explosion', 'grenadeThrow', 'breach', 'hunker', 'step', 'pickup', 'tripwire', 'tide',
  'turn', 'tick', 'uiClick', 'uiHover', 'uiError', 'setMuted']);

/** Wrap an audio instance so missing methods are no-ops and errors never escape. */
function safeAudio(obj, gate = () => true) {
  return new Proxy({}, {
    get(_, k) {
      if (k === 'raw') return obj;
      const v = obj?.[k];
      if (typeof v === 'function') {
        return (...a) => { if (!gate(k)) return undefined; try { return v.apply(obj, a); } catch (e) { warnOnce('audio.' + String(k), e); return undefined; } };
      }
      if (v === undefined && SFX_METHODS.has(k)) return () => undefined;
      return v;
    },
  });
}

const warned = new Set();
function warnOnce(tag, e) { if (warned.has(tag)) return; warned.add(tag); console.warn('[tidefall]', tag, e); }

let rawSfx = null;
try {
  const AU = await import('./audio.js');
  const Ctor = AU.Audio || AU.Sfx || AU.GameAudio || AU.default;
  rawSfx = typeof Ctor === 'function' ? new Ctor() : null;
} catch (e) { warnOnce('audio import', e); }
let attract = false; // menu backdrop match: world sounds muted
const sfx = safeAudio(rawSfx);
const worldSfx = safeAudio(rawSfx, () => !attract);

// ---------------------------------------------------------------- renderer

let R = null;
try {
  const RM = await import('./render.js');
  R = new RM.Renderer($('scene'), {
    sfx: worldSfx,
    onTileTap: (x, y) => onTileTap(x, y),
    onUnitTap: (id) => onUnitTap(id),
    onTileHover: (x, y) => onTileHover(x, y),
    onFeed: (m) => { if (!attract && !fastForward) H.feedInfo(m); },
  });
} catch (e) {
  console.error(e);
  $('bootErr').textContent = 'The 3D view failed to start on this device. Try another browser, or turn on hardware acceleration.';
  $('bootErr').classList.remove('hidden');
}
const Rcall = (name, ...a) => {
  const fn = R?.[name];
  if (typeof fn !== 'function') return undefined;
  try { return fn.apply(R, a); } catch (e) { warnOnce('R.' + name, e); return undefined; }
};

// Track the last pointer type so desktop hover-then-click can move in one click.
let lastPointer = 'mouse';
window.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; }, true);
window.addEventListener('pointermove', (e) => { if (e.pointerType) lastPointer = e.pointerType; }, true);

// ---------------------------------------------------------------- state

let state = null;
let gameToken = 0;
let turnCtx = null;        // the active human turn
let fastForward = false;
let playerPlace = null;
let specSpeed = 2;
let activeTeam = -1;
let actingId = null;
let stats = null;
let lastCause = {};
let lastAoe = null;
let lastIntensity = -1;
let lastKillerTeam = null;

const ui = {
  mode: 'move',            // move | shoot | aimed | grenade | breach
  reach: null,             // Map<key,{d,prev}> for move mode
  valid: null,             // Set<key> for grenade / breach
  targets: [],             // [{id, p}] for shoot / aimed
  target: null,            // selected target id
  pending: null,           // {kind, k, x, y, via, ...}
  endArmed: 0,             // end-turn double tap guard
};

const me = () => state?.units.find((u) => u.isPlayer);
const myTeam = () => state?.playerTeam ?? -1;
const keyOf = (x, y) => y * state.map.size + x;
const playerAlive = () => !!me()?.alive;
const myTurnReady = () => !!turnCtx && !turnCtx.busy;
const unitVisible = (u) => {
  if (!u) return false;
  if (u.team === myTeam()) return true;
  if (typeof R?.isUnitVisible === 'function') { try { return !!R.isUnitVisible(u.id); } catch { /* fall through */ } }
  return !!R?.unitObjs?.[u.id]?.g?.visible;
};
const tileVisible = (x, y) => {
  if (typeof R?.visibleToMe === 'function') { try { return !!R.visibleToMe(x, y); } catch { /* ignore */ } }
  return RU.teamSeesTile ? RU.teamSeesTile(state, myTeam(), x, y) : true;
};
const teamName = (t) => (t === myTeam() ? (MODES[state.mode].teamSize > 1 ? 'Your squad' : 'You') : `Squad ${t + 1}`);
const unitName = (u) => (u.team === myTeam() ? u.name : `${u.name}`);

// ---------------------------------------------------------------- menu + settings

setMenuToast((m, k) => H.toast(m, k));
const menu = initMenu({
  CLASSES, MODES,
  onDeploy: () => startGame(),
  onClick: () => { firstGesture(); sfx.uiClick(); },
  onHover: () => sfx.uiHover(),
});

let gestured = false;
function firstGesture() {
  if (gestured) return;
  gestured = true;
  sfx.resume();
  applyAudio();
}
window.addEventListener('pointerdown', () => { if ($('menu') && !$('menu').classList.contains('hidden')) firstGesture(); }, { once: false, passive: true });

function applyAudio() {
  if (typeof rawSfx?.setMuted === 'function') { sfx.setMuted(!!settings.muted); sfx.setVolume(settings.volume); }
  else sfx.setVolume(settings.muted ? 0 : settings.volume);
  $('muteBtn').innerHTML = settings.muted ? ICON.soundOff : ICON.soundOn;
}
function applyQuality() {
  if (settings.quality === 'auto') {
    if (typeof R?.setAutoQuality === 'function') Rcall('setAutoQuality');
    else if (qualityTouched && R) { R.qualityPinned = false; if (R.perf) R.perf.bad = 0; }
  } else { qualityTouched = true; Rcall('setQuality', settings.quality); }
}
let qualityTouched = false;
function applyVisualSettings() {
  applyQuality();
  Rcall('setCinematic', !!settings.cinematic);
  $('timer').dataset.style = settings.timer;
  updateTimer();
}
onSettingChange((k) => {
  if (k === 'volume' || k === 'muted') applyAudio();
  if (k === 'quality' || k === 'cinematic' || k === 'timer') applyVisualSettings();
  if (k === 'botSpeed') applySpeed();
});
applyAudio();
applyVisualSettings();

// static icons
$('rotL').innerHTML = ICON.rotL;
$('rotR').innerHTML = ICON.rotR;
$('focusBtn').innerHTML = ICON.focus;
$('pauseBtn').innerHTML = ICON.pause;
document.querySelectorAll('.sheet [data-close].icon-btn').forEach((b) => { b.innerHTML = ICON.close; });
$('speedBtn').innerHTML = `${ICON.ff}<span>2×</span>`;

$('rotL').onclick = () => { sfx.uiClick(); Rcall('rotate', -1); };
$('rotR').onclick = () => { sfx.uiClick(); Rcall('rotate', 1); };
$('focusBtn').onclick = () => { sfx.uiClick(); focusMe(); };
$('muteBtn').onclick = () => { settings.muted = !settings.muted; sfx.uiClick(); };
$('pauseBtn').onclick = () => { sfx.uiClick(); openPause(); };
$('tpClose').onclick = (e) => { e.stopPropagation(); sfx.uiClick(); cancelMode(); };
$('fireBtn').onclick = (e) => { e.stopPropagation(); confirmPending(); };
$('endBtn').onclick = (e) => {
  e.stopPropagation();
  if (!turnCtx || turnCtx.busy) { sfx.uiError(); if (state && playerAlive()) H.toast('Wait for your turn', 'error'); return; }
  endTurnPressed();
};
$('skipBtn').onclick = () => { sfx.uiClick(); skipToResults(); };
$('speedBtn').onclick = () => {
  sfx.uiClick();
  specSpeed = specSpeed === 1 ? 2 : specSpeed === 2 ? 4 : 1;
  $('speedBtn').innerHTML = `${ICON.ff}<span>${specSpeed}×</span>`;
  applySpeed();
};
$('againBtn').onclick = () => { sfx.uiClick(); $('endScreen').classList.add('hidden'); startGame(); };
$('loadoutBtn').onclick = () => { sfx.uiClick(); toMenu(); };
$('pSettings').onclick = () => { sfx.uiClick(); openSheet('settingsSheet'); };
$('pHow').onclick = () => { sfx.uiClick(); openSheet('howSheet'); };
$('pQuit').onclick = () => { sfx.uiClick(); closeSheet('pauseSheet'); toMenu(); };
onSheetClose('pauseSheet', () => resumeTimer());

function focusMe() {
  const u = me();
  if (u?.alive) Rcall('focus', u.x, u.y);
  else { const d = Rcall('myRef'); if (d) Rcall('focus', d.x, d.y); }
}

// Keep floating panels stacked right above the dock, whatever its height.
new ResizeObserver(() => {
  document.body.style.setProperty('--dock-h', $('dock').offsetHeight + 'px');
}).observe($('dock'));

// ---------------------------------------------------------------- minimap

const minimap = new Minimap($('minimap'), {
  onPick: (x, y) => { sfx.uiClick(); Rcall('setFollow', null); Rcall('focus', x, y); },
});
setInterval(() => {
  if (state && !$('hud').classList.contains('hidden') && !fastForward) minimap.draw(state, R);
}, 180);

// ---------------------------------------------------------------- attract mode (menu backdrop)

let attractState = null;
async function runAttract() {
  if (!R || !G.createGame) return;
  const token = ++gameToken;
  attract = true;
  document.body.classList.add('in-menu');
  try {
    attractState = G.createGame({ mode: 'quads', noHuman: true, seed: (Math.random() * 2 ** 32) >>> 0 });
    state = null;
    Rcall('setGame', attractState, -1);
    Rcall('setSpectator', true);
    Rcall('zoomBy', 1.15);
    R.speed = 1.1;
    const s = attractState;
    await sleep(600);
    while (s.winner === null && token === gameToken) {
      const t = G.currentTeamId(s);
      for (const id of s.teams[t].members) {
        if (token !== gameToken) return;
        const u = s.units[id];
        if (!u.alive) continue;
        const evs = AI.botTakeTurn(s, id);
        for (const ev of evs) {
          if (token !== gameToken) return;
          const a = actorOf(ev);
          if (a !== null && s.units[a]) Rcall('focus', s.units[a].x, s.units[a].y);
          await safePlay(ev);
        }
        if (s.winner !== null) break;
        await sleep(evs.length ? 260 : 0);
      }
      if (token !== gameToken) return;
      for (const ev of G.endTeamTurn(s)) await safePlay(ev);
      if (s.round % 3 === 0 && G.currentTeamId(s) === s.order[0]) Rcall('rotate', 1);
    }
    if (token === gameToken) { await sleep(2500); if (token === gameToken) runAttract(); }
  } catch (e) { warnOnce('attract', e); }
}

// ---------------------------------------------------------------- game flow

function toMenu() {
  gameToken++;
  turnCtx = null;
  state = null;
  allowSleep();
  clearPreviews();
  H.hideContext();
  H.hideBanner();
  $('hud').classList.add('hidden');
  $('endScreen').classList.add('hidden');
  $('menu').classList.remove('hidden');
  document.body.classList.add('in-menu');
  document.body.classList.remove('in-game', 'ended');
  sfx.stopMusic();
  menu.renderModes();
  menu.renderClasses();
  runAttract();
}

async function startGame() {
  if (!R) { H.toast('The 3D view is unavailable on this device.', 'error'); return; }
  firstGesture();
  sfx.resume();
  keepAwake();
  attract = false;
  const token = ++gameToken;
  fastForward = false;
  playerPlace = null;
  specSpeed = 2;
  $('speedBtn').innerHTML = `${ICON.ff}<span>2×</span>`;
  lastCause = {};
  lastAoe = null;
  lastIntensity = -1;
  turnCtx = null;
  state = G.createGame({ mode: settings.mode, playerClass: settings.cls, volunteerLoneWolf: settings.mode === 'trios' && !!settings.loneWolf });
  stats = { dmg: 0, shots: 0, hits: 0, kills: 0, squadKills: 0, roundOut: null, taken: 0 };
  Rcall('setGame', state, state.playerTeam);
  Rcall('setSpectator', false);
  Rcall('setFollow', null);
  applyVisualSettings();
  if (R) R.speed = 1;
  $('menu').classList.add('hidden');
  $('endScreen').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('specBar').classList.add('hidden');
  document.body.classList.remove('in-menu', 'ended');
  document.body.classList.add('in-game');
  H.clearFeed();
  H.hideContext();
  const u = me();
  focusMe();
  sfx.startMusic();
  updateHud();
  const nTeams = state.teams.length;
  H.banner(MODES[state.mode].name.toUpperCase(), 'info', `${nTeams} squads · last one above the tide wins`, 1700);
  if (u.isLoneWolf) setTimeout(() => H.toast('You are the Lone Wolf: +1 AP, +50% HP, +1 armor.', 'info', 'wolf'), 900);
  if (!settings.seenHowTo) {
    settings.seenHowTo = true;
    setTimeout(() => H.toast('Tap a tile to preview a move, tap again to go.', 'info', 'tap'), 2200);
  }
  runMatch(token);
}

function actorOf(ev) {
  switch (ev.type) {
    case 'move': case 'grenade': case 'breach': case 'overwatch': case 'heal': case 'hunker': case 'crate':
      return ev.id;
    case 'shot': return ev.from;
    default: return null;
  }
}

async function safePlay(ev) {
  if (!R) return;
  try {
    const p = R.playEvent(ev);
    if (p && typeof p.then === 'function') await Promise.race([p, sleep(8000)]);
  } catch (e) { warnOnce('playEvent ' + ev.type, e); }
}

/** Play events with camera follow. Returns true if anything was visible. */
async function play(events, token = gameToken) {
  let shown = false;
  for (const ev of events) {
    if (token !== gameToken) return shown;
    if (!fastForward) {
      const a = actorOf(ev);
      const visible = isEventVisible(ev);
      if (visible) shown = true;
      if (visible && settings.follow && a !== null) followFor(ev, a);
      await safePlay(ev);
      if (token !== gameToken || !state) return shown;
    }
    meta(ev);
  }
  if (!fastForward) { Rcall('setFollow', null); updateHud(); }
  return shown;
}

function isEventVisible(ev) {
  const st = state;
  switch (ev.type) {
    case 'move': {
      const u = st.units[ev.id];
      return u.team === myTeam() || ev.path.some(([x, y]) => tileVisible(x, y));
    }
    case 'shot': return st.units[ev.from].team === myTeam() || st.units[ev.to].team === myTeam()
      || unitVisible(st.units[ev.from]) || unitVisible(st.units[ev.to]);
    case 'grenade': case 'breach': return st.units[ev.id]?.team === myTeam() || tileVisible(ev.x, ev.y);
    case 'overwatch': case 'heal': case 'hunker': return unitVisible(st.units[ev.id]);
    case 'death': return unitVisible(st.units[ev.id]);
    case 'zone_shrink': case 'supply_drop': return true;
    default: return false;
  }
}

function followFor(ev, a) {
  const u = state.units[a];
  if (!u) return;
  if (ev.type === 'move') {
    if (typeof R?.setFollow === 'function') Rcall('setFollow', a);
    else { const [x, y] = ev.path[ev.path.length - 1]; Rcall('focus', x, y); }
  } else if (ev.type === 'shot') {
    const t = state.units[ev.to];
    const d = R?.disp?.[a] || u;
    Rcall('focus', (d.x + t.x) / 2, (d.y + t.y) / 2);
  } else if (ev.type === 'grenade' || ev.type === 'breach') {
    Rcall('focus', ev.x, ev.y);
  } else {
    const d = R?.disp?.[a] || u;
    Rcall('focus', d.x, d.y);
  }
}

function applySpeed() {
  if (!R) return;
  const bot = settings.botSpeed === 'fast' ? 1.8 : 1.2;
  if (!playerAlive() && state) R.speed = bot * specSpeed;
  else if (turnCtx) R.speed = 1.15;
  else R.speed = bot;
}

async function runMatch(token) {
  await play(state.startEvents || [], token);
  while (state && state.winner === null && token === gameToken) {
    const t = G.currentTeamId(state);
    const team = state.teams[t];
    activeTeam = t;
    applySpeed();
    if (!fastForward) updateHud();
    let shown = false;
    for (const id of team.members) {
      const u = state.units[id];
      if (u.isPlayer || !u.alive) continue;
      actingId = id;
      let evs = [];
      try { evs = AI.botTakeTurn(state, id); } catch (e) { warnOnce('bot', e); }
      if (await play(evs, token)) shown = true;
      if (token !== gameToken || !state) return;
      if (state.winner !== null) break;
      if (shown && !fastForward) await sleep(settings.botSpeed === 'fast' ? 90 : 220);
    }
    actingId = null;
    if (token !== gameToken || !state) return;
    const human = team.members.map((id) => state.units[id]).find((u) => u.isPlayer && u.alive);
    if (state.winner === null && human && human.ap > 0) await humanTurn(human);
    if (token !== gameToken || !state) return;
    await play(G.endTeamTurn(state), token);
    if (token !== gameToken || !state) return;
    if (fastForward) { if (state.round % 1 === 0) await sleep(0); }
    else if (shown) await sleep(140);
    else await nextFrame();
  }
  if (token !== gameToken || !state) return;
  if (fastForward) Rcall('syncFromState');
  activeTeam = -1;
  updateHud();
  showEnd();
}

function skipToResults() {
  if (!state || state.winner !== null) return;
  fastForward = true;
  $('skipBtn').disabled = true;
  $('specText').textContent = 'Simulating the rest of the match…';
}

// ---------------------------------------------------------------- human turn

function humanTurn(u) {
  return new Promise((resolve) => {
    turnCtx = { u, resolve, deadline: performance.now() + TURN_SECONDS * 1000, busy: false, lastTick: TURN_SECONDS, paused: 0 };
    applySpeed();
    Rcall('setFollow', null);
    Rcall('focus', u.x, u.y);
    sfx.turn();
    H.banner('YOUR TURN', 'you', `${u.ap} AP · ${TURN_SECONDS} seconds`, 1100);
    setMode('move');
    updateHud();
    timerLoop(turnCtx);
  });
}

function timerLoop(c) {
  if (turnCtx !== c) { updateTimer(); return; }
  const now = performance.now();
  // The clock stops while paused and while your own action animates.
  if (c.paused) { c.deadline += now - c.paused; c.paused = now; }
  if (c.busy) { if (c.busyAt) c.deadline += now - c.busyAt; c.busyAt = now; } else c.busyAt = 0;
  const left = Math.max(0, (c.deadline - now) / 1000);
  updateTimer(left);
  const whole = Math.ceil(left);
  if (whole !== c.lastTick) {
    c.lastTick = whole;
    if (whole <= 5 && whole > 0) sfx.tick(true);
    else if (whole <= 10 && whole > 0) sfx.tick(false);
  }
  if (left <= 0 && !c.busy && !c.paused) {
    H.toast('Time! Auto-overwatch.', 'warn', 'clock');
    const a = c.u.ap > 0 ? { type: 'overwatch' } : { type: 'hold' };
    doAction(a).then((ok) => { if (!ok && turnCtx === c) doAction({ type: 'hold' }); });
  }
  requestAnimationFrame(() => timerLoop(c));
}

function updateTimer(left) {
  const c = turnCtx;
  H.renderTimer({ left: left ?? (c ? Math.max(0, (c.deadline - performance.now()) / 1000) : 0), total: TURN_SECONDS, active: !!c, style: settings.timer, over: !!state && state.winner !== null });
}

function openPause() {
  if (!state) return;
  $('pauseNote').textContent = turnCtx ? 'Your turn timer is paused.' : 'The match continues in the background.';
  if (turnCtx && !turnCtx.paused) turnCtx.paused = performance.now();
  openSheet('pauseSheet');
}
function resumeTimer() { if (turnCtx) turnCtx.paused = 0; }

function finishTurn() {
  const c = turnCtx;
  turnCtx = null;
  clearPreviews();
  ui.mode = 'move';
  ui.pending = null;
  H.hideContext();
  applySpeed();
  updateHud();
  c?.resolve();
}

async function doAction(a) {
  const c = turnCtx;
  if (!c || c.busy) return false;
  c.busy = true;
  clearPreviews();
  H.hideContext();
  ui.pending = null;
  let r;
  try { r = G.act(state, c.u.id, a); } catch (e) { r = { ok: false, error: String(e.message || e) }; }
  if (!r.ok) {
    sfx.uiError();
    H.toast(r.error || 'Not possible', 'error');
    c.busy = false;
    setMode('move');
    updateHud();
    return false;
  }
  updateHud();
  await play(r.events);
  c.busy = false;
  if (turnCtx !== c) return true;
  if (!c.u.alive || c.u.ap <= 0 || state.winner !== null) finishTurn();
  else { setMode('move'); updateHud(); }
  return true;
}

// ---------------------------------------------------------------- abilities / availability

function abilityMap(u) {
  const m = {};
  if (typeof G.abilityInfo === 'function') {
    try { for (const a of G.abilityInfo(u, state) || []) m[a.key] = a; } catch (e) { warnOnce('abilityInfo', e); }
  }
  return m;
}

function validTargets(u, kind = 'shoot') {
  const fn = kind === 'aimed' && typeof G.aimedPreview === 'function' ? G.aimedPreview : G.shotPreview;
  const out = [];
  for (const e of state.units) {
    if (!e.alive || e.team === u.team || !unitVisible(e)) continue;
    let p = null;
    try { p = fn(state, u, e); } catch { p = null; }
    if (p) out.push({ id: e.id, p });
  }
  out.sort((a, b) => b.p.chance - a.p.chance);
  return out;
}

function grenadeSet(u) {
  if (typeof G.grenadeTargets !== 'function') return null;
  try { return G.grenadeTargets(state, u); } catch (e) { warnOnce('grenadeTargets', e); return null; }
}
function breachSet(u) {
  if (typeof G.breachTargets !== 'function') return null;
  try { return G.breachTargets(state, u); } catch (e) { warnOnce('breachTargets', e); return null; }
}

const CD_LABEL = (n) => `Cooldown: ${n} round${n === 1 ? '' : 's'}`;

function availability(u) {
  const out = {};
  const my = !!turnCtx;
  const busy = turnCtx?.busy;
  const base = !my ? 'Wait for your turn' : busy ? 'Action in progress' : u.ap < 1 ? 'No AP left' : null;
  const ab = abilityMap(u);
  const set = (k, reason, extra = {}) => { out[k] = { ok: !reason, reason, ...extra }; };

  set('move', base || (ui.reach && [...ui.reach.values()].every((n) => n.d === 0) ? 'Nowhere to move' : null));
  const shots = !base ? validTargets(u) : [];
  set('shoot', base || (shots.length ? null : 'No enemy in range and sight'), { count: shots.length });

  const frags = u.items?.frag ?? 0;
  const ga = ab.grenade;
  let gReason = base;
  if (!gReason) {
    if (typeof G.grenadeTargets !== 'function') gReason = 'Frags arrive with the next sim update';
    else if (frags < 1) gReason = 'No frags. Loot crates to find more';
    else if (!(grenadeSet(u)?.size)) gReason = 'No visible tile in throw range';
    else if (ga && !ga.ready) gReason = ga.reason || 'Not ready';
  }
  set('grenade', gReason, { charges: ga?.charges ?? frags });

  if (u.cls === 'marksman') {
    const a = ab.aimed;
    const cd = a?.cooldown ?? u.cooldowns?.aimed ?? 0;
    let r = base;
    if (!r) {
      if (typeof G.aimedPreview !== 'function' && !a) r = 'Aimed Shot arrives with the next sim update';
      else if (cd > 0) r = CD_LABEL(cd);
      else if (!validTargets(u, 'aimed').length) r = 'No enemy in range and sight';
      else if (a && !a.ready) r = a.reason || 'Not ready';
    }
    set('aimed', r, { cooldown: cd });
  }
  if (u.cls === 'breacher') {
    const a = ab.breach;
    const cd = a?.cooldown ?? u.cooldowns?.breach ?? 0;
    let r = base;
    if (!r) {
      if (typeof G.breachTargets !== 'function') r = 'Breach arrives with the next sim update';
      else if (cd > 0) r = CD_LABEL(cd);
      else if (!(breachSet(u)?.size)) r = 'Stand next to cover to breach it';
      else if (a && !a.ready) r = a.reason || 'Not ready';
    }
    set('breach', r, { cooldown: cd });
  }
  const hk = ab.hunker;
  set('hunker', base || (hk && !hk.ready ? hk.reason || 'Not ready' : null));
  set('overwatch', base);
  set('medkit', base || (u.items.medkit < 1 ? 'No medkits' : u.hp >= u.maxHp ? 'Already at full health' : null), { count: u.items.medkit });
  set('end', !my ? 'Wait for your turn' : busy ? 'Action in progress' : null);
  return out;
}

function actionList(u) {
  const av = availability(u);
  const st = (k) => (!av[k].ok ? 'off' : ui.mode === k ? 'active' : 'on');
  const list = [
    { key: 'move', icon: 'move', label: 'Move', hotkey: '1' },
    { key: 'shoot', icon: 'shoot', label: 'Shoot', hotkey: '2', badge: av.shoot.ok && av.shoot.count ? av.shoot.count : null, badgeKind: 'tg' },
    { key: 'grenade', icon: 'grenade', label: 'Frag', hotkey: '3', badge: av.grenade.charges ?? 0, badgeKind: (av.grenade.charges ?? 0) > 0 ? 'ch' : 'zero' },
  ];
  if (av.aimed) list.push({ key: 'aimed', icon: 'aimed', label: 'Aimed', hotkey: '4', badge: av.aimed.cooldown > 0 ? av.aimed.cooldown : null, badgeKind: 'cd' });
  if (av.breach) list.push({ key: 'breach', icon: 'breach', label: 'Breach', hotkey: '4', badge: av.breach.cooldown > 0 ? av.breach.cooldown : null, badgeKind: 'cd' });
  list.push(
    { key: 'hunker', icon: 'hunker', label: 'Hunker', hotkey: '5' },
    { key: 'overwatch', icon: 'overwatch', label: 'Watch', hotkey: '6' },
    { key: 'medkit', icon: 'medkit', label: 'Medkit', hotkey: '7', badge: u.items.medkit, badgeKind: u.items.medkit ? 'ch' : 'zero' },
  );
  for (const a of list) { a.state = st(a.key); a.reason = av[a.key].reason; }
  return { list, av };
}

function pressAction(a) {
  const u = me();
  if (!u) return;
  if (a.state === 'off') {
    sfx.uiError();
    if (a.reason) H.toast(`${a.label}: ${a.reason}`, 'error');
    return;
  }
  sfx.uiClick();
  switch (a.key) {
    case 'move': setMode('move'); break;
    case 'shoot': case 'aimed': case 'grenade': case 'breach':
      if (ui.mode === a.key) { cancelMode(); break; }
      setMode(a.key);
      break;
    case 'hunker': doAction({ type: 'hunker' }); break;
    case 'overwatch': doAction({ type: 'overwatch' }); break;
    case 'medkit': doAction({ type: 'medkit' }); break;
    case 'end': endTurnPressed(); break;
    default:
  }
  updateHud();
}

function endTurnPressed(force = false) {
  if (!turnCtx) {
    if (state && !playerAlive() && state.winner === null) skipToResults();
    return;
  }
  if (turnCtx.busy) return;
  const u = turnCtx.u;
  // Ending with all AP unused is probably a mis-tap: ask once.
  if (!force && u.ap >= u.maxAp && performance.now() - ui.endArmed > 2200) {
    ui.endArmed = performance.now();
    $('endBtn').classList.add('armed');
    $('endBtn').querySelector('.al').textContent = 'Confirm?';
    sfx.uiClick();
    setTimeout(() => { $('endBtn').classList.remove('armed'); updateEndBtn(true); }, 2200);
    return;
  }
  ui.endArmed = 0;
  sfx.uiClick();
  $('endBtn').classList.remove('armed');
  doAction({ type: 'hold' });
}

// ---------------------------------------------------------------- input modes

function clearPreviews() {
  Rcall('setPathPreview', null);
  Rcall('setAoePreview', null);
  Rcall('setTargetMarkers', null);
  Rcall('setSelectedTarget', null);
  Rcall('setHighlights', null);
}

function setMode(mode, preselect = null) {
  const u = turnCtx?.u;
  clearPreviews();
  H.hideContext();
  ui.pending = null;
  ui.target = null;
  ui.valid = null;
  ui.targets = [];
  ui.mode = mode;
  if (!u || !state) { ui.mode = 'move'; return; }

  if (mode === 'move') {
    ui.reach = G.moveOptions(state, u);
    const hl = new Map();
    for (const [k, n] of ui.reach) if (n.d > 0) hl.set(k, n.d <= u.move ? 1 : 2);
    Rcall('setHighlights', hl);
  } else if (mode === 'shoot' || mode === 'aimed') {
    ui.targets = validTargets(u, mode);
    if (!ui.targets.length) { H.toast('No enemy in range and sight', 'error'); sfx.uiError(); return setMode('move'); }
    Rcall('setTargetMarkers', ui.targets.map((t) => ({ id: t.id, chance: t.p.chance })));
    const pick = ui.targets.find((t) => t.id === preselect) || ui.targets[0];
    selectTarget(pick.id);
  } else if (mode === 'grenade' || mode === 'breach') {
    ui.valid = mode === 'grenade' ? grenadeSet(u) : breachSet(u);
    if (!ui.valid?.size) { H.toast(mode === 'grenade' ? 'No tile in throw range' : 'Nothing to breach here', 'error'); sfx.uiError(); return setMode('move'); }
    const hl = new Map();
    for (const k of ui.valid) hl.set(k, 2);
    Rcall('setHighlights', hl);
    if (mode === 'breach' && ui.valid.size === 1) {
      const [k] = ui.valid; const S = state.map.size;
      previewArea(k % S, (k / S) | 0, 'tap');
    } else showAreaPrompt(mode);
  }
  document.body.dataset.mode = ui.mode;
  updateHud();
}

function cancelMode() {
  if (ui.mode !== 'move') setMode('move');
  else if (ui.pending) { ui.pending = null; Rcall('setPathPreview', null); H.hideContext(); }
  updateHud();
}

// ----- move

function previewMove(k, via) {
  const u = turnCtx.u;
  const S = state.map.size;
  const node = ui.reach?.get(k);
  if (!node || node.d === 0) return false;
  const x = k % S, y = (k / S) | 0;
  const cost = node.d <= u.move ? 1 : 2;
  const path = RU.pathTo ? RU.pathTo(ui.reach, S, k) : [[u.x, u.y], [x, y]];
  ui.pending = { kind: 'move', k, x, y, cost, path, via };
  Rcall('setPathPreview', path, cost);
  showMoveContext(ui.pending, via);
  return true;
}

function coverInfo(x, y) {
  const u = turnCtx.u;
  const enemies = state.units.filter((e) => e.alive && e.team !== u.team && unitVisible(e));
  const dirs = RU.tileCoverDirs ? RU.tileCoverDirs(state.map, x, y) : [0, 0, 0, 0];
  const best = Math.max(0, ...dirs);
  let flankers = 0;
  let worst = 2;
  for (const e of enemies) {
    if (RU.dist(e.x, e.y, x, y) > 14) continue;
    const c = RU.coverVs(state.map, x, y, e.x, e.y);
    worst = Math.min(worst, c);
    if (c === 0 && RU.los(state.map, e.x, e.y, x, y)) flankers++;
  }
  return { best, flankers, enemies: enemies.length, worst };
}

function showMoveContext(p, via) {
  const u = turnCtx.u;
  const ci = coverInfo(p.x, p.y);
  const z = state.zone;
  const crate = state.crates.find((c) => !c.taken && c.x === p.x && c.y === p.y);
  const outNow = !G.insideZone(state, p.x, p.y);
  const outNext = !G.insideZone(state, p.x, p.y, z.next);
  const coverTxt = ['Exposed', 'Half cover', 'Full cover'][ci.best];
  const notes = [];
  if (ci.flankers) notes.push(`<span class="n bad">${ICON.warn}Flanked by ${ci.flankers}</span>`);
  if (crate) notes.push(`<span class="n loot">${ICON.crate}${crate.type === 'cache' ? 'Supply cache' : 'Crate'}</span>`);
  if (outNow) notes.push(`<span class="n bad">${ICON.tide}In the tide</span>`);
  else if (outNext) notes.push(`<span class="n warn">${ICON.tide}Outside next ring</span>`);
  const left = u.ap - p.cost;
  const html = `
    <div class="ctx-h"><span class="ctx-ic">${ICON.move}</span><b>${p.cost === 2 ? 'Dash' : 'Move'}</b>
      <span class="cost c${p.cost}">${p.cost} AP</span><span class="spacer"></span><span class="dim">${left > 0 ? `${left} AP left after` : 'Uses your last AP'}</span></div>
    <div class="ctx-row">
      <span class="cover-badge cv${ci.best}">${ICON.shield}<b>${coverTxt}</b></span>
      ${notes.join('')}
    </div>
    ${via === 'hover' ? '<div class="ctx-hint">Click to move</div>' : '<div class="ctx-hint">Tap the tile again or confirm</div>'}`;
  H.showContext(html, 'move' + (via === 'hover' ? ' hover' : ''));
  $('fireBtn').innerHTML = `${ICON.check}<span>${p.cost === 2 ? 'Dash' : 'Move'}</span>`;
  $('fireBtn').disabled = false;
}

// ----- shoot / aimed

function selectTarget(id) {
  const t = ui.targets.find((x) => x.id === id);
  if (!t) return false;
  ui.target = id;
  ui.pending = { kind: ui.mode, id };
  Rcall('setSelectedTarget', id);
  if (typeof R?.setSelectedTarget !== 'function') { const t = state.units[id], u = turnCtx.u; Rcall('focus', (t.x + u.x) / 2, (t.y + u.y) / 2); }
  Rcall('setTargetMarkers', ui.targets.map((x) => ({ id: x.id, chance: x.p.chance, selected: x.id === id })));
  showTargetContext(t);
  return true;
}

function showTargetContext({ id, p }) {
  const t = state.units[id];
  const c = CLASSES[t.cls];
  const aimed = ui.mode === 'aimed';
  const lethal = p.dmg[1] >= t.hp;
  const sure = p.dmg[0] >= t.hp;
  const hpPips = Array.from({ length: t.maxHp }, (_, i) => {
    const on = i < t.hp;
    const threat = on && i >= t.hp - p.dmg[1];
    return `<i class="${on ? 'on' : ''}${threat ? ' threat' : ''}"></i>`;
  }).join('');
  const coverWord = p.cover === 2 ? 'Full cover' : p.cover === 1 ? 'Half cover' : 'Flanked';
  const notes = (p.notes || []).map((n) => {
    const good = /\+/.test(n) && !/-/.test(n);
    return `<span class="n ${good ? 'good' : 'bad'}">${n}</span>`;
  }).join('');
  const idx = ui.targets.findIndex((x) => x.id === id);
  const html = `
    <div class="ctx-h enemy"><span class="sil-sm">${SILHOUETTE[t.cls] || ''}</span>
      <div class="tgt-name"><b>${t.name}</b><small>Squad ${t.team + 1} · ${c.name}${t.isLoneWolf ? ' · Lone Wolf' : ''}</small></div>
      ${ui.targets.length > 1 ? `<button class="btn ghost sm cycle" id="cycleBtn" title="Next target [Tab]">${idx + 1}/${ui.targets.length}<span class="kbd-hint">Tab</span></button>` : ''}</div>
    <div class="tgt-hp"><span class="hp-pips enemy${t.maxHp > 14 ? ' dense' : ''}">${hpPips}</span><span>${t.hp}/${t.maxHp}</span>${t.armor ? `<span class="armor">${ICON.shield}<b>${t.armor}</b></span>` : ''}${t.hunkered ? `<span class="tag hk">${ICON.hunker}Hunkered</span>` : ''}</div>
    <div class="odds">
      <div class="odd big"><b>${p.chance}<small>%</small></b><span>Hit</span></div>
      <div class="odd"><b>${p.graze || 0}<small>%</small></b><span>Graze</span></div>
      <div class="odd"><b>${p.dmg[0]}–${p.dmg[1]}</b><span>Damage</span></div>
      <div class="odd ${sure ? 'kill' : lethal ? 'maybe' : ''}"><b>${sure ? 'KILL' : lethal ? 'CAN KILL' : coverWord}</b><span>${sure || lethal ? coverWord : 'Target'}</span></div>
    </div>
    <div class="ctx-row notes">${aimed && !(p.notes || []).some((n) => /aimed/i.test(n)) ? `<span class="n good">${ICON.aimed}Aimed +15 aim, +2 dmg</span>` : ''}${notes}</div>`;
  H.showContext(html, 'shoot');
  $('fireBtn').innerHTML = `${aimed ? ICON.aimed : ICON.shoot}<span>${aimed ? 'Aimed shot' : 'Fire'}</span><small>ends turn</small>`;
  $('fireBtn').disabled = false;
  const cb = $('cycleBtn');
  if (cb) cb.onclick = (e) => { e.stopPropagation(); sfx.uiClick(); cycleTarget(1); };
}

function cycleTarget(dir) {
  if (!ui.targets.length) return;
  const i = ui.targets.findIndex((t) => t.id === ui.target);
  const n = ui.targets[(i + dir + ui.targets.length) % ui.targets.length];
  selectTarget(n.id);
}

// ----- grenade / breach

function showAreaPrompt(mode) {
  const u = turnCtx.u;
  const g = mode === 'grenade';
  const html = `
    <div class="ctx-h"><span class="ctx-ic">${g ? ICON.grenade : ICON.breach}</span><b>${g ? 'Frag grenade' : 'Breach'}</b>
      ${g ? `<span class="cost">${u.items.frag ?? 0} left</span>` : ''}<span class="spacer"></span></div>
    <div class="ctx-hint big">${g ? 'Tap a highlighted tile up to 7 tiles away' : 'Tap the cover next to you to blow it open'}</div>`;
  H.showContext(html, 'area');
  $('fireBtn').innerHTML = `${ICON.check}<span>${g ? 'Throw' : 'Breach'}</span>`;
  $('fireBtn').disabled = true;
}

function localAreaPreview(kind, x, y) {
  const u = turnCtx.u;
  const r = kind === 'grenade' ? 1.5 : 1.5;
  const base = kind === 'grenade' ? 3 : 4;
  const units = state.units.filter((e) => e.alive && RU.dist(e.x, e.y, x, y) <= r && (kind === 'grenade' || e.team !== u.team))
    .map((e) => { const dmg = Math.max(1, base - e.armor); return { id: e.id, dmg, lethal: dmg >= e.hp }; });
  return { valid: ui.valid?.has(keyOf(x, y)) ?? true, units, cover: [] };
}

function previewArea(x, y, via) {
  const u = turnCtx.u;
  const k = keyOf(x, y);
  const kind = ui.mode;
  const valid = !!ui.valid?.has(k);
  let pv = null;
  const pfn = kind === 'grenade' ? G.grenadePreview : G.breachPreview;
  if (typeof pfn === 'function') {
    try { pv = pfn(state, u, x, y); } catch (e) { warnOnce(kind + 'Preview', e); }
  }
  if (!pv) pv = localAreaPreview(kind, x, y);
  const ok = valid && pv.valid !== false;
  Rcall('setAoePreview', { x, y, radius: kind === 'grenade' ? 1.5 : 1, valid: ok });
  if (via === 'tap') Rcall('focus', (x + u.x) / 2, (y + u.y) / 2);
  ui.pending = ok ? { kind, k, x, y, via } : null;
  // Hide units the player can't see from the hit list (no free intel).
  const hits = (pv.units || []).filter((h) => unitVisible(state.units[h.id]));
  const rows = hits.map((h) => {
    const t = state.units[h.id];
    const mine = t.team === u.team;
    return `<span class="hit ${mine ? 'ff' : 'en'}${h.lethal ? ' lethal' : ''}">${t.isPlayer ? 'You' : t.name}<b>-${h.dmg}</b>${h.lethal ? `<em>${ICON.skull}</em>` : ''}</span>`;
  }).join('');
  const ff = hits.some((h) => state.units[h.id].team === u.team);
  const covers = (pv.cover || []).length;
  const g = kind === 'grenade';
  const html = `
    <div class="ctx-h"><span class="ctx-ic">${g ? ICON.grenade : ICON.breach}</span><b>${g ? 'Frag grenade' : 'Breach'}</b>
      ${g ? `<span class="cost">1 AP</span><span class="dim">${u.items.frag ?? 0} left</span>` : '<span class="cost">1 AP</span>'}<span class="spacer"></span></div>
    ${ok ? `<div class="ctx-row hits">${rows || '<span class="dim">No visible units in the blast</span>'}</div>
      <div class="ctx-row">${covers ? `<span class="n warn">${ICON.burst}${covers} cover tile${covers === 1 ? '' : 's'} wrecked</span>` : g ? `<span class="n">${ICON.burst}3×3 blast · ignores cover</span>` : `<span class="n">${ICON.burst}Opens this tile · 4 dmg nearby</span>`}
      ${ff ? `<span class="n bad">${ICON.warn}Friendly fire</span>` : ''}</div>`
    : `<div class="ctx-hint big bad">${g ? 'Out of range or no line of sight' : 'Pick cover right next to you'}</div>`}
    ${via === 'hover' && ok ? '<div class="ctx-hint">Click to throw</div>' : ''}`;
  H.showContext(html, 'area' + (ok ? '' : ' invalid'));
  $('fireBtn').innerHTML = `${ICON.check}<span>${g ? 'Throw' : 'Breach'}</span>`;
  $('fireBtn').disabled = !ok;
}

// ----- commit

function confirmPending() {
  const p = ui.pending;
  if (!turnCtx || turnCtx.busy || !p) { if (!p && turnCtx) sfx.uiError(); return; }
  sfx.uiClick();
  switch (p.kind) {
    case 'move': doAction({ type: 'move', x: p.x, y: p.y }); break;
    case 'shoot': doAction({ type: 'shoot', targetId: p.id }); break;
    case 'aimed': doAction({ type: 'aimed', targetId: p.id }); break;
    case 'grenade': doAction({ type: 'grenade', x: p.x, y: p.y }); break;
    case 'breach': doAction({ type: 'breach', x: p.x, y: p.y }); break;
    default:
  }
}

// ----- renderer hooks

function unitAt(x, y) {
  return state.units.find((e) => e.alive && e.x === x && e.y === y);
}

function onTileTap(x, y) {
  if (!state || attract) return;
  const u = unitAt(x, y);
  if (u && u.team !== myTeam() && unitVisible(u) && ui.mode !== 'grenade') return onUnitTap(u.id);
  handleTile(x, y);
}

function handleTile(x, y) {
  if (!turnCtx || turnCtx.busy) return;
  const k = keyOf(x, y);
  const p = ui.pending;
  switch (ui.mode) {
    case 'move': {
      const node = ui.reach?.get(k);
      if (!node || node.d === 0) {
        if (p) { ui.pending = null; Rcall('setPathPreview', null); H.hideContext(); }
        else if (!node) { sfx.uiError(); H.toast('Out of reach', 'error'); }
        return;
      }
      if (p && p.k === k && (p.via !== 'hover' || lastPointer === 'mouse')) { confirmPending(); return; }
      sfx.uiClick();
      previewMove(k, 'tap');
      return;
    }
    case 'grenade': case 'breach': {
      if (p && p.k === k && (p.via !== 'hover' || lastPointer === 'mouse')) { confirmPending(); return; }
      if (!ui.valid?.has(k)) { sfx.uiError(); }
      else sfx.uiClick();
      previewArea(x, y, 'tap');
      return;
    }
    case 'shoot': case 'aimed':
      // Tapping the ground drops back to move mode and treats it as a move tap.
      setMode('move');
      handleTile(x, y);
      return;
    default:
  }
}

function onUnitTap(id) {
  if (!state || attract) return;
  const t = state.units[id];
  if (!t) return;
  if (t.team === myTeam()) { if (turnCtx) handleTile(t.x, t.y); return; }
  if (!unitVisible(t)) return;
  if (!turnCtx || turnCtx.busy) {
    H.toast(`Squad ${t.team + 1} · ${t.name} · ${CLASSES[t.cls].name} · ${t.hp}/${t.maxHp} HP`, 'info', 'eye');
    return;
  }
  if (ui.mode === 'grenade') { handleTile(t.x, t.y); return; }
  if (ui.mode === 'shoot' || ui.mode === 'aimed') {
    if (ui.target === id) { confirmPending(); return; }
    if (selectTarget(id)) { sfx.uiClick(); return; }
  }
  const u = turnCtx.u;
  let p = null;
  try { p = G.shotPreview(state, u, t); } catch { p = null; }
  if (!p || u.ap < 1) {
    sfx.uiError();
    H.toast(u.ap < 1 ? 'No AP left' : `No shot on ${t.name}: out of range or no line of sight`, 'error');
    return;
  }
  sfx.uiClick();
  setMode('shoot', id);
}

function onTileHover(x, y) {
  if (!state || attract || !turnCtx || turnCtx.busy) return;
  if (x === null || x === undefined) {
    if (ui.pending?.via === 'hover') {
      ui.pending = null;
      Rcall('setPathPreview', null);
      if (ui.mode === 'grenade' || ui.mode === 'breach') { Rcall('setAoePreview', null); showAreaPrompt(ui.mode); } else H.hideContext();
    }
    return;
  }
  if (ui.pending && ui.pending.via === 'tap') return; // a tapped choice wins over hover
  const k = keyOf(x, y);
  if (ui.pending?.k === k) return;
  if (ui.mode === 'move') {
    if (!previewMove(k, 'hover') && ui.pending?.via === 'hover') {
      ui.pending = null; Rcall('setPathPreview', null); H.hideContext();
    }
  } else if (ui.mode === 'grenade' || ui.mode === 'breach') {
    if (ui.valid?.has(k)) previewArea(x, y, 'hover');
  }
}

// ---------------------------------------------------------------- keyboard

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key;
  if (k === 'Escape') {
    if (closeTopSheet()) return;
    if (state && !$('hud').classList.contains('hidden')) {
      if (ui.mode !== 'move' || ui.pending) cancelMode();
      else openPause();
    }
    return;
  }
  if (sheetOpen()) return;
  if (!$('menu').classList.contains('hidden')) {
    if (k === 'Enter') { e.preventDefault(); sfx.uiClick(); startGame(); }
    return;
  }
  if (!state || $('hud').classList.contains('hidden')) return;
  const lower = k.toLowerCase();
  if (lower === 'q') { Rcall('rotate', -1); return; }
  if (lower === 'e') { Rcall('rotate', 1); return; }
  if (lower === 'f') { focusMe(); return; }
  if (lower === 'm') { settings.muted = !settings.muted; return; }
  if (k === ' ' || k === 'Spacebar') { e.preventDefault(); if (turnCtx) endTurnPressed(true); else endTurnPressed(); return; }
  if (k === 'Enter') { e.preventDefault(); confirmPending(); return; }
  if (k === 'Tab') { e.preventDefault(); if (ui.mode === 'shoot' || ui.mode === 'aimed') cycleTarget(e.shiftKey ? -1 : 1); else if (turnCtx) pressByKey('shoot'); return; }
  const map = { 1: 'move', 2: 'shoot', 3: 'grenade', 4: me()?.cls === 'marksman' ? 'aimed' : 'breach', 5: 'hunker', 6: 'overwatch', 7: 'medkit' };
  if (map[k]) pressByKey(map[k]);
});

function pressByKey(key) {
  const u = me();
  if (!u?.alive) return;
  const { list } = actionList(u);
  const a = list.find((x) => x.key === key);
  if (a) pressAction(a);
}

// ---------------------------------------------------------------- HUD

function updateEndBtn(force) {
  const b = $('endBtn');
  if (!b) return;
  if (b.classList.contains('armed') && !force) return;
  const u = me();
  const my = !!turnCtx && !turnCtx.busy;
  b.className = 'act end ' + (my ? 'on' : 'off');
  b.innerHTML = `<span class="ai">${ICON.end}</span><span class="al">End turn</span><kbd>Space</kbd>`;
  b.title = my ? 'End turn [Space]' : 'Wait for your turn';
  b.setAttribute('aria-disabled', my ? 'false' : 'true');
  b.classList.toggle('hidden', !u?.alive);
}

function updateHud() {
  if (!state || attract) return;
  const u = me();
  const alive = new Set(G.aliveTeams(state));
  const curTeam = state.winner === null ? G.currentTeamId(state) : -1;
  const mt = myTeam();

  // turn strip + label
  H.renderTurnStrip(state, { myTeam: mt, activeTeam: curTeam, alive });
  let label, kind;
  if (state.winner !== null) { label = state.winner === mt ? 'VICTORY' : 'MATCH OVER'; kind = state.winner === mt ? 'you' : 'neutral'; }
  else if (turnCtx) { label = 'YOUR TURN'; kind = 'you'; }
  else if (curTeam === mt) { label = playerAlive() ? 'SQUADMATES MOVING' : 'YOUR SQUAD'; kind = 'mates'; }
  else {
    const nextIdx = state.order.indexOf(curTeam) + 1;
    let n = nextIdx; while (n < state.order.length && !alive.has(state.order[n])) n++;
    const upNext = n < state.order.length && state.order[n] === mt && playerAlive();
    label = `SQUAD ${curTeam + 1}${upNext ? ' · YOU\'RE NEXT' : ''}`;
    kind = upNext ? 'enemy next' : 'enemy';
  }
  H.renderTurnLabel(label, kind);
  updateTimer();

  // chips
  const z = state.zone;
  H.renderChips({
    round: state.round,
    squadsLeft: alive.size,
    squadsTotal: state.teams.length,
    tideIn: G.roundsUntilShrink ? G.roundsUntilShrink(state) : 0,
    tideDmg: G.zoneDamage ? G.zoneDamage(state) : 0,
    outside: u?.alive && !G.insideZone(state, u.x, u.y),
    nextOutside: u?.alive && !G.insideZone(state, u.x, u.y, z.next),
  });

  // unit card + actions
  const mates = state.teams[mt]?.members.map((id) => state.units[id]).filter((m) => m.alive && !m.isPlayer).length || 0;
  const ws = u ? {
    range: RU.weaponRange ? RU.weaponRange(u) : u.weapon.range,
    aim: u.weapon.aim + (u.mods.scope || 0) * 5,
    dmg: [u.weapon.dmg[0] + (u.mods.barrel || 0), u.weapon.dmg[1] + (u.mods.barrel || 0)],
  } : null;
  H.renderUnitCard(u, {
    CLASSES, myTurn: !!turnCtx, weaponStats: ws,
    outside: u?.alive && !G.insideZone(state, u.x, u.y),
    nextOutside: u?.alive && !G.insideZone(state, u.x, u.y, z.next),
    spectating: !u?.alive, aliveMates: mates,
  });
  if (u?.alive) {
    const { list } = actionList(u);
    H.renderActions(list, pressAction);
  } else H.renderActions([], pressAction);
  updateEndBtn();
  document.body.classList.toggle('my-turn', !!turnCtx);
  document.body.classList.toggle('dead', !u?.alive);

  // spectator bar
  const spec = !u?.alive && state.winner === null;
  $('specBar').classList.toggle('hidden', !spec);
  if (spec && !fastForward) {
    $('skipBtn').disabled = false;
    $('specText').textContent = mates ? `Spectating · ${mates} squadmate${mates === 1 ? '' : 's'} fighting` : `Spectating · ${alive.size} squads left`;
  }
  $('dock').classList.toggle('spectating', !u?.alive);

  updateIntensity(u, alive);
  minimap.draw(state, R);
}

let hudQueued = false;
function queueHud() {
  if (hudQueued) return;
  hudQueued = true;
  requestAnimationFrame(() => { hudQueued = false; updateHud(); });
}

function updateIntensity(u, alive) {
  const total = Math.max(2, state.teams.length);
  const prog = 1 - (alive.size - 1) / (total - 1);
  const stage = clamp((state.zone.stage || 0) / 6, 0, 1);
  let near = 0;
  const ref = u?.alive ? u : (R?.myRef ? Rcall('myRef') : null);
  if (ref) {
    for (const e of state.units) {
      if (e.alive && e.team !== myTeam() && unitVisible(e) && RU.dist(e.x, e.y, ref.x, ref.y) <= 9) near++;
    }
  }
  let v = 0.12 + prog * 0.42 + stage * 0.16 + Math.min(1, near / 2) * 0.3;
  if (turnCtx) { const left = (turnCtx.deadline - performance.now()) / 1000; if (left < 6) v += 0.08; }
  if (state.winner !== null) v = 0.15;
  v = clamp(Math.round(v * 50) / 50, 0, 1);
  if (v !== lastIntensity) { lastIntensity = v; sfx.setIntensity(v); }
}

// ---------------------------------------------------------------- event bookkeeping

function meta(ev) {
  const st = state;
  const mt = myTeam();
  if (!fastForward) {
    const id = ev.id ?? ev.to;
    if (id !== undefined && st.units[id]?.team === mt && ['shot', 'damage', 'death', 'heal', 'crate', 'zone_damage'].includes(ev.type)) queueHud();
  }
  switch (ev.type) {
    case 'shot': {
      const s = st.units[ev.from], t = st.units[ev.to];
      lastCause[ev.to] = ev.reaction ? 'overwatch' : ev.ability === 'aimed' ? 'aimed' : 'shoot';
      if (s.isPlayer) { stats.shots++; if (ev.result !== 'miss') { stats.hits++; stats.dmg += ev.dmg || 0; } }
      if (t.isPlayer && ev.dmg) stats.taken += ev.dmg;
      break;
    }
    case 'grenade': lastAoe = ev.id; break;
    case 'breach': lastAoe = ev.id; break;
    case 'damage': {
      lastCause[ev.id] = ev.source === 'breach' ? 'breach' : 'grenade';
      const src = ev.by ?? ev.from ?? lastAoe;
      if (src !== null && src !== undefined && st.units[src]?.isPlayer && st.units[ev.id]?.team !== mt) stats.dmg += ev.dmg || 0;
      if (st.units[ev.id]?.isPlayer) stats.taken += ev.dmg || 0;
      break;
    }
    case 'zone_damage': lastCause[ev.id] = 'tide'; break;
    case 'death': {
      const u = st.units[ev.id];
      const k = ev.by !== null && ev.by !== undefined ? st.units[ev.by] : null;
      lastKillerTeam = k ? k.team : null;
      if (k?.isPlayer) stats.kills++;
      if (k && k.team === mt) stats.squadKills++;
      if (!fastForward) {
        H.feedKill({
          killer: k ? `${unitName(k)}` : null,
          victim: `${unitName(u)}`,
          cause: k ? (lastCause[ev.id] || 'shoot') : (lastCause[ev.id] || 'tide'),
          killerMine: k?.team === mt, victimMine: u.team === mt,
        });
        if (k?.isPlayer) H.toast(`You eliminated ${u.name}`, 'kill', 'skull');
      }
      if (u.isPlayer) {
        stats.roundOut = st.round;
        stats.killedBy = k ? k.name : null;
        const mates = st.teams[mt].members.some((id) => st.units[id].alive);
        if (!fastForward && mates) H.banner('YOU\'RE DOWN', 'bad', 'Your squad fights on', 1800);
        if (!mates) Rcall('setSpectator', true);
        applySpeed();
      }
      break;
    }
    case 'team_out':
      if (ev.team === mt) {
        playerPlace = ev.place;
        Rcall('setSpectator', true);
        if (!fastForward) H.banner(MODES[st.mode].teamSize > 1 ? 'SQUAD WIPED' : 'ELIMINATED', 'bad', `Placed #${ev.place} of ${st.teams.length}`, 2200);
        sfx.stinger('defeat');
      } else if (!fastForward) {
        H.feedInfo(`Squad ${ev.team + 1} eliminated · #${ev.place}`, 'out');
        if (lastKillerTeam === mt && st.winner === null) H.banner('SQUAD ELIMINATED', 'kill', `${G.aliveTeams(st).length} squads left`, 1300);
      }
      break;
    case 'crate': {
      const u = st.units[ev.id];
      if (u.team === mt && !fastForward) {
        const label = (K.CRATE_LABEL && K.CRATE_LABEL[ev.item]) || (ev.item === 'frag' ? '+1 Frag grenade' : ev.item === 'cache' ? 'Supply cache: scope, barrel and frag' : ev.item);
        H.toast(`${u.isPlayer ? '' : u.name + ': '}${label}`, 'loot', ev.item === 'frag' ? 'grenade' : 'crate');
      }
      break;
    }
    case 'supply_drop':
      if (!fastForward) {
        H.toast('Supply cache inbound inside the next ring', 'loot', 'drop');
        H.feedInfo('Supply drop spotted', 'signal');
      }
      break;
    case 'overwatch_trigger':
      if (!fastForward && st.units[ev.target].team === mt) H.toast(`Overwatch fire on ${unitName(st.units[ev.target])}!`, 'warn', 'overwatch');
      break;
    case 'zone_shrink':
      sfx.stinger('tide');
      if (!fastForward) H.banner('THE TIDE RISES', 'tide', `Safe radius ${ev.r} · next ${ev.next}`, 1800);
      break;
    case 'round_start':
      sfx.stinger('round');
      if (!fastForward) updateHud();
      break;
    case 'game_over':
      allowSleep();
      break;
    default:
  }
}

// ---------------------------------------------------------------- end screen

function showEnd() {
  const u = me();
  const mt = myTeam();
  const won = state.winner === mt;
  const place = won ? 1 : (playerPlace ?? '?');
  const total = state.teams.length;
  sfx.stinger(won ? 'victory' : 'defeat');
  sfx.setIntensity(0.15);
  allowSleep();
  if (!fastForward) H.banner(won ? '#1 LAST SQUAD STANDING' : `#${place} OF ${total}`, won ? 'win' : 'bad', '', 1800);
  const rounds = stats.roundOut ?? state.round;
  const acc = stats.shots ? Math.round((stats.hits / stats.shots) * 100) + '%' : '-';
  $('endKicker').innerHTML = `<span>${MODES[state.mode].name}</span><span>${CLASSES[u.cls].name}</span><span>Seed ${state.seed}</span>`;
  $('endPlace').innerHTML = `<span class="hash">#</span>${place}<small>/${total}</small>`;
  $('endPlace').className = 'end-place' + (won ? ' win' : '');
  const cause = lastCause[u.id];
  $('endTitle').textContent = won ? 'LAST SQUAD STANDING'
    : u.alive ? 'SQUAD WIPED'
    : place !== '?' && place <= 3 ? 'SO CLOSE'
    : cause === 'tide' && !stats.killedBy ? 'TAKEN BY THE TIDE' : 'ELIMINATED';
  $('endTitle').className = won ? 'win' : '';
  $('endSub').textContent = won
    ? 'Everyone else is under the water.'
    : stats.roundOut ? (stats.killedBy ? `${stats.killedBy} took you out in round ${stats.roundOut}.` : `The tide took you in round ${stats.roundOut}.`) : 'Your squad was wiped out.';
  const stat = (ic, v, k) => `<div class="es"><span class="es-ic">${ICON[ic]}</span><b>${v}</b><small>${k}</small></div>`;
  $('endStats').innerHTML = [
    stat('trophy', `#${place}`, 'Placement'),
    stat('skull', u.kills, 'Kills'),
    stat('burst', stats.dmg, 'Damage dealt'),
    stat('clock', rounds, 'Rounds survived'),
    stat('shoot', acc, 'Accuracy'),
    MODES[state.mode].teamSize > 1 ? stat('squads', stats.squadKills, 'Squad kills') : stat('heart', stats.taken, 'Damage taken'),
  ].join('');
  $('specBar').classList.add('hidden');
  setTimeout(() => {
    document.body.classList.add('ended');
    $('endScreen').classList.remove('hidden');
    requestAnimationFrame(() => $('endScreen').classList.add('open'));
  }, fastForward ? 0 : 1500);
}

// ---------------------------------------------------------------- boot

runAttract();

// Test hooks for automated smoke tests: open the page with ?debug.
if (DEBUG) {
  window.__dbg = {
    state: () => state,
    R,
    ui,
    sfx,
    get myTurn() { return !!turnCtx && !turnCtx.busy; },
    info: () => ({
      mode: ui.mode, myTurn: !!turnCtx, busy: !!turnCtx?.busy, pending: ui.pending && { ...ui.pending, path: undefined },
      target: ui.target, round: state?.round, winner: state?.winner, alive: playerAlive(), fastForward,
    }),
    setMode: (m, id) => { if (!turnCtx) return 'not my turn'; setMode(m, id); return ui.mode; },
    confirm: () => { confirmPending(); return 'ok'; },
    cancel: () => { cancelMode(); return ui.mode; },
    aim() {
      if (!turnCtx) return 'not my turn';
      const t = validTargets(turnCtx.u)[0];
      if (!t) return 'no target';
      Rcall('focus', state.units[t.id].x, state.units[t.id].y);
      setMode('shoot', t.id);
      return 'aiming at ' + state.units[t.id].name;
    },
    previewFirstReachable() {
      if (!turnCtx || turnCtx.busy || !ui.reach) return 'not my turn';
      if (ui.mode !== 'move') setMode('move');
      const S = state.map.size;
      const u = turnCtx.u;
      const opts = [...ui.reach.entries()].filter(([, n]) => n.d > 0 && n.d <= u.move);
      if (!opts.length) return 'nothing reachable';
      const [k] = opts[opts.length - 1];
      onTileTap(k % S, (k / S) | 0);
      return `preview ${k % S},${(k / S) | 0}`;
    },
    tapFirstReachable() {
      if (!turnCtx || turnCtx.busy || !ui.reach) return 'not my turn';
      if (ui.mode !== 'move') setMode('move');
      const S = state.map.size;
      const u = turnCtx.u;
      const opts = [...ui.reach.entries()].filter(([, n]) => n.d > 0 && n.d <= u.move);
      if (!opts.length) return 'nothing reachable';
      const [k] = opts[opts.length - 1];
      const x = k % S, y = (k / S) | 0;
      onTileTap(x, y); // preview
      onTileTap(x, y); // confirm
      return `moved to ${x},${y}`;
    },
    grenade() {
      if (!turnCtx) return 'not my turn';
      const u = turnCtx.u;
      const set = grenadeSet(u);
      if (!set?.size) return 'no grenade targets';
      setMode('grenade');
      if (ui.mode !== 'grenade') return 'grenade unavailable';
      const S = state.map.size;
      let best = null;
      for (const k of set) {
        const x = k % S, y = (k / S) | 0;
        const n = state.units.filter((e) => e.alive && e.team !== u.team && RU.dist(e.x, e.y, x, y) <= 1.5).length;
        const self = RU.dist(u.x, u.y, x, y) <= 1.5;
        if (!self && (!best || n > best.n)) best = { x, y, n };
      }
      if (!best) return 'no safe tile';
      onTileTap(best.x, best.y);
      return `grenade preview ${best.x},${best.y} hits ${best.n}`;
    },
    autoplay() {
      if (turnCtx && !turnCtx.busy) {
        const u = turnCtx.u;
        const t = validTargets(u)[0];
        doAction(t ? { type: 'shoot', targetId: t.id } : { type: 'overwatch' });
        return t ? 'shoot' : 'overwatch';
      }
      if (!playerAlive()) { fastForward = true; return 'fast-forward'; }
      return 'waiting';
    },
    fastForward: () => { fastForward = true; },
  };
}
