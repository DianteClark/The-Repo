// Match juice (5.0): engagement-turn indicator, spotted / engagement banners,
// hitmarkers, kill confirms with XP popups, the medal system and The Pit
// screen. Pure DOM + a medal tracker that reads the event stream; main.js
// feeds it events and asks it for the end-of-match tally.

import { ICON } from './icons.js';
import { settings } from './settings.js';
import { MEDALS } from './progress.js';
import { medalArt } from './hubpages.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reduced = () => document.body.classList.contains('reduce-motion');

// ------------------------------------------------------------------ hitmarker / popups

let hmT = 0;
export function hitmarker(kind = 'hit') {
  if (!settings.hitmarkers) return;
  const el = $('hitmarker');
  if (!el) return;
  el.className = '';
  void el.offsetWidth;
  el.className = 'show ' + kind;
  clearTimeout(hmT);
  hmT = setTimeout(() => { el.className = ''; }, kind === 'kill' ? 520 : 320);
}

const popQ = [];
let popBusy = false;
/** "+100 KILL"-style popups, stacked and staggered so a multi-part kill reads as a rhythm. */
export function xpPop(lines) {
  if (!settings.hitmarkers) return;
  for (const l of lines) popQ.push(l);
  if (!popBusy) drainPops();
}
function drainPops() {
  const host = $('xpPops');
  if (!host || !popQ.length) { popBusy = false; return; }
  popBusy = true;
  const [label, xp, kind = ''] = popQ.shift();
  const d = document.createElement('div');
  d.className = 'xpp ' + kind;
  d.innerHTML = `<b>+${xp}</b><span>${esc(label)}</span>`;
  host.appendChild(d);
  while (host.children.length > 5) host.firstChild.remove();
  setTimeout(() => d.classList.add('out'), 1500);
  setTimeout(() => d.remove(), 2000);
  setTimeout(drainPops, reduced() ? 60 : 170);
}

let kcT = 0;
export function killConfirm(name, sub = 'Eliminated') {
  const el = $('killConfirm');
  if (!el) return;
  el.innerHTML = `<span class="kc-sk">${ICON.skull}</span><span class="kc-t"><small>${esc(sub)}</small><b>${esc(name)}</b></span>`;
  el.className = '';
  void el.offsetWidth;
  el.className = 'show';
  clearTimeout(kcT);
  kcT = setTimeout(() => { el.className = ''; }, 1800);
}

// ------------------------------------------------------------------ medals

const medalQ = [];
let medalBusy = false;
export function showMedal(key, sfx) {
  const m = MEDALS[key];
  if (!m) return;
  medalQ.push(key);
  if (!medalBusy) drainMedals(sfx);
}
function drainMedals(sfx) {
  const host = $('medalStack');
  if (!host || !medalQ.length) { medalBusy = false; return; }
  medalBusy = true;
  const key = medalQ.shift();
  const m = MEDALS[key];
  const d = document.createElement('div');
  d.className = `mdl t${m.tier}`;
  d.innerHTML = `<span class="mdl-ic">${medalArt(key, m.tier, 54)}</span><span class="mdl-t"><b>${esc(m.name)}</b><small>+${m.xp} XP</small></span>`;
  host.appendChild(d);
  const AUD = { double_kill: 'doublekill', triple_kill: 'multikill', collateral: 'multikill', longshot: 'longshot', revenge: 'revenge', first_blood: 'firstblood', survivor: 'survivor', champion: 'champion', long_odds: 'headshot', bloodthirsty: 'multikill', clutch: 'survivor' };
  try { if (typeof sfx?.raw?.medal === 'function') sfx.medal(AUD[key] || (m.tier >= 3 ? 'multikill' : 'headshot')); } catch { /* ignore */ }
  while (host.children.length > 3) host.firstChild.remove();
  setTimeout(() => d.classList.add('out'), 2300);
  setTimeout(() => d.remove(), 2800);
  setTimeout(() => drainMedals(sfx), reduced() ? 200 : 900);
}

/**
 * Medal + challenge tracker. Feed it every event (after it played) with a ctx:
 * { st, myId, myTeam, standing(u), dist(a,b) }. It keeps per-turn kill counts,
 * the last shot at each victim (for longshots, flanks, headshots), who hit my
 * squad (revenge) and the first blood flag.
 */
