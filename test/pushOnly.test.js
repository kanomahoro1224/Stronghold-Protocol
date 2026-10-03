// 省流量模式 / server-push-only (env `SP_PUSH_ONLY`): the server runs every battle and streams it down, so a client
// only sends intents. Because that spends the host's uplink, the mode is offered only inside a *secure context* —
// https seen through a trusted proxy, or the browser's own machine (`http://127.0.0.1:3000` is a secure context in
// every browser; a LAN address over plain http is not). Anyone else is refused: 403 at the WebSocket upgrade, and a
// `hello` on a socket that got in anyway is answered with INSECURE. Wired in server/index.js (SP_PUSH_ONLY, /healthz,
// /api/client-config), server/net.js (admission / onHelloMsg), server/match/Match.js (m.public.pushOnly) and
// public/js/screens/title.js (the start screen warns and refuses to start).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startServer, parsePushOnly } from '../server/index.js';
import { requestSecure, isLoopbackIp, normalizeIp } from '../server/net.js';
import { ERR } from '../shared/constants.js';
import { makeMatch } from './match/harness.js';

/** Minimal request: the socket peer plus whatever a proxy forwarded. */
const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test('parsePushOnly: only 1/true/yes/on/always turn the mode on', () => {
  for (const v of ['1', 'true', 'YES', 'on', ' always ']) assert.equal(parsePushOnly(v), true, v);
  for (const v of [undefined, '', '0', 'false', 'off', 'no', 'maybe']) assert.equal(parsePushOnly(v), false, String(v));
});

test('isLoopbackIp: only the browser\'s own machine is a secure context over plain http', () => {
  for (const ip of ['127.0.0.1', '127.5.6.7', '0.0.0.0', '::1']) assert.ok(isLoopbackIp(ip), ip);
  assert.ok(isLoopbackIp(normalizeIp('::ffff:127.0.0.1')), 'IPv4-mapped IPv6 is normalised first (requestSecure does)');
  for (const ip of ['192.168.1.23', '10.0.0.5', '172.16.4.4', '203.0.113.7', '2001:db8::1', '']) assert.ok(!isLoopbackIp(ip), ip);
});

test('requestSecure: https through a trusted proxy, or the local machine — never plain http from elsewhere', () => {
  assert.ok(requestSecure(req('127.0.0.1')), 'the local machine: no proxy, loopback peer');
  assert.ok(requestSecure(req('127.0.0.1', { 'x-forwarded-proto': 'https' })), 'nginx terminated https');
  assert.ok(requestSecure(req('127.0.0.1', { 'x-forwarded-proto': 'https, http' })), 'leftmost hop is the browser');
  assert.ok(!requestSecure(req('127.0.0.1', { 'x-forwarded-proto': 'http' })), 'nginx proxied plain http');
  assert.ok(!requestSecure(req('127.0.0.1', { 'x-forwarded-proto': 'http, https' })));
  assert.ok(!requestSecure(req('192.168.1.23')), 'a LAN browser over plain http');
  assert.ok(!requestSecure(req('203.0.113.7')), 'an internet peer');
  assert.ok(!requestSecure(req('203.0.113.7', { 'x-forwarded-proto': 'https' })), 'untrusted peer: header ignored');
  assert.ok(requestSecure(req('203.0.113.7', { 'x-forwarded-proto': 'https' }), true), 'trustProxy=true: header honoured');
});

// ---- the real server -------------------------------------------------------------------------------------------

const servers = [];
const boot = async (opts) => {
  const s = await startServer({ port: 0, host: '127.0.0.1', quiet: true, ...opts });
  servers.push(s);
  return s;
};
after(async () => { for (const s of servers) await s.close(); });

/** Upgrade attempt: 'open', or the HTTP status the server refused with. */
const upgrade = (port, headers) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  ws.on('open', () => { ws.close(); resolve('open'); });
  ws.on('unexpected-response', (_r, res) => { res.resume(); resolve(res.statusCode); });
  ws.on('error', () => resolve('error'));
});

