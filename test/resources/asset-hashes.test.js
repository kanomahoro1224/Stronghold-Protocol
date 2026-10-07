// test/resources/asset-hashes.test.js — tools/asset-hashes.mjs, the generator of data/asset-hashes.json.
//
// The file is what turns the server's synthetic `syn-…` fallback hash into a real content digest: without it one
// regenerated data/assets.json invalidates every web asset's hash and the preload re-downloads the whole cache, and
// store.js has nothing to verify cached bytes against. These tests pin the digest (the client recomputes it with
// WebCrypto) and the document shape server/resources.js reads.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildDoc, diffDoc, digestFile, hashTree } from '../../tools/asset-hashes.mjs';
import { collectRealHashes } from '../../server/resources.js';

const tmp = (prefix) => fsp.mkdtemp(path.join(os.tmpdir(), prefix));

describe('tools/asset-hashes.mjs', () => {
  test('digestFile is the 12-hex SHA-1 the client recomputes from the cached body', async () => {
    const dir = await tmp('sp-hash-');
    const file = path.join(dir, 'x.bin');
    await fsp.writeFile(file, 'abc');
    // sha1('abc') = a9993e364706816aba3e25717850c26c9cd0d89d
    assert.equal(await digestFile(file), 'a9993e364706');
  });

  test('hashTree keys files by their served URL; buildDoc is what resources.js reads back', async () => {
    const root = await tmp('sp-root-');
    await fsp.mkdir(path.join(root, 'public/assets/ui'), { recursive: true });
    await fsp.mkdir(path.join(root, 'public/fonts'), { recursive: true });
    await fsp.writeFile(path.join(root, 'public/assets/ui/a.png'), 'abc');
    await fsp.writeFile(path.join(root, 'public/assets/ui/b.png'), 'de');
    await fsp.writeFile(path.join(root, 'public/fonts/f.woff2'), 'fgh');

    const entries = await hashTree(root);
    assert.deepEqual(entries.map((e) => e.url), ['/assets/ui/a.png', '/assets/ui/b.png', '/fonts/f.woff2']);
    const doc = buildDoc(entries);
    assert.equal(doc.count, 3);
    assert.equal(doc.bytes, 8);
    assert.equal(doc.generator, 'tools/asset-hashes.mjs');
    assert.deepEqual(Object.keys(doc.files).sort(), ['/assets/ui/a.png', '/assets/ui/b.png', '/fonts/f.woff2']);

    // the server only accepts HASH_RE values, and they must survive collectRealHashes into the manifest
    const real = collectRealHashes(null, doc);
    assert.equal(real.get('/assets/ui/a.png'), 'a9993e364706');
    // sha1('fgh') = 3f7b1e2a98dea15069fdc2542560c21bf5fd8234 (checked with Get-FileHash, not this tool)
    assert.equal(real.get('/fonts/f.woff2'), '3f7b1e2a98de');
  });

  test('a checkout without the asset trees yields an empty document instead of throwing', async () => {
    const root = await tmp('sp-empty-');
    assert.deepEqual(await hashTree(root), []);
    assert.deepEqual(buildDoc([]), { version: 1, generator: 'tools/asset-hashes.mjs', count: 0, bytes: 0, files: {} });
  });

  test('diffDoc reports the three ways the file can be stale before a deploy', () => {
    const entries = [
      { url: '/assets/a.png', hash: 'aaaaaaaaaaaa', size: 1 },
      { url: '/assets/b.png', hash: 'bbbbbbbbbbbb', size: 1 },
    ];
    // changed (b), gone from disk (c), new on disk (d is missing from `entries` but present in the doc ⇒ 'stale' is
    // the other direction: files on disk that the document does not cover)
    const doc = { version: 1, files: { '/assets/a.png': 'aaaaaaaaaaaa', '/assets/b.png': '0123456789ab', '/assets/c.png': 'cccccccccccc' } };
    const d = diffDoc(doc, entries);
    assert.equal(d.ok, false);
    assert.deepEqual(d.changed, [{ url: '/assets/b.png', was: '0123456789ab', now: 'bbbbbbbbbbbb' }]);
    assert.deepEqual(d.missing, ['/assets/c.png'], 'in the file, gone from disk');
    assert.deepEqual(d.stale, [], 'every file on disk has an entry');

    const d2 = diffDoc(doc, [...entries, { url: '/assets/d.png', hash: 'dddddddddddd', size: 1 }]);
    assert.deepEqual(d2.stale, ['/assets/d.png'], 'on disk, not in the file');

    const same = { version: 1, files: { '/assets/a.png': 'aaaaaaaaaaaa', '/assets/b.png': 'bbbbbbbbbbbb' } };
    assert.equal(diffDoc(same, entries).ok, true);
    assert.equal(diffDoc({}, entries).ok, false, 'an empty document is stale');
  });
});
