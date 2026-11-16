// Team canonical → the flat wire stream the existing replay engine consumes; one field at a time, own private only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canReplayVisual, teamFields, teamViewerId, teamWireFor } from '../../public/js/demoReplay.js';

const doc = {
  kind: 'team', matchId: 'm_T_1', startedAt: 1000, endedAt: 5000, mode: 'coop', difficulty: 'HARD',
  players: [{ playerId: 'p_a', seat: 0, name: 'A', isBot: false }, { playerId: 'p_b', seat: 1, name: 'B', isBot: false }],
  public: [{ at: 0, t: 'm.public', m: { phase: 'prep', round: 1 } }],
  result: { at: 4000, t: 'm.result', m: { settled: true, outcome: 'won' } },
  fields: {
    'n:p_a': { owner: 'p_a', kind: 'normal', fieldMeta: { fieldId: 'n:p_a', stageId: 's1' }, frames: [
      { at: 100, t: 'b.snap', m: { fieldId: 'n:p_a', units: [{ id: 'a1', x: 1 }] } },
    ] },
    'n:p_b': { owner: 'p_b', kind: 'normal', fieldMeta: { fieldId: 'n:p_b' }, frames: [
      { at: 100, t: 'b.snap', m: { fieldId: 'n:p_b', units: [{ id: 'b1', x: 2 }] } },
    ] },
  },
  privates: { p_a: [{ at: 0, t: 'm.private', m: { playerId: 'p_a', hand: ['x'] } }] },
};

test('team replay: viewer and field list', () => {
  assert.equal(canReplayVisual(doc), true);
  assert.equal(teamViewerId(doc), 'p_a');
  assert.deepEqual(teamFields(doc).map((f) => f.fieldId), ['n:p_a', 'n:p_b']);
});

test('team replay: one field wire has public + meta + own frames + own private, never B private', () => {
  const wire = teamWireFor(doc, 'n:p_a');
  assert.ok(wire.some((f) => f.t === 'm.public'));
  assert.ok(wire.some((f) => f.t === 'm.result' && f.m.outcome === 'won'), 'the final result is replayed too');
  assert.ok(wire.some((f) => f.t === 'm.field' && f.m.fieldId === 'n:p_a'));
  assert.ok(wire.some((f) => f.t === 'b.snap' && f.m.units[0].id === 'a1'));
  assert.ok(wire.some((f) => f.t === 'm.private' && f.m.playerId === 'p_a'));
  assert.equal(wire.some((f) => f.t === 'm.private' && f.m.playerId === 'p_b'), false);
  assert.equal(wire.some((f) => f.t === 'b.snap' && f.m.units[0].id === 'b1'), false, 'other field frames stay out');
});
