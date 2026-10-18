// scripts/r2-size-index.mjs：按清单 HEAD R2 对象补齐 size 的正式脚本。
// 用一个本机 mock R2 覆盖：并发确实放大、200 取 Content-Length、5xx 重试、404 计入缺失并落盘、
// --index 产出的 resource-packs.json 形态能被 server/resources.js 的 collectPackSizes 采信、进度与汇总输出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { collectPackSizes } from '../../server/resources.js';
import { objectKey } from '../../scripts/r2-size-index.mjs';

const script = path.resolve('scripts/r2-size-index.mjs');

/** mock R2：按 key 给 Content-Length；记录最大同时在途数，用于证明并发真的放大。 */
async function mockR2({ sizeOf, statusOf = () => 200, delayMs = 5, lengthlessOf = () => false }) {
  const attempts = new Map();
  const state = { inFlight: 0, maxInFlight: 0, heads: 0, identity: 0, ranges: 0 };
  const server = createServer((req, res) => {
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    const key = decodeURIComponent(req.url.replace(/^\/bucket\//, ''));
    if (req.method === 'HEAD') state.heads += 1;
    // undici 会把自己那份额外的 identity 追加进来（"identity, identity"），语义仍是要求不压缩。
    if ((req.headers['accept-encoding'] || '').includes('identity')) state.identity += 1;
    if (req.headers.range) state.ranges += 1;
    const count = (attempts.get(key) || 0) + 1;
    attempts.set(key, count);
    const status = statusOf(key, count);
    setTimeout(() => {
      state.inFlight -= 1;
      if (status !== 200) {
        res.writeHead(status);
        return res.end();
      }
      const size = sizeOf(key);
      if (size == null) {
        res.writeHead(404);
        return res.end();
      }
      if (lengthlessOf(key)) {
        // Cloudflare 压缩响应时会去掉 content-length；只有带 Range 的 GET 才给得出总长。
        if (req.headers.range) {
          res.writeHead(206, { 'content-range': `bytes 0-0/${size}` });
          return res.end(Buffer.alloc(1));
        }
        res.writeHead(200);
        return res.end();
      }
      res.writeHead(200, { 'content-length': String(size) });
      res.end();
    }, delayMs);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, state, url: `http://127.0.0.1:${server.address().port}` };
}

async function fixture(root) {
  const manifest = path.join(root, 'resource-manifest.json');
  const out = path.join(root, 'sizes.json');
  const failList = path.join(root, 'missing.json');
  return { manifest, out, failList };
}

function run(args, { endpoint, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: {
        ...process.env,
        R2_REPO_ROOT: path.dirname(args[0] || '.'),
        R2_ENDPOINT: endpoint,
        R2_BUCKET: 'bucket',
        R2_ACCESS_KEY_ID: 'test-key',
        R2_SECRET_ACCESS_KEY: 'test-secret',
        R2_PREFIX: 'release',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('对象键 = 前缀 + 清单 URL 的路径，绝对 CDN 地址与站点相对路径都适用', () => {
  assert.equal(objectKey('/assets/spine/x/front/x.skel', 'release'), 'release/assets/spine/x/front/x.skel');
  assert.equal(objectKey('https://cdn.example.com/release/assets/a.png', 'release'), 'release/assets/a.png');
  assert.equal(objectKey('https://cdn.example.com/release/assets/a.png?v=2', 'release'), 'release/assets/a.png');
  // 清单把方括号写成 %5B/%5D，R2 上的键是上传时的原始文件名，取键前必须解码。
  assert.equal(objectKey('/assets/a%5B1%5D.png', ''), 'assets/a[1].png');
  // 线上 CDN 清单的地址已经带前缀，不能再拼一次。
  assert.equal(objectKey('https://local.xiaolubao.com/Stronghold-Protocol/assets/a.png', 'Stronghold-Protocol'), 'Stronghold-Protocol/assets/a.png');
});

test('HEAD 无 content-length 时用 Range 读 content-range，且请求带 accept-encoding: identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sp-size-'));
  try {
    const { manifest, out, failList } = await fixture(root);
    const files = [{ url: '/fonts/a.otf' }, { url: '/assets/b%5B1%5D.png' }];
    await writeFile(manifest, JSON.stringify({ version: 1, files }));
    const mock = await mockR2({
      sizeOf: (key) => (key === 'release/fonts/a.otf' ? 4096 : key === 'release/assets/b[1].png' ? 8192 : null),
      lengthlessOf: (key) => key === 'release/fonts/a.otf',
    });
    try {
      const result = await run(['--manifest', manifest, '--out', out, '--fail-list', failList], { endpoint: mock.url });
      assert.equal(result.code, 0, result.stderr);
      const sizes = JSON.parse(await readFile(out, 'utf8'));
      assert.equal(sizes['/fonts/a.otf'], 4096, '无 content-length 时应从 content-range 拿到总长');
      assert.equal(sizes['/assets/b%5B1%5D.png'], 8192, '方括号键要解码后去取');
      assert.equal(mock.state.ranges, 1);
      assert.equal(mock.state.identity, mock.state.heads + mock.state.ranges, '所有请求都要声明 identity');
    } finally {
      mock.server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('清单里每条都取到 Content-Length，且并发明显大于 1', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sp-size-'));
  try {
    const { manifest, out } = await fixture(root);
    const files = Array.from({ length: 240 }, (_, index) => ({ url: `/assets/f/${index}.png`, hash: 'abcdef012345', tier: 1 }));
    await writeFile(manifest, JSON.stringify({ format: 'stronghold-resource-manifest', version: 1, count: files.length, files }));
    const mock = await mockR2({ sizeOf: (key) => (key.endsWith('.png') ? 1024 : null) });
    try {
      const result = await run(['--manifest', manifest, '--out', out, '--concurrency', '32'], { endpoint: mock.url });
      assert.equal(result.code, 0, result.stderr);
      const sizes = JSON.parse(await readFile(out, 'utf8'));
      assert.equal(Object.keys(sizes).length, 240);
      assert.equal(sizes['/assets/f/0.png'], 1024);
      assert.equal(mock.state.heads, 240);
      assert.ok(mock.state.maxInFlight >= 8, `并发应明显大于 1，实测 ${mock.state.maxInFlight}`);
      assert.match(result.stdout, /240\/240 100\.0%/);
      assert.match(result.stdout, /有 size 240 \/ 缺失 0/);
    } finally {
      mock.server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('5xx 重试后成功，404 计入缺失、落盘并让退出码为 1', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sp-size-'));
  try {
    const { manifest, out, failList } = await fixture(root);
    const files = [
      { url: '/assets/ok.png' },
      { url: '/assets/flaky.png' },
      { url: '/assets/gone.png' },
    ];
    await writeFile(manifest, JSON.stringify({ version: 1, files }));
    const mock = await mockR2({
      sizeOf: (key) => (key === 'release/assets/gone.png' ? null : 2048),
      statusOf: (key, count) => (key === 'release/assets/flaky.png' && count <= 2 ? 503 : 200),
    });
    try {
      const result = await run(['--manifest', manifest, '--out', out, '--fail-list', failList], { endpoint: mock.url });
      assert.equal(result.code, 1);
      const sizes = JSON.parse(await readFile(out, 'utf8'));
      assert.deepEqual(Object.keys(sizes).sort(), ['/assets/flaky.png', '/assets/ok.png']);
      const missing = JSON.parse(await readFile(failList, 'utf8'));
      assert.equal(missing.length, 1);
      assert.equal(missing[0].url, '/assets/gone.png');
      assert.equal(missing[0].status, 404);
      assert.match(result.stderr, /404 \/assets\/gone\.png/);
    } finally {
      mock.server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--patch 就地补 size：不动 URL/hash/version/count，只更新 sized 与 totalBytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sp-size-'));
  try {
    const { manifest, out } = await fixture(root);
    const patchedPath = path.join(root, 'patched.json');
    const files = [
      { url: '/assets/a.png', tier: 1, hash: 'aaaaaaaaaaaa' },
      { url: 'https://cdn.example.com/release/assets/b.png', tier: 1, hash: 'bbbbbbbbbbbb' },
      { url: '/assets/gone.png', tier: 1, hash: 'cccccccccccc' },
    ];
    await writeFile(manifest, JSON.stringify({ format: 1, version: '27bd82ddcc48', count: 3, tier1: 3, sized: 0, totalBytes: 0, files }));
    const mock = await mockR2({ sizeOf: (key) => (key.endsWith('gone.png') ? null : key.endsWith('a.png') ? 1024 : 2048) });
    try {
      const result = await run(['--manifest', manifest, '--out', out, '--patch', patchedPath], { endpoint: mock.url });
      assert.equal(result.code, 1, result.stderr);
      const doc = JSON.parse(await readFile(patchedPath, 'utf8'));
      assert.equal(doc.format, 1);
      assert.equal(doc.version, '27bd82ddcc48');
      assert.equal(doc.count, 3);
      assert.equal(doc.tier1, 3);
      assert.equal(doc.sized, 2);
      assert.equal(doc.totalBytes, 3072);
      assert.equal(doc.files[0].size, 1024);
      assert.equal(doc.files[0].hash, 'aaaaaaaaaaaa');
      assert.equal(doc.files[1].size, 2048);
      assert.equal('size' in doc.files[2], false);
      assert.match(result.stdout, /sized 0 → 2/);
    } finally {
      mock.server.close();
    }
    const refused = await run(['--manifest', manifest, '--out', out, '--patch', patchedPath, '--limit', '2'], { endpoint: 'http://127.0.0.1:1' });
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /--patch 不能和 --limit 一起用/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--index 产出 resource-packs.json 形态，collectPackSizes 能据此补出站点路径的 size', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sp-size-'));
  try {
    const { manifest, out } = await fixture(root);
    const files = [
      { url: 'https://cdn.example.com/release/assets/spine/a/front/a.skel' },
      { url: 'https://cdn.example.com/release/assets/spine/b/front/b.skel' },
    ];
    await writeFile(manifest, JSON.stringify({ version: 7, files }));
    const mock = await mockR2({ sizeOf: (key) => (key.endsWith('a.skel') ? 4096 : 8192) });
    try {
      const result = await run(['--manifest', manifest, '--out', out, '--index'], { endpoint: mock.url });
      assert.equal(result.code, 0, result.stderr);
      const doc = JSON.parse(await readFile(out, 'utf8'));
      assert.equal(doc.format, 'stronghold-resource-pack-index');
      assert.equal(doc.version, 1);
      assert.equal(doc.resourceVersion, 7);
      const sizes = collectPackSizes(doc);
      assert.equal(sizes.get('/assets/spine/a/front/a.skel'), 4096);
      assert.equal(sizes.get('/assets/spine/b/front/b.skel'), 8192);
    } finally {
      mock.server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
