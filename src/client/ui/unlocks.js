// 5.2 unlock track: classes, perks and killstreaks unlock with PLAYER LEVEL (1–100).
//
// The whole schedule is the one table below. Everything else (Barracks locks, loadout
// sanitising, the Career "Unlocks" road, the level-up reveal cards, what goes online) reads it
// through the helpers. Bots are unaffected: this only gates what the local player can equip.
//
// Keys are the sim's (src/sim/weapons.js / constants.js); the arsenal's fallback aliases are
// mapped too. Anything not in the table is available from level 1.

import * as A from './arsenal.js';

/** [kind, key, level]. Level 1 = the starter kit. */
export const UNLOCKS = [
  // classes: three to start, the specialists early
  ['class', 'assault', 1], ['class', 'medic', 1], ['class', 'recon', 1],
  ['class', 'marksman', 3], ['class', 'breacher', 6], ['class', 'engineer', 10], ['class', 'gunner', 15],
  // perk tier 1
  ['perk', 'scavenger', 1], ['perk', 'lightweight', 1], ['perk', 'amphibious', 4], ['perk', 'flak', 12],
  // perk tier 2
  ['perk', 'steady', 1], ['perk', 'trapper', 1], ['perk', 'ghost', 9], ['perk', 'hardline', 20],
  // perk tier 3
  ['perk', 'quickfix', 1], ['perk', 'tracker', 1], ['perk', 'mask', 7], ['perk', 'deadsilence', 26],
  // killstreaks: the three cheap ones to start
  ['streak', 'uav', 1], ['streak', 'care', 1], ['streak', 'cuav', 1],
  ['streak', 'airstrike', 8], ['streak', 'sentry', 14], ['streak', 'gunship', 22],
];

// arsenal fallback keys → sim keys
const ALIAS = { flak_jacket: 'flak', steady_aim: 'steady', dead_silence: 'deadsilence', quick_fix: 'quickfix', tactical_mask: 'mask', care_package: 'care', counter_uav: 'cuav' };
const canon = (k) => ALIAS[k] || k;
const TABLE = new Map(UNLOCKS.map(([kind, key, lv]) => [`${kind}:${key}`, lv]));

/** The player level an item unlocks at (1 = always available). */
export const unlockLevel = (kind, key) => TABLE.get(`${kind}:${canon(key)}`) ?? 1;
export const isUnlocked = (kind, key, level) => (Number(level) || 1) >= unlockLevel(kind, key);
export const classUnlocked = (key, level) => isUnlocked('class', key, level);
export const perkUnlocked = (key, level) => isUnlocked('perk', key, level);
export const streakUnlocked = (key, level) => isUnlocked('streak', key, level);

/** Display name + art hints for one unlock. */
export function describe(kind, key) {
  if (kind === 'class') {
    const c = A.CLASSES[key];
    return { kind, key, name: c?.name || key, desc: A.CLASS_ROLE[key]?.role || c?.desc || '', sub: A.CLASS_ROLE[key]?.ability || '', label: 'Class' };
  }
  if (kind === 'perk') {
    const p = A.perkByKey(key) || A.perkByKey(Object.keys(ALIAS).find((a) => ALIAS[a] === key) || '');
    const tier = [1, 2, 3].find((t) => A.PERKS[`tier${t}`].some((x) => canon(x.key) === canon(key))) || 1;
    return { kind, key, name: p?.name || key, desc: p?.desc || '', sub: `Perk ${tier}`, tier, label: `Perk · tier ${tier}` };
  }
  const s = A.streakByKey(key) || A.streakByKey(Object.keys(ALIAS).find((a) => ALIAS[a] === key) || '');
  return { kind, key, name: s?.name || key, desc: s?.desc || '', sub: s ? `${s.cost} points` : '', label: 'Killstreak' };
}

/** Everything that unlocks in (from, to]: one entry per item, in level order. */
export function unlocksBetween(from, to) {
  return UNLOCKS.filter(([, , lv]) => lv > from && lv <= to && lv > 1)
    .sort((a, b) => a[2] - b[2])
    .map(([kind, key, lv]) => ({ ...describe(kind, key), level: lv }))
    .filter((d) => d.kind !== 'class' || A.CLASSES[d.key]);
}
export const unlocksAt = (level) => unlocksBetween(level - 1, level);

