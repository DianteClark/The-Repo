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
import { ICON } from './ui/icons.js';
import { Minimap, nextZone } from './ui/minimap.js';
import { badgeSVG, badgeCached, botTier } from './ui/badges.js';
import * as M from './ui/meta.js';
import { initShop } from './ui/shop.js';
import { squadColor } from './ui/squads.js';
import * as P from './ui/progress.js';
import * as AR from './ui/arsenal.js';
import { initHubPages, medalArt, equipIcon, streakIcon } from './ui/hubpages.js';
import { openTransfer } from './ui/xferui.js';
import { cardSVG, emblemSVG, CARDS, EMBLEMS } from '../shared/cards.js';
import { stageInfo } from './ui/stages.js';
import { Ambient } from './ui/ambient.js';
import { career, recordMatch } from './ui/career.js';
import { buzz } from './ui/haptics.js';
import {
  initMenu, openSheet, closeSheet, closeTopSheet, closeAllSheets, sheetOpen, onSheetClose, setMenuToast, cleanCallsign,
  applyAccessibility, setSwatchSource,
} from './ui/menu.js';
import * as H from './ui/hud.js';
import * as J from './ui/juice.js';

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
const BARREL_RADIUS = K.BARREL?.radius ?? 1.5;
const BARREL_DMG = K.BARREL?.dmg ?? 4;
const SMOKE_AIM = K.SMOKE?.aimIn ?? K.SMOKE?.defense ?? 20;
const KELP_AIM = K.KELP?.aim ?? 10;
const KELP_REVEAL = K.KELP?.reveal ?? 3;

// NET's match controllers (local / host / client). Feature-checked: without them
// the hub still works and Deploy explains what's missing.
let MatchMod = null;
try { MatchMod = await import('./match/index.js'); } catch (e) { console.error('[tidefall] match controller unavailable', e); }

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
      // Any audio hook the AUDIO stream hasn't written (yet) is a silent no-op.
      if (v === undefined && typeof k === 'string' && k !== 'then') return () => undefined;
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
let activeTeams = [];       // squads moving this step (engagement turns)
const tracker = J.createTracker();
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
let lastBlast = null;      // 'grenade' | 'breach' | 'barrel': source of the next damage events
let zoneCenter = null;     // previous safe-zone centre (drift detection)
let myLoadout = null;      // the player's cosmetics for this match
let coverFadeOn = false;
let tierUpT = 0;
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
const AREA_MODES = new Set(['grenade', 'breach', 'smoke', 'scan', 'equip', 'cover', 'streak', 'launch']);
const UNIT_MODES = new Set(['shoot', 'aimed', 'knife', 'suppress']);
const SUPPORT_MODES = new Set(['patch', 'revive']);

let ctl = null;            // the match controller (createMatch)
let pitView = null;        // {myDuelUnitId} while my Pit duel is on screen
const myId = () => (pitView ? pitView.myDuelUnitId : ctl ? ctl.myUnitId : -1);
const me = () => (state && myId() >= 0 ? state.units[myId()] || null : null);
const isMe = (u) => !!u && myId() >= 0 && u.id === myId();
const myTeam = () => (pitView ? (state?.units?.[myId()]?.team ?? -1) : ctl ? ctl.myTeam : -1);
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
const unitName = (u) => (isMe(u) ? 'You' : (ctl?.names?.[u.id] || u.name));
const teamColor = (t) => squadColor(t, myTeam());
const curStage = () => (state ? stageInfo(K, state.stage || (settings.stage !== 'random' ? settings.stage : 'harbor')) : null);
const isNight = () => !!state && (state.night || K.STAGES?.[state.stage]?.night || state.stage === 'spire');
const hasBarrels = () => !!state?.map?.explosive && state.map.explosive.some((v, k) => v && state.map.cover[k] > 0);
function isFlared(u) {
  if (!u || !state) return false;
  if (typeof RU.isFlared === 'function') { try { return !!RU.isFlared(state, u); } catch { /* fall through */ } }
  return Array.isArray(state.flares) && state.flares.some((f) => f === u.id || f?.id === u.id);
}
/** Why a tile hides whoever stands on it: 'smoke' | 'kelp' | null. */
function concealBy(x, y) {
  if (typeof RU.concealment === 'function') { try { return RU.concealment(state, x, y)?.by || null; } catch { /* fall through */ } }
  if (RU.smokeAt && RU.smokeAt(state, x, y)) return 'smoke';
  const S = state.map.size;
  return state.map.terrain?.[y * S + x] === 1 ? 'kelp' : null;
}
const terrainAt = (x, y) => state?.map?.terrain?.[y * state.map.size + x] || 0;
const insideNext = (x, y) => {
  if (typeof G.insideNextZone === 'function') { try { return G.insideNextZone(state, x, y); } catch { /* fall through */ } }
  const n = nextZone(state.zone);
  return RU.dist(x, y, n.x, n.y) <= n.r;
};
const myTier = () => (me() ? M.classProgress(me().cls).tier : 0);
const unitTier = (u) => (isMe(u) ? myTier() : botTier(u));

/** Cover fade: on in Move mode while the move range / path preview shows (Graphics fades props). */
function syncCoverFade(force = false) {
  const reach = ui.reach && [...ui.reach.values()].some((n) => n.d > 0);
  const want = !force && !!settings.coverFade && !attract && !introCtx && !!turnCtx && !turnCtx.busy && ui.mode === 'move' && !!reach && !!state && state.winner === null;
  if (want === coverFadeOn && !force) return;
  coverFadeOn = want;
  Rcall('setCoverFade', want);
}

// ---------------------------------------------------------------- menu + settings

setMenuToast((m, k) => H.toast(m, k));
applyAccessibility();
setSwatchSource((t) => squadColor(t, 0));
const ambient = new Ambient($('menuFx'));
const uiSound = (k) => {
  if (k === 'error') sfx.uiError();
  else if (k === 'tab') { if (typeof rawSfx?.uiSwipe === 'function') sfx.uiSwipe(); else sfx.uiClick(); }
  else if (k === 'deploy') { if (typeof rawSfx?.uiConfirm === 'function') sfx.uiConfirm(); else sfx.uiClick(); }
  else if (k === 'buy') { if (typeof rawSfx?.uiBuy === 'function') sfx.uiBuy(); else sfx.pickup(); buzz('kill'); }
  else sfx.uiClick();
};
const menu = initMenu({
  MODES, K,
  onDeploy: () => startGame(),
  onClick: (k) => { firstGesture(); uiSound(k); },
  onHover: () => sfx.uiHover(),
  onEnter: () => { firstGesture(); sfx.startMenuMusic(); ambient.pulse(); setTimeout(showMetaNotice, 900); if (PARAMS.get('join')) setTimeout(() => openOnline('join', PARAMS.get('join')), 500); },
  qualityNow: () => R?.quality,
  onPage: (page, el, o) => onHubPage(page, el, o),
  onPlayOnline: (kind) => openOnline(kind),
  onTransfer: (mode) => openTransfer(mode, { onClick: uiSound, toast: (m, k, ic) => H.toast(m, k, ic) }),
});
const shop = initShop({
  CLASSES: AR.CLASSES,
  getR: () => R,
  onClick: (k) => uiSound(k),
  onBuy: () => uiSound('buy'),
  onChange: () => { menu.renderWallet(); hub.renderChip(); if (!$('endScreen').classList.contains('hidden')) $('endShopSalv').innerHTML = `${ICON.coin}${M.salvage().toLocaleString('en-US')}`; },
  toast: (m, k, ic) => H.toast(m, k, ic),
});
const hub = initHubPages({
  getR: () => R,
  onClick: (k) => uiSound(k),
  toast: (m, k, ic) => H.toast(m, k, ic),
  onChange: (what) => {
    if (typeof what === 'string' && what.startsWith('goto:')) { menu.setPage(what.slice(5)); return; }
    menu.renderWallet();
  },
});
let lastHubPage = 'play';
function onHubPage(page, el, o = {}) {
  // Menu theme v2 on the hub, the store has its own loop.
  if (page === 'store' && lastHubPage !== 'store') sfx.startStoreMusic();
  else if (page !== 'store' && lastHubPage === 'store') sfx.startMenuMusic();
  lastHubPage = page;
  if (page !== 'store') shop.stopPreview();
  if (page === 'store') shop.show(o.refresh ? undefined : null);
  else hub.render(page);
  if (page === 'play') menu.renderPlay();
}

// ---------------------------------------------------------------- online (NET's lobby mounts into #onlineRoot)

let lobby = null;
async function openOnline(kind, code = null) {
  firstGesture();
  let mod = null;
  try { mod = await import('./online/lobby.js'); } catch (e) { warnOnce('lobby import', e); }
  const mount = mod?.mountLobby || mod?.openLobby || mod?.default;
  if (typeof mount !== 'function') {
    sfx.uiError();
    H.toast('Online play failed to load in this build. Try Solo vs Bots.', 'error', 'globe');
    return;
  }
  const root = $('onlineRoot');
  root.classList.remove('hidden');
  document.body.classList.add('online-open');
  const profile = () => {
    const l = AR.validate(P.activeLoadout());
    return {
      name: callsign(), callsign: callsign(), cls: l.cls, loadout: l, tier: M.classProgress(l.cls).tier, level: P.player().level,
      card: P.equippedCard(), emblem: P.equippedEmblem(), cosmetics: cosmeticsFor(l),
    };
  };
  const close = () => {
    try { lobby?.destroy?.(); } catch { /* ignore */ }
    lobby = null;
    root.classList.add('hidden'); root.innerHTML = '';
    document.body.classList.remove('online-open');
  };
  try {
    if (lobby && typeof lobby.showHost === 'function') {
      if (kind === 'join') lobby.showJoin?.(code); else lobby.showHost();
      return;
    }
    lobby = mount(root, {
      intent: kind === 'join' ? 'join' : 'host', code: code || (mod.joinCodeFromUrl?.() ?? null), profile, sfx,
      get mode() { return settings.mode; }, get stage() { return settings.stage || 'random'; }, // read when hosting
      ui: { badgeSVG, cardSVG, emblemSVG, squadColor },
      onExit: close,
      onStart: ({ kind: k, net, lobby: l }) => {
        root.classList.add('hidden');
        document.body.classList.remove('online-open');
        startGame({ online: { kind: k, net, lobby: l || lobby } });
      },
    });
    if (lobby && typeof lobby.then === 'function') lobby = await lobby;
  } catch (e) {
    warnOnce('lobby mount', e);
    close();
    H.toast('Could not open the online lobby.', 'error', 'globe');
  }
}

/** Cosmetics for the renderer: equipped items + the weapon's camo. */
function cosmeticsFor(l) {
  return { ...M.loadoutFor(l.cls), camo: P.equippedCamo(l.primary?.id) || 'none' };
}

