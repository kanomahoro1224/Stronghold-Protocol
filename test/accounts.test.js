// test/accounts.test.js — account service: schema, codes/sessions, cloud save, history, demos, recording, REST.
// Needs a real PostgreSQL: set DATABASE_URL (tools/dev-postgres.mjs prints one). Without it the whole file skips,
// because the rest of the test suite must keep running on machines without a database.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createDb } from '../server/accounts/db.js';
import { createAuth, readCookie, sessionCookie } from '../server/accounts/auth.js';
import { createTurnstile } from '../server/accounts/turnstile.js';
import { getProfile, putProfile, linkPlayer, listMatches, getDemo, canWatchDemo, putAccountDemo, listAccountDemos, getAccountDemo } from '../server/accounts/store.js';
import { createDemoRecorder } from '../server/accounts/recorder.js';
import { createAccountApi } from '../server/accounts/api.js';

const CONN = process.env.SP_TEST_DATABASE_URL || process.env.DATABASE_URL || '';

/** @type {any} */ let db;
/** @type {string[]} */ const mails = [];

before(async () => {
  if (!CONN) return;
  db = await createDb({ url: CONN, log: {} });
  await db.query(`TRUNCATE accounts, email_codes, sessions, profiles, match_records, demos, player_links RESTART IDENTITY CASCADE`);
});

after(async () => { await db?.close(); });

test('accounts: schema, e-mail codes, sessions', { skip: !CONN }, async () => {
  const mailer = {
    ready: false, dev: true,
    async sendCode({ to, code }) { mails.push(`${to}:${code}`); return { sent: false, dev: true }; },
  };
  const turnstile = createTurnstile({ secret: '', log: {} }); // official always-pass test secret
  const auth = createAuth({ db, mailer, turnstile, pepper: 'test-pepper' });

  const bad = await auth.requestCode({ email: 'nope', turnstileToken: 'x' });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);

  const noToken = await auth.requestCode({ email: 'a@b.co', turnstileToken: '' });
  assert.equal(noToken.code, 'TURNSTILE_FAILED');

  const sent = await auth.requestCode({ email: 'A@B.co ', turnstileToken: 'test-token' });
  assert.equal(sent.ok, true);
  assert.equal(sent.email, 'a@b.co');
  const code = sent.devCode;
  assert.match(code, /^\d{6}$/);

  assert.equal((await auth.verify({ email: 'a@b.co', code: '000000' === code ? '111111' : '000000' })).code, 'CODE_WRONG');
  const ok = await auth.verify({ email: 'a@b.co', code });
  assert.equal(ok.ok, true);
  const token = ok.token;
  const me = await auth.resolve(token);
  assert.equal(me.email, 'a@b.co');

  // single use
  assert.equal((await auth.verify({ email: 'a@b.co', code })).code, 'CODE_USED');
  await auth.logout(token);
  assert.equal(await auth.resolve(token), null);

  // rate limit: second code within the minute
  await auth.requestCode({ email: 'c@d.co', turnstileToken: 't' });
  assert.equal((await auth.requestCode({ email: 'c@d.co', turnstileToken: 't' })).code, 'RATE_LIMITED');

  assert.equal(readCookie(`${sessionCookie('tok')}; x=1`), 'tok');
  assert.match(sessionCookie('tok'), /HttpOnly/);
});

