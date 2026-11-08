// Invite codes: 6 characters from an alphabet with no look-alikes (no 0/O, 1/I/L, 5/S, 8/B, 2/Z, 6/G, U/V).
// The host's PeerJS id is `tidefall-<CODE>`.

export const CODE_ALPHABET = 'ACDEFHJKMNPQRTVWXY3479'; // 22 symbols: 113M codes
export const CODE_LENGTH = 6;
export const PEER_PREFIX = 'tidefall-';

export function makeCode(rand = Math.random) {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}

/** Normalise user input: upper-case, strip spaces/dashes, map common look-alikes. null if invalid. */
export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toUpperCase();
  if (s.startsWith(PEER_PREFIX.toUpperCase())) s = s.slice(PEER_PREFIX.length);
  s = s.replace(/[\s\-_.]/g, '');
  if (s.length !== CODE_LENGTH) return null;
  for (const c of s) if (!CODE_ALPHABET.includes(c)) return null;
  return s;
}

export const peerIdFor = (code) => PEER_PREFIX + code;

/** A random opaque token (reconnect secret, connection ids). */
export function token(n = 16) {
  const a = new Uint8Array(n);
  (globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(a) : a.forEach((_, i) => { a[i] = Math.random() * 256; }));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
