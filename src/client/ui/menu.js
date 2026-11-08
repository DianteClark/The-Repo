// Front end shell: animated title → hub (Play · Barracks · Armory · Store ·
// Career) with a pinned Deploy footer, plus the settings / transfer / how-to /
// tutorial sheets. Pure DOM; main.js owns the match and passes callbacks in.
// The Barracks, Armory, Store and Career pages render themselves (their own
// modules) when the hub switches to them via onPage(page, el).

import { ICON } from './icons.js';
import { settings } from './settings.js';
import { career, resetCareer } from './career.js';
import { hapticsSupported, buzz } from './haptics.js';
import { badgeSVG } from './badges.js';
import * as P from './progress.js';
import { setColorPreset } from './squads.js';
import * as M from './meta.js';
import { stageList, stageArt, stageIcon } from './stages.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const MODE_INFO = {
  solos: { line: '16 × 1', desc: 'Every soldier for themselves.' },
  duos: { line: '8 × 2', desc: 'You plus one bot partner. Revives on.' },
  trios: { line: '5 × 3 + Wolf', desc: 'Five trios and one Lone Wolf. Revives on.' },
  quads: { line: '4 × 4', desc: 'Four full squads collide. Revives on.' },
};

function squadGlyph(mode, teamSize) {
  const groups = [];
  const full = Math.floor(16 / teamSize);
  for (let i = 0; i < full; i++) groups.push(teamSize);
  if (16 - full * teamSize) groups.push(16 - full * teamSize);
  return `<span class="glyph">${groups.map((n, gi) =>
    `<span class="g${gi === 0 ? ' you' : ''}${mode === 'trios' && n === 1 ? ' wolf' : ''}">${'<i></i>'.repeat(n)}</span>`).join('')}</span>`;
}

export function randomCallsign(K) {
  const pool = K?.CALLSIGNS?.length ? K.CALLSIGNS : ['Rook', 'Vex', 'Salt', 'Kestrel', 'Brine', 'Mako', 'Tern', 'Gale'];
  const n = pool[Math.floor(Math.random() * pool.length)];
  return `${n}-${String(Math.floor(Math.random() * 90) + 10)}`.toUpperCase();
}
export const cleanCallsign = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ._-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);

// ------------------------------------------------------------------ menu

export const PAGES = ['play', 'barracks', 'armory', 'store', 'career'];
const PAGE_ICON = { play: 'play', barracks: 'helmet', armory: 'rifle', store: 'shop', career: 'medal' };

