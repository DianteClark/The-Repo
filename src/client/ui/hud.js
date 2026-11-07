// HUD rendering helpers. Pure DOM: main.js owns the game state and calls in.

import { ICON, SILHOUETTE } from './icons.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- turn order strip ----------

export function renderTurnStrip(state, { myTeam, activeTeam, alive }) {
  const el = $('turnStrip');
  if (!el) return;
  const pos = state.turnPos;
  const solo = state.teams.every((t) => t.members.length <= 1);
  const html = state.order.map((t, i) => {
    const team = state.teams[t];
    const out = !alive.has(t);
    const cls = ['ts'];
    if (t === myTeam) cls.push('mine');
    if (t === activeTeam && state.winner === null) cls.push('cur');
    else if (i < pos) cls.push('done');
    if (out) cls.push('out');
    if (team.isLoneWolf) cls.push('wolf');
    const dots = solo ? '' : team.members.map((id) => { const m = state.units[id]; return `<i class="${!m.alive ? 'x' : m.downed ? 'dn' : ''}"></i>`; }).join('');
    return `<span class="${cls.join(' ')}" title="${t === myTeam ? 'Your squad' : 'Squad ' + (t + 1)}">${solo ? '' : dots}</span>`;
  }).join('');
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
  el.classList.toggle('solo', solo);
}

export function renderTurnLabel(text, kind) {
  const el = $('turnInfo');
  if (el._t === text + kind) return;
  el._t = text + kind;
  el.textContent = text;
  el.className = 'turn-label ' + kind;
}

// ---------- timer ----------

const RING_LEN = 2 * Math.PI * 22;
export function renderTimer({ left, total, active, style, over }) {
  const wrap = $('timer');
  const urgency = over ? 'over' : !active ? 'idle' : left <= 5 ? 'crit' : left <= 10 ? 'warn' : 'ok';
  const key = `${style}|${urgency}|${active}`;
  if (wrap._k !== key) {
    wrap._k = key;
    wrap.className = `timer ${style} ${urgency}`;
  }
  const frac = active ? Math.max(0, Math.min(1, left / total)) : 1;
  const arc = $('timerArc');
  if (arc) arc.style.strokeDashoffset = String(RING_LEN * (1 - frac));
  const bar = $('timerBarFill');
  if (bar) bar.style.transform = `scaleX(${frac})`;
  const t = $('timerText');
  const txt = active ? String(Math.ceil(left)) : '';
  if (t.textContent !== txt) t.textContent = txt;
}
export const TIMER_RING_LEN = RING_LEN;

// ---------- chips ----------

export function renderChips({ round, squadsLeft, squadsTotal, tideIn, tideDmg, outside, nextOutside }) {
  const el = $('roundInfo');
  const tideTxt = tideIn <= 1 ? 'Tide rises next round' : `Tide in ${tideIn}`;
  const html = `
    <span class="chip"><b>R${round}</b></span>
    <span class="chip">${ICON.squads}<b>${squadsLeft}</b><small>/${squadsTotal}</small></span>
    <span class="chip tide${tideIn <= 1 ? ' soon' : ''}${outside ? ' danger' : nextOutside ? ' warn' : ''}">${ICON.tide}<b>${tideTxt}</b><small>${tideDmg} dmg</small></span>`;
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
}

// ---------- unit card ----------

