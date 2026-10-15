// 头像 P2P (user request 2026-10-15): a teammate's avatar travels straight between browsers over a WebRTC
// DataChannel, so the server never carries an image. The server's only part is relaying the SDP/ICE signaling
// (`rtc.signal`, server/lobby.js rtcSignal): it forwards a few kB verbatim to the addressed seat of the same
// room and stores nothing.
//
// Shape: one RTCPeerConnection per teammate — a mesh, and a room holds at most four seats, so a full room is six
// connections. Negotiation follows the "perfect negotiation" pattern (MDN): the larger playerId is the offerer
// and creates the channel, the smaller one is polite and yields on a glare, so both ends agree without a
// designated host. Everything here is best effort — when WebRTC cannot connect (a symmetric NAT without a
// reachable STUN server), the seat keeps showing the namecard operator and the match is unaffected.
import { store } from '../store.js';

const DC_LABEL = 'sp-avatar';
const CHUNK = 12 * 1024; // safe SCTP message size for every browser we support
const MAX_AVATAR = 200 * 1024; // the local avatar is a ≤160 kB data URL (ui/accounts.js AVATAR_MAX); cap a peer
const BUFFER_HIGH = 512 * 1024; // backpressure: wait for the channel to drain past this before the next chunk
const NAME_MAX = 64;
const TAG_RE = /^\d{4}$/;

/**
 * ICE servers. A public STUN server is enough for most home NATs; a symmetric NAT / CGNAT needs a TURN relay,
 * which this feature deliberately does not use (it would put the avatar back on a server). Set
 * `globalThis.SP_ICE_SERVERS = [{ urls: 'stun:your.host:3478' }]` to point at your own. Google's STUN is not
 * reachable from mainland China, hence the Xiaomi one first.
 */
const DEFAULT_ICE = Object.freeze([
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
]);

/** @type {Map<string, any>} playerId → the mesh leg */
const peers = new Map();
const listeners = new Set();
let started = false;
let enabled = true; // 设置 →「头像 P2P」(ui/settings.js applyP2pAvatar); false means never start
let netRef = null;
let local = null; // { name, tag, avatar } — what this browser offers its teammates
let iceServers = DEFAULT_ICE;

// ---- pure helpers (exported for the unit tests) -----------------------------------------------------------------------

/** Split a payload into DataChannel frames. One frame when it fits, otherwise numbered chunks. */
export function avatarFrames(text, size = CHUNK) {
  if (typeof text !== 'string' || !text) return [];
  const n = Math.max(1, Math.ceil(text.length / size));
  if (n === 1) return [JSON.stringify({ v: 1, s: text })];
  const out = [];
  for (let i = 0; i < n; i++) out.push(JSON.stringify({ v: 1, i, n, s: text.slice(i * size, (i + 1) * size) }));
  return out;
}

/**
 * Fold one frame into a reassembly buffer. @returns {{ text?: string, buffer?: Array<string>, bad?: boolean }}
 * `text` is set once the payload is complete (a single frame, or the last missing chunk of a numbered run).
 */
export function foldAvatarFrame(buffer, raw) {
  let frame;
  try { frame = JSON.parse(typeof raw === 'string' ? raw : ''); } catch { return { bad: true }; }
  if (!frame || frame.v !== 1 || typeof frame.s !== 'string') return { bad: true };
  const n = frame.n == null ? 1 : frame.n;
  if (!Number.isInteger(n) || n < 1 || n > 64) return { bad: true };
  if (n === 1) return { text: frame.s };
  const i = frame.i;
  if (!Number.isInteger(i) || i < 0 || i >= n) return { bad: true };
  const next = Array.isArray(buffer) ? buffer.slice() : new Array(n).fill(undefined);
  if (next.length !== n) return { bad: true };
  next[i] = frame.s;
  return next.every((s) => typeof s === 'string') ? { text: next.join('') } : { buffer: next };
}

