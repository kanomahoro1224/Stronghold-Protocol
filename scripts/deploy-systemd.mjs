#!/usr/bin/env node
/**
 * systemd 生产部署器（本分支三台线上机用的就是这套：systemd + 文件拷贝，没有 Docker）。
 *
 * 与 scripts/deploy-compose.mjs（Docker Compose）并列；R2 静态资源上传见 scripts/sync-to-r2-http.mjs。
 *
 * 默认是只读计划：列出目标、包大小、sha256 与将要执行的步骤，不传任何东西、不改任何文件。
 * 加 --apply 才真的部署，每个目标机执行：
 *   0. sha256sum -c + tar -tzf 校验上传的包 —— 不符就退出，**线上保持原样**；
 *   1. 备份源码与前端构建到 /root/stronghold-static-<ts>.tar.gz；
 *   2. 解包源码（永不覆盖 config/announcements.json）；
 *   3. 解包 public/build（不删旧哈希分包）；
 *   4. 自检：构建 HTML 的每个引用、入口分包的每个分包都必须存在且 HTTP 200；
 *   5. 任一失败即从本次备份还原 public/build（--restart 时还会还原并重启）；
 *   6. 可选 --restart：重启服务并轮询 /healthz，失败回滚。
 *
 * 用法：
 *   node scripts/deploy-systemd.mjs --target root@1.2.3.4 --identity ~/.ssh/id_ed25519
 *   node scripts/deploy-systemd.mjs --target root@1.2.3.4 --identity k \
 *     --via root@1.2.3.4 --via-identity k \
 *     --behind root@5.6.7.8 --behind-identity /root/.ssh/id_to_b \
 *     --apply
 *
 * 常用参数：
 *   --apply              真的部署（默认只打印计划）
 *   --build              部署前先跑 npm run build
 *   --restart            部署成功后重启服务（纯前端改动不需要）
 *   --target SSH         直连目标（可重复）
 *   --identity PATH      直连目标的私钥
 *   --via SSH            中转机（--behind 的包先传到它，再由它转发）
 *   --via-identity PATH  中转机私钥
 *   --behind SSH         经由 --via 才能到达的目标（可重复）
 *   --behind-identity P  这些目标的私钥（在 --via 上使用）
 *   --remote-dir DIR     部署根目录，默认 /opt/stronghold
 *   --service NAME       systemd 服务名，默认 stronghold
 *   --deploy-dir DIR     目标机上放包的目录，默认 /tmp/sp-deploy
 *   --health URL         健康检查，默认 http://127.0.0.1:3000/healthz
 *   --bundle-dir DIR     本地打包目录，默认 .cache/deploy
 *   --attempts N         每个文件的上传尝试次数，默认 3
 *   --prune-backups      成功后只保留最近 3 份目标机备份（默认不删）
 *   --help
 *
 * 退出码：0 全部成功；1 有目标失败；2 用法或前置条件错误。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REMOTE_SCRIPT = 'scripts/deploy-systemd-remote.sh';

const HELP = `systemd 部署器 —— 默认只打印计划，--apply 才执行（见文件头部注释）`;

/** Run a command, capture output (never throws). */
function run(cmd, args, { input, timeout = 0 } = {}) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: timeout || undefined, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

function sha256File(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (!read) break;
      hash.update(buf.subarray(0, read));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

const sshOpts = (identity) => ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=20',
  ...(identity ? ['-i', identity] : [])];
const scpOpts = (identity) => ['-q', '-C', ...sshOpts(identity)];

/** ssh to a host, run one shell command string. */
function ssh(host, command, identity, timeout = 0) { return run('ssh', [...sshOpts(identity), host, command], { timeout }); }

/** scp local files to host:dir (dir must exist). */
function scp(files, dest, identity, timeout = 0) { return run('scp', [...scpOpts(identity), ...files, dest], { timeout }); }

/** Run a shell command on host；给了 via 就从中转机跳过去（目标机私钥只在中转机上）。 */
function sshHost(host, identity, command, via, timeout = 0) {
  if (via) return ssh(via.host, `ssh ${sshOpts(identity).join(' ')} ${host} '${command}'`, via.identity, timeout);
  return ssh(host, command, identity, timeout);
}

