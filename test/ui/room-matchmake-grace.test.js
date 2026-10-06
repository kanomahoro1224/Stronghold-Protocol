// test/ui/room-matchmake-grace.test.js — 开始匹配 must keep the old queue's 3 s 冷静期.
//
// Owner report 2026-10-06: 「开始匹配没有 3s 冷静期啊，直接开了」 — the click used to send room.matchmake immediately, so a
// room the pool (or the host's own AI fill) could fill at once started under the player's hand with no way back.
// The grace itself is armQueueJoin's behaviour and stays covered by test/ui/matchmaking-queue.test.js; what these pin is
// that the ROOM screen uses it for room.matchmake, and that a cancel inside the grace never reaches the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(path.join(ROOT, 'public/js/screens/room.js'), 'utf8');

test('the room screen arms 开始匹配 instead of sending room.matchmake on the click', () => {
  assert.match(SRC, /import \{ armQueueJoin \} from '\.\/lobby\.js'/, "the grace is the lobby queue's own");
  const start = SRC.match(/const start = \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(start, 'start() is a block, not a one-line request');
  assert.match(start[0], /armQueueJoin\(/, 'it arms the search');
  assert.match(start[0], /room\.matchmake/, 'the armed send is room.matchmake');
  assert.doesNotMatch(SRC, /net\.request\(coop \? 'room\.matchmake'/, 'nothing is sent on the click itself');
  assert.match(start[0], /if \(!coop\) \{ run\('start', \(\) => net\.request\('room\.start', \{\}\)\); return; \}/, 'solo stays immediate');
});

test('a cancel inside the grace sends nothing; a cancel after it calls the pool off', () => {
  const cancel = SRC.match(/const cancelSearch = \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(cancel, 'cancelSearch is a block');
  assert.match(cancel[0], /armed\.cancel\(\)/, 'the armed entry is taken back locally');
  assert.match(cancel[0], /'room\.matchmake', \{ on: false \}/, 'and only a real search is called off');
  assert.match(SRC, /const searching = !!room\.searching \|\| arming;/, 'the grace already looks like searching');
  assert.match(SRC, /armRef\.current\?\.cancel\(\)/, 'leaving the screen disarms a pending search');
});
