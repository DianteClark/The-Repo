# Tidefall 2.0 — shared build spec (extends V1_SPEC.md)

Everything in V1_SPEC still applies, including file ownership, colour rules and testing.
This doc adds the 2.0 contract. The four workstreams run in parallel again.
**Never edit another workstream's files.**

Ownership changes for 2.0:
- **Graphics** also owns `assets/icon/`, the app icon.
- **UI** also owns `manifest.webmanifest`, `sw.js`, and anything new at the repo root for the PWA.

## Known bugs to fix (all workstreams: scrub your own code for more)
- **Graphics:** the overwatch vision cone appears *behind* the soldier. It must point the way the soldier faces. That means the nearest enemy the team can see, or else the last direction the soldier moved or aimed. Audit every directional effect the same way: muzzle flash, recoil, tracers, aim line, cover shields.
- **Everyone:** look for stale state when starting a new match, double-firing input, effects that never despawn, camera fights between follow, cinematic and user pan, and timers that keep running in the background.

## 1. Sim 2.0 (Sim)

### New classes (5 total)

| key | name | hp | armor | move | weapon (range/aim/dmg) | ability |
| --- | --- | --- | --- | --- | --- | --- |
| `medic` | Medic | 9 | 0 | 6 | SMG 7 / 66 / 2–4 | **Patch**: 1 AP, cooldown 2. Heals 5, targeting self or an adjacent ally. On a downed ally it revives them at 4 HP |
| `recon` | Recon | 8 | 0 | 7 | Carbine 10 / 66 / 3–4 | **Scan**: 1 AP, cooldown 3. Pick a tile within 12 tiles, no line of sight needed. Reveals every unit within radius 5 of it to the Recon's team until the Recon's team's next turn starts |

Keys stay stable: `assault`, `marksman`, `breacher`, `medic`, `recon`.

### Downed and revive (team modes only, teamSize > 1)
A unit that drops to 0 HP while any teammate is still standing becomes **downed** instead of dying.
- **Fields:** `downed = true`, `hp = 0`, `bleed = 2`. The `bleed` counter is the number of the unit's own team turns left.
- **Restrictions:** downed units can't act. They don't count as cover-blockers for pathing, but they still occupy their tile.
- **Revive:** any adjacent standing teammate can revive with action `revive {targetId}`. It costs 1 AP and brings the unit back at 3 HP. A Medic's `patch` also revives, at 4 HP.
- **Execute:** any hit (or explosion, or tide) on a downed unit kills it. The `death` event follows.
- **Bleed out:** at the end of the downed unit's team turn, `bleed` goes down by 1. At 0 the unit dies, and the event is `bleed_out` followed by `death`.
- **Team wipe:** a team whose members are all dead or downed is eliminated, and its downed members die. Fire `team_out` as before.
- **Solos:** units die immediately, with no downed state.

### Smoke grenades
- **Items:** new item `items.smoke`. Recon starts with 1, everyone else with 0. Crates can give `smoke` (add it to `CRATE_TABLE` and `CRATE_LABEL`).
- **Action:** `smoke {x,y}`. Costs 1 AP. Same range and line-of-sight rules as a frag. Makes a cloud of radius 1.5.
- **Effect:** while a unit stands inside the cloud, it gets **+25 defense** (a separate bonus that stacks with cover).
- **Duration:** the cloud lasts until the start of the thrower's team turn in the next round.
- **State:** clouds are stored in `state.smokes = [{id, x, y, radius, team, expiresRound, expiresTeam}]`.

### New events
- `{type:'downed', id, by}`
- `{type:'revive', id, by, hp}`
- `{type:'bleed_out', id}` (always followed by `death`)
- `{type:'patch', id, target, amount}` (the target may be the medic itself)
- `{type:'scan', id, x, y, radius, revealed:[unitIds]}`
- `{type:'reveal_end', team}`
- `{type:'smoke', id, x, y, radius, smokeId}`
- `{type:'smoke_clear', smokeId}`
- `shot` and `damage` events now also carry `downed: boolean` (true when the hit downed the target rather than killing it).

### Visibility
`teamSeesUnit` also returns true for units revealed by an active scan. Renderers and UIs should keep calling the same helpers.

