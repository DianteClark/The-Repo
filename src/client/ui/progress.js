// 5.0 progression: player level 1–100, weapon levels 1–20, camo challenges
// (Gold → Diamond → Tidal), daily challenges, medals, calling cards and
// emblems, and the five Create-a-Class loadouts.
//
// Stored under its own key next to the 3.x stores (settings, career, meta),
// which stay where they are so older saves keep working. Every field is
// validated on load: a corrupt or hand-edited save degrades to defaults
// instead of breaking the menu.

import { career } from './career.js';
import * as A from './arsenal.js';
import * as M from './meta.js';
import { CARDS, EMBLEMS, cardById, emblemById, DEFAULT_CARD, DEFAULT_EMBLEM } from '../../shared/cards.js';

const KEY = 'tidefall.v5';
export const MAX_LEVEL = 100;
export const LOADOUT_SLOTS = 5;

// ------------------------------------------------------------------ curves

/** XP to go from level n to n+1. */
export const levelNeed = (n) => 500 + 45 * n;
const LEVEL_FLOOR = [0, 0];
for (let n = 1; n < MAX_LEVEL; n++) LEVEL_FLOOR[n + 1] = LEVEL_FLOOR[n] + levelNeed(n);
export function levelInfo(xp) {
  xp = Math.max(0, Math.floor(xp || 0));
  let lv = 1;
  while (lv < MAX_LEVEL && xp >= LEVEL_FLOOR[lv + 1]) lv++;
  const floor = LEVEL_FLOOR[lv];
  const next = lv < MAX_LEVEL ? LEVEL_FLOOR[lv + 1] : null;
  return { level: lv, xp, floor, next, frac: next === null ? 1 : (xp - floor) / (next - floor), toNext: next === null ? 0 : next - xp };
}

export const weaponNeed = (n) => (typeof A.SIM.weaponXpForLevel === 'function' ? A.SIM.weaponXpForLevel(n) : 400 + 150 * (n - 1));
export const WEAPON_XP = A.SIM.WEAPON_XP || { kill: 100, hit: 25, shot: 10, win: 150 };
const WFLOOR = [0, 0];
for (let n = 1; n < A.MAX_WEAPON_LEVEL; n++) WFLOOR[n + 1] = WFLOOR[n] + weaponNeed(n);
export function weaponLevelInfo(xp) {
  xp = Math.max(0, Math.floor(xp || 0));
  let lv = 1;
  while (lv < A.MAX_WEAPON_LEVEL && xp >= WFLOOR[lv + 1]) lv++;
  const next = lv < A.MAX_WEAPON_LEVEL ? WFLOOR[lv + 1] : null;
  return { level: lv, xp, floor: WFLOOR[lv], next, frac: next === null ? 1 : (xp - WFLOOR[lv]) / (next - WFLOOR[lv]), toNext: next === null ? 0 : next - xp };
}

// ------------------------------------------------------------------ camos

