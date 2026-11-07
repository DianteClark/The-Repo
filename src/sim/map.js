import { makeRng } from './rng.js';
import { STAGES, SIGHT } from './constants.js';

// Map layers (all Uint8Array, index y*size+x):
//   cover:     0 = open, 1 = half cover (low object), 2 = full cover (wall).
//              Any tile with cover > 0 is impassable. Mutable at runtime (destruction).
//   terrain:   0 ground, 1 kelp (conceals), 2 shallow water (costs 2 movement).
//   explosive: 1 = this half-cover tile is a fuel barrel (Rig Graveyard).
// Plus: wallHeight (cosmetic only), sight (tiles), stage (key).

export function generateMap(seed, size, stageKey = 'harbor') {
  const stage = STAGES[stageKey] || STAGES.harbor;
  const g = stage.gen;
  const rng = makeRng(seed ^ 0x9e3779b9);
  const cover = new Uint8Array(size * size);
  const terrain = new Uint8Array(size * size);
  const explosive = new Uint8Array(size * size);
  const wallHeight = new Float32Array(size * size);
  const tall = new Uint8Array(size * size);
  const idx = (x, y) => y * size + x;
  const ri = (n) => Math.floor(rng() * n);
  const inside = (x, y, m = 1) => x >= m && y >= m && x < size - m && y < size - m;

  // Ruined buildings: rectangular walls with doorways.
  const buildings = Math.round((size / 4) * g.buildings) + ri(3);
  for (let b = 0; b < buildings; b++) hollowBuilding(4 + ri(3), 4 + ri(3), 2 + ri(Math.max(1, size - 10)), 2 + ri(Math.max(1, size - 10)));

  // Night Spires: tight clusters of narrow towers with alleys between them.
  for (let c = 0; c < g.clusters; c++) {
    const cx = 5 + ri(size - 10), cy = 5 + ri(size - 10);
    const n = 3 + ri(3);
    for (let i = 0; i < n; i++) {
      const w = 2 + ri(2), h = 2 + ri(2);
      const x0 = cx + ri(9) - 4, y0 = cy + ri(9) - 4;
      for (let x = x0; x < x0 + w; x++) {
        for (let y = y0; y < y0 + h; y++) {
          if (!inside(x, y, 2)) continue;
          cover[idx(x, y)] = 2;
          tall[idx(x, y)] = 1;
        }
      }
    }
  }

  // Shipping containers: solid 2-wide blocks, in rows with gaps.
  for (let i = 0; i < g.containers; i++) {
    const horiz = rng() < 0.5;
    const len = 3 + ri(3);
    const x0 = 2 + ri(size - 8), y0 = 2 + ri(size - 8);
    for (let k = 0; k < len; k++) {
      for (let j = 0; j < 2; j++) {
        const x = horiz ? x0 + k : x0 + j;
        const y = horiz ? y0 + j : y0 + k;
        if (inside(x, y, 1) && cover[idx(x, y)] === 0) cover[idx(x, y)] = 2;
      }
    }
  }

  // Free-standing wall segments.
  for (let i = 0; i < Math.round((size / 2) * g.walls); i++) {
    const len = 2 + ri(3);
    const horiz = rng() < 0.5;
    const x0 = 1 + ri(size - 2);
    const y0 = 1 + ri(size - 2);
    for (let k = 0; k < len; k++) {
      const x = horiz ? x0 + k : x0;
      const y = horiz ? y0 : y0 + k;
      if (inside(x, y) && cover[idx(x, y)] === 0) cover[idx(x, y)] = 2;
    }
  }

  // Scattered low cover: crates, wrecks, drums.
  const lows = [];
  for (let i = 0; i < Math.round(size * size * g.low); i++) {
    const x = ri(size);
    const y = ri(size);
    if (cover[idx(x, y)] === 0) { cover[idx(x, y)] = 1; lows.push(idx(x, y)); }
  }
  // Rig Graveyard: some of the low cover is fuel drums, often in pairs so they chain.
  if (g.barrels > 0) {
    for (const k of lows) {
      if (rng() >= g.barrels) continue;
      explosive[k] = 1;
      if (rng() < 0.45) {
        const x = k % size, y = (k / size) | 0;
        const [dx, dy] = [[1, 0], [-1, 0], [0, 1], [0, -1]][ri(4)];
        const nx = x + dx, ny = y + dy;
        if (inside(nx, ny) && cover[idx(nx, ny)] === 0) { cover[idx(nx, ny)] = 1; explosive[idx(nx, ny)] = 1; }
      }
    }
  }

  // Connectivity: keep the largest open region; seal smaller pockets.
  const comp = new Int32Array(size * size).fill(-1);
  const compSize = [];
  for (let s = 0; s < size * size; s++) {
    if (cover[s] !== 0 || comp[s] >= 0) continue;
    const id = compSize.length;
    let n = 0;
    const stack = [s];
    comp[s] = id;
    while (stack.length) {
      const k = stack.pop();
      n++;
      const x = k % size, y = (k / size) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const nk = idx(nx, ny);
        if (comp[nk] >= 0 || cover[nk] !== 0) continue;
        comp[nk] = id;
        stack.push(nk);
      }
    }
    compSize.push(n);
  }
  const main = compSize.indexOf(Math.max(...compSize));
  // Sealed pockets become low rubble: impassable, but they don't block sight.
  for (let k = 0; k < size * size; k++) if (cover[k] === 0 && comp[k] !== main) cover[k] = 1;

  // Open water (passable, costs 2) and kelp beds, grown as blobs on open ground.
  const openCount = cover.reduce((n, c) => n + (c === 0 ? 1 : 0), 0);
  if (g.water > 0) blobs(2, Math.round(openCount * g.water), 6 + ri(6));
  if (g.kelp > 0) blobs(1, Math.round(openCount * g.kelp), 9 + ri(6));

  // Cosmetic per-tile height for full walls (rendering only, never gameplay).
  for (let k = 0; k < size * size; k++) wallHeight[k] = tall[k] ? 2.2 + rng() * 1.6 : 0.95 + rng() * 0.35;

  return { size, cover, terrain, explosive, wallHeight, sight: stage.sight ?? SIGHT, stage: stage.key };

  function hollowBuilding(w, h, x0, y0) {
    if (x0 + w > size - 2 || y0 + h > size - 2) return;
    for (let x = x0; x < x0 + w; x++) {
      for (let y = y0; y < y0 + h; y++) {
        const edge = x === x0 || x === x0 + w - 1 || y === y0 || y === y0 + h - 1;
        cover[idx(x, y)] = edge ? 2 : 0;
      }
    }
    // doorways (never on corners), plus broken wall sections that become half cover
    const openings = 2 + ri(2);
    for (let d = 0; d < openings; d++) {
      const side = ri(4);
      let x, y;
      if (side < 2) {
        x = x0 + 1 + ri(w - 2);
        y = side === 0 ? y0 : y0 + h - 1;
      } else {
        y = y0 + 1 + ri(h - 2);
        x = side === 2 ? x0 : x0 + w - 1;
      }
      cover[idx(x, y)] = 0;
    }
    const broken = 1 + ri(2);
    for (let d = 0; d < broken; d++) {
      const x = x0 + ri(w);
      const y = rng() < 0.5 ? y0 : y0 + h - 1;
      if (cover[idx(x, y)] === 2 && x !== x0 && x !== x0 + w - 1) cover[idx(x, y)] = 1;
    }
  }

  /** Paint `total` open tiles with terrain `value`, in blobs of about `blob` tiles. */
  function blobs(value, total, blob) {
    let painted = 0, guard = 0;
    while (painted < total && guard++ < 400) {
      let x = ri(size), y = ri(size);
      if (cover[idx(x, y)] !== 0 || terrain[idx(x, y)] !== 0) continue;
      const want = Math.min(total - painted, blob + ri(blob));
      const frontier = [idx(x, y)];
      const seen = new Set(frontier);
      let n = 0;
      while (frontier.length && n < want) {
        const k = frontier.splice(ri(frontier.length), 1)[0];
        if (cover[k] !== 0 || terrain[k] !== 0) continue;
        terrain[k] = value;
        n++;
        x = k % size; y = (k / size) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const nk = idx(nx, ny);
          if (!seen.has(nk)) { seen.add(nk); frontier.push(nk); }
        }
      }
      painted += n;
    }
  }
}
