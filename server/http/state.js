// server/http/state.js — the match-state persistence wiring of the process (server/state/*, P0/P1/P2): the bridge
// startServer() hands to the lobby and the BOOT SCAN that reads the persisted index back.
//
// Kept out of server/index.js (which stays the assembly + public API of the process) because it is a self-contained
// concern: one bridge per process, one scan after `listen`, one probe for `/healthz.state`.
//
//   * `createStateBridge` builds the store + write queue + StateBridge from `startServer({ state })` / the environment
//     (SP_STATE, SP_STATE_DIR, SP_STATE_MAX_PENDING, SP_STATE_RESUME). A backend failure degrades to a disabled bridge
//     with one error line: persistence is a recovery aid, never a dependency of the live match loop.
//   * `runBootScan` reads every record AFTER `listen` — boot never waits for the disk — paced (≈100 records/s) and
//     hard-capped (`SP_MAX_ROOMS`), and reports exactly what it SAW through `StateBridge.noteScan`, because
//     `resumedCount: 0` alone cannot tell an empty state directory from a scan that ran out of budget or records the
//     version gate turned away.
//   * `stateStats()` is the tiny `/healthz.state` block of the live bridge (a few property reads: /healthz is polled by
//     every open page).

import { createStore } from '../state/store.js';
import { PersistQueue, DEFAULT_MAX_PENDING } from '../state/persist.js';
import { StateBridge, loadResumable, rulesHash, recordTtlMs, engineHash, dirTag } from '../state/resume.js';
import { LOBBY_DEFAULTS } from '../lobby.js';
import { buildTag } from './buildTag.js';

/** A truthy env flag (`1/true/yes/on`). @param {string | undefined} v @param {boolean} [dflt] */
export function envFlag(v, dflt = false) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return dflt;
  return ['1', 'true', 'yes', 'on'].includes(s);
}

/** The live state bridge of the last `startServer` (there is one per process in production); `/healthz` reads it. */
let stateProbe = null;

/** Remember (or forget) the process's bridge. @param {StateBridge | null} bridge */
export function setStateProbe(bridge) { stateProbe = bridge; }

/**
 * Match-state persistence counters for `/healthz.state` (P0/P1): the write queue's depth and totals, the last write
 * error (null while healthy — the field worth alarming on) and how many persisted matches this process has loaded as
 * resumable (`resumedCount`; `resumed` says whether a returning player may actually be put back into one). Never
 * throws: a diagnostic may not take `/healthz` down.
 */
export function stateStats() {
  const idle = { queued: 0, written: 0, dropped: 0, errors: 0, lastError: null, resumedCount: 0, resumed: false, store: 'off', scan: null };
  try {
    return stateProbe ? stateProbe.stats() : idle;
  } catch {
    return { ...idle, store: 'error' };
  }
}

/**
 * Build the persistence bridge of this process. `config === false` disables it outright (tests, `SP_STATE=off`); a
 * backend failure degrades to a disabled bridge with one error line — a broken state directory must never take the
 * server down.
 * @param {{ config?: false | object, log: object }} opts
 * @returns {StateBridge}
 */
export function createStateBridge({ config, log }) {
  if (config === false) return StateBridge.disabled('off');
  const cfg = config && typeof config === 'object' ? config : {};
  // Under the Node test runner (`node --test`) persistence defaults to OFF unless the backend is set explicitly
  // (SP_STATE=... or startServer({ state: {...} })): the existing suites boot real servers on the real state
  // directory, and a test run must not write records into the working tree.
  if (cfg.backend == null && process.env.NODE_TEST_CONTEXT && process.env.SP_STATE == null) {
    return StateBridge.disabled('test');
  }
  try {
    const store = createStore({ backend: cfg.backend, dir: cfg.dir, log });
    const persist = new PersistQueue({
      store,
      maxPending: cfg.maxPending ?? (Number(process.env.SP_STATE_MAX_PENDING) || DEFAULT_MAX_PENDING),
      log,
    });
    const bridge = new StateBridge({
      store,
      persist,
      // the version gate: a record is only resumable by the build + rules that wrote it (server/state/resume.js)
      build: buildTag(),
      rulesHash: rulesHash(),
      ttlMs: recordTtlMs(),
      resume: cfg.resume !== undefined ? !!cfg.resume : envFlag(process.env.SP_STATE_RESUME),
      log,
    });
    bridge.startSweeper();
    return bridge;
  } catch (e) {
    log.error(`[state] persistence disabled (${e && e.message ? e.message : e})`);
    return StateBridge.disabled('error');
  }
}

/**
 * The room cap of the scan: the lobby's own `maxRooms` (the bridge may not hold more records than this process can
 * hold rooms) further capped by `SP_MAX_ROOMS` when that is set.
 * @param {{ maxRooms?: number }} opts @returns {number}
 */