// Camo art and ids come from the shared catalog (Graphics renders by id);
// the challenge stats follow the sim's definitions (src/sim/weapons.js).
let GFX_CAMOS = [];
try { const cm = await import('../../shared/cosmetics.js'); GFX_CAMOS = Array.isArray(cm.CAMOS) ? cm.CAMOS : Array.isArray(cm.COSMETICS?.camos) ? cm.COSMETICS.camos : []; } catch { /* fallback names */ }
const FB_CAMOS = [
  { id: 'woodland', name: 'Woodland', swatch: ['#4a5a32', '#2a2a1a', '#7a6a42'] },
  { id: 'desert', name: 'Dune', swatch: ['#c8a873', '#8a6d44'] },
  { id: 'urban', name: 'Concrete', swatch: ['#8f969a', '#3e4448'] },
  { id: 'kelp', name: 'Kelp Bed', swatch: ['#2d5a33', '#86a35c'] },
  { id: 'digital', name: 'Pixel Surf', swatch: ['#5a7a8a', '#2a3a4a', '#a8c0c8'] },
  { id: 'tiger', name: 'Tiger', swatch: ['#e0a040', '#1a1a1a'] },
  { id: 'splinter', name: 'Splinter', swatch: ['#7a8a6a', '#3a4a3a', '#b0b89a'] },
  { id: 'arctic', name: 'Floe', swatch: ['#e6ebee', '#8c99a3'] },
  { id: 'reef', name: 'Reef', swatch: ['#f08a7e', '#2f8f8a'] },
  { id: 'dazzle', name: 'Dazzle', swatch: ['#f2f2ee', '#1b1d22'] },
  { id: 'hex', name: 'Hexcore', swatch: ['#2c3034', '#5d666c'] },
  { id: 'topo', name: 'Bathymetry', swatch: ['#2a4a5a', '#7ac0c8'] },
  { id: 'magma', name: 'Magma', swatch: ['#1a1412', '#ff6a1a'] },
];
const MASTERY_FB = { gold: { id: 'gold', name: 'Gold', swatch: ['#ffe08a', '#b8862a'] }, diamond: { id: 'diamond', name: 'Diamond', swatch: ['#f4fbff', '#9ad8ff', '#ff9ae0'] }, tidal: { id: 'tidal', name: 'Tidal', swatch: ['#0a3a5a', '#2ad0e0', '#e8fbff'], animated: true } };
const pickMastery = (k) => ({ ...MASTERY_FB[k], ...(GFX_CAMOS.find((c) => c.id === k || c.tier === k) || {}) });
export const MASTERY = { gold: pickMastery('gold'), diamond: pickMastery('diamond'), tidal: pickMastery('tidal') };
// Challenge camos (the sim's CAMO_CHALLENGES, GFX set 'challenge') gate Gold.
// Bonus camos (GFX set 'bonus') get extra, optional challenges.
const SIM_CH = Array.isArray(A.SIM.CAMO_CHALLENGES) && A.SIM.CAMO_CHALLENGES.length ? A.SIM.CAMO_CHALLENGES : null;
const art = (id, i) => GFX_CAMOS.find((c) => c.id === id) || FB_CAMOS[i % FB_CAMOS.length];
const colorsOf = (c) => c.swatch || c.colors || ['#55716f', '#1b2a2a'];
const BONUS_TABLE = [
  ['longodds', 5, '5 kills on shots of 50% or less'], ['coverKills', 8, '8 kills on targets in cover'], ['top5', 5, '5 top-5 finishes'],
  ['dmg', 300, 'Deal 300 damage'], ['kills', 75, '75 kills'], ['headshots', 20, '20 headshots'], ['flanks', 15, '15 flanking kills'],
  ['longshots', 15, '15 longshot kills'], ['multis', 6, '6 multi-kill turns'], ['wins', 5, 'Win 5 matches'], ['closes', 15, '15 kills within 3 tiles'],
  ['dmg', 800, 'Deal 800 damage'], ['kills', 100, '100 kills'], ['top5', 15, '15 top-5 finishes'],
];
let core;
if (SIM_CH) core = SIM_CH.map((c, i) => { const a2 = art(c.id, i); return { key: c.id, stat: c.stat, n: c.count ?? c.n ?? 10, label: c.desc || '', camo: { ...a2, id: c.id, name: c.name || a2.name, colors: colorsOf(a2) } }; });
else {
  const std = GFX_CAMOS.filter((c) => c.tier === 'standard' && c.set !== 'bonus');
  const list = std.length ? std : FB_CAMOS;
  const T = [['kills', 10, '10 kills'], ['kills', 25, '25 kills'], ['headshots', 10, '10 headshots'], ['flanks', 5, '5 flanking kills'], ['longshots', 5, '5 longshot kills'], ['closes', 5, '5 kills within 3 tiles'], ['multis', 3, '3 multi-kill turns'], ['kills', 50, '50 kills'], ['wins', 3, 'Win 3 matches']];
  core = list.slice(0, T.length).map((c, i) => ({ key: c.id, stat: T[i][0], n: T[i][1], label: T[i][2], camo: { ...c, colors: colorsOf(c) } }));
}
const bonus = GFX_CAMOS.filter((c) => c.set === 'bonus').slice(0, BONUS_TABLE.length)
  .map((c, i) => ({ key: c.id, stat: BONUS_TABLE[i][0], n: BONUS_TABLE[i][1], label: BONUS_TABLE[i][2], bonus: true, camo: { ...c, colors: colorsOf(c) } }));
