// test/shutdown-timeout.test.js — the final save gets a configurable window instead of a hard 5 s.
//
// server/http/boot.js used to exit 0 five seconds after SIGINT/SIGTERM no matter what: a persistence worker still
// flushing the last document was cut off silently. The window is now SP_SHUTDOWN_TIMEOUT_MS (default 60 s), and a
// value outside a sane range falls back to the default rather than disabling the guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shutdownTimeoutMs } from '../server/http/boot.js';

test('the shutdown window defaults to 60 s and reads SP_SHUTDOWN_TIMEOUT_MS', () => {
  const saved = process.env.SP_SHUTDOWN_TIMEOUT_MS;
  try {
    delete process.env.SP_SHUTDOWN_TIMEOUT_MS;
    assert.equal(shutdownTimeoutMs(), 60_000, 'unset falls back to the documented default');
    process.env.SP_SHUTDOWN_TIMEOUT_MS = '45000';
    assert.equal(shutdownTimeoutMs(), 45_000, 'the environment variable is honoured');
    assert.equal(shutdownTimeoutMs('120000'), 120_000, 'an explicit value wins over the environment');
  } finally {
    if (saved === undefined) delete process.env.SP_SHUTDOWN_TIMEOUT_MS; else process.env.SP_SHUTDOWN_TIMEOUT_MS = saved;
  }
});

test('an unusable value falls back to the default instead of removing the guard', () => {
  for (const bad of ['0', '999', '300001', '-1', 'abc', '', '60000.5', 'Infinity', undefined]) {
    assert.equal(shutdownTimeoutMs(bad), 60_000, `${String(bad)} -> default`);
  }
  assert.equal(shutdownTimeoutMs('1000'), 1_000, 'the lower bound itself is accepted');
  assert.equal(shutdownTimeoutMs('300000'), 300_000, 'the upper bound itself is accepted');
});