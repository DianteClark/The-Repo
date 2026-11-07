// Class badges: one emblem per class, five prestige tiers that escalate from a
// flat stamped disc (Recruit) to an animated holographic crest (Legend).
// Pure SVG strings. Every call gets its own gradient/filter ids, so any number
// of badges can share a page (and a hidden one never breaks a visible one).

export const TIERS = ['Recruit', 'Veteran', 'Elite', 'Master', 'Legend'];
export const tierName = (t) => TIERS[Math.max(0, Math.min(4, t | 0))];

/** Enamel colour of each class (the badge field), plus a lighter accent. */
export const CLASS_BADGE = {
  assault: { field: '#c8562a', deep: '#5e1f0b', accent: '#ffb27a' },
  marksman: { field: '#3d7d4c', deep: '#123220', accent: '#a9e3a0' },
  breacher: { field: '#3a5f92', deep: '#111f38', accent: '#a9c6ff' },
  medic: { field: '#b13246', deep: '#4a0d18', accent: '#ffb3bf' },
  recon: { field: '#6c4ea3', deep: '#251648', accent: '#d2bcff' },
};
const FALLBACK = { field: '#55716f', deep: '#1b2a2a', accent: '#d8cfb6' };

let uid = 0;

// ------------------------------------------------------------------ class motifs
// Drawn in a 120×120 box, centred on (60, 58), about 40px across.

const MOTIF = {
  // Spearhead over two rank chevrons: the one who goes first.
  assault: (c) => `<g fill="${c}">
      <path d="M60 33 L73 53 L65 51.5 L65 63 L55 63 L55 51.5 L47 53 Z"/>
      <path d="M45 67 L60 75 L75 67 L75 72.5 L60 80.5 L45 72.5 Z"/>
      <path d="M48 77.5 L60 84 L72 77.5 L72 82 L60 88.5 L48 82 Z" opacity=".75"/></g>`,
  // Reticle with a split crosshair and a centre dot.
  marksman: (c) => `<g fill="none" stroke="${c}" stroke-linecap="round">
      <circle cx="60" cy="59" r="15.5" stroke-width="4.2"/>
      <path d="M60 36.5 V47 M60 71 V81.5 M37.5 59 H48 M72 59 H82.5" stroke-width="4.2"/>
      <circle cx="60" cy="59" r="3.6" fill="${c}" stroke="none"/></g>`,
  // A brick wall with a charge-shaped hole punched through it.
  breacher: (c) => `<g fill="${c}" fill-rule="evenodd">
      <path d="M35 43 H85 V77 H35 Z M57.3 53.5 L51.2 51.2 L53.5 57.3 L44.5 60.0 L53.5 62.7 L51.2 68.8 L57.3 66.5 L60.0 75.5 L62.7 66.5 L68.8 68.8 L66.5 62.7 L75.5 60.0 L66.5 57.3 L68.8 51.2 L62.7 53.5 L60.0 44.5 Z M35 54 H43 V56 H35 Z M77 54 H85 V56 H77 Z M35 65 H45 V67 H35 Z M75 65 H85 V67 H75 Z M50 43 V45 H52 V43 Z M68 75 V77 H70 V75 Z"/></g>`,
  // Rounded cross inside a pulse ring.
  medic: (c) => `<g fill="${c}">
      <path d="M54.5 38 h11 a2.5 2.5 0 0 1 2.5 2.5 V51 h10.5 a2.5 2.5 0 0 1 2.5 2.5 v11 a2.5 2.5 0 0 1 -2.5 2.5 H68 v10.5 a2.5 2.5 0 0 1 -2.5 2.5 h-11 a2.5 2.5 0 0 1 -2.5 -2.5 V67 H41.5 A2.5 2.5 0 0 1 39 64.5 v-11 a2.5 2.5 0 0 1 2.5 -2.5 H52 V40.5 A2.5 2.5 0 0 1 54.5 38 z"/></g>
      <circle cx="60" cy="59" r="27" fill="none" stroke="${c}" stroke-width="1.6" stroke-dasharray="2 4" opacity=".6"/>`,
  // Watchful eye under radar arcs.
  recon: (c) => `<g fill="none" stroke="${c}" stroke-linecap="round">
      <path d="M36 63 Q60 42 84 63 Q60 84 36 63 Z" stroke-width="4" stroke-linejoin="round"/>
      <path d="M46 44 Q60 33 74 44" stroke-width="3.4"/>
      <path d="M52 37.5 Q60 32 68 37.5" stroke-width="3" opacity=".7"/></g>
      <circle cx="60" cy="63" r="8" fill="${c}"/><circle cx="62.6" cy="60.6" r="2.4" fill="#000" fill-opacity=".35"/>`,
};

