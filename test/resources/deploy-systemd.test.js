import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/deploy-systemd.mjs（systemd 部署器）与 scripts/deploy-systemd-remote.sh（落地脚本）。
// 这里只做本地、无网络的检查：CLI 前置条件、只读计划的行为，以及落地脚本里那几条
// 「不校验就不许解包」「失败必须回滚」的硬约束 —— 2026-10-17 线上前端事故就是缺了这些守卫。

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCRIPT = path.join(ROOT, 'scripts', 'deploy-systemd.mjs');
const REMOTE = path.join(ROOT, 'scripts', 'deploy-systemd-remote.sh');

const runCli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

/** 造一个含两个真实小 tar 的 bundle 目录，避免测试里打包 180MB 产物。 */
function fakeBundle() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-deploy-'));
  const src = path.join(dir, 'payload');
  fs.mkdirSync(path.join(src, 'public', 'build'), { recursive: true });
  fs.writeFileSync(path.join(src, 'public', 'build', 'index.html'), '<html>ok</html>');
  fs.writeFileSync(path.join(src, 'marker.txt'), 'x');
  for (const name of ['repo.tar', 'build.tar']) {
    const r = spawnSync('tar', ['-cf', path.join(dir, name), '-C', src, '.'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `测试前置：tar 打包失败 ${r.stderr}`);
  }
  return dir;
}

test('deploy-systemd --help 退出 0 并给出用法', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /systemd/);
  assert.match(r.stdout, /--apply/);
});

test('deploy-systemd 缺少目标时退出 2', () => {
  const r = runCli([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--target/);
});

test('deploy-systemd --behind 必须配 --via', () => {
  const r = runCli(['--behind', 'root@10.0.0.1']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--via/);
});

test('deploy-systemd 非法 --attempts 退出 2', () => {
  const r = runCli(['--target', 'root@10.0.0.1', '--attempts', '0']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /attempts/);
});

test('deploy-systemd --skip-bundle 缺包时退出 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-deploy-empty-'));
  const r = runCli(['--target', 'root@10.0.0.1', '--bundle-dir', dir, '--skip-bundle']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /skip-bundle/);
});

test('deploy-systemd 默认只打印计划，不连任何主机', () => {
  const dir = fakeBundle();
  const r = runCli(['--target', 'root@example.invalid', '--bundle-dir', dir, '--skip-bundle']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /只读计划/);
  assert.match(r.stdout, /未做任何改动/);
  assert.match(r.stdout, /root@example\.invalid/);
  // 计划里必须把包大小和 sha256 摆出来，否则没法核对将要发布的是什么
  assert.match(r.stdout, /repo\.tar\s+[\d.]+ MB\s+[0-9a-f]{16}/);
  assert.match(r.stdout, /build\.tar\s+[\d.]+ MB\s+[0-9a-f]{16}/);
});

test('落地脚本：先校验再解包，绝不覆盖公告，失败回滚，默认不重启', () => {
  const s = fs.readFileSync(REMOTE, 'utf8');
  const verifyAt = s.indexOf('sha256sum -c');
  const extractAt = s.indexOf('tar -xf "$DEPLOY_DIR/repo.tar"');
  assert.ok(verifyAt > 0 && extractAt > 0, '缺少校验或解包步骤');
  assert.ok(verifyAt < extractAt, '校验必须在任何解包之前');
  // 校验失败必须直接退出，而不是继续解包
  const beforeExtract = s.slice(0, extractAt);
  assert.match(beforeExtract, /哈希不符[\s\S]*exit 1/);
  assert.match(beforeExtract, /不是完整 tar[\s\S]*exit 1/);
  // 公告与旧分包
  assert.match(s, /--exclude='config\/announcements\.json'/);
  assert.doesNotMatch(s, /rm -rf\s+public\/build/);
  // 自检 + 回滚
  assert.match(s, /自检：构建 HTML 的引用与入口分包/);
  assert.match(s, /回滚 public\/build/);
  assert.match(s, /tar -xzf "\$backup" \.\/public\/build/);
  // 重启只在 SP_RESTART=1 分支里
  const restartBranch = s.slice(s.indexOf('if [ "$RESTART" = 1 ]'));
  assert.match(restartBranch, /systemctl restart/);
  assert.match(restartBranch, /健康检查未通过[\s\S]*回滚/);
  assert.doesNotMatch(s.slice(0, s.indexOf('if [ "$RESTART" = 1 ]')), /systemctl restart/);
});
