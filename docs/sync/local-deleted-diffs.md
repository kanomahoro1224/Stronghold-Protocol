# 本地已删除文件与上游 0.4.0 差异

基准：本地 HEAD a9797916，上游 dev 55f528e9；以下为 `git diff f07b8965061bbc311ad7aa815879b09264a1e47d FETCH_HEAD` 的完整上游改动。

## public/sw.js

```diff
diff --git a/public/sw.js b/public/sw.js
index 1edef4da..f70dd3ad 100644
--- a/public/sw.js
+++ b/public/sw.js
@@ -22,6 +22,10 @@ self.addEventListener('fetch', (event) => {
   const request = event.request;
   if (request.method !== 'GET') return;
   if (request.headers.has('range')) return;
+  // A cache-only probe (resourceCheck.js) must reach the browser HTTP cache. respondWith, even with 504, hides
+  // that cache. Leaving the event unanswered lets a hit return and a miss reject, with no network. Cache Storage
+  // is already decided by the page's caches.match before this probe.
+  if (request.cache === 'only-if-cached') return;
   let url;
   try { url = new URL(request.url); } catch { return; }
   if (url.origin !== self.location.origin) return;
```

## test/ui/asset-download.browser.test.js

```diff
diff --git a/test/ui/asset-download.browser.test.js b/test/ui/asset-download.browser.test.js
index 355b171d..29e2d500 100644
--- a/test/ui/asset-download.browser.test.js
+++ b/test/ui/asset-download.browser.test.js
@@ -6,8 +6,25 @@ import path from 'node:path';
 import { startServer } from '../../server/index.js';
 import { hash16 } from '../../server/http/assetIndex.js';
 import { CHROME, hasChrome } from '../e2e/client.mjs';
+import { seedReleaseRead } from '../helpers/releaseNotes.js';
 
-test('homepage download, visible failure/retry, pause, cache reuse, and the two asset buttons\' responsive placement', {
+async function openDownload(page) {
+  await page.click('[data-testid="resource-manager-open"]');
+  // The opening dialog moves during its entrance animation; wait before coordinate clicks.
+  await page.waitForFunction(async () => {
+    const el = document.querySelector('[data-testid="resource-download"]');
+    if (!el) return false;
+    const before = el.getBoundingClientRect();
+    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
+    const after = el.getBoundingClientRect();
+    return before.x === after.x && before.y === after.y && after.width > 0;
+  });
+  await page.click('[data-testid="resource-download"]');
+  await page.waitForSelector('[data-testid="asset-download-resume"]', { visible: true });
+  await page.click('[data-testid="asset-download-resume"]');
+}
+
+test('homepage download, visible failure/retry, pause, cache reuse, and the resource manager entry\'s responsive placement', {
   skip: process.env.SP_E2E !== '1' || !hasChrome(), timeout: 90000,
 }, async (t) => {
   const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
@@ -43,18 +60,19 @@ test('homepage download, visible failure/retry, pause, cache reuse, and the two
   const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
   t.after(() => browser.close());
   const page = await browser.newPage();
+  await seedReleaseRead(page);
   const errors = [];
   page.on('pageerror', (error) => errors.push(error.message));
   await page.setViewport({ width: 1280, height: 900 });
   await page.goto(srv.url);
-  await page.waitForSelector('[data-testid="asset-download"]');
+  await page.waitForSelector('[data-testid="resource-manager-open"]');
   assert.equal(counts.size, 0, 'opening the homepage does not download the asset pack');
   if (process.env.SP_ASSET_SCREENSHOTS) {
     fs.mkdirSync(process.env.SP_ASSET_SCREENSHOTS, { recursive: true });
     await new Promise((resolve) => setTimeout(resolve, 500));
     await page.screenshot({ path: path.join(process.env.SP_ASSET_SCREENSHOTS, 'title.png') });
   }
-  await page.click('[data-testid="asset-download"]');
+  await openDownload(page);
   await page.waitForFunction(() => document.querySelector('[data-testid="asset-download-status"]')?.textContent.includes('1 个素材下载失败'));
   assert.equal(await page.$eval('.asset-download [role="progressbar"]', (el) => el.getAttribute('aria-valuenow')), '1');
   assert.match(await page.$eval('.asset-download', (el) => el.textContent), /已就绪 1，缺少 1/);
@@ -68,6 +86,14 @@ test('homepage download, visible failure/retry, pause, cache reuse, and the two
     const img = new Image(); img.onload = () => resolve(img.naturalWidth); img.onerror = () => resolve(0); img.src = url;
   }), image), 1);
   assert.equal(counts.get(image), 1, 'the renderer Image request reuses the downloaded HTTP cache');
+  // GitHub #725: 127.0.0.1 is a secure context, so the download is also kept in the import cache (the worker answers
+  // from it) and in its index; the unhashed missing file is not (the worker never serves such a URL)
+  assert.deepEqual(await page.evaluate(async ([url, other]) => {
+    const cache = await caches.open('sp-imported-assets-v1');
+    const index = await (await cache.match('/sp-imported-index.json'))?.json();
+    return [!!(await cache.match(url)), !!(await cache.match(other)), Array.isArray(index) && index.includes(url)];
+  }, [image, missing]), [true, false, true]);
+  assert.equal(await page.$('[data-testid="asset-download-http"]'), null, 'no HTTP-cache warning in a secure context');
   if (process.env.SP_ASSET_SCREENSHOTS) {
     fs.mkdirSync(process.env.SP_ASSET_SCREENSHOTS, { recursive: true });
     await new Promise((resolve) => setTimeout(resolve, 500));
@@ -75,58 +101,47 @@ test('homepage download, visible failure/retry, pause, cache reuse, and the two
   }
   await page.keyboard.press('Escape');
   await page.reload();
-  await page.waitForSelector('[data-testid="asset-download"]');
+  await page.waitForSelector('[data-testid="resource-manager-open"]');
   const beforeReloadCheck = new Map(counts);
-  await page.click('[data-testid="asset-download"]');
+  await openDownload(page);
   await page.waitForFunction(() => document.querySelector('[data-testid="asset-download-status"]')?.textContent.includes('本次素材下载完成'));
   assert.match(await page.$eval('.asset-download', (el) => el.textContent), /已就绪 2，缺少 0/);
   assert.deepEqual(counts, beforeReloadCheck, 'a fresh queue after reload reuses the HTTP cache');
+  assert.equal(await page.evaluate(async () => (await import('/js/assetDownload.js')).assetDownload.get().cached), 1,
+    'the kept file counts as stored: the fresh queue does not request it at all');
   await page.keyboard.press('Escape');
-  // 下载完整素材 and 导入素材包 side by side (ui/assetDownload.js, ui/assetImport.js): both inside the viewport, uncovered, on one
-  // row, not overlapping, their hint lines clear of the footer — on a desktop and on a landscape phone
+  // The unified entry stays visible on desktop and landscape phones.
   for (const viewport of [{ width: 1280, height: 900 }, { width: 844, height: 390 }]) {
     await page.setViewport(viewport);
-    const box = (sel) => page.$eval(sel, (el) => {
+    const bounds = await page.$eval('[data-testid="resource-manager-open"]', (el) => {
       const b = el.getBoundingClientRect();
       return { left: b.left, top: b.top, right: b.right, bottom: b.bottom,
         visible: el.contains(document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2)) };
     });
-    const download = await box('[data-testid="asset-download"]');
-    const importer = await box('[data-testid="asset-import"]');
-    for (const [name, bounds] of [['download', download], ['import', importer]]) {
-      assert.ok(bounds.left >= 0 && bounds.right <= viewport.width && bounds.top >= 0 && bounds.bottom <= viewport.height, `${name} ${JSON.stringify(bounds)}`);
-      assert.ok(bounds.visible, `the ${name} button is not covered`);
-    }
-    assert.ok(Math.abs(download.top - importer.top) < 1 && download.right <= importer.left, `side by side ${JSON.stringify({ download, importer })}`);
-    const hints = await page.$$eval('.title-assets__item > small', (els) => els.map((el) => el.getBoundingClientRect().bottom));
-    const foot = await page.$eval('.title-foot', (el) => [...el.children].map((c) => c.getBoundingClientRect())
-      .filter((b) => b.width > 0).map((b) => ({ top: b.top, left: b.left, right: b.right })));
-    const block = await page.$eval('.title-assets', (el) => el.getBoundingClientRect().toJSON());
-    assert.equal(hints.length, 2, 'a hint line under each button');
-    for (const f of foot) {
-      const across = f.left < block.right && f.right > block.left;
-      assert.ok(!across || Math.max(...hints) <= f.top, `the hints stay above the footer ${JSON.stringify({ hints, f })}`);
-    }
+    assert.ok(bounds.left >= 0 && bounds.right <= viewport.width && bounds.top >= 0 && bounds.bottom <= viewport.height);
+    assert.ok(bounds.visible, 'the unified resource entry is not covered');
     if (process.env.SP_ASSET_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.SP_ASSET_SCREENSHOTS, `title-${viewport.width}.png`) });
   }
   // A new browser context has an empty HTTP cache. Closing the dialog must stop a hanging request.
   const context = await browser.createBrowserContext();
   const other = await context.newPage();
+  await seedReleaseRead(other);
   hanging = true;
   await other.goto(srv.url);
-  await other.click('[data-testid="asset-download"]');
+  await openDownload(other);
   await other.waitForFunction(async (size) => (await import('/js/assetDownload.js')).assetDownload.get().bytes === size, {}, png.length);
   await other.keyboard.press('Escape');
   await other.waitForFunction(async () => (await import('/js/assetDownload.js')).assetDownload.get().phase === 'paused');
   assert.equal(await other.evaluate(async () => (await import('/js/assetDownload.js')).assetDownload.get().done), 1);
   hanging = false;
-  await other.click('[data-testid="asset-download"]');
+  await openDownload(other);
   await other.waitForFunction(() => document.querySelector('[data-testid="asset-download-status"]')?.textContent.includes('本次素材下载完成'));
   assert.match(await other.$eval('.asset-download', (el) => el.textContent), /已就绪 2，缺少 0/);
 
   // A real local import plus one network success must both count as ready (#725).
   const mixedContext = await browser.createBrowserContext();
   const mixed = await mixedContext.newPage();
+  await seedReleaseRead(mixed);
   await mixed.goto(srv.url);
   const imported = await mixed.evaluate(async (bytes) => {
     const { createAssetImport } = await import('/js/assetPack.js');
@@ -136,7 +151,7 @@ test('homepage download, visible failure/retry, pause, cache reuse, and the two
   }, [...png]);
   assert.equal(imported.accepted, 1);
   const beforeMixed = new Map(counts);
-  await mixed.click('[data-testid="asset-download"]');
+  await openDownload(mixed);
   await mixed.waitForFunction(() => document.querySelector('[data-testid="asset-download-status"]')?.textContent.includes('本次素材下载完成'));
   assert.equal(counts.get(image), beforeMixed.get(image), 'the imported file is not fetched');
   assert.equal(counts.get(missing), beforeMixed.get(missing) + 1, 'the remaining file comes from the server');
```