export const CAMO_CHALLENGES = [...core, ...bonus];
for (const k of Object.keys(MASTERY)) MASTERY[k].colors = MASTERY[k].swatch || MASTERY[k].colors;
export const camoById = (id) => CAMO_CHALLENGES.find((c) => c.camo.id === id)?.camo || Object.values(MASTERY).find((c) => c.id === id) || null;
export const GOLDS_FOR_DIAMOND = 5;

// ------------------------------------------------------------------ daily challenges

export const DAILY_POOL = [
  { key: 'd_kills', stat: 'kills', n: 6, label: 'Get 6 kills', xp: 1500, salvage: 120 },
  { key: 'd_dmg', stat: 'dmg', n: 60, label: 'Deal 60 damage', xp: 1200, salvage: 100 },
  { key: 'd_top5', stat: 'top5', n: 2, label: 'Finish top 5 twice', xp: 1500, salvage: 150 },
  { key: 'd_matches', stat: 'matches', n: 3, label: 'Play 3 matches', xp: 1000, salvage: 90 },
  { key: 'd_medals', stat: 'medals', n: 8, label: 'Earn 8 medals', xp: 1400, salvage: 120 },
  { key: 'd_flank', stat: 'flanks', n: 3, label: 'Get 3 flanking kills', xp: 1300, salvage: 110 },
  { key: 'd_long', stat: 'longshots', n: 2, label: 'Get 2 Longshot kills', xp: 1300, salvage: 110 },
  { key: 'd_streaks', stat: 'streaks', n: 2, label: 'Call in 2 killstreaks', xp: 1600, salvage: 140 },
  { key: 'd_revive', stat: 'revives', n: 2, label: 'Revive 2 squadmates', xp: 1200, salvage: 110 },
  { key: 'd_win', stat: 'wins', n: 1, label: 'Win a match', xp: 2500, salvage: 250 },
  { key: 'd_lethal', stat: 'lethalKills', n: 2, label: '2 kills with lethal equipment', xp: 1400, salvage: 120 },
  { key: 'd_rounds', stat: 'rounds', n: 25, label: 'Survive 25 rounds', xp: 1100, salvage: 100 },
];
const DAY = 86400000;
const dayNow = () => Math.floor(Date.now() / DAY);
function dayPick(day) {
  let h = (day * 2654435761) >>> 0;
  const pool = [...DAILY_POOL];
  const out = [];
  while (out.length < 3 && pool.length) {
    h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
    out.push(pool.splice(h % pool.length, 1)[0]);
  }
  return out;
}
export const msToDailyReset = () => DAY - (Date.now() % DAY);

// ------------------------------------------------------------------ medals

