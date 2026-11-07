# Tidefall 3.0 — shared build spec (extends V1 + V2)

User requests driving 3.0:
- Class badges instead of stick figures, with 5 prestige tiers per class.
- Multiple stages, each with a unique twist, and bigger maps.
- Cover fades out while you choose where to move.
- Every squad gets its own colour.
- A shop for skins, kill effects and drop-in animations.
- A redone app icon.
- Smoke hides units and reduces aim.
- AP stays as is: firing ends the turn, by design (XCOM rule).

Ownership is unchanged except for the new shared folder:
- **Sim:** `src/sim/*` and `tests/*`.
- **Graphics:** `render.js`, `gfx/`, `assets/icon/`, and the new **`src/shared/`** (colours and cosmetics catalog).
- **UI:** `index.html`, `styles.css`, `main.js`, `ui/`, `manifest.webmanifest` and `sw.js`.

Never edit another workstream's files. When you add files, UI must add them to the `sw.js` precache list (Graphics: tell UI in your report).

## 1. Stages (Sim)
`createGame({..., stage})`. `stage` is one of the 5 keys below or `'random'`. Export `STAGES` from `constants.js` as an object of `{ key, name, tagline, twist, size, ... }`. Store `state.stage` as the stage key.

Every map is **44×44**, up from 34. Tune spawns, crate counts (scaled to area), zone start radius and step so matches still run about 13–17 rounds. Map generation is stage-specific: building density, prop mix and open water vary by stage.

| key | name | twist (mechanics) |
| --- | --- | --- |
| `harbor` | Drowned Harbor | The classic tide from the edges. Docks and containers, dense hard cover. |
| `kelp` | Kelp Shallows | **Kelp beds** cover about 15% of open tiles (`map.terrain` value 1). A unit standing in kelp can't be seen by enemies more than 3 tiles away, and shots at it take -10 aim. Kelp is passable and gives no cover. Little hard cover overall. |
| `rig` | Rig Graveyard | **Explosive barrels**: some half-cover tiles are explosive (`map.explosive` Uint8Array). A frag, breach or another explosion within radius 1.5 detonates a barrel, dealing 4 damage in radius 1.5. Barrels can chain. Event `{type:'barrel', x, y}`, followed by `damage`, `cover_change` and further `barrel` events. A barrel can also be **shot** with action `shoot_barrel {x,y}` (1 AP, ends the turn, needs line of sight and range, always hits). |
| `spire` | Night Spires | **Night**: sight drops to 6. Firing reveals the shooter to *all* teams until the start of the shooter's next team turn (`state.flares`, event `{type:'flare', id}` and `{type:'flare_end', id}`). More vertical building clusters. |
| `surge` | Surge Point | **Drifting zone**: the safe circle's centre moves at every shrink toward a final point near one side, so squads must rotate across the map. Event `zone_shrink` gains `x` and `y`. |

Map layers are generic: `map.terrain` is a Uint8Array (0 ground, 1 kelp, 2 shallow water, which costs 2 movement). `map.explosive` is a Uint8Array. Both exist on every stage, all zeros where unused.

