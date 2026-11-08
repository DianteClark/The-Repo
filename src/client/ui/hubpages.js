// Hub pages: Barracks (Create-a-Class + Gunsmith), Armory (weapon levels,
// attachment track, camo challenges, mastery), Career (player level, class
// prestige, daily challenges, medals, calling cards + emblems), plus the
// profile button, the deploy-bar loadout chip and procedural weapon art.
// Pure DOM; renderer previews are optional (renderPreview kind:'weapon').

import { ICON } from './icons.js';
import { settings } from './settings.js';
import { badgeSVG } from './badges.js';
import { career } from './career.js';
import { openSheet, closeSheet, onSheetClose, cleanCallsign, randomCallsign } from './menu.js';
import * as M from './meta.js';
import * as P from './progress.js';
import * as A from './arsenal.js';
import { CARDS, EMBLEMS, cardSVG, emblemSVG, cardById, emblemById } from '../../shared/cards.js';
import { weaponThumb, hydrateThumbs, setThumbRenderer } from './weaponthumbs.js';

/** Weapon card art: the cached 3D render (equipped camo + attachments), SVG until it lands. */
export function weaponImg(id, attachments = {}, { w = 220, cls = '' } = {}) {
  const sw = camoSwatch(id);
  return weaponThumb(id, { attachments, camo: P.equippedCamo(id) || 'none', cls, fallback: weaponArt(id, attachments, { w, camo: sw?.colors, gold: sw?.gold }) });
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => Number(n).toLocaleString('en-US');
const RAR = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };
const EQUIP_ICON = { frag: 'grenade', grenade: 'grenade', semtex: 'semtex', claymore: 'claymore', knife: 'knife', smoke: 'smoke', flashbang: 'flash', flash: 'flash', stim: 'stim', decoy: 'decoy' };
const STREAK_ICON = { uav: 'uav', care: 'care', care_package: 'care', cuav: 'cuav', counter_uav: 'cuav', airstrike: 'airstrike', sentry: 'sentry', gunship: 'gunship' };
export const equipIcon = (id) => ICON[EQUIP_ICON[id]] || ICON.grenade;
export const streakIcon = (k) => ICON[STREAK_ICON[k]] || ICON.bolt;
// Weapon previews need GFX-CHAR's renderPreview({kind:'weapon'}). Until the
// preview module handles that kind, keep the SVG art (a soldier would render instead).
let weaponPv = null;
export function weaponPreviewSupported() {
  if (!weaponPv) {
    weaponPv = import('../render.js').then((m) => (Array.isArray(m.PREVIEW_KINDS) ? m : import('../gfx/preview.js'))).then((m) => {
      if (Array.isArray(m.PREVIEW_KINDS)) return m.PREVIEW_KINDS.includes('weapon');
      return fetch(new URL('../gfx/preview.js', import.meta.url)).then((r) => r.text()).then((t) => /kind\s*===?\s*['"]weapon['"]|case\s*['"]weapon['"]|weapon:\s*\(/.test(t));
    }).catch(() => false);
  }
  return weaponPv;
}
const SLOT_ICON = { optic: 'scope', barrel: 'barrel', magazine: 'ammo', underbarrel: 'target', stock: 'rifle' };

// ------------------------------------------------------------------ weapon art (SVG)

const CAT_SHAPE = {
  ar: { barrel: 52, body: 62, stock: 34, mag: 'box', thick: 9 },
  smg: { barrel: 30, body: 50, stock: 26, mag: 'stick', thick: 9 },
  lmg: { barrel: 56, body: 70, stock: 36, mag: 'drum', thick: 12 },
  shotgun: { barrel: 58, body: 52, stock: 38, mag: 'tube', thick: 11 },
  dmr: { barrel: 64, body: 60, stock: 36, mag: 'box', thick: 9 },
  sniper: { barrel: 78, body: 58, stock: 40, mag: 'small', thick: 8 },
  carbine: { barrel: 46, body: 56, stock: 30, mag: 'box', thick: 8 },
  pistol: { barrel: 20, body: 34, stock: 0, mag: 'grip', thick: 9 },
  mpistol: { barrel: 22, body: 40, stock: 0, mag: 'stick', thick: 9 },
  launcher: { barrel: 70, body: 46, stock: 18, mag: 'none', thick: 16 },
};
let wuid = 0;
/** A side-view weapon silhouette with its attachments drawn on. camo: [c1, c2] swatch. */
export function weaponArt(id, attachments = {}, { w = 220, camo = null, gold = false } = {}) {
  const wd = A.weaponById(id);
  const sh = CAT_SHAPE[wd?.cat] || CAT_SHAPE.ar;
  const k = `wa${++wuid}`;
  const H = 80, cy = 34;
  const total = sh.stock + sh.body + sh.barrel;
  const x0 = (220 - total) / 2;
  const sx = x0, bx = x0 + sh.stock, brx = bx + sh.body;
  const t = sh.thick;
  const metal = gold ? `url(#${k}gold)` : `url(#${k}m)`;
  const body = camo ? `url(#${k}c)` : metal;
  const att = attachments || {};
  const parts = [];
  // stock
  if (sh.stock) {
    if (att.stock === 'lightstock' || att.stock === 'light_stock') parts.push(`<path d="M${sx} ${cy - 4} H${bx} V${cy + 2} H${sx + 10} L${sx} ${cy + 12} Z" fill="none" stroke="${metal}" stroke-width="3"/>`);
    else if (att.stock === 'foldstock' || att.stock === 'no_stock') parts.push(`<rect x="${bx - 14}" y="${cy - 3}" width="14" height="5" rx="1" fill="${metal}"/>`);
    else parts.push(`<path d="M${sx} ${cy - 5} H${bx} V${cy + 4} L${sx + 8} ${cy + 14} H${sx} Z" fill="${body}" stroke="#000" stroke-opacity=".35"/>${att.stock === 'heavystock' || att.stock === 'padded_stock' ? `<rect x="${sx - 4}" y="${cy - 5}" width="5" height="19" rx="2" fill="#222"/>` : ''}`);
  }
  // receiver + handguard
  parts.push(`<rect x="${bx}" y="${cy - t / 2 - 2}" width="${sh.body}" height="${t + 4}" rx="2" fill="${body}" stroke="#000" stroke-opacity=".35"/>`);
  parts.push(`<rect x="${bx + 4}" y="${cy - t / 2 - 4}" width="${sh.body * 0.45}" height="3" rx="1" fill="#000" opacity=".35"/>`);
  // grip
  parts.push(`<path d="M${bx + sh.body * 0.28} ${cy + t / 2 + 2} l-4 16 h8 l3 -16 z" fill="${metal}"/>`);
  // barrel
  const bl = sh.barrel + (att.barrel === 'longbarrel' || att.barrel === 'long_barrel' ? 14 : 0);
  const bt = att.barrel === 'heavybarrel' || att.barrel === 'heavy_barrel' ? 6 : 4;
  parts.push(`<rect x="${brx}" y="${cy - bt / 2}" width="${bl}" height="${bt}" fill="${metal}"/>`);
  if (sh.mag === 'tube') parts.push(`<rect x="${brx}" y="${cy + 3}" width="${bl * 0.8}" height="4" rx="2" fill="${metal}" opacity=".9"/>`);
  if (att.barrel === 'suppressor') parts.push(`<rect x="${brx + bl - 2}" y="${cy - 5}" width="22" height="10" rx="3" fill="#2a2f33" stroke="#000" stroke-opacity=".4"/>`);
  else parts.push(`<rect x="${brx + bl - 4}" y="${cy - bt / 2 - 1}" width="6" height="${bt + 2}" fill="${metal}"/>`);
  // magazine
  const mx = bx + sh.body * 0.52;
  const ext = att.magazine === 'extmag' || att.magazine === 'ext_mag';
  if (sh.mag === 'drum' || att.magazine === 'drum') parts.push(`<circle cx="${mx + 6}" cy="${cy + t / 2 + 10}" r="${ext ? 13 : 11}" fill="#23282b" stroke="${metal}" stroke-width="2"/>`);
  else if (sh.mag === 'box' || sh.mag === 'stick') parts.push(`<path d="M${mx} ${cy + t / 2} h10 l${sh.mag === 'stick' ? 0 : 3} ${ext ? 26 : 18} h-10 z" fill="#23282b" stroke="#000" stroke-opacity=".4"/>${att.magazine === 'fastmag' ? `<path d="M${mx + 12} ${cy + t / 2} h8 l2 16 h-8 z" fill="#2c3236"/>` : ''}`);
  else if (sh.mag === 'small') parts.push(`<rect x="${mx}" y="${cy + t / 2}" width="10" height="${ext ? 14 : 8}" fill="#23282b"/>`);
  else if (sh.mag === 'grip') parts.push(`<rect x="${bx + 4}" y="${cy + t / 2}" width="9" height="16" rx="2" fill="#23282b"/>`);
  // underbarrel
  const ux = brx + Math.min(14, bl * 0.25);
  if (att.underbarrel === 'grip') parts.push(`<path d="M${ux} ${cy + bt / 2 + 2} h6 l1 14 h-7 z" fill="#2c3236"/>`);
  else if (att.underbarrel === 'bipod') parts.push(`<path d="M${ux + 4} ${cy + 3} l-8 20 M${ux + 4} ${cy + 3} l8 20" stroke="#2c3236" stroke-width="2.4" stroke-linecap="round"/>`);
  else if (att.underbarrel === 'laser') parts.push(`<rect x="${ux}" y="${cy + bt / 2 + 1}" width="16" height="5" rx="1.5" fill="#2c3236"/><path d="M${ux + 16} ${cy + bt / 2 + 3.5} H220" stroke="#ff3b3b" stroke-width=".8" opacity=".8"/>`);
  // optic
  const ox = bx + sh.body * 0.35;
  if (att.optic === 'scope4x' || att.optic === 'acog') parts.push(`<rect x="${ox - 8}" y="${cy - t / 2 - 12}" width="34" height="8" rx="4" fill="#1d2226" stroke="${metal}" stroke-width="1.2"/><circle cx="${ox + 26}" cy="${cy - t / 2 - 8}" r="3" fill="#7fe9ff" opacity=".7"/>`);
  else if (att.optic === 'reflex' || att.optic === 'red_dot') parts.push(`<path d="M${ox} ${cy - t / 2 - 2} v-8 h12 v8" fill="none" stroke="#1d2226" stroke-width="2.6"/><circle cx="${ox + 6}" cy="${cy - t / 2 - 7}" r="1.6" fill="#ff3b3b"/>`);
  else if (att.optic === 'thermal') parts.push(`<rect x="${ox - 2}" y="${cy - t / 2 - 13}" width="20" height="11" rx="2" fill="#1d2226"/><rect x="${ox + 16}" y="${cy - t / 2 - 11}" width="3" height="7" fill="#ffb000"/>`);
  else if (sh.stock) parts.push(`<path d="M${ox} ${cy - t / 2 - 2} v-4 h6 v4 M${brx + bl - 8} ${cy - bt / 2} v-5 h3 v5" fill="none" stroke="${metal}" stroke-width="2"/>`);
  const [c1, c2] = camo || ['#555', '#333'];
  const defs = `<defs><linearGradient id="${k}m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7d8a8f"/><stop offset=".5" stop-color="#4a5559"/><stop offset="1" stop-color="#2a3134"/></linearGradient>
    <linearGradient id="${k}gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff0b0"/><stop offset=".5" stop-color="#e2b23e"/><stop offset="1" stop-color="#8a5a06"/></linearGradient>
    <pattern id="${k}c" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><rect width="14" height="14" fill="${c1}"/><path d="M0 0h7v6H0zM7 7h7v7H7z" fill="${c2}"/></pattern></defs>`;
  return `<svg class="wart" viewBox="0 0 220 ${H}" width="${w}" height="${(w * H) / 220}" aria-hidden="true">${defs}<ellipse cx="110" cy="${H - 6}" rx="80" ry="3" fill="#000" opacity=".3"/>${parts.join('')}</svg>`;
}

// ------------------------------------------------------------------ shared bits

const statRows = (cur, base, cls) => {
  const C = A.CLASSES[cls] || {};
  const mob = (C.move ?? 6) + (cur.move || 0);
  const baseMob = (C.move ?? 6) + (base.move || 0);
  const avg = (d) => (d[0] + d[1]) / 2;
  const mag = (m) => (m === Infinity ? 20 : m);
  const rows = [
    ['Damage', avg(cur.dmg), avg(base.dmg), 8, `${cur.dmg[0]}–${cur.dmg[1]}`],
    ['Range', cur.range, base.range, 16, `${cur.range} tiles`],
    ['Accuracy', cur.aim, base.aim, 90, `${cur.aim}`],
    ['Close aim', 50 + (cur.close || 0), 50 + (base.close || 0), 70, `${cur.close > 0 ? '+' : ''}${cur.close || 0}`],
    ['Magazine', mag(cur.mag), mag(base.mag), 20, cur.mag === Infinity ? '∞' : String(cur.mag)],
    ['Mobility', mob, baseMob, 8, `${mob} tiles`],
  ];
  return rows.map(([k, v, b, max, label], i) => {
    const w = Math.max(3, Math.min(100, (v / max) * 100)), bw = Math.max(3, Math.min(100, (b / max) * 100));
    const d = v - b;
    return `<div class="stat${d > 0 ? ' up' : d < 0 ? ' down' : ''}"><span class="sk">${k}</span><span class="sb"><i style="--w:${Math.min(w, bw)}%;--d:${i * 40}ms"></i>${d ? `<em style="--l:${Math.min(w, bw)}%;--w:${Math.abs(w - bw)}%"></em>` : ''}</span><span class="sv">${label}${d ? `<small>${d > 0 ? '+' : ''}${Number.isInteger(d) ? d : d.toFixed(1)}</small>` : ''}</span></div>`;
  }).join('');
};
const flagsLine = (s) => [s.silent && 'Silent', s.thermal && 'Thermal', s.freeReload && 'Free reload', s.steady && `Steady +${s.steady}`, s.owAim && `Overwatch ${s.owAim > 0 ? '+' : ''}${s.owAim}`].filter(Boolean).map((x) => `<span class="flag">${x}</span>`).join('');
function camoSwatch(weaponId) {
  const id = P.equippedCamo(weaponId);
  const c = id ? P.camoById(id) : null;
  return c ? { colors: c.colors || c.swatch, gold: id === 'gold', id } : null;
}

// ------------------------------------------------------------------ picker sheet

let pickWire = null;
export function openPicker(title, html, wire, cls = '') {
  $('pickTitle').textContent = title;
  const body = $('pickBody');
  body.className = cls;
  body.innerHTML = html;
  pickWire = wire;
  wire?.(body);
  hydrateThumbs(body);
  openSheet('pickSheet');
  body.scrollTop = 0;
  $('pickSheet').querySelector('.sheet-card').scrollTop = 0;
}
export function refreshPicker(html) { const body = $('pickBody'); const st = $('pickSheet').querySelector('.sheet-card').scrollTop; body.innerHTML = html; pickWire?.(body); hydrateThumbs(body); $('pickSheet').querySelector('.sheet-card').scrollTop = st; }

// ------------------------------------------------------------------ init

export function initHubPages({ getR, onClick, onChange, toast, onDeploy, sfx = {} }) {
  const click = (k) => onClick?.(k);
  const R = () => getR?.();
  setThumbRenderer(R);
  let preview = null; // canvas with a live renderPreview
  function stopPreview() {
    if (preview && typeof R()?.stopPreview === 'function') { try { R().stopPreview(preview); } catch { /* ignore */ } }
    preview = null;
  }
  function livePreview(canvas, opts) {
    if (opts?.kind === 'weapon') {
      weaponPreviewSupported().then((ok) => { if (ok && canvas?.isConnected) livePreviewNow(canvas, opts); });
      return false;
    }
    return livePreviewNow(canvas, opts);
  }
  function livePreviewNow(canvas, opts) {
    stopPreview();
    const r = R();
    if (!canvas || typeof r?.renderPreview !== 'function') return false;
    try {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      r.renderPreview(canvas, opts);
      preview = canvas;
      canvas.closest('.pv')?.classList.add('live');
      return true;
    } catch (e) { console.warn('[tidefall] renderPreview', e); return false; }
  }
  onSheetClose('pickSheet', () => { stopPreview(); pickWire = null; });

  // ================================================================ BARRACKS
  let editIdx = P.activeIndex();
  let draft = null;
  const loadDraft = () => { draft = JSON.parse(JSON.stringify(P.loadouts()[editIdx])); };
  loadDraft();
  const commit = (msg) => {
    P.saveLoadout(editIdx, draft);
    loadDraft();
    if (editIdx === P.activeIndex()) settings.cls = draft.cls;
    renderBarracks();
    renderChip();
    onChange?.('loadout');
    if (msg) toast?.(msg, 'loot', 'check');
  };

  function slotTabs() {
    return P.loadouts().map((l, i) => {
      const w = A.weaponById(l.primary?.id);
      return `<button class="bk-slot${i === editIdx ? ' on' : ''}${i === P.activeIndex() ? ' current' : ''}" data-slot="${i}" role="tab" aria-selected="${i === editIdx}">
        <span class="bks-n">${i + 1}</span>${badgeSVG(l.cls, M.classProgress(l.cls).tier, { size: 30, title: false, animated: false })}
        <span class="bks-t"><b>${esc(l.name || `Loadout ${i + 1}`)}</b><small>${esc(w?.name || '')}</small></span>${i === P.activeIndex() ? `<i class="bks-eq">${ICON.check}</i>` : ''}</button>`;
    }).join('');
  }

  function renderBarracks() {
    const el = $('pageBarracks');
    if (!el) return;
    const l = draft;
    const C = A.CLASSES[l.cls] || {};
    const role = A.CLASS_ROLE[l.cls] || {};
    const w = A.weaponById(l.primary.id);
    const wl = P.weaponLevel(l.primary.id);
    const cur = A.weaponStats(l.primary.id, l.primary.attachments) || { dmg: [0, 0] };
    const base = A.weaponStats(l.primary.id, {}) || cur;
    const sec = A.weaponById(l.secondary.id);
    const le = A.equipById(l.lethal), ta = A.equipById(l.tactical);
    const sw = camoSwatch(l.primary.id);
    const nAtt = Object.keys(l.primary.attachments || {}).length;
    const pk = l.perks.map((k) => A.perkByKey(k));
    const st = l.streaks.map((k) => A.streakByKey(k)).filter(Boolean);
    el.innerHTML = `
      <div class="bk">
        <div class="bk-slots h-scroll" role="tablist" aria-label="Loadouts">${slotTabs()}</div>
        <div class="bk-main">
          <div class="bk-col">
            <div class="bk-head">
              <input id="bkName" class="bk-name" maxlength="18" value="${esc(l.name || '')}" aria-label="Loadout name" spellcheck="false" autocomplete="off" />
              ${editIdx === P.activeIndex() ? `<span class="bk-active">${ICON.check}Active</span>` : '<button id="bkUse" class="btn ghost sm">Use this loadout</button>'}
            </div>
            <div class="bk-classes h-scroll" role="radiogroup" aria-label="Class">${A.classKeys().map((k) => `<button class="bk-cls${k === l.cls ? ' on' : ''}" data-cls="${k}" role="radio" aria-checked="${k === l.cls}">${badgeSVG(k, M.classProgress(k).tier, { size: 40, title: false, animated: k === l.cls })}<b>${esc(A.CLASSES[k].name)}</b></button>`).join('')}</div>
            <div class="bk-cinfo">
              <div class="bkc-h"><b>${esc(C.name || l.cls)}</b><span>${esc(role.role || C.desc || '')}</span></div>
              <div class="bkc-ab"><span class="ab-ic">${ICON[l.cls === 'engineer' ? 'cover' : l.cls === 'gunner' ? 'suppress' : { assault: 'grenade', marksman: 'aimed', breacher: 'breach', medic: 'patch', recon: 'scan' }[l.cls]] || ICON.bolt}</span><div><b>${esc(role.ability || '')}</b><p>${esc(role.abilityDesc || '')}</p></div></div>
              <div class="bkc-pills"><span>${ICON.heart}<b>${C.hp ?? '?'}</b> HP</span><span>${ICON.shield}<b>${C.armor ?? 0}</b> Armor</span><span>${ICON.move}<b>${C.move ?? '?'}</b> Move</span><span>${ICON.rifle}${A.allowedCats(l.cls).map((c) => A.CAT_SHORT[c] || c.toUpperCase()).join(' · ')}</span></div>
            </div>
            <button class="bk-item primary" data-pick="primary">
              <span class="bki-k">Primary<em>LV ${wl.level}</em></span>
              <span class="bki-art">${weaponImg(l.primary.id, l.primary.attachments, { w: 240 })}</span>
              <span class="bki-n"><b>${esc(w?.name || l.primary.id)}</b><small>${esc(A.CAT_NAMES[w?.cat] || '')}</small></span>
              <span class="bki-att">${A.SLOT_KEYS.map((s) => { const a = A.attachmentById(l.primary.attachments?.[s]); return `<i class="${a ? 'on' : ''}" title="${esc(A.SLOT_NAMES[s])}: ${esc(a?.name || 'none')}">${ICON[SLOT_ICON[s]]}</i>`; }).join('')}</span>
            </button>
            <button class="bk-item gunsmith" data-pick="gunsmith"><span class="bki-ic">${ICON.gear}</span><span class="bki-n"><b>Gunsmith</b><small>${nAtt}/5 attachments · ${A.unlockTrack(l.primary.id).filter((id) => P.isAttachmentUnlocked(l.primary.id, id)).length} unlocked</small></span>${ICON.chevR}</button>
            <div class="bk-two">
              <button class="bk-item" data-pick="secondary"><span class="bki-k">Secondary</span><span class="bki-art sm">${weaponImg(l.secondary.id, {}, { w: 120 })}</span><span class="bki-n"><b>${esc(sec?.name || l.secondary.id)}</b></span></button>
              <button class="bk-item" data-pick="lethal"><span class="bki-k">Lethal</span><span class="bki-ic big">${equipIcon(l.lethal)}</span><span class="bki-n"><b>${esc(le?.name || l.lethal)}</b></span></button>
              <button class="bk-item" data-pick="tactical"><span class="bki-k">Tactical</span><span class="bki-ic big cy">${equipIcon(l.tactical)}</span><span class="bki-n"><b>${esc(ta?.name || l.tactical)}</b></span></button>
            </div>
            <div class="bk-sec">Perks</div>
            <div class="bk-perks">${pk.map((p, i) => `<button class="bk-perk t${i + 1}" data-pick="perk${i + 1}"><span class="pk-ic">${ICON.perk}<em>${i + 1}</em></span><b>${esc(p?.name || '?')}</b><small>${esc(p?.desc || '')}</small></button>`).join('')}</div>
            <div class="bk-sec">Killstreaks<small>Kills in one match</small></div>
            <div class="bk-streaks">${st.map((s) => `<button class="bk-str" data-pick="streaks"><span class="str-ic">${streakIcon(s.key)}</span><b>${esc(s.name)}</b><span class="str-c">${s.cost}<small>kills</small></span></button>`).join('')}</div>
          </div>
          <div class="bk-col bk-side">
            <div class="bk-statcard">
              <div class="bk-sec">${esc(w?.name || '')} · stats<small>${nAtt ? 'With attachments vs stock' : 'Stock'}</small></div>
              <div class="stats">${statRows(cur, base, l.cls)}</div>
              <div class="flags">${flagsLine(cur)}</div>
              <p class="bk-desc">${esc(w?.desc || '')}</p>
            </div>
            <div class="bk-tip">${ICON.bolt}<span>Every unlock is a sidegrade: a new player is never outgunned by raw stats.</span></div>
          </div>
        </div>
      </div>`;
    wireBarracks(el);
    hydrateThumbs(el);
  }

  function wireBarracks(el) {
    el.querySelectorAll('.bk-slot').forEach((b) => { b.onclick = () => { click('tab'); editIdx = Number(b.dataset.slot); loadDraft(); renderBarracks(); }; });
    const name = $('bkName');
    name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') name.blur(); });
    name.addEventListener('change', () => { draft.name = name.value.trim() || `Loadout ${editIdx + 1}`; commit(); });
    $('bkUse')?.addEventListener('click', () => { click(); P.setActive(editIdx); settings.cls = draft.cls; renderBarracks(); renderChip(); onChange?.('loadout'); toast?.(`${draft.name} equipped`, 'loot', 'check'); });
    el.querySelectorAll('.bk-cls').forEach((b) => {
      b.onclick = () => {
        const cls = b.dataset.cls;
        if (cls === draft.cls) return;
        click();
        const d = A.defaultLoadout(cls);
        // Keep what still fits the new class; swap the primary if its category isn't allowed.
        const keep = A.primariesFor(cls).some((w) => w.id === draft.primary.id);
        draft = { ...draft, cls, primary: keep ? draft.primary : d.primary };
        commit();
      };
    });
    el.querySelectorAll('[data-pick]').forEach((b) => { b.onclick = () => { click(); openPick(b.dataset.pick); }; });
  }

  // ---- pickers
  function openPick(kind) {
    if (kind === 'primary') return pickPrimary();
    if (kind === 'gunsmith') return pickGunsmith();
    if (kind === 'secondary') return pickList('Secondary', A.SECONDARIES.map((w) => ({ id: w.id, name: w.name, desc: w.desc, art: weaponImg(w.id, {}, { w: 150 }), sel: draft.secondary.id === w.id, meta: `${w.range} range · ${w.dmg[0]}–${w.dmg[1]} dmg · ${w.mag === Infinity ? '∞' : w.mag} mag` })), (id) => { draft.secondary = { id }; });
    if (kind === 'lethal') return pickList('Lethal', A.LETHALS.map((e) => ({ id: e.id, name: e.name, desc: e.desc, icon: equipIcon(e.id), sel: draft.lethal === e.id, meta: `${e.charges + (draft.cls === 'assault' ? 1 : 0)} charge${e.charges + (draft.cls === 'assault' ? 1 : 0) === 1 ? '' : 's'}${draft.cls === 'assault' ? ' (Frag specialist +1)' : ''}` })), (id) => { draft.lethal = id; });
    if (kind === 'tactical') return pickList('Tactical', A.TACTICALS.map((e) => ({ id: e.id, name: e.name, desc: e.desc, icon: equipIcon(e.id), cyan: true, sel: draft.tactical === e.id, meta: `${e.charges} charge${e.charges === 1 ? '' : 's'}` })), (id) => { draft.tactical = id; });
    if (kind.startsWith('perk')) {
      const t = Number(kind.slice(4));
      return pickList(`Perk ${t}`, A.PERKS[`tier${t}`].map((p) => ({ id: p.key, name: p.name, desc: p.desc, icon: ICON.perk, sel: draft.perks[t - 1] === p.key })), (id) => { draft.perks[t - 1] = id; });
    }
    if (kind === 'streaks') return pickStreaks();
    return null;
  }

  function pickList(title, items, apply) {
    const html = `<div class="pk-list">${items.map((it) => `<button class="pk-it${it.sel ? ' sel' : ''}" data-id="${esc(it.id)}">
        ${it.art ? `<span class="pk-art">${it.art}</span>` : `<span class="pk-ic${it.cyan ? ' cy' : ''}">${it.icon || ''}</span>`}
        <span class="pk-t"><b>${esc(it.name)}</b><small>${esc(it.desc || '')}</small>${it.meta ? `<em>${esc(it.meta)}</em>` : ''}</span>${it.sel ? `<i class="pk-chk">${ICON.check}</i>` : ''}</button>`).join('')}</div>`;
    openPicker(title, html, (body) => {
      body.querySelectorAll('.pk-it').forEach((b) => { b.onclick = () => { click(); apply(b.dataset.id); commit(); closeSheet('pickSheet'); }; });
    });
  }

  function pickStreaks() {
    let sel = [...draft.streaks];
    const render = () => `<p class="pk-note">Pick three. Each unlocks once your kills this match reach its cost; Hardline makes them 1 cheaper.</p>
      <div class="pk-list streaks">${A.STREAKS.map((s) => { const on = sel.includes(s.key); return `<button class="pk-it${on ? ' sel' : ''}" data-id="${s.key}"><span class="pk-ic str">${streakIcon(s.key)}</span><span class="pk-t"><b>${esc(s.name)}</b><small>${esc(s.desc)}</small></span><span class="str-c">${s.cost}<small>kills</small></span>${on ? `<i class="pk-chk">${ICON.check}</i>` : ''}</button>`; }).join('')}</div>
      <div class="pk-foot"><span>${sel.length}/3 selected</span><button class="btn primary" id="pkStrOk" ${sel.length === 3 ? '' : 'disabled'}>Save</button></div>`;
    openPicker('Killstreaks', render(), function wire(body) {
      body.querySelectorAll('.pk-it').forEach((b) => {
        b.onclick = () => {
          click();
          const k = b.dataset.id;
          if (sel.includes(k)) sel = sel.filter((x) => x !== k);
          else if (sel.length < 3) sel.push(k);
          else { sel.shift(); sel.push(k); }
          refreshPicker(render());
        };
      });
      const ok = body.querySelector('#pkStrOk');
      if (ok) ok.onclick = () => { click(); draft.streaks = sel; commit(); closeSheet('pickSheet'); };
    });
  }

  function pickPrimary() {
    const cats = A.allowedCats(draft.cls);
    let cat = A.weaponById(draft.primary.id)?.cat || cats[0];
    const base = A.weaponStats(draft.primary.id, {});
    const render = () => {
      const list = A.PRIMARIES.filter((w) => w.cat === cat);
      return `<div class="pk-tabs h-scroll">${cats.map((c) => `<button data-cat="${c}" class="${c === cat ? 'on' : ''}">${esc(A.CAT_NAMES[c] || c)}</button>`).join('')}</div>
        <div class="pk-weapons">${list.map((w) => {
          const s = A.weaponStats(w.id, {});
          const lv = P.weaponLevel(w.id);
          const sw = camoSwatch(w.id);
          const d = (a, b) => (a > b ? `<em class="up">+${a - b}</em>` : a < b ? `<em class="dn">${a - b}</em>` : '');
          return `<button class="pk-w${w.id === draft.primary.id ? ' sel' : ''}" data-id="${w.id}">
            <span class="pkw-art">${weaponImg(w.id, w.id === draft.primary.id ? draft.primary.attachments : {}, { w: 200 })}</span>
            <span class="pkw-h"><b>${esc(w.name)}</b><span class="lvl">LV ${lv.level}</span></span>
            <span class="pkw-s"><span>DMG <b>${s.dmg[0]}–${s.dmg[1]}</b></span><span>RNG <b>${s.range}</b>${d(s.range, base.range)}</span><span>AIM <b>${s.aim}</b>${d(s.aim, base.aim)}</span><span>MAG <b>${s.mag === Infinity ? '∞' : s.mag}</b></span>${s.move ? `<span>MOV <b>${s.move > 0 ? '+' : ''}${s.move}</b></span>` : ''}</span>
            <small>${esc(w.desc)}</small></button>`;
        }).join('')}</div>`;
    };
    openPicker('Primary weapon', render(), function wire(body) {
      body.querySelectorAll('.pk-tabs button').forEach((b) => { b.onclick = () => { click('tab'); cat = b.dataset.cat; refreshPicker(render()); }; });
      body.querySelectorAll('.pk-w').forEach((b) => {
        b.onclick = () => {
          click();
          const id = b.dataset.id;
          const att = {};
          for (const [s, a] of Object.entries(draft.primary.attachments || {})) if (P.isAttachmentUnlocked(id, a)) att[s] = a;
          draft.primary = { id, attachments: att };
          commit();
          closeSheet('pickSheet');
        };
      });
    }, 'wide');
  }

  function pickGunsmith() {
    const wid = draft.primary.id;
    const render = () => {
      const cur = A.weaponStats(wid, draft.primary.attachments);
      const base = A.weaponStats(wid, {});
      const sw = camoSwatch(wid);
      const lv = P.weaponLevel(wid);
      return `<div class="gs">
        <div class="gs-top">
          <div class="pv weapon"><div class="pv-fallback">${weaponArt(wid, draft.primary.attachments, { w: 320, camo: sw?.colors, gold: sw?.gold })}</div><canvas class="pv-cv" aria-hidden="true"></canvas></div>
          <div class="gs-stats"><div class="gs-h"><b>${esc(A.weaponById(wid)?.name)}</b><span class="lvl">LV ${lv.level}</span><span class="xpbar sm"><i style="--w:${Math.round(lv.frac * 100)}%"></i></span></div><div class="stats">${statRows(cur, base, draft.cls)}</div><div class="flags">${flagsLine(cur)}</div></div>
        </div>
        ${A.SLOT_KEYS.map((s) => `<div class="gs-slot"><div class="gs-sk">${ICON[SLOT_ICON[s]]}<b>${A.SLOT_NAMES[s]}</b></div><div class="gs-opts h-scroll">
          <button class="gs-o${!draft.primary.attachments?.[s] ? ' sel' : ''}" data-slot="${s}" data-id=""><b>None</b><small>Stock</small></button>
          ${A.attachmentsFor(s).map((a) => {
            const lvReq = P.attachmentUnlockLevel(wid, a.id);
            const unlocked = P.isAttachmentUnlocked(wid, a.id);
            const sel = draft.primary.attachments?.[s] === a.id;
            return `<button class="gs-o${sel ? ' sel' : ''}${unlocked ? '' : ' lock'}" data-slot="${s}" data-id="${a.id}" ${unlocked ? '' : 'aria-disabled="true"'}><b>${esc(a.name)}</b>${a.pro ? `<small class="pro">${esc(a.pro)}</small><small class="con">${esc(a.con || '')}</small>` : `<small>${esc(a.desc)}</small>`}${unlocked ? '' : `<span class="gs-lock">${ICON.lock}LV ${lvReq ?? '–'}</span>`}</button>`;
          }).join('')}</div></div>`).join('')}
      </div>`;
    };
    const start = () => {
      const cv = $('pickBody').querySelector('.pv canvas');
      requestAnimationFrame(() => livePreview(cv, { kind: 'weapon', weapon: wid, id: wid, attachments: draft.primary.attachments, camo: P.equippedCamo(wid) || 'none', cls: draft.cls }));
    };
    openPicker('Gunsmith', render(), function wire(body) {
      body.querySelectorAll('.gs-o').forEach((b) => {
        b.onclick = () => {
          if (b.classList.contains('lock')) { onClick?.('error'); toast?.(`Reach ${A.weaponById(wid)?.name} ${b.querySelector('.gs-lock')?.textContent?.trim()} to unlock ${b.querySelector('b').textContent}`, 'error'); return; }
          click();
          const att = { ...(draft.primary.attachments || {}) };
          if (b.dataset.id) att[b.dataset.slot] = b.dataset.id; else delete att[b.dataset.slot];
          draft.primary = { ...draft.primary, attachments: att };
          P.saveLoadout(editIdx, draft);
          loadDraft();
          refreshPicker(render());
          start();
          renderBarracks();
          renderChip();
        };
      });
    }, 'wide');
    start();
  }

  // ================================================================ ARMORY
  let arCat = 'all';
  function renderArmory() {
    const el = $('pageArmory');
    if (!el) return;
    const cats = ['all', ...new Set(A.PRIMARIES.map((w) => w.cat))];
    const list = A.PRIMARIES.filter((w) => arCat === 'all' || w.cat === arCat);
    const golds = P.goldCount();
    el.innerHTML = `<div class="ar">
      <div class="ar-mastery">
        ${['gold', 'diamond', 'tidal'].map((k) => { const c = P.MASTERY[k]; const on = k === 'gold' ? golds > 0 : k === 'diamond' ? P.diamondUnlocked() : P.tidalUnlocked(); const prog = k === 'gold' ? `${golds} weapon${golds === 1 ? '' : 's'}` : k === 'diamond' ? `${Math.min(golds, P.GOLDS_FOR_DIAMOND)}/${P.GOLDS_FOR_DIAMOND} Gold` : 'Gold in every category'; return `<div class="arm m-${k}${on ? ' on' : ''}"><span class="arm-sw" style="--c1:${c.colors[0]};--c2:${c.colors[1]};--c3:${c.colors[2] || c.colors[1]}"></span><div><b>${esc(c.name)}</b><small>${on ? 'Unlocked' : prog}</small></div></div>`; }).join('')}
      </div>
      <div class="ar-cats h-scroll">${cats.map((c) => `<button data-cat="${c}" class="${c === arCat ? 'on' : ''}">${c === 'all' ? 'All' : esc(A.CAT_NAMES[c] || c)}</button>`).join('')}</div>
      <div class="ar-grid">${list.map((w) => {
        const lv = P.weaponLevel(w.id);
        const cs = P.camoStatus(w.id);
        const sw = camoSwatch(w.id);
        return `<button class="ar-w${cs.gold ? ' gold' : ''}" data-id="${w.id}">
          <span class="arw-art">${weaponImg(w.id, {}, { w: 220 })}</span>
          <span class="arw-h"><b>${esc(w.name)}</b><small>${esc(A.CAT_NAMES[w.cat] || '')}</small><span class="lvl${lv.level >= A.MAX_WEAPON_LEVEL ? ' max' : ''}">LV ${lv.level}</span></span>
          <span class="xpbar sm"><i style="--w:${Math.round(lv.frac * 100)}%"></i></span>
          <span class="arw-camo">${cs.core.map((c) => `<i class="${c.done ? 'on' : ''}" style="--c:${c.camo.colors[0]}"></i>`).join('')}<em class="${cs.gold ? 'on' : ''}">G</em></span>
        </button>`;
      }).join('')}</div></div>`;
    el.querySelectorAll('.ar-cats button').forEach((b) => { b.onclick = () => { click('tab'); arCat = b.dataset.cat; renderArmory(); }; });
    el.querySelectorAll('.ar-w').forEach((b) => { b.onclick = () => { click(); openWeapon(b.dataset.id); }; });
    hydrateThumbs(el);
  }

  function openWeapon(wid) {
    const w = A.weaponById(wid);
    const render = () => {
      const lv = P.weaponLevel(wid);
      const cs = P.camoStatus(wid);
      const track = A.unlockTrack(wid);
      const owned = new Set(P.ownedCamos(wid).map((c) => c.id));
      const eq = P.equippedCamo(wid);
      const sw = camoSwatch(wid);
      const nodes = Array.from({ length: A.MAX_WEAPON_LEVEL }, (_, i) => {
        const L = i + 1;
        const att = A.attachmentById(track[L - 2]);
        const got = lv.level >= L;
        return `<div class="lt-n${got ? ' got' : ''}${L === lv.level ? ' cur' : ''}"><b>${L}</b>${att ? `<span class="lt-i" title="${esc(att.name)}">${ICON[SLOT_ICON[att.slot]]}</span><small>${esc(att.name)}</small>` : L === 1 ? '<small>Base</small>' : `<small>${L === A.MAX_WEAPON_LEVEL ? 'Mastery' : 'Camo XP'}</small>`}</div>`;
      }).join('');
      const camoBtn = (c, done, label, prog) => `<button class="cm${owned.has(c.id) ? ' got' : ''}${eq === c.id ? ' eq' : ''}${c.animated ? ' anim' : ''}" data-camo="${c.id}" ${owned.has(c.id) ? '' : 'aria-disabled="true"'}>
          <span class="cm-sw" style="--c1:${c.colors[0]};--c2:${c.colors[1]};--c3:${c.colors[2] || c.colors[0]}">${owned.has(c.id) ? '' : ICON.lock}</span>
          <b>${esc(c.name)}</b><small>${esc(label)}</small>${prog !== null ? `<span class="xpbar sm"><i style="--w:${Math.round(prog * 100)}%"></i></span>` : ''}${eq === c.id ? `<i class="cm-eq">${ICON.check}</i>` : ''}</button>`;
      return `<div class="wd">
        <div class="wd-top">
          <div class="pv weapon big"><div class="pv-fallback">${weaponArt(wid, {}, { w: 360, camo: sw?.colors, gold: sw?.gold })}</div><canvas class="pv-cv" aria-hidden="true"></canvas></div>
          <div class="wd-info"><span class="kick">${esc(A.CAT_NAMES[w.cat] || '')}</span><b class="wd-name">${esc(w.name)}</b><p>${esc(w.desc)}</p>
            <div class="wd-lv"><span class="lvl big">LV ${lv.level}</span><div><span class="xpbar"><i style="--w:${Math.round(lv.frac * 100)}%"></i></span><small>${lv.next === null ? 'Max level' : `${fmt(lv.toNext)} XP to level ${lv.level + 1}`}</small></div></div>
            <div class="stats">${statRows(A.weaponStats(wid, {}), A.weaponStats(wid, {}), 'assault')}</div></div>
        </div>
        <div class="bk-sec">Level track<small>One attachment per level, always a sidegrade</small></div>
        <div class="lt h-scroll">${nodes}</div>
        <div class="bk-sec">Camos<small>${cs.done}/${cs.total} toward Gold · tap an unlocked camo to equip</small></div>
        <div class="cm-grid">
          <button class="cm${!eq ? ' eq got' : ' got'}" data-camo=""><span class="cm-sw none"></span><b>Factory</b><small>No camo</small>${!eq ? `<i class="cm-eq">${ICON.check}</i>` : ''}</button>
          ${cs.core.map((c) => camoBtn(c.camo, c.done, c.label, c.done ? null : c.have / c.n)).join('')}
        </div>
        ${cs.challenges.some((c) => c.bonus) ? `<div class="bk-sec">Bonus camos<small>Optional · not needed for Gold</small></div>
        <div class="cm-grid">${cs.challenges.filter((c) => c.bonus).map((c) => camoBtn(c.camo, c.done, c.label, c.done ? null : c.have / c.n)).join('')}</div>` : ''}
        <div class="bk-sec">Mastery</div>
        <div class="cm-grid mastery">
          ${camoBtn(P.MASTERY.gold, cs.gold, 'Every challenge camo on this weapon', cs.gold ? null : cs.done / cs.total)}
          ${camoBtn(P.MASTERY.diamond, owned.has(P.MASTERY.diamond.id), `Gold on ${P.GOLDS_FOR_DIAMOND} weapons`, owned.has(P.MASTERY.diamond.id) ? null : Math.min(1, P.goldCount() / P.GOLDS_FOR_DIAMOND))}
          ${camoBtn(P.MASTERY.tidal, owned.has(P.MASTERY.tidal.id), 'Gold in every category + Diamond. Animated', null)}
        </div>
      </div>`;
    };
    const start = () => {
      const cv = $('pickBody').querySelector('.pv canvas');
      requestAnimationFrame(() => livePreview(cv, { kind: 'weapon', weapon: wid, id: wid, attachments: {}, camo: P.equippedCamo(wid) || 'none' }));
    };
    openPicker(w.name, render(), function wire(body) {
      body.querySelectorAll('.cm').forEach((b) => {
        b.onclick = () => {
          if (b.getAttribute('aria-disabled') === 'true') { onClick?.('error'); toast?.('Complete the challenge to unlock this camo', 'error'); return; }
          click();
          P.setCamo(wid, b.dataset.camo || null);
          refreshPicker(render());
          start();
          renderArmory();
          if (draft.primary.id === wid) renderBarracks();
        };
      });
    }, 'wide');
    start();
  }

  // ================================================================ CAREER
  let colTab = 'cards';
  function renderCareer() {
    const el = $('pageCareer');
    if (!el) return;
    const lv = P.player();
    const c = career();
    const pr = P.progress();
    const ds = P.dailies();
    const winRate = c.matches ? Math.round((c.wins / c.matches) * 100) : 0;
    const tile = (ic, v, k) => `<div class="cr"><span class="cr-ic">${ICON[ic]}</span><b>${v}</b><small>${k}</small></div>`;
    const h = Math.floor(P.msToDailyReset() / 3600000), mi = Math.floor((P.msToDailyReset() % 3600000) / 60000);
    const medals = Object.entries(P.MEDALS).sort((a, b) => (pr.medals[b[0]] ? 1 : 0) - (pr.medals[a[0]] ? 1 : 0));
    el.innerHTML = `<div class="cp">
      <div class="cp-hero">
        <div class="cp-card">${cardSVG(P.equippedCard(), { name: settings.callsign || 'OPERATOR', emblem: P.equippedEmblem(), level: lv.level, sub: `LEVEL ${lv.level} · ${M.TIER_NAMES[Math.max(...A.classKeys().map((k) => M.classProgress(k).tier))]}` , w: 640 })}</div>
        <div class="cp-lv">
          <div class="cp-lvn"><small>Level</small><b>${lv.level}</b></div>
          <div class="cp-lvb"><span class="xpbar big"><i style="--w:${Math.round(lv.frac * 100)}%"></i></span><small>${lv.next === null ? `${fmt(lv.xp)} XP · max level` : `${fmt(lv.xp - lv.floor)} / ${fmt(lv.next - lv.floor)} XP · ${fmt(lv.toNext)} to level ${lv.level + 1}`}</small></div>
        </div>
        <label class="callsign"><span class="cs-ic">${ICON.user}</span><span class="cs-l">Callsign</span>
          <input id="callsign" type="text" maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="done" aria-label="Callsign" value="${esc(settings.callsign)}" />
          <button id="csDice" class="cs-dice" type="button" title="Random callsign" aria-label="Random callsign">${ICON.refresh}</button>
        </label>
      </div>
      <div class="career">${tile('trophy', c.wins, c.wins === 1 ? 'Win' : 'Wins')}${tile('skull', c.kills, 'Kills')}${tile('squads', c.matches, c.matches === 1 ? 'Match' : 'Matches')}${tile('medal', c.best ? `#${c.best}` : '–', 'Best')}
        <div class="cr-foot">${c.matches ? `${winRate}% win rate${c.streak > 1 ? ` · ${c.streak} win streak` : ''} · ${fmt(pr.totals.medals)} medals` : 'No matches yet. Your record starts with the first drop.'}</div></div>
      <div class="bk-sec">Daily challenges<small>New in ${h}h ${mi}m</small></div>
      <div class="cp-daily">${ds.map((d) => `<div class="dc${d.done ? ' done' : ''}"><span class="dc-ic">${d.done ? ICON.check : ICON.calendar}</span><div class="dc-t"><b>${esc(d.label)}</b><span class="xpbar sm"><i style="--w:${Math.round((d.have / d.n) * 100)}%"></i></span><small>${d.have}/${d.n}</small></div><div class="dc-r"><span>+${fmt(d.xp)} XP</span><span>${ICON.coin}${d.salvage}</span></div></div>`).join('')}</div>
      <div class="bk-sec">Class prestige<small>Recruit → Legend, earned per class</small></div>
      <div class="cp-prest">${A.classKeys().map((k) => { const p = M.classProgress(k); return `<div class="cpp t${p.tier}"><span class="cpp-b">${badgeSVG(k, p.tier, { size: 52, title: false, animated: p.tier >= 4 })}</span><div class="cpp-t"><b>${esc(A.CLASSES[k].name)}</b><small class="tier t${p.tier}">${p.name}</small><span class="xpbar sm"><i style="--w:${Math.round(p.frac * 100)}%"></i></span><small>${p.next === null ? 'Max tier' : `${fmt(p.toNext)} XP to ${M.TIER_NAMES[p.tier + 1]}`}</small></div><span class="cpp-pips">${[0, 1, 2, 3, 4].map((t) => `<i class="${t <= p.tier ? 'on' : ''}"></i>`).join('')}</span></div>`; }).join('')}</div>
      <div class="bk-sec">Medals<small>${Object.values(pr.medals).filter(Boolean).length}/${Object.keys(P.MEDALS).length} earned</small></div>
      <div class="cp-medals">${medals.map(([k, m]) => `<div class="md t${m.tier}${pr.medals[k] ? ' got' : ''}" title="${esc(m.desc)}"><span class="md-ic">${medalArt(k, m.tier)}</span><b>${esc(m.name)}</b><small>${pr.medals[k] ? `×${pr.medals[k]}` : esc(m.desc)}</small></div>`).join('')}</div>
      <div class="bk-sec">Collection</div>
      <div class="seg cp-tabs"><button data-tab="cards" class="${colTab === 'cards' ? 'on' : ''}">Calling cards</button><button data-tab="emblems" class="${colTab === 'emblems' ? 'on' : ''}">Emblems</button></div>
      <div class="cp-col ${colTab}">${colTab === 'cards' ? CARDS.map((cd) => { const s = P.cardState(cd.id); return `<button class="cc-it r-${cd.rarity}${s.ok ? '' : ' lock'}${s.equipped ? ' eq' : ''}" data-card="${cd.id}">${cardSVG(cd.id, { w: 300, animated: false })}<span class="cc-m"><b>${esc(cd.name)}</b><small>${s.equipped ? 'Equipped' : s.ok ? RAR[cd.rarity] : s.price ? `${ICON.coin}${fmt(s.price)}` : esc(s.label)}</small></span>${s.ok ? '' : `<i class="cc-lock">${s.price ? ICON.shop : ICON.lock}</i>`}${!s.ok && s.prog !== undefined ? `<span class="xpbar sm"><i style="--w:${Math.round((s.prog || 0) * 100)}%"></i></span>` : ''}</button>`; }).join('')
        : EMBLEMS.map((e) => { const s = P.emblemState(e.id); return `<button class="em-it r-${e.rarity}${s.ok ? '' : ' lock'}${s.equipped ? ' eq' : ''}" data-emblem="${e.id}">${emblemSVG(e.id, 64)}<b>${esc(e.name)}</b><small>${s.equipped ? 'Equipped' : s.ok ? RAR[e.rarity] : s.price ? `${ICON.coin}${fmt(s.price)}` : esc(s.label)}</small></button>`; }).join('')}</div>
    </div>`;
    wireCareer(el);
  }

  function wireCareer(el) {
    const cs = $('callsign');
    const commitCs = () => { const v = cleanCallsign(cs.value) || randomCallsign(); settings.callsign = v; cs.value = v; renderProfile(); };
    cs.addEventListener('input', () => { const v = cs.value.toUpperCase().replace(/[^A-Z0-9 ._-]/g, ''); if (v !== cs.value) cs.value = v; });
    cs.addEventListener('change', () => { commitCs(); renderCareer(); });
    cs.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); cs.blur(); } });
    $('csDice').onclick = () => { click(); settings.callsign = randomCallsign(); renderCareer(); renderProfile(); };
    el.querySelectorAll('.cp-tabs button').forEach((b) => { b.onclick = () => { click('tab'); colTab = b.dataset.tab; renderCareer(); el.querySelector('.cp-col')?.scrollIntoView({ block: 'nearest' }); }; });
    const buyOrEquip = (kind, id) => {
      const s = kind === 'card' ? P.cardState(id) : P.emblemState(id);
      const item = kind === 'card' ? cardById(id) : emblemById(id);
      if (s.ok) { click(); if (kind === 'card') P.equipCard(id); else P.equipEmblem(id); toast?.(`${item.name} equipped`, 'loot', 'check'); }
      else if (s.price) {
        const r = P.buyCard(kind, id);
        if (!r.ok) { onClick?.('error'); toast?.(r.error, 'error'); return; }
        onClick?.('buy');
        if (kind === 'card') P.equipCard(id); else P.equipEmblem(id);
        toast?.(`${item.name} unlocked and equipped`, 'loot', 'sparkle');
      } else { onClick?.('error'); toast?.(`Locked: ${s.label}`, 'error'); return; }
      renderCareer(); renderProfile(); onChange?.('card');
    };
    el.querySelectorAll('[data-card]').forEach((b) => { b.onclick = () => buyOrEquip('card', b.dataset.card); });
    el.querySelectorAll('[data-emblem]').forEach((b) => { b.onclick = () => buyOrEquip('emblem', b.dataset.emblem); });
  }

  // ================================================================ profile + loadout chip
  function renderProfile() {
    const lv = P.player();
    const b = $('profileBtn');
    if (!b) return;
    const r = 15, C = 2 * Math.PI * r;
    b.innerHTML = `<span class="pf-em">${emblemSVG(P.equippedEmblem(), 34)}</span>
      <span class="pf-t"><b>${esc(settings.callsign || 'OPERATOR')}</b><span class="xpbar sm"><i style="--w:${Math.round(lv.frac * 100)}%"></i></span></span>
      <span class="pf-lv"><svg viewBox="0 0 36 36" width="36" height="36"><circle cx="18" cy="18" r="${r}" class="trk"/><circle cx="18" cy="18" r="${r}" class="arc" style="stroke-dasharray:${C};stroke-dashoffset:${C * (1 - lv.frac)}"/></svg><b>${lv.level}</b></span>`;
  }
  function renderChip() {
    const l = P.activeLoadout();
    const w = A.weaponById(l.primary.id);
    const b = $('loadoutChip');
    if (!b) return;
    b.innerHTML = `<span class="lc-b">${badgeSVG(l.cls, M.classProgress(l.cls).tier, { size: 40, title: false, animated: false })}</span>
      <span class="lc-t"><small>${esc(P.loadouts()[P.activeIndex()]?.name || 'Loadout')} · ${esc(A.CLASSES[l.cls]?.name || l.cls)}</small><b>${esc(w?.name || '')}</b><span class="lc-eq">${equipIcon(l.lethal)}${equipIcon(l.tactical)}${l.streaks.map((k) => streakIcon(k)).join('')}</span></span>
      <span class="lc-sw">${ICON.chevR}</span>`;
    settings.cls = l.cls;
  }
  function quickLoadouts() {
    const html = `<div class="ql">${P.loadouts().map((l, i) => { const w = A.weaponById(l.primary?.id); return `<button class="ql-it${i === P.activeIndex() ? ' sel' : ''}" data-i="${i}">${badgeSVG(l.cls, M.classProgress(l.cls).tier, { size: 44, title: false, animated: false })}<span class="ql-t"><b>${esc(l.name)}</b><small>${esc(A.CLASSES[l.cls]?.name || l.cls)} · ${esc(w?.name || '')}</small><span class="lc-eq">${equipIcon(l.lethal)}${equipIcon(l.tactical)}${l.streaks.map((k) => streakIcon(k)).join('')}</span></span>${i === P.activeIndex() ? `<i class="pk-chk">${ICON.check}</i>` : ''}</button>`; }).join('')}</div>
      <button class="btn ghost ql-edit">${ICON.gear}Edit in Barracks</button>`;
    openPicker('Choose loadout', html, (body) => {
      body.querySelectorAll('.ql-it').forEach((b) => { b.onclick = () => { click(); P.setActive(Number(b.dataset.i)); editIdx = P.activeIndex(); loadDraft(); renderChip(); renderBarracks(); onChange?.('loadout'); closeSheet('pickSheet'); }; });
      body.querySelector('.ql-edit').onclick = () => { click(); closeSheet('pickSheet'); onChange?.('goto:barracks'); };
    });
  }
  $('loadoutChip').onclick = () => { click(); quickLoadouts(); };
  $('profileBtn').onclick = () => { click(); onChange?.('goto:career'); };

  renderProfile();
  renderChip();

  return {
    render(page) {
      stopPreview();
      if (page === 'barracks') { editIdx = Math.min(editIdx, P.LOADOUT_SLOTS - 1); loadDraft(); renderBarracks(); }
      if (page === 'armory') renderArmory();
      if (page === 'career') renderCareer();
      renderProfile();
      renderChip();
    },
    renderProfile, renderChip, openWeapon, stopPreview,
    weaponArt,
  };
}

// ------------------------------------------------------------------ medal art

/** Small SVG medal: tier 1 bronze, 2 silver, 3 gold, 4 holo. */
export function medalArt(key, tier = 1, size = 40) {
  const m = { 1: ['#ffd2a0', '#c27d43', '#6e3a17'], 2: ['#ffffff', '#c3ced3', '#5f6d74'], 3: ['#fff6c4', '#f3c24b', '#9a5f05'], 4: ['#ffe8fb', '#b28dff', '#3a1f7a'] }[tier] || ['#fff', '#aaa', '#555'];
  let h = 0; for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const id = `md${h}${tier}`;
  const glyph = {
    first_blood: '<path d="M20 9c3 6 7 9 7 14a7 7 0 0 1-14 0c0-5 4-8 7-14z"/>',
    double_kill: '<path d="M12 13l5 9 5-9M18 13l5 9 5-9" fill="none" stroke-width="2.6"/>',
    triple_kill: '<path d="M9 13l4 9 4-9M16 13l4 9 4-9M23 13l4 9 4-9" fill="none" stroke-width="2.4"/>',
    collateral: '<circle cx="15" cy="20" r="4"/><circle cx="25" cy="20" r="4"/><path d="M8 20h24" stroke-width="2"/>',
    longshot: '<circle cx="20" cy="20" r="7" fill="none" stroke-width="2.4"/><path d="M20 9v6M20 25v6M9 20h6M25 20h6" stroke-width="2.4"/>',
    point_blank: '<circle cx="20" cy="20" r="3"/><circle cx="20" cy="20" r="8" fill="none" stroke-width="2"/>',
    revenge: '<path d="M12 26l8-12 8 12z"/><path d="M20 18v4" stroke="#000" stroke-width="2"/>',
    clutch: '<path d="M20 10l3 7h7l-6 4 2 8-6-5-6 5 2-8-6-4h7z"/>',
    flanker: '<path d="M10 20h16M20 13l7 7-7 7" fill="none" stroke-width="2.8"/>',
    long_odds: '<rect x="13" y="13" width="14" height="14" rx="3" fill="none" stroke-width="2.4"/><circle cx="17" cy="17" r="1.6"/><circle cx="23" cy="23" r="1.6"/>',
    executioner: '<path d="M14 26l12-12M22 12l6 6" stroke-width="2.8"/>',
    demolition: '<path d="M20 10l3 6 6-2-3 6 5 3-6 1 1 6-6-4-6 4 1-6-6-1 5-3-3-6 6 2z"/>',
    savior: '<path d="M17 11h6v6h6v6h-6v6h-6v-6h-6v-6h6z"/>',
    bloodthirsty: '<path d="M13 12h14v4l-3 3 3 3v6H13v-6l3-3-3-3z"/>',
    streak_called: '<path d="M10 22l20-8-6 14-4-5z"/>',
    survivor: '<path d="M20 10l9 4v6c0 5-4 8-9 10-5-2-9-5-9-10v-6z"/>',
    champion: '<path d="M12 26l-1-12 5 4 4-7 4 7 5-4-1 12z"/>',
    comeback: '<path d="M27 16a8 8 0 1 0 1 6" fill="none" stroke-width="2.6"/><path d="M28 10v7h-7" fill="none" stroke-width="2.6"/>',
  }[key] || '<circle cx="20" cy="20" r="6"/>';
  return `<svg class="medal t${tier}" viewBox="0 0 40 40" width="${size}" height="${size}" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${m[0]}"/><stop offset=".5" stop-color="${m[1]}"/><stop offset="1" stop-color="${m[2]}"/></linearGradient></defs>
    <path d="M20 2l5 4 6-1 2 6 5 3-2 6 2 6-5 3-2 6-6-1-5 4-5-4-6 1-2-6-5-3 2-6-2-6 5-3 2-6 6 1z" fill="url(#${id})" stroke="${m[2]}" stroke-width="1"/>
    <circle cx="20" cy="20" r="12" fill="#0b171c" opacity=".82"/><g fill="${m[0]}" stroke="${m[0]}">${glyph}</g></svg>`;
}