export const MEDALS = {
  first_blood: { name: 'First Blood', xp: 200, desc: 'First kill of the match', tier: 3 },
  double_kill: { name: 'Double Kill', xp: 150, desc: 'Two kills in one turn', tier: 2 },
  triple_kill: { name: 'Triple Kill', xp: 300, desc: 'Three kills in one turn', tier: 3 },
  collateral: { name: 'Collateral', xp: 200, desc: 'Two kills with one action', tier: 3 },
  longshot: { name: 'Longshot', xp: 100, desc: 'Kill from 10+ tiles', tier: 2 },
  point_blank: { name: 'Point Blank', xp: 75, desc: 'Kill from right next to them', tier: 1 },
  revenge: { name: 'Revenge', xp: 100, desc: 'Kill the soldier who hit your squad', tier: 2 },
  clutch: { name: 'Clutch', xp: 250, desc: 'Kill as your squad\'s last soldier, on 3 HP or less', tier: 3 },
  flanker: { name: 'Flanker', xp: 75, desc: 'Kill a flanked target', tier: 1 },
  long_odds: { name: 'Long Odds', xp: 125, desc: 'Kill with a shot of 40% or less', tier: 2 },
  executioner: { name: 'Executioner', xp: 50, desc: 'Finish a downed enemy', tier: 1 },
  demolition: { name: 'Demolition', xp: 100, desc: 'Kill with an explosive', tier: 1 },
  savior: { name: 'Savior', xp: 100, desc: 'Revive a squadmate', tier: 1 },
  bloodthirsty: { name: 'Bloodthirsty', xp: 300, desc: 'Five kills in one match', tier: 3 },
  streak_called: { name: 'Air Support', xp: 75, desc: 'Call in a killstreak', tier: 1 },
  survivor: { name: 'Survivor', xp: 150, desc: 'Win on 3 HP or less', tier: 2 },
  champion: { name: 'Last Squad Standing', xp: 500, desc: 'Win the match', tier: 4 },
  comeback: { name: 'Second Chance', xp: 200, desc: 'Win your duel in the Pit and redeploy', tier: 3 },
};

// ------------------------------------------------------------------ storage

const LOADOUT_DEFAULT_CLASSES = ['assault', 'marksman', 'breacher', 'medic', 'recon'];
const EMPTY = () => ({
  v: 5,
  xp: 0,
  weapons: {},            // id -> { xp, kills, longshots, flanks, longodds, dmg, multis, top3, matches }
  camoSel: {},            // weapon id -> camo id
  daily: { day: -1, prog: {}, claimed: [] },
  medals: {},             // key -> count
  owned: { cards: [], emblems: [] }, // bought ones (earned ones are computed)
  card: DEFAULT_CARD,
  emblem: DEFAULT_EMBLEM,
  loadouts: LOADOUT_DEFAULT_CLASSES.map((c, i) => ({ ...A.defaultLoadout(A.CLASSES[c] ? c : 'assault'), name: `Loadout ${i + 1}` })),
  active: 0,
  totals: { kills: 0, matches: 0, wins: 0, medals: 0, streaks: 0 },
  migrated: false,
  notice: null,
});

const nn = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const WSTATS = ['xp', 'kills', 'headshots', 'longshots', 'closes', 'flanks', 'longodds', 'coverKills', 'dmg', 'multis', 'top3', 'top5', 'wins', 'matches'];

/** Sanitise any object into a valid v5 progress record. Exported for the transfer import. */
export function sanitize(saved) {
  const d = EMPTY();
  if (!isObj(saved)) return d;
  d.xp = Math.min(nn(saved.xp), LEVEL_FLOOR[MAX_LEVEL] + 10_000_000);
  if (isObj(saved.weapons)) for (const [id, r] of Object.entries(saved.weapons)) {
    if (typeof id !== 'string' || id.length > 40 || !isObj(r)) continue;
    const o = {}; for (const k of WSTATS) o[k] = nn(r[k]);
    d.weapons[id] = o;
  }
  if (isObj(saved.camoSel)) for (const [id, c] of Object.entries(saved.camoSel)) if (typeof c === 'string' && c.length < 40) d.camoSel[id] = c;
  if (isObj(saved.daily)) {
    d.daily.day = Number.isInteger(saved.daily.day) ? saved.daily.day : -1;
    if (isObj(saved.daily.prog)) for (const [k, v] of Object.entries(saved.daily.prog)) d.daily.prog[k] = nn(v);
    if (Array.isArray(saved.daily.claimed)) d.daily.claimed = saved.daily.claimed.filter((x) => typeof x === 'string').slice(0, 10);
  }
  if (isObj(saved.medals)) for (const k of Object.keys(MEDALS)) d.medals[k] = nn(saved.medals[k]);
  if (isObj(saved.owned)) {
    d.owned.cards = Array.isArray(saved.owned.cards) ? saved.owned.cards.filter((x) => typeof x === 'string' && cardById(x)) : [];
    d.owned.emblems = Array.isArray(saved.owned.emblems) ? saved.owned.emblems.filter((x) => typeof x === 'string' && emblemById(x)) : [];
  }
  if (typeof saved.card === 'string' && cardById(saved.card)) d.card = saved.card;
  if (typeof saved.emblem === 'string' && emblemById(saved.emblem)) d.emblem = saved.emblem;
  if (Array.isArray(saved.loadouts)) {
    for (let i = 0; i < LOADOUT_SLOTS; i++) if (saved.loadouts[i]) d.loadouts[i] = { ...A.cleanLoadout(saved.loadouts[i]), name: typeof saved.loadouts[i].name === 'string' ? saved.loadouts[i].name.slice(0, 18) : `Loadout ${i + 1}` };
  }
  d.active = Number.isInteger(saved.active) && saved.active >= 0 && saved.active < LOADOUT_SLOTS ? saved.active : 0;
  if (isObj(saved.totals)) for (const k of Object.keys(d.totals)) d.totals[k] = nn(saved.totals[k]);
  d.migrated = !!saved.migrated;
  d.notice = isObj(saved.notice) && typeof saved.notice.kind === 'string' ? saved.notice : null;
  return d;
}

