import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from './harness.js';

function dropOneAt(h, phase) {
  const m = h.m;
  h.drive(() => m.phase === phase, { ready: false });
  m.handle('p_1', { t: 'g.leave' });
  assert.equal(h.ps('p_1').left, true, `${phase}: p_1 left`);
  assert.equal(h.logs.error.length, 0, `${phase}: leave must not throw: ${h.logs.error.join(' | ')}`);
  return m;
}

test('quit matrix: leaving at each pre-combat phase cannot leave the match waiting on the departed player', () => {
  for (const phase of [PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.SP_DRAFT, PHASE.PREP]) {
    const h = makeMatch({ mode: 'coop', humans: 2, seed: 4800 + phase.length, fake: true, script: () => ({ duration: 2 }) }).start();
    const m = dropOneAt(h, phase);
    h.run(() => m.phase === PHASE.COMBAT || m.ended, { maxTime: 500_000 });
    assert.ok(m.phase === PHASE.COMBAT || m.ended, `${phase}: phase=${m.phase} round=${m.round} did not advance`);
    m.dispose();
  }
});

test('quit matrix: leaving during client combat settles the field and advances the round', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 4900, fake: true, clientCombat: true, instant: false, script: () => ({ duration: 3 }) }).start();
  const m = h.m;
  h.drive(() => m.phase === PHASE.PREP && m.round === 1);
  m.handle('p_0', { t: 'g.ready', ready: true });
  m.handle('p_1', { t: 'g.ready', ready: true });
  h.run(() => m.phase === PHASE.COMBAT);
  m.handle('p_1', { t: 'g.leave' });
  h.run(() => m.round >= 2 || m.ended, { maxTime: 500_000 });
  assert.ok(m.round >= 2 || m.ended, `COMBAT: phase=${m.phase} round=${m.round} did not advance`);
  assert.equal(h.logs.error.length, 0, `COMBAT leave threw: ${h.logs.error.join(' | ')}`);
  m.dispose();
});