function parse() {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      build: { type: 'boolean', default: false },
      'skip-bundle': { type: 'boolean', default: false },
      restart: { type: 'boolean', default: false },
      'prune-backups': { type: 'boolean', default: false },
      target: { type: 'string', multiple: true, default: [] },
      identity: { type: 'string' },
      via: { type: 'string' },
      'via-identity': { type: 'string' },
      behind: { type: 'string', multiple: true, default: [] },
      'behind-identity': { type: 'string', multiple: true, default: [] },
      'remote-dir': { type: 'string' },
      service: { type: 'string' },
      'deploy-dir': { type: 'string' },
      health: { type: 'string' },
      'bundle-dir': { type: 'string' },
      attempts: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) { console.log(HELP); process.exit(0); }
  if (!values.target.length && !values.behind.length) {
    console.error('需要 --target（直连目标）或 --behind（经 --via 到达的目标）'); process.exit(2);
  }
  if (values.behind.length && !values.via) { console.error('--behind 必须同时给 --via'); process.exit(2); }
  const attempts = Number(values.attempts ?? 3);
  if (!Number.isInteger(attempts) || attempts < 1) { console.error('--attempts 需要正整数'); process.exit(2); }
  return {
    apply: values.apply, build: values.build, skipBundle: values['skip-bundle'],
    restart: values.restart,
    pruneBackups: values['prune-backups'],
    target: values.target, identity: values.identity,
    via: values.via, viaIdentity: values['via-identity'],
    behind: values.behind, behindIdentity: values['behind-identity'],
    remoteDir: values['remote-dir'] || '/opt/stronghold',
    service: values.service || 'stronghold',
    deployDir: values['deploy-dir'] || '/tmp/sp-deploy',
    health: values.health || 'http://127.0.0.1:3000/healthz',
    bundleDir: values['bundle-dir'] || path.join(ROOT, '.cache', 'deploy'),
    attempts,
  };
}

/** Create repo.tar (tracked files only) and build.tar (public/build). */
function createBundles(dir, { build, skipBundle }) {
  fs.mkdirSync(dir, { recursive: true });
  const repo = path.join(dir, 'repo.tar');
  const buildTar = path.join(dir, 'build.tar');
  if (skipBundle) {
    for (const f of [repo, buildTar]) {
      if (!fs.existsSync(f)) { console.error(`--skip-bundle 但缺少 ${f}`); process.exit(2); }
    }
    return { repo, buildTar };
  }
  if (build) {
    console.log('  → npm run build');
    const r = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { timeout: 15 * 60 * 1000 });
    if (r.status !== 0) { console.error('构建失败：\n' + r.stdout + r.stderr); process.exit(2); }
  }
  const a = run('git', ['archive', '--format=tar', '-o', repo, 'HEAD']);
  if (a.status !== 0) { console.error('git archive 失败：' + a.stderr); process.exit(2); }
  const b = run('tar', ['-cf', buildTar, '-C', path.join(ROOT, 'public'), 'build']);
  if (b.status !== 0) { console.error('打包 public/build 失败：' + b.stderr); process.exit(2); }
  // 本地就检查一次完整性：坏包不出发（repo.tar/build.tar 都是未压缩 tar，bsdtar 与 GNU tar 都试）
  for (const f of [repo, buildTar]) {
    if (run('tar', ['-tf', f]).status !== 0 && run('tar', ['-tzf', f]).status !== 0) {
      console.error(`本地 ${f} 不是完整 tar，已中止`); process.exit(2);
    }
  }
  return { repo, buildTar };
}

/** Write the remote-side sha256 manifest (absolute paths inside deployDir). */
function writeManifest(dir, deployDir, files) {
  const lines = files.map((f) => `${sha256File(f)}  ${deployDir}/${path.basename(f)}`).join('\n') + '\n';
  const manifest = path.join(dir, 'deploy.sha256');
  fs.writeFileSync(manifest, lines);
  return manifest;
}

function pushFiles(host, identity, files, deployDir, attempts, via) {
  const names = files.map((f) => path.basename(f));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const mk = via
      // 中转机上转发：路径是它本地的 deployDir，私钥是**目标机**的（转发时在 via 上使用）
      ? ssh(via.host, `mkdir -p ${deployDir} && scp ${scpOpts(identity).join(' ')} `
        + `${names.map((n) => `${deployDir}/${n}`).join(' ')} ${host}:${deployDir}/`, via.identity)
      : (() => { ssh(host, `mkdir -p ${deployDir}`, identity); return scp(files, `${host}:${deployDir}/`, identity); })();
    if (mk.status !== 0) {
      console.log(`      ! 第 ${attempt}/${attempts} 次上传失败（${(mk.stderr || mk.error?.message || '').trim().split('\n')[0]}），重试`);
      continue;
    }
    // 传完必须核验：哈希不符就当这次没成功，绝不进入解包（经中转机时也要从中转机核对）
    const check = sshHost(host, identity, `cd ${deployDir} && sha256sum -c deploy.sha256`, via);
    if (check.status === 0) return { ok: true, names };
    console.log(`      ! 第 ${attempt}/${attempts} 次上传后哈希不符，重试：`
      + ` ${(check.stdout + check.stderr).trim().split('\n').filter((l) => /FAILED|No such|error/i.test(l)).slice(0, 3).join(' | ') || '（无输出）'}`);
  }
  return { ok: false, names };
}

