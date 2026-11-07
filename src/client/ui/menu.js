// Title flow: splash ("tap to start") → loadout (mode, class carousel,
// callsign, career strip) plus the settings / how-to / tutorial sheets.
// Pure DOM; main.js owns the match and passes callbacks in.

import { ICON } from './icons.js';
import { settings } from './settings.js';
import { career, resetCareer } from './career.js';
import { hapticsSupported, buzz } from './haptics.js';
import { badgeSVG } from './badges.js';
import * as M from './meta.js';
import { stageList, stageArt, stageIcon } from './stages.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const CLASS_INFO = {
  assault: { role: 'Frontline all-rounder', ability: 'grenade', abilityName: 'Frag Grenades ×2' },
  marksman: { role: 'Long-range precision', ability: 'aimed' },
  breacher: { role: 'Close-quarters bruiser', ability: 'breach' },
  medic: { role: 'Squad lifeline', ability: 'patch' },
  recon: { role: 'Eyes of the squad', ability: 'scan', extra: 'smoke' },
};
const ABILITY_FALLBACK = {
  grenade: { name: 'Frag Grenade', desc: 'Lob up to 7 tiles. 3 damage to everyone in a 3×3 blast, and it shreds cover. Does not end your turn.' },
  aimed: { name: 'Aimed Shot', desc: '+15 aim and +2 damage on one carefully placed round. 3-round cooldown. Ends your turn.' },
  breach: { name: 'Breach Charge', desc: 'Blow apart adjacent cover: the tile opens up and enemies within 1 tile take 4 damage. 3-round cooldown.' },
  patch: { name: 'Patch', desc: 'Heal yourself or an adjacent ally for 5, or revive a downed ally at 4 HP. 1 AP, 2-round cooldown.' },
  scan: { name: 'Scan', desc: 'Reveal every unit within 5 tiles of a point up to 12 tiles away, through walls, until your next turn.' },
  smoke: { name: 'Smoke Grenade', desc: 'A 3×3 cloud that hides anyone inside from enemies more than a tile away, until your next turn. Shots into or out of smoke take -20 aim. Does not end your turn.' },
  hunker: { name: 'Hunker Down', desc: 'Doubles your cover and blocks grazes until your next turn.' },
};

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

const STAT_MAX = { hp: 14, armor: 2, move: 7, range: 14, aim: 90, dmg: 7 };

function statBars(c) {
  const avg = (c.weapon.dmg[0] + c.weapon.dmg[1]) / 2;
  const rows = [
    ['Health', c.hp, STAT_MAX.hp, String(c.hp)],
    ['Armor', c.armor, STAT_MAX.armor, String(c.armor)],
    ['Mobility', c.move, STAT_MAX.move, `${c.move} tiles`],
    ['Range', c.weapon.range, STAT_MAX.range, `${c.weapon.range} tiles`],
    ['Aim', c.weapon.aim, STAT_MAX.aim, `${c.weapon.aim}`],
    ['Damage', avg, STAT_MAX.dmg, `${c.weapon.dmg[0]}–${c.weapon.dmg[1]}`],
  ];
  return rows.map(([k, v, m, label], i) =>
    `<div class="stat"><span class="sk">${k}</span><span class="sb"><i style="--w:${Math.max(4, Math.min(100, (v / m) * 100))}%;--d:${i * 40}ms"></i></span><span class="sv">${label}</span></div>`).join('');
}

export function randomCallsign(K) {
  const pool = K?.CALLSIGNS?.length ? K.CALLSIGNS : ['Rook', 'Vex', 'Salt', 'Kestrel', 'Brine', 'Mako', 'Tern', 'Gale'];
  const n = pool[Math.floor(Math.random() * pool.length)];
  return `${n}-${String(Math.floor(Math.random() * 90) + 10)}`.toUpperCase();
}
export const cleanCallsign = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ._-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);

// ------------------------------------------------------------------ menu