let data = EMPTY();
try {
  const raw = localStorage.getItem(KEY);
  if (raw) data = sanitize(JSON.parse(raw));
} catch { data = EMPTY(); }

function save() { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* ignore */ } }
const listeners = new Set();
export function onProgressChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed(what) { save(); for (const fn of listeners) { try { fn(what); } catch (e) { console.warn(e); } } }

// ---- migration from 3.x: back-pay player XP from the old career, carry the class pick
if (!data.migrated) {
  data.migrated = true;
  try {
    const c = career();
    if (c && nn(c.matches) > 0) {
      const xp = Math.min(LEVEL_FLOOR[30], nn(c.matches) * 400 + nn(c.kills) * 60 + nn(c.wins) * 300 + nn(c.revives) * 40);
      data.xp = Math.max(data.xp, xp);
      data.totals.kills = nn(c.kills); data.totals.matches = nn(c.matches); data.totals.wins = nn(c.wins);
      data.notice = { kind: 'v5', level: levelInfo(data.xp).level };
    }
    // Old 3.x settings picked a class: make it the first loadout.
    const s = JSON.parse(localStorage.getItem('tidefall.settings.v1') || 'null');
    if (s && typeof s.cls === 'string' && A.CLASSES[s.cls]) {
      const i = data.loadouts.findIndex((l) => l.cls === s.cls);
      data.active = i >= 0 ? i : 0;
    }
  } catch { /* garbage in old stores: start fresh */ }
  save();
}

export const progress = () => data;
export const player = () => levelInfo(data.xp);
export function takeNotice() { const n = data.notice; if (n) { data.notice = null; save(); } return n; }

// ------------------------------------------------------------------ weapons

export const wrec = (id) => data.weapons[id] || Object.fromEntries(WSTATS.map((k) => [k, 0]));
export const weaponLevel = (id) => weaponLevelInfo(wrec(id).xp);
export function attachmentUnlockLevel(weaponId, attId) {
  const i = A.unlockTrack(weaponId).indexOf(attId);
  return i < 0 ? null : i + 2;
}
export const isAttachmentUnlocked = (weaponId, attId) => {
  const lv = attachmentUnlockLevel(weaponId, attId);
  return lv !== null && weaponLevel(weaponId).level >= lv;
};