export function renderUnitCard(u, { CLASSES, myTurn, outside, nextOutside, weaponStats, spectating, aliveMates, callsign, inSmoke, spotted }) {
  const el = $('unitCard');
  if (!u) { el.innerHTML = ''; el._html = ''; return; }
  const c = CLASSES[u.cls];
  if (u.alive && u.downed) {
    const pips = Array.from({ length: Math.max(2, u.bleed || 0) }, (_, i) => `<i class="${i < (u.bleed || 0) ? 'on' : ''}"></i>`).join('');
    const html = `<div class="uc downed"><div class="uc-sil">${SILHOUETTE[u.cls] || ''}</div>
      <div class="uc-main"><div class="uc-top"><span class="uc-name">Downed</span><span class="tag bleed">${ICON.bleed}${u.bleed || 0} turn${u.bleed === 1 ? '' : 's'} left</span></div>
      <div class="uc-sub">${aliveMates ? 'Hold on. A squadmate next to you can revive you.' : 'No squadmate standing to revive you.'}</div></div>
      <div class="uc-bleed" title="Bleed-out counter"><span class="bl-pips">${pips}</span><small>Bleed</small></div></div>`;
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    return;
  }
  if (!u.alive) {
    const html = `<div class="uc dead"><div class="uc-sil">${SILHOUETTE[u.cls] || ''}</div>
      <div class="uc-main"><div class="uc-top"><span class="uc-name">Eliminated</span></div>
      <div class="uc-sub">${spectating ? (aliveMates ? `Spectating your squad · ${aliveMates} still fighting` : 'Spectating the match') : ''} · ${u.kills} kill${u.kills === 1 ? '' : 's'}</div></div></div>`;
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    return;
  }
  const prevHp = el._hp && el._hp.id === u.id ? el._hp.hp : u.hp;
  el._hp = { id: u.id, hp: u.hp };
  const hpPips = Array.from({ length: u.maxHp }, (_, i) => `<i class="${i < u.hp ? 'on' : ''}${i < u.hp && u.hp <= u.maxHp * 0.35 ? ' low' : ''}${i >= u.hp && i < prevHp ? ' lost' : ''}${i < u.hp && i >= prevHp ? ' gain' : ''}"></i>`).join('');
  const apPips = Array.from({ length: u.maxAp }, (_, i) => `<i class="${myTurn && i < u.ap ? 'on' : ''}"></i>`).join('');
  const armor = u.armor > 0 ? `<span class="armor" title="Armor: blocks ${u.armor} damage per hit">${ICON.shield}<b>${u.armor}</b></span>` : '';
  const tags = [
    u.isLoneWolf && `<span class="tag wolf">${ICON.wolf}Lone wolf</span>`,
    u.overwatch && `<span class="tag ow">${ICON.overwatch}Overwatch</span>`,
    u.hunkered && `<span class="tag hk">${ICON.hunker}Hunkered</span>`,
    inSmoke && `<span class="tag sm">${ICON.smoke}Smoke</span>`,
    spotted && `<span class="tag spot">${ICON.scan}Scanned</span>`,
    outside ? `<span class="tag danger">${ICON.tide}In the tide</span>` : nextOutside ? `<span class="tag warn">${ICON.tide}Tide next</span>` : '',
  ].filter(Boolean).join('');
  const ws = weaponStats;
  const gear = [
    `<span class="g wpn" title="${esc(c.weapon.name)}"><b>${esc(c.weapon.name)}</b> ${ws.range}t · ${ws.aim}% · ${ws.dmg[0]}–${ws.dmg[1]}</span>`,
    u.mods.scope ? `<span class="g mod" title="Scope ×${u.mods.scope}">${ICON.scope}${u.mods.scope}</span>` : '',
    u.mods.barrel ? `<span class="g mod" title="Heavy barrel ×${u.mods.barrel}">${ICON.barrel}${u.mods.barrel}</span>` : '',
    `<span class="g item${u.items.medkit ? '' : ' none'}" title="Medkits">${ICON.medkit}${u.items.medkit}</span>`,
    (u.items.frag ?? 0) > 0 || u.cls === 'assault' ? `<span class="g item${u.items.frag ? '' : ' none'}" title="Frag grenades">${ICON.grenade}${u.items.frag ?? 0}</span>` : '',
    (u.items.smoke ?? 0) > 0 || u.cls === 'recon' ? `<span class="g item${u.items.smoke ? '' : ' none'}" title="Smoke grenades">${ICON.smoke}${u.items.smoke ?? 0}</span>` : '',
    u.missStreak ? `<span class="g streak" title="Miss streak bonus">+${u.missStreak * 10}%</span>` : '',
  ].filter(Boolean).join('');
  const html = `<div class="uc">
    <div class="uc-sil">${SILHOUETTE[u.cls] || ''}</div>
    <div class="uc-main">
      <div class="uc-top"><span class="uc-name">${callsign ? `${esc(callsign)}<em>${esc(c.name)}</em>` : esc(c.name)}</span>${tags}</div>
      <div class="uc-hp"><span class="hp-pips${u.maxHp > 14 ? ' dense' : ''}">${hpPips}</span><span class="hp-num">${u.hp}<small>/${u.maxHp}</small></span>${armor}</div>
      <div class="uc-gear">${gear}</div>
    </div>
    <div class="uc-ap${myTurn ? ' live' : ''}" title="Action points"><span class="ap-pips">${apPips}</span><small>AP</small></div>
  </div>`;
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
}

// ---------- action bar ----------

