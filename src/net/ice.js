// ICE (NAT traversal) configuration for the PeerJS transport.
//
// Direct peer-to-peer only by default: several public STUN servers so a phone on cellular has the
// best chance of finding a reflexive (or IPv6) candidate pair. IPv6 candidates are never filtered:
// many carriers give phones public IPv6, where a direct connection usually works even behind CGNAT.
//
// Testing override: localStorage 'tidefall.ice' = JSON array of RTCIceServer objects, e.g.
//   localStorage.setItem('tidefall.ice', JSON.stringify([{ urls: 'stun:stun.l.google.com:19302' }]))

// Two providers (Google + Cloudflare) so one blocked/slow provider never leaves us without a
// server-reflexive candidate. Few entries per RTCIceServer keeps gathering fast (Chrome warns past ~4 URLs).
export const STUN = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: ['stun:stun2.l.google.com:19302', 'stun:stun3.l.google.com:19302', 'stun:stun4.l.google.com:19302'] },
];

// ---------------------------------------------------------------------------------------------
// OPTIONAL RELAY (TURN) SLOT. Empty on purpose: there is no relay today.
// If you ever add one, put its servers here; prefer TLS on 443 (passes most carrier firewalls):
//   { urls: ['turn:relay.example.com:3478', 'turns:relay.example.com:443?transport=tcp'],
//     username: '…', credential: '…' }
// ---------------------------------------------------------------------------------------------
export const RELAY = [];

export const ICE_KEY = 'tidefall.ice';

function override() {
  try {
    const raw = globalThis.localStorage?.getItem(ICE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.length && v.every((s) => s && (typeof s.urls === 'string' || Array.isArray(s.urls))) ? v : null;
  } catch { return null; }
}

/** The ICE server list to use now. */
export function iceServers() {
  return override() || [...STUN, ...RELAY];
}

/** RTCPeerConnection config for PeerJS (`new Peer({ config })`). */
export function rtcConfig() {
  return { iceServers: iceServers(), iceCandidatePoolSize: 4, iceTransportPolicy: 'all', bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };
}

export const hasRelay = () => iceServers().some((s) => [].concat(s.urls).some((u) => /^turns?:/i.test(u)));

/** Debug: describe the selected candidate pair of a peer connection ('host' / 'srflx' / 'prflx' / 'relay', udp/tcp, v4/v6). */
export async function describePath(pc) {
  if (!pc?.getStats) return null;
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
    });
    if (!pair) stats.forEach((r) => { if (!pair && r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) pair = r; });
    if (!pair) return null;
    const l = stats.get(pair.localCandidateId), rm = stats.get(pair.remoteCandidateId);
    const fam = (c) => (String(c?.address || c?.ip || '').includes(':') ? 'v6' : 'v4');
    return {
      local: l?.candidateType, remote: rm?.candidateType, protocol: l?.protocol, family: fam(l),
      relay: l?.candidateType === 'relay' || rm?.candidateType === 'relay',
      rtt: Number.isFinite(pair.currentRoundTripTime) ? Math.round(pair.currentRoundTripTime * 1000) : null,
    };
  } catch { return null; }
}
