// test/net-online-cap.test.js — SP_MAX_ONLINE / the `maxOnline` option and the online count cap (server/net.js).
//
// The cap is an admission decision for a *new* player, not a socket limit and not a way to evict anyone: a token that
// still resolves resumes (even when the cap is reached), an expired token no longer counts as a resume, and a second
// connection with a live token replaces that socket instead of taking a second seat. The upgrade stage has a limit of
// its own — maxPendingConnections, unauthenticated / closing sockets — and the online threshold is never used to refuse
// an upgrade (AGENTS.md 2026-10-18: it would block the hello hint and the match-recovery path).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

/** Start a server on a free port, run `fn({ url })`, and always close it. */
async function withServer(opts, fn) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, ...opts });
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  try {
    return await fn({ srv, url });
  } finally {
    await srv.close();
  }
}

test('without maxOnline nothing is refused (the default stays unlimited)', async () => {
  await withServer({}, async ({ url }) => {
    const clients = await Promise.all([TestClient.connect(url), TestClient.connect(url), TestClient.connect(url)]);
    try {
      const welcomes = await Promise.all(clients.map((c, i) => c.hello(`P${i}`)));
      assert.equal(welcomes.length, 3);
      for (const w of welcomes) assert.ok(w.token);
    } finally {
      for (const c of clients) await c.close();
    }
  });
});

test('a full server refuses the next new player with SERVER_FULL, and leaves the players inside alone', async () => {
  await withServer({ maxOnline: 1 }, async ({ url }) => {
    const alice = await TestClient.connect(url);
    await alice.hello('Alice');
    try {
      const bob = await TestClient.connect(url);
      // the player sees the localized 「服务器已满」: the reply carries ERR.SERVER_FULL, not ERR.INTERNAL
      await assert.rejects(() => bob.hello('Bob'), (e) => {
        assert.match(e.message, /SERVER_FULL/);
        assert.doesNotMatch(e.message, /INTERNAL/);
        return true;
      });
      await bob.close();

      // the player already inside keeps playing: a repeat hello on that socket is still answered
      const again = await alice.request({ t: 'hello', name: 'Alice', version: 1 });
      assert.equal(again.t, 'welcome');
    } finally {
      await alice.close();
    }
  });
});

test('a real disconnect can come back with the original token even when the cap is reached', async () => {
  await withServer({ maxOnline: 1 }, async ({ url }) => {
    const alice = await TestClient.connect(url);
    const a = await alice.hello('Alice');
    await alice.terminate();                     // the network drops; the session waits in the reconnect window

    const bob = await TestClient.connect(url);
    const b = await bob.hello('Bob');            // a new player takes the only seat
    assert.ok(b.token);

    const back = await TestClient.connect(url);
    const resumed = await back.hello('Alice', a.token);
    assert.equal(resumed.playerId, a.playerId, 'the returning player is the same session, not a new seat');
    assert.equal(resumed.token, a.token);

    // and the cap still holds: the next *new* player is refused
    const carol = await TestClient.connect(url);
    await assert.rejects(() => carol.hello('Carol'), /SERVER_FULL/);
    await carol.close();
    await back.close();
    await bob.close();
  });
});

test('at the cap a live token with noReplace is refused by the claim rule (SESSION_IN_USE), not by the online cap', async () => {
  // The reviewer's case: "a resume is never refused" must mean *this layer*. A valid token whose session is still live on
  // another socket asks for a takeover; `noReplace` says no. That answer has to be SESSION_IN_USE — not SERVER_FULL, and
  // not a silent extra seat — so the client can tell "someone else is playing that session" from "the server is full".
  await withServer({ maxOnline: 1 }, async ({ url }) => {
    const alice = await TestClient.connect(url);
    const a = await alice.hello('Alice');

    const second = await TestClient.connect(url);
    try {
      await assert.rejects(() => second.hello('Alice', a.token, { noReplace: true }), (e) => {
        assert.match(e.message, /SESSION_IN_USE/);
        assert.doesNotMatch(e.message, /SERVER_FULL/);
        return true;
      });
      // the first socket was not detached: the old player keeps the seat
      assert.equal(alice.isOpen, true);
      const again = await alice.request({ t: 'hello', name: 'Alice', version: 1 });
      assert.equal(again.t, 'welcome');
    } finally {
      await second.close();
      await alice.close();
    }
  });
});

test('an expired token is no longer a resume, so a full server refuses it as a new player', async () => {
  await withServer({ maxOnline: 1, reconnectWindowMs: 120 }, async ({ url }) => {
    const alice = await TestClient.connect(url);
    const a = await alice.hello('Alice');
    await alice.terminate();

    const bob = await TestClient.connect(url);
    await bob.hello('Bob');                      // the only seat is taken
    await new Promise((resolve) => setTimeout(resolve, 400));   // past the reconnect window

    const stale = await TestClient.connect(url);
    await assert.rejects(() => stale.hello('Alice', a.token), /SERVER_FULL/);
    await stale.close();
    await bob.close();
  });
});

test('the same token from a second connection replaces that socket instead of taking a second seat', async () => {
  await withServer({ maxOnline: 1 }, async ({ url }) => {
    const carol = await TestClient.connect(url);
    const c = await carol.hello('Carol');

    const takeover = await TestClient.connect(url);
    const h = await takeover.hello('Carol', c.token);
    assert.equal(h.playerId, c.playerId, 'the same session, not a new player');

    const closed = await carol.closed;
    assert.equal(closed.code, 4001, 'the old socket is replaced (4001); the client must not auto-reconnect');
    assert.equal(carol.isOpen, false);

    // no extra seat exists: the next new player is still refused
    const dave = await TestClient.connect(url);
    await assert.rejects(() => dave.hello('Dave'), /SERVER_FULL/);
    await dave.close();
    await takeover.close();
  });
});

test('the upgrade admits sockets on its own budget: a pending flood answers 503, the online cap only decides a hello', async () => {
  // AGENTS.md 2026-10-18: the online threshold must not refuse an upgrade ("不用在线阈值堵住 hello 提示及对局恢复通道"),
  // so a full online list still admits the socket and answers SERVER_FULL at its hello.
  await withServer({ maxConnections: 1, maxOnline: 100 }, async ({ url }) => {
    const alice = await TestClient.connect(url);
    await alice.hello('Alice');
    const bob = await TestClient.connect(url);
    try {
      await assert.rejects(() => bob.hello('Bob'), /SERVER_FULL/);
    } finally {
      await bob.close();
      await alice.close();
    }
  });
  // the upgrade's own budget (maxPendingConnections) is checked before a hello exists: a socket that never said hello
  // is the whole allowance, and the next upgrade is refused with 503
  await withServer({ maxPendingConnections: 1 }, async ({ url }) => {
    const silent = await TestClient.connect(url);
    try {
      await assert.rejects(() => TestClient.connect(url), (e) => {
        assert.match(String(e.message ?? e), /50[0-9]|unexpected server response|service unavailable/i);
        return true;
      });
    } finally {
      await silent.close();
    }
  });
});
