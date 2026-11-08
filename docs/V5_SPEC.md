# Tidefall 5.0 — "Dream game on the verge of release"

**Pitch:** XCOM tactics × Call of Duty loadouts and killstreaks × Battlefield combined arms and destruction. A 16-player turn-based battle royale on a drowning archipelago. Everything in V1–V3 still applies unless this doc changes it.

**Quality bar:** this is the release candidate.
- Every screen, effect and sound should feel premium and intentional.
- Don't stop at "works". Aim for the standard of a top mobile title.
- Readability rules still hold: squad colours (your squad amber), and cyan for pickups and signals.

## Workstreams and file ownership (never edit another stream's files)
| Stream | Owns |
| --- | --- |
| **SIM-1** | `src/sim/*` and `tests/*`: turn system, classes, perks, weapons, ammo, equipment, killstreaks, legendaries, AI |
| **SIM-2** (starts after SIM-1) | `src/sim/*` and `tests/*`: boats, stage events, building collapse, The Pit |
| **NET** | `src/net/*`, `src/client/match/*` (match controllers: local, host, client) and `src/client/online/*` (lobby UI) |
| **GFX-WORLD** | `src/client/render.js` and `src/client/gfx/*` except the files GFX-CHAR owns |
| **GFX-CHAR** | `src/client/gfx/units.js`, `skins.js`, `cosmeticfx.js`, `preview.js`, new `gfx/weapons.js`, `gfx/camos.js`, `src/shared/cosmetics.js`, `src/shared/colors.js`, `assets/icon/*` |
| **UI** | `index.html`, `styles.css`, `src/client/main.js`, `src/client/ui/*`, `src/shared/cards.js` (new), `manifest.webmanifest`, `sw.js` |
| **AUDIO** | `src/client/audio.js` and `src/client/sfx/*` |

Every stream must list its **new files** in its report so UI can add them to the `sw.js` precache. Use feature checks (`obj.fn?.()`, dynamic imports with fallbacks) wherever you depend on another stream that is still being built.

---
## 1. Turn system: Engagement Turns (SIM-1). The biggest change.
Rounds stay, but squads no longer take every turn one after another.

- **Contact.** At the start of each round, two squads are *in contact* if any standing unit of one can see a unit of the other (`teamSeesUnit`, either direction). Squads in contact form **engagement groups**, the connected components of that graph. A squad with no contacts is **free**.
- **Steps.** A round is a series of steps:
  - **Step 0:** every free squad, plus the first squad of each engagement group, is active **at the same time**.
  - **Step k:** the k-th squad of each group.
  - The order inside a group rotates each round.
  - The round ends after the largest group's last step.
- **Concurrency.** Several squads are active at once. Every active squad gets its own 20 s clock, and actions from active squads resolve immediately, in the order they arrive.
- **API, `src/sim/game.js`:**
  - `activeTeams(state) → number[]`
  - `isTeamActive(state, team) → bool`
  - `endTeamTurn(state, team) → events` ends one squad's turn. When every active squad is done, it advances the step or round.
  - `engagements(state) → number[][]`
  - `currentTeamId(state)` is kept for back-compat and returns `activeTeams[0]`. It is deprecated.
  - `act(state, unitId, action)` validates the unit's team with `isTeamActive`.
- **Events:**
  - `{type:'round_start', round}`
  - `{type:'engagement', groups:[[t,…],…], free:[t,…]}`
  - `{type:'step_start', step, active:[t,…]}`
  - `turn_start` is still sent per squad.
- Zone damage still applies at the end of each squad's own turn.
- **Target:** bot-only matches stay at roughly 13–17 rounds.

## 2. Classes (7) + perks (SIM-1)
Classes give **role, ability, health and armour, and allowed weapon categories**. Specialisations move into perks.

| key | name | ability | allowed primaries |
| --- | --- | --- | --- |
| assault | Assault | Frag specialist: +1 lethal charge, Run & Gun (shooting after a dash is allowed once per 3 rounds) | AR, SMG |
| marksman | Marksman | Aimed Shot (as before) | DMR, Sniper |
| breacher | Breacher | Breach (as before) | Shotgun, SMG |
| medic | Medic | Patch / revive (as before) | SMG, Carbine |
| recon | Recon | Scan (as before) | Carbine, DMR |
| engineer | Engineer | **Deploy Cover**: places a full-cover barricade on an adjacent open tile (cooldown 3). Also repairs boats (SIM-2) | SMG, Shotgun, Carbine |
| gunner | Gunner | **Suppress**: target enemy in line of sight. Until its next turn ends it has -25 aim, and moving triggers a reaction shot. Costs 1 AP and 3 ammo, ends turn, cooldown 2 | LMG |