## test/ui/asset-download.test.js

```diff
diff --git a/test/ui/asset-download.test.js b/test/ui/asset-download.test.js
index 84d8bb7f..06deedc8 100644
--- a/test/ui/asset-download.test.js
+++ b/test/ui/asset-download.test.js
@@ -172,3 +172,155 @@ test('the official battle effects manifest (/data/local-fx.json, DESIGN §33) is
   assert.ok(got.includes('/assets/~fedcba0987654321/local/fx/prefabs/common_hit_01.json'));
   assert.ok(got.includes('/assets/~1234567890abcdef/a.png'));
 });
+
+test('predownload supports multiple dubs, repairs old empty choices and never mutates the manifest', async () => {
+  const ids = ['char_102_texas', 'char_103_angel', 'char_010_chen'];
+  const bank = (lang) => Object.fromEntries(ids.map((id) => [id, { select: `/assets/audio/voice/${lang}/${id}/cn_001.mp3` }]));
+  const manifest = { image: '/assets/a.png', audio: {
+    voice: bank('cn'), voiceJp: bank('jp'), voiceEn: bank('en'), voiceKr: bank('kr'), voiceNative: bank('native'),
+  } };
+  const before = JSON.stringify(manifest);
+  const got = [];
+  let settings = { languages: ['cn'], operators: { [ids[0]]: ['en', 'jp'], [ids[1]]: [], [ids[2]]: ['cn', 'native'] } };
+  const queue = createAssetDownload({ readVoiceSettings: () => settings, lookupImported: async () => new Set(),
+    fetch: fixture(manifest, async (url) => { got.push(url); return file(); }) });
+  await queue.start();
+  assert.equal(queue.get().total, 6);
+  assert.ok(got.includes(`/media/voice/en/${ids[0]}/cn_001`));
+  assert.ok(got.includes(`/media/voice/native/${ids[2]}/cn_001`));
+  assert.equal(got.filter((url) => url.includes('/voice/cn/')).length, 2);
+  assert.ok(!got.includes(`/media/voice/cn/${ids[0]}/cn_001`), 'an operator with other selections does not implicitly download Chinese');
+  assert.ok(got.includes(`/media/voice/jp/${ids[0]}/cn_001`));
+  assert.ok(!got.some((url) => url.includes('/voice/kr/')));
+  assert.equal(JSON.stringify(manifest), before);
+  got.length = 0;
+  settings = { languages: ['cn', 'kr'], operators: {} };
+  await queue.start();
+  assert.equal(queue.get().total, 7);
+  assert.equal(got.filter((url) => url.includes('/voice/kr/')).length, 3);
+  assert.ok(!got.some((url) => /voice\/(en|native|jp)\//.test(url)));
+});
+
+test('a paused download rebuilds its voice selection when resumed after a preference change', async () => {
+  const id = 'char_102_texas';
+  let settings = { languages: ['en'], operators: {} };
+  const got = [];
+  const queue = createAssetDownload({ concurrency: 1, readVoiceSettings: () => settings, lookupImported: async () => new Set(),
+    fetch: fixture({ image: '/assets/a.png', audio: {
+      voice: { [id]: { select: '/assets/audio/voice/cn/a.mp3' } },
+      voiceEn: { [id]: { select: '/assets/audio/voice/en/a.mp3' } },
+      voiceJp: { [id]: { select: '/assets/audio/voice/jp/a.mp3' } },
+    } }, async (url) => { got.push(url); if (url === '/assets/a.png' && got.length === 1) queue.pause(); return file(); }) });
+  await queue.start();
+  assert.equal(queue.get().phase, 'paused');
+  settings = { ...settings, languages: ['jp'] };
+  await queue.start();
+  assert.equal(queue.get().phase, 'complete');
+  assert.ok(got.includes('/media/voice/jp/a'));
+  assert.ok(!got.includes('/media/voice/en/a'));
+  assert.equal(got.filter(url => url === '/assets/a.png').length, 1, 'finished non-voice files are not requested twice');
+});
+
+// GitHub #725: Chrome keeps at most 320 MB of HTTP cache on Windows, less than a host's whole art, so a queue that walks
+// every file evicts each before it is asked for again. In a secure context each download is kept in the import cache
+// (assetCache.js openDownloadStore), whose index the next check reads.
+function fakeStore({ failAt = Infinity } = {}) {
+  const kept = new Map(), index = new Set();
+  let flushes = 0, puts = 0;
+  return {
+    kept, index, get flushes() { return flushes; },
+    open: async () => ({
+      async put(url, bytes, type) {
+        if (++puts >= failAt) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
+        kept.set(url, { text: new TextDecoder().decode(bytes), type });
+        return true;
+      },
+      async flush() { flushes++; for (const url of kept.keys()) index.add(url); },
+    }),
+  };
+}
+
+test('#725: a secure context keeps every downloaded body in the import cache; the next check requests none of them', async () => {
+  const store = fakeStore();
+  const calls = [];
+  const options = {
+    openStore: store.open,
+    lookupImported: async () => new Set(store.index),
+    fetch: fixture({ a: '/assets/~1234567890abcdef/a.png', b: '/assets/~1234567890abcdef/audio/bgm/b.mp3' }, async (url) => {
+      calls.push(url);
+      return new Response(`body of ${url}`, { headers: { 'content-type': url.startsWith('/media/') ? 'audio/mpeg' : 'image/png' } });
+    }),
+  };
+  const queue = createAssetDownload(options);
+  await queue.start();
+  assert.deepEqual([queue.get().phase, queue.get().storage], ['complete', 'site']);
+  assert.deepEqual([...store.kept.keys()].sort(), ['/assets/~1234567890abcdef/a.png', '/media/~1234567890abcdef/bgm/b']);
+  assert.deepEqual(store.kept.get('/media/~1234567890abcdef/bgm/b'), { text: 'body of /media/~1234567890abcdef/bgm/b', type: 'audio/mpeg' }, 'the whole body, the served type');
+  assert.equal(store.flushes, 1, 'the index is written as the run ends');
+  // a reload: a new queue reads the index and asks the server for nothing
+  calls.length = 0;
+  const again = createAssetDownload(options);
+  await again.start();
+  assert.deepEqual([again.get().phase, again.get().cached, again.get().done], ['complete', 2, 2]);
+  assert.deepEqual(calls.filter((url) => !url.startsWith('/data/')), [], 'no file requested again');
+});
+
+test('#725: without a secure context the HTTP cache is all there is (the dialog says so); a failed write sends the rest there', async () => {
+  const plain = createAssetDownload({ openStore: async () => null, fetch: fixture({ a: '/assets/a' }, async () => file()) });
+  await plain.start();
+  assert.deepEqual([plain.get().phase, plain.get().storage], ['complete', 'http']);
+  const store = fakeStore({ failAt: 2 });
+  const full = createAssetDownload({ openStore: store.open, concurrency: 1, lookupImported: async () => new Set(),
+    fetch: fixture({ a: '/assets/~1234567890abcdef/a', b: '/assets/~1234567890abcdef/b', c: '/assets/~1234567890abcdef/c' }, async () => file()) });
+  await full.start();
+  assert.deepEqual([full.get().phase, full.get().done, full.get().storage], ['complete', 3, 'full'], 'every file still counts; storage says full');
+  assert.deepEqual([...store.kept.keys()], ['/assets/~1234567890abcdef/a'], 'only the write before the failure');
+});
+
+test('#725 openDownloadStore: hashed URLs kept under their pathname with the served type, indexed on flush; none without support', async () => {
+  const { openDownloadStore, listImportedPaths, IMPORTED_ASSET_CACHE } = await import('../../public/js/assetCache.js');
+  const entries = new Map();
+  const key = (req) => new URL(typeof req === 'string' ? req : req.url, 'http://host.test').pathname;
+  const cache = {
+    async put(req, res) { entries.set(key(req), { type: res.headers.get('content-type'), bytes: new Uint8Array(await res.arrayBuffer()) }); },
+    async match(req) { const e = entries.get(key(req)); return e ? new Response(e.bytes.slice(), { headers: { 'content-type': e.type } }) : undefined; },
+    async keys() { return [...entries.keys()].map((p) => new Request(`http://host.test${p}`)); },
+  };
+  const names = [];
+  const caches = { async open(name) { names.push(name); return cache; } };
+  assert.equal(await openDownloadStore(caches, { ok: false, reason: 'insecure' }), null, 'no secure context: no store');
+  const store = await openDownloadStore(caches, { ok: true });
+  assert.deepEqual(names, [IMPORTED_ASSET_CACHE], 'the import cache, the one the worker answers from');
+  assert.equal(await store.put('/assets/~1234567890abcdef/a.png?x=1', new TextEncoder().encode('png!'), 'image/png'), true);
+  assert.equal(await store.put('/assets/plain.png', new TextEncoder().encode('x')), false, 'not content-hashed: the worker would never serve it');
+  assert.equal(await store.put('/media/~1234567890abcdef/bgm/b', new TextEncoder().encode('mp3!')), true);
+  assert.deepEqual(entries.get('/assets/~1234567890abcdef/a.png').type, 'image/png');
+  assert.equal(new TextDecoder().decode(entries.get('/media/~1234567890abcdef/bgm/b').bytes), 'mp3!');
+  assert.deepEqual([...await listImportedPaths(caches)].sort(), ['/assets/~1234567890abcdef/a.png', '/media/~1234567890abcdef/bgm/b'],
+    'before the flush the keys still answer');
+  await store.flush();
+  assert.ok(entries.has('/sp-imported-index.json'), 'the index is written');
+  assert.deepEqual([...await listImportedPaths(caches)].sort(), ['/assets/~1234567890abcdef/a.png', '/media/~1234567890abcdef/bgm/b']);
+});
+
+test('changing dubs retains completed models, fonts and BGM during a paused download', async () => {
+  const id = 'char_102_texas', calls = [];
+  let settings = { languages: ['en'], operators: {} }, stopped = false;
+  const queue = createAssetDownload({ concurrency: 1, readVoiceSettings: () => settings,
+    lookupImported: async () => new Set(), openStore: async () => null,
+    fetch: fixture({ model: '/assets/a.skel', font: '/fonts/a.woff2', audio: { bgm: '/assets/audio/bgm/a.mp3',
+      voice: { [id]: { select: '/assets/audio/voice/cn/a.mp3' } },
+      voiceEn: { [id]: { select: '/assets/audio/voice/en/a.mp3' } },
+      voiceJp: { [id]: { select: '/assets/audio/voice/jp/a.mp3' } },
+    } }, async url => {
+      calls.push(url);
+      if (url.includes('/voice/') && !stopped) { stopped = true; queue.pause(); }
+      return file();
+    }) });
+  await queue.start();
+  settings = { languages: ['jp'], operators: {} };
+  await queue.start();
+  assert.equal(queue.get().phase, 'complete');
+  for (const url of ['/assets/a.skel', '/fonts/a.woff2', '/media/bgm/a']) assert.equal(calls.filter(x => x === url).length, 1);
+  assert.ok(calls.includes('/media/voice/jp/a'));
+});
```

## test/ui/asset-import.browser.test.js

```diff
diff --git a/test/ui/asset-import.browser.test.js b/test/ui/asset-import.browser.test.js
index 4b109f10..3ef1c40b 100644
--- a/test/ui/asset-import.browser.test.js
+++ b/test/ui/asset-import.browser.test.js
@@ -13,6 +13,7 @@ import { startServer } from '../../server/index.js';
 import { hash16 } from '../../server/http/assetIndex.js';
 import { crc32 } from '../../public/js/assetPack.js';
 import { CHROME, hasChrome } from '../e2e/client.mjs';
