// server/state/playerstate.js — the P2a per-seat payload: the FULL gameplay state of one PlayerState (server/match/
// PlayerState.js), captured into plain JSON and applied back onto a rebuilt seat.
//
// Why a GENERIC serializer: a piece is an open bag of fields. `newPiece` writes uid/kind/id/items/count/ownerUid/
// poolCopies/boughtRound/meta and the rest of server/** keeps adding to it (meta.round, deferMerge, dir, …), so a
// whitelist here would silently drop whatever was added last — the exact "record that lies" failure this feature must
// never produce. So every container is copied by walking OWN ENUMERABLE PROPERTIES and recursing (arrays, plain
// objects, `Map` as an entry list), and only values that are not JSON-shaped (functions, class instances) are dropped.
//
// What is deliberately NOT captured:
//   * `bonds` — derived from layers/board/… by the pure `computeBonds` (bondsMeta.js), recomputed on apply;
//   * `_deployMap` / `_deployField` / `_legalityStale` / `_botPrepToken` — caches of the match's terrain and of the bot
//     scheduler; the first three are invalidated (and thus recomputed) on apply;
//   * `lastResult` — written by settle for the 联防 carry state and never read outside the round it belongs to (and
//     only a ROUND_START / settled record is resumable).
//
// Ordering contract for the caller (server/state/resume.js): `applyPlayerState` is applied to a FRESHLY rebuilt seat
// and replaces the containers it owns; it never allocates from the shared pool and never consumes randomness, so the
// caller restores `pool.snapshot()` / the rng positions / `uidSeq` AFTER it (a payload grant that is overwritten must
// not move the pool).

import { applyPayload } from './snapshot.js';

/** Depth guard of the generic copy: content graphs (effect params, offer data) are shallow by construction. */
const MAX_DEPTH = 8;

/** `clone` result for a value that must not enter a JSON record (function, class instance, …). */
const DROP = Symbol('drop');

/**
 * Deep, JSON-shaped copy of a value: primitives, arrays, plain objects. A `Map` becomes an object of its entries (a
 * plain object graph is what the rest of the payload uses); anything else is DROPPED rather than serialised into
 * something a rebuild could not read back.
 * @param {any} v @param {number} [depth]
 */
function copy(v, depth = 0) {
  if (v === null || typeof v === 'undefined') return v;
  const t = typeof v;
  if (t === 'number' || t === 'string' || t === 'boolean') return v;
  if (t !== 'object') return DROP; // function / symbol / bigint: not part of a record
  if (depth >= MAX_DEPTH) return DROP;
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) { const x = copy(v[i], depth + 1); out[i] = x === DROP ? null : x; }
    return out;
  }
  if (v instanceof Map) {
    const out = {};
    for (const [k, x] of v) { const y = copy(x, depth + 1); if (y !== DROP) out[String(k)] = y; }
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return DROP;
  const out = {};
  for (const k of Object.keys(v)) { const x = copy(v[k], depth + 1); if (x !== DROP) out[k] = x; }
  return out;
}

/** A JSON-shaped copy of `v` with every unreadable value turned into null (used where a value is required). */
function copyOrNull(v) { const x = copy(v); return x === DROP ? null : x; }

/** The same generic copy, named for the APPLY direction: a restored piece is a fresh object, never the record's own. */
const applyPiece = (piece) => (piece ? copyOrNull(piece) : null);

/** A finite number or the fallback. */
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** True when `ps` is a real engine PlayerState (the platform stub exposes plain seat objects instead). */
export function hasEngineShape(ps) {
  return !!(ps && ps.board instanceof Map && Array.isArray(ps.hand) && Array.isArray(ps.temp) && ps.shop && typeof ps.shop === 'object');
}

/**
 * One piece as plain JSON (a generic own-property spread, `items` included by the recursion). `null` stays `null`
 * (an empty hand / temp slot).
 */
export function capturePiece(piece) {
  return piece ? copyOrNull(piece) : null;
}

/** A slot / offer / effect / bounty object: the same generic copy. */
export { copyOrNull as captureValue };

