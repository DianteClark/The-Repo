// Balance report: node tests/stats.mjs [seedsPerCell=20] [modes=all] [stages=all] [--detail]
// Bot-only matches for every stage × mode. Prints a summary table per stage, and with
// --detail the full breakdown (hit rates, cover, per-class results, ability usage).
// Always ends with the 5.0 totals: class / weapon-category kill + win share, equipment,
// ammo, killstreaks and engagement-turn shape, then the battlefield layer (boats, stage events,
// building collapse, the Pit) and streak points (what a mid-game survivor earns).
import { createGame, endTeamTurn, activeTeams } from '../src/sim/game.js';
import { botTakeTurn } from '../src/sim/ai.js';
import { MODES, STAGE_KEYS } from '../src/sim/constants.js';
import { weaponDef } from '../src/sim/weapons.js';
import { streakCost } from '../src/sim/core.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const detail = process.argv.includes('--detail');
const N = Number(args[0] || 20);
const modes = args[1] && args[1] !== 'all' ? args[1].split(',') : Object.keys(MODES);
const stages = args[2] && args[2] !== 'all' ? args[2].split(',') : STAGE_KEYS;
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0) + '%' : '-');
const avg = (a) => (a.reduce((x, y) => x + y, 0) / Math.max(1, a.length));
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

const TOTAL = {
  classN: {}, classKills: {}, classWin: {}, catN: {}, catKills: {}, catWin: {}, events: {}, rounds: [], matches: 0,
  steps: 0, roundsSeen: 0, groupsSum: 0, freeSum: 0, maxDepth: 0, streakUse: {}, streakReady: {}, legendKills: 0,
  // SIM-2
  pointsBy: {}, midN: 0, midEarned: [0, 0, 0, 0], midUsed: 0, midPoints: [], lateN: 0, lateEarned: 0,
  duels: 0, wardenDuels: 0, wardenWins: 0, duelRounds: 0, stageHits: 0, tideDeathsAboard: 0,
};
const catOf = (id) => weaponDef(id)?.cat || '?';

