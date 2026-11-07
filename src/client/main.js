// Match controller: splash → loadout → drop-in → turns → end screen.
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
import { Ambient } from './ui/ambient.js';
import { career, recordMatch } from './ui/career.js';
import { buzz } from './ui/haptics.js';
import {
  initMenu, openSheet, closeSheet, closeTopSheet, closeAllSheets, sheetOpen, onSheetClose, setMenuToast, cleanCallsign,
} from './ui/menu.js';
import * as H from './ui/hud.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const { CLASSES, MODES } = K;
const TURN_SECONDS = K.TURN_SECONDS || 20;
const PARAMS = new URLSearchParams(location.search);
const DEBUG = PARAMS.has('debug');
const NO_TIMER = DEBUG && PARAMS.has('notimer'); // test harness: the clock never forces overwatch
const SCAN_RANGE = K.SCAN?.range ?? 12;
const SCAN_RADIUS = K.SCAN?.radius ?? 5;
const SMOKE_RADIUS = K.SMOKE?.radius ?? 1.5;
const FRAG_RADIUS = K.FRAG?.radius ?? 1.5;
const standing = (u) => !!u && u.alive && !u.downed;

// Three is only needed for screen-space damage indicators; the renderer loads it anyway.
let THREE = null;
import('three').then((m) => { THREE = m; }).catch(() => {});

// ---------------------------------------------------------------- audio

const SFX_METHODS = new Set(['resume', 'toggle', 'setVolume', 'setIntensity', 'startMusic', 'stopMusic', 'stinger',
  'shot', 'hit', 'miss', 'death', 'explosion', 'grenadeThrow', 'breach', 'hunker', 'step', 'pickup', 'tripwire', 'tide',
  'turn', 'tick', 'uiClick', 'uiHover', 'uiError', 'setMuted',
  'startMenuMusic', 'setAmbience', 'smoke', 'revive', 'downed', 'patch', 'scan', 'bleedOut']);

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
    onFeed: (m) => { if (!attract && !fastForward && state) H.feedInfo(m); },
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
const hasR = (name) => typeof R?.[name] === 'function';

// Track the last pointer type so desktop hover-then-click can move in one click.
let lastPointer = 'mouse';
window.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; }, true);
window.addEventListener('pointermove', (e) => { if (e.pointerType) lastPointer = e.pointerType; }, true);
// A HUD button clicked with a pointer must not keep focus: Space/Enter would re-fire it.
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('#hud button, #endScreen button');
  if (b && e.detail > 0) b.blur();
}, true);

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
let lastAoe = null;        // { id, x, y } of the last blast
let lastIntensity = -1;
let lastKillerTeam = null;
let lastAmbience = '';
let reviveSig = '';
let starting = false;
let introCtx = null;       // drop-in sequence
let introHideT = 0;
let endTimer = 0;
let armTimer = 0;
const timeouts = new Set(); // match-scoped timers, cleared on leave
function later(fn, ms) {
  const t = setTimeout(() => { timeouts.delete(t); fn(); }, ms);
  timeouts.add(t);
  return t;
}
function clearLater() { for (const t of timeouts) clearTimeout(t); timeouts.clear(); }

const ui = {
  mode: 'move',            // move | shoot | aimed | grenade | breach | smoke | scan | patch | revive
  reach: null,             // Map<key,{d,prev}> for move mode
  valid: null,             // Set<key> for area / support modes
  targets: [],             // [{id, p}] for shoot / aimed
  target: null,            // selected target id
  pending: null,           // {kind, k, x, y, via, ...}
  endArmed: 0,             // end-turn double tap guard
};
const AREA_MODES = new Set(['grenade', 'breach', 'smoke', 'scan']);
const SUPPORT_MODES = new Set(['patch', 'revive']);

const me = () => state?.units.find((u) => u.isPlayer);
const myTeam = () => state?.playerTeam ?? -1;
const keyOf = (x, y) => y * state.map.size + x;
const playerAlive = () => !!me()?.alive;
const playerUp = () => standing(me());
const teamMode = () => !!state && MODES[state.mode].teamSize > 1;
const callsign = () => cleanCallsign(settings.callsign) || 'You';
const unitVisible = (u) => {
  if (!u) return false;
  if (u.team === myTeam()) return true;
  if (typeof R?.isUnitVisible === 'function') { try { return !!R.isUnitVisible(u.id); } catch { /* fall through */ } }
  if (RU.teamSeesUnit && state) return RU.teamSeesUnit(state, myTeam(), u);
  return !!R?.unitObjs?.[u.id]?.g?.visible;
};
const tileVisible = (x, y) => {
  if (typeof R?.visibleToMe === 'function') { try { return !!R.visibleToMe(x, y); } catch { /* ignore */ } }
  return RU.teamSeesTile ? RU.teamSeesTile(state, myTeam(), x, y) : true;
};
const unitName = (u) => (u.isPlayer ? 'You' : u.name);

// ---------------------------------------------------------------- menu + settings

setMenuToast((m, k) => H.toast(m, k));
const ambient = new Ambient($('menuFx'));
const menu = initMenu({
  CLASSES, MODES, K,
  onDeploy: () => startGame(),
  onClick: () => { firstGesture(); sfx.uiClick(); },
  onHover: () => sfx.uiHover(),
  onEnter: () => { firstGesture(); sfx.startMenuMusic(); ambient.pulse(); },
  qualityNow: () => R?.quality,
});

let gestured = false;
function firstGesture() {
  if (gestured) return;
  gestured = true;
  sfx.resume();
  applyAudio();
}
window.addEventListener('pointerdown', () => { if (inMenu()) firstGesture(); }, { passive: true });
const inMenu = () => !$('menu').classList.contains('hidden') || !$('splash').classList.contains('hidden');

function applyAudio() {
  if (typeof rawSfx?.setMuted === 'function') { sfx.setMuted(!!settings.muted); sfx.setVolume(settings.volume); }
  else sfx.setVolume(settings.muted ? 0 : settings.volume);
  $('muteBtn').innerHTML = settings.muted ? ICON.soundOff : ICON.soundOn;
}
// Quality: '?gfx=low|high' in the URL always wins. 'auto' leaves the renderer's own
// pick (and its fps-based downgrade) alone; only switching back to auto re-arms it.
const GFX_PARAM = PARAMS.get('gfx');
function applyQuality(changed = false) {
  if (GFX_PARAM === 'low' || GFX_PARAM === 'high') return;
  if (settings.quality === 'auto') {
    if (!changed) return;
    if (hasR('setAutoQuality')) Rcall('setAutoQuality');
    else if (R) { R.qualityPinned = false; if (R.perf) R.perf.bad = 0; }
  } else Rcall('setQuality', settings.quality);
}
function applyVisualSettings() {
  Rcall('setCinematic', !!settings.cinematic);
  $('timer').dataset.style = settings.timer;
  updateTimer();
}
onSettingChange((k) => {
  if (k === 'volume' || k === 'muted') applyAudio();
  if (k === 'quality') applyQuality(true);
  if (k === 'cinematic' || k === 'timer') applyVisualSettings();
  if (k === 'botSpeed') applySpeed();
});
applyAudio();
applyQuality(false);
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
  if (!turnCtx || turnCtx.busy) { sfx.uiError(); if (state && playerUp()) H.toast('Wait for your turn', 'error'); return; }
  endTurnPressed();
};
$('skipBtn').onclick = () => { sfx.uiClick(); skipToResults(); };
$('speedBtn').onclick = () => {
  sfx.uiClick();
  specSpeed = specSpeed === 1 ? 2 : specSpeed === 2 ? 4 : 1;
  $('speedBtn').innerHTML = `${ICON.ff}<span>${specSpeed}×</span>`;
  applySpeed();
};
$('againBtn').onclick = () => { sfx.uiClick(); startGame(); };
$('loadoutBtn').onclick = () => { sfx.uiClick(); toMenu(); };
$('pSettings').onclick = () => { sfx.uiClick(); openSheet('settingsSheet'); };
$('pHow').onclick = () => { sfx.uiClick(); openSheet('howSheet'); };
$('pQuit').onclick = () => { sfx.uiClick(); closeAllSheets(); toMenu(); };
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
new ResizeObserver(() => {
  const h = $('squadAlert').classList.contains('hidden') ? 0 : $('squadAlert').offsetHeight + 6;
  document.body.style.setProperty('--sa-h', h + 'px');
}).observe($('squadAlert'));

// ---------------------------------------------------------------- minimap

const minimap = new Minimap($('minimap'), {
  onPick: (x, y) => { sfx.uiClick(); Rcall('setFollow', null); Rcall('focus', x, y); },
});
setInterval(() => {
  if (document.hidden || !state || fastForward || $('hud').classList.contains('hidden')) return;
  minimap.draw(state, R);
}, 180);

// ---------------------------------------------------------------- tab visibility

document.addEventListener('visibilitychange', () => {
  // Your clock must not run out while the app is in the background.
  if (document.hidden && turnCtx && !turnCtx.paused && !sheetOpen()) openPause();
});
const whileHidden = async (token) => { while (document.hidden && token === gameToken) await sleep(400); };

// ---------------------------------------------------------------- attract mode (menu backdrop)

let attractState = null;
async function runAttract() {
  if (!R || !G.createGame) return;
  const token = ++gameToken;
  attract = true;
  document.body.classList.add('in-menu');
  const showcase = hasR('setMenuShowcase');
  try {
    attractState = G.createGame({ mode: 'quads', noHuman: true, seed: (Math.random() * 2 ** 32) >>> 0 });
    state = null;
    Rcall('setGame', attractState, -1);
    Rcall('setSpectator', true);
    Rcall('setReviveMarkers', null);
    if (showcase) Rcall('setMenuShowcase', true); else Rcall('zoomBy', 1.15);
    R.speed = 1.1;
    const s = attractState;
    await sleep(600);
    while (s.winner === null && token === gameToken) {
      await whileHidden(token);
      const t = G.currentTeamId(s);
      for (const id of s.teams[t].members) {
        if (token !== gameToken) return;
        const u = s.units[id];
        if (!standing(u)) continue;
        let evs = [];
        try { evs = AI.botTakeTurn(s, id); } catch (e) { warnOnce('attract bot', e); }
        for (const ev of evs) {
          if (token !== gameToken) return;
          const a = actorOf(ev);
          // The showcase camera owns the view on the title screen: never fight it.
          if (!showcase && a !== null && s.units[a]) Rcall('focus', s.units[a].x, s.units[a].y);
          await safePlay(ev);
        }
        if (s.winner !== null) break;
        await sleep(evs.length ? 260 : 0);
      }
      if (token !== gameToken) return;
      for (const ev of G.endTeamTurn(s)) { if (token !== gameToken) return; await safePlay(ev); }
      if (!showcase && s.round % 3 === 0 && G.currentTeamId(s) === s.order[0]) Rcall('rotate', 1);
    }
    if (token === gameToken) { await sleep(2500); if (token === gameToken) runAttract(); }
  } catch (e) { warnOnce('attract', e); }
}

