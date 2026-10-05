// test/state/healthz-state.test.js — the boot wiring of the match-state persistence (server/index.js).
//
// One narrow check on the two things the wiring adds to the running server: `/healthz` carries a small `state` block
// (and stays cheap), and the lobby actually receives the bridge. The store is the in-memory backend, so this test
// touches no disk and leaves no state directory behind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { startServer, stateStats } from '../../server/index.js';
import { PersistQueue } from '../../server/state/persist.js';
import { MemoryStore } from '../../server/state/store.js';
import { StateBridge } from '../../server/state/resume.js';

function httpReq(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a fresh, healthy queue and a disabled bridge report the zero-safe /healthz.state shape', () => {
  const store = new MemoryStore();
  const q = new PersistQueue({ store });
  assert.deepEqual(q.stats(), { queued: 0, written: 0, deleted: 0, dropped: 0, errors: 0, lastError: null, store: 'memory' });
  const disabled = StateBridge.disabled('off');
  for (const k of ['queued', 'written', 'dropped', 'errors', 'resumedCount']) {
    assert.equal(typeof disabled.stats()[k], 'number', `state.stats().${k} is a number`);
  }
  assert.equal(disabled.stats().resumed, false);
  assert.equal(disabled.stats().lastError, null);
});

test('startServer wires a state bridge into the lobby and /healthz reports it', async () => {
  const srv = await startServer({ port: 0, quiet: true, host: '127.0.0.1', state: { backend: 'memory' } });
  try {
    assert.ok(srv.lobby.state, 'the lobby got the bridge');
    assert.equal(srv.lobby.state.enabled, true);
    assert.equal(srv.lobby.state.store.kind, 'memory');
    const h = (await httpReq(srv.port, '/healthz')).body;
    assert.ok(h.state && typeof h.state === 'object', `/healthz.state exists: ${JSON.stringify(h.state)}`);
    for (const k of ['queued', 'written', 'dropped', 'errors', 'resumedCount']) {
      assert.equal(typeof h.state[k], 'number', `/healthz.state.${k} is a number (${JSON.stringify(h.state[k])})`);
    }
    assert.equal(h.state.resumedCount, 0, 'nothing was persisted before this server started');
    assert.equal(h.state.resumed, false, 'resume is opt-in (SP_STATE_RESUME)');
    assert.equal(h.state.lastError, null);
    assert.equal(h.state.store, 'memory');
    assert.ok(JSON.stringify(h).length < 4000, 'the frame stays small');
    assert.equal(stateStats().store, 'memory', 'the exported probe reads the live bridge');
  } finally {
    await srv.close();
  }
  assert.equal(stateStats().store, 'off', 'a closed server leaves no probe behind');
});

test('startServer({ state: false }) disables persistence entirely (tests, SP_STATE=off)', async () => {
  const srv = await startServer({ port: 0, quiet: true, host: '127.0.0.1', state: false });
  try {
    assert.equal(srv.lobby.state.enabled, false);
    assert.equal(srv.lobby.state.stats().store, 'off');
    assert.equal(srv.lobby.state.claim('anything'), null);
    srv.lobby.noteMatch(srv.lobby.rooms.get('NONE'), null, 'start'); // must not throw with a null room
  } finally {
    await srv.close();
  }
});
