// Match controllers: one interface for solo, online host and online client.
//
//   import { createMatch } from './match/index.js';
//   const match = createMatch('local' | 'host' | 'client', { R, sfx, ui, opts, net });
//   await match.start();            // resolves with the end summary (or when you leave)
//
// ---------------------------------------------------------------------------------------------
// Controller API
//   start() → Promise<summary>    sets up the renderer (R.setGame), awaits ui.onIntro, runs the match
//   act(action) → Promise<{ok, error?, events?}>   resolves after the action's events have played
//   endTurn() → Promise<{ok}>     end my turn now ('hold')
//   leave()                       stop; a host leaving ends the match for everyone
//   setSpeed(1|2|4) → n           spectator playback speed (scales R.speed, our gaps, camera)
//   fastForward() → bool          skip the remaining animations (only while not standing)
//   pause() / resume()            solo only: freezes my clock (pause sheet, app hidden)
//   state        the sim state (local/host) or the redacted mirror (client). Read-only for the UI.
//                Hidden enemy units in a mirror: {hidden:true, x:-99, y:-99}. Never mutate it.
//   view         the state the renderer shows (differs from state during a Pit duel)
//   myTeam, myUnitId   use these, not unit.isPlayer (online several units are human)
//   turn         null or {unitId, deadline (performance.now ms), total ms, busy, left (s)}
//   players      humans: [{unitId, pid, name, team, local, connected}]
//   names        {unitId: callsign} for human units
//   spectating, fastForwarding, speed, over, summary
//   follow = bool (camera follows whoever acts), botSpeed = 'fast'|'normal'
//
// opts: local → {mode, stage, cls, callsign, loadout?, loneWolf?, seed?, cosmetics?, noTimer?, follow?, botSpeed?}
//       host  → {seed?, noTimer?, follow?, botSpeed?}  (mode/stage/players come from the lobby: net)
//       client→ {follow?, botSpeed?}
// net: the session from src/net (hostSession() for 'host', joinSession() for 'client').
//
// ---------------------------------------------------------------------------------------------
// UI hook contract (every hook optional; exceptions are caught and logged):
//   onIntro(match) → Promise?        after R.setGame, before anything plays (drop-in + countdown)
//   onEventStart(ev)                 just before an event animates (pre-meta: camera, banners)
//   onEvent(ev, {ff, visible})       after it played (or instantly in fast-forward): kill feed,
//                                    stats, toasts, HUD refresh. Every event reaches this hook.
//   onTurnStart({unitId, deadline, total, pit})   my turn opened: show input. deadline is
//                                    performance.now()-based and moves while my action animates.
//   onTick({unitId, left, total, deadline})       ~10×/s during my turn: draw the timer
//   onTurnEnd({unitId, reason})      'done' | 'ended' | 'timeout' | 'disconnected' | 'over' | …
//   onStep({active, engagements, round, activeCount?})  a new set of squads is moving
//   onPit({phase:'start'|'end', duelId, duelState, a, b, mine, myDuelUnitId, winner})
//   onMatchEnd(summary)              {winner, myTeam, myUnitId, place, round, squads, kills, alive,
//                                     names, reason, msg?}
//   onStatus(msg, level)             'info'|'ok'|'warn'|'error': toasts (disconnects, auto-overwatch…)
//   onConnection(connected)          client only: show "Reconnecting…"
//   onState()                        state changed (after a batch, spectator switch): redraw HUD
// sfx: the controller calls sfx.turn() when my turn opens and sfx.tick(urgent) for the last 10 s.

import * as G from '../../sim/game.js';
import * as AI from '../../sim/ai.js';
import { createAuthority } from './authority.js';
import { createRemote } from './remote.js';

export { SPEC_SPEEDS } from './playback.js';
export { turnModel } from './turns.js';

export function createMatch(kind, deps = {}) {
  const d = { G, AI, ...deps };
  if (kind === 'client') {
    if (!d.net) throw new Error('createMatch(client) needs net');
    return createRemote(d);
  }
  if (kind === 'host' && !d.net) throw new Error('createMatch(host) needs net');
  if (kind !== 'host' && kind !== 'local') throw new Error('Unknown match kind ' + kind);
  return createAuthority(kind, d);
}