// ---------------------------------------------------------------- screen transitions

function wipe(on) {
  const w = $('wipe');
  if (on) { w.classList.remove('out'); w.classList.add('in'); }
  else { w.classList.remove('in'); w.classList.add('out'); setTimeout(() => w.classList.remove('out'), 600); }
}

// ---------------------------------------------------------------- game flow

function resetMatchUi() {
  clearLater();
  clearTimeout(endTimer);
  clearTimeout(armTimer);
  // Let a pending human turn settle so the old match loop sees the new token and exits.
  const oldTurn = turnCtx;
  turnCtx = null;
  oldTurn?.resolve?.();
  introCtx?.cancel?.();
  introCtx = null;
  clearPreviews();
  H.hideContext();
  H.hideBanner();
  H.clearFeed();
  H.clearJuice();
  ui.mode = 'move'; ui.pending = null; ui.target = null; ui.valid = null; ui.targets = []; ui.reach = null; ui.endArmed = 0;
  delete document.body.dataset.mode;
  document.body.classList.remove('my-turn', 'dead', 'downed', 'ctx-open', 'ended', 'intro');
  $('endBtn').classList.remove('armed');
  $('dropIn').classList.add('hidden');
  $('dropIn').classList.remove('show', 'go');
  const es = $('endScreen');
  es.classList.add('hidden');
  es.classList.remove('open');
  $('specBar').classList.add('hidden');
  $('skipBtn').disabled = false;
  reviveSig = '';
  Rcall('setReviveMarkers', null);
}

function toMenu() {
  if (stats && !stats.recorded && playerPlace) recordCareer(playerPlace); // left after being knocked out
  gameToken++;
  starting = false;
  state = null;
  stats = null;
  fastForward = false;
  allowSleep();
  resetMatchUi();
  closeAllSheets();
  $('hud').classList.add('hidden');
  document.body.classList.add('in-menu');
  document.body.classList.remove('in-game');
  menu.showMenu(false);
  sfx.startMenuMusic();
  sfx.setIntensity(0.1);
  setAmbience(0.1, 0);
  menu.renderModes();
  menu.renderClasses();
  ambient.start();
  runAttract();
}

async function startGame() {
  if (!R) { H.toast('The 3D view is unavailable on this device.', 'error'); return; }
  if (starting) return;
  starting = true;
  firstGesture();
  sfx.resume();
  keepAwake();
  const token = ++gameToken; // stops the attract loop and any older match
  attract = false;
  closeAllSheets();
  document.activeElement?.blur?.();
  wipe(true);
  await sleep(DEBUG && PARAMS.has('fast') ? 0 : 380);
  if (token !== gameToken) { starting = false; return; }

  resetMatchUi();
  fastForward = false;
  playerPlace = null;
  specSpeed = 2;
  $('speedBtn').innerHTML = `${ICON.ff}<span>2×</span>`;
  lastCause = {};
  lastAoe = null;
  lastIntensity = -1;
  lastAmbience = '';
  lastKillerTeam = null;
  state = G.createGame({
    mode: settings.mode, playerClass: settings.cls, callsign: callsign(),
    volunteerLoneWolf: settings.mode === 'trios' && !!settings.loneWolf,
  });
  stats = { dmg: 0, shots: 0, hits: 0, kills: 0, squadKills: 0, roundOut: null, taken: 0, revives: 0, patched: 0, scans: 0, downs: 0, recorded: false };
  Rcall('setMenuShowcase', false);
  Rcall('setGame', state, state.playerTeam);
  Rcall('setSpectator', false);
  Rcall('setFollow', null);
  applyVisualSettings();
  R.speed = 1;
  ambient.stop();
  $('menu').classList.add('hidden');
  $('splash').classList.add('hidden');
  $('hud').classList.remove('hidden');
  document.body.classList.remove('in-menu');
  document.body.classList.add('in-game', 'intro');
  focusMe();
  sfx.startMusic();
  setAmbience(0, 0);
  updateHud();
  wipe(false);
  starting = false;

  await dropIn(token);
  if (token !== gameToken || !state) return;
  document.body.classList.remove('intro');
  const u = me();
  if (u.isLoneWolf) later(() => H.toast('You are the Lone Wolf: +1 AP, +50% HP, +1 armor.', 'info', 'wolf'), 600);
  if (!settings.seenHowTo) {
    settings.seenHowTo = true;
    later(() => H.toast('Tap a tile to preview a move, tap again to go.', 'info', 'tap'), 1400);
  }
  runMatch(token);
}

// ----- DROP IN intro: squad cards + countdown. Tap to skip.

const CLASS_TIP = {
  assault: 'Frags do not end your turn: blast cover, then shoot.',
  marksman: 'Aimed Shot: +15 aim, +2 damage. Find a high, quiet angle.',
  breacher: 'Breach adjacent cover to expose whoever hides behind it.',
  medic: 'Patch revives a downed squadmate at 4 HP from the next tile.',
  recon: 'Scan before you push: it sees through walls for a full round.',
};

function dropIn(token) {
  const el = $('dropIn');
  const u = me();
  const mt = myTeam();
  const mode = MODES[state.mode];
  const squad = state.teams[mt].members.map((id) => state.units[id]);
  const nTeams = state.teams.length;
  $('diKicker').innerHTML = `<span>${esc(mode.name)}</span><span>${nTeams} squads</span><span>Round 1</span>`;
  $('diSquad').innerHTML = squad.map((m, i) => {
    const c = CLASSES[m.cls];
    return `<div class="di-card-u${m.isPlayer ? ' you' : ''}" style="--i:${i}">
      <div class="di-sil">${SILHOUETTE[m.cls] || ''}</div>
      <div class="di-meta"><b>${esc(m.isPlayer ? callsign() : m.name)}</b><small>${esc(c?.name || m.cls)}${m.isLoneWolf ? ' · Lone Wolf' : ''}</small>
      <span class="di-hp"><i style="--w:${Math.round((m.maxHp / 15) * 100)}%"></i><em>${m.maxHp} HP</em></span></div>
      ${m.isPlayer ? '<span class="di-you">You</span>' : ''}</div>`;
  }).join('') + (squad.length === 1 ? `<div class="di-vs"><b>${TOTAL_RIVALS()}</b><small>rivals</small></div>` : '');
  $('diTip').textContent = CLASS_TIP[u.cls] || 'Stay inside the ring. The tide is coming.';
  clearTimeout(introHideT);
  el.classList.remove('hidden', 'go', 'show');
  // A zoom-in "drop" while the countdown runs.
  if (typeof R?.view === 'number' && typeof R?.viewGoal === 'number') { const g = R.viewGoal; R.view = g * 1.9; R.viewGoal = g; }
  return new Promise((resolve) => {
    let done = false;
    const timers = [];
    const finish = () => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      el.removeEventListener('pointerdown', skip);
      el.classList.add('go');
      clearTimeout(introHideT);
      introHideT = setTimeout(() => { el.classList.add('hidden'); el.classList.remove('show', 'go'); }, 420);
      introCtx = null;
      resolve();
    };
    const skip = () => { sfx.uiClick(); finish(); };
    introCtx = { cancel: finish, skip };
    el.addEventListener('pointerdown', skip);
    const num = $('diNum');
    num.textContent = '';
    const step = DEBUG && PARAMS.has('fast') ? 60 : 750;
    const seq = ['3', '2', '1', 'GO'];
    // Chain each beat off the previous one, starting once the overlay has actually
    // painted: a long frame (world build, shader compile) delays the count instead
    // of collapsing it.
    const beat = (i) => {
      if (done) return;
      if (token !== gameToken) { finish(); return; }
      if (i >= seq.length) { finish(); return; }
      const n = seq[i];
      num.textContent = n;
      num.classList.remove('pop'); void num.offsetWidth; num.classList.add('pop');
      num.classList.toggle('go', n === 'GO');
      if (n === 'GO') { sfx.turn(); buzz('tap'); } else sfx.tick(false);
      timers.push(setTimeout(() => beat(i + 1), i === seq.length - 1 ? step * 0.6 : step));
    };
    requestAnimationFrame(() => {
      el.classList.add('show');
      requestAnimationFrame(() => requestAnimationFrame(() => timers.push(setTimeout(() => beat(0), 450))));
    });
  });
}
const TOTAL_RIVALS = () => (K.TOTAL_PLAYERS || 16) - 1;

function actorOf(ev) {
  switch (ev.type) {
    case 'move': case 'grenade': case 'breach': case 'overwatch': case 'heal': case 'hunker': case 'crate':
    case 'smoke': case 'scan': case 'patch':
      return ev.id;
    case 'revive': return ev.by ?? ev.id;
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
    if (token !== gameToken || !state) return shown;
    if (!fastForward) {
      const a = actorOf(ev);
      const visible = isEventVisible(ev);
      if (visible) shown = true;
      if (visible && settings.follow && a !== null) followFor(ev, a);
      preMeta(ev);
      await safePlay(ev);
      if (token !== gameToken || !state) return shown;
    }
    meta(ev);
  }
  if (!fastForward && state) { Rcall('setFollow', null); updateHud(); }
  return shown;
}

function isEventVisible(ev) {
  const st = state;
  const mt = myTeam();
  switch (ev.type) {
    case 'move': {
      const u = st.units[ev.id];
      return u.team === mt || ev.path.some(([x, y]) => tileVisible(x, y));
    }
    case 'shot': return st.units[ev.from].team === mt || st.units[ev.to].team === mt
      || unitVisible(st.units[ev.from]) || unitVisible(st.units[ev.to]);
    case 'grenade': case 'breach': case 'smoke': return st.units[ev.id]?.team === mt || tileVisible(ev.x, ev.y);
    case 'scan': return st.units[ev.id]?.team === mt || (ev.revealed || []).some((id) => st.units[id]?.team === mt);
    case 'overwatch': case 'heal': case 'hunker': case 'patch': return unitVisible(st.units[ev.id]);
    case 'death': case 'downed': case 'bleed_out': case 'revive': return unitVisible(st.units[ev.id]);
    case 'zone_shrink': case 'supply_drop': return true;
    default: return false;
  }
}

