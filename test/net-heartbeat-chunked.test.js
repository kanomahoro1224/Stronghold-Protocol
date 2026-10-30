// test/net-heartbeat-chunked.test.js — the heartbeat pass yields, and never overlaps itself.
//
// heartbeat() walks every connection on a 30 s interval. Done in one synchronous loop it holds the event loop for the
// whole sweep, so the pass runs as a job on the fanout queue: at most 128 connections (or 2 ms) per slice, with a
// setImmediate in between, which also keeps the sweep in the same order as broadcasts (test/ws-latency.test.js). The
// per-connection behaviour is unchanged (hello timeout, dead-socket terminate, ping), which is what these cases pin
// down. The queue state mirrors what the Network constructor sets up; `conns` is keyed by the socket, as in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Network } from '../server/net.js';

function fakeNet(count, { alive = true, session = {} } = {}) {
  const net = Object.create(Network.prototype);
  net.opts = { helloTimeoutMs: 1000 };
  net.log = { debug() {}, error() {}, info() {}, warn() {} };
  net.now = () => 10_000;
  net.closed = false;
  net.draining = false;
  net.conns = new Map();
  net._fanout = [];
  net._fanoutImmediate = null;
  net._fanoutRunning = false;
  net._heartbeatPending = false;
  for (let i = 0; i < count; i++) {
    const conn = { alive, closing: false, session, openedAt: 0, pings: 0, terminated: 0, closes: 0 };
    conn.ws = { ping() { conn.pings++; }, terminate() { conn.terminated++; } };
    conn.close = () => { conn.closes++; };
    net.conns.set(conn.ws, conn);
  }
  return net;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const pinged = (net) => [...net.conns.values()].reduce((n, c) => n + c.pings, 0);

test('a large pass pings every socket but yields instead of blocking', async () => {
  const net = fakeNet(300);
  net.heartbeat();
  const pingsAfterCall = pinged(net);
  assert.ok(pingsAfterCall > 0 && pingsAfterCall <= 128,
    `the first slice ran, the rest waits (${pingsAfterCall} of 300, at most 128)`);
  assert.equal(net._heartbeatPending, true, 'the pass is still yielding');

  for (let i = 0; i < 10 && [...net.conns.values()].some((c) => c.pings === 0); i++) await settle();
  for (const c of net.conns.values()) {
    assert.equal(c.pings, 1, 'every connection is pinged exactly once');
    assert.equal(c.alive, false, 'and marked unanswered until the pong arrives');
  }
  assert.equal(net._heartbeatPending, false, 'the pass is finished');
});

test('a socket that did not answer is terminated, and a hello-less one is closed', async () => {
  const net = fakeNet(3, { alive: false });
  net.heartbeat();
  for (let i = 0; i < 5; i++) await settle();
  for (const c of net.conns.values()) assert.equal(c.terminated, 1, 'dead sockets are dropped');

  const hello = fakeNet(2, { session: null });
  hello.opts.helloTimeoutMs = 500;
  hello.heartbeat();
  for (let i = 0; i < 5; i++) await settle();
  for (const c of hello.conns.values()) {
    assert.equal(c.closes, 1, 'a connection that never said hello is closed');
    assert.equal(c.pings, 0, 'and is not pinged');
  }
});

test('a pass still yielding is not started a second time', async () => {
  const net = fakeNet(300);
  net.heartbeat();
  assert.equal(net._heartbeatPending, true);
  net.heartbeat();                                  // the next interval tick fires while the first pass is yielding
  for (let i = 0; i < 10; i++) await settle();
  for (const c of net.conns.values()) assert.equal(c.pings, 1, 'still exactly one ping, not two overlapping passes');
  assert.equal(net._heartbeatPending, false);
});

test('fewer connections than one slice complete in the same tick, like the old loop', () => {
  const net = fakeNet(127);
  net.heartbeat();
  for (const c of net.conns.values()) assert.equal(c.pings, 1, 'all of them were pinged synchronously');
  assert.equal(net._heartbeatPending, false, 'nothing yielded, so the pass had already ended when the caller resumed');
});

test('a closed server never starts a pass', () => {
  const net = fakeNet(10);
  net.closed = true;
  net.heartbeat();
  for (const c of net.conns.values()) assert.equal(c.pings, 0, 'a shut-down server pings nothing');
  assert.equal(net._heartbeatPending, false, 'and does not mark a pass pending');
});

test('a server that closes while the pass is yielding stops the rest of it', async () => {
  const net = fakeNet(300);
  net.heartbeat();
  const first = pinged(net);
  assert.ok(first > 0 && first < 300, 'the first slice ran, the rest is still queued');
  net.closed = true;                                // shutdown lands after the first slice, before the next one
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(pinged(net), first, 'only the slice that had already run');
  assert.equal(net._heartbeatPending, false, 'the pass ended rather than pinging the rest');
});

test('a connection removed or replaced while the pass yields is left to the next pass', async () => {
  const net = fakeNet(300);
  net.heartbeat();                                  // the first slice is done, the pass is waiting on the yield

  const keys = [...net.conns.keys()];
  const removed = net.conns.get(keys[200]);
  net.conns.delete(keys[200]);
  const replaced = net.conns.get(keys[250]);
  const replacement = { alive: true, closing: false, session: {}, openedAt: 0, pings: 0, terminated: 0, closes: 0 };
  replacement.ws = replaced.ws;                     // the same socket, a new connection record
  replacement.close = () => { replacement.closes++; };
  net.conns.set(keys[250], replacement);

  for (let i = 0; i < 10; i++) await settle();
  assert.equal(removed.pings, 0, 'a connection dropped mid-pass is not acted on after its owner let it go');
  assert.equal(replaced.pings, 0, 'the object that was replaced is not acted on either');
  assert.equal(replacement.pings, 0, 'the replacement waits for the next pass');
  assert.equal([...net.conns.values()].filter((c) => c.pings === 1).length, 298,
    'every other connection is still pinged exactly once');
});

test('each pass pings each connection once, however many passes run', async () => {
  const net = fakeNet(200);
  net.heartbeat();
  for (let i = 0; i < 10; i++) await settle();
  for (const c of net.conns.values()) c.alive = true;   // the pongs came back between the two ticks
  net.heartbeat();
  for (let i = 0; i < 10; i++) await settle();
  for (const c of net.conns.values()) assert.equal(c.pings, 2, 'one ping per pass, never two in one pass');
});
