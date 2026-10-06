// server/state/resume.js — reading persisted matches back, and the version gate that decides whether one may resume.
//
// Rehydration is LAZY (server/lobby.js): at boot the index is only READ — records are checked, counted and remembered
// as "resumable"; no Match is rebuilt and no game CPU is spent until a player actually comes back. This module holds
// the three pieces that decision needs:
//
//   rulesHash()         sha256 over `data/*.json` minus the art/text manifests (`RULES_INPUTS.skip`) plus
//                       `shared/constants.js` = "the rules this process runs".
//   checkRecord()       version / expiry / human / build / rulesHash gate + (P2a, widened by P1) the RE-ENTRY gate:
//                       any match — a lone human's run or a whole co-op room — at a re-enterable point
//                       (`resumePlan`: the round start, the open prep the heartbeat writes,
//                       or the settle it can continue from) may be put back into a rebuilt match. A record
//                       whose build or rules changed is REFUSED (logged once) — an old input log replayed against new
//                       rules is exactly the corruption this feature must never cause, and preferring a clean
//                       "simulation closed" over a wrong match is the whole point of the gate.
//   loadResumable()     the boot scan (rate-limited and hard-capped, so boot can never stall) + `StateBridge`, which
//                       the lobby and net.js talk to.
//   applyRecord()       the ONE way back into a rebuilt match (`Match.resumeAt` + the recorded payloads + the volatile
//                       run state), in the order the recorded phase demands — see its own doc comment.
//
// `StateBridge` is the only object the rest of the server sees. Its `claim(token)` is what makes resume possible across
// a restart: sessions live in memory, so a restarted process cannot resolve the client's reconnect token — but the
// record holds `sha256(token)` per human seat, so the first `hello` that presents that token gets the SAME playerId
// back (server/net.js adoptIdentity → server/lobby.js). Without it a returning player would be a brand-new player and
// could not be put back into the match at all.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PHASE } from '../../shared/constants.js';
import { RECORD_VERSION, hasHuman, tokenHash, buildRecord, buildRoomRecord } from './snapshot.js';
import { applyPlayerState } from './playerstate.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * May this record be re-entered, and where? (P2a) A record carries engine state only in v2+ (`record.state`), and only
 * the ROUND-START-based points of a match can be reconstructed faithfully from what a record holds — for a lone human
 * and for a whole co-op room alike (P1: every seat is in the record):
 *
 *   ROUND_START r — written at the end of `Match.startRound(r)`: the payload is the state right after the round start,
 *                   so the resume restores it as-is (`playerStart:false`, the recorded wave) and the payload follows.
 *   PREP r        — written by the mid-round heartbeat while the prep is open (a lone-human prep is untimed, so this is
 *                   the record a live process is usually sitting on). It re-enters the SAME round, with the same
 *                   options plus `intoPrep:true`: the payload already holds everything the round start and the prep
 *                   entry produced (income, the lowered upgrade price, the rolled shop, the prep-start grants), so
 *                   `PlayerState.startRound` is skipped, the recorded wave is kept and the payload overrides the
 *                   re-entry. `intoPrep` also keeps the transition out of ROUND_START from going through the round's
 *                   机变 draft (a record written inside the prep is already past it — replaying it would hand out a
 *                   second card) or through the prep entry itself (replaying it would clear `ready` and dispatch
 *                   `onPrepStart` a second time). The heartbeat record is the newest truth on disk — refusing it would
 *                   throw away the whole point of the heartbeat, which exists to bound a crash to a few seconds.
 *   SETTLE r      — written at the end of `Match.settle()`: the round is settled, so the continuation is what the engine
 *                   itself does next (`afterSettle` → `startRound(r + 1)`): the payload is applied first, then the next
 *                   round start runs normally (income, upgrade price, a fresh shop, a freshly drawn wave).
 *
 * Everything else is REFUSED, by design and not by omission:
 *   * `final` — the Hidden Core chapter is entered from the VISIBLE final assault's live outcome (team LP, the shared
 *     boss pool, the hidden layer sum), none of which a record holds (P2a refuses the final assault);
 *   * `phase` — COMBAT / UNITE / SP_DRAFT / BAND_DRAFT / FINAL_ASSAULT / INFO_CHECK: a battle in flight, a draft in
 *     progress or a final assault is not persisted anywhere in the record, so re-entering it would invent one;
 *   * `no-state` — a record of a match implementation that exposes no engine state (the platform stub): there is no
 *     round to re-enter, and reading it as one would be a guess. `checkRecord` deliberately does NOT gate those (their
 *     records have no `state`), so the platform's own resume path keeps working unchanged.
 *
 * A PREP record is accepted because its re-entry is FAITHFUL, and that is MEASURED rather than assumed: a mid-prep
 * payload round-trips field for field — the seat digest (hand / board / temp / offers / shop / layers / counters), the
 * shared pool, all six rng positions, no second income, no second upgrade-price drop, no re-rolled shop, `uidSeq`
 * untouched — both at a plain round and at a 机变 round, right after the re-entry and again once the prep is open.
 * See test/state/resume-p2a.test.js ('a PREP record …'), which pins the equality on both, and
 * test/state/lobby-resume.test.js, which does it end to end through `claim` + `rehydrate`.
 *
 * @param {any} record
 * @returns {{ ok: true, round: number, payloadFirst: boolean, intoPrep: boolean } | { ok: false, reason: string }}
 */