**Perks:** pick one per tier.
- **Tier 1:**
  - Scavenger: a kill refills your magazine and +1 lethal (once per kill).
  - Amphibious: shallow water and tide tiles cost normal movement, and tide damage -1.
  - Lightweight: +1 move.
  - Flak Jacket: explosive damage halved.
- **Tier 2:**
  - Ghost: immune to Scan and UAV.
  - Hardline: killstreaks cost 1 fewer kill.
  - Steady Aim: +10 aim if you haven't moved this turn.
  - Trapper: start with a Claymore (see equipment).
- **Tier 3:**
  - Dead Silence: your gunfire doesn't create unseen-gunfire pings for enemies, and you don't trigger enemy overwatch on your first move each turn.
  - Quick Fix: heal 3 on a kill or revive, and you revive at +2 HP.
  - Tracker: enemies you damage are revealed to your squad until your next turn.
  - Tactical Mask: immune to flashbangs and the smoke aim penalty.

Export `PERKS = {tier1:[…], tier2:[…], tier3:[…]}` as `{key, name, desc}` objects.

## 3. Weapons, attachments, ammo, equipment (SIM-1)
**Weapon data** lives in `src/sim/weapons.js`. Export `WEAPONS` (id → def), `CATEGORIES`, `ATTACHMENTS`, `LEGENDARIES`, `EQUIPMENT` and `STREAKS`.

**Primaries** (about 3 per category, ≥18 total):
- AR, SMG, LMG, Shotgun, DMR, Sniper, Carbine.
- Each has `{id, name, cat, range, aim, dmg:[a,b], mag, special?}`. `special` can be `falloff`, `closePenalty`, `pellets`, `burst`, `pierce` and so on.
- Weapons are trade-offs, never strict upgrades.

**Secondaries:**
- Pistol: infinite ammo, low damage.
- Machine pistol.
- Launcher: 2 rockets, blast radius 1.5, damages cover.

**Attachment slots:** optic, barrel, magazine, underbarrel, stock, with ≥3 per slot. Every attachment has a pro and a con, for example `{aim:+8, move:-1}` or `{mag:+4, aim:-3}`. A loadout carries up to 5 attachments.

**Ammo:**
- `unit.ammo` is the current magazine. Shooting costs 1 round, burst weapons cost 1 per shot as well, and Suppress costs 3.
- `reload`: 1 AP, doesn't end the turn.
- `swap`: free, once per turn, switches between primary and secondary.
- You can't shoot with an empty magazine. The UI shows a RELOAD prompt.

**Equipment:**
- **Lethal (1 slot, 1–2 charges):**
  - frag (as before)
  - semtex: sticks to a unit, so a direct hit adds +2 damage to that unit, and it never misses its tile
  - claymore: placed on an adjacent tile, triggers on the first enemy to move within 1.5, 5 damage
  - throwing knife: range 4, 4 damage, silent
- **Tactical (1 slot, 1–2 charges):**
  - smoke (as before)
  - flashbang: radius 1.5. Enemies hit lose 1 AP on their next turn and take -30 aim until their next turn ends. Units with Tactical Mask are immune.
  - stim: instant, +1 AP this turn and heal 2
  - decoy: creates a fake gunfire ping and attracts bot overwatch and aim for a round

**Loadouts:**
```
{cls, primary:{id, attachments:{optic?,barrel?,magazine?,underbarrel?,stock?}}, secondary:{id}, lethal, tactical, perks:[t1,t2,t3], streaks:[k1,k2,k3]}
```
- `createGame` takes `opts.players = [{name, loadout, isHuman:true}]`, one entry per human. The current single `playerClass` and callsign options still work.
- Bots get sensible random loadouts.
- Validate loadouts with `validateLoadout(l) → l'`, which clamps anything illegal.

**Crates:**
- Contents: medkit, armor, ammo, a *field attachment* (fills or replaces a slot, chosen randomly), lethal, tactical.
- **Gold crates** are rare, appear at about 25% of supply drops, and hold a legendary weapon.
- **Legendaries** are named gold weapons with a unique trait (≥6). For example:
  - Tidebreaker (rail sniper, pierces one cover level)
  - Maw (shotgun, shreds cover)
  - Undertow (LMG, every hit slows the target)
  - Lantern (DMR, a hit flares the target)
  - Riptide (SMG, +1 move after a kill)
  - Leviathan (launcher, 4 rockets)

