// The server's own simulation pool for room work: bot prep rehearsals, takeovers and result re-checks.
//
// The WebSocket and the Match object remain on the main thread in this first phase; what moves is CPU-bound simulation.
// Two topologies are supported and the caller picks one:
//   * `lanes = 0` (the default, and the upstream v0.3.3 shape): ONE bounded pool every room submits into. A pool per
//     room would multiply the thread count and overfill the process, which is exactly what the pool exists to prevent.
//     Overload is refused (POOL_FULL) instead of starting another thread — the caller then runs the same candidates on
//     the main thread, so a busy pool costs latency, never correctness.
//   * `lanes = 1..32` (branch phase one, enabled by SP_ROOM_WORKERS / startServer({ roomWorkers })): each room or
//     standalone match key is pinned to one lane with its own pool, so a room's battle/rehearsal work does not contend
//     in one global queue. `totalWorkers` stays the budget for ALL lanes together — a lane never receives the full
//     default thread count of its own.
import { SimulationPool, workerSettings } from './pool.js';

export class RoomWorkerPool {
  constructor({ data, lanes = 0, totalWorkers = 1, maxQueue = 256, timeoutMs = 120000, workerUrl } = {}) {
    if (!Number.isInteger(lanes) || lanes < 0 || lanes > 32) throw new RangeError('room worker lanes must be 0..32');
    if (!Number.isInteger(totalWorkers) || totalWorkers < 1 || totalWorkers > 32) {
      throw new RangeError('room worker total must be 1..32');
    }
    if (lanes > 0 && totalWorkers < lanes) {
      throw new RangeError('room worker total must be between lanes and 32');
    }
    this.lanes = lanes > 0 ? Array.from({ length: lanes }, (_, i) => ({
      id: i,
      rooms: new Set(),
      pool: new SimulationPool({
        data,
        size: Math.max(1, Math.ceil((totalWorkers - i) / lanes)),
        maxQueue,
        timeoutMs,
        ...(workerUrl ? { workerUrl } : {}),
      }),
    })) : null;
    this.pool = this.lanes ? null
      : new SimulationPool({ data, size: totalWorkers, maxQueue, timeoutMs, ...(workerUrl ? { workerUrl } : {}) });
    /** Lane assignments in lane mode: room/match key -> lane id. */
    this.assignments = new Map();
    /** The rooms (or standalone match keys) currently holding work here — bookkeeping for stats(), never a scheduling hint. */
    this.rooms = new Set();
    this.closed = false;
  }

  /**
   * Note that a room is using this pool and return the pool its work belongs in. In lane mode a key is pinned to the
   * least-loaded lane (and keeps resolving to that same lane); otherwise every room gets the one shared pool, because
   * that pool schedules tasks by priority and arrival, not by room.
   */
  assign(key) {
    const id = String(key || '');
    if (!this.lanes) {
      this.rooms.add(id);
      return this.pool;
    }
    const existing = this.assignments.get(id);
    if (existing != null) return this.lanes[existing].pool;
    const lane = this.lanes.reduce((best, current) => current.rooms.size < best.rooms.size ? current : best, this.lanes[0]);
    lane.rooms.add(id);
    this.assignments.set(id, lane.id);
    return lane.pool;
  }

  /** Submit through the same object startServer passes to Match. */
  submit(type, payload, options) { return (this.pool || this.lanes[0].pool).submit(type, payload, options); }

  /** Whether a room's tasks are being told apart here: the single pool itself does not. */
  has(key) {
    const id = String(key || '');
    return this.lanes ? this.assignments.has(id) : this.rooms.has(id);
  }

  release(key) {
    const id = String(key || '');
    if (!this.lanes) {
      this.rooms.delete(id);
      return;
    }
    const laneId = this.assignments.get(id);
    if (laneId == null) return;
    this.assignments.delete(id);
    this.lanes[laneId]?.rooms.delete(id);
  }

  stats() {
    if (!this.lanes) return { kind: 'room-pool', ...this.pool.stats(), rooms: this.rooms.size };
    const lanes = this.lanes.map((lane) => ({ id: lane.id, rooms: lane.rooms.size, ...lane.pool.stats() }));
    const sum = (field) => lanes.reduce((n, item) => n + (Number(item[field]) || 0), 0);
    return {
      kind: 'room-lanes',
      size: sum('size'), threads: sum('threads'), busy: sum('busy'), queued: sum('queued'),
      maxQueue: sum('maxQueue'), timeoutMs: Math.max(...lanes.map((s) => s.timeoutMs)),
      submitted: sum('submitted'), completed: sum('completed'), failed: sum('failed'),
      cancelled: sum('cancelled'), rejected: sum('rejected'), queueMs: sum('queueMs'), computeMs: sum('computeMs'),
      avgComputeMs: sum('completed') ? sum('computeMs') / sum('completed') : 0,
      lanes,
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.lanes) await Promise.all(this.lanes.map((lane) => lane.pool.close()));
    else await this.pool.close();
  }
}

/**
 * The pool a server should run with, or null when the workers are switched off: the callers then keep doing the work on
 * the main thread, exactly as before the pool existed. A null result comes from an explicit SP_WORKERS=0; an unset or
 * junk SP_WORKERS keeps the branch default (workerSettings / defaultWorkerCount).
 * @param {{ data?: object, env?: NodeJS.ProcessEnv, workerUrl?: URL, lanes?: number }} [opts]
 * @returns {RoomWorkerPool | null}
 */
export function createRoomWorkerPool({ data, env = process.env, workerUrl, lanes = 0 } = {}) {
  const { size, maxQueue, timeoutMs } = workerSettings(env);
  if (size === 0) return null;
  return new RoomWorkerPool({ data, lanes, totalWorkers: size, maxQueue, timeoutMs, workerUrl });
}
