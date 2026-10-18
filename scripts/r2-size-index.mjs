#!/usr/bin/env node
// 为 CDN-only 部署补齐资源清单里的 size：按清单逐条 HEAD R2 上的对象，读 Content-Length。
//
// 为什么需要它：素材只在 R2、本机没有文件时，server/resources.js 的清单构建取不到 size，
// 客户端只能显示「大小待确认」。resource-packs.json 的 files[].size 是既有的大小来源
// （collectPackSizes），本脚本就是把这个来源补齐 —— 只发 HEAD，不下载正文、不写远端。
//
// 用法:
//   node --env-file=.env scripts/r2-size-index.mjs                       # 读 data/resource-manifest.json
//   node --env-file=.env scripts/r2-size-index.mjs --manifest https://weishu.xiaolubao.com/data/resource-manifest.json
//   node --env-file=.env scripts/r2-size-index.mjs --index --out data/resource-packs.json
import { createHash, createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const SCRIPT_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(process.env.R2_REPO_ROOT || path.join(SCRIPT_DIR, '..'));
const HEAD_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const PACK_INDEX_FORMAT = 'stronghold-resource-pack-index';
const PACK_INDEX_VERSION = 1;

function usage() {
  return [
    '用法: node scripts/r2-size-index.mjs [选项]',
    '',
    '按资源清单逐条 HEAD R2 对象，生成 size 映射或 resource-packs.json 形态的大小索引。',
    '只读远端：不发 PUT、不下载正文。',
    '',
    '  --manifest <url|文件>  资源清单（默认 data/resource-manifest.json；可给 https:// 线上地址）',
    '  --out <文件>           输出（默认 data/resource-sizes.json）',
    '  --index                输出 resource-packs.json 形态（format/version/packs[].files[]），',
    '                         可被 prepare-r2-data.mjs 与 server/resources.js 的 collectPackSizes 采信',
    '  --patch <文件>         把取到的 size 就地写回清单副本（不动 URL/hash/version，更新 sized/totalBytes）',
    '  --concurrency <n>      并发 HEAD 数（默认 64，或 R2_TRANSFERS；上限 1024）',
    '  --attempts <n>         每个对象最多尝试次数（默认 4，上限 20）',
    '  --resume               续跑：读回 <out>.partial 或已有输出，跳过已取到 size 的条目',
    '  --prefix <前缀>        覆盖 R2_PREFIX（对象键 = 前缀 + 清单 URL 的路径）',
    '  --limit <n>            只处理前 n 条（调试用）',
    '  --fail-list <文件>     缺失/失败清单写入 JSON',
    '  --quiet                只报失败和汇总',
    '  --help                 显示本帮助',
    '',
    '配置：读 config/r2-sync.json，或环境变量 R2_ENDPOINT（或 R2_ACCOUNT_ID）、R2_BUCKET、',
    'R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY、R2_PREFIX、R2_REGION。可用 node --env-file=.env 载入 .env。',
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
        manifest: { type: 'string' },
        out: { type: 'string' },
        index: { type: 'boolean', default: false },
        patch: { type: 'string' },
        concurrency: { type: 'string' },
        attempts: { type: 'string' },
        resume: { type: 'boolean', default: false },
        prefix: { type: 'string' },
        limit: { type: 'string' },
        'fail-list': { type: 'string' },
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
    manifest: options.manifest || path.join(REPO_ROOT, 'data', 'resource-manifest.json'),
    out: options.out || path.join(REPO_ROOT, 'data', 'resource-sizes.json'),
    concurrency: integer('--concurrency', options.concurrency, Number(process.env.R2_TRANSFERS) || 256, 1024),
    attempts: integer('--attempts', options.attempts, 4, 20),
    limit: integer('--limit', options.limit, 0, Number.MAX_SAFE_INTEGER),
  };
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
    return {
      configPath,
      endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
      bucket: r2.bucket,
      access: r2.accessKeyId,
      secret: r2.secretAccessKey,
      prefix: cleanPrefix(r2.prefix),
      region: 'auto',
    };
  }
  const target = String(process.env.R2_TARGET || '');
  const parts = target.startsWith('r2:') ? target.slice(3).split('/') : [];
  const config = {
    configPath: '',
    endpoint: (process.env.R2_ENDPOINT
      || (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '')).replace(/\/+$/, ''),
    bucket: process.env.R2_BUCKET || parts[0] || '',
    access: process.env.R2_ACCESS_KEY_ID || '',
    secret: process.env.R2_SECRET_ACCESS_KEY || '',
    prefix: cleanPrefix(process.env.R2_PREFIX ?? parts.slice(1).join('/')),
    region: process.env.R2_REGION || 'auto',
  };
  for (const [name, value] of Object.entries({ R2_ENDPOINT: config.endpoint, R2_BUCKET: config.bucket, R2_ACCESS_KEY_ID: config.access, R2_SECRET_ACCESS_KEY: config.secret })) {
    if (!value) fail(`缺少环境变量 ${name}（或提供 config/r2-sync.json）`);
  }
  return config;
}