export function initMenu({ MODES, K, onDeploy, onClick, onHover, onEnter, qualityNow, onReplayTutorial, onPage, onPlayOnline, onTransfer }) {
  const click = (fn) => (e) => { onClick?.(); fn(e); };
  const menuEl = $('menu');

  // static icons
  $('howBtn').innerHTML = ICON.book;
  $('setBtn').innerHTML = ICON.gear;
  document.querySelectorAll('#hubNav button').forEach((b) => { b.querySelector('.hn-ic').innerHTML = ICON[PAGE_ICON[b.dataset.page]] || ''; });
  $('playHost').querySelector('.pm-ic').innerHTML = ICON.globe;
  $('playJoin').querySelector('.pm-ic').innerHTML = ICON.key;

  // ---- hub navigation
  let page = PAGES.includes(menuEl.dataset.page) ? menuEl.dataset.page : 'play';
  function moveInk() {
    const nav = $('hubNav');
    const btn = nav.querySelector(`button[data-page="${page}"]`);
    const ink = nav.querySelector('.hn-ink');
    if (!btn || !ink) return;
    ink.style.setProperty('--x', btn.offsetLeft + 'px');
    ink.style.setProperty('--w', btn.offsetWidth + 'px');
    if (nav.scrollWidth > nav.clientWidth) nav.scrollTo?.({ left: btn.offsetLeft - (nav.clientWidth - btn.offsetWidth) / 2, behavior: 'smooth' });
  }
  function setPage(p, { silent = false } = {}) {
    if (!PAGES.includes(p)) p = 'play';
    const from = PAGES.indexOf(page), to = PAGES.indexOf(p);
    const changed = p !== page;
    page = p;
    menuEl.dataset.page = p;
    menuEl.style.setProperty('--dir', to >= from ? '1' : '-1');
    document.querySelectorAll('#hubNav button').forEach((b) => {
      const on = b.dataset.page === p;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('#hubPages .page').forEach((el) => {
      const on = el.dataset.page === p;
      if (on && changed) { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }
      el.classList.toggle('on', on);
      if (on) el.scrollTop = 0;
    });
    moveInk();
    if (changed && !silent) buzz('tap');
    onPage?.(p, document.querySelector(`#hubPages .page[data-page="${p}"]`));
  }
  document.querySelectorAll('#hubNav button').forEach((b) => {
    b.onclick = () => { if (b.dataset.page === page) return; onClick?.('tab'); setPage(b.dataset.page); };
    b.onpointerenter = () => onHover?.();
  });
  addEventListener('resize', () => requestAnimationFrame(moveInk));
  // Swipe between hub pages on touch (not inside horizontal scrollers or inputs).
  let swx = null, swy = 0, swt = 0;
  $('hubPages').addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || e.target.closest('input, textarea, .stage-row, .h-scroll, canvas')) { swx = null; return; }
    swx = e.clientX; swy = e.clientY; swt = performance.now();
  }, { passive: true });
  $('hubPages').addEventListener('pointerup', (e) => {
    if (swx === null) return;
    const dx = e.clientX - swx, dy = e.clientY - swy;
    swx = null;
    if (performance.now() - swt > 600 || Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
    const i = PAGES.indexOf(page) + (dx < 0 ? 1 : -1);
    if (i >= 0 && i < PAGES.length) { onClick?.('tab'); setPage(PAGES[i]); }
  });

  // ---- play choices (Solo / Host / Join)
  document.querySelectorAll('#pagePlay .pm-card').forEach((b) => {
    b.onpointerenter = () => onHover?.();
    b.onclick = click(() => {
      const kind = b.dataset.play;
      if (kind === 'solo') { settings.playMode = 'solo'; renderPlay(); return; }
      onPlayOnline?.(kind);
    });
  });
  function renderPlay() {
    document.querySelectorAll('#pagePlay .pm-card').forEach((b) => b.classList.toggle('sel', b.dataset.play === 'solo'));
    renderDailies();
  }
  function renderDailies() {
    const el = $('playDailies');
    if (!el) return;
    const ds = P.dailies();
    const h = Math.floor(P.msToDailyReset() / 3600000), m = Math.floor((P.msToDailyReset() % 3600000) / 60000);
    $('dailyReset').textContent = `New in ${h}h ${m}m`;
    el.innerHTML = ds.map((d) => `<div class="dm${d.done ? ' done' : ''}"><span class="dm-ic">${d.done ? ICON.check : ICON.calendar}</span><div class="dm-t"><b>${esc(d.label)}</b><span class="xpbar sm"><i style="--w:${Math.round((d.have / d.n) * 100)}%"></i></span></div><span class="dm-r"><b>${d.have}/${d.n}</b><small>+${d.xp.toLocaleString('en-US')} XP</small></span></div>`).join('');
  }

  // ---- modes
  function renderModes() {
    const mc = $('modeChoices');
    mc.innerHTML = '';
    for (const [k, m] of Object.entries(MODES)) {
      const b = document.createElement('button');
      b.className = 'mode-card' + (k === settings.mode ? ' sel' : '');
      b.dataset.mode = k;
      b.setAttribute('aria-pressed', String(k === settings.mode));
      const info = MODE_INFO[k] || { line: `${16 / m.teamSize} × ${m.teamSize}`, desc: '' };
      b.innerHTML = `<b>${m.name}</b>${squadGlyph(k, m.teamSize)}<small>${info.line}</small>`;
      b.title = info.desc;
      b.onclick = click(() => { settings.mode = k; renderModes(); });
      b.onpointerenter = () => onHover?.();
      mc.appendChild(b);
    }
    const wolf = $('wolfRow');
    wolf.classList.toggle('collapsed', settings.mode !== 'trios');
    $('wolfBox').checked = !!settings.loneWolf;
    $('modeDesc').textContent = (MODE_INFO[settings.mode] || {}).desc || '';
  }

  // ---- stages: always random (5.1). The Play page shows the rotation; the stage
  // wheel before each match lands on whichever stage the match seed picked.
  const STAGES = stageList(K);
  if (settings.stage !== 'random') settings.stage = 'random';
  function renderStages() {
    const row = $('stageChoices');
    if (!row) return;
    row.innerHTML = STAGES.map((st, i) => `<div class="stage-mini st-${st.key}" style="--i:${i}" title="${esc(st.name)}: ${esc(st.twist)}">
        ${stageArt(st.key)}<span class="st-meta"><b>${esc(st.name)}</b><small>${stageIcon(st)}${esc(st.short || '')}</small></span></div>`).join('');
  }

  // ---- wallet
  function renderWallet() {
    $('menuSalvage').innerHTML = `${ICON.coin}<b>${M.salvage().toLocaleString('en-US')}</b><small>Salvage</small>`;
    const cheapest = Math.min(...M.SLOTS.flatMap((sl) => M.catalog()[sl.key].filter((i) => !i.isDefault && !M.owns(sl.key, i.id)).map((i) => M.priceOf(i))), Infinity);
    $('shopDot').classList.toggle('hidden', !(M.salvage() >= cheapest));
  }

  if (!settings.callsign) settings.callsign = randomCallsign(K);

  $('wolfBox').onchange = () => { onClick?.(); settings.loneWolf = $('wolfBox').checked; };
  $('playBtn').onclick = () => { onClick?.('deploy'); onDeploy(); };
  $('howBtn').onclick = click(() => openSheet('howSheet'));
  $('setBtn').onclick = click(() => openSheet('settingsSheet'));
  $('howTut').onclick = click(() => { closeSheet('howSheet'); openTutorial(); });

  // ---- splash
  const splash = $('splash');
  let entering = false;
  const enter = () => {
    if (entering || splash.classList.contains('hidden')) return;
    entering = true;
    onClick?.();
    buzz('tap');
    splash.classList.add('leaving');
    showMenu(true);
    setTimeout(() => { splash.classList.add('hidden'); splash.classList.remove('leaving'); entering = false; }, 650);
    onEnter?.();
    if (!settings.seenTutorial) setTimeout(() => openTutorial(), 700);
  };
  splash.addEventListener('click', enter);
  splash.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enter(); } });
  // Any touchscreen says "tap" (some phones/tablets report hover + a fine pointer);
  // only mouse-and-keyboard devices get the click/key prompt. A first touch on a
  // hybrid device switches it back to "tap".
  const startTxt = (touch) => {
    const t = touch ? 'Tap to start' : 'Click or press any key';
    $('spStartTxt').textContent = t;
    splash.setAttribute('aria-label', `Tidefall. ${t}`);
  };
  const hasTouch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window || matchMedia('(any-pointer: coarse)').matches;
  startTxt(hasTouch || !matchMedia('(hover: hover) and (pointer: fine)').matches);
  splash.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') startTxt(true); }, { passive: true });

  function showMenu(fromSplash = false) {
    const m = $('menu');
    m.classList.remove('hidden');
    m.classList.toggle('intro', fromSplash);
    renderWallet();
    renderStages();
    setPage(page, { silent: true });
  }

  renderModes();
  renderWallet();
  renderStages();
  renderPlay();
  buildHowTo();
  initSettingsSheet({ onClick, qualityNow, onReplayTutorial: () => { closeSheet('settingsSheet'); openTutorial(); onReplayTutorial?.(); }, onResetCareer: () => onPage?.(page, document.querySelector(`#hubPages .page[data-page="${page}"]`)), onTransfer });
  initTutorial(onClick);
  for (const el of document.querySelectorAll('[data-close]')) {
    el.addEventListener('click', () => { onClick?.(); closeSheet(el.closest('.sheet').id); });
  }
  for (const sh of document.querySelectorAll('.sheet')) {
    sh.addEventListener('pointerdown', (e) => { if (e.target === sh) closeSheet(sh.id); });
    sh.addEventListener('keydown', (e) => trapFocus(e, sh));
  }
  return {
    renderModes, renderWallet, renderStages, renderPlay, showMenu, enter, setPage,
    page: () => page,
    refreshMeta: () => { renderWallet(); renderDailies(); onPage?.(page, document.querySelector(`#hubPages .page[data-page="${page}"]`), { refresh: true }); },
    splashOpen: () => !splash.classList.contains('hidden'),
    showSplash: () => { splash.classList.remove('hidden', 'leaving'); $('menu').classList.add('hidden'); },
  };
}