function run(stage, mode) {
  const st = {
    rounds: [], deaths: 0, tideDeaths: 0, shots: 0, hits: 0, grazes: 0, aimed: 0, grenade: 0, breach: 0, hunker: 0,
    overwatch: 0, owShots: 0, medkit: 0, coverBreak: 0, cache: 0, cachePick: 0, explosionKills: 0, cover: [0, 0, 0],
    flank: 0, firstKill: [], downed: 0, revive: 0, medRevive: 0, patch: 0, scan: 0, scanHits: 0, smoke: 0, bleed: 0,
    executes: 0, barrel: 0, barrelShot: 0, barrelKills: 0, flare: 0, kelpShots: 0, smokeShots: 0, ms: 0,
    classKills: {}, classN: {}, classWin: {}, streaks: 0, equip: 0,
  };
  for (let seed = 1; seed <= N; seed++) {
    const t0 = Date.now();
    const s = createGame({ seed: seed * 7919, mode, stage, noHuman: true });
    for (const u of s.units) {
      st.classN[u.cls] = (st.classN[u.cls] || 0) + 1;
      inc(TOTAL.classN, u.cls); inc(TOTAL.catN, catOf(u.weapons[0].id));
    }
    let guard = 0, firstKill = null;
    const downedNow = new Set();
    const tally = (evs) => {
      let lastSrc = null, lastWeapon = null;
      for (const e of evs) {
        inc(TOTAL.events, e.type);
        switch (e.type) {
          case 'downed': st.downed++; downedNow.add(e.id); break;
          case 'revive': st.revive++; downedNow.delete(e.id); if (s.units[e.by].cls === 'medic') st.medRevive++; break;
          case 'shot':
            st.shots++; if (e.result === 'hit') st.hits++; if (e.result === 'graze') st.grazes++;
            if (e.ability === 'aimed') st.aimed++; if (e.reaction) st.owShots++;
            if (e.cover !== undefined) st.cover[e.cover]++; if (e.flank) st.flank++;
            if (s.map.terrain[s.units[e.to].y * s.map.size + s.units[e.to].x] === 1) st.kelpShots++;
            if (s.smokes.some((c) => Math.hypot(c.x - s.units[e.to].x, c.y - s.units[e.to].y) <= c.radius
              || Math.hypot(c.x - s.units[e.from].x, c.y - s.units[e.from].y) <= c.radius)) st.smokeShots++;
            lastSrc = 'shot'; lastWeapon = e.weapon; break;
          case 'grenade': st.grenade++; st.equip++; break;
          case 'semtex': case 'knife': case 'flashbang': case 'stim': case 'claymore': case 'decoy': st.equip++; break;
          case 'breach': st.breach++; break;
          case 'hunker': st.hunker++; break;
          case 'overwatch': st.overwatch++; break;
          case 'heal': if (!e.source) st.medkit++; break;
          case 'cover_change': st.coverBreak++; break;
          case 'supply_drop': st.cache++; break;
          case 'crate': if (e.item === 'cache' || e.item === 'gold') st.cachePick++; break;
          case 'patch': st.patch++; break;
          case 'scan': st.scan++; st.scanHits += e.revealed.length; break;
          case 'smoke': st.smoke++; st.equip++; break;
          case 'barrel': st.barrel++; lastSrc = 'barrel'; break;
          case 'barrel_shot': st.barrelShot++; break;
          case 'flare': st.flare++; break;
          case 'bleed_out': st.bleed++; lastSrc = 'bleed'; break;
          case 'damage': if (lastSrc !== 'barrel') lastSrc = e.source; break;
          case 'zone_damage': lastSrc = 'tide'; break;
          case 'streak_used': st.streaks++; inc(TOTAL.streakUse, e.key); usedBy.set(e.id, (usedBy.get(e.id) || 0) + 1); break;
          case 'streak_points': inc(TOTAL.pointsBy, e.reason, e.add); break;
          case 'round_start':
            if (e.round === 8) midSet = s.units.filter((u) => u.alive).map((u) => u.id);
            if (e.round === 11) lateSet = s.units.filter((u) => u.alive).map((u) => u.id);
            break;
          case 'streak_ready': inc(TOTAL.streakReady, e.key); break;
          case 'step_start': TOTAL.steps++; break;
          case 'engagement':
            TOTAL.roundsSeen++; TOTAL.groupsSum += e.groups.length; TOTAL.freeSum += e.free.length;
            TOTAL.maxDepth = Math.max(TOTAL.maxDepth, ...e.groups.map((g) => g.length), 1);
            break;
          case 'death':
            st.deaths++;
            if (e.by === null) st.tideDeaths++;
            else if (lastSrc === 'barrel') st.barrelKills++;
            else if (lastSrc === 'explosion' || lastSrc === 'breach') st.explosionKills++;
            if (e.by !== null && lastSrc !== 'bleed') {
              const k = s.units[e.by];
              st.classKills[k.cls] = (st.classKills[k.cls] || 0) + 1;
              inc(TOTAL.classKills, k.cls);
              const w = e.weapon || lastWeapon;
              if (w) { inc(TOTAL.catKills, catOf(w)); if (weaponDef(w)?.legendary) TOTAL.legendKills++; }
            }
            if (lastSrc === 'shot' && downedNow.has(e.id)) st.executes++;
            if (firstKill === null) firstKill = s.round;
            break;
          default:
        }
      }
    };
    const readyBy = new Map(), usedBy = new Map();
    let midSet = [], lateSet = [];
    tally(s.startEvents);
    while (s.winner === null && guard++ < 5000) {
      const t = activeTeams(s)[0];
      for (const id of s.teams[t].members) tally(botTakeTurn(s, id));
      tally(endTeamTurn(s, t));
    }
    for (const u of s.units) {
      if (u.team !== s.winner) continue;
      st.classWin[u.cls] = (st.classWin[u.cls] || 0) + 1;
      inc(TOTAL.classWin, u.cls); inc(TOTAL.catWin, catOf(u.loadout.primary.id));
    }
    st.rounds.push(s.round);
    TOTAL.rounds.push(s.round);
    TOTAL.matches++;
    // Streaks earned over the match by players still alive at round 8 / 11 (their own 3 streaks).
    const earned = (id) => s.units[id].streaks.filter((k) => (s.units[id].points || 0) >= streakCost(s.units[id], k)).length;
    for (const id of midSet) {
      TOTAL.midN++; TOTAL.midEarned[earned(id)]++; TOTAL.midUsed += usedBy.get(id) || 0; TOTAL.midPoints.push(s.units[id].points || 0);
    }
    for (const id of lateSet) { TOTAL.lateN++; TOTAL.lateEarned += earned(id); }
    for (const d of s.pit.duels) {
      if (!d.done) continue;
      TOTAL.duels++; TOTAL.duelRounds += d.state.round;
      if (d.warden) { TOTAL.wardenDuels++; if (d.winner === null) TOTAL.wardenWins++; }
    }
    st.firstKill.push(firstKill ?? s.round);
    st.ms += Date.now() - t0;
  }
  return st;
}