export function scanCap(opts, env = process.env) {
  const rooms = Number.isFinite(opts.maxRooms) ? opts.maxRooms : LOBBY_DEFAULTS.maxRooms;
  const envMax = Number(env.SP_MAX_ROOMS);
  return Math.max(0, Math.min(rooms, Number.isFinite(envMax) && envMax > 0 ? envMax : Infinity));
}

/**
 * Read the persisted index back after `listen`, LAZILY: a record is only marked resumable, nothing is rebuilt until a
 * returning player actually comes back (server/lobby.js `rehydrate`). Each accepted record is marked AS IT IS READ, so
 * a `hello` that arrives while the directory is still being scanned already resolves its token.
 *
 * Fire-and-forget: the scan must never delay serving, and a failure is reported through `noteScan`, not thrown.
 * @param {{ state: StateBridge, opts?: object, log: object, env?: Record<string, string | undefined> }} deps
 * @returns {Promise<any> | null} the scan promise (tests await it), or null when persistence is off
 */
export function runBootScan({ state, opts = {}, log, env = process.env }) {
  if (!state || !state.enabled) return null;
  const cap = scanCap(opts, env);
  const ignoreBuild = envFlag(env.SP_STATE_IGNORE_BUILD);
  // 100/s over a 60 s budget (≈6000 records, past any sane room cap): this runs AFTER `listen`, so it delays only the
  // marks, never the serving — and a smaller budget left records past the cap unresumable, i.e. a restart still
  // interrupted their matches.
  const perSecond = 100;
  const budgetMs = 60_000;
  const t0 = Date.now();
  const gate = {
    build: ignoreBuild ? 'ignored (SP_STATE_IGNORE_BUILD)' : String(state.build),
    // rulesHash covers `data/*.json` + shared/constants.js; the ENGINE is reported too, so a record written by other
    // server code than the one now reading it is at least visible. Report-only on purpose: refusing a record whose
    // engine hash differs would break resume after every code deploy, which is the opposite of this feature's point.
    engine: engineHash().slice(0, 12),
    maxRecords: cap, perSecond, budgetMs, ttlMs: state.ttlMs,
  };
  // "still scanning" and "never ran" must not look the same: until the first record is marked, a returning player is
  // handed a fresh session, so this window is the one that decides whether a reconnect resumes.
  state.noteScan({ at: new Date(t0).toISOString(), scanning: true, gate });
  return loadResumable(state.store, {
    // SP_STATE_IGNORE_BUILD=1 drops the BUILD half of the version gate for this scan only: an operator restarting the
    // service mid-match must not interrupt a room, even when the deploy changed the build tag (the records still carry
    // the real tag — only the comparison is skipped). The rulesHash half STAYS: a record is never replayed against
    // rules (data/*.json, shared/constants.js) it never saw.
    build: ignoreBuild ? null : state.build,
    rulesHash: state.rulesHash, ttlMs: state.ttlMs, maxRecords: cap,
    perSecond, budgetMs, log,
    onRecord: (record) => state.markResumable([record], { maxRooms: cap }),
  }).then(({ records, refused, scanned, capped, listed, listError, readErrors }) => {
    state.noteRefused(refused);
    const marked = records.length; // the marks themselves already happened through `onRecord`
    state.logRefusals();
    const purged = state.purgeRefused(); // terminal refusals only: `phase`/`build`/`rules` records stay (state/resume.js)
    // What the scan SAW, not just what survived it: `resumedCount: 0` means "this process marked nothing", which is an
    // empty directory, a scan that ran out of budget, records the gate turned away, or an unreadable directory.
    state.noteScan({
      at: new Date(t0).toISOString(),
      durationMs: Date.now() - t0,
      scanning: false,
      dirTag: dirTag(state.store && state.store.dir), // NEVER the raw path: /healthz is public and every client polls it
      listed,
      scanned,
      capped,
      marked,
      loaded: state.records.size,
      refused: refused.length,
      reasons: refused.reduce((m, r) => { const k = (r && r.reason) || 'unknown'; m[k] = (m[k] || 0) + 1; return m; }, {}),
      samples: refused.slice(0, 3),
      purged,
      // the two fields that tell an unreadable state directory apart from an empty one (a store answers "empty" for both)
      listError: listError || null,
      readErrors,
      gate,
    });
    if (state.resumedCount) {
      log.info(`[state] ${state.resumedCount} persisted match(es) resumable `
        + `(${state.resume ? 'resume enabled' : 'resume disabled'}${refused.length ? `, ${refused.length} refused` : ''})`);
    }
    return state.scan;
  }).catch((e) => {
    state.noteScan({ at: new Date(t0).toISOString(), durationMs: Date.now() - t0, scanning: false, error: String((e && e.message) || e) });
    log.error('[state] resume scan failed', e);
    return null;
  });
}
