// Settings → Transfer sheet: export (code + QR + copy/share) and import
// (paste → validate → preview "Level 23 · 4,200 Salvage · 37 items" → confirm).

import { ICON } from './icons.js';
import { openSheet } from './menu.js';
import * as T from './transfer.js';
import { sanitizeSettings } from './settings.js';
import { sanitizeCareer } from './career.js';
import { sanitizeMeta } from './meta.js';
import * as P from './progress.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('en-US');

/** Sanitise each store of a decoded snapshot (garbage in → defaults out). */
export function cleanSnapshot(d) {
  return {
    settings: d.settings ? sanitizeSettings(d.settings) : null,
    career: d.career ? sanitizeCareer(d.career) : null,
    meta: d.meta ? { ...sanitizeMeta(d.meta), migrated: true, welcomed: true, notice: null } : null,
    progress: d.progress ? { ...P.sanitize(d.progress), migrated: true, notice: null } : null,
  };
}
export function summarize(clean) {
  const lv = P.levelInfo(clean.progress?.xp || 0).level;
  const salv = clean.meta?.salvage || 0;
  const items = clean.meta ? Object.values(clean.meta.owned || {}).reduce((a, l) => a + (Array.isArray(l) ? l.length : 0), 0) + (clean.progress?.owned?.cards?.length || 0) + (clean.progress?.owned?.emblems?.length || 0) : 0;
  const name = clean.settings?.callsign || 'Unnamed';
  const matches = clean.career?.matches || 0;
  return { lv, salv, items, name, matches, line: `Level ${lv} · ${fmt(salv)} Salvage · ${items} item${items === 1 ? '' : 's'}` };
}

export function openTransfer(mode = 'export', { onClick, toast } = {}) {
  const body = $('transferBody');
  const tabs = (m) => `<div class="seg xf-tabs"><button data-m="export" class="${m === 'export' ? 'on' : ''}">${ICON.upload}Export</button><button data-m="import" class="${m === 'import' ? 'on' : ''}">${ICON.download}Import</button></div>`;
  const wireTabs = () => body.querySelectorAll('.xf-tabs button').forEach((b) => { b.onclick = () => { onClick?.(); show(b.dataset.m); }; });

  async function showExport() {
    body.innerHTML = `${tabs('export')}<div class="xf-wait">Packing your account…</div>`;
    wireTabs();
    const code = await T.exportCode();
    const sum = summarize(cleanSnapshot(T.snapshot()));
    const qr = T.qrSVG(code, { size: 232 });
    body.innerHTML = `${tabs('export')}
      <div class="xf-sum">${ICON.user}<div><b>${esc(sum.name)}</b><small>${esc(sum.line)}</small></div></div>
      <div class="xf-qr">${qr || `<div class="xf-noqr">${ICON.qr}<small>Too much data for one QR code. Copy the code instead.</small></div>`}</div>
      <p class="xf-note">Scan this on your other device, or copy the code. It holds your level, Salvage, items, loadouts, weapon progress, challenges and settings. Anyone with it can copy your progress, so keep it to yourself.</p>
      <textarea id="xfCode" class="xf-code" readonly rows="4" spellcheck="false">${esc(code)}</textarea>
      <div class="xf-btns"><button id="xfCopy" class="btn primary">${ICON.copy}Copy code</button>${navigator.share ? `<button id="xfShare" class="btn ghost">${ICON.share}Share</button>` : ''}</div>`;
    wireTabs();
    const ta = $('xfCode');
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    ta.onfocus = () => ta.select();
    $('xfCopy').onclick = async () => {
      onClick?.();
      try { await navigator.clipboard.writeText(code); toast?.('Transfer code copied', 'loot', 'copy'); } catch { ta.select(); document.execCommand?.('copy'); toast?.('Code selected: copy it from the box', 'info', 'copy'); }
    };
    $('xfShare')?.addEventListener('click', () => { onClick?.(); navigator.share({ title: 'Tidefall transfer code', text: code }).catch(() => {}); });
  }

  function showImport(prefill = '') {
    body.innerHTML = `${tabs('import')}
      <p class="xf-note">Paste a code that starts with <b>TF5-</b>. We check it before anything changes.</p>
      <textarea id="xfIn" class="xf-code" rows="5" spellcheck="false" autocomplete="off" placeholder="TF5-…">${esc(prefill)}</textarea>
      <div id="xfPrev" class="xf-prev"></div>
      <div class="xf-btns"><button id="xfCheck" class="btn primary">${ICON.check}Check code</button></div>`;
    wireTabs();
    const ta = $('xfIn');
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    let clean = null;
    const prev = $('xfPrev');
    $('xfCheck').onclick = async () => {
      onClick?.();
      const r = await T.decodeCode(ta.value);
      if (!r.ok) { clean = null; prev.className = 'xf-prev bad'; prev.innerHTML = `${ICON.warn}<span>${esc(r.error)}</span>`; onClick?.('error'); return; }
      clean = cleanSnapshot(r.data);
      const s = summarize(clean);
      const now = summarize(cleanSnapshot(T.snapshot()));
      prev.className = 'xf-prev ok';
      prev.innerHTML = `<div class="xf-cmp"><div><small>This device now</small><b>${esc(now.name)}</b><span>${esc(now.line)}</span></div><span class="xf-arrow">${ICON.chevR}</span><div class="new"><small>From the code${r.data.at ? ` · ${new Date(r.data.at).toLocaleDateString()}` : ''}</small><b>${esc(s.name)}</b><span>${esc(s.line)}</span></div></div>
        <p class="xf-warn">${ICON.warn}This replaces everything on this device. It can't be undone.</p>
        <button id="xfApply" class="btn primary danger-fill">Replace my progress</button>`;
      $('xfApply').onclick = () => {
        onClick?.();
        T.writeSnapshot(clean);
        toast?.('Progress imported. Reloading…', 'loot', 'check');
        setTimeout(() => location.reload(), 700);
      };
    };
  }

  function show(m) { if (m === 'import') showImport(); else showExport(); }
  show(mode);
  openSheet('transferSheet');
}