export function resumePlan(record) {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'missing' };
  // the version is re-checked here too: this is the function that decides to RE-ENTER a match, and a v1 record has no
  // `props` to re-enter with even when a caller forgot `checkRecord`
  if (record.version !== RECORD_VERSION) return { ok: false, reason: 'version' };
  if (!record.state) return { ok: false, reason: 'no-state' };
  // P1: the number of human seats is NOT a gate. A co-op record carries every seat (each human with its own tokenHash,
  // each bot with its whole PlayerState) and the lobby rebuilds the room and the match from those rows, so a teammate
  // that never comes back costs its own seat, never the match. `loneHuman` stays in the record as a description only.
  // the first round whose entry depends on the visible final assault's outcome (see the header): the Hidden Core when
  // the mode has one, else every round past the last (where the mode has no hidden chapter, the match is simply over)
  const finalRound = Number.isInteger(record.hiddenRound) ? record.hiddenRound
    : (Number.isInteger(record.lastRound) ? record.lastRound + 1 : null);
  if (finalRound != null && Number.isInteger(record.round) && record.round >= finalRound) return { ok: false, reason: 'final' };
  // ROUND_START and PREP share the re-entry: re-enter the round with `playerStart:false` and the payload after it.
  // `intoPrep` is where they differ — a PREP record is already PAST the round's 机变 draft and INSIDE its prep, so the
  // engine may neither replay the draft (a second card) nor re-run the prep entry (a cleared `ready`). SETTLE is the
  // other direction (the settled round, continued by the engine's own next round start).
  if (record.phase === PHASE.ROUND_START || record.phase === PHASE.PREP) {
    return {
      ok: true,
      round: Number.isInteger(record.round) ? record.round : 1,
      payloadFirst: false,
      intoPrep: record.phase === PHASE.PREP,
    };
  }
  if (record.phase === PHASE.SETTLE) return { ok: true, round: (Number.isInteger(record.round) ? record.round : 0) + 1, payloadFirst: true, intoPrep: false };
  return { ok: false, reason: 'phase' };
}

/** Repository root (server/state/ → ../..). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Record keys: `match:<ROOM CODE>` (the prefix `loadResumable` scans). */
export const KEY_PREFIX = 'match:';
export const matchKey = (code) => `${KEY_PREFIX}${String(code)}`;

/**
 * The state directory as the scan report may disclose it: its last path segment plus a short hash of the full path. The
 * report travels on `/healthz`, which is public and polled by every client, so it must identify the directory (is this
 * the one I think it is?) without publishing the deploy path of the host.
 */
export function dirTag(dir) {
  if (!dir) return null;
  const s = String(dir);
  return `${path.basename(s)}#${createHash('sha256').update(s).digest('hex').slice(0, 8)}`;
}

/**
 * The refusal reasons whose record can NEVER be resumed again — the only ones `purgeRefused` deletes at boot. Anything
 * else (`phase`, `build`, `rules`) is unusable for THIS process only and is kept (see `purgeRefused` for why).
 */
export const PURGEABLE_REFUSALS = new Set(['version', 'shape', 'ended', 'no-human', 'key-mismatch', 'expired']);

/** The default record TTL. It is never shorter than `SP_SOLO_RECONNECT_MS` (see recordTtlMs). */
export const RESUME_TTL_MS = 20 * 60 * 1000;

/**
 * TTL for a persisted record: 20 minutes, raised to `SP_SOLO_RECONNECT_MS` when that is longer. The solo reconnect
 * window is the official 休整期 promise ("come back within singleReconnectTime"), so a record may not expire while the
 * server would still accept the session. NOTE: `SP_SOLO_RECONNECT_MS` is a plain env knob (900000 ms = 15 min is
 * SHORTER than the 20-minute default, so it does not lower it); the design's "20 minutes, aligned with 900000" reads
 * as the max of the two, which is what this returns.
 * @param {{ ttlMs?: number, env?: Record<string, string | undefined> }} [opts]
 */
