// Bot sanity audit (not a test file itself): counts decisions a competent human wouldn't make.
// Usage: const A = createAudit(); A.install(); ... A.turn(state, team, () => botTakeTurn(...)) ...; A.uninstall().
// Checks only use what the bot's team could see at the time (visible enemies, recent noises).
import { AI_HOOKS } from '../src/sim/ai.js';
import { insideZone, insideNextZone, moveOptions, dangerTiles } from '../src/sim/game.js';
import { dist, teamSeesUnit, standing, coverVs, los, reachable, moveOf } from '../src/sim/rules.js';
import { streakTargets } from '../src/sim/streaks.js';

const visibleThreats = (state, u) => state.units.filter((e) => standing(e) && e.team !== u.team && teamSeesUnit(state, u.team, e));
const heard = (state, u, r = 14) => (state.noises || []).some((n) => n.team !== u.team && n.round >= state.round - 1 && dist(n.x, n.y, u.x, u.y) <= r);
const dot = (ax, ay, bx, by) => ax * bx + ay * by;
const inCone = (dx, dy, vx, vy) => {
  const l1 = Math.hypot(dx, dy), l2 = Math.hypot(vx, vy);
  return l2 > 0 && dot(dx, dy, vx, vy) / (l1 * l2) >= Math.SQRT1_2 - 1e-9;
};

export const AUDIT_KEYS = [
  ['claymore', 'claymores placed'],
  ['clayTide', 'claymore outside current safe zone (in the tide)'],
  ['clayNextTide', 'claymore outside next safe zone'],
  ['clayBlind', 'claymore with no enemy seen (now or last 2 rounds) / heard within 14'],
  ['clayBehind', 'claymore on the far side from every known threat / noise'],
  ['clayUntriggered', 'claymores never triggered'],
  ['cover', 'deploy cover'],
  ['coverUseless', 'deploy cover that adds no cover / LOS block vs any known threat'],
  ['sentry', 'sentries'],
  ['sentryAway', 'sentry whose cone misses every known threat'],
  ['sentryTide', 'sentry in the tide (outside current zone)'],
  ['sentryNext', 'sentry outside next safe zone'],
  ['airstrike', 'airstrikes'],
  ['airOwn', 'airstrike marked over own squad'],
  ['airFriendly', 'own-squad units hit by own airstrike'],
  ['airMiss', 'airstrike that landed on no enemy'],
  ['uav', 'UAVs'],
  ['uavEmpty', 'UAV that revealed nobody'],
  ['care', 'care packages'],
  ['careBad', 'care package outside next ring (one was in range) or not walkable in 2 moves'],
  ['careLanded', 'care packages landed'],
  ['careOwn', '  claimed by the caller\'s squad'],
  ['careCaller', '    of which by the caller'],
  ['careFast', '    of which within 2 rounds of landing'],
  ['careEnemy', '  claimed by an enemy squad'],
  ['careSniped', '    of which before the caller\'s squad had another turn'],
  ['careNever', '  never claimed'],
  ['careTide', '    of which landed outside the next ring'],
  ['careWiped', '    of which the caller\'s squad was knocked out before claiming it'],
  ['gold', 'gold supply drops landed'],
  ['goldTaken', '  gold drops claimed'],
  ['killDrop', 'kill drops (crates from the dead)'],
  ['killDropTaken', '  kill drops claimed'],
  ['smoke', 'smokes'],
  ['smokeBlind', 'smoke with no visible threat'],
  ['decoy', 'decoys'],
  ['decoyTide', 'decoy outside safe zone'],
  ['nade', 'frag / semtex / flashbang'],
  ['nadeWaste', 'throw that catches no visible enemy'],
  ['reloadFull', 'reload with a full magazine'],
  ['turns', 'bot unit-turns'],
  ['tideEnd', 'turn ended in the tide with a dry tile reachable'],
  ['nextTideEnd', 'turn ended outside next ring before a shrink with an in-ring tile reachable'],
  ['dangerEnd', 'turn ended on a telegraphed danger tile with a safe tile reachable'],
  ['boatTide', 'boat moved to a tide tile'],
];

