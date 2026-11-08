// Meta progression: class prestige (XP per class, 5 tiers), Salvage currency,
// the cosmetics catalog, owned items and the equipped loadout.
// Persisted in localStorage separately from settings and career stats.
//
// The catalog lives in src/shared/cosmetics.js (Graphics). It is imported
// dynamically so the menu still works, with a built-in fallback catalog, if
// that file is missing or fails to load.

import { career } from './career.js';

const KEY = 'tidefall.meta.v1';
export const CLASS_KEYS = ['assault', 'marksman', 'breacher', 'medic', 'recon', 'engineer', 'gunner'];

// ------------------------------------------------------------------ prestige

/** Cumulative XP needed to reach each tier: Recruit, Veteran, Elite, Master, Legend. */
export const TIER_XP = [0, 1000, 3000, 7000, 15000];
export const TIER_NAMES = ['Recruit', 'Veteran', 'Elite', 'Master', 'Legend'];

export function tierOf(xp) {
  let t = 0;
  for (let i = 0; i < TIER_XP.length; i++) if (xp >= TIER_XP[i]) t = i;
  return t;
}

/** Progress of one class: tier, xp, and the fraction towards the next tier (1 at Legend). */
export function classProgress(cls) {
  const xp = Math.max(0, Math.round(data.classXp[cls] || 0));
  const tier = tierOf(xp);
  const floor = TIER_XP[tier];
  const next = TIER_XP[tier + 1] ?? null;
  const frac = next === null ? 1 : (xp - floor) / (next - floor);
  return { cls, xp, tier, name: TIER_NAMES[tier], floor, next, frac, toNext: next === null ? 0 : next - xp, stats: data.classStats[cls] || { matches: 0, kills: 0, wins: 0 } };
}

// ------------------------------------------------------------------ catalog

export const RARITY = ['common', 'rare', 'epic', 'legendary'];
const RARITY_PRICE = { common: 150, rare: 450, epic: 1100, legendary: 2500 };

// Used only when src/shared/cosmetics.js can't be loaded. Ids follow the spec's examples.
const FALLBACK_CATALOG = {
  skins: [
    { id: 'default', name: 'Standard Issue', rarity: 'common', price: 0, classes: 'all', desc: 'Drowned Coast regulation kit.' },
    { id: 'driftwood', name: 'Driftwood', rarity: 'common', price: 150, classes: 'all', desc: 'Sun-bleached canvas and salt-crusted straps.' },
    { id: 'harbor_rust', name: 'Harbor Rust', rarity: 'common', price: 180, classes: 'all', desc: 'Oxide-red plates scavenged from the docks.' },
    { id: 'kelp_camo', name: 'Kelp Camo', rarity: 'rare', price: 450, classes: 'all', desc: 'Mottled green weave for the shallows.' },
    { id: 'night_ops', name: 'Night Ops', rarity: 'rare', price: 500, classes: 'all', desc: 'Matte black with low-glow trim.' },
    { id: 'deep_diver', name: 'Deep Diver', rarity: 'epic', price: 1100, classes: 'all', desc: 'Brass-ringed pressure suit.' },
    { id: 'storm_chaser', name: 'Storm Chaser', rarity: 'epic', price: 1200, classes: 'all', desc: 'Slicker plates streaked with lightning.' },
    { id: 'abyssal', name: 'Abyssal', rarity: 'legendary', price: 2500, classes: 'all', desc: 'Bioluminescent plating from the trench.' },
  ],
  killFx: [
    { id: 'default', name: 'None', rarity: 'common', price: 0, desc: 'A clean finish.' },
    { id: 'tidal_splash', name: 'Tidal Splash', rarity: 'common', price: 200, desc: 'A burst of seawater.' },
    { id: 'kelp_bloom', name: 'Kelp Bloom', rarity: 'rare', price: 450, desc: 'Fronds unfurl from the fallen.' },
    { id: 'ember_burst', name: 'Ember Burst', rarity: 'rare', price: 500, desc: 'A shower of sparks and ash.' },
    { id: 'salvage_coins', name: 'Salvage Coins', rarity: 'epic', price: 1100, desc: 'Gold scrap rains from the sky.' },
    { id: 'lightning_strike', name: 'Lightning Strike', rarity: 'legendary', price: 2400, desc: 'The storm answers.' },
  ],
  dropIns: [
    { id: 'default', name: 'Hot Drop', rarity: 'common', price: 0, desc: 'Straight down, boots first.' },
    { id: 'parachute', name: 'Parachute', rarity: 'common', price: 200, desc: 'A canopy over the archipelago.' },
    { id: 'gull_flock', name: 'Gull Flock', rarity: 'rare', price: 450, desc: 'Arrive in a storm of wings.' },
    { id: 'boat_landing', name: 'Beach Landing', rarity: 'rare', price: 500, desc: 'A skiff runs up the shingle.' },
    { id: 'sea_breach', name: 'Sea Breach', rarity: 'epic', price: 1100, desc: 'Burst up through the surface.' },
    { id: 'orbital_beacon', name: 'Orbital Beacon', rarity: 'legendary', price: 2500, desc: 'A column of light from above.' },
  ],
};

