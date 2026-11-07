// Tidefall 3.0 squad colours (shared by Graphics and UI).
//
// Your squad is always amber. Every other squad gets one of 15 saturated,
// clearly separated hues. Two bands of the colour wheel are kept free:
// amber (35–50°, your squad) and cyan (180–195°, pickups and signals).
// The list is ordered so the first few entries (what you see in Quads / Trios)
// are as far apart as possible; later entries fill in with lighter tints so
// neighbours in hue still differ in lightness.

export const MY_SQUAD = '#ffb000';

/** 15 enemy-squad colours, in assignment order. Hue in degrees noted for each. */
export const SQUAD_PALETTE = [
  '#ff3b3b', // red        0°
  '#3d8bff', // azure    216°
  '#a6f01c', // lime      85°
  '#c44bff', // purple   281°
  '#ff6a1f', // orange    21°
  '#14e0a0', // jade     161°
  '#ff3fc0', // magenta  318°
  '#5a5cff', // indigo   240°
  '#3fd14e', // green    125°
  '#ff5a86', // rose     344°
  '#8f5bff', // violet   260°
  '#9cc6ff', // sky      214° (light)
  '#ffa494', // salmon     8° (light)
  '#a4ffb8', // mint     133° (light)
  '#ecb0ff', // lilac    286° (light)
];

/** Spectating (no squad of your own): the 16th squad takes this neutral bone tint. */
export const SPARE_COLOR = '#e8e2d0';

/**
 * Colour of squad `teamId` as seen by `myTeam` (pass -1 or null when
 * spectating with no squad). Stable for a whole match.
 */
export function squadColor(teamId, myTeam) {
  if (teamId === null || teamId === undefined || teamId < 0) return SPARE_COLOR;
  const mine = myTeam !== null && myTeam !== undefined && myTeam >= 0;
  if (mine && teamId === myTeam) return MY_SQUAD;
  const i = mine && teamId > myTeam ? teamId - 1 : teamId;
  return i < SQUAD_PALETTE.length ? SQUAD_PALETTE[i] : SPARE_COLOR;
}

/** Same as squadColor but as a 0xRRGGBB number (for three.js). */
export function squadColorHex(teamId, myTeam) {
  return parseInt(squadColor(teamId, myTeam).slice(1), 16);
}
