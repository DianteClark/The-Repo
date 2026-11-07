# Tidefall 1.0 — shared build spec

The contract between the four workstreams: **Sim**, **Graphics**, **UI/Camera** and **Audio**.
Each workstream owns its own files. Never edit another workstream's files. If you need
something from another workstream, code against this spec and note it in your report.

Fixed for 1.0:
- 16 players and one soldier per player.
- Modes: Solos, Duos, Trios (5×3 plus a Lone Wolf), Quads.
- 20-second squad turns.
- The browser game uses plain ES modules with no build step. Three.js 0.170 comes in through the importmap:
  `"three": "https://unpkg.com/three@0.170.0/build/three.module.js"`,
  `"three/addons/": "https://unpkg.com/three@0.170.0/examples/jsm/"`.
- Art direction is *Tidefall*: a drowned near-future archipelago with a teal, rust and bone world.
  Gameplay owns saturation. **Amber #ffb000 = your squad, magenta #ff3fa4 = enemies,
  cyan #7fe9ff = pickups and signals.** Nothing else in the world may use those.

## File ownership
| Workstream | Owns |
| --- | --- |
| Sim | `src/sim/*`, `tests/*` |
| Graphics | `src/client/render.js` and anything new under `src/client/gfx/` |
| UI/Camera | `index.html`, `styles.css`, `src/client/main.js`, anything new under `src/client/ui/` |
| Audio | `src/client/audio.js` and anything new under `src/client/sfx/` |

## 1. Sim additions (Sim implements; UI and Graphics consume)

### Unit fields (added)
- `items.frag`: number of grenades. Assault starts with 2, everyone else with 0. Crates can give `frag`.
- `cooldowns`: `{ aimed: 0, breach: 0 }`. These are rounds remaining, and they tick down at the start of the unit's team turn.
- `hunkered`: boolean. Cleared at the start of the unit's own team turn.

### Actions (`act(state, unitId, action)`)
Existing actions: `move {x,y}`, `shoot {targetId}`, `overwatch`, `medkit`, `hold`.

New actions:
- `grenade {x,y}`. Costs 1 AP, needs `items.frag > 0`. The target tile must be within **7** tiles (euclidean), seen by the team, and in line of sight from the thrower.
  - Hits radius **1.5** (the 3×3 area). Deals **3** damage, minus armor (minimum 1), to every unit in it. Allies are hit too, so friendly fire is on.
  - Cover inside the radius is **downgraded**: full becomes half, half becomes open.
  - Ignores cover. Does not end the turn.
- `aimed {targetId}`. Marksman only, cooldown 3. Works like `shoot` with **+15 aim and +2 damage**, and ends the turn.
- `breach {x,y}`. Breacher only, cooldown 3, costs 1 AP. The target is an adjacent tile (8-way) that has cover.
  - Sets that tile to open (0).
  - Deals **4** damage, minus armor, to enemy units within 1 tile of the target tile.
- `hunker`. Any class. Costs ≥1 AP and ends the turn. Sets `hunkered = true`.
  - While hunkered, cover penalties against you are doubled (half cover 40, full cover 80).
  - Graze is impossible against a hunkered unit in cover, so shots against them are either a hit or a miss.

### Preview / query helpers (exported from `src/sim/game.js`)
- `grenadeTargets(state, u)` → `Set<tileKey>` of valid target tiles (`key = y*size + x`).
- `grenadePreview(state, u, x, y)` → `{ valid, units: [{id, dmg, lethal}], cover: [{x,y,from,to}] }`.
- `breachTargets(state, u)` → `Set<tileKey>`.
- `aimedPreview(state, u, target)` → same shape as `shotPreview`, with the ability modifiers applied.
- `abilityInfo(u)` → `[{ key:'grenade'|'aimed'|'breach'|'hunker', name, desc, ready:boolean, reason?:string, charges?:number, cooldown?:number }]`.
- Existing exports keep working: `shotPreview`, `moveOptions`, and the rest.

