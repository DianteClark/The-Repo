// Stage roulette (5.1): the stage is always random, so every match opens with a
// dramatic reel of the five stage cards that ticks past a pointer, decelerates
// and lands on the stage the match seed already chose (state.stage). Host and
// clients all land on the same card because they all read the same state.
// Skippable (tap / Esc / Space); flows straight into the DROP IN intro.

import { stageArt, stageIcon } from './stages.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const LOOPS = 7;          // how many times the reel cycles before it lands
const LAND_LOOP = 5;      // the loop whose target card it lands on

/**
 * opts: { stages:[{key,name,short,tagline,twist,icon}], target:'harbor', sfx, buzz, fast, reduced, kicker }
 * Returns { done: Promise<boolean skipped>, skip() }.
 */
export function spinStageWheel({ stages, target, sfx = {}, buzz = () => {}, fast = false, reduced = false, kicker = '' }) {
  const el = $('stageWheel');
  const strip = $('swStrip');
  const reveal = $('swReveal');
  const list = stages.length ? stages : [{ key: target, name: target }];
  let ti = list.findIndex((s) => s.key === target);
  if (ti < 0) ti = 0;
  const tgt = list[ti];

  // Build the reel: LOOPS × stages, each a card with the stage art.
  const cards = [];
  for (let l = 0; l < LOOPS; l++) for (let i = 0; i < list.length; i++) cards.push({ st: list[i], land: l === LAND_LOOP && i === ti });
  strip.innerHTML = cards.map((c, i) => `<div class="sw-c st-${c.st.key}${c.land ? ' land' : ''}" data-i="${i}">${stageArt(c.st.key)}<span class="sw-cn"><b>${esc(c.st.name)}</b></span></div>`).join('');
  reveal.innerHTML = '';
  reveal.className = 'sw-reveal';
  $('swMode').textContent = kicker;
  el.classList.remove('hidden', 'landed', 'out');
  el.classList.add('show');

  const cardEls = [...strip.children];
  const landEl = strip.querySelector('.sw-c.land');
  let raf = 0;
  let finished = false;
  let resolveFn;
  const done = new Promise((r) => { resolveFn = r; });
  const timers = [];

  const geometry = () => {
    const cw = cardEls[0]?.offsetWidth || 150;
    const gap = parseFloat(getComputedStyle(strip).columnGap || getComputedStyle(strip).gap) || 10;
    const reelW = strip.parentElement.clientWidth;
    return { pitch: cw + gap, cw, reelW };
  };
  // x offset that centres card i under the pointer
  const xFor = (i, g) => -(i * g.pitch) + (g.reelW - g.cw) / 2;
  const setX = (x) => { strip.style.transform = `translate3d(${x.toFixed(1)}px,0,0)`; };

  const landIdx = LAND_LOOP * list.length + ti;
  const g0 = geometry();
  // start a little before the first loop so the reel enters already moving
  const startI = 0.4 + (Math.random() * 0.4);
  const x0 = xFor(startI, g0), x1 = xFor(landIdx, g0);
  // a few px of overshoot jitter makes it feel mechanical rather than computed
  const dur = fast ? 380 : reduced ? 1200 : 3400 + Math.random() * 500;
  setX(x0);

  // Decelerating spin: quintic ease-out with a tiny settle at the end.
  const ease = (t) => 1 - Math.pow(1 - t, 4.2);
  let lastTick = Math.floor(startI + 0.5);
  const t0 = performance.now();
  const step = (now) => {
    if (finished) return;
    const t = Math.min(1, (now - t0) / dur);
    const g = geometry();
    const x = xFor(startI, g) + (xFor(landIdx, g) - xFor(startI, g)) * ease(t);
    setX(x);
    // which card is under the pointer now: tick once per card
    const ci = Math.round(((g.reelW - g.cw) / 2 - x) / g.pitch);
    if (ci !== lastTick) {
      lastTick = ci;
      cardEls.forEach((c, i) => c.classList.toggle('hot', i === ci));
      if (!fast) { try { sfx.tick?.(t > 0.82); } catch { /* ignore */ } }
      if (t > 0.7 && !fast) buzz('tap');
    }
    if (t < 1) raf = requestAnimationFrame(step);
    else land(false);
  };
  void x1;

  function land(skipped) {
    if (el.classList.contains('landed')) return;
    cancelAnimationFrame(raf);
    const g = geometry();
    strip.style.transition = skipped ? 'transform .28s cubic-bezier(.2,.8,.2,1)' : '';
    setX(xFor(landIdx, g));
    cardEls.forEach((c) => c.classList.remove('hot'));
    landEl?.classList.add('hot', 'won');
    el.classList.add('landed');
    try { sfx.stageLand ? sfx.stageLand(tgt.key) : (sfx.uiConfirm ? sfx.uiConfirm() : sfx.turn?.()); } catch { /* ignore */ }
    try { sfx.stinger?.('round'); } catch { /* ignore */ }
    buzz('turn');
    reveal.innerHTML = `<span class="swr-ic">${stageIcon(tgt)}</span><div class="swr-t"><small>${esc(tgt.short || 'Stage')}</small><b>${esc(tgt.name)}</b><p>${esc(tgt.twist || tgt.tagline || '')}</p></div>`;
    requestAnimationFrame(() => reveal.classList.add('in'));
    timers.push(setTimeout(() => finish(skipped), fast ? 250 : skipped ? 900 : 2300));
  }

  function finish(skipped) {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(raf);
    timers.forEach(clearTimeout);
    el.removeEventListener('pointerdown', onTap);
    el.classList.add('out');
    setTimeout(() => { el.classList.add('hidden'); el.classList.remove('show', 'out', 'landed'); strip.style.transition = ''; strip.innerHTML = ''; }, 380);
    resolveFn(skipped);
  }

  const skip = () => {
    if (finished) return;
    if (!el.classList.contains('landed')) land(true);
    else finish(true);
  };
  const onTap = () => { try { sfx.uiClick?.(); } catch { /* ignore */ } skip(); };
  el.addEventListener('pointerdown', onTap);
  // first frame after layout, so the geometry is real
  requestAnimationFrame(() => { raf = requestAnimationFrame(step); });
  return { done, skip, cancel: () => finish(true) };
}