// ------------------------------------------------------------------ shared shapes

const SHIELD = 'M60 21 L89 31.5 V57 C89 78 75 90.5 60 98 C45 90.5 31 78 31 57 V31.5 Z';
const SHIELD_IN = 'M60 27.5 L83.5 36 V57.5 C83.5 74.5 72.5 85 60 91.5 C47.5 85 36.5 74.5 36.5 57.5 V36 Z';

const star = (cx, cy, r, fill, extra = '') => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    pts.push(`${(cx + Math.cos(a) * rr).toFixed(2)},${(cy + Math.sin(a) * rr).toFixed(2)}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}"${extra}/>`;
};
const spark = (cx, cy, r, fill, inner = '') =>
  `<path d="M${cx} ${cy - r} Q${cx + r * 0.18} ${cy - r * 0.18} ${cx + r} ${cy} Q${cx + r * 0.18} ${cy + r * 0.18} ${cx} ${cy + r} Q${cx - r * 0.18} ${cy + r * 0.18} ${cx - r} ${cy} Q${cx - r * 0.18} ${cy - r * 0.18} ${cx} ${cy - r} Z" fill="${fill}"${inner ? ` opacity="0">${inner}</path>` : '/>'}`;

function wing(fill, edge, n = 5) {
  // A fan of feathers to the left of the shield; mirrored for the right.
  let s = '';
  for (let i = 0; i < n; i++) {
    const rx = 15 - i * 1.4;
    const ang = 192 + i * 13;
    const ox = 34 - i * 0.6, oy = 41 + i * 6.2;
    const a = (ang * Math.PI) / 180;
    const cx = ox + Math.cos(a) * rx, cy = oy + Math.sin(a) * rx;
    s += `<ellipse cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" rx="${rx.toFixed(2)}" ry="${(4.6 - i * 0.35).toFixed(2)}" transform="rotate(${ang} ${cx.toFixed(2)} ${cy.toFixed(2)})" fill="${fill}" stroke="${edge}" stroke-width=".9"/>`;
  }
  return `<g>${s}</g><g transform="matrix(-1 0 0 1 120 0)">${s}</g>`;
}

function laurel(fill, edge) {
  let s = '';
  const R = 45, cx = 60, cy = 60;
  for (let i = 0; i < 9; i++) {
    const th = (104 + i * 13.5) * Math.PI / 180;
    for (const side of [-1, 1]) {
      const r = R + side * 3.2;
      const x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
      const rot = (th * 180) / Math.PI + 90 + side * 28;
      s += `<ellipse cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" rx="5.4" ry="2.3" transform="rotate(${rot.toFixed(1)} ${x.toFixed(2)} ${y.toFixed(2)})" fill="${fill}" stroke="${edge}" stroke-width=".6"/>`;
    }
  }
  const stem = `<path d="M${(cx + Math.cos(104 * Math.PI / 180) * R).toFixed(1)} ${(cy + Math.sin(104 * Math.PI / 180) * R).toFixed(1)} A${R} ${R} 0 0 1 ${(cx + Math.cos(212 * Math.PI / 180) * R).toFixed(1)} ${(cy + Math.sin(212 * Math.PI / 180) * R).toFixed(1)}" fill="none" stroke="${edge}" stroke-width="1.4"/>`;
  const one = stem + s;
  return `<g>${one}</g><g transform="matrix(-1 0 0 1 120 0)">${one}</g>`;
}