let catalogSource = 'fallback';
let RAW_BUNDLES = null;
export let RARITY_INFO = null;
let RAW = FALLBACK_CATALOG;
export let DEFAULT_LOADOUT = { skin: 'default', killFx: 'default', dropIn: 'default' };
try {
  const mod = await import('../../shared/cosmetics.js');
  const C = mod.COSMETICS;
  if (C && Array.isArray(C.skins) && Array.isArray(C.killFx) && Array.isArray(C.dropIns)) { RAW = C; catalogSource = 'shared'; }
  if (mod.DEFAULT_LOADOUT && typeof mod.DEFAULT_LOADOUT === 'object') DEFAULT_LOADOUT = { ...DEFAULT_LOADOUT, ...mod.DEFAULT_LOADOUT };
  if (Array.isArray(mod.BUNDLES)) RAW_BUNDLES = mod.BUNDLES;
  if (mod.RARITY && typeof mod.RARITY === 'object') RARITY_INFO = mod.RARITY;
} catch (e) { console.warn('[tidefall] cosmetics catalog unavailable, using the built-in list', e?.message || e); }

// Slots: the three 3.0 slots always exist; any other array category in the
// 5.0 catalog (emotes, charms, tracers, streak skins...) becomes a slot too.
const KNOWN_SLOTS = [
  { cat: 'skins', key: 'skin', name: 'Skins', one: 'Skin', icon: 'user' },
  { cat: 'killFx', key: 'killFx', name: 'Kill FX', one: 'Kill effect', icon: 'burst' },
  { cat: 'dropIns', key: 'dropIn', name: 'Drop-ins', one: 'Drop-in', icon: 'drop' },
  { cat: 'emotes', key: 'emote', name: 'Emotes', one: 'Victory emote', icon: 'trophy' },
  { cat: 'charms', key: 'charm', name: 'Charms', one: 'Weapon charm', icon: 'charm' },
  { cat: 'tracers', key: 'tracer', name: 'Tracers', one: 'Tracer', icon: 'tracer' },
  { cat: 'streakSkins', key: 'streakSkin', name: 'Streak skins', one: 'Streak skin', icon: 'jet' },
];
const NOT_SLOTS = new Set(['bundles', 'camos', 'featured', 'rarities']);
export const SLOTS = (() => {
  const out = [];
  for (const s of KNOWN_SLOTS) if (Array.isArray(RAW[s.cat]) || s.cat === 'skins' || s.cat === 'killFx' || s.cat === 'dropIns') out.push(s);
  for (const [cat, list] of Object.entries(RAW)) {
    if (NOT_SLOTS.has(cat) || out.some((s) => s.cat === cat) || !Array.isArray(list) || !list.some((i) => i && typeof i.id === 'string')) continue;
    const key = cat.replace(/s$/, '');
    const nice = cat.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
    out.push({ cat, key, name: nice, one: nice.replace(/s$/, ''), icon: 'sparkle' });
  }
  return out;
})();
for (const s of SLOTS) if (!(s.key in DEFAULT_LOADOUT)) DEFAULT_LOADOUT[s.key] = 'default';

