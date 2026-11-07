// Match controller: menu → turns → end screen. The sim decides, this file
// only feeds it player input and plays back the resulting events.

import {
  createGame, act, endTeamTurn, currentTeamId, moveOptions, shotPreview,
  insideZone, roundsUntilShrink, aliveTeams, zoneDamage,
} from '../sim/game.js';
import { botTakeTurn } from '../sim/ai.js';
import { CLASSES, MODES, TURN_SECONDS, CRATE_LABEL } from '../sim/constants.js';
import { weaponRange } from '../sim/rules.js';
import { Renderer } from './render.js';
import { Sfx } from './audio.js';
import { keepAwake, allowSleep } from './wakelock.js';

const $ = (id) => document.getElementById(id);
const sfx = new Sfx();
const R = new Renderer($('scene'), {
  sfx,
  onTileTap: (x, y) => onTileTap(x, y),
  onUnitTap: (id) => onUnitTap(id),
  onFeed: (m) => feed(m),
});

let mode = 'solos';
let cls = 'assault';
let state = null;
let gameToken = 0;
let turnCtx = null; // active human turn
let fastForward = false;
let playerPlace = null;

// ---------- menu ----------

function buildMenu() {
  const mc = $('modeChoices');
  mc.innerHTML = '';
  for (const [k, m] of Object.entries(MODES)) {
    const b = document.createElement('button');
    b.className = 'choice' + (k === mode ? ' sel' : '');
    const desc = k === 'trios' ? '5 × 3 + lone wolf' : `${16 / m.teamSize} × ${m.teamSize}`;
    b.innerHTML = `<b>${m.name}</b><small>${desc}</small>`;
    b.onclick = () => { mode = k; buildMenu(); };
    mc.appendChild(b);
  }
  $('wolfRow').classList.toggle('hidden', mode !== 'trios');
  const cc = $('classChoices');
  cc.innerHTML = '';
  for (const [k, c] of Object.entries(CLASSES)) {
    const b = document.createElement('button');
    b.className = 'choice' + (k === cls ? ' sel' : '');
    b.innerHTML = `<b>${c.name}</b><small>${c.desc}</small><small>HP ${c.hp} · ${c.weapon.name} ${c.weapon.range}t</small>`;
    b.onclick = () => { cls = k; buildMenu(); };
    cc.appendChild(b);
  }
}
buildMenu();

$('playBtn').onclick = () => startGame();
$('againBtn').onclick = () => { $('endScreen').classList.add('hidden'); $('menu').classList.remove('hidden'); };
$('rotL').onclick = () => R.rotate(-1);
$('rotR').onclick = () => R.rotate(1);
$('focusBtn').onclick = () => { const d = R.myRef(); R.focus(d.x, d.y); };
$('muteBtn').onclick = () => { $('muteBtn').textContent = sfx.toggle() ? '🔇' : '🔊'; };
$('tpClose').onclick = () => hideTarget();
$('owBtn').onclick = () => doAction({ type: 'overwatch' });
$('medBtn').onclick = () => doAction({ type: 'medkit' });
$('endBtn').onclick = () => {
  if (turnCtx && !turnCtx.busy) doAction({ type: 'hold' });
  else if (!playerAlive() && state && state.winner === null) { fastForward = true; feed('Skipping to results…'); }
};

// ---------- game loop ----------

async function startGame() {
  sfx.resume();
  keepAwake();
  fastForward = false;
  playerPlace = null;
  state = createGame({ mode, playerClass: cls, volunteerLoneWolf: $('wolfBox').checked });
  R.setGame(state, state.playerTeam);
  R.speed = 1;
  $('menu').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('feed').innerHTML = '';
  const me = state.units.find((u) => u.isPlayer);
  feed(`${MODES[mode].name} · ${state.teams.length} squads · seed ${state.seed}`);
  if (me.isLoneWolf) feed('You are the Lone Wolf: +1 AP, +50% HP, +1 armor.');
  runMatch(++gameToken);
}

