#!/usr/bin/env node
// scripts/launcher.mjs — 「开箱即用」启动界面（Windows 便携版 / 任意平台同样可用）。
//
// 开始界面就在这里，两条路二选一（docs/WINDOWS.md）：
//   [1] 本机当服务器   在这台电脑上开服（scripts/launch.mjs --no-setup → server/index.js），浏览器自动打开；
//                      局域网地址会打印出来，发给朋友即可加入。退出启动器＝停止服务器。
//   [2] 连接服务器     用浏览器直接打开别人的服务器：页面、素材、对局数据都从对方来，本机不跑任何服务。
//                      地址会记住（scripts/launcher.config.json）。
//   [3] 设置           端口 / 局域网共享（HOST=0.0.0.0）
//   [4] 查看状态       本机服务器 + 上次连接的服务器：是否在跑、采用哪种战斗模式
//
// 用法：
//   node scripts/launcher.mjs                        交互菜单（双击 启动游戏.bat 也是这个）
//   node scripts/launcher.mjs --mode local           直接本机开服
//   node scripts/launcher.mjs --mode connect --server game.example.com
//   node scripts/launcher.mjs --mode status
//   --port N / --server HOST / --no-open / --no-color / --yes（跳过确认，用于脚本）
//
// 这里**没有**「本机页面 + 远端服务器」那种玩法：页面源决定了会话凭证存在哪，让一个 ?server= 参数把页面
// 指向任意主机，等于把凭证发给参数里写的那台机器（详见 PR 讨论）。连接别人的服务器就是打开对方的网页。

import readline from 'node:readline';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
// 打开浏览器的实现也只有一份（scripts/open-browser.mjs）
import { openBrowser as openInBrowser } from './open-browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'scripts', 'launcher.config.json');
const IS_WIN = process.platform === 'win32';
/** 便携版目录布局：<bundle>\node\node.exe + <bundle>\app\scripts\launcher.mjs（见 scripts/make-windows-bundle.mjs） */
const PORTABLE_NODE = path.resolve(ROOT, '..', 'node', IS_WIN ? 'node.exe' : 'node');
const DEFAULTS = { port: 3000, host: '0.0.0.0', lastName: '' };

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
/** `host[:port]` → 去掉端口与 IPv6 方括号的主机名。 */
function hostnameOf(host) {
  let h = String(host || '');
  if (h.startsWith('[')) h = h.replace(/\]:\d+$/, ']').slice(1, -1);
  else h = h.replace(/:\d+$/, '');
  return h.toLowerCase();
}

/**
 * 本机 / 局域网 / 点对点地址：这些地址没有证书，用 http 就够了。
 *
 * 含 100.64.0.0/10（CGNAT，Tailscale 就用这一段）和 26.x（Radmin VPN）——它们看着像公网 IP，实际是
 * 私有点对点网段，按 https 去连只会白等一次握手超时。
 */
export function isLocalOrPrivate(name) {
  const h = String(name || '').toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || h.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^(127|10)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;   // 100.64.0.0/10
  if (/^26\./.test(h)) return true;                                      // Radmin VPN
  return !h.includes('.');                                               // 单段主机名（局域网机器名）
}

/**
 * 解析玩家输入的服务器地址：`[scheme://]host[:port][/path]`。无效返回 null。
 *
 * 只做启动器需要的事：拿到 `host`，并判断该用 http 还是 https。没写协议时按地址推断——本机/内网用
 * http，其余域名默认 https。`encrypted` 表示玩家**显式**写了 https（连接时先试它）。
 * @param {string} raw
 * @returns {{ host: string, scheme: 'http' | 'https', secure: boolean, encrypted: boolean } | null}
 */