### Helpers
- `abilityInfo` covers `patch`, `scan`, `smoke` and `revive`.
- `patchTargets(state,u)`, `scanPreview(state,u,x,y)` → `{valid, units:[visible-after-scan count only, no ids of hidden units]}`.
- `smokeTargets(state,u)`, `reviveTargets(state,u)` → `Set<key>`.

### AI
Bots must use all of the new tools:
- Revive downed teammates when it's safe enough.
- Medics patch.
- Recon scans before advancing.
- Throw smoke over themselves or allies who are exposed and wounded.
- Finish off downed enemies when the shot is good.

### Tests
- Unit tests for every new rule.
- The bot-only test across all modes must still always end.
- The stats script reports usage of every new feature.

## 2. Renderer 2.0 additions (Graphics)
- **Play every new event:**
  - `downed`: a slumped pose with a pulsing red-free "bleed" ring that shows the bleed counter.
  - `revive`: a stand-up with a cyan shimmer.
  - `patch`: a healing pulse.
  - `scan`: an expanding radar sweep at the target. Revealed units get a magenta outline through fog until `reveal_end`.
  - `smoke`: a volumetric-looking particle cloud that persists until `smoke_clear`.
  - `bleed_out`
- **New unit silhouettes:** Medic (cross-marked satchel, short SMG) and Recon (hood, drone backpack, carbine). Their class shapes must stay distinct at 40px.
- **Menu showcase:** `setMenuShowcase(on: boolean)` gives a cinematic slow orbit or dolly over the map, with depth of field (high quality only) and dramatic light, for the title screen. The UI calls it while the menu is open.
- **Previews:**
  - `setAoePreview` takes a new optional `kind: 'frag'|'smoke'|'scan'`, which changes the colour and style.
  - New `setReviveMarkers(ids|null)`.
- **App icon:** in `assets/icon/`, deliver `favicon.svg`, `icon-180.png` (apple-touch), `icon-192.png`, `icon-512.png` and `icon-maskable-512.png`, with the safe zone respected.
  - Bold, readable at 48px, recognisably *Tidefall*.
  - Suggested direction: a curling woodblock-style storm wave in teal and bone, with a lone amber soldier silhouette or crosshair on the crest, on a deep teal background.
  - Render the PNGs from an SVG master with headless Chrome. Look at them at small sizes.
- **Art depth:** more prop and ground variety, environmental storytelling (beached boats, flooded cars, signage), better soldier models and animation, plus richer weather and lighting by tide stage. Keep phone performance in check.

## 3. Audio 2.0 additions (Audio)
- **New SFX:** `smoke()`, `revive()`, `downed()`, `patch()`, `scan()`, `bleedOut()`.
- **Ambience:** `setAmbience({stage:0..1, rain:0..1})`. Waves, wind and gulls early; rain and storm late.
- **Menu theme:** `startMenuMusic()`, a hooky, distinct title theme that crossfades into the match score on `startMusic()`.
- **Stinger:** `stinger('downed')`.

## 4. UI 2.0 (UI)
- **Title screen, much bigger:**
  - Uses `setMenuShowcase`.
  - Animated logo with a water or light sweep, parallax, ambient particles, and a "2.0" badge.
  - A class carousel covering all 5 classes.
  - A callsign entry box (saved), and a career stats strip (wins, kills, best placement, saved in localStorage).
  - A first-launch tutorial or tips.
- **Match intro:** a "DROP IN" sequence showing your squad cards and a countdown.
- **New controls:**
  - Action-bar buttons and input modes for Patch, Scan, Smoke and Revive, with AoE previews (`kind`).
  - A downed-teammate alert with a revive prompt.
  - A bleed-out counter.
- **Juice:**
  - Haptics (`navigator.vibrate`) on hits, kills and turn start, with a toggle in settings.
  - Damage-direction indicators.
  - Smoother screen transitions and turn-handoff transitions.
- **PWA:**
  - `manifest.webmanifest` (name Tidefall, standalone, portrait-primary or any, theme colour, the icons from `assets/icon/`).
  - apple-touch-icon and apple-mobile-web-app tags, a favicon, and a simple `sw.js` that caches the app shell and three.js for offline play after the first visit.
  - Everything must work under the GitHub Pages subpath `/The-Repo/`, so use relative URLs throughout.