export function recordTtlMs({ ttlMs, env = process.env } = {}) {
  if (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0) return ttlMs;
  const solo = Number(env.SP_SOLO_RECONNECT_MS);
  const base = Number.isFinite(solo) && solo > 0 ? solo : RESUME_TTL_MS;
  return Math.max(RESUME_TTL_MS, base);
}

// ---------------------------------------------------------------------------------------------------
// rulesHash — "the rules this process runs"
// ---------------------------------------------------------------------------------------------------

/**
 * Files whose CONTENT decides whether an old match may be resumed (relative to the repo root).
 *
 * `data/*.json` is hashed EXCEPT the manifests in `skip`: those describe ART and TEXT, not rules, and a deploy
 * rewrites them without changing a single rule — `assets.json` (the asset manifest), `local-assets.json` (the
 * local-client extraction, which even differs from machine to machine), `emotes.json` (the emote art) and
 * `notice.json` (the announcement text). Hashing them would refuse every resumable match after a pure art or
 * announcement deploy, which is precisely what this gate must not do. Everything else under `data/` is rules.
 */
export const RULES_INPUTS = Object.freeze({
  dirs: ['data'],
  files: ['shared/constants.js'],
  skip: Object.freeze(['assets.json', 'local-assets.json', 'emotes.json', 'notice.json']),
});

let rulesCache = null;

/**
 * sha256 over the contents of `data/*.json` (top level, sorted, minus `RULES_INPUTS.skip`) and
 * `shared/constants.js`. Content, not mtime: the hash must survive a checkout/deploy that does not change a single
 * rule, and MUST change on any content change.
 * Computed once per process (the files are read at startup and never re-read), like the build tag in server/index.js.
 * @param {{ root?: string, dataDir?: string, extraFiles?: string[] }} [opts] used by the first call only
 */
export function rulesHash({ root = ROOT, dataDir = null, extraFiles = null } = {}) {
  if (rulesCache !== null) return rulesCache;
  const h = createHash('sha256');
  const add = (abs, rel) => {
    let buf;
    try { buf = fs.readFileSync(abs); } catch { h.update(`${rel}\0missing\n`); return; }
    h.update(`${rel}\0${buf.length}\0`);
    h.update(buf);
    h.update('\n');
  };
  const files = [];
  const dir = dataDir || path.join(root, RULES_INPUTS.dirs[0]);
  try {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.json') || name.startsWith('.') || RULES_INPUTS.skip.includes(name)) continue;
      files.push([path.join(dir, name), `data/${name}`]);
    }
  } catch { /* a missing data dir hashes as empty — the process itself would be broken long before this matters */ }
  for (const rel of (extraFiles || RULES_INPUTS.files)) files.push([path.join(root, rel), rel]);
  files.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  for (const [abs, rel] of files) add(abs, rel);
  rulesCache = h.digest('hex');
  return rulesCache;
}

/** The server's own code as one hash. `rulesHash` covers the CONTENT that decides a match's rules (`data/*.json` minus
 * the art/text manifests, plus `shared/constants.js`) and nothing else, so an ENGINE-only deploy (`server/**`) is
 * invisible to the version gate — and with `SP_STATE_IGNORE_BUILD` the build half is skipped as well, which means an
 * old payload could be replayed into changed engine code with nothing able to notice.
 *
 * This is REPORTED and never gated on, deliberately: refusing every record after every code deploy is the opposite of
 * "a restart must not interrupt a match". It surfaces through `/healthz.state.scan.gate.engine`, so a record written
 * by other engine code than the one now reading it is at least visible to an operator. Computed once per process.
 * @param {{ root?: string }} [opts] used by the first call only
 */
let engineCache = null;

/** Drop the caches: the next `rulesHash()` / `engineHash()` re-reads the files (tests). */
export function resetRulesHash() { rulesCache = null; engineCache = null; }

export function engineHash({ root = ROOT } = {}) {
  // only the default root is cached: a caller passing another tree (tests) must get that tree's hash, not the cache's
  if (root === ROOT && engineCache !== null) return engineCache;
  const h = createHash('sha256');
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(abs); } else if (e.name.endsWith('.js')) files.push(abs);
    }
  };
  walk(path.join(root, 'server'));
  files.sort();
  for (const abs of files) {
    let buf;
    try { buf = fs.readFileSync(abs); } catch { continue; }
    h.update(`${path.relative(root, abs).split(path.sep).join('/')}\0${buf.length}\0`);
    h.update(buf);
    h.update('\n');
  }
  const digest = h.digest('hex');
  if (root === ROOT) engineCache = digest;
  return digest;
}