/** A teammate's account as this client will show it, or null when the payload is not one. */
export function sanitizePeerAccount(v, playerId) {
  if (!v || typeof v !== 'object') return null;
  const name = typeof v.name === 'string' ? v.name.trim().slice(0, NAME_MAX) : '';
  const tag = typeof v.tag === 'string' && TAG_RE.test(v.tag) ? v.tag : null;
  const avatar = typeof v.avatar === 'string' && /^data:image\//.test(v.avatar) && v.avatar.length <= MAX_AVATAR ? v.avatar : null;
  if (!name && !avatar) return null;
  return { id: playerId, name, tag, avatar, card: null, local: false };
}

// ---- subscriptions ---------------------------------------------------------------------------------------------------

/** Preact/vanilla: called whenever a teammate's account arrives or changes. @returns {() => void} unsubscribe */
export function subscribePeerAccounts(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() { for (const fn of listeners) { try { fn(); } catch { /* a listener's own problem */ } } }

/** A teammate's account — what this browser learned over P2P, or null (ui/accounts.js accountOf/useAccount). */
export function peerAccount(playerId) { return playerId ? peers.get(playerId)?.account || null : null; }

/** The teammates this browser currently holds an account for (tests / debugging). */
export function peerAccountIds() { return [...peers.entries()].filter(([, p]) => p.account).map(([id]) => id); }

/** This browser's own account, as offered to teammates. `null` avatar tells them to fall back to the initial. */
export function setLocalPeerAccount(account) {
  const name = typeof account?.name === 'string' ? account.name.trim().slice(0, NAME_MAX) : '';
  const tag = typeof account?.tag === 'string' && TAG_RE.test(account.tag) ? account.tag : null;
  const avatar = typeof account?.avatar === 'string' && account.avatar.length <= MAX_AVATAR ? account.avatar : null;
  const next = { name, tag, avatar };
  const changed = !local || local.name !== next.name || local.tag !== next.tag || local.avatar !== next.avatar;
  local = next;
  if (changed) for (const p of peers.values()) if (p.ready) sendLocal(p);
}

/** Point the mesh at a specific STUN server (called before `startPeerAvatars`). */
export function setIceServers(list) { if (Array.isArray(list) && list.length) iceServers = list; }

// ---- the mesh ---------------------------------------------------------------------------------------------------------

const selfId = () => store.get().me?.playerId || null;

function signal(to, kind, data) {
  try { netRef?.send('rtc.signal', { to, kind, data }); } catch { /* the socket is down: the next hello resyncs */ }
}

/** The peers this browser should hold a leg to: every other human in the room (seats and spectators). */
function roomPeerIds() {
  const room = store.get().room;
  const self = selfId();
  const ids = new Set();
  if (!room || !self) return ids;
  for (const s of [...(room.seats || []), ...(room.spectators || [])]) {
    if (s && typeof s.playerId === 'string' && s.playerId !== self && !s.isBot) ids.add(s.playerId);
  }
  return ids;
}

async function drain(dc) {
  // Wait for the send buffer to fall back below the threshold. A closed channel stops the wait immediately.
  let guard = 0;
  while (dc.readyState === 'open' && dc.bufferedAmount > BUFFER_HIGH && guard++ < 200) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

function sendLocal(p) {
  const text = JSON.stringify({ v: 1, name: local?.name || '', tag: local?.tag || null, avatar: local?.avatar || null });
  sendText(p, text);
}

async function sendText(p, text) {
  const dc = p.dc;
  if (!dc || dc.readyState !== 'open') return;
  for (const frame of avatarFrames(text)) {
    await drain(dc);
    if (dc.readyState !== 'open') return;
    try { dc.send(frame); } catch { return; }
  }
}

function attach(p, dc) {
  p.dc = dc;
  dc.onopen = () => { p.ready = true; sendLocal(p); };
  dc.onclose = () => { p.ready = false; p.rx = null; };
  dc.onerror = () => { p.ready = false; };
  dc.onmessage = (e) => {
    const res = foldAvatarFrame(p.rx, e.data);
    if (res.bad) return;
    if (res.buffer) { p.rx = res.buffer; return; }
    p.rx = null;
    let payload;
    try { payload = JSON.parse(res.text); } catch { return; }
    const account = sanitizePeerAccount(payload, p.id);
    if (!account) return;
    p.account = account;
    emit();
  };
}

function ensurePeer(id) {
  const existing = peers.get(id);
  if (existing) return existing;
  if (typeof globalThis.RTCPeerConnection !== 'function') return null;
  const pc = new globalThis.RTCPeerConnection({ iceServers });
  // The larger playerId offers; the smaller one is polite and yields when both offer at once.
  const polite = selfId() < id;
  const p = { id, pc, dc: null, polite, makingOffer: false, ignoreOffer: false, ready: false, rx: null, account: null };
  peers.set(id, p);
  pc.onicecandidate = (e) => { if (e.candidate) signal(id, 'ice', JSON.stringify(e.candidate)); };
  pc.onnegotiationneeded = async () => {
    try {
      p.makingOffer = true;
      await pc.setLocalDescription();
      signal(id, pc.localDescription.type, JSON.stringify(pc.localDescription));
    } catch { /* a failed negotiation is retried on the next room change */ } finally { p.makingOffer = false; }
  };
  pc.ondatachannel = (e) => attach(p, e.channel);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch { /* older browsers: leave it */ } }
  };
  if (!polite) attach(p, pc.createDataChannel(DC_LABEL));
  return p;
}