## 4. Killstreaks (SIM-1)
- Each player brings 3 streaks in the loadout. A streak unlocks when your kill count this match reaches its cost; Hardline reduces costs by 1.
- Each streak can be used once. Calling one in costs 0 AP, at most one per turn.
- **The streaks:**
  - **UAV (3):** reveals every enemy within radius 14 of you to your squad until your next turn. Ghost counters it.
  - **Care Package (4):** pick a tile within 6. A crate drops there next step. 40% chance of a legendary, otherwise a strong random crate.
  - **Counter-UAV (4):** enemy scans and UAVs can't see your squad for 2 rounds.
  - **Airstrike (5):** pick a line of 7 tiles. It's **telegraphed**: shown to everyone with a warning, then hits at the start of the next round for 5 damage, destroys cover, and ignores cover.
  - **Sentry (5):** places a turret with 8 HP that overwatches a cone each turn for 3 rounds.
  - **Gunship (7):** for 2 rounds, at the end of each of your squad's turns, the gunship fires on up to 2 visible enemies (aim 60, 4 damage, cover applies).
- **Action:** `streak {key, x?, y?, x2?, y2?}`.
- **Events:**
  - `streak_ready {id, key}` and `streak_used {id, key}`
  - `uav {team, x, y, r}`
  - `care_package {crate}`
  - `airstrike_mark {id, tiles, round}` and `airstrike {tiles}`, followed by damage and cover events
  - `sentry {id, x, y, owner}` and `sentry_shot …`
  - `gunship_start {team}`, `gunship_shot {target, …}` and `gunship_end`
- **Helpers:** `streakInfo(state, u)`, `streakTargets(state, u, key)`, `streakPreview(state, u, key, x, y, x2?, y2?)`.

## 5. Battlefield layer (SIM-2, after SIM-1)
- **Boats:**
  - 2–3 per map, on shoreline water or shallows. `state.vehicles = [{id, kind:'boat', x, y, hp:12, fuel:3, seats:[unitIds]}]`.
  - **Boarding:** move onto an adjacent boat tile to board, if a seat is free (capacity 4).
  - **Driving:** the first unit aboard drives. `boat_move {x,y}` costs 1 AP and the driver's whole turn, moves up to 8 tiles through water (tide-flooded tiles, shallows and ocean inside the map), and uses 1 fuel.
  - **Aboard:** passengers can shoot, and get half cover. While aboard, units take no tide damage.
  - **Destroyed:** a boat at 0 HP explodes for 3 damage to everyone aboard, and they are dropped into the water.
  - **Repair:** an Engineer adjacent can `repair` it for 1 AP, +4 HP and +1 fuel.
  - **Events:** `board`, `disembark`, `boat_move {id, path}`, `vehicle_damage`, `vehicle_destroyed`.
- **Stage events ("Levolution"):** one per match, telegraphed one round before (`stage_event_warn {kind, tiles, round}`), then `stage_event {kind, tiles}` followed by `cover_change`, `damage`, `knockback {id, path}` and terrain changes (`terrain_change {x, y, to}`).
  - Harbor: a container ship breaks loose and ploughs a lane, destroying cover and leaving container walls.
  - Kelp: Red Tide. A toxic algae band does 2 damage per turn for 2 rounds.
  - Rig: platform collapse. A section becomes water.
  - Spire: a tower topples. A line of rubble half-cover forms a bridge over water.
  - Surge: a rogue wave. A band takes 3 damage and is knocked 2 tiles inland.
- **Building collapse:** walls belong to buildings (`map.building` Int16Array, -1 for none). When 40% of a building's full-cover tiles have been destroyed, the rest collapse into rubble half-cover, and units inside take 3. Event `building_collapse {id, tiles}`.
- **The Pit (second chance):**
  - Your **first death**, up to round 8, sends you to the Pit queue. Death means actually dying, not being downed.
  - Two queued players fight a 1v1 duel on a tiny 9×9 arena with pistols and 1 frag, using the same rules. If nobody is waiting by the end of the round, you fight the Pit Warden bot.
  - The winner redeploys at the next round start: parachuted to a random safe tile, 6 HP, primary at half ammo. In team modes, only if your squad still has a standing member. The loser is out.
  - **API:** `state.pit = {queue, duels:[{id, a, b, state}]}`. A duel's state is a separate mini game state, run with the same `act` and `endTeamTurn`. `pitDuels(state)` lists them, and `resolvePitBots(state)` auto-plays bot-only duels.
  - **Events:** `pit_enter {id}`, `pit_duel {duelId, a, b}`, `pit_result {duelId, winner, loser}`, `redeploy {id, x, y}`.
  - The match controller (NET) runs a human's duel interactively. The duel runs between the main match's steps, and the main match pauses for it.

