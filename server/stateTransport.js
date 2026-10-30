// Connection-local baselines. Snapshot and diff encoding are shared only for the SAME message/baseline objects,
// never across players' private views. Weak maps release disconnected sockets and superseded snapshots.
//
// Every frame a connection is given — full or delta — carries a fresh number from that connection's own counter, so
// the sequence only moves forward: a re-sent snapshot must not hand out an older number than the frames before it, and
// a full frame is always ahead of what came before it. The receiver keys its baseline on those numbers.
//
// A match hosted in a lane Worker already encoded (and diffed) its state — server/workers/matchPool.js hands those bytes
// over with attachWorkerState(). This module then only decides whether they can be a delta for THIS connection: the
// same owner and stream as the last frame it got, and the worker's base is that frame's worker sequence. Everything else
// — a new owner, a new stream, an unusable frame — is a full frame.
import { diffState, isStateKind, STATE_DELTA_VERSION } from '../shared/stateDelta.js';

/**
 * The channels this build compresses. Both state channels: it is the fork's feature, and the baselines are per
 * connection, so one player's patch is never another's — m.private included (each connection keeps its own
 * snapshot/seq for it; a client that misses a frame asks for a resync). Upstream ships the public one only.
 */
export const DELTA_KINDS = new Set(['m.public', 'm.private']);

// ws -> { seq, roomCode, kinds: Map<kind, { snapshot, seq, owner, stream, streamSeq }> }
const connections = new WeakMap();
// msg -> { encoded, view, patches: WeakMap<previousSnapshot, opsJson | false> }
const snapshots = new WeakMap();
// msg -> { encoded, frame: { stream, seq, base, delta }, owner } (a lane Worker's pre-encoded state)
const workerFrames = new WeakMap();

/** Mark a message whose state bytes a lane Worker already encoded and diffed (server/workers/matchPool.js). */
export function attachWorkerState(msg, encoded, frame, owner) {
  if (frame) workerFrames.set(msg, { encoded, frame, owner });
  return msg;
}

const fullFrame = (kind, seq, encoded) =>
  `{"t":"m.state","kind":${JSON.stringify(kind)},"seq":${seq},"full":${encoded}}`;

/** The patch text of a Worker delta frame (`{"t":"m.state",…,"patch":{…}}`), or null when it carries none. */
function workerPatch(delta) {
  if (typeof delta !== 'string') return null;
  const at = delta.indexOf('"patch":');
  if (at < 0) return null;
  const body = delta.slice(at + 8, delta.lastIndexOf('}')).trim();
  return body.startsWith('{') || body.startsWith('[') ? body : null;
}

export function negotiateStateDelta(ws, version) {
  const enabled = version === STATE_DELTA_VERSION;
  const old = connections.get(ws);
  // A repeated hello keeps the baseline it already has: dropping it would turn the next frame into a full one for no
  // reason, and the client would have to decode a full frame it did not need.
  if (enabled) { if (!old) connections.set(ws, { seq: 0, roomCode: null, kinds: new Map() }); return; }
  connections.delete(ws);
}

/** The already negotiated capability, for an internal identity handover on the same socket. */
export function stateDeltaVersion(ws) { return connections.has(ws) ? STATE_DELTA_VERSION : undefined; }

/** Forget the baselines (a new negotiation, or a client that asked for a full resync). The counter never rewinds. */
export function resetStateDelta(ws) { connections.get(ws)?.kinds.clear(); }

/** Keep negotiation and sequence, but never carry a previous room's state into a new room. */
export function setStateDeltaRoom(ws, roomCode) {
  const connection = connections.get(ws);
  if (!connection || connection.roomCode === roomCode) return;
  connection.roomCode = roomCode;
  connection.kinds.clear();
}

/**
 * A state frame for one connection, from bytes the caller already has (its own encoding, or a lane Worker's).
 * @param {import('ws').WebSocket} ws
 * @param {object} msg
 * @param {string} encoded
 * @returns {{ data: string, commit: () => void, usable: boolean }} `usable: false` means the given bytes cannot be a
 *   baseline (they are not a JSON object) and the caller should send a full frame it encoded itself; this connection
 *   keeps the baseline it already had. commit() only runs once the caller successfully queued the frame.
 */
export function prepareStateFrame(ws, msg, encoded) {
  const connection = connections.get(ws);
  if (!connection || !isStateKind(msg?.t) || !DELTA_KINDS.has(msg.t)) return { data: encoded, commit() {}, usable: true };

  // A lane Worker encoded and diffed this state already: reuse its patch when it lines up with what this connection
  // was last given, and renumber onto this connection's own counter (the sequence must not rewind per owner).
  const prepared = workerFrames.get(msg);
  if (prepared && prepared.encoded === encoded) {
    const { frame, owner } = prepared;
    const previous = connection.kinds.get(msg.t);
    const seq = ++connection.seq;
    let data = fullFrame(msg.t, seq, encoded);
    if (previous && previous.owner === owner && previous.stream === frame.stream
      && previous.streamSeq === frame.base && frame.delta) {
      const patch = workerPatch(frame.delta);
      if (patch) data = `{"t":"m.state","kind":${JSON.stringify(msg.t)},"seq":${seq},"base":${previous.seq},"patch":${patch}}`;
    }
    return {
      data,
      commit() { connection.kinds.set(msg.t, { seq, owner, stream: frame.stream, streamSeq: frame.seq }); },
      usable: true,
    };
  }

  let snapshot = snapshots.get(msg);
  // The encoding, not mutable game objects, owns this immutable baseline.
  if (!snapshot || snapshot.encoded !== encoded) {
    let view;
    // Bytes a caller pre-encoded (a lane worker) can be anything: never throw out of the send path because of them.
    try { view = JSON.parse(encoded); } catch { view = null; }
    if (view === null || typeof view !== 'object' || Array.isArray(view)) {
      return { data: encoded, commit() {}, usable: false };
    }
    snapshot = { encoded, view, patches: new WeakMap() };
    snapshots.set(msg, snapshot);
  }
  const previous = connection.kinds.get(msg.t);
  const seq = ++connection.seq;
  let data = fullFrame(msg.t, seq, encoded);
  if (previous?.snapshot && previous.snapshot !== snapshot) {
    // The patch is content-only, so it is shared between connections; the sequence numbers are not.
    let patch = snapshot.patches.get(previous.snapshot);
    if (patch === undefined) {
      const ops = diffState(previous.snapshot.view, snapshot.view);
      patch = ops ? JSON.stringify(ops) : false;
      snapshot.patches.set(previous.snapshot, patch);
    }
    if (patch) {
      const delta = `{"t":"m.state","kind":${JSON.stringify(msg.t)},"seq":${seq},"base":${previous.seq},"patch":${patch}}`;
      // Compare actual UTF-8 bytes, not JS string length. Large changes fall back to full.
      if (Buffer.byteLength(delta) < Buffer.byteLength(data)) data = delta;
    }
  }
  return { data, commit() { connection.kinds.set(msg.t, { snapshot, seq }); }, usable: true };
}
