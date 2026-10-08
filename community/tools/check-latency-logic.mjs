// community/tools/check-latency-logic.mjs — pure checks for public/js/latency.js (no browser, no server).
//
//   node tools/check-latency-logic.mjs
//
// The point of this file is the rule the UI must never break: a browser-side miss may NOT paint a node as
// offline, and the fallback wording must say the figure came from the server.
import { measure, measureAll, grade, statusFor } from '../public/js/latency.js';

let checks = 0;
let failed = 0;
const ok = (name, cond) => {
  checks += 1;
  if (cond) console.log(`  ✓ ${name}`);
  else { failed += 1; console.error(`  ✗ ${name}`); }
};

const UP = { ok: true, latencyMs: 42 };
const DOWN = { ok: false, error: '无法连接 · unreachable', latencyMs: 4000 };
const STALE = { ok: false, error: '版本待更新 · please reload' };

console.log('statusFor · 服务端说可达 + 本机有数');
ok('本机 33 ms → local/good', (() => { const s = statusFor({ health: UP, clientMs: 33 }); return s.state === 'local' && s.sub === '本机 33 ms' && s.subTone === 'good'; })());
ok('本机 120 ms → fair', statusFor({ health: UP, clientMs: 120 }).subTone === 'fair');
ok('本机 300 ms → poor', statusFor({ health: UP, clientMs: 300 }).subTone === 'poor');

console.log('statusFor · 服务端说可达 + 本机测不到（本次要修的判断错误）');
const missed = statusFor({ health: UP, clientMs: null, measuring: false });
ok('state 不是 off（绝不判离线）', missed.state === 'ok');
ok('主行仍是运行正常', missed.main === '运行正常');
ok('副行说明是服务端结果', missed.sub === '本机未测到 · 服务端 42 ms');
ok('不再出现「本机延迟未知」', !/延迟未知/.test(missed.sub));
ok('有解释性 tooltip', /服务端/.test(missed.subTitle));
ok('服务端也没给延迟 → 服务端正常', statusFor({ health: { ok: true }, clientMs: null }).sub === '本机未测到 · 服务端正常');
ok('测速中 → 本机测速中…', statusFor({ health: UP, clientMs: null, measuring: true }).sub === '本机测速中…');
ok('未测过（undefined）与测不到（null）同样处理', statusFor({ health: UP }).state === 'ok');

console.log('statusFor · 只有服务端不可达才判离线');
ok('服务端 unreachable → off', (() => { const s = statusFor({ health: DOWN, clientMs: null }); return s.state === 'off' && s.main === '离线无响应'; })());
ok('服务端版本待更新 → warn', (() => { const s = statusFor({ health: STALE }); return s.state === 'warn' && s.main === '版本待更新'; })());
ok('无服务端结论 → pending，不下判断', (() => { const s = statusFor({ health: null }); return s.state === 'pending' && s.main === '探测中…'; })());

console.log('statusFor · 反向：服务端探测失败，但本机刚刚连通（线上 t44 就是这种）');
const mirror = statusFor({ health: DOWN, clientMs: 93 });
ok('state = reachable，不是 off', mirror.state === 'reachable');
ok('主行「本机可达」，不判离线', mirror.main === '本机可达');
ok('副行同时给出服务端错误与本机实测', mirror.sub === '无法连接 · unreachable · 本机 93 ms');
ok('tooltip 说明是服务端出口的问题', /浏览器/.test(mirror.subTitle));
ok('版本待更新 + 本机可达 → 保留原因', (() => { const s = statusFor({ health: STALE, clientMs: 50 }); return s.state === 'reachable' && /版本/.test(s.sub) && /本机 50 ms/.test(s.sub); })());

console.log('grade 分档');
ok('null → none', grade(null) === 'none');
ok('79 → good / 80 → fair / 180 → poor', grade(79) === 'good' && grade(80) === 'fair' && grade(180) === 'poor');

console.log('measure · 瞬时失败要重试，全失败才算测不到');
const realFetch = globalThis.fetch;
let calls = 0;
try {
  globalThis.fetch = async () => { calls += 1; throw new Error('blocked'); };
  const all = await measure('https://node.example/');
  ok('全失败 → null', all === null);
  ok('确实重试了一整轮（3 次 × 2 轮）', calls === 6);

  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls <= 3) throw new Error('transient');
    return new Response('', { status: 200 });
  };
  const transient = await measure('https://node.example/');
  ok('第一轮失败、第二轮成功 → 拿到数字', typeof transient === 'number' && transient >= 0);
  ok('第一轮 3 次全失败后重试，第二轮 3 次都打出去', calls === 6);

  calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('', { status: 200 }); };
  const good = await measure('https://node.example/');
  ok('第一次就成功 → 数字 + 只打 3 次', typeof good === 'number' && calls === 3);

  globalThis.fetch = async () => { throw new Error('blocked'); };
  const many = await measureAll([{ id: 1, address: 'https://a.example/' }, { id: 2, address: 'https://b.example/' }]);
  ok('measureAll 保留 id→null 结构', many['1'] === null && many['2'] === null);

  const bad = await measure('not a url');
  ok('非法地址 → null 且不请求', bad === null);
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${checks - failed}/${checks} 通过`);
if (failed) process.exitCode = 1;
