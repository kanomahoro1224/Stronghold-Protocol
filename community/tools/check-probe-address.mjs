// community/tools/check-probe-address.mjs — end-to-end checks for the 「实际探测地址」 field.
//
//   node tools/check-probe-address.mjs
//
// It drives the REAL service (an ephemeral port, a throwaway database in the OS temp dir) over the real API, so
// it covers: the schema migration on an old database, the input validation, which address the probe actually
// uses, the fallback when the field is cleared, and that the field is only exposed to admins.
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import https from 'node:https';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, probeTargetOf, publicServer } from '../server/db.js';
import { readServerInput } from '../server/api.js';
import { probe, invalidate } from '../server/probe.js';
import { startCommunity } from '../server/index.js';

let checks = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  checks += 1;
  if (cond) console.log(`  ✓ ${name}`);
  else { failed += 1; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const dir = mkdtempSync(path.join(tmpdir(), 'sp-community-probe-'));
const dbFile = path.join(dir, 'community.db');
const ADMIN_PW = 'probe-address-test-pw';
process.env.SP_COMMUNITY_ADMIN_PASSWORD = ADMIN_PW;

console.log('1. 旧库迁移：没有 probe_address 列的数据库');
{
  const legacy = new DatabaseSync(dbFile);
  legacy.exec(`
    CREATE TABLE servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT NOT NULL,
      region TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT NOT NULL, login_name TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, last_login_at INTEGER);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    INSERT INTO servers (name, address, region, created_at, updated_at) VALUES ('老节点', 'https://old.example/', 'asia', 1, 1);
  `);
  legacy.close();
  const db = openDatabase({ file: dbFile });
  const cols = db.prepare('PRAGMA table_info(servers)').all().map((c) => c.name);
  ok('自动补上 probe_address 列', cols.includes('probe_address'));
  const row = db.prepare('SELECT * FROM servers WHERE name = ?').get('老节点');
  ok('旧数据没丢，新列为空串', !!row && row.probe_address === '' && row.address === 'https://old.example/');
  ok('probeTargetOf 回退到公开地址', probeTargetOf(row) === 'https://old.example/');
  ok('明确的探测地址优先', probeTargetOf({ address: 'https://public/', probe_address: 'https://probe/' }) === 'https://probe/');
  db.close();
}

console.log('2. 入参校验');
{
  const base = { name: 'n', address: 'https://public.example:34046/', region: 'asia' };
  ok('不传 probeAddress → 结果里不含该字段（不是清空）', !('probeAddress' in readServerInput(base).value));
  ok('自动补 scheme 并规范化', readServerInput({ ...base, probeAddress: '1.2.3.4:34046' }).value.probeAddress === 'https://1.2.3.4:34046/');
  ok('空白串 = 清空', readServerInput({ ...base, probeAddress: '   ' }).value.probeAddress === '');
  ok('非法地址被拒', readServerInput({ ...base, probeAddress: 'not a url' }).ok === false);
  ok('整体更新缺省不报错', readServerInput(base).ok === true);
  ok('局部更新不带它就不动它', !('probeAddress' in readServerInput({ note: 'x' }, { partial: true }).value));
  ok('局部更新可以单独清空', readServerInput({ probeAddress: '' }, { partial: true }).value.probeAddress === '');
  const row = { id: 1, name: 'n', address: 'https://public/', region: 'asia', probe_address: 'https://probe/' };
  ok('公开形状不含 probeAddress', publicServer(row).probeAddress === undefined);
  ok('管理员形状含 probeAddress', publicServer(row, { withProbe: true }).probeAddress === 'https://probe/');
}

console.log('3. 真实 API：探测走哪个地址 + 谁能看到');
const srv = await startCommunity({ port: 0, host: '127.0.0.1', dbFile, quiet: true });
const base = `http://127.0.0.1:${srv.port}`;
let cookie = '';
async function call(method, p, body, { auth = false } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(auth && cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json };
}
try {
  const login = await call('POST', '/api/auth/login', { loginName: 'admin', password: ADMIN_PW });
  ok('管理员登录成功', login.status === 200, JSON.stringify(login.json));

  // 公开地址故意用 TEST-NET-1（RFC 5737，必然连不通），探测地址指向本服务自己 ⇒ 探测可达就证明用的是探测地址。
  const probeTarget = `${base}/`;
  const created = await call('POST', '/api/servers',
    { name: '探测地址测试', address: 'https://192.0.2.1:34046/', region: 'asia', probeAddress: probeTarget },
    { auth: true });
  ok('新增成功（201）', created.status === 201, JSON.stringify(created.json));
  ok('响应里带 probeAddress', created.json?.server?.probeAddress === probeTarget, String(created.json?.server?.probeAddress));
  const id = created.json?.server?.id;

  const adminList = await call('GET', '/api/servers?probe=1', undefined, { auth: true });
  const mine = adminList.json?.servers?.find((s) => s.id === id);
  ok('管理员列表能看到 probeAddress', mine?.probeAddress === probeTarget);
  ok('服务端探测走探测地址 → 判定可达（公开地址 192.0.2.1 是连不通的）', mine?.health?.ok === true, JSON.stringify(mine?.health));

  const guest = await call('GET', '/api/servers?probe=1');
  const guestMine = guest.json?.servers?.find((s) => s.id === id);
  ok('游客拿不到 probeAddress', !!guestMine && guestMine.probeAddress === undefined);
  ok('游客仍能看到健康结论', guestMine?.health?.ok === true);

  const one = await call('GET', `/api/servers/${id}`, undefined, { auth: true });
  ok('单个服务器接口也返回 probeAddress（管理员）', one.json?.server?.probeAddress === probeTarget);

  const cleared = await call('PUT', `/api/servers/${id}`, { probeAddress: '' }, { auth: true });
  ok('清空探测地址后响应里是空串', cleared.json?.server?.probeAddress === '');
  const after = await call('GET', `/api/servers/${id}`, undefined, { auth: true });
  ok('清空后探测回落到公开地址 → 如实判定不可达', after.json?.server?.health?.ok === false, JSON.stringify(after.json?.server?.health));

  const bad = await call('PUT', `/api/servers/${id}`, { probeAddress: 'not a url' }, { auth: true });
  ok('非法探测地址被拒（400）', bad.status === 400 && /探测地址/.test(bad.json?.error?.message || ''), JSON.stringify(bad.json));
} finally {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log('4. 证书放宽：自签证书的节点也要能探到（各游戏节点的证书常年名不匹配）');
{
  const key = readFileSync(new URL('./fixtures/self-signed-key.pem', import.meta.url));
  const cert = readFileSync(new URL('./fixtures/self-signed-cert.pem', import.meta.url));
  const tls = https.createServer({ key, cert }, (req, res) => {
    if (req.url.startsWith('/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: 1, app: 'self-signed-test' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => tls.listen(0, '127.0.0.1', r));
  const url = `https://127.0.0.1:${tls.address().port}/`;
  let plainFetchFailed = false;
  try { await fetch(`${url}healthz`); } catch { plainFetchFailed = true; }
  ok('对照：普通 fetch 因自签证书失败', plainFetchFailed === true);
  const r = await probe(url);
  ok('probe() 放宽校验 → 正常拿到 200 JSON', r.ok === true && r.raw?.app === 'self-signed-test', JSON.stringify(r));
  ok('探到的是节点自己的 /healthz 数据', r.status === 200 && r.latencyMs >= 0);
  invalidate(url);
  await new Promise((r2) => tls.close(r2));
}

console.log(`\n${checks - failed}/${checks} 通过`);
if (failed) process.exitCode = 1;
