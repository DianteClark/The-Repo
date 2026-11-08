// HUD rendering helpers. Pure DOM: main.js owns the game state and calls in.

import { ICON } from './icons.js';
import { badgeCached } from './badges.js';
import { squadColor } from './squads.js';
import { perkByKey } from './arsenal.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- turn order strip ----------

export function renderTurnStrip(state, { myTeam, activeTeam, activeTeams = null, alive }) {
  const el = $('turnStrip');
  if (!el) return;
  const pos = state.turn ? Infinity : state.turnPos; // engagement turns: no single cursor
  const solo = state.teams.every((t) => t.members.length <= 1);
  const html = state.order.map((t, i) => {
    const team = state.teams[t];
    const out = !alive.has(t);
    const cls = ['ts'];
    if (t === myTeam) cls.push('mine');
    if ((activeTeams ? activeTeams.includes(t) : t === activeTeam) && state.winner === null) cls.push('cur');
    else if (state.turn ? state.turn.done?.includes(t) : i < pos) cls.push('done');
    if (out) cls.push('out');
    if (team.isLoneWolf) cls.push('wolf');
    const dots = solo ? '' : team.members.map((id) => { const m = state.units[id]; return `<i class="${!m.alive ? 'x' : m.downed ? 'dn' : ''}"></i>`; }).join('');
    return `<span class="${cls.join(' ')}" style="--sq:${squadColor(t, myTeam)}" title="${t === myTeam ? 'Your squad' : 'Squad ' + (t + 1)}">${solo ? '' : dots}</span>`;
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

// ---------- top bar stats (round · squads · tide) ----------

export function renderChips({ round, squadsLeft, squadsTotal, tideIn, tideDmg, outside, nextOutside }) {
  const el = $('roundInfo');
  const tide = outside ? 'IN TIDE' : tideIn <= 1 ? 'NEXT' : `IN ${tideIn}`;
  const cls = outside ? ' danger' : nextOutside ? ' warn' : tideIn <= 1 ? ' soon' : '';
  const html = `<span class="tsx-r" title="Round ${round}"><small>R</small><b>${round}</b></span>
    <span class="tsx-sq" title="${squadsLeft} of ${squadsTotal} squads left">${ICON.squads}<b>${squadsLeft}</b><small>/${squadsTotal}</small></span>
    <span class="tsx-tide${cls}" title="${outside ? `You are in the tide: ${tideDmg} damage at the end of your turn` : tideIn <= 1 ? 'The tide rises next round' : `The tide rises in ${tideIn} rounds`} · ${tideDmg} damage">${ICON.tide}<b>${tide}</b><small>−${tideDmg}</small></span>`;
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
}

// ---------- unit card ----------

/** Compact soldier card: badge · name/class · HP bar · status tags · AP. Always one tidy block. */
export function renderUnitCard(u, { CLASSES, myTurn, outside, nextOutside, spectating, aliveMates, callsign, inSmoke, spotted, tier = 0, inKelp, flared, inShallows, boat = null }) {
  const badge = (dim) => `<div class="uc-badge${dim ? ' dim' : ''}">${u ? badgeCached(u.cls, tier, { size: 44, animated: tier >= 4 && !dim }) : ''}</div>`;
  const el = $('unitCard');
  if (!u) { el.innerHTML = ''; el._html = ''; return; }
  const c = CLASSES[u.cls];
  if (u.alive && u.downed) {
    const pips = Array.from({ length: Math.max(2, u.bleed || 0) }, (_, i) => `<i class="${i < (u.bleed || 0) ? 'on' : ''}"></i>`).join('');
    const html = `<div class="uc downed">${badge(true)}
      <div class="uc-main"><div class="uc-top"><span class="uc-name">Downed</span></div>
      <div class="uc-sub">${aliveMates ? 'A squadmate next to you can revive you' : 'No squadmate left to revive you'}</div></div>
      <div class="uc-side" title="Bleed-out counter"><span class="bl-pips">${pips}</span><small>${u.bleed || 0} turn${u.bleed === 1 ? '' : 's'}</small></div></div>`;
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    return;
  }
  if (!u.alive) {
    const html = `<div class="uc dead">${badge(true)}
      <div class="uc-main"><div class="uc-top"><span class="uc-name">Eliminated</span><span class="uc-cls">${u.kills} kill${u.kills === 1 ? '' : 's'}</span></div>
      <div class="uc-sub">${spectating ? (aliveMates ? `Spectating your squad · ${aliveMates} still fighting` : 'Spectating the match') : 'Out of the match'}</div></div></div>`;
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    return;
  }
  const prevHp = el._hp && el._hp.id === u.id ? el._hp.hp : u.hp;
  el._hp = { id: u.id, hp: u.hp };
  const pct = (n) => `${Math.max(0, Math.min(100, (n / Math.max(1, u.maxHp)) * 100))}%`;
  const low = u.hp <= u.maxHp * 0.35;
  const ticks = u.maxHp <= 20 ? Array.from({ length: u.maxHp - 1 }, (_, i) => `<i style="left:${pct(i + 1)}"></i>`).join('') : '';
  const apPips = Array.from({ length: u.maxAp }, (_, i) => `<i class="${myTurn && i < u.ap ? 'on' : ''}"></i>`).join('');
  // Status tags: the most urgent first; the row never wraps (extra tags collapse to icons).
  const tags = [
    outside ? `<span class="tag danger" title="In the tide: you take damage at the end of your turn">${ICON.tide}<em>In the tide</em></span>` : '',
    !outside && nextOutside ? `<span class="tag warn" title="Outside the next safe ring">${ICON.tide}<em>Tide next</em></span>` : '',
    flared ? `<span class="tag flare" title="Your gunfire lit a flare: every squad can see you until your next turn">${ICON.flare}<em>Flared</em></span>` : '',
    !flared && inSmoke ? `<span class="tag hid" title="Hidden in smoke: enemies more than a tile away can't see you">${ICON.hidden}<em>Smoke</em></span>` : '',
    !flared && !inSmoke && inKelp ? `<span class="tag hid" title="Hidden in kelp: enemies more than 3 tiles away can't see you">${ICON.hidden}<em>Kelp</em></span>` : '',
    boat ? `<span class="tag boat" title="Aboard a boat: half cover, no tide damage">${ICON.boat}<em>Hull ${boat.hp}${boat.driver ? ` · fuel ${boat.fuel}` : ''}</em></span>` : '',
    spotted ? `<span class="tag spot" title="Scanned: an enemy squad can see you through walls">${ICON.scan}<em>Scanned</em></span>` : '',
    u.overwatch ? `<span class="tag ow" title="Overwatch">${ICON.overwatch}<em>Watch</em></span>` : '',
    u.hunkered ? `<span class="tag hk" title="Hunkered">${ICON.hunker}<em>Hunker</em></span>` : '',
    !boat && inShallows ? `<span class="tag" title="Shallow water: costs double movement">${ICON.water}<em>Shallows</em></span>` : '',
    u.isLoneWolf ? `<span class="tag wolf" title="Lone Wolf">${ICON.wolf}<em>Wolf</em></span>` : '',
    u.missStreak ? `<span class="tag ms" title="Miss streak bonus">+${u.missStreak * 10}%</span>` : '',
  ].filter(Boolean);
  const perks = Array.isArray(u.perks) && u.perks.length ? `<span class="uc-perks">${u.perks.map((p, i) => `<i class="pt${i + 1}" title="${esc(perkByKey(p)?.name || p)}: ${esc(perkByKey(p)?.desc || '')}">${ICON.perk}</i>`).join('')}</span>` : '';
  const html = `<div class="uc${flared ? ' flared' : ''}${low ? ' low' : ''}">
    ${badge(false)}
    <div class="uc-main">
      <div class="uc-top"><span class="uc-name">${esc(callsign || c?.name || u.cls)}</span><span class="uc-cls">${esc(c?.name || u.cls)}</span>${perks}</div>
      <div class="uc-hp"><span class="hpbar${low ? ' low' : ''}"><i class="lost" style="width:${pct(Math.max(prevHp, u.hp))}"></i><i class="fill" style="width:${pct(u.hp)}"></i>${ticks}</span><span class="hp-num">${u.hp}<small>/${u.maxHp}</small></span>${u.armor > 0 ? `<span class="armor" title="Armor: blocks ${u.armor} damage per hit">${ICON.shield}<b>${u.armor}</b></span>` : ''}</div>
      ${tags.length ? `<div class="uc-tags">${tags.join('')}</div>` : ''}
    </div>
    <div class="uc-side uc-ap${myTurn ? ' live' : ''}" title="Action points"><span class="ap-pips">${apPips}</span><small>AP</small></div>
  </div>`;
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
}

// ---------- action bar + gear tray ----------

/**
 * list: [{key, icon, label, state, badge, badgeKind, reason, hotkey, endsTurn, cls, group?}].
 * Items with group:'gear' (lethal, tactical, medkit) live in the Gear tray; the bar shows one
 * Gear button for them. gear: {open, onToggle}.
 */
export function renderActions(list, onPress, gear = {}) {
  const el = $('actions');
  const main = list.filter((a) => a.group !== 'gear');
  const kit = list.filter((a) => a.group === 'gear');
  const sig = list.map((a) => `${a.key}:${a.state}:${a.badge ?? ''}:${a.badgeKind ?? ''}:${a.reason ?? ''}:${a.label}:${a.icon}`).join('|') + `|g${!!gear.open}`;
  if (el._sig !== sig) {
    el._sig = sig;
    el.innerHTML = '';
    const items = [...main];
    if (kit.length) {
      // Gear goes after the class ability (or Shoot): Move · Shoot · Ability · Gear · …
      const at = Math.max(items.findIndex((a) => a.key === 'shoot'), items.findIndex((a) => a.cls?.includes('ability') && ['aimed', 'breach', 'patch', 'scan', 'cover', 'suppress'].includes(a.key))) + 1;
      const active = kit.find((a) => a.state === 'active');
      const ready = kit.filter((a) => a.state !== 'off').length;
      const total = kit.reduce((n, a) => n + (Number(a.badge) || 0), 0);
      items.splice(at || 2, 0, {
        key: 'gear', icon: active?.icon || 'grenade', label: active ? active.label : 'Gear', state: active ? 'active' : gear.open ? 'open' : ready ? 'on' : 'off',
        badge: total || null, badgeKind: total ? 'ch' : 'zero', hotkey: 'G', cls: 'gearbtn', reason: ready ? null : kit[0]?.reason || 'No gear left', isGear: true,
      });
    }
    for (const a of items) {
      const b = document.createElement('button');
      b.className = `act ${a.state}${a.cls ? ' ' + a.cls : ''}`;
      b.dataset.act = a.key;
      b.setAttribute('aria-disabled', a.state === 'off' ? 'true' : 'false');
      if (a.isGear) b.setAttribute('aria-expanded', String(!!gear.open));
      b.title = (a.state === 'off' && a.reason ? `${a.label}: ${a.reason}` : a.label + (a.hotkey ? ` [${a.hotkey}]` : '')) + (a.endsTurn ? ' · ends your turn' : '');
      if (a.endsTurn) b.classList.add('ends');
      b.innerHTML = `<span class="ai">${ICON[a.icon] || ''}</span><span class="al">${esc(a.label)}</span>`
        + (a.badge !== undefined && a.badge !== null && a.badge !== '' ? `<span class="badge${a.badgeKind ? ' ' + a.badgeKind : ''}">${a.badge}</span>` : '')
        + (a.hotkey ? `<kbd>${a.hotkey}</kbd>` : '')
        + (a.endsTurn ? `<i class="et" aria-label="ends turn">${ICON.endturn}</i>` : '')
        + (a.isGear ? `<i class="gx" aria-hidden="true">${ICON.chevU || '▴'}</i>` : '');
      b.addEventListener('click', (e) => { e.stopPropagation(); if (a.isGear && a.state !== 'active') gear.onToggle?.(); else onPress(a.isGear ? kit.find((k) => k.state === 'active') || a : a); });
      el.appendChild(b);
    }
    el.style.setProperty('--n', String(items.length));
  }
  renderGearTray(kit, onPress, gear);
}

function renderGearTray(kit, onPress, gear) {
  const el = $('gearTray');
  if (!el) return;
  const open = !!gear.open && kit.length > 0;
  const sig = open ? kit.map((a) => `${a.key}:${a.state}:${a.badge}:${a.label}:${a.reason}`).join('|') : '';
  el.classList.toggle('hidden', !open);
  document.body.classList.toggle('gear-open', open);
  if (el._sig === sig) return;
  el._sig = sig;
  el.innerHTML = open ? kit.map((a) => `<button class="gt ${a.state}${a.cls ? ' ' + a.cls : ''}" data-k="${a.key}" title="${esc(a.state === 'off' && a.reason ? a.reason : a.label)}">
      <span class="gt-ic">${ICON[a.icon] || ''}</span><span class="gt-t"><b>${esc(a.label)}</b><small>${esc(a.state === 'off' ? a.reason || '' : a.sub || '')}</small></span>
      <span class="gt-n${Number(a.badge) ? '' : ' zero'}">×${a.badge ?? 0}</span>${a.hotkey ? `<kbd>${a.hotkey}</kbd>` : ''}</button>`).join('') : '';
  el.querySelectorAll('.gt').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); const a = kit.find((k) => k.key === b.dataset.k); if (a) onPress(a); };
  });
}