function followFor(ev, a) {
  const u = state.units[a];
  if (!u) return;
  if (ev.type === 'move') {
    if (hasR('setFollow')) Rcall('setFollow', a);
    else { const [x, y] = ev.path[ev.path.length - 1]; Rcall('focus', x, y); }
  } else if (ev.type === 'shot') {
    const t = state.units[ev.to];
    const d = R?.disp?.[a] || u;
    Rcall('focus', (d.x + t.x) / 2, (d.y + t.y) / 2);
  } else if (ev.type === 'grenade' || ev.type === 'breach' || ev.type === 'smoke' || ev.type === 'scan') {
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
    if (!fastForward) await whileHidden(token);
    if (token !== gameToken || !state) return;
    const t = G.currentTeamId(state);
    const team = state.teams[t];
    const prevTeam = activeTeam;
    activeTeam = t;
    applySpeed();
    if (!fastForward) { updateHud(); if (prevTeam !== t) handoff(t); }
    let shown = false;
    for (const id of team.members) {
      if (token !== gameToken || !state) return;
      const u = state.units[id];
      if (u.isPlayer || !standing(u)) continue;
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
    const human = team.members.map((id) => state.units[id]).find((u) => u.isPlayer && standing(u));
    if (state.winner === null && human && human.ap > 0) await humanTurn(human);
    if (token !== gameToken || !state) return;
    await play(G.endTeamTurn(state), token);
    if (token !== gameToken || !state) return;
    if (fastForward) await sleep(0);
    else if (shown) await sleep(140);
    else await nextFrame();
  }
  if (token !== gameToken || !state) return;
  if (fastForward) Rcall('syncFromState');
  activeTeam = -1;
  updateHud();
  showEnd(token);
}

/** Turn hand-off juice: a swipe across the turn label when a new squad takes over. */
function handoff(t) {
  const el = $('turnInfo');
  el.classList.remove('handoff');
  void el.offsetWidth;
  el.classList.add('handoff');
  document.body.dataset.turn = t === myTeam() ? 'mine' : 'enemy';
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
    buzz('turn');
    H.edgeGlow('you', 1100);
    H.banner('YOUR TURN', 'you', `${u.ap} AP · ${TURN_SECONDS} seconds`, 1100);
    setMode('move');
    updateHud();
    if (document.hidden) openPause();
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
  if (left <= 0 && !c.busy && !c.paused && !NO_TIMER) {
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
  ui.valid = null;
  ui.targets = [];
  ui.target = null;
  delete document.body.dataset.mode;
  clearTimeout(armTimer);
  $('endBtn').classList.remove('armed');
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
  if (!r || !r.ok) {
    sfx.uiError();
    buzz('error');
    H.toast(r?.error || 'Not possible', 'error');
    c.busy = false;
    setMode('move');
    updateHud();
    return false;
  }
  updateHud();
  await play(r.events);
  c.busy = false;
  if (turnCtx !== c) return true;
  if (!standing(c.u) || c.u.ap <= 0 || state.winner !== null) finishTurn();
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
  // Standing threats first, then by hit chance; downed enemies go last.
  out.sort((a, b) => (state.units[a.id].downed ? 1 : 0) - (state.units[b.id].downed ? 1 : 0) || b.p.chance - a.p.chance);
  return out;
}

/** Call a sim helper that returns a Set<key>; null if the helper is missing. */
function keySet(name, u) {
  const fn = G[name];
  if (typeof fn !== 'function') return null;
  try {
    const r = fn(state, u);
    if (r instanceof Set) return r;
    if (Array.isArray(r)) return new Set(r.map((v) => (typeof v === 'object' ? keyOf(v.x, v.y) : v)));
    return null;
  } catch (e) { warnOnce(name, e); return null; }
}
const grenadeSet = (u) => keySet('grenadeTargets', u);
const breachSet = (u) => keySet('breachTargets', u);
const smokeSet = (u) => keySet('smokeTargets', u);
const patchSet = (u) => keySet('patchTargets', u);
const reviveSet = (u) => keySet('reviveTargets', u);
function scanSet(u) {
  const out = new Set();
  const S = state.map.size;
  for (let y = Math.max(0, u.y - SCAN_RANGE); y <= Math.min(S - 1, u.y + SCAN_RANGE); y++) {
    for (let x = Math.max(0, u.x - SCAN_RANGE); x <= Math.min(S - 1, u.x + SCAN_RANGE); x++) {
      if (Math.hypot(x - u.x, y - u.y) <= SCAN_RANGE) out.add(y * S + x);
    }
  }
  return out;
}
function setFor(mode, u) {
  return { grenade: grenadeSet, breach: breachSet, smoke: smokeSet, scan: scanSet, patch: patchSet, revive: reviveSet }[mode]?.(u) ?? null;
}

const CD_LABEL = (n) => `Cooldown: ${n} round${n === 1 ? '' : 's'}`;
const downedMates = () => (state ? state.teams[myTeam()].members.map((id) => state.units[id]).filter((m) => m.alive && m.downed) : []);

function availability(u) {
  const out = {};
  const my = !!turnCtx;
  const busy = turnCtx?.busy;
  const base = !my ? 'Wait for your turn' : busy ? 'Action in progress' : u.ap < 1 ? 'No AP left' : null;
  const ab = abilityMap(u);
  const set = (k, reason, extra = {}) => { out[k] = { ok: !reason, reason, ...extra }; };
  const cdAbility = (key, missingHelper, emptyReason, setFn) => {
    const a = ab[key];
    const cd = a?.cooldown ?? u.cooldowns?.[key] ?? 0;
    let r = base;
    if (!r) {
      if (missingHelper) r = `${a?.name || key} arrives with the next sim update`;
      else if (cd > 0) r = CD_LABEL(cd);
      else if (setFn && !(setFn(u)?.size)) r = emptyReason;
      else if (a && !a.ready) r = a.reason || 'Not ready';
    }
    set(key, r, { cooldown: cd });
  };

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

  const smokes = u.items?.smoke ?? 0;
  const sa = ab.smoke;
  let sReason = base;
  if (!sReason) {
    if (typeof G.smokeTargets !== 'function') sReason = 'Smoke arrives with the next sim update';
    else if (smokes < 1) sReason = 'No smoke. Loot crates to find more';
    else if (!(smokeSet(u)?.size)) sReason = 'No visible tile in throw range';
    else if (sa && !sa.ready) sReason = sa.reason || 'Not ready';
  }
  set('smoke', sReason, { charges: sa?.charges ?? smokes });

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
  if (u.cls === 'breacher') cdAbility('breach', typeof G.breachTargets !== 'function', 'Stand next to cover to breach it', breachSet);
  if (u.cls === 'medic') cdAbility('patch', typeof G.patchTargets !== 'function', 'Nobody hurt next to you', patchSet);
  if (u.cls === 'recon') cdAbility('scan', false, null, null);

  if (teamMode()) {
    const downed = downedMates();
    let r = base;
    if (!r) {
      if (typeof G.reviveTargets !== 'function') r = 'Revive arrives with the next sim update';
      else if (!downed.length) r = 'No squadmate is down';
      else if (!(reviveSet(u)?.size)) r = `Move next to ${downed[0].name} to revive`;
    }
    set('revive', r, { count: downed.length });
  }
  const hk = ab.hunker;
  set('hunker', base || (hk && !hk.ready ? hk.reason || 'Not ready' : null));
  set('overwatch', base);
  set('medkit', base || (u.items.medkit < 1 ? 'No medkits' : u.hp >= u.maxHp ? 'Already at full health' : null), { count: u.items.medkit });
  set('end', !my ? 'Wait for your turn' : busy ? 'Action in progress' : null);
  return out;
}

const CLASS_ACTION = {
  marksman: { key: 'aimed', icon: 'aimed', label: 'Aimed' },
  breacher: { key: 'breach', icon: 'breach', label: 'Breach' },
  medic: { key: 'patch', icon: 'patch', label: 'Patch' },
  recon: { key: 'scan', icon: 'scan', label: 'Scan' },
};
const HOTKEYS = { move: '1', shoot: '2', aimed: '3', breach: '3', patch: '3', scan: '3', grenade: '4', smoke: '5', hunker: '6', overwatch: '7', medkit: '8', revive: 'R' };

function actionList(u) {
  const av = availability(u);
  const st = (k) => (!av[k].ok ? 'off' : ui.mode === k ? 'active' : 'on');
  const list = [
    { key: 'move', icon: 'move', label: 'Move' },
    { key: 'shoot', icon: 'shoot', label: 'Shoot', badge: av.shoot.ok && av.shoot.count ? av.shoot.count : null, badgeKind: 'tg' },
  ];
  const ca = CLASS_ACTION[u.cls];
  if (ca && av[ca.key]) list.push({ ...ca, badge: av[ca.key].cooldown > 0 ? av[ca.key].cooldown : null, badgeKind: 'cd', cls: 'ability' });
  const frags = av.grenade.charges ?? 0;
  if (frags > 0 || u.cls === 'assault') list.push({ key: 'grenade', icon: 'grenade', label: 'Frag', badge: frags, badgeKind: frags > 0 ? 'ch' : 'zero' });
  const smokes = av.smoke.charges ?? 0;
  if (smokes > 0 || u.cls === 'recon') list.push({ key: 'smoke', icon: 'smoke', label: 'Smoke', badge: smokes, badgeKind: smokes > 0 ? 'ch' : 'zero' });
  if (av.revive && av.revive.count > 0) list.push({ key: 'revive', icon: 'revive', label: 'Revive', badge: av.revive.count, badgeKind: av.revive.ok ? 'rv' : 'zero', cls: av.revive.ok ? 'urgent' : '' });
  list.push(
    { key: 'hunker', icon: 'hunker', label: 'Hunker' },
    { key: 'overwatch', icon: 'overwatch', label: 'Watch' },
    { key: 'medkit', icon: 'medkit', label: 'Medkit', badge: u.items.medkit, badgeKind: u.items.medkit ? 'ch' : 'zero' },
  );
  for (const a of list) { a.state = st(a.key); a.reason = av[a.key].reason; a.hotkey = HOTKEYS[a.key]; }
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
    case 'shoot': case 'aimed': case 'grenade': case 'breach': case 'smoke': case 'scan': case 'patch': case 'revive':
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
    clearTimeout(armTimer);
    armTimer = setTimeout(() => { $('endBtn').classList.remove('armed'); updateEndBtn(true); }, 2200);
    return;
  }
  ui.endArmed = 0;
  clearTimeout(armTimer);
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
  if (!u || !state) { ui.mode = 'move'; delete document.body.dataset.mode; return; }

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
  } else if (AREA_MODES.has(mode)) {
    ui.valid = setFor(mode, u);
    if (!ui.valid?.size) {
      H.toast({ grenade: 'No tile in throw range', smoke: 'No tile in throw range', breach: 'Nothing to breach here', scan: 'Nothing to scan' }[mode], 'error');
      sfx.uiError();
      return setMode('move');
    }
    const hl = new Map();
    for (const k of ui.valid) hl.set(k, 2);
    Rcall('setHighlights', hl);
    if (mode === 'breach' && ui.valid.size === 1) {
      const [k] = ui.valid; const S = state.map.size;
      previewArea(k % S, (k / S) | 0, 'tap');
    } else showAreaPrompt(mode);
  } else if (SUPPORT_MODES.has(mode)) {
    ui.valid = setFor(mode, u);
    if (!ui.valid?.size) { H.toast(mode === 'patch' ? 'Nobody hurt next to you' : 'No downed squadmate next to you', 'error'); sfx.uiError(); return setMode('move'); }
    const hl = new Map();
    for (const k of ui.valid) hl.set(k, 1);
    Rcall('setHighlights', hl);
    // Preselect: the requested unit, else the most urgent (downed, lowest bleed), else the most hurt.
    const cands = [...ui.valid].map((k) => unitAtKey(k)).filter(Boolean);
    cands.sort((a, b) => (b.downed - a.downed) || ((a.bleed || 9) - (b.bleed || 9)) || ((a.hp / a.maxHp) - (b.hp / b.maxHp)) || (a.isPlayer - b.isPlayer));
    const pick = cands.find((c) => c.id === preselect) || cands[0];
    if (pick) previewSupport(pick, 'tap');
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
  const enemies = state.units.filter((e) => standing(e) && e.team !== u.team && unitVisible(e));
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
  const smoke = RU.smokeAt ? RU.smokeAt(state, p.x, p.y) : null;
  const coverTxt = ['Exposed', 'Half cover', 'Full cover'][ci.best];
  const notes = [];
  if (ci.flankers) notes.push(`<span class="n bad">${ICON.warn}Flanked by ${ci.flankers}</span>`);
  if (smoke) notes.push(`<span class="n good">${ICON.smoke}In smoke +${K.SMOKE?.defense ?? 25} def</span>`);
  if (crate) notes.push(`<span class="n loot">${ICON.crate}${crate.type === 'cache' ? 'Supply cache' : 'Crate'}</span>`);
  const downedNear = downedMates().filter((m) => Math.max(Math.abs(m.x - p.x), Math.abs(m.y - p.y)) <= 1);
  if (downedNear.length) notes.push(`<span class="n rv">${ICON.revive}Next to ${esc(downedNear[0].name)}</span>`);
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
  if (!hasR('setSelectedTarget')) { const tu = state.units[id], u = turnCtx.u; Rcall('focus', (tu.x + u.x) / 2, (tu.y + u.y) / 2); }
  Rcall('setTargetMarkers', ui.targets.map((x) => ({ id: x.id, chance: x.p.chance, selected: x.id === id })));
  showTargetContext(t);
  return true;
}

function showTargetContext({ id, p }) {
  const t = state.units[id];
  const c = CLASSES[t.cls];
  const aimed = ui.mode === 'aimed';
  const lethal = t.downed || p.dmg[1] >= t.hp;
  const sure = t.downed || p.dmg[0] >= t.hp;
  const hpPips = Array.from({ length: t.maxHp }, (_, i) => {
    const on = i < t.hp;
    const threat = on && i >= t.hp - p.dmg[1];
    return `<i class="${on ? 'on' : ''}${threat ? ' threat' : ''}"></i>`;
  }).join('');
  const coverWord = p.cover === 2 ? 'Full cover' : p.cover === 1 ? 'Half cover' : p.flank ? 'Flanked' : 'Exposed';
  const notes = (p.notes || []).map((n) => {
    const good = /\+/.test(n) && !/-/.test(n);
    return `<span class="n ${good ? 'good' : 'bad'}">${esc(n)}</span>`;
  }).join('');
  const smoke = RU.smokeAt ? RU.smokeAt(state, t.x, t.y) : null;
  const idx = ui.targets.findIndex((x) => x.id === id);
  const html = `
    <div class="ctx-h enemy"><span class="sil-sm">${SILHOUETTE[t.cls] || ''}</span>
      <div class="tgt-name"><b>${esc(t.name)}</b><small>Squad ${t.team + 1} · ${esc(c?.name || t.cls)}${t.isLoneWolf ? ' · Lone Wolf' : ''}</small></div>
      ${ui.targets.length > 1 ? `<button class="btn ghost sm cycle" id="cycleBtn" title="Next target [Tab]">${idx + 1}/${ui.targets.length}<span class="kbd-hint">Tab</span></button>` : ''}</div>
    <div class="tgt-hp">${t.downed ? `<span class="tag bleed">${ICON.downed}Downed · ${t.bleed} turn${t.bleed === 1 ? '' : 's'} left</span>` : `<span class="hp-pips enemy${t.maxHp > 14 ? ' dense' : ''}">${hpPips}</span><span>${t.hp}/${t.maxHp}</span>`}${t.armor ? `<span class="armor">${ICON.shield}<b>${t.armor}</b></span>` : ''}${t.hunkered ? `<span class="tag hk">${ICON.hunker}Hunkered</span>` : ''}${smoke ? `<span class="tag sm">${ICON.smoke}In smoke</span>` : ''}</div>
    <div class="odds">
      <div class="odd big"><b>${p.chance}<small>%</small></b><span>Hit</span></div>
      <div class="odd"><b>${p.graze || 0}<small>%</small></b><span>Graze</span></div>
      <div class="odd"><b>${p.dmg[0]}–${p.dmg[1]}</b><span>Damage</span></div>
      <div class="odd ${sure ? 'kill' : lethal ? 'maybe' : ''}"><b>${t.downed ? 'FINISH' : sure ? 'KILL' : lethal ? 'CAN KILL' : coverWord}</b><span>${sure || lethal ? coverWord : 'Target'}</span></div>
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

// ----- area abilities: grenade / breach / smoke / scan

const AREA = {
  grenade: { icon: 'grenade', title: 'Frag grenade', verb: 'Throw', radius: FRAG_RADIUS, prompt: 'Tap a highlighted tile up to 7 tiles away', bad: 'Out of range or no line of sight' },
  smoke: { icon: 'smoke', title: 'Smoke grenade', verb: 'Throw', radius: SMOKE_RADIUS, prompt: 'Tap a tile to drop a 3×3 smoke screen', bad: 'Out of range or no line of sight' },
  breach: { icon: 'breach', title: 'Breach', verb: 'Breach', radius: 1, prompt: 'Tap the cover next to you to blow it open', bad: 'Pick cover right next to you' },
  scan: { icon: 'scan', title: 'Recon scan', verb: 'Scan', radius: SCAN_RADIUS, prompt: `Tap anywhere within ${SCAN_RANGE} tiles. Walls don't block it`, bad: `Too far: scans reach ${SCAN_RANGE} tiles` },
};

function showAreaPrompt(mode) {
  const u = turnCtx.u;
  const A = AREA[mode];
  const charges = mode === 'grenade' ? `<span class="cost">${u.items.frag ?? 0} left</span>` : mode === 'smoke' ? `<span class="cost">${u.items.smoke ?? 0} left</span>` : '';
  const html = `
    <div class="ctx-h"><span class="ctx-ic">${ICON[A.icon]}</span><b>${A.title}</b>${charges}<span class="spacer"></span></div>
    <div class="ctx-hint big">${A.prompt}</div>`;
  H.showContext(html, 'area ' + mode);
  $('fireBtn').innerHTML = `${ICON.check}<span>${A.verb}</span>`;
  $('fireBtn').disabled = true;
}

function localAreaPreview(kind, x, y) {
  const u = turnCtx.u;
  const r = kind === 'grenade' ? FRAG_RADIUS : 1.5;
  const base = kind === 'grenade' ? 3 : 4;
  const units = state.units.filter((e) => e.alive && RU.dist(e.x, e.y, x, y) <= r && (kind === 'grenade' || e.team !== u.team))
    .map((e) => { const dmg = Math.max(1, base - e.armor); return { id: e.id, dmg, lethal: dmg >= e.hp }; });
  return { valid: ui.valid?.has(keyOf(x, y)) ?? true, units, cover: [] };
}

function previewArea(x, y, via) {
  const u = turnCtx.u;
  const k = keyOf(x, y);
  const kind = ui.mode;
  const A = AREA[kind];
  const valid = !!ui.valid?.has(k);
  let pv = null;
  const pfn = { grenade: G.grenadePreview, breach: G.breachPreview, smoke: G.smokePreview, scan: G.scanPreview }[kind];
  if (typeof pfn === 'function') {
    try { pv = pfn(state, u, x, y); } catch (e) { warnOnce(kind + 'Preview', e); }
  }
  if (!pv) pv = kind === 'grenade' || kind === 'breach' ? localAreaPreview(kind, x, y) : { valid, units: [] };
  const ok = valid && pv.valid !== false;
  Rcall('setAoePreview', { x, y, radius: pv.radius ?? A.radius, valid: ok, kind: kind === 'breach' ? 'frag' : kind === 'grenade' ? 'frag' : kind });
  if (via === 'tap') Rcall('focus', (x + u.x) / 2, (y + u.y) / 2);
  ui.pending = ok ? { kind, k, x, y, via } : null;
  // Only list units the player can already see (no free intel).
  const seen = (pv.units || []).filter((h) => unitVisible(state.units[h.id]));
  let rows = '';
  let foot = '';
  if (kind === 'grenade' || kind === 'breach') {
    rows = seen.map((h) => {
      const t = state.units[h.id];
      const mine = t.team === u.team;
      return `<span class="hit ${mine ? 'ff' : 'en'}${h.lethal ? ' lethal' : ''}">${esc(unitName(t))}<b>-${h.dmg}</b>${h.lethal ? `<em>${ICON.skull}</em>` : ''}</span>`;
    }).join('') || '<span class="dim">No visible units in the blast</span>';
    const ff = seen.some((h) => state.units[h.id].team === u.team);
    const covers = (pv.cover || []).length;
    foot = `${covers ? `<span class="n warn">${ICON.burst}${covers} cover tile${covers === 1 ? '' : 's'} wrecked</span>` : kind === 'grenade' ? `<span class="n">${ICON.burst}3×3 blast · ignores cover</span>` : `<span class="n">${ICON.burst}Opens this tile · 4 dmg nearby</span>`}
      ${ff ? `<span class="n bad">${ICON.warn}Friendly fire</span>` : ''}`;
  } else if (kind === 'smoke') {
    const allies = seen.filter((h) => state.units[h.id].team === u.team);
    const foes = seen.filter((h) => state.units[h.id].team !== u.team);
    rows = allies.map((h) => `<span class="hit sm">${esc(unitName(state.units[h.id]))}<b>+${K.SMOKE?.defense ?? 25}</b></span>`).join('')
      + foes.map((h) => `<span class="hit en">${esc(state.units[h.id].name)}<b>+${K.SMOKE?.defense ?? 25}</b></span>`).join('')
      || '<span class="dim">Nobody inside yet. Smoke lasts until your next turn</span>';
    foot = `<span class="n">${ICON.smoke}+${K.SMOKE?.defense ?? 25} defense inside · lasts a round</span>${foes.length ? `<span class="n warn">${ICON.warn}Shields enemies too</span>` : ''}`;
  } else if (kind === 'scan') {
    rows = `<span class="n scan">${ICON.scan}${seen.length ? `${seen.length} known contact${seen.length === 1 ? '' : 's'} in the area` : 'No known contacts in the area'}</span>`;
    foot = `<span class="n">${ICON.eye}Reveals everyone within ${pv.radius ?? SCAN_RADIUS} tiles until your next turn</span>`;
  }
  const charges = kind === 'grenade' ? `<span class="dim">${u.items.frag ?? 0} left</span>` : kind === 'smoke' ? `<span class="dim">${u.items.smoke ?? 0} left</span>` : '';
  const html = `
    <div class="ctx-h"><span class="ctx-ic">${ICON[A.icon]}</span><b>${A.title}</b><span class="cost">1 AP</span>${charges}<span class="spacer"></span></div>
    ${ok ? `<div class="ctx-row hits">${rows}</div><div class="ctx-row">${foot}</div>`
    : `<div class="ctx-hint big bad">${A.bad}</div>`}
    ${via === 'hover' && ok ? `<div class="ctx-hint">Click to ${A.verb.toLowerCase()}</div>` : ''}`;
  H.showContext(html, 'area ' + kind + (ok ? '' : ' invalid'));
  $('fireBtn').innerHTML = `${ICON.check}<span>${A.verb}</span>`;
  $('fireBtn').disabled = !ok;
}

// ----- support abilities: patch / revive

function unitAtKey(k) {
  const S = state.map.size;
  return state.units.find((e) => e.alive && e.x === k % S && e.y === ((k / S) | 0)) || null;
}

function previewSupport(t, via) {
  const u = turnCtx.u;
  const kind = ui.mode;
  const k = keyOf(t.x, t.y);
  const ok = !!ui.valid?.has(k) && t.team === u.team;
  ui.pending = ok ? { kind, k, x: t.x, y: t.y, id: t.id, via } : null;
  Rcall('setAoePreview', { x: t.x, y: t.y, radius: 0.6, valid: ok, kind: 'scan' }); // cyan ring: support, not a blast
  const healTo = kind === 'patch'
    ? (t.downed ? (K.PATCH?.reviveHp ?? 4) : Math.min(t.maxHp, t.hp + (K.PATCH?.heal ?? 5)))
    : (K.REVIVE_HP ?? 3);
  const pips = Array.from({ length: t.maxHp }, (_, i) => `<i class="${i < t.hp ? 'on' : ''}${i >= t.hp && i < healTo ? ' gain' : ''}"></i>`).join('');
  const title = kind === 'patch' ? (t.downed ? 'Patch · revive' : 'Patch') : 'Revive';
  const who = t.id === u.id ? 'Yourself' : t.name;
  const html = `
    <div class="ctx-h"><span class="ctx-ic heal">${ICON[kind === 'patch' ? 'patch' : 'revive']}</span><b>${title}</b><span class="cost">1 AP</span>${kind === 'patch' ? `<span class="dim">Cooldown ${K.PATCH?.cooldown ?? 2}</span>` : ''}<span class="spacer"></span>
      ${ui.valid.size > 1 ? `<span class="dim">${ui.valid.size} targets</span>` : ''}</div>
    ${ok ? `<div class="sup-row"><span class="sil-sm mine">${SILHOUETTE[t.cls] || ''}</span>
      <div class="tgt-name"><b class="mine">${esc(who)}</b><small>${t.downed ? `Downed · ${t.bleed} turn${t.bleed === 1 ? '' : 's'} to bleed out` : `${t.hp}/${t.maxHp} HP`}</small></div>
      <div class="sup-res"><span class="hp-pips heal${t.maxHp > 14 ? ' dense' : ''}">${pips}</span><b>${t.downed ? `Up at ${healTo} HP` : `${t.hp} → ${healTo} HP`}</b></div></div>`
    : `<div class="ctx-hint big bad">${kind === 'patch' ? 'Pick yourself or a hurt squadmate next to you' : 'Pick a downed squadmate next to you'}</div>`}
    ${ui.valid.size > 1 ? '<div class="ctx-hint">Tap another highlighted squadmate to switch</div>' : ''}`;
  H.showContext(html, 'support' + (ok ? '' : ' invalid'));
  $('fireBtn').innerHTML = `${ICON[kind === 'patch' ? 'patch' : 'revive']}<span>${kind === 'patch' ? 'Patch' : 'Revive'}</span>`;
  $('fireBtn').disabled = !ok;
  if (via === 'tap') Rcall('focus', (t.x + u.x) / 2, (t.y + u.y) / 2);
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
    case 'smoke': doAction({ type: 'smoke', x: p.x, y: p.y }); break;
    case 'scan': doAction({ type: 'scan', x: p.x, y: p.y }); break;
    case 'breach': doAction({ type: 'breach', x: p.x, y: p.y }); break;
    case 'patch': doAction({ type: 'patch', targetId: p.id }); break;
    case 'revive': doAction({ type: 'revive', targetId: p.id }); break;
    default:
  }
}

