// server/state/persist.js — the single-writer write queue between the game loop and the state store.
//
// The game loop must stay free of I/O (server/match/Match.js never awaits anything), so a transition only calls
// `enqueue(key, record)` and forgets about it. This queue owns the disk:
//
//   * COALESCING, latest wins: at most one pending entry per key. A round that persists every 4 s of a 1 Hz heartbeat
//     therefore costs one write, not one per call, and the record written is always the newest one.
//   * BOUNDED: over `cap` pending entries the OLDEST entry is dropped and counted (`stats().dropped`). A stalled disk
//     can never grow the queue without limit; a dropped record only costs one resume, never the process.
//   * SINGLE WRITER: one drain loop, one write at a time, in insertion order (puts and deletes share the queue, so a
//     match that ends while its last write is still pending ends with the record DELETED, in that order).
//   * NEVER THROWS INTO THE CALLER: `enqueue` catches everything; a failing `store.put` is counted in
//     `stats().errors` / `lastError` and the entry is dropped (no retry storm).
//
// `stats()` backs the tiny `/healthz.state` block (queued/written/dropped/lastError); `idle()` is what tests await to
// make the write deterministic.

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** Pending entries over this are dropped, oldest first (`SP_STATE_MAX_PENDING`). */
export const DEFAULT_MAX_PENDING = 4096;

/** How long `close()` waits for the final drain (a shutdown must not hang on the disk). */
export const DEFAULT_FLUSH_MS = 2000;

export class PersistQueue {
  /**
   * @param {{ store: { put: Function, get?: Function, del: Function, list?: Function },
   *           cap?: number, maxPending?: number, log?: object }} opts
   */
  constructor({ store, cap, maxPending, log = noopLog } = {}) {
    if (!store || typeof store.put !== 'function' || typeof store.del !== 'function') {
      throw new TypeError('PersistQueue: store with put/del required');
    }
    this.store = store;
    this.cap = Math.max(1, Number(maxPending ?? cap ?? DEFAULT_MAX_PENDING) | 0);
    this.log = log;
    /** @type {Map<string, { op: 'put' | 'del', value?: unknown }>} insertion-ordered, one entry per key */
    this.pending = new Map();
    this.written = 0;
    this.deleted = 0;
    this.dropped = 0;
    this.errors = 0;
    /** @type {string | null} */
    this.lastError = null;
    this.closed = false;
    /** @type {Promise<void> | null} the running drain loop */
    this._running = null;
    /** @type {Array<() => void>} waiters of idle() */
    this._idleWaiters = [];
    /** rate limit for the drop warning (a full queue would otherwise log per tick) */
    this._dropWarnAt = -Infinity;
  }

  /** Entries waiting to be written. */
  get size() { return this.pending.size; }

  /**
   * Queue `obj` under `key` (fire-and-forget). The newest value for a key wins; nothing is awaited and nothing throws.
   * @param {string} key @param {unknown} obj
   * @returns {boolean} true when the write was accepted (false: full-queue drop or a closed queue)
   */
  enqueue(key, obj) {
    return this._push(key, { op: 'put', value: obj });
  }

  /**
   * Queue the deletion of `key` (fire-and-forget). Coalesces with a pending put: "enqueue then remove" writes nothing
   * and deletes once, so a match that ends within the same tick never touches the disk at all.
   * @param {string} key
   */
  remove(key) {
    // A delete is queued like a put (it is never refused for naming a key that was never written); it coalesces with a
    // pending put for the same key, so "enqueue then remove" writes nothing and deletes once.
    return this._push(key, { op: 'del' });
  }