// ---------- context panel (move confirm / target / grenade / breach) ----------

export function showContext(html, kind) {
  const el = $('targetPanel');
  el.className = `panel ctx ${kind}`;
  $('ctxBody').innerHTML = html;
  el.classList.remove('hidden');
  document.body.classList.add('ctx-open');
  requestAnimationFrame(() => el.classList.add('open'));
}
export function hideContext() {
  const el = $('targetPanel');
  el.classList.remove('open');
  el.classList.add('hidden');
  document.body.classList.remove('ctx-open');
}

// ---------- kill feed: 3–4 concise lines, merged + deduped ----------
//
// Every line is [actor] icon [target] note, in squad colours (you amber). Repeats within a
// few seconds fold into one line with a ×N counter; unseen-gunfire style pings fold by kind
// with their compass directions ("Gunfire · N · NE ×3"). Personal moments (you downed, you
// revived) are banners; the feed only reports the battlefield.

const nameSpan = (cls, txt, mine, color) => `<span class="${cls}${mine ? ' mine' : ''}"${color && !mine ? ` style="--c:${color}"` : ''}>${esc(txt)}</span>`;
const CAUSE_ICON = { shoot: 'shoot', aimed: 'aimed', grenade: 'grenade', breach: 'breach', tide: 'tide', overwatch: 'overwatch', bleed: 'bleed', execute: 'skull', barrel: 'barrelx', knife: 'knife', streak: 'airstrike', stage: 'warn' };
const FEED_LIFE = 6500;
const feedMax = () => (innerWidth >= 900 && innerHeight >= 560 ? 4 : 3);
let feedRows = [];

