// server/accounts/teamDemos.js — pure merge of a team's demo parts into one canonical replay document.
//
// The server NEVER re-simulates a battle. Each client records the wire frames it received (its own field, and the
// spectator copy of a teammate's field while watching), uploads one part at settle time, and this module only:
//   * anchors each part's relative `at` to the server clock carried by m.public (serverNow);
//   * de-duplicates the public timeline across parts;
//   * keeps a field from its owner's part only (a spectator copy is a fallback, marked degraded);
//   * stores each player's m.private under that playerId (the API filters it on download).
//
// Output shape is documented in docs/TEAM_DEMO_MERGE.md §4.1. No DB / HTTP code here, so the merge is unit-testable.

// shared/protocol.js is browser-safe and already used by the server (server/net.js). A model form is state, not
// decoration: dropping it under the size cap made a replay draw the previous unit's model (the Texas report).
import { fxForm } from '../../shared/protocol.js';

export const TEAM_DOC_VERSION = 2;
export const MAX_TEAM_PART_GZIP = 12 * 1024 * 1024;
export const MAX_TEAM_PART_JSON = 24 * 1024 * 1024;
export const MAX_TEAM_CANONICAL_BYTES = 8 * 1024 * 1024;

const WIRE_PUBLIC = new Set(['m.public', 'm.result', 'm.ticker', 'b.pool']);
const FIELD_TYPES = new Set(['m.field', 'b.start', 'b.snap', 'b.ev', 'b.end']);
const OWN_FIELD_TYPES = new Set(['b.start', 'b.snap', 'b.ev', 'b.end']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clampAt = (v) => Math.max(0, num(v, 0));

/**
 * Server-clock time of one part-local `at`, using the latest `m.public.serverNow` anchor at or before it.
 * A mark is not a wire frame, so it needs the same anchor mapping as the frames around it.
 * @param {{ wire?: any[], startedAt?: number }} part
 * @param {number} at
 */
function serverAtOf(part, at) {
  const target = clampAt(at);
  let anchor = null;
  for (const frame of arr(part?.wire)) {
    const frameAt = clampAt(frame?.at);
    if (frameAt > target || frame?.t !== 'm.public') continue;
    const now = num(frame.serverNow ?? frame.m?.serverNow, NaN);
    if (Number.isFinite(now) && (!anchor || frameAt >= anchor.at)) anchor = { at: frameAt, serverAt: now };
  }
  return anchor ? Math.round(anchor.serverAt + (target - anchor.at)) : num(part?.startedAt, 0) + target;
}

/** Stable JSON for a public-payload comparison: serverNow / deadline drift must not defeat de-duplication. */
function publicKey(t, msg) {
  if (!isObj(msg)) return `${t}:${String(msg)}`;
  const copy = { ...msg };
  delete copy.serverNow;
  delete copy.at;
  delete copy.t;
  if (isObj(copy.m)) { copy.m = { ...copy.m }; delete copy.m.serverNow; }
  let s;
  try { s = JSON.stringify(copy); } catch { s = String(copy); }
  return `${t}:${s}`;
}

/** `{ fieldId, players }` of a field frame, from m.field / b.start or a spectator b.snap. */
function fieldInfo(t, msg) {
  if (!isObj(msg)) return null;
  const fieldId = msg.fieldId || msg.m?.fieldId || null;
  if (!fieldId) return null;
  const players = (arr(msg.players).length ? arr(msg.players) : arr(msg.members).length ? arr(msg.members) : arr(msg.m?.players)).map((p) =>
    isObj(p) ? p.playerId : p).filter(Boolean);
  return { fieldId, players };
}

/** Channel of one wire frame: public timeline, a field, or a player's private stream. */
function classify(t, msg) {
  if (WIRE_PUBLIC.has(t)) return { kind: 'public' };
  if (t === 'm.private') return { kind: 'private' };
  if (FIELD_TYPES.has(t)) {
    const f = fieldInfo(t, msg);
    if (f) return { kind: 'field', ...f };
    // a b.snap / b.ev without a fieldId still belongs to the part's only battle; the caller supplies the default
    return { kind: 'field', fieldId: null, players: [] };
  }
  return { kind: 'other' };
}

/**
 * Give every wire frame a server-clock stamp. `m.public.serverNow` anchors the part; a frame with no preceding anchor
 * falls back to the part's own startedAt and is marked `clockQuality: 'low'`.
 * @param {{ wire: any[], startedAt?: number }} part
 */
export function alignPart(part) {
  const startedAt = num(part?.startedAt, 0);
  const out = [];
  let anchor = null;
  for (const frame of arr(part?.wire)) {
    if (!isObj(frame) || typeof frame.t !== 'string') continue;
    const at = clampAt(frame.at);
    if (frame.t === 'm.public') {
      const now = num(frame.serverNow ?? frame.m?.serverNow, NaN);
      if (Number.isFinite(now)) anchor = { at, serverAt: now, quality: 'high' };
    } else if (!anchor) {
      out.push({ ...frame, at, serverAt: startedAt + at, clockQuality: 'low' });
      continue;
    }
    const usable = anchor && at >= anchor.at;
    const serverAt = usable ? anchor.serverAt + (at - anchor.at) : startedAt + at;
    out.push({ ...frame, at, serverAt: Math.round(serverAt), clockQuality: usable ? 'high' : 'low' });
  }
  return out;
}

const stripFrame = (frame) => {
  if (isObj(frame.m)) return { ...frame.m };
  const m = { ...frame };
  delete m.t; delete m.at; delete m.serverAt; delete m.local; delete m.clockQuality;
  return m;
};

/**
 * Merge already-aligned parts.
 * @param {{ playerId: string, doc: any }[]} parts
 * @param {{ participants?: string[], matchId?: string }} [opts]
 */
export function mergeTeamDemos(parts, opts = {}) {
  const list = arr(parts).filter((p) => p && p.playerId && isObj(p.doc));
  if (!list.length) throw new Error('mergeTeamDemos: no parts');
  const matchId = opts.matchId || list[0].doc.matchId;
  if (!matchId) throw new Error('mergeTeamDemos: matchId required');
  for (const p of list) {
    if (p.doc.matchId && p.doc.matchId !== matchId) throw new Error(`mergeTeamDemos: part matchId mismatch for ${p.playerId}`);
  }
  const participants = [...new Set(arr(opts.participants).length
    ? arr(opts.participants)
    : list.flatMap((p) => arr(p.doc.players).filter((x) => x && !x.isBot).map((x) => x.playerId)).filter(Boolean))];

  const aligned = list.map((p) => {
    const frames = alignPart(p.doc);
    // Round marks are part-local too. Map them through the same serverNow anchor as the wire frames, otherwise a
    // client with a skewed clock puts its round dot seconds away from the actual round boundary.
    const markFrames = arr(p.doc.marks).filter((m) => isObj(m)).map((m) => ({
      ...m, at: clampAt(m.at), serverAt: serverAtOf(p.doc, m.at),
    }));
    return { playerId: p.playerId, doc: p.doc, frames, markFrames };
  });
  const allFrames = aligned.flatMap((p) => p.frames).filter((f) => isObj(f));
  // Prefer an anchored (high-quality) frame as the canonical origin. An old frame before the first serverNow anchor
  // carries a local-clock fallback; using that as clockBase would shift every anchored frame by the client skew.
  const highFrames = allFrames.filter((f) => f.clockQuality === 'high' && Number.isFinite(Number(f.serverAt)));
  const baseFrames = highFrames.length ? highFrames : allFrames;
  const clockBase = Math.min(...baseFrames.map((f) => num(f.serverAt, Infinity)).filter((n) => Number.isFinite(n)));
  const canonicalAt = (f) => Math.max(0, Math.round(num(f.serverAt, clockBase) - (Number.isFinite(clockBase) ? clockBase : 0)));

  const publicFrames = [];
  const publicSeen = new Map();
  let result = null;
  for (const f of allFrames) {
    const c = classify(f.t, f);
    if (c.kind !== 'public') continue;
    if (f.t === 'm.result') {
      // last settlement wins; `settled:true` beats an earlier synthetic / half result
      const settled = f.m?.settled === true || f.settled === true;
      if (settled || !result) result = { at: canonicalAt(f), t: f.t, m: stripFrame(f) };
      continue;
    }
    const key = publicKey(f.t, f.m);
    const prev = publicSeen.get(key);
    const at = canonicalAt(f);
    // a duplicate is the same frame around the same moment (±100ms): keep the earliest server stamp
    if (prev && Math.abs(prev.at - at) <= 100) continue;
    const item = { at, serverAt: f.serverAt, t: f.t, m: stripFrame(f) };
    publicFrames.push(item);
    publicSeen.set(key, item);
  }
  publicFrames.sort((a, b) => a.at - b.at || a.serverAt - b.serverAt);

  // one entry per field, from its owner's part when that part has frames; a spectator copy is the degraded fallback
  const fields = {};
  const fieldOwners = new Map(); // fieldId → players, learned from every part's m.field / b.start
  for (const p of aligned) for (const f of p.frames) {
    const c = classify(f.t, f);
    if (c.kind === 'field' && c.fieldId && (c.players || []).length) fieldOwners.set(c.fieldId, c.players);
  }
  for (const p of aligned) {
    for (const f of p.frames) {
      const c = classify(f.t, f);
      if (c.kind !== 'field') continue;
      const fieldId = c.fieldId || f.m?.fieldId || null;
      if (!fieldId) continue;
      const who = (c.players && c.players.length ? c.players : fieldOwners.get(fieldId) || []);
      const partOwns = who.includes(p.playerId);
      let entry = fields[fieldId];
      if (!entry) entry = fields[fieldId] = { owner: null, frames: [], spectators: [], degraded: true };
      if (partOwns) { entry.owner = p.playerId; entry.frames.push(f); }
      else entry.spectators.push(f);
    }
  }
  const availableFields = [];
  for (const [fieldId, entry] of Object.entries(fields)) {
    const chosen = entry.frames.length ? entry.frames : entry.spectators;
    const sorted = chosen.slice().sort((a, b) => num(a.serverAt) - num(b.serverAt) || num(a.at) - num(b.at));
    // resyncs can repeat m.field; the newest one carries the latest unit metadata (devices / a changed form).
    const metaFrame = sorted.filter((f) => f.t === 'm.field').at(-1);
    const meta = metaFrame ? stripFrame(metaFrame) : {};
    const frames = sorted.filter((f) => f.t !== 'm.field').map((f) => ({
      at: canonicalAt(f), serverAt: f.serverAt,
      ...(f.clockQuality === 'low' ? { clockQuality: 'low' } : {}), t: f.t, m: stripFrame(f),
    }));
    fields[fieldId] = {
      owner: entry.owner || null,
      kind: meta.kind || (fieldId.startsWith('b:') ? 'boss' : 'normal'),
      fieldMeta: { ...meta, fieldId },
      frames,
      degraded: !entry.frames.length,
    };
    availableFields.push(fieldId);
  }

  const privates = {};
  for (const p of aligned) {
    const own = p.frames.filter((f) => f.t === 'm.private').map((f) => ({
      at: canonicalAt(f), serverAt: f.serverAt, t: f.t, m: stripFrame(f),
    })).sort((a, b) => a.at - b.at);
    privates[p.playerId] = own;
  }

  const players = [];
  for (const p of aligned) {
    for (const x of arr(p.doc.players)) {
      if (!x || !x.playerId || players.some((y) => y.playerId === x.playerId)) continue;
      players.push({ playerId: x.playerId, seat: x.seat ?? null, name: x.name ?? null, isBot: !!x.isBot });
    }
  }
  const marks = [];
  for (const p of aligned) for (const m of p.markFrames) {
    const at = canonicalAt(m);
    if (!marks.some((x) => x.round === m.round && Math.abs(x.at - at) <= 100)) {
      marks.push({ at, round: m.round, ...(m.phase != null ? { phase: m.phase } : {}) });
    }
  }
  marks.sort((a, b) => num(a.at) - num(b.at));
  const startedAt = Number.isFinite(clockBase)
    ? Math.round(clockBase)
    : Math.min(...list.map((p) => num(p.doc.startedAt, Date.now())));
  const lastServer = allFrames.length ? Math.max(...allFrames.map((f) => num(f.serverAt, clockBase))) : startedAt;
  // The client's startedAt/endedAt are absolute wall-clock stamps, but their difference is a usable match duration even
  // when its clock is skewed. Keep the tail of a match whose result frame never arrived; otherwise use the last frame.
  const clientSpans = list.map((p) => Math.max(0, num(p.doc.endedAt, num(p.doc.startedAt, 0)) - num(p.doc.startedAt, 0)));
  const endedAt = Math.round(Math.max(lastServer, startedAt + Math.max(0, ...clientSpans)));
  const lowClock = aligned.some((p) => p.frames.some((f) => f.clockQuality === 'low'));
  return {
    version: TEAM_DOC_VERSION, kind: 'team', matchId,
    startedAt, endedAt,
    mode: list[0].doc.mode || null, difficulty: list[0].doc.difficulty || null,
    players,
    public: publicFrames,
    fields,
    privates,
    marks,
    result: result || {},
    partial: participants.some((id) => !list.some((p) => p.playerId === id)),
    availableFields,
    clockQuality: lowClock ? 'low' : 'high',
  };
}

const STATE_EV = new Set(['spawn', 'die', 'deploy', 'status', 'skill', 'leak']);

/**
 * Size control from docs/TEAM_DEMO_MERGE.md §8 Step 6: state events are never dropped; attack animations go first, then
 * snapshots are thinned 2× / 5× / 20×. This is a canonical-only transform; the recorder's local document is untouched.
 */
export function downsampleTeamDemo(doc, { snapStep = 2 } = {}) {
  const fields = {};
  for (const [fieldId, f] of Object.entries(doc.fields || {})) {
    const frames = [];
    let snapIndex = 0;
    const snaps = (f.frames || []).filter((x) => x.t === 'b.snap');
    for (const x of (f.frames || [])) {
      if (x.t === 'b.ev') {
        const ev = (x.m?.ev || []).filter((e) => Array.isArray(e) && (STATE_EV.has(e[0]) || fxForm(e) !== undefined || String(e[0]).startsWith('fx:')));
        if (ev.length) frames.push({ ...x, m: { ...x.m, ev } });
      } else if (x.t === 'b.snap') {
        const i = snapIndex++;
        if (i === 0 || i === snaps.length - 1 || i % Math.max(1, snapStep) === 0) frames.push(x);
      } else frames.push(x);
    }
    fields[fieldId] = { ...f, frames };
  }
  return { ...doc, fields };
}

/** The subset one viewer may receive: all public/fields, only their own m.private. */
export function filterTeamDemoForViewer(doc, playerId) {
  if (!isObj(doc) || doc.kind !== 'team') return null;
  const keep = isObj(doc.privates) && playerId && doc.privates[playerId] ? { [playerId]: doc.privates[playerId] } : {};
  return { ...doc, privates: keep };
}
