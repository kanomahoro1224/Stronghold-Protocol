// Regression tests (Node, no browser) of the client side of 同盟匹配 / 搜寻队友 (DESIGN §23, public/js/screens/lobby.js):
//   1. the search counter starts at *this* player's own click and counts up from there — never from the pool's wait time
//      (`queue.state.waitedMs` is the pool's first *connected* entry, broadcast to everybody, so a late clicker used to
//      see somebody else's seconds the moment they joined);
//   2. a fresh click only reaches the server after QUEUE_GRACE_MS of local elapsed time, and a cancel inside that window
//      sends nothing at all (a misclick must not queue the player: with four doctors already waiting, one stray tap
//      would start a match) — with no visible hint that the grace exists;
//   3. a reload / reconnect, where this page has no click of its own, resumes from the server's snapshot instead of
//      wrongly restarting at 0.
// The browser counterpart (real sockets, real click) is test/e2e/matchmaking.e2e.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUEUE_GRACE_MS, armQueueJoin, queueWaited, queueClock } from '../../public/js/screens/lobby.js';
import { MAX_SEATS } from '../../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOBBY_SRC = readFileSync(path.join(ROOT, 'public/js/screens/lobby.js'), 'utf8');

/** A `queue.state` payload as the panel sees it: somebody else has already been waiting 12.5 s. */
const POOLED = { difficulty: 'HARD', size: 3, max: MAX_SEATS, solo: false, since: 1_000_000 };

describe('搜寻队友: the counter belongs to this player\'s own click', () => {
  test('a late clicker starts at 00:00, not at the pool\'s wait time', () => {
    const click = 1_012_500; // this player clicks 12.5 s after the pool's first waiter
    assert.equal(queueWaited(POOLED, click, click), 0, 'the click itself is zero');
    assert.equal(queueClock(queueWaited(POOLED, click, click)), '00:00');
    assert.equal(queueClock(queueWaited(POOLED, click, click + 1_000)), '00:01');
    assert.equal(queueClock(queueWaited(POOLED, click, click + 3_000)), '00:03', 'it counts this player\'s own wait up');
    assert.equal(queueClock(queueWaited(POOLED, click, click + 65_000)), '01:05');
  });

  test('a later queue.state cannot jump the counter forward', () => {
    const click = 5_000_000;
    // The pool still reports its oldest waiter on the next broadcast (server/lobby.js firstAt / queueState):
    const pooled = { ...POOLED, since: click - 9_000 };
    assert.equal(queueClock(queueWaited(pooled, click, click + 4_000)), '00:04', 'still this player\'s own 4 s');
    // …and the same snapshot is all a page without its own click can go by:
    assert.equal(queueWaited(pooled, undefined, click + 4_000), 13_000);
  });

  test('without a local click the clock resumes from the server snapshot (reload / reconnect)', () => {
    const since = 2_000_000; // main.js: since = Date.now() - queue.state.waitedMs
    assert.equal(queueWaited({ since }, null, since + 12_400), 12_400, 'the entry really has been waiting that long');
    assert.equal(queueClock(queueWaited({ since }, null, since + 12_400)), '00:12');
    assert.equal(queueWaited({}, undefined, 5_000), 0, 'no anchor at all: 0, not a huge or negative wait');
    assert.equal(queueWaited(null, null, 5_000), 0);
    assert.equal(queueWaited({ since: 9_000 }, 9_500, 9_000), 0, 'a clock behind the anchor never goes negative');
  });

  test('queueClock is the panel\'s MM:SS', () => {
    assert.equal(queueClock(0), '00:00');
    assert.equal(queueClock(999), '00:00');
    assert.equal(queueClock(1_000), '00:01');
    assert.equal(queueClock(59_999), '00:59');
    assert.equal(queueClock(60_000), '01:00');
    assert.equal(queueClock(3_600_000), '60:00');
    assert.equal(queueClock(-5), '00:00');
    assert.equal(queueClock(undefined), '00:00');
  });
});