const n = (st, k) => (st[k] / N).toFixed(1);
for (const stage of stages) {
  console.log(`\n=== ${stage} (${N} seeds per mode) ===`);
  console.log('mode    rounds(min-max)  tide%  boom%  hit/graze  aimed nade breach barrelShot(boom) flare smoke scan downed revive equip streak ms/match');
  for (const mode of modes) {
    const st = run(stage, mode);
    const r = [...st.rounds].sort((a, b) => a - b);
    console.log([
      mode.padEnd(7),
      `${avg(r).toFixed(1)} (${r[0]}-${r[r.length - 1]})`.padEnd(16),
      pct(st.tideDeaths, st.deaths).padStart(5),
      pct(st.explosionKills + st.barrelKills, st.deaths).padStart(6),
      `${pct(st.hits, st.shots)}/${pct(st.grazes, st.shots)}`.padStart(10),
      n(st, 'aimed').padStart(6), n(st, 'grenade').padStart(4), n(st, 'breach').padStart(6),
      `${n(st, 'barrelShot')}(${n(st, 'barrel')})`.padStart(16), n(st, 'flare').padStart(5),
      n(st, 'smoke').padStart(5), n(st, 'scan').padStart(4), n(st, 'downed').padStart(6), n(st, 'revive').padStart(6),
      n(st, 'equip').padStart(5), n(st, 'streaks').padStart(6),
      String(Math.round(st.ms / N)).padStart(8),
    ].join(' '));
    if (detail) {
      console.log(`   first kill r${avg(st.firstKill).toFixed(1)}  shots/match ${(st.shots / N).toFixed(0)}  reaction ${n(st, 'owShots')}  target cover open/half/full ${st.cover.join('/')}  flanked ${st.flank}`);
      console.log(`   shots at kelp targets ${n(st, 'kelpShots')}  shots into/out of smoke ${n(st, 'smokeShots')}  barrel kills ${n(st, 'barrelKills')}  bled out ${n(st, 'bleed')}  executed ${n(st, 'executes')}  medic revives ${n(st, 'medRevive')}  patch ${n(st, 'patch')}  revealed/scan ${(st.scanHits / Math.max(1, st.scan)).toFixed(1)}`);
      console.log(`   hunker ${n(st, 'hunker')}  overwatch ${n(st, 'overwatch')}  medkit ${n(st, 'medkit')}  cover destroyed ${n(st, 'coverBreak')}  caches ${n(st, 'cachePick')}/${n(st, 'cache')}`);
      console.log(`   per class (kills/unit, win share): ${Object.keys(st.classN).map((k) => `${k} ${((st.classKills[k] || 0) / st.classN[k]).toFixed(2)} ${pct(st.classWin[k] || 0, st.classN[k])}`).join('  ')}`);
    }
  }
}