let toastFn = null;
export function setMenuToast(fn) { toastFn = fn; }

// ------------------------------------------------------------------ sheets (stacked, focus-trapped)

const sheetCloseHooks = new Map();
const sheetStack = [];
const returnFocus = new Map();
export function onSheetClose(id, fn) { sheetCloseHooks.set(id, fn); }
const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function openSheet(id) {
  const el = $(id);
  if (!el) return;
  const i = sheetStack.indexOf(id);
  if (i >= 0) sheetStack.splice(i, 1);
  sheetStack.push(id);
  el.style.zIndex = String(40 + sheetStack.length);
  if (!returnFocus.has(id)) returnFocus.set(id, document.activeElement);
  el.classList.remove('hidden', 'closing');
  clearTimeout(el._hideT);
  requestAnimationFrame(() => {
    el.classList.add('open');
    const card = el.querySelector('.sheet-card');
    const first = card?.querySelector('[data-autofocus]') || card?.querySelector(FOCUSABLE);
    try { first?.focus({ preventScroll: true }); } catch { /* ignore */ }
  });
}
export function closeSheet(id) {
  const el = $(id);
  if (!el || el.classList.contains('hidden') || el.classList.contains('closing')) return;
  const i = sheetStack.indexOf(id);
  if (i >= 0) sheetStack.splice(i, 1);
  el.classList.remove('open');
  el.classList.add('closing');
  el._hideT = setTimeout(() => { el.classList.add('hidden'); el.classList.remove('closing'); }, 220);
  const back = returnFocus.get(id);
  returnFocus.delete(id);
  if (back && back.isConnected && back.offsetParent !== null) { try { back.focus({ preventScroll: true }); } catch { /* ignore */ } } else document.activeElement?.blur?.();
  sheetCloseHooks.get(id)?.();
}
export const sheetOpen = () => sheetStack.length > 0;
export function closeTopSheet() {
  if (!sheetStack.length) return false;
  closeSheet(sheetStack[sheetStack.length - 1]);
  return true;
}
export function closeAllSheets() { while (sheetStack.length) closeSheet(sheetStack[sheetStack.length - 1]); }

