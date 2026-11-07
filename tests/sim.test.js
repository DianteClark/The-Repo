import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMap } from '../src/sim/map.js';
import { createGame, act, endTeamTurn, currentTeamId, aliveTeams } from '../src/sim/game.js';
import { botTakeTurn } from '../src/sim/ai.js';
import { losDirect, coverVs, hitChance } from '../src/sim/rules.js';
import { MODES } from '../src/sim/constants.js';

function emptyMap(size = 10) {
  return { size, cover: new Uint8Array(size * size), wallHeight: new Float32Array(size * size) };
}

/** Bot-plays a whole match, every unit (human slot included) driven by AI. */
function simulate(opts) {
  const state = createGame(opts);
  let guard = 0;
  while (state.winner === null && guard++ < 3000) {
    const t = currentTeamId(state);
    for (const id of state.teams[t].members) botTakeTurn(state, id);
    endTeamTurn(state);
  }
  return state;
}

test('map generation is deterministic', () => {
  const a = generateMap(42, 28), b = generateMap(42, 28);
  assert.deepEqual(a.cover, b.cover);
});

test('full walls block line of sight, half cover does not', () => {
  const m = emptyMap();
  m.cover[5 * 10 + 5] = 2;
  assert.equal(losDirect(m, 3, 5, 7, 5), false);
  m.cover[5 * 10 + 5] = 1;
  assert.equal(losDirect(m, 3, 5, 7, 5), true);
});

test('cover applies facing the attacker and flanking removes it', () => {
  const m = emptyMap();
  m.cover[5 * 10 + 6] = 1; // half cover east of (5,5)
  assert.equal(coverVs(m, 5, 5, 9, 5), 1); // attacker east
  assert.equal(coverVs(m, 5, 5, 5, 9), 0); // attacker south: flanked
});

test('hit chance stays within 5..95', () => {
  const s = createGame({ seed: 7 });
  const [a, b] = s.units;
  a.x = 1; a.y = 1; b.x = 2; b.y = 2;
  const { chance } = hitChance({ ...s, map: emptyMap(28) }, a, b);
  assert.ok(chance >= 5 && chance <= 95);
});

test('every mode has 16 players; trios has a lone wolf with extra AP/HP/armor', () => {
  for (const mode of Object.keys(MODES)) {
    const s = createGame({ mode, seed: 1 });
    assert.equal(s.units.length, 16, mode);
  }
  const s = createGame({ mode: 'trios', seed: 3, volunteerLoneWolf: true });
  assert.equal(s.teams.length, 6);
  const wolf = s.units.find((u) => u.isLoneWolf);
  assert.ok(wolf.isPlayer, 'volunteer becomes the lone wolf');
  assert.equal(wolf.maxAp, 3);
});

test('cannot act out of turn', () => {
  const s = createGame({ seed: 9 });
  const other = s.units.find((u) => u.team !== currentTeamId(s));
  assert.equal(act(s, other.id, { type: 'overwatch' }).ok, false);
});

test('same seed, same match', () => {
  const a = simulate({ seed: 1234, mode: 'duos', noHuman: true });
  const b = simulate({ seed: 1234, mode: 'duos', noHuman: true });
  assert.equal(a.winner, b.winner);
  assert.equal(a.round, b.round);
});

test('bot-only matches finish with a single winner in every mode', () => {
  for (const mode of Object.keys(MODES)) {
    for (let seed = 1; seed <= 6; seed++) {
      const s = simulate({ seed, mode, noHuman: true });
      assert.notEqual(s.winner, null, `${mode} seed ${seed} never ended`);
      assert.equal(aliveTeams(s).length, 1);
      assert.ok(s.round < 60, `${mode} seed ${seed} dragged to round ${s.round}`);
    }
  }
});