export function initMenu({ CLASSES, MODES, K, onDeploy, onClick, onHover, onEnter, qualityNow, onReplayTutorial, onShop, onLocker }) {
  const click = (fn) => (e) => { onClick?.(); fn(e); };
  const classKeys = () => Object.keys(CLASSES);

  // static icons
  $('howBtn').innerHTML = ICON.book;
  $('setBtn').innerHTML = ICON.gear;
  document.querySelector('#menu .cs-ic').innerHTML = ICON.user;
  $('csDice').innerHTML = ICON.refresh;
  document.querySelector('#shopBtn .mb-ic').innerHTML = ICON.shop;
  document.querySelector('#lockerBtn .mb-ic').innerHTML = ICON.locker;
  $('shopBtn').onclick = click(() => onShop?.());
  $('lockerBtn').onclick = click(() => onLocker?.());

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

  // ---- class carousel
  if (!CLASSES[settings.cls]) settings.cls = classKeys()[0];
  let lastIdx = classKeys().indexOf(settings.cls);
  const stage = document.querySelector('#classCarousel .car-stage');
  stage.innerHTML = classKeys().map((k) => `<div class="car-slide" data-cls="${k}">
      <div class="car-sil"></div>
      <div class="car-tier"></div>
      <div class="car-name"><b>${esc(CLASSES[k].name)}</b><small>${esc(CLASSES[k].weapon.name)}</small></div>
    </div>`).join('');
  document.querySelector('#classCarousel .prev').innerHTML = ICON.chevL;
  document.querySelector('#classCarousel .next').innerHTML = ICON.chevR;

  const pick = (k) => { if (k === settings.cls) return; onClick?.(); settings.cls = k; renderClasses(); };
  const step = (d) => { const ks = classKeys(); const i = ks.indexOf(settings.cls); pick(ks[(i + d + ks.length) % ks.length]); };
  document.querySelector('#classCarousel .prev').onclick = () => step(-1);
  document.querySelector('#classCarousel .next').onclick = () => step(1);
  for (const sl of stage.children) sl.onclick = () => pick(sl.dataset.cls);
  // swipe
  let sx = null, sy = 0;
  const car = $('classCarousel');
  car.addEventListener('pointerdown', (e) => { sx = e.clientX; sy = e.clientY; }, { passive: true });
  car.addEventListener('pointerup', (e) => {
    if (sx === null) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    sx = null;
    if (Math.abs(dx) > 34 && Math.abs(dx) > Math.abs(dy) * 1.2) { step(dx < 0 ? 1 : -1); e.preventDefault(); }
  });
  car.addEventListener('pointercancel', () => { sx = null; });

  let badgeSig = '';
  function refreshBadges() {
    const sig = classKeys().map((k) => M.classProgress(k).tier).join('') + settings.cls;
    if (sig === badgeSig) return;
    badgeSig = sig;
    for (const sl of stage.children) {
      const k = sl.dataset.cls;
      const p = M.classProgress(k);
      // Only the selected slide animates (Legend); the rest stay static to save work.
      sl.querySelector('.car-sil').innerHTML = badgeSVG(k, p.tier, { size: 104, animated: k === settings.cls });
      sl.querySelector('.car-tier').innerHTML = `<span class="tier-pill t${p.tier}">${p.name}</span>`;
    }
  }

  function layoutCarousel() {
    const ks = classKeys();
    const n = ks.length;
    const sel = ks.indexOf(settings.cls);
    for (const sl of stage.children) {
      const i = ks.indexOf(sl.dataset.cls);
      let off = i - sel;
      if (off > n / 2) off -= n;
      if (off < -n / 2) off += n;
      const a = Math.abs(off);
      sl.style.setProperty('--off', off);
      sl.style.setProperty('--abs', a);
      sl.style.zIndex = String(10 - a);
      sl.classList.toggle('sel', off === 0);
      sl.classList.toggle('far', a >= 2);
    }
  }

  function renderClasses() {
    const ks = classKeys();
    const idx = ks.indexOf(settings.cls);
    const dir = idx > lastIdx ? 1 : idx < lastIdx ? -1 : 0;
    lastIdx = idx;
    const cc = $('classChoices');
    cc.innerHTML = '';
    for (const k of ks) {
      const c = CLASSES[k];
      const b = document.createElement('button');
      b.className = 'class-tab' + (k === settings.cls ? ' sel' : '');
      b.dataset.cls = k;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(k === settings.cls));
      b.innerHTML = `<span class="ct-sil">${badgeSVG(k, M.classProgress(k).tier, { size: 26, animated: false, title: false })}</span><b>${esc(c.name)}</b>`;
      b.onclick = () => pick(k);
      b.onpointerenter = () => onHover?.();
      cc.appendChild(b);
    }
    $('classCount').textContent = `${idx + 1} / ${ks.length}`;
    refreshBadges();
    layoutCarousel();
    const P = M.classProgress(settings.cls);
    const c = CLASSES[settings.cls];
    const info = CLASS_INFO[settings.cls] || { role: c.desc };
    const abText = (key) => ({ ...(ABILITY_FALLBACK[key] || {}), ...((K?.ABILITY_TEXT || {})[key] || {}) });
    const ab = info.ability ? abText(info.ability) : null;
    const extra = info.extra ? abText(info.extra) : null;
    const frags = K?.START_FRAGS?.[settings.cls] ?? (settings.cls === 'assault' ? 2 : 0);
    const smokes = K?.START_SMOKES?.[settings.cls] ?? (settings.cls === 'recon' ? 1 : 0);
    const kit = [
      `<span class="kit">${ICON.medkit}1 Medkit</span>`,
      frags ? `<span class="kit">${ICON.grenade}${frags} Frag${frags > 1 ? 's' : ''}</span>` : '',
      smokes ? `<span class="kit">${ICON.smoke}${smokes} Smoke</span>` : '',
    ].join('');
    const det = $('classDetail');
    det.innerHTML = `
      <div class="cd-prestige t${P.tier}" title="Class prestige: earn XP by playing this class">
        <span class="cdp-tier">${P.name}</span>
        <span class="xpbar"><i style="--w:${Math.round(P.frac * 100)}%"></i></span>
        <span class="cdp-xp">${P.next === null ? 'Max tier' : `${P.toNext.toLocaleString('en-US')} XP to ${M.TIER_NAMES[P.tier + 1]}`}</span>
      </div>
      <div class="cd-body">
        <div class="cd-name">${esc(c.name)}<span>${esc(info.role || '')}</span></div>
        <p class="cd-desc">${esc(c.desc || '')}</p>
        <div class="stats">${statBars(c)}</div>
      </div>
      ${ab ? `<div class="cd-ability"><span class="ab-ic">${ICON[info.ability] || ''}</span><div><b>${esc(info.abilityName || ab.name)}</b><p>${esc(ab.desc)}</p></div></div>` : ''}
      ${extra ? `<div class="cd-ability alt"><span class="ab-ic">${ICON[info.extra] || ''}</span><div><b>${esc(extra.name)}</b><p>${esc(extra.desc)}</p></div></div>` : ''}
      <div class="cd-kit">${kit}<span class="kit dim">${ICON.hunker}Hunker</span></div>`;
    det.classList.remove('from-l', 'from-r');
    void det.offsetWidth;
    if (dir) det.classList.add(dir > 0 ? 'from-r' : 'from-l');
  }

  // ---- stages
  const STAGES = stageList(K);
  if (settings.stage !== 'random' && !STAGES.some((x) => x.key === settings.stage)) settings.stage = 'random';
  function renderStages() {
    const row = $('stageChoices');
    const opts = [...STAGES, { key: 'random', name: 'Random', tagline: 'Let the tide decide.', twist: 'A different stage every drop.', short: 'Any stage', icon: 'dice' }];
    row.innerHTML = opts.map((st) => `<button class="stage-card st-${st.key}${settings.stage === st.key ? ' sel' : ''}" data-stage="${st.key}" role="radio" aria-checked="${settings.stage === st.key}" title="${esc(st.tagline)}">
        ${stageArt(st.key)}<span class="st-meta"><b>${esc(st.name)}</b><small>${stageIcon(st)}${esc(st.short || '')}</small></span></button>`).join('');
    row.querySelectorAll('.stage-card').forEach((b) => {
      b.onclick = click(() => { settings.stage = b.dataset.stage; renderStages(); });
      b.onpointerenter = () => onHover?.();
    });
    const cur = opts.find((x) => x.key === settings.stage) || opts[opts.length - 1];
    $('stageDesc').textContent = cur.name;
    $('stageDetail').innerHTML = `<span class="sd-ic">${stageIcon(cur)}</span><div><b>${esc(cur.tagline)}</b><p>${esc(cur.twist)}</p></div>`;
    // Keep the chosen card in view on narrow, scrolling rows.
    const sel = row.querySelector('.sel');
    if (sel && row.scrollWidth > row.clientWidth) {
      const l = sel.offsetLeft - (row.clientWidth - sel.offsetWidth) / 2;
      row.scrollTo?.({ left: l, behavior: 'smooth' });
    }
  }

  // ---- wallet
  function renderWallet() {
    $('menuSalvage').innerHTML = `${ICON.coin}<b>${M.salvage().toLocaleString('en-US')}</b><small>Salvage</small>`;
    const cheapest = Math.min(...M.SLOTS.flatMap((sl) => M.catalog()[sl.key].filter((i) => !i.isDefault && !M.owns(sl.key, i.id)).map((i) => M.priceOf(i))), Infinity);
    $('shopDot').classList.toggle('hidden', !(M.salvage() >= cheapest));
  }

  // ---- callsign
  const cs = $('callsign');
  if (!settings.callsign) settings.callsign = randomCallsign(K);
  cs.value = settings.callsign;
  const commit = () => {
    const v = cleanCallsign(cs.value) || randomCallsign(K);
    settings.callsign = v;
    cs.value = v;
  };
  cs.addEventListener('input', () => {
    const pos = cs.selectionStart;
    const v = cs.value.toUpperCase().replace(/[^A-Z0-9 ._-]/g, '');
    if (v !== cs.value) { cs.value = v; try { cs.setSelectionRange(pos, pos); } catch { /* ignore */ } }
  });
  cs.addEventListener('change', commit);
  cs.addEventListener('blur', commit);
  cs.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); cs.blur(); } e.stopPropagation(); });
  $('csDice').onclick = click(() => { settings.callsign = randomCallsign(K); cs.value = settings.callsign; cs.classList.remove('flash'); void cs.offsetWidth; cs.classList.add('flash'); });

  // ---- career strip
  function renderCareer() {
    const c = career();
    const tile = (ic, v, k, cls = '') => `<div class="cr ${cls}"><span class="cr-ic">${ICON[ic]}</span><b>${v}</b><small>${k}</small></div>`;
    const winRate = c.matches ? Math.round((c.wins / c.matches) * 100) : 0;
    $('career').innerHTML = [
      tile('trophy', c.wins, c.wins === 1 ? 'Win' : 'Wins', c.wins ? 'hot' : ''),
      tile('skull', c.kills, 'Kills'),
      tile('squads', c.matches, c.matches === 1 ? 'Match' : 'Matches'),
      tile('medal', c.best ? `#${c.best}` : '–', 'Best'),
    ].join('') + (c.matches ? `<div class="cr-foot">${winRate}% win rate${c.streak > 1 ? ` · ${c.streak} win streak` : ''}${c.revives ? ` · ${c.revives} revive${c.revives === 1 ? '' : 's'}` : ''}</div>` : '<div class="cr-foot">No matches yet. Your record starts with the first drop.</div>');
  }

  $('wolfBox').onchange = () => { onClick?.(); settings.loneWolf = $('wolfBox').checked; };
  $('playBtn').onclick = click(() => onDeploy());
  $('howBtn').onclick = click(() => openSheet('howSheet'));
  $('setBtn').onclick = click(() => openSheet('settingsSheet'));
  $('howTut').onclick = click(() => { closeSheet('howSheet'); openTutorial(); });
  $('inviteBtn').onclick = () => { onClick?.(); toastFn?.('Online lobbies with invite codes are coming in a later build.', 'info'); };

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
    renderCareer();
    renderWallet();
    renderStages();
  }

  renderModes();
  renderClasses();
  renderCareer();
  renderWallet();
  renderStages();
  buildHowTo();
  initSettingsSheet({ onClick, qualityNow, onReplayTutorial: () => { closeSheet('settingsSheet'); openTutorial(); onReplayTutorial?.(); }, onResetCareer: renderCareer });
  initTutorial(onClick);
  for (const el of document.querySelectorAll('[data-close]')) {
    el.addEventListener('click', () => { onClick?.(); closeSheet(el.closest('.sheet').id); });
  }
  for (const sh of document.querySelectorAll('.sheet')) {
    sh.addEventListener('pointerdown', (e) => { if (e.target === sh) closeSheet(sh.id); });
    sh.addEventListener('keydown', (e) => trapFocus(e, sh));
  }
  return {
    renderModes, renderClasses, renderCareer, renderWallet, renderStages, showMenu, enter,
    refreshMeta: () => { badgeSig = ''; renderClasses(); renderWallet(); },
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

function initSettingsSheet({ onClick, qualityNow, onReplayTutorial, onResetCareer }) {
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
      ${row('Turn timer', 'How the 20s clock is shown', seg('timer', [['ring', 'Ring'], ['bar', 'Bar']], settings.timer))}
      ${row('Enemy turns', 'Playback speed of bot actions', seg('botSpeed', [['normal', 'Normal'], ['fast', 'Fast']], settings.botSpeed))}
      ${row('Haptics', hapticsSupported ? 'Vibrate on hits, kills and your turn' : 'Not supported on this device', seg('haptics', [[true, 'On'], [false, 'Off']], settings.haptics), hapticsSupported ? '' : 'na')}
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

// ------------------------------------------------------------------ how to play

function buildHowTo() {
  const card = (ic, title, text, cls = '') => `<div class="how ${cls}"><span class="how-ic">${ICON[ic]}</span><div><b>${title}</b><p>${text}</p></div></div>`;
  $('howBody').innerHTML = [
    card('clock', '20-second turns', 'Squads take turns. Your soldier has <b>2 AP</b>. When the clock runs out you go on overwatch automatically.'),
    card('tap', 'Tap, then tap again', 'Tap a tile to preview the route and the cover you will have there. Tap it again, or press <b>Confirm</b>, to commit. Cyan tiles cost 1 AP; gold is a 2 AP dash. Walls and crates <b>fade</b> while you pick a move, leaving shield outlines on the ground.'),
    card('shield', 'Cover is life', 'Shields show half and full cover at your destination. Shots from an open side <b>flank</b> you for +10 aim.'),
    card('shoot', 'Shooting ends your turn', 'Pick <b>Shoot</b> and every target shows its hit chance. Tap one to see graze odds and damage, then fire. <b>Firing always ends your turn</b>, so move first. Near-misses graze for half damage.'),
    card('grenade', 'Frags, Aimed Shot, Breach', 'Grenades blast a 3×3 area and wreck cover, friendly fire included. Marksmen line up Aimed Shots; Breachers blow cover apart.'),
    card('smoke', 'Smoke hides you', 'Anyone inside a smoke cloud is <b>invisible</b> to enemies more than a tile away. Shots into or out of smoke take <b>-20 aim</b>. Throwing smoke does not end your turn.'),
    card('patch', 'Medic: Patch', 'Heal yourself or an adjacent squadmate for 5, or pick a downed one straight back up at 4 HP.'),
    card('scan', 'Recon: Scan', 'Scan reveals everyone within 5 tiles of a point, through walls and smoke, until your next turn.'),
    card('revive', 'Downed, not out', 'In squad modes a soldier at 0 HP goes <b>down</b>. Any adjacent squadmate can revive for 1 AP. Downed soldiers bleed out after 2 of their turns, and any hit finishes them.'),
    card('hunker', 'Hunker and Overwatch', 'Hunker doubles your cover until your next turn. Overwatch fires at the first enemy that moves in your sight.'),
    card('tide', 'The tide rises', 'Every 2 rounds the water closes in. The <span class="c-cyan">cyan ring</span> is the next safe edge. Ending your turn in the water hurts, and it gets worse.'),
    card('stage', 'Five stages, five twists', '<b>Drowned Harbor</b>: the classic. <b>Kelp Shallows</b>: weed beds hide you. <b>Rig Graveyard</b>: barrels explode. <b>Night Spires</b>: dark, and gunfire lights flares. <b>Surge Point</b>: the safe zone drifts.', 'wide'),
    card('kelp', 'Kelp', 'Standing in kelp hides you from anyone more than <b>3 tiles</b> away and gives -10 aim against you. It is not cover: a close shooter still sees you in the open.'),
    card('barrelx', 'Explosive barrels', 'Red-banded barrels deal <b>4 damage</b> in a 3×3 when a frag, breach or blast hits them, and they chain. In Shoot mode you can fire at one: 1 AP, always hits, ends your turn.'),
    card('flare', 'Night and flares', 'At night you see 6 tiles. Firing lights a <b>flare</b> over the shooter: every squad can see them until their next turn. Shoot, then expect company.'),
    card('drift', 'Drifting zone', 'On Surge Point the safe circle moves each time it shrinks. Watch the dashed <span class="c-cyan">cyan ring</span> on the minimap and rotate early.'),
    card('crate', 'Crates and supply drops', 'Crates hold medkits, armor, scopes, heavy barrels, frags and smoke. Supply caches land inside the next ring on rounds 4, 8 and 12.'),
    card('medal', 'Prestige and Salvage', 'Every match earns <b>XP for the class you played</b>: placement, kills, damage and revives. Its badge grows through Recruit, Veteran, Elite, Master and Legend. You also earn <b>Salvage</b> to spend in the Shop on skins, kill effects and drop-ins.'),
    `<div class="how keys"><span class="how-ic">${ICON.gear}</span><div><b>Keyboard</b><p><kbd>1</kbd>–<kbd>9</kbd> actions · <kbd>Space</kbd> end turn · <kbd>Q</kbd>/<kbd>E</kbd> rotate · <kbd>Tab</kbd> next target · <kbd>Enter</kbd> confirm · <kbd>Esc</kbd> cancel · <kbd>F</kbd> find me · <kbd>R</kbd> revive</p></div></div>`,
  ].join('');
}

// ------------------------------------------------------------------ tutorial

const TUT = [
  { ic: 'tap', title: 'Tap, then tap again', art: 'move', text: 'Tap a tile to <b>preview</b> your route and the cover waiting there. Tap the same tile again to <b>commit</b>. Cover fades while you choose, so every tile stays readable.' },
  { ic: 'shield', title: 'Cover is life', art: 'cover', text: 'Full cover blocks 40 aim, half cover 20. Enemies on an open side <b>flank</b> you: +10 aim and extra damage. Hunker to double your cover.' },
  { ic: 'shoot', title: 'Firing ends your turn', art: 'shoot', text: 'You get <b>2 AP</b> and 20 seconds. Move first: <b>shooting always ends your turn</b>. Frags, smoke, Patch and Scan cost 1 AP and let you keep going.' },
  { ic: 'smoke', title: 'Smoke hides you', art: 'smoke', text: 'Inside smoke, enemies more than a tile away <b>can\'t see you</b>. Shots into or out of it take <b>-20 aim</b>. Use it to cross open ground.' },
  { ic: 'revive', title: 'Nobody left behind', art: 'revive', text: 'In squad modes, 0 HP means <b>downed</b>, not dead. Stand next to a downed squadmate and press <b>Revive</b>. They bleed out after 2 of their turns.' },
  { ic: 'stage', title: 'Every stage has a twist', art: 'stages', text: '<b>Kelp</b> hides you beyond 3 tiles. <b>Barrels</b> explode and chain. At <b>night</b>, firing lights a flare over you. On <b>Surge Point</b> the safe zone drifts.' },
  { ic: 'tide', title: 'The tide rises', art: 'tide', text: 'Every 2 rounds the safe ring shrinks. The <span class="c-cyan">cyan ring</span> shows where it goes next. Be the last squad above the water.' },
  { ic: 'medal', title: 'Badges grow with you', art: 'prestige', text: 'Each class earns its own XP. Its badge climbs from <b>Recruit</b> to an animated <b>Legend</b>. Salvage from every match buys skins, kill effects and drop-ins.' },
];

function tutArt(kind) {
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
