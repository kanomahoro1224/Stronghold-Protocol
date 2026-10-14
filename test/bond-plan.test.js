// test/bond-plan.test.js — 预选盟约 BOND PLAN (shared/protocol.js `room.bondPlan`): the wire contract, the lobby
// wiring and the public view. The plan is public and inert, so the assertions are about reach, not about rules.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateC2S, isBondPlanId } from '../shared/protocol.js';
import { Lobby } from '../server/lobby.js';
import { DATA, makeMatch } from './match/harness.js';

const CORE = 'yanShip'; // 炎 — isCore in data/bonds.json, one of the eight the picker offers
const OTHER = 'egirShip'; // 阿戈尔 — also core, used as a second valid id

describe('bond plan: wire contract', () => {
  test('room.bondPlan accepts a bond id and an explicit null', () => {
    assert.equal(validateC2S({ t: 'room.bondPlan', bondId: CORE }), null);
    assert.equal(validateC2S({ t: 'room.bondPlan', bondId: null }), null);
  });

  test('room.bondPlan is refused with a non-id; an omitted field means "no plan"', () => {
    // nullable() accepts undefined, so an omitted bondId is a valid "clear" — the client always sends the field.
    assert.equal(validateC2S({ t: 'room.bondPlan' }), null, 'omitted field = no plan');
    assert.equal(validateC2S({ t: 'room.bondPlan', bondId: undefined }), null, 'undefined = no plan');
    assert.ok(validateC2S({ t: 'room.bondPlan', bondId: 'has space' }), 'not an id');
    assert.ok(validateC2S({ t: 'room.bondPlan', bondId: 7 }), 'not a string');
    assert.ok(validateC2S({ t: 'room.bondPlan', bondId: {} }), 'not a string');
    assert.ok(validateC2S({ t: 'room.bondPlan', bondId: 'x'.repeat(65) }), 'longer than 64');
  });

  test('isBondPlanId: null or an id, nothing else', () => {
    assert.equal(isBondPlanId(null), true);
    assert.equal(isBondPlanId(CORE), true);
    assert.equal(isBondPlanId('a b'), false);
    assert.equal(isBondPlanId(undefined), false);
    assert.equal(isBondPlanId(3), false);
  });
});

describe('bond plan: lobby wiring', () => {
  const quietLog = { info() {}, warn() {}, error() {} };
  const newLobby = () => new Lobby({ registry: { all: () => [], byId: () => null }, getData: () => DATA, log: quietLog });
  const newSession = (bondPlan = null) => ({ playerId: 'p1', name: 'P1', connected: true, loadout: null, skins: null, bondPlan });

  test('humanSeat carries session.bondPlan into the seat', () => {
    const lobby = newLobby();
    const seat = lobby.humanSeat(0, newSession(CORE));
    assert.equal(seat.bondPlan, CORE, 'humanSeat must preserve the plan from the session');
    assert.equal(seat.skins, null, 'and must not invent skins');
  });

  test('the handler refuses an unknown bond, stores a known one, and null clears it', () => {
    const lobby = newLobby();
    const session = newSession();
    const bad = lobby.bondPlan(session, { bondId: 'not_a_bond' });
    assert.ok(bad && bad.error, 'an unknown bond is refused');
    assert.equal(session.bondPlan, null, 'a refused plan is not stored');
    const ok = lobby.bondPlan(session, { bondId: CORE });
    assert.ok(!(ok && ok.error), 'a known bond is accepted');
    assert.equal(session.bondPlan, CORE);
    lobby.bondPlan(session, { bondId: OTHER });
    assert.equal(session.bondPlan, OTHER, 'a second pick replaces the first');
    lobby.bondPlan(session, { bondId: null });
    assert.equal(session.bondPlan, null, 'null clears the plan');
  });
});

describe('bond plan: match and public view', () => {
  const seats = (extra) => [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, ...extra }];

  test('seat.bondPlan reaches PlayerState and the public view', () => {
    const h = makeMatch({ mode: 'solo', seats: seats({ bondPlan: CORE }) });
    const ps = h.ps('p_0');
    assert.equal(ps.bondPlan, CORE, 'ps.bondPlan is initialised from seat.bondPlan');
    assert.equal(h.m.publicView().players[0].bondPlan, CORE, 'the public view carries the plan');
  });

  test('an unset plan stays off the wire; setBondPlan updates the public view and clears on an unknown id', () => {
    const h = makeMatch({ mode: 'solo', seats: seats({}) });
    const ps = h.ps('p_0');
    assert.equal(ps.bondPlan, null, 'initially unset');
    assert.equal(h.m.publicView().players[0].bondPlan, undefined, 'omitted while unset');

    let publicMarked = false;
    h.m.markPublic = () => { publicMarked = true; };
    const r = h.m.setBondPlan('p_0', OTHER);
    assert.ok(!(r && r.error), 'a known bond is accepted mid-match');
    assert.equal(ps.bondPlan, OTHER);
    assert.ok(publicMarked, 'markPublic was called (the plan is public)');
    assert.equal(h.m.publicView().players[0].bondPlan, OTHER);

    h.m.setBondPlan('p_0', 'not_a_bond');
    assert.equal(ps.bondPlan, null, 'an unknown id clears instead of storing an id no client can draw');
    assert.equal(h.m.publicView().players[0].bondPlan, undefined);
  });

  test('a bot seat never carries a plan', () => {
    const h = makeMatch({ mode: 'solo', seats: [{ seat: 0, playerId: 'p_0', name: 'AI', isBot: true, connected: true, bondPlan: CORE }] });
    const ps = h.ps('p_0');
    assert.equal(ps.bondPlan, null, 'bots keep no plan');
    assert.equal(h.m.publicView().players[0].bondPlan, undefined);
  });
});
