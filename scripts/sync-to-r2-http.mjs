#!/usr/bin/env node
// 不依赖 rclone 的 R2 上传脚本，供装不了 rclone 的部署机使用。
// 目标前缀、Cache-Control、发布顺序（素材先于 data 清单）与 scripts/sync-to-r2.sh 保持一致，
// 只用 Node 内置能力：fetch + node:crypto 手写 SigV4。
//
// 与 sync-to-r2.sh 的差异（有意为之，写入 docs/R2_SYNC.md）：
//   - 默认只预演，--apply 才写远端；没有 --mirror，不会删除远端对象。
//   - 逐文件失败重试，失败的键名全部打印，可用 --fail-list 落盘、--retry-file 只补传失败文件。
//
// 用法:
//   node scripts/sync-to-r2-http.mjs                       # 预演（读 config/r2-sync.json）
//   node --env-file=.env scripts/sync-to-r2-http.mjs --apply
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const SCRIPT_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(process.env.R2_REPO_ROOT || path.join(SCRIPT_DIR, '..'));
const CACHE_ASSET = 'public, max-age=86400';
const CACHE_DATA = 'no-cache';
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const HEAD_TIMEOUT_MS = 60_000;
const PUT_TIMEOUT_MS = 300_000;

// 前缀 -> 本地目录；顺序即发布顺序，data 必须在所有素材之后。
const TREES = [
  { id: 'assets', source: 'public/assets', cacheControl: CACHE_ASSET },
  { id: 'fonts', source: 'public/fonts', cacheControl: CACHE_ASSET, optional: true },
  { id: 'i18n', source: 'public/i18n', cacheControl: CACHE_ASSET, optional: true },
  { id: 'resource-packs', source: 'public/resource-packs', cacheControl: CACHE_ASSET, optional: true },
  { id: 'packs', source: 'packs', cacheControl: CACHE_DATA, optional: true },
  { id: 'data', source: 'data', cacheControl: CACHE_DATA, staged: true },
];

const MIME_TYPES = {
  '.avif': 'image/avif', '.bin': 'application/octet-stream', '.css': 'text/css', '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.m4a': 'audio/mp4', '.md': 'text/markdown; charset=utf-8',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.ogg': 'audio/ogg', '.otf': 'font/otf', '.pdf': 'application/pdf',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
  '.webm': 'video/webm', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.xml': 'application/xml',
  '.zip': 'application/zip',
};

function usage() {
  return [
    '用法: node scripts/sync-to-r2-http.mjs [选项]',
    '',
    '  --config <文件>      JSON 配置（默认 config/r2-sync.json，与 sync-to-r2.sh 相同）',
    '  --apply              真正上传；不加则只预演，不写远端',
    '  --only <列表>        只同步这些前缀：assets,fonts,i18n,resource-packs,packs,data',
    '  --concurrency <n>    并发请求数（默认 32，或配置 sync.transfers；上限 1024）',
    '  --max-inflight-mb <n> 在途上传字节上限，MB（默认 512）；大文件会排队，小文件可跑满并发',
    '  --attempts <n>       每个文件最多尝试次数（默认 5）',
    '  --force              不跳过已存在且大小一致的对象',
    '  --checksum           额外比较本机 MD5 与远端 ETag，再决定是否跳过',
    '  --fail-list <文件>   失败清单写入 JSON，可直接喂给 --retry-file',
    '  --retry-file <文件>  只补传该清单里列出的对象',
    '  --no-purge           --apply 时不清 Cloudflare 缓存（配置模式默认清理）',
    '  --quiet              只报失败和汇总',
    '  --help               显示本帮助',
    '',
    '环境变量模式（无配置文件时）：R2_ENDPOINT 或 R2_ACCOUNT_ID、R2_BUCKET、R2_ACCESS_KEY_ID、',
    'R2_SECRET_ACCESS_KEY、R2_PREFIX（或 R2_TARGET=r2:<bucket>/<prefix>）、ASSETS_CDN_BASE_URL、',
    'SP_RESOURCE_PACK_ROUTES、R2_TRANSFERS。可用 node --env-file=.env 载入 .env。',
  ].join('\n');
}

