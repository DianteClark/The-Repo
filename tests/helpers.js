// Shared test fixtures (not a test file itself).
import {
  createGame, currentTeamId, endTeamTurn, startFirstRound, isTeamActive, activeTeams,
} from '../src/sim/game.js';
import { CLASSES } from '../src/sim/constants.js';
import { applyLoadout } from '../src/sim/loadout.js';
import { EQUIPMENT } from '../src/sim/weapons.js';

export const S = 44;

/**
 * Duos match on an empty map with only the listed units alive.
 * spec: { me:[x,y,cls], mate?:[x,y,cls], foes:[[x,y,cls],...], mode? }
 * foes alternate squads: es[0] & es[2] are squadmates, as are es[1] & es[3].
 */
export function arena({ me, mate, foes = [], mode = 'duos', stage = 'harbor', pit = false }) {
  const s = createGame({ seed: 77, mode, stage, noHuman: true });
  s.map = {
    size: S, cover: new Uint8Array(S * S), terrain: new Uint8Array(S * S), explosive: new Uint8Array(S * S),
    wallHeight: new Float32Array(S * S), sight: s.map.sight, stage: s.map.stage,
    building: new Int16Array(S * S).fill(-1), buildings: [],
  };
  s.crates = [];
  // 5.0 battlefield layer: off unless a test sets it up (no boats, no stage event, Pit opt-in).
  s.vehicles = []; s.blockers = []; s._boatKeys = []; s.stageEvent = null; s.hazards = [];
  s.pit.enabled = pit;
  for (const u of s.units) u.alive = false;
  const myTeam = s.teams[currentTeamId(s)];
  const other = s.teams.find((t) => t.id !== myTeam.id);
  const other2 = s.teams.find((t) => t.id !== myTeam.id && t.id !== other.id);
  const m = (t, i) => t.members[i] ?? null;
  // Neutral fixture: the class's default weapon, no perks, legacy kit (assault 2 frags,
  // recon 1 smoke). Tests opt in to perks / equipment explicitly.
  const place = (u, [x, y, cls = 'assault', loadout = {}]) => {
    applyLoadout(u, { cls, ...loadout });
    if (!loadout.perks) u.perks = [];
    const c = CLASSES[cls];
    Object.assign(u, {
      alive: true, x, y, cls, hp: c.hp, maxHp: c.hp, armor: c.armor, ap: u.maxAp,
      missStreak: 0, hunkered: false, overwatch: false,
    });
    u.mods = { scope: 0, barrel: 0, armor: 0 };
    if (!loadout.lethal && !loadout.tactical) {
      u.items = { medkit: 1 };
      for (const k of Object.keys(EQUIPMENT)) u.items[k] = 0;
      u.items.frag = cls === 'assault' ? 2 : 0;
      u.items.smoke = cls === 'recon' ? 1 : 0;
      u.lethal = 'frag'; u.tactical = 'smoke';
    }
    u.cooldowns = { aimed: 0, breach: 0, patch: 0, scan: 0, deploy_cover: 0, suppress: 0, run_gun: 0 };
    u.downed = false; u.bleed = 0; u.downedBy = null; u.downedAt = -1; u.kills = 0;
    u.streakUsed = {}; u.flash = null; u.suppressed = null; u.slow = 0; u.moved = false;
    return u;
  };
  const a = place(s.units[myTeam.members[0]], me);
  const b = mate ? place(s.units[myTeam.members[1]], mate) : null;
  // Interleave so es[0] and es[1] are on different squads.
  const pool = [m(other, 0), m(other2, 0), m(other, 1), m(other2, 1)].filter((id) => id !== null);
  const es = foes.map((f, i) => place(s.units[pool[i]], f));
  // Re-plan round 1 for the new layout (contact groups), then open my squad's turn.
  s.turnSerial = 0;
  s.startEvents = startFirstRound(s);
  let g = 0;
  while (!isTeamActive(s, myTeam.id) && g++ < 50) endTeamTurn(s, activeTeams(s)[0]);
  return { s, a, b, es };
}
export const setCover = (s, x, y, c) => { s.map.cover[y * S + x] = c; };
export const coverAt = (s, x, y) => s.map.cover[y * S + x];

/** End team turns (whoever is active) until `team` is active again (at least one turn passes). */
export function cycleTo(s, team) {
  cycleLog(s, team);
}
/** End turns until `team` is active again, collecting every event. Ends `team`'s own turn first if it's active. */
export function cycleLog(s, team) {
  const log = [];
  let guard = 0;
  if (isTeamActive(s, team)) log.push(...endTeamTurn(s, team));
  while (!isTeamActive(s, team) && s.winner === null && guard++ < 200) log.push(...endTeamTurn(s, activeTeams(s)[0]));
  return log;
}
/** End every other active squad's turn so that only `team` (if active) is left in this step. */
export function only(s, team) {
  for (const t of activeTeams(s)) if (t !== team) endTeamTurn(s, t);
}