function trapFocus(e, sheet) {
  if (e.key !== 'Tab') return;
  const items = [...sheet.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } else if (!sheet.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
}

// ------------------------------------------------------------------ settings

function seg(name, options, value) {
  return `<div class="seg" data-setting="${name}" role="radiogroup">${options.map(([v, label]) =>
    `<button data-v="${v}" role="radio" aria-checked="${String(v) === String(value)}" class="${String(v) === String(value) ? 'on' : ''}">${label}</button>`).join('')}</div>`;
}

/** Text size, reduced motion and the colourblind palette, applied to the page. */
export function applyAccessibility() {
  const b = document.body;
  b.dataset.text = settings.textSize || 'm';
  const osReduced = matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  b.classList.toggle('reduce-motion', settings.motion === 'reduced' || (settings.motion === 'auto' && osReduced));
  b.dataset.cb = settings.colorPreset || 'standard';
  setColorPreset(settings.colorPreset);
}

function initSettingsSheet({ onClick, qualityNow, onReplayTutorial, onResetCareer, onTransfer }) {
  const body = $('settingsBody');
  let confirmReset = 0;
  const render = () => {
    const q = qualityNow?.();
    const autoNote = settings.quality === 'auto' && q ? ` · now ${q === 'high' ? 'High' : 'Low'}` : '';
    const row = (title, sub, ctl, cls = '') => `<div class="set-row ${cls}"><div><b>${title}</b><small>${sub}</small></div>${ctl}</div>`;
    body.innerHTML = `
      <div class="set-group">Sound</div>
      ${row('Volume', 'Music and effects', `<div class="vol"><button id="setMute" class="icon-btn sm" aria-label="${settings.muted ? 'Unmute' : 'Mute'}">${settings.muted ? ICON.soundOff : ICON.soundOn}</button>
        <input id="setVol" type="range" min="0" max="100" value="${Math.round(settings.volume * 100)}" aria-label="Volume" /><span class="vol-n">${settings.muted ? 'Off' : Math.round(settings.volume * 100)}</span></div>`)}
      <div class="set-group">Graphics</div>
      ${row('Quality', `Auto picks for your device${autoNote}. Low drops shadows and post-FX`, seg('quality', [['auto', 'Auto'], ['high', 'High'], ['low', 'Low']], settings.quality))}
      ${row('Cinematic camera', 'Action cam on shots and kills', seg('cinematic', [[true, 'On'], [false, 'Off']], settings.cinematic))}
      ${row('Camera follow', 'Track whoever is acting', seg('follow', [[true, 'On'], [false, 'Off']], settings.follow))}
      ${row('Cover fade', 'Fade walls and crates while you pick a move', seg('coverFade', [[true, 'On'], [false, 'Off']], settings.coverFade))}
      <div class="set-group">Gameplay</div>
      ${row('Turn timer', 'How your 20-second clock is shown', seg('timer', [['ring', 'Ring'], ['bar', 'Bar']], settings.timer))}
      ${row('Pacing', 'Camera and action rhythm. Cinematic frames every action and set piece', seg('pacing', [['cinematic', 'Cinematic'], ['normal', 'Normal'], ['fast', 'Fast']], settings.pacing), 'wide')}
      ${row('Hitmarkers', 'Hit ticks, kill confirms and XP popups', seg('hitmarkers', [[true, 'On'], [false, 'Off']], settings.hitmarkers))}
      <div class="set-group">Accessibility</div>
      ${row('Squad colours', 'Colourblind-safe palettes. You stay amber, signals stay cyan', seg('colorPreset', [['standard', 'Std'], ['deutan', 'Deut'], ['protan', 'Prot'], ['tritan', 'Trit'], ['high', 'High']], settings.colorPreset), 'wide')}
      <div class="cb-preview" aria-hidden="true">${cbSwatches()}</div>
      ${row('Text size', 'Scales menus and the HUD', seg('textSize', [['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']], settings.textSize))}
      ${row('Reduced motion', 'Calmer transitions, no shake or sweeps', seg('motion', [['auto', 'Auto'], ['reduced', 'On'], ['full', 'Off']], settings.motion))}
      ${row('Haptics', hapticsSupported ? 'Vibrate on hits, kills and your turn' : 'Not supported on this device', seg('haptics', [[true, 'On'], [false, 'Off']], settings.haptics), hapticsSupported ? '' : 'na')}
      <div class="set-group">Account</div>
      <div class="set-xfer">
        <div><b>Transfer</b><small>Move your level, items, loadouts and progress to another device with a code or QR.</small></div>
        <div class="set-btns"><button id="setExport" class="btn ghost sm">${ICON.upload}Export</button><button id="setImport" class="btn ghost sm">${ICON.download}Import</button></div>
      </div>
      <div class="set-group">Data</div>
      <div class="set-btns">
        <button id="setTut" class="btn ghost sm">${ICON.book}Replay tutorial</button>
        <button id="setReset" class="btn ghost sm danger">${ICON.refresh}${Date.now() - confirmReset < 3000 ? 'Tap again to wipe' : 'Reset career stats'}</button>
      </div>`;
    body.querySelectorAll('.seg').forEach((s) => {
      s.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          onClick?.();
          const raw = b.dataset.v;
          settings[s.dataset.setting] = raw === 'true' ? true : raw === 'false' ? false : raw;
          if (s.dataset.setting === 'haptics' && settings.haptics) buzz('tap');
          if (['textSize', 'motion', 'colorPreset'].includes(s.dataset.setting)) applyAccessibility();
          render();
          body.querySelector(`.seg[data-setting="${s.dataset.setting}"] button.on`)?.focus({ preventScroll: true });
        };
      });
    });
    $('setVol').oninput = (e) => {
      settings.volume = Number(e.target.value) / 100;
      if (settings.muted) { settings.muted = false; $('setMute').innerHTML = ICON.soundOn; }
      body.querySelector('.vol-n').textContent = String(Math.round(settings.volume * 100));
    };
    $('setMute').onclick = () => { onClick?.(); settings.muted = !settings.muted; render(); $('setMute')?.focus({ preventScroll: true }); };
    $('setTut').onclick = () => { onClick?.(); onReplayTutorial?.(); };
    $('setExport').onclick = () => { onClick?.(); onTransfer?.('export'); };
    $('setImport').onclick = () => { onClick?.(); onTransfer?.('import'); };
    $('setReset').onclick = () => {
      onClick?.();
      if (Date.now() - confirmReset < 3000) { resetCareer(); confirmReset = 0; onResetCareer?.(); toastFn?.('Career stats wiped. Prestige, Salvage and items are kept', 'info'); } else confirmReset = Date.now();
      render();
    };
  };
  render();
  // Re-render when opened so "Auto · now High/Low" is current.
  const sheet = $('settingsSheet');
  new MutationObserver(() => { if (!sheet.classList.contains('hidden') && !sheet.classList.contains('open')) render(); })
    .observe(sheet, { attributes: true, attributeFilter: ['class'] });
}

