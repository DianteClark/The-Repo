// Title screen, loadout (mode + class), settings and how-to-play sheets.

import { ICON, SILHOUETTE } from './icons.js';
import { settings } from './settings.js';

const $ = (id) => document.getElementById(id);

export const CLASS_INFO = {
  assault: {
    role: 'Frontline all-rounder',
    ability: { icon: 'grenade', name: 'Frag Grenades ×2', desc: 'Lob up to 7 tiles. 3 damage to everyone in a 3×3 blast, and it shreds cover. Does not end your turn.' },
  },
  marksman: {
    role: 'Long-range precision',
    ability: { icon: 'aimed', name: 'Aimed Shot', desc: '+15 aim and +2 damage on one carefully placed round. 3-round cooldown. Ends your turn.' },
  },
  breacher: {
    role: 'Close-quarters bruiser',
    ability: { icon: 'breach', name: 'Breach', desc: 'Blow apart adjacent cover: the tile opens up and enemies within 1 tile take 4 damage. 3-round cooldown.' },
  },
};

const MODE_INFO = {
  solos: { line: '16 × 1', desc: 'Every soldier for themselves.' },
  duos: { line: '8 × 2', desc: 'You and one bot partner.' },
  trios: { line: '5 × 3 + Wolf', desc: 'Five trios and one Lone Wolf.' },
  quads: { line: '4 × 4', desc: 'Four full squads collide.' },
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
  return rows.map(([k, v, m, label]) =>
    `<div class="stat"><span class="sk">${k}</span><span class="sb"><i style="--w:${Math.max(4, Math.min(100, (v / m) * 100))}%"></i></span><span class="sv">${label}</span></div>`).join('');
}

export function initMenu({ CLASSES, MODES, onDeploy, onClick, onHover }) {
  const click = (fn) => (e) => { onClick?.(); fn(e); };

  function renderModes() {
    const mc = $('modeChoices');
    mc.innerHTML = '';
    for (const [k, m] of Object.entries(MODES)) {
      const b = document.createElement('button');
      b.className = 'mode-card' + (k === settings.mode ? ' sel' : '');
      b.dataset.mode = k;
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

  function renderClasses() {
    const cc = $('classChoices');
    cc.innerHTML = '';
    for (const [k, c] of Object.entries(CLASSES)) {
      const b = document.createElement('button');
      b.className = 'class-card' + (k === settings.cls ? ' sel' : '');
      b.dataset.cls = k;
      b.innerHTML = `${SILHOUETTE[k] || ''}<b>${c.name}</b><small>${c.weapon.name}</small>`;
      b.onclick = click(() => { settings.cls = k; renderClasses(); });
      b.onpointerenter = () => onHover?.();
      cc.appendChild(b);
    }
    const c = CLASSES[settings.cls];
    const info = CLASS_INFO[settings.cls] || { role: c.desc, ability: null };
    $('classDetail').innerHTML = `
      <div class="cd-art">${SILHOUETTE[settings.cls] || ''}</div>
      <div class="cd-body">
        <div class="cd-name">${c.name}<span>${info.role}</span></div>
        <p class="cd-desc">${c.desc}</p>
        <div class="stats">${statBars(c)}</div>
      </div>
      ${info.ability ? `<div class="cd-ability"><span class="ab-ic">${ICON[info.ability.icon]}</span><div><b>${info.ability.name}</b><p>${info.ability.desc}</p></div></div>` : ''}
      <div class="cd-ability minor"><span class="ab-ic">${ICON.hunker}</span><div><b>Hunker Down</b><p>Any class. Doubles your cover and blocks grazes until your next turn.</p></div></div>`;
  }

  $('wolfBox').onchange = () => { onClick?.(); settings.loneWolf = $('wolfBox').checked; };
  $('playBtn').onclick = click(() => onDeploy());
  $('howBtn').onclick = click(() => openSheet('howSheet'));
  $('setBtn').onclick = click(() => openSheet('settingsSheet'));
  $('inviteBtn').onclick = () => { onClick?.(); toastFn?.('Online lobbies with invite codes are coming in the next build.', 'info'); };

  renderModes();
  renderClasses();
  buildHowTo();
  initSettingsSheet(onClick);
  for (const el of document.querySelectorAll('[data-close]')) {
    el.addEventListener('click', () => { onClick?.(); closeSheet(el.closest('.sheet').id); });
  }
  for (const sh of document.querySelectorAll('.sheet')) {
    sh.addEventListener('pointerdown', (e) => { if (e.target === sh) closeSheet(sh.id); });
  }
  return { renderModes, renderClasses };
}

let toastFn = null;
export function setMenuToast(fn) { toastFn = fn; }

const sheetCloseHooks = new Map();
export function onSheetClose(id, fn) { sheetCloseHooks.set(id, fn); }
export function openSheet(id) {
  const el = $(id);
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('open'));
}
export function closeSheet(id) {
  const el = $(id);
  if (!el || el.classList.contains('hidden')) return;
  el.classList.remove('open');
  setTimeout(() => el.classList.add('hidden'), 220);
  sheetCloseHooks.get(id)?.();
}
export const sheetOpen = () => [...document.querySelectorAll('.sheet')].some((s) => !s.classList.contains('hidden'));
export function closeTopSheet() {
  const open = [...document.querySelectorAll('.sheet')].filter((s) => !s.classList.contains('hidden'));
  if (!open.length) return false;
  closeSheet(open[open.length - 1].id);
  return true;
}

function seg(name, options, value) {
  return `<div class="seg" data-setting="${name}">${options.map(([v, label]) =>
    `<button data-v="${v}" class="${String(v) === String(value) ? 'on' : ''}">${label}</button>`).join('')}</div>`;
}

function initSettingsSheet(onClick) {
  const body = $('settingsBody');
  const render = () => {
    body.innerHTML = `
      <div class="set-row"><div><b>Sound</b><small>Music and effects volume</small></div>
        <div class="vol"><button id="setMute" class="icon-btn sm">${settings.muted ? ICON.soundOff : ICON.soundOn}</button>
        <input id="setVol" type="range" min="0" max="100" value="${Math.round(settings.volume * 100)}" /></div></div>
      <div class="set-row"><div><b>Graphics</b><small>Low turns off shadows and post-FX</small></div>
        ${seg('quality', [['auto', 'Auto'], ['high', 'High'], ['low', 'Low']], settings.quality)}</div>
      <div class="set-row"><div><b>Cinematic camera</b><small>Action cam on shots and kills</small></div>
        ${seg('cinematic', [[true, 'On'], [false, 'Off']], settings.cinematic)}</div>
      <div class="set-row"><div><b>Camera follow</b><small>Track whoever is acting</small></div>
        ${seg('follow', [[true, 'On'], [false, 'Off']], settings.follow)}</div>
      <div class="set-row"><div><b>Turn timer</b><small>How the 20s clock is shown</small></div>
        ${seg('timer', [['ring', 'Ring'], ['bar', 'Bar']], settings.timer)}</div>
      <div class="set-row"><div><b>Enemy turns</b><small>Playback speed of bot actions</small></div>
        ${seg('botSpeed', [['normal', 'Normal'], ['fast', 'Fast']], settings.botSpeed)}</div>`;
    body.querySelectorAll('.seg').forEach((s) => {
      s.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          onClick?.();
          const raw = b.dataset.v;
          settings[s.dataset.setting] = raw === 'true' ? true : raw === 'false' ? false : raw;
          render();
        };
      });
    });
    $('setVol').oninput = (e) => { settings.volume = Number(e.target.value) / 100; if (settings.muted) { settings.muted = false; $('setMute').innerHTML = ICON.soundOn; } };
    $('setMute').onclick = () => { onClick?.(); settings.muted = !settings.muted; render(); };
  };
  render();
}

