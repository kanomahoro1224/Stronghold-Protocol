// Unit tests (Node) for the local demo recorder (public/js/demoRecorder.js):
//   the keep rule (a match left before the first round was cleared is not worth a demo — owner's rule 2026-11-15),
//   one document per match (frames keep appending to the same id, the statistics record links to it),
//   every ending closes the document (result, leaving the room, 放弃模拟, a replace).
// IndexedDB is absent in Node, so nothing is written: these tests follow the document, not the storage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { net } from '../../public/js/net.js';
import { keepsDemo, startDemoRecorder, currentDemoId, currentDemoMeta, dropDemo } from '../../public/js/demoRecorder.js';

const frame = (over = {}) => ({
  t: 'm.public', phase: 'prep', round: 1, modeId: 'mode_single_hard', difficulty: 'HARD',
  players: [{ playerId: 'p1', seat: 0, name: 'A' }], ...over,
});

test('demo recorder: the keep rule (no demo before the first round is cleared)', () => {
  assert.equal(keepsDemo({ settled: false, rounds: 0 }), false, 'left in round 1 → no demo');
  assert.equal(keepsDemo({ settled: false, rounds: 1 }), true, 'one round cleared → demo');
  assert.equal(keepsDemo({ settled: true, rounds: 0 }), true, 'a settlement is always worth it');
  assert.equal(keepsDemo(null), false);
});

test('demo recorder: one document per match, closed by every ending', () => {
  startDemoRecorder();
  assert.equal(currentDemoId(), null, 'nothing before a match');

  net._emit('m.public', frame());
  const id = currentDemoId();
  assert.ok(id, 'the first board frame opens the document');

  net._emit('m.public', frame({ phase: 'settle' }));
  net._emit('m.public', frame({ phase: 'prep', round: 2 }));
  assert.equal(currentDemoId(), id, 'later frames stay in the same document');

  net._emit('m.result', {});
  assert.equal(currentDemoId(), null, 'the settlement closes it');

  // a result replay's trailing frame must not open a second document for the finished match
  net._emit('m.public', frame());
  assert.equal(currentDemoId(), null, 'no document after the result');

  // leaving the room without a result: the recorder starts over with the next match
  dropDemo();
  assert.equal(currentDemoId(), null);

  // the lobby's result replay: a final frame is never a new match (the latch and the phase both say so)
  net._emit('room.state', { inMatch: true });
  net._emit('m.public', frame({ phase: 'RESULT', round: 9 }));
  assert.equal(currentDemoId(), null, 'a RESULT frame opens nothing');

  // the room going away under a match closes the document, with or without a settlement
  net._emit('m.public', frame({ round: 3 }));
  assert.ok(currentDemoId());
  net._emit('room.state', { inMatch: false });
  assert.equal(currentDemoId(), null, 'the room going away closes it');
});

test('demo recorder: matchId / playerId / isTeam come from the first public frame', () => {
  startDemoRecorder();
  net._emit('m.public', frame({
    matchId: 'm_TEST_1_7',
    players: [{ playerId: 'p1', seat: 0, name: 'A', isBot: false }, { playerId: 'p2', seat: 1, name: 'B', isBot: false }],
  }));
  assert.deepEqual(currentDemoMeta(), { matchId: 'm_TEST_1_7', playerId: null, isTeam: true });
  dropDemo();
  net._emit('room.state', { inMatch: false });
});