function cbSwatches() {
  // Your squad, then the first 7 enemy squads as they'll look in-game.
  const out = [`<i style="--c:#ffb000" title="You"></i>`];
  for (let t = 1; t < 8; t++) out.push(`<i style="--c:${squadColorFor(t)}"></i>`);
  return out.join('');
}
let squadColorFor = () => '#888';
export function setSwatchSource(fn) { squadColorFor = fn; }

// ------------------------------------------------------------------ how to play

function buildHowTo() {
  const card = (ic, title, text, cls = '') => `<div class="how ${cls}"><span class="how-ic">${ICON[ic]}</span><div><b>${title}</b><p>${text}</p></div></div>`;
  const classes = `<div class="how wide how-classes"><span class="how-ic">${ICON.helmet || ICON.squads}</span><div><b>Seven classes</b><div class="hc-grid">${CLASS_LINES.map(([k, n, t]) => `<span class="hc">${badgeSVG(k, 0, { size: 34, title: false, animated: false })}<span><b>${n}</b><small>${t}</small></span></span>`).join('')}</div></div></div>`;
  $('howBody').innerHTML = [
    card('clock', 'Engagement turns', 'Squads that can see each other are <b>engaged</b> and take turns in order. Every squad out of contact moves <b>at the same time</b>. You get <b>2 AP</b> and a 20-second clock; if it runs out you go on overwatch.'),
    card('tap', 'Tap, then tap again', 'Tap a tile to preview the route and the cover waiting there. Tap it again, or press <b>Confirm</b>. Cyan tiles cost 1 AP, gold tiles are a 2 AP dash. Walls fade while you choose.'),
    card('shoot', 'Shooting ends your turn', 'Every target shows its hit chance, graze odds and damage. <b>Firing ends your turn</b>, so move first. Near-misses graze for half damage. Throwing gear, reloading and abilities like Patch or Scan don\'t end it.'),
    card('shield', 'Cover is life', 'Half cover is -20 aim against you, full cover -40. Shots from an open side <b>flank</b> you: +10 aim and +1 damage. Hunker doubles your cover until your next turn.'),
    classes,
    card('rifle', 'Create-a-Class', 'In the <b>Barracks</b>, build 5 loadouts: class, primary with up to 5 <b>Gunsmith</b> attachments, secondary, lethal, tactical, 3 perks and 3 killstreaks. Every unlock is a sidegrade.'),
    card('reload', 'Ammo, reload, swap', 'Every shot uses a round; burst weapons use one per bullet. <b>Reload</b> costs 1 AP and doesn\'t end your turn. <b>Swap</b> to your secondary once per turn for free. The pistol never runs dry.'),
    card('grenade', 'Gear', 'Open <b>Gear</b> on the action bar for your lethal (frag, semtex, claymore, throwing knife), your tactical (smoke, flashbang, stim, decoy) and medkits.'),
    card('airstrike', 'Killstreaks', 'Kills unlock your three streaks: UAV (3), Care Package (4), Counter-UAV (4), Airstrike (5), Sentry (5), Gunship (7). Tap a glowing streak to call it in: 0 AP, one per turn. Hardline makes them 1 cheaper.'),
    card('water', 'Boats', 'Step onto a boat to board it. The first soldier aboard drives: up to 8 tiles of water for 1 AP and 1 fuel, ending the turn. Aboard you get half cover and no tide damage. Engineers repair hulls.'),
    card('warn', 'Stage events', 'Once per match the stage turns on you: a container ship breaks loose, a red tide spreads, a platform collapses, a tower topples or a rogue wave hits. It\'s <b>telegraphed a round before</b>: get off the marked tiles.'),
    card('pit', 'The Pit', 'Your first death up to round 8 sends you to the <b>Pit</b>: a 1v1 duel with pistols and a frag. Win and you parachute back in at 6 HP.'),
    card('revive', 'Downed, not out', 'In squad modes 0 HP means <b>downed</b>. An adjacent squadmate revives you for 1 AP (back at 3 HP; a Medic\'s Patch brings you to 4). You bleed out after 2 of your squad\'s turns, and any hit finishes you.'),
    card('smoke', 'Smoke and kelp hide you', 'Inside smoke, enemies more than a tile away can\'t see you, and shots into or out of it take -20 aim. Kelp hides you from anyone more than 3 tiles away.'),
    card('tide', 'The tide rises', 'Every 2 rounds the water closes in. The <span class="c-cyan">cyan ring</span> is the next safe edge. Ending your turn in the water hurts, more as the match goes on. On Surge Point the ring drifts.'),
    card('stage', 'Five stages, picked at random', '<b>Drowned Harbor</b>: dense cover. <b>Kelp Shallows</b>: weed beds hide you. <b>Rig Graveyard</b>: barrels explode and chain. <b>Night Spires</b>: dark, and gunfire lights a flare over you. <b>Surge Point</b>: the safe zone drifts. The stage wheel spins before every drop.', 'wide'),
    card('crate', 'Crates and supply drops', 'Crates hold medkits, armor, ammo, field attachments and extra lethals or tacticals. Supply caches land inside the next ring on rounds 4, 8 and 12; about one in four is a <b>gold crate</b> with a legendary weapon.'),
    card('medal', 'Levels, camos and Salvage', 'Matches earn player XP (level 1–100), <b>weapon XP</b> that unlocks attachments, and <b>class XP</b> that grows its badge from Recruit to Legend. Camo challenges lead to Gold, Diamond and the animated Tidal. Salvage buys skins and effects in the Store.'),
    `<div class="how keys wide"><span class="how-ic">${ICON.gear}</span><div><b>Keyboard</b><p><kbd>1</kbd> move · <kbd>2</kbd> shoot · <kbd>3</kbd> ability · <kbd>4</kbd> lethal · <kbd>5</kbd> tactical · <kbd>6</kbd> hunker · <kbd>7</kbd> overwatch · <kbd>8</kbd> medkit · <kbd>G</kbd> gear · <kbd>R</kbd> reload · <kbd>X</kbd> swap · <kbd>V</kbd> revive · <kbd>Space</kbd> end turn · <kbd>Q</kbd>/<kbd>E</kbd> rotate · <kbd>Tab</kbd> next target · <kbd>Enter</kbd> confirm · <kbd>Esc</kbd> cancel · <kbd>F</kbd> find me</p></div></div>`,
  ].join('');
}