/**
 * May this record be resumed by THIS process? The order of the checks is the order of the reasons a resume is refused;
 * `rules`/`build` are the version gate, and they are checked BEFORE anything is rebuilt.
 *
 * The last check is the P2a RE-ENTRY gate: a record that carries engine state (`record.state`, v2) is resumable only
 * at a re-enterable point (see `resumePlan` — the round start, an OPEN prep, or a settle), for a lone human and for a
 * whole co-op room alike (P1). It is refused with `phase` / `final`, exactly like the version gate: a record this
 * process cannot re-enter must not be handed to the lobby (which would rebuild a room around a half-restored match) —
 * it is refused and purged instead.
 * A record WITHOUT engine state (a room whose match has not started yet, or the platform stub) has no round to
 * re-enter and keeps its old behaviour: it rebuilds the ROOM (P2), never a match.
 *
 * @param {any} record
 * @param {{ now?: number, ttlMs?: number, build?: string | null, rulesHash?: string | null }} [opts]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkRecord(record, { now = Date.now(), ttlMs = RESUME_TTL_MS, build = null, rulesHash: hash = null } = {}) {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'missing' };
  if (record.version !== RECORD_VERSION) return { ok: false, reason: 'version' };
  if (typeof record.code !== 'string' || !record.code || !Array.isArray(record.seats) || !record.seats.length) {
    return { ok: false, reason: 'shape' };
  }
  if (record.ended) return { ok: false, reason: 'ended' };
  if (!hasHuman(record)) return { ok: false, reason: 'no-human' };
  if (!(record.updatedAt > 0) || now - record.updatedAt > ttlMs) return { ok: false, reason: 'expired' };
  // The version gate: a record written by another build (or against other rules) is NEVER replayed — its engine state
  // would be reconstructed against inputs it never saw. A ROOM record (P2) carries no engine state at all
  // (`inMatch: false`, `state: null`): there is nothing to replay, so a deploy must not delete the room and evict
  // everybody sitting in it. Every other reason below still applies to it.
  if (record.inMatch !== false) {
    if (build != null && record.build != null && record.build !== build) return { ok: false, reason: 'build' };
    if (hash != null && record.rulesHash != null && record.rulesHash !== hash) return { ok: false, reason: 'rules' };
  }
  if (record.state) {
    const plan = resumePlan(record);
    if (!plan.ok) return { ok: false, reason: plan.reason };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------
// boot scan
// ---------------------------------------------------------------------------------------------------

/**
 * Read every persisted record under `match:` — paced (`perSecond`) and hard-capped (`maxRecords`, `budgetMs`) so a
 * large state directory can never stall boot. Records that fail the gate are reported, not thrown.
 *
 * `onRecord(record, key)` is called for each ACCEPTED record as it is read, which is what lets the caller mark it
 * immediately (server/index.js): batching the marks until the whole scan finished meant a player who reconnected
 * during the scan — seconds to a minute of reading — was given a fresh, identity-less session.
 *
 * @param {{ list: Function, get: Function, listError?: string | null, readErrors?: number }} store
 * @param {{ now?: number, ttlMs?: number, build?: string | null, rulesHash?: string | null, maxRecords?: number,
 *           perSecond?: number, budgetMs?: number, log?: object, sleep?: (ms: number) => Promise<unknown>,
 *           onRecord?: ((record: any, key: string) => void) | null }} [opts]
 * @returns {Promise<{ records: any[], refused: { key: string, reason: string }[], scanned: number, capped: boolean,
 *           listed: number, listError: string | null, readErrors: number }>}
 */
export async function loadResumable(store, {
  now = Date.now(),
  ttlMs = RESUME_TTL_MS,
  build = null,
  rulesHash: hash = null,
  maxRecords = 200,
  perSecond = 20,
  budgetMs = 2000,
  log = noopLog,
  sleep = delay,
  onRecord = null,
} = {}) {
  const out = { records: [], refused: [], scanned: 0, capped: false, listed: 0, listError: null, readErrors: 0 };
  if (!store || typeof store.list !== 'function' || typeof store.get !== 'function') return out;
  let keys = [];
  try { keys = await store.list(KEY_PREFIX); } catch (e) {
    // the CODE, not the message: an fs message embeds the path, and this string is published on a public /healthz
    out.listError = String((e && (e.code || e.message)) || e);
    log.warn?.(`[state] resume scan failed: ${out.listError}`);
    return out;
  }
  // how many keys the store actually reported (`scanned` is only how many the budget allowed): the difference is what
  // the cap skipped, and 0 here versus a directory full of files is what tells "empty" from "unreadable" apart
  out.listed = keys.length;
  const started = Date.now();
  const gap = Number.isFinite(perSecond) && perSecond > 0 ? Math.ceil(1000 / perSecond) : 0;
  for (const key of keys) {
    if (out.scanned >= maxRecords || Date.now() - started > budgetMs) { out.capped = true; break; }
    out.scanned++;
    let record = null;
    try { record = await store.get(key); } catch { record = null; out.readErrors++; }
    const verdict = checkRecord(record, { now, ttlMs, build, rulesHash: hash });
    if (verdict.ok) {
      // the key owns the identity: a record whose `code` disagrees with its key is not trusted
      if (matchKey(record.code) !== key) { out.refused.push({ key, reason: 'key-mismatch' }); continue; }
      out.records.push(record);
      // an accepted record is marked as soon as it is read (see the doc comment); a hook that throws may not stop the boot
      if (typeof onRecord === 'function') { try { onRecord(record, key); } catch { /* the scan is never a control path */ } }
    } else {
      out.refused.push({ key, reason: verdict.reason });
    }
    if (gap) await sleep(gap);
  }
  if (out.capped) log.warn?.(`[state] resume scan capped at ${out.scanned} record(s) (more remain on disk)`);
  // A store may SWALLOW a readdir/read failure and answer "empty" instead (FileStore does, deliberately: a broken record
  // must not take the boot down). Re-report it here, so the scan report can tell an empty directory from an unreadable one.
  if (!out.listError && typeof store.listError === 'string' && store.listError) out.listError = store.listError;
  if (Number.isFinite(store.readErrors) && store.readErrors > 0) out.readErrors = Math.max(out.readErrors, store.readErrors);
  return out;
}

