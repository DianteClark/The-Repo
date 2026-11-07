// Career stats, persisted in localStorage separately from settings so a
// settings reset never wipes them. Recorded once per finished match.

const KEY = 'tidefall.career.v1';

const EMPTY = () => ({
  matches: 0, wins: 0, kills: 0, best: 0, top3: 0,
  damage: 0, revives: 0, rounds: 0, streak: 0, bestStreak: 0,
  byMode: {}, // mode -> { matches, wins, best }
  last: null,  // { place, total, mode, cls, kills, won, at }
});

let data = EMPTY();
try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const saved = JSON.parse(raw);
    if (saved && typeof saved === 'object') {
      const base = EMPTY();
      for (const k of Object.keys(base)) if (typeof saved[k] === typeof base[k] || (k === 'last' && saved[k])) base[k] = saved[k];
      data = base;
    }
  }
} catch { /* private mode etc. */ }

function save() { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* ignore */ } }

export function career() { return data; }

/** Record one finished match. `place` 1 = winner. Returns flags for "new best" etc. */
export function recordMatch({ mode, cls, place, total, kills = 0, damage = 0, revives = 0, rounds = 0 }) {
  const won = place === 1;
  const prevBest = data.best || 0;
  data.matches++;
  data.kills += kills;
  data.damage += damage;
  data.revives += revives;
  data.rounds += rounds;
  if (won) { data.wins++; data.streak++; data.bestStreak = Math.max(data.bestStreak, data.streak); } else data.streak = 0;
  if (place <= 3) data.top3++;
  const newBest = place > 0 && (!prevBest || place < prevBest);
  if (newBest) data.best = place;
  const m = data.byMode[mode] || (data.byMode[mode] = { matches: 0, wins: 0, best: 0 });
  m.matches++;
  if (won) m.wins++;
  if (place > 0 && (!m.best || place < m.best)) m.best = place;
  data.last = { place, total, mode, cls, kills, won, at: Date.now() };
  save();
  return { newBest, firstWin: won && data.wins === 1, matches: data.matches };
}

export function resetCareer() { data = EMPTY(); save(); }