function feedRow({ key, html, cls, mergeTxt = null }) {
  const f = $('feed');
  if (!f) return;
  const now = performance.now();
  const hit = key ? feedRows.find((r) => r.key === key && r.el.isConnected && now - r.t < FEED_LIFE) : null;
  if (hit) {
    hit.n++;
    hit.t = now;
    if (mergeTxt) hit.el.querySelector('.kt').innerHTML = mergeTxt(hit);
    let c = hit.el.querySelector('.kn');
    if (!c) { c = document.createElement('em'); c.className = 'kn'; hit.el.appendChild(c); }
    c.textContent = `×${hit.n}`;
    hit.el.classList.remove('bump'); void hit.el.offsetWidth; hit.el.classList.add('bump');
    clearTimeout(hit.timer);
    hit.timer = setTimeout(() => dropRow(hit), FEED_LIFE);
    return hit;
  }
  const d = document.createElement('div');
  d.className = 'kf ' + (cls || '');
  d.innerHTML = html;
  f.prepend(d);
  const row = { key, el: d, n: 1, t: now, dirs: [], timer: 0 };
  row.timer = setTimeout(() => dropRow(row), FEED_LIFE);
  feedRows.unshift(row);
  requestAnimationFrame(() => d.classList.add('in'));
  while (feedRows.length > feedMax()) { const old = feedRows.pop(); clearTimeout(old.timer); old.el.remove(); }
  return row;
}
function dropRow(row) {
  row.el.classList.add('fade');
  setTimeout(() => row.el.remove(), 450);
  feedRows = feedRows.filter((r) => r !== row);
}