describe('搜寻队友: the silent join grace', () => {
  test('queue.join is not sent inside the grace and goes out at the threshold', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const sent = [];
    const entry = armQueueJoin({ difficulty: 'HARD', send: (d) => sent.push(d) });
    assert.equal(entry.start, Date.now(), 'the counter starts at the click');
    assert.equal(entry.sent, false);
    t.mock.timers.tick(QUEUE_GRACE_MS - 1);
    assert.deepEqual(sent, [], `nothing reaches the server before ${QUEUE_GRACE_MS} ms`);
    assert.equal(entry.sent, false, 'the click is still only local');
    t.mock.timers.tick(1);
    assert.deepEqual(sent, ['HARD'], '>= the threshold sends the join');
    assert.equal(entry.sent, true);
    t.mock.timers.tick(10 * 60_000);
    assert.deepEqual(sent, ['HARD'], 'and exactly once');
  });

  test('the panel counts 0, 1, 2 … while the join is still ours to take back', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const sent = [];
    const entry = armQueueJoin({ difficulty: 'HARD', send: (d) => sent.push(d) });
    const panelQ = { difficulty: 'HARD', size: 1, max: MAX_SEATS, solo: true, since: null }; // the grace-window placeholder
    const shown = () => queueClock(queueWaited(panelQ, entry.start));
    assert.equal(shown(), '00:00', 'the click shows 00:00 at once');
    t.mock.timers.tick(1_500);
    assert.equal(shown(), '00:01');
    assert.deepEqual(sent, [], 'still nothing sent');
    t.mock.timers.tick(1_500);
    assert.equal(shown(), '00:03', 'the clock reaches 00:03 …');
    assert.deepEqual(sent, ['HARD'], '… exactly as the join leaves');
  });

  test('a cancel inside the grace sends nothing at all', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const sent = [];
    const entry = armQueueJoin({ difficulty: 'HARD', send: (d) => sent.push(d) });
    t.mock.timers.tick(QUEUE_GRACE_MS - 1);
    entry.cancel();
    assert.equal(entry.cancelled, true);
    assert.equal(entry.timer, null, 'the pending join is disarmed');
    t.mock.timers.tick(10 * 60_000);
    assert.deepEqual(sent, [], 'a click taken back inside the grace never reaches the queue');
    assert.equal(entry.sent, false);
  });

  test('a timer that fires early waits for the remainder instead of joining too soon', () => {
    let clock = 7_000;
    let next = 0;
    const timers = new Map();
    const sent = [];
    const entry = armQueueJoin({
      difficulty: 'HARD', send: (d) => sent.push(d), now: () => clock,
      setTimer: (fn, ms) => { const id = ++next; timers.set(id, { fn, at: clock + ms }); return id; },
      clearTimer: (id) => timers.delete(id),
    });
    assert.equal(timers.get(entry.timer).at, 7_000 + QUEUE_GRACE_MS, 'the join is one grace out');
    clock += QUEUE_GRACE_MS - 100;                 // a coarse timer fires 100 ms early
    timers.get(entry.timer).fn();
    assert.deepEqual(sent, [], 'the gate is local elapsed time, not the timer\'s own idea');
    const rearmed = timers.get(entry.timer);
    assert.equal(rearmed.at, clock + 100, 'it re-arms for what is left');
    clock += 100;
    rearmed.fn();
    assert.deepEqual(sent, ['HARD']);
  });

  test('an armed search sends at most one queue.join, even if a timer fires twice', () => {
    let clock = 1_000;
    let next = 0;
    const timers = new Map();
    const sent = [];
    const entry = armQueueJoin({
      difficulty: 'HARD', send: (d) => sent.push(d), now: () => clock,
      setTimer: (fn, ms) => { const id = ++next; timers.set(id, { fn, at: clock + ms }); return id; },
      clearTimer: (id) => timers.delete(id),
    });
    const fire = timers.get(entry.timer).fn;
    clock += QUEUE_GRACE_MS;
    fire();
    assert.deepEqual(sent, ['HARD']);
    fire();                                    // a duplicate timer for the same entry
    for (const { fn } of timers.values()) fn();
    assert.deepEqual(sent, ['HARD'], 'one click, one queue.join');
  });

  test('the screen has exactly one queue.join site and the grace owns it', () => {
    const sites = LOBBY_SRC.match(/net\.request\('queue\.join'/g) || [];
    assert.equal(sites.length, 1, 'no second code path may send queue.join (in particular not the click handler)');
    assert.match(LOBBY_SRC, /armQueueJoin\(\{ difficulty: d, send: joinQueue \}\)/, 'the join is wired through armQueueJoin');
    assert.match(LOBBY_SRC, /QUEUE_GRACE_MS = 3000/);
    assert.match(LOBBY_SRC, /if \(armed && !armed\.sent\)/, '取消搜寻 inside the grace takes the click back locally');
    assert.match(LOBBY_SRC, /joinRef\.current\.cancel\(\)/, 'leaving the lobby disarms the pending join');
  });
});
