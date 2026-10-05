// test/match/healthz-load.test.js — DESIGN §23 "make the load visible": /healthz must report the battles the server
// actually steps, and where it steps them. Under client-side combat (DESIGN §14) every field with no connected human
// (each bot seat, each mid-disconnect takeover) is a HeadlessJob advanced in this thread by Match._runOnServer, which
// the old `hostedFields()` (runner + pacer only) never counted: a four-bot match reported `fields: 1` while four
// battles were stepping. `fieldsInThread` / `fieldsPooled` split that number; `mem` reports RSS / used heap in MB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, memStats } from '../../server/index.js';
import { Lobby } from '../../server/lobby.js';
import { makeMatch } from './harness.js';

/** Raw HTTP GET against a started server. */
function httpReq(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      req.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('hostedFields counts the fields the event loop steps itself, and hostedFieldStats splits them', () => {
  const h = makeMatch({
    mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 3, captureFrames: false, clientCombat: true, headlessSliceMs: 0.05,
  });
  h.autoHumans();
  const m = h.m;
  try {
    // zero-safe: a match that has not started steps nothing
    assert.equal(m.hostedFields(), 0);
    assert.deepEqual(m.hostedFieldStats(), { inThread: 0, pooled: 0 });

    h.start();
    h.run(() => m.fields.filter((f) => f.mode === 'server' && f.job).length >= 3 || h.ended != null, { maxSteps: 5e6 });
    assert.equal(m.runner, null, 'client-side combat runs no FieldRunner');
    assert.equal(m.pacer, null, 'and no HeadlessPacer on a normal round');
    const st = m.hostedFieldStats();
    assert.ok(st.inThread >= 3, `the three bot fields are stepped in this thread (${st.inThread})`);
    assert.equal(st.pooled, 0, 'no worker pool in virtual time (SP_SIM_WORKERS is off by default)');
    assert.equal(m.hostedFields(), st.inThread + st.pooled, 'the old count said 1 while these battles were stepping');

    // a frozen match still holds (and reports) the parked jobs; `/healthz` `paused` says how many matches are frozen
    m._freeze();
    assert.equal(m.hostedFieldStats().inThread, st.inThread);
    assert.equal(m.paused, true);
    m._unfreeze();
    assert.equal(m.paused, false);
  } finally { m.dispose(); }
});

test('lobby.stats sums fieldsInThread / fieldsPooled over the running matches (undefined-safe)', () => {
  const lobby = new Lobby({ registry: { size: 0 }, options: {} });
  const empty = lobby.stats();
  assert.equal(empty.fieldsInThread, 0);
  assert.equal(empty.fieldsPooled, 0);
  assert.equal(empty.fields, 0);
  // a match object that predates the breakdown (or a stub) must not break the aggregation
  lobby.rooms.set('STUB', { seats: [], match: { hostedFields: () => 2, liveHumans: () => 1, paused: false } });
  const stub = lobby.stats();
  assert.equal(stub.fields, 2);
  assert.equal(stub.fieldsInThread, 0);
  assert.equal(stub.fieldsPooled, 0);

  const h = makeMatch({
    mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 3, captureFrames: false, clientCombat: true, headlessSliceMs: 0.05,
  });
  h.autoHumans();
  try {
    h.start();
    h.run(() => h.m.fields.filter((f) => f.mode === 'server' && f.job).length >= 3 || h.ended != null, { maxSteps: 5e6 });
    lobby.rooms.set('TEST', { seats: [], match: h.m });
    const st = lobby.stats();
    assert.equal(st.matches, 2);
    assert.equal(st.fieldsInThread, h.m.hostedFieldStats().inThread);
    assert.ok(st.fieldsInThread >= 3);
    assert.ok(st.fields >= st.fieldsInThread, 'the breakdown is part of the total');
    assert.equal(typeof st.paused, 'number');
  } finally { h.m.dispose(); }
});

test('memStats: two small MB numbers for /healthz.mem', () => {
  const m = memStats();
  assert.deepEqual(Object.keys(m).sort(), ['heap', 'rss']);
  assert.ok(Number.isInteger(m.rss) && m.rss > 0, `rss MB (${m.rss})`);
  assert.ok(Number.isInteger(m.heap) && m.heap > 0, `heap MB (${m.heap})`);
});

test('/healthz carries the new load numbers and mem, and stays small and zero-safe with no match', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  try {
    const r = await httpReq(srv.port, '/healthz');
    assert.equal(r.status, 200);
    const h = JSON.parse(r.body.toString());
    for (const k of ['fields', 'fieldsIdle', 'fieldsInThread', 'fieldsPooled', 'paused']) {
      assert.equal(typeof h[k], 'number', `/healthz.${k} is a number (${JSON.stringify(h[k])})`);
    }
    assert.equal(h.fields, 0, 'no match is running: nothing is stepped');
    assert.equal(h.fieldsInThread, 0);
    assert.equal(h.fieldsPooled, 0);
    assert.equal(typeof h.mem, 'object');
    assert.ok(Number.isInteger(h.mem.rss) && h.mem.rss > 0, `mem.rss (${h.mem.rss})`);
    assert.ok(Number.isInteger(h.mem.heap) && h.mem.heap > 0, `mem.heap (${h.mem.heap})`);
    assert.ok(h.mem.rss >= h.mem.heap, 'the resident set holds the used heap');
    assert.ok(JSON.stringify(h).length < 2000, `every open page polls this: payload ${JSON.stringify(h).length} bytes`);
  } finally { await srv.close(); }
});
