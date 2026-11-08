// Inline SVG icon set (no emoji, no external files). Every icon is a 24×24
// stroke drawing that inherits currentColor, so CSS decides the colour.

const S = (body, extra = '') =>
  `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;

export const ICON = {
  move: S('<path d="M4 18c3-1 4-4 6-7s4-5 9-6"/><path d="M15 4.5l4 .5-.6 4"/><circle cx="4.5" cy="18.5" r="1.6" fill="currentColor"/>'),
  shoot: S('<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/>'),
  grenade: S('<path d="M9.5 7.5h5l1 2.2A6.5 6.5 0 1 1 8.5 9.7z"/><path d="M10 7.5V5.5h4v2"/><path d="M14 5.5c1.5-2.2 4-2.3 5.5-.8"/><path d="M9.5 13h5M9.5 16h5"/>'),
  aimed: S('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2"/><path d="M12 1.5V5M12 19v3.5M1.5 12H5M19 12h3.5"/><path d="M17.5 3.5l3 3" stroke-width="1.6"/>'),
  breach: S('<path d="M5 21V4h9v17"/><path d="M14 9l3.5-2M14 13h5M14 16.5l3.5 2"/><path d="M8 12l2-2 1 3 1.5-2.2"/>'),
  hunker: S('<path d="M12 3l7 3v5c0 5-3.2 8.2-7 10-3.8-1.8-7-5-7-10V6z"/><path d="M8.5 13.5L12 10l3.5 3.5"/>'),
  overwatch: S('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r=".8" fill="currentColor"/>'),
  medkit: S('<rect x="3" y="6.5" width="18" height="13" rx="2.5"/><path d="M9 6.5V4.5h6v2"/><path d="M12 10v6M9 13h6"/>'),
  end: S('<path d="M5 5l8 7-8 7z" fill="currentColor" stroke="none"/><path d="M13 5l7 7-7 7"/>'),
  check: S('<path d="M4.5 12.5l5 5L19.5 7"/>'),
  close: S('<path d="M6 6l12 12M18 6L6 18"/>'),
  back: S('<path d="M15 5l-7 7 7 7"/>'),
  rotL: S('<path d="M4 4v6h6"/><path d="M4.6 14a8 8 0 1 0 1.8-8.3L4 10"/>'),
  rotR: S('<path d="M20 4v6h-6"/><path d="M19.4 14a8 8 0 1 1-1.8-8.3L20 10"/>'),
  focus: S('<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22"/><circle cx="12" cy="12" r="7.5"/>'),
  soundOn: S('<path d="M4 9.5h3.5L13 5v14l-5.5-4.5H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>'),
  soundOff: S('<path d="M4 9.5h3.5L13 5v14l-5.5-4.5H4z"/><path d="M17 9.5l5 5M22 9.5l-5 5"/>'),
  pause: S('<path d="M8.5 5v14M15.5 5v14" stroke-width="2.6"/>'),
  menu: S('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  skull: S('<path d="M12 3a8 8 0 0 0-5 14.2V20h10v-2.8A8 8 0 0 0 12 3z"/><circle cx="9" cy="11.5" r="1.7" fill="currentColor"/><circle cx="15" cy="11.5" r="1.7" fill="currentColor"/><path d="M10.5 20v-2M13.5 20v-2"/>'),
  tide: S('<path d="M2 9c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2"/><path d="M2 14c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2"/><path d="M2 19c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2"/>'),
  crate: S('<path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9"/>'),
  drop: S('<path d="M6 9a6 6 0 0 1 12 0"/><path d="M6 9l6 6 6-6M12 15v0"/><rect x="9" y="15" width="6" height="5" rx="1"/>'),
  squads: S('<circle cx="8" cy="8" r="3"/><circle cx="16.5" cy="9" r="2.5"/><path d="M2.5 19c.6-3.6 2.8-5.5 5.5-5.5s4.9 1.9 5.5 5.5"/><path d="M14 14.5c.8-.6 1.6-.9 2.5-.9 2.3 0 3.9 1.7 4.5 5.4"/>'),
  clock: S('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>'),
  shield: S('<path d="M12 3l7 3v5c0 5-3.2 8.2-7 10-3.8-1.8-7-5-7-10V6z"/>'),
  scope: S('<rect x="3" y="9" width="13" height="6" rx="3"/><path d="M16 12h5M7 9V7M12 9V7"/>'),
  barrel: S('<path d="M3 10h14v4H3z"/><path d="M17 11h4v2h-4M6 10V8h4v2"/>'),
  heart: S('<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20z"/>'),
  bolt: S('<path d="M13 2L5 13h6l-1 9 8-11h-6z"/>'),
  wolf: S('<path d="M4 4l4 5h8l4-5-1 9-3 5-4 3-4-3-3-5z"/><path d="M9.5 13.5h.01M14.5 13.5h.01" stroke-width="3"/>'),
  burst: S('<path d="M12 2l1.8 5.2L19 5l-2.2 5.2L22 12l-5.2 1.8L19 19l-5.2-2.2L12 22l-1.8-5.2L5 19l2.2-5.2L2 12l5.2-1.8L5 5l5.2 2.2z"/>'),
  ff: S('<path d="M3 5l8 7-8 7zM12 5l8 7-8 7z" fill="currentColor" stroke="none"/>'),
  play: S('<path d="M7 4.5l13 7.5-13 7.5z" fill="currentColor" stroke="none"/>'),
  gear: S('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>'),
  book: S('<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5z"/><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H20v-3"/><path d="M8 7.5h8M8 11h6"/>'),
  link: S('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>'),
  lock: S('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  eye: S('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  tap: S('<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M12 10.5V9.5a1.5 1.5 0 0 1 3 0v2a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.7a6 6 0 0 1-4.7-2.3L4 15.3a1.5 1.5 0 0 1 2.3-1.9L9 15.5"/>'),
  warn: S('<path d="M12 3.5L22 20H2z"/><path d="M12 10v4.5M12 17.5v.01"/>'),
  trophy: S('<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H4.5a3 3 0 0 0 3.5 4M16 6h3.5a3 3 0 0 1-3.5 4"/><path d="M12 13v4M8 21h8M9.5 17h5v4h-5z"/>'),
  patch: S('<path d="M4.5 9.5l5-5a3.5 3.5 0 0 1 5 0l5 5a3.5 3.5 0 0 1 0 5l-5 5a3.5 3.5 0 0 1-5 0l-5-5a3.5 3.5 0 0 1 0-5z"/><path d="M12 9v6M9 12h6"/>'),
  scan: S('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5" opacity=".6"/><path d="M12 12l6.4-6.4"/><circle cx="15.5" cy="9" r="1.2" fill="currentColor"/><circle cx="8" cy="15" r="1" fill="currentColor"/>'),
  smoke: S('<path d="M6.5 18a4 4 0 0 1-.6-7.95A5.5 5.5 0 0 1 16.6 8.5 4.5 4.5 0 0 1 17.5 18z"/><path d="M8 21.5h8M10 14.5c1-1 3-1 4 0" opacity=".7"/>'),
  revive: S('<path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.5a4.3 4.3 0 0 1 7.5 2.8c0 5.6-7.5 10.2-7.5 10.2z"/><path d="M7.5 13h2.5l1.2-2.5 1.8 5 1.3-2.5h2.2"/>'),
  downed: S('<path d="M3 19h18"/><circle cx="6.5" cy="14.5" r="2.3"/><path d="M9 15.5l4-1.5 3 1.5 4-1"/><path d="M12.5 5v4M10.5 7h4" opacity=".8"/>'),
  user: S('<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4.2 4-6.5 8-6.5s7.2 2.3 8 6.5"/>'),
  vibrate: S('<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M3 8v8M21 8v8M11 18h2"/>'),
  chevL: S('<path d="M15 4.5L7.5 12 15 19.5"/>'),
  chevR: S('<path d="M9 4.5l7.5 7.5L9 19.5"/>'),
  medal: S('<path d="M8 2.5h8l-2 6h-4z"/><circle cx="12" cy="15" r="6"/><path d="M12 12l.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3z" fill="currentColor" stroke="none"/>'),
  target: S('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'),
  sparkle: S('<path d="M12 3l1.8 5.4L19 10l-5.2 1.7L12 17l-1.8-5.3L5 10l5.2-1.6z"/><path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z"/>'),
  refresh: S('<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 3.5V8h4.5"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20.5V16h-4.5"/>'),
  kelp: S('<path d="M7 21c-1.5-4 1.5-6 0-10S8 4 9 3"/><path d="M12.5 21c1-3.5-1.5-5.5 0-9s.5-6-.5-8"/><path d="M18 21c-1.2-3 1.2-5 0-8.5S18.5 7 19.5 6"/><path d="M3 21h18"/>'),
  barrelx: S('<path d="M6 5h12v15H6z"/><path d="M6 9h12M6 15.5h12" stroke-width="2.6"/><path d="M12 1.5v2M17.5 2.5l-1.2 1.6M6.5 2.5l1.2 1.6"/>'),
  flare: S('<circle cx="12" cy="8" r="3.4" fill="currentColor"/><path d="M12 1.5v1.6M5.5 8H4M20 8h-1.5M7.4 3.4l1 1M16.6 3.4l-1 1"/><path d="M12 12v9M9 21h6"/>'),
  drift: S('<circle cx="9" cy="13" r="6" stroke-dasharray="2.6 2.4"/><circle cx="15.5" cy="10" r="4"/><path d="M9 13l5.2-2.4"/><path d="M19 4l2 2-2 2"/>'),
  coin: S('<ellipse cx="12" cy="7" rx="7.5" ry="3.2"/><path d="M4.5 7v5c0 1.8 3.4 3.2 7.5 3.2s7.5-1.4 7.5-3.2V7"/><path d="M4.5 12v5c0 1.8 3.4 3.2 7.5 3.2s7.5-1.4 7.5-3.2v-5"/>'),
  shop: S('<path d="M5 8h14l-1.3 12.2a1 1 0 0 1-1 .8H7.3a1 1 0 0 1-1-.8z"/><path d="M9 10.5V6.5a3 3 0 0 1 6 0v4"/>'),
  locker: S('<path d="M12 6.5a2 2 0 1 0-2-2"/><path d="M12 6.5v1.8L3 14.5c-.8.6-.4 1.8.6 1.8h16.8c1 0 1.4-1.2.6-1.8l-9-6.2"/><path d="M5 19.5h14"/>'),
  hidden: S('<path d="M3 3l18 18"/><path d="M10.6 5.6A10.4 10.4 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.1 3.9M6.5 7.3C3.8 9.1 2 12 2 12s3.6 6.5 10 6.5c1.6 0 3-.4 4.3-1"/><path d="M9.9 10a3 3 0 0 0 4.1 4.1"/>'),
  star: S('<path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/>'),
  stage: S('<path d="M3 19l6-9 4 5 3-4 5 8z"/><circle cx="17" cy="6" r="2.2"/>'),
  dice: S('<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="15" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="15" r="1.2" fill="currentColor"/>'),
  endturn: S('<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5h5v5h-5z" fill="currentColor"/>'),
  water: S('<path d="M2 12c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2"/><path d="M2 17c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2"/>'),
  bleed: S('<path d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11z"/><path d="M12 10v4.5l2.2 1.3"/>'),

  // ---- 5.0
  play: S('<path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor" stroke="none"/>'),
  helmet: S('<path d="M4 15a8 8 0 0 1 16 0v2H4z"/><path d="M3 17h18M9 11.5h6"/><path d="M12 7v4"/>'),
  rifle: S('<path d="M2 12h13l2-2h5v3h-4l-1 2H9l-1.5 4h-3L6 15H2z"/><path d="M10 10V8h3"/>'),
  reload: S('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/><rect x="10" y="9" width="4" height="7" rx="1"/>'),
  swap: S('<path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/>'),
  ammo: S('<rect x="5" y="9" width="4" height="12" rx="1"/><path d="M5 9c0-3 2-6 2-6s2 3 2 6"/><rect x="15" y="9" width="4" height="12" rx="1"/><path d="M15 9c0-3 2-6 2-6s2 3 2 6"/>'),
  knife: S('<path d="M4 20l9-9"/><path d="M13 11l7-7c1 3 0 6-3 9l-2 1z"/><path d="M6.5 15.5l2 2"/>'),
  semtex: S('<rect x="5" y="8" width="14" height="10" rx="2"/><path d="M8 8V6h8v2M9 13h6"/><circle cx="17" cy="5" r="1.4" fill="currentColor"/>'),
  claymore: S('<path d="M4 15c3-5 13-5 16 0z"/><path d="M8 15l-2 5M16 15l2 5M12 6v4M9 7l1.5 2.5M15 7l-1.5 2.5"/>'),
  flash: S('<rect x="8" y="7" width="8" height="13" rx="2"/><path d="M10 7V4h4v3M12 11v5"/><path d="M3 9l2 1M21 9l-2 1M4 15h2M18 15h2"/>'),
  stim: S('<path d="M14 4l6 6M17 7l-9 9-3 1 1-3 9-9"/><path d="M5 19l-2 2M10 9l5 5"/>'),
  decoy: S('<circle cx="12" cy="12" r="3"/><path d="M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7"/>'),
  uav: S('<path d="M12 9v6M5 9h14"/><circle cx="5" cy="9" r="2"/><circle cx="19" cy="9" r="2"/><path d="M9 15h6l-1 3h-4z"/><path d="M3 21c3-2 15-2 18 0" stroke-dasharray="2 2"/>'),
  care: S('<path d="M12 2c-5 0-8 3-8 6h16c0-3-3-6-8-6z"/><path d="M4 8l7 7M20 8l-7 7M12 8v7"/><rect x="8" y="15" width="8" height="7" rx="1"/>'),
  cuav: S('<path d="M12 9v6M5 9h14"/><circle cx="5" cy="9" r="2"/><circle cx="19" cy="9" r="2"/><path d="M3 3l18 18"/>'),
  airstrike: S('<path d="M12 2l2 6 7 3-7 2-2 9-2-9-7-2 7-3z"/>'),
  sentry: S('<path d="M8 21l4-8 4 8M12 13V9"/><rect x="7" y="5" width="10" height="5" rx="1.5"/><path d="M17 7.5h4"/>'),
  gunship: S('<path d="M3 12h18M12 12V7M8 7h8"/><path d="M6 12l-2 5h16l-2-5"/><circle cx="12" cy="17" r="1.5" fill="currentColor"/>'),
  perk: S('<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z"/>'),
  globe: S('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>'),
  key: S('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>'),
  copy: S('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  share: S('<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.5M8.2 13.2l7.6 4.5"/>'),
  qr: S('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM18 18h3v3h-3zM18 14h3M14 21v-1"/>'),
  upload: S('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>'),
  download: S('<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>'),
  charm: S('<path d="M12 2v5"/><circle cx="12" cy="10" r="3"/><path d="M9 13l-2 8 5-3 5 3-2-8"/>'),
  tracer: S('<path d="M3 18L21 6"/><path d="M15 6h6v6" /><path d="M3 14l6-4M7 20l6-4" opacity=".5"/>'),
  jet: S('<path d="M2 13l8-2 4-7h2l-2 7 6 1 2-3h2l-1 4 1 4h-2l-2-3-6 1 2 7h-2l-4-7-8-2z"/>'),
  cover: S('<rect x="3" y="10" width="18" height="10" rx="1"/><path d="M3 15h18M9 10v5M15 15v5"/><path d="M8 6l4-3 4 3"/>'),
  suppress: S('<circle cx="12" cy="12" r="8"/><path d="M12 4v4M12 16v4M4 12h4M16 12h4"/><path d="M8.5 8.5l7 7"/>'),
  pit: S('<path d="M3 20h18M5 20l2-7h10l2 7"/><path d="M9 13l1-5h4l1 5"/><path d="M12 3v5"/>'),
  crown: S('<path d="M3 18l1.5-10 5 4L12 5l2.5 7 5-4L21 18z"/><path d="M3 21h18"/>'),
  level: S('<path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z"/><path d="M8.5 13l3.5-3.5 3.5 3.5"/>'),
  medalStar: S('<circle cx="12" cy="15" r="6"/><path d="M8 3h8l-2 6h-4z"/><path d="M12 12l1 2h2l-1.6 1.2.6 2-2-1.3-2 1.3.6-2L9 14h2z" fill="currentColor"/>'),
  calendar: S('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  palette: S('<path d="M12 3a9 9 0 1 0 0 18c1.7 0 2-1.3 1.3-2.4-.8-1.2 0-2.6 1.4-2.6H17a4 4 0 0 0 4-4c0-5-4-9-9-9z"/><circle cx="7.5" cy="11" r="1.2" fill="currentColor"/><circle cx="10" cy="7" r="1.2" fill="currentColor"/><circle cx="15" cy="7.5" r="1.2" fill="currentColor"/>'),
  text: S('<path d="M4 7V5h12v2M10 5v14M7 19h6"/><path d="M15 12v-1.5h6V12M18 10.5V19M16.5 19h3"/>'),
  motion: S('<path d="M4 12h3l2-6 4 12 2-6h5"/>'),
  wifi: S('<path d="M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0"/><circle cx="12" cy="19" r="1.2" fill="currentColor"/>'),
};

// Class silhouettes: filled figures, used in the class picker, the unit card and the turn strip.
const SIL = (body) =>
  `<svg class="sil" viewBox="0 0 64 80" aria-hidden="true">${body}</svg>`;

export const SILHOUETTE = {
  assault: SIL(`
    <g fill="currentColor">
      <circle cx="32" cy="13" r="8"/>
      <rect x="25" y="9.5" width="14" height="3.5" rx="1.5" class="visor"/>
      <path d="M20 26c0-3 3-5 6-5h12c3 0 6 2 6 5v20l-4 2v26h-6V52h-4v22h-6V48l-4-2z"/>
      <rect x="13" y="24" width="8" height="18" rx="2" opacity=".75"/>
      <path d="M30 34h26v4H40l-2 6h-4l1-6h-5z"/>
    </g>`),
  marksman: SIL(`
    <g fill="currentColor">
      <circle cx="31" cy="14" r="7.5"/>
      <rect x="24.5" y="11" width="13" height="3.2" rx="1.5" class="visor"/>
      <path d="M21 27c0-3 3-5 6-5h10c3 0 6 2 6 5v19l-3 2v26h-6V52h-4v22h-6V48l-3-2z"/>
      <rect x="15" y="1" width="1.8" height="26" opacity=".8"/>
      <circle cx="15.9" cy="2" r="1.8"/>
      <path d="M26 33h37v3H44l-1.5 5h-4l1-5H26z"/>
      <rect x="38" y="29" width="9" height="3" rx="1"/>
    </g>`),
  breacher: SIL(`
    <g fill="currentColor">
      <circle cx="30" cy="13" r="8.5"/>
      <rect x="22.5" y="9.5" width="15" height="3.6" rx="1.5" class="visor"/>
      <path d="M17 27c0-3.5 3.5-6 7-6h12c3.5 0 7 2.5 7 6v20l-4 2v25h-7V53h-4v21h-7V49l-4-2z"/>
      <path d="M40 24h16a2 2 0 0 1 2 2v30a2 2 0 0 1-2 2H40z" opacity=".85"/>
      <rect x="44" y="30" width="10" height="3" rx="1" class="visor"/>
    </g>`),
  medic: SIL(`
    <g fill="currentColor">
      <circle cx="31" cy="13" r="7.8"/>
      <rect x="24" y="10" width="14" height="3.3" rx="1.5" class="visor"/>
      <path d="M21 26c0-3 3-5 6-5h10c3 0 6 2 6 5v20l-3 2v26h-6V52h-4v22h-6V48l-3-2z"/>
      <path d="M8 27h14v17a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2z" opacity=".85"/>
      <path d="M13.6 31h2.8v3h3v2.8h-3v3h-2.8v-3h-3V34h3z" class="visor"/>
      <path d="M33 34h19v3.5H44l-1 4h-3.5l.8-4H33z"/>
      <rect x="40" y="37" width="3" height="6" rx="1"/>
    </g>`),
  recon: SIL(`
    <g fill="currentColor">
      <path d="M22 15c0-6 4.5-10 9.5-10S41 9 41 15v3H22z"/>
      <rect x="25" y="12.5" width="13" height="3" rx="1.4" class="visor"/>
      <path d="M21 27c0-3 3-5 6-5h10c3 0 6 2 6 5v19l-3 2v26h-6V52h-4v22h-6V48l-3-2z"/>
      <rect x="11" y="23" width="9" height="13" rx="2" opacity=".8"/>
      <path d="M6 18h18v2.4H6z" opacity=".9"/>
      <circle cx="7" cy="17" r="2.6" opacity=".9"/><circle cx="23" cy="17" r="2.6" opacity=".9"/>
      <path d="M30 33h28v3.5H45l-1.4 4.5h-3.8l1-4.5H30z"/>
    </g>`),
  engineer: SIL(`<g fill="currentColor"><path d="M21 16c0-6 5-10 11-10s11 4 11 10v2H21z"/><rect x="24" y="13" width="16" height="3" rx="1.4" class="visor"/><path d="M21 27c0-3 3-5 6-5h10c3 0 6 2 6 5v19l-3 2v26h-6V52h-4v22h-6V48l-3-2z"/><path d="M44 30l12-6 3 4-12 7z"/></g>`),
  gunner: SIL(`<g fill="currentColor"><path d="M20 16c0-6 5-10 12-10s12 4 12 10v2H20z"/><rect x="23" y="13" width="18" height="3" rx="1.4" class="visor"/><path d="M19 27c0-3 3-5 7-5h12c4 0 7 2 7 5v19l-3 2v26h-7V52h-4v22h-7V48l-3-2z"/><path d="M28 34h32v5H46l-2 5h-5l1-5H28z"/></g>`),
};

export const icon = (name) => ICON[name] || '';
