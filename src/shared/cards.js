// Calling cards and emblems (UI stream). Procedural SVG art only: no image
// files, every piece is drawn from a style + palette, so the whole set costs a
// few kilobytes and scales to any size. Shown in the hub, the lobby, squad
// cards and the end screen.
//
// cardSVG(id, {name, level, emblem, w}) → 4:1 banner string
// emblemSVG(id, size) → square string
// Unlock rules ({kind:'level'|'prestige'|'gold'|'diamond'|'tidal'|'medal'|'wins'|'kills'|'price'|'default'})
// are evaluated by the UI's progress store.

let uid = 0;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function rng(seed) {
  let h = 2166136261 >>> 0;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0; return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}

// ------------------------------------------------------------------ catalog

const C = (id, name, style, colors, rarity, unlock, extra = {}) => ({ id, name, style, colors, rarity, unlock, ...extra });
const LV = (level) => ({ kind: 'level', level });
const PRICE = (price) => ({ kind: 'price', price });

export const CARDS = [
  C('first_tide', 'First Tide', 'waves', ['#0f3b4a', '#1f7a8c', '#bfe9e4'], 'common', { kind: 'default' }),
  C('salt_flats', 'Salt Flats', 'stripes', ['#2d3a3a', '#55716f', '#d8cfb6'], 'common', { kind: 'default' }),
  C('harbor_dusk', 'Harbor Dusk', 'skyline', ['#2a1636', '#c3683d', '#ffcf7a'], 'common', { kind: 'default' }),
  C('drift', 'Drift', 'topo', ['#10232a', '#2f5d62', '#9fd8cf'], 'common', LV(5)),
  C('gullwing', 'Gullwing', 'birds', ['#26445a', '#7aa7c7', '#f4f1e6'], 'common', LV(10)),
  C('hex_reef', 'Hex Reef', 'hex', ['#14212e', '#2b6c8a', '#7fe9ff'], 'rare', LV(15)),
  C('red_tide', 'Red Tide', 'waves', ['#2b0d14', '#a3263b', '#ff8a7a'], 'rare', LV(20)),
  C('rig_lights', 'Rig Lights', 'skyline', ['#0b1420', '#ff5a1f', '#ffd27a'], 'rare', LV(25)),
  C('kelp_forest', 'Kelp Forest', 'kelp', ['#082018', '#2f7a46', '#a9e3a0'], 'rare', LV(30)),
  C('night_spire', 'Night Spire', 'moon', ['#070b1d', '#3a3f8f', '#cfd8ff'], 'rare', LV(35)),
  C('stormfront', 'Stormfront', 'storm', ['#11161f', '#4a5a78', '#e8f1ff'], 'epic', LV(40)),
  C('shattered', 'Shattered Coast', 'shards', ['#1a1030', '#6c4ea3', '#ffb3e6'], 'epic', LV(50)),
  C('radar_sweep', 'Radar Sweep', 'radar', ['#03140c', '#0f6b3a', '#7dffb0'], 'epic', LV(60)),
  C('sunburst', 'High Noon', 'sunburst', ['#3a1804', '#f39a1e', '#fff1b8'], 'epic', LV(70)),
  C('deep_signal', 'Deep Signal', 'circuit', ['#04101c', '#1c4f7a', '#7fe9ff'], 'epic', LV(80)),
  C('maelstrom', 'Maelstrom', 'vortex', ['#060c16', '#1f4f8a', '#c8f4ff'], 'legendary', LV(90), { animated: true }),
  C('centurion', 'Centurion', 'laurel', ['#1a1204', '#c99a2e', '#fff3c0'], 'legendary', LV(100), { animated: true }),
  // Prestige: one per class at Legend.
  C('legend_assault', 'Spearhead', 'chevrons', ['#2a0e05', '#c8562a', '#ffb27a'], 'legendary', { kind: 'prestige', cls: 'assault', tier: 4 }, { animated: true }),
  C('legend_marksman', 'One Shot', 'reticle', ['#06170c', '#3d7d4c', '#a9e3a0'], 'legendary', { kind: 'prestige', cls: 'marksman', tier: 4 }, { animated: true }),
  C('legend_breacher', 'Wallbreaker', 'shards', ['#08101f', '#3a5f92', '#a9c6ff'], 'legendary', { kind: 'prestige', cls: 'breacher', tier: 4 }, { animated: true }),
  C('legend_medic', 'Lifeline', 'pulse', ['#1f050b', '#b13246', '#ffb3bf'], 'legendary', { kind: 'prestige', cls: 'medic', tier: 4 }, { animated: true }),
  C('legend_recon', 'Overseer', 'radar', ['#120a26', '#6c4ea3', '#d2bcff'], 'legendary', { kind: 'prestige', cls: 'recon', tier: 4 }, { animated: true }),
  C('legend_engineer', 'Bulwark', 'hex', ['#1d1405', '#b8862b', '#ffe0a0'], 'legendary', { kind: 'prestige', cls: 'engineer', tier: 4 }, { animated: true }),
  C('legend_gunner', 'Hailstorm', 'storm', ['#14100c', '#7a6a55', '#ffd9a0'], 'legendary', { kind: 'prestige', cls: 'gunner', tier: 4 }, { animated: true }),
  C('elite_any', 'Winged', 'wings', ['#0f1a22', '#8fa5a2', '#ffffff'], 'epic', { kind: 'prestige', cls: 'assault', tier: 2 }),
  // Camo mastery.
  C('gilded', 'Gilded', 'shards', ['#1a1204', '#c99a2e', '#fff3c0'], 'epic', { kind: 'gold', n: 1 }),
  C('diamond_cut', 'Diamond Cut', 'shards', ['#0a1424', '#7fb8ff', '#ffffff'], 'legendary', { kind: 'diamond' }, { animated: true }),
  C('tidal_master', 'Tidal', 'vortex', ['#03121c', '#14a3c7', '#7fe9ff'], 'legendary', { kind: 'tidal' }, { animated: true }),
  // Medals.
  C('first_blood', 'First Blood', 'slash', ['#16050a', '#b0122b', '#ff6b6b'], 'rare', { kind: 'medal', medal: 'first_blood', n: 5 }),
  C('clutch', 'Clutch', 'pulse', ['#0d0d14', '#ffb000', '#fff1c4'], 'epic', { kind: 'medal', medal: 'clutch', n: 3 }),
  C('collateral', 'Collateral', 'burst', ['#160b04', '#ff6a1f', '#ffd27a'], 'epic', { kind: 'medal', medal: 'collateral', n: 3 }),
  C('longshot', 'Longshot', 'reticle', ['#0a1218', '#55716f', '#e9e5d8'], 'rare', { kind: 'medal', medal: 'longshot', n: 10 }),
  C('champion', 'Last Above Water', 'laurel', ['#04121a', '#1f7a8c', '#ffb000'], 'epic', { kind: 'wins', n: 10 }),
  C('hundred', 'The Hundred', 'chevrons', ['#160404', '#7a1b1b', '#ff9a8a'], 'epic', { kind: 'kills', n: 100 }),
  // Store.
  C('neon_surf', 'Neon Surf', 'waves', ['#12062a', '#ff3fa4', '#7fe9ff'], 'rare', PRICE(400)),
  C('copper_rain', 'Copper Rain', 'rain', ['#140b06', '#b8642d', '#ffd2a0'], 'rare', PRICE(450)),
  C('aurora', 'Aurora', 'aurora', ['#030a14', '#2fe0a0', '#b28dff'], 'epic', PRICE(900), { animated: true }),
  C('lighthouse', 'Lighthouse', 'beam', ['#050b14', '#ffd27a', '#fff8e0'], 'epic', PRICE(950), { animated: true }),
  C('kraken', 'Kraken', 'tentacles', ['#08040f', '#5a1f6b', '#ff7ad9'], 'legendary', PRICE(2200), { animated: true }),
];