function encodeKey(key) {
  return key.split('/').map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

/** SigV4 签名；每次尝试都重新签，避免长重试后时间戳过期。 */
function sign(cfg, method, key, extra = {}) {
  const payloadHash = createHash('sha256').update('').digest('hex');
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  // accept-encoding: identity —— 否则 Cloudflare 会压缩响应并去掉 content-length，HEAD 就拿不到大小。
  const headers = { host: new URL(cfg.endpoint).host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, 'accept-encoding': 'identity', ...extra };
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
    headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${cfg.access}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` },
  };
}

/** 清单 URL -> R2 对象键：前缀 + URL 的路径（绝对 CDN 地址和站点相对路径都适用）。 */
export function objectKey(url, prefix) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = String(url).split(/[?#]/)[0];
  }
  // 清单把方括号写成 %5B/%5D，而 R2 上的键是上传时的原始文件名，先解码再取键。
  try {
    pathname = decodeURIComponent(pathname);
  } catch { /* 非法转义按原样处理 */ }
  const clean = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const trimmed = cleanPrefix(prefix);
  // 对象键不带前导斜杠（与 sync-to-r2-http.mjs 的键一致）。
  if (!trimmed) return clean.slice(1);
  // CDN 清单里的地址通常已经带前缀（对象键与 CDN 路径一致），再拼一次会变成 prefix/prefix/… 而全部 404。
  if (clean === `/${trimmed}` || clean.startsWith(`/${trimmed}/`)) return clean.slice(1);
  return `${trimmed}${clean}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backoff = (attempt) => Math.min(15000, 500 * 2 ** attempt) + Math.floor(Math.random() * 500);

/** HEAD 拿不到 content-length 时，用 1 字节 Range 请求读 content-range 里的总长。 */
async function sizeViaRange(cfg, key) {
  const { url, headers } = sign(cfg, 'GET', key, { range: 'bytes=0-0' });
  const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) });
  if (res.status !== 200 && res.status !== 206) return { status: res.status, size: null };
  const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
  const length = Number(res.headers.get('content-length'));
  await res.body?.cancel().catch(() => {});
  if (total) return { status: 200, size: Number(total[1]) };
  // 200 表示 Range 被忽略，content-length 就是整份大小。
  return { status: 200, size: res.status === 200 && Number.isSafeInteger(length) && length >= 0 ? length : null };
}

/** 一次 HEAD；200 取 Content-Length，取不到时退回 Range 请求，其余状态原样返回。 */
export async function headObject(cfg, key) {
  const { url, headers } = sign(cfg, 'HEAD', key);
  const res = await fetch(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) });
  if (res.status !== 200) return { status: res.status, size: null };
  const raw = res.headers.get('content-length');
  const size = raw == null ? Number.NaN : Number(raw);
  if (Number.isSafeInteger(size) && size >= 0) return { status: 200, size };
  return sizeViaRange(cfg, key);
}

/** 单行进度；TTY 用 \r 原地刷新，管道下按固定间隔打行。 */
export function createProgress(stream, { isTty, quiet, every = 250 } = {}) {
  const started = Date.now();
  let lastPrint = 0;
  let lastLine = '';
  return {
    report(state, force = false) {
      const now = Date.now();
      if (!force && now - lastPrint < every) return;
      lastPrint = now;
      const seconds = Math.max(0.001, (now - started) / 1000);
      const rate = state.done / seconds;
      const percent = state.total ? (state.done / state.total) * 100 : 0;
      const left = state.done ? Math.round((state.total - state.done) / Math.max(rate, 0.001)) : 0;
      const text = `  ${state.done}/${state.total} ${percent.toFixed(1)}% ${rate.toFixed(0)}/s 失败 ${state.missing} 剩余 ${left}s`;
      if (quiet) return;
      if (isTty) {
        lastLine = text;
        stream.write(`\r${text}\x1b[K`);
      } else {
        stream.write(`${text}\n`);
      }
    },
    finish() {
      if (isTty && lastLine) stream.write('\r\x1b[K');
    },
  };
}