/** The Match-constructor seat rows of a record (a human seat keeps its recorded id and loadout). */
export function recordSeats(record) {
  const byId = new Map((record.players || []).map((p) => [p && p.playerId, p]));
  return (record.seats || []).filter(Boolean).map((s) => ({
    seat: s.seat,
    playerId: s.playerId,
    name: s.name,
    isBot: !!s.isBot,
    connected: false,
    loadout: s.isBot ? null : (byId.get(s.playerId)?.loadout || null),
  }));
}

/** Restore every recorded seat of a record (bots included — an AI teammate's board is part of the state a human sees). */
function applyPlayers(match, record) {
  let applied = 0;
  for (const payload of record.players || []) {
    const ps = payload && match.players && match.players.get(payload.playerId);
    if (!ps) continue;
    if (applyPlayerState(ps, payload)) applied++;
  }
  return applied;
}

/**
 * Put a rebuilt match back into the recorded round and restore the recorded state (snapshot.js + playerstate.js).
 * Called by the lobby after `new MatchClass(...)` + `start()`, and only when the version + re-entry gates passed.
 *
 * The ORDER is the fix for the double-apply bug the P0/P1 gated path had (state was restored, then `resumeAt` ran
 * `PlayerState.startRound` on top of it: a second income, a second upgrade-price decrement and a re-rolled shop, all
 * compounding on every resume). It now mirrors what the recording process did next (see `resumePlan`):
 *
 *   ROUND_START — `resumeAt(r, { playerStart:false, drawWave:false })` (no `PlayerState.startRound`, the recorded
 *                 wave), then the payloads, then the run state (rng positions, pool, uidSeq, battleSeq). The rng is
 *                 restored LAST on purpose: the round-start effects that still run may consume randomness, and what a
 *                 record promises is the streams' position at the recorded moment.
 *   PREP        — the same branch with `intoPrep:true`: the recorded round is re-entered exactly as above (the payload
 *                 is mid-prep and overrides everything the re-entry produced), but the transition that leads out of
 *                 ROUND_START goes STRAIGHT to the prep — the record is already past this round's 机变 draft and inside
 *                 its prep, so neither the draft (a second card) nor the prep entry (a cleared `ready`, a second
 *                 `onPrepStart`) may run again. 1.5 s of round-start presentation aside, the match is back in the prep
 *                 it was interrupted in, at the recorded rng positions, ready for the player's next message.
 *   SETTLE      — the run state first (the streams/pool/uidSeq the NEXT round start draws from), then the payloads,
 *                 then the ordinary `resumeAt(r + 1)`: the transition is REPLAYED from the recorded position, so the
 *                 rebuilt round start is the one the dead process would have produced.
 *
 * @returns {number} how many seats were restored
 */
export function applyRecord(match, record) {
  if (!match || !record) return 0;
  const plan = resumePlan(record);
  // A record with no engine state (the platform stub) has no round to re-enter, but its plain payload is still applied
  // exactly as before P2a; a record whose POINT cannot be re-entered (co-op, mid-combat, mid-draft, final assault) is
  // left untouched instead — never half-entered.
  if (!plan.ok) return plan.reason === 'no-state' ? applyPlayers(match, record) : 0;
  const hasRunState = !!record.state;
  let applied = 0;
  if (plan.payloadFirst) {
    if (hasRunState && typeof match.restoreRunState === 'function') match.restoreRunState(record.state);
    applied = applyPlayers(match, record);
    if (typeof match.resumeAt === 'function') match.resumeAt(plan.round);
  } else {
    if (typeof match.resumeAt === 'function') {
      match.resumeAt(plan.round, {
        playerStart: false,
        drawWave: false,
        wave: record.state.wave,
        bossWaves: record.state.bossWaves,
        intoPrep: plan.intoPrep,
      });
    }
    applied = applyPlayers(match, record);
    if (hasRunState && typeof match.restoreRunState === 'function') match.restoreRunState(record.state);
  }
  return applied;
}

