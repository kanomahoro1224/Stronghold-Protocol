#!/usr/bin/env node
// scripts/make-windows-bundle.mjs — 打一份「开箱即用」的 Windows 便携包（docs/WINDOWS.md）。
//
//   node scripts/make-windows-bundle.mjs [--out <dir>] [--zip] [--no-node] [--with-tests] [--force]
//                                       [--node-version 22.x|latest-v22.x|<vX.Y.Z>]
//
// 产物目录（默认 <仓库的上一级>\Stronghold-Protocol-Windows）：
//   node\node.exe            官方 Windows x64 便携版 Node（只取 node.exe；版本从 nodejs.org 校验 sha256）
//   app\                     整个游戏：代码 + node_modules + public（含全部素材）+ data，离线可玩
//   app\scripts\launcher.mjs 开始界面（本机当服务器 / 连接服务器 / 设置 / 状态）
//   启动游戏.bat             菜单（开始界面）
//   本机当服务器.bat         ← 直接当服务器
//   连接服务器.bat           ← 直接连别人的服务器
//   README-开箱即用.md       给玩家看的说明
//
// 目标机器什么都不用装：解压 → 双击 启动游戏.bat。素材约 330 MB 是硬成本，包因此较大。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const MB = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** app\ 里不要带上的东西：版本库、缓存、日志、测试、本机配置、打包中间产物。 */
const SKIP_DIRS = new Set(['.git', '.cache', 'logs', 'test', 'node_modules/.cache', '.toolchain', 'mobile/build']);
const SKIP_FILES = new Set(['scripts/launcher.config.json', '.DS_Store', 'Thumbs.db', 'desktop.ini']);

function parseArgs(argv) {
  const o = { out: '', zip: false, node: true, tests: false, force: false, nodeSpec: 'latest-v22.x', webfonts: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, v] = a.split('=');
    const val = () => (v !== undefined ? v : argv[++i]);
    if (k === '--out') o.out = String(val() || '');
    else if (k === '--node-version') o.nodeSpec = String(val() || 'latest-v22.x');
    else if (a === '--zip') o.zip = true;
    else if (a === '--no-node') o.node = false;
    else if (a === '--with-tests') o.tests = true;
    else if (a === '--keep-webfonts') o.webfonts = true;
    else if (a === '--force') o.force = true;
    else if (a === '-h' || a === '--help') o.help = true;
  }
  return o;
}

const HELP = `node scripts/make-windows-bundle.mjs — 生成 Windows 开箱即用便携包

  --out <dir>        产物目录（默认 <仓库上一级>/Stronghold-Protocol-Windows）
  --zip              额外压成 <out>.zip（用系统 tar/bsdtar）
  --no-node          不下载便携版 Node（目标机器需自备 Node 22+）
  --with-tests       连 test/ 一起打包（默认不打，省体积）
  --keep-webfonts    保留 index.html 里的 Google Fonts 外链（默认去掉，见下）
  --force            目录已存在时先删掉
  --node-version X   Node 版本：latest-v22.x（默认）| v22.20.0 …

  默认去掉 https://fonts.googleapis.com 的外链：便携包里已自带 /fonts（Bender / Novecento Wide），
  而 Google Fonts 在国内通常不可达 —— 留着只是白等十几个请求。标题/正文字体会退回系统黑体（本来就是
  多数国内玩家的实际效果）。想保留外链（能上 Google 时更好看）加 --keep-webfonts。
`;

/**
 * 便携包默认去掉 index.html 里的 Google Fonts 外链（preconnect + css2 stylesheet）。
 * 只删这两条 <link>，其余原样；找不到就原样返回。
 * @param {string} html
 * @returns {{ html: string, removed: number }}
 */
export function stripWebfonts(html) {
  let removed = 0;
  const out = html.replace(/^[ \t]*<link[^>]*fonts\.(googleapis|gstatic)\.com[^>]*>\r?\n?/gm, () => { removed++; return ''; });
  return { html: out, removed };
}

