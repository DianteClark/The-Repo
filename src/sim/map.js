import { makeRng } from './rng.js';

// cover values: 0 = open, 1 = half cover (low object), 2 = full cover (wall).
// Any tile with cover > 0 is impassable.

export function generateMap(seed, size) {
  const rng = makeRng(seed ^ 0x9e3779b9);
  const cover = new Uint8Array(size * size);
  const idx = (x, y) => y * size + x;
  const ri = (n) => Math.floor(rng() * n);

  // Ruined buildings: rectangular walls with doorways.
  const buildings = Math.round(size / 4) + ri(3);
  for (let b = 0; b < buildings; b++) {
    const w = 4 + ri(3);
    const h = 4 + ri(3);
    const x0 = 2 + ri(size - w - 4);
    const y0 = 2 + ri(size - h - 4);
    for (let x = x0; x < x0 + w; x++) {
      for (let y = y0; y < y0 + h; y++) {
        const edge = x === x0 || x === x0 + w - 1 || y === y0 || y === y0 + h - 1;
        if (edge) cover[idx(x, y)] = 2;
        else cover[idx(x, y)] = 0;
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

  // Free-standing wall segments.
  for (let i = 0; i < Math.round(size / 2); i++) {
    const len = 2 + ri(3);
    const horiz = rng() < 0.5;
    const x0 = 1 + ri(size - 2);
    const y0 = 1 + ri(size - 2);
    for (let k = 0; k < len; k++) {
      const x = horiz ? x0 + k : x0;
      const y = horiz ? y0 : y0 + k;
      if (x > 0 && y > 0 && x < size - 1 && y < size - 1 && cover[idx(x, y)] === 0) cover[idx(x, y)] = 2;
    }
  }

  // Scattered low cover: crates, barrels, wrecks.
  for (let i = 0; i < Math.round(size * size * 0.09); i++) {
    const x = ri(size);
    const y = ri(size);
    if (cover[idx(x, y)] === 0) cover[idx(x, y)] = 1;
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

  // Cosmetic per-tile height for full walls (rendering only, never gameplay).
  const wallHeight = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) wallHeight[k] = 0.95 + rng() * 0.35;

  return { size, cover, wallHeight };
}
