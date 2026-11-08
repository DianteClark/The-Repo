// Tidefall 5.1 pacing presets + event classes. Plain data, no three.js import:
// shared by the renderer's director (gfx/director.js) and the match controller
// (match/playback.js), and loadable from node.

/**
 * Pacing presets. Times are real-time ms at spectator 1× (spectator 2×/4× divide
 * them, and multiply the animation speed). anim* = renderer playback speed
 * (R.speed) for bot / other-player turns and for my own actions.
 *   camTime     camera glide smoothing (critically damped spring, s)
 *   arrive      max wait for the camera to arrive before an action starts
 *   lead        anticipation beat once framed (major actions: shots, throws, abilities)
 *   leadMinor   anticipation for minor actions (reload, overwatch, moves)
 *   hold        hold after a major action resolves (read the damage number)
 *   holdMinor   hold after minor actions / moves
 *   holdConseq  hold after consequences (damage, death, downed, cover breaking)
 *   gap         gap between two actors' turns
 *   squad       "Squad N is moving" beat: camera glides to the squad's first actor, then the
 *               tag holds for 60% of this (0 = UI hook only, no camera beat)
 *   my*         my own actions: snappy but framed
 *   zoom        action framing as a fraction of the base (overview) zoom
 *   slow        slow-motion factor for set pieces (stage events)
 *   cine        set-piece holds: {pre, post, warnFly}
 */
export const PACING = {
  cinematic: {
    name: 'cinematic', anim: 1.0, animMine: 1.1, camTime: 0.34, arrive: 1400,
    lead: 420, leadMinor: 160, hold: 820, holdMinor: 300, holdConseq: 520, gap: 380, squad: 1050,
    myLead: 140, myHold: 360, myArrive: 650, zoom: 0.78, slow: 0.55,
    cine: { pre: 900, post: 1500, warnFly: 2600 },
  },
  normal: {
    name: 'normal', anim: 1.3, animMine: 1.12, camTime: 0.24, arrive: 900,
    lead: 220, leadMinor: 70, hold: 450, holdMinor: 150, holdConseq: 280, gap: 200, squad: 620,
    myLead: 60, myHold: 200, myArrive: 450, zoom: 0.88, slow: 0.7,
    cine: { pre: 600, post: 1000, warnFly: 1800 },
  },
  fast: {
    name: 'fast', anim: 1.8, animMine: 1.15, camTime: 0.15, arrive: 450,
    lead: 40, leadMinor: 0, hold: 120, holdMinor: 30, holdConseq: 60, gap: 90, squad: 0,
    myLead: 0, myHold: 60, myArrive: 300, zoom: 1, slow: 0.85,
    cine: { pre: 300, post: 500, warnFly: 1000 },
  },
};
export const PACING_NAMES = Object.keys(PACING);

// event classes: how the controller paces them
const MAJOR = new Set(['shot', 'grenade', 'smoke', 'breach', 'semtex', 'flashbang', 'knife', 'rocket', 'barrel_shot', 'suppress',
  'scan', 'patch', 'heal_ally', 'revive', 'stim', 'decoy', 'claymore', 'deploy_cover', 'streak_used', 'overwatch_trigger', 'sentry_shot',
  'gunship_shot', 'shot_sentry', 'shot_vehicle', 'uav', 'care_package', 'sentry', 'repair', 'boat_move', 'airstrike_mark', 'redeploy', 'supply_drop',
  'gunship_start', 'counter_uav', 'cuav']);
const MINOR = new Set(['reload', 'swap', 'overwatch', 'hunker', 'crate', 'flare', 'board', 'disembark', 'medkit', 'heal', 'pit_enter', 'claymore_place']);
const CONSEQ = new Set(['damage', 'death', 'downed', 'cover_change', 'barrel', 'knockback', 'vehicle_damage', 'vehicle_destroyed',
  'claymore_trigger', 'claymore_blast', 'suppress_trigger', 'zone_damage', 'bleed_out', 'sentry_damage', 'sentry_destroyed', 'terrain_change']);
const SET = new Set(['stage_event_warn', 'stage_event', 'airstrike', 'building_collapse']);

/** 'major' | 'move' | 'minor' | 'conseq' | 'set' | 'none' */
export function eventClass(ev) {
  const t = ev?.type;
  if (t === 'move') return 'move';
  if (SET.has(t)) return 'set';
  if (MAJOR.has(t)) return 'major';
  if (MINOR.has(t)) return 'minor';
  if (CONSEQ.has(t)) return 'conseq';
  return 'none';
}