let noticeShown = false;
function showMetaNotice() {
  if (noticeShown) return;
  const n = M.takeNotice();
  if (!n && !P.progress().notice) return;
  noticeShown = true;
  if (n?.kind === 'migrated') H.toast(`Welcome back, veteran: +${n.salvage.toLocaleString('en-US')} Salvage and prestige XP from your career`, 'loot', 'medal');
  else if (n) H.toast(`Welcome bonus: +${n.salvage} Salvage. Spend it in the Store`, 'loot', 'coin');
  const n5 = P.takeNotice();
  if (n5?.kind === 'v5') setTimeout(() => H.toast(`Tidefall 5.0: your career starts you at level ${n5.level}`, 'loot', 'level'), 1200);
  menu.refreshMeta();
}

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
  if (k === 'coverFade') syncCoverFade();
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
$('specPrev').innerHTML = ICON.chevL;
$('specNext').innerHTML = ICON.chevR;

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
document.querySelectorAll('#specBar .spec-speed button').forEach((b) => {
  b.onclick = () => { sfx.uiClick(); setSpecSpeed(Number(b.dataset.speed)); };
});
$('specPrev').onclick = () => { sfx.uiClick(); cycleSpectate(-1); };
$('specNext').onclick = () => { sfx.uiClick(); cycleSpectate(1); };
function renderSpecSpeed() {
  document.querySelectorAll('#specBar .spec-speed button').forEach((b) => {
    const on = Number(b.dataset.speed) === specSpeed;
    b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
  });
}
function setSpecSpeed(n) {
  specSpeed = [1, 2, 4].includes(n) ? n : 2;
  const got = ctl?.setSpeed?.(specSpeed);
  if (Number.isFinite(got)) specSpeed = got;
  renderSpecSpeed();
}
$('againBtn').onclick = () => { sfx.uiClick(); if (onlineCfg) toMenu(); else startGame(); };
$('loadoutBtn').onclick = () => { sfx.uiClick(); toMenu(); };
$('luOk').onclick = () => { sfx.uiClick(); closeLevelUp(); };
$('endShopBtn').querySelector('.mb-ic').innerHTML = ICON.shop;
$('endShopBtn').onclick = () => { sfx.uiClick(); toMenu('store'); };
$('tuOk').onclick = () => { sfx.uiClick(); closeTierUp(); };
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
async function safePlay(ev) {
  if (!R) return;
  try {
    const p = R.playEvent(ev);
    if (p && typeof p.then === 'function') await Promise.race([p, sleep(8000)]);
  } catch (e) { warnOnce('playEvent ' + ev.type, e); }
}
const attractModel = MatchMod?.turnModel ? MatchMod.turnModel(G) : null;
async function runAttract() {
  if (!R || !G.createGame || PARAMS.has('noattract')) return;
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
    for (const ev of s.startEvents || []) { if (token !== gameToken) return; await safePlay(ev); }
    let guard = 0;
    while (s.winner === null && token === gameToken && guard++ < 5000) {
      await whileHidden(token);
      const active = attractModel ? attractModel.active(s) : [G.currentTeamId(s)];
      if (!active.length) break;
      for (const t of active) {
        for (const id of s.teams[t].members) {
          if (token !== gameToken) return;
          const u = s.units[id];
          if (!standing(u) || s.winner !== null) continue;
          let evs = [];
          try { evs = AI.botTakeTurn(s, id) || []; } catch (e) { warnOnce('attract bot', e); }
          for (const ev of evs) {
            if (token !== gameToken) return;
            // The showcase camera owns the view on the title screen: never fight it.
            const a = ev.id ?? ev.from;
            if (!showcase && Number.isInteger(a) && s.units[a]) Rcall('focus', s.units[a].x, s.units[a].y);
            await safePlay(ev);
          }
          await sleep(evs.length ? 260 : 0);
        }
        if (s.winner !== null) break;
        const evs = attractModel ? attractModel.endTeam(s, t) : G.endTeamTurn(s);
        for (const ev of evs || []) { if (token !== gameToken) return; await safePlay(ev); }
      }
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
  turnCtx = null;
  pitView = null;
  introCtx?.cancel?.();
  introCtx = null;
  clearPreviews();
  H.hideContext();
  H.hideBanner();
  H.clearFeed();
  H.clearJuice();
  J.reset();
  ui.mode = 'move'; ui.pending = null; ui.target = null; ui.valid = null; ui.targets = []; ui.reach = null; ui.endArmed = 0;
  delete document.body.dataset.mode;
  document.body.classList.remove('my-turn', 'dead', 'downed', 'ctx-open', 'ended', 'intro', 'in-pit');
  $('endBtn').classList.remove('armed');
  $('dropIn').classList.add('hidden');
  $('dropIn').classList.remove('show', 'go');
  $('pitScreen').classList.add('hidden');
  const es = $('endScreen');
  es.classList.add('hidden');
  es.classList.remove('open');
  $('specBar').classList.add('hidden');
  $('skipBtn').disabled = false;
  $('engageInfo').classList.add('hidden');
  $('netStatus').classList.add('hidden');
  reviveSig = '';
  Rcall('setReviveMarkers', null);
  coverFadeOn = true; syncCoverFade(true); // force the fade off
  closeTierUp(true);
  closeLevelUp(true);
  levelQueue.length = 0;
  $('endPrestige').innerHTML = '';
}

function leaveMatch() {
  const c = ctl;
  ctl = null;
  if (c) { try { c.leave(); } catch (e) { warnOnce('leave', e); } }
}

function toMenu(page = null) {
  if (stats && !stats.recorded && playerPlace) recordCareer(playerPlace); // left after being knocked out
  gameToken++;
  leaveMatch();
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
  if (onlineCfg?.lobby && typeof onlineCfg.lobby.returnToLobby === 'function' && !page) {
    // Online: back to the same lobby (same code, same squad).
    const l = onlineCfg.lobby;
    onlineCfg = null;
    menu.showMenu(false);
    $('onlineRoot').classList.remove('hidden');
    document.body.classList.add('online-open');
    try { l.returnToLobby(); } catch (e) { warnOnce('returnToLobby', e); }
  } else {
    onlineCfg = null;
    menu.showMenu(false);
    if (page) menu.setPage(page);
  }
  sfx.startMenuMusic();
  sfx.setIntensity(0.1);
  setAmbience(0.1, 0);
  menu.renderModes();
  menu.refreshMeta();
  menu.renderStages();
  hub.renderProfile(); hub.renderChip();
  ambient.start();
  runAttract();
}

let onlineCfg = null;      // {kind, net, lobby} while an online match runs
let matchLoadout = null;   // the validated loadout I deployed with

async function startGame({ online = null } = {}) {
  if (!R) { H.toast('The 3D view is unavailable on this device.', 'error'); return; }
  if (!MatchMod?.createMatch) { H.toast('The match engine failed to load. Reload the page.', 'error'); return; }
  if (starting) return;
  starting = true;
  firstGesture();
  sfx.resume();
  keepAwake();
  const token = ++gameToken; // stops the attract loop and any older match
  attract = false;
  leaveMatch();
  closeAllSheets();
  document.activeElement?.blur?.();
  wipe(true);
  await sleep(DEBUG && PARAMS.has('fast') ? 0 : 380);
  if (token !== gameToken) { starting = false; return; }

  resetMatchUi();
  fastForward = false;
  playerPlace = null;
  specSpeed = 2;
  renderSpecSpeed();
  lastCause = {};
  lastAoe = null;
  lastIntensity = -1;
  lastAmbience = '';
  lastKillerTeam = null;
  lastBlast = null;
  onlineCfg = online;
  tracker.reset();
  activeTeams = [];
  lastStep = null;
  const lo = AR.validate(P.activeLoadout());
  matchLoadout = lo;
  settings.cls = lo.cls;
  myLoadout = cosmeticsFor(lo);
  const kind = online?.kind || 'local';
  const opts = kind === 'local' ? {
    mode: settings.mode, stage: settings.stage || 'random', cls: lo.cls, callsign: callsign(), loadout: lo,
    loneWolf: settings.mode === 'trios' && !!settings.loneWolf, cosmetics: myLoadout,
    noTimer: NO_TIMER, follow: settings.follow, botSpeed: settings.botSpeed,
  } : { noTimer: NO_TIMER, follow: settings.follow, botSpeed: settings.botSpeed };
  try {
    ctl = MatchMod.createMatch(kind, { R, sfx: worldSfx, ui: matchHooks(token), opts, net: online?.net || null });
  } catch (e) {
    console.error(e);
    starting = false;
    wipe(false);
    H.toast(`Couldn't start the match: ${e?.message || e}`, 'error');
    return;
  }
  state = ctl.view || ctl.state;
  stats = { dmg: 0, shots: 0, hits: 0, kills: 0, squadKills: 0, roundOut: null, taken: 0, revives: 0, patched: 0, scans: 0, downs: 0, barrels: 0, recorded: false, award: null, streaks: 0, lethalKills: 0 };
  zoneCenter = state ? { x: state.zone.x, y: state.zone.y } : null;
  Rcall('setMenuShowcase', false);
  applyVisualSettings();
  ambient.stop();
  $('menu').classList.add('hidden');
  $('splash').classList.add('hidden');
  $('onlineRoot').classList.add('hidden');
  document.body.classList.remove('online-open');
  $('hud').classList.remove('hidden');
  document.body.classList.remove('in-menu');
  document.body.classList.add('in-game', 'intro');
  sfx.startMusic();
  setAmbience(0, 0);
  starting = false;
  ctl.start();
  if (token !== gameToken) return;
  state = ctl.view || ctl.state || state;
  focusMe();
  updateHud();
  wipe(false);
}

/** The UI side of the match controller contract (src/client/match/index.js). */
function matchHooks(token) {
  const live = () => token === gameToken && !!ctl;
  const sync = () => { const s = ctl?.view || ctl?.state; if (s) state = s; };
  const guard = (fn) => (...a) => { if (!live()) return undefined; sync(); try { return fn(...a); } catch (e) { warnOnce('hook', e); return undefined; } };
  return {
    onIntro: async () => {
      if (!live()) return;
      sync();
      if (!state) return;
      zoneCenter = { x: state.zone.x, y: state.zone.y };
      focusMe();
      updateHud();
      await dropIn(token);
      if (!live()) return;
      document.body.classList.remove('intro');
      const u = me();
      if (u?.isLoneWolf) later(() => H.toast('You are the Lone Wolf: +1 AP, +50% HP, +1 armor.', 'info', 'wolf'), 600);
      if (!settings.seenHowTo) {
        settings.seenHowTo = true;
        later(() => H.toast('Tap a tile to preview a move, tap again to go.', 'info', 'tap'), 1400);
      }
    },
    onEventStart: guard((ev) => { preMeta(ev); }),
    onEvent: guard((ev, info = {}) => { fastForward = !!info.ff; meta(ev); }),
    onTurnStart: guard((t) => openTurn(t)),
    onTick: guard((t) => {
      if (turnCtx && t.unitId === turnCtx.u.id) { turnCtx.deadline = t.deadline; turnCtx.total = t.total; }
      updateTimer(t.left);
    }),
    onTurnEnd: guard(() => finishTurn()),
    onStep: guard((st) => onStep(st)),
    onPit: guard((pt) => onPit(pt)),
    onMatchEnd: guard((sum) => onMatchEnd(sum, token)),
    onStatus: guard((msg, level) => H.toast(String(msg), level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'ok' ? 'loot' : 'info', level === 'warn' ? 'warn' : 'link')),
    onConnection: guard((connected) => {
      const el = $('netStatus');
      el.classList.toggle('hidden', !!connected);
      el.innerHTML = connected ? '' : `${ICON.wifi}<b>Reconnecting…</b><small>Your unit holds overwatch for up to 60 s</small>`;
    }),
    onState: guard(() => { queueHud(); }),
  };
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
  const st = curStage();
  $('diKicker').innerHTML = `<span>${esc(mode.name)}</span><span>${nTeams} squads</span><span>Round 1</span>`;
  $('diStage').innerHTML = st ? `<span class="ds-ic">${ICON[st.icon] || ICON.stage}</span><b>${esc(st.name)}</b><small>${esc(st.short || st.tagline || '')}</small>` : '';
  $('diSquad').innerHTML = squad.map((m, i) => {
    const c = CLASSES[m.cls];
    const tier = isMe(m) ? M.classProgress(m.cls).tier : botTier(m);
    return `<div class="di-card-u${isMe(m) ? ' you' : ''}" style="--i:${i}">
      <div class="di-sil">${badgeSVG(m.cls, tier, { size: 48, title: false })}</div>
      <div class="di-meta"><b>${esc(isMe(m) ? callsign() : m.name)}</b><small>${esc(c?.name || m.cls)} · ${M.TIER_NAMES[tier]}${m.isLoneWolf ? ' · Lone Wolf' : ''}</small>
      <span class="di-hp"><i style="--w:${Math.round((m.maxHp / 15) * 100)}%"></i><em>${m.maxHp} HP</em></span></div>
      ${isMe(m) ? '<span class="di-you">You</span>' : ''}</div>`;
  }).join('') + (squad.length === 1 ? `<div class="di-vs"><b>${TOTAL_RIVALS()}</b><small>rivals</small></div>` : '');
  $('diTip').textContent = (st && STAGE_TIP[st.key]) || CLASS_TIP[u.cls] || 'Stay inside the ring. The tide is coming.';
  clearTimeout(introHideT);
  const cine = hasR('playDropIn');
  el.classList.remove('hidden', 'go', 'show');
  el.classList.toggle('cine', cine);
  // Without a renderer drop-in, a zoom-in "drop" while the countdown runs.
  if (!cine && typeof R?.view === 'number' && typeof R?.viewGoal === 'number') { const g = R.viewGoal; R.view = g * 1.9; R.viewGoal = g; }
  return new Promise((resolve) => {
    let done = false;
    let counted = false;
    let landed = !cine;
    const timers = [];
    const finish = (skipped = false) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      el.removeEventListener('pointerdown', skip);
      if (!landed) Rcall('skipDropIn'); // skipped, cancelled or too slow: snap everyone into place
      el.classList.add('go');
      clearTimeout(introHideT);
      introHideT = setTimeout(() => { el.classList.add('hidden'); el.classList.remove('show', 'go', 'cine'); }, 420);
      introCtx = null;
      resolve(skipped);
    };
    const maybeDone = () => { if (counted && landed) finish(); };
    const skip = () => { sfx.uiClick(); finish(true); };
    introCtx = { cancel: () => finish(true), skip };
    el.addEventListener('pointerdown', skip);
    const num = $('diNum');
    num.textContent = '';
    const fast = DEBUG && PARAMS.has('fast');
    const step = fast ? 60 : 750;
    const seq = ['3', '2', '1', 'GO'];
    // Chain each beat off the previous one, starting once the overlay has actually
    // painted: a long frame (world build, shader compile) delays the count instead
    // of collapsing it.
    const beat = (i) => {
      if (done) return;
      if (token !== gameToken) { finish(true); return; }
      if (i >= seq.length) { counted = true; maybeDone(); return; }
      const n = seq[i];
      num.textContent = n;
      num.classList.remove('pop'); void num.offsetWidth; num.classList.add('pop');
      num.classList.toggle('go', n === 'GO');
      if (n === 'GO') { sfx.turn(); buzz('tap'); } else sfx.tick(false);
      timers.push(setTimeout(() => beat(i + 1), i === seq.length - 1 ? step * 0.6 : step));
    };
    requestAnimationFrame(() => {
      el.classList.add('show');
      if (cine) {
        // Every unit arrives with its drop-in; the countdown runs alongside.
        let p;
        try { p = R.playDropIn(); } catch (e) { warnOnce('playDropIn', e); }
        if (fast) Rcall('skipDropIn');
        Promise.race([Promise.resolve(p), sleep(fast ? 50 : 5000)]).catch(() => {}).then(() => { landed = true; maybeDone(); });
      }
      requestAnimationFrame(() => requestAnimationFrame(() => timers.push(setTimeout(() => beat(0), 450))));
    });
  });
}
const STAGE_TIP = {
  kelp: 'Kelp hides you beyond 3 tiles. Weed-hop to close the distance.',
  rig: 'Red-banded barrels explode and chain. Shoot one next to a squad.',
  spire: 'Night: firing lights a flare over you. Shoot, then move next turn.',
  surge: 'The safe zone drifts. Watch the cyan ring and rotate early.',
};
const TOTAL_RIVALS = () => (K.TOTAL_PLAYERS || 16) - 1;

function applySpeed() {
  // The controller owns R.speed and its own delays; tell it about bot speed changes.
  if (ctl) { try { ctl.botSpeed = settings.botSpeed; } catch { /* older controller */ } }
}

/** Turn hand-off juice: a swipe across the turn label when a new squad takes over. */
let lastStep = null; // the main match's step, re-shown when a Pit duel ends
function renderStepInfo(quiet = false) {
  if (!lastStep) return;
  const mt = ctl ? ctl.myTeam : myTeam();
  J.renderStep({
    ...lastStep, myTeam: mt, sfx: quiet ? null : sfx,
    nameOf: (t) => (t === mt ? 'Your squad' : squadName(t)),
    colorOf: (t) => teamColor(t),
    banner: (a, b, c, d) => { if (!fastForward && !quiet) H.banner(a, b, c, d); },
  });
}
function onStep({ active = [], engagements = [] } = {}) {
  activeTeams = [...active];
  lastStep = { active: [...active], engagements };
  if (pitView) { queueHud(); return; } // the main match's squads aren't what the duel HUD shows
  const mt = myTeam();
  renderStepInfo();
  if (active.includes(mt) && !playerUp() && !fastForward) H.feedInfo('Your squad is moving', 'signal');
  document.body.dataset.turn = active.includes(mt) ? 'mine' : 'enemy';
  handoff();
  queueHud();
}
/** A squad's display name: online players' callsigns where we know them. */
function squadName(t) {
  const names = ctl?.names || {};
  const h = state?.teams[t]?.members.map((id) => names[id]).find(Boolean);
  return h ? `${h}'s squad` : `Squad ${t + 1}`;
}

function onPit(p = {}) {
  const meU = ctl?.state?.units?.[ctl.myUnitId];
  if (p.phase === 'start' && p.mine) {
    pitView = { myDuelUnitId: p.myDuelUnitId };
    state = ctl.view || p.duelState || state;
    document.body.classList.add('in-pit');
    $('engageInfo')?.classList.add('hidden');
    const foe = state.units.find((u) => u.id !== p.myDuelUnitId && u.alive);
    J.showPit({ phase: 'start', mine: true, meName: callsign(), foeName: foe ? (ctl?.names?.[foe.srcId ?? foe.id] || foe.name) : null, round: ctl?.state?.round });
    sfx.pitTheme(true);
    H.banner('THE PIT', 'engage', 'Win the duel to redeploy', 1600);
  } else if (p.phase === 'end' && p.mine) {
    const won = typeof p.won === 'boolean' ? p.won : Number.isInteger(p.winner) && state?.units?.[pitView?.myDuelUnitId]?.team === p.winner;
    pitView = null;
    state = ctl.view || ctl.state;
    document.body.classList.remove('in-pit');
    renderStepInfo(true);
    sfx.pitTheme(false);
    J.showPit({ phase: 'end', mine: true, meName: callsign(), won });
    if (won) buzz('win');
  }
  updateHud();
  void meU;
}

function handoff() {
  const el = $('turnInfo');
  el.classList.remove('handoff');
  void el.offsetWidth;
  el.classList.add('handoff');
}

let specIdx = -1;
/** Spectator: cycle the camera between standing soldiers (squadmates first). */
function cycleSpectate(dir) {
  if (!state) return;
  const mt = myTeam();
  const list = state.units.filter((u) => standing(u) && (u.team === mt || unitVisible(u)))
    .sort((a, b) => (b.team === mt) - (a.team === mt) || a.team - b.team || a.id - b.id);
  if (!list.length) return;
  const cur = list.findIndex((u) => u.id === specIdx);
  const n = list[((cur < 0 ? (dir > 0 ? -1 : 0) : cur) + dir + list.length) % list.length];
  specIdx = n.id;
  Rcall('setFollow', n.id);
  Rcall('focus', n.x, n.y);
  renderSpecWho();
}
function renderSpecWho() {
  const u = state?.units[specIdx];
  const el = $('specWho');
  if (!el) return;
  if (!u || !u.alive) { el.innerHTML = '<small>Free camera</small><b>Tap ‹ › to follow a soldier</b>'; return; }
  el.innerHTML = `<span class="sw-b" style="--sq:${teamColor(u.team)}">${badgeCached(u.cls, unitTier(u), { size: 30 })}</span><span class="sw-t"><b style="color:${teamColor(u.team)}">${esc(unitName(u))}</b><small>${u.team === myTeam() ? 'Your squad' : `Squad ${u.team + 1}`} · ${esc(CLASSES[u.cls]?.name || u.cls)} · ${u.hp}/${u.maxHp} HP</small></span>`;
}

function skipToResults() {
  if (!state || state.winner !== null || !ctl) return;
  if (ctl.fastForward?.() === false) { H.toast('Online matches play out at everyone\'s pace', 'info', 'clock'); return; }
  fastForward = true;
  $('skipBtn').disabled = true;
  $('specText').textContent = 'Simulating the rest of the match…';
}

// ---------------------------------------------------------------- human turn

function openTurn(t) {
  const u = state?.units[t.unitId];
  if (!u) return;
  tracker.turnStart();
  turnCtx = { u, deadline: t.deadline, total: (t.total || TURN_SECONDS * 1000) / 1000, busy: false, paused: 0, pit: t.pit || null };
  Rcall('setFollow', null);
  sfx.turn();
  buzz('turn');
  H.edgeGlow('you', 1100);
  H.banner(t.pit ? 'DUEL: YOUR TURN' : 'YOUR TURN', 'you', `${u.ap} AP · ${Math.round(turnCtx.total)} seconds${J.engagedWith() ? ` · ${J.engagedWith()}` : ''}`, 1100);
  setMode('move');
  updateHud();
  if (document.hidden) openPause();
}

function updateTimer(left) {
  const c = turnCtx;
  H.renderTimer({ left: left ?? (c ? Math.max(0, (c.deadline - performance.now()) / 1000) : 0), total: TURN_SECONDS, active: !!c, style: settings.timer, over: !!state && state.winner !== null });
}

function openPause() {
  if (!state) return;
  const solo = ctl?.kind !== 'host' && !onlineCfg;
  const paused = turnCtx && solo && ctl?.pause?.();
  $('pauseNote').textContent = turnCtx ? (paused ? 'Your turn timer is paused.' : 'Online matches keep running: your timer is still counting.') : 'The match continues in the background.';
  const st = curStage();
  $('pauseStage').innerHTML = st ? `<span class="sd-ic">${ICON[st.icon] || ICON.stage}</span><div><b>${esc(st.name)}</b><p>${esc(st.twist)}</p></div>` : '';
  if (turnCtx && paused) turnCtx.paused = performance.now();
  openSheet('pauseSheet');
}
function resumeTimer() { if (turnCtx) turnCtx.paused = 0; ctl?.resume?.(); }

function finishTurn() {
  if (turnCtx) tracker.turnEnd();
  turnCtx = null;
  clearPreviews();
  ui.mode = 'move';
  ui.pending = null;
  ui.valid = null;
  ui.targets = [];
  ui.target = null;
  ui.streak = null;
  delete document.body.dataset.mode;
  clearTimeout(armTimer);
  $('endBtn').classList.remove('armed');
  H.hideContext();
  $('targetHint').classList.add('hidden');
  syncCoverFade();
  updateHud();
}