/** A kill (or a death with no killer: tide, bleed-out). weapon: short weapon name. */
export function feedKill({ killer, victim, cause, killerMine, victimMine, killerColor, victimColor, weapon }) {
  const ic = ICON[CAUSE_ICON[cause]] || ICON.skull;
  const note = { tide: 'drowned', bleed: 'bled out' }[cause] || (killer ? '' : 'died');
  const html = killer
    ? `${nameSpan('a', killer, killerMine, killerColor)}<span class="kic">${ic}</span>${weapon ? `<span class="kw">${esc(weapon)}</span>` : ''}${nameSpan('b', victim, victimMine, victimColor)}`
    : `<span class="kic ${cause === 'tide' ? 'tide' : ''}">${ic}</span>${nameSpan('b', victim, victimMine, victimColor)}<small>${note}</small>`;
  feedRow({ html: `<span class="kt">${html}</span>`, cls: 'kill' + (killerMine ? ' by-me' : '') + (victimMine ? ' on-me' : '') });
}

/** One feed line: [a] icon [b] note. kind: down | revive | patch | scan | smoke | streak | barrel | flare | out */
export function feedLine({ a, aMine, aColor, icon, b, bMine, bColor, note, kind = '' }) {
  const html = (a ? nameSpan('a', a, aMine, aColor) : '') + `<span class="kic">${ICON[icon] || ''}</span>` + (b ? nameSpan('b', b, bMine, bColor) : '') + (note ? `<small>${esc(note)}</small>` : '');
  feedRow({ key: `${kind}|${a}|${b}|${note}`, html: `<span class="kt">${html}</span>`, cls: `ev ${kind}` + (aMine || bMine ? ' mineish' : '') });
}