function fail(message) {
  console.error(`错误: ${message}`);
  process.exit(2);
}

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        config: { type: 'string' },
        apply: { type: 'boolean', default: false },
        only: { type: 'string' },
        concurrency: { type: 'string' },
        'max-inflight-mb': { type: 'string' },
        attempts: { type: 'string' },
        force: { type: 'boolean', default: false },
        checksum: { type: 'boolean', default: false },
        'fail-list': { type: 'string' },
        'retry-file': { type: 'string' },
        'no-purge': { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (error) {
    fail(`${error.message}\n\n${usage()}`);
  }
  const options = parsed.values;
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  const integer = (name, value, fallback, max) => {
    if (value == null) return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > max) fail(`${name} 必须是 1 到 ${max} 的整数`);
    return number;
  };
  return {
    ...options,
    concurrency: integer('--concurrency', options.concurrency, 0, 1024),
    maxInflightBytes: integer('--max-inflight-mb', options['max-inflight-mb'], 512, 16384) * 1024 * 1024,
    attempts: integer('--attempts', options.attempts, 5, 20),
  };
}

function pickOnly(value) {
  if (!value) return null;
  const wanted = value.split(',').map((part) => part.trim()).filter(Boolean);
  const known = new Set(TREES.map((tree) => tree.id));
  for (const id of wanted) if (!known.has(id)) fail(`--only 不认识的前缀: ${id}`);
  return new Set(wanted);
}

function cleanPrefix(value) {
  return String(value || '').replace(/^\/+|\/+$/g, '');
}