export function renderActions(list, onPress) {
  const el = $('actions');
  const sig = list.map((a) => `${a.key}:${a.state}:${a.badge ?? ''}:${a.reason ?? ''}:${a.label}`).join('|');
  if (el._sig === sig) return;
  el._sig = sig;
  el.innerHTML = '';
  for (const a of list) {
    const b = document.createElement('button');
    b.className = `act ${a.state}${a.key === 'end' ? ' end' : ''}`;
    b.dataset.act = a.key;
    b.setAttribute('aria-disabled', a.state === 'off' ? 'true' : 'false');
    b.title = a.state === 'off' && a.reason ? `${a.label}: ${a.reason}` : a.label + (a.hotkey ? ` [${a.hotkey}]` : '');
    b.innerHTML = `<span class="ai">${ICON[a.icon] || ''}</span><span class="al">${a.label}</span>`
      + (a.badge !== undefined && a.badge !== null && a.badge !== '' ? `<span class="badge${a.badgeKind ? ' ' + a.badgeKind : ''}">${a.badge}</span>` : '')
      + (a.hotkey ? `<kbd>${a.hotkey}</kbd>` : '');
    b.addEventListener('click', (e) => { e.stopPropagation(); onPress(a); });
    el.appendChild(b);
  }
}

// ---------- context panel (move confirm / target / grenade / breach) ----------

export function showContext(html, kind) {
  const el = $('targetPanel');
  el.className = `panel ctx ${kind}`;
  $('ctxBody').innerHTML = html;
  el.classList.remove('hidden');
  document.body.style.setProperty('--ctx-h', el.offsetHeight + 'px');
  document.body.classList.add('ctx-open');
  requestAnimationFrame(() => el.classList.add('open'));
}
export function hideContext() {
  const el = $('targetPanel');
  el.classList.remove('open');
  el.classList.add('hidden');
  document.body.classList.remove('ctx-open');
  document.body.style.setProperty('--ctx-h', '0px');
}

// ---------- feed / toasts / banners ----------

export function feedKill({ killer, victim, cause, killerMine, victimMine }) {
  const f = $('feed');
  const d = document.createElement('div');
  d.className = 'kf' + (killerMine ? ' by-me' : '') + (victimMine ? ' on-me' : '');
  const ic = CAUSE_ICON[cause] || ICON.skull;
  const note = { tide: 'drowned', bleed: 'bled out', downed: 'down' }[cause] || 'down';
  d.innerHTML = killer
    ? `<span class="a ${killerMine ? 'mine' : ''}">${esc(killer)}</span><span class="kic">${ic}</span><span class="b ${victimMine ? 'mine' : ''}">${esc(victim)}</span>`
    : `<span class="kic ${cause === 'tide' ? 'tide' : ''}">${ic}</span><span class="b ${victimMine ? 'mine' : ''}">${esc(victim)}</span><small>${note}</small>`;
  pushFeed(d);
}
const CAUSE_ICON = { shoot: ICON.shoot, aimed: ICON.aimed, grenade: ICON.grenade, breach: ICON.breach, tide: ICON.tide, overwatch: ICON.overwatch, bleed: ICON.bleed, execute: ICON.skull };

/** One feed line: [a] icon [b] note. kind: down | revive | patch | scan | smoke */
export function feedLine({ a, aMine, icon, b, bMine, note, kind = '' }) {
  const d = document.createElement('div');
  d.className = `kf ev ${kind}` + (aMine || bMine ? ' mineish' : '');
  d.innerHTML = (a ? `<span class="a ${aMine ? 'mine' : ''}">${esc(a)}</span>` : '')
    + `<span class="kic">${ICON[icon] || ''}</span>`
    + (b ? `<span class="b ${bMine ? 'mine' : ''}">${esc(b)}</span>` : '')
    + (note ? `<small>${esc(note)}</small>` : '');
  pushFeed(d);
}

let merged = null;
export function feedInfo(msg, kind = '') {
  // Off-screen gunfire arrives in bursts: fold it into one line.
  const m = /^Gunfire to the (\w+)/.exec(msg);
  if (m && merged && merged.el.isConnected && performance.now() - merged.t < 4000) {
    if (!merged.dirs.includes(m[1])) merged.dirs.push(m[1]);
    merged.n++;
    merged.t = performance.now();
    merged.el.textContent = `Gunfire ${merged.dirs.join(' · ')}${merged.n > merged.dirs.length ? ` ×${merged.n}` : ''}`;
    return;
  }
  const d = document.createElement('div');
  d.className = 'kf info ' + kind;
  d.textContent = m ? `Gunfire ${m[1]}` : msg;
  if (m) merged = { el: d, dirs: [m[1]], n: 1, t: performance.now() };
  pushFeed(d);
}

function pushFeed(d) {
  const f = $('feed');
  f.prepend(d);
  requestAnimationFrame(() => d.classList.add('in'));
  while (f.children.length > 5) f.lastChild.remove();
  setTimeout(() => { d.classList.add('fade'); setTimeout(() => d.remove(), 600); }, 7000);
}

export function clearFeed() { $('feed').innerHTML = ''; $('toasts').innerHTML = ''; merged = null; }