export function createTracker() {
  const T = {
    medals: [],
    w: { kills: 0, headshots: 0, longshots: 0, closes: 0, flanks: 0, longodds: 0, coverKills: 0, dmg: 0, multis: 0, hits: 0, shots: 0 },
    lethalKills: 0,
    streaks: 0,
    firstBlood: false,
    turnKills: 0,
    actionKills: 0,
    lastShot: new Map(),   // victim id → {from, chance, flank, dist, cover, dmg, max, weapon}
    downedIds: new Set(),  // units currently downed (from the event stream, in order)
    hitMe: new Set(),      // enemy ids that damaged my squad
    kills: 0,
  };
  const award = (key, out) => { T.medals.push(key); out.push(key); };
  T.reset = () => { T.medals = []; T.firstBlood = false; T.turnKills = 0; T.actionKills = 0; T.lastShot.clear(); T.downedIds.clear(); T.hitMe.clear(); T.kills = 0; T.lethalKills = 0; T.streaks = 0; for (const k of Object.keys(T.w)) T.w[k] = 0; };
  T.turnStart = () => { T.turnKills = 0; };
  T.actionStart = () => { T.actionKills = 0; };
  T.turnEnd = () => {
    if (T.turnKills >= 2) T.w.multis++;
    T.turnKills = 0;
  };
  /** Returns {medals:[], pops:[[label, xp, kind]]} for the UI to show. */
  T.feed = (ev, ctx) => {
    const out = [];
    const pops = [];
    const { st, myId, myTeam } = ctx;
    const mine = (id) => id === myId;
    switch (ev.type) {
      case 'shot': {
        const s = st.units[ev.from], t = st.units[ev.to];
        if (!s || !t) break;
        if (mine(ev.from)) {
          // Weapon challenge stats count the deployed primary only (not the sidearm, a legendary or the Pit pistol).
          const prim = !ctx.weaponId || !ev.weapon || ev.weapon === ctx.weaponId;
          if (prim) {
            T.w.shots++;
            if (ev.result !== 'miss') { T.w.hits++; T.w.dmg += ev.dmg || 0; }
          }
          const d = ctx.dist(s, t, ev);
          const wd = ev.weapon && s.weapons ? s.weapons.find((w) => w?.id === ev.weapon) : null;
          const range = (wd || s.weapon)?.range || 10;
          // Sim shot events carry {chance, cover, flank, headshot, dist}; older shapes fall back.
          const max = typeof ev.headshot === 'boolean' ? ev.headshot : (Array.isArray(s.weapon?.dmg) && ev.dmg >= s.weapon.dmg[1] && ev.result === 'hit');
          T.lastShot.set(ev.to, { from: ev.from, prim, chance: Number.isFinite(ev.chance) ? ev.chance : Number.isFinite(ev.hit) ? ev.hit : null, flank: !!ev.flank, dist: d, range, cover: ev.cover ?? null, dmg: ev.dmg || 0, max: ev.result === 'hit' && !!max, downed: T.downedIds.has(ev.to) && !ev.downed });
        } else if (t.team === myTeam && ev.result !== 'miss' && s.team !== myTeam) T.hitMe.add(ev.from);
        break;
      }
      case 'damage': case 'sentry_shot': case 'gunship_shot': {
        const t = st.units[ev.id ?? ev.target];
        const by = ev.by ?? ev.from ?? ev.owner;
        if (t && t.team === myTeam && Number.isInteger(by) && st.units[by]?.team !== myTeam) T.hitMe.add(by);
        break;
      }
      case 'downed': T.downedIds.add(ev.id); break;
      case 'streak_used':
        if (mine(ev.id)) { T.streaks++; award('streak_called', out); }
        break;
      case 'revive':
        T.downedIds.delete(ev.id ?? ev.target);
        if (mine(ev.by)) award('savior', out);
        break;
      case 'death': {
        const v = st.units[ev.id];
        const k = Number.isInteger(ev.by) ? st.units[ev.by] : null;
        const first = !T.firstBlood;
        T.firstBlood = true;
        T.downedIds.delete(ev.id);
        if (!v || !k || !mine(k.id) || v.team === myTeam) break;
        T.kills++;
        T.turnKills++;
        T.actionKills++;
        const shot = T.lastShot.get(v.id);
        const viaShot = shot && shot.from === k.id && (!ev.source || ev.source === 'shot');
        const lethal = ['grenade', 'frag', 'semtex', 'claymore', 'knife', 'barrel', 'breach', 'launcher'].includes(ev.source || ctx.lastBlast);
        pops.push(['KILL', 100, 'kill']);
        if (first) { award('first_blood', out); pops.push(['FIRST BLOOD', 200, 'gold']); }
        if (viaShot) {
          const w = shot.prim ? T.w : {}; // challenge tallies: primary weapon only
          w.kills = (w.kills || 0) + 1;
          if (shot.dist >= 10) { award('longshot', out); pops.push(['LONGSHOT', 50]); }
          if (shot.dist >= shot.range * 0.75) w.longshots = (w.longshots || 0) + 1;
          if (shot.dist <= 1.5) award('point_blank', out);
          if (shot.dist <= 3) w.closes = (w.closes || 0) + 1;
          if (shot.flank) { award('flanker', out); w.flanks = (w.flanks || 0) + 1; pops.push(['FLANK', 50]); }
          if (shot.chance !== null && shot.chance <= 50) w.longodds = (w.longodds || 0) + 1;
          if (shot.chance !== null && shot.chance <= 40) { award('long_odds', out); pops.push(['LONG ODDS', 75]); }
          if (shot.cover) w.coverKills = (w.coverKills || 0) + 1;
          if (shot.max) { w.headshots = (w.headshots || 0) + 1; pops.push(['HEADSHOT', 50]); }
          if (shot.downed) { award('executioner', out); pops.push(['EXECUTION', 25]); }
        } else if (lethal) {
          T.lethalKills++;
          award('demolition', out);
          pops.push(['DEMOLITION', 50]);
        }
        if (T.hitMe.has(v.id)) { award('revenge', out); pops.push(['REVENGE', 50]); T.hitMe.delete(v.id); }
        if (T.turnKills === 2) { award('double_kill', out); pops.push(['DOUBLE KILL', 100, 'gold']); }
        if (T.turnKills === 3) { award('triple_kill', out); pops.push(['TRIPLE KILL', 200, 'gold']); }
        if (T.actionKills === 2) award('collateral', out);
        const me = st.units[myId];
        const mates = st.teams[myTeam]?.members.filter((id) => id !== myId && ctx.standing(st.units[id])).length || 0;
        if (me && me.hp <= 3 && !mates && st.teams[myTeam].members.length > 1) award('clutch', out);
        if (T.kills === 5) award('bloodthirsty', out);
        break;
      }
      case 'redeploy':
        if (mine(ev.id)) award('comeback', out);
        break;
      default:
    }
    return { medals: out, pops };
  };
  T.finish = ({ won, hp }) => {
    if (T.turnKills >= 2) T.w.multis++;
    T.turnKills = 0;
    if (won) T.medals.push('champion');
    if (won && hp > 0 && hp <= 3) T.medals.push('survivor');
    return T.medals;
  };
  return T;
}