function deployOne(host, identity, opts, { via } = {}) {
  const env = [
    `SP_DEPLOY_DIR=${opts.deployDir}`,
    `SP_REMOTE_DIR=${opts.remoteDir}`,
    `SP_SERVICE=${opts.service}`,
    `SP_RESTART=${opts.restart ? 1 : 0}`,
    `SP_HEALTH=${opts.health}`,
  ].join(' ');
  const cmd = `${env} bash ${opts.deployDir}/deploy-systemd-remote.sh`;
  const r = sshHost(host, identity, cmd, via, 30 * 60 * 1000);
  if (opts.pruneBackups && r.status === 0) {
    sshHost(host, identity, 'ls -t /root/stronghold-static-*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm -f', via);
  }
  return r;
}

function main() {
  const opts = parse();
  const files = createBundles(opts.bundleDir, opts);
  const manifest = writeManifest(opts.bundleDir, opts.deployDir, [files.repo, files.buildTar, path.join(ROOT, REMOTE_SCRIPT)]);
  const upload = [files.repo, files.buildTar, manifest, path.join(ROOT, REMOTE_SCRIPT)];

  console.log('systemd 部署' + (opts.apply ? '' : '（只读计划，加 --apply 才执行）'));
  console.log(`  仓库        ${ROOT}`);
  console.log(`  repo.tar    ${(fs.statSync(files.repo).size / 1048576).toFixed(1)} MB  ${sha256File(files.repo).slice(0, 16)}`);
  console.log(`  build.tar   ${(fs.statSync(files.buildTar).size / 1048576).toFixed(1)} MB  ${sha256File(files.buildTar).slice(0, 16)}`);
  console.log(`  目标根目录  ${opts.remoteDir}   服务 ${opts.service}   重启 ${opts.restart ? '是' : '否'}`);
  for (const t of opts.target) console.log(`  直连目标    ${t}${opts.identity ? `（私钥 ${opts.identity}）` : ''}`);
  for (const b of opts.behind) console.log(`  中转目标    ${b}  经 ${opts.via}`);
  if (!opts.apply) { console.log('\n未做任何改动。'); return 0; }

  // 中转机上先放一份，再由它转发给 --behind
  const direct = [...opts.target];
  if (opts.behind.length && opts.via && !direct.includes(opts.via)) direct.push(opts.via);

  const results = [];
  const uploaded = new Set();
  for (const host of direct) {
    const identity = host === opts.via ? opts.viaIdentity : opts.identity;
    console.log(`\n=== ${host} 上传 ===`);
    const up = pushFiles(host, identity, upload, opts.deployDir, opts.attempts);
    if (!up.ok) { console.log(`      ✗ ${host} 上传失败（已重试 ${opts.attempts} 次），跳过该机`); results.push([host, false]); continue; }
    console.log('      ✓ 上传并校验通过');
    uploaded.add(host);
    if (opts.target.includes(host)) {
      console.log(`=== ${host} 部署 ===`);
      const r = deployOne(host, opts.identity, opts);
      process.stdout.write(r.stdout.replace(/^/gm, '    '));
      if (r.stderr.trim()) process.stdout.write(r.stderr.replace(/^/gm, '    ! '));
      results.push([host, r.status === 0]);
    }
  }
  for (const [i, host] of opts.behind.entries()) {
    const behindIdentity = opts.behindIdentity[i];
    const via = { host: opts.via, identity: opts.viaIdentity };
    console.log(`\n=== ${host}（经 ${opts.via}）上传 ===`);
    if (!uploaded.has(opts.via)) { console.log(`      ✗ 中转机 ${opts.via} 未上传成功，跳过`); results.push([host, false]); continue; }
    const up = pushFiles(host, behindIdentity, upload, opts.deployDir, opts.attempts, via);
    if (!up.ok) { console.log(`      ✗ ${host} 上传失败，跳过该机`); results.push([host, false]); continue; }
    console.log('      ✓ 上传并校验通过');
    console.log(`=== ${host} 部署 ===`);
    const r = deployOne(host, behindIdentity, opts, { via });
    process.stdout.write(r.stdout.replace(/^/gm, '    '));
    if (r.stderr.trim()) process.stdout.write(r.stderr.replace(/^/gm, '    ! '));
    results.push([host, r.status === 0]);
  }

  console.log('\n===== 结果 =====');
  for (const [host, ok] of results) console.log(`  ${ok ? '✓' : '✗'} ${host}`);
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(failed ? `${failed} 个目标失败` : '全部成功');
  return failed ? 1 : 0;
}

process.exit(main());
