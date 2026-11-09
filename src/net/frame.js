// Message framing for the PeerJS data channel (serialization 'raw').
//
// Why: PeerJS 1.5.4's 'json' serialization refuses any message of 16300 bytes or more (it emits a
// "Message too big for JSON channel" error and drops the message). Our match snapshots are far
// bigger, so with 'json' every start/batch failed and the connection was torn down. We send
// strings ourselves instead: short messages as-is, long ones split into numbered chunks that are
// reassembled on the other side (the channel is reliable and ordered).
//
//   frames(obj) → string[]            what to send, in order
//   const rx = reassembler(); rx.push(str) → obj | undefined (undefined while a message is partial)

export const FRAME_CHARS = 12000; // chars per frame: ≤ 36 KB even if every char were 3-byte UTF-8
const MAX_PARTS = 2000; // ~24 MB: anything bigger is junk
const STALE_MS = 60000;

let nextId = 1;

export function frames(obj, max = FRAME_CHARS) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  if (s.length <= max) return [s];
  const n = Math.ceil(s.length / max);
  const id = (nextId++).toString(36);
  const out = [];
  for (let i = 0; i < n; i++) out.push(`~${id}:${i}:${n}:${s.slice(i * max, (i + 1) * max)}`);
  return out;
}

export function reassembler({ now = () => Date.now() } = {}) {
  const parts = new Map(); // id → {n, got, list, at}
  return {
    get pending() { return parts.size; },
    push(data) {
      let s = data;
      if (typeof s !== 'string') {
        if (s instanceof ArrayBuffer || ArrayBuffer.isView(s)) s = new TextDecoder().decode(s);
        else return s; // already an object (a peer on 'json' serialization)
      }
      if (s.charCodeAt(0) !== 126 /* ~ */) {
        try { return JSON.parse(s); } catch { return undefined; }
      }
      const a = s.indexOf(':'), b = s.indexOf(':', a + 1), c = s.indexOf(':', b + 1);
      if (a < 0 || b < 0 || c < 0) return undefined;
      const id = s.slice(1, a), i = +s.slice(a + 1, b), n = +s.slice(b + 1, c);
      if (!Number.isInteger(i) || !Number.isInteger(n) || n < 1 || n > MAX_PARTS || i < 0 || i >= n) return undefined;
      const t = now();
      for (const [k, p] of parts) if (t - p.at > STALE_MS) parts.delete(k);
      let p = parts.get(id);
      if (!p || p.n !== n) { p = { n, got: 0, list: new Array(n), at: t }; parts.set(id, p); }
      if (p.list[i] === undefined) { p.list[i] = s.slice(c + 1); p.got++; }
      p.at = t;
      if (p.got < n) return undefined;
      parts.delete(id);
      try { return JSON.parse(p.list.join('')); } catch { return undefined; }
    },
  };
}