/** One-tap revive from the squad alert (or the R key). */
function quickRevive(id) {
  if (!turnCtx || turnCtx.busy) { sfx.uiError(); H.toast('Wait for your turn', 'error'); return; }
  const set = reviveSet(turnCtx.u);
  const t = state.units[id];
  if (!t || !set?.has(keyOf(t.x, t.y))) { sfx.uiError(); H.toast(`Move next to ${t?.name || 'them'} first`, 'error'); return; }
  setMode('revive', id);
}

// ----- renderer hooks

function unitAt(x, y) {
  return state.units.find((e) => e.alive && e.x === x && e.y === y);
}

function onTileTap(x, y) {
  if (!state || attract || introCtx) return;
  const u = unitAt(x, y);
  if (u && u.team !== myTeam() && unitVisible(u) && !AREA_MODES.has(ui.mode)) return onUnitTap(u.id);
  handleTile(x, y);
}

function handleTile(x, y) {
  if (!turnCtx || turnCtx.busy) return;
  const k = keyOf(x, y);
  const p = ui.pending;
  const sameTap = p && p.k === k && (p.via !== 'hover' || lastPointer === 'mouse');
  switch (ui.mode) {
    case 'move': {
      const node = ui.reach?.get(k);
      const ally = unitAt(x, y);
      // Tapping a downed squadmate next to you starts a revive.
      if (ally && ally.downed && ally.team === myTeam() && reviveSet(turnCtx.u)?.has(k)) { sfx.uiClick(); setMode('revive', ally.id); return; }
      if (ally && ally.downed && ally.team === myTeam()) { sfx.uiError(); H.toast(`Move next to ${ally.name} to revive`, 'info', 'revive'); return; }
      if (!node || node.d === 0) {
        if (p) { ui.pending = null; Rcall('setPathPreview', null); H.hideContext(); }
        else if (!node) { sfx.uiError(); H.toast('Out of reach', 'error'); }
        return;
      }
      if (sameTap) { confirmPending(); return; }
      sfx.uiClick();
      previewMove(k, 'tap');
      return;
    }
    case 'grenade': case 'breach': case 'smoke': case 'scan': {
      if (sameTap) { confirmPending(); return; }
      if (!ui.valid?.has(k)) sfx.uiError();
      else sfx.uiClick();
      previewArea(x, y, 'tap');
      return;
    }
    case 'patch': case 'revive': {
      const t = unitAt(x, y);
      if (sameTap) { confirmPending(); return; }
      if (!t || !ui.valid?.has(k)) {
        sfx.uiError();
        H.toast(ui.mode === 'patch' ? 'Tap yourself or a highlighted squadmate' : 'Tap a highlighted downed squadmate', 'error');
        return;
      }
      sfx.uiClick();
      previewSupport(t, 'tap');
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
  if (!state || attract || introCtx) return;
  const t = state.units[id];
  if (!t) return;
  if (t.team === myTeam()) { if (turnCtx) handleTile(t.x, t.y); return; }
  if (!unitVisible(t)) return;
  if (!turnCtx || turnCtx.busy) {
    H.toast(`Squad ${t.team + 1} · ${t.name} · ${CLASSES[t.cls]?.name || t.cls} · ${t.downed ? 'downed' : `${t.hp}/${t.maxHp} HP`}`, 'info', 'eye');
    return;
  }
  if (AREA_MODES.has(ui.mode)) { handleTile(t.x, t.y); return; }
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
      if (AREA_MODES.has(ui.mode)) { Rcall('setAoePreview', null); showAreaPrompt(ui.mode); } else H.hideContext();
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
  } else if (AREA_MODES.has(ui.mode)) {
    if (ui.valid?.has(k)) previewArea(x, y, 'hover');
  }
}

// ---------------------------------------------------------------- keyboard

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key;
  if (k === 'Escape') {
    if (closeTopSheet()) return;
    if (introCtx) { introCtx.skip(); return; }
    if (state && !$('hud').classList.contains('hidden') && $('endScreen').classList.contains('hidden')) {
      if (ui.mode !== 'move' || ui.pending) cancelMode();
      else openPause();
    }
    return;
  }
  if (sheetOpen()) return;
  if (!$('splash').classList.contains('hidden')) {
    if (!e.metaKey && !e.ctrlKey && !e.altKey && k !== 'Tab' && k !== 'Shift') { e.preventDefault(); menu.enter(); }
    return;
  }
  if (!$('menu').classList.contains('hidden')) {
    if (k === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); sfx.uiClick(); startGame(); }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const ks = Object.keys(CLASSES); const i = ks.indexOf(settings.cls);
      settings.cls = ks[(i + (k === 'ArrowRight' ? 1 : -1) + ks.length) % ks.length];
      sfx.uiClick(); menu.renderClasses();
    }
    return;
  }
  if (introCtx) { if (k === ' ' || k === 'Enter') { e.preventDefault(); introCtx.skip(); } return; }
  if (!$('endScreen').classList.contains('hidden')) return;
  if (!state || $('hud').classList.contains('hidden')) return;
  const lower = k.toLowerCase();
  if (lower === 'q') { Rcall('rotate', -1); return; }
  if (lower === 'e') { Rcall('rotate', 1); return; }
  if (lower === 'f') { focusMe(); return; }
  if (lower === 'm') { settings.muted = !settings.muted; return; }
  if (lower === 'r') { pressByKey('revive'); return; }
  if (k === ' ' || k === 'Spacebar') { e.preventDefault(); if (turnCtx) endTurnPressed(true); else endTurnPressed(); return; }
  if (k === 'Enter') { e.preventDefault(); confirmPending(); return; }
  if (k === 'Tab') { e.preventDefault(); if (ui.mode === 'shoot' || ui.mode === 'aimed') cycleTarget(e.shiftKey ? -1 : 1); else if (turnCtx) pressByKey('shoot'); return; }
  const cls = me()?.cls;
  const map = { 1: 'move', 2: 'shoot', 3: CLASS_ACTION[cls]?.key, 4: 'grenade', 5: 'smoke', 6: 'hunker', 7: 'overwatch', 8: 'medkit' };
  if (map[k]) pressByKey(map[k]);
});