## 6. Online: code invites (NET)
- **PeerJS public broker** (no server). Import: `https://esm.sh/peerjs@1.5.4`. The host's peer id is `tidefall-<CODE>`, where CODE is 6 characters A–Z/2–9 with no confusable characters. STUN is Google's public servers. There's no TURN for now, so mention in the UI that some cellular networks may fail.
- **Host-authoritative:**
  - The host runs the sim.
  - Clients send `{t:'act', action}` and `{t:'end'}`.
  - The host validates the action against that player's unit, then broadcasts to each client **only the events that client's team can see**, plus a **redacted snapshot**: enemy units its team can't see are removed or marked hidden, and hidden crate contents and other teams' private loadout data are stripped. Never leak hidden information.
  - Up to 16 humans. Bots fill the rest. Squads are assigned in the lobby, with friends grouped into a squad.
- **Lobby:** create or join, players list with callsign, class badge and ready state, squad assignment, mode and stage chosen by the host, start, kick, leave. Show the code large with a copy/share button (`navigator.share`). A `?join=CODE` deep link opens join.
- **Robustness:** connection status, reconnect within 60 s (the slot gets auto-overwatch meanwhile), the host leaving ends the match with a clear message, heartbeats.
- **Match controllers** in `src/client/match/`, one interface for local, host and client:
```
createMatch(kind:'local'|'host'|'client', {R, sfx, ui, opts, net?}) → {
  start(): Promise, act(action) → Promise<{ok, error?, events?}>, endTurn(), leave(),
  state /* view state (client: redacted mirror) */, myTeam, myUnitId,
  setSpeed(x) /* spectator playback speed: must visibly change playback */, fastForward(),
}
ui hooks (provided by UI): onEvent(ev), onTurnStart({unitId, deadline}), onTurnEnd(), onStep({active, engagements}),
  onPit({duelState, …}), onMatchEnd(summary), onStatus(msg), onState()
```
- The controller owns event playback through `R.playEvent`, with the 8 s safety timeout kept, plus bot turns, timers and auto-overwatch on timeout.
- **Bot action pacing:** visible bot actions animate, invisible ones resolve instantly.
- **Concurrency:** during a step where the human and bot squads are active together, bots act first, then the human's turn opens.
- **Bug to fix:** spectator 1×/2×/4× currently all look the same. `setSpeed` must scale every animation, including camera moves and the delays between events. Verify by timing it.
- **UI** builds the HUD and input, calls `createMatch`, and reacts to the hooks.

## 7. Account transfer (UI)
- Settings → Transfer → **Export** shows a code (base64url of compressed JSON with a CRC32 checksum, prefixed `TF5-`) plus a QR code, rendered by a small inline QR generator you write or vendor, MIT-licensed.
- **Import** accepts a pasted code, validates it, previews it ("Level 23 · 4,200 Salvage · 37 items") and confirms before overwriting.
- Covers all meta: career, prestige, Salvage, owned and equipped items, classes and loadouts, weapon levels, camos, challenges, settings.

## 8. Progression (UI owns meta and screens; SIM owns the gameplay data)
- **Player level:** 1–100 from match XP, with a level-up celebration. Plus class prestige badges (as in V3, now 7 classes × 5 tiers).
- **Weapon levels:** 1–20 per weapon from use. These unlock attachments in a fixed order. Each unlock is a sidegrade, so new players are never outgunned by raw stats.
- **Camos:** per-weapon challenges, for example 25 kills, 10 headshots (that is, kills at ≥70% chance? Define something clear), 5 flanking kills, and so on, unlock camos. All camos on a weapon unlock **Gold**. Gold on 5 weapons unlocks **Diamond**. All Diamond unlocks **Tidal**, which is animated.
- **Daily challenges:** 3 rotating each day, rewarding XP and Salvage.
- **Calling cards and emblems:** earned or bought, shown in the lobby, on squad cards and on the end screen. UI owns them in `src/shared/cards.js`, with procedural SVG art.
- **Barracks / Create-a-Class:** 5 custom loadout slots, with a weapon picker showing stats and Gunsmith attachments, perk tiers, lethal and tactical choice, and a streak picker.

## 9. Graphics 5.0 (GFX-WORLD + GFX-CHAR)
Aim high, cohesive and premium, while keeping phone performance. The current game runs flawlessly on the user's phone; keep auto-quality honest.