// ---------- 5.0 totals ----------
const T = TOTAL;
const r = [...T.rounds].sort((a, b) => a - b);
const per = (k) => ((T.events[k] || 0) / T.matches).toFixed(1);
console.log(`\n=== 5.0 totals: ${T.matches} matches ===`);
console.log(`rounds avg ${avg(r).toFixed(1)}  median ${r[r.length >> 1]}  p10 ${r[Math.floor(r.length * 0.1)]}  p90 ${r[Math.floor(r.length * 0.9)]}  min ${r[0]} max ${r[r.length - 1]}`);
console.log(`engagement turns: ${(T.steps / T.roundsSeen).toFixed(2)} steps/round, ${(T.groupsSum / T.roundsSeen).toFixed(2)} groups/round, ${(T.freeSum / T.roundsSeen).toFixed(2)} free squads/round, largest group ${T.maxDepth}`);
const share = (kills, wins, N0) => {
  const tk = Object.values(kills).reduce((a, b) => a + b, 0), tw = Object.values(wins).reduce((a, b) => a + b, 0);
  const tn = Object.values(N0).reduce((a, b) => a + b, 0);
  return Object.keys(N0).sort().map((k) => {
    const pop = (N0[k] || 0) / tn;
    const ks = (kills[k] || 0) / Math.max(1, tk), ws = (wins[k] || 0) / Math.max(1, tw);
    return `  ${k.padEnd(9)} pop ${(pop * 100).toFixed(1).padStart(5)}%  kill share ${(ks * 100).toFixed(1).padStart(5)}% (x${(ks / pop).toFixed(2)})  win share ${(ws * 100).toFixed(1).padStart(5)}% (x${(ws / pop).toFixed(2)})`;
  }).join('\n');
};
console.log('per class (x = share / population share; 1.00 is fair):');
console.log(share(T.classKills, T.classWin, T.classN));
console.log('per primary weapon category:');
console.log(share(T.catKills, T.catWin, T.catN));
console.log(`legendary kills/match ${(T.legendKills / T.matches).toFixed(2)}  gold drops ${per('supply_drop')} supply drops/match`);
console.log(`ammo: reload ${per('reload')}  swap ${per('swap')}  noise ${per('noise')}  scavenge ${per('scavenge')}  /match`);
console.log(`class 5.0: suppress ${per('suppress')} (+${per('suppress_trigger')} reaction)  deploy_cover ${per('deploy_cover')}  run&gun ${per('run_gun_ready')}  /match`);
console.log(`equipment: frag ${per('grenade')}  semtex ${per('semtex')}  knife ${per('knife')}  claymore ${per('claymore')} (${per('claymore_trigger')} triggered)  smoke ${per('smoke')}  flashbang ${per('flashbang')}  stim ${per('stim')}  decoy ${per('decoy')}  /match`);
console.log(`streaks ready/used per match: ${Object.keys({ ...T.streakReady, ...T.streakUse }).sort().map((k) => `${k} ${((T.streakReady[k] || 0) / T.matches).toFixed(2)}/${((T.streakUse[k] || 0) / T.matches).toFixed(2)}`).join('  ')}`);
console.log(`streak effects: uav ${per('uav')}  care ${per('care_package')}  cuav ${per('cuav')}  airstrike ${per('airstrike')}  sentry shots ${per('sentry_shot')}  gunship shots ${per('gunship_shot')}  /match`);

// ---------- SIM-2: battlefield layer + streak points ----------
console.log(`\n=== battlefield (per match) ===`);
console.log(`boats: board ${per('board')}  disembark ${per('disembark')}  boat_move ${per('boat_move')}  hull hits ${per('vehicle_damage')}  destroyed ${per('vehicle_destroyed')}  repair ${per('repair')}  shots at boats ${per('shot_vehicle')}`);
console.log(`stage events: warned ${per('stage_event_warn')}  fired ${per('stage_event')}  knockback ${per('knockback')}  terrain changes ${per('terrain_change')}  hazard ends ${per('stage_event_end')}`);
console.log(`building collapses ${per('building_collapse')}  cover changes ${per('cover_change')}`);
console.log(`the Pit: entered ${per('pit_enter')}  duels ${per('pit_duel')} (warden ${(T.wardenDuels / T.matches).toFixed(1)}, warden wins ${pct(T.wardenWins, T.wardenDuels)})  avg duel rounds ${(T.duelRounds / Math.max(1, T.duels)).toFixed(1)}  redeploys ${per('redeploy')}  pit_out ${per('pit_out')}`);
const tp = Object.values(T.pointsBy).reduce((a, b) => a + b, 0);
console.log(`streak points/match ${(tp / T.matches).toFixed(1)}: ${Object.keys(T.pointsBy).sort().map((k) => `${k} ${(T.pointsBy[k] / T.matches).toFixed(1)}`).join('  ')}`);
const mp = [...T.midPoints].sort((a, b) => a - b);
const q = (p) => mp[Math.floor(p * (mp.length - 1))];
console.log(`alive at round 8 (${T.midN}): final points p25/median/p75 ${q(0.25)}/${q(0.5)}/${q(0.75)}  streaks earned avg ${((T.midEarned[1] + 2 * T.midEarned[2] + 3 * T.midEarned[3]) / Math.max(1, T.midN)).toFixed(2)} (0/1/2/3: ${T.midEarned.map((n) => pct(n, T.midN)).join('/')})  used avg ${(T.midUsed / Math.max(1, T.midN)).toFixed(2)}`);
console.log(`alive at round 11 (${T.lateN}): streaks earned avg ${(T.lateEarned / Math.max(1, T.lateN)).toFixed(2)}`);
