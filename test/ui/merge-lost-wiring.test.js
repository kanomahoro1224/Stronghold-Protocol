// The 0.3.3 merge kept both trees' features but silently dropped two WIRINGS that no test pinned, so the UI looked
// present while doing nothing (found 2026-11-01/02):
//   1. 作战统计 (battle/metrics.js): upstream f07b8965's game.js pushed the `combatMetrics` setting into the runner
//      (`battleRunner.setCombatMetrics`) — the runner never imports the settings store, so without this push
//      `metricsEnabled()` stayed false, `runner.js` never attached `trackCombat`, and the panel opened on an empty list.
//   2. 控制台 (room.console.enable): the branch's room screen had the 启用控制台 button, its 5 s ConsoleWarning and the
//      four handlers; the merged room.js kept ConsoleWarning's definition and `canManageConsole` but nothing called them,
//      so a room could never switch its console on.
// These are source-level guards on purpose: the panels are React-free pure renderers and a browser test cannot see the
// runner's private meter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const GAME = src('public/js/screens/game.js');
const ROOM = src('public/js/screens/room.js');
const RUNNER = src('public/js/battle/runner.js');

test('作战统计: the game screen pushes the setting into the runner (the merge had dropped this)', () => {
  // the runner keeps the switch but never reads the settings store itself
  assert.match(RUNNER, /export function createBattleRunner/, 'the runner module moved');
  assert.match(RUNNER, /setCombatMetrics/);
  assert.doesNotMatch(RUNNER, /from '\.\.\/ui\/settings\.js'/, 'the runner must not import the settings store: game.js pushes');
  // the push, at module scope, before any battle exists (a setting turned on in a previous session applies to the first one)
  assert.match(GAME, /import \{[^}]*\bsettingsStore\b[^}]*\} from '\.\.\/ui\/settings\.js';/, 'settingsStore has to be imported');
  assert.match(GAME, /if \(battleRunner\) \{\n\s*const applyCombatMetrics = \(s\) => battleRunner\.setCombatMetrics\(s\?\.combatMetrics === true\);\n\s*applyCombatMetrics\(settingsStore\.get\(\)\);\n\s*settingsStore\.subscribe\(applyCombatMetrics\);\n\}/,
    'game.js applies the switch at boot and follows later changes');
  // the panel is still gated on the same setting, so the two stay in step
  assert.match(GAME, /const metricsSetting = playerSettings\.combatMetrics === true;/);
  assert.match(GAME, /const showMetrics = metricsSetting && !modRoom && !spectator;/);
});

test('控制台: the room screen wires the branch\'s button, warning and handlers (the merge had dropped these)', () => {
  assert.match(ROOM, /function ConsoleWarning\(\{ open, remaining, busy, onCancel, onConfirm \}\)/);
  // the three states and the countdown that unlocks 确定启用
  assert.match(ROOM, /const \[consoleOpen, setConsoleOpen\] = useState\(false\);/);
  assert.match(ROOM, /const \[consoleReadyAt, setConsoleReadyAt\] = useState\(0\);/);
  assert.match(ROOM, /const \[consoleNow, setConsoleNow\] = useState\(\(\) => Date\.now\(\)\);/);
  assert.match(ROOM, /setConsoleReadyAt\(Date\.now\(\) \+ CONSOLE_ARM_MS\)/);
  assert.match(ROOM, /const CONSOLE_ARM_MS = 5000;/);
  assert.match(ROOM, /if \(!consoleOpen\) return undefined;\n\s*const id = setInterval\(\(\) => setConsoleNow\(Date\.now\(\)\), 200\);/,
    'the countdown ticks while the warning is up');
  // the four handlers talk to the protocol's room.console.* messages
  assert.match(ROOM, /net\.request\('room\.console\.enable', \{\}\)/);
  assert.match(ROOM, /net\.request\('room\.console\.disable', \{\}\)/);
  // the button itself, host only, and the read-only mark for everybody else
  assert.match(ROOM, /const canManageConsole = facts\.isHost \|\| \(room\.mode === 'solo' && !!facts\.mine\);/);
  assert.match(ROOM, /data-testid="room-console"/);
  assert.match(ROOM, /onClick=\$\{room\.consoleEnabled \? disableConsole : openConsole\}/);
  assert.match(ROOM, /room\.consoleEnabled \? html`<span class="rs-pill__con is-on is-ro" title=\$\{t\('控制台已启用'\)\}/);
  // and the warning is mounted (the merged file had the component but no caller)
  assert.match(ROOM, /<\$\{ConsoleWarning\} open=\$\{consoleOpen\} remaining=\$\{Math\.max\(0, Math\.ceil\(\(consoleReadyAt - consoleNow\) \/ 1000\)\)\}/);
  // a console room cannot queue for the public match: the box un-ticks itself and the server refuses it too
  assert.match(ROOM, /if \(room\?\.consoleEnabled\) setMatchTeammates\(false\);/);
  assert.match(src('server/lobby.js'), /公共匹配固定为第二期下半：其他版本的房间请直接开赛/);
});
