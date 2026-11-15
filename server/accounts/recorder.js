// server/accounts/recorder.js — the demo recorder: every player action of a match, plus the seed, so the match can be
// re-simulated later (docs/ACCOUNTS.md「Demo」).
//
// What is recorded: each C2S `g.*` message a human sends (the same frames Match.handle receives), with a millisecond
// offset from the first action. What is NOT: server broadcasts, battle progress/result reports (b.progress/b.result —
// they are the client's own sim and already replayable from the seed), and anything that carries no board state.
//
// On match end the document is written once (demos, keyed by matchKey) and one match_records row is written per
// participant whose playerId is linked to an account. A match with no linked participant still stores its demo —
// the row has no owner, so canWatchDemo() lets any participant's account claim it later? No: an unowned demo is
// watchable only by accounts that own one of its records; unlinked matches keep the demo for admin/debug use.

import { randomBytes } from 'node:crypto';
import { putDemo, addMatchRecord, accountOfPlayer } from './store.js';

const MAX_EVENT_BYTES = 2 * 1024 * 1024;

/** Keep only what a replay needs: the C2S type and its payload, minus oversized binary/debug fields. */
function slim(msg) {
  const out = {};
  for (const [k, v] of Object.entries(msg || {})) {
    if (k === 't' || k === 'rid') continue;
    if (typeof v === 'function') continue;
    const s = JSON.stringify(v);
    if (s && s.length > 4096) continue;
    out[k] = v;
  }
  out.t = msg?.t || null;
  return out;
}

/**
 * @param {{ db: any, log?: { warn?: Function, info?: Function }, maxEvents?: number }} deps
 */
export function createDemoRecorder({ db, log = {}, maxEvents = 20_000 }) {
  /** @type {Map<string, { key: string, startedAt: number, seed: any, mode: any, difficulty: any, version: any, players: any[], events: any[], bytes: number, finished: boolean, startedAtIso: string }>} */
  const live = new Map();

  function keyOf(match) {
    return match?.demoKey || match?.matchKey || null;
  }

  function ensure(match) {
    if (!match) return null;
    // every recorded match gets its own key the first time the recorder sees it
    if (!keyOf(match)) match.demoKey = `d_${randomBytes(6).toString('hex')}`;
    const key = keyOf(match);
    if (!key) return null;
    let doc = live.get(key);
    if (!doc) {
      doc = {
        key, startedAt: Date.now(), startedAtIso: new Date().toISOString(),
        seed: Number.isFinite(Number(match?.seed)) ? Number(match.seed) : null,
        mode: match?.mode || null, difficulty: match?.difficulty || null,
        version: match?.version || null,
        players: [], events: [], snapshots: [], bytes: 0, finished: false,
      };
      live.set(key, doc);
    }
    if (!doc.players.length && Array.isArray(match?.order)) {
      doc.players = match.order.map((p) => ({
        playerId: p.playerId, name: p.name, seat: p.seat, isBot: !!p.isBot,
      }));
    }
    return doc;
  }

  return {
    /** A match started: remember its identity even before the first action (participants for the demo roster). */
    start(match) { ensure(match); },

    /** One human action, right before Match.handle runs. */
    record(match, playerId, msg) {
      const doc = ensure(match);
      if (!doc || doc.finished) return;
      if (!msg || typeof msg.t !== 'string' || !msg.t.startsWith('g.')) return;
      if (doc.events.length >= maxEvents) return;
      const slimMsg = slim(msg);
      const size = Buffer.byteLength(JSON.stringify(slimMsg));
      if (doc.bytes + size > MAX_EVENT_BYTES) return;
      doc.bytes += size;
      doc.events.push({ at: Date.now() - doc.startedAt, p: String(playerId || ''), a: slimMsg });
    },

    /**
     * The match ended: persist the demo and one record per linked participant.
     * @param {{ match?: any, matchKey?: string, summary?: any, resultByPlayer?: Record<string, any> }} input
     */
    async finish({ match = null, matchKey = null, summary = null, resultByPlayer = {} } = {}) {
      const key = matchKey || keyOf(match);
      const doc = key ? live.get(key) : null;
      if (!doc || doc.finished) return null;
      doc.finished = true;
      live.delete(key);
      try {
        const demoId = await putDemo(db, {
          matchKey: doc.key, mode: doc.mode, difficulty: doc.difficulty, version: doc.version, seed: doc.seed,
          players: doc.players, events: doc.events, snapshots: doc.snapshots, frames: doc.events.length,
        });
        const counts = { records: 0, demos: 1, demoId };
        for (const p of doc.players) {
          if (p.isBot) continue;
          const account = await accountOfPlayer(db, p.playerId).catch(() => null);
          if (!account) continue;
          await addMatchRecord(db, {
            accountId: account.accountId, playerId: p.playerId, matchKey: doc.key,
            mode: doc.mode, difficulty: doc.difficulty, version: doc.version,
            result: resultByPlayer[p.playerId] || (summary?.result ?? null),
            summary: summary || {}, startedAt: doc.startedAtIso,
          }).catch((e) => { log.warn?.('[accounts] match record failed', e?.message || e); });
          counts.records++;
        }
        log.info?.(`[accounts] demo ${doc.key} stored: ${doc.events.length} events, ${doc.bytes} bytes, ${counts.records} records`);
        return counts;
      } catch (e) {
        log.warn?.('[accounts] demo store failed', e?.message || e);
        return null;
      }
    },

    /** One public board frame (`m.public`) for the visual timeline; events alone carry no board state. */
    frame(match, msg) {
      const doc = ensure(match);
      if (!doc || doc.finished || !msg || msg.t !== 'm.public') return;
      const players = Array.isArray(msg.players) ? msg.players.map((p) => ({
        playerId: p.playerId, seat: p.seat, name: p.name, isBot: !!p.isBot,
        alive: !!p.alive, lp: p.lp, shopLevel: p.shopLevel, boardCount: p.boardCount, ready: !!p.ready,
        status: p.status || null, autoplay: !!p.autoplay,
      })) : [];
      const snap = {
        at: Date.now() - doc.startedAt, phase: msg.phase ?? null, round: msg.round ?? null,
        lastRound: msg.lastRound ?? null, modeId: msg.modeId ?? null, difficulty: msg.difficulty ?? null,
        teamLp: msg.teamLp ?? null, players,
      };
      doc.snapshots.push(snap);
      // keep the document bounded: a 15-minute match at ~1 Hz is ~900 frames; 400 is plenty for a viewer
      if (doc.snapshots.length > 400) doc.snapshots.splice(0, doc.snapshots.length - 400);
    },

    /** Forget a live match that was abandoned (no demo written). */
    drop(matchKey) { live.delete(matchKey); },

    /** Diagnostics for /healthz. */
    stats() { return { live: live.size }; },
  };
}