/** 读 config/r2-sync.json，或退回环境变量；凭据只留在内存，永不打印。 */
async function resolveConfig(options) {
  const configPath = options.config
    || (existsSync(path.join(REPO_ROOT, 'config/r2-sync.json')) ? path.join(REPO_ROOT, 'config/r2-sync.json') : '');
  if (configPath) {
    let doc;
    try {
      doc = JSON.parse(await fs.readFile(configPath, 'utf8'));
    } catch (error) {
      fail(`读取配置失败 ${configPath}: ${error.message}`);
    }
    const r2 = doc.r2 || {};
    for (const field of ['accountId', 'accessKeyId', 'secretAccessKey', 'bucket']) {
      if (typeof r2[field] !== 'string' || !r2[field].trim()) fail(`配置缺少 r2.${field}`);
    }
    if (!/^[a-f0-9]{32}$/i.test(r2.accountId)) fail('r2.accountId 必须是 32 位十六进制');
    const prefix = cleanPrefix(r2.prefix);
    if (prefix.split('/').some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) fail('r2.prefix 含非法路径段');
    const sync = doc.sync || {};
    const cloudflare = doc.cloudflare || {};
    return {
      configPath,
      endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
      bucket: r2.bucket,
      access: r2.accessKeyId,
      secret: r2.secretAccessKey,
      prefix,
      region: 'auto',
      assetsBase: String(doc.cdn?.assetsBaseUrl || '').replace(/\/+$/, ''),
      packRoutes: JSON.stringify(sync.packRoutes ?? []),
      concurrency: Number.isInteger(sync.transfers) ? sync.transfers : 32,
      purge: !options['no-purge'] && cloudflare.zoneId && cloudflare.apiToken ? { zoneId: cloudflare.zoneId } : null,
    };
  }
  const target = String(process.env.R2_TARGET || '');
  const parts = target.startsWith('r2:') ? target.slice(3).split('/') : [];
  const endpoint = process.env.R2_ENDPOINT
    || (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
  const config = {
    configPath: '',
    endpoint: endpoint.replace(/\/+$/, ''),
    bucket: process.env.R2_BUCKET || parts[0] || '',
    access: process.env.R2_ACCESS_KEY_ID || '',
    secret: process.env.R2_SECRET_ACCESS_KEY || '',
    prefix: cleanPrefix(process.env.R2_PREFIX ?? parts.slice(1).join('/')),
    region: process.env.R2_REGION || 'auto',
    assetsBase: String(process.env.ASSETS_CDN_BASE_URL || '').replace(/\/+$/, ''),
    packRoutes: process.env.SP_RESOURCE_PACK_ROUTES || '[]',
    concurrency: Number(process.env.R2_TRANSFERS) || 32,
    purge: null,
  };
  for (const [name, value] of Object.entries({ R2_ENDPOINT: config.endpoint, R2_BUCKET: config.bucket, R2_ACCESS_KEY_ID: config.access, R2_SECRET_ACCESS_KEY: config.secret })) {
    if (!value) fail(`缺少环境变量 ${name}（或提供 --config）`);
  }
  return config;
}

function encodeKey(key) {
  return key.split('/').map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

/** SigV4 签名；每次尝试都重新签，避免长重试后时间戳过期。 */
function sign(cfg, method, key, { body = Buffer.alloc(0), contentType = '', cacheControl = '' } = {}) {
  const payloadHash = createHash('sha256').update(body).digest('hex');
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers = { host: new URL(cfg.endpoint).host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (contentType) headers['content-type'] = contentType;
  if (cacheControl) headers['cache-control'] = cacheControl;
  const names = Object.keys(headers).sort();
  const canonicalRequest = [
    method,
    `/${cfg.bucket}/${encodeKey(key)}`,
    '',
    names.map((name) => `${name}:${headers[name]}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const hmac = (keyBytes, message) => createHmac('sha256', keyBytes).update(message).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secret}`, dateStamp), cfg.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    url: `${cfg.endpoint}/${cfg.bucket}/${encodeKey(key)}`,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${cfg.access}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 网络类失败（连接重置 / TLS 握手失败）在高并发下会成片出现，退避要够长才能自愈。
const backoff = (attempt) => Math.min(15000, 500 * 2 ** attempt) + Math.floor(Math.random() * 500);

async function send(cfg, method, key, options) {
  const { url, headers } = sign(cfg, method, key, options);
  return fetch(url, {
    method,
    headers,
    body: method === 'PUT' ? options.body : undefined,
    signal: AbortSignal.timeout(method === 'PUT' ? PUT_TIMEOUT_MS : HEAD_TIMEOUT_MS),
  });
}

/** 在途字节上限：小文件能跑满并发，大文件自动排队，避免几百 MB 同时读进内存。 */
function createByteLimiter(budget) {
  let used = 0;
  const waiters = [];
  const pump = () => {
    while (waiters.length) {
      const next = waiters[0];
      if (used > 0 && used + next.size > budget) return;
      waiters.shift();
      used += next.size;
      next.resolve(() => { used -= next.size; pump(); });
    }
  };
  return { acquire: (size) => new Promise((resolve) => { waiters.push({ size, resolve }); pump(); }) };
}

async function md5Hex(file) {
  return createHash('md5').update(await fs.readFile(file)).digest('hex');
}

function mimeFor(key) {
  return MIME_TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream';
}

/** 一个文件的完整流程：可选 HEAD 跳过，然后 PUT，逐次重试。返回 'skip' | 'put' | 失败原因。 */
async function uploadOne(cfg, job, options) {
  const { key, file, size, cacheControl } = job;
  let lastReason = '';
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      if (!options.force && attempt === 1) {
        const head = await send(cfg, 'HEAD', key);
        if (head.status === 200) {
          const remoteSize = Number(head.headers.get('content-length'));
          let same = Number.isFinite(remoteSize) && remoteSize === size;
          if (same && options.checksum) {
            const etag = String(head.headers.get('etag') || '').replace(/"/g, '').toLowerCase();
            same = /^[a-f0-9]{32}$/.test(etag) && etag === await md5Hex(file);
          }
          if (same) return 'skip';
        } else if (head.status !== 404) {
          lastReason = `HEAD ${head.status}`;
          if (!RETRYABLE_STATUS.has(head.status)) return `HEAD ${head.status}`;
          if (attempt < options.attempts) await sleep(backoff(attempt));
          continue;
        }
      }
      const release = await options.limiter.acquire(size);
      try {
        const response = await send(cfg, 'PUT', key, { body: await fs.readFile(file), contentType: mimeFor(key), cacheControl });
        if (response.status === 200 || response.status === 201) return 'put';
        lastReason = `PUT ${response.status}${(await response.text().catch(() => '')).slice(0, 160)}`;
        if (!RETRYABLE_STATUS.has(response.status)) return lastReason;
      } finally {
        release();
      }
    } catch (error) {
      lastReason = `${error.name}: ${error.message}`;
    }
    if (attempt < options.attempts) await sleep(backoff(attempt));
  }
  return lastReason || '未知失败';
}

async function walk(dir, base = dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return out;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(abs, base, out);
    else if (entry.isFile()) out.push({ abs, rel: path.relative(base, abs).replace(/\\/g, '/') });
  }
  return out;
}

/** data/ 先在临时目录跑一遍 prepare-r2-data.mjs，保持与 sync-to-r2.sh 相同的改写与校验。 */
async function stageData(cfg) {
  process.stdout.write('正在生成 data 清单（prepare-r2-data.mjs）…\n');
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-r2-http.'));
  const dataDir = path.join(workDir, 'data');
  await fs.cp(path.join(REPO_ROOT, 'data'), dataDir, { recursive: true });
  const result = spawnSync(process.execPath, [
    path.join(SCRIPT_DIR, 'prepare-r2-data.mjs'), dataDir, path.join(REPO_ROOT, 'public'), cfg.assetsBase, cfg.packRoutes,
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    await fs.rm(workDir, { recursive: true, force: true });
    throw new Error(`prepare-r2-data.mjs 失败: ${(result.stderr || String(result.status)).trim()}`);
  }
  return { workDir, dataDir };
}

async function buildPlan(cfg, trees) {
  process.stdout.write('正在扫描本地文件…\n');
  const staged = trees.some((tree) => tree.staged) ? await stageData(cfg) : null;
  try {
    const groups = [];
    for (const tree of trees) {
      const root = tree.staged ? staged.dataDir : path.join(REPO_ROOT, tree.source);
      const files = await walk(root);
      if (!files.length) {
        if (!tree.optional) throw new Error(`目录为空或不存在: ${tree.source}`);
        continue;
      }
      const jobs = [];
      for (const { abs, rel } of files) {
        const { size } = await fs.stat(abs);
        jobs.push({ key: [cfg.prefix, tree.id, rel].filter(Boolean).join('/'), file: abs, size, cacheControl: tree.cacheControl });
      }
      groups.push({ tree, jobs });
    }
    return { groups, staged };
  } catch (error) {
    if (staged) await fs.rm(staged.workDir, { recursive: true, force: true });
    throw error;
  }
}

async function runPool(jobs, limit, worker, options) {
  const queue = jobs.slice();
  const total = jobs.length;
  const results = [];
  let done = 0;
  let lastPrint = 0;
  const tally = (state) => results.filter((result) => result.state === state).length;
  const report = (force) => {
    const now = Date.now();
    if (!force && now - lastPrint < 2000 && done % 500 !== 0) return;
    lastPrint = now;
    process.stdout.write(`  ... ${done}/${total}（上传 ${tally('put')} / 跳过 ${tally('skip')} / 失败 ${tally('fail')}）\n`);
  };
  const runner = async () => {
    while (queue.length) {
      const job = queue.shift();
      const result = await worker(job);
      results.push(result);
      done += 1;
      if (result.state === 'fail') process.stderr.write(`  ❌ ${result.job.key}  ${result.reason}\n`);
      else if (result.state === 'put' && !options.quiet) process.stdout.write(`  ✅ ${(result.job.size / 1024).toFixed(0)} KB  ${result.job.key}\n`);
      if (options.quiet) report(done === 1);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, runner));
  report(true);
  return results;
}

async function purgeCache(cfg) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-r2-purge.'));
  try {
    const result = spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'prepare-r2-config.mjs'), cfg.configPath, workDir], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`prepare-r2-config.mjs 失败: ${(result.stderr || String(result.status)).trim()}`);
    const runtime = JSON.parse(await fs.readFile(path.join(workDir, 'runtime.json'), 'utf8'));
    const doc = JSON.parse(await fs.readFile(cfg.configPath, 'utf8'));
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${runtime.zoneId}/purge_cache`, {
      method: 'POST',
      headers: { authorization: `Bearer ${doc.cloudflare.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(runtime.purge),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success !== true) throw new Error(`Cloudflare 缓存清理失败（HTTP ${response.status}）；修好权限后重跑本脚本即可补齐`);
    console.log('Cloudflare 缓存清理已受理。');
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseCli();
  const only = pickOnly(options.only);
  const cfg = await resolveConfig(options);
  const trees = TREES.filter((tree) => !only || only.has(tree.id));
  const concurrency = options.concurrency || cfg.concurrency;
  options.limiter = createByteLimiter(options.maxInflightBytes);

  const retryKeys = options['retry-file']
    ? new Set((JSON.parse(await fs.readFile(options['retry-file'], 'utf8')).failures || []).map((entry) => entry.key))
    : null;

  const { groups, staged } = await buildPlan(cfg, trees);
  try {
    const plan = groups.map(({ tree, jobs }) => ({
      tree,
      jobs: retryKeys ? jobs.filter((job) => retryKeys.has(job.key)) : jobs,
    })).filter(({ jobs }) => jobs.length);
    const totalFiles = plan.reduce((sum, group) => sum + group.jobs.length, 0);
    const totalBytes = plan.reduce((sum, group) => sum + group.jobs.reduce((bytes, job) => bytes + job.size, 0), 0);
    const target = `s3://${cfg.bucket}/${cfg.prefix ? `${cfg.prefix}/` : ''}`;
    console.log(`${options.apply ? '上传' : '预演'} ${totalFiles} 个文件，${(totalBytes / 1048576).toFixed(2)} MB -> ${target}（并发 ${concurrency}，在途上限 ${(options.maxInflightBytes / 1048576).toFixed(0)} MB）`);
    for (const { tree, jobs } of plan) {
      console.log(`  ${tree.id.padEnd(15)} ${String(jobs.length).padStart(6)} 个  ${(jobs.reduce((bytes, job) => bytes + job.size, 0) / 1048576).toFixed(2)} MB  Cache-Control: ${tree.cacheControl}`);
    }
    if (retryKeys) console.log(`  只补传 --retry-file 里列出的 ${totalFiles} 个对象`);
    if (!options.apply) {
      console.log('预演结束：没有写入远端。确认后加 --apply。');
      return 0;
    }

    const failures = [];
    let uploaded = 0;
    let skipped = 0;
    const startedAt = Date.now();
    for (const { tree, jobs } of plan) {
      console.log(`→ ${tree.id} 开始（${jobs.length} 个）`);
      const results = await runPool(jobs, concurrency, (job) => uploadOne(cfg, job, options).then((outcome) => (
        outcome === 'skip' ? { state: 'skip', job } : outcome === 'put' ? { state: 'put', job } : { state: 'fail', job, reason: outcome }
      )), options);
      for (const result of results) {
        if (result.state === 'skip') skipped += 1;
        else if (result.state === 'put') uploaded += 1;
        else failures.push({ key: result.job.key, size: result.job.size, reason: result.reason });
      }
      if (!options.quiet) console.log(`  ${tree.id} 完成：上传 ${results.filter((r) => r.state === 'put').length} / 跳过 ${results.filter((r) => r.state === 'skip').length} / 失败 ${results.filter((r) => r.state === 'fail').length}`);
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`完成: 上传 ${uploaded} / 跳过 ${skipped} / 失败 ${failures.length}（${seconds}s）`);
    if (failures.length) {
      console.error(`失败文件 ${failures.length} 个（全部列出，可 --fail-list 落盘后 --retry-file 补传）:`);
      for (const failure of failures) console.error(`  ${failure.key}  ${failure.size} B  ${failure.reason}`);
      if (options['fail-list']) {
        await fs.writeFile(options['fail-list'], `${JSON.stringify({
          generator: 'scripts/sync-to-r2-http.mjs',
          target,
          createdAt: new Date().toISOString(),
          attempts: options.attempts,
          failures,
        }, null, 1)}\n`);
        console.log(`失败清单已写入 ${options['fail-list']}；补传：--retry-file ${options['fail-list']}`);
      }
      return 1;
    }
    if (cfg.purge) await purgeCache(cfg);
    return 0;
  } finally {
    if (staged) await fs.rm(staged.workDir, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`错误: ${error.message}`);
  process.exitCode = 1;
}
