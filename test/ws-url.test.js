import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { parseWsUrl } from '../server/http/config.js';
import { defaultWsUrl } from '../public/js/net.js';

test('WS endpoint parsing accepts complete URLs and rejects unusable configurations', () => {
  for (const value of [undefined, '', '  ', '/ws', 'example.com/ws', 'https://example.com/ws',
    'ws://', 'wss://user:secret@example.com/ws', 'wss://example.com/ws#fragment', 'wss://example.com:99999/ws']) {
    assert.equal(parseWsUrl(value), '', String(value));
  }
  assert.equal(parseWsUrl(' wss://example.com/game/ws?route=2 '), 'wss://example.com/game/ws?route=2');
  assert.equal(parseWsUrl('ws://[::1]:3000/ws'), 'ws://[::1]:3000/ws');
  assert.equal(defaultWsUrl({ protocol: 'http:', host: 'site.test:3000' }), 'ws://site.test:3000/ws');
  assert.equal(defaultWsUrl({ protocol: 'https:', host: 'site.test' }), 'wss://site.test/ws');
  assert.equal(defaultWsUrl(null), 'ws://localhost:3000/ws');
});

// Execute the client with the exact runtime module the HTTP server returned, using Node for the other ESM imports.
async function clientWithRuntime(body) {
  const sourceUrl = new URL('../public/js/net.js', import.meta.url);
  const runtimeUrl = 'data:text/javascript,' + encodeURIComponent(body);
  const source = (await fs.readFile(sourceUrl, 'utf8')).replace(/from '([^']+)'/g, (_match, specifier) => {
    const target = specifier === './ws-config.js' ? runtimeUrl : new URL(specifier, sourceUrl).href;
    return `from ${JSON.stringify(target)}`;
  });
  return import('data:text/javascript,' + encodeURIComponent(source));
}

test('SP_WS_URL reaches initial/reconnect sockets; empty options and invalid settings fall back', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-ws-url-'));
  const previous = process.env.SP_WS_URL;
  t.after(async () => {
    if (previous === undefined) delete process.env.SP_WS_URL;
    else process.env.SP_WS_URL = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const expected = 'wss://backend.example.com/custom/ws?route=2';
  process.env.SP_WS_URL = ` ${expected} `;
  let previousTag;
  for (const [wsUrl, endpoint, warning] of [[undefined, expected, false], ['', '', false],
    ['ws://127.0.0.1:9000/ws', 'ws://127.0.0.1:9000/ws', false], ['https://bad.example/ws', '', true]]) {
    const warnings = [];
    const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, packsDir: path.join(dir, 'packs'),
      pluginsDir: path.join(dir, 'plugins'), wsUrl, store: null, workers: 0, roomWorkers: 0, matchWorkers: 0,
      studio: false, announcementsFile: null, log: { info() {}, warn: (msg) => warnings.push(msg), error() {}, debug() {} } });
    try {
      const url = `${srv.url}/js/ws-config.js`;
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /javascript/);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      const body = await response.text();
      const runtime = await import('data:text/javascript,' + encodeURIComponent(body));
      assert.equal(runtime.WS_URL, endpoint);
      const tag = response.headers.get('etag');
      if (previousTag) assert.notEqual(tag, previousTag, 'a changed endpoint changes the ETag');
      previousTag = tag;
      assert.equal((await fetch(url, { headers: { 'If-None-Match': tag } })).status, 304);
      const head = await fetch(url, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(body));
      assert.equal(warnings.some(msg => msg.includes('SP_WS_URL ignored')), warning);

      const { Net, defaultWsUrl: resolvedUrl } = await clientWithRuntime(body);
      assert.equal(resolvedUrl({ protocol: 'https:', host: 'frontend.test' }), endpoint || 'wss://frontend.test/ws');
      const sockets = [];
      class Socket {
        constructor(address) { this.url = address; this.readyState = 0; sockets.push(this); }
        close() { this.readyState = 3; }
      }
      const net = new Net({ WebSocket: Socket });
      try {
        net.connect();
        assert.equal(sockets[0].url, endpoint || 'ws://localhost:3000/ws');
        sockets[0].readyState = 3;
        sockets[0].onclose({ code: 1006 });
        net.retryNow();
        assert.equal(sockets.length, 2);
        assert.equal(sockets[1].url, sockets[0].url);
      } finally { net.close(); }
      const explicit = new Net({ url: 'ws://explicit.test/ws', WebSocket: Socket });
      try {
        explicit.connect();
        assert.equal(explicit.ws.url, 'ws://explicit.test/ws');
      } finally { explicit.close(); }
    } finally { await srv.close(); }
  }
});
