// Turn-model adapter: engagement turns (5.0: activeTeams / endTeamTurn(state, team)) when the sim
// has them, otherwise the classic one-squad-at-a-time model (currentTeamId / endTeamTurn(state)).
// Pure logic, no DOM: also used by node tests.

export function turnModel(G) {
  const engagement = typeof G.activeTeams === 'function';
  const standing = (u) => !!u && u.alive && !u.downed;
  return {
    engagement,
    /** Squads whose turn is open right now. */
    active(state) {
      if (state.winner !== null && state.winner !== undefined) return [];
      if (engagement) { try { return [...(G.activeTeams(state) || [])]; } catch { /* fall through */ } }
      const t = typeof G.currentTeamId === 'function' ? G.currentTeamId(state) : state.order?.[state.turnPos];
      return t === undefined || t === null ? [] : [t];
    },
    isActive(state, team) {
      if (engagement && typeof G.isTeamActive === 'function') { try { return !!G.isTeamActive(state, team); } catch { /* fall through */ } }
      return this.active(state).includes(team);
    },
    /** End one squad's turn. Returns events. */
    endTeam(state, team) {
      if (engagement) return G.endTeamTurn(state, team) || [];
      return G.endTeamTurn(state) || [];
    },
    engagements(state) {
      if (typeof G.engagements === 'function') { try { return G.engagements(state) || []; } catch { /* ignore */ } }
      return [];
    },
    /** Stable key for "the current step" (changes when the sim advances a step or round). */
    stepKey(state) {
      return `${state.round}:${state.step ?? state.turnPos ?? 0}:${state.turnSerial ?? ''}`;
    },
    standing,
  };
}

/** Run one bot-only step for tests / attract: every active squad's standing bots act, then end. */
export function runBotStep(G, AI, state, model = turnModel(G), onEvents = () => {}) {
  const active = model.active(state);
  for (const t of active) {
    if (state.winner !== null) break;
    for (const id of state.teams[t].members) {
      const u = state.units[id];
      if (!model.standing(u) || state.winner !== null) continue;
      let evs = [];
      try { evs = AI.botTakeTurn(state, id) || []; } catch (e) { evs = []; }
      onEvents(evs, { team: t, unitId: id });
    }
    if (state.winner !== null) break;
    onEvents(model.endTeam(state, t), { team: t, end: true });
  }
  return active;
}
