// scripts/sync-to-r2-http.mjs：不依赖 rclone 的正式上传脚本。
// 用一个本机 mock R2 覆盖：预演不写远端、大小一致跳过、5xx 重试、4xx 立即失败、
// 失败键名全列并可落盘补传、各前缀的 Cache-Control、以及 data 必须最后发布。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const script = path.resolve('scripts/sync-to-r2-http.mjs');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sp-r2-http-'));
  await mkdir(path.join(root, 'data'), { recursive: true });
  await mkdir(path.join(root, 'public', 'assets'), { recursive: true });
  await mkdir(path.join(root, 'public', 'i18n'), { recursive: true });
  await mkdir(path.join(root, 'packs'), { recursive: true });
  await writeFile(path.join(root, 'data', 'assets.json'), JSON.stringify({ ui: { icon: '/assets/icon.png' } }));
  await writeFile(path.join(root, 'data', 'local-assets.json'), JSON.stringify({ version: 1, groups: {} }));
  await writeFile(path.join(root, 'data', 'local-fx.json'), JSON.stringify({ groups: {} }));
  await writeFile(path.join(root, 'data', 'chess.json'), JSON.stringify({ chars: [] }));
  await writeFile(path.join(root, 'data', 'asset-hashes.json'), JSON.stringify({ files: {} }));
  await writeFile(path.join(root, 'public', 'assets', 'icon.png'), 'image');
  await writeFile(path.join(root, 'public', 'assets', 'fresh.png'), 'fresh');
  await writeFile(path.join(root, 'public', 'assets', 'flaky.png'), 'flaky');
  await writeFile(path.join(root, 'public', 'assets', 'denied.png'), 'denied');
  await writeFile(path.join(root, 'public', 'i18n', 'en.json'), '{}');
  await writeFile(path.join(root, 'packs', 'ui-01.zip'), 'zip');
  return root;
}