/** The seven classes in one line each (How to Play + tutorial). */
const CLASS_LINES = [
  ['assault', 'Assault', '+1 lethal · Run & Gun after a dash'],
  ['marksman', 'Marksman', 'Aimed Shot: +15 aim, +2 dmg'],
  ['breacher', 'Breacher', 'Breach: blow open adjacent cover'],
  ['medic', 'Medic', 'Patch: heal 5 or revive at 4 HP'],
  ['recon', 'Recon', 'Scan: see through walls, 5 tiles'],
  ['engineer', 'Engineer', 'Deploy Cover · repairs boats'],
  ['gunner', 'Gunner', 'Suppress: -25 aim, LMG only'],
];

// ------------------------------------------------------------------ tutorial

const TUT = [
  { ic: 'clock', title: 'Engagement turns', art: 'engage', text: 'Squads that can see each other are <b>engaged</b> and take turns in order. Everyone out of contact moves <b>at once</b>. The bar at the top shows who is moving and who you\'re fighting.' },
  { ic: 'squads', title: 'Seven classes', art: 'classes', text: 'Assault, Marksman, Breacher, Medic, Recon, <b>Engineer</b> and <b>Gunner</b>. Each brings its own ability, health and weapon types.' },
  { ic: 'tap', title: 'Tap, then tap again', art: 'move', text: 'Tap a tile to <b>preview</b> your route and the cover waiting there. Tap the same tile again to <b>commit</b>. Cyan costs 1 AP, gold is a 2 AP dash.' },
  { ic: 'shield', title: 'Cover is life', art: 'cover', text: 'Full cover is -40 aim against you, half cover -20. Enemies on an open side <b>flank</b> you: +10 aim and +1 damage. Hunker to double your cover.' },
  { ic: 'shoot', title: 'Firing ends your turn', art: 'shoot', text: 'You get <b>2 AP</b> and 20 seconds. Move first: <b>shooting ends your turn</b>. Every shot uses a round: <b>Reload</b> costs 1 AP, <b>Swap</b> to your sidearm is free once a turn.' },
  { ic: 'grenade', title: 'Loadouts and gear', art: 'prestige', text: 'Build 5 classes in the <b>Barracks</b>: weapon, Gunsmith attachments, perks, a lethal and a tactical. In a match, open <b>Gear</b> to throw a frag, pop smoke or use a medkit.' },
  { ic: 'airstrike', title: 'Killstreaks', art: 'streaks', text: 'Kills unlock your 3 streaks. Tap a glowing one to call in a UAV, care package, counter-UAV, airstrike, sentry or gunship. 0 AP, one per turn.' },
  { ic: 'water', title: 'Boats and stage events', art: 'stages', text: 'Board a boat to cross water with half cover. Once a match the stage strikes: a ship, a red tide, a collapse, a falling tower or a rogue wave. It\'s <b>marked a round early</b>.' },
  { ic: 'revive', title: 'Downed, then the Pit', art: 'revive', text: 'In squads, 0 HP means <b>downed</b>: a squadmate next to you can revive you. Your first death up to round 8 sends you to <b>the Pit</b>, a 1v1 duel to get back in.' },
  { ic: 'tide', title: 'The tide rises', art: 'tide', text: 'Every 2 rounds the safe ring shrinks. The <span class="c-cyan">cyan ring</span> shows where it goes next. The stage is picked at random. Be the last squad above the water.' },
];

