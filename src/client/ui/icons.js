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
};

export const icon = (name) => ICON[name] || '';
