// test/net-backpressure-diagnostics.test.js — the two backpressure counters are actually counted.
//
// NetDiagnostics defined droppedSnapshots/slowDisconnects and stats() reported them, but nothing ever incremented them:
// /healthz said "0 dropped, 0 slow" no matter how many frames were skipped or sockets terminated. These are the
// numbers an operator uses to decide whether a slow client is the problem, so they must be real.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sendRaw } from '../server/net.js';
import { NetDiagnostics, socketDiagnostics } from '../server/netDiagnostics.js';

const socket = (bufferedAmount, { terminate = () => {} } = {}) => ({
  readyState: 1, bufferedAmount, terminated: 0, frames: [], terminate() { this.terminated++; terminate(); },
  send(data) { this.frames.push(data); },
});

test('a droppable frame over the snapshot threshold is counted as dropped', () => {
  const ws = socket(2 << 20);
  socketDiagnostics.set(ws, new NetDiagnostics());
  assert.equal(sendRaw(ws, '{"t":"b.snap"}', { droppable: true }), false, 'the frame is skipped');
  assert.equal(ws.frames.length, 0);
  assert.equal(socketDiagnostics.get(ws).droppedSnapshots, 1);
  assert.equal(socketDiagnostics.get(ws).slowDisconnects, 0, 'a dropped snapshot is not a slow disconnect');
});

test('a socket over the hard threshold is counted as a slow disconnect and terminated', () => {
  const ws = socket(32 << 20);
  socketDiagnostics.set(ws, new NetDiagnostics());
  assert.equal(sendRaw(ws, '{"t":"m.public"}'), false);
  assert.equal(ws.terminated, 1, 'the socket is closed');
  assert.equal(socketDiagnostics.get(ws).slowDisconnects, 1);
  assert.equal(socketDiagnostics.get(ws).droppedSnapshots, 0);
});

test('the counters reach stats() and a socket without diagnostics still behaves', () => {
  const ws = socket(2 << 20);
  const d = new NetDiagnostics();
  socketDiagnostics.set(ws, d);
  sendRaw(ws, '{"t":"b.snap"}', { droppable: true });
  sendRaw(ws, '{"t":"b.snap"}', { droppable: true });
  assert.equal(d.stats().droppedSnapshots, 2, 'the reported number matches what happened');

  const bare = socket(2 << 20);
  assert.equal(sendRaw(bare, '{"t":"b.snap"}', { droppable: true }), false, 'no diagnostics registered: still a no-op');
});