/** 递归复制，按 skip 表过滤（跨平台，保留目录结构）。 */
async function copyTree(src, dst, rel = '') {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  let files = 0; let bytes = 0;
  for (const e of entries) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    const skipped = e.isDirectory() ? SKIP_DIRS.has(r) || SKIP_DIRS.has(e.name) : SKIP_FILES.has(r) || SKIP_FILES.has(e.name);
    if (skipped) continue;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      const sub = await copyTree(from, to, r);
      files += sub.files; bytes += sub.bytes;
    } else if (e.isFile()) {
      await fsp.copyFile(from, to);
      const st = await fsp.stat(to);
      files++; bytes += st.size;
    }
  }
  return { files, bytes };
}

async function dirSize(dir) {
  let bytes = 0; let files = 0;
  const walk = async (d) => {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) { files++; try { bytes += (await fsp.stat(p)).size; } catch { /* ignore */ } }
    }
  };
  await walk(dir);
  return { bytes, files };
}

/** 便携版 Node：取官方 zip 里的 node.exe（版本与 sha256 都对着 nodejs.org 的 SHASUMS 校验）。 */
async function downloadPortableNode(bundleNodeDir, spec) {
  const base = spec.startsWith('latest') ? `https://nodejs.org/dist/${spec}/` : `https://nodejs.org/dist/${spec.startsWith('v') ? spec : `v${spec}`}/`;
  console.log(`  · 读取 ${base}SHASUMS256.txt`);
  const sums = await (await fetch(`${base}SHASUMS256.txt`)).text();
  const entry = sums.split('\n').map((l) => l.trim()).find((l) => /node-v[\d.]+-win-x64\.zip$/.test(l));
  if (!entry) throw new Error(`在 ${base}SHASUMS256.txt 里没找到 win-x64.zip`);
  const [wantHash, zipName] = entry.split(/\s+/);
  const version = /node-(v[\d.]+)-win-x64\.zip$/.exec(zipName)[1];

  const cacheDir = path.join(os.tmpdir(), 'sp-node-cache');
  await fsp.mkdir(cacheDir, { recursive: true });
  const zipPath = path.join(cacheDir, zipName);
  let have = false;
  if (fs.existsSync(zipPath)) {
    const h = crypto.createHash('sha256').update(await fsp.readFile(zipPath)).digest('hex');
    have = h === wantHash;
    if (!have) console.log(`  · 缓存校验失败，重新下载 ${zipName}`);
  }
  if (!have) {
    console.log(`  · 下载 ${zipName}（约 30 MB）`);
    const res = await fetch(`${base}${zipName}`);
    if (!res.ok) throw new Error(`下载失败 ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== wantHash) throw new Error(`${zipName} sha256 不匹配：${got} ≠ ${wantHash}`);
    await fsp.writeFile(zipPath, buf);
  }

  const unpack = path.join(cacheDir, zipName.replace(/\.zip$/, ''));
  const nodeExe = path.join(unpack, zipName.replace(/\.zip$/, ''), IS_WIN ? 'node.exe' : 'bin/node');
  if (!fs.existsSync(nodeExe)) {
    await fsp.rm(unpack, { recursive: true, force: true });
    await fsp.mkdir(unpack, { recursive: true });
    // Windows 10+ 自带 bsdtar，能直接解 zip；没有就退回 Expand-Archive。
    let r = spawnSync('tar', ['-xf', zipPath, '-C', unpack], { stdio: 'inherit' });
    if (r.error || r.status !== 0) {
      r = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${unpack}' -Force`], { stdio: 'inherit' });
    }
    if (r.error || r.status !== 0) throw new Error('解压 Node 失败（没有可用的 tar 或 PowerShell）');
  }
  await fsp.mkdir(bundleNodeDir, { recursive: true });
  await fsp.copyFile(nodeExe, path.join(bundleNodeDir, IS_WIN ? 'node.exe' : 'node'));
  return { version, bytes: (await fsp.stat(path.join(bundleNodeDir, IS_WIN ? 'node.exe' : 'node'))).size };
}