export function parseServer(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, '');
  if (!s) return null;
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  const scheme = m ? m[1].toLowerCase() : '';
  if (scheme && scheme !== 'http' && scheme !== 'https') return null;
  const hostport = (m ? s.slice(m[0].length) : s).replace(/[/?#].*$/, '');
  if (!hostport) return null;
  let host;
  try {
    host = new URL(`${scheme || 'https'}://${hostport}`).host;
  } catch {
    return null;
  }
  if (!host) return null;
  const secure = scheme ? scheme === 'https' : !isLocalOrPrivate(hostnameOf(host));
  return { host, scheme: secure ? 'https' : 'http', secure, encrypted: scheme === 'https' };
}

/** `scheme://host/` —— 探测与打开浏览器都用它。 */
export const originOf = (p) => `${p.scheme}://${p.host}/`;

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

/** 服务器的战斗模式；老服务器没有 /api/client-config 时退回 /healthz。 */
async function serverInfo(base) {
  const cfg = await fetchJson(base, '/api/client-config');
  if (cfg && cfg.ok) return { ...cfg, endpoint: '/api/client-config' };
  const health = await fetchJson(base, '/healthz');
  if (health && health.ok) return { ...health, endpoint: '/healthz' };
  return null;
}

/** 用玩家自己的默认浏览器打开（scripts/open-browser.mjs：走 shell 关联，从提权终端启动也不会把浏览器拉成提权）。 */
function openBrowser(url) {
  const used = openInBrowser(url);
  if (used) return true;
  // 连启动器都没法启动（无桌面 / 缺系统文件）：交给调用方打印地址
  return false;
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
  console.log(`  ${ok} ${c.bold('本机当服务器')}  端口 ${c.cyan(cfg.port)} · 局域网共享 ${cfg.host === '0.0.0.0' ? '开' : '关'}`);
  console.log(c.dim('  正在启动服务器…（Ctrl+C 停止服务器并回到菜单）'));
  console.log(`${line()}\n`);
  const args = [path.join(ROOT, 'scripts', 'launch.mjs'), '--no-setup', '--port', String(cfg.port), '--host', cfg.host];
  if (!open) args.push('--no-open');
  const child = spawn(nodeExe(), args, {
    cwd: ROOT, stdio: 'inherit',
    env: { ...process.env, PORT: String(cfg.port), HOST: cfg.host },
  });
  const code = await new Promise((resolve) => child.on('exit', (cc) => resolve(cc ?? 0)));
  console.log(`\n${ok} 服务器已停止（退出码 ${code}）。`);
  return code;
}

/**
 * 模式 2：连接服务器——用浏览器直接打开对方的服务器。
 *
 * 页面、素材、对局数据全部来自对方，本机不起任何服务。地址会记进配置，下次回车即可复用。
 * 连接别人的服务器时本机不需要几百 MB 素材，也不需要这台电脑开着。
 */
async function connect(cfg, rawAddr, { open = true, yes = false } = {}) {
  const input = rawAddr || await ask('服务器地址（例如 game.example.com）', cfg.lastName);
  if (!input) return 1;
  const parsed = parseServer(input);
  if (!parsed) { console.log(`${err} 地址无效：${input}`); return 1; }

  // 先试按地址推断出来的那个协议：本机/内网用 http，省掉一次必然失败的 https 握手
  const candidates = [originOf(parsed), `${parsed.secure ? 'http' : 'https'}://${parsed.host}/`];
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

  saveConfig({ ...cfg, lastName: input });
  console.log(`\n  ${ok} ${c.bold('连接服务器')}  ${c.cyan(chosen)} ${c.dim(`(来自 ${info.endpoint})`)}`);
  if (!parseServer(chosen)?.secure) {
    console.log(`  ${warn} 未加密的 http 连接：局域网自建没问题，公网服务器建议用 https。`);
  }

  if (!open) { console.log(c.dim(`  请手动访问 ${chosen}`)); return 0; }
  if (!yes) {
    const ans = await ask(`用浏览器打开 ${chosen} ？[Y/n]`, 'Y');
    if (/^(n|no|否)$/i.test(ans)) return 0;
  }
  if (!openBrowser(chosen)) { console.log(`${warn} 未能自动打开浏览器，请手动访问 ${chosen}`); return 1; }
  console.log(c.dim('  已在浏览器中打开。'));
  return 0;
}

/** 模式 4：查看状态。 */
async function showStatus(cfg) {
  const localBase = `http://127.0.0.1:${cfg.port}/`;
  const local = await serverInfo(localBase);
  console.log(`\n${line()}`);
  console.log(`  ${c.bold('本机服务器')}  ${localBase}`);
  if (!local) console.log(`  ${c.dim('未运行')}（在菜单里选 [1] 启动）`);
  else console.log(`  ${ok} 运行中 · 战斗模式 ${local.combatMode === 'server' ? '服务器推流' : '各客户端自算'}`);
  if (cfg.lastName) {
    const last = parseServer(cfg.lastName);
    const remote = last ? await serverInfo(originOf(last)) : null;
    console.log(`\n  ${c.bold('上次连接')}  ${cfg.lastName}`);
    if (!remote) console.log(`  ${c.dim('无响应')}`);
    else console.log(`  ${ok} 在线 · 战斗模式 ${remote.combatMode === 'server' ? '服务器推流' : '各客户端自算'}`);
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
    console.log(`   [2] 局域网共享      ${cfg.host === '0.0.0.0' ? '开（朋友可以连这台电脑）' : '关（只有本机能连）'}`);
    console.log('   [0] 返回');
    console.log(line());
    const a = await ask('选择：', '0');
    if (a === '1') {
      const p = await ask('端口（1-65535）', String(cfg.port));
      const n = Number(p);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) { cfg.port = n; saveConfig(cfg); }
      else console.log(`${err} 端口无效`);
    } else if (a === '2') {
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
    console.log(`  ${c.dim(`端口 ${cfg.port} · 局域网共享 ${cfg.host === '0.0.0.0' ? '开' : '关'}`)}`);
    console.log('');
    console.log(`   ${c.cyan('[1]')} 本机当服务器  ${c.dim('在这台电脑开服，浏览器自动打开，可把局域网地址发给朋友')}`);
    console.log(`   ${c.cyan('[2]')} 连接服务器    ${c.dim('用浏览器直接打开别人的服务器（页面与素材从对方下载）')}`);
    console.log(`   ${c.cyan('[3]')} 设置          ${c.dim('端口 / 局域网共享')}`);
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
  const o = { mode: '', port: 0, server: '', open: !/^(1|true|yes)$/i.test(process.env.SP_NO_BROWSER || ''), yes: argv.includes('--yes') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, v] = a.split('=');
    const val = () => (v !== undefined ? v : argv[++i]);
    if (k === '--mode') o.mode = String(val() || '').toLowerCase();
    else if (k === '--port') o.port = Number(val()) || 0;
    else if (k === '--server') o.server = String(val() || '');
    else if (a === '--no-open') o.open = false;
    else if (a === '-h' || a === '--help') o.mode = 'help';
  }
  return o;
}

const HELP = `scripts/launcher.mjs — 开箱即用启动界面

  node scripts/launcher.mjs                         交互菜单（开始界面）
  node scripts/launcher.mjs --mode local            本机当服务器（起服务器 + 开浏览器）
  node scripts/launcher.mjs --mode connect --server game.example.com
                                                    连接服务器：用浏览器直接打开对方的服务器
  node scripts/launcher.mjs --mode status           本机与上次连接的服务器状态
  node scripts/launcher.mjs --mode settings         设置（也可以用菜单 [3]）
  --port N  覆盖端口   --no-open 不开浏览器   --yes 跳过确认   --no-color

  详见 README 与 docs/WINDOWS.md。`;

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.mode === 'help') { console.log(HELP); return 0; }
  const cfg = loadConfig();
  if (o.port) cfg.port = o.port;

  console.log(`\n${line()}`);
  console.log(`  ${c.bold('卫戍协议：盟约 · Stronghold Protocol')}  ${c.dim(`启动器 · Node ${process.versions.node}${nodeExe() !== process.execPath ? ' · 便携版' : ''}`)}`);
  console.log(line());

  if (o.mode === 'local') return runLocal(cfg, { open: o.open });
  if (o.mode === 'connect') return connect(cfg, o.server, { open: o.open, yes: o.yes });
  if (o.mode === 'status') { const code = await showStatus(cfg); if (!process.stdin.isTTY) return code; await pause(); return code; }
  if (o.mode === 'settings') { await settings(cfg); return 0; }
  if (!process.stdin.isTTY) { console.log(HELP); return 0; }   // 非交互（脚本/CI）：打印用法而不是卡在菜单
  saveConfig(cfg);
  return menu(cfg);
}

// 与 scripts/launch.mjs、tools/setup.mjs 同一约定：被 import 时（测试、工具）不启动界面。
function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  main().then((code) => { process.exitCode = code ?? 0; }, (e) => { console.error(e?.stack || e); process.exitCode = 1; });
}