/** mock R2：记录每个请求，icon.png 视为已存在，flaky 前两次 503，denied 恒 403。 */
async function mockR2() {
  const requests = [];
  const attempts = new Map();
  const server = createServer((req, res) => {
    const key = decodeURIComponent(req.url.replace(/^\/game\//, ''));
    const record = { method: req.method, key, cacheControl: req.headers['cache-control'] || '', contentType: req.headers['content-type'] || '' };
    requests.push(record);
    if (req.method === 'HEAD') {
      if (key === 'release/assets/icon.png') {
        res.writeHead(200, { 'content-length': '5' });
        return res.end();
      }
      res.writeHead(404);
      return res.end();
    }
    const count = (attempts.get(key) || 0) + 1;
    attempts.set(key, count);
    req.resume();
    if (key === 'release/assets/denied.png') {
      res.writeHead(403);
      return res.end('denied');
    }
    if (key === 'release/assets/flaky.png' && count <= 2) {
      res.writeHead(503);
      return res.end('try again');
    }
    res.writeHead(200);
    return res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { requests, attempts, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

const puts = (requests) => requests.filter((entry) => entry.method === 'PUT');

// 必须异步 spawn：spawnSync 会阻塞测试进程的事件循环，同进程里的 mock R2 就再也回不了响应。
function run(root, env, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: {
        ...process.env,
        R2_REPO_ROOT: root,
        R2_BUCKET: 'game',
        R2_PREFIX: 'release',
        R2_ACCESS_KEY_ID: 'test-access',
        R2_SECRET_ACCESS_KEY: 'test-secret-key',
        ASSETS_CDN_BASE_URL: 'https://assets.example/game',
        R2_TRANSFERS: '4',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 60000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test('R2 HTTP 上传：预演不写远端，逐文件重试并列出失败键名，可补传', async (t) => {
  const root = await fixture();
  const mock = await mockR2();
  t.after(async () => { await mock.close(); await rm(root, { recursive: true, force: true }); });
  const env = { R2_ENDPOINT: mock.url };

  const preview = await run(root, env);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /预演 \d+ 个文件/);
  assert.match(preview.stdout, /assets\s+4 个/);
  assert.match(preview.stdout, /没有写入远端/);
  assert.equal(puts(mock.requests).length, 0, '预演不得写入远端');

  const failList = path.join(root, 'failures.json');
  const applied = await run(root, env, '--apply', '--fail-list', failList);
  assert.equal(applied.status, 1, applied.stdout);
  const uploaded = puts(mock.requests).map((entry) => entry.key);
  assert.ok(uploaded.includes('release/assets/fresh.png'), applied.stdout);
  assert.ok(uploaded.includes('release/i18n/en.json'));
  assert.ok(uploaded.includes('release/packs/ui-01.zip'));
  assert.ok(uploaded.includes('release/data/assets.json'));
  assert.ok(uploaded.includes('release/data/resource-manifest.json'), 'data 先经 prepare-r2-data.mjs 生成清单');
  assert.ok(!uploaded.includes('release/assets/icon.png'), '大小一致的对象要跳过');
  assert.equal(mock.attempts.get('release/assets/flaky.png'), 3, '503 要重试到成功');
  assert.equal(mock.attempts.get('release/assets/denied.png'), 1, '403 不重试');

  const iconCheck = mock.requests.find((entry) => entry.key === 'release/assets/icon.png');
  assert.equal(iconCheck.method, 'HEAD');
  const assetPut = puts(mock.requests).find((entry) => entry.key === 'release/assets/fresh.png');
  assert.equal(assetPut.cacheControl, 'public, max-age=86400');
  assert.equal(assetPut.contentType, 'image/png');
  const dataPut = puts(mock.requests).find((entry) => entry.key === 'release/data/assets.json');
  assert.equal(dataPut.cacheControl, 'no-cache');
  const firstAsset = mock.requests.findIndex((entry) => entry.key.startsWith('release/assets/'));
  const firstData = mock.requests.findIndex((entry) => entry.key.startsWith('release/data/'));
  assert.ok(firstAsset >= 0 && firstData > firstAsset, '素材必须先于 data 清单发布');

  assert.match(applied.stderr, /失败文件 1 个/);
  assert.match(applied.stderr, /release\/assets\/denied\.png/);
  assert.doesNotMatch(applied.stdout + applied.stderr, /test-secret-key/, '不得打印凭据');
  const doc = JSON.parse(await readFile(failList, 'utf8'));
  assert.equal(doc.failures.length, 1);
  assert.equal(doc.failures[0].key, 'release/assets/denied.png');

  mock.requests.length = 0;
  const retry = await run(root, env, '--apply', '--retry-file', failList);
  assert.equal(retry.status, 1, retry.stdout);
  assert.deepEqual(puts(mock.requests).map((entry) => entry.key), ['release/assets/denied.png'], '补传只重试失败文件');
});

test('R2 HTTP 上传：配置模式预演、缺少凭据报错', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'r2-sync.json');
  await writeFile(configPath, JSON.stringify({
    r2: { accountId: 'b'.repeat(32), accessKeyId: 'cfg-access', secretAccessKey: 'cfg-secret', bucket: 'game', prefix: 'release' },
    cdn: { dataBaseUrl: 'https://data.example/game', assetsBaseUrl: 'https://assets.example/game' },
    sync: { transfers: 4 },
  }));
  const configured = await run(root, { R2_ENDPOINT: '' }, '--config', configPath);
  assert.equal(configured.status, 0, configured.stderr);
  assert.match(configured.stdout, /没有写入远端/);
  assert.doesNotMatch(configured.stdout + configured.stderr, /cfg-secret/);

  const noCreds = spawnSync(process.execPath, [script, '--apply'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, R2_REPO_ROOT: root, R2_ENDPOINT: '', R2_ACCOUNT_ID: '', R2_BUCKET: '', R2_PREFIX: '',
      R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '' },
  });
  assert.equal(noCreds.status, 2, noCreds.stdout);
  assert.match(noCreds.stderr, /缺少环境变量/);
});
