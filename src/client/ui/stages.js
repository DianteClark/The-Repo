// Stage metadata for the UI: names, taglines and twists come from the sim's
// STAGES (constants.js) when present; the local table mirrors V3_SPEC so the
// stage picker still works before (or without) the sim update.

import { ICON } from './icons.js';

const LOCAL = {
  harbor: { key: 'harbor', name: 'Drowned Harbor', tagline: 'Docks, containers and a rising tide.', twist: 'The classic: dense hard cover, tide closing in from every edge.', icon: 'tide', short: 'Classic tide' },
  kelp: { key: 'kelp', name: 'Kelp Shallows', tagline: 'Open water, thick weed, few walls.', twist: 'Kelp beds hide you from anyone more than 3 tiles away and give -10 aim against you. No cover in kelp.', icon: 'kelp', short: 'Kelp hides you' },
  rig: { key: 'rig', name: 'Rig Graveyard', tagline: 'Rusting platforms and fuel drums.', twist: 'Red-banded barrels explode: 4 damage in a 3×3 when shot, fragged or breached, and they chain. Shoot one for 1 AP.', icon: 'barrelx', short: 'Explosive barrels' },
  spire: { key: 'spire', name: 'Night Spires', tagline: 'Neon towers in total darkness.', twist: 'Night: sight drops to 6 tiles. Firing lights a flare over you, visible to every squad until your next turn.', icon: 'flare', short: 'Night + flares' },
  surge: { key: 'surge', name: 'Surge Point', tagline: 'A storm that pushes the fight.', twist: 'The safe zone drifts every time it shrinks. Watch the cyan ring and rotate early.', icon: 'drift', short: 'Drifting zone' },
};
export const STAGE_ORDER = ['harbor', 'kelp', 'rig', 'spire', 'surge'];

export function stageList(K) {
  const S = K?.STAGES && typeof K.STAGES === 'object' ? K.STAGES : null;
  const keys = S ? [...new Set([...STAGE_ORDER.filter((k) => S[k]), ...Object.keys(S)])] : STAGE_ORDER;
  return keys.map((k) => {
    const loc = LOCAL[k] || { key: k, name: k, tagline: '', twist: '', icon: 'tide', short: '' };
    const sim = S?.[k] || {};
    return {
      ...loc,
      key: k,
      name: typeof sim.name === 'string' ? sim.name : loc.name,
      tagline: typeof sim.tagline === 'string' ? sim.tagline : loc.tagline,
      // The sim's twist text describes mechanics; keep ours if theirs is missing.
      twist: typeof sim.twist === 'string' && sim.twist.length > 8 ? sim.twist : loc.twist,
      simReady: !!S?.[k],
    };
  });
}
export function stageInfo(K, key) { return stageList(K).find((s) => s.key === key) || LOCAL[key] || null; }

