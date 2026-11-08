# Tidefall (working title)

**▶ Play now: https://dianteclark.github.io/The-Repo/**

A 16-player, turn-based, XCOM-style battle royale that runs in the browser.
One soldier per player. Rival salvage crews fight across a drowning archipelago
while the storm tide (**the Surge**) floods the map from the edges in.

> **Status: v5.1.** XCOM tactics × Call of Duty loadouts × Battlefield destruction. Solo vs 15 bots, or online via invite code (peer-to-peer, host-run). Installable, works offline.

## Play it

- **Online:** https://dianteclark.github.io/The-Repo/. Every push to `main` redeploys it.
- **Locally:** `npm start`, then open http://localhost:8080.
- **Invite friends:** Play → Host Online, then share the code or link. Friends use Join with Code or open `?join=CODE`.

## What's in 5.0

| Area | Details |
| --- | --- |
| Turns | **Engagement turns**: squads out of contact move at the same time; squads in a firefight alternate XCOM-style. 20 s per squad turn |
| Classes | 7: Assault, Marksman, Breacher, Medic, Recon, **Engineer** (deploy cover, repair boats), **Gunner** (suppress) · 12 perks in 3 tiers |
| Arsenal | 21 primaries, 3 secondaries, 15 attachments (Gunsmith), 7 named **legendaries**, ammo and reload, swap · Lethal: frag, semtex, claymore, knife · Tactical: smoke, flashbang, stim, decoy |
| Killstreaks | Earned with points (kills, downs, assists, revives): UAV · Care Package · Counter-UAV · Airstrike (telegraphed) · Sentry · Gunship |
| Battlefield | Boats you can drive, repair and shoot · one telegraphed stage event per match · whole buildings collapse |
| The Pit | Your first death sends you to a 1v1 duel. Win it and you redeploy |
| Stages | Drowned Harbor · Kelp Shallows · Rig Graveyard · Night Spires · Surge Point (44×44). Picked at random by a stage wheel before every match |
| Presentation | An action director frames every visible action before it plays · Cinematic, Normal or Fast pacing · letterboxed slow-motion stage events |
| Progression | Player level 1–100 · class prestige badges (5 tiers) · weapon levels 1–20 · camo challenges with Gold, Diamond and animated Tidal · daily challenges · medals · calling cards and emblems |
| Store | 120+ cosmetics: operator skins, kill effects, drop-ins, emotes, charms, tracers, streak skins, bundles. Earned Salvage only, no real money |
| Online | Code invites, lobby with squads, host-authoritative with fog-filtered data (no hidden-info leaks), reconnect within 60 s |
| Account | Transfer code (`TF5-…`) + QR to move your progress between devices |

## Layout

```
index.html, styles.css    page + HUD (Three.js loaded from a CDN via importmap)
src/sim/                  game rules: pure, deterministic, no DOM
  constants.js            every balance number (edit here to tune)
  game.js                 state, actions, turn flow, zone
  rules.js                line of sight, cover, hit chance, pathfinding
  map.js                  seeded map generation
  ai.js                   bots (same rules, same fog as players)
src/client/               main.js (UI flow), match/ (controllers), online/ (lobby), render.js + gfx/, ui/, audio.js + sfx/
src/net/                  peer-to-peer transport, sessions, redaction
src/shared/               colours, cosmetics, calling cards
docs/V1–V5_SPEC.md        design contracts per version
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