/** 开始界面用的 .bat（内容保持纯 ASCII，中文只出现在文件名与 Node 菜单里）。 */
function bat(body) {
  return `@echo off\r\nchcp 65001 >nul\r\nsetlocal\r\nset "HERE=%~dp0"\r\nset "NODE="\r\nif exist "%HERE%node\\node.exe" set "NODE=%HERE%node\\node.exe"\r\nif not defined NODE set "NODE=node"\r\n${body}\r\nset "CODE=%ERRORLEVEL%"\r\nif not "%CODE%"=="0" pause\r\nexit /b %CODE%\r\n`;
}

const README = (version) => `# 卫戍协议：盟约 · Windows 开箱即用包

解压后**双击 \`启动游戏.bat\`** 即可，目标机器不需要安装 Node、不需要联网下载素材。
这个包**不访问外网**：字体用包内自带的 \`app\\public\\fonts\`（Bender / Novecento Wide），
原版页面里指向 \`fonts.googleapis.com\` 的外链已去掉（想保留：重新打包时加 \`--keep-webfonts\`）；
中文会退回系统自带的黑体，和没有代理时上 Google 的效果一致。

## 开始界面（启动器菜单）

\`\`\`
[1] 本机当服务器   在这台电脑开服，浏览器自动打开；把打印出来的局域网地址发给朋友即可加入
[2] 连接服务器     输入别人的服务器地址（例如 game.example.com）；页面与素材仍从本机读，
                   只有对局数据连对方服务器——比直接开对方网页省下几十 MB 素材流量
[3] 设置           端口 / 省流量模式 / 局域网共享
[4] 查看状态       本机服务器与上次连接的服务器是否在跑、是否省流量模式
\`\`\`

也可以直接双击 \`本机当服务器.bat\` 或 \`连接服务器.bat\`，等于菜单里的 [1] / [2]。

选 [2] 后浏览器地址栏会是 **\`http://127.0.0.1:端口/?server=对方地址\`**（本机页面服务只监听本机，局域网看不到）：
界面和全部素材从本地硬盘读，只有游戏数据（WebSocket）发到对方服务器。因此邀请朋友要用游戏里的「复制链接」
（它指向对方服务器，不会把你的 127.0.0.1 发出去）。想让浏览器直接打开对方网页、不要本机这层页面服务，用
\`连接服务器.bat --no-page\`（素材则会从对方服务器下载）。

## 省流量模式（服务器设置）

省流量模式下**战斗由服务器模拟并推流**，客户端只发送操作，上行流量几乎为零——适合流量/带宽紧张的场景。
它花费服务器的带宽与 CPU，所以由服务器端开关（环境变量 \`SP_PUSH_ONLY=1\`）：

* 开启后**只有 https 或本机 \`http://127.0.0.1\` 能开始游戏**（浏览器把 127.0.0.1 视为安全上下文）；
* 局域网/公网用普通 \`http://192.168.x.x\` 打开时，网页会弹出警告并禁止开始，服务器同时以 403 拒绝连接；
* 本机开服（[1]）且只自己玩时不受影响；要开给局域网朋友玩，请在 [3] 里关掉省流量模式。

## 好友怎么加入（本机当服务器）

1. 菜单选 [1]，等浏览器打开、控制台打印出「发给朋友」的地址（形如 \`http://192.168.1.23:3000\`）。
2. 第一次可能需要在 Windows 防火墙弹窗里勾选**允许专用网络**（否则朋友连不上）。
3. 建房后把 4 位「同盟密钥」或「复制链接」（\`…/?room=密钥\`）发给朋友。

## 目录结构

\`\`\`
node\\node.exe            便携版 Node ${version}（官方 x64，已经 sha256 校验）
app\\                    游戏本体：server / shared / public（全部素材）/ data / scripts / tools
app\\scripts\\launcher.mjs 启动器（开始界面）
启动游戏.bat             双击开始（菜单）
README-开箱即用.md       本文件
\`\`\`

卸载＝直接删掉整个文件夹（不写注册表、不放系统目录）。存档/昵称在该电脑的浏览器 localStorage 里。
`;

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return 0; }
  const out = path.resolve(o.out || path.join(path.dirname(ROOT), 'Stronghold-Protocol-Windows'));
  if (o.tests) SKIP_DIRS.delete('test');   // --with-tests: ship node --test as well
  const appDir = path.join(out, 'app');
  const nodeDir = path.join(out, 'node');
  console.log(`\n卫戍协议 · Windows 开箱即用包\n  源仓库：${ROOT}\n  产物：  ${out}\n`);

  if (fs.existsSync(out)) {
    if (!o.force) {
      console.error(`✖ ${out} 已存在。加 --force 覆盖（会先删掉整个目录）。`);
      return 1;
    }
    await fsp.rm(out, { recursive: true, force: true });
  }
  await fsp.mkdir(out, { recursive: true });

  console.log('  · 复制 app（代码 + node_modules + 素材，几百 MB，稍等）…');
  const copied = await copyTree(ROOT, appDir);
  console.log(`    完成：${copied.files} 个文件 / ${MB(copied.bytes)}`);

  if (!o.webfonts) {
    const page = path.join(appDir, 'public', 'index.html');
    const { html, removed } = stripWebfonts(await fsp.readFile(page, 'utf8'));
    if (removed) {
      await fsp.writeFile(page, html);
      console.log(`    去掉 ${removed} 条 Google Fonts 外链（包内自带 /fonts；--keep-webfonts 可保留）`);
    } else {
      console.log('    提示：index.html 里没有 Google Fonts 外链，无需处理');
    }
  }

  let nodeInfo = { version: '（未打包，目标机器需自备 Node 22+）', bytes: 0 };
  if (o.node) {
    console.log('  · 准备便携版 Node…');
    nodeInfo = await downloadPortableNode(nodeDir, o.nodeSpec);
    console.log(`    完成：Node ${nodeInfo.version} / ${MB(nodeInfo.bytes)}`);
  }

  await fsp.writeFile(path.join(out, '启动游戏.bat'), bat('"%NODE%" "%HERE%app\\scripts\\launcher.mjs" %*'), 'latin1');
  await fsp.writeFile(path.join(out, '本机当服务器.bat'), bat('"%NODE%" "%HERE%app\\scripts\\launcher.mjs" --mode local %*'), 'latin1');
  await fsp.writeFile(path.join(out, '连接服务器.bat'), bat('"%NODE%" "%HERE%app\\scripts\\launcher.mjs" --mode connect %*'), 'latin1');
  await fsp.writeFile(path.join(out, 'README-开箱即用.md'), README(nodeInfo.version), 'utf8');

  const total = await dirSize(out);
  console.log(`\n✔ 便携包已生成：${out}\n  ${total.files} 个文件 / ${MB(total.bytes)}`);
  console.log('  双击「启动游戏.bat」即可（开始界面：本机当服务器 / 连接服务器）。');

  if (o.zip) {
    const zipPath = `${out}.zip`;
    await fsp.rm(zipPath, { force: true });
    console.log(`\n  · 压缩 ${zipPath}（大包，几分钟）…`);
    let r = spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', path.dirname(out), path.basename(out)], { stdio: 'inherit' });
    if (r.error || r.status !== 0) {
      r = spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${out}\\*' -DestinationPath '${zipPath}' -Force`], { stdio: 'inherit' });
    }
    if (r.error || r.status !== 0) { console.error('✖ 压缩失败'); return 1; }
    console.log(`  ✔ ${zipPath}（${MB((await fsp.stat(zipPath)).size)}）`);
  }
  return 0;
}

// 作为脚本运行时才打包（被 import 时只导出 stripWebfonts 等纯函数，方便测试）。
const IS_MAIN = !!process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (IS_MAIN) main().then((code) => { process.exitCode = code ?? 0; }, (e) => { console.error(e?.stack || e); process.exitCode = 1; });