### Events (new; every event is a plain object)
- `{type:'grenade', id, x, y, radius}`: the throw. Immediately followed by the damage and cover events below.
- `{type:'damage', id, dmg, source:'explosion'|'breach'}`: possibly followed by `death`.
- `{type:'cover_change', x, y, from, to}`: the tile's cover level changed (destruction).
- `{type:'breach', id, x, y}`
- `{type:'hunker', id}`
- `shot` events gain `ability: 'aimed' | undefined` and `cover: 0|1|2` (the target's cover against this shot) and `flank: boolean`.
- `{type:'supply_drop', crate}`: at the start of rounds **4, 8 and 12**, a `cache` crate lands at a random open tile inside the next zone. Picking up a cache gives **+1 scope, +1 barrel and +1 frag**, capped as usual.
- `crate` events can now carry `item: 'frag' | 'cache'`.

### Balance and AI
- Bots use grenades when 2 or more enemies are in the blast, or when an enemy is in full cover and the grenade breaks it.
- Bots use aimed shots when they're ready.
- Bots hunker when their HP is at or below 40% and they're exposed with no good shot.
- Matches must still always end. Keep the bot-only all-mode test, and add tests for every new action.

## 2. Renderer API (Graphics implements; UI consumes)

`new Renderer(canvas, hooks)`. Hooks:
- `sfx`: an Audio instance.
- `onTileTap(x,y)`
- `onUnitTap(id)`
- `onTileHover(x,y)|null`: desktop hover.
- `onFeed(msg)`

Methods:
- `setGame(state, myTeam)`, `playEvent(ev) → Promise` for **every** event type, including the new ones above.
- `syncFromState()`, `setSpectator(bool)`, `speed` (number, playback multiplier), `myRef()`, `isUnitVisible(id)`, `visibleToMe(x,y)`.
- `focus(x,y,instant?)`, `rotate(dir)`, `zoomBy(factor)`, `setFollow(unitId|null)`.
- `setHighlights(Map<key,1|2>|null)`: move range. 1 = one AP, 2 = dash.
- `setPathPreview(path:[[x,y],...]|null, cost:1|2)`: draws the route, plus cover shields at the destination.
- `setAoePreview({x,y,radius,valid}|null)`
- `setTargetMarkers([{id, chance}]|null)`: floating hit-% badges over targetable enemies.
- `setSelectedTarget(id|null)`: aim line from the active unit to the target, with the camera framing both.
- `setQuality('high'|'low')`: low turns off post-processing and shadows for weak phones. The renderer should auto-pick a quality.
- `setCinematic(bool)`: action cam on shots and kills. On by default.

## 3. Audio API (Audio implements; Graphics and UI call)
- `resume()`, `toggle() → muted`, `setVolume(0..1)`.
- `setIntensity(0..1)`: adaptive music driver. UI calls it from squads left, zone stage and nearby enemies.
- `startMusic()`, `stopMusic()`, `stinger('victory'|'defeat'|'round'|'tide')`.
- SFX:
  - Combat: `shot(far, weapon:'rifle'|'longrifle'|'shotgun')`, `hit(graze)`, `miss()`, `death()`, `explosion(far)`, `grenadeThrow()`, `breach()`, `hunker()`.
  - Movement and world: `step()`, `pickup()`, `tripwire()`, `tide()`.
  - Turn and UI: `turn()`, `tick(urgent)`, `uiClick()`, `uiHover()`, `uiError()`.
- Every method must be safe to call before `resume()` and when muted (no-op).

## 4. UI/Camera owns the match flow
`main.js` drives the match: the menu, turns, input modes (move / shoot / grenade / aimed / breach), HUD and end screen.

Mobile-first:
- Tap to preview, tap again (or the confirm button) to commit.
- Keep the 20-second timer, the Lone Wolf volunteer option and wake lock.

## Testing
- Sim: `npm test`.
- Browser: `/home/claude/smoke.py` shows how to drive headless Chrome against a local server. Route every request under `https://unpkg.com/three@0.170.0/` to the local copy at `/tmp/deps/node_modules/three/` (build/ and examples/jsm/ are both there).
- Use `?debug` to get `window.__dbg`.
- Look at screenshots of your own work before you call it done.