function normalise(list, slot) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    if (!raw || typeof raw.id !== 'string' || seen.has(raw.id)) continue;
    seen.add(raw.id);
    const rarity = RARITY.includes(raw.rarity) ? raw.rarity : 'common';
    const isDefault = raw.id === DEFAULT_LOADOUT[slot.key] || raw.id === 'default';
    out.push({
      ...raw,
      slot: slot.key, cat: slot.cat, rarity,
      name: String(raw.name || raw.id),
      desc: String(raw.desc || ''),
      price: isDefault ? 0 : Math.max(0, Math.round(Number(raw.price) || RARITY_PRICE[rarity])),
      classes: raw.classes === undefined ? 'all' : raw.classes,
      isDefault,
    });
  }
  // A free default always exists, first.
  if (!out.some((i) => i.isDefault)) out.unshift({ id: DEFAULT_LOADOUT[slot.key], name: 'Standard', rarity: 'common', price: 0, classes: 'all', desc: '', slot: slot.key, cat: slot.cat, isDefault: true });
  out.sort((a, b) => (b.isDefault - a.isDefault) || RARITY.indexOf(a.rarity) - RARITY.indexOf(b.rarity) || a.price - b.price);
  return out;
}

const CATALOG = {};
for (const s of SLOTS) CATALOG[s.key] = normalise(RAW[s.cat], s);

// Bundles: [{ id, name, price?, rarity?, items: ['cat:id' | {cat|slot, id} | {slot: id...}] }]
const slotOf = (k) => SLOTS.find((s) => s.key === k || s.cat === k)?.key || null;
export const BUNDLES = (RAW_BUNDLES || (Array.isArray(RAW.bundles) ? RAW.bundles : [])).map((b) => {
  if (!b || typeof b.id !== 'string') return null;
  let items = [];
  const push = (sk, id) => { const k = slotOf(sk); if (k && CATALOG[k].some((i) => i.id === id && !i.isDefault)) items.push({ slot: k, id }); };
  if (Array.isArray(b.items)) for (const it of b.items) {
    if (typeof it === 'string' && it.includes(':')) push(...it.split(':'));
    else if (it && typeof it === 'object') push(it.slot || it.cat || it.kind, it.id);
  } else if (b.items && typeof b.items === 'object') for (const [k, v] of Object.entries(b.items)) (Array.isArray(v) ? v : [v]).forEach((id) => push(k, id));
  if (!items.length) return null;
  const full = items.reduce((a, it) => a + (CATALOG[it.slot].find((i) => i.id === it.id)?.price || 0), 0);
  const rarity = RARITY.includes(b.rarity) ? b.rarity : 'epic';
  return { ...b, items, rarity, name: String(b.name || b.id), desc: String(b.desc || ''), full: Number(b.fullPrice) || full, price: Math.max(1, Math.round(Number(b.price) || full * 0.7)) };
}).filter(Boolean);
export function buyBundle(id) {
  const b = BUNDLES.find((x) => x.id === id);
  if (!b) return { ok: false, error: 'Bundle not found' };
  const missing = b.items.filter((it) => !owns(it.slot, it.id));
  if (!missing.length) return { ok: false, error: 'You already own everything in it' };
  const price = bundlePrice(b);
  if (data.salvage < price) return { ok: false, error: `You need ${price - data.salvage} more Salvage` };
  data.salvage -= price;
  for (const it of missing) data.owned[it.slot].push(it.id);
  changed('buy');
  return { ok: true, price };
}
/** Bundles get cheaper by the value of the parts you already own. */
export function bundlePrice(b) {
  const ownedVal = b.items.filter((it) => owns(it.slot, it.id)).reduce((a, it) => a + (itemById(it.slot, it.id)?.price || 0), 0);
  return Math.max(0, Math.round(((b.price) * (1 - ownedVal / Math.max(1, b.full))) / 10) * 10);
}
export const catalog = () => CATALOG;
export const catalogInfo = () => ({ source: catalogSource });
export const itemById = (slotKey, id) => CATALOG[slotKey]?.find((i) => i.id === id) || null;
export const fitsClass = (item, cls) => !item || item.classes === 'all' || !Array.isArray(item.classes) || item.classes.includes(cls);

