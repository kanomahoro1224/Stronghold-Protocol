#!/usr/bin/env node
// scripts/launcher.mjs — 「开箱即用」启动界面（Windows 便携版 / 任意平台同样可用）。
//
// 开始界面就在这里，两条路二选一（docs/WINDOWS.md）：
//   [1] 本机当服务器   在这台电脑上开服（scripts/launch.mjs --no-setup → server/index.js），浏览器自动打开；
//                      局域网地址会打印出来，发给朋友即可加入。退出启动器＝停止服务器。
//   [2] 连接服务器     只打开浏览器连别人的服务器，本机不跑任何服务；地址会记住（scripts/launcher.config.json）。
//                      若对方开启了省流量模式（SP_PUSH_ONLY），会要求 https，本启动器与网页都会拦下来。
//   [3] 设置           端口 / 省流量模式（SP_PUSH_ONLY）/ 局域网共享（HOST=0.0.0.0）
//   [4] 查看状态       本机服务器 + 上次连接的服务器：是否在跑、是否省流量模式、证书/加密情况
//
// 用法：
//   node scripts/launcher.mjs                        交互菜单（双击 启动游戏.bat 也是这个）
//   node scripts/launcher.mjs --mode local           直接本机开服
//   node scripts/launcher.mjs --mode connect --server game.example.com
//   node scripts/launcher.mjs --mode status
//   --port N / --server HOST / --no-open / --no-color / --yes（跳过确认，用于脚本）
//
// 省流量模式（服务器环境变量 SP_PUSH_ONLY=1，见 README「环境变量」）：战斗由服务器模拟并推流，客户端只发操作，
// 上行流量几乎为零。它花费服务器带宽，所以只接受安全上下文——https，或浏览器所在的本机
// （http://127.0.0.1 也算安全上下文）。局域网/公网用普通 http 会被服务器 403 拒绝。

import readline from 'node:readline';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
// 地址与安全判断只有一套：和开始界面（页面里）共用同一个模块，避免两边规则漂移。
import { parseServer } from '../public/js/gameserver.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'scripts', 'launcher.config.json');
const IS_WIN = process.platform === 'win32';
/** 便携版目录布局：<bundle>\node\node.exe + <bundle>\app\scripts\launcher.mjs（见 scripts/make-windows-bundle.mjs） */
const PORTABLE_NODE = path.resolve(ROOT, '..', 'node', IS_WIN ? 'node.exe' : 'node');
const DEFAULTS = { port: 3000, host: '0.0.0.0', pushOnly: false, lastName: '' };

// ---- 输出 ------------------------------------------------------------------------------------------------------
const useColor = !process.argv.includes('--no-color') && process.stdout.isTTY && (process.stdout.hasColors?.() ?? false);
const paint = (code) => (s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const c = {
  bold: paint('1'), dim: paint('2'), red: paint('31'), green: paint('32'), yellow: paint('33'), cyan: paint('36'),
};
const ok = `${c.green('✔')}`;
const warn = `${c.yellow('!')}`;
const err = `${c.red('✖')}`;
const line = (n = 64) => c.dim('─'.repeat(n));

/** 一行提示后等待回车（菜单里也用来防止刷屏）。 */
function pause(msg = '按回车返回菜单 / Press Enter') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(c.dim(`  ${msg} `), () => { rl.close(); resolve(); }));
}

function ask(question, def = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const hint = def ? c.dim(`（回车＝${def}）`) : '';
    rl.question(`  ${question}${hint} `, (a) => { rl.close(); resolve(String(a || '').trim() || def); });
  });
}

// ---- 配置 ------------------------------------------------------------------------------------------------------
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
  } catch (e) {
    console.log(`${warn} 配置无法写入 ${CONFIG_PATH}：${e?.message || e}`);
  }
}

// ---- 地址 / 探测 -----------------------------------------------------------------------------------------------
/**
 * 把用户输入的地址规范成 URL。域名一律先按 https 试（省流量模式必须 https），本机/内网地址用 http。
 * @param {string} raw
 * @param {'https' | 'http'} [scheme] 强制协议；不给则按地址推断（内网 http、其余 https）
 */
function toUrl(raw, scheme) {
  let s = String(raw || '').trim().replace(/\s+/g, '');
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `${scheme || parseServer(s)?.scheme || 'https'}://${s}`;
  try {
    const u = new URL(s);
    return u.host ? `${u.protocol}//${u.host}/` : '';
  } catch {
    return '';
  }
}

