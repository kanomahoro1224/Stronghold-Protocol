// test/state/resume.test.js — the version gate, the TTL and the boot scan (server/state/resume.js).
//
// The load-bearing rule of the whole feature: a record is resumed ONLY by the build + rules that wrote it. An old
// match replayed against changed rules is worse than no resume at all, so every mismatch must come back refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../../server/state/store.js';
import { PersistQueue } from '../../server/state/persist.js';
import {
  checkRecord, loadResumable, matchKey, recordTtlMs, rulesHash, resetRulesHash, recordSeats,
  RESUME_TTL_MS, StateBridge, KEY_PREFIX, dirTag, engineHash,
} from '../../server/state/resume.js';
import { RECORD_VERSION, tokenHash } from '../../server/state/snapshot.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const NOW = 1_800_000_000_000;

/** A minimal eligible record. */
const record = (over = {}) => ({
  version: RECORD_VERSION,
  code: 'ABCD',
  matchNo: 1,
  mode: 'coop',
  difficulty: 'NORMAL',
  modeId: 'mode_multi_normal',
  seed: 12345,
  round: 5,
  phase: 'PREP',
  seats: [{ seat: 0, playerId: 'p_1', name: 'A', isBot: false, connected: false, left: false, tokenHash: 'h1' }],
  players: [{ playerId: 'p_1', lp: 7, layers: {} }],
  build: 'build-a',
  rulesHash: 'rules-a',
  updatedAt: NOW - 1000,
  ...over,
});

// ---------------------------------------------------------------------------------------------------
// version gate + TTL
// ---------------------------------------------------------------------------------------------------

test('gate: a matching build and rulesHash resume; a changed rulesHash or build is REFUSED', () => {
  const opts = { now: NOW, ttlMs: RESUME_TTL_MS, build: 'build-a', rulesHash: 'rules-a' };
  assert.deepEqual(checkRecord(record(), opts), { ok: true });
  assert.deepEqual(checkRecord(record({ rulesHash: 'rules-b' }), opts), { ok: false, reason: 'rules' },
    'data/*.json changed under the record: never replay it');
  assert.deepEqual(checkRecord(record({ build: 'build-b' }), opts), { ok: false, reason: 'build' });
  // an old record without a hash (or a process without one) is not a refusal on its own
  assert.deepEqual(checkRecord(record({ rulesHash: null }), opts), { ok: true });
  assert.deepEqual(checkRecord(record(), { now: NOW }), { ok: true });
});

test('gate: version, shape, ended, no-human and expiry are each refused with their own reason', () => {
  const opts = { now: NOW, ttlMs: RESUME_TTL_MS, build: 'build-a', rulesHash: 'rules-a' };
  assert.deepEqual(checkRecord(null, opts), { ok: false, reason: 'missing' });
  assert.deepEqual(checkRecord(record({ version: RECORD_VERSION - 1 }), opts), { ok: false, reason: 'version' },
    'the PREVIOUS record shape (v1) is refused, never read as the current one');
  assert.deepEqual(checkRecord(record({ code: '' }), opts), { ok: false, reason: 'shape' });
  assert.deepEqual(checkRecord(record({ seats: [] }), opts), { ok: false, reason: 'shape' });
  assert.deepEqual(checkRecord(record({ ended: true }), opts), { ok: false, reason: 'ended' });
  assert.deepEqual(checkRecord(record({ seats: [{ seat: 0, playerId: 'ai_1', isBot: true }] }), opts), { ok: false, reason: 'no-human' },
    'a bot-only match is never resumable');
  assert.deepEqual(checkRecord(record({ seats: [{ seat: 0, playerId: 'p_1', isBot: false, left: true }] }), opts), { ok: false, reason: 'no-human' },
    'nor is one whose humans all departed');
});