export function createAudit() {
  const A = Object.fromEntries(AUDIT_KEYS.map(([k]) => [k, 0]));
  const placed = new Set();
  // Crates being tracked: crate id → {kind:'care'|'gold'|'kill', team, by, round, next}.
  const watch = new Map();
  const calls = []; // callers of care packages still in the air, in call order
  // The audit's own team memory: last place each enemy was seen (kept 2 rounds).
  const memory = new Map();
  const remember = (state, team) => {
    let m = memory.get(team);
    if (!m) memory.set(team, (m = new Map()));
    for (const e of state.units) {
      if (e.team === team) continue;
      if (!standing(e)) m.delete(e.id);
      else if (teamSeesUnit(state, team, e)) m.set(e.id, { x: e.x, y: e.y, round: state.round });
      else if (m.get(e.id) && m.get(e.id).round < state.round - 2) m.delete(e.id);
    }
    return [...m.values()];
  };
  const onAct = (state, u, a) => {
    if (state.isPit) return null;
    const foes = visibleThreats(state, u);
    const known = remember(state, u.team);
    const { x, y } = a;
    switch (a.type) {
      case 'claymore': return (evs) => {
        A.claymore++;
        const ev = evs.find((e) => e.type === 'claymore');
        if (ev) placed.add(ev.claymoreId);
        if (!insideZone(state, x, y)) A.clayTide++;
        else if (!insideNextZone(state, x, y)) A.clayNextTide++;
        if (!known.some((e) => dist(e.x, e.y, u.x, u.y) <= 14) && !heard(state, u)) A.clayBlind++;
        else {
          const leads = [...known, ...(state.noises || []).filter((n) => n.team !== u.team && n.round >= state.round - 1)];
          if (leads.length && leads.every((e) => dot(x - u.x, y - u.y, e.x - u.x, e.y - u.y) < 0)) A.clayBehind++;
        }
      };
      case 'deploy_cover': {
        const S = state.map.size;
        const before = known.map((e) => [coverVs(state.map, u.x, u.y, e.x, e.y), los(state.map, e.x, e.y, u.x, u.y)]);
        state.map.cover[y * S + x] = 2;
        const gain = known.some((e, i) => coverVs(state.map, u.x, u.y, e.x, e.y) > before[i][0]
          || (before[i][1] && !los(state.map, e.x, e.y, u.x, u.y)));
        state.map.cover[y * S + x] = 0;
        return () => { A.cover++; if (!gain) A.coverUseless++; };
      }
      case 'streak': {
        if (a.key === 'sentry') {
          return () => {
            A.sentry++;
            const dx = (a.x2 ?? a.x) - a.x || a.x - u.x, dy = (a.y2 ?? a.y) - a.y || a.y - u.y;
            if (!known.some((e) => inCone(dx, dy, e.x - a.x, e.y - a.y))) A.sentryAway++;
            if (!insideZone(state, a.x, a.y)) A.sentryTide++;
            else if (!insideNextZone(state, a.x, a.y)) A.sentryNext++;
          };
        }
        if (a.key === 'airstrike') {
          return (evs) => {
            A.airstrike++;
            const mark = evs.find((e) => e.type === 'airstrike_mark');
            if (mark && state.units.some((m) => m.alive && m.team === u.team && mark.tiles.some(([tx, ty]) => tx === m.x && ty === m.y))) A.airOwn++;
          };
        }
        if (a.key === 'care') {
          const S = state.map.size;
          const ringInRange = [...streakTargets(state, u, 'care')].some((k) => insideZone(state, k % S, (k / S) | 0)
            && insideNextZone(state, k % S, (k / S) | 0));
          const n = reachable(state, u, moveOf(u) * 2).get(y * S + x);
          return () => {
            A.care++;
            if ((!insideNextZone(state, x, y) && ringInRange) || !n) A.careBad++;
          };
        }
        return null;
      }
      case 'smoke': return () => { A.smoke++; if (!foes.length) A.smokeBlind++; };
      case 'decoy': return () => { A.decoy++; if (!insideZone(state, x, y)) A.decoyTide++; };
      case 'grenade': case 'semtex': case 'flashbang': {
        const r = a.type === 'flashbang' ? 1.5 : 1.5;
        const hits = foes.some((e) => dist(e.x, e.y, x, y) <= r + 0.01)
          || state.units.some((e) => e.alive && e.downed && e.team !== u.team && dist(e.x, e.y, x, y) <= r && teamSeesUnit(state, u.team, e));
        return () => { A.nade++; if (!hits) A.nadeWaste++; };
      }
      case 'reload': {
        const full = u.ammo >= u.weapon.mag;
        return () => { if (full) A.reloadFull++; };
      }
      case 'boat_move': return () => { if (!insideZone(state, x, y)) A.boatTide++; };
      default: return null;
    }
  };
  return {
    A,
    install() { AI_HOOKS.onAct = onAct; },
    uninstall() { AI_HOOKS.onAct = null; },
    /** Wrap one bot unit's turn: pre-computes the escape options, then checks where it ended. */
    unitTurn(state, id, run) {
      const u = state.units[id];
      if (!standing(u) || state.isPit) return run();
      remember(state, u.team);
      // The caller's squad gets a turn with its care package on the ground.
      for (const w of watch.values()) if (w.kind === 'care' && w.team === u.team) w.acted = true;
      const S = state.map.size;
      const danger = dangerTiles(state);
      let dry = false, ring = false, safe = false;
      if (u.vehicle == null) {
        for (const k of moveOptions(state, u).keys()) {
          const x = k % S, y = (k / S) | 0;
          if (danger.has(k)) continue;
          safe = true;
          if (insideZone(state, x, y)) dry = true;
          if (insideZone(state, x, y) && insideNextZone(state, x, y)) ring = true;
        }
      }
      const evs = run();
      A.turns++;
      if (standing(u) && u.vehicle == null) {
        if (dry && !insideZone(state, u.x, u.y)) A.tideEnd++;
        else if (ring && state.round % 2 === 0 && !insideNextZone(state, u.x, u.y)) A.nextTideEnd++;
        if (safe && danger.has(u.y * S + u.x) && dangerTiles(state).has(u.y * S + u.x)) A.dangerEnd++;
      }
      return evs;
    },
    /** Tally events from the main match (claymore triggers, friendly airstrike hits). */
    events(state, evs) {
      let strike = null;
      const flush = () => { if (strike && !strike.hit) A.airMiss++; strike = null; };
      for (const e of evs) {
        if (e.type === 'airstrike') { flush(); strike = { hit: false }; }
        if (e.type === 'round_start' || e.type === 'engagement') flush();
        if (e.type === 'damage' && e.source === 'airstrike' && strike && e.by !== null
          && state.units[e.id].team !== state.units[e.by].team) strike.hit = true;
        if (e.type === 'uav') { A.uav++; if (!e.revealed.length) A.uavEmpty++; }
        if (e.type === 'claymore_trigger') placed.delete(e.claymoreId);
        if (e.type === 'care_package_called') calls.push(e.id);
        if (e.type === 'team_out') for (const w of watch.values()) if (w.kind === 'care' && w.team === e.team) w.out = true;
        if (e.type === 'care_package') {
          // Drops land in call order: the caller comes off the queue (works with 5.2.1 events too).
          const by = calls.length ? calls.shift() : e.by;
          A.careLanded++;
          watch.set(e.crate.id, {
            kind: 'care', team: e.team ?? state.units[by]?.team, by, round: state.round,
            next: insideNextZone(state, e.crate.x, e.crate.y),
          });
        }
        if (e.type === 'supply_drop' && e.crate.type === 'gold') { A.gold++; watch.set(e.crate.id, { kind: 'gold' }); }
        if (e.type === 'crate_drop') { A.killDrop++; watch.set(e.crate.id, { kind: 'kill' }); }
        if (e.type === 'crate' && watch.has(e.crate)) {
          const w = watch.get(e.crate);
          watch.delete(e.crate);
          const picker = state.units[e.id];
          if (w.kind === 'gold') A.goldTaken++;
          else if (w.kind === 'kill') A.killDropTaken++;
          else if (picker.team === w.team) {
            A.careOwn++;
            if (picker.id === w.by) A.careCaller++;
            if (state.round - w.round <= 2) A.careFast++;
          } else {
            A.careEnemy++;
            if (!w.acted) A.careSniped++;
          }
        }
        if (e.type === 'damage' && e.source === 'airstrike' && e.by !== null
          && state.units[e.id].team === state.units[e.by].team) A.airFriendly++;
      }
      flush();
    },
    endMatch() {
      A.clayUntriggered += placed.size; placed.clear(); memory.clear();
      for (const w of watch.values()) {
        if (w.kind !== 'care') continue;
        A.careNever++;
        if (!w.next) A.careTide++;
        if (w.out) A.careWiped++;
      }
      watch.clear(); calls.length = 0;
    },
  };
}

/** Print before/after style table rows: `label  count  (per match)`. */
export function auditReport(A, matches) {
  const lines = [];
  for (const [k, label] of AUDIT_KEYS) {
    lines.push(`  ${label.padEnd(76)} ${String(A[k]).padStart(6)}  (${(A[k] / Math.max(1, matches)).toFixed(2)}/match)`);
  }
  return lines.join('\n');
}
