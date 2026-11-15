// Pure team-demo merge: public timeline de-dup / server clock anchoring / field ownership / private isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignPart, mergeTeamDemos, filterTeamDemoForViewer, downsampleTeamDemo } from '../server/accounts/teamDemos.js';

const frame = (at, t, m = {}) => ({ at, t, m });
const part = (playerId, wire, over = {}) => ({
  playerId,
  doc: {
    matchId: 'm_T_1', startedAt: 1000, endedAt: 5000, mode: 'coop', difficulty: 'HARD',
    players: [{ playerId: 'p_a', seat: 0, name: 'A', isBot: false }, { playerId: 'p_b', seat: 1, name: 'B', isBot: false }],
    wire, ...over,
  },
});

test('alignPart: m.public.serverNow anchors frames; a missing anchor falls back to low quality', () => {
  const p = { startedAt: 1000, wire: [frame(100, 'm.public', { serverNow: 2000 }), frame(200, 'b.snap', { x: 1 }), frame(0, 'm.ticker', { y: 2 })] };
  const a = alignPart(p);
  assert.equal(a[0].serverAt, 2000);
  assert.equal(a[0].clockQuality, 'high');
  assert.equal(a[1].serverAt, 2100);
  assert.equal(a[2].clockQuality, 'low');
});

test('mergeTeamDemos: public dedupe, owner-only field frames, own private only, partial when a participant is missing', () => {
  const a = part('p_a', [
    frame(0, 'm.public', { serverNow: 1000, players: [{ playerId: 'p_a', isBot: false }, { playerId: 'p_b', isBot: false }] }),
    frame(100, 'm.field', { fieldId: 'n:p_a', players: ['p_a'], kind: 'normal' }),
    frame(100, 'b.snap', { fieldId: 'n:p_a', units: [{ id: 'u1', x: 1 }] }),
    frame(0, 'm.private', { hand: ['a'] }),
  ]);
  const b = part('p_b', [
    frame(0, 'm.public', { serverNow: 1001, players: [{ playerId: 'p_a', isBot: false }, { playerId: 'p_b', isBot: false }] }),
    // spectator copy of A's field must not win over A's own frames
    frame(100, 'b.snap', { fieldId: 'n:p_a', units: [{ id: 'u1', x: 99 }] }),
    frame(100, 'm.field', { fieldId: 'n:p_b', players: ['p_b'], kind: 'normal' }),
    frame(100, 'b.snap', { fieldId: 'n:p_b', units: [{ id: 'u2', x: 2 }] }),
    frame(0, 'm.private', { hand: ['b'] }),
  ]);
  const doc = mergeTeamDemos([a, b]);
  assert.equal(doc.kind, 'team');
  assert.equal(doc.matchId, 'm_T_1');
  assert.equal(doc.public.length, 1, 'the same public frame from both parts is deduped');
  assert.equal(doc.partial, false, 'both participants uploaded');
  assert.deepEqual(doc.availableFields.sort(), ['n:p_a', 'n:p_b']);
  assert.equal(doc.fields['n:p_a'].owner, 'p_a');
  assert.equal(doc.fields['n:p_a'].frames[0].m.units[0].x, 1, 'owner frame wins over spectator copy');
  assert.equal(doc.fields['n:p_b'].owner, 'p_b');
  assert.deepEqual(Object.keys(doc.privates).sort(), ['p_a', 'p_b']);
  const view = filterTeamDemoForViewer(doc, 'p_a');
  assert.deepEqual(Object.keys(view.privates), ['p_a'], 'B private never reaches A');
  assert.deepEqual(view.fields, doc.fields, 'all fields are visible');
});

test('mergeTeamDemos: a missing participant makes partial and a field without owner frames is degraded', () => {
  const a = part('p_a', [
    frame(0, 'm.public', { serverNow: 1000 }),
    frame(100, 'b.snap', { fieldId: 'n:p_b', units: [{ id: 'u2', x: 2 }] }),
    frame(100, 'm.field', { fieldId: 'n:p_b', players: ['p_b'], kind: 'normal' }),
  ]);
  const doc = mergeTeamDemos([a], { participants: ['p_a', 'p_b'] });
  assert.equal(doc.partial, true);
  assert.equal(doc.fields['n:p_b'].owner, null);
  assert.equal(doc.fields['n:p_b'].degraded, true);
  assert.equal(doc.partial, true);
});


test('downsampleTeamDemo: state events survive; attack animations and extra snapshots are dropped', () => {
  const frames = [];
  for (let i = 0; i < 10; i++) frames.push({ at: i * 100, t: 'b.snap', m: { fieldId: 'n:p_a', tick: i } });
  frames.push({ at: 50, t: 'b.ev', m: { fieldId: 'n:p_a', ev: [['spawn', { id: 'u1' }], ['hit', { id: 'u1' }]] } });
  frames.push({ at: 60, t: 'b.ev', m: { fieldId: 'n:p_a', ev: [['hit', { id: 'u1' }]] } });
  const doc = { kind: 'team', fields: { 'n:p_a': { owner: 'p_a', frames } }, public: [], privates: {} };
  const out = downsampleTeamDemo(doc, { snapStep: 2 });
  const kept = out.fields['n:p_a'].frames;
  assert.equal(kept.filter((f) => f.t === 'b.snap').length, 6, 'first, last and every 2nd snapshot');
  assert.equal(kept.filter((f) => f.t === 'b.ev').length, 1, 'only the state event remains');
  assert.deepEqual(kept.find((f) => f.t === 'b.ev').m.ev[0][0], 'spawn');
});
