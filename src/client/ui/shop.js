// Armory sheet: the Shop (featured row, Skins / Kill FX / Drop-ins tabs,
// rarity styling, live previews, buy with Salvage) and the Locker (class
// prestige ladder plus equipping owned items). Pure DOM; the renderer's
// preview API is optional: renderPreview(canvas, opts) / stopPreview(canvas).

import { ICON } from './icons.js';
import { settings } from './settings.js';
import { badgeSVG } from './badges.js';
import { openSheet, closeSheet, onSheetClose } from './menu.js';
import * as M from './meta.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const RAR_LABEL = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };
const SLOT_ICON = { skin: 'user', killFx: 'burst', dropIn: 'drop' };

export const coin = (n, cls = '') => `<span class="salv ${cls}">${ICON.coin}<b>${Number(n).toLocaleString('en-US')}</b></span>`;

function hashHue(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) % 360; }

/** Static art for an item card: the catalog's own swatch if it has one, else a stable gradient + slot glyph. */
function itemArt(it, cls) {
  const sw = Array.isArray(it.swatch) ? it.swatch : Array.isArray(it.colors) ? it.colors : typeof it.color === 'string' ? [it.color] : null;
  const h = hashHue(it.id);
  const c1 = sw?.[0] || `hsl(${h} 45% 42%)`;
  const c2 = sw?.[1] || sw?.[0] || `hsl(${(h + 40) % 360} 55% 22%)`;
  const glyph = it.slot === 'skin'
    ? `<span class="ia-badge">${badgeSVG(cls, 0, { size: 44, title: false })}</span>`
    : `<span class="ia-ic">${ICON[SLOT_ICON[it.slot]]}</span>`;
  return `<span class="ia" style="--c1:${c1};--c2:${c2}">${it.isDefault ? '' : '<i class="ia-shine"></i>'}${glyph}</span>`;
}