// ------------------------------------------------------------------ persistence

const EMPTY = () => ({
  v: 1,
  salvage: 0,
  earned: 0,          // lifetime Salvage earned
  classXp: {},        // cls -> xp
  classStats: {},     // cls -> { matches, kills, wins }
  owned: Object.fromEntries(SLOTS.map((sl) => [sl.key, []])),
  loadout: { skins: {} }, // skins per class; every other slot is global (slotKey -> id)
  seen: [],           // item keys the player has looked at (for "new" dots)
  migrated: false,
  welcomed: false,
  notice: null,       // one-off message for the menu to show
});

const num = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };

/** Validate any object into a meta record (also used by the transfer import). */
export function sanitizeMeta(saved) {
  const base = EMPTY();
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return base;
  for (const k of Object.keys(base)) {
    if (saved[k] === undefined || saved[k] === null) continue;
    if (typeof saved[k] === typeof base[k] || base[k] === null) base[k] = saved[k];
  }
  if (!base.loadout || typeof base.loadout !== 'object' || Array.isArray(base.loadout)) base.loadout = EMPTY().loadout;
  if (!base.loadout.skins || typeof base.loadout.skins !== 'object') base.loadout.skins = {};
  for (const [k, v] of Object.entries(base.loadout)) if (k !== 'skins' && typeof v !== 'string') delete base.loadout[k];
  if (!Array.isArray(base.seen)) base.seen = [];
  base.seen = base.seen.filter((x) => typeof x === 'string').slice(-400);
  if (!base.owned || typeof base.owned !== 'object' || Array.isArray(base.owned)) base.owned = EMPTY().owned;
  for (const sl of SLOTS) base.owned[sl.key] = Array.isArray(base.owned[sl.key]) ? base.owned[sl.key].filter((id) => typeof id === 'string') : [];
  // Garbage-proof the per-class maps: finite, non-negative numbers only.
  const xp = {}, cs = {};
  if (base.classXp && typeof base.classXp === 'object') for (const k of CLASS_KEYS) { const v = Number(base.classXp[k]); if (Number.isFinite(v) && v > 0) xp[k] = Math.min(v, 1e8); }
  if (base.classStats && typeof base.classStats === 'object') for (const k of CLASS_KEYS) {
    const r = base.classStats[k];
    if (r && typeof r === 'object') cs[k] = { matches: num(r.matches), kills: num(r.kills), wins: num(r.wins) };
  }
  base.classXp = xp; base.classStats = cs;
  base.salvage = Math.min(num(base.salvage), 1e9);
  base.earned = Math.min(num(base.earned), 1e10);
  base.migrated = !!base.migrated; base.welcomed = !!base.welcomed;
  if (base.notice && (typeof base.notice !== 'object' || typeof base.notice.kind !== 'string')) base.notice = null;
  return base;
}

let data = EMPTY();
try {
  const raw = localStorage.getItem(KEY);
  if (raw) data = sanitizeMeta(JSON.parse(raw));
} catch { /* private mode, corrupt JSON etc. */ data = EMPTY(); }

function save() { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* ignore */ } }

const listeners = new Set();
export function onMetaChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed(what) { save(); for (const fn of listeners) { try { fn(what); } catch (e) { console.warn(e); } } }