async function play(events) {
  for (const ev of events) {
    if (!fastForward) await R.playEvent(ev);
    meta(ev);
  }
  if (!fastForward) updateHud();
}

async function runMatch(token) {
  await play(state.startEvents);
  while (state.winner === null && token === gameToken) {
    const t = currentTeamId(state);
    const team = state.teams[t];
    if (!fastForward) updateHud();
    for (const id of team.members) {
      const u = state.units[id];
      if (u.isPlayer || !u.alive) continue;
      await play(botTakeTurn(state, id));
      if (state.winner !== null) break;
    }
    const human = team.members.map((id) => state.units[id]).find((u) => u.isPlayer && u.alive);
    if (state.winner === null && human && human.ap > 0) await humanTurn(human);
    if (token !== gameToken) return;
    await play(endTeamTurn(state));
    if (fastForward) await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
  }
  if (token !== gameToken) return;
  if (fastForward) R.syncFromState();
  updateHud();
  showEnd();
}

function humanTurn(u) {
  return new Promise((resolve) => {
    turnCtx = { u, resolve, deadline: performance.now() + TURN_SECONDS * 1000, busy: false, lastTick: TURN_SECONDS };
    R.focus(u.x, u.y);
    sfx.turn();
    banner('YOUR TURN', '#ffb000');
    refreshHighlights();
    updateHud();
    timerLoop();
  });
}

function timerLoop() {
  const c = turnCtx;
  if (!c) { $('timerBar').style.width = '0%'; $('timerText').textContent = ''; return; }
  const left = Math.max(0, (c.deadline - performance.now()) / 1000);
  $('timerBar').style.width = (left / TURN_SECONDS) * 100 + '%';
  $('timerBar').classList.toggle('low', left <= 5);
  $('timerText').textContent = Math.ceil(left) + 's';
  const whole = Math.ceil(left);
  if (whole !== c.lastTick) { c.lastTick = whole; if (whole <= 5 && whole > 0) sfx.tick(true); }
  if (left <= 0 && !c.busy) {
    feed('Time! Auto-overwatch.');
    doAction(c.u.ap > 0 ? { type: 'overwatch' } : { type: 'hold' });
  }
  requestAnimationFrame(timerLoop);
}

function finishTurn() {
  const c = turnCtx;
  turnCtx = null;
  R.setHighlights(null);
  hideTarget();
  c?.resolve();
}

async function doAction(a) {
  const c = turnCtx;
  if (!c || c.busy) return;
  c.busy = true;
  R.setHighlights(null);
  hideTarget();
  const r = act(state, c.u.id, a);
  if (!r.ok) {
    feed(r.error);
    c.busy = false;
    refreshHighlights();
    updateHud();
    return;
  }
  await play(r.events);
  c.busy = false;
  if (turnCtx !== c) return;
  if (!c.u.alive || c.u.ap <= 0 || state.winner !== null) finishTurn();
  else { refreshHighlights(); updateHud(); }
}

function refreshHighlights() {
  if (!turnCtx) return;
  const u = turnCtx.u;
  const reach = moveOptions(state, u);
  const hl = new Map();
  for (const [k, n] of reach) {
    if (n.d === 0) continue;
    hl.set(k, n.d <= u.move ? 1 : 2);
  }
  R.setHighlights(hl);
}

// ---------- input ----------

function onTileTap(x, y) {
  if (!state) return;
  const enemy = state.units.find((e) => e.alive && e.x === x && e.y === y && e.team !== state.playerTeam && R.unitObjs[e.id].g.visible);
  if (enemy) return onUnitTap(enemy.id);
  if (!turnCtx || turnCtx.busy) return;
  const k = y * state.map.size + x;
  if (R.highlight?.has(k)) doAction({ type: 'move', x, y });
  else hideTarget();
}

