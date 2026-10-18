// test/redis-store.test.js — the optional Redis state store (server/redis.js) on its own.
// The test body is taken verbatim from test/persist-redis.test.js (authored by @xinhai-ai). The real-server
// round-trip cases in that file need a live Redis and the lobby wiring, so this PR keeps the config contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateStore, parseRedisConfig, openStoreFromEnv } from '../server/redis.js';

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

test('parseRedisConfig reads the environment and ignores nonsense', () => {
  assert.equal(parseRedisConfig({}), null);
  assert.equal(parseRedisConfig({ SP_REDIS_URL: '' }), null);
  assert.equal(parseRedisConfig({ SP_REDIS_URL: 'not-a-url' }), null);
  const a = parseRedisConfig({ SP_REDIS_URL: 'redis://redis:6379/0' });
  assert.deepEqual(a, { url: 'redis://redis:6379/0', prefix: 'stronghold:', ttlSec: 90_000 });
  const b = parseRedisConfig({ REDIS_URL: 'rediss://user:pw@host:6380/2', SP_REDIS_PREFIX: 'sp:', SP_REDIS_TTL: '3600' });
  assert.equal(b.url, 'rediss://user:pw@host:6380/2');
  assert.equal(b.prefix, 'sp:');
  assert.equal(b.ttlSec, 3600);
  assert.equal(parseRedisConfig({ SP_REDIS_URL: 'redis://h:1', SP_REDIS_TTL: '5' }).ttlSec, 90_000, 'a short TTL falls back');
  assert.equal(openStoreFromEnv({ env: {} }), null);
  const s = openStoreFromEnv({ env: { SP_REDIS_URL: 'redis://h:1' }, log: quietLog });
  assert.ok(s instanceof StateStore);
  assert.equal(s.key, 'stronghold:state');
  assert.equal(s.label, 'redis://h:1');
});