/** Small scenic illustration for a stage card (SVG, 160×90). */
let artId = 0;
export function stageArt(key) {
  const u = `s${++artId}`;
  let body = {
    harbor: `<rect width="160" height="90" fill="url(#sk-h)"/><circle cx="122" cy="26" r="13" fill="#ffd98a" opacity=".9"/>
      <path d="M0 60 H160 V90 H0Z" fill="#1d5f70"/><path d="M18 46h30v14H18zM52 40h22v20H52zM96 50h36v10H96z" fill="#3a2a22"/><path d="M58 30h3v10h-3zM58 30h18v3H58z" fill="#3a2a22"/>
      <path d="M0 64c14 0 14-3 28-3s14 3 28 3 14-3 28-3 14 3 28 3 14-3 28-3 14 3 20 3" stroke="#9fe7e0" stroke-width="1.6" fill="none" opacity=".6"/>`,
    kelp: `<rect width="160" height="90" fill="url(#sk-k)"/><path d="M0 50 H160 V90 H0Z" fill="#1f6b55"/>
      ${[14, 34, 52, 78, 98, 120, 142].map((x, i) => `<path d="M${x} 90 C${x - 6} ${70 - (i % 3) * 6} ${x + 6} ${60 - (i % 2) * 8} ${x - 2} ${40 + (i % 3) * 4}" stroke="#5fbf7d" stroke-width="3" fill="none" stroke-linecap="round"/>`).join('')}
      <path d="M0 54c14 0 14-3 28-3s14 3 28 3 14-3 28-3 14 3 28 3 14-3 28-3 14 3 20 3" stroke="#bff5d6" stroke-width="1.4" fill="none" opacity=".5"/>`,
    rig: `<rect width="160" height="90" fill="url(#sk-r)"/><path d="M0 64 H160 V90 H0Z" fill="#26393b"/>
      <path d="M30 64V30h50v34M30 40h50M42 30V18h8v12" stroke="#7a4a2c" stroke-width="4" fill="none"/>
      ${[[96, 52], [110, 52], [103, 40]].map(([x, y]) => `<rect x="${x}" y="${y}" width="12" height="12" rx="2" fill="#a8322b"/><rect x="${x}" y="${y + 4}" width="12" height="3" fill="#f0d36a"/>`).join('')}
      <circle cx="132" cy="30" r="10" fill="#ff8a3d" opacity=".55"/>`,
    spire: `<rect width="160" height="90" fill="url(#sk-s)"/>${[[16, 26, 14], [36, 12, 12], [62, 34, 16], [84, 18, 10], [104, 8, 14], [128, 30, 18]].map(([x, y, w]) => `<rect x="${x}" y="${y}" width="${w}" height="${90 - y}" fill="#10162a"/><rect x="${x + 3}" y="${y + 6}" width="${w - 6}" height="2" fill="${x % 3 ? '#ff5fd2' : '#7f9bff'}" opacity=".85"/>`).join('')}
      <circle cx="70" cy="18" r="4" fill="#fff6c8"/><circle cx="70" cy="18" r="12" fill="#fff6c8" opacity=".2"/>`,
    surge: `<rect width="160" height="90" fill="url(#sk-u)"/><path d="M0 58 H160 V90 H0Z" fill="#163c48"/>
      <path d="M96 4 L84 30 h10 L80 56" stroke="#e9f3ff" stroke-width="2.4" fill="none" stroke-linejoin="round"/>
      <circle cx="60" cy="66" r="18" fill="none" stroke="#7fe9ff" stroke-width="1.6" stroke-dasharray="4 3"/><path d="M60 66 L92 60" stroke="#7fe9ff" stroke-width="1.6"/><path d="M92 60 l-6 -3 1 6z" fill="#7fe9ff"/>`,
    random: `<rect width="160" height="90" fill="url(#sk-x)"/><text x="80" y="62" text-anchor="middle" font-size="52" font-weight="900" fill="#e9e5d8" opacity=".9" font-family="Barlow Condensed, sans-serif">?</text>`,
  }[key] || '';
  body = body.replace(/url\(#sk-/g, `url(#${u}-`);
  return `<svg class="st-art" viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs>
    <linearGradient id="${u}-h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9a65a"/><stop offset="1" stop-color="#5d4a3a"/></linearGradient>
    <linearGradient id="${u}-k" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fd3b4"/><stop offset="1" stop-color="#245e4a"/></linearGradient>
    <linearGradient id="${u}-r" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d0743d"/><stop offset="1" stop-color="#3b2a24"/></linearGradient>
    <linearGradient id="${u}-s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a1440"/><stop offset="1" stop-color="#06070f"/></linearGradient>
    <linearGradient id="${u}-u" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3d4a5a"/><stop offset="1" stop-color="#0f2026"/></linearGradient>
    <linearGradient id="${u}-x" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9a65a"/><stop offset=".3" stop-color="#3d7d64"/><stop offset=".55" stop-color="#a8322b"/><stop offset=".8" stop-color="#1a1440"/><stop offset="1" stop-color="#3d4a5a"/></linearGradient>
  </defs>${body}</svg>`;
}

export const stageIcon = (s) => ICON[s?.icon] || ICON.tide;
