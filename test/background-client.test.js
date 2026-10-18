// test/background-client.test.js — the lazy background worker client hands out results and never leaks a job.
//
// server/workers/backgroundClient.js is the shared client for the background encoding/scanning workers: one worker per
// client, started on the first request, unref'd while idle so it cannot hold the process open, and every pending job
// settled exactly once whether the answer arrives, the worker throws, the worker dies or the client is closed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { BackgroundClient } from '../server/workers/backgroundClient.js';

const ECHO = fileURLToPath(new URL('./fixtures/background-echo.mjs', import.meta.url));
const client = (timeoutMs) => new BackgroundClient(ECHO, {}, timeoutMs);

test('a request starts one worker and returns its value', async (t) => {
  const c = client();
  t.after(() => c.close());
  const first = await c.request({ a: 1 });
  assert.deepEqual(first.echoed, { a: 1 });
  assert.equal(typeof first.pid, 'number');
  const worker = c.worker;
  await c.request({ b: 2 });
  assert.equal(c.worker, worker, 'the same worker serves the next request (no per-job spawn)');
});

test('an error answer rejects only that job', async (t) => {
  const c = client();
  t.after(() => c.close());
  await assert.rejects(() => c.request({ boom: true }), /boom/);
  assert.deepEqual((await c.request({ ok: true })).echoed, { ok: true }, 'the client stays usable');
  assert.equal(c.pending.size, 0, 'nothing is left pending');
});

test('a dying worker rejects its pending job and drops the worker', async (t) => {
  const c = client();
  t.after(() => c.close());
  await assert.rejects(() => c.request({ exit: true }), /exited 3/);
  assert.equal(c.worker, null, 'the dead worker is dropped');
  assert.equal(c.pending.size, 0);
  assert.deepEqual((await c.request({ after: 'death' })).echoed, { after: 'death' }, 'the next request starts a fresh worker');
});

test('close() rejects what is pending and refuses new work', async (t) => {
  const c = client();
  const inFlight = c.request({ slow: true });
  // attach the handler before closing: the rejection happens while close() is still awaited
  const rejected = assert.rejects(() => inFlight, /closed/);
  await c.close();
  await rejected;
  await assert.rejects(() => c.request({ later: true }), /closed/);
  assert.equal(c.pending.size, 0);
});