/** The full road (levels with something on them), for the Career page. */
export function road() {
  const by = new Map();
  for (const [kind, key, lv] of UNLOCKS) {
    if (lv <= 1) continue;
    if (kind === 'class' && !A.CLASSES[key]) continue;
    if (!by.has(lv)) by.set(lv, []);
    by.get(lv).push({ ...describe(kind, key), level: lv });
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([level, items]) => ({ level, items }));
}
/** The starter kit (level 1), for the road's first stop. */
export const starters = () => UNLOCKS.filter(([kind, key, lv]) => lv <= 1 && (kind !== 'class' || A.CLASSES[key])).map(([kind, key]) => describe(kind, key));

/** The next unlock above a level (null at the end of the road). */
export function nextUnlock(level) {
  const r = road().find((s) => s.level > level);
  return r || null;
}

// ------------------------------------------------------------------ loadouts

/** First unlocked class at this level (prefers `want`). */
export function fallbackClass(want, level) {
  if (classUnlocked(want, level) && A.CLASSES[want]) return want;
  return A.CLASS_ORDER.find((k) => A.CLASSES[k] && classUnlocked(k, level)) || 'assault';
}

/** A tier's fallback perk: the earliest-unlocking one this level has (the starter kit first). */
function starterPerk(t, level) {
  return A.PERKS[`tier${t}`].filter((p) => perkUnlocked(p.key, level)).sort((a, b) => unlockLevel('perk', a.key) - unlockLevel('perk', b.key))[0] || null;
}

/**
 * Clamp a loadout to what this level allows. Locked class → the first unlocked class's default
 * kit (keeping a primary that still fits); locked perk → the tier's first unlocked perk;
 * locked streaks → replaced by unlocked ones (cheapest first). Never throws; returns a new object.
 * `changed` tells whether anything was swapped.
 */
export function gateLoadout(l, level) {
  const src = l && typeof l === 'object' ? l : {};
  let out = JSON.parse(JSON.stringify(src));
  let changed = false;
  const cls = out.cls && A.CLASSES[out.cls] ? out.cls : 'assault';
  if (!classUnlocked(cls, level)) {
    const nc = fallbackClass(cls, level);
    const d = A.defaultLoadout(nc);
    const keep = out.primary && A.primariesFor(nc).some((w) => w.id === out.primary.id);
    out = { ...out, cls: nc, primary: keep ? out.primary : d.primary, lethal: d.lethal, tactical: d.tactical };
    changed = true;
  } else out.cls = cls;
  if (Array.isArray(out.perks)) {
    out.perks = [1, 2, 3].map((t, i) => {
      const k = out.perks[i];
      if (k && perkUnlocked(k, level)) return k;
      const first = starterPerk(t, level);
      if (k) changed = true;
      return first ? first.key : k;
    });
  } else {
    out.perks = [1, 2, 3].map((t) => starterPerk(t, level)?.key).filter(Boolean);
    if (out.perks.length !== 3) delete out.perks;
  }
  const want = Array.isArray(out.streaks) ? out.streaks : [];
  const ks = [...new Set(want.filter((k) => A.streakByKey(k) && streakUnlocked(k, level)))].slice(0, 3);
  if (ks.length !== Math.min(3, want.length) || want.some((k) => !streakUnlocked(k, level))) changed = true;
  for (const s of A.STREAKS) { if (ks.length >= 3) break; if (!ks.includes(s.key) && streakUnlocked(s.key, level)) ks.push(s.key); }
  out.streaks = ks.sort((a, b) => (A.streakByKey(a)?.cost ?? 0) - (A.streakByKey(b)?.cost ?? 0));
  return { loadout: out, changed };
}

/** True if the loadout uses anything above this level. */
export function loadoutLocked(l, level) {
  if (!l) return false;
  if (!classUnlocked(l.cls, level)) return true;
  if ((l.perks || []).some((k) => !perkUnlocked(k, level))) return true;
  return (l.streaks || []).some((k) => !streakUnlocked(k, level));
}