// ---- migration from 2.x career stats (once)
const WELCOME_SALVAGE = 300;
if (!data.migrated) {
  data.migrated = true;
  const c = career();
  if (c.matches > 0) {
    // Back-pay for veterans: Salvage and prestige XP from the old career totals.
    const salvage = Math.min(4000, num(c.matches) * 60 + num(c.kills) * 20 + num(c.wins) * 150);
    const xp = Math.min(60000, num(c.matches) * 220 + num(c.kills) * 75 + num(c.wins) * 150 + num(c.revives) * 60);
    const last = CLASS_KEYS.includes(c.last?.cls) ? c.last.cls : null;
    const share = Math.round((last ? xp * 0.4 : xp) / CLASS_KEYS.length);
    for (const k of CLASS_KEYS) data.classXp[k] = (data.classXp[k] || 0) + share;
    if (last) data.classXp[last] += Math.round(xp * 0.6);
    data.salvage += salvage + WELCOME_SALVAGE;
    data.earned += salvage + WELCOME_SALVAGE;
    data.welcomed = true;
    data.notice = { kind: 'migrated', salvage: salvage + WELCOME_SALVAGE, xp, cls: last };
  }
  save();
}
if (!data.welcomed) {
  data.welcomed = true;
  data.salvage += WELCOME_SALVAGE;
  data.earned += WELCOME_SALVAGE;
  data.notice = { kind: 'welcome', salvage: WELCOME_SALVAGE };
  save();
}

export const meta = () => data;
export const salvage = () => data.salvage;
export function takeNotice() { const n = data.notice; if (n) { data.notice = null; save(); } return n; }

// ------------------------------------------------------------------ match rewards

/**
 * Award XP to the class played and Salvage to the wallet. Called once per match.
 * Returns the breakdown for the end screen.
 */
export function awardMatch({ cls, place, total, kills = 0, damage = 0, revives = 0 }) {
  const key = CLASS_KEYS.includes(cls) ? cls : (cls || 'assault');
  const won = place === 1;
  const span = Math.max(1, (total || 2) - 1);
  const placeFrac = Math.max(0, Math.min(1, ((total || 1) - (place || total || 1)) / span));
  const xpParts = [
    ['Match played', 100],
    [`Placement #${place}`, Math.round(250 * placeFrac)],
    won && ['Victory', 150],
    kills > 0 && [`${kills} kill${kills === 1 ? '' : 's'}`, kills * 75],
    damage > 0 && [`${damage} damage`, damage * 5],
    revives > 0 && [`${revives} revive${revives === 1 ? '' : 's'}`, revives * 60],
  ].filter(Boolean).filter((p) => p[1] > 0);
  const salvParts = [
    ['Match played', 40],
    [`Placement #${place}`, Math.round(160 * placeFrac)],
    kills > 0 && [`${kills} kill${kills === 1 ? '' : 's'}`, kills * 30],
    won && ['Victory', 200],
  ].filter(Boolean).filter((p) => p[1] > 0);
  const xp = xpParts.reduce((a, p) => a + p[1], 0);
  const sv = salvParts.reduce((a, p) => a + p[1], 0);

  const before = classProgress(key);
  data.classXp[key] = (data.classXp[key] || 0) + xp;
  const st = data.classStats[key] || (data.classStats[key] = { matches: 0, kills: 0, wins: 0 });
  st.matches++; st.kills += kills; if (won) st.wins++;
  data.salvage += sv;
  data.earned += sv;
  const after = classProgress(key);
  changed('award');
  return {
    cls: key,
    xp: { total: xp, parts: xpParts },
    salvage: { total: sv, parts: salvParts, balance: data.salvage },
    before, after,
    tierUp: after.tier > before.tier,
  };
}

// ------------------------------------------------------------------ shop

const DAY = 86400000;
function dayHash(n) { let h = (n * 2654435761) >>> 0; h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13; return h >>> 0; }