test('TTL: a record older than the window expires, one inside it does not', () => {
  const opts = { ttlMs: RESUME_TTL_MS, build: 'build-a', rulesHash: 'rules-a' };
  assert.deepEqual(checkRecord(record({ updatedAt: NOW - RESUME_TTL_MS + 1 }), { ...opts, now: NOW }), { ok: true });
  assert.deepEqual(checkRecord(record({ updatedAt: NOW - RESUME_TTL_MS - 1 }), { ...opts, now: NOW }), { ok: false, reason: 'expired' });
  assert.deepEqual(checkRecord(record({ updatedAt: 0 }), { ...opts, now: NOW }), { ok: false, reason: 'expired' },
    'a record with no timestamp cannot be trusted');
  assert.equal(RESUME_TTL_MS, 20 * 60 * 1000, 'the default window is 20 minutes');
  assert.equal(recordTtlMs({ env: {} }), RESUME_TTL_MS);
  assert.equal(recordTtlMs({ env: { SP_SOLO_RECONNECT_MS: '900000' } }), RESUME_TTL_MS,
    '900000 ms (15 min) is SHORTER than the default and must not lower it');
  assert.equal(recordTtlMs({ env: { SP_SOLO_RECONNECT_MS: '3600000' } }), 3_600_000,
    'a longer solo reconnect window raises the TTL with it');
  assert.equal(recordTtlMs({ ttlMs: 5000, env: { SP_SOLO_RECONNECT_MS: '3600000' } }), 5000, 'an explicit ttl wins');
});

test('rulesHash is a stable sha256 over the rule data + shared/constants.js, cached per process', () => {
  resetRulesHash();
  const a = rulesHash();
  assert.match(a, /^[0-9a-f]{64}$/, 'a full sha256 digest');
  assert.equal(rulesHash(), a, 'the cached value is reused');
  resetRulesHash();
  assert.equal(rulesHash(), a, 'and recomputing it from unchanged files gives the same hash');
  resetRulesHash();
  const other = rulesHash({ root: process.cwd(), extraFiles: [] });
  assert.match(other, /^[0-9a-f]{64}$/);
  resetRulesHash();
});

test('rulesHash: the asset and text manifests are NOT rules — a deploy that only re-fetches art keeps every record', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rules-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  const write = (rel, text) => fs.writeFileSync(path.join(root, rel), text);
  write('shared/constants.js', 'export const X = 1;\n');
  for (const name of ['chess.json', 'stages.json', 'assets.json', 'local-assets.json', 'emotes.json', 'notice.json']) {
    write(`data/${name}`, '{"v":"1"}\n');
  }
  const hash = () => { resetRulesHash(); return rulesHash({ root, dataDir: data }); };
  const base = hash();
  // Manifests that describe ART / TEXT, not rules: a deploy rewrites them (and local-assets.json even differs per
  // machine), so none of them may invalidate a match that is sitting in a resumable phase.
  for (const name of ['assets.json', 'local-assets.json', 'emotes.json', 'notice.json']) {
    write(`data/${name}`, '{"v":"2"}\n');
    assert.equal(hash(), base, `${name} is an asset/text manifest: it must not invalidate a resumable match`);
    write(`data/${name}`, '{"v":"1"}\n');
  }
  // The rules themselves still gate: an old match must never be replayed against changed rules.
  for (const name of ['chess.json', 'stages.json']) {
    write(`data/${name}`, '{"v":"2"}\n');
    assert.notEqual(hash(), base, `${name} carries rules: changing it must invalidate the record`);
    write(`data/${name}`, '{"v":"1"}\n');
  }
  write('shared/constants.js', 'export const X = 2;\n');
  assert.notEqual(hash(), base, 'shared/constants.js carries rules');
  write('shared/constants.js', 'export const X = 1;\n');
  assert.equal(hash(), base, 'and putting the rules back restores the hash (content, not mtime)');
  fs.rmSync(root, { recursive: true, force: true });
  resetRulesHash();
});

// ---------------------------------------------------------------------------------------------------
// boot scan
// ---------------------------------------------------------------------------------------------------