  /** @param {string} key @param {{ op: 'put' | 'del', value?: unknown }} entry */
  _push(key, entry) {
    try {
      if (typeof key !== 'string' || !key) return false;
      if (this.closed) { this.dropped++; return false; }
      // Re-inserting moves the key to the END (Map keeps insertion order), so "latest wins" and "drop the oldest"
      // agree: the entry dropped under pressure is the write nobody has needed for the longest.
      this.pending.delete(key);
      this.pending.set(key, entry);
      while (this.pending.size > this.cap) {
        const oldest = this.pending.keys().next();
        if (oldest.done) break;
        this.pending.delete(oldest.value);
        this.dropped++;
        this._warnDrop();
      }
      this._start();
      return true;
    } catch (e) {
      // enqueue may never throw into the game loop
      this.errors++;
      this.lastError = String((e && e.message) || e);
      return false;
    }
  }

  _warnDrop() {
    const now = Date.now();
    if (now - this._dropWarnAt < 10_000) return;
    this._dropWarnAt = now;
    this.log.warn?.(`[state] write queue full (cap ${this.cap}) — dropping oldest pending records (${this.dropped} dropped so far)`);
  }

  _start() {
    if (this._running || this.pending.size === 0) return;
    // The drain starts on a MICROTASK, never synchronously: a burst of enqueues inside one tick (a round boundary, a
    // room disposal) then coalesces into a single write, because the first entry is not taken until the burst is over.
    this._running = Promise.resolve().then(() => this._drain()).catch((e) => {
      // _drain swallows per-entry failures; anything reaching here is a bug in the loop itself
      this.errors++;
      this.lastError = String((e && e.message) || e);
      this.log.error?.('[state] write queue failed', e);
    });
  }

  /** The one writer: drain in insertion order until the queue is empty. */
  async _drain() {
    try {
      for (;;) {
        const first = this.pending.entries().next();
        if (first.done) break;
        const [key, entry] = first.value;
        this.pending.delete(key);
        try {
          if (entry.op === 'del') {
            await this.store.del(key);
            this.deleted++;
          } else {
            await this.store.put(key, entry.value);
            this.written++;
          }
        } catch (e) {
          this.errors++;
          this.lastError = String((e && e.message) || e);
          this.log.warn?.(`[state] ${entry.op} ${key} failed: ${this.lastError}`);
        }
      }
    } finally {
      this._running = null;
      if (this.pending.size > 0) this._start(); // entries queued while the loop was finishing
      else this._settleIdle();
    }
  }

  _settleIdle() {
    if (this.pending.size || this._running) return;
    const waiters = this._idleWaiters;
    this._idleWaiters = [];
    for (const w of waiters) w();
  }

  /** Resolves once nothing is pending (tests, and `close`). Never rejects. */
  idle() {
    if (!this.pending.size && !this._running) return Promise.resolve();
    return new Promise((resolve) => { this._idleWaiters.push(resolve); });
  }

  /** Counters for `/healthz.state` (and for tests). Cheap: no allocation beyond the object. */
  stats() {
    return {
      queued: this.pending.size,
      written: this.written,
      deleted: this.deleted,
      dropped: this.dropped,
      errors: this.errors,
      lastError: this.lastError,
      store: this.store && this.store.kind ? this.store.kind : '?',
    };
  }

  /**
   * Stop accepting writes and flush what is pending, bounded by `flushMs` so a shutdown never hangs on the disk.
   * @param {{ flushMs?: number }} [opts]
   */
  async close({ flushMs = DEFAULT_FLUSH_MS } = {}) {
    this.closed = true;
    if (!this.pending.size && !this._running) {
      await this.store.close?.();
      return;
    }
    let timer = null;
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, flushMs)); });
    if (timer && typeof timer.unref === 'function') timer.unref();
    await Promise.race([this.idle(), timeout]);
    if (timer) clearTimeout(timer);
    if (this.pending.size) this.log.warn?.(`[state] ${this.pending.size} record(s) not flushed before shutdown`);
    try { await this.store.close?.(); } catch (e) { this.log.warn?.(`[state] store close failed: ${e && e.message ? e.message : e}`); }
  }
}