const E = (id, name, shape, glyph, colors, rarity, unlock) => ({ id, name, shape, glyph, colors, rarity, unlock });
export const EMBLEMS = [
  E('anchor', 'Anchor', 'circle', 'anchor', ['#1f7a8c', '#0b2a33', '#e9e5d8'], 'common', { kind: 'default' }),
  E('crosshair', 'Tide Line', 'circle', 'crosshair', ['#ffb000', '#2a1d00', '#fff4cf'], 'common', { kind: 'default' }),
  E('wave', 'Breaker', 'shield', 'wave', ['#2b6c8a', '#0a1c26', '#bfe9e4'], 'common', { kind: 'default' }),
  E('gull', 'Gull', 'hex', 'gull', ['#7aa7c7', '#14212e', '#ffffff'], 'common', LV(3)),
  E('compass', 'Compass', 'circle', 'compass', ['#c3683d', '#2a1206', '#ffd2a0'], 'common', LV(8)),
  E('trident', 'Trident', 'shield', 'trident', ['#3d7d4c', '#0b1f12', '#d8f5d0'], 'rare', LV(12)),
  E('skull', 'Drowned', 'diamond', 'skull', ['#d8cfb6', '#1b1b1b', '#ffffff'], 'rare', LV(18)),
  E('lighthouse', 'Beacon', 'shield', 'lighthouse', ['#b13246', '#1f050b', '#ffd27a'], 'rare', LV(22)),
  E('shark', 'Fin', 'circle', 'fin', ['#55716f', '#0d1617', '#e9e5d8'], 'rare', LV(28)),
  E('bolt', 'Surge', 'hex', 'bolt', ['#ffd000', '#1c1600', '#ffffff'], 'rare', LV(33)),
  E('eye', 'Kraken Eye', 'diamond', 'eye', ['#6c4ea3', '#120a26', '#ffe28a'], 'epic', LV(45)),
  E('crown', 'Crown', 'shield', 'crown', ['#c99a2e', '#1a1204', '#fff3c0'], 'epic', LV(55)),
  E('flame', 'Flare', 'circle', 'flame', ['#ff6a1f', '#200800', '#ffe0a0'], 'epic', LV(65)),
  E('wing', 'Gunship', 'hex', 'wing', ['#8fa5a2', '#10232a', '#ffffff'], 'epic', LV(75)),
  E('star', 'Polaris', 'star', 'star', ['#7fe9ff', '#04101c', '#ffffff'], 'legendary', LV(85)),
  E('tidal', 'Tidefall', 'circle', 'tide', ['#14a3c7', '#03121c', '#7fe9ff'], 'legendary', LV(100)),
  E('e_assault', 'Spearhead', 'shield', 'spear', ['#c8562a', '#2a0e05', '#ffb27a'], 'epic', { kind: 'prestige', cls: 'assault', tier: 3 }),
  E('e_marksman', 'Reticle', 'circle', 'crosshair', ['#3d7d4c', '#06170c', '#a9e3a0'], 'epic', { kind: 'prestige', cls: 'marksman', tier: 3 }),
  E('e_breacher', 'Charge', 'hex', 'burst', ['#3a5f92', '#08101f', '#a9c6ff'], 'epic', { kind: 'prestige', cls: 'breacher', tier: 3 }),
  E('e_medic', 'Cross', 'circle', 'cross', ['#b13246', '#1f050b', '#ffb3bf'], 'epic', { kind: 'prestige', cls: 'medic', tier: 3 }),
  E('e_recon', 'Watcher', 'diamond', 'eye', ['#6c4ea3', '#120a26', '#d2bcff'], 'epic', { kind: 'prestige', cls: 'recon', tier: 3 }),
  E('e_engineer', 'Wrench', 'hex', 'wrench', ['#b8862b', '#1d1405', '#ffe0a0'], 'epic', { kind: 'prestige', cls: 'engineer', tier: 3 }),
  E('e_gunner', 'Belt', 'shield', 'belt', ['#7a6a55', '#14100c', '#ffd9a0'], 'epic', { kind: 'prestige', cls: 'gunner', tier: 3 }),
  E('gold_skull', 'Gold Skull', 'diamond', 'skull', ['#f3c24b', '#3a2600', '#fff6c4'], 'epic', { kind: 'gold', n: 3 }),
  E('diamond', 'Facet', 'diamond', 'gem', ['#bfe3ff', '#0a1424', '#ffffff'], 'legendary', { kind: 'diamond' }),
  E('blood', 'First Blood', 'circle', 'drop', ['#b0122b', '#16050a', '#ff8a8a'], 'rare', { kind: 'medal', medal: 'first_blood', n: 1 }),
  E('reaper', 'Reaper', 'shield', 'scythe', ['#2d3a3a', '#060909', '#d8cfb6'], 'epic', { kind: 'kills', n: 250 }),
  E('neon_fish', 'Neon Fish', 'circle', 'fish', ['#ff3fa4', '#12062a', '#7fe9ff'], 'rare', PRICE(300)),
  E('kraken', 'Kraken', 'hex', 'tentacle', ['#5a1f6b', '#08040f', '#ff7ad9'], 'epic', PRICE(700)),
  E('sun', 'High Noon', 'star', 'sun', ['#f39a1e', '#3a1804', '#fff1b8'], 'epic', PRICE(650)),
];

