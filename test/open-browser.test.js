// openBrowser(): 用玩家的默认浏览器打开页面，且不会把浏览器拉成提权进程。
// 背景：`rundll32 url.dll,FileProtocolHandler` 继承调用方令牌，从提权终端启动会把 Edge 也拉成提权，之后 Edge 每次
// 都弹「现有实例正在以提升的权限运行」；交给 shell（explorer.exe <url>）则由非提权的 Explorer 转发给默认浏览器。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { browserCommands, openBrowser, parseBrowserCommand } from '../scripts/open-browser.mjs';

const WIN = { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } };

describe('openBrowser: 默认浏览器 + 不提权', () => {
  test('Windows 第一候选是 shell 关联（explorer），后面才是 start / rundll32 兜底', () => {
    const cmds = browserCommands('http://127.0.0.1:3000/', WIN);
    assert.deepEqual(cmds.map((c) => c.label), ['explorer', 'start', 'rundll32']);
    assert.equal(cmds[0].cmd, 'C:\\Windows\\explorer.exe');
    assert.deepEqual(cmds[0].args, ['http://127.0.0.1:3000/'], 'URL 原样交给 shell，由默认浏览器打开');
    assert.deepEqual(cmds[1].args, ['/c', 'start', '', 'http://127.0.0.1:3000/']);
    assert.deepEqual(cmds[2].args, ['url.dll,FileProtocolHandler', 'http://127.0.0.1:3000/']);
    // 不再有直接 rundll32 的“唯一路径”：从提权终端启动时它会把浏览器也提权
    assert.notEqual(cmds[0].label, 'rundll32');
  });

  test('系统目录里找不到可执行文件时退回裸命令名（由 PATH 解析），顺序不变', () => {
    const cmds = browserCommands('http://x/', { platform: 'win32', env: { SystemRoot: 'Z:\\no-such-windows' } });
    assert.deepEqual(cmds.map((c) => c.cmd), ['explorer.exe', 'cmd.exe', 'rundll32.exe']);
    // 没给 SystemRoot 时按默认的 C:\Windows 找绝对路径
    const real = browserCommands('http://x/', { platform: 'win32', env: {} });
    assert.match(real[0].cmd, /explorer\.exe$/);
  });

  test('SP_BROWSER 优先级最高，支持带引号的路径与额外参数', () => {
    const cmds = browserCommands('http://x/', { platform: 'win32', env: { SP_BROWSER: '"C:\\Program Files\\Browser\\b.exe" -new-window', SystemRoot: 'C:\\Windows' } });
    assert.equal(cmds[0].label, 'SP_BROWSER');
    assert.equal(cmds[0].cmd, 'C:\\Program Files\\Browser\\b.exe');
    assert.deepEqual(cmds[0].args, ['-new-window', 'http://x/']);
    assert.equal(cmds.length, 4, '仍然保留系统兜底');
    assert.deepEqual(parseBrowserCommand('   '), null);
    assert.deepEqual(parseBrowserCommand('firefox'), ['firefox']);
  });

  test('macOS 用 open，无桌面的 Linux 不启动任何东西', () => {
    assert.deepEqual(browserCommands('http://x/', { platform: 'darwin', env: {} }).map((c) => c.label), ['open']);
    assert.deepEqual(browserCommands('http://x/', { platform: 'linux', env: {} }), []);
    assert.deepEqual(browserCommands('http://x/', { platform: 'linux', env: { DISPLAY: ':0' } }).map((c) => c.label), ['xdg-open']);
  });

  test('openBrowser 启动第一个候选并返回它的名字；启动不了的候选会跳到下一个', () => {
    const spawned = [];
    const ok = openBrowser('http://127.0.0.1:3000/', {
      platform: 'win32', env: { SystemRoot: 'C:\\Windows' },
      spawnImpl: (cmd, args) => { spawned.push([cmd, args]); return { unref() {}, on() {} }; },
    });
    assert.equal(ok, 'explorer');
    assert.deepEqual(spawned, [['C:\\Windows\\explorer.exe', ['http://127.0.0.1:3000/']]]);

    const tried = [];
    const second = openBrowser('http://x/', {
      platform: 'win32', env: { SystemRoot: 'C:\\Windows' },
      spawnImpl: (cmd) => {
        tried.push(cmd);
        if (cmd.endsWith('explorer.exe')) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
        return { unref() {}, on() {} };
      },
    });
    assert.equal(second, 'start', 'explorer 起不来就用 cmd start');
    assert.equal(tried.length, 2);
  });

  test('没有可用的启动方式时返回 null（调用方只打印地址）', () => {
    assert.equal(openBrowser('http://x/', { platform: 'linux', env: {}, spawnImpl: () => { throw new Error('no'); } }), null);
  });
});