function tutArt(kind) {
  if (kind === 'classes') {
    return `<div class="tut-art tut-classes" aria-hidden="true">${CLASS_LINES.map(([k, n], i) => `<span style="--i:${i}">${badgeSVG(k, 0, { size: 48, title: false, animated: false })}<small>${n}</small></span>`).join('')}</div>`;
  }
  if (kind === 'streaks') {
    return `<div class="tut-art tut-streaks" aria-hidden="true">${[['uav', 'UAV', 3], ['care', 'Care', 4], ['airstrike', 'Airstrike', 5], ['gunship', 'Gunship', 7]].map(([k, n, c], i) => `<span style="--i:${i}"><i>${ICON[k] || ICON.bolt}</i><b>${n}</b><small>${c} kills</small></span>`).join('')}</div>`;
  }
  if (kind === 'prestige') {
    return `<div class="tut-art tut-badges" aria-hidden="true">${[0, 2, 4].map((t, i) => `<span style="--i:${i}">${badgeSVG(['assault', 'medic', 'recon'][i], t, { size: i === 2 ? 96 : 76, title: false })}<small>${M.TIER_NAMES[t]}</small></span>`).join('')}</div>`;
  }
  // Small schematic illustrations (SVG), coloured with the reserved palette.
  const grid = Array.from({ length: 5 }, (_, y) => Array.from({ length: 7 }, (_, x) => `<rect x="${x * 30 + 6}" y="${y * 22 + 6}" width="26" height="18" rx="3" class="t-tile"/>`).join('')).join('');
  const you = (x, y) => `<g class="t-you" transform="translate(${x},${y})"><circle r="8"/><circle r="13" class="t-pulse"/></g>`;
  const foe = (x, y) => `<g class="t-foe" transform="translate(${x},${y})"><circle r="7"/></g>`;
  const body = {
    move: `${[[1, 2], [2, 2], [3, 1], [3, 2], [2, 1], [2, 3], [3, 3], [4, 2]].map(([x, y]) => `<rect x="${x * 30 + 6}" y="${y * 22 + 6}" width="26" height="18" rx="3" class="t-reach"/>`).join('')}
      <rect x="${5 * 30 + 6}" y="${1 * 22 + 6}" width="26" height="18" rx="3" class="t-dash"/>
      <rect x="96" y="50" width="26" height="18" rx="3" class="t-ghost"/><path d="M104 59 l5 -5 l5 5" class="t-ghost-shield"/>
      <path d="M33 59 L63 59 L93 37 L165 37" class="t-path"/>${you(33, 59)}<g class="t-tap" transform="translate(165,37)"><circle r="10"/></g>`,
    cover: `<rect x="96" y="28" width="26" height="40" rx="3" class="t-cover"/><rect x="66" y="72" width="26" height="12" rx="3" class="t-cover half"/>${you(79, 59)}${foe(185, 50)}<path d="M178 50 L130 50" class="t-shot blocked"/><path d="M95 50 l-6 -10 h12 z" class="t-shield"/>`,
    shoot: `${you(48, 59)}${foe(168, 37)}<path d="M56 56 L160 39" class="t-aim"/><g transform="translate(168,20)"><rect x="-17" y="-9" width="34" height="16" rx="4" class="t-badge"/><text y="3" class="t-txt">72%</text></g><g transform="translate(48,96)" class="t-ap"><rect x="-14" y="-5" width="10" height="10" transform="rotate(45 -9 0)"/><rect x="4" y="-5" width="10" height="10" transform="rotate(45 9 0)"/></g><text x="111" y="104" class="t-txt warn">ENDS TURN</text>`,
    smoke: `<g class="t-smoke"><circle cx="70" cy="60" r="26"/><circle cx="52" cy="52" r="16"/><circle cx="90" cy="70" r="17"/></g>${you(70, 60)}${foe(185, 40)}<path d="M178 42 L100 56" class="t-shot blocked"/><text x="140" y="36" class="t-txt">?</text><text x="70" y="104" class="t-txt">-20 AIM</text>`,
    revive: `${you(78, 59)}<g class="t-down" transform="translate(108,63)"><ellipse rx="11" ry="6"/><circle r="15" class="t-bleed"/></g><path d="M86 52 Q97 36 106 50" class="t-arc"/><text x="108" y="30" class="t-txt cyan">REVIVE</text>`,
    stages: `<g transform="translate(18,24)" class="t-kelp">${[0, 12, 24].map((x) => `<path d="M${x + 6} 70 C${x} 52 ${x + 12} 40 ${x + 4} 20"/>`).join('')}</g>
      <g transform="translate(96,52)"><rect x="-9" y="-12" width="18" height="24" rx="3" class="t-barrel"/><rect x="-9" y="-4" width="18" height="5" class="t-band"/><path d="M-20 -22 l6 6 M20 -22 l-6 6 M0 -30 v8" class="t-burst"/></g>
      <g transform="translate(176,58)"><circle r="7" class="t-foe-c"/><circle cy="-34" r="5" class="t-flare"/><circle cy="-34" r="14" class="t-flare-glow"/><path d="M0 -26 V-10" class="t-flare-line"/></g>
      <text x="34" y="112" class="t-txt">KELP</text><text x="96" y="112" class="t-txt">BARREL</text><text x="176" y="112" class="t-txt">FLARE</text>`,
    engage: `${you(48, 40)}${you(60, 84)}${foe(170, 36)}${foe(160, 82)}<path d="M58 44 L160 38 M70 82 L150 82" class="t-aim"/><g transform="translate(111,20)"><rect x="-30" y="-9" width="60" height="16" rx="4" class="t-badge"/><text y="3" class="t-txt">ENGAGED</text></g><text x="111" y="112" class="t-txt cyan">OTHERS MOVE AT ONCE</text>`,
    tide: `<circle cx="111" cy="61" r="62" class="t-ring now"/><circle cx="111" cy="61" r="38" class="t-ring next"/>${you(95, 66)}${foe(40, 30)}${foe(175, 90)}`,
  }[kind] || '';
  return `<svg class="tut-art" viewBox="0 0 222 122" aria-hidden="true">${kind === 'stages' ? '' : grid}${body}</svg>`;
}