export function camoStatus(weaponId) {
  const r = wrec(weaponId);
  const ch = CAMO_CHALLENGES.map((c) => ({ ...c, have: Math.min(c.n, r[c.stat] || 0), done: (r[c.stat] || 0) >= c.n }));
  const core = ch.filter((c) => !c.bonus);
  const gold = core.every((c) => c.done);
  return { challenges: ch, core, gold, done: core.filter((c) => c.done).length, total: core.length };
}
export const goldCount = () => A.PRIMARIES.filter((w) => camoStatus(w.id).gold).length;
export const diamondUnlocked = () => goldCount() >= GOLDS_FOR_DIAMOND;
/** Tidal: Diamond unlocked and a Gold weapon in every primary category (sim rule: "Diamond on every category"). */
export const tidalUnlocked = () => diamondUnlocked() && [...new Set(A.PRIMARIES.map((w) => w.cat))].every((cat) => A.PRIMARIES.some((w) => w.cat === cat && camoStatus(w.id).gold));
export function ownedCamos(weaponId) {
  const st = camoStatus(weaponId);
  const out = st.challenges.filter((c) => c.done).map((c) => c.camo);
  if (st.gold) out.push(MASTERY.gold);
  if (st.gold && diamondUnlocked()) out.push(MASTERY.diamond);
  if (st.gold && tidalUnlocked()) out.push(MASTERY.tidal);
  return out;
}
export function equippedCamo(weaponId) {
  const id = data.camoSel[weaponId];
  return id && ownedCamos(weaponId).some((c) => c.id === id) ? id : null;
}
export function setCamo(weaponId, camoId) {
  if (camoId && !ownedCamos(weaponId).some((c) => c.id === camoId)) return false;
  if (camoId) data.camoSel[weaponId] = camoId; else delete data.camoSel[weaponId];
  changed('camo');
  return true;
}

// ------------------------------------------------------------------ loadouts

export const loadouts = () => data.loadouts;
export const activeIndex = () => data.active;
export function activeLoadout() { return A.cleanLoadout(data.loadouts[data.active], isAttachmentUnlocked); }
export function setActive(i) { if (i >= 0 && i < LOADOUT_SLOTS) { data.active = i; changed('loadout'); } }
export function saveLoadout(i, l) {
  if (i < 0 || i >= LOADOUT_SLOTS) return null;
  const name = typeof l?.name === 'string' && l.name.trim() ? l.name.trim().slice(0, 18) : data.loadouts[i]?.name || `Loadout ${i + 1}`;
  data.loadouts[i] = { ...A.cleanLoadout(l, isAttachmentUnlocked), name };
  changed('loadout');
  return data.loadouts[i];
}

// ------------------------------------------------------------------ cards + emblems