test('gate: a ROOM record survives a deploy — it has no engine state to replay against other rules', () => {
  const opts = { now: NOW, ttlMs: RESUME_TTL_MS, build: 'build-b', rulesHash: 'rules-b' };
  const room = { ...record({ build: 'build-a', rulesHash: 'rules-a' }), inMatch: false, state: null, phase: 'LOBBY' };
  assert.deepEqual(checkRecord(room, opts), { ok: true },
    'a room has no round to re-enter and no seat payload: a build/rules change must not delete it and evict everyone');
  // the MATCH record next to it is still refused: its engine state WOULD be replayed against inputs it never saw
  assert.deepEqual(checkRecord(record({ build: 'build-a' }), opts), { ok: false, reason: 'build' });
  assert.deepEqual(checkRecord(record({ build: 'build-b' }), opts), { ok: false, reason: 'rules' });
  // and a room record is still refused for the reasons that are about the ROOM itself
  assert.deepEqual(checkRecord({ ...room, updatedAt: NOW - RESUME_TTL_MS - 1 }, opts), { ok: false, reason: 'expired' });
  assert.deepEqual(checkRecord({ ...room, seats: [{ seat: 0, playerId: 'ai_1', isBot: true }] }, opts), { ok: false, reason: 'no-human' });
});

test('loadResumable: reads the index, keeps the eligible records and reports every refusal by reason', async () => {
  const store = new MemoryStore({ log: quiet });
  const good = record({ code: 'GOOD' });
  await store.put(matchKey('GOOD'), good);
  await store.put(matchKey('OLD'), record({ code: 'OLD', updatedAt: NOW - RESUME_TTL_MS - 5000 }));
  await store.put(matchKey('RULES'), record({ code: 'RULES', rulesHash: 'rules-b' }));
  await store.put(matchKey('KEY'), record({ code: 'OTHER' })); // key and record disagree
  await store.put('other:NOPE', { anything: true });
  const out = await loadResumable(store, {
    now: NOW, ttlMs: RESUME_TTL_MS, build: 'build-a', rulesHash: 'rules-a', perSecond: 0, log: quiet,
  });
  assert.deepEqual(out.records.map((r) => r.code), ['GOOD'], 'only the eligible record is handed back');
  assert.equal(out.scanned, 4, 'the `other:` key was never scanned');
  assert.deepEqual(out.refused.map((r) => r.reason).sort(), ['expired', 'key-mismatch', 'rules']);
  assert.equal(out.capped, false);
  assert.equal(KEY_PREFIX, 'match:');
});