function destroyPeer(id) {
  const p = peers.get(id);
  if (!p) return;
  peers.delete(id);
  try { p.dc?.close(); } catch { /* already gone */ }
  try { p.pc.close(); } catch { /* already gone */ }
  if (p.account) emit();
}

/** Add/remove legs so the mesh matches the room's humans. Called on every store change. */
function syncPeers() {
  if (!started) return;
  const want = roomPeerIds();
  for (const id of want) if (!peers.has(id)) ensurePeer(id);
  for (const id of [...peers.keys()]) if (!want.has(id)) destroyPeer(id);
}

async function onSignal(msg) {
  const from = msg?.from;
  if (typeof from !== 'string' || from === selfId()) return;
  const p = peers.get(from);
  if (!p) return; // not a teammate of the current room: ignore (membership is syncPeers' decision)
  const pc = p.pc;
  try {
    if (msg.kind === 'ice') {
      try { await pc.addIceCandidate(JSON.parse(msg.data)); } catch (e) { if (!p.ignoreOffer) throw e; }
      return;
    }
    const desc = JSON.parse(msg.data);
    const collision = desc.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
    p.ignoreOffer = !p.polite && collision;
    if (p.ignoreOffer) return;
    await pc.setRemoteDescription(desc);
    if (desc.type === 'offer') {
      await pc.setLocalDescription();
      signal(from, pc.localDescription.type, JSON.stringify(pc.localDescription));
    }
  } catch { /* a malformed or late signal is dropped; the next negotiation retries */ }
}

// ---- lifecycle --------------------------------------------------------------------------------------------------------

/** Begin offering this browser's account to the room's teammates. Idempotent; safe without WebRTC. */
export async function startPeerAvatars() {
  if (started || !enabled) return;
  // No WebRTC (Node tests, an old browser): the room simply keeps showing the namecard operator.
  if (typeof globalThis.RTCPeerConnection !== 'function') return;
  started = true;
  const mod = await import('../net.js');
  netRef = mod.net;
  netRef.on('rtc.signal', onSignal);
  if (typeof store.subscribe === 'function') store.subscribe(syncPeers);
  syncPeers();
}

/** Stop the mesh and forget every teammate's account (tests, and the identity-change reset). */
export function stopPeerAvatars() {
  if (!started) return;
  started = false;
  for (const id of [...peers.keys()]) destroyPeer(id);
  try { netRef?.off('rtc.signal', onSignal); } catch { /* already detached */ }
  netRef = null;
  local = null;
  emit();
}

/** Whether the mesh is running (the settings toggle and the tests). */
export function peerAvatarsRunning() { return started; }

/**
 * 设置 →「头像 P2P」(ui/settings.js applyP2pAvatar): the player's choice, which every start path honours — the
 * boot call in main.js included, so a stored `false` cannot be overridden by the app's own startup. Turning it off
 * also closes an already-running mesh and forgets what teammates sent.
 * @param {boolean} v
 */
export function setPeerAvatarsEnabled(v) {
  enabled = v !== false;
  if (!enabled) stopPeerAvatars();
  else startPeerAvatars();
}
