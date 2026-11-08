// The DISPLAYED match model: what the player has already SEEN, not what the sim already knows.
//
// The sim resolves an action instantly; its events then animate one by one. Anything the HUD
// reads straight from the sim state is therefore a spoiler ("You're down" before the shot lands,
// "Skip to results" before the death animation, squads-left dropping before the kill plays).
// Every player-facing read goes through this model instead:
//
//   shown.sync(state)        the playback queue is idle: what was played == the sim (resync all)
//   shown.apply(ev, state)   an event has finished animating (playback's onEvent): fold it in
//   shown.state()            a read-only view of the state with displayed units / winner /
//                            eliminated / round / zone / crates (live everything else)
//   shown.unit(id)           one displayed unit
//
// Units are split into field groups so a consequence never lands before its own event:
//   health  hp / alive / downed / bleed   only from damage / downed / death / revive / heal events
//   score   kills / points / streakUsed    only from death / streak_points / streak_* events
//   kit     everything else (ammo, AP, items, cooldowns…)   when that unit's own action plays
// Positions are the renderer's displayed positions when it has them (R.disp).

const HEALTH = ['hp', 'alive', 'downed', 'bleed'];
const SCORE = ['kills', 'points', 'streakUsed', 'streakCalled'];
const SKIP = new Set([...HEALTH, ...SCORE, 'x', 'y']);

const clone = (v) => { try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); } };

/** The unit whose own action this event is (mirrors playback.actorOf, kept local to stay pure). */
function actorOf(ev) {
  switch (ev.type) {
    case 'shot': case 'shot_sentry': case 'shot_vehicle': return ev.from;
    case 'revive': return ev.by ?? null;
    case 'boat_move': return Number.isInteger(ev.driver) ? ev.driver : null;
    case 'move': case 'grenade': case 'breach': case 'overwatch': case 'hunker': case 'crate': case 'smoke': case 'scan':
    case 'patch': case 'barrel_shot': case 'reload': case 'swap': case 'semtex': case 'knife': case 'flashbang': case 'stim':
    case 'deploy_cover': case 'suppress': case 'streak_used': case 'rocket': case 'decoy': case 'claymore': case 'repair':
    case 'board': case 'disembark': case 'heal': case 'medkit': case 'overwatch_trigger':
      return Number.isInteger(ev.id) ? ev.id : null;
    default: return null;
  }
}