const INFO_KIND = [
  [/^Gunfire/i, 'shoot', 'Gunfire'], [/^Explosion/i, 'burst', 'Explosion'], [/^Breach/i, 'breach', 'Breach'],
  [/^Barrel/i, 'barrelx', 'Barrel blast'], [/^(Legendary )?care package/i, 'care', null], [/^Supply/i, 'drop', null],
  [/airstrike/i, 'airstrike', null], [/UAV/i, 'uav', null], [/gunship/i, 'gunship', null], [/^Pit|the Pit/i, 'pit', null],
];
/** Intel lines from the renderer / match ("Gunfire to the NE"): folded by kind + direction. */
export function feedInfo(msg, kind = '') {
  msg = String(msg || '').trim();
  if (!msg) return;
  const m = /^(.*?) to the ([NSEW]{1,2})(\b.*)?$/.exec(msg);
  const k = INFO_KIND.find(([re]) => re.test(msg));
  const icon = ICON[k?.[1]] || (kind === 'signal' ? ICON.signal || ICON.eye : ICON.eye);
  if (m && k?.[2]) {
    // unseen action: one line per kind, directions accumulate
    const base = k[2];
    const dir = m[2];
    const txt = (r) => `<span class="kic">${icon}</span><span class="ki">${esc(base)}</span><small>${r.dirs.join(' · ')}</small>`;
    const row = feedRow({ key: 'intel|' + base, html: '', cls: `info intel ${kind}`, mergeTxt: (r) => { if (!r.dirs.includes(dir)) r.dirs.push(dir); return txt(r); } });
    if (row && row.n === 1) { row.dirs = [dir]; row.el.innerHTML = `<span class="kt">${txt(row)}</span>`; }
    return;
  }
  feedRow({ key: 'msg|' + msg, html: `<span class="kt"><span class="kic">${icon}</span><span class="ki">${esc(msg)}</span></span>`, cls: `info ${kind}` });
}