test('accounts: password login and the #tag that follows the account', { skip: !CONN }, async () => {
  const mailer = { ready: false, dev: true, async sendCode() { return { sent: false, dev: true }; } };
  const turnstile = createTurnstile({ secret: '', log: {} });
  const auth = createAuth({ db, mailer, turnstile, pepper: 'test-pepper' });

  const first = await auth.requestCode({ email: 'tag@x.co', turnstileToken: 't', mode: 'register' });
  assert.equal(first.ok, true);

  // 弱密码 / 非法识别号在验证码被消费之前就拒绝，玩家可以原地改
  assert.equal((await auth.verify({ email: 'tag@x.co', code: first.devCode, password: '123' })).code, 'PASSWORD_WEAK');
  assert.equal((await auth.verify({ email: 'tag@x.co', code: first.devCode, tag: '42' })).code, 'TAG_INVALID');

  const created = await auth.verify({ email: 'tag@x.co', code: first.devCode, password: 'secret123', name: '博士 A', tag: '0042' });
  assert.equal(created.ok, true);
  assert.equal(created.account.tag, '0042');
  assert.equal(created.account.name, '博士 A');
  assert.equal(created.account.passwordHash, undefined); // 哈希不出现在 API 形状里

  // 会话解析把代号 / 识别号一起带回来 → 标题页登录后自动填入
  const resolved = await auth.resolve(created.token);
  assert.equal(resolved.tag, '0042');
  assert.equal(resolved.name, '博士 A');

  // 密码登录：密码错、账号不存在都说 BAD_CREDENTIALS（不给人枚举邮箱）
  assert.equal((await auth.loginWithPassword({ email: 'tag@x.co', password: 'nope-123' })).code, 'BAD_CREDENTIALS');
  assert.equal((await auth.loginWithPassword({ email: 'ghost@x.co', password: 'secret123' })).code, 'BAD_CREDENTIALS');
  const pwLogin = await auth.loginWithPassword({ email: 'TAG@x.co ', password: 'secret123' });
  assert.equal(pwLogin.ok, true);
  assert.equal(pwLogin.account.tag, '0042');

  // 识别号全局唯一：撞号时验证码不被消费，换个号立刻能过（否则要等 60 秒再收一封信）
  const second = await auth.requestCode({ email: 'tag2@x.co', turnstileToken: 't', mode: 'register' });
  assert.equal((await auth.verify({ email: 'tag2@x.co', code: second.devCode, tag: '0042' })).code, 'TAG_TAKEN');
  const retried = await auth.verify({ email: 'tag2@x.co', code: second.devCode, tag: '0043' });
  assert.equal(retried.ok, true);
  assert.equal(retried.account.tag, '0043');

  // 跟着账号：只补空位，已有值不覆盖
  const kept = await auth.setProfile({ account: created.account, tag: '0777', name: '改名' });
  assert.equal(kept.account.tag, '0042');
  assert.equal(kept.account.name, '博士 A');

  // 老账号（注册时没填）登录后补：识别号同上唯一
  const legacy = await auth.requestCode({ email: 'tag3@x.co', turnstileToken: 't', mode: 'register' });
  const old = await auth.verify({ email: 'tag3@x.co', code: legacy.devCode });
  assert.equal(old.account.tag, null);
  assert.equal((await auth.setProfile({ account: old.account, tag: '0043' })).code, 'TAG_TAKEN');
  const filled = await auth.setProfile({ account: old.account, tag: '0044', name: '博士 C' });
  assert.equal(filled.account.tag, '0044');
  assert.equal(filled.account.name, '博士 C');
});

test('accounts: cloud save, history, demo access', { skip: !CONN }, async () => {
  const account = (await db.query(`INSERT INTO accounts (email) VALUES ('save@x.co') RETURNING id`)).rows[0];
  const accountId = String(account.id);

  const empty = await getProfile(db, accountId);
  assert.deepEqual(empty.loadouts, {});

  assert.equal((await putProfile(db, accountId, { loadouts: { squads: [{ id: 's1' }] }, stats: { wins: 2 } })).ok, true);
  const saved = await getProfile(db, accountId);
  assert.equal(saved.loadouts.squads[0].id, 's1');
  assert.deepEqual(saved.settings, {});

  // partial update keeps earlier columns
  assert.equal((await putProfile(db, accountId, { settings: { lang: 'zh' } })).ok, true);
  const merged = await getProfile(db, accountId);
  assert.equal(merged.loadouts.squads[0].id, 's1');
  assert.equal(merged.settings.lang, 'zh');

  const huge = await putProfile(db, accountId, { stats: { blob: 'x'.repeat(300 * 1024) } });
  assert.equal(huge.ok, false);
  assert.equal(huge.code, 'TOO_LARGE');

  await linkPlayer(db, accountId, 'p_test1');
  assert.equal(await linkPlayer(db, accountId, 'p_test2').then(() => true), true);
});