function pressByKey(key) {
  const u = me();
  if (!standing(u)) return;
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
  b.classList.toggle('hidden', !standing(u));
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
  else if (curTeam === mt) { label = playerUp() ? 'SQUADMATES MOVING' : 'YOUR SQUAD'; kind = 'mates'; }
  else {
    const nextIdx = state.order.indexOf(curTeam) + 1;
    let n = nextIdx; while (n < state.order.length && !alive.has(state.order[n])) n++;
    const upNext = n < state.order.length && state.order[n] === mt && playerUp();
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
  const mates = state.teams[mt]?.members.map((id) => state.units[id]).filter((m) => standing(m) && !m.isPlayer).length || 0;
  const ws = u ? {
    range: RU.weaponRange ? RU.weaponRange(u) : u.weapon.range,
    aim: u.weapon.aim + (u.mods.scope || 0) * 5,
    dmg: [u.weapon.dmg[0] + (u.mods.barrel || 0), u.weapon.dmg[1] + (u.mods.barrel || 0)],
  } : null;
  const spotted = !!u?.alive && !!state.reveals?.some((r) => r.team !== mt && r.ids?.includes(u.id));
  H.renderUnitCard(u, {
    CLASSES, myTurn: !!turnCtx, weaponStats: ws, callsign: callsign(),
    outside: u?.alive && !G.insideZone(state, u.x, u.y),
    nextOutside: u?.alive && !G.insideZone(state, u.x, u.y, z.next),
    spectating: !u?.alive, aliveMates: mates,
    inSmoke: !!(u?.alive && RU.smokeAt && RU.smokeAt(state, u.x, u.y)),
    spotted,
  });
  if (standing(u)) {
    const { list } = actionList(u);
    H.renderActions(list, pressAction);
  } else H.renderActions([], pressAction);
  updateEndBtn();
  document.body.classList.toggle('my-turn', !!turnCtx);
  document.body.classList.toggle('dead', !u?.alive);
  document.body.classList.toggle('downed', !!u?.alive && !!u?.downed);

  // downed squadmates: alert + world markers
  const downed = state.winner === null ? downedMates() : [];
  const canAct = !!turnCtx && !turnCtx.busy && standing(u) && u.ap > 0;
  const rset = canAct && downed.length ? reviveSet(u) : null;
  H.renderSquadAlert(downed.map((m) => ({
    id: m.id, name: m.name, cls: m.cls, bleed: m.bleed ?? 0, isPlayer: m.isPlayer,
    adjacent: !!rset?.has(keyOf(m.x, m.y)),
  })), {
    canAct,
    onRevive: (id) => { sfx.uiClick(); quickRevive(id); },
    onFind: (id) => { sfx.uiClick(); const m = state.units[id]; Rcall('setFollow', null); Rcall('focus', m.x, m.y); },
  });
  const sig = downed.map((m) => m.id).join(',');
  if (sig !== reviveSig) { reviveSig = sig; Rcall('setReviveMarkers', downed.length ? downed.map((m) => m.id) : null); }

  // spectator bar
  const spec = !u?.alive && state.winner === null;
  $('specBar').classList.toggle('hidden', !spec);
  if (spec && !fastForward) {
    $('skipBtn').disabled = false;
    $('specText').textContent = mates ? `Spectating · ${mates} squadmate${mates === 1 ? '' : 's'} fighting` : `Spectating · ${alive.size} squads left`;
  }
  $('dock').classList.toggle('spectating', !standing(u));

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
  const ref = u?.alive ? u : (hasR('myRef') ? Rcall('myRef') : null);
  if (ref) {
    for (const e of state.units) {
      if (standing(e) && e.team !== myTeam() && unitVisible(e) && RU.dist(e.x, e.y, ref.x, ref.y) <= 9) near++;
    }
  }
  let v = 0.12 + prog * 0.42 + stage * 0.16 + Math.min(1, near / 2) * 0.3;
  if (turnCtx) { const left = (turnCtx.deadline - performance.now()) / 1000; if (left < 6) v += 0.08; }
  if (u?.downed) v += 0.1;
  if (state.winner !== null) v = 0.15;
  v = clamp(Math.round(v * 50) / 50, 0, 1);
  if (v !== lastIntensity) { lastIntensity = v; sfx.setIntensity(v); }
  updateAmbience();
}

function setAmbience(stage, rain) {
  const sig = `${stage.toFixed(2)}|${rain.toFixed(2)}`;
  if (sig === lastAmbience) return;
  lastAmbience = sig;
  sfx.setAmbience({ stage, rain });
}
function updateAmbience() {
  if (!state) return;
  const stage = clamp((state.zone.stage || 0) / 6, 0, 1);
  setAmbience(stage, clamp((stage - 0.3) / 0.6, 0, 1));
}

// ---------------------------------------------------------------- juice: damage direction

/** Screen-space angle (0 = up, clockwise) from the player's soldier towards a world tile. */
function screenAngleTo(x, y) {
  const u = me();
  if (!u || !R?.camera || typeof R.wx !== 'function') return null;
  if (THREE) {
    try {
      const a = new THREE.Vector3(R.wx(u.x), 0.6, R.wz(u.y)).project(R.camera);
      const b = new THREE.Vector3(R.wx(x), 0.6, R.wz(y)).project(R.camera);
      const dx = (b.x - a.x) * innerWidth, dy = -(b.y - a.y) * innerHeight;
      if (Math.hypot(dx, dy) < 1) return null;
      return Math.atan2(dx, -dy);
    } catch { /* fall through */ }
  }
  return null;
}

function hitJuice(ev) {
  const st = state;
  const mt = myTeam();
  if (ev.type === 'shot') {
    const t = st.units[ev.to], s = st.units[ev.from];
    if (t.isPlayer) {
      const ang = screenAngleTo(s.x, s.y);
      if (ev.result === 'miss') { if (ang !== null) H.damageDir(ang, 'miss', 0.4); return; }
      if (ang !== null) H.damageDir(ang, 'enemy', (ev.dmg || 1) / 5);
      H.edgeGlow('hurt', 700);
      buzz(ev.result === 'graze' ? 'graze' : 'hit');
    } else if (s.isPlayer && ev.result !== 'miss') buzz('hitDealt');
    else if (t.team === mt && ev.result !== 'miss' && !fastForward) H.edgeGlow('mate', 500);
  } else if (ev.type === 'damage') {
    const t = st.units[ev.id];
    if (t?.isPlayer) {
      const src = lastAoe;
      const ang = src ? screenAngleTo(src.x, src.y) : null;
      if (ang !== null) H.damageDir(ang, 'blast', (ev.dmg || 1) / 4);
      H.edgeGlow('hurt', 700);
      buzz('explosion');
    }
  } else if (ev.type === 'zone_damage') {
    if (st.units[ev.id]?.isPlayer) { H.edgeGlow('tide', 900); buzz('hit'); }
  }
}

// ---------------------------------------------------------------- event bookkeeping

/** Runs before an event animates (so banners land with the action, not after it). */
function preMeta(ev) {
  if (ev.type === 'grenade' || ev.type === 'breach') lastAoe = { id: ev.id, x: ev.x, y: ev.y };
  // render.js plays downed/revive/patch/scan/smoke sounds itself; bleed-out is ours.
  if (ev.type === 'bleed_out' && (state.units[ev.id]?.team === myTeam() || unitVisible(state.units[ev.id]))) sfx.bleedOut();
}

function meta(ev) {
  const st = state;
  if (!st) return;
  const mt = myTeam();
  const ff = fastForward;
  if (!ff) {
    const id = ev.id ?? ev.to;
    if (id !== undefined && st.units[id]?.team === mt && ['shot', 'damage', 'death', 'heal', 'crate', 'zone_damage', 'downed', 'revive', 'patch', 'bleed_out'].includes(ev.type)) queueHud();
    if (ev.type === 'patch' && st.units[ev.target]?.team === mt) queueHud();
    hitJuice(ev);
  }
  switch (ev.type) {
    case 'shot': {
      const s = st.units[ev.from], t = st.units[ev.to];
      lastCause[ev.to] = ev.reaction ? 'overwatch' : ev.ability === 'aimed' ? 'aimed' : 'shoot';
      if (s.isPlayer) { stats.shots++; if (ev.result !== 'miss') { stats.hits++; stats.dmg += ev.dmg || 0; } }
      if (t.isPlayer && ev.dmg) stats.taken += ev.dmg;
      break;
    }
    case 'grenade': case 'breach': lastAoe = { id: ev.id, x: ev.x, y: ev.y }; break;
    case 'damage': {
      lastCause[ev.id] = ev.source === 'breach' ? 'breach' : 'grenade';
      const src = ev.by ?? ev.from ?? lastAoe?.id;
      if (src !== null && src !== undefined && st.units[src]?.isPlayer && st.units[ev.id]?.team !== mt) stats.dmg += ev.dmg || 0;
      if (st.units[ev.id]?.isPlayer) stats.taken += ev.dmg || 0;
      break;
    }
    case 'zone_damage': lastCause[ev.id] = 'tide'; break;
    case 'downed': {
      const u = st.units[ev.id];
      const k = ev.by !== null && ev.by !== undefined ? st.units[ev.by] : null;
      if (k?.isPlayer) stats.downs++;
      if (ff) break;
      H.feedLine({ a: k ? unitName(k) : null, aMine: k?.team === mt, icon: 'downed', b: unitName(u), bMine: u.team === mt, note: k ? 'downed' : 'went down', kind: 'down' });
      if (u.isPlayer) {
        // The 'downed' stinger + sfx come from render.js (_evDowned) with the animation.
        H.banner('YOU\'RE DOWN', 'bad', `Bleed out in ${u.bleed ?? 2} turns · a squadmate can revive you`, 2200);
        buzz('downed');
        H.edgeGlow('hurt', 1600);
      } else if (u.team === mt) {
        H.banner(`${u.name.toUpperCase()} IS DOWN`, 'down', playerUp() ? 'Get next to them and revive' : 'Hold on', 1700);
        buzz('downed');
      } else if (k?.isPlayer) {
        H.toast(`You downed ${u.name}. Finish them before they're revived`, 'kill', 'downed');
        buzz('kill');
      }
      break;
    }
    case 'revive': {
      const u = st.units[ev.id];
      const by = ev.by !== undefined && ev.by !== null ? st.units[ev.by] : null;
      if (by?.isPlayer) stats.revives++;
      if (ff) break;
      if (u.team === mt || unitVisible(u)) H.feedLine({ a: by ? unitName(by) : null, aMine: by?.team === mt, icon: 'revive', b: unitName(u), bMine: u.team === mt, note: 'revived', kind: 'revive' });
      if (u.isPlayer) { H.banner('BACK IN THE FIGHT', 'heal', `${by ? by.name : 'A squadmate'} got you up · ${ev.hp ?? u.hp} HP`, 1700); H.edgeGlow('heal', 1200); buzz('revive'); }
      else if (u.team === mt) { H.toast(`${u.name} is back up${by?.isPlayer ? '. Nice save' : ''} · ${ev.hp ?? u.hp} HP`, 'heal', 'revive'); buzz('revive'); }
      else if (unitVisible(u)) H.toast(`Squad ${u.team + 1} revived ${u.name}`, 'warn', 'revive');
      break;
    }
    case 'bleed_out': {
      lastCause[ev.id] = 'bleed';
      const u = st.units[ev.id];
      if (!ff && u.team === mt && !u.isPlayer) H.toast(`${u.name} bled out`, 'error', 'bleed');
      break;
    }
    case 'patch': {
      const m = st.units[ev.id], t = st.units[ev.target];
      if (m?.isPlayer) stats.patched += ev.amount || 0;
      if (ff || !t) break;
      if (t.team === mt && !t.downed && ev.amount) {
        if (t.isPlayer) H.edgeGlow('heal', 900);
        if (m.isPlayer || t.isPlayer) H.toast(`${t.isPlayer ? 'You' : t.name} +${ev.amount} HP`, 'heal', 'patch');
        else H.feedLine({ a: m.name, aMine: true, icon: 'patch', b: t.id === m.id ? 'self' : t.name, bMine: true, note: `+${ev.amount}`, kind: 'revive' });
      }
      break;
    }
    case 'scan': {
      const s = st.units[ev.id];
      const n = (ev.revealed || []).length;
      if (s?.isPlayer) stats.scans++;
      if (ff) break;
      if (s?.team === mt) {
        H.feedLine({ a: unitName(s), aMine: true, icon: 'scan', note: `${n} contact${n === 1 ? '' : 's'} revealed`, kind: 'scan' });
        if (s.isPlayer) H.toast(n ? `Scan: ${n} contact${n === 1 ? '' : 's'} revealed until your next turn` : 'Scan: area clear', 'loot', 'scan');
      } else if ((ev.revealed || []).some((id) => st.units[id]?.team === mt)) {
        H.toast(`Squad ${s.team + 1} scanned you. They can see you through walls`, 'warn', 'scan');
        H.edgeGlow('scan', 900);
      }
      break;
    }
    case 'reveal_end':
      if (!ff && ev.team === mt) H.feedInfo('Scan faded', 'signal');
      break;
    case 'smoke': {
      const s = st.units[ev.id];
      if (!ff && (s?.team === mt || tileVisible(ev.x, ev.y))) H.feedLine({ a: s ? unitName(s) : null, aMine: s?.team === mt, icon: 'smoke', note: 'smoke screen', kind: 'smoke' });
      queueHud();
      break;
    }
    case 'smoke_clear': queueHud(); break;
    case 'death': {
      const u = st.units[ev.id];
      const k = ev.by !== null && ev.by !== undefined ? st.units[ev.by] : null;
      lastKillerTeam = k ? k.team : null;
      if (k?.isPlayer && k.team !== u.team) stats.kills++;
      if (k && k.team === mt && u.team !== mt) stats.squadKills++;
      if (!ff) {
        const cause = lastCause[ev.id] === 'bleed' ? 'bleed' : k ? (lastCause[ev.id] || 'shoot') : (lastCause[ev.id] || 'tide');
        H.feedKill({
          killer: k ? unitName(k) : null,
          victim: unitName(u),
          cause,
          killerMine: k?.team === mt, victimMine: u.team === mt,
        });
        if (k?.isPlayer && u.team !== mt) { H.toast(`You eliminated ${u.name}`, 'kill', 'skull'); buzz('kill'); }
      }
      if (u.isPlayer) {
        stats.roundOut = st.round;
        stats.killedBy = k && k.team !== mt ? k.name : null;
        stats.bledOut = lastCause[ev.id] === 'bleed';
        const mates = st.teams[mt].members.some((id) => standing(st.units[id]));
        if (!ff && mates) H.banner(stats.bledOut ? 'YOU BLED OUT' : 'YOU\'RE OUT', 'bad', 'Your squad fights on', 1800);
        if (!mates) Rcall('setSpectator', true);
        if (!ff) buzz('downed');
        applySpeed();
      }
      break;
    }
    case 'team_out':
      if (ev.team === mt) {
        playerPlace = ev.place;
        Rcall('setSpectator', true);
        if (!ff) H.banner(MODES[st.mode].teamSize > 1 ? 'SQUAD WIPED' : 'ELIMINATED', 'bad', `Placed #${ev.place} of ${st.teams.length}`, 2200);
        // One defeat stinger per match (showEnd skips its own); none if this wipe still wins.
        if (!ff && st.winner !== mt && stats) { sfx.stinger('defeat'); stats.defeatPlayed = true; }
      } else if (!ff) {
        H.feedInfo(`Squad ${ev.team + 1} eliminated · #${ev.place}`, 'out');
        if (lastKillerTeam === mt && st.winner === null) H.banner('SQUAD ELIMINATED', 'kill', `${G.aliveTeams(st).length} squads left`, 1300);
      }
      break;
    case 'crate': {
      const u = st.units[ev.id];
      if (u.team === mt && !ff) {
        const label = (K.CRATE_LABEL && K.CRATE_LABEL[ev.item]) || ev.item;
        H.toast(`${u.isPlayer ? '' : u.name + ': '}${label}`, 'loot', ev.item === 'frag' ? 'grenade' : ev.item === 'smoke' ? 'smoke' : 'crate');
      }
      break;
    }
    case 'supply_drop':
      if (!ff) {
        H.toast('Supply cache inbound inside the next ring', 'loot', 'drop');
        H.feedInfo('Supply drop spotted', 'signal');
      }
      break;
    case 'overwatch_trigger':
      if (!ff && st.units[ev.target].team === mt) H.toast(`Overwatch fire on ${unitName(st.units[ev.target])}!`, 'warn', 'overwatch');
      break;
    case 'zone_shrink':
      if (!ff) sfx.stinger('tide');
      updateAmbience();
      if (!ff) H.banner('THE TIDE RISES', 'tide', `Safe radius ${ev.r} · next ${ev.next}`, 1800);
      break;
    case 'round_start':
      if (!ff) sfx.stinger('round');
      if (!ff) updateHud();
      break;
    case 'game_over':
      allowSleep();
      break;
    default:
  }
}

// ---------------------------------------------------------------- end screen

function recordCareer(place) {
  if (!stats || stats.recorded || !state) return null;
  stats.recorded = true;
  const u = me();
  return recordMatch({
    mode: state.mode, cls: u.cls, place, total: state.teams.length,
    kills: u.kills, damage: stats.dmg, revives: stats.revives, rounds: stats.roundOut ?? state.round,
  });
}

function showEnd(token) {
  const u = me();
  const mt = myTeam();
  const won = state.winner === mt;
  const place = won ? 1 : (playerPlace ?? state.teams.length);
  const total = state.teams.length;
  const rec = recordCareer(place);
  if (won || !stats.defeatPlayed) sfx.stinger(won ? 'victory' : 'defeat');
  sfx.setIntensity(0.15);
  allowSleep();
  if (won) buzz('win');
  if (!fastForward) H.banner(won ? '#1 LAST SQUAD STANDING' : `#${place} OF ${total}`, won ? 'win' : 'bad', '', 1800);
  const rounds = stats.roundOut ?? state.round;
  const acc = stats.shots ? Math.round((stats.hits / stats.shots) * 100) + '%' : '-';
  $('endKicker').innerHTML = `<span>${esc(callsign())}</span><span>${MODES[state.mode].name}</span><span>${CLASSES[u.cls]?.name || u.cls}</span>`;
  $('endPlace').innerHTML = `<span class="hash">#</span>${place}<small>/${total}</small>`;
  $('endPlace').className = 'end-place' + (won ? ' win' : '');
  const cause = lastCause[u.id];
  $('endTitle').textContent = won ? 'LAST SQUAD STANDING'
    : u.alive ? 'SQUAD WIPED'
    : place <= 3 ? 'SO CLOSE'
    : stats.bledOut ? 'BLED OUT'
    : cause === 'tide' && !stats.killedBy ? 'TAKEN BY THE TIDE' : 'ELIMINATED';
  $('endTitle').className = won ? 'win' : '';
  $('endSub').textContent = won
    ? (u.alive ? 'Everyone else is under the water.' : 'Your squad finished the job without you.')
    : stats.roundOut ? (stats.bledOut ? `You bled out in round ${stats.roundOut}.` : stats.killedBy ? `${stats.killedBy} took you out in round ${stats.roundOut}.` : `The tide took you in round ${stats.roundOut}.`) : 'Your squad was wiped out.';
  const stat = (ic, v, k) => `<div class="es"><span class="es-ic">${ICON[ic]}</span><b>${v}</b><small>${k}</small></div>`;
  const team = MODES[state.mode].teamSize > 1;
  $('endStats').innerHTML = [
    stat('trophy', `#${place}`, 'Placement'),
    stat('skull', u.kills, 'Kills'),
    stat('burst', stats.dmg, 'Damage dealt'),
    stat('clock', rounds, 'Rounds survived'),
    stat('shoot', acc, 'Accuracy'),
    team ? (stats.revives || u.cls === 'medic' ? stat('revive', stats.revives, 'Revives') : stat('squads', stats.squadKills, 'Squad kills')) : stat('heart', stats.taken, 'Damage taken'),
  ].join('');
  const c = career();
  const flags = [];
  if (rec?.firstWin) flags.push(`<span class="ec-flag win">${ICON.trophy}First win</span>`);
  else if (rec?.newBest && c.matches > 1) flags.push(`<span class="ec-flag">${ICON.medal}New personal best</span>`);
  if (c.streak > 1) flags.push(`<span class="ec-flag">${ICON.bolt}${c.streak} win streak</span>`);
  $('endCareer').innerHTML = `${flags.join('')}<span class="ec-line">Career · ${c.wins} win${c.wins === 1 ? '' : 's'} · ${c.kills} kill${c.kills === 1 ? '' : 's'} · ${c.matches} match${c.matches === 1 ? '' : 'es'} · best #${c.best || '–'}</span>`;
  $('specBar').classList.add('hidden');
  clearTimeout(endTimer);
  endTimer = setTimeout(() => {
    if (token !== gameToken || !state) return; // left the match meanwhile
    turnCtx = null;
    document.body.classList.add('ended');
    const es = $('endScreen');
    es.classList.remove('hidden');
    requestAnimationFrame(() => { es.classList.add('open'); $('againBtn').focus({ preventScroll: true }); });
  }, fastForward ? 0 : 1500);
}

// ---------------------------------------------------------------- PWA

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  // Local dev servers and test harnesses skip the worker unless asked (?sw), so
  // stale caches never hide edits.
  const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname);
  if (local && !PARAMS.has('sw')) return;
  if (PARAMS.has('nosw')) return;
  const go = () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).then((reg) => {
      // Warm the cache with everything this first visit loaded (modules, fonts, three.js).
      const urls = performance.getEntriesByType('resource').map((e) => e.name)
        .filter((n) => n.startsWith(location.origin) || n.startsWith('https://unpkg.com/three@'));
      urls.push(location.href.split('#')[0].split('?')[0]);
      const send = (w) => w?.postMessage({ type: 'warm', urls });
      send(reg.active || reg.waiting || reg.installing);
      navigator.serviceWorker.ready.then((r) => send(r.active)).catch(() => {});
    }).catch((e) => warnOnce('sw', e));
  };
  // main.js runs after top-level awaits, usually after 'load' has already fired.
  if (document.readyState === 'complete') setTimeout(go, 500);
  else window.addEventListener('load', go, { once: true });
}
registerSW();

