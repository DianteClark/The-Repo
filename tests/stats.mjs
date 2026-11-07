// Balance report: node tests/stats.mjs [seedsPerMode=20]
// Bot-only matches in every mode; prints rounds, kill sources, hit rates and ability usage.
import { createGame, endTeamTurn, currentTeamId } from '../src/sim/game.js';
import { botTakeTurn } from '../src/sim/ai.js';
import { MODES } from '../src/sim/constants.js';

const N = Number(process.argv[2] || 20);
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0) + '%' : '-');

for (const mode of Object.keys(MODES)) {
  const st = { rounds: [], deaths: 0, tideDeaths: 0, shots: 0, hits: 0, grazes: 0, aimed: 0, grenade: 0,
    breach: 0, hunker: 0, overwatch: 0, owShots: 0, medkit: 0, coverBreak: 0, cache: 0, cachePick: 0,
    expDmg: 0, explosionKills: 0, ff: 0, cover: [0, 0, 0], flank: 0, firstKill: [] };
  for (let seed = 1; seed <= N; seed++) {
    const s = createGame({ seed: seed * 7919, mode, noHuman: true });
    let guard = 0, firstKill = null;
    const tally = (evs) => {
      let lastSrc = null;
      for (const e of evs) {
        if (e.type === 'shot') {
          st.shots++; if (e.result === 'hit') st.hits++; if (e.result === 'graze') st.grazes++;
          if (e.ability === 'aimed') st.aimed++; if (e.reaction) st.owShots++;
          if (e.cover !== undefined) st.cover[e.cover]++; if (e.flank) st.flank++;
          lastSrc = 'shot';
        } else if (e.type === 'grenade') st.grenade++;
        else if (e.type === 'breach') st.breach++;
        else if (e.type === 'hunker') st.hunker++;
        else if (e.type === 'overwatch') st.overwatch++;
        else if (e.type === 'heal') st.medkit++;
        else if (e.type === 'cover_change') st.coverBreak++;
        else if (e.type === 'supply_drop') st.cache++;
        else if (e.type === 'crate' && e.item === 'cache') st.cachePick++;
        else if (e.type === 'damage') { lastSrc = e.source; if (e.source === 'explosion') st.expDmg++; }
        else if (e.type === 'zone_damage') lastSrc = 'tide';
        else if (e.type === 'death') {
          st.deaths++;
          if (e.by === null) st.tideDeaths++;
          else if (lastSrc === 'explosion' || lastSrc === 'breach') st.explosionKills++;
          if (firstKill === null) firstKill = s.round;
        }
      }
    };
    tally(s.startEvents);
    while (s.winner === null && guard++ < 4000) {
      const t = currentTeamId(s);
      for (const id of s.teams[t].members) tally(botTakeTurn(s, id));
      tally(endTeamTurn(s));
    }
    st.rounds.push(s.round);
    st.firstKill.push(firstKill);
  }
  const r = [...st.rounds].sort((a, b) => a - b);
  const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
  console.log(`\n== ${mode} (${N} seeds) ==`);
  console.log(`rounds avg ${avg(r)}  median ${r[r.length >> 1]}  min ${r[0]}  max ${r[r.length - 1]}  first kill avg r${avg(st.firstKill)}`);
  console.log(`deaths ${st.deaths}  tide ${pct(st.tideDeaths, st.deaths)}  explosive ${pct(st.explosionKills, st.deaths)}`);
  console.log(`shots ${st.shots} (${(st.shots / N).toFixed(0)}/match)  hit ${pct(st.hits, st.shots)}  graze ${pct(st.grazes, st.shots)}  miss ${pct(st.shots - st.hits - st.grazes, st.shots)}  reaction ${st.owShots}`);
  console.log(`target cover open/half/full ${st.cover.join('/')}  flanked ${st.flank}`);
  console.log(`per match: aimed ${(st.aimed / N).toFixed(1)}  grenades ${(st.grenade / N).toFixed(1)}  breach ${(st.breach / N).toFixed(1)}  hunker ${(st.hunker / N).toFixed(1)}  overwatch ${(st.overwatch / N).toFixed(1)}  medkit ${(st.medkit / N).toFixed(1)}  cover destroyed ${(st.coverBreak / N).toFixed(1)}  caches ${(st.cachePick / N).toFixed(1)}/${(st.cache / N).toFixed(1)}`);
}