function onUnitTap(id) {
  const t = state.units[id];
  if (!turnCtx || turnCtx.busy || t.team === state.playerTeam) return;
  const p = shotPreview(state, turnCtx.u, t);
  if (!p) { feed(`No shot on ${t.name}: out of range or no line of sight.`); return; }
  $('tpName').textContent = `Squad ${t.team + 1} · ${t.name} (${CLASSES[t.cls].name})`;
  $('tpChance').textContent = p.chance + '%';
  $('tpGraze').textContent = p.graze ? `+${p.graze}% graze` : '';
  $('tpDmg').textContent = `Damage ${p.dmg[0]}–${p.dmg[1]} · target HP ${t.hp}/${t.maxHp}${t.armor ? ` · armor ${t.armor}` : ''}`;
  $('tpNotes').textContent = p.notes.join(' · ');
  $('targetPanel').classList.remove('hidden');
  $('fireBtn').onclick = () => doAction({ type: 'shoot', targetId: id });
}

function hideTarget() { $('targetPanel').classList.add('hidden'); }

// ---------- HUD ----------

const playerAlive = () => state?.units.some((u) => u.isPlayer && u.alive);

function teamName(t) {
  if (t === state.playerTeam) return MODES[state.mode].teamSize > 1 ? 'Your squad' : 'You';
  return `Squad ${t + 1}` + (state.teams[t].isLoneWolf ? ' (Lone Wolf)' : '');
}
const unitName = (u) => (u.team === state.playerTeam ? u.name : `${u.name} [S${u.team + 1}]`);

function updateHud() {
  if (!state) return;
  const z = state.zone;
  const left = aliveTeams(state).length;
  $('roundInfo').textContent = `Round ${state.round} · ${left} squads left · tide rises in ${roundsUntilShrink(state)} rd · tide dmg ${zoneDamage(state)}`;
  const t = currentTeamId(state);
  $('turnInfo').textContent = state.winner !== null ? 'Match over' : (turnCtx ? 'YOUR TURN' : `${teamName(t)} moving…`);
  $('turnInfo').style.color = turnCtx ? '#ffb000' : (t === state.playerTeam ? '#ffb000' : '#ff3fa4');
  if (!turnCtx) { $('timerBar').style.width = '0%'; $('timerText').textContent = ''; }

  const u = state.units.find((x) => x.isPlayer);
  const c = CLASSES[u.cls];
  const outside = !insideZone(state, u.x, u.y, z.next);
  const pips = Array.from({ length: u.maxAp }, (_, i) => `<i class="${turnCtx && i < u.ap ? 'on' : ''}"></i>`).join('');
  const mods = [u.mods.scope && `scope ×${u.mods.scope}`, u.mods.barrel && `barrel ×${u.mods.barrel}`].filter(Boolean).join(', ');
  $('unitCard').innerHTML = u.alive ? `
    <div class="row"><span class="name">${c.name}</span>${u.isLoneWolf ? '<span class="tag">LONE WOLF</span>' : ''}
      <div class="hpbar"><i style="width:${(u.hp / u.maxHp) * 100}%"></i></div><span>${u.hp}/${u.maxHp}</span>
      <div class="pips" title="Action points">${pips}</div></div>
    <div class="stats">${c.weapon.name}: range ${weaponRange(u)} · aim ${u.weapon.aim + u.mods.scope * 5} · dmg ${u.weapon.dmg[0] + u.mods.barrel}–${u.weapon.dmg[1] + u.mods.barrel}
      · armor ${u.armor} · medkits ${u.items.medkit}${mods ? ' · ' + mods : ''}${u.missStreak ? ` · miss streak +${u.missStreak * 10}%` : ''}
      ${outside ? '<br><b style="color:#5fc8e0">The tide will reach you — move inside the cyan ring.</b>' : ''}</div>`
    : `<div class="row"><span class="name">Eliminated</span><span class="tag">Spectating · ${u.kills} kills</span></div>`;

  const myTurn = !!turnCtx && !turnCtx.busy;
  $('owBtn').disabled = !myTurn;
  $('medBtn').disabled = !myTurn || u.items.medkit < 1 || u.hp >= u.maxHp;
  $('medBtn').textContent = `Medkit (${u.items.medkit})`;
  if (u.alive) { $('endBtn').textContent = 'End turn'; $('endBtn').disabled = !myTurn; }
  else { $('endBtn').textContent = 'Skip to results'; $('endBtn').disabled = state.winner !== null; }
}