let tutIdx = 0;
let tutOnClick = null;
function renderTut(dir = 0) {
  const t = TUT[tutIdx];
  $('tutStep').textContent = `${tutIdx + 1} / ${TUT.length}`;
  const b = $('tutBody');
  b.innerHTML = `<div class="tut-slide ${dir > 0 ? 'from-r' : dir < 0 ? 'from-l' : ''}">${tutArt(t.art)}<div class="tut-h"><span class="how-ic">${ICON[t.ic]}</span><b>${t.title}</b></div><p>${t.text}</p></div>`;
  $('tutDots').innerHTML = TUT.map((_, i) => `<button class="${i === tutIdx ? 'on' : ''}" aria-label="Tip ${i + 1}" data-i="${i}"></button>`).join('');
  $('tutDots').querySelectorAll('button').forEach((d) => { d.onclick = () => { tutOnClick?.(); const i = Number(d.dataset.i); const dd = i - tutIdx; tutIdx = i; renderTut(dd); }; });
  $('tutNext').textContent = tutIdx === TUT.length - 1 ? "Let's go" : 'Next';
  $('tutSkip').classList.toggle('invisible', tutIdx === TUT.length - 1);
}
function initTutorial(onClick) {
  tutOnClick = onClick;
  $('tutNext').onclick = () => {
    onClick?.();
    if (tutIdx >= TUT.length - 1) { closeSheet('tutSheet'); return; }
    tutIdx++; renderTut(1);
  };
  $('tutSkip').onclick = () => { onClick?.(); closeSheet('tutSheet'); };
  onSheetClose('tutSheet', () => { settings.seenTutorial = true; });
  // swipe between tips
  let sx = null;
  const body = $('tutBody');
  body.addEventListener('pointerdown', (e) => { sx = e.clientX; });
  body.addEventListener('pointerup', (e) => {
    if (sx === null) return;
    const dx = e.clientX - sx; sx = null;
    if (Math.abs(dx) < 40) return;
    const ni = Math.max(0, Math.min(TUT.length - 1, tutIdx + (dx < 0 ? 1 : -1)));
    if (ni !== tutIdx) { const d = ni - tutIdx; tutIdx = ni; renderTut(d); }
  });
  $('tutSheet').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); $('tutNext').click(); }
    if (e.key === 'ArrowLeft' && tutIdx > 0) { e.preventDefault(); tutIdx--; renderTut(-1); }
  });
}
export function openTutorial() {
  tutIdx = 0;
  renderTut(0);
  openSheet('tutSheet');
  requestAnimationFrame(() => requestAnimationFrame(() => $('tutNext')?.focus({ preventScroll: true })));
}