export const DEFAULT_CARD = 'first_tide';
export const DEFAULT_EMBLEM = 'anchor';
const cardIdx = new Map(CARDS.map((c) => [c.id, c]));
const embIdx = new Map(EMBLEMS.map((e) => [e.id, e]));
export const cardById = (id) => cardIdx.get(id) || null;
export const emblemById = (id) => embIdx.get(id) || null;

// ------------------------------------------------------------------ card art

const W = 320, H = 80;
function wavePath(y, amp, len, phase, w = W, h = H) {
  let d = `M0 ${h} L0 ${y.toFixed(1)}`;
  for (let x = 0; x <= w; x += 8) d += ` L${x} ${(y + Math.sin((x / len) * Math.PI * 2 + phase) * amp).toFixed(1)}`;
  return d + ` L${w} ${h} Z`;
}

const STYLE = {
  waves(c, r, id, anim) {
    let s = '';
    for (let i = 0; i < 5; i++) {
      const y = 34 + i * 10, op = 0.25 + i * 0.16;
      s += `<path d="${wavePath(y, 4 + i * 1.2, 70 + i * 22, r() * 6)}" fill="${i % 2 ? c[1] : c[2]}" opacity="${op.toFixed(2)}">${anim ? `<animateTransform attributeName="transform" type="translate" values="0 0;${i % 2 ? -12 : 12} 0;0 0" dur="${4 + i}s" repeatCount="indefinite"/>` : ''}</path>`;
    }
    return s;
  },
  stripes(c, r) {
    let s = '';
    for (let x = -80; x < W + 80; x += 22) s += `<path d="M${x} ${H} L${x + 40} 0 L${x + 51} 0 L${x + 11} ${H} Z" fill="${c[2]}" opacity="${(0.05 + r() * 0.1).toFixed(2)}"/>`;
    return s + `<rect y="${H - 10}" width="${W}" height="3" fill="${c[1]}" opacity=".7"/>`;
  },
  skyline(c, r) {
    let s = `<circle cx="${230 + r() * 40}" cy="30" r="16" fill="${c[2]}" opacity=".9"/><rect y="56" width="${W}" height="24" fill="${c[1]}" opacity=".25"/>`;
    let x = 0;
    while (x < W) {
      const w = 10 + r() * 26, h = 12 + r() * 38;
      s += `<rect x="${x.toFixed(1)}" y="${(60 - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#000" opacity=".55"/>`;
      if (r() > 0.6) s += `<rect x="${(x + w / 2 - 1).toFixed(1)}" y="${(60 - h - 10).toFixed(1)}" width="2" height="10" fill="#000" opacity=".55"/><circle cx="${(x + w / 2).toFixed(1)}" cy="${(60 - h - 10).toFixed(1)}" r="1.5" fill="${c[2]}"/>`;
      x += w + r() * 6;
    }
    return s + `<path d="${wavePath(64, 2, 40, 0)}" fill="${c[0]}" opacity=".85"/>`;
  },
  topo(c, r) {
    let s = '';
    for (let k = 0; k < 3; k++) {
      const cx = r() * W, cy = r() * H;
      for (let i = 1; i < 9; i++) s += `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${i * 16}" ry="${i * 9}" fill="none" stroke="${c[2]}" stroke-width=".8" opacity="${(0.42 - i * 0.04).toFixed(2)}" transform="rotate(${(r() * 30 - 15).toFixed(1)} ${cx.toFixed(1)} ${cy.toFixed(1)})"/>`;
    }
    return s;
  },
  birds(c, r) {
    let s = `<path d="${wavePath(60, 3, 90, 1)}" fill="${c[1]}" opacity=".5"/>`;
    for (let i = 0; i < 9; i++) {
      const x = 40 + r() * 260, y = 10 + r() * 38, k = 3 + r() * 5;
      s += `<path d="M${(x - k).toFixed(1)} ${y.toFixed(1)} Q${(x - k / 2).toFixed(1)} ${(y - k / 2).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)} Q${(x + k / 2).toFixed(1)} ${(y - k / 2).toFixed(1)} ${(x + k).toFixed(1)} ${y.toFixed(1)}" fill="none" stroke="${c[2]}" stroke-width="1.4" stroke-linecap="round"/>`;
    }
    return s;
  },
  hex(c, r, id, anim) {
    let s = '';
    const R = 9, hw = R * Math.sqrt(3);
    for (let row = -1; row < 7; row++) for (let col = -1; col < 22; col++) {
      const x = col * hw + (row % 2 ? hw / 2 : 0), y = row * R * 1.5;
      const o = Math.max(0, (x / W) * 0.5 - 0.05 + r() * 0.18);
      const pts = Array.from({ length: 6 }, (_, i) => { const a = Math.PI / 6 + (i * Math.PI) / 3; return `${(x + Math.cos(a) * (R - 1)).toFixed(1)},${(y + Math.sin(a) * (R - 1)).toFixed(1)}`; }).join(' ');
      s += `<polygon points="${pts}" fill="${r() > 0.86 ? c[2] : 'none'}" fill-opacity="${(o * 0.6).toFixed(2)}" stroke="${c[2]}" stroke-width=".7" opacity="${o.toFixed(2)}">${anim && r() > 0.9 ? `<animate attributeName="opacity" values="${o.toFixed(2)};1;${o.toFixed(2)}" dur="${2 + r() * 3}s" repeatCount="indefinite"/>` : ''}</polygon>`;
    }
    return s;
  },
  kelp(c, r, id, anim) {
    let s = '';
    for (let i = 0; i < 16; i++) {
      const x = r() * W, h = 30 + r() * 50, sway = 6 + r() * 10;
      s += `<path d="M${x.toFixed(1)} ${H} C${(x - sway).toFixed(1)} ${H - h * 0.4} ${(x + sway).toFixed(1)} ${H - h * 0.7} ${x.toFixed(1)} ${H - h}" fill="none" stroke="${i % 3 ? c[1] : c[2]}" stroke-width="${(2 + r() * 3).toFixed(1)}" stroke-linecap="round" opacity="${(0.4 + r() * 0.5).toFixed(2)}">${anim ? `<animateTransform attributeName="transform" type="skewX" values="0;3;0;-3;0" dur="${5 + r() * 3}s" repeatCount="indefinite"/>` : ''}</path>`;
    }
    return s;
  },
  moon(c, r) {
    let s = `<circle cx="250" cy="28" r="15" fill="${c[2]}"/><circle cx="256" cy="24" r="13" fill="${c[0]}"/>`;
    for (let i = 0; i < 40; i++) s += `<circle cx="${(r() * W).toFixed(1)}" cy="${(r() * 50).toFixed(1)}" r="${(0.4 + r() * 0.9).toFixed(2)}" fill="${c[2]}" opacity="${(0.3 + r() * 0.7).toFixed(2)}"/>`;
    s += `<rect x="70" y="18" width="10" height="44" fill="#000" opacity=".6"/><rect x="84" y="30" width="8" height="32" fill="#000" opacity=".6"/><rect x="60" y="34" width="7" height="28" fill="#000" opacity=".6"/>`;
    return s + `<path d="${wavePath(62, 2, 50, 0)}" fill="${c[1]}" opacity=".4"/><rect x="236" y="62" width="30" height="18" fill="${c[2]}" opacity=".08"/>`;
  },
  storm(c, r, id, anim) {
    let s = '';
    for (let i = 0; i < 7; i++) s += `<ellipse cx="${(r() * W).toFixed(1)}" cy="${(r() * 22).toFixed(1)}" rx="${40 + r() * 50}" ry="${10 + r() * 10}" fill="${c[1]}" opacity="${(0.25 + r() * 0.3).toFixed(2)}"/>`;
    for (let i = 0; i < 40; i++) { const x = r() * W, y = r() * H; s += `<path d="M${x.toFixed(1)} ${y.toFixed(1)} l-4 10" stroke="${c[2]}" stroke-width=".7" opacity=".35"/>`; }
    s += `<path d="M205 8 L192 38 L204 38 L190 72 L222 30 L208 30 L220 8 Z" fill="${c[2]}">${anim ? '<animate attributeName="opacity" values="1;0.1;1;0.1;0.1;1" dur="3s" repeatCount="indefinite"/>' : ''}</path>`;
    return s;
  },
  shards(c, r, id, anim) {
    let s = '';
    for (let i = 0; i < 26; i++) {
      const x = r() * W, y = r() * H, k = 10 + r() * 30;
      s += `<polygon points="${x.toFixed(1)},${y.toFixed(1)} ${(x + k).toFixed(1)},${(y + r() * k - k / 2).toFixed(1)} ${(x + r() * k).toFixed(1)},${(y + k).toFixed(1)}" fill="${r() > 0.5 ? c[2] : c[1]}" opacity="${(0.1 + r() * 0.4).toFixed(2)}"/>`;
    }
    if (anim) s += `<rect x="-60" y="-20" width="40" height="${H + 40}" fill="#fff" opacity=".25" transform="rotate(20)"><animate attributeName="x" values="-80;${W + 40};${W + 40}" keyTimes="0;.5;1" dur="3.5s" repeatCount="indefinite"/></rect>`;
    return s;
  },
  radar(c, r, id, anim) {
    let s = '';
    for (let i = 1; i < 6; i++) s += `<circle cx="250" cy="40" r="${i * 14}" fill="none" stroke="${c[2]}" stroke-width=".8" opacity=".35"/>`;
    s += `<path d="M250 40 H325 M250 -40 V120" stroke="${c[2]}" stroke-width=".6" opacity=".3"/>`;
    s += `<path d="M250 40 L320 10 A76 76 0 0 1 326 40 Z" fill="${c[2]}" opacity=".35">${anim ? '<animateTransform attributeName="transform" type="rotate" values="0 250 40;360 250 40" dur="4s" repeatCount="indefinite"/>' : ''}</path>`;
    for (let i = 0; i < 5; i++) s += `<circle cx="${(200 + r() * 100).toFixed(1)}" cy="${(10 + r() * 60).toFixed(1)}" r="2" fill="${c[2]}"/>`;
    for (let x = 0; x < 180; x += 12) s += `<path d="M${x} 0 V${H}" stroke="${c[2]}" stroke-width=".4" opacity=".12"/>`;
    return s;
  },
  sunburst(c, r) {
    let s = '';
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2, b = a + Math.PI / 48;
      s += `<polygon points="250,70 ${(250 + Math.cos(a) * 400).toFixed(1)},${(70 + Math.sin(a) * 400).toFixed(1)} ${(250 + Math.cos(b) * 400).toFixed(1)},${(70 + Math.sin(b) * 400).toFixed(1)}" fill="${c[2]}" opacity=".12"/>`;
    }
    return s + `<circle cx="250" cy="70" r="22" fill="${c[2]}"/><path d="${wavePath(68, 2.5, 60, 0)}" fill="${c[0]}"/>`;
  },
  circuit(c, r, id, anim) {
    let s = '';
    for (let i = 0; i < 18; i++) {
      let x = r() * W, y = r() * H;
      let d = `M${x.toFixed(0)} ${y.toFixed(0)}`;
      for (let k = 0; k < 4; k++) { if (r() > 0.5) x += (r() - 0.3) * 60; else y += (r() - 0.5) * 40; d += ` L${x.toFixed(0)} ${y.toFixed(0)}`; }
      s += `<path d="${d}" fill="none" stroke="${c[2]}" stroke-width="1" opacity=".4"${anim ? ` stroke-dasharray="6 140"><animate attributeName="stroke-dashoffset" values="146;0" dur="${2 + r() * 2}s" repeatCount="indefinite"/></path>` : '/>'}<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="2.2" fill="${c[2]}" opacity=".8"/>`;
    }
    return s;
  },
  vortex(c, r, id, anim) {
    let s = '';
    for (let i = 0; i < 12; i++) s += `<ellipse cx="240" cy="40" rx="${12 + i * 12}" ry="${5 + i * 5}" fill="none" stroke="${i % 2 ? c[2] : c[1]}" stroke-width="${(2.4 - i * 0.15).toFixed(2)}" opacity="${(0.8 - i * 0.05).toFixed(2)}" stroke-dasharray="${20 + i * 6} ${8 + i * 3}">${anim ? `<animateTransform attributeName="transform" type="rotate" values="0 240 40;${i % 2 ? -360 : 360} 240 40" dur="${8 + i * 2}s" repeatCount="indefinite"/>` : ''}</ellipse>`;
    return s + `<circle cx="240" cy="40" r="6" fill="${c[2]}"/>`;
  },
  laurel(c, r, id, anim) {
    let s = '';
    for (let side of [-1, 1]) for (let i = 0; i < 9; i++) {
      const a = (200 + i * 15) * Math.PI / 180;
      const x = 250 + side * Math.cos(a) * -34, y = 44 + Math.sin(a) * 30;
      s += `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="7" ry="2.8" fill="${c[2]}" opacity=".85" transform="rotate(${(side * (i * 15 + 30)).toFixed(0)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
    }
    s += `<text x="250" y="52" text-anchor="middle" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-weight="800" font-size="26" fill="${c[2]}">C</text>`;
    for (let i = 0; i < 30; i++) s += `<circle cx="${(r() * 180).toFixed(1)}" cy="${(r() * H).toFixed(1)}" r="${(0.5 + r()).toFixed(1)}" fill="${c[2]}" opacity="${(r() * 0.6).toFixed(2)}">${anim ? `<animate attributeName="opacity" values="0;.9;0" dur="${2 + r() * 3}s" begin="${(r() * 3).toFixed(1)}s" repeatCount="indefinite"/>` : ''}</circle>`;
    return s;
  },
  chevrons(c, r, id, anim) {
    let s = '';
    for (let i = 0; i < 9; i++) {
      const x = 120 + i * 24;
      s += `<path d="M${x} 10 L${x + 18} 40 L${x} 70 L${x + 9} 70 L${x + 27} 40 L${x + 9} 10 Z" fill="${c[2]}" opacity="${(0.08 + i * 0.07).toFixed(2)}">${anim ? `<animate attributeName="opacity" values="${(0.08 + i * 0.07).toFixed(2)};.9;${(0.08 + i * 0.07).toFixed(2)}" dur="1.8s" begin="${(i * 0.12).toFixed(2)}s" repeatCount="indefinite"/>` : ''}</path>`;
    }
    return s;
  },
  reticle(c, r, id, anim) {
    return `<g stroke="${c[2]}" fill="none" opacity=".75"><circle cx="250" cy="40" r="26" stroke-width="1.6"/><circle cx="250" cy="40" r="12" stroke-width="1"/><path d="M250 6 V26 M250 54 V74 M216 40 H236 M264 40 H284" stroke-width="1.6"/></g><circle cx="250" cy="40" r="2.4" fill="${c[2]}">${anim ? '<animate attributeName="r" values="2;4;2" dur="1.6s" repeatCount="indefinite"/>' : ''}</circle>`
      + Array.from({ length: 10 }, (_, i) => `<path d="M${30 + i * 16} 64 v${-6 - (i % 5 === 0 ? 6 : 0)}" stroke="${c[2]}" stroke-width="1" opacity=".4"/>`).join('');
  },
  pulse(c, r, id, anim) {
    const d = 'M0 44 H120 L130 44 L138 20 L148 68 L158 30 L166 50 L172 44 H320';
    return `<path d="${d}" fill="none" stroke="${c[1]}" stroke-width="5" opacity=".35"/><path d="${d}" fill="none" stroke="${c[2]}" stroke-width="2"${anim ? ' stroke-dasharray="80 400"><animate attributeName="stroke-dashoffset" values="480;0" dur="2.2s" repeatCount="indefinite"/></path>' : '/>'}`;
  },
  slash(c, r) {
    let s = '';
    for (let i = 0; i < 3; i++) s += `<path d="M${180 + i * 30} 80 L${240 + i * 30} 0 L${248 + i * 30} 0 L${186 + i * 30} 80 Z" fill="${c[2]}" opacity="${0.4 + i * 0.2}"/>`;
    for (let i = 0; i < 14; i++) s += `<circle cx="${(150 + r() * 160).toFixed(1)}" cy="${(r() * H).toFixed(1)}" r="${(1 + r() * 2.4).toFixed(1)}" fill="${c[1]}" opacity=".8"/>`;
    return s;
  },
  burst(c, r) {
    let s = '';
    for (let i = 0; i < 18; i++) {
      const a = r() * Math.PI * 2, l = 20 + r() * 60;
      s += `<path d="M250 40 L${(250 + Math.cos(a) * l).toFixed(1)} ${(40 + Math.sin(a) * l * 0.6).toFixed(1)}" stroke="${c[2]}" stroke-width="${(1 + r() * 2).toFixed(1)}" opacity=".6" stroke-linecap="round"/>`;
    }
    return s + `<circle cx="250" cy="40" r="14" fill="${c[2]}" opacity=".85"/><circle cx="250" cy="40" r="26" fill="${c[1]}" opacity=".35"/>`;
  },
  wings(c) {
    let s = '';
    for (let i = 0; i < 7; i++) {
      s += `<ellipse cx="${232 - i * 7}" cy="${30 + i * 5}" rx="${30 - i * 2.5}" ry="5" fill="${c[2]}" opacity="${(0.7 - i * 0.07).toFixed(2)}" transform="rotate(${-12 - i * 6} ${232 - i * 7} ${30 + i * 5})"/>`;
      s += `<ellipse cx="${268 + i * 7}" cy="${30 + i * 5}" rx="${30 - i * 2.5}" ry="5" fill="${c[2]}" opacity="${(0.7 - i * 0.07).toFixed(2)}" transform="rotate(${12 + i * 6} ${268 + i * 7} ${30 + i * 5})"/>`;
    }
    return s;
  },
  rain(c, r) {
    let s = '';
    for (let i = 0; i < 70; i++) { const x = r() * W, y = r() * H, l = 6 + r() * 14; s += `<path d="M${x.toFixed(1)} ${y.toFixed(1)} l-3 ${l.toFixed(1)}" stroke="${r() > 0.7 ? c[2] : c[1]}" stroke-width="1.2" opacity="${(0.3 + r() * 0.6).toFixed(2)}"/>`; }
    return s;
  },
  aurora(c, r, id, anim) {
    let s = '';
    for (let i = 0; i < 4; i++) {
      const y = 18 + i * 9;
      s += `<path d="M0 ${y} C80 ${y - 18} 160 ${y + 18} 320 ${y - 6} L320 ${y + 20} C160 ${y + 36} 80 ${y} 0 ${y + 18} Z" fill="${i % 2 ? c[2] : c[1]}" opacity=".28">${anim ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 ${i % 2 ? 6 : -6};0 0" dur="${5 + i}s" repeatCount="indefinite"/>` : ''}</path>`;
    }
    for (let i = 0; i < 30; i++) s += `<circle cx="${(r() * W).toFixed(1)}" cy="${(r() * 30).toFixed(1)}" r=".7" fill="#fff" opacity="${(r() * 0.8).toFixed(2)}"/>`;
    return s;
  },
  beam(c, r, id, anim) {
    return `<g>${anim ? '<animateTransform attributeName="transform" type="rotate" values="-30 250 34;30 250 34;-30 250 34" dur="6s" repeatCount="indefinite"/>' : ''}<polygon points="250,34 -40,0 -40,70" fill="${c[1]}" opacity=".25"/></g>`
      + `<rect x="244" y="34" width="12" height="40" fill="#e9e5d8"/><rect x="244" y="44" width="12" height="6" fill="${c[2]}" opacity=".6"/><rect x="242" y="28" width="16" height="8" fill="${c[1]}"/><circle cx="250" cy="32" r="4" fill="${c[2]}"/><path d="${wavePath(70, 2, 40, 0)}" fill="#000" opacity=".5"/>`;
  },
  tentacles(c, r, id, anim) {
    let s = '';
    for (let i = 0; i < 6; i++) {
      const x = 140 + i * 30;
      s += `<path d="M${x} ${H} C${x - 20} 50 ${x + 30} 30 ${x + 6} 6" fill="none" stroke="${c[1]}" stroke-width="${9 - i * 0.6}" stroke-linecap="round" opacity=".85">${anim ? `<animateTransform attributeName="transform" type="skewX" values="0;${i % 2 ? 6 : -6};0" dur="${3 + i * 0.4}s" repeatCount="indefinite"/>` : ''}</path>`;
      for (let k = 0; k < 4; k++) s += `<circle cx="${x - 4 + k * 3}" cy="${H - 10 - k * 14}" r="1.6" fill="${c[2]}" opacity=".8"/>`;
    }
    return s;
  },
};