function unlockState(item) {
  const u = item.unlock || { kind: 'default' };
  switch (u.kind) {
    case 'default': return { ok: true, label: 'Default' };
    case 'level': { const lv = player().level; return { ok: lv >= u.level, label: `Reach level ${u.level}`, prog: Math.min(1, lv / u.level) }; }
    case 'prestige': { const t = M.classProgress(u.cls).tier; return { ok: t >= u.tier, label: `${A.CLASSES[u.cls]?.name || u.cls} ${M.TIER_NAMES[u.tier]}`, prog: Math.min(1, t / u.tier) }; }
    case 'gold': { const g = goldCount(); return { ok: g >= u.n, label: `Gold camo on ${u.n} weapon${u.n === 1 ? '' : 's'}`, prog: Math.min(1, g / u.n) }; }
    case 'diamond': return { ok: diamondUnlocked(), label: 'Unlock Diamond camo', prog: Math.min(1, goldCount() / GOLDS_FOR_DIAMOND) };
    case 'tidal': { const cats = [...new Set(A.PRIMARIES.map((w) => w.cat))]; const g = cats.filter((cat) => A.PRIMARIES.some((w) => w.cat === cat && camoStatus(w.id).gold)).length; return { ok: tidalUnlocked(), label: 'Unlock the Tidal camo', prog: cats.length ? g / cats.length : 0 }; }
    case 'medal': { const n = data.medals[u.medal] || 0; return { ok: n >= u.n, label: `${MEDALS[u.medal]?.name || u.medal} ×${u.n}`, prog: Math.min(1, n / u.n) }; }
    case 'wins': { const n = data.totals.wins; return { ok: n >= u.n, label: `Win ${u.n} match${u.n === 1 ? '' : 'es'}`, prog: Math.min(1, n / u.n) }; }
    case 'kills': { const n = data.totals.kills; return { ok: n >= u.n, label: `${u.n} career kills`, prog: Math.min(1, n / u.n) }; }
    case 'price': return { ok: false, label: `${u.price.toLocaleString('en-US')} Salvage`, price: u.price };
    default: return { ok: false, label: 'Locked' };
  }
}
export function cardState(id) {
  const c = cardById(id); if (!c) return null;
  const owned = data.owned.cards.includes(id);
  const s = unlockState(c);
  return { ...s, ok: s.ok || owned, owned: s.ok || owned, equipped: data.card === id };
}
export function emblemState(id) {
  const e = emblemById(id); if (!e) return null;
  const owned = data.owned.emblems.includes(id);
  const s = unlockState(e);
  return { ...s, ok: s.ok || owned, owned: s.ok || owned, equipped: data.emblem === id };
}
export const equippedCard = () => (cardState(data.card)?.ok ? data.card : DEFAULT_CARD);
export const equippedEmblem = () => (emblemState(data.emblem)?.ok ? data.emblem : DEFAULT_EMBLEM);
export function equipCard(id) { if (!cardState(id)?.ok) return false; data.card = id; changed('card'); return true; }
export function equipEmblem(id) { if (!emblemState(id)?.ok) return false; data.emblem = id; changed('emblem'); return true; }
export function buyCard(kind, id) {
  const item = kind === 'card' ? cardById(id) : emblemById(id);
  if (!item || item.unlock?.kind !== 'price') return { ok: false, error: 'Not for sale' };
  const list = kind === 'card' ? data.owned.cards : data.owned.emblems;
  if (list.includes(id)) return { ok: false, error: 'Already owned' };
  const r = M.spend?.(item.unlock.price);
  if (!r?.ok) return { ok: false, error: r?.error || 'Not enough Salvage' };
  list.push(id);
  changed('buy');
  return { ok: true };
}
const earnedSet = () => new Set([...CARDS.filter((c) => cardState(c.id)?.ok).map((c) => 'c:' + c.id), ...EMBLEMS.filter((e) => emblemState(e.id)?.ok).map((e) => 'e:' + e.id)]);

// ------------------------------------------------------------------ dailies

export function dailies() {
  const day = dayNow();
  if (data.daily.day !== day) { data.daily = { day, prog: {}, claimed: [] }; save(); }
  return dayPick(day).map((c) => ({ ...c, have: Math.min(c.n, data.daily.prog[c.key] || 0), done: (data.daily.prog[c.key] || 0) >= c.n, claimed: data.daily.claimed.includes(c.key) }));
}

// ------------------------------------------------------------------ match award

/**
 * One call per finished match. `m`:
 * { cls, place, total, won, kills, dmg, revives, rounds, medals:[key], weaponId, wstats:{kills,longshots,flanks,longodds,dmg,multis}, streaks, lethalKills, xpEvents:[[label, xp]] }
 * Returns everything the end screen animates.
 */