async function doAction(a) {
  const c = turnCtx;
  if (!c || c.busy || !ctl) return false;
  c.busy = true;
  tracker.actionStart();
  clearPreviews();
  syncCoverFade();
  H.hideContext();
  $('targetHint').classList.add('hidden');
  ui.pending = null;
  updateHud();
  let r;
  try { r = await ctl.act(a); } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
  if (!r || !r.ok) {
    sfx.uiError();
    buzz('error');
    H.toast(r?.error || 'Not possible', 'error');
    c.busy = false;
    if (turnCtx === c) setMode('move');
    updateHud();
    return false;
  }
  c.busy = false;
  if (turnCtx === c) {
    const u = me();
    if (!standing(u) || u.ap <= 0 || state.winner !== null) finishTurn();
    else { setMode('move'); updateHud(); }
  }
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

/** Explosive barrels the unit can shoot: [{id:'b<key>', barrel:true, k, x, y, pv}]. */
function barrelTargetList(u, withPreview = true) {
  if (!hasBarrels()) return [];
  const S = state.map.size;
  let keys = keySet('barrelTargets', u);
  if (!keys) {
    keys = new Set();
    const range = RU.weaponRange ? RU.weaponRange(u) : u.weapon.range;
    state.map.explosive.forEach((v, k) => {
      if (!v || !state.map.cover[k]) return;
      const x = k % S, y = (k / S) | 0;
      if (RU.dist(u.x, u.y, x, y) <= range && RU.los(state.map, u.x, u.y, x, y)) keys.add(k);
    });
  }
  const out = [];
  for (const k of keys) {
    const x = k % S, y = (k / S) | 0;
    if (!tileVisible(x, y)) continue;
    out.push({ id: 'b' + k, barrel: true, k, x, y, pv: withPreview ? barrelPreviewAt(u, x, y) : null });
  }
  if (!withPreview) return out;
  // Best blasts first: visible enemies hit, minus friendly fire.
  const score = (t) => t.pv.units.reduce((a, h) => a + (state.units[h.id].team === u.team ? -2 : unitVisible(state.units[h.id]) ? 1 + (h.lethal ? 1 : 0) : 0), 0);
  out.sort((a, b) => score(b) - score(a) || RU.dist(u.x, u.y, a.x, a.y) - RU.dist(u.x, u.y, b.x, b.y));
  return out;
}
/** Enemy-crewed or empty boats in range and sight (5.0): shoot the hull. */
function boatTargetList(u) {
  if (!state.vehicles?.length || typeof G.vehicleShotPreview !== 'function' || isLauncher(u)) return [];
  const S = state.map.size;
  const out = [];
  for (const v of state.vehicles) {
    let pv = null;
    try { pv = G.vehicleShotPreview(state, u, v); } catch { pv = null; }
    if (pv) out.push({ id: 'v' + v.id, vehicle: true, vehicleId: v.id, k: v.y * S + v.x, x: v.x, y: v.y, hp: v.hp, pv });
  }
  return out;
}
function barrelPreviewAt(u, x, y) {
  if (typeof G.barrelPreview === 'function') {
    try { const p = G.barrelPreview(state, u, x, y); if (p) return { units: p.units || [], barrels: p.barrels || [], cover: p.cover || [], radius: p.radius ?? BARREL_RADIUS, valid: p.valid !== false }; } catch (e) { warnOnce('barrelPreview', e); }
  }
  // Local estimate with chains.
  const S = state.map.size;
  const done = new Set([y * S + x]);
  const queue = [[x, y]];
  const hits = new Map();
  while (queue.length) {
    const [bx, by] = queue.shift();
    for (const e of state.units) {
      if (!e.alive || RU.dist(e.x, e.y, bx, by) > BARREL_RADIUS) continue;
      hits.set(e.id, (hits.get(e.id) || 0) + Math.max(1, BARREL_DMG - e.armor));
    }
    state.map.explosive.forEach((v, k) => {
      if (!v || done.has(k) || !state.map.cover[k]) return;
      const cx = k % S, cy = (k / S) | 0;
      if (RU.dist(cx, cy, bx, by) <= BARREL_RADIUS) { done.add(k); queue.push([cx, cy]); }
    });
  }
  const units = [...hits].map(([id, dmg]) => ({ id, dmg, lethal: state.units[id].downed || dmg >= state.units[id].hp }));
  return { units, barrels: [...done].slice(1).map((k) => ({ x: k % S, y: (k / S) | 0 })), cover: [], radius: BARREL_RADIUS, valid: true };
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
  if (mode === 'equip') return ui.equip ? equipSet(u, ui.equip.e) : null;
  if (mode === 'cover') return coverSet(u);
  if (mode === 'launch') { try { return G.launchTargets?.(state, u) || null; } catch { return null; } }
  if (mode === 'streak') return ui.streak ? streakSet(u, ui.streak.key) : null;
  return { grenade: grenadeSet, breach: breachSet, smoke: smokeSet, scan: scanSet, patch: patchSet, revive: reviveSet }[mode]?.(u) ?? null;
}

const CD_LABEL = (n) => `Cooldown: ${n} round${n === 1 ? '' : 's'}`;
const downedMates = () => (state ? state.teams[myTeam()].members.map((id) => state.units[id]).filter((m) => m.alive && m.downed) : []);

// ---- 5.0 kit helpers (ammo, weapons, equipment, streaks): all feature-checked against the sim

const isLauncher = (u) => !!(u?.weapon?.special?.includes?.('explosive'));
const infiniteAmmo = (u) => !!(u?.weapon?.special?.includes?.('infinite') || u?.weapon?.infinite || u?.weapon?.mag === Infinity);
const wInfo = (u) => { if (typeof G.weaponInfo === 'function' && u?.weapon) { try { return G.weaponInfo(u); } catch { /* fall through */ } } return null; };
const hasAmmoModel = (u) => Number.isFinite(u?.ammo) || Number.isFinite(u?.weapon?.ammo);
const ammoOf = (u) => (Number.isFinite(u?.ammo) ? u.ammo : u?.weapon?.ammo ?? null);
const magOf = (u) => u?.weapon?.mag ?? null;
const spareOf = (u) => u?.weapon?.spare ?? u?.spare ?? null;
const otherWeapon = (u) => (Array.isArray(u?.weapons) && u.weapons.length > 1 ? u.weapons[(u.slot ?? 0) === 0 ? 1 : 0] : null);
const equipOf = (u, slot) => (u?.[slot] ? AR.equipById(u[slot]) : null);
const chargesOf = (u, key) => (key ? u?.items?.[key] ?? 0 : 0);
/** Streak bar for my unit: the sim's streakInfo when present, else derived from kills. */
function streakBar(u) {
  if (!u) return [];
  if (typeof G.streakInfo === 'function') { try { return G.streakInfo(state, u) || []; } catch (e) { warnOnce('streakInfo', e); } }
  const keys = Array.isArray(u.streaks) ? u.streaks : matchLoadout?.streaks || [];
  const hard = (u.perks || []).includes('hardline') ? 1 : 0;
  return keys.map((k) => {
    const d = AR.streakByKey(k) || { name: k, cost: 5, target: 'none' };
    const cost = Math.max(1, d.cost - hard);
    const used = !!u.streakUsed?.[k];
    const earned = (u.kills || 0) >= cost;
    return { key: k, name: d.name, desc: d.desc, cost, kills: u.kills || 0, used, earned, ready: earned && !used && !!turnCtx, target: d.target === 'none' ? null : d.target, reason: used ? 'Used' : !earned ? `${cost - (u.kills || 0)} more kill${cost - (u.kills || 0) === 1 ? '' : 's'}` : null };
  });
}
const STREAK_PREVIEW_KIND = { airstrike: 'frag', care: 'scan', care_package: 'scan', sentry: 'scan' };

/** Tiles a piece of equipment can target: the sim's helper, else a local estimate. */
function equipSet(u, e) {
  if (typeof G.equipmentTargets === 'function') { try { const r = G.equipmentTargets(state, u, e.id); if (r instanceof Set) return r; } catch (err) { warnOnce('equipmentTargets', err); } }
  const fn = G[`${e.action}Targets`] || (e.action === 'grenade' ? G.grenadeTargets : null);
  if (typeof fn === 'function') {
    try { const r = fn(state, u); if (r instanceof Set) return r; if (Array.isArray(r)) return new Set(r.map((v) => (typeof v === 'object' ? keyOf(v.x, v.y) : v))); } catch (err) { warnOnce(e.action + 'Targets', err); }
  }
  if (typeof G.equipTargets === 'function') { try { const r = G.equipTargets(state, u, e.id); if (r?.size !== undefined) return r; } catch { /* fall through */ } }
  const S = state.map.size;
  const out = new Set();
  const range = e.range ?? (e.id === 'claymore' ? 1.5 : 7);
  for (let y = Math.max(0, u.y - Math.ceil(range)); y <= Math.min(S - 1, u.y + Math.ceil(range)); y++) {
    for (let x = Math.max(0, u.x - Math.ceil(range)); x <= Math.min(S - 1, u.x + Math.ceil(range)); x++) {
      if (RU.dist(u.x, u.y, x, y) > range || (x === u.x && y === u.y && e.id === 'claymore')) continue;
      if (e.id === 'claymore' && (state.map.cover[y * S + x] || unitAt(x, y))) continue;
      if (e.id !== 'claymore' && !RU.los(state.map, u.x, u.y, x, y)) continue;
      out.add(y * S + x);
    }
  }
  return out;
}
/** Adjacent open tiles for the Engineer's Deploy Cover. */
function coverSet(u) {
  if (typeof G.deployCoverTargets === 'function') { try { return G.deployCoverTargets(state, u); } catch { /* fall through */ } }
  for (const n of ['deployCoverTargets', 'coverTargets']) {
    if (typeof G[n] === 'function') { try { const r = G[n](state, u); if (r instanceof Set) return r; if (Array.isArray(r)) return new Set(r.map((v) => (typeof v === 'object' ? keyOf(v.x, v.y) : v))); } catch { /* fall through */ } }
  }
  const S = state.map.size; const out = new Set();
  for (const [dx, dy] of RU.DIRS8 || [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const x = u.x + dx, y = u.y + dy;
    if (x < 0 || y < 0 || x >= S || y >= S || state.map.cover[y * S + x] || unitAt(x, y)) continue;
    out.add(y * S + x);
  }
  return out;
}
function streakSet(u, key) {
  if (typeof G.streakTargets === 'function') { try { const r = G.streakTargets(state, u, key); if (r) return r instanceof Set ? r : new Set(r); } catch (e) { warnOnce('streakTargets', e); } }
  const d = AR.streakByKey(key);
  const S = state.map.size; const out = new Set(); const R2 = d?.range ?? 6;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (RU.dist(u.x, u.y, x, y) <= R2) out.add(y * S + x);
  return out;
}

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
  const empty = hasAmmoModel(u) && !infiniteAmmo(u) && (ammoOf(u) ?? 1) < 1;
  const launch = isLauncher(u);
  const shots = !base && !empty ? (launch ? [...(setFor('launch', u) || [])] : validTargets(u)) : [];
  const barrels = !base && !empty ? barrelTargetList(u, false).length + boatTargetList(u).length : 0;
  set('shoot', base || (empty ? 'Magazine empty: reload' : shots.length || barrels ? null : hasBarrels() ? 'No enemy or barrel in range and sight' : 'No enemy in range and sight'), { count: shots.length, barrels, empty });

  // reload / swap (5.0)
  if (hasAmmoModel(u)) {
    const full = infiniteAmmo(u) || (ammoOf(u) ?? 0) >= (magOf(u) ?? 0);
    const free = !!u.weapon?.freeReload;
    set('reload', !my ? 'Wait for your turn' : busy ? 'Action in progress' : full ? 'Magazine full' : (spareOf(u) !== null && spareOf(u) <= 0) ? 'No spare ammo' : (!free && u.ap < 1) ? 'No AP left' : null, { free });
  }
  if (otherWeapon(u)) set('swap', !my ? 'Wait for your turn' : busy ? 'Action in progress' : u.swapped || u.swappedThisTurn ? 'One swap per turn' : null);

  // lethal / tactical (5.0 loadouts) or the 3.0 frag / smoke
  const lethal = equipOf(u, 'lethal'), tactical = equipOf(u, 'tactical');
  if (lethal || tactical) {
    for (const [slot, e] of [['lethal', lethal], ['tactical', tactical]]) {
      if (!e) continue;
      const n = chargesOf(u, e.id);
      let r = e.id === 'stim' ? (!my ? 'Wait for your turn' : busy ? 'Action in progress' : null) : base;
      if (!r && n < 1) r = `No ${e.name.toLowerCase()} left`;
      if (!r && e.id !== 'stim' && e.action !== 'knife' && !equipSet(u, e).size) r = 'No tile in range';
      if (!r && e.action === 'knife' && !knifeTargets(u, e).length) r = 'No enemy within 4 tiles';
      set(slot, r, { charges: n, e });
    }
  } else {
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
  }

  if (u.cls === 'marksman') {
    const a = ab.aimed;
    const cd = a?.cooldown ?? u.cooldowns?.aimed ?? 0;
    let r = base;
    if (!r) {
      if (typeof G.aimedPreview !== 'function' && !a) r = 'Aimed Shot arrives with the next sim update';
      else if (empty) r = 'Magazine empty: reload';
      else if (cd > 0) r = CD_LABEL(cd);
      else if (!validTargets(u, 'aimed').length) r = 'No enemy in range and sight';
      else if (a && !a.ready) r = a.reason || 'Not ready';
    }
    set('aimed', r, { cooldown: cd });
  }
  if (u.cls === 'breacher') cdAbility('breach', typeof G.breachTargets !== 'function', 'Stand next to cover to breach it', breachSet);
  if (u.cls === 'medic') cdAbility('patch', typeof G.patchTargets !== 'function', 'Nobody hurt next to you', patchSet);
  if (u.cls === 'recon') cdAbility('scan', false, null, null);
  if (u.cls === 'engineer') { const k = ab.deploy_cover ? 'deploy_cover' : ab.cover ? 'cover' : 'deploy_cover'; cdAbility(k, false, 'No open tile next to you', coverSet); out.cover = out[k]; }
  if (u.cls === 'gunner') {
    const a = ab.suppress;
    const cd = a?.cooldown ?? u.cooldowns?.suppress ?? 0;
    let r = base;
    if (!r) {
      if (cd > 0) r = CD_LABEL(cd);
      else if (hasAmmoModel(u) && !infiniteAmmo(u) && (ammoOf(u) ?? 0) < 3) r = 'Needs 3 rounds: reload';
      else if (!validTargets(u).length) r = 'No enemy in sight';
      else if (a && !a.ready) r = a.reason || 'Not ready';
    }
    set('suppress', r, { cooldown: cd });
  }

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
  // Engineer next to a damaged boat (5.0): repair +4 hull, +1 fuel.
  if (u.cls === 'engineer' && state.vehicles?.length && typeof G.repairTargets === 'function') {
    let ids = [];
    try { ids = [...(G.repairTargets(state, u) || [])]; } catch { ids = []; }
    if (ids.length) set('repair', base, { ids });
  }
  const hk = ab.hunker;
  set('hunker', base || (hk && !hk.ready ? hk.reason || 'Not ready' : null));
  set('overwatch', base || (empty ? 'Magazine empty: reload' : null));
  set('medkit', base || ((u.items?.medkit ?? 0) < 1 ? 'No medkits' : u.hp >= u.maxHp ? 'Already at full health' : null), { count: u.items?.medkit ?? 0 });
  set('end', !my ? 'Wait for your turn' : busy ? 'Action in progress' : null);
  return out;
}

function knifeTargets(u, e) {
  if (typeof G.equipmentTargets === 'function' && typeof G.equipmentPreview === 'function') {
    try {
      const set = G.equipmentTargets(state, u, e?.id || 'knife');
      const out = [];
      for (const k of set) {
        const t = unitAtKey(k);
        if (!t || t.team === u.team || !unitVisible(t)) continue;
        const pv = G.equipmentPreview(state, u, e?.id || 'knife', t.x, t.y) || {};
        const hit = pv.units?.find((h) => h.id === t.id) || {};
        const chance = pv.chance ?? hit.chance ?? pv.hc?.chance ?? 75;
        out.push({ id: t.id, p: { chance, graze: pv.graze ?? hit.graze ?? 0, dmg: Number.isFinite(hit.dmg) ? [hit.dmg, hit.dmg] : [e?.dmg ?? 4, e?.dmg ?? 4], cover: pv.cover ?? 0, flank: pv.flank, notes: pv.notes || ['Silent'] } });
      }
      return out;
    } catch (err) { warnOnce('knife targets', err); }
  }
  const range = e?.range ?? 4;
  return state.units.filter((t) => t.alive && t.team !== u.team && unitVisible(t) && RU.dist(u.x, u.y, t.x, t.y) <= range && RU.los(state.map, u.x, u.y, t.x, t.y))
    .map((t) => {
      let p = null;
      if (typeof G.knifePreview === 'function') { try { p = G.knifePreview(state, u, t); } catch { p = null; } }
      if (!p) { let sp = null; try { sp = G.shotPreview(state, u, t); } catch { sp = null; } p = { chance: Math.max(5, Math.min(95, (e?.aim ?? 75) - (sp ? Math.max(0, (u.weapon?.aim ?? 65) - sp.chance) : 0))), graze: 0, dmg: [e?.dmg ?? 4, e?.dmg ?? 4], cover: sp?.cover ?? 0, flank: sp?.flank, notes: ['Silent'] }; }
      return { id: t.id, p };
    });
}

const CLASS_ACTION = {
  marksman: { key: 'aimed', icon: 'aimed', label: 'Aimed' },
  breacher: { key: 'breach', icon: 'breach', label: 'Breach' },
  medic: { key: 'patch', icon: 'patch', label: 'Patch' },
  recon: { key: 'scan', icon: 'scan', label: 'Scan' },
  engineer: { key: 'cover', icon: 'cover', label: 'Cover' },
  gunner: { key: 'suppress', icon: 'suppress', label: 'Suppress' },
};
const HOTKEYS = { move: '1', shoot: '2', aimed: '3', breach: '3', patch: '3', scan: '3', cover: '3', suppress: '3', grenade: '4', lethal: '4', smoke: '5', tactical: '5', hunker: '6', overwatch: '7', medkit: '8', reload: 'R', swap: 'X', revive: 'V' };

function actionList(u) {
  const av = availability(u);
  const st = (k) => (!av[k]?.ok ? 'off' : ui.mode === k || (ui.mode === 'equip' && ui.equipSlot === k) ? 'active' : 'on');
  const list = [
    { key: 'move', icon: 'move', label: 'Move' },
    { key: 'shoot', icon: 'shoot', label: av.shoot.empty ? 'Empty' : 'Shoot', badge: av.shoot.ok && (av.shoot.count || av.shoot.barrels) ? (av.shoot.count || 'B') : null, badgeKind: av.shoot.count ? 'tg' : 'br', endsTurn: true, cls: av.shoot.empty ? 'empty' : '' },
  ];
  const ca = CLASS_ACTION[u.cls];
  if (ca && av[ca.key]) list.push({ ...ca, badge: av[ca.key].cooldown > 0 ? av[ca.key].cooldown : null, badgeKind: 'cd', cls: 'ability', endsTurn: ca.key === 'aimed' || ca.key === 'suppress' });
  if (av.lethal || av.tactical) {
    for (const slot of ['lethal', 'tactical']) {
      const a = av[slot];
      if (!a) continue;
      list.push({ key: slot, icon: { grenade: 'grenade', semtex: 'semtex', claymore: 'claymore', knife: 'knife', smoke: 'smoke', flashbang: 'flash', stim: 'stim', decoy: 'decoy' }[a.e.action] || (slot === 'lethal' ? 'grenade' : 'smoke'), label: a.e.name.replace(/ Grenade$/, '').replace('Throwing ', ''), badge: a.charges, badgeKind: a.charges > 0 ? 'ch' : 'zero', cls: slot });
    }
  } else {
    const frags = av.grenade.charges ?? 0;
    if (frags > 0 || u.cls === 'assault') list.push({ key: 'grenade', icon: 'grenade', label: 'Frag', badge: frags, badgeKind: frags > 0 ? 'ch' : 'zero' });
    const smokes = av.smoke.charges ?? 0;
    if (smokes > 0 || u.cls === 'recon') list.push({ key: 'smoke', icon: 'smoke', label: 'Smoke', badge: smokes, badgeKind: smokes > 0 ? 'ch' : 'zero' });
  }
  if (av.repair) list.push({ key: 'repair', icon: 'water', label: 'Repair', cls: 'ability' });
  if (av.revive && av.revive.count > 0) list.push({ key: 'revive', icon: 'revive', label: 'Revive', badge: av.revive.count, badgeKind: av.revive.ok ? 'rv' : 'zero', cls: av.revive.ok ? 'urgent' : '' });
  list.push(
    { key: 'hunker', icon: 'hunker', label: 'Hunker', endsTurn: true },
    { key: 'overwatch', icon: 'overwatch', label: 'Watch', endsTurn: true },
    { key: 'medkit', icon: 'medkit', label: 'Medkit', badge: u.items?.medkit ?? 0, badgeKind: u.items?.medkit ? 'ch' : 'zero' },
  );
  for (const a of list) { a.state = st(a.key); a.reason = av[a.key]?.reason; a.hotkey = HOTKEYS[a.key]; }
  return { list, av };
}

function pressAction(a) {
  const u = me();
  if (!u) return;
  if (a.state === 'off') {
    sfx.uiError();
    if (a.reason) H.toast(`${a.label}: ${a.reason}`, 'error');
    if (a.key === 'shoot' && /reload/i.test(a.reason || '')) { J.hitmarker('empty'); sfx.emptyClick(); }
    return;
  }
  sfx.uiClick();
  switch (a.key) {
    case 'move': setMode('move'); break;
    case 'shoot': case 'aimed': case 'grenade': case 'breach': case 'smoke': case 'scan': case 'patch': case 'revive': case 'cover': case 'suppress': {
      const m = a.key === 'shoot' && isLauncher(u) ? 'launch' : a.key;
      if (ui.mode === m) { cancelMode(); break; }
      setMode(m);
      break;
    }
    case 'lethal': case 'tactical': {
      const e = equipOf(u, a.key);
      if (!e) break;
      if (e.id === 'stim' || e.action === 'stim') { doAction({ type: e.action || 'stim' }); break; }
      if (ui.mode === 'equip' && ui.equipSlot === a.key) { cancelMode(); break; }
      if (e.action === 'knife') { ui.equipSlot = a.key; setMode('knife'); break; }
      if (e.action === 'grenade' && typeof G.grenadeTargets === 'function' && !G.semtexTargets) { ui.equipSlot = a.key; setMode('equip', null, { e, slot: a.key }); break; }
      ui.equipSlot = a.key;
      setMode('equip', null, { e, slot: a.key });
      break;
    }
    case 'hunker': doAction({ type: 'hunker' }); break;
    case 'repair': { const id = availability(u).repair?.ids?.[0]; if (id !== undefined) doAction({ type: 'repair', vehicleId: id }); break; }
    case 'overwatch': doAction({ type: 'overwatch' }); break;
    case 'medkit': doAction({ type: 'medkit' }); break;
    case 'reload': doAction({ type: 'reload' }).then((ok) => { if (ok) { sfx.reload?.(); buzz('tap'); } }); break;
    case 'swap': doAction({ type: 'swap' }).then((ok) => { if (ok) sfx.swap?.(); }); break;
    case 'end': endTurnPressed(); break;
    default:
  }
  updateHud();
}

/** Streak bar press: ready → instant call-in or a targeting mode (tile / line). */
function pressStreak(s) {
  if (!s.ready) {
    sfx.uiError();
    H.toast(`${s.name}: ${s.reason || 'Not ready'}`, 'error', 'bolt');
    return;
  }
  sfx.uiClick();
  if (!s.target || s.target === 'none') {
    ui.pending = { kind: 'streak', key: s.key };
    ui.streak = { key: s.key, target: null };
    const d = AR.streakByKey(s.key);
    H.showContext(`<div class="ctx-h"><span class="ctx-ic str">${streakIcon(s.key)}</span><b>${esc(s.name)}</b><span class="cost">0 AP</span><span class="spacer"></span><span class="dim">once per match</span></div>
      <div class="ctx-row"><span class="n scan">${esc(d?.desc || s.desc || '')}</span></div>`, 'streak');
    $('fireBtn').innerHTML = `${streakIcon(s.key)}<span>Call in</span>`;
    $('fireBtn').disabled = false;
    document.body.dataset.mode = 'streak';
    return;
  }
  setMode('streak', null, { key: s.key, target: s.target });
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

function setMode(mode, preselect = null, extra = null) {
  const u = turnCtx?.u;
  clearPreviews();
  H.hideContext();
  $('targetHint').classList.add('hidden');
  ui.pending = null;
  ui.target = null;
  ui.valid = null;
  ui.targets = [];
  if (mode !== 'equip' && mode !== 'knife') { ui.equip = null; if (mode !== 'streak') ui.equipSlot = null; }
  if (mode !== 'streak') ui.streak = null;
  if (mode === 'equip' && extra) ui.equip = extra;
  if (mode === 'knife') ui.equip = { e: equipOf(u, ui.equipSlot || 'lethal'), slot: ui.equipSlot || 'lethal' };
  if (mode === 'streak' && extra) { ui.streak = { ...extra, a: null }; ui.equipSlot = null; }
  ui.mode = mode;
  if (!u || !state) { ui.mode = 'move'; delete document.body.dataset.mode; return; }

  if (mode === 'move') {
    ui.reach = G.moveOptions(state, u);
    addBoatNodes(u);
    const hl = new Map();
    for (const [k, n] of ui.reach) if (n.d > 0) hl.set(k, n.d <= u.move ? 1 : 2);
    Rcall('setHighlights', hl);
  } else if (mode === 'knife' || mode === 'suppress') {
    ui.targets = mode === 'knife' ? knifeTargets(u, ui.equip?.e) : validTargets(u).map((t) => {
      let p = null;
      if (typeof G.suppressPreview === 'function') { try { p = G.suppressPreview(state, u, state.units[t.id]); } catch { p = null; } }
      return { id: t.id, p: p ? { ...t.p, ...p } : { ...t.p, notes: [...(t.p.notes || []), '-25 aim on them', 'Moving draws fire'] } };
    });
    if (!ui.targets.length) { H.toast(mode === 'knife' ? 'No enemy within throwing range' : 'No enemy in sight', 'error'); sfx.uiError(); return setMode('move'); }
    Rcall('setTargetMarkers', unitMarkers());
    const pick = ui.targets.find((t) => t.id === preselect) || ui.targets[0];
    selectTarget(pick.id);
  } else if (mode === 'shoot' || mode === 'aimed') {
    ui.targets = validTargets(u, mode);
    if (mode === 'shoot') {
      const bt = barrelTargetList(u);
      ui.targets.push(...bt, ...boatTargetList(u));
      if (bt.length) {
        // Show which barrels can be shot.
        const hl = new Map();
        for (const b of bt) hl.set(b.k, 2);
        Rcall('setHighlights', hl);
      }
    }
    if (!ui.targets.length) { H.toast('No enemy in range and sight', 'error'); sfx.uiError(); return setMode('move'); }
    Rcall('setTargetMarkers', unitMarkers());
    const pick = ui.targets.find((t) => t.id === preselect) || ui.targets[0];
    selectTarget(pick.id);
  } else if (AREA_MODES.has(mode)) {
    ui.valid = setFor(mode, u);
    if (!ui.valid?.size) {
      H.toast({ grenade: 'No tile in throw range', smoke: 'No tile in throw range', breach: 'Nothing to breach here', scan: 'Nothing to scan', equip: 'No tile in range', cover: 'No open tile next to you', streak: 'No tile in range' }[mode], 'error');
      sfx.uiError();
      return setMode('move');
    }
    const hl = new Map();
    for (const k of ui.valid) hl.set(k, 2);
    Rcall('setHighlights', hl);
    if (mode === 'streak' && ui.streak.target === 'line') showTargetHint('Tap where the airstrike starts, then tap its direction');
    else if (mode === 'streak') showTargetHint(`Tap a highlighted tile for the ${AR.streakByKey(ui.streak.key)?.name || 'drop'}`);
    if ((mode === 'breach' || mode === 'cover') && ui.valid.size === 1) {
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
    cands.sort((a, b) => (b.downed - a.downed) || ((a.bleed || 9) - (b.bleed || 9)) || ((a.hp / a.maxHp) - (b.hp / b.maxHp)) || (isMe(a) - isMe(b)));
    const pick = cands.find((c) => c.id === preselect) || cands[0];
    if (pick) previewSupport(pick, 'tap');
  }
  document.body.dataset.mode = ui.mode;
  syncCoverFade();
  updateHud();
}

function cancelMode() {
  if (ui.mode !== 'move') setMode('move');
  else if (ui.pending) { ui.pending = null; Rcall('setPathPreview', null); H.hideContext(); }
  updateHud();
}

// ----- move

/** Boats (5.0): boardable boats next to you, or the water your boat can reach when you drive. */
function addBoatNodes(u) {
  if (!state.vehicles?.length || !ui.reach) return;
  const S = state.map.size;
  const start = u.y * S + u.x;
  if (!ui.reach.has(start)) ui.reach.set(start, { d: 0, prev: -1 });
  try {
    if (u.vehicle != null) {
      const v = G.vehicleOf?.(state, u) || state.vehicles.find((w) => w.id === u.vehicle);
      const set = G.boatMoveTargets?.(state, u);
      if (!v || !set?.size) return;
      const reach = G.boatReach(state, v);
      for (const k of set) ui.reach.set(k, { d: 1, prev: start, boat: 'drive', path: RU.pathTo(reach, S, k) });
    } else {
      for (const k of G.boardTargets?.(state, u) || []) ui.reach.set(k, { d: 1, prev: start, boat: 'board' });
    }
  } catch (e) { warnOnce('boat nodes', e); }
}

function previewMove(k, via) {
  const u = turnCtx.u;
  const S = state.map.size;
  const node = ui.reach?.get(k);
  if (!node || node.d === 0) return false;
  const x = k % S, y = (k / S) | 0;
  const cost = node.d <= u.move ? 1 : 2;
  const path = node.path || (RU.pathTo ? RU.pathTo(ui.reach, S, k) : [[u.x, u.y], [x, y]]);
  if (node.boat) {
    const v = node.boat === 'drive' ? state.vehicles.find((w) => w.id === u.vehicle) : state.vehicles.find((w) => w.x === x && w.y === y);
    ui.pending = { kind: 'move', boat: node.boat, k, x, y, cost: 1, path, via };
    Rcall('setPathPreview', path, 1);
    H.showContext(`<div class="ctx-h"><span class="ctx-ic">${ICON.move}</span><b>${node.boat === 'drive' ? 'Drive the boat' : 'Board the boat'}</b><span class="cost">1 AP</span></div>
      <div class="ctx-row"><span class="n">${node.boat === 'drive' ? `Ends your turn · fuel ${v?.fuel ?? '?'} → ${(v?.fuel ?? 1) - 1}` : `Hull ${v?.hp ?? '?'}/${v?.maxHp ?? 12} · ${v?.seats?.length ?? 0}/4 aboard · half cover, no tide damage`}</span></div>`, 'move');
    $('fireBtn').innerHTML = `${ICON.check}<span>${node.boat === 'drive' ? 'Drive' : 'Board'}</span>`;
    $('fireBtn').disabled = false;
    return true;
  }
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
  const outNext = !insideNext(p.x, p.y);
  const hid = concealBy(p.x, p.y);
  const S = state.map.size;
  const nearBarrel = hasBarrels() && state.map.explosive.some((v, k) => v && state.map.cover[k] && RU.dist(k % S, (k / S) | 0, p.x, p.y) <= BARREL_RADIUS);
  const coverTxt = ['Exposed', 'Half cover', 'Full cover'][ci.best];
  const notes = [];
  if (ci.flankers) notes.push(`<span class="n bad">${ICON.warn}Flanked by ${ci.flankers}</span>`);
  if (hid === 'smoke') notes.push(`<span class="n good">${ICON.hidden}Smoke: hidden · -${SMOKE_AIM} aim in and out</span>`);
  else if (hid === 'kelp') notes.push(`<span class="n good">${ICON.kelp}Kelp: hidden beyond ${KELP_REVEAL} tiles</span>`);
  if (nearBarrel) notes.push(`<span class="n bad">${ICON.barrelx}Next to a barrel</span>`);
  if (terrainAt(p.x, p.y) === 2) notes.push(`<span class="n">${ICON.water}Shallows</span>`);
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

const unitMarkers = (sel = null) => ui.targets.filter((x) => !x.barrel && !x.vehicle).map((x) => ({ id: x.id, chance: x.p.chance, selected: x.id === sel }));

function selectTarget(id) {
  const t = ui.targets.find((x) => x.id === id);
  if (!t) return false;
  ui.target = id;
  if (t.vehicle) {
    ui.pending = { kind: 'vehicle', id, vehicleId: t.vehicleId, k: t.k, x: t.x, y: t.y };
    Rcall('setSelectedTarget', null);
    Rcall('setTargetMarkers', unitMarkers());
    Rcall('setAoePreview', { x: t.x, y: t.y, radius: 0.5, valid: true, kind: 'scan' });
    const u = turnCtx.u;
    Rcall('focus', (t.x + u.x) / 2, (t.y + u.y) / 2);
    const idx = ui.targets.findIndex((x) => x.id === t.id);
    H.showContext(`<div class="ctx-h"><span class="ctx-ic">${ICON.shoot}</span><b>Enemy boat</b><span class="cost">1 AP</span><span class="spacer"></span>
      ${ui.targets.length > 1 ? `<button class="btn ghost sm cycle" id="cycleBtn" title="Next target [Tab]">${idx + 1}/${ui.targets.length}<span class="kbd-hint">Tab</span></button>` : ''}</div>
      <div class="odds three"><div class="odd big"><b>${t.pv.chance}<small>%</small></b><span>Hit</span></div><div class="odd"><b>${t.pv.dmg[0]}-${t.pv.dmg[1]}</b><span>Hull dmg</span></div><div class="odd"><b>${t.hp}</b><span>Hull left</span></div></div>`, 'shoot');
    $('fireBtn').innerHTML = `${ICON.shoot}<span>Shoot boat</span><small>ends turn</small>`;
    $('fireBtn').disabled = false;
    const cb = $('cycleBtn');
    if (cb) cb.onclick = (e) => { e.stopPropagation(); sfx.uiClick(); cycleTarget(1); };
    return true;
  }
  if (t.barrel) {
    ui.pending = { kind: 'barrel', id, k: t.k, x: t.x, y: t.y };
    Rcall('setSelectedTarget', null);
    Rcall('setTargetMarkers', unitMarkers());
    Rcall('setAoePreview', { x: t.x, y: t.y, radius: t.pv.radius ?? BARREL_RADIUS, valid: true, kind: 'frag' });
    const u = turnCtx.u;
    Rcall('focus', (t.x + u.x) / 2, (t.y + u.y) / 2);
    showBarrelContext(t);
    return true;
  }
  Rcall('setAoePreview', null);
  ui.pending = { kind: ui.mode, id };
  Rcall('setSelectedTarget', id);
  if (!hasR('setSelectedTarget')) { const tu = state.units[id], u = turnCtx.u; Rcall('focus', (tu.x + u.x) / 2, (tu.y + u.y) / 2); }
  Rcall('setTargetMarkers', unitMarkers(id));
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
  const hid = concealBy(t.x, t.y);
  const flared = isFlared(t);
  const idx = ui.targets.findIndex((x) => x.id === id);
  const html = `
    <div class="ctx-h enemy" style="--sq:${teamColor(t.team)}"><span class="sil-sm tgt-badge">${badgeCached(t.cls, unitTier(t), { size: 40 })}</span>
      <div class="tgt-name"><b>${esc(t.name)}</b><small><i class="sq-dot"></i>Squad ${t.team + 1} · ${esc(c?.name || t.cls)}${t.isLoneWolf ? ' · Lone Wolf' : ''}</small></div>
      ${ui.targets.length > 1 ? `<button class="btn ghost sm cycle" id="cycleBtn" title="Next target [Tab]">${idx + 1}/${ui.targets.length}<span class="kbd-hint">Tab</span></button>` : ''}</div>
    <div class="tgt-hp">${t.downed ? `<span class="tag bleed">${ICON.downed}Downed · ${t.bleed} turn${t.bleed === 1 ? '' : 's'} left</span>` : `<span class="hp-pips enemy${t.maxHp > 14 ? ' dense' : ''}">${hpPips}</span><span>${t.hp}/${t.maxHp}</span>`}${t.armor ? `<span class="armor">${ICON.shield}<b>${t.armor}</b></span>` : ''}${t.hunkered ? `<span class="tag hk">${ICON.hunker}Hunkered</span>` : ''}${hid ? `<span class="tag sm">${ICON[hid === 'kelp' ? 'kelp' : 'smoke']}In ${hid}</span>` : ''}${flared ? `<span class="tag flare">${ICON.flare}Flared</span>` : ''}</div>
    <div class="odds">
      <div class="odd big"><b>${p.chance}<small>%</small></b><span>Hit</span></div>
      <div class="odd"><b>${p.graze || 0}<small>%</small></b><span>Graze</span></div>
      <div class="odd"><b>${p.dmg[0]}–${p.dmg[1]}</b><span>Damage</span></div>
      <div class="odd ${sure ? 'kill' : lethal ? 'maybe' : ''}"><b>${t.downed ? 'FINISH' : sure ? 'KILL' : lethal ? 'CAN KILL' : coverWord}</b><span>${sure || lethal ? coverWord : 'Target'}</span></div>
    </div>
    <div class="ctx-row notes">${aimed && !(p.notes || []).some((n) => /aimed/i.test(n)) ? `<span class="n good">${ICON.aimed}Aimed +15 aim, +2 dmg</span>` : ''}${notes}</div>
    ${ui.mode === 'knife' ? `<div class="ends-turn free">${ICON.knife}<b>Doesn't end your turn</b><span>Silent: no gunfire ping, no flare.</span></div>` : endsTurnStrip()}`;
  H.showContext(html, 'shoot');
  const knife = ui.mode === 'knife', sup = ui.mode === 'suppress';
  $('fireBtn').innerHTML = knife ? `${ICON.knife}<span>Throw knife</span><small>silent</small>` : sup ? `${ICON.suppress}<span>Suppress</span><small>ends turn</small>` : `${aimed ? ICON.aimed : ICON.shoot}<span>${aimed ? 'Aimed shot' : 'Fire'}</span><small>ends turn</small>`;
  $('fireBtn').disabled = false;
  const cb = $('cycleBtn');
  if (cb) cb.onclick = (e) => { e.stopPropagation(); sfx.uiClick(); cycleTarget(1); };
}

/** The XCOM rule, spelled out: firing ends the turn (and lights a flare at night). */
function endsTurnStrip() {
  const u = turnCtx?.u;
  const spare = u ? u.ap - 1 : 0;
  return `<div class="ends-turn">${ICON.endturn}<b>Ends your turn</b><span>${spare > 0 ? `Your other ${spare} AP ${spare === 1 ? 'is' : 'are'} lost. Move first to reposition.` : 'Uses your last AP.'}</span></div>
    ${isNight() ? `<div class="ends-turn flare">${ICON.flare}<b>Flare</b><span>Firing lights you up for every squad until your next turn.</span></div>` : ''}`;
}

function showBarrelContext(t) {
  const u = turnCtx.u;
  const seen = (t.pv.units || []).filter((h) => unitVisible(state.units[h.id]));
  const rows = seen.map((h) => {
    const e = state.units[h.id];
    const mine = e.team === u.team;
    return `<span class="hit ${mine ? 'ff' : 'en'}${h.lethal ? ' lethal' : ''}"${mine ? '' : ` style="--sq:${teamColor(e.team)}"`}>${esc(unitName(e))}<b>-${h.dmg}</b>${h.lethal ? `<em>${ICON.skull}</em>` : ''}</span>`;
  }).join('') || '<span class="dim">No visible units in the blast</span>';
  const chain = (t.pv.barrels || []).length;
  const ff = seen.some((h) => state.units[h.id].team === u.team);
  const idx = ui.targets.findIndex((x) => x.id === t.id);
  const html = `
    <div class="ctx-h"><span class="ctx-ic barrel">${ICON.barrelx}</span><b>Explosive barrel</b><span class="cost">1 AP</span><span class="spacer"></span>
      ${ui.targets.length > 1 ? `<button class="btn ghost sm cycle" id="cycleBtn" title="Next target [Tab]">${idx + 1}/${ui.targets.length}<span class="kbd-hint">Tab</span></button>` : ''}</div>
    <div class="odds three">
      <div class="odd big"><b>100<small>%</small></b><span>Hit</span></div>
      <div class="odd"><b>${BARREL_DMG}</b><span>Blast dmg</span></div>
      <div class="odd"><b>${chain ? `+${chain}` : '3×3'}</b><span>${chain ? `Chain${chain === 1 ? '' : 's'}` : 'Radius'}</span></div>
    </div>
    <div class="ctx-row hits">${rows}</div>
    ${ff ? `<div class="ctx-row"><span class="n bad">${ICON.warn}Friendly fire</span></div>` : ''}
    ${endsTurnStrip()}`;
  H.showContext(html, 'shoot barrel');
  $('fireBtn').innerHTML = `${ICON.barrelx}<span>Shoot barrel</span><small>ends turn</small>`;
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

function areaDef(mode) {
  if (mode === 'equip' && ui.equip) {
    const e = ui.equip.e;
    return { icon: { grenade: 'grenade', semtex: 'semtex', claymore: 'claymore', smoke: 'smoke', flashbang: 'flash', decoy: 'decoy' }[e.action] || 'grenade', title: e.name, verb: e.id === 'claymore' ? 'Place' : 'Throw', radius: e.radius ?? (e.id === 'decoy' ? 0.8 : 1.5), prompt: e.id === 'claymore' ? 'Tap an open tile next to you' : `Tap a highlighted tile up to ${e.range ?? 7} tiles away`, bad: 'Out of range or no line of sight' };
  }
  if (mode === 'launch') return { icon: 'burst', title: u_weaponName(), verb: 'Fire', radius: turnCtx?.u?.weapon?.radius ?? 1.5, prompt: 'Tap a tile in range: the rocket never misses its tile', bad: 'Out of range or no line of sight' };
  if (mode === 'cover') return { icon: 'cover', title: 'Deploy Cover', verb: 'Build', radius: 0.6, prompt: 'Tap an open tile next to you to raise a full-cover barricade', bad: 'Pick an open tile next to you' };
  if (mode === 'streak' && ui.streak) {
    const d = AR.streakByKey(ui.streak.key) || {};
    return { icon: STREAK_ICON_KEY[ui.streak.key] || 'bolt', title: d.name || 'Killstreak', verb: 'Call in', radius: ui.streak.key === 'sentry' ? 1 : 0.8, prompt: ui.streak.target === 'line' ? 'Tap the start of the 7-tile line, then its direction' : 'Tap a highlighted tile', bad: 'Out of range' };
  }
  return AREA[mode];
}
const STREAK_ICON_KEY = { uav: 'uav', care: 'care', care_package: 'care', cuav: 'cuav', counter_uav: 'cuav', airstrike: 'airstrike', sentry: 'sentry', gunship: 'gunship' };
function u_weaponName() { return turnCtx?.u?.weapon?.name || 'Launcher'; }
function showTargetHint(txt) { const el = $('targetHint'); el.textContent = txt; el.classList.remove('hidden'); }

function showAreaPrompt(mode) {
  const u = turnCtx.u;
  const A = areaDef(mode);
  const charges = mode === 'grenade' ? `<span class="cost">${u.items.frag ?? 0} left</span>` : mode === 'smoke' ? `<span class="cost">${u.items.smoke ?? 0} left</span>` : mode === 'equip' ? `<span class="cost">${chargesOf(u, ui.equip.e.id)} left</span>` : mode === 'streak' ? '<span class="cost">0 AP</span>' : '';
  const html = `
    <div class="ctx-h"><span class="ctx-ic${mode === 'streak' ? ' str' : ''}">${ICON[A.icon]}</span><b>${A.title}</b>${charges}<span class="spacer"></span></div>
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
  if (ui.mode === 'streak') return previewStreak(x, y, via);
  const u = turnCtx.u;
  const k = keyOf(x, y);
  const mode = ui.mode;
  const eq = mode === 'equip' ? ui.equip.e : null;
  // Equipment previews like the 3.0 kinds they resemble.
  const kind = eq ? ({ grenade: 'grenade', semtex: 'grenade', flashbang: 'flash', smoke: 'smoke', claymore: 'claymore', decoy: 'decoy' }[eq.action] || 'grenade') : mode;
  const A = areaDef(mode);
  const valid = !!ui.valid?.has(k);
  let pv = null;
  const pfn = eq ? (typeof G.equipmentPreview === 'function' ? (st, uu, xx, yy) => G.equipmentPreview(st, uu, eq.id, xx, yy) : G[`${eq.action}Preview`] || (eq.action === 'grenade' ? G.grenadePreview : null)) : { grenade: G.grenadePreview, breach: G.breachPreview, smoke: G.smokePreview, scan: G.scanPreview, cover: G.deployCoverPreview, launch: G.launchPreview }[kind];
  if (typeof pfn === 'function') {
    try { pv = pfn(state, u, x, y); } catch (e) { warnOnce(kind + 'Preview', e); }
  }
  if (!pv) pv = kind === 'grenade' || kind === 'breach' ? localAreaPreview(kind, x, y) : { valid, units: [] };
  const ok = valid && pv.valid !== false;
  Rcall('setAoePreview', { x, y, radius: pv.radius ?? A.radius, valid: ok, kind: kind === 'launch' || kind === 'breach' || kind === 'grenade' || kind === 'claymore' ? 'frag' : kind === 'flash' ? 'scan' : kind === 'cover' ? 'scan' : kind === 'decoy' ? 'scan' : kind });
  if (via === 'tap') Rcall('focus', (x + u.x) / 2, (y + u.y) / 2);
  ui.pending = ok ? { kind: mode, k, x, y, via, action: eq?.action } : null;
  // Only list units the player can already see (no free intel).
  const seen = (pv.units || []).filter((h) => unitVisible(state.units[h.id]));
  let rows = '';
  let foot = '';
  if (kind === 'grenade' || kind === 'breach' || kind === 'launch') {
    foot = '';
    rows = seen.map((h) => {
      const t = state.units[h.id];
      const mine = t.team === u.team;
      return `<span class="hit ${mine ? 'ff' : 'en'}${h.lethal ? ' lethal' : ''}">${esc(unitName(t))}<b>-${h.dmg}</b>${h.lethal ? `<em>${ICON.skull}</em>` : ''}</span>`;
    }).join('') || '<span class="dim">No visible units in the blast</span>';
    const ff = seen.some((h) => state.units[h.id].team === u.team);
    const covers = (pv.cover || []).length;
    const chain = (pv.barrels || []).length;
    if (chain) foot = `<span class="n bad">${ICON.barrelx}${chain} barrel${chain === 1 ? '' : 's'} will blow</span>`;
    foot += `${covers ? `<span class="n warn">${ICON.burst}${covers} cover tile${covers === 1 ? '' : 's'} wrecked</span>` : kind === 'grenade' ? `<span class="n">${ICON.burst}3×3 blast · ignores cover</span>` : `<span class="n">${ICON.burst}Opens this tile · 4 dmg nearby</span>`}
      ${ff ? `<span class="n bad">${ICON.warn}Friendly fire</span>` : ''}`;
  } else if (kind === 'smoke') {
    const allies = seen.filter((h) => state.units[h.id].team === u.team);
    const foes = seen.filter((h) => state.units[h.id].team !== u.team);
    rows = allies.map((h) => `<span class="hit sm">${esc(unitName(state.units[h.id]))}<b>hidden</b></span>`).join('')
      + foes.map((h) => `<span class="hit en">${esc(state.units[h.id].name)}<b>hidden</b></span>`).join('')
      || '<span class="dim">Nobody inside yet. Smoke lasts until your next turn</span>';
    foot = `<span class="n">${ICON.hidden}Hides anyone inside · -${SMOKE_AIM} aim in and out · lasts a round</span>${foes.length ? `<span class="n warn">${ICON.warn}Hides enemies too</span>` : ''}`;
  } else if (kind === 'scan') {
    rows = `<span class="n scan">${ICON.scan}${seen.length ? `${seen.length} known contact${seen.length === 1 ? '' : 's'} in the area` : 'No known contacts in the area'}</span>`;
    foot = `<span class="n">${ICON.eye}Reveals everyone within ${pv.radius ?? SCAN_RADIUS} tiles until your next turn</span>`;
  } else if (kind === 'flash') {
    const foes = seen.filter((h) => state.units[h.id].team !== u.team);
    rows = foes.map((h) => `<span class="hit en">${esc(state.units[h.id].name)}<b>-1 AP</b></span>`).join('') || '<span class="dim">No visible enemies in the flash</span>';
    foot = `<span class="n">${ICON.flash}-1 AP next turn · -30 aim until it ends · Tactical Mask blocks it</span>`;
  } else if (kind === 'claymore') {
    rows = `<span class="n bad">${ICON.claymore}${eq?.dmg ?? 5} damage to the first enemy that moves within ${eq?.trigger ?? 1.5}</span>`;
    foot = `<span class="n">${ICON.hidden}Enemies don't see it unless they're right on top of it</span>`;
  } else if (kind === 'decoy') {
    rows = `<span class="n scan">${ICON.decoy}Fake gunfire ping here for a round</span>`;
    foot = `<span class="n">${ICON.overwatch}Draws bot overwatch and aim</span>`;
  } else if (kind === 'cover') {
    rows = `<span class="n good">${ICON.cover}Full cover barricade on this tile</span>`;
    foot = `<span class="n">${ICON.shield}Blocks shots from that side · cooldown 3</span>`;
  }
  if (eq?.action === 'semtex') foot = `<span class="n">${ICON.semtex}Sticks: never misses its tile · +${eq.stick ?? 2} to a unit on it</span>` + foot;
  const charges = kind === 'grenade' && !eq ? `<span class="dim">${u.items.frag ?? 0} left</span>` : kind === 'smoke' && !eq ? `<span class="dim">${u.items.smoke ?? 0} left</span>` : eq ? `<span class="dim">${chargesOf(u, eq.id)} left</span>` : '';
  const html = `
    <div class="ctx-h"><span class="ctx-ic">${ICON[A.icon]}</span><b>${A.title}</b><span class="cost">1 AP</span>${charges}<span class="spacer"></span></div>
    ${ok ? `<div class="ctx-row hits">${rows}</div><div class="ctx-row">${foot}</div>`
    : `<div class="ctx-hint big bad">${A.bad}</div>`}
    ${via === 'hover' && ok ? `<div class="ctx-hint">Click to ${A.verb.toLowerCase()}</div>` : ''}`;
  H.showContext(html, 'area ' + kind + (ok ? '' : ' invalid'));
  $('fireBtn').innerHTML = `${ICON.check}<span>${A.verb}</span>`;
  $('fireBtn').disabled = !ok;
}

/** Killstreak targeting: tile streaks (care package, sentry) and the 2-tap airstrike line. */
function previewStreak(x, y, via) {
  const u = turnCtx.u;
  const sk = ui.streak;
  const d = AR.streakByKey(sk.key) || { name: sk.key };
  const k = keyOf(x, y);
  let x0 = x, y0 = y, x2, y2;
  if (sk.target === 'line') {
    // First tap anchors the start; later taps aim the jets (tapping the aimed tile again calls it in).
    if (!sk.a) {
      if (!ui.valid?.has(k)) { sfx.uiError(); return; }
      if (via !== 'tap') { x2 = x + 1; y2 = y; } else { sk.a = { x, y }; sk.locked = true; showTargetHint('Now tap the direction the jets fly'); }
    }
    if (sk.a) { x0 = sk.a.x; y0 = sk.a.y; x2 = x === x0 && y === y0 ? x0 + 1 : x; y2 = x === x0 && y === y0 ? y0 : y; }
  }
  let pv = null;
  if (typeof G.streakPreview === 'function') { try { pv = G.streakPreview(state, u, sk.key, x0, y0, x2, y2); } catch (e) { warnOnce('streakPreview', e); } }
  if (!pv) {
    const tiles = [];
    if (sk.target === 'line') { const dx = Math.sign((x2 ?? x0 + 1) - x0), dy = Math.sign((y2 ?? y0) - y0); for (let i = 0; i < (d.length || 7); i++) tiles.push([x0 + dx * i, y0 + dy * i]); } else tiles.push([x0, y0]);
    pv = { valid: !!ui.valid?.has(keyOf(x0, y0)), tiles, units: [] };
  }
  const ok = pv.valid !== false && (sk.target !== 'line' || !!sk.a);
  const hl = new Map();
  for (const kk of ui.valid || []) hl.set(kk, 1);
  for (const [tx, ty] of pv.tiles || []) if (tx >= 0 && ty >= 0 && tx < state.map.size && ty < state.map.size) hl.set(keyOf(tx, ty), 3);
  Rcall('setHighlights', hl);
  if (sk.target !== 'line') Rcall('setAoePreview', { x: x0, y: y0, radius: sk.key === 'sentry' ? (d.reach ?? 8) / 8 : 0.7, valid: ok, kind: STREAK_PREVIEW_KIND[sk.key] || 'scan' });
  Rcall('setStreakPreview', { key: sk.key, tiles: pv.tiles, valid: ok });
  ui.pending = ok ? { kind: 'streak', key: sk.key, k, x: x0, y: y0, x2, y2, via: sk.target === 'line' ? 'line' : via } : (sk.target === 'line' && sk.a ? { kind: 'streak-wait', k } : null);
  const seen = (pv.units || []).filter((h) => unitVisible(state.units[h.id]));
  const rows = seen.map((h) => { const t = state.units[h.id]; return `<span class="hit ${t.team === u.team ? 'ff' : 'en'}">${esc(unitName(t))}<b>-${h.dmg ?? d.dmg ?? 5}</b></span>`; }).join('');
  const html = `<div class="ctx-h"><span class="ctx-ic str">${streakIcon(sk.key)}</span><b>${esc(d.name)}</b><span class="cost">0 AP</span><span class="spacer"></span><span class="dim">once per match</span></div>
    ${sk.target === 'line' ? `<div class="ctx-row hits">${rows || '<span class="dim">No visible soldiers on the line</span>'}</div><div class="ctx-row"><span class="n warn">${ICON.warn}Telegraphed: everyone sees the red line. Hits next round for ${d.dmg ?? 5}, ignores cover</span></div>`
      : `<div class="ctx-row"><span class="n scan">${esc(d.desc || '')}</span></div>`}
    ${sk.target === 'line' && !sk.a ? '<div class="ctx-hint big">Tap the start tile</div>' : ''}`;
  H.showContext(html, 'streak' + (ok ? '' : ' invalid'));
  $('fireBtn').innerHTML = `${streakIcon(sk.key)}<span>Call in</span>`;
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
    ${ok ? `<div class="sup-row"><span class="sil-sm mine tgt-badge">${badgeCached(t.cls, unitTier(t), { size: 40 })}</span>
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
  if (!turnCtx || turnCtx.busy || !p || p.kind === 'streak-wait') { if ((!p || p.kind === 'streak-wait') && turnCtx) sfx.uiError(); return; }
  sfx.uiClick();
  switch (p.kind) {
    case 'move': doAction({ type: p.boat === 'drive' ? 'boat_move' : 'move', x: p.x, y: p.y }); break;
    case 'vehicle': doAction({ type: 'shoot', vehicleId: p.vehicleId }); break;
    case 'repair': doAction({ type: 'repair', vehicleId: p.vehicleId }); break;
    case 'shoot': doAction({ type: 'shoot', targetId: p.id }); break;
    case 'aimed': doAction({ type: 'aimed', targetId: p.id }); break;
    case 'barrel': doAction({ type: 'shoot_barrel', x: p.x, y: p.y }); break;
    case 'grenade': doAction({ type: 'grenade', x: p.x, y: p.y }); break;
    case 'smoke': doAction({ type: 'smoke', x: p.x, y: p.y }); break;
    case 'scan': doAction({ type: 'scan', x: p.x, y: p.y }); break;
    case 'breach': doAction({ type: 'breach', x: p.x, y: p.y }); break;
    case 'patch': doAction({ type: 'patch', targetId: p.id }); break;
    case 'revive': doAction({ type: 'revive', targetId: p.id }); break;
    case 'equip': doAction({ type: p.action, x: p.x, y: p.y }); break;
    case 'cover': doAction({ type: 'deploy_cover', x: p.x, y: p.y }); break;
    case 'launch': doAction({ type: 'shoot', x: p.x, y: p.y }); break;
    case 'knife': doAction({ type: 'knife', targetId: p.id, x: state.units[p.id]?.x, y: state.units[p.id]?.y }); break;
    case 'suppress': doAction({ type: 'suppress', targetId: p.id }); break;
    case 'streak': {
      const a = { type: 'streak', key: p.key };
      if (Number.isInteger(p.x)) { a.x = p.x; a.y = p.y; }
      if (Number.isInteger(p.x2)) { a.x2 = p.x2; a.y2 = p.y2; }
      Rcall('setStreakPreview', null);
      doAction(a).then((ok) => { if (ok) { stats.streaks = (stats.streaks || 0) + 1; } });
      break;
    }
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
    case 'streak': {
      if (sameTap && ui.streak?.target !== 'line') { confirmPending(); return; }
      if (ui.streak?.target === 'line' && ui.streak.a && p?.kind === 'streak' && p.x2 === x && p.y2 === y) { confirmPending(); return; }
      if (!ui.valid?.has(k) && !(ui.streak?.target === 'line' && ui.streak.a)) { sfx.uiError(); return; }
      sfx.uiClick();
      previewArea(x, y, 'tap');
      return;
    }
    case 'grenade': case 'breach': case 'smoke': case 'scan': case 'equip': case 'cover': case 'launch': {
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
    case 'shoot': case 'aimed': case 'knife': case 'suppress': {
      const b = ui.targets.find((t) => (t.barrel || t.vehicle) && t.k === k);
      if (b) {
        if (ui.target === b.id) { confirmPending(); return; }
        sfx.uiClick(); selectTarget(b.id); return;
      }
      // Tapping the ground drops back to move mode and treats it as a move tap.
      setMode('move');
      handleTile(x, y);
      return;
    }
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
  if (UNIT_MODES.has(ui.mode)) {
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
    if (!$('tierUp').classList.contains('hidden')) { closeTierUp(); return; }
    if (introCtx) { introCtx.skip(); return; }
    if (state && !$('hud').classList.contains('hidden') && $('endScreen').classList.contains('hidden')) {
      if (ui.mode !== 'move' || ui.pending) cancelMode();
      else openPause();
    }
    return;
  }
  if (sheetOpen()) return;
  if (!$('tierUp').classList.contains('hidden')) { if (k === 'Enter' || k === ' ') { e.preventDefault(); closeTierUp(); } return; }
  if (!$('levelUp').classList.contains('hidden')) { if (k === 'Enter' || k === ' ') { e.preventDefault(); closeLevelUp(); } return; }
  if (!$('onlineRoot').classList.contains('hidden')) return;
  if (!$('splash').classList.contains('hidden')) {
    if (!e.metaKey && !e.ctrlKey && !e.altKey && k !== 'Tab' && k !== 'Shift') { e.preventDefault(); menu.enter(); }
    return;
  }
  if (!$('menu').classList.contains('hidden')) {
    if (k === 'Enter' && !(e.target instanceof HTMLButtonElement) && menu.page() === 'play') { e.preventDefault(); sfx.uiClick(); startGame(); }
    if ((k === '[' || k === ']') && !e.metaKey && !e.ctrlKey) {
      const pages = ['play', 'barracks', 'armory', 'store', 'career'];
      const i = pages.indexOf(menu.page()) + (k === ']' ? 1 : -1);
      if (i >= 0 && i < pages.length) { uiSound('tab'); menu.setPage(pages[i]); }
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
  const alive = new Set(typeof G.aliveTeams === 'function' ? G.aliveTeams(state) : state.teams.map((t) => t.id));
  const mt = myTeam();
  let act = pitView ? [] : activeTeams.filter((t) => alive.has(t));
  if (!act.length && state.winner === null) {
    try { act = typeof G.activeTeams === 'function' ? G.activeTeams(state) : [G.currentTeamId(state)]; } catch { act = []; }
  }
  const curTeam = state.winner === null ? (act.includes(mt) ? mt : act[0] ?? -1) : -1;

  // turn strip + label
  H.renderTurnStrip(state, { myTeam: mt, activeTeam: curTeam, activeTeams: act, alive });
  let label, kind;
  if (pitView && state.winner !== null) { const w = state.winner === mt; label = w ? 'THE PIT · WON · REDEPLOYING' : 'ELIMINATED · SPECTATING'; kind = w ? 'you' : 'neutral'; } // duel over, arena still on screen
  else if (state.winner !== null) { label = state.winner === mt ? 'VICTORY' : 'MATCH OVER'; kind = state.winner === mt ? 'you' : 'neutral'; }
  else if (!pitView && !standing(u) && u && !u.alive && ctl?.state?.pit?.queue?.includes?.(u.id)) { label = 'OUT · WAITING FOR THE PIT'; kind = 'neutral'; }
  else if (pitView) { label = turnCtx ? 'THE PIT · YOUR TURN' : 'THE PIT'; kind = turnCtx ? 'you' : 'enemy'; }
  else if (turnCtx) { label = 'YOUR TURN'; kind = 'you'; }
  else if (act.includes(mt)) { label = playerUp() ? (turnCtx === null && act.length > 1 ? 'SQUADS MOVING' : 'SQUADMATES MOVING') : 'YOUR SQUAD'; kind = 'mates'; }
  else if (act.length > 1) { label = `${act.length} SQUADS MOVING`; kind = 'enemy'; }
  else { label = curTeam >= 0 ? squadName(curTeam).toUpperCase() : 'STANDBY'; kind = 'enemy'; }
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
    nextOutside: u?.alive && !insideNext(u.x, u.y),
  });

  // unit card + actions
  const mates = state.teams[mt]?.members.map((id) => state.units[id]).filter((m) => standing(m) && !isMe(m)).length || 0;
  const ws = u ? {
    range: RU.weaponRange ? RU.weaponRange(u) : u.weapon.range,
    aim: u.weapon.aim + (u.mods?.scope || 0) * 5,
    dmg: [u.weapon.dmg[0] + (u.mods?.barrel || 0), u.weapon.dmg[1] + (u.mods?.barrel || 0)],
  } : null;
  const spotted = !!u?.alive && !!state.reveals?.some((r) => r.team !== mt && r.ids?.includes(u.id));
  H.renderUnitCard(u, {
    CLASSES, myTurn: !!turnCtx, weaponStats: ws, callsign: callsign(),
    outside: u?.alive && !G.insideZone(state, u.x, u.y),
    nextOutside: u?.alive && !insideNext(u.x, u.y),
    spectating: !u?.alive, aliveMates: mates,
    inSmoke: !!u?.alive && concealBy(u.x, u.y) === 'smoke',
    inKelp: !!u?.alive && concealBy(u.x, u.y) === 'kelp',
    inShallows: !!u?.alive && terrainAt(u.x, u.y) === 2,
    flared: !!u?.alive && isFlared(u),
    tier: u ? M.classProgress(u.cls).tier : 0,
    spotted,
  });
  if (standing(u)) {
    const { list, av } = actionList(u);
    H.renderActions(list, pressAction);
    renderWeaponBar(u, av);
    renderStreakBar(u);
  } else { H.renderActions([], pressAction); $('wpnBar').classList.add('hidden'); $('streakBar').classList.add('hidden'); }
  updateEndBtn();
  document.body.classList.toggle('my-turn', !!turnCtx);
  document.body.classList.toggle('dead', !u?.alive);
  document.body.classList.toggle('downed', !!u?.alive && !!u?.downed);

  // downed squadmates: alert + world markers
  const downed = state.winner === null ? downedMates() : [];
  const canAct = !!turnCtx && !turnCtx.busy && standing(u) && u.ap > 0;
  const rset = canAct && downed.length ? reviveSet(u) : null;
  H.renderSquadAlert(downed.map((m) => ({
    id: m.id, name: m.name, cls: m.cls, bleed: m.bleed ?? 0, isPlayer: isMe(m),
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

/** Ammo counter + reload + primary/secondary swap (5.0). */
function renderWeaponBar(u, av) {
  const el = $('wpnBar');
  if (!hasAmmoModel(u) && !u.weapon) { el.classList.add('hidden'); return; }
  const wi = wInfo(u);
  const inf = wi ? wi.infinite : infiniteAmmo(u);
  const ammo = wi ? wi.ammo : ammoOf(u);
  const mag = wi ? wi.mag : magOf(u);
  const spare = wi ? wi.spare : spareOf(u);
  const other = wi ? wi.other : otherWeapon(u);
  const low = !inf && Number.isFinite(ammo) && Number.isFinite(mag) && ammo <= Math.max(1, Math.floor(mag / 4));
  const pips = !inf && Number.isFinite(mag) && mag <= 16 ? Array.from({ length: mag }, (_, i) => `<i class="${i < ammo ? 'on' : ''}"></i>`).join('') : '';
  const rl = av.reload, sw = av.swap;
  const sig = `${u.weapon?.id}|${ammo}|${mag}|${spare}|${other?.id}|${rl?.ok}|${sw?.ok}|${rl?.free}|${!!turnCtx}`;
  if (el._sig === sig) return;
  el._sig = sig;
  el.classList.remove('hidden');
  el.classList.toggle('low', low);
  el.classList.toggle('empty', !inf && ammo === 0);
  el.innerHTML = `<div class="wb-w"><small>${u.slot ? 'Secondary' : 'Primary'}</small><b>${esc(u.weapon?.name || '')}</b></div>
    <div class="wb-ammo">${inf ? '<b class="inf">∞</b>' : `<b>${ammo ?? '–'}</b><small>/${mag ?? '–'}</small>`}${pips ? `<span class="wb-pips${mag > 10 ? ' dense' : ''}">${pips}</span>` : ''}${!inf && Number.isFinite(spare) ? `<em>${spare} spare</em>` : ''}</div>
    ${rl ? `<button class="wb-btn${rl.ok ? '' : ' off'}${!inf && ammo === 0 ? ' urgent' : ''}" data-k="reload" title="${esc(rl.reason || 'Reload [R]')}">${ICON.reload}<span>Reload</span><small>${rl.free ? 'free' : '1 AP'}</small></button>` : ''}
    ${sw && other ? `<button class="wb-btn${sw.ok ? '' : ' off'}" data-k="swap" title="${esc(sw.reason || 'Swap weapon [X]')}">${ICON.swap}<span>${esc(other.name)}</span><small>free</small></button>` : ''}`;
  el.querySelectorAll('.wb-btn').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); const k = b.dataset.k; const a = av[k]; pressAction({ key: k, label: k === 'reload' ? 'Reload' : 'Swap', state: a?.ok ? 'on' : 'off', reason: a?.reason }); };
  });
}

/** The killstreak bar: progress to each streak, a ready glow, tap to call in / target. */
let lastReady = '';
function renderStreakBar(u) {
  const el = $('streakBar');
  const list = streakBar(u);
  if (!list.length) { el.classList.add('hidden'); return; }
  const pts = list[0]?.points ?? list[0]?.kills ?? u.kills ?? 0;
  const sig = JSON.stringify(list.map((s) => [s.key, s.ready, s.used, s.earned, s.cost, s.kills ?? s.points])) + (ui.streak?.key || '') + !!turnCtx;
  if (el._sig === sig) return;
  el._sig = sig;
  el.classList.remove('hidden');
  el.innerHTML = list.map((s) => {
    const have = s.points ?? s.kills ?? pts;
    const frac = Math.max(0, Math.min(1, have / Math.max(1, s.cost)));
    const st = s.used ? 'used' : s.ready ? 'ready' : s.earned ? 'earned' : 'locked';
    return `<button class="sk ${st}${ui.streak?.key === s.key ? ' active' : ''}" data-key="${esc(s.key)}" title="${esc(s.name)}: ${esc(s.reason || s.desc || '')}" style="--f:${frac}">
      <span class="sk-ring"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" class="trk"/><circle cx="18" cy="18" r="16" class="arc"/></svg><span class="sk-ic">${streakIcon(s.key)}</span></span>
      <span class="sk-t"><b>${esc(String(s.name || '').replace(/^Care Package$/i, 'Care Drop').replace(/^Counter-UAV$/i, 'C-UAV'))}</b><small>${s.used ? 'Used' : s.ready ? 'Ready' : `${Math.min(have, s.cost)}/${s.cost}`}</small></span></button>`;
  }).join('');
  el.querySelectorAll('.sk').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); const s = list.find((x) => x.key === b.dataset.key); if (s) pressStreak(s); }; });
  const ready = list.filter((s) => s.earned && !s.used).map((s) => s.key).join(',');
  if (ready && ready !== lastReady && !fastForward) {
    const s = list.find((x) => x.earned && !x.used && !lastReady.split(',').includes(x.key));
    if (s) { H.banner(`${s.name.toUpperCase()} READY`, 'streak', 'Tap it on the streak bar to call it in', 1500); sfx.streakReady?.(s.key); buzz('kill'); }
  }
  lastReady = ready;
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
    if (isMe(t)) {
      const ang = screenAngleTo(s.x, s.y);
      if (ev.result === 'miss') { if (ang !== null) H.damageDir(ang, 'miss', 0.4); return; }
      if (ang !== null) H.damageDir(ang, 'enemy', (ev.dmg || 1) / 5);
      H.edgeGlow('hurt', 700);
      buzz(ev.result === 'graze' ? 'graze' : 'hit');
    } else if (isMe(s) && ev.result !== 'miss') buzz('hitDealt');
    else if (t.team === mt && ev.result !== 'miss' && !fastForward) H.edgeGlow('mate', 500);
  } else if (ev.type === 'damage') {
    const t = st.units[ev.id];
    if (isMe(t)) {
      const src = lastAoe;
      const ang = src ? screenAngleTo(src.x, src.y) : null;
      if (ang !== null) H.damageDir(ang, 'blast', (ev.dmg || 1) / 4);
      H.edgeGlow('hurt', 700);
      buzz('explosion');
    }
  } else if (ev.type === 'zone_damage') {
    if (isMe(st.units[ev.id])) { H.edgeGlow('tide', 900); buzz('hit'); }
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
  if (!stats) return;
  // Medals, challenge stats and XP popups (5.0).
  if (!pitView || ev.type === 'redeploy') {
    const tr = tracker.feed(ev, { st, myId: myId(), myTeam: mt, standing, lastBlast, weaponId: matchLoadout?.primary?.id, dist: (a, b, e) => (Number.isFinite(e?.dist) ? e.dist : RU.dist(e?.fx ?? a.x, e?.fy ?? a.y, b.x, b.y)) });
    if (!ff) { for (const k of tr.medals) J.showMedal(k, sfx); if (tr.pops.length) J.xpPop(tr.pops); }
  }
  if (!ff && ev.type === 'shot' && ev.from === myId() && ev.result !== 'miss') { J.hitmarker(ev.result === 'graze' ? 'graze' : ev.headshot ? 'crit' : 'hit'); sfx.hitmarker(ev.result); }
  if (!ff && (ev.type === 'damage' || ev.type === 'knife_hit') && (ev.by ?? ev.from) === myId() && st.units[ev.id]?.team !== mt) J.hitmarker('hit');
  switch (ev.type) {
    case 'streak_ready': if (!ff && ev.id === myId()) queueHud(); break;
    case 'streak_used': {
      const u = st.units[ev.id];
      const d = AR.streakByKey(ev.key);
      if (u && !ff) {
        if (u.team === mt) H.banner(`${(d?.name || ev.key).toUpperCase()} INBOUND`, 'streak', isMe(u) ? 'Your killstreak is live' : `Called in by ${unitName(u)}`, 1500);
        else H.feedLine({ a: unitName(u), aColor: teamColor(u.team), icon: STREAK_ICON_KEY[ev.key] || 'bolt', note: `${d?.name || ev.key}`, kind: 'streak' });
        if (isMe(u)) { stats.streaks = Math.max(stats.streaks || 0, (tracker.streaks || 0)); buzz('kill'); }
      }
      queueHud();
      break;
    }
    case 'uav':
      if (!ff && ev.team !== mt) { H.toast('Enemy UAV overhead: you are on their map', 'warn', 'uav'); H.edgeGlow('scan', 900); }
      break;
    case 'airstrike_mark': {
      if (ff) break;
      const u = me();
      const near = u && (ev.tiles || []).some(([x, y]) => Math.max(Math.abs(x - u.x), Math.abs(y - u.y)) <= 1);
      const ownerTeam = st.units[ev.id ?? ev.owner]?.team;
      if (ownerTeam !== mt) H.banner('AIRSTRIKE INBOUND', 'bad', near ? 'You are on the line. Move before next round' : 'Stay off the red line next round', 1900);
      if (near) { buzz('downed'); H.edgeGlow('hurt', 1200); }
      break;
    }
    case 'care_package': if (!ff) H.feedInfo('Care package landing', 'signal'); break;
    case 'gunship_start': if (!ff && ev.team !== mt) H.banner('ENEMY GUNSHIP', 'bad', 'Stay in cover for the next 2 rounds', 1600); break;
    case 'pit_enter':
      if (ev.id === ctl?.myUnitId) { J.showPit({ phase: 'enter', mine: true, meName: callsign(), round: ctl?.state?.round }); sfx.pitTheme(true); }
      break;
    case 'redeploy':
      if (ev.id === ctl?.myUnitId) { H.banner('REDEPLOYED', 'heal', 'Back in the fight at 6 HP', 1800); sfx.redeploy(); buzz('revive'); H.edgeGlow('heal', 1200); stats.roundOut = null; Rcall('setSpectator', false); }
      break;
    case 'reload': if (!ff && isMe(st.units[ev.id])) queueHud(); break;
    case 'swap': if (!ff && isMe(st.units[ev.id])) queueHud(); break;
    case 'shot': {
      const s = st.units[ev.from], t = st.units[ev.to];
      lastCause[ev.to] = ev.reaction ? 'overwatch' : ev.ability === 'aimed' ? 'aimed' : 'shoot';
      if (isMe(s)) { stats.shots++; if (ev.result !== 'miss') { stats.hits++; stats.dmg += ev.dmg || 0; } }
      if (isMe(t) && ev.dmg) stats.taken += ev.dmg;
      break;
    }
    case 'grenade': case 'breach': lastAoe = { id: ev.id, x: ev.x, y: ev.y }; lastBlast = ev.type; break;
    case 'barrel_shot': {
      lastAoe = { id: ev.id, x: ev.x, y: ev.y };
      lastBlast = 'barrel';
      if (isMe(st.units[ev.id])) { stats.barrels++; stats.shots++; }
      break;
    }
    case 'barrel': {
      // Chains keep the original culprit; a barrel set off by a frag credits the thrower.
      lastAoe = { id: lastAoe?.id ?? null, x: ev.x, y: ev.y };
      lastBlast = 'barrel';
      if (!ff && tileVisible(ev.x, ev.y)) {
        const by = lastAoe.id !== null && lastAoe.id !== undefined ? st.units[lastAoe.id] : null;
        H.feedLine({ a: by ? unitName(by) : null, aMine: by?.team === mt, aColor: by ? teamColor(by.team) : null, icon: 'barrelx', note: 'barrel exploded', kind: 'barrel' });
      }
      break;
    }
    case 'flare': {
      const u = st.units[ev.id];
      if (ff || !u) { queueHud(); break; }
      if (isMe(u)) {
        H.banner('YOU\'RE LIT UP', 'bad', 'Your flare shows you to every squad until your next turn', 1800);
        H.edgeGlow('flare', 1200);
        buzz('hit');
      } else if (u.team === mt) H.toast(`${u.name} is flared: visible to everyone`, 'warn', 'flare');
      else H.feedLine({ a: unitName(u), aColor: teamColor(u.team), icon: 'flare', note: 'flared · visible', kind: 'flare' });
      queueHud();
      break;
    }
    case 'flare_end': {
      const u = st.units[ev.id];
      if (!ff && isMe(u) && u.alive) H.toast('Your flare burned out. Back in the dark', 'info', 'flare');
      queueHud();
      break;
    }
    case 'damage': {
      lastCause[ev.id] = ev.source === 'breach' ? 'breach' : ev.source === 'barrel' ? 'barrel' : 'grenade';
      const src = ev.by ?? ev.from ?? lastAoe?.id;
      if (src !== null && src !== undefined && isMe(st.units[src]) && st.units[ev.id]?.team !== mt) stats.dmg += ev.dmg || 0;
      if (isMe(st.units[ev.id])) stats.taken += ev.dmg || 0;
      break;
    }
    case 'zone_damage': lastCause[ev.id] = 'tide'; break;
    case 'downed': {
      const u = st.units[ev.id];
      const k = ev.by !== null && ev.by !== undefined ? st.units[ev.by] : null;
      if (isMe(k)) stats.downs++;
      if (ff) break;
      H.feedLine({ a: k ? unitName(k) : null, aMine: k?.team === mt, aColor: k ? teamColor(k.team) : null, icon: 'downed', b: unitName(u), bMine: u.team === mt, bColor: teamColor(u.team), note: k ? 'downed' : 'went down', kind: 'down' });
      if (isMe(u)) {
        // The 'downed' stinger + sfx come from render.js (_evDowned) with the animation.
        H.banner('YOU\'RE DOWN', 'bad', `Bleed out in ${u.bleed ?? 2} turns · a squadmate can revive you`, 2200);
        buzz('downed');
        H.edgeGlow('hurt', 1600);
      } else if (u.team === mt) {
        H.banner(`${u.name.toUpperCase()} IS DOWN`, 'down', playerUp() ? 'Get next to them and revive' : 'Hold on', 1700);
        buzz('downed');
      } else if (isMe(k)) {
        H.toast(`You downed ${u.name}. Finish them before they're revived`, 'kill', 'downed');
        buzz('kill');
      }
      break;
    }
    case 'revive': {
      const u = st.units[ev.id];
      const by = ev.by !== undefined && ev.by !== null ? st.units[ev.by] : null;
      if (isMe(by)) stats.revives++;
      if (ff) break;
      if (u.team === mt || unitVisible(u)) H.feedLine({ a: by ? unitName(by) : null, aMine: by?.team === mt, aColor: by ? teamColor(by.team) : null, icon: 'revive', b: unitName(u), bMine: u.team === mt, bColor: teamColor(u.team), note: 'revived', kind: 'revive' });
      if (isMe(u)) { H.banner('BACK IN THE FIGHT', 'heal', `${by ? by.name : 'A squadmate'} got you up · ${ev.hp ?? u.hp} HP`, 1700); H.edgeGlow('heal', 1200); buzz('revive'); }
      else if (u.team === mt) { H.toast(`${u.name} is back up${isMe(by) ? '. Nice save' : ''} · ${ev.hp ?? u.hp} HP`, 'heal', 'revive'); buzz('revive'); }
      else if (unitVisible(u)) H.toast(`Squad ${u.team + 1} revived ${u.name}`, 'warn', 'revive');
      break;
    }
    case 'bleed_out': {
      lastCause[ev.id] = 'bleed';
      const u = st.units[ev.id];
      if (!ff && u.team === mt && !isMe(u)) H.toast(`${u.name} bled out`, 'error', 'bleed');
      break;
    }
    case 'patch': {
      const m = st.units[ev.id], t = st.units[ev.target];
      if (isMe(m)) stats.patched += ev.amount || 0;
      if (ff || !t) break;
      if (t.team === mt && !t.downed && ev.amount) {
        if (isMe(t)) H.edgeGlow('heal', 900);
        if (isMe(m) || isMe(t)) H.toast(`${isMe(t) ? 'You' : t.name} +${ev.amount} HP`, 'heal', 'patch');
        else H.feedLine({ a: m.name, aMine: true, icon: 'patch', b: t.id === m.id ? 'self' : t.name, bMine: true, note: `+${ev.amount}`, kind: 'revive' });
      }
      break;
    }
    case 'scan': {
      const s = st.units[ev.id];
      const n = (ev.revealed || []).length;
      if (isMe(s)) stats.scans++;
      if (ff) break;
      if (s?.team === mt) {
        H.feedLine({ a: unitName(s), aMine: true, icon: 'scan', note: `${n} contact${n === 1 ? '' : 's'} revealed`, kind: 'scan' });
        if (isMe(s)) H.toast(n ? `Scan: ${n} contact${n === 1 ? '' : 's'} revealed until your next turn` : 'Scan: area clear', 'loot', 'scan');
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
      if (!ff && (s?.team === mt || tileVisible(ev.x, ev.y))) H.feedLine({ a: s ? unitName(s) : null, aMine: s?.team === mt, aColor: s ? teamColor(s.team) : null, icon: 'smoke', note: 'smoke screen', kind: 'smoke' });
      queueHud();
      break;
    }
    case 'smoke_clear': queueHud(); break;
    case 'death': {
      const u = st.units[ev.id];
      const k = ev.by !== null && ev.by !== undefined ? st.units[ev.by] : null;
      lastKillerTeam = k ? k.team : null;
      if (isMe(k) && k.team !== u.team) stats.kills++;
      if (k && k.team === mt && u.team !== mt) stats.squadKills++;
      if (!ff) {
        const cause = lastCause[ev.id] === 'bleed' ? 'bleed' : k ? (lastCause[ev.id] || 'shoot') : (lastCause[ev.id] || 'tide');
        H.feedKill({
          killer: k ? unitName(k) : null,
          victim: unitName(u),
          cause,
          killerMine: k?.team === mt, victimMine: u.team === mt,
          killerColor: k ? teamColor(k.team) : null, victimColor: teamColor(u.team),
        });
        if (isMe(k) && u.team !== mt) { J.killConfirm(unitName(u), tracker.turnKills >= 2 ? `${tracker.turnKills} kills this turn` : 'Eliminated'); J.hitmarker('kill'); sfx.killConfirm(); buzz('kill'); }
      }
      if (isMe(u) && pitView) break; // lost the Pit duel: keep the main-match death (round, killer) for the end screen
      if (isMe(u)) {
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
        H.feedLine({ a: `Squad ${ev.team + 1}`, aColor: teamColor(ev.team), icon: 'squads', note: `eliminated · #${ev.place}`, kind: 'out' });
        if (lastKillerTeam === mt && st.winner === null) H.banner('SQUAD ELIMINATED', 'kill', `${G.aliveTeams(st).length} squads left`, 1300);
      }
      break;
    case 'crate': {
      const u = st.units[ev.id];
      if (u.team === mt && !ff) {
        const label = (K.CRATE_LABEL && K.CRATE_LABEL[ev.item]) || ev.item;
        H.toast(`${isMe(u) ? '' : u.name + ': '}${label}`, 'loot', ev.item === 'frag' ? 'grenade' : ev.item === 'smoke' ? 'smoke' : 'crate');
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
      if (!ff && st.units[ev.target]?.team === mt) H.toast(`Overwatch fire on ${unitName(st.units[ev.target])}!`, 'warn', 'overwatch');
      break;
    case 'zone_shrink': {
      if (!ff) sfx.stinger('tide');
      updateAmbience();
      const cx = ev.x ?? st.zone.x, cy = ev.y ?? st.zone.y;
      const moved = zoneCenter && Math.hypot(cx - zoneCenter.x, cy - zoneCenter.y) > 0.5;
      const nz = nextZone(st.zone);
      const drifting = moved || Math.hypot(nz.x - st.zone.x, nz.y - st.zone.y) > 0.5;
      zoneCenter = { x: cx, y: cy };
      const u = me();
      const outN = u?.alive && !insideNext(u.x, u.y);
      if (!ff) {
        if (drifting) {
          H.banner('THE ZONE DRIFTS', 'tide', outN ? 'The next ring is moving away from you. Rotate now' : 'Follow the cyan ring on the minimap', 2000);
          H.feedInfo('Safe zone drifting', 'signal');
        } else H.banner('THE TIDE RISES', 'tide', `Safe radius ${ev.r} · next ${typeof ev.next === 'number' ? ev.next : nz.r}`, 1800);
      }
      queueHud();
      break;
    }
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
  const u = ctl?.state?.units?.[ctl.myUnitId] || me();
  if (!u) return null;
  const total = (ctl?.state || state).teams.length;
  const won = place === 1;
  try {
    stats.award = M.awardMatch({ cls: u.cls, place, total, kills: u.kills, damage: stats.dmg, revives: stats.revives });
  } catch (e) { warnOnce('awardMatch', e); }
  const medals = tracker.finish({ won, hp: u.alive ? u.hp : 0 });
  stats.medals = medals;
  try {
    stats.award5 = P.awardMatch5({
      cls: u.cls, place, total, won, kills: u.kills || 0, dmg: stats.dmg, revives: stats.revives,
      rounds: stats.roundOut ?? (ctl?.state || state).round, medals, weaponId: matchLoadout?.primary?.id,
      wstats: { ...tracker.w }, // primary-weapon tallies from the event stream (juice.js tracker) streaks: tracker.streaks || stats.streaks || 0, lethalKills: tracker.lethalKills,
    });
  } catch (e) { warnOnce('awardMatch5', e); }
  return recordMatch({
    mode: state.mode, cls: u.cls, place, total,
    kills: u.kills, damage: stats.dmg, revives: stats.revives, rounds: stats.roundOut ?? state.round,
  });
}

function onMatchEnd(summary = {}, token) {
  if (summary.reason && summary.reason !== 'over' && summary.place === null && summary.winner === null) {
    // Host left / connection lost before the end.
    H.toast(summary.msg || 'The match ended early.', 'error', 'link');
  }
  if (Number.isInteger(summary.place)) playerPlace = summary.place;
  pitView = null;
  state = ctl?.state || state;
  turnCtx = null;
  activeTeams = [];
  updateHud();
  showEnd(token, summary);
}

function showEnd(token, summary = {}) {
  const u = ctl?.state?.units?.[ctl.myUnitId] || me();
  if (!u || !state) return;
  const mt = ctl ? ctl.myTeam : myTeam();
  // Host left / connection lost: no placement, no career record, no XP.
  const aborted = !!summary.reason && summary.reason !== 'over';
  const won = !aborted && state.winner === mt;
  const total = state.teams.length;
  const place = won ? 1 : (playerPlace ?? summary.place ?? total);
  if (aborted) { showAborted(token, summary, u); return; }
  const rec = recordCareer(place);
  if (won || !stats.defeatPlayed) sfx.stinger(won ? 'victory' : 'defeat');
  sfx.setIntensity(0.15);
  allowSleep();
  if (won) buzz('win');
  if (!fastForward) H.banner(won ? '#1 LAST SQUAD STANDING' : `#${place} OF ${total}`, won ? 'win' : 'bad', '', 1800);
  const rounds = stats.roundOut ?? state.round;
  const acc = stats.shots ? Math.round((stats.hits / stats.shots) * 100) + '%' : '-';
  const st = curStage();
  $('endKicker').innerHTML = `<span>${esc(callsign())}</span><span>${MODES[state.mode]?.name || state.mode}</span><span>${esc(AR.CLASSES[u.cls]?.name || u.cls)}</span>${st ? `<span>${esc(st.name)}</span>` : ''}`;
  $('endBanner').innerHTML = cardSVG(P.equippedCard(), { name: callsign(), emblem: P.equippedEmblem(), level: P.player().level, sub: won ? 'WINNER' : `PLACED #${place}`, w: 640 });
  $('endPlace').innerHTML = `<span class="hash">#</span>${place}<small>/${total}</small>`;
  $('endPlace').className = 'end-place' + (won ? ' win' : place <= 3 ? ' top' : '');
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
  const team = MODES[state.mode]?.teamSize > 1;
  $('endStats').innerHTML = [
    stat('skull', u.kills, 'Kills'),
    stat('burst', stats.dmg, 'Damage'),
    stat('clock', rounds, 'Rounds'),
    stat('shoot', acc, 'Accuracy'),
    team ? (stats.revives || u.cls === 'medic' ? stat('revive', stats.revives, 'Revives') : stat('squads', stats.squadKills, 'Squad kills')) : stat('heart', stats.taken, 'Taken'),
    stat('bolt', tracker.streaks || stats.streaks || 0, 'Streaks'),
  ].join('');
  // medals earned this match
  const counts = {};
  for (const k of stats.medals || []) counts[k] = (counts[k] || 0) + 1;
  const mk = Object.keys(counts);
  $('endMedals').innerHTML = mk.length ? `<div class="em-h">Medals<small>${(stats.medals || []).length}</small></div><div class="em-row">${mk.map((k, i) => `<div class="em-m t${P.MEDALS[k].tier}" style="--i:${i}">${medalArt(k, P.MEDALS[k].tier, 46)}<b>${esc(P.MEDALS[k].name)}</b>${counts[k] > 1 ? `<em>×${counts[k]}</em>` : ''}</div>`).join('')}</div>` : '';
  renderEndXp(stats.award5);
  const c = career();
  const flags = [];
  if (rec?.firstWin) flags.push(`<span class="ec-flag win">${ICON.trophy}First win</span>`);
  else if (rec?.newBest && c.matches > 1) flags.push(`<span class="ec-flag">${ICON.medal}New personal best</span>`);
  if (c.streak > 1) flags.push(`<span class="ec-flag">${ICON.bolt}${c.streak} win streak</span>`);
  $('endCareer').innerHTML = `${flags.join('')}<span class="ec-line">Career · ${c.wins} win${c.wins === 1 ? '' : 's'} · ${c.kills} kill${c.kills === 1 ? '' : 's'} · ${c.matches} match${c.matches === 1 ? '' : 'es'} · best #${c.best || '–'}</span>`;
  $('specBar').classList.add('hidden');
  const award = stats.award;
  renderEndPrestige(award);
  $('endShopSalv').innerHTML = `${ICON.coin}${M.salvage().toLocaleString('en-US')}`;
  $('loadoutBtn').textContent = onlineCfg?.lobby ? 'Back to lobby' : 'Back to hub';
  $('againBtn').querySelector('span').textContent = onlineCfg ? 'Back to lobby' : 'Play again';
  clearTimeout(endTimer);
  endTimer = setTimeout(() => {
    if (token !== gameToken || !state) return; // left the match meanwhile
    turnCtx = null;
    document.body.classList.add('ended');
    const es = $('endScreen');
    es.classList.remove('hidden');
    es.scrollTop = 0;
    requestAnimationFrame(() => {
      es.classList.add('open');
      $('againBtn').focus({ preventScroll: true });
      animateEndXp(stats.award5, token);
      animateEndPrestige(award, token);
    });
  }, fastForward ? 0 : 1500);
}

/** The match ended early (host left, connection lost): a clean result with nothing recorded. */
function showAborted(token, summary, u) {
  if (stats) stats.recorded = true; // never record this match later
  sfx.setIntensity(0.15);
  allowSleep();
  const host = summary.reason === 'host_left';
  const st = curStage();
  $('endKicker').innerHTML = `<span>${esc(callsign())}</span><span>${MODES[state.mode]?.name || state.mode}</span><span>${esc(AR.CLASSES[u.cls]?.name || u.cls)}</span>${st ? `<span>${esc(st.name)}</span>` : ''}`;
  $('endBanner').innerHTML = cardSVG(P.equippedCard(), { name: callsign(), emblem: P.equippedEmblem(), level: P.player().level, sub: 'MATCH ENDED', w: 640 });
  $('endPlace').innerHTML = '<span class="hash">–</span>';
  $('endPlace').className = 'end-place';
  $('endTitle').textContent = host ? 'HOST LEFT' : summary.reason === 'lost' ? 'CONNECTION LOST' : 'MATCH ENDED';
  $('endTitle').className = '';
  $('endSub').textContent = (summary.msg || (host ? 'The host left the match.' : 'The connection to the match was lost.')) + ' Nothing was recorded.';
  for (const id of ['endStats', 'endMedals', 'endXp', 'endPrestige', 'endChallenges', 'endCareer']) $(id).innerHTML = '';
  $('specBar').classList.add('hidden');
  $('endShopSalv').innerHTML = `${ICON.coin}${M.salvage().toLocaleString('en-US')}`;
  $('loadoutBtn').textContent = onlineCfg?.lobby ? 'Back to lobby' : 'Back to hub';
  $('againBtn').querySelector('span').textContent = onlineCfg ? 'Back to lobby' : 'Back to hub';
  clearTimeout(endTimer);
  endTimer = setTimeout(() => {
    if (token !== gameToken || !state) return;
    turnCtx = null;
    document.body.classList.add('ended');
    const es = $('endScreen');
    es.classList.remove('hidden');
    es.scrollTop = 0;
    requestAnimationFrame(() => { es.classList.add('open'); $('againBtn').focus({ preventScroll: true }); });
  }, 300);
}

// ----- player / weapon XP, challenges, camos and Salvage on the end screen

function xpRow(id, icon, title, sub, before, after, gain, extra = '') {
  return `<div class="ex-row" id="${id}"><span class="ex-ic">${icon}</span><div class="ex-main">
    <div class="ex-h"><b>${title}</b><span class="ex-lv"><small>LV</small><em>${before.level}</em></span><span class="ex-gain">+${gain.toLocaleString('en-US')} XP</span></div>
    <div class="xpbar big"><i style="--w:${Math.round(before.frac * 100)}%"></i></div><small class="ex-sub">${sub}</small>${extra}</div></div>`;
}
function renderEndXp(a) {
  const el = $('endXp');
  if (!a) { el.innerHTML = ''; $('endChallenges').innerHTML = ''; return; }
  const w = a.weapon;
  const wd = w ? AR.weaponById(w.id) : null;
  const parts = a.player.parts.map(([k, v]) => `<span class="ep-chip">${esc(k)}<b>+${v.toLocaleString('en-US')}</b></span>`).join('');
  const salv = stats.award?.salvage;
  const salvTotal = (salv?.total || 0) + (a.dailySalvage || 0);
  el.innerHTML = `
    ${xpRow('exPlayer', emblemSVG(P.equippedEmblem(), 40), 'Player level', a.player.after.next === null ? 'Max level' : `${a.player.after.toNext.toLocaleString('en-US')} XP to level ${a.player.after.level + 1}`, a.player.before, a.player.after, a.player.xp)}
    ${w ? xpRow('exWeapon', `<span class="ex-w">${ICON.rifle}</span>`, esc(wd?.name || w.id), w.after.next === null ? 'Max weapon level' : `${w.after.toNext.toLocaleString('en-US')} XP to level ${w.after.level + 1}`, w.before, w.after, w.xp, w.unlocked.length ? `<div class="ex-unl">${w.unlocked.map((id) => `<span>${ICON.lock}${esc(AR.attachmentById(id)?.name || id)}</span>`).join('')}</div>` : '') : ''}
    <div class="ep-chips">${parts}</div>
    <div class="ex-salv"><span class="ex-sv">${ICON.coin}<b data-count="${salvTotal}">0</b><small>Salvage</small></span>${(salv?.parts || []).concat(a.dailySalvage ? [['Daily challenges', a.dailySalvage]] : []).map(([k, v]) => `<span class="ep-chip">${esc(k)}<b>+${v}</b></span>`).join('')}<span class="ep-bal">Balance ${M.salvage().toLocaleString('en-US')}</span></div>`;
  // challenges: dailies + camo progress + new camos / cards
  const ch = [];
  for (const d of a.daily || []) {
    if (d.after === d.before && !d.justDone) continue;
    ch.push(`<div class="ec-c${d.done ? ' done' : ''}"><span class="ec-ic">${d.done ? ICON.check : ICON.calendar}</span><div><b>${esc(d.label)}</b><span class="xpbar sm"><i style="--w:${Math.round((d.before / d.n) * 100)}%" data-to="${Math.round((d.after / d.n) * 100)}"></i></span></div><small>${d.after}/${d.n}${d.justDone ? ` · +${d.xp} XP` : ''}</small></div>`);
  }
  if (w?.challenges) {
    for (const c of w.challenges) {
      if (c.done && !a.camos.some((x) => x.camo.id === c.camo.id)) continue;
      const pct = Math.round((c.have / c.n) * 100);
      if (!pct) continue;
      ch.push(`<div class="ec-c camo${c.done ? ' done' : ''}"><span class="ec-sw" style="--c1:${c.camo.colors[0]};--c2:${c.camo.colors[1]}"></span><div><b>${esc(c.camo.name)} camo</b><span class="xpbar sm"><i style="--w:${pct}%"></i></span></div><small>${esc(c.label)} · ${c.have}/${c.n}</small></div>`);
      if (ch.length > 7) break;
    }
  }
  const unl = [
    ...a.camos.map((x) => `<div class="ec-u camo"><span class="ec-sw big${x.camo.animated ? ' anim' : ''}" style="--c1:${x.camo.colors[0]};--c2:${x.camo.colors[1]};--c3:${x.camo.colors[2] || x.camo.colors[0]}"></span><b>${esc(x.camo.name)}</b><small>Camo · ${esc(AR.weaponById(x.weapon)?.name || '')}</small></div>`),
    ...a.unlocks.map((x) => `<div class="ec-u">${x.kind === 'card' ? cardSVG(x.id, { w: 150, animated: false }) : emblemSVG(x.id, 52)}<b>New ${x.kind === 'card' ? 'calling card' : 'emblem'}</b></div>`),
  ];
  $('endChallenges').innerHTML = (unl.length ? `<div class="em-h">Unlocked<small>${unl.length}</small></div><div class="ec-unl">${unl.join('')}</div>` : '')
    + (ch.length ? `<div class="em-h">Challenges</div><div class="ec-list">${ch.join('')}</div>` : '');
}
function animateEndXp(a, token) {
  if (!a) return;
  const fill = (id, info, levelUps, onLevel) => {
    const row = $(id);
    if (!row) return;
    const bar = row.querySelector('.xpbar i');
    const lv = row.querySelector('.ex-lv em');
    let shown = info.before.level;
    const step = () => {
      if (token !== gameToken) return;
      if (shown < info.after.level) {
        bar.style.setProperty('--w', '100%');
        later(() => {
          shown++;
          lv.textContent = shown;
          row.classList.remove('lvup'); void row.offsetWidth; row.classList.add('lvup');
          onLevel?.(shown);
          bar.style.transition = 'none'; bar.style.setProperty('--w', '0%'); void bar.offsetWidth; bar.style.transition = '';
          later(step, 80);
        }, 950);
      } else bar.style.setProperty('--w', `${Math.round(info.after.frac * 100)}%`);
    };
    later(step, 500);
  };
  fill('exPlayer', a.player, a.player.levelUps, (lv) => { sfx.levelUp(); buzz('win'); if (lv === a.player.after.level) queueLevelUp({ kind: 'player', level: lv }); });
  if (a.weapon) fill('exWeapon', a.weapon, 0, (lv) => { sfx.rankUp(); if (lv === a.weapon.after.level && a.weapon.unlocked.length) queueLevelUp({ kind: 'weapon', level: lv, weapon: a.weapon }); });
  for (const c of a.camos) queueLevelUp({ kind: 'camo', camo: c });
  // Salvage tally counts up.
  const sv = $('endXp').querySelector('[data-count]');
  if (sv) {
    const to = Number(sv.dataset.count) || 0;
    const t0 = performance.now();
    const tick = () => { if (token !== gameToken) return; const f = Math.min(1, (performance.now() - t0) / 1200); sv.textContent = Math.round(to * (1 - (1 - f) ** 3)).toLocaleString('en-US'); if (f < 1) requestAnimationFrame(tick); };
    later(() => { requestAnimationFrame(tick); sfx.coins?.(); }, 700);
  }
  later(() => { $('endChallenges').querySelectorAll('.xpbar i[data-to]').forEach((i) => i.style.setProperty('--w', i.dataset.to + '%')); }, 900);
}

/** Level-up / weapon-level / camo celebrations, one after another. */
function queueLevelUp(item) {
  const show = () => showLevelUp(item);
  if ($('levelUp').classList.contains('hidden') && $('tierUp').classList.contains('hidden')) show(); else levelQueue.push(show);
}
function showLevelUp(it) {
  const el = $('levelUp');
  if (it.kind === 'player') {
    $('luKick').textContent = 'Level up';
    $('luBadge').innerHTML = `<div class="lu-num"><small>Level</small><b>${it.level}</b></div>`;
    $('luName').textContent = `LEVEL ${it.level}`;
    $('luName').className = 'tu-name t3';
    const cards = CARDS_AT(it.level);
    $('luSub').textContent = cards.length ? 'New rewards unlocked.' : `${(P.levelNeed(it.level)).toLocaleString('en-US')} XP to the next level.`;
    $('luRewards').innerHTML = cards.join('');
  } else if (it.kind === 'weapon') {
    const wd = AR.weaponById(it.weapon.id);
    $('luKick').textContent = `${wd?.name || ''} · weapon level`;
    $('luBadge').innerHTML = `<div class="lu-w">${hub.weaponArt(it.weapon.id, {}, { w: 260 })}</div>`;
    $('luName').textContent = `LEVEL ${it.level}`;
    $('luName').className = 'tu-name t2';
    $('luSub').textContent = 'New attachments in the Gunsmith:';
    $('luRewards').innerHTML = it.weapon.unlocked.map((id) => `<span class="lu-r">${ICON.gear}${esc(AR.attachmentById(id)?.name || id)}</span>`).join('');
  } else {
    const c = it.camo.camo;
    $('luKick').textContent = `${AR.weaponById(it.camo.weapon)?.name || ''} · camo unlocked`;
    $('luBadge').innerHTML = `<span class="lu-camo${c.animated ? ' anim' : ''}" style="--c1:${c.colors[0]};--c2:${c.colors[1]};--c3:${c.colors[2] || c.colors[0]}"></span>`;
    $('luName').textContent = c.name.toUpperCase();
    $('luName').className = 'tu-name ' + (c.id === 'gold' ? 't3' : c.id === 'diamond' || c.id === 'tidal' ? 't4' : 't1');
    $('luSub').textContent = c.id === 'gold' ? 'Every camo on this weapon. Gold looks good on you.' : c.id === 'diamond' ? 'Five Gold weapons. Diamond unlocked.' : c.id === 'tidal' ? 'The Tidal camo. Animated. Earned.' : 'Equip it in the Armory.';
    $('luRewards').innerHTML = '';
    sfx.camoUnlock();
  }
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('open'));
  if (it.kind === 'player') sfx.stinger('victory');
  buzz('win');
  setTimeout(() => $('luOk').focus({ preventScroll: true }), 300);
}
function CARDS_AT(level) {
  const out = [];
  for (const c of CARDS) if (c.unlock?.kind === 'level' && c.unlock.level === level) out.push(`<div class="lu-card">${cardSVG(c.id, { w: 240, animated: false })}<small>Calling card · ${esc(c.name)}</small></div>`);
  for (const e of EMBLEMS) if (e.unlock?.kind === 'level' && e.unlock.level === level) out.push(`<div class="lu-card em">${emblemSVG(e.id, 56)}<small>Emblem · ${esc(e.name)}</small></div>`);
  return out;
}

// ----- prestige + Salvage on the end screen

function xpLine(P) {
  return P.next === null ? `${P.xp.toLocaleString('en-US')} XP · max tier` : `${P.xp.toLocaleString('en-US')} / ${P.next.toLocaleString('en-US')} XP · ${P.toNext.toLocaleString('en-US')} to ${M.TIER_NAMES[P.tier + 1]}`;
}
function renderEndPrestige(a) {
  const el = $('endPrestige');
  if (!a) { el.innerHTML = ''; return; }
  const b = a.before;
  const chips = (parts) => parts.map(([k, v]) => `<span class="ep-chip">${esc(k)}<b>+${v.toLocaleString('en-US')}</b></span>`).join('');
  el.innerHTML = `
    <div class="ep-row">
      <div class="ep-badge" id="epBadge">${badgeSVG(a.cls, b.tier, { size: 72 })}</div>
      <div class="ep-main">
        <div class="ep-h"><b>${esc(CLASSES[a.cls]?.name || a.cls)} · <span id="epTier" class="t${b.tier}">${b.name}</span></b><span class="ep-gain">+${a.xp.total.toLocaleString('en-US')} XP</span></div>
        <div class="xpbar big"><i id="epFill" style="--w:${Math.round(b.frac * 100)}%"></i></div>
        <small id="epLine" class="ep-line">${xpLine(b)}</small>
      </div>
    </div>
    <div class="ep-chips">${chips(a.xp.parts)}</div>
    <div class="ep-salv"><span class="ep-sv">${ICON.coin}<b>+${a.salvage.total.toLocaleString('en-US')}</b> Salvage</span><span class="ep-bal">Balance ${a.salvage.balance.toLocaleString('en-US')}</span></div>`;
}
function animateEndPrestige(a, token) {
  if (!a) return;
  const fill = $('epFill');
  if (!fill) return;
  const step2 = () => {
    if (token !== gameToken) return;
    // Land on the new tier's progress and swap the badge.
    fill.style.transition = 'none';
    fill.style.setProperty('--w', '0%');
    void fill.offsetWidth;
    fill.style.transition = '';
    $('epBadge').innerHTML = badgeSVG(a.cls, a.after.tier, { size: 72 });
    $('epBadge').classList.add('up');
    $('epTier').textContent = a.after.name;
    $('epTier').className = 't' + a.after.tier;
    requestAnimationFrame(() => fill.style.setProperty('--w', `${Math.round(a.after.frac * 100)}%`));
    $('epLine').textContent = xpLine(a.after);
  };
  setTimeout(() => {
    if (token !== gameToken) return;
    if (a.tierUp) {
      fill.style.setProperty('--w', '100%');
      later(() => { step2(); showTierUp(a); }, 1100);
    } else {
      fill.style.setProperty('--w', `${Math.round(a.after.frac * 100)}%`);
      $('epLine').textContent = xpLine(a.after);
    }
  }, 450);
}
function showTierUp(a) {
  if (!$('levelUp').classList.contains('hidden')) { levelQueue.push(() => showTierUp(a)); return; }
  const el = $('tierUp');
  $('tuClass').textContent = CLASSES[a.cls]?.name || a.cls;
  $('tuBadge').innerHTML = badgeSVG(a.cls, a.after.tier, { size: 190, animated: true });
  $('tuName').textContent = a.after.name;
  $('tuName').className = 'tu-name t' + a.after.tier;
  $('tuSub').textContent = a.after.tier >= 4 ? 'The highest honour. Your badge is now a living legend.' : `Your ${CLASSES[a.cls]?.name || a.cls} badge evolves. Next: ${M.TIER_NAMES[a.after.tier + 1]} at ${a.after.next.toLocaleString('en-US')} XP.`;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('open'));
  sfx.stinger('victory');
  buzz('win');
  clearTimeout(tierUpT);
  tierUpT = setTimeout(() => $('tuOk').focus({ preventScroll: true }), 300);
}
function closeLevelUp(instant = false) {
  const el = $('levelUp');
  if (!el || el.classList.contains('hidden')) return;
  el.classList.remove('open');
  if (instant) el.classList.add('hidden'); else setTimeout(() => el.classList.add('hidden'), 300);
  const next = levelQueue.shift();
  if (next && !instant) setTimeout(next, 360);
  else if (!instant) $('againBtn')?.focus({ preventScroll: true });
}
const levelQueue = [];
function closeTierUp(instant = false) {
  const el = $('tierUp');
  if (!el || el.classList.contains('hidden')) return;
  clearTimeout(tierUpT);
  el.classList.remove('open');
  if (instant) el.classList.add('hidden');
  else tierUpT = setTimeout(() => el.classList.add('hidden'), 300);
  const next = !instant && levelQueue.shift();
  if (next) setTimeout(next, 360);
  else if (!instant) $('againBtn')?.focus({ preventScroll: true });
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
    me: () => me(),
    pitView: () => pitView,
    tap: (x, y) => { onTileTap(x, y); return ui.pending ? ui.pending.kind + (ui.pending.boat ? ':' + ui.pending.boat : '') : ui.mode; },
    press: (key) => { const a = standing(me()) ? actionList(me()).list.find((x) => x.key === key) : null; if (!a) return 'none'; pressAction(a); return a.state === 'off' ? 'off: ' + a.reason : ui.mode; },
    streakBar: () => streakBar(me()).map((s) => `${s.key}:${s.ready ? 'ready' : s.reason}`),
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
      const m = state?.teams[myTeam()].members.map((id) => state.units[id]).find((x) => !isMe(x) && standing(x));
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
      if (!playerAlive()) { ctl?.fastForward?.(); fastForward = true; return 'fast-forward'; }
      return 'waiting';
    },
    fastForward: () => { ctl?.fastForward?.(); fastForward = true; },
    get ctl() { return ctl; },
    tracker,
    progress: P,
    arsenal: AR,
    hub, menu,
    page: (p) => { menu.setPage(p); return p; },
    streak: (key) => { const s = streakBar(me()).find((x) => x.key === key) || streakBar(me())[0]; if (!s) return 'none'; pressStreak({ ...s, ready: true }); return ui.mode; },
    equip: (slot = 'lethal') => { const a = actionList(me()).list.find((x) => x.key === slot); if (!a) return 'none'; pressAction(a); return ui.mode; },
    endScreen: () => { const st = ctl?.state; if (!st) return 'no match'; playerPlace = 3; showEnd(gameToken, { place: 3 }); return 'ok'; },
    levelUp: (kind = 'player') => { queueLevelUp(kind === 'player' ? { kind, level: P.player().level } : { kind: 'camo', camo: { weapon: 'tr7', camo: P.MASTERY.gold } }); return 'ok'; },
    pit: (phase = 'start') => { J.showPit({ phase, mine: true, meName: callsign(), foeName: 'KESTREL-09', won: true, round: 4 }); return 'ok'; },
    medal: (k = 'double_kill') => { J.showMedal(k, sfx); J.xpPop([['KILL', 100, 'kill'], ['FLANK', 50]]); J.hitmarker('kill'); J.killConfirm('VEX-31'); return 'ok'; },
    meta: M,
    shop,
    coverFade: () => coverFadeOn,
    stage: () => state?.stage,
    grant: (n = 5000) => { const v = M._debugGrant(n); menu.refreshMeta(); return v; },
    xp: (cls, n) => { const p = M._debugXp(cls, n); menu.refreshMeta(); return p; },
    /** Debug only: aim at the best barrel, if any. */
    barrel() {
      if (!turnCtx) return 'not my turn';
      const b = barrelTargetList(turnCtx.u)[0];
      if (!b) return 'no barrel';
      setMode('shoot');
      if (ui.mode !== 'shoot') return 'shoot unavailable';
      selectTarget(b.id);
      return `barrel ${b.x},${b.y} hits ${b.pv.units.length}`;
    },
    /** Debug only: move the player onto the nearest tile of a terrain type (1 kelp, 2 shallows). */
    toTerrain(v = 1) {
      const u = me(); const S = state.map.size; let best = null;
      state.map.terrain?.forEach((t, k) => { if (t !== v || state.map.cover[k] || unitAt(k % S, (k / S) | 0)) return; const d = RU.dist(u.x, u.y, k % S, (k / S) | 0); if (!best || d < best.d) best = { k, d }; });
      if (!best) return 'none';
      u.x = best.k % S; u.y = (best.k / S) | 0;
      Rcall('syncFromState'); Rcall('focus', u.x, u.y);
      if (turnCtx) setMode('move'); else updateHud();
      return `at ${u.x},${u.y}`;
    },
    tierUp: (cls = 'assault', t = 2) => { const P = M.classProgress(cls); showTierUp({ cls, after: { ...P, tier: t, name: M.TIER_NAMES[t], next: M.TIER_XP[t + 1] ?? null } }); return 'ok'; },
  };
}