// ---------------------------------------------------------------------------------------------------
// StateBridge — the single object the lobby / net.js talk to
// ---------------------------------------------------------------------------------------------------

/**
 * Glue between the store, the write queue and the lobby. Every method is cheap and synchronous except the two that
 * touch the disk (`noteMatch` and `forget` only ENQUEUE; the queue is the only thing that awaits).
 */
export class StateBridge {
  /**
   * @param {{ store?: object | null, persist?: object | null, build?: string | null, rulesHash?: string | null,
   *           ttlMs?: number, resume?: boolean, log?: object, now?: () => number }} [opts]
   */
  constructor({ store = null, persist = null, build = null, rulesHash: hash = null, ttlMs = RESUME_TTL_MS, resume = false, log = noopLog, now = Date.now } = {}) {
    this.store = store;
    this.persist = persist;
    this.build = build;
    this.rulesHash = hash;
    this.ttlMs = ttlMs;
    /** whether a returning player may actually be put back into a persisted match (SP_STATE_RESUME) */
    this.resume = !!resume;
    this.log = log;
    this.now = typeof now === 'function' ? now : Date.now;
    /** @type {Map<string, any>} code → loaded record (bounded by the boot cap) */
    this.records = new Map();
    /** @type {Map<string, { playerId: string, code: string, seat: number }>} sha256(token) → the seat it proves */
    this.claims = new Map();
    this.refused = [];
    /**
     * What the LAST boot scan saw (server/index.js `noteScan`), or null before it ran. `resumedCount: 0` alone cannot
     * say whether the state directory was empty, the scan hit its own budget, or every record was refused — the live
     * box reported 0 twice while the same call marked 151 of 293 records offline, so the boot path has to be
     * measurable. In memory only: a restart replaces it with that boot's own report.
     * @type {any}
     */
    this.scan = null;
    /** @type {NodeJS.Timeout | null} */
    this._sweepTimer = null;
    /**
     * Optional `(code) => boolean`: "this room is live in this process" — a live (even frozen) match is never swept.
     * The caller sets it once its room registry exists.
     * @type {((code: string) => boolean) | null}
     */
    this.isLive = null;
  }

  /** A bridge that persists nothing (SP_STATE=off, or a store this process could not build). */
  static disabled(reason = 'off') { return new DisabledBridge(reason); }

  /** True when records are actually written. */
  get enabled() { return !!(this.store && this.persist && this.store.kind && this.store.kind !== 'off'); }

  /** How many persisted matches are loaded and eligible. */
  get resumedCount() { return this.records.size; }

  /**
   * Persist one match (fire-and-forget, called from a phase transition or a lobby lifecycle hook).
   * A record is written only for a match with at least one human seat that has not ended — a bot-only or finished
   * match has nothing to come back to.
   * @param {any} match @param {{ tokenHashOf?: (playerId: string) => string | null, now?: number }} [opts]
   */
  noteMatch(match, { tokenHashOf = null, now = null } = {}) {
    if (!this.enabled || !match || !match.roomCode) return false;
    try {
      if (match.ended || match.disposed) return false;
      const record = buildRecord(match, {
        build: this.build,
        rulesHash: this.rulesHash,
        now: now ?? this.now(),
        tokenHashOf,
      });
      // only a match with a human seat that has not departed is worth a record (design §8)
      if (!hasHuman(record)) return false;
      const key = matchKey(record.code);
      // a resumed match is already in `records`: keep the loaded copy in step with what we write, so the TTL sweeper
      // never deletes a record that is being refreshed by a live match
      if (this.records.has(record.code)) this.records.set(record.code, record);
      this.persist.enqueue(key, record);
      return true;
    } catch (e) {
      this.log.warn?.(`[state] snapshot ${match && match.roomCode} failed: ${e && e.message ? e.message : e}`);
      return false;
    }
  }

