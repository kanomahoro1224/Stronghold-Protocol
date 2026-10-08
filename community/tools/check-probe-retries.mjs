// community/tools/check-probe-retries.mjs — 服务端探测的「三次机会」规则（纯 Node，无浏览器）。
//
//   node tools/check-probe-retries.mjs
//
// 用户规则（2026-10-08）：超时一般不会三次都超时，**只有三次都超时才判不正常**。
// 所以这里用真实的本地 HTTP 服务把这几种情况都跑一遍：
//   1. 黑孔（连得上但永不响应）→ 必须恰好尝试 3 次，结论 ok:false；
//   2. 前两次超时、第三次正常响应 → 必须判 ok:true（一两次抖动不能定生死）；
//   3. 第一次就成功 → 只探 1 次；
//   4. HTTP 500 → 有明确结论，不再重试（只探 1 次）；
//   5. 响应不是 JSON → 只探 1 次；
//   6. 同地址并发 → 只发 1 次请求（in-flight 复用）；
//   7. 成功缓存 100ms / 失败缓存 250ms 生效。
import http from 'node:http';

// 必须在 import server/probe.js 之前设好：常量在模块加载时读取。
process.env.SP_COMMUNITY_PROBE_TIMEOUT_MS = '150';
process.env.SP_COMMUNITY_PROBE_RETRY_TIMEOUT_MS = '120';
process.env.SP_COMMUNITY_PROBE_ATTEMPTS = '3';
process.env.SP_COMMUNITY_PROBE_BUDGET_MS = '600';
process.env.SP_COMMUNITY_PROBE_TTL_MS = '100';
process.env.SP_COMMUNITY_PROBE_FAILED_TTL_MS = '250';

const { probe, invalidate } = await import('../server/probe.js');

let checks = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  checks += 1;
  if (cond) console.log(`  ✓ ${name}`);
  else { failed += 1; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

/** Start a throwaway listener and return `{ url, hits }`. */
async function node(handler) {
  const state = { hits: 0 };
  const server = http.createServer((req, res) => { state.hits += 1; handler(req, res, state); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  state.server = server;
  state.url = `http://127.0.0.1:${server.address().port}/`;
  state.close = () => new Promise((r) => server.close(r));
  return state;
}
const json = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, app: 'v0.2.1' })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('1. 黑孔（连得上、永不响应）⇒ 必须恰好 3 次尝试');
{
  const s = await node(() => { /* 永不响应 */ });
  invalidate();
  const r = await probe(s.url);
  ok('结论 ok:false', r.ok === false, JSON.stringify(r));
  ok('error 是超时', /timeout|超时/.test(r.error || ''), r.error);
  ok('attempts = 3（三次都超时才判不正常）', r.attempts === 3, `attempts=${r.attempts}`);
  ok('服务端确实收到了 3 次连接', s.hits === 3, `hits=${s.hits}`);
  await s.close();
}

console.log('2. 前两次超时、第三次正常 ⇒ 判「可达」');
{
  const s = await node((req, res, st) => { if (st.hits < 3) return; json(res); });
  invalidate();
  const r = await probe(s.url);
  ok('结论 ok:true（一两次抖动不能定生死）', r.ok === true, JSON.stringify(r));
  ok('attempts = 3', r.attempts === 3, `attempts=${r.attempts}`);
  ok('拿到了 healthz 原始数据', r.raw && r.raw.app === 'v0.2.1');
  ok('服务端收到 3 次连接', s.hits === 3, `hits=${s.hits}`);
  await s.close();
}

console.log('3. 第一次就成功 ⇒ 不重试');
{
  const s = await node((req, res) => json(res));
  invalidate();
  const r = await probe(s.url);
  ok('ok:true 且 attempts=1', r.ok === true && r.attempts === 1, `attempts=${r.attempts}`);
  ok('只发了 1 次请求', s.hits === 1, `hits=${s.hits}`);
  await s.close();
}

console.log('4. HTTP 500 ⇒ 有明确结论，不重试');
{
  const s = await node((req, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"ok":false}'); });
  invalidate();
  const r = await probe(s.url);
  ok('ok:false 且 attempts=1', r.ok === false && r.attempts === 1, `attempts=${r.attempts}`);
  ok('只发了 1 次请求', s.hits === 1, `hits=${s.hits}`);
  await s.close();
}

console.log('5. 响应不是 JSON ⇒ 不重试');
{
  const s = await node((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>hi</html>'); });
  invalidate();
  const r = await probe(s.url);
  ok('ok:false 且 attempts=1', r.ok === false && r.attempts === 1, `attempts=${r.attempts}`);
  ok('error 说明不是 JSON', /JSON/.test(r.error || ''), r.error);
  await s.close();
}

console.log('6. 同地址并发 ⇒ 复用同一次探测');
{
  const s = await node(async (req, res) => { await sleep(60); json(res); });
  invalidate();
  const [a, b] = await Promise.all([probe(s.url), probe(s.url)]);
  ok('两次调用都拿到结果', a.ok === true && b.ok === true);
  ok('服务端只收到 1 次请求（in-flight 复用）', s.hits === 1, `hits=${s.hits}`);
  await s.close();
}

console.log('7. 缓存：成功 100ms、失败 250ms');
{
  const s = await node((req, res, st) => { if (st.hits <= 3) return; json(res); }); // 前 3 次超时（一次失败结论）
  invalidate();
  const first = await probe(s.url);
  ok('第一次：失败', first.ok === false, JSON.stringify(first));
  const hitsAfterFirst = s.hits;
  const cached = await probe(s.url);
  ok('失败结果被缓存（不再发请求）', cached.ok === false && s.hits === hitsAfterFirst, `hits=${s.hits}/${hitsAfterFirst}`);
  await sleep(300);
  const refetched = await probe(s.url);
  ok('过了失败 TTL 会重新探（这次成功）', refetched.ok === true, JSON.stringify(refetched));
  await s.close();
}

console.log(`\n${checks - failed}/${checks} 通过`);
if (failed) process.exitCode = 1;