async function readManifest(source) {
  const text = /^https?:\/\//i.test(source)
    ? await (async () => {
      const res = await fetch(source, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) fail(`下载清单失败 ${source}: HTTP ${res.status}`);
      return res.text();
    })()
    : await fs.readFile(source, 'utf8').catch((error) => fail(`读取清单失败 ${source}: ${error.message}`));
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    fail(`清单不是合法 JSON ${source}: ${error.message}`);
  }
  if (!Array.isArray(doc.files)) fail(`清单缺少 files 数组：${source}`);
  return doc;
}

async function main() {
  const options = parseCli();
  const cfg = await resolveConfig(options);
  if (options.prefix != null) cfg.prefix = cleanPrefix(options.prefix);
  const manifest = await readManifest(options.manifest);
  const entries = (options.limit ? manifest.files.slice(0, options.limit) : manifest.files)
    .filter((file) => typeof file?.url === 'string' && file.url);

  const isTty = Boolean(process.stdout.isTTY);
  const progress = createProgress(process.stdout, { isTty, quiet: options.quiet, every: isTty ? 250 : 2000 });
  const sizes = new Map();
  const missing = [];
  const state = { done: 0, total: entries.length, missing: 0 };
  const workers = Math.min(options.concurrency, entries.length) || 1;
  const partialPath = `${options.out}.partial`;
  let next = 0;
  let flushFailList = Promise.resolve();
  let flushPartial = Promise.resolve();
  let lastPartialAt = 0;
  // 持续高并发会被 Cloudflare 限流（成片 fetch failed、速率骤降），所以失败到一定比例就全局冷却，
  // 冷却时间按连续坏窗口翻倍，窗口干净后归零。
  const gate = { until: 0, cooldown: 0, window: [], printed: 0, lastPrint: 0 };

  // --resume：读回上次的半成品（或已完成的输出），跳过已经拿到 size 的条目，避免被中断就得从头再来。
  if (options.resume) {
    for (const file of [partialPath, options.out]) {
      try {
        const doc = JSON.parse(await fs.readFile(file, 'utf8'));
        for (const [url, size] of Object.entries(doc)) if (Number.isSafeInteger(size) && size >= 0) sizes.set(url, size);
        break;
      } catch { /* 没有半成品就从零开始 */ }
    }
    for (const file of entries) if (sizes.has(file.url)) state.done += 1;
  }

  if (!options.quiet) {
    console.log(`  清单 ${options.manifest}：${entries.length} 条，并发 ${workers}，前缀 ${cfg.prefix || '(空)'}${state.done ? `，续跑跳过 ${state.done} 条` : ''}`);
  }

  await Promise.all(Array.from({ length: workers }, async () => {
    for (let index = next++; index < entries.length; index = next++) {
      const url = entries[index].url;
      if (sizes.has(url)) continue;
      const wait = gate.until - Date.now();
      if (wait > 0) await sleep(wait);
      const key = objectKey(url, cfg.prefix);
      let result = { status: 0, size: null };
      for (let attempt = 0; attempt < options.attempts; attempt++) {
        // 被限流时先等全局冷却，避免所有 worker 一起重试把连接再打爆一次。
        const pause = gate.until - Date.now();
        if (pause > 0) await sleep(pause);
        try {
          result = await headObject(cfg, key);
        } catch (error) {
          result = { status: 0, size: null, reason: error.message };
        }
        if (result.status === 200 || result.status === 404) break;
        if (!RETRYABLE_STATUS.has(result.status) && result.status !== 0) break;
        await sleep(backoff(attempt));
      }
      gate.window.push(result.status === 0 ? 1 : 0);
      if (gate.window.length > 64) gate.window.shift();
      if (gate.window.length >= 32) {
        const bad = gate.window.reduce((sum, value) => sum + value, 0) / gate.window.length;
        if (bad >= 0.25) {
          gate.cooldown = Math.min(8000, gate.cooldown ? gate.cooldown * 2 : 500);
          gate.until = Date.now() + gate.cooldown;
          gate.window.length = 0;
        } else if (bad === 0 && gate.cooldown) {
          gate.cooldown = 0;
        }
      }
      if (result.status === 200 && result.size != null) sizes.set(url, result.size);
      else {
        const failure = {
          url,
          key,
          status: result.status,
          reason: result.reason || (result.status === 200 ? '200 但 HEAD 与 Range 都取不到长度' : ''),
        };
        missing.push(failure);
        state.missing = missing.length;
        // 失败立刻报出来并落盘：长时间扫描被中断时，最后汇总的那份清单根本不会写到。
        // 但成片失败时不能逐条刷屏，只报前几个再按时间节流，完整清单在 --fail-list 里。
        gate.printed += 1;
        const stamp = Date.now();
        if (gate.printed <= 5 || stamp - gate.lastPrint > 2000) {
          gate.lastPrint = stamp;
          console.error(`  ✗ ${failure.status || '网络失败'} ${url}${failure.reason ? ` (${failure.reason})` : ''}${gate.printed > 5 ? `（第 ${gate.printed} 个失败，完整清单见 --fail-list）` : ''}`);
        }
        if (options['fail-list']) flushFailList = flushFailList.then(() => fs.writeFile(options['fail-list'], `${JSON.stringify(missing, null, 2)}\n`)).catch(() => {});
      }
      state.done += 1;
      progress.report(state);
      // 定期把半成品落盘，跑几分钟被中断也不用从头再来。
      if (Date.now() - lastPartialAt > 3000) {
        lastPartialAt = Date.now();
        const snapshot = `${JSON.stringify(Object.fromEntries(sizes))}\n`;
        flushPartial = flushPartial.then(() => fs.writeFile(partialPath, snapshot)).catch(() => {});
      }
    }
  }));
  await flushPartial;
  await fs.rm(partialPath, { force: true }).catch(() => {});
  progress.report(state, true);
  progress.finish();

  // 索引同时写绝对 URL 与站点路径两种键：清单 URL 可能是 CDN 绝对地址，而 collectPackSizes 既会按
  // 去掉 CDN 前缀的站点路径查，也会按 URL 原样查，两种都写才不会漏。
  const files = [];
  const seen = new Set();
  const prefixPath = cfg.prefix ? `${cfg.prefix}/` : '';
  for (const [url, size] of sizes) {
    const candidates = [url];
    if (options.index) {
      // 站点路径 = 对象键去掉前缀，与清单 URL 剥掉 CDN 前缀后的形态一致。
      const key = objectKey(url, cfg.prefix);
      candidates.push(key.startsWith(prefixPath) ? `/${key.slice(prefixPath.length)}` : `/${key}`);
    }
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      files.push({ url: candidate, size });
    }
  }
  const out = options.index
    ? {
      format: PACK_INDEX_FORMAT,
      version: PACK_INDEX_VERSION,
      maxBytes: 16000000,
      resourceVersion: Number.isSafeInteger(manifest.version) ? manifest.version : 1,
      packs: [{ id: 'sizes', url: '/resource-packs/sizes.zip', size: 0, sha1: '0'.repeat(40), files }],
    }
    : Object.fromEntries(sizes);
  await fs.mkdir(path.dirname(options.out), { recursive: true });
  await fs.writeFile(options.out, `${JSON.stringify(out)}\n`);

  await flushFailList;
  if (options['fail-list'] && missing.length) {
    await fs.writeFile(options['fail-list'], `${JSON.stringify(missing, null, 2)}\n`);
  }
  if (options.patch) {
    if (options.limit) fail('--patch 不能和 --limit 一起用：只扫描一部分会把清单写成缺 size 的版本');
    const patched = {
      ...manifest,
      files: manifest.files.map((file) => {
        const size = sizes.get(file.url);
        return size == null ? file : { ...file, size };
      }),
    };
    patched.sized = patched.files.filter((file) => Number.isSafeInteger(file.size)).length;
    if (Number.isFinite(manifest.totalBytes)) {
      patched.totalBytes = patched.files.reduce((sum, file) => sum + (Number.isSafeInteger(file.size) ? file.size : 0), 0);
    }
    await fs.mkdir(path.dirname(options.patch), { recursive: true });
    await fs.writeFile(options.patch, `${JSON.stringify(patched)}\n`);
    console.log(`  写回清单 ${options.patch}：sized ${manifest.sized} → ${patched.sized}，totalBytes ${manifest.totalBytes} → ${patched.totalBytes}`);
  }
  console.log(`  完成：有 size ${sizes.size} / 缺失 ${missing.length}，写入 ${options.out}`);
  // 用 exitCode 而不是 process.exit()：高并发下还有 keep-alive 连接，强制退出会在 Windows 上 abort。
  if (missing.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