test('accounts: recorder writes a demo and one record per linked participant', { skip: !CONN }, async () => {
  const account = (await db.query(`INSERT INTO accounts (email) VALUES ('rec@x.co') RETURNING id`)).rows[0];
  await linkPlayer(db, String(account.id), 'p_rec1');

  const recorder = createDemoRecorder({ db, log: {} });
  const match = {
    seed: 123456, mode: 'coop', difficulty: 'normal', version: null, roomCode: 'T1',
    order: [ { playerId: 'p_rec1', name: 'A', seat: 0, isBot: false }, { playerId: 'p_bot', name: 'B', seat: 1, isBot: true } ],
  };
  recorder.start(match);
  assert.match(match.demoKey, /^d_[0-9a-f]{12}$/);
  recorder.record(match, 'p_rec1', { t: 'g.deploy', unit: 'u1', at: 1 });
  recorder.record(match, 'p_rec1', { t: 'b.progress', x: 1 }); // not a C2S action: skipped
  recorder.record(match, 'p_rec1', { t: 'g.move', unit: 'u1', to: 2 });
  recorder.frame(match, { t: 'm.public', phase: 'PREP', round: 1, players: [
    { playerId: 'p_rec1', seat: 0, name: 'A', isBot: false, alive: true, lp: 10, shopLevel: 2, boardCount: 3, status: 'acting' },
  ] });
  recorder.frame(match, { t: 'm.private', deck: [] }); // not a public frame: skipped

  const out = await recorder.finish({ match, summary: { winner: 'A' }, resultByPlayer: { p_rec1: { place: 1 } } });
  assert.equal(out.records, 1);

  const demo = await getDemo(db, out.demoId);
  assert.equal(demo.seed, 123456);
  assert.equal(demo.events.length, 2);
  assert.equal(demo.events[0].a.t, 'g.deploy');
  assert.equal(demo.events[1].a.t, 'g.move');
  assert.equal(demo.snapshots.length, 1);
  assert.equal(demo.snapshots[0].players[0].lp, 10);
  assert.equal(demo.events[0].p, 'p_rec1');
  assert.equal(await canWatchDemo(db, String(account.id), out.demoId), true);
  assert.equal(await canWatchDemo(db, '999', out.demoId), false);

  const history = await listMatches(db, String(account.id));
  assert.equal(history.length, 1);
  assert.equal(history[0].demoId, out.demoId);
  assert.equal(history[0].seed, undefined);

  // finishing twice is a no-op
  assert.equal(await recorder.finish({ match }), null);
});

test('accounts: cloud demos keep only the newest 10 per account', { skip: !CONN }, async () => {
  const account = (await db.query(`INSERT INTO accounts (email) VALUES ('demos@x.co') RETURNING id`)).rows[0];
  const accountId = String(account.id);
  for (let i = 0; i < 12; i++) {
    const r = await putAccountDemo(db, accountId, {
      id: `d_local_${i}`, startedAt: Date.now() - i * 60_000, mode: 'coop', difficulty: 'normal',
      players: [{ playerId: 'p_x', name: 'A', seat: 0 }],
      events: [{ at: 0, a: { t: 'g.deploy' } }],
      snapshots: [{ at: 0, phase: 'PREP', round: 1 }],
    });
    assert.equal(r.ok, true);
  }
  const list = await listAccountDemos(db, accountId);
  assert.equal(list.length, 10);
  assert.equal(list[0].events, 1);
  const newest = await getAccountDemo(db, accountId, list[0].id);
  assert.equal(newest.events.length, 1);
  assert.equal(newest.snapshots.length, 1);
  const tooBig = await putAccountDemo(db, accountId, { id: 'big', events: Array.from({ length: 50 }, () => ({ a: 'x'.repeat(70_000) })) });
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.code, 'TOO_LARGE');
});