export function clearFeed() { for (const r of feedRows) clearTimeout(r.timer); feedRows = []; $('feed').innerHTML = ''; $('toasts').innerHTML = ''; }

export function toast(msg, kind = 'info', iconName) {
  // Outside a match (menu, shop) the HUD is hidden: use the global host.
  const t = $('hud').classList.contains('hidden') || document.body.classList.contains('ended') ? $('menuToasts') : $('toasts');
  const d = document.createElement('div');
  d.className = 'toast ' + kind;
  const ic = iconName ? ICON[iconName] : kind === 'error' ? ICON.warn : kind === 'loot' ? ICON.crate : '';
  d.innerHTML = `${ic ? `<span class="ti">${ic}</span>` : ''}<span>${esc(msg)}</span>`;
  t.appendChild(d);
  requestAnimationFrame(() => d.classList.add('in'));
  while (t.children.length > (t.id === 'toasts' ? 2 : 3)) t.firstChild.remove();
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

// ---------- cinematic title card (stage events, airstrikes, collapses) ----------

const CINE_KICK = { ship: 'Stage event', redtide: 'Stage event', red_tide: 'Stage event', collapse: 'Stage event', platform: 'Stage event', tower: 'Stage event', topple: 'Stage event', wave: 'Stage event', surge: 'Stage event', airstrike: 'Killstreak', building: 'Structure down', warn: 'Incoming' };
let cineT = 0;
/** R.onCinematic payload: {phase:'start'|'end', kind, name, sub, light}. Sits in the letterbox bars. */
export function cineCard(p = {}) {
  const el = $('cineCard');
  if (!el) return;
  clearTimeout(cineT);
  if (p.phase === 'end') {
    el.classList.remove('show');
    document.body.classList.remove('cine', 'cine-light');
    return;
  }
  const kick = p.kick || CINE_KICK[p.kind] || (p.light ? 'Warning' : 'Set piece');
  $('cineKick').textContent = kick;
  $('cineName').textContent = String(p.name || '').toUpperCase();
  $('cineSub').textContent = p.sub || '';
  el.className = `cine-card show k-${String(p.kind || 'x').replace(/[^a-z_]/gi, '')}${p.light ? ' light' : ''}`;
  document.body.classList.add('cine');
  document.body.classList.toggle('cine-light', !!p.light);
  // never stick: the director always ends, but a dropped 'end' must not hide the HUD for good.
  // While the set piece is still running (p.alive), keep the HUD hidden: Cinematic pacing can run past 9s.
  const guard = () => { cineT = setTimeout(() => { if (typeof p.alive === 'function' && p.alive()) guard(); else cineCard({ phase: 'end' }); }, 9000); };
  guard();
}