// ---------------------------------------------------------------- boot

document.body.classList.add('in-menu');
ambient.start();
sfx.startMenuMusic(); // queued until the first gesture resumes audio
setAmbience(0.1, 0);
runAttract();

// Test hooks for automated smoke tests: open the page with ?debug.
if (DEBUG) {
  const tapKey = (k) => { const S = state.map.size; onTileTap(k % S, (k / S) | 0); };
  window.__dbg = {
    state: () => state,
    R,
    ui,
    sfx,
    career,
    get myTurn() { return !!turnCtx && !turnCtx.busy; },
    info: () => ({
      mode: ui.mode, myTurn: !!turnCtx, busy: !!turnCtx?.busy, pending: ui.pending && { ...ui.pending, path: undefined },
      target: ui.target, round: state?.round, winner: state?.winner, alive: playerAlive(), downed: !!me()?.downed, fastForward,
      intro: !!introCtx, menu: inMenu(), ended: !$('endScreen').classList.contains('hidden'),
    }),
    enter: () => { menu.enter(); return 'ok'; },
    deploy: () => { startGame(); return 'ok'; },
    skipIntro: () => { introCtx?.skip(); return 'ok'; },
    toMenu: () => { toMenu(); return 'ok'; },
    setMode: (m, id) => { if (!turnCtx) return 'not my turn'; setMode(m, id); return ui.mode; },
    confirm: () => { confirmPending(); return 'ok'; },
    cancel: () => { cancelMode(); return ui.mode; },
    actions: () => (standing(me()) ? actionList(me()).list.map((a) => `${a.key}:${a.state}`) : []),
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
      const u = turnCtx.u;
      const opts = [...ui.reach.entries()].filter(([, n]) => n.d > 0 && n.d <= u.move);
      if (!opts.length) return 'nothing reachable';
      const [k] = opts[opts.length - 1];
      tapKey(k);
      return `preview ${k % state.map.size},${(k / state.map.size) | 0}`;
    },
    tapFirstReachable() {
      if (!turnCtx || turnCtx.busy || !ui.reach) return 'not my turn';
      if (ui.mode !== 'move') setMode('move');
      const u = turnCtx.u;
      const opts = [...ui.reach.entries()].filter(([, n]) => n.d > 0 && n.d <= u.move);
      if (!opts.length) return 'nothing reachable';
      const [k] = opts[opts.length - 1];
      tapKey(k); // preview
      tapKey(k); // confirm
      return `moved to ${k % state.map.size},${(k / state.map.size) | 0}`;
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
    /** Preview an area ability on the tile nearest the closest visible enemy (or a tile ahead). */
    area(kind) {
      if (!turnCtx) return 'not my turn';
      const u = turnCtx.u;
      if (!availability(u)[kind]?.ok) return `${kind} unavailable: ${availability(u)[kind]?.reason || 'not this class'}`;
      const set = setFor(kind, u);
      if (!set?.size) return `no ${kind} targets`;
      setMode(kind);
      if (ui.mode !== kind) return `${kind} unavailable`;
      const S = state.map.size;
      const foe = state.units.filter((e) => standing(e) && e.team !== u.team).sort((a, b) => RU.dist(a.x, a.y, u.x, u.y) - RU.dist(b.x, b.y, u.x, u.y))[0];
      const goal = kind === 'smoke' ? u : foe || { x: S / 2, y: S / 2 };
      let best = null;
      for (const k of set) { const d = RU.dist(k % S, (k / S) | 0, goal.x, goal.y); if (!best || d < best.d) best = { k, d }; }
      tapKey(best.k);
      return `${kind} preview ${best.k % S},${(best.k / S) | 0}`;
    },
    support(kind) {
      if (!turnCtx) return 'not my turn';
      if (!availability(turnCtx.u)[kind]?.ok) return `${kind} unavailable`;
      const set = setFor(kind, turnCtx.u);
      if (!set?.size) return `no ${kind} targets`;
      setMode(kind);
      return ui.mode === kind ? `${kind} on ${ui.pending ? state.units[ui.pending.id].name : '?'}` : `${kind} unavailable`;
    },
    /** Debug only: knock a squadmate down next to the player (to exercise revive UI). */
    downMate() {
      const u = me();
      const m = state?.teams[myTeam()].members.map((id) => state.units[id]).find((x) => !x.isPlayer && standing(x));
      if (!m) return 'no mate';
      const S = state.map.size;
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const x = u.x + dx, y = u.y + dy;
        if (x < 0 || y < 0 || x >= S || y >= S || state.map.cover[y * S + x] || unitAt(x, y)) continue;
        m.x = x; m.y = y; break;
      }
      m.hp = 0; m.downed = true; m.bleed = 2; m.downedBy = null; m.ap = 0;
      Rcall('syncFromState');
      meta({ type: 'downed', id: m.id, by: null });
      safePlay({ type: 'downed', id: m.id, by: null });
      updateHud();
      if (turnCtx) setMode('move');
      return `downed ${m.name}`;
    },
    /** Debug only: knock the player down (team modes), as if shot. */
    downMe() {
      const u = me();
      if (!teamMode() || !standing(u)) return 'n/a';
      u.hp = 0; u.downed = true; u.bleed = 2; u.downedBy = null; u.ap = 0;
      Rcall('syncFromState');
      meta({ type: 'downed', id: u.id, by: null });
      safePlay({ type: 'downed', id: u.id, by: null });
      if (turnCtx) finishTurn(); else updateHud();
      return 'downed';
    },
    /** Debug only: fire the hit juice (direction indicator, edge glow, haptics) from the nearest enemy. */
    juice() {
      const u = me();
      const e = state.units.filter((x) => x.alive && x.team !== u.team).sort((a, b) => RU.dist(a.x, a.y, u.x, u.y) - RU.dist(b.x, b.y, u.x, u.y))[0];
      hitJuice({ type: 'shot', from: e.id, to: u.id, result: 'hit', dmg: 4 });
      return `hit from ${e.name} at ${e.x},${e.y} (me ${u.x},${u.y}) angle ${screenAngleTo(e.x, e.y)}`;
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