test('dirTag: the scan report identifies the state directory without publishing its path', () => {
  assert.equal(dirTag(null), null);
  const a = dirTag('/opt/Stronghold-Protocol/state/matches');
  const b = dirTag('/srv/other/matches');
  assert.match(a, /^matches#[0-9a-f]{8}$/, 'the last path segment + a short hash');
  assert.ok(!a.includes('opt') && !a.includes('Stronghold'), 'no part of the deploy path leaks onto the public /healthz');
  assert.equal(dirTag('/opt/Stronghold-Protocol/state/matches'), a, 'deterministic');
  assert.notEqual(a, b, 'two directories with the same basename stay distinguishable');
});

test('engineHash: a hash of the server code — stable, cached, and sensitive to one changed file', () => {
  resetRulesHash();
  const h1 = engineHash();
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(engineHash(), h1, 'cached per process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-engine-'));
  try {
    fs.mkdirSync(path.join(tmp, 'server', 'match'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'server', 'a.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(tmp, 'server', 'match', 'b.js'), 'export const b = 2;\n');
    const x = engineHash({ root: tmp });
    assert.match(x, /^[0-9a-f]{64}$/);
    assert.notEqual(x, h1, 'a different tree hashes differently');
    fs.writeFileSync(path.join(tmp, 'server', 'match', 'b.js'), 'export const b = 3;\n');
    assert.notEqual(engineHash({ root: tmp }), x, 'one changed byte changes the hash');
    assert.equal(engineHash(), h1, 'and the default root keeps its own cached value');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumable: the scan is hard-capped (maxRecords / budgetMs) so a full state dir cannot stall boot', async () => {
  const store = new MemoryStore({ log: quiet });
  for (let i = 0; i < 10; i++) await store.put(matchKey(`R${i}`), record({ code: `R${i}` }));
  const capped = await loadResumable(store, { now: NOW, maxRecords: 3, perSecond: 0, log: quiet });
  assert.equal(capped.scanned, 3);
  assert.equal(capped.records.length, 3);
  assert.equal(capped.capped, true, 'it said so instead of silently truncating');
  const timed = await loadResumable(store, { now: NOW, maxRecords: 100, budgetMs: -1, perSecond: 0, log: quiet });
  assert.equal(timed.capped, true, 'a spent budget caps the scan');
  assert.equal(timed.scanned, 0, 'the budget is consulted before a read, so a spent one reads nothing');
  const partial = await loadResumable(store, { now: NOW, maxRecords: 100, budgetMs: 0, perSecond: 0, log: quiet });
  assert.ok(partial.scanned >= 1, 'a zero budget still reads while the clock says there is time');
});

test('loadResumable: a missing/unreadable store is not an error (boot continues)', async () => {
  const out = await loadResumable(null, { log: quiet });
  assert.deepEqual(out, { records: [], refused: [], scanned: 0, capped: false, listed: 0, listError: null, readErrors: 0 });
  const broken = { list: async () => { throw new Error('io'); }, get: async () => null };
  const out2 = await loadResumable(broken, { log: quiet });
  assert.deepEqual(out2.records, []);
  assert.equal(out2.listError, 'io', 'a FAILED directory scan is reported as such, not as an empty directory');
  // FileStore swallows a non-ENOENT readdir/read failure on purpose (one corrupt record must not take the boot down):
  // the counters it keeps are what the scan report re-exports, so "empty" and "unreadable" stop looking identical.
  const swallowed = { list: async () => [], get: async () => null, listError: 'EACCES: permission denied', readErrors: 2 };
  const out3 = await loadResumable(swallowed, { log: quiet });
  assert.equal(out3.listError, 'EACCES: permission denied');
  assert.equal(out3.readErrors, 2);
  assert.equal(out3.listed, 0);
});

test('loadResumable: onRecord marks each accepted record AS IT IS READ (a hello mid-scan resolves its token)', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const store = {
    list: async () => [matchKey('A'), matchKey('B')],
    get: async (key) => {
      if (key === matchKey('B')) await held; // the second read is still in flight while the first is already usable
      return record({ code: key === matchKey('A') ? 'A' : 'B' });
    },
  };
  const seen = [];
  const done = loadResumable(store, { now: NOW, perSecond: 0, log: quiet, onRecord: (r) => seen.push(r.code) });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ['A'], 'A is marked while B is still being read — batching until the end is what left early hellos identity-less');
  release();
  const out = await done;
  assert.deepEqual(seen, ['A', 'B']);
  assert.deepEqual(out.records.map((r) => r.code), ['A', 'B']);
  assert.equal(out.listed, 2, 'the report counts the keys the store actually listed');
  // a hook that throws may never stop the boot
  const out2 = await loadResumable(store, { now: NOW, perSecond: 0, log: quiet, onRecord: () => { throw new Error('hook'); } });
  assert.deepEqual(out2.records.map((r) => r.code), ['A', 'B']);
});

// ---------------------------------------------------------------------------------------------------
// StateBridge
// ---------------------------------------------------------------------------------------------------

test('StateBridge: an ineligible record is never marked resumable; purgeRefused deletes only TERMINAL refusals', async () => {
  const store = new MemoryStore({ log: quiet });
  const persist = new PersistQueue({ store, log: quiet });
  const bridge = new StateBridge({ store, persist, build: 'build-a', rulesHash: 'rules-a', ttlMs: RESUME_TTL_MS, resume: true, log: quiet });
  await store.put(matchKey('GOOD'), record({ code: 'GOOD' }));
  await store.put(matchKey('BAD'), record({ code: 'BAD', rulesHash: 'rules-b' }));
  await store.put(matchKey('DEAD'), record({ code: 'DEAD', ended: true }));
  const out = await loadResumable(store, { now: NOW, build: 'build-a', rulesHash: 'rules-a', perSecond: 0, log: quiet });
  bridge.noteRefused(out.refused);
  bridge.markResumable(out.records);
  assert.equal(bridge.resumedCount, 1);
  bridge.purgeRefused();
  await persist.idle();
  // A rules mismatch is only unusable for THIS process: rolling the deploy back makes it resumable again, and a
  // mid-combat record is the newest truth of a live match (the only one such a room has). Deleting those is what lost
  // a mid-combat room and the P2 lobby around it, so they are kept and left to their own TTL.
  assert.ok(await store.get(matchKey('BAD')), 'a rules mismatch is KEPT (a rollback makes it resumable again)');
  assert.equal(await store.get(matchKey('DEAD')), null, 'an ended match never comes back: its record is deleted');
  assert.ok(await store.get(matchKey('GOOD')), 'the eligible one is left alone');
  assert.deepEqual(bridge.stats().resumedCount, 1);
  assert.equal(bridge.stats().store, 'memory');
});

test('StateBridge: the sweeper deletes a record whose TTL ran out, and keeps a refreshed one', async () => {
  const store = new MemoryStore({ log: quiet });
  const persist = new PersistQueue({ store, log: quiet });
  const bridge = new StateBridge({ store, persist, ttlMs: 1000, resume: true, log: quiet, now: () => NOW });
  bridge.markResumable([record({ code: 'COLD', updatedAt: NOW - 5000 }), record({ code: 'WARM', updatedAt: NOW - 10 })]);
  assert.equal(bridge.resumedCount, 2);
  const n = await bridge.sweepOnce(NOW);
  assert.equal(n, 1, 'exactly the expired record was swept');
  await persist.idle();
  assert.equal(bridge.record('COLD'), null);
  assert.ok(bridge.record('WARM'), 'the fresh record is still resumable');
  assert.equal(await store.get(matchKey('COLD')), null, 'and its file is gone');
});

test('StateBridge: the sweeper skips a room this process still holds (a frozen match writes nothing)', async () => {
  const store = new MemoryStore({ log: quiet });
  const persist = new PersistQueue({ store, log: quiet });
  const bridge = new StateBridge({ store, persist, ttlMs: 1000, resume: true, log: quiet, now: () => NOW });
  bridge.markResumable([record({ code: 'FROZEN', updatedAt: NOW - 60_000 }), record({ code: 'GONE', updatedAt: NOW - 60_000 })]);
  bridge.isLive = (code) => code === 'FROZEN'; // the lobby's room registry
  assert.equal(await bridge.sweepOnce(NOW), 1, 'only the room that no longer exists was swept');
  await persist.idle();
  assert.ok(bridge.record('FROZEN'), 'the live room keeps its record');
  assert.equal(bridge.record('GONE'), null);
});

test('StateBridge: a live match refreshes its loaded record, so the TTL sweeper never deletes it', async () => {
  const store = new MemoryStore({ log: quiet });
  const persist = new PersistQueue({ store, log: quiet });
  const bridge = new StateBridge({ store, persist, ttlMs: 1000, resume: true, log: quiet, now: () => NOW });
  bridge.markResumable([record({ code: 'ABCD', updatedAt: NOW - 5000 })]);
  // the resumed match writes its next heartbeat: the in-memory copy must move with it
  const ps = {
    playerId: 'p_1', seat: 0, name: 'A', isBot: false, connected: true, left: false, alive: true, lp: 9,
    layers: {}, counters: {}, round: {}, stats: {}, bondCountBonus: {}, loadout: {}, shop: { level: 3 },
  };
  const match = {
    roomCode: 'ABCD', mode: 'coop', difficulty: 'NORMAL', modeId: 'mode_multi_normal', seed: 1, round: 6, phase: 'PREP',
    deadline: 0, paused: false, ended: false, startedAt: NOW, order: [ps], opts: {},
  };
  assert.equal(bridge.noteMatch(match, { now: NOW }), true);
  await persist.idle();
  assert.equal((await store.get(matchKey('ABCD'))).updatedAt, NOW, 'the heartbeat rewrote the record');
  assert.equal(await bridge.sweepOnce(NOW), 0, 'nothing was swept');
  assert.ok(await store.get(matchKey('ABCD')));
});

test('StateBridge: claim() resolves a token hash to its seat exactly once', async () => {
  const store = new MemoryStore({ log: quiet });
  const persist = new PersistQueue({ store, log: quiet });
  const token = 'a'.repeat(32);
  const hash = tokenHash(token);
  const rec = record({
    code: 'ABCD',
    seats: [
      { seat: 0, playerId: 'p_1', name: 'A', isBot: false, connected: false, left: false, tokenHash: hash },
      { seat: 1, playerId: 'ai_1', name: 'AI', isBot: true, connected: true, left: false, tokenHash: null },
    ],
  });
  const bridge = new StateBridge({ store, persist, resume: true, log: quiet });
  bridge.markResumable([rec]);
  assert.deepEqual(bridge.claim(token), { playerId: 'p_1', code: 'ABCD', seat: 0 });
  assert.equal(bridge.claim(token), null, 'the identity is one-shot: a duplicated tab cannot adopt the seat again');
  assert.equal(bridge.claim('b'.repeat(32)), null, 'an unknown token proves nothing');
  assert.equal(bridge.claim(null), null);

  // resume disabled: the record is known, the identity is not handed out
  const off = new StateBridge({ store, persist, resume: false, log: quiet });
  off.markResumable([rec]);
  assert.equal(off.claim(token), null);
  assert.equal(off.resumedCount, 1, 'the record is still marked (the counters are honest either way)');

  // forgetting a room drops its claims with it
  const again = new StateBridge({ store, persist, resume: true, log: quiet });
  again.markResumable([rec]);
  again.forget('ABCD');
  assert.equal(again.claim(token), null);
  assert.equal(again.record('ABCD'), null);
});

test('StateBridge: forget() deletes the record, and noteMatch refuses bot-only / ended matches', async () => {
  const store = new MemoryStore({ log: quiet });
  const persist = new PersistQueue({ store, log: quiet });
  const bridge = new StateBridge({ store, persist, build: 'b', rulesHash: 'r', resume: true, log: quiet });
  const seats = [{ seat: 0, playerId: 'p_1', name: 'A', isBot: false }, { seat: 1, playerId: 'ai_1', name: 'AI', isBot: true }];
  const base = {
    roomCode: 'ABCD', mode: 'coop', difficulty: 'NORMAL', modeId: 'mode_multi_normal', seed: 7, round: 3, phase: 'PREP',
    deadline: 0, paused: false, ended: false, startedAt: NOW, opts: {},
    order: [{ playerId: 'p_1', seat: 0, name: 'A', isBot: false, connected: true, left: false, lp: 5, layers: {}, counters: {}, round: {}, stats: {}, bondCountBonus: {}, loadout: {}, shop: { level: 2 } }],
    seats,
  };
  assert.equal(bridge.noteMatch(base, { now: NOW }), true);
  await persist.idle();
  const saved = await store.get(matchKey('ABCD'));
  assert.equal(saved.round, 3);
  assert.equal(saved.seats.length, 1, 'seats come from the live match order');
  assert.equal(saved.build, 'b');
  assert.equal(bridge.noteMatch({ ...base, ended: true }, { now: NOW }), false, 'an ended match is never persisted');
  assert.equal(bridge.noteMatch({ ...base, order: [] }, { now: NOW }), false, 'nor is a bot-only one');
  bridge.forget('ABCD');
  await persist.idle();
  assert.equal(await store.get(matchKey('ABCD')), null);

  const disabled = StateBridge.disabled('off');
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.noteMatch(base), false);
  assert.equal(disabled.claim('x'), null);
  assert.equal(disabled.forget('ABCD'), false);
  assert.deepEqual(disabled.stats().resumedCount, 0);
});

test('recordSeats carries the recorded human seats (and their loadout) for the Match constructor', () => {
  const rec = record({
    players: [{ playerId: 'p_1', loadout: { c1: { skill: 2, module: null } } }],
    seats: [
      { seat: 0, playerId: 'p_1', name: 'A', isBot: false, connected: true, left: false },
      { seat: 2, playerId: 'ai_1', name: 'AI', isBot: true, connected: true, left: false },
    ],
  });
  assert.deepEqual(recordSeats(rec), [
    { seat: 0, playerId: 'p_1', name: 'A', isBot: false, connected: false, loadout: { c1: { skill: 2, module: null } } },
    { seat: 2, playerId: 'ai_1', name: 'AI', isBot: true, connected: false, loadout: null },
  ]);
});