function rays(fill, n = 16, r0 = 26, r1 = 58) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const w = Math.PI / n * 0.5;
    const p = (rr, aa) => `${(60 + Math.cos(aa) * rr).toFixed(1)},${(60 + Math.sin(aa) * rr).toFixed(1)}`;
    s += `<polygon points="${p(r0, a - w)} ${p(r1, a)} ${p(r0, a + w)}"/>`;
  }
  return `<g fill="${fill}">${s}</g>`;
}

const METAL = {
  1: ['#ffd2a0', '#c27d43', '#6e3a17'], // bronze
  2: ['#ffffff', '#c3ced3', '#5f6d74'], // steel / silver
  3: ['#fff6c4', '#f3c24b', '#9a5f05'], // gold
  4: ['#fff6c4', '#f3c24b', '#9a5f05'], // gold trim around the holo field
};

// ------------------------------------------------------------------ main

/**
 * @param {string} cls   class key
 * @param {number} tier  0 Recruit … 4 Legend
 * @param {{size?:number, animated?:boolean, title?:boolean, cls?:string}} opts
 */
export function badgeSVG(cls, tier = 0, opts = {}) {
  const t = Math.max(0, Math.min(4, tier | 0));
  const size = opts.size ?? 64;
  const animated = opts.animated !== false && t === 4 ? true : !!opts.animated && t >= 3;
  const C = CLASS_BADGE[cls] || FALLBACK;
  const motif = MOTIF[cls] || MOTIF.assault;
  const id = `bg${++uid}`;
  const extraCls = opts.cls ? ' ' + opts.cls : '';
  const label = opts.title === false ? '' : `<title>${tierName(t)} ${cls}</title>`;
  const open = `<svg class="cbadge t${t} b-${cls}${animated ? ' anim' : ''}${extraCls}" viewBox="0 0 120 120" width="${size}" height="${size}" role="img" aria-label="${tierName(t)} badge">${label}`;

  if (t === 0) {
    // Recruit: flat stamped disc, one colour, dashed stamp ring. Honest and plain.
    return `${open}
      <circle cx="60" cy="60" r="40" fill="#3a4746"/>
      <circle cx="60" cy="60" r="40" fill="none" stroke="#24302f" stroke-width="3"/>
      <circle cx="60" cy="60" r="34" fill="none" stroke="#8a9a95" stroke-width="1.6" stroke-dasharray="3.2 3.2" opacity=".75"/>
      <g opacity=".9" transform="translate(0 1)">${motif('#c9c1a8')}</g>
    </svg>`;
  }

  const m = METAL[t];
  const defs = [];
  defs.push(`<linearGradient id="${id}m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${m[0]}"/><stop offset=".45" stop-color="${m[1]}"/><stop offset="1" stop-color="${m[2]}"/></linearGradient>`);
  defs.push(`<linearGradient id="${id}e" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.field}"/><stop offset="1" stop-color="${C.deep}"/></linearGradient>`);
  defs.push(`<clipPath id="${id}c"><path d="${SHIELD_IN}"/></clipPath>`);
  if (t >= 3) defs.push(`<radialGradient id="${id}g" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${t === 4 ? '#fff' : '#fff3c0'}" stop-opacity=".85"/><stop offset=".55" stop-color="${t === 4 ? '#b9f3ff' : '#ffcf5a'}" stop-opacity=".25"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>`);
  if (t === 4) {
    defs.push(`<linearGradient id="${id}h" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">
      <stop offset="0" stop-color="#ff7ad9"/><stop offset=".25" stop-color="#7fe9ff"/><stop offset=".5" stop-color="#fff0a0"/><stop offset=".75" stop-color="#b28dff"/><stop offset="1" stop-color="#ff7ad9"/>
      ${animated ? '<animateTransform attributeName="gradientTransform" type="rotate" values="0 .5 .5;360 .5 .5" dur="6s" repeatCount="indefinite"/>' : ''}</linearGradient>`);
    defs.push(`<linearGradient id="${id}s" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".75"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`);
    defs.push(`<filter id="${id}f" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`);
  }

  const parts = [];
  // Back layer: rays (Master+) and an aura (Legend).
  if (t >= 3) parts.push(`<circle cx="60" cy="60" r="56" fill="url(#${id}g)">${animated ? '<animate attributeName="opacity" values=".55;1;.55" dur="2.6s" repeatCount="indefinite"/>' : ''}</circle>`);
  if (t >= 3) {
    parts.push(`<g opacity="${t === 4 ? 0.55 : 0.4}">${rays(t === 4 ? `url(#${id}h)` : '#ffd76a')}${animated ? '<animateTransform attributeName="transform" type="rotate" values="0 60 60;360 60 60" dur="40s" repeatCount="indefinite"/>' : ''}</g>`);
  }
  // Laurels (Master+).
  if (t >= 3) parts.push(laurel(t === 4 ? `url(#${id}h)` : '#e8b23a', t === 4 ? '#fff6c4' : '#8a5a06'));
  // Wings (Elite+).
  if (t >= 2) {
    const wf = t === 2 ? `url(#${id}m)` : t === 3 ? '#f6dc8a' : `url(#${id}h)`;
    const we = t === 2 ? '#56636a' : '#8a5a06';
    parts.push(`<g transform="translate(0 2)">${wing(wf, we, t >= 3 ? 6 : 5)}</g>`);
  }
  // The shield: metal rim, enamel field, motif.
  parts.push(`<path d="${SHIELD}" fill="#000" fill-opacity=".35" transform="translate(0 2.5)"/>`);
  parts.push(`<path d="${SHIELD}" fill="${t === 4 ? `url(#${id}h)` : `url(#${id}m)`}" stroke="${m[2]}" stroke-width="1.2"/>`);
  if (t >= 3) parts.push(`<path d="M60 24.5 L86 34 V57.2 C86 76.5 73.6 88 60 94.8 C46.4 88 34 76.5 34 57.2 V34 Z" fill="none" stroke="${m[0]}" stroke-width="1" opacity=".8"/>`);
  parts.push(`<path d="${SHIELD_IN}" fill="url(#${id}e)"/>`);
  if (t === 4) parts.push(`<path d="${SHIELD_IN}" fill="url(#${id}h)" fill-opacity=".3"/><path d="${SHIELD_IN}" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="1"/>`);
  // Field texture: a subtle diagonal sheen.
  parts.push(`<g clip-path="url(#${id}c)"><path d="M20 20 L100 20 L20 80 Z" fill="#fff" fill-opacity="${t === 4 ? 0.14 : 0.1}"/></g>`);
  // Motif with an engraved shadow.
  const mc = t === 1 ? '#f2dcc0' : t === 2 ? '#f4f7f8' : t === 3 ? '#fff4cf' : '#ffffff';
  parts.push(`<g transform="translate(0 1.4)" opacity=".45">${motif('#000')}</g>`);
  parts.push(`<g${t === 4 ? ` filter="url(#${id}f)"` : ''}>${motif(mc)}</g>`);
  // Legend: a light sweep across the field.
  if (t === 4 && animated) {
    parts.push(`<g clip-path="url(#${id}c)"><rect x="-40" y="10" width="26" height="110" fill="url(#${id}s)" transform="rotate(18 60 60)"><animate attributeName="x" values="-60;130;130" keyTimes="0;.55;1" dur="3.2s" repeatCount="indefinite"/></rect></g>`);
  }
  // Rank marks: Veteran chevron, Elite 2 stars, Master 3 stars + gem, Legend crown + gem.
  if (t === 1) {
    parts.push(`<path d="M44 101 L60 109 L76 101 L76 106 L60 114 L44 106 Z" fill="url(#${id}m)" stroke="${m[2]}" stroke-width="1"/>`);
  }
  if (t >= 2) {
    // Ribbon under the shield.
    parts.push(`<path d="M30 96 L44 92 L60 96 L76 92 L90 96 L86 104 L90 110 L74 107 L60 110 L46 107 L30 110 L34 104 Z" fill="${C.deep}" stroke="${t === 2 ? '#c3ced3' : '#f3c24b'}" stroke-width="1.2"/>`);
    parts.push(`<path d="M44 99.5 L60 102.5 L76 99.5" fill="none" stroke="${t === 2 ? '#c3ced3' : '#f3c24b'}" stroke-width="1" opacity=".7"/>`);
  }
  if (t === 2) parts.push(star(50, 15, 4.6, '#eef3f5') + star(70, 15, 4.6, '#eef3f5'));
  if (t === 3) parts.push(star(44, 17, 4.2, '#ffe28a') + star(76, 17, 4.2, '#ffe28a'));
  if (t >= 3) {
    // Gem at the crest.
    const g1 = C.accent, g2 = C.field;
    parts.push(`<g transform="translate(60 18)">${t === 4 ? '<path d="M-14 4 L-11 -9 L-5 -2 L0 -13 L5 -2 L11 -9 L14 4 Z" fill="#f3c24b" stroke="#8a5a06" stroke-width="1"/>' : ''}
      <path d="M0 -8 L7 0 L0 9 L-7 0 Z" fill="${g2}" stroke="#fff6c4" stroke-width="1.2"/>
      <path d="M0 -8 L7 0 L0 1.5 L-7 0 Z" fill="${g1}" opacity=".9"/>
      <path d="M-2.5 -3.5 L0 -6 L1 -3 Z" fill="#fff" opacity=".9">${animated ? '<animate attributeName="opacity" values=".2;1;.2" dur="1.8s" repeatCount="indefinite"/>' : ''}</path></g>`);
  }
  if (t === 4) {
    const tw = (x, y, r, d) => spark(x, y, r, '#fff', animated ? `<animate attributeName="opacity" values="0;1;0" dur="2.4s" begin="${d}s" repeatCount="indefinite"/>` : '');
    parts.push(tw(18, 26, 5, 0) + tw(102, 30, 4, 0.8) + tw(98, 92, 5, 1.5) + tw(22, 88, 3.6, 2));
  }

  return `${open}<defs>${defs.join('')}</defs>${parts.join('')}</svg>`;
}

/** A small, cheap badge for dense lists (turn strip, feed): Recruit art at any tier, tier pips under it. */
export function badgeMini(cls, tier = 0, size = 24) {
  return badgeSVG(cls, Math.min(tier, 2), { size, animated: false, title: false, cls: 'mini' });
}

// Memoised badges for HUD elements that re-render by string comparison: the
// same (class, tier, size) always returns the same markup, so unchanged cards
// are not rebuilt every frame.
const memo = new Map();
export function badgeCached(cls, tier, opts = {}) {
  const k = `${cls}|${tier}|${opts.size ?? 64}|${opts.animated ? 1 : 0}|${opts.cls || ''}`;
  let v = memo.get(k);
  if (!v) { v = badgeSVG(cls, tier, { ...opts, title: false }); memo.set(k, v); }
  return v;
}

/** A stable pseudo-prestige for bots (by name), so squads look varied but consistent. */
export function botTier(u) {
  const s = `${u?.name || ''}:${u?.cls || ''}`;
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return [0, 0, 0, 1, 1, 1, 2, 2, 3, 4][h % 10];
}