  /**
   * Persist one ROOM that has no match running (P2): the lobby state — the host, every seat, its ready flag and the
   * spectators — so a restart puts the players back into the room they were in instead of a brand-new one.
   *
   * It is written under the SAME key as the match record, and that is the point: a room is described by exactly one
   * document, whichever of the two is current. A live match's record is the richer one, so the lobby must not call
   * this while a match runs (server/lobby.js noteRoom enforces that); when a match ends, its record is replaced by
   * this one, and the queue's one-entry-per-key rule turns that pair into a single write (server/state/persist.js).
   * @param {any} room a server/lobby.js Room
   * @param {{ tokenHashOf?: (playerId: string) => string | null, now?: number }} [opts]
   */
  noteRoom(room, { tokenHashOf = null, now = null } = {}) {
    if (!this.enabled || !room || !room.code || room.disposed) return false;
    try {
      const record = buildRoomRecord(room, {
        build: this.build,
        rulesHash: this.rulesHash,
        now: now ?? this.now(),
        tokenHashOf,
      });
      // a room with no human left in it is not worth a record — the same rule a match follows (design §8)
      if (!hasHuman(record)) return false;
      const key = matchKey(record.code);
      if (this.records.has(record.code)) this.records.set(record.code, record);
      this.persist.enqueue(key, record);
      return true;
    } catch (e) {
      this.log.warn?.(`[state] room snapshot ${room && room.code} failed: ${e && e.message ? e.message : e}`);
      return false;
    }
  }

  /** The match is over / the room is gone: the record must not survive it. */
  forget(code) {
    if (!this.enabled || !code) return false;
    const key = matchKey(code);
    this.records.delete(String(code));
    this._dropClaimsFor(String(code));
    this.persist.remove(key);
    return true;
  }

  /** Remember the records the boot scan found and build the identity index used by `claim`. */
  markResumable(records, { maxRooms = Infinity } = {}) {
    let n = 0;
    for (const record of records || []) {
      if (!record || typeof record.code !== 'string') continue;
      if (this.records.size >= maxRooms) break;
      this.records.set(record.code, record);
      for (const s of record.seats || []) {
        if (!s || s.isBot || s.left || typeof s.tokenHash !== 'string' || !s.tokenHash) continue;
        this.claims.set(s.tokenHash, { playerId: s.playerId, code: record.code, seat: s.seat });
      }
      // a spectator seat is a session too (P2): it has no seat number, so `seat: null` — and a player seat, indexed
      // above, always wins over a spectator entry for the same token
      for (const s of record.spectators || []) {
        if (!s || typeof s.tokenHash !== 'string' || !s.tokenHash || this.claims.has(s.tokenHash)) continue;
        this.claims.set(s.tokenHash, { playerId: s.playerId, code: record.code, seat: null });
      }
      n++;
    }
    return n;
  }

  /** The loaded record of a room code (null when it is not resumable). */
  record(code) {
    return this.records.get(String(code)) || null;
  }

  /**
   * Resolve a presented reconnect token to the identity it proves. ONE-SHOT: the entry is consumed, so a second
   * hello with the same token (a duplicated tab) can never adopt the same seat again — it becomes a fresh session.
   * @param {unknown} token
   * @returns {{ playerId: string, code: string, seat: number } | null}
   */
  claim(token) {
    if (!this.resume || !this.claims.size) return null;
    const hash = tokenHash(typeof token === 'string' ? token : null);
    if (!hash) return null;
    const hit = this.claims.get(hash);
    if (!hit) return null;
    this.claims.delete(hash);
    if (!this.records.has(hit.code)) return null;
    return hit;
  }

  /** The record refused by the version gate (logged once by the caller). */
  noteRefused(refused) { this.refused = Array.isArray(refused) ? refused : []; }

  /**
   * Remember what the boot scan saw. Reported by `/healthz.state.scan`, so a restart's `resumedCount: 0` can be told
   * apart at a glance: an empty directory (`listed: 0`), a scan that ran out of budget (`capped: true`), or records the
   * gate turned away (`reasons`). Never throws — this is a diagnostic, not a control path.
   * @param {any} info
   */
  noteScan(info) {
    if (!info || typeof info !== 'object') { this.scan = null; return; }
    this.scan = { ...info };
  }

  /** Log the version gate's refusals, once, without letting a big state dir flood the log. */
  logRefusals(limit = 5) {
    const counts = new Map();
    for (const r of this.refused) counts.set(r.reason, (counts.get(r.reason) || 0) + 1);
    if (!counts.size) return;
    const parts = [...counts.entries()].map(([reason, n]) => `${reason}×${n}`);
    this.log.warn?.(`[state] ${this.refused.length} persisted match record(s) refused: ${parts.join(', ')}`);
    for (const r of this.refused.slice(0, limit)) this.log.info?.(`[state]   ${r.key}: ${r.reason}`);
  }

