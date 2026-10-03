#!/usr/bin/env node
// scripts/launch.mjs — cross-platform "prepare + start + open the browser", used by scripts/start-windows.bat,
// scripts/start-windows.ps1 and scripts/start.sh (docs/DEPLOY.md).
//
//   node scripts/launch.mjs [--port 3000] [--host 0.0.0.0] [--no-open] [--no-setup] [setup options…]
//
//   1. If our server already answers on the port, just open the browser (double-clicking twice is harmless).
//   2. node tools/setup.mjs --quiet (dependencies, vendor libs, art download / resume, optional local extraction);
//      setup options such as --no-assets, --no-local, --local, --game <dir>, -y are passed through.
//   3. node server/index.js (PORT / HOST from the options or the environment; SP_COMBAT / SP_VERIFY / TRUST_PROXY /
//      DEBUG are inherited), then — once /healthz answers — prints the addresses to share and opens
//      http://localhost:<port> (not with --no-open, SP_NO_BROWSER=1, or on a Linux box without a display).
//   5. With --game-server <host> the page is still served from here (interface and assets from the local disk) but the
//      match runs on that server: the browser opens http://localhost:<port>/?server=<host> and only the game protocol
//      crosses the network (public/js/gameserver.js, docs/WINDOWS.md). --push-only adds ?pushOnly=1 for the warning
//      before the remote server's /api/client-config has been read.
// Ctrl+C stops the server (it gets the signal from the terminal itself); the exit code is the server's.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
// 打开浏览器只有一份实现（走 shell 关联 = 默认浏览器，且不会把浏览器拉成提权）
import { openBrowser as openInBrowser } from './open-browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`Node.js ${process.versions.node} 太旧，需要 22 或更高（22 / 24 LTS）：https://nodejs.org/zh-cn/download`);
  process.exit(1);
}

const { c, mark } = await import('../tools/setup.mjs');
const { probePort, classifyAddresses, KIND_LABEL } = await import('../tools/doctor.mjs');

function parseArgs(argv) {
  const o = { port: Number(process.env.PORT) || 3000, host: process.env.HOST || '0.0.0.0', open: !/^(1|true|yes)$/i.test(process.env.SP_NO_BROWSER || ''), setup: true, setupArgs: [], help: false, gameServer: '', pushOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, v] = a.split('=');
    const val = () => (v !== undefined ? v : argv[++i]);
    if (k === '--port') o.port = Number(val()) || o.port;
    else if (k === '--host') o.host = val() || o.host;
    else if (a === '--no-open') o.open = false;
    else if (a === '--no-setup') o.setup = false;
    else if (k === '--game-server') o.gameServer = String(val() || '').replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
    else if (a === '--push-only') o.pushOnly = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--game') o.setupArgs.push(a, argv[++i] ?? '');
    else o.setupArgs.push(a);
  }
  return o;
}

/**
 * The URL the browser should open. Normally this server's own page; with `--game-server <host>` the page (and its
 * assets) still come from here while the match runs on that server — `?server=` tells the client where to connect
 * (public/js/gameserver.js, docs/WINDOWS.md).
 * @param {string} origin e.g. http://localhost:3000
 * @param {{ gameServer?: string, pushOnly?: boolean }} o
 */
export function browserUrl(origin, o = {}) {
  if (!o.gameServer) return origin;
  const q = new URLSearchParams({ server: o.gameServer });
  if (o.pushOnly) q.set('pushOnly', '1');
  return `${origin}/?${q}`;
}

/** The page URL as seen by the browser on this machine (`localhost`, not `0.0.0.0`). @param {number} port */
export const localPageUrl = (port) => `http://localhost:${port}`;

function openBrowser(url) {
  return openInBrowser(url) !== null;
}