test('SP_PUSH_ONLY: /healthz and /api/client-config publish the mode before the client says hello', async () => {
  const s = await boot({ pushOnly: true });
  const health = await (await fetch(`http://127.0.0.1:${s.port}/healthz`)).json();
  assert.equal(health.pushOnly, true);
  assert.equal(health.secure, true, 'the test connects from loopback');
  const cfg = await (await fetch(`http://127.0.0.1:${s.port}/api/client-config`)).json();
  assert.equal(cfg.ok, true);
  assert.equal(cfg.pushOnly, true);
  assert.equal(cfg.combatMode, 'server', 'push-only runs the server-side simulation');
  assert.equal(cfg.secure, true);
  assert.equal(s.lobby.opts.pushOnly, true, 'the lobby hands it to every match');
  assert.equal(s.pushOnly, true);
});

test('push-only refuses a plain-http browser (403) and accepts https / the local machine', async () => {
  const s = await boot({ pushOnly: true });
  assert.equal(await upgrade(s.port, { 'x-forwarded-proto': 'http' }), 403);
  assert.equal(await upgrade(s.port, { 'x-forwarded-proto': 'https' }), 'open');
  assert.equal(await upgrade(s.port, {}), 'open', 'no proxy header + loopback peer = the local machine');
});

test('without the flag neither the upgrade nor the page is restricted', async () => {
  const s = await boot({});
  assert.equal((await (await fetch(`http://127.0.0.1:${s.port}/api/client-config`)).json()).pushOnly, false);
  assert.equal(await upgrade(s.port, { 'x-forwarded-proto': 'http' }), 'open');
  assert.equal(await upgrade(s.port, { 'x-forwarded-proto': 'https' }), 'open');
});

test('a socket that got in while the mode was off is still refused at hello (INSECURE, 4003)', async () => {
  const s = await boot({});
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, { headers: { 'x-forwarded-proto': 'http' } });
  await once(ws, 'open');
  const closed = once(ws, 'close');
  // the operator turns the mode on while this (insecure) socket is already connected
  s.network.opts.pushOnly = true;
  const reply = once(ws, 'message');
  ws.send(JSON.stringify({ t: 'hello', name: 'Doctor' }));
  const msg = JSON.parse((await reply)[0].toString());
  assert.equal(msg.t, 'error');
  assert.equal(msg.code, ERR.INSECURE);
  const [code] = await closed;
  assert.equal(code, 4003, 'server/net.js CLOSE.INSECURE');
});

test('a secure socket still plays with the mode on: hello → welcome', async () => {
  const s = await boot({ pushOnly: true });
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, { headers: { 'x-forwarded-proto': 'https' } });
  await once(ws, 'open');
  const reply = once(ws, 'message');
  ws.send(JSON.stringify({ t: 'hello', name: 'Doctor' }));
  const msg = JSON.parse((await reply)[0].toString());
  assert.equal(msg.t, 'welcome', JSON.stringify(msg));
  ws.close();
});

// ---- the match -------------------------------------------------------------------------------------------------

test('SP_PUSH_ONLY makes every match server-run and publishes it (m.public.pushOnly)', () => {
  const prev = process.env.SP_PUSH_ONLY;
  process.env.SP_PUSH_ONLY = '1';
  try {
    const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 11 }).start();
    const pub = h.lastBc('m.public');
    assert.equal(h.m.pushOnly, true);
    assert.equal(h.m.clientCombat, false, 'push-only implies server-run combat');
    assert.equal(pub.pushOnly, true);
    assert.equal(pub.combatMode, 'server');
    h.m.dispose();
  } finally {
    if (prev == null) delete process.env.SP_PUSH_ONLY; else process.env.SP_PUSH_ONLY = prev;
  }
});

test('an explicit clientCombat / pushOnly wins over the env', () => {
  const prev = process.env.SP_PUSH_ONLY;
  process.env.SP_PUSH_ONLY = '1';
  try {
    const off = makeMatch({ mode: 'solo', humans: 1, seed: 12, clientCombat: true }).start();
    assert.equal(off.m.pushOnly, true, 'the flag is still published…');
    assert.equal(off.m.clientCombat, true, '…but an explicit opt-in is honoured (tests/tools)');
    off.m.dispose();
  } finally {
    if (prev == null) delete process.env.SP_PUSH_ONLY; else process.env.SP_PUSH_ONLY = prev;
  }
});