  /**
   * Delete the records that can NEVER become resumable again. Only those: `version`, `shape`, `ended`, `no-human`,
   * `key-mismatch`, `expired` are terminal, but `phase`, `build` and `rules` are not.
   *
   *   * `phase` (COMBAT / SP_DRAFT / INFO_CHECK / UNITE / FINAL_ASSAULT) is the ONLY record a mid-combat room has —
   *     `noteRoom` refuses to write while a match runs — so purging it threw away the last trace of a live match AND
   *     the P2 lobby around it (host, seats, spectators): the returning players got a brand-new room.
   *   * `build` / `rules` are undone by rolling the deploy back, and a rolled-back process can use them again.
   *
   * A kept record costs one refused verdict per boot and ages out through its own TTL, which is cheaper than the
   * irreplaceable data it holds. `missing` means there is nothing to delete.
   * @returns {number} keys queued for deletion
   */
  purgeRefused() {
    if (!this.enabled) return 0;
    let n = 0;
    for (const r of this.refused) {
      if (!r || !r.key || r.reason === 'missing') continue;
      if (!PURGEABLE_REFUSALS.has(r.reason)) continue;
      this.persist.remove(r.key);
      n++;
    }
    return n;
  }

  /**
   * Delete the loaded records whose TTL ran out (design §8). Only records this process has LOADED can expire here: a
   * live match refreshes its record every few seconds (`noteMatch`), so its TTL never runs out, and a record that was
   * never loaded is handled by `purgeRefused` at boot.
   *
   * `isLive(code)` (set by the caller once its room registry exists) is the safety net for the one case a heartbeat
   * cannot cover: a FROZEN match writes nothing on purpose, so its record would age out while the match is still
   * being held in memory. A room that still exists is never swept.
   * @returns {Promise<number>}
   */
  async sweepOnce(now = this.now()) {
    if (!this.enabled) return 0;
    let n = 0;
    for (const [code, record] of [...this.records]) {
      if (record.updatedAt > 0 && now - record.updatedAt <= this.ttlMs) continue;
      if (typeof this.isLive === 'function' && this.isLive(code)) continue;
      this.forget(code);
      n++;
    }
    if (n) this.log.info?.(`[state] ${n} persisted match record(s) expired (TTL ${Math.round(this.ttlMs / 1000)}s)`);
    return n;
  }

  /**
   * The TTL sweeper. The lobby has no shared tick of its own (every timer in this server belongs to a match or to
   * net.js's session sweep), so the sweep runs here on a low-frequency, unref'd interval instead of a new tight timer.
   */
  startSweeper({ intervalMs = 60_000 } = {}) {
    if (!this.enabled || this._sweepTimer) return null;
    const t = setInterval(() => { this.sweepOnce().catch(() => {}); }, Math.max(1000, intervalMs));
    t.unref?.();
    this._sweepTimer = t;
    return t;
  }

  stopSweeper() {
    if (this._sweepTimer) { clearInterval(this._sweepTimer); this._sweepTimer = null; }
  }

  _dropClaimsFor(code) {
    for (const [hash, hit] of this.claims) if (hit.code === code) this.claims.delete(hash);
  }

  /** Counters for `/healthz.state` (the queue's own counters included). */
  stats() {
    const q = this.persist && typeof this.persist.stats === 'function'
      ? this.persist.stats()
      : { queued: 0, written: 0, dropped: 0, errors: 0, lastError: null, store: 'off' };
    return {
      queued: q.queued,
      written: q.written,
      dropped: q.dropped,
      errors: q.errors,
      lastError: q.lastError,
      resumedCount: this.records.size,
      resumed: this.resume,
      store: q.store,
      // what the boot scan saw (SP_STATE observability): null until it ran, or on a bridge that never scans
      scan: this.scan,
    };
  }

  /** Stop the sweeper (server shutdown). The write queue is closed by its owner. */
  close() {
    this.stopSweeper();
  }
}

/** The no-op bridge (`SP_STATE=off`, or persistence disabled after a bootstrap failure). Every method is inert. */
export class DisabledBridge {
  constructor(reason = 'off') {
    this.reason = reason;
    this.resume = false;
    this.records = new Map();
    this.refused = [];
    this.store = null;
    this.persist = null;
    this.build = null;
    this.rulesHash = null;
  }
  get enabled() { return false; }
  get resumedCount() { return 0; }
  noteMatch() { return false; }
  noteRoom() { return false; }
  forget() { return false; }
  markResumable() { return 0; }
  record() { return null; }
  claim() { return null; }
  noteRefused() {}
  noteScan() {}
  logRefusals() {}
  purgeRefused() { return 0; }
  async sweepOnce() { return 0; }
  startSweeper() { return null; }
  stopSweeper() {}
  close() {}
  stats() { return { queued: 0, written: 0, dropped: 0, errors: 0, lastError: null, resumedCount: 0, resumed: false, store: this.reason, scan: null }; }
}