/**
 * The P2a payload of one seat. Every field the engine's gameplay reads is here (see the header for the three
 * deliberate omissions); nothing is whitelisted per piece.
 */
export function captureProps(ps) {
  const shop = ps.shop && typeof ps.shop === 'object' ? ps.shop : {};
  return {
    alive: ps.alive !== false,
    lp: num(ps.lp, 0),
    bandId: typeof ps.bandId === 'string' ? ps.bandId : null,
    funds: num(ps.funds, 0),
    pendingFunds: num(ps.pendingFunds, 0),
    prepsEnded: Number.isInteger(ps.prepsEnded) ? ps.prepsEnded : 0,
    ready: !!ps.ready,
    infoReady: !!ps.infoReady,
    autoplay: !!ps.autoplay,
    deployCapBonus: num(ps.deployCapBonus, 0),
    deployCapMin: num(ps.deployCapMin, 0),
    eliminatedRound: Number.isInteger(ps.eliminatedRound) ? ps.eliminatedRound : null,
    lpAtFinal: num(ps.lpAtFinal, null),
    /** the frozen operator loadout (`{ [chessId]: { skill, module } }`) — re-checked by setLoadout on apply */
    loadout: copyOrNull(ps.loadout) || {},
    hand: (ps.hand || []).map(capturePiece),
    temp: (ps.temp || []).map(capturePiece),
    /** board as an entry list: a `Map` is not JSON, and the insertion order is the reading order of the UI */
    board: [...(ps.board instanceof Map ? ps.board : [])].map(([k, p]) => [String(k), capturePiece(p)]),
    /** `_tempDue`: uid → the prep whose deadline resolves the piece (PlayerState.tempDue) */
    tempDue: [...(ps._tempDue instanceof Map ? ps._tempDue : [])].map(([uid, due]) => [uid, due]),
    shop: {
      level: num(shop.level, 1),
      upgradePrice: num(shop.upgradePrice, 0),
      freeRefreshes: num(shop.freeRefreshes, 0),
      frozen: !!shop.frozen,
      /** created LAZILY by rollShop (absent from the constructor): null when the shop never rolled */
      layout: shop.layout ? copyOrNull(shop.layout) : null,
      slots: (shop.slots || []).map(capturePiece),
    },
    offers: copyOrNull(ps.offers) || [],
    effects: copyOrNull(ps.effects) || [],
    bounties: copyOrNull(ps.bounties) || [],
    counters: copyOrNull(ps.counters) || {},
    round: copyOrNull(ps.round) || {},
    layers: copyOrNull(ps.layers) || {},
    bondCountBonus: copyOrNull(ps.bondCountBonus) || {},
    stats: copyOrNull(ps.stats) || {},
    pendingLayerGains: ps.pendingLayerGains ? copyOrNull(ps.pendingLayerGains) : null,
    deviceOverrides: copyOrNull(ps.deviceOverrides) || {},
    tileOverrides: copyOrNull(ps.tileOverrides) || {},
  };
}

/** Fill `target[i]` from `src[i]` for every slot of `target` (a shorter source leaves the tail empty). */
function slotArray(target, src) {
  const out = new Array(target.length).fill(null);
  for (let i = 0; i < out.length; i++) out[i] = applyPiece(Array.isArray(src) ? src[i] : null);
  return out;
}

/**
 * Apply a payload captured by `captureProps` onto a freshly rebuilt seat. Containers are REPLACED (not merged) so a
 * piece the rebuild granted by itself can never survive next to the recorded one; every piece is a fresh object, so
 * mutating the restored seat never writes back into the record.
 *
 * Legality is then re-established, not trusted: device/tile overrides and the board changed under the cached deploy
 * map, so it is invalidated and `recompute()` re-derives the bonds (never persisted) and re-checks the board on the
 * field the seat deploys on now.
 *
 * @param {any} ps @param {any} props
 * @returns {boolean} true when the payload was applied
 */
