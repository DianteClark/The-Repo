// Loadouts: validation, bot loadouts, and turning a loadout into a unit's kit.
//
// Loadout shape (spec §3):
//   { cls, primary:{id, attachments:{optic?,barrel?,magazine?,underbarrel?,stock?}},
//     secondary:{id}, lethal, tactical, perks:[t1,t2,t3], streaks:[k1,k2,k3] }

import { CLASSES } from './constants.js';
import {
  WEAPONS, SECONDARIES, ATTACHMENTS, ATTACHMENT_SLOTS, EQUIPMENT, LETHALS, TACTICALS, PERKS, STREAKS, STREAK_KEYS,
  CLASS_WEAPONS, DEFAULT_PRIMARY, DEFAULT_KIT, buildWeapon, weaponsForClass,
} from './weapons.js';

const DEFAULT_STREAKS = ['uav', 'care', 'airstrike'];
const DEFAULT_PERKS = ['scavenger', 'steady', 'quickfix'];

/** Clamp any loadout-ish object into a legal loadout. Never throws. */
export function validateLoadout(l) {
  const src = l && typeof l === 'object' ? l : {};
  const cls = CLASSES[src.cls] ? src.cls : 'assault';
  const allowed = CLASS_WEAPONS[cls];
  let pid = src.primary?.id ?? src.primary;
  if (!WEAPONS[pid] || !allowed.includes(WEAPONS[pid].cat)) pid = DEFAULT_PRIMARY[cls];
  const attachments = {};
  const att = src.primary?.attachments || {};
  let n = 0;
  for (const slot of ATTACHMENT_SLOTS) {
    const a = ATTACHMENTS[att[slot]];
    if (a && a.slot === slot && n < 5) { attachments[slot] = a.id; n++; }
  }
  let sid = src.secondary?.id ?? src.secondary;
  if (!SECONDARIES[sid]) sid = 'pistol';
  const lethal = LETHALS.includes(src.lethal) ? src.lethal : DEFAULT_KIT[cls].lethal;
  const tactical = TACTICALS.includes(src.tactical) ? src.tactical : DEFAULT_KIT[cls].tactical;
  const tiers = [PERKS.tier1, PERKS.tier2, PERKS.tier3];
  const perks = tiers.map((tier, i) => {
    const want = Array.isArray(src.perks) ? src.perks[i] : undefined;
    return tier.some((p) => p.key === want) ? want : DEFAULT_PERKS[i];
  });
  const streaks = [];
  for (const k of Array.isArray(src.streaks) ? src.streaks : []) {
    if (STREAKS[k] && !streaks.includes(k) && streaks.length < 3) streaks.push(k);
  }
  for (const k of DEFAULT_STREAKS.concat(STREAK_KEYS)) if (streaks.length < 3 && !streaks.includes(k)) streaks.push(k);
  streaks.sort((a, b) => STREAKS[a].cost - STREAKS[b].cost);
  return { cls, primary: { id: pid, attachments }, secondary: { id: sid }, lethal, tactical, perks, streaks };
}

/** Default loadout for a class (what the legacy `playerClass` option gives you). */
export const defaultLoadout = (cls) => validateLoadout({ cls });

/**
 * A sensible random loadout for a bot. `rnd` is a () => [0,1) source.
 * Bots carry 0–2 attachments that suit their weapon, and kit that suits their class.
 */
export function randomLoadout(rnd, cls) {
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const prims = weaponsForClass(cls);
  const primary = rnd() < 0.35 ? DEFAULT_PRIMARY[cls] : pick(prims);
  const attachments = {};
  const n = Math.floor(rnd() * 3);
  const slots = [...ATTACHMENT_SLOTS];
  for (let i = 0; i < n; i++) {
    const slot = slots.splice(Math.floor(rnd() * slots.length), 1)[0];
    const opts = Object.values(ATTACHMENTS).filter((a) => a.slot === slot).map((a) => a.id);
    attachments[slot] = pick(opts);
  }
  const secondary = pick(['pistol', 'pistol', 'mpistol', 'launcher']);
  const lethal = rnd() < 0.5 ? DEFAULT_KIT[cls].lethal : pick(LETHALS);
  const tactical = rnd() < 0.5 ? DEFAULT_KIT[cls].tactical : pick(TACTICALS);
  const perks = [pick(PERKS.tier1).key, pick(PERKS.tier2).key, pick(PERKS.tier3).key];
  const pool = [...STREAK_KEYS];
  const streaks = [];
  while (streaks.length < 3) streaks.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return validateLoadout({ cls, primary: { id: primary, attachments }, secondary: { id: secondary }, lethal, tactical, perks, streaks });
}

/** Starting charges for a piece of equipment carried by this class / perks. */
export function startCharges(key, cls) {
  const e = EQUIPMENT[key];
  if (!e) return 0;
  let n = e.charges;
  if (e.slot === 'lethal' && cls === 'assault') n++; // Frag specialist
  return n;
}

export const hasPerk = (u, k) => !!u.perks && u.perks.includes(k);

/** Recompute derived movement after kit changes (attachments, legendary pickups, perks). */
export function refreshMove(u) {
  const base = u.baseMove ?? CLASSES[u.cls]?.move ?? 6;
  const prim = u.weapons ? u.weapons[0] : u.weapon;
  u.move = Math.max(2, base + (hasPerk(u, 'lightweight') ? 1 : 0) + (prim?.move || 0));
}

/** Load a weapon object's ammo fields: a full magazine plus spare rounds. */
export function armWeapon(w) {
  w.ammo = w.mag;
  w.spare = w.reserve;
  return w;
}

/**
 * Equip a validated loadout onto a unit (class stats included). Lone-wolf
 * bonuses are applied by the caller afterwards.
 */
export function applyLoadout(u, loadout) {
  const l = validateLoadout(loadout);
  const c = CLASSES[l.cls];
  u.cls = l.cls;
  u.loadout = l;
  u.perks = [...l.perks];
  u.streaks = [...l.streaks];
  u.maxHp = c.hp; u.hp = c.hp; u.armor = c.armor;
  u.baseMove = c.move;
  const primary = armWeapon(buildWeapon(l.primary.id, l.primary.attachments));
  const secondary = armWeapon(buildWeapon(l.secondary.id));
  u.weapons = [primary, secondary];
  u.slot = 0;
  u.weapon = primary;
  u.ammo = primary.ammo;
  u.lethal = l.lethal;
  u.tactical = l.tactical;
  u.items = { medkit: 1 };
  for (const k of Object.keys(EQUIPMENT)) u.items[k] = 0;
  u.items[l.lethal] += startCharges(l.lethal, l.cls);
  u.items[l.tactical] += startCharges(l.tactical, l.cls);
  if (u.perks.includes('trapper')) u.items.claymore++;
  refreshMove(u);
  return u;
}
