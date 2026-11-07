// Balance report: node tests/stats.mjs [seedsPerCell=20] [modes=all] [stages=all] [--detail]
// Bot-only matches for every stage × mode. Prints a summary table per stage, and with
// --detail the full breakdown (hit rates, cover, per-class results, ability usage).
import { createGame, endTeamTurn, currentTeamId } from '../src/sim/game.js';
import { botTakeTurn } from '../src/sim/ai.js';
import { MODES, STAGE_KEYS } from '../src/sim/constants.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const detail = process.argv.includes('--detail');
const N = Number(args[0] || 20);
const modes = args[1] && args[1] !== 'all' ? args[1].split(',') : Object.keys(MODES);
const stages = args[2] && args[2] !== 'all' ? args[2].split(',') : STAGE_KEYS;
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0) + '%' : '-');
const avg = (a) => (a.reduce((x, y) => x + y, 0) / Math.max(1, a.length));

function run(stage, mode) {
  const st = {
    rounds: [], deaths: 0, tideDeaths: 0, shots: 0, hits: 0, grazes: 0, aimed: 0, grenade: 0, breach: 0, hunker: 0,
    overwatch: 0, owShots: 0, medkit: 0, coverBreak: 0, cache: 0, cachePick: 0, explosionKills: 0, cover: [0, 0, 0],
    flank: 0, firstKill: [], downed: 0, revive: 0, medRevive: 0, patch: 0, scan: 0, scanHits: 0, smoke: 0, bleed: 0,
    executes: 0, barrel: 0, barrelShot: 0, barrelKills: 0, flare: 0, kelpShots: 0, smokeShots: 0, ms: 0,
    classKills: {}, classN: {}, classWin: {},
  };
  for (let seed = 1; seed <= N; seed++) {
    const t0 = Date.now();
    const s = createGame({ seed: seed * 7919, mode, stage, noHuman: true });
    for (const u of s.units) st.classN[u.cls] = (st.classN[u.cls] || 0) + 1;
    let guard = 0, firstKill = null;
    const downedNow = new Set();
    const tally = (evs) => {
      let lastSrc = null;
      for (const e of evs) {
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
            lastSrc = 'shot'; break;
          case 'grenade': st.grenade++; break;
          case 'breach': st.breach++; break;
          case 'hunker': st.hunker++; break;
          case 'overwatch': st.overwatch++; break;
          case 'heal': st.medkit++; break;
          case 'cover_change': st.coverBreak++; break;
          case 'supply_drop': st.cache++; break;
          case 'crate': if (e.item === 'cache') st.cachePick++; break;
          case 'patch': st.patch++; break;
          case 'scan': st.scan++; st.scanHits += e.revealed.length; break;
          case 'smoke': st.smoke++; break;
          case 'barrel': st.barrel++; lastSrc = 'barrel'; break;
          case 'barrel_shot': st.barrelShot++; break;
          case 'flare': st.flare++; break;
          case 'bleed_out': st.bleed++; lastSrc = 'bleed'; break;
          case 'damage': if (lastSrc !== 'barrel') lastSrc = e.source; break;
          case 'zone_damage': lastSrc = 'tide'; break;
          case 'death':
            st.deaths++;
            if (e.by === null) st.tideDeaths++;
            else if (lastSrc === 'barrel') st.barrelKills++;
            else if (lastSrc === 'explosion' || lastSrc === 'breach') st.explosionKills++;
            if (e.by !== null && lastSrc !== 'bleed') {
              const c = s.units[e.by].cls; st.classKills[c] = (st.classKills[c] || 0) + 1;
            }
            if (lastSrc === 'shot' && downedNow.has(e.id)) st.executes++;
            if (firstKill === null) firstKill = s.round;
            break;
          default:
        }
      }
    };
    tally(s.startEvents);
    while (s.winner === null && guard++ < 5000) {
      const t = currentTeamId(s);
      for (const id of s.teams[t].members) tally(botTakeTurn(s, id));
      tally(endTeamTurn(s));
    }
    for (const u of s.units) if (u.team === s.winner) st.classWin[u.cls] = (st.classWin[u.cls] || 0) + 1;
    st.rounds.push(s.round);
    st.firstKill.push(firstKill ?? s.round);
    st.ms += Date.now() - t0;
  }
  return st;
}

const n = (st, k) => (st[k] / N).toFixed(1);
for (const stage of stages) {
  console.log(`\n=== ${stage} (${N} seeds per mode) ===`);
  console.log('mode    rounds(min-max)  tide%  boom%  hit/graze  aimed nade breach barrelShot(boom) flare smoke scan downed revive  ms/match');
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
      String(Math.round(st.ms / N)).padStart(9),
    ].join(' '));
    if (detail) {
      console.log(`   first kill r${avg(st.firstKill).toFixed(1)}  shots/match ${(st.shots / N).toFixed(0)}  reaction ${n(st, 'owShots')}  target cover open/half/full ${st.cover.join('/')}  flanked ${st.flank}`);
      console.log(`   shots at kelp targets ${n(st, 'kelpShots')}  shots into/out of smoke ${n(st, 'smokeShots')}  barrel kills ${n(st, 'barrelKills')}  bled out ${n(st, 'bleed')}  executed ${n(st, 'executes')}  medic revives ${n(st, 'medRevive')}  patch ${n(st, 'patch')}  revealed/scan ${(st.scanHits / Math.max(1, st.scan)).toFixed(1)}`);
      console.log(`   hunker ${n(st, 'hunker')}  overwatch ${n(st, 'overwatch')}  medkit ${n(st, 'medkit')}  cover destroyed ${n(st, 'coverBreak')}  caches ${n(st, 'cachePick')}/${n(st, 'cache')}`);
      console.log(`   per class (kills/unit, win share): ${Object.keys(st.classN).map((k) => `${k} ${((st.classKills[k] || 0) / st.classN[k]).toFixed(2)} ${pct(st.classWin[k] || 0, st.classN[k])}`).join('  ')}`);
    }
  }
}