export function applyProps(ps, props) {
  if (!hasEngineShape(ps) || !props || typeof props !== 'object') return false;
  const shop = props.shop && typeof props.shop === 'object' ? props.shop : {};
  ps.alive = props.alive !== false;
  ps.lp = num(props.lp, ps.lp);
  ps.bandId = typeof props.bandId === 'string' ? props.bandId : null;
  ps.funds = num(props.funds, ps.funds);
  ps.pendingFunds = num(props.pendingFunds, ps.pendingFunds);
  ps.prepsEnded = Number.isInteger(props.prepsEnded) ? props.prepsEnded : ps.prepsEnded;
  ps.ready = !!props.ready;
  ps.infoReady = !!props.infoReady;
  ps.autoplay = !!props.autoplay;
  ps.deployCapBonus = num(props.deployCapBonus, ps.deployCapBonus);
  ps.deployCapMin = num(props.deployCapMin, ps.deployCapMin);
  ps.eliminatedRound = Number.isInteger(props.eliminatedRound) ? props.eliminatedRound : null;
  ps.lpAtFinal = num(props.lpAtFinal, null);
  ps.hand = slotArray(ps.hand, props.hand);
  ps.temp = slotArray(ps.temp, props.temp);
  const board = new Map();
  for (const e of Array.isArray(props.board) ? props.board : []) {
    if (!Array.isArray(e) || typeof e[0] !== 'string') continue;
    const piece = applyPiece(e[1]);
    if (piece) board.set(e[0], piece);
  }
  ps.board = board;
  const due = new Map();
  for (const e of Array.isArray(props.tempDue) ? props.tempDue : []) {
    if (!Array.isArray(e) || !Number.isInteger(e[0])) continue;
    due.set(e[0], Number.isInteger(e[1]) ? e[1] : ps.prepsEnded);
  }
  ps._tempDue = due;
  ps.shop.level = num(shop.level, ps.shop.level);
  ps.shop.upgradePrice = num(shop.upgradePrice, ps.shop.upgradePrice);
  ps.shop.freeRefreshes = num(shop.freeRefreshes, ps.shop.freeRefreshes);
  ps.shop.frozen = !!shop.frozen;
  ps.shop.slots = (shop.slots || []).map(applyPiece);
  if (shop.layout && typeof shop.layout === 'object') ps.shop.layout = copyOrNull(shop.layout);
  ps.offers = copyOrNull(props.offers) || [];
  ps.effects = copyOrNull(props.effects) || [];
  ps.bounties = copyOrNull(props.bounties) || [];
  ps.counters = copyOrNull(props.counters) || {};
  ps.round = copyOrNull(props.round) || {};
  ps.layers = copyOrNull(props.layers) || {};
  ps.bondCountBonus = copyOrNull(props.bondCountBonus) || {};
  ps.stats = copyOrNull(props.stats) || {};
  ps.pendingLayerGains = props.pendingLayerGains ? copyOrNull(props.pendingLayerGains) : null;
  ps.deviceOverrides = copyOrNull(props.deviceOverrides) || {};
  ps.tileOverrides = copyOrNull(props.tileOverrides) || {};
  if (!ps.isBot && ps.setLoadout) ps.setLoadout(copyOrNull(props.loadout) || {});
  // the cached deploy map describes a board that no longer exists: drop it and let recompute() re-derive the bonds and
  // re-check the restored board's legality on the current field
  if (typeof ps.invalidateDeployMap === 'function') ps.invalidateDeployMap();
  if (typeof ps.recompute === 'function') ps.recompute();
  return true;
}

/**
 * Restore one seat from its record payload: the plain-JSON progress (snapshot.applyPayload) AND, when the seat is a
 * real engine PlayerState, the full P2a props. A record written against a narrower match implementation (the platform
 * stub) keeps applying exactly what it always did.
 * @param {any} ps @param {any} payload
 * @returns {boolean} true when something was applied
 */
export function applyPlayerState(ps, payload) {
  if (!ps || !payload || typeof payload !== 'object' || payload.playerId !== ps.playerId) return false;
  const plain = applyPayload(ps, payload);
  const full = hasEngineShape(ps) && payload.props ? applyProps(ps, payload.props) : false;
  return plain || full;
}