/** 带超时的 JSON GET；失败返回 null。 */
async function fetchJson(base, apiPath, timeoutMs = 5000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(new URL(apiPath, base), { signal: ctrl.signal, headers: { accept: 'application/json' }, cache: 'no-store' });
    clearTimeout(timer);
    if (!res.ok) return { status: res.status };
    return await res.json();
  } catch {
    return null;
  }
}

/** 服务器的省流量模式 / 战斗模式；老服务器没有 /api/client-config 时退回 /healthz。 */
async function serverInfo(base) {
  const cfg = await fetchJson(base, '/api/client-config');
  if (cfg && cfg.ok) return { ...cfg, endpoint: '/api/client-config' };
  const health = await fetchJson(base, '/healthz');
  if (health && health.ok) return { ...health, combatMode: health.pushOnly ? 'server' : 'client', endpoint: '/healthz' };
  return null;
}

function openBrowser(url) {
  try {
    let cmd; let args;
    if (IS_WIN) { cmd = 'rundll32'; args = ['url.dll,FileProtocolHandler', url]; }
    else if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
    else {
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
      cmd = 'xdg-open'; args = [url];
    }
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** 便携版自带的 node（<bundle>\node\node.exe），没有就用当前进程的 node。 */
function nodeExe() {
  try {
    if (fs.existsSync(PORTABLE_NODE)) return PORTABLE_NODE;
  } catch { /* ignore */ }
  return process.execPath;
}

// ---- 各项功能 --------------------------------------------------------------------------------------------------
/** 模式 1：本机当服务器（scripts/launch.mjs 起服务器 + 开浏览器，Ctrl+C 停止）。 */
async function runLocal(cfg, { open = true } = {}) {
  console.log(`\n${line()}`);
  console.log(`  ${ok} ${c.bold('本机当服务器')}  端口 ${c.cyan(cfg.port)} · 局域网共享 ${cfg.host === '0.0.0.0' ? '开' : '关'} · 省流量模式 ${cfg.pushOnly ? c.yellow('开') : '关'}`);
  if (cfg.pushOnly) {
    console.log(`  ${warn} 省流量模式要求安全上下文：只有 ${c.cyan(`http://127.0.0.1:${cfg.port}`)}（本机）或 https 能进游戏。`);
    if (cfg.host === '0.0.0.0') console.log(`  ${warn} 局域网朋友用 http://<你的IP>:${cfg.port} 会被拒绝（403）。要给他们玩请先关掉省流量模式，或让他们用 https。`);
  }
  console.log(c.dim('  正在启动服务器…（Ctrl+C 停止服务器并回到菜单）'));
  console.log(`${line()}\n`);
  const args = [path.join(ROOT, 'scripts', 'launch.mjs'), '--no-setup', '--port', String(cfg.port), '--host', cfg.host];
  if (!open) args.push('--no-open');
  const child = spawn(nodeExe(), args, {
    cwd: ROOT, stdio: 'inherit',
    env: { ...process.env, PORT: String(cfg.port), HOST: cfg.host, SP_PUSH_ONLY: cfg.pushOnly ? '1' : '0' },
  });
  const code = await new Promise((resolve) => child.on('exit', (cc) => resolve(cc ?? 0)));
  console.log(`\n${ok} 服务器已停止（退出码 ${code}）。`);
  return code;
}

/**
 * 模式 2：连接服务器——**页面和素材走本机，对局数据走远端**。
 *
 * 浏览器打开的是 `http://127.0.0.1:<port>/?server=<远端>`（本机页面服务只监听本机，局域网看不到），
 * 客户端据此把 WebSocket 连到远端服务器（public/js/gameserver.js）。这样连别人的服务器时不必再把几十 MB
 * 素材从远端下载一遍，实测只有游戏数据过网络；配合远端的省流量模式最省带宽。
 * 传 `{ page: false }` 则退回旧行为：什么都不在本机跑，直接用浏览器打开远端网页。
 */
async function connect(cfg, rawAddr, { open = true, yes = false, page = true } = {}) {
  const input = rawAddr || await ask('服务器地址（例如 game.example.com）', cfg.lastName);
  if (!input) return 1;
  // 判断协议与 start 界面用的是同一套规则（public/js/gameserver.js）：https 或本机/内网（没证书，用 http）。
  const parsed = parseServer(input);
  if (!parsed) { console.log(`${err} 地址无效：${input}`); return 1; }
  const https = toUrl(input, 'https');
  const http = toUrl(input, 'http');
  if (!https || !http) { console.log(`${err} 地址无效：${input}`); return 1; }

  const candidates = parsed.encrypted ? [https, http] : [http, https];   // 内网先试 http，省一次必然失败的探测
  let chosen = null; let info = null;
  for (const base of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const got = await serverInfo(base);
    if (got) { chosen = base; info = got; break; }
    console.log(c.dim(`  ${base} 无响应…`));
  }
  if (!chosen) {
    console.log(`${err} 连不上这台服务器：${input}`);
    console.log(c.dim('  确认地址写对了、对方服务器在跑；本机服务器请用 [1] 启动。'));
    return 1;
  }
  const target = parseServer(chosen);
  if (info.pushOnly && !target.secure) {
    console.log(`${err} 该服务器已开启省流量模式（SP_PUSH_ONLY），只接受 https 或本机访问。`);
    console.log(c.dim('  请改用 https 地址，或请管理员关闭该功能（SP_PUSH_ONLY=0）。'));
    return 1;
  }
  const insecureWarning = !target.secure;

  saveConfig({ ...cfg, lastName: input });
  console.log(`\n  ${ok} ${c.bold('连接服务器')}  ${c.cyan(chosen)}  ${info.pushOnly ? c.yellow('省流量模式') : c.dim('标准模式')} ${c.dim(`(来自 ${info.endpoint})`)}`);
  if (insecureWarning) console.log(`  ${warn} 未加密的 http 连接：省流量模式在别人开启时会拒绝，请尽量用 https。`);

  // 旧行为：不在本机跑任何东西，直接打开远端网页（素材也从远端下载）。
  if (!page) {
    if (!open) return 0;
    if (!yes) {
      const ans = await ask(`用浏览器打开 ${chosen} ？[Y/n]`, 'Y');
      if (/^(n|no|否)$/i.test(ans)) return 0;
    }
    if (!openBrowser(chosen)) { console.log(`${warn} 未能自动打开浏览器，请手动访问 ${chosen}`); return 1; }
    console.log(c.dim('  已在浏览器中打开。'));
    return 0;
  }

  const host = target.host;
  const pageBase = `http://127.0.0.1:${cfg.port}`;
  const pageUrl = `${pageBase}/?server=${encodeURIComponent(host)}${info.pushOnly ? '&pushOnly=1' : ''}`;
  console.log(`  页面与素材：${c.cyan(pageBase)} ${c.dim('（本机读，局域网看不到）')}`);
  console.log(`  对局数据：  ${c.cyan(chosen)} ${c.dim('（只有游戏数据过网络）')}`);
  if (open && !yes) {
    const ans = await ask(`在本机浏览器打开 ${pageBase} 并连到上面这台服务器？[Y/n]`, 'Y');
    if (/^(n|no|否)$/i.test(ans)) return 0;
  }
  console.log(c.dim('  正在启动本机页面服务…（Ctrl+C 结束）'));
  const args = [
    path.join(ROOT, 'scripts', 'launch.mjs'), '--no-setup', '--port', String(cfg.port), '--host', '127.0.0.1',
    '--game-server', host,
  ];
  if (info.pushOnly) args.push('--push-only');
  if (!open) args.push('--no-open');
  const child = spawn(nodeExe(), args, {
    cwd: ROOT, stdio: 'inherit',
    env: { ...process.env, PORT: String(cfg.port), HOST: '127.0.0.1', SP_PUSH_ONLY: '0' },
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
  // 本机页面服务起不来（端口被占等）就别卡住：直接退回「打开远端网页」，照样能玩。
  if (!(await waitPageUp(cfg.port, exited))) {
    console.log(`\n${warn} 本机页面服务没能启动（端口 ${cfg.port} 可能被占用），改为直接打开远端网页。`);
    console.log(c.dim(`  素材将从 ${chosen} 下载；想省带宽请换端口：启动器 [3] 设置。`));
    if (open) openBrowser(chosen);
    return 0;
  }
  console.log(`${ok} 已就绪：${pageUrl}`);
  console.log(c.dim('  浏览器地址栏是本机 127.0.0.1，这是正常的：界面与素材本地读，只有游戏数据发到远端。'));
  console.log(c.dim('  邀请朋友请用游戏里的「复制链接」（指向远端服务器，不是你的本机）。'));
  const code = await exited;
  console.log(`\n${ok} 本机页面服务已停止（退出码 ${code}）。`);
  return code;
}

/**
 * 等本机页面服务就绪：`/healthz` 有响应即成功；进程先退出则失败。
 * @param {number} port
 * @param {Promise<number>} exited
 * @returns {Promise<boolean>}
 */
async function waitPageUp(port, exited, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let dead = false;
  exited.then(() => { dead = true; });
  while (Date.now() < deadline) {
    if (dead) return false;
    // eslint-disable-next-line no-await-in-loop
    if (await fetchJson(`http://127.0.0.1:${port}/`, '/healthz', 1500)) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** 模式 4：查看状态。 */
async function showStatus(cfg) {
  const localBase = `http://127.0.0.1:${cfg.port}/`;
  const local = await serverInfo(localBase);
  console.log(`\n${line()}`);
  console.log(`  ${c.bold('本机服务器')}  ${localBase}`);
  if (!local) console.log(`  ${c.dim('未运行')}（在菜单里选 [1] 启动）`);
  else console.log(`  ${ok} 运行中 · 战斗模式 ${local.combatMode === 'server' ? '服务器推流（省流量）' : '各客户端自算'} · 省流量模式 ${local.pushOnly ? c.yellow('开') : '关'}`);
  if (local && local.pushOnly && cfg.host === '0.0.0.0') {
    console.log(`  ${warn} 省流量模式 + 局域网共享：朋友用 http://<你的IP>:${cfg.port} 会被 403 拒绝。`);
  }
  if (cfg.lastName) {
    const remote = await serverInfo(toUrl(cfg.lastName) || '');
    console.log(`\n  ${c.bold('上次连接')}  ${cfg.lastName}`);
    if (!remote) console.log(`  ${c.dim('无响应')}`);
    else console.log(`  ${ok} 在线 · 战斗模式 ${remote.combatMode === 'server' ? '服务器推流（省流量）' : '各客户端自算'} · 省流量模式 ${remote.pushOnly ? c.yellow('开') : '关'}`);
  }
  console.log(line());
  return 0;
}

/** 模式 3：设置。 */
async function settings(cfg) {
  for (;;) {
    console.log(`\n${line()}`);
    console.log(`  ${c.bold('设置')}`);
    console.log(`   [1] 端口            ${c.cyan(cfg.port)}`);
    console.log(`   [2] 省流量模式      ${cfg.pushOnly ? c.yellow('开（服务器模拟并推流，省客户端上行）') : '关'}`);
    console.log(`   [3] 局域网共享      ${cfg.host === '0.0.0.0' ? '开（朋友可以连这台电脑）' : '关（只有本机能连）'}`);
    console.log('   [0] 返回');
    console.log(line());
    const a = await ask('选择：', '0');
    if (a === '1') {
      const p = await ask('端口（1-65535）', String(cfg.port));
      const n = Number(p);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) { cfg.port = n; saveConfig(cfg); }
      else console.log(`${err} 端口无效`);
    } else if (a === '2') {
      cfg.pushOnly = !cfg.pushOnly;
      saveConfig(cfg);
      if (cfg.pushOnly) {
        console.log(`\n  ${warn} 已开启省流量模式：战斗由服务器模拟并推流，客户端只发操作（更省带宽），但服务器 CPU/带宽上升。`);
        console.log(`  ${warn} 只有 https 或本机 ${c.cyan(`http://127.0.0.1:${cfg.port}`)} 能开始游戏；普通 http 的局域网/公网访问会在浏览器里`);
        console.log('     弹出警告并禁止开始（服务器同时返回 403）。');
      } else {
        console.log(`  ${ok} 已关闭省流量模式：每个客户端自己模拟战斗（标准模式，服务器负载最低）。`);
      }
    } else if (a === '3') {
      cfg.host = cfg.host === '0.0.0.0' ? '127.0.0.1' : '0.0.0.0';
      saveConfig(cfg);
      console.log(cfg.host === '0.0.0.0'
        ? `  ${ok} 已开启局域网共享：朋友用 http://<你的IP>:${cfg.port} 加入（防火墙可能需要放行）。`
        : `  ${ok} 已关闭局域网共享：服务器只监听 127.0.0.1。`);
    } else return 0;
  }
}

/** 交互菜单（开始界面）。 */
async function menu(cfg) {
  for (;;) {
    console.log(`\n${line()}`);
    console.log(`  ${c.bold('卫戍协议：盟约 · Stronghold Protocol')}  ${c.dim('启动器')}`);
    console.log(`  ${c.dim(`端口 ${cfg.port} · 局域网共享 ${cfg.host === '0.0.0.0' ? '开' : '关'} · 省流量模式 ${cfg.pushOnly ? '开' : '关'}`)}`);
    console.log('');
    console.log(`   ${c.cyan('[1]')} 本机当服务器  ${c.dim('在这台电脑开服，浏览器自动打开，可把局域网地址发给朋友')}`);
    console.log(`   ${c.cyan('[2]')} 连接服务器    ${c.dim('页面与素材走本机，只有对局数据连别人的服务器（最省带宽）')}`);
    console.log(`   ${c.cyan('[3]')} 设置          ${c.dim('端口 / 省流量模式 / 局域网共享')}`);
    console.log(`   ${c.cyan('[4]')} 查看状态`);
    console.log(`   ${c.cyan('[0]')} 退出`);
    console.log(line());
    const a = (await ask('选择：')).toLowerCase();
    if (a === '1' || a === 'local') await runLocal(cfg);
    else if (a === '2' || a === 'connect') await connect(cfg);
    else if (a === '3' || a === 'settings') await settings(cfg);
    else if (a === '4' || a === 'status') { await showStatus(cfg); await pause(); }
    else if (a === '0' || a === 'q' || a === 'exit') return 0;
    else if (a) console.log(`${warn} 请输入 0-4`);
  }
}

// ---- CLI -------------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { mode: '', port: 0, server: '', open: !/^(1|true|yes)$/i.test(process.env.SP_NO_BROWSER || ''), yes: argv.includes('--yes'), page: !argv.includes('--no-page') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, v] = a.split('=');
    const val = () => (v !== undefined ? v : argv[++i]);
    if (k === '--mode') o.mode = String(val() || '').toLowerCase();
    else if (k === '--port') o.port = Number(val()) || 0;
    else if (k === '--server') o.server = String(val() || '');
    else if (a === '--no-open') o.open = false;
    else if (a === '--no-page') o.page = false;
    else if (a === '-h' || a === '--help') o.mode = 'help';
  }
  return o;
}

const HELP = `scripts/launcher.mjs — 开箱即用启动界面

  node scripts/launcher.mjs                         交互菜单（开始界面）
  node scripts/launcher.mjs --mode local            本机当服务器（起服务器 + 开浏览器）
  node scripts/launcher.mjs --mode connect --server game.example.com
                                                    连接服务器：本机只发页面与素材，对局数据连远端
  node scripts/launcher.mjs --mode status           本机与上次连接的服务器状态
  node scripts/launcher.mjs --mode settings         设置（也可以用菜单 [3]）
  --port N  覆盖端口   --no-open 不开浏览器   --yes 跳过确认   --no-color
  --no-page        连接服务器时不启本机页面服务，直接用浏览器打开远端网页（素材也从远端下载）
  --game-server H  （launch.mjs）页面从本机发，客户端连到 H
  --push-only      （launch.mjs）预先告知客户端远端开了省流量模式

  省流量模式（服务器 SP_PUSH_ONLY=1）需要安全上下文：https，或本机 http://127.0.0.1。
  详见 README「环境变量」与 docs/WINDOWS.md。`;

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.mode === 'help') { console.log(HELP); return 0; }
  const cfg = loadConfig();
  if (o.port) cfg.port = o.port;
  if (process.env.SP_PUSH_ONLY != null) cfg.pushOnly = /^(1|true|yes|on)$/i.test(process.env.SP_PUSH_ONLY);

  console.log(`\n${line()}`);
  console.log(`  ${c.bold('卫戍协议：盟约 · Stronghold Protocol')}  ${c.dim(`启动器 · Node ${process.versions.node}${nodeExe() !== process.execPath ? ' · 便携版' : ''}`)}`);
  console.log(line());

  if (o.mode === 'local') return runLocal(cfg, { open: o.open });
  if (o.mode === 'connect') return connect(cfg, o.server, { open: o.open, yes: o.yes, page: o.page });
  if (o.mode === 'status') { const code = await showStatus(cfg); if (!process.stdin.isTTY) return code; await pause(); return code; }
  if (o.mode === 'settings') { await settings(cfg); return 0; }
  if (!process.stdin.isTTY) { console.log(HELP); return 0; }   // 非交互（脚本/CI）：打印用法而不是卡在菜单
  saveConfig(cfg);
  return menu(cfg);
}

main().then((code) => { process.exitCode = code ?? 0; }, (e) => { console.error(e?.stack || e); process.exitCode = 1; });