function printShare(port, o = {}) {
  const line = c.dim('─'.repeat(56));
  console.log(`\n${line}`);
  if (o.gameServer) {
    // 连接服务器：页面与素材来自本机，对局在远端跑（只有游戏数据走远端，最省带宽）。
    console.log(`${mark.ok} ${c.bold('页面已就绪')}   本机打开：${c.cyan(`http://localhost:${port}`)}`);
    console.log(`  游戏服务器：${c.cyan(`https://${o.gameServer}`)} ${c.dim('（页面与素材来自本机，对局数据走远端）')}`);
    console.log(c.dim('  浏览器地址栏会是 127.0.0.1，这是正常的：素材本地读，只有游戏数据发到上面的服务器。'));
    console.log(c.dim('  邀请朋友请用游戏里「复制链接」（指向游戏服务器，不是本机）。按 Ctrl+C 停止。'));
    console.log(`${line}\n`);
    return;
  }
  const addrs = classifyAddresses().filter((a) => a.kind === 'lan' || a.kind === 'vpn' || a.kind === 'public');
  console.log(`${mark.ok} ${c.bold('服务器已启动')}   本机打开：${c.cyan(`http://localhost:${port}`)}`);
  if (addrs.length) {
    console.log('  发给朋友（需要能访问这台电脑的网络）：');
    for (const a of addrs.slice(0, 4)) console.log(`    ${c.cyan(`http://${a.address}:${port}`)}  ${c.dim(KIND_LABEL[a.kind])}`);
  } else {
    console.log(c.warn('  没有检测到局域网地址：朋友暂时无法连接（检查网线/Wi-Fi）。'));
  }
  console.log(c.dim('  建房后把 4 位「同盟密钥」或「复制链接」（…/?room=密钥）发给朋友。'));
  console.log(c.dim('  朋友打不开？运行 node tools/doctor.mjs 检查防火墙。按 Ctrl+C 停止服务器。'));
  console.log(`${line}\n`);
}

async function waitHealthy(port, child, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && child.exitCode === null) {
    const p = await probePort(port);
    if (p.state === 'ours') return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
    console.log(src.slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  const localUrl = localPageUrl(o.port);
  const pageUrl = browserUrl(localUrl, o);

  const before = await probePort(o.port, o.host);
  if (before.state === 'ours') {
    console.log(`${mark.ok} 服务器已经在运行（端口 ${o.port}），直接打开浏览器。`);
    printShare(o.port, o);
    if (o.open) openBrowser(pageUrl);
    return 0;
  }
  if (before.state !== 'free') {
    console.error(`${mark.err} 端口 ${o.port} 被其他程序占用或无权限（${before.code || before.state}）。`);
    console.error(`  换一个端口：${IS_WIN ? 'scripts\\start-windows.bat --port 3001' : 'scripts/start.sh --port 3001'}`);
    return 1;
  }

  if (o.setup) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'setup.mjs'), '--quiet', ...o.setupArgs], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) { console.error(`${mark.err} 准备步骤失败（见上方）。`); return r.status || 1; }
  }

  const env = { ...process.env, PORT: String(o.port), HOST: o.host };
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: 'inherit' });
  const forward = (sig) => { if (child.exitCode === null) { try { child.kill(sig); } catch { /* gone */ } } };
  // SIGINT reaches the server straight from the terminal (same process group / console); forwarding it too would make
  // the server's second-signal path force-exit. Other signals (service managers, `kill`) are forwarded.
  process.on('SIGINT', () => {});
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGBREAK']) { try { process.on(sig, () => forward(sig === 'SIGBREAK' ? 'SIGTERM' : sig)); } catch { /* unsupported here */ } }

  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? (signal ? 0 : 1))));
  if (await waitHealthy(o.port, child)) {
    printShare(o.port, o);
    if (o.open && !openBrowser(pageUrl)) console.log(c.dim(`（未能自动打开浏览器，请手动访问 ${pageUrl}）`));
  }
  return exited;
}

// 作为脚本运行时才启动（被 import 时只导出 browserUrl / localPageUrl 等纯函数，方便测试与复用）。
const IS_MAIN = !!process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (IS_MAIN) main().then((code) => { process.exitCode = code; }, (e) => { console.error(e?.stack || e); process.exitCode = 1; });