- **GFX-WORLD:**
  - Re-light and re-grade every stage: better sky and horizon, volumetric-looking light shafts on high quality, wet surfaces after rain, water caustics, a crisper foam shoreline, and an ambient-occlusion feel (baked vertex AO or SSAO on high only).
  - Richer destruction: building collapse with dust plumes, stage-event set pieces staged like cinematics with camera moves.
  - Vehicles:
    - boats with wakes and bobbing
    - the UAV drone overhead
    - an airstrike: jets flyby, telegraphed red line, staggered explosions
    - a gunship circling with tracer fire
    - care package: smoke flare, then a parachute crate
    - a sentry turret
  - Overlays:
    - engagement brackets and lines between engaged squads
    - a contact "spotted!" pulse
    - claymore laser lines
    - flashbang white-out and a ring
    - suppression tracers
  - Fix the spectator speed scaling for every animation.
- **GFX-CHAR:**
  - Better soldier models and animation:
    - reload animation
    - swap animation
    - throw animation per equipment
    - stim injection
    - knife throw
    - an emote at victory
  - Weapons: a model per category and per legendary, with attachments visible on the model (optic, suppressor, grip, magazine).
  - **Camos:** procedural shader camos (≥12 standard, plus Gold, Diamond and the animated Tidal).
  - Weapon charms.
  - **Expand the shop catalog massively:**
    - ≥30 skins, including operator-style named skins with backstory text
    - ≥12 kill effects
    - ≥10 drop-ins
    - ≥10 victory emotes
    - ≥12 weapon charms
    - ≥8 tracer colours (tracers stay readable)
    - ≥6 streak skins (e.g. a "Leviathan" gunship)
    - Bundles.
  - All previewable via `renderPreview` (add `kind:'weapon'` for weapon and camo previews).
  - Polish the app icon (A, the crosshair at the tide line) only if it clearly improves it.

## 10. UI 5.0 (UI)
- **Front end like a premium shooter:**
  - Animated title.
  - Main hub: Play (Solo vs Bots / Host Online / Join with Code), Barracks (Create-a-Class), Armory (weapons, Gunsmith, camos), Store, Career (level, prestige, challenges, calling cards and emblems), Settings.
  - Transitions, sounds and haptics everywhere.
- **Deploy button pinned** to the bottom of the screen, as a sticky footer in the loadout flow.
- **Match HUD:**
  - Active-squads indicator for engagement turns ("3 squads moving · you're in an engagement with Squad 7").
  - Ammo counter with a reload button, primary/secondary swap, lethal and tactical buttons, and a streak bar with ready glow.
  - Spotted / engagement banners, a hitmarker, a kill confirm with XP popups (+100 KILL, +50 FLANK…).
  - A medal system (Double Kill, Headshot, Revenge, Clutch, Longshot, Collateral, First Blood…).
  - The Pit screen, a redeploy sequence, and a better spectator with player cycling and speed that works.
- **End screen:** placement, medals, XP bar fill (player, weapon, class), challenge progress, camo unlocks and a Salvage tally. Then back to the hub.
- **Online:** the hub entries open NET's lobby (`src/client/online/lobby.js` mounts into a container UI provides: `#onlineRoot`). In-match, show player names and connection status.
- **Accessibility:** colourblind presets for squad colours, text size, reduced motion, haptics toggle.

## 11. Audio 5.0 (AUDIO)
- **Weapons:** a voice per weapon category plus each legendary, suppressed variants, reload, empty-click, swap, and the launcher.
- **Equipment:** semtex beep, claymore trigger, knife throw and hit, flashbang (ring plus a ducked mix with a high-pass for affected players), stim.
- **Killstreaks:** UAV online chirp, care package flare and drop, jets flyby, airstrike whistle and impacts, sentry, gunship drone with cannon. Each has a radio callout "voice" built from synthesized radio tones; there is no TTS.
- **World:** boat engine and wake, building collapse rumble, stage-event sirens and set-piece audio, The Pit's own tense theme.
- **Feedback:** hitmarker tick, kill-confirm ding, medal stingers, level-up / rank-up / camo-unlock fanfares, engagement-start sting.
- **Music:** a bigger menu theme v2 and the store and hub ambience. Keep the mix clean, with ducking and voice limits.

## Testing (everyone)
- `npm test` must pass.
- Use a browser harness (headless Chrome via Playwright; route `https://unpkg.com/three@0.170.0/**` to `/tmp/deps/node_modules/three/`). Peer-to-peer can be tested in one browser with two pages, since PeerJS cloud may be unreachable from the sandbox. If so, NET adds a **loopback transport** (BroadcastChannel) so host and client can be tested without the network, and exposes it with `?net=loop`.
- Software GL is slow, so use `?gfx=low&fast&notimer` and small viewports.
- Look at screenshots and iterate.