function buildHowTo() {
  const card = (ic, title, text) => `<div class="how"><span class="how-ic">${ICON[ic]}</span><div><b>${title}</b><p>${text}</p></div></div>`;
  $('howBody').innerHTML = [
    card('clock', '20-second turns', 'Squads take turns. Your soldier has <b>2 AP</b>. When the clock runs out you go on overwatch automatically.'),
    card('tap', 'Tap, then tap again', 'Tap a tile to preview the route and the cover you will have there. Tap it again, or press <b>Confirm</b>, to commit. Cyan tiles cost 1 AP; gold is a 2 AP dash.'),
    card('shield', 'Cover is life', 'Shields show half and full cover at your destination. Shots from an open side <b>flank</b> you for +10 aim.'),
    card('shoot', 'Shooting', 'Pick <b>Shoot</b> and every target shows its hit chance. Tap one to see graze odds and damage, then fire. Firing ends your turn. Near-misses graze for half damage.'),
    card('grenade', 'Frags, Aimed Shot, Breach', 'Grenades blast a 3×3 area and wreck cover, friendly fire included. Marksmen line up Aimed Shots; Breachers blow cover apart.'),
    card('hunker', 'Hunker and Overwatch', 'Hunker doubles your cover until your next turn. Overwatch fires at the first enemy that moves in your sight.'),
    card('tide', 'The tide rises', 'Every 2 rounds the water closes in. The <span class="c-cyan">cyan ring</span> is the next safe edge. Ending your turn in the water hurts, and it gets worse.'),
    card('crate', 'Crates and supply drops', 'Crates hold medkits, armor plates, scopes, heavy barrels and frags. Supply caches land inside the next ring on rounds 4, 8 and 12.'),
    `<div class="how keys"><span class="how-ic">${ICON.gear}</span><div><b>Keyboard</b><p><kbd>1</kbd>–<kbd>7</kbd> actions · <kbd>Space</kbd> end turn · <kbd>Q</kbd>/<kbd>E</kbd> rotate · <kbd>Tab</kbd> next target · <kbd>Enter</kbd> confirm · <kbd>Esc</kbd> cancel · <kbd>F</kbd> find me</p></div></div>`,
  ].join('');
}