export function awardMatch5(m) {
  const before = player();
  const earnedBefore = earnedSet();
  const placeFrac = Math.max(0, Math.min(1, ((m.total || 1) - (m.place || m.total || 1)) / Math.max(1, (m.total || 2) - 1)));
  const medalXp = (m.medals || []).reduce((a, k) => a + (MEDALS[k]?.xp || 0), 0);
  const parts = [
    ['Match', 300],
    [`Placement #${m.place}`, Math.round(900 * placeFrac)],
    m.won && ['Victory', 1000],
    m.kills > 0 && [`Kills ×${m.kills}`, m.kills * 150],
    m.dmg > 0 && ['Damage', m.dmg * 8],
    m.revives > 0 && [`Revives ×${m.revives}`, m.revives * 120],
    medalXp > 0 && [`Medals ×${m.medals.length}`, medalXp],
  ].filter(Boolean).filter((p) => p[1] > 0);
  const total = parts.reduce((a, p) => a + p[1], 0);

  // Dailies (before XP, so rewards land in the same bar fill).
  const ds = dailies();
  const inc = { kills: m.kills, dmg: m.dmg, top5: m.place <= 5 ? 1 : 0, matches: 1, medals: (m.medals || []).length, flanks: m.wstats?.flanks || 0, longshots: m.wstats?.longshots || 0, streaks: m.streaks || 0, revives: m.revives || 0, wins: m.won ? 1 : 0, lethalKills: m.lethalKills || 0, rounds: m.rounds || 0 };
  const daily = [];
  let dailyXp = 0, dailySalv = 0;
  for (const c of ds) {
    const was = data.daily.prog[c.key] || 0;
    const now = was + (inc[c.stat] || 0);
    data.daily.prog[c.key] = now;
    const done = now >= c.n && was < c.n;
    if (done && !data.daily.claimed.includes(c.key)) { data.daily.claimed.push(c.key); dailyXp += c.xp; dailySalv += c.salvage; }
    daily.push({ ...c, before: Math.min(c.n, was), after: Math.min(c.n, now), done: now >= c.n, justDone: done });
  }
  if (dailyXp) parts.push(['Daily challenges', dailyXp]);
  data.xp += total + dailyXp;
  if (dailySalv) M.grantSalvage?.(dailySalv);
  const after = player();

  // Weapon XP + camo progress.
  let weapon = null;
  const camos = [];
  if (m.weaponId && A.weaponById(m.weaponId)) {
    const r = data.weapons[m.weaponId] || (data.weapons[m.weaponId] = Object.fromEntries(WSTATS.map((k) => [k, 0])));
    const wb = weaponLevelInfo(r.xp);
    const camoBefore = new Set(ownedCamos(m.weaponId).map((c) => c.id));
    const ws = m.wstats || {};
    const wxp = 150 + (ws.kills || 0) * WEAPON_XP.kill + (ws.hits || 0) * WEAPON_XP.hit + (ws.shots || 0) * WEAPON_XP.shot + (m.won ? WEAPON_XP.win : 0) + Math.round(300 * placeFrac);
    r.xp += wxp;
    for (const k of ['kills', 'headshots', 'longshots', 'closes', 'flanks', 'longodds', 'coverKills', 'dmg', 'multis']) r[k] += nn(ws[k]);
    if (m.place <= 3) r.top3++;
    if (m.place <= 5) r.top5++;
    if (m.won) r.wins++;
    r.matches++;
    const wa = weaponLevelInfo(r.xp);
    const track = A.unlockTrack(m.weaponId);
    const unlocked = [];
    for (let lv = wb.level + 1; lv <= wa.level; lv++) if (track[lv - 2]) unlocked.push(track[lv - 2]);
    weapon = { id: m.weaponId, xp: wxp, before: wb, after: wa, unlocked };
    for (const c of ownedCamos(m.weaponId)) if (!camoBefore.has(c.id)) camos.push({ weapon: m.weaponId, camo: c });
    weapon.challenges = camoStatus(m.weaponId).challenges;
  }

  for (const k of m.medals || []) if (MEDALS[k]) data.medals[k] = (data.medals[k] || 0) + 1;
  data.totals.kills += nn(m.kills); data.totals.matches++; if (m.won) data.totals.wins++;
  data.totals.medals += (m.medals || []).length; data.totals.streaks += nn(m.streaks);

  const earnedAfter = earnedSet();
  const newly = [...earnedAfter].filter((k) => !earnedBefore.has(k)).map((k) => ({ kind: k[0] === 'c' ? 'card' : 'emblem', id: k.slice(2) }));
  changed('award');
  return { player: { xp: total + dailyXp, parts, before, after, levelUps: after.level - before.level }, weapon, camos, daily, dailySalvage: dailySalv, unlocks: newly };
}

/** Debug only. */
export function _debugXp(n) { data.xp += n; changed('xp'); return player(); }
export function _debugWeapon(id, stats) { const r = data.weapons[id] || (data.weapons[id] = Object.fromEntries(WSTATS.map((k) => [k, 0]))); for (const [k, v] of Object.entries(stats)) r[k] = (r[k] || 0) + v; changed('w'); return r; }
export function replaceAll(d) { data = sanitize(d); data.migrated = true; save(); }