/**
 * Calling card banner.
 * @param {string} id
 * @param {{name?:string, level?:number, emblem?:string, w?:number, animated?:boolean, title?:string, sub?:string}} o
 */
export function cardSVG(id, o = {}) {
  const c = cardById(id) || cardById(DEFAULT_CARD);
  const k = `cc${++uid}`;
  const r = rng(c.id);
  const anim = o.animated !== false && !!c.animated;
  const body = (STYLE[c.style] || STYLE.waves)(c.colors, r, k, anim);
  const w = o.w ?? 320;
  const em = o.emblem ? `<g transform="translate(8 8) scale(1)">${emblemInner(o.emblem, 64, k + 'e')}</g>` : '';
  const tx = o.emblem ? 82 : 14;
  const name = o.name ? `<text x="${tx}" y="${o.sub ? 40 : 48}" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-weight="800" font-size="26" letter-spacing="1.5" fill="#fff" style="paint-order:stroke" stroke="#000" stroke-opacity=".45" stroke-width="3">${esc(o.name)}</text>` : '';
  const sub = o.sub ? `<text x="${tx + 1}" y="60" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-weight="700" font-size="13" letter-spacing="2" fill="#fff" fill-opacity=".8">${esc(o.sub)}</text>` : '';
  const lv = o.level ? `<g transform="translate(${W - 40} 8)"><rect width="32" height="22" rx="4" fill="#000" fill-opacity=".45"/><text x="16" y="16" text-anchor="middle" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-weight="800" font-size="15" fill="#fff">${o.level}</text></g>` : '';
  return `<svg class="ccard r-${c.rarity}" viewBox="0 0 ${W} ${H}" width="${w}" height="${(w * H) / W}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${esc(o.title || c.name)}">
    <defs><linearGradient id="${k}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.colors[0]}"/><stop offset="1" stop-color="${c.colors[1]}"/></linearGradient>
    <linearGradient id="${k}v" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity=".55"/><stop offset=".55" stop-color="#000" stop-opacity="0"/></linearGradient>
    <clipPath id="${k}c"><rect width="${W}" height="${H}"/></clipPath></defs>
    <g clip-path="url(#${k}c)"><rect width="${W}" height="${H}" fill="url(#${k}g)"/>${body}${o.name || o.emblem ? `<rect width="${W}" height="${H}" fill="url(#${k}v)"/>` : ''}</g>
    ${em}${name}${sub}${lv}</svg>`;
}

