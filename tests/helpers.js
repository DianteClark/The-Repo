// Shared test fixtures (not a test file itself).
import { createGame, currentTeamId, endTeamTurn } from '../src/sim/game.js';
import { CLASSES } from '../src/sim/constants.js';

export const S = 44;

/**
 * Duos match on an empty map with only the listed units alive.
 * spec: { me:[x,y,cls], mate?:[x,y,cls], foes:[[x,y,cls],...], mode? }
 * foes alternate squads: es[0] & es[2] are squadmates, as are es[1] & es[3].
 */
export function arena({ me, mate, foes = [], mode = 'duos', stage = 'harbor' }) {
  const s = createGame({ seed: 77, mode, stage, noHuman: true });
  s.map = {
    size: S, cover: new Uint8Array(S * S), terrain: new Uint8Array(S * S), explosive: new Uint8Array(S * S),
    wallHeight: new Float32Array(S * S), sight: s.map.sight, stage: s.map.stage,
  };
  s.crates = [];
  for (const u of s.units) u.alive = false;
  const myTeam = s.teams[currentTeamId(s)];
  const other = s.teams.find((t) => t.id !== myTeam.id);
  const other2 = s.teams.find((t) => t.id !== myTeam.id && t.id !== other.id);
  const m = (t, i) => t.members[i] ?? null;
  const place = (u, [x, y, cls = 'assault']) => {
    const c = CLASSES[cls];
    Object.assign(u, {
      alive: true, x, y, cls, hp: c.hp, maxHp: c.hp, armor: c.armor, move: c.move, ap: u.maxAp,
      weapon: { ...c.weapon, dmg: [...c.weapon.dmg] }, missStreak: 0, hunkered: false, overwatch: false,
    });
    u.mods = { scope: 0, barrel: 0, armor: 0 };
    u.items = { medkit: 1, frag: cls === 'assault' ? 2 : 0, smoke: cls === 'recon' ? 1 : 0 };
    u.cooldowns = { aimed: 0, breach: 0, patch: 0, scan: 0 };
    u.downed = false; u.bleed = 0; u.downedBy = null; u.downedAt = -1; u.kills = 0;
    return u;
  };
  const a = place(s.units[myTeam.members[0]], me);
  const b = mate ? place(s.units[myTeam.members[1]], mate) : null;
  // Interleave so es[0] and es[1] are on different squads.
  const pool = [m(other, 0), m(other2, 0), m(other, 1), m(other2, 1)].filter((id) => id !== null);
  const es = foes.map((f, i) => place(s.units[pool[i]], f));
  return { s, a, b, es };
}
export const setCover = (s, x, y, c) => { s.map.cover[y * S + x] = c; };
export const coverAt = (s, x, y) => s.map.cover[y * S + x];

/** End team turns until it's `team`'s turn again. */
export function cycleTo(s, team) {
  let guard = 0;
  do endTeamTurn(s); while (currentTeamId(s) !== team && s.winner === null && guard++ < 100);
}
/** End turns until `team` is up, collecting every event. */
export function cycleLog(s, team) {
  const log = [];
  let guard = 0;
  do log.push(...endTeamTurn(s)); while (currentTeamId(s) !== team && s.winner === null && guard++ < 100);
  return log;
}