function feed(msg) {
  if (fastForward) return;
  const d = document.createElement('div');
  d.textContent = msg;
  const f = $('feed');
  f.prepend(d);
  while (f.children.length > 6) f.lastChild.remove();
}

let bannerTimer = 0;
function banner(text, color = '#e7e3d6') {
  if (fastForward) return;
  const b = $('banner');
  b.textContent = text;
  b.style.color = color;
  b.classList.remove('hidden');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.add('hidden'), 1300);
}

function meta(ev) {
  switch (ev.type) {
    case 'death': {
      const u = state.units[ev.id];
      const k = ev.by !== null ? state.units[ev.by] : null;
      feed(k ? `${unitName(k)} eliminated ${unitName(u)}` : `${unitName(u)} was taken by the tide`);
      if (u.isPlayer) {
        banner('YOU WERE ELIMINATED', '#ff5a4f');
        R.setSpectator(true);
        R.speed = 2.5;
      }
      break;
    }
    case 'team_out':
      if (ev.team === state.playerTeam) playerPlace = ev.place;
      feed(`${teamName(ev.team)} is out — #${ev.place}`);
      break;
    case 'crate': {
      const u = state.units[ev.id];
      if (u.team === state.playerTeam) feed(`${unitName(u)}: ${CRATE_LABEL[ev.item]}`);
      break;
    }
    case 'overwatch_trigger':
      if (state.units[ev.target].team === state.playerTeam) feed('Overwatch shot on ' + unitName(state.units[ev.target]) + '!');
      break;
    case 'zone_shrink':
      banner('THE TIDE RISES', '#7fe9ff');
      feed(`The tide rises. Safe radius ${ev.r} → next ${ev.next}.`);
      break;
    case 'round_start':
      if (!fastForward) updateHud();
      break;
    case 'game_over':
      allowSleep();
      break;
    default:
  }
}

function showEnd() {
  const me = state.units.find((u) => u.isPlayer);
  const won = state.winner === state.playerTeam;
  $('endTitle').textContent = won ? 'LAST SQUAD STANDING' : `#${playerPlace ?? '?'} of ${state.teams.length}`;
  $('endTitle').style.color = won ? '#ffb000' : '#e7e3d6';
  $('endStats').textContent = `${MODES[state.mode].name} · ${me.kills} kill${me.kills === 1 ? '' : 's'} · ${state.round} rounds · seed ${state.seed}`;
  setTimeout(() => $('endScreen').classList.remove('hidden'), fastForward ? 0 : 1200);
  $('hud').classList.toggle('hidden', false);
}

// Test hooks for automated smoke tests: open the page with ?debug.
if (location.search.includes('debug')) {
  window.__dbg = {
    state: () => state,
    R,
    aim() {
      if (!turnCtx) return 'not my turn';
      const u = turnCtx.u;
      const t = state.units.find((e) => e.alive && e.team !== u.team && shotPreview(state, u, e));
      if (!t) return 'no target';
      R.focus(t.x, t.y);
      onUnitTap(t.id);
      return 'aiming at ' + t.name;
    },
    tapFirstReachable() {
      if (!turnCtx || !R.highlight) return 'not my turn';
      const [k] = [...R.highlight.entries()].filter(([, v]) => v === 1).pop() || [];
      if (k === undefined) return 'nothing reachable';
      const S = state.map.size;
      onTileTap(k % S, (k / S) | 0);
      return `moved to ${k % S},${(k / S) | 0}`;
    },
    autoplay() {
      if (turnCtx && !turnCtx.busy) {
        const u = turnCtx.u;
        const shot = state.units.filter((e) => e.alive && e.team !== u.team).map((e) => [e, shotPreview(state, u, e)]).find(([, p]) => p);
        doAction(shot ? { type: 'shoot', targetId: shot[0].id } : { type: 'overwatch' });
      } else if (!playerAlive()) fastForward = true;
    },
  };
}
