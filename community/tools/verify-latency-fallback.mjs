// community/tools/verify-latency-fallback.mjs — dev-only: prove the status pill never guesses wrong about a node.
//
//   node tools/verify-latency-fallback.mjs [baseUrl]        (默认 http://127.0.0.1:3100)
//
// Three passes over the same page:
//   1. 正常          — 服务端可达的节点必须给出本机实测值
//   2. 本机 ping 被拦截 — 这些节点必须仍显示「运行正常」+「本机未测到 · 服务端 NN ms」，绝不能说离线
//   3. 服务端探测被伪造为失败（本机仍能连通）— 该节点必须显示「本机可达」并可点进，不能判离线
//
// The assertions are invariants checked per card against the verdict that card was served, so a node the
// community server genuinely cannot reach (a real offline node) is still allowed to say so. Requires
// puppeteer-core + a local Chrome/Edge.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = (process.argv[2] || 'http://127.0.0.1:3100').replace(/\/+$/, '');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome/Edge'); process.exit(1); }

/** The server's own verdict — the baseline every card is judged against. */
const verdict = await (await fetch(`${BASE}/api/servers?probe=1`)).json();
const cards = verdict.servers.map((s) => ({ id: s.id, name: s.name, serverOk: !!s.health?.ok, error: s.health?.error || null }));
const firstServerOk = cards.find((c) => c.serverOk)?.id ?? null;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });

async function pass({ blockLocal = false, fakeDownId = null } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    // Only the page's own ping to a node (<address>/healthz…), never the community API on BASE.
    if (blockLocal && u.includes('/healthz') && !u.startsWith(BASE)) return req.abort('failed');
    if (fakeDownId != null && u.startsWith(`${BASE}/api/servers?probe=1`)) {
      const body = structuredClone(verdict);
      for (const s of body.servers) {
        if (s.id === fakeDownId) s.health = { ok: false, reachable: false, latencyMs: 4000, error: '探测超时 · timeout' };
      }
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    return req.continue();
  });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 });
  // The first local round (3 samples × 2 rounds + gaps) plus the 5 s retry must have settled.
  await new Promise((r) => setTimeout(r, 16000));
  const report = await page.evaluate(() => ({
    mains: [...document.querySelectorAll('.card__status-main')].map((e) => e.textContent.trim()),
    subs: [...document.querySelectorAll('.card__status-sub')].map((e) => e.textContent.trim().replace(/\s+/g, ' ')),
    enterable: [...document.querySelectorAll('.card')].map((c) => !!c.querySelector('a.btn--primary')),
    classes: [...document.querySelectorAll('.card')].map((c) => c.className),
    stats: [...document.querySelectorAll('.stat__val')].map((e) => e.textContent.trim()),
  }));
  await page.close();
  return { ...report, errors };
}

const normal = await pass();
const blocked = await pass({ blockLocal: true });
const mirror = firstServerOk == null ? null : await pass({ fakeDownId: firstServerOk });
await browser.close();

let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed += 1; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const expFor = (fakeDownId) => cards.map((c) => ({ ...c, serverOk: c.id === fakeDownId ? false : c.serverOk, faked: c.id === fakeDownId }));
const show = (label, r, exp) => {
  console.log(`\n=== ${label} ===`);
  exp.forEach((e, i) => {
    console.log(`  ${i + 1}. ${e.name}  [服务端 ${e.serverOk ? '可达' : '不可达: ' + e.error}${e.faked ? ' (伪造)' : ''}]  →  ${r.mains[i] ?? '(无)'} / ${r.subs[i] ?? '(无)'}  ${r.enterable[i] ? '[可进入]' : '[不可进入]'}`);
  });
  console.log(`  在线节点统计: ${r.stats[0] ?? '?'}`);
};

