# Tidefall (working title)

**▶ Play now: https://dianteclark.github.io/The-Repo/**

A 16-player, turn-based, XCOM-style battle royale that runs in the browser.
One soldier per player. Rival salvage crews fight across a drowning archipelago
while the storm tide (**the Surge**) floods the map from the edges in.

> **Status: v1.0.** Single device against 15 bots. Online invite-code lobbies are the next build.

## Play it

- **Locally:** `npm start`, then open http://localhost:8080. Or use any static file server; there's no build step.
- **Online:** https://dianteclark.github.io/The-Repo/ — every push to `main` redeploys it through GitHub Pages.

**Controls:**
- Tap a tile to move: cyan costs 1 AP, gold is a 2 AP dash.
- Tap a visible enemy to aim, then **Fire**. Firing ends your turn.
- Drag to pan the map. Pinch or scroll to zoom. ⟲ ⟳ rotate the camera.

## What's in 1.0

| Area | Details |
| --- | --- |
| Modes | Solos 16×1 · Duos 8×2 · Trios 5×3 + 1 **Lone Wolf** (+1 AP, +50% HP, +1 armor; volunteer in the menu) · Quads 4×4 |
| Turns | Each squad gets **20 s**. Teammates act in the same window, and the clock pauses while your own action animates. When time runs out, your unit goes on overwatch |
| Actions | Move/dash · Shoot · Frag grenade (destroys cover) · Aimed Shot (Marksman) · Breach charge (Breacher) · Hunker · Overwatch · Medkit |
| Combat | Destructible cover · flanking (+aim, +damage) · step-out line of sight · graze band · visible miss-streak bonus · seeded rolls |
| Loot | You drop in with your class weapon. Crates hold medkits, armor, frags, scopes and barrels. **Supply caches** fall on rounds 4, 8 and 12 |
| The Surge | The tide floods in every 2 rounds and its damage grows. The storm grade, rain and lightning intensify late game |
| Graphics | Stylized diorama: ACES, soft shadows, bloom, animated water and tide, prop-based cover, debris, action cam, hit-stop. Auto quality (`?gfx=low\|high` to force) |
| Audio | Fully synthesized weapons per class, explosions, radio-style UI, adaptive music |
| UI | Tap to preview, tap again to confirm. Hit-% badges, grenade AoE preview, minimap, kill feed, turn-order strip, spectator mode, and keyboard shortcuts on desktop |

## Layout

```
index.html, styles.css    page + HUD (Three.js loaded from a CDN via importmap)
src/sim/                  game rules: pure, deterministic, no DOM
  constants.js            every balance number (edit here to tune)
  game.js                 state, actions, turn flow, zone
  rules.js                line of sight, cover, hit chance, pathfinding
  map.js                  seeded map generation
  ai.js                   bots (same rules, same fog as players)
src/client/               main.js (match flow), render.js + gfx/ (graphics), ui/ (HUD/menu), audio.js + sfx/
docs/V1_SPEC.md           contract between sim, graphics, UI and audio
tests/                    node:test suite incl. full bot-only matches
```

The sim knows nothing about rendering. That way the same code can run on the
multiplayer server later, and the server can be the only one that decides outcomes.

## Tests

`npm test` runs these checks:
- Map generation and every roll are deterministic.
- Line of sight and cover follow the rules.
- Every mode spawns 16 players, and Trios has a correct lone wolf.
- Full bot-only matches in all four modes always end with one winner (typically 13–19 rounds).

## Roadmap

1. **v0.2: online.** Invite-code lobbies on a small Node + WebSocket server, with the server deciding all outcomes. Players only receive what their squad can see. Reconnect handling, and auto-overwatch for missed turns.
2. **v0.3: depth.** More classes, grenades and destructible cover, flood-height terrain (low ground floods first), and contact bubbles: squads out of combat move at the same time.
3. **v0.4: progression.** Weapon mastery that unlocks sidegrades and cosmetics, never raw stat increases.
