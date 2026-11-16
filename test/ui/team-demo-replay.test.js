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

test('team replay: a settlement sharing the final frame timestamp still sorts last', () => {
  const tied = { ...doc, result: { at: 100, t: 'm.result', m: { settled: true, outcome: 'won' } },
    fields: { ...doc.fields, 'n:p_a': { ...doc.fields['n:p_a'], frames: [
      { at: 100, t: 'b.snap', m: { fieldId: 'n:p_a', units: [{ id: 'a1', x: 1 }] } },
    ] } } };
  const wire = teamWireFor(tied, 'n:p_a');
  const last = wire[wire.length - 1];
  assert.equal(last.t, 'm.result', 'the result is after the final snapshot at the same at');
  assert.equal(wire[wire.length - 2].t, 'b.snap');
});

test('team replay: a public RESULT recorded before the last field frame is moved after it', () => {
  const early = { ...doc, public: [
    { at: 0, t: 'm.public', m: { phase: 'prep', round: 1 } },
    { at: 50, t: 'm.public', m: { phase: 'RESULT', round: 2 } },
  ], fields: { ...doc.fields, 'n:p_a': { ...doc.fields['n:p_a'], frames: [
    { at: 100, t: 'b.snap', m: { fieldId: 'n:p_a', units: [{ id: 'a1', x: 1 }] } },
  ] } } };
  const wire = teamWireFor(early, 'n:p_a');
  assert.equal(wire[wire.length - 1].t, 'm.result');
  assert.equal(wire[wire.length - 2].t, 'm.public');
  assert.equal(wire[wire.length - 2].m.phase, 'RESULT');
  assert.equal(wire[wire.length - 3].t, 'b.snap');
});


test('team replay: viewerId wins over another private key and field order prefers the viewer', () => {
  const d = { ...doc, viewerId: 'p_b', privates: {
    p_a: [{ at: 0, t: 'm.private', m: { playerId: 'p_a', hand: ['a'] } }],
    p_b: [{ at: 0, t: 'm.private', m: { playerId: 'p_b', hand: ['b'] } }],
  } };
  assert.equal(teamViewerId(d), 'p_b');
  assert.deepEqual(teamFields(d).map((f) => f.fieldId), ['n:p_b', 'n:p_a']);
  const wire = teamWireFor(d, 'n:p_a');
  assert.ok(wire.some((f) => f.t === 'm.private' && f.m.playerId === 'p_b'));
  assert.equal(wire.some((f) => f.t === 'm.private' && f.m.playerId === 'p_a'), false);
});

test('team replay: the meta at t=0 is the initial board, not the last resync', () => {
  const resync = { ...doc, fields: { ...doc.fields, 'n:p_a': {
    owner: 'p_a', kind: 'normal',
    initialFieldMeta: { fieldId: 'n:p_a', units: [{ id: 'a1', form: 'first' }] },
    fieldMeta: { fieldId: 'n:p_a', units: [{ id: 'a1', form: 'second' }] },
    frames: [
      { at: 100, t: 'm.field', m: { fieldId: 'n:p_a', units: [{ id: 'a1', form: 'second' }] } },
      { at: 100, t: 'b.snap', m: { fieldId: 'n:p_a', units: [{ id: 'a1', x: 1 }] } },
    ],
  } } };
  const metas = teamWireFor(resync, 'n:p_a').filter((f) => f.t === 'm.field');
  assert.equal(metas[0].m.units[0].form, 'first');
  assert.equal(metas[1].m.units[0].form, 'second');
  assert.equal(metas[0].m.local, false);
});