// ------------------------------------------------------------------ engagement indicator

let lastEngaged = '';
let engagedTxt = '';
export function engagedWith() { return engagedTxt; }
/**
 * {active, engagements, round} from the controller's onStep. Shows "3 squads moving ·
 * engaged with Squad 7", and a banner when contact starts.
 */
export function renderStep({ active = [], engagements = [], myTeam, nameOf, colorOf, banner, sfx }) {
  const el = $('engageInfo');
  if (!el) return;
  const grp = engagements.find((g) => g.includes(myTeam)) || null;
  const foes = grp ? grp.filter((t) => t !== myTeam) : [];
  const n = active.length;
  const mineActive = active.includes(myTeam);
  engagedTxt = foes.length ? `vs ${foes.map((t) => nameOf(t)).join(', ')}` : '';
  const chips = foes.slice(0, 3).map((t) => `<i style="--sq:${colorOf(t)}">${esc(nameOf(t))}</i>`).join('');
  const cls = `engage${foes.length ? ' hot' : ''}${mineActive ? ' mine' : ''}`;
  const html = `<span class="en-n"><b>${n}</b> squad${n === 1 ? '' : 's'} moving</span>${foes.length ? `<span class="en-sep"></span><span class="en-vs">${ICON.target}${mineActive ? 'Engaged' : 'Contact'} ${chips}${foes.length > 3 ? `<em>+${foes.length - 3}</em>` : ''}</span>` : mineActive ? '<span class="en-sep"></span><span class="en-free">Free move</span>' : ''}`;
  if (el._beat) el._beat = { html, cls }; else { el.className = cls; el.innerHTML = html; }
  const sig = foes.slice().sort().join(',');
  if (sig && sig !== lastEngaged) {
    banner?.(foes.length > 1 ? 'ENGAGEMENT' : 'CONTACT', 'engage', `${engagedTxt} · squads in contact take turns in order`, 1500);
    try { if (typeof sfx?.raw?.engagementStart === 'function') sfx.engagementStart(); else sfx?.stinger?.('round'); } catch { /* ignore */ }
  }
  lastEngaged = sig;
}
let beatT = 0;
/** Director focus beat ("Squad 7 is moving"): flashes the engagement chip for a moment. */
export function focusBeat({ name, color }) {
  const el = $('engageInfo');
  if (!el || !name) return;
  clearTimeout(beatT);
  if (!el._beat) el._beat = { html: el.innerHTML, cls: el.className };
  el.className = 'engage beat';
  el.style.setProperty('--bc', color || 'var(--line-hi)');
  el.innerHTML = `<span class="fb"><i></i>${esc(String(name).toUpperCase())} MOVING</span>`;
  beatT = setTimeout(() => { const b = el._beat; el._beat = null; if (b) { el.className = b.cls; el.innerHTML = b.html; } }, 1500);
}
export function resetStep() {
  clearTimeout(beatT); lastEngaged = ''; engagedTxt = ''; const el = $('engageInfo'); if (el) { el._beat = null; el.className = 'engage hidden'; el.innerHTML = ''; } }