test('accounts: REST surface (config, code, verify, cloud, rejection)', { skip: !CONN }, async () => {
  const sentCodes = [];
  const mailer = { ready: false, dev: true, async sendCode({ to, code }) { sentCodes.push({ to, code }); return { sent: false, dev: true }; } };
  const turnstile = createTurnstile({ secret: '', log: {} });
  const auth = createAuth({ db, mailer, turnstile, pepper: 'test-pepper' });
  const registry = { byId: (id) => (id === 'p_live' ? { playerId: 'p_live', token: 'secret-token' } : null) };
  const api = createAccountApi({ db, auth, turnstile, mailer, registry, log: {}, dev: true });
  const server = createServer((req, res) => { api(req, res, new URL(req.url, 'http://x').pathname); });

  let base = '';
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(undefined); }));
  try {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.accounts, true);
    assert.equal(config.turnstileSiteKey, '1x00000000000000000000AA');

    const code = await (await fetch(`${base}/api/auth/code`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'rest@x.co', turnstileToken: 't' }) })).json();
    assert.equal(code.ok, true);

    // read the code from the DB (the test mailer does not echo it)
    const row = (await db.query(`SELECT id FROM email_codes ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.ok(row);

    const me = await fetch(`${base}/api/auth/me`);
    assert.equal(me.status, 401);

    const link = await fetch(`${base}/api/link`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 'p_live', playerToken: 'secret-token' }) });
    assert.equal(link.status, 401); // no session yet

    const badOrigin = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    assert.equal(badOrigin.status, 403);

    // 登录后走一遍云端 Demo 上传 / 列表 / 下载
    const last = sentCodes[sentCodes.length - 1];
    const verified = await fetch(`${base}/api/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: last.to, code: last.code }) });
    assert.equal(verified.status, 200);
    const cookie = (verified.headers.get('set-cookie') || '').split(';')[0];

    // 博士代号 / #识别号：登录后补进账号（未登录 401，撞号 409）
    const anonProfile = await fetch(`${base}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag: '0101' }) });
    assert.equal(anonProfile.status, 401);
    const tagged = await (await fetch(`${base}/api/profile`, { method: 'PUT',
      headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: '博士 R', tag: '0101' }) })).json();
    assert.equal(tagged.ok, true);
    assert.equal(tagged.account.tag, '0101');
    assert.equal(tagged.account.name, '博士 R');
    // 已经有识别号的账号不会被改写
    const keptTag = await (await fetch(`${base}/api/profile`, { method: 'PUT',
      headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ tag: '0202' }) })).json();
    assert.equal(keptTag.account.tag, '0101');
    // 没设过密码的账号走密码登录：401 BAD_CREDENTIALS
    const pw = await fetch(`${base}/api/auth/password`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'rest@x.co', password: 'whatever1' }) });
    assert.equal(pw.status, 401);

    const up = await fetch(`${base}/api/cloud/demos`, { method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ id: 'd_rest_1', startedAt: Date.now(), mode: 'coop', difficulty: 'normal',
        players: [{ playerId: 'p_x', name: 'A', seat: 0 }], events: [{ at: 0, a: { t: 'g.deploy' } }],
        snapshots: [{ at: 0, phase: 'PREP', round: 1 }] }) });
    assert.equal(up.status, 200);

    const listRes = await (await fetch(`${base}/api/cloud/demos`, { headers: { cookie } })).json();
    assert.equal(listRes.ok, true);
    assert.equal(listRes.demos.length, 1);
    const id = listRes.demos[0].id;
    const docRes = await (await fetch(`${base}/api/cloud/demos/${id}`, { headers: { cookie } })).json();
    assert.equal(docRes.ok, true);
    assert.equal(docRes.demo.events.length, 1);
    assert.equal(docRes.demo.snapshots.length, 1);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});