/** Today's featured items (one per slot, rotating daily) at 20% off. */
export function featured(now = Date.now()) {
  const day = Math.floor(now / DAY);
  const out = [];
  SLOTS.forEach((s, i) => {
    const pool = CATALOG[s.key].filter((it) => !it.isDefault);
    if (!pool.length) return;
    // Prefer something the player doesn't own yet.
    const fresh = pool.filter((it) => !owns(s.key, it.id));
    const list = fresh.length ? fresh : pool;
    out.push(list[dayHash(day * 7 + i * 131) % list.length]);
  });
  // The rarest one leads the row.
  out.sort((a, b) => RARITY.indexOf(b.rarity) - RARITY.indexOf(a.rarity));
  return out;
}
export const FEATURED_DISCOUNT = 0.2;
export function isFeatured(item) { return !!item && featured().some((f) => f.slot === item.slot && f.id === item.id); }
export function priceOf(item) {
  if (!item || item.isDefault) return 0;
  return isFeatured(item) ? Math.round((item.price * (1 - FEATURED_DISCOUNT)) / 10) * 10 : item.price;
}
export function msToReset(now = Date.now()) { return DAY - (now % DAY); }

export function owns(slotKey, id) {
  const it = itemById(slotKey, id);
  if (it?.isDefault) return true;
  return data.owned[slotKey]?.includes(id) || false;
}

export function buy(slotKey, id) {
  const it = itemById(slotKey, id);
  if (!it) return { ok: false, error: 'That item is not in the catalog' };
  if (owns(slotKey, id)) return { ok: false, error: 'You already own this' };
  const price = priceOf(it);
  if (data.salvage < price) return { ok: false, error: `You need ${price - data.salvage} more Salvage` };
  data.salvage -= price;
  data.owned[slotKey].push(id);
  changed('buy');
  return { ok: true, price, balance: data.salvage };
}

export function markSeen(slotKey, id) {
  const k = `${slotKey}:${id}`;
  if (data.seen.includes(k)) return;
  data.seen.push(k);
  if (data.seen.length > 400) data.seen.splice(0, data.seen.length - 400);
  save();
}
export const isNew = (slotKey, id) => !data.seen.includes(`${slotKey}:${id}`);

// ------------------------------------------------------------------ loadout

export function equipped(slotKey, cls) {
  if (slotKey === 'skin') {
    const id = data.loadout.skins[cls];
    const it = id && itemById('skin', id);
    return it && owns('skin', id) && fitsClass(it, cls) ? id : DEFAULT_LOADOUT.skin;
  }
  const id = data.loadout[slotKey];
  return id && itemById(slotKey, id) && owns(slotKey, id) ? id : DEFAULT_LOADOUT[slotKey];
}

export function equip(slotKey, id, cls) {
  const it = itemById(slotKey, id);
  if (!it || !owns(slotKey, id)) return { ok: false, error: 'Buy it in the Shop first' };
  if (slotKey === 'skin') {
    if (!fitsClass(it, cls)) return { ok: false, error: 'That skin does not fit this class' };
    data.loadout.skins[cls] = id;
  } else data.loadout[slotKey] = id;
  changed('equip');
  return { ok: true };
}

/** The resolved loadout for a class, in the renderer's shape. */
export function loadoutFor(cls) {
  const out = {};
  for (const sl of SLOTS) out[sl.key] = equipped(sl.key, cls);
  return out;
}

export function spend(n) {
  n = Math.max(0, Math.round(n));
  if (data.salvage < n) return { ok: false, error: `You need ${n - data.salvage} more Salvage` };
  data.salvage -= n; changed('spend');
  return { ok: true, balance: data.salvage };
}
export function grantSalvage(n) { n = num(n); data.salvage += n; data.earned += n; changed('grant'); return data.salvage; }
export function replaceAll(d) { data = sanitizeMeta(d); data.migrated = true; data.welcomed = true; save(); changed('import'); }

export function ownedCount() {
  let n = 0, all = 0;
  for (const s of SLOTS) for (const it of CATALOG[s.key]) { if (it.isDefault) continue; all++; if (owns(s.key, it.id)) n++; }
  return { n, all };
}

/** Debug only. */
export function _debugGrant(n = 5000) { data.salvage += n; changed('grant'); return data.salvage; }
export function _debugXp(cls, n) { data.classXp[cls] = (data.classXp[cls] || 0) + n; changed('xp'); return classProgress(cls); }
export function resetMeta() { data = EMPTY(); data.migrated = true; data.welcomed = true; changed('reset'); }