// ------------------------------------------------------------------ The Pit

let pitT = 0;
export function showPit({ phase, mine, meName, foeName, won, round, onClose }) {
  const el = $('pitScreen');
  if (!el) return;
  clearTimeout(pitT);
  const vs = $('pitVs');
  if (phase === 'enter') {
    $('pitRound').textContent = round ? `Round ${round}` : '';
    vs.innerHTML = `<div class="pv-me"><b>${esc(meName)}</b><small>You</small></div><span class="pv-x">${ICON.pit}</span><div class="pv-foe"><b>Waiting…</b><small>Next soldier to fall</small></div>`;
    $('pitSub').textContent = 'Your first death sent you to the Pit. Win a 1v1 duel with pistols and a frag to redeploy at 6 HP.';
    $('pitOk').textContent = 'Understood';
  } else if (phase === 'start') {
    vs.innerHTML = `<div class="pv-me"><b>${esc(meName)}</b><small>You</small></div><span class="pv-x">VS</span><div class="pv-foe"><b>${esc(foeName || 'Pit Warden')}</b><small>Opponent</small></div>`;
    $('pitSub').textContent = 'Same rules, tiny arena. Last one standing goes back in.';
    $('pitOk').textContent = 'Fight';
  } else if (phase === 'end') {
    vs.innerHTML = won ? `<div class="pv-res win"><b>YOU WON THE DUEL</b><small>Redeploying next round · 6 HP</small></div>` : `<div class="pv-res lose"><b>DEFEATED</b><small>The Pit claims you</small></div>`;
    $('pitSub').textContent = won ? 'Parachuting back in at the next round start.' : 'You are out of the match. Spectate your squad or skip to the results.';
    $('pitOk').textContent = won ? 'Redeploy' : 'Continue';
  }
  el.dataset.phase = phase;
  el.classList.toggle('mine', !!mine);
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('open'));
  const close = () => { el.classList.remove('open'); setTimeout(() => el.classList.add('hidden'), 300); onClose?.(); };
  $('pitOk').onclick = close;
  pitT = setTimeout(close, phase === 'start' ? 2600 : 3600);
}

export function reset() {
  resetStep();
  popQ.length = 0; medalQ.length = 0;
  const ids = ['xpPops', 'medalStack'];
  for (const id of ids) { const el = $(id); if (el) el.innerHTML = ''; }
  const kc = $('killConfirm'); if (kc) kc.className = '';
  const hm = $('hitmarker'); if (hm) hm.className = '';
  const pit = $('pitScreen'); if (pit) { pit.classList.add('hidden'); pit.classList.remove('open'); }
}