+import { seedReleaseRead } from '../helpers/releaseNotes.js';
 
 /** A zip of stored entries: `[{ name, raw }]`. */
 function buildStoredZip(files) {
@@ -108,27 +109,29 @@ test('import has its own dialog that requests nothing on opening; imported art i
   const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
   t.after(() => browser.close());
   const page = await browser.newPage();
+  await seedReleaseRead(page); // the title's own controls: no release notes nor entry film over them
   const errors = [];
   page.on('pageerror', (error) => errors.push(error.message));
   await page.goto(srv.url);
   await page.waitForFunction(() => navigator.serviceWorker.controller != null, { timeout: 20000 });
-  await page.waitForSelector('[data-testid="asset-import"]');
+  await page.waitForSelector('[data-testid="resource-manager-open"]');
   // a first gesture unlocks audio (public/js/audio.js): make it elsewhere, so what follows is the dialog's own traffic
   await page.click('.title-tag');
   await new Promise((resolve) => setTimeout(resolve, 500));
   const quiet = requests.length;
-  await page.click('[data-testid="asset-import"]');
+  await page.click('[data-testid="resource-manager-open"]');
+  await page.click('[data-testid="resource-import"]');
   await page.waitForSelector('.asset-import-dialog [data-testid="asset-import-zip"]');
   await new Promise((resolve) => setTimeout(resolve, 800));
   const opening = requests.slice(quiet);
-  assert.deepEqual(opening.filter((url) => /^\/(?:assets|media|fonts)\//.test(url) || /^\/data\//.test(url)), [],
-    'opening the import dialog requests no art and no manifest');
+  assert.deepEqual(opening.filter((url) => /^\/(?:assets|media|fonts)\//.test(url)), [],
+    'opening the manager and selecting import requests no art; the default voice section may read manifests');
   assert.equal(await page.$('.asset-download'), null, 'the download dialog stays closed');
   assert.deepEqual(await page.evaluate(async () => ({
     download: (await import('/js/assetDownload.js')).assetDownload.get().phase,
     import: (await import('/js/assetPack.js')).assetImport.get().phase,
   })), { download: 'idle', import: 'idle' });
-  assert.ok(await page.$eval('.asset-import-dialog', (box) => box.contains(document.activeElement)), 'the dialog holds the focus');
+  assert.ok(await page.$eval('.resource-manager', (box) => box.contains(document.activeElement)), 'the dialog holds the focus');
 
   // a pack laid out like `node tools/package.mjs --assets`, through the dialog's zip picker
   const packZip = path.join(tmp, 'Stronghold-Protocol-v9.9.9-assets.zip');
@@ -170,7 +173,9 @@ test('import has its own dialog that requests nothing on opening; imported art i
   await page.evaluate(() => fetch('/healthz?import-probe=1'));
   assert.ok(probes > beforeProbe, 'a non-asset URL still reaches the server');
 
-  await page.click('[data-testid="asset-download"]');
+  await page.click('[data-testid="resource-manager-open"]');
+  await page.click('[data-testid="resource-download"]');
+  await page.click('[data-testid="asset-download-resume"]');
   await page.waitForFunction(() => document.querySelector('[data-testid="asset-download-status"]')?.textContent.includes('1 个素材下载失败'));
   assert.equal(counts.get(zipUrl) || 0, 0, 'download skips the imported zip file');
   assert.equal(counts.get(folderUrl) || 0, 0, 'download skips the imported folder file');
@@ -179,13 +184,14 @@ test('import has its own dialog that requests nothing on opening; imported art i
   assert.equal(await page.$('.asset-download .asset-import__row'), null, 'the download dialog has no import controls');
 
   const insecure = await browser.newPage();
+  await seedReleaseRead(insecure);
   await insecure.evaluateOnNewDocument(() => {
     Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
   });
   await insecure.goto(srv.url);
-  await insecure.waitForSelector('[data-testid="asset-import"]');
-  assert.match(await insecure.$eval('#title-asset-import-hint', (el) => el.textContent), /HTTPS/, 'the hint under the button says why');
-  await insecure.click('[data-testid="asset-import"]');
+  await insecure.waitForSelector('[data-testid="resource-manager-open"]');
+  await insecure.click('[data-testid="resource-manager-open"]');
+  await insecure.click('[data-testid="resource-import"]');
   await insecure.waitForSelector('[data-testid="asset-import-unavailable"]');
   const reason = await insecure.$eval('[data-testid="asset-import-unavailable"]', (el) => el.textContent);
   assert.match(reason, /HTTPS/);
```

## test/ui/asset-import.test.js

```diff
diff --git a/test/ui/asset-import.test.js b/test/ui/asset-import.test.js
index 87ea2291..130eb7c6 100644
--- a/test/ui/asset-import.test.js
+++ b/test/ui/asset-import.test.js
@@ -617,6 +617,16 @@ test('the worker answers only hashed asset GET, and its copy matches the module'
   assert.equal(await (await missPromise).text(), 'from-network');
   assert.equal(fetched.length, fetchedBeforeHit + 1);
   assert.equal(fetched.at(-1), miss.url);
+
+  // The page already asked Cache Storage. A cache-only probe must not be answered here, or the HTTP cache stays hidden.
+  const fetchedBeforeProbe = fetched.length;
+  for (const url of [`${origin}/assets/~0123456789abcdef/hit.png`, `${origin}/assets/plain.png`, `${origin}/media/bgm/a`]) {
+    const request = new Request(url, { cache: 'only-if-cached', mode: 'same-origin' });
+    let responded = null;
+    listeners.fetch({ request, respondWith(p) { responded = p; } });
+    assert.equal(responded, null, `cache-only probe is not answered by the worker: ${url}`);
+  }
+  assert.equal(fetched.length, fetchedBeforeProbe, 'a cache-only probe does not use the network');
 });
 
 test('site CSP keeps worker-src self and blob, and the sim worker policy does not gain the asset worker', () => {
```