## 2. Smoke rework (Sim)
- **Hiding:** a unit inside smoke is **not visible to enemies** unless the enemy is within 1.5 tiles of it. This applies to `teamSeesUnit` and to targeting. Scan still reveals.
- **Firing out:** shooting from inside smoke takes **-20 aim**.
- **Firing in:** shooting at a smoked target that is visible (because it's adjacent) takes -20 aim. This replaces the +25 defense.
- **Throwing smoke** doesn't end the turn, and smoke still lasts as in V2.
- **AI:** bots use smoke to break line of sight and to approach.

## 3. Squad colours (Graphics owns `src/shared/colors.js`)
- `squadColor(teamId, myTeam) → '#rrggbb'`.
- **Your squad is always amber `#ffb000`.**
- The other squads take 15 distinct, saturated hues spread around the colour wheel, avoiding amber (35–50°) and cyan (180–195°), which stay reserved for you and for signals/pickups.
- Also export `SQUAD_PALETTE`.
- **Where Graphics uses them:** unit rings, visors, armbands, labels and tracers.
- **Where UI uses them:** the turn strip, kill feed, minimap and target panel.
- Enemy hit-% badges and danger signals may still use magenta accents.

## 4. Cosmetics (Graphics owns `src/shared/cosmetics.js`, the catalog plus rendering)
```js
export const COSMETICS = {
  skins:   [{ id, name, rarity:'common'|'rare'|'epic'|'legendary', price, classes:'all'|[keys], desc }],
  killFx:  [{ id, name, rarity, price, desc }],
  dropIns: [{ id, name, rarity, price, desc }],
};
export const DEFAULT_LOADOUT = { skin:'default', killFx:'default', dropIn:'default' };
```
- **Catalog size:** at least 10 skins, 6 kill effects and 6 drop-ins. Each slot includes a free `default`. Prices are in **Salvage**, roughly 150 for common up to 2500 for legendary.
- **Skins:** change body and gear materials, patterns, helmets and decals. They must **never** change the class silhouette or the squad-colour ring, visor and armband.
- **Kill effects:** play on the victim when the cosmetic owner gets a kill, for example tidal splash, ember burst, gold salvage coins, holo glitch, lightning strike and kelp bloom.
- **Drop-ins:** how a unit arrives at match start, for example parachute, boat beach-landing, grapple from a gunship, sea-surface breach, orbital beacon and gull flock.

Renderer API additions:
- `setGame(state, myTeam, { cosmetics: { [unitId]: { skin, killFx, dropIn } } })`. Bots get random cosmetics for flavour.
- `playDropIn() → Promise`: all units arrive using their drop-in. Keep it about 3 s or less, and make it skippable via `skipDropIn()`.
- `renderPreview(canvas, { cls, skin, killFx?, dropIn?, color })`: a small turntable or vignette preview for the shop and locker. It can loop. Also add `stopPreview(canvas)`.

## 5. Cover fade while moving (Graphics, called by UI)
- `setCoverFade(on:boolean)`. While on, every cover prop fades to near-invisible (~0.06 opacity). Each prop leaves a crisp ground **footprint outline** with a half or full shield glyph, so movable tiles are fully readable.
- Fade in and out over 150 ms.
- **UI** turns it on in Move mode while a path preview or move range is showing, and off in other modes.

## 6. Stage visuals (Graphics)
- Each stage has its own palette, lighting and props:
  - Harbor: golden day.
  - Kelp: green shallows, with swaying kelp meshes on terrain=1 tiles.
  - Rig: rust and oil platforms, with red-banded explosive barrels.
  - Spire: night with neon spill.
  - Surge: violent storm.
- Render `barrel` explosions and chains, `flare` (a bright beacon above the revealed shooter), and smoke that actually hides units: enemies inside are invisible unless the sim says they're visible.
- The 44×44 maps must hold performance. Use chunked/instanced geometry and frustum culling, and tighten auto-quality.

## 7. App icon redo (Graphics)
- The user asked for a redo, so try a different direction from the woodblock wave.
- Produce **3 distinct concepts** as `assets/icon/concepts/A.png`, `B.png` and `C.png`, plus a comparison sheet at 48, 96 and 180px.
- Pick the strongest as the shipped set: the same five filenames as V2.
- Aim for a bold silhouette, few shapes, strong contrast, and nothing that looks generic. It must be readable at 48px.

## 8. Meta (UI)
- **Class badges** (`src/client/ui/badges.js`): an SVG badge per class, replacing the stick figures everywhere (carousel, unit card, end screen, squad cards). There are 5 tiers: **Recruit, Veteran, Elite, Master, Legend**.
  - Badges escalate with tier: Recruit is a basic stamped emblem; later tiers add metal, wings or laurels, gems, and then an animated holographic legend.
  - `badgeSVG(cls, tier, {size, animated})`.
- **Class prestige:** XP per class, earned from matches played with that class (placement, kills, damage, revives). 5 tier thresholds, with a progress bar per class and a tier-up celebration on the end screen. Store in localStorage.
- **Salvage currency:** earned per match from placement, kills and wins.
- **Shop:** featured items, tabs for Skins, Kill FX and Drop-ins, rarity styling, and previews via `renderPreview`. Buy with Salvage only; there is no real money.
- **Locker:** equip items. The equipped loadout is passed to `setGame` cosmetics for the player's unit.
- **Stage select** on the title flow, with a card per stage showing its twist, plus a Random option.
- The DROP IN intro calls `R.playDropIn()`.
- **New actions and states:**
  - Shooting a barrel: in Shoot mode, barrels are targetable.
  - Flare warnings.
  - Kelp and smoke "hidden" indicators on the unit card.
- Use squad colours everywhere.
- Update the "How to play" content and tutorial with the new mechanics.

## 9. Sim AI and tests
Bots must:
- shoot barrels near clustered enemies
- respect flares (attack revealed shooters)
- use kelp for approach
- rotate with the drifting zone

Tests must cover every stage twist, the smoke rework and determinism. The bot-only test must cover every stage × mode and always end.