export function toast(msg, kind = 'info', iconName) {
  const t = $('toasts');
  const d = document.createElement('div');
  d.className = 'toast ' + kind;
  const ic = iconName ? ICON[iconName] : kind === 'error' ? ICON.warn : kind === 'loot' ? ICON.crate : '';
  d.innerHTML = `${ic ? `<span class="ti">${ic}</span>` : ''}<span>${esc(msg)}</span>`;
  t.appendChild(d);
  requestAnimationFrame(() => d.classList.add('in'));
  while (t.children.length > 3) t.firstChild.remove();
  setTimeout(() => { d.classList.remove('in'); d.classList.add('out'); setTimeout(() => d.remove(), 350); }, kind === 'error' ? 2200 : 2800);
}

let bannerTimer = 0;
export function banner(text, kind = 'you', sub = '', ms = 1400) {
  const b = $('banner');
  b.className = 'banner ' + kind;
  b.innerHTML = `<div class="bn-stripe"></div><div class="bn-text">${esc(text)}</div>${sub ? `<div class="bn-sub">${esc(sub)}</div>` : ''}`;
  b.style.animationDuration = ms + 'ms';
  void b.offsetWidth; // restart animation
  b.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.remove('show'), ms);
}
export function hideBanner() { clearTimeout(bannerTimer); $('banner').classList.remove('show'); }

// ---------- squad alert (downed teammates) ----------

/**
 * list: [{id, name, cls, bleed, adjacent, isPlayer}] — downed squadmates.
 * opts: { canAct, onRevive(id), onFind(id), selfDowned }
 */
export function renderSquadAlert(list, opts = {}) {
  const el = $('squadAlert');
  if (!list.length) {
    if (!el.classList.contains('hidden')) { el.classList.add('hidden'); el.innerHTML = ''; el._sig = ''; }
    return;
  }
  const sig = JSON.stringify(list) + '|' + !!opts.canAct;
  if (el._sig === sig) return;
  el._sig = sig;
  el.classList.remove('hidden');
  el.innerHTML = list.map((m) => {
    const btn = m.isPlayer ? ''
      : m.adjacent && opts.canAct ? `<button class="btn sm sa-rev" data-id="${m.id}">${ICON.revive}<span>Revive</span><small>1 AP</small></button>`
      : `<button class="btn ghost sm sa-find" data-id="${m.id}" title="Show on map">${ICON.focus}<span>${opts.canAct ? 'Move next to them' : 'Find'}</span></button>`;
    const pips = Array.from({ length: 2 }, (_, i) => `<i class="${i < m.bleed ? 'on' : ''}"></i>`).join('');
    return `<div class="sa-row${m.bleed <= 1 ? ' crit' : ''}${m.isPlayer ? ' me' : ''}">
      <span class="sa-ic">${ICON.downed}</span>
      <div class="sa-txt"><b>${esc(m.isPlayer ? 'You are down' : `${m.name} is down`)}</b><small><span class="bl-pips">${pips}</span>${m.bleed} turn${m.bleed === 1 ? '' : 's'} to bleed out</small></div>
      ${btn}</div>`;
  }).join('');
  el.querySelectorAll('.sa-rev').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); opts.onRevive?.(Number(b.dataset.id)); }; });
  el.querySelectorAll('.sa-find').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); opts.onFind?.(Number(b.dataset.id)); }; });
}

// ---------- damage direction + screen edge juice ----------

/** angle: radians, 0 = up (towards the top of the screen), clockwise. */
export function damageDir(angle, kind = 'enemy', strength = 1) {
  const host = $('dmgDir');
  if (!host) return;
  const d = document.createElement('i');
  d.className = 'dd ' + kind;
  d.style.setProperty('--a', `${angle}rad`);
  d.style.setProperty('--s', String(0.7 + Math.min(1, strength) * 0.5));
  host.appendChild(d);
  while (host.children.length > 4) host.firstChild.remove();
  setTimeout(() => d.remove(), 1500);
}

let glowT = 0;
/** kind: you (amber turn start) | hurt | heal | tide */
export function edgeGlow(kind, ms = 900) {
  const g = $('edgeGlow');
  if (!g) return;
  g.className = '';
  void g.offsetWidth;
  g.className = 'show ' + kind;
  g.style.animationDuration = ms + 'ms';
  clearTimeout(glowT);
  glowT = setTimeout(() => { g.className = ''; }, ms);
}
export function clearJuice() {
  const h = $('dmgDir'); if (h) h.innerHTML = '';
  const g = $('edgeGlow'); if (g) g.className = '';
  clearTimeout(glowT);
  renderSquadAlert([]);
}