// ------------------------------------------------------------------ emblem art

const SHAPES = {
  circle: (f, s) => `<circle cx="32" cy="32" r="28" fill="${f}" stroke="${s}" stroke-width="2.5"/><circle cx="32" cy="32" r="23.5" fill="none" stroke="${s}" stroke-width="1" opacity=".6"/>`,
  shield: (f, s) => `<path d="M32 4 L56 12 V30 C56 46 45 55 32 60 C19 55 8 46 8 30 V12 Z" fill="${f}" stroke="${s}" stroke-width="2.5" stroke-linejoin="round"/>`,
  hex: (f, s) => `<polygon points="32,3 57,17.5 57,46.5 32,61 7,46.5 7,17.5" fill="${f}" stroke="${s}" stroke-width="2.5" stroke-linejoin="round"/>`,
  diamond: (f, s) => `<polygon points="32,3 61,32 32,61 3,32" fill="${f}" stroke="${s}" stroke-width="2.5" stroke-linejoin="round"/>`,
  star: (f, s) => { const p = []; for (let i = 0; i < 16; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 8; const rr = i % 2 ? 22 : 30; p.push(`${(32 + Math.cos(a) * rr).toFixed(1)},${(32 + Math.sin(a) * rr).toFixed(1)}`); } return `<polygon points="${p.join(' ')}" fill="${f}" stroke="${s}" stroke-width="2.2" stroke-linejoin="round"/>`; },
};
const GLYPHS = {
  anchor: (c) => `<g fill="none" stroke="${c}" stroke-width="3.2" stroke-linecap="round"><circle cx="32" cy="17" r="4"/><path d="M32 21 V48 M23 28 H41 M18 38 C20 48 28 50 32 50 C36 50 44 48 46 38"/><path d="M15 41 L18 37 L22 40 M49 41 L46 37 L42 40"/></g>`,
  crosshair: (c) => `<g fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"><circle cx="32" cy="32" r="12"/><path d="M32 12 V22 M32 42 V52 M12 32 H22 M42 32 H52"/></g><path d="M16 40 C22 36 26 44 32 40 C38 36 42 44 48 40" fill="none" stroke="${c}" stroke-width="2.4" opacity=".75"/>`,
  wave: (c) => `<path d="M12 40 C18 26 30 22 36 30 C30 30 28 36 34 40 C40 44 48 38 52 34 C50 46 40 52 30 50 C22 49 15 46 12 40 Z" fill="${c}"/><path d="M14 48 C22 44 28 52 36 48 C44 44 48 50 52 48" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/>`,
  gull: (c) => `<path d="M10 30 Q20 20 32 32 Q44 20 54 30 Q44 26 32 38 Q20 26 10 30 Z" fill="${c}"/>`,
  compass: (c) => `<circle cx="32" cy="32" r="15" fill="none" stroke="${c}" stroke-width="2"/><path d="M32 12 L36 32 L32 52 L28 32 Z" fill="${c}"/><path d="M12 32 L32 29 L52 32 L32 35 Z" fill="${c}" opacity=".6"/>`,
  trident: (c) => `<g fill="none" stroke="${c}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M32 14 V52 M20 16 V26 C20 32 26 34 32 34 C38 34 44 32 44 26 V16"/><path d="M17 20 L20 14 L23 20 M29 18 L32 12 L35 18 M41 20 L44 14 L47 20"/></g>`,
  skull: (c) => `<path d="M32 12 C21 12 15 20 15 29 C15 35 18 38 21 40 V47 H43 V40 C46 38 49 35 49 29 C49 20 43 12 32 12 Z" fill="${c}"/><circle cx="25" cy="30" r="5" fill="#000" fill-opacity=".7"/><circle cx="39" cy="30" r="5" fill="#000" fill-opacity=".7"/><path d="M30 37 L32 34 L34 37 Z" fill="#000" fill-opacity=".7"/><path d="M26 47 V51 M32 47 V52 M38 47 V51" stroke="${c}" stroke-width="2.4"/>`,
  lighthouse: (c) => `<path d="M27 50 L29 22 H35 L37 50 Z" fill="${c}"/><rect x="26" y="16" width="12" height="6" fill="${c}"/><path d="M24 16 L32 10 L40 16 Z" fill="${c}"/><path d="M38 19 L54 13 V25 Z M26 19 L10 13 V25 Z" fill="${c}" opacity=".5"/><path d="M14 52 H50" stroke="${c}" stroke-width="2.6"/>`,
  fin: (c) => `<path d="M18 44 C26 40 32 26 30 12 C40 22 44 34 46 44 Z" fill="${c}"/><path d="M10 46 C18 42 24 50 32 46 C40 42 46 50 54 46" fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>`,
  bolt: (c) => `<path d="M36 8 L18 36 H30 L26 56 L46 26 H34 Z" fill="${c}"/>`,
  eye: (c) => `<path d="M10 32 Q32 12 54 32 Q32 52 10 32 Z" fill="none" stroke="${c}" stroke-width="3"/><circle cx="32" cy="32" r="8" fill="${c}"/><ellipse cx="32" cy="32" rx="2.2" ry="6" fill="#000" fill-opacity=".75"/>`,
  crown: (c) => `<path d="M14 44 L12 22 L22 32 L32 16 L42 32 L52 22 L50 44 Z" fill="${c}"/><rect x="14" y="46" width="36" height="5" fill="${c}"/>`,
  flame: (c) => `<path d="M32 10 C36 20 46 24 46 38 C46 47 40 54 32 54 C24 54 18 47 18 38 C18 30 24 26 26 20 C28 26 30 28 32 28 C30 22 30 16 32 10 Z" fill="${c}"/><path d="M32 34 C35 38 38 40 38 45 C38 49 35 51 32 51 C29 51 26 49 26 45 C26 41 30 39 32 34 Z" fill="#000" fill-opacity=".3"/>`,
  wing: (c) => `<g fill="${c}">${[0, 1, 2, 3, 4].map((i) => `<ellipse cx="${22 - i}" cy="${24 + i * 5}" rx="${14 - i * 1.5}" ry="3" transform="rotate(${-20 - i * 8} ${22 - i} ${24 + i * 5})"/><ellipse cx="${42 + i}" cy="${24 + i * 5}" rx="${14 - i * 1.5}" ry="3" transform="rotate(${20 + i * 8} ${42 + i} ${24 + i * 5})"/>`).join('')}<circle cx="32" cy="32" r="6"/></g>`,
  star: (c) => `<polygon points="32,12 37,27 52,27 40,36 45,51 32,42 19,51 24,36 12,27 27,27" fill="${c}"/>`,
  tide: (c) => `<g fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"><circle cx="32" cy="24" r="9"/><path d="M32 10 V16 M32 32 V38 M18 24 H24 M40 24 H46"/></g><path d="M10 42 C18 36 24 46 32 40 C40 34 46 44 54 38 V54 H10 Z" fill="${c}"/>`,
  spear: (c) => `<path d="M32 10 L42 28 L35 26 V52 H29 V26 L22 28 Z" fill="${c}"/>`,
  burst: (c) => `<polygon points="32,10 36,24 50,18 41,30 54,36 39,38 42,52 32,42 22,52 25,38 10,36 23,30 14,18 28,24" fill="${c}"/>`,
  cross: (c) => `<path d="M27 12 H37 V27 H52 V37 H37 V52 H27 V37 H12 V27 H27 Z" fill="${c}"/>`,
  wrench: (c) => `<path d="M42 12 C36 10 30 14 30 20 C30 22 31 24 31 24 L14 41 C12 43 12 46 14 48 L16 50 C18 52 21 52 23 50 L40 33 C40 33 42 34 44 34 C50 34 54 28 52 22 L46 28 L40 26 L38 20 Z" fill="${c}"/>`,
  belt: (c) => `<g fill="${c}">${[0, 1, 2, 3, 4].map((i) => `<rect x="${13 + i * 8}" y="${16 + (i % 2) * 2}" width="6" height="24" rx="3" transform="rotate(${-8 + i * 4} ${16 + i * 8} 28)"/>`).join('')}<rect x="10" y="40" width="44" height="6" rx="2"/></g>`,
  gem: (c) => `<path d="M18 24 L26 14 H38 L46 24 L32 52 Z" fill="${c}"/><path d="M18 24 H46 M26 14 L32 24 L38 14 M32 24 V52" fill="none" stroke="#000" stroke-opacity=".3" stroke-width="1.4"/>`,
  drop: (c) => `<path d="M32 10 C38 22 46 30 46 40 C46 48 40 54 32 54 C24 54 18 48 18 40 C18 30 26 22 32 10 Z" fill="${c}"/>`,
  scythe: (c) => `<path d="M20 54 L34 14" stroke="${c}" stroke-width="3.4" stroke-linecap="round"/><path d="M33 16 C42 12 52 18 54 28 C48 22 40 20 33 22 Z" fill="${c}"/>`,
  fish: (c) => `<path d="M12 32 C20 20 38 20 46 32 C38 44 20 44 12 32 Z M46 32 L56 22 V42 Z" fill="${c}"/><circle cx="20" cy="30" r="2.2" fill="#000" fill-opacity=".6"/>`,
  tentacle: (c) => `<path d="M24 54 C14 44 18 30 28 26 C38 22 44 30 38 36 C34 40 28 36 32 32" fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round"/><circle cx="40" cy="18" r="6" fill="${c}"/>`,
  sun: (c) => `<circle cx="32" cy="32" r="10" fill="${c}"/>${Array.from({ length: 12 }, (_, i) => { const a = (i / 12) * Math.PI * 2; return `<path d="M${(32 + Math.cos(a) * 15).toFixed(1)} ${(32 + Math.sin(a) * 15).toFixed(1)} L${(32 + Math.cos(a) * 22).toFixed(1)} ${(32 + Math.sin(a) * 22).toFixed(1)}" stroke="${c}" stroke-width="3" stroke-linecap="round"/>`; }).join('')}`,
};

function emblemInner(id, size, k) {
  const e = emblemById(id) || emblemById(DEFAULT_EMBLEM);
  const [f, bg, g] = e.colors;
  const shine = e.rarity === 'legendary' || e.rarity === 'epic';
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" x="0" y="0">
    <defs><linearGradient id="${k}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bg}" stop-opacity=".9"/><stop offset="1" stop-color="${bg}"/></linearGradient></defs>
    ${(SHAPES[e.shape] || SHAPES.circle)(`url(#${k}f)`, f)}
    <g>${(GLYPHS[e.glyph] || GLYPHS.anchor)(g)}</g>
    ${shine ? `<path d="M14 14 L50 14 L14 34 Z" fill="#fff" opacity=".08"/>` : ''}</svg>`;
}

export function emblemSVG(id, size = 48) {
  const e = emblemById(id) || emblemById(DEFAULT_EMBLEM);
  return `<svg class="emblem r-${e.rarity}" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${esc(e.name)}">${emblemInner(e.id, 64, `em${++uid}`)}</svg>`;
}

export const RARITY_ORDER = ['common', 'rare', 'epic', 'legendary'];
