// test/ui/lobby-tip.test.js — the lobby's 分线 / 粥友群 tip (user request: the group number beside the line link).
//
// The row is static copy with no logic of its own, so what is worth pinning is that both facts stay in the SAME
// `.lobby-tip` row: the 联机用分线 link the operator publishes, and the 粥友群 number players are told to join.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOBBY_SRC = readFileSync(path.join(ROOT, 'public/js/screens/lobby.js'), 'utf8');
const CSS = readFileSync(path.join(ROOT, 'public/css/screens/lobby.css'), 'utf8');

test('the lobby tip carries the 分线 link and the 粥友群 number in one row', () => {
  const row = LOBBY_SRC.match(/<div class="lobby-tip">([\s\S]*?)<\/div>/);
  assert.ok(row, 'the lobby tip row exists');
  assert.match(row[1], /联机用分线/, 'the line label');
  assert.match(row[1], /href="https:\/\/game\.kafuno\.cn"/, 'the line link');
  assert.match(row[1], /粥友群/, 'the group label');
  assert.match(row[1], /933064601/, 'the group number');
  assert.match(CSS, /\.lobby-tip__num\s*\{/, 'the number has its own style');
});