export function createShown() {
  let live = null;
  let R = null;
  let kit = [];      // per unit: clone of the non-health, non-score fields
  let health = [];   // per unit: {hp, alive, downed, bleed}
  let score = [];    // per unit: {kills, points, streakUsed, streakCalled}
  let winner = null;
  let eliminated = [];
  let round = 0;
  let zone = null;
  let crateKnown = new Set();
  let crateTaken = new Set();
  let ver = 0;
  let cache = null, cacheVer = -1, cacheLive = null;
  const units = [];  // merged unit views (rebuilt lazily)
  let unitVer = [];

  const H = (u) => ({ hp: u.hp, alive: !!u.alive, downed: !!u.downed, bleed: u.bleed || 0 });
  const Sc = (u) => ({ kills: u.kills || 0, points: u.points || 0, streakUsed: clone(u.streakUsed || {}), streakCalled: u.streakCalled });
  const K = (u) => { const o = {}; for (const k of Object.keys(u)) if (!SKIP.has(k)) o[k] = u[k]; return clone(o); };

  const S = {
    /** Use the renderer's displayed positions (R.disp) when it has them. */
    setRenderer(r) { R = r || null; },
    get ready() { return !!live; },
    /** The sim state this model mirrors (a Pit duel swaps it). */
    get live() { return live; },
    /** Everything played: the displayed model is the sim again. */
    sync(state) {
      if (!state) return;
      live = state;
      kit = state.units.map(K);
      health = state.units.map(H);
      score = state.units.map(Sc);
      winner = state.winner ?? null;
      eliminated = [...(state.eliminated || [])];
      round = state.round;
      zone = clone(state.zone);
      crateKnown = new Set((state.crates || []).map((c) => c.id));
      crateTaken = new Set((state.crates || []).filter((c) => c.taken).map((c) => c.id));
      ver++;
    },
    reset() { live = null; kit = []; health = []; score = []; winner = null; eliminated = []; ver++; units.length = 0; unitVer = []; },
    /** An event has finished animating: fold its consequence into what the player has seen. */
    apply(ev, state) {
      if (!ev || !state) return;
      if (state !== live || state.units.length !== health.length) { S.sync(state); return; }
      const U = state.units;
      const h = (id) => (Number.isInteger(id) && health[id] ? health[id] : null);
      const maxHp = (id) => U[id]?.maxHp ?? 99;
      const hurt = (id, dmg) => { const x = h(id); if (x && Number.isFinite(dmg) && dmg > 0) x.hp = Math.max(0, (x.hp ?? 0) - dmg); };
      const heal = (id, n) => { const x = h(id); if (x && Number.isFinite(n) && n > 0 && x.alive && !x.downed) x.hp = Math.min(maxHp(id), (x.hp ?? 0) + n); };
      switch (ev.type) {
        // (gunship / knife hits come with their own 'damage' event; sentry shots and unit shots don't)
        case 'shot': case 'sentry_shot': {
          const t = ev.to ?? ev.target;
          if (ev.result !== 'miss' && ev.dmg) hurt(t, ev.dmg);
          break;
        }
        case 'damage': case 'zone_damage': hurt(ev.id ?? ev.target, ev.dmg); break;
        case 'downed': { const x = h(ev.id); if (x) { x.downed = true; x.hp = 0; x.bleed = U[ev.id]?.alive && U[ev.id]?.downed ? (U[ev.id].bleed || 2) : 2; } break; }
        case 'death': case 'bleed_out': { const x = h(ev.id); if (x) { x.alive = false; x.downed = false; x.hp = 0; x.bleed = 0; } break; }
        case 'revive': { const x = h(ev.id); if (x) { x.downed = false; x.alive = true; x.bleed = 0; x.hp = Number.isFinite(ev.hp) ? ev.hp : U[ev.id]?.hp ?? 1; } break; }
        case 'redeploy': if (U[ev.id]) { health[ev.id] = H(U[ev.id]); kit[ev.id] = K(U[ev.id]); score[ev.id] = Sc(U[ev.id]); } break;
        case 'heal': heal(ev.id, ev.amount); break;
        case 'stim': heal(ev.id, ev.heal ?? ev.amount); break;
        case 'patch': {
          // revive is its own event; a plain patch heals
          const t = ev.target ?? ev.id;
          if (h(t) && !h(t).downed) heal(t, ev.amount);
          break;
        }
        case 'medkit': heal(ev.id, ev.amount ?? ev.heal); break;
        case 'turn_start': case 'turn_end': case 'round_start': case 'step_start': {
          // bleed counters tick at turn boundaries; untouched units' HP may have moved without an event
          for (let i = 0; i < U.length; i++) {
            const x = health[i], u = U[i];
            if (x.downed && u.alive && u.downed) x.bleed = u.bleed || 0;
          }
          if (ev.type === 'round_start') round = Number.isFinite(ev.round) ? ev.round : state.round;
          break;
        }
        case 'team_out': if (Number.isInteger(ev.team) && !eliminated.includes(ev.team)) eliminated.push(ev.team); break;
        case 'game_over': winner = ev.winner ?? state.winner ?? null; break;
        case 'zone_shrink': zone = clone(state.zone); break;
        case 'crate': if (ev.crate !== undefined && ev.crate !== null) crateTaken.add(ev.crate?.id ?? ev.crate); break;
        case 'care_package': case 'supply_drop': case 'crate_drop': for (const c of state.crates || []) crateKnown.add(c.id); break;
        case 'streak_points': if (score[ev.id]) score[ev.id].points = Number.isFinite(ev.total) ? ev.total : U[ev.id]?.points || 0; break;
        case 'streak_ready': case 'streak_used': if (score[ev.id] && U[ev.id]) { score[ev.id].streakUsed = clone(U[ev.id].streakUsed || {}); score[ev.id].streakCalled = U[ev.id].streakCalled; } break;
        default:
      }
      if (ev.type === 'death' && Number.isInteger(ev.by) && score[ev.by] && U[ev.by] && U[ev.by].team !== U[ev.id]?.team) {
        score[ev.by].kills = Math.min(U[ev.by].kills || 0, (score[ev.by].kills || 0) + 1);
      }
      // The actor's own kit (ammo, AP, items, cooldowns) lands when its action has played.
      const a = actorOf(ev);
      if (Number.isInteger(a) && U[a]) {
        kit[a] = K(U[a]);
      }
      ver++;
    },
    /** A displayed unit: sim object for identity-free fields, displayed health / score / kit. */
    unit(id) {
      if (!live) return null;
      const u = live.units[id];
      if (!u) return null;
      if (!health[id]) return u;
      if (unitVer[id] === ver && units[id]) return units[id];
      const d = R?.disp?.[id];
      const o = Object.assign({}, u, kit[id], score[id], health[id]);
      if (d && Number.isFinite(d.x) && Number.isFinite(d.y) && !u.hidden) { o.x = d.x; o.y = d.y; }
      units[id] = o; unitVer[id] = ver;
      return o;
    },
    /** A read-only view of the state for the HUD (shallow: map, smokes, … are the live ones). */
    state() {
      if (!live) return null;
      if (cache && cacheVer === ver && cacheLive === live) return cache;
      const v = Object.assign({}, live);
      v.units = live.units.map((_, i) => S.unit(i));
      v.winner = winner;
      v.eliminated = eliminated;
      v.round = round;
      if (zone) v.zone = zone;
      v.crates = (live.crates || []).filter((c) => crateKnown.has(c.id)).map((c) => (!!c.taken === crateTaken.has(c.id) ? c : { ...c, taken: crateTaken.has(c.id) }));
      v.__shown = true;
      cache = v; cacheVer = ver; cacheLive = live;
      return v;
    },
    get winner() { return winner; },
    get version() { return ver; },
    /** Debug: what differs between the displayed model and the sim right now. */
    diff() {
      if (!live) return [];
      const out = [];
      live.units.forEach((u, i) => {
        const x = health[i];
        if (!x) return;
        for (const k of HEALTH) if ((k === 'hp' ? u.hp : k === 'bleed' ? u.bleed || 0 : !!u[k]) !== x[k]) out.push({ id: i, k, shown: x[k], live: u[k] });
      });
      if ((live.winner ?? null) !== winner) out.push({ k: 'winner', shown: winner, live: live.winner });
      return out;
    },
  };
  return S;
}