export function initShop({ CLASSES, getR, onClick, onBuy, onChange, toast }) {
  const sheet = $('shopSheet');
  const body = $('shopBody');
  const ui = { view: 'shop', tab: 'skin', sel: null, confirmAt: 0, previewOn: null };
  const click = () => onClick?.();

  // ---- live preview ----
  const R = () => getR?.();
  function stopPreview() {
    if (ui.previewOn && typeof R()?.stopPreview === 'function') { try { R().stopPreview(ui.previewOn); } catch (e) { console.warn(e); } }
    ui.previewOn = null;
  }
  function startPreview(canvas, opts) {
    stopPreview();
    const r = R();
    if (!canvas || typeof r?.renderPreview !== 'function') return false;
    try {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      r.renderPreview(canvas, { color: '#ffb000', ...opts });
      ui.previewOn = canvas;
      canvas.closest('.pv')?.classList.add('live');
      return true;
    } catch (e) { console.warn('[tidefall] renderPreview', e); return false; }
  }
  const previewOpts = (it, cls) => {
    const lo = M.loadoutFor(cls);
    const o = { cls, skin: it.slot === 'skin' ? it.id : lo.skin };
    if (it.slot === 'killFx') o.killFx = it.id;
    if (it.slot === 'dropIn') o.dropIn = it.id;
    return o;
  };

  function previewBox(it, cls, big = true) {
    // A static fallback sits under the canvas; the live preview covers it when available.
    return `<div class="pv${big ? ' big' : ''} r-${it.rarity}">
      <div class="pv-fallback">${itemArt(it, cls)}<span class="pv-cls">${badgeSVG(cls, M.classProgress(cls).tier, { size: 34, title: false })}</span></div>
      <canvas class="pv-cv" aria-hidden="true"></canvas>
      <span class="pv-tag">${ICON[SLOT_ICON[it.slot]]}${esc(M.SLOTS.find((s) => s.key === it.slot)?.one || '')}</span>
    </div>`;
  }

  // ---- rendering ----
  function header() {
    $('shopSalvage').innerHTML = coin(M.salvage());
    sheet.querySelectorAll('.shop-switch button').forEach((b) => {
      const on = b.dataset.view === ui.view;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
    sheet.querySelector('.sheet-card').dataset.view = ui.view;
  }

  function itemState(it, cls) {
    const owned = M.owns(it.slot, it.id);
    const eq = M.equipped(it.slot, cls) === it.id;
    const fits = M.fitsClass(it, cls);
    return { owned, eq, fits, price: M.priceOf(it), feat: M.isFeatured(it) };
  }

  function card(it, cls, big = false) {
    const s = itemState(it, cls);
    const priceHtml = s.owned ? `<span class="ic-own">${s.eq ? `${ICON.check}Equipped` : 'Owned'}</span>`
      : `${s.feat && !it.isDefault ? `<s>${it.price}</s>` : ''}${coin(s.price, M.salvage() >= s.price ? '' : 'short')}`;
    const isSel = ui.sel && ui.sel.slot === it.slot && ui.sel.id === it.id;
    return `<button class="it r-${it.rarity}${big ? ' feat' : ''}${isSel ? ' sel' : ''}${s.owned ? ' owned' : ''}${s.eq ? ' eq' : ''}" data-slot="${it.slot}" data-id="${esc(it.id)}">
      ${itemArt(it, cls)}
      ${!s.owned && M.isNew(it.slot, it.id) && !it.isDefault ? '<i class="it-new">New</i>' : ''}
      ${s.feat && !s.owned ? `<i class="it-deal">-${Math.round(M.FEATURED_DISCOUNT * 100)}%</i>` : ''}
      <span class="it-meta"><b>${esc(it.name)}</b><small class="rar">${RAR_LABEL[it.rarity]}${big ? ` · ${esc(M.SLOTS.find((x) => x.key === it.slot).one)}` : ''}</small></span>
      <span class="it-price">${priceHtml}</span>
    </button>`;
  }

  function detail(it, cls) {
    const s = itemState(it, cls);
    let btn;
    if (!s.fits) btn = `<button class="btn ghost" disabled>Not for ${esc(CLASSES[cls]?.name || cls)}</button>`;
    else if (s.eq) btn = `<button class="btn ghost" disabled>${ICON.check}Equipped</button>`;
    else if (s.owned) btn = `<button class="btn primary" data-act="equip">Equip${it.slot === 'skin' ? ` on ${esc(CLASSES[cls]?.name || cls)}` : ''}</button>`;
    else {
      const arm = performance.now() - ui.confirmAt < 4000;
      const short = M.salvage() < s.price;
      btn = short ? `<button class="btn ghost short" data-act="short">${ICON.lock}Need ${(s.price - M.salvage()).toLocaleString('en-US')} more</button>`
        : `<button class="btn primary buy${arm ? ' armed' : ''}" data-act="buy">${arm ? 'Tap to confirm' : 'Buy'}${coin(s.price)}</button>`;
    }
    const classes = Array.isArray(it.classes) ? it.classes.map((k) => CLASSES[k]?.name || k).join(', ') : null;
    return `<div class="dt r-${it.rarity}">
      ${previewBox(it, cls)}
      <div class="dt-info">
        <div class="dt-h"><span class="rar-pill">${RAR_LABEL[it.rarity]}</span>${s.feat && !s.owned ? `<span class="rar-pill deal">Featured -${Math.round(M.FEATURED_DISCOUNT * 100)}%</span>` : ''}</div>
        <b class="dt-name">${esc(it.name)}</b>
        <p class="dt-desc">${esc(it.desc || '')}${classes ? `<em> ${esc(classes)} only.</em>` : ''}</p>
        <div class="dt-btns">${btn}</div>
      </div>
    </div>`;
  }

  function renderShop() {
    const cls = settings.cls;
    const cat = M.catalog();
    const feat = M.featured();
    if (!ui.sel) ui.sel = feat[0] || cat.skin[1] || cat.skin[0];
    const it = M.itemById(ui.sel.slot, ui.sel.id) || cat.skin[0];
    const h = Math.floor(M.msToReset() / 3600000), mi = Math.floor((M.msToReset() % 3600000) / 60000);
    const list = cat[ui.tab];
    body.innerHTML = `
      <div class="shop-grid">
        <div class="shop-detail">${detail(it, cls)}</div>
        <div class="shop-main">
          <div class="shop-sec"><span>${ICON.star}Featured</span><small>New picks in ${h}h ${mi}m</small></div>
          <div class="feat-row">${feat.map((f) => card(f, cls, true)).join('')}</div>
          <div class="shop-tabs" role="tablist">${M.SLOTS.map((s) => `<button role="tab" data-tab="${s.key}" class="${ui.tab === s.key ? 'on' : ''}" aria-selected="${ui.tab === s.key}">${ICON[SLOT_ICON[s.key]]}${s.name}<small>${cat[s.key].filter((x) => M.owns(s.key, x.id)).length}/${cat[s.key].length}</small></button>`).join('')}</div>
          <div class="it-grid">${list.map((x) => card(x, cls)).join('')}</div>
          <p class="shop-foot">${ICON.coin}Salvage is earned in matches: placement, kills and wins. No real money, ever.</p>
        </div>
      </div>`;
    wire();
    M.markSeen(it.slot, it.id);
    const cv = body.querySelector('.shop-detail canvas');
    requestAnimationFrame(() => { if (ui.view === 'shop' && !sheet.classList.contains('hidden')) startPreview(cv, previewOpts(it, cls)); });
  }

  function renderLocker() {
    const cls = settings.cls;
    const P = M.classProgress(cls);
    const lo = M.loadoutFor(cls);
    const cat = M.catalog();
    const slot = ui.lockerSlot || 'skin';
    const ladder = M.TIER_XP.map((xp, t) => `<div class="lad${t <= P.tier ? ' got' : ''}${t === P.tier ? ' cur' : ''}">${badgeSVG(cls, t, { size: 40, animated: false, title: false })}<b>${M.TIER_NAMES[t]}</b><small>${xp ? `${(xp / 1000).toFixed(xp % 1000 ? 1 : 0)}k XP` : 'Start'}</small></div>`).join('');
    const owned = cat[slot].filter((x) => M.owns(slot, x.id));
    const locked = cat[slot].filter((x) => !M.owns(slot, x.id)).length;
    body.innerHTML = `
      <div class="lk-classes" role="tablist">${M.CLASS_KEYS.filter((k) => CLASSES[k]).map((k) => { const p = M.classProgress(k); return `<button role="tab" data-cls="${k}" class="${k === cls ? 'on' : ''}" aria-selected="${k === cls}">${badgeSVG(k, p.tier, { size: 40, animated: false, title: false })}<b>${esc(CLASSES[k].name)}</b><small>${p.name}</small></button>`; }).join('')}</div>
      <div class="lk-grid">
        <div class="lk-prestige panel-in">
          <div class="lk-badge">${badgeSVG(cls, P.tier, { size: 132, animated: true })}</div>
          <div class="lk-pinfo">
            <small class="lk-k">${esc(CLASSES[cls]?.name || cls)} prestige</small>
            <b class="lk-tier t${P.tier}">${P.name}</b>
            <div class="xpbar"><i style="--w:${Math.round(P.frac * 100)}%"></i></div>
            <small class="lk-xp">${P.next === null ? `${P.xp.toLocaleString('en-US')} XP · max tier` : `${P.xp.toLocaleString('en-US')} / ${P.next.toLocaleString('en-US')} XP · ${P.toNext.toLocaleString('en-US')} to ${M.TIER_NAMES[P.tier + 1]}`}</small>
            <small class="lk-st">${P.stats.matches} match${P.stats.matches === 1 ? '' : 'es'} · ${P.stats.kills} kill${P.stats.kills === 1 ? '' : 's'} · ${P.stats.wins} win${P.stats.wins === 1 ? '' : 's'}</small>
          </div>
          <div class="ladder">${ladder}</div>
        </div>
        <div class="lk-loadout">
          ${previewBox(M.itemById('skin', lo.skin) || cat.skin[0], cls)}
          <div class="lk-slots">${M.SLOTS.map((s) => { const it = M.itemById(s.key, lo[s.key]); return `<button class="lk-slot r-${it?.rarity || 'common'}${slot === s.key ? ' on' : ''}" data-slot="${s.key}"><span class="ls-ic">${ICON[SLOT_ICON[s.key]]}</span><span><small>${s.one}</small><b>${esc(it?.name || 'Default')}</b></span></button>`; }).join('')}</div>
          <div class="lk-owned">${owned.map((x) => { const eq = lo[slot] === x.id; const fits = M.fitsClass(x, cls); return `<button class="own r-${x.rarity}${eq ? ' eq' : ''}" data-slot="${slot}" data-id="${esc(x.id)}" ${fits ? '' : 'disabled'}>${itemArt(x, cls)}<b>${esc(x.name)}</b>${eq ? `<span class="own-eq">${ICON.check}</span>` : ''}</button>`; }).join('')}
            ${locked ? `<button class="own more" data-goshop="${slot}">${ICON.shop}<b>${locked} more in the Shop</b></button>` : ''}</div>
        </div>
      </div>`;
    wire();
    const cv = body.querySelector('.lk-loadout canvas');
    requestAnimationFrame(() => { if (ui.view === 'locker' && !sheet.classList.contains('hidden')) startPreview(cv, slot === 'skin' ? { cls, skin: lo.skin } : slot === 'killFx' ? { cls, skin: lo.skin, killFx: lo.killFx } : { cls, skin: lo.skin, dropIn: lo.dropIn }); });
  }

  function render() {
    header();
    stopPreview();
    if (ui.view === 'shop') renderShop(); else renderLocker();
  }

  function wire() {
    body.querySelectorAll('.it').forEach((b) => {
      b.onclick = () => {
        click();
        ui.sel = { slot: b.dataset.slot, id: b.dataset.id };
        ui.confirmAt = 0;
        render();
        // On phones the detail pane is above the list: bring it into view.
        body.querySelector('.shop-detail')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      };
    });
    body.querySelectorAll('.shop-tabs button').forEach((b) => { b.onclick = () => { click(); ui.tab = b.dataset.tab; render(); }; });
    const act = body.querySelector('.dt-btns [data-act]');
    if (act) {
      act.onclick = () => {
        const it = M.itemById(ui.sel.slot, ui.sel.id);
        if (!it) return;
        if (act.dataset.act === 'short') { onClick?.('error'); toast?.('Not enough Salvage yet. Play a match to earn more.', 'error'); return; }
        if (act.dataset.act === 'equip') {
          const r = M.equip(it.slot, it.id, settings.cls);
          click();
          if (!r.ok) toast?.(r.error, 'error'); else toast?.(`${it.name} equipped`, 'loot', SLOT_ICON[it.slot]);
          onChange?.(); render(); return;
        }
        if (act.dataset.act === 'buy') {
          if (performance.now() - ui.confirmAt > 4000) { click(); ui.confirmAt = performance.now(); render(); return; }
          const r = M.buy(it.slot, it.id);
          ui.confirmAt = 0;
          if (!r.ok) { onClick?.('error'); toast?.(r.error, 'error'); render(); return; }
          onBuy?.(it);
          // Buying something new equips it right away when it fits.
          if (M.fitsClass(it, settings.cls)) M.equip(it.slot, it.id, settings.cls);
          toast?.(`${it.name} unlocked and equipped`, 'loot', 'sparkle');
          onChange?.();
          render();
          const d = body.querySelector('.dt');
          d?.classList.add('bought');
        }
      };
    }
    body.querySelectorAll('.lk-classes button').forEach((b) => { b.onclick = () => { click(); settings.cls = b.dataset.cls; onChange?.(); render(); }; });
    body.querySelectorAll('.lk-slot').forEach((b) => { b.onclick = () => { click(); ui.lockerSlot = b.dataset.slot; render(); }; });
    body.querySelectorAll('.own[data-id]').forEach((b) => {
      b.onclick = () => {
        const r = M.equip(b.dataset.slot, b.dataset.id, settings.cls);
        click();
        if (!r.ok) toast?.(r.error, 'error');
        onChange?.(); render();
      };
    });
    body.querySelectorAll('[data-goshop]').forEach((b) => { b.onclick = () => { click(); ui.view = 'shop'; ui.tab = b.dataset.goshop; ui.sel = null; render(); body.scrollTop = 0; sheet.querySelector('.sheet-card').scrollTop = 0; }; });
  }

  sheet.querySelectorAll('.shop-switch button').forEach((b) => {
    b.onclick = () => { click(); ui.view = b.dataset.view; ui.confirmAt = 0; render(); sheet.querySelector('.sheet-card').scrollTop = 0; };
  });
  onSheetClose('shopSheet', () => { stopPreview(); ui.confirmAt = 0; onChange?.(); });
  M.onMetaChange(() => { if (!sheet.classList.contains('hidden')) header(); });

  return {
    open(view = 'shop', opts = {}) {
      ui.view = view;
      ui.confirmAt = 0;
      if (opts.tab) ui.tab = opts.tab;
      if (opts.sel) ui.sel = opts.sel;
      openSheet('shopSheet');
      render();
      sheet.querySelector('.sheet-card').scrollTop = 0;
    },
    close() { closeSheet('shopSheet'); },
    isOpen: () => !sheet.classList.contains('hidden'),
    stopPreview,
  };
}
