// test/state/store.test.js — the KV under the match-state persistence (server/state/store.js).
//
// The two properties the feature stands on: a record round-trips exactly, and a `put` REPLACES a record atomically
// (a crash can leave the old record or the new one, never a half-written file, never a temp file that `list` shows).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createStore, FileStore, MemoryStore, NullStore, RedisStore, parseBackend, isStateKey } from '../../server/state/store.js';

const tmpDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'sp-state-store-'));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test('file store: put/get round-trip, delete, and list(prefix) is sorted and prefix-filtered', async () => {
  const dir = await tmpDir();
  const store = new FileStore({ dir, log: quiet });
  const rec = { version: 1, code: 'ABCD', seats: [{ playerId: 'p_1', isBot: false }], nested: { a: [1, 2, 3] } };
  await store.put('match:ABCD', rec);
  assert.deepEqual(await store.get('match:ABCD'), rec, 'the record round-trips exactly');
  await store.put('match:WXYZ', { code: 'WXYZ' });
  await store.put('other:ABCD', { other: true });
  assert.deepEqual(await store.list(), ['match:ABCD', 'match:WXYZ', 'other:ABCD'], 'every key, sorted');
  assert.deepEqual(await store.list('match:'), ['match:ABCD', 'match:WXYZ'], 'prefix-filtered');
  assert.equal(await store.del('match:ABCD'), true);
  assert.equal(await store.get('match:ABCD'), null, 'a deleted record is gone');
  assert.equal(await store.del('match:ABCD'), true, 'deleting a missing key is not an error');
  assert.deepEqual(await store.list('match:'), ['match:WXYZ']);
  await store.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('file store: put is an atomic replace — no temp file survives and list never shows one', async () => {
  const dir = await tmpDir();
  const store = new FileStore({ dir, log: quiet });
  await store.put('match:ABCD', { n: 1 });
  const first = await fsp.readFile(path.join(dir, 'match%3AABCD.json'), 'utf8');
  assert.match(first, /"n":1/);
  await store.put('match:ABCD', { n: 2 });
  assert.deepEqual(await store.get('match:ABCD'), { n: 2 }, 'the newer record wins');
  const names = await fsp.readdir(dir);
  assert.deepEqual(names, ['match%3AABCD.json'], `exactly one file, no temp leftovers: ${names.join(', ')}`);
  // a temp file left by a killed process is invisible to list() and never read back
  await fsp.writeFile(path.join(dir, '.match%3AABCD.999.1.tmp'), '{ broken');
  assert.deepEqual(await store.list('match:'), ['match:ABCD'], 'the stray temp file is not a record');
  assert.deepEqual(await store.get('match:ABCD'), { n: 2 });
  await fsp.rm(dir, { recursive: true, force: true });
});

test('file store: a corrupt record reads as null and never throws; a missing dir lists empty', async () => {
  const dir = await tmpDir();
  const warnings = [];
  const store = new FileStore({ dir, log: { ...quiet, warn: (m) => warnings.push(String(m)) } });
  assert.deepEqual(await store.list('match:'), [], 'nothing was ever written');
  assert.equal(await store.get('match:NONE'), null);
  await store.put('match:BAD', { ok: true });
  await fsp.writeFile(path.join(dir, 'match%3ABAD.json'), 'not json at all');
  assert.equal(await store.get('match:BAD'), null, 'a corrupt record is skipped, not thrown at boot');
  assert.ok(warnings.some((w) => w.includes('corrupt')), `the corruption was reported: ${warnings.join(' | ')}`);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('store: bad keys are refused (no path escapes) and a non-serializable record throws', async () => {
  const dir = await tmpDir();
  const store = new FileStore({ dir, log: quiet });
  for (const key of ['../escape', 'a/b', '', 'x'.repeat(200), '.hidden']) {
    assert.equal(isStateKey(key), false, `${JSON.stringify(key)} is not a valid key`);
    assert.equal(await store.get(key), null);
    await assert.rejects(() => store.put(key, { a: 1 }), TypeError, `put(${JSON.stringify(key)}) is refused`);
  }
  const circular = {};
  circular.self = circular;
  await assert.rejects(() => store.put('match:OK', circular), TypeError, 'a circular record cannot be written');
  assert.deepEqual(await fsp.readdir(dir).catch(() => []), [], 'the refused writes left nothing behind');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('memory store behaves like the file store (tests) and NullStore swallows every write', async () => {
  const mem = new MemoryStore({ log: quiet });
  await mem.put('match:ABCD', { a: 1 });
  assert.deepEqual(await mem.get('match:ABCD'), { a: 1 });
  assert.deepEqual(await mem.list('match:'), ['match:ABCD']);
  assert.equal(await mem.del('match:ABCD'), true);
  assert.equal(await mem.get('match:ABCD'), null);

  const off = new NullStore();
  await off.put('match:ABCD', { a: 1 });
  assert.equal(off.dropped, 1, 'the write was counted as dropped');
  assert.equal(await off.get('match:ABCD'), null);
  assert.deepEqual(await off.list(), []);
});

test('backend selection: SP_STATE default is file, off/none disable it, an unknown name throws, redis is a stub', () => {
  assert.equal(parseBackend(undefined), 'file');
  assert.equal(parseBackend(''), 'file');
  assert.equal(parseBackend('FILE'), 'file');
  assert.equal(parseBackend('off'), 'off');
  assert.equal(parseBackend('none'), 'off');
  assert.equal(parseBackend('memory'), 'memory');
  assert.throws(() => parseBackend('postgres'), RangeError);
  assert.throws(() => new RedisStore(), /not implemented/, 'redis is a documented stub, not a silent fallback');
  assert.equal(createStore({ backend: 'off' }).kind, 'off');
  assert.equal(createStore({ backend: 'memory' }).kind, 'memory');
  const dir = path.join(os.tmpdir(), 'sp-state-unused');
  const file = createStore({ backend: 'file', dir });
  assert.equal(file.kind, 'file');
  assert.equal(file.dir, path.resolve(dir));
  assert.equal(fs.existsSync(dir), false, 'building a store touches no disk until the first write');
});
