// m.public carries the platform's stable matchId: the client demo recorder groups a team's four parts by it.
// A bare test / journal match without one keeps the frame byte-identical (no key at all, not `matchId: null`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';

test('matchId: the platform id reaches m.public', () => {
  const h = makeMatch({ matchId: 'm_TEST_1_7' }).start();
  try {
    const pub = h.bc.find((msg) => msg.t === 'm.public');
    assert.ok(pub, 'start broadcasts a public frame');
    assert.equal(pub.matchId, 'm_TEST_1_7');
  } finally { h.m.dispose(); }
});

test('matchId: absent on a bare match (test journals stay byte-identical)', () => {
  const h = makeMatch({}).start();
  try {
    const pub = h.bc.find((msg) => msg.t === 'm.public');
    assert.ok(pub);
    assert.equal(Object.hasOwn(pub, 'matchId'), false);
  } finally { h.m.dispose(); }
});