/** Invariants that must hold for every card, whatever the environment does. */
function invariants(label, r, exp) {
  const hasLocal = r.subs.map((s) => /本机 \d+ ms/.test(s || ''));
  ok(`${label}: 卡片数与服务端列表一致`, r.mains.length === exp.length, `${r.mains.length}/${exp.length}`);
  ok(`${label}: 本机有数 + 服务端可达 → 本机实测`, exp.every((e, i) => !(e.serverOk && hasLocal[i]) || (r.mains[i] === '运行正常' && /^本机 \d+ ms$/.test(r.subs[i] || ''))), r.subs.join(' | '));
  ok(`${label}: 本机无数据 + 服务端可达 → 服务端结果（绝不说离线）`, exp.every((e, i) => !(e.serverOk && !hasLocal[i]) || (r.mains[i] === '运行正常' && /^本机未测到 · 服务端( \d+ ms|正常)$/.test(r.subs[i] || ''))), r.subs.join(' | '));
  ok(`${label}: 本机有数 + 服务端不可达 → 仍是「运行正常」（能连上就是正常）`, exp.every((e, i) => !(!e.serverOk && hasLocal[i]) || (r.mains[i] === '运行正常' && /^服务端.+ · 本机 \d+ ms$/.test(r.subs[i] || ''))), `${r.mains.join(' | ')} // ${r.subs.join(' | ')}`);
  ok(`${label}: 本机有数 + 服务端不可达 → 卡片不能是灰/离线`, exp.every((e, i) => !(!e.serverOk && hasLocal[i]) || /is-online/.test(r.classes[i] || '')), r.classes.join(' | '));
  ok(`${label}: 本机无数据 + 服务端不可达 → 才允许离线`, exp.every((e, i) => !(!e.serverOk && !hasLocal[i]) || r.mains[i] !== '运行正常'), r.mains.join(' | '));
  ok(`${label}: 可进入 ⇔ 服务端可达或本机有数`, exp.every((e, i) => !!r.enterable[i] === (e.serverOk || hasLocal[i])), r.enterable.join(','));
  ok(`${label}: 旧措辞「本机延迟未知」不存在`, r.subs.every((s) => !/延迟未知/.test(s || '')));
  return hasLocal;
}

console.log('=== 判定（逐卡对齐该卡实际拿到的服务端结论）===');
const expNormal = expFor(null);
show('1. 正常本机测速', normal, expNormal);
invariants('正常', normal, expNormal);

const expBlocked = expFor(null);
show('2. 本机 ping 被拦截（模拟瞬时连不上）', blocked, expBlocked);
const blockedLocal = invariants('拦截', blocked, expBlocked);
ok('拦截: 至少有一个服务端可达的节点走服务端回退', expBlocked.some((e) => e.serverOk), `serverOk=${expBlocked.filter((e) => e.serverOk).length}`);
ok('拦截: 服务端可达的节点一个都没被判离线', expBlocked.every((e, i) => !e.serverOk || blocked.mains[i] !== '离线无响应'), blocked.mains.join(' | '));
ok('拦截: 服务端可达的节点本机确实测不到（否则这一趟没验到东西）', expBlocked.every((e, i) => !e.serverOk || !blockedLocal[i]), blockedLocal.join(','));

if (mirror) {
  const expMirror = expFor(firstServerOk);
  show('3. 服务端探测被伪造为失败（本机仍连通）', mirror, expMirror);
  invariants('反向', mirror, expMirror);
  const i = expMirror.findIndex((e) => e.faked);
  ok('反向: 被伪造失败的节点仍是「运行正常」', mirror.mains[i] === '运行正常', `${mirror.mains[i]} / ${mirror.subs[i]}`);
  ok('反向: 副行点明是服务端那一侧失败', /服务端/.test(mirror.subs[i] || '') && /本机 \d+ ms/.test(mirror.subs[i] || ''), mirror.subs[i]);
  ok('反向: 卡片保持绿色 is-online', /is-online/.test(mirror.classes[i] || ''), mirror.classes[i]);
  ok('反向: 该节点仍然可点进', mirror.enterable[i] === true);
  ok('反向: 该节点没有被判离线', mirror.mains[i] !== '离线无响应');
} else {
  console.log('\n(跳过第 3 趟：服务端当前没有任何可达节点可用来伪造)');
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
if (failed) process.exitCode = 1;
