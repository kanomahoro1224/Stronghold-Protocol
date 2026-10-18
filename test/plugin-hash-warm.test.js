// test/plugin-hash-warm.test.js — plugin file hashes warmed off the main thread.
//
// A registry's refresh() is called synchronously and lazily by every accessor, so the scan cannot be made async.
// server/plugins/hashWarm.js therefore only fills the cache the scan reads: the same folders (same walk budgets),
// hashed in a worker. hashFile() still verifies the stat identity of each file before trusting an entry, so a file
// that changed in the meantime is re-read on the main thread - the warmed cache is an optimisation, never truth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { warmPluginHashes, pluginHashTargets } from '../server/plugins/hashWarm.js';
import { hashFile } from '../server/plugins/registry.js';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-hashwarm-'));
  const pluginsDir = path.join(root, 'plugins');
  const dir = path.join(pluginsDir, 'demo');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'plugin.json');
  fs.writeFileSync(manifest, JSON.stringify({ id: 'demo', type: 'cosmetic' }));
  const blob = path.join(dir, 'big.bin');
  fs.writeFileSync(blob, Buffer.alloc(256 * 1024, 7));
  return { root, pluginsDir, manifest, blob };
}

test('the warmed cache carries the real SHA-256 of every plugin file', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const targets = pluginHashTargets({ pluginsDir: f.pluginsDir });
  assert.ok(targets.includes(f.manifest), 'the manifest is a target');
  assert.ok(targets.includes(f.blob), 'so is a referenced file');

  const warmed = await warmPluginHashes({ pluginsDir: f.pluginsDir });
  assert.equal(warmed.get(f.blob).sha256, sha256(fs.readFileSync(f.blob)), 'the hash matches an independent one');
  assert.equal(warmed.get(f.manifest).sha256, sha256(fs.readFileSync(f.manifest)));
  assert.equal(typeof warmed.get(f.blob).ino, 'number', 'the identity travels with the hash');
});

test('hashFile trusts a warmed entry while the identity holds, and re-reads when it does not', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const warmed = await warmPluginHashes({ pluginsDir: f.pluginsDir });
  const cache = new Map(warmed);
  const hit = hashFile(f.blob, cache);
  assert.equal(hit.sha256, warmed.get(f.blob).sha256, 'the identity still matches: the cache is used');

  fs.writeFileSync(f.blob, Buffer.alloc(64, 9));            // same path, new inode/size/ctime
  const again = hashFile(f.blob, cache);
  assert.notEqual(again.sha256, hit.sha256, 'a changed file is hashed again, not served from the cache');
  assert.equal(again.sha256, sha256(fs.readFileSync(f.blob)));
});

test('an empty or missing folder is not an error', async () => {
  const empty = await warmPluginHashes({});
  assert.equal(empty.size, 0);
  const missing = await warmPluginHashes({ pluginsDir: path.join(os.tmpdir(), 'sp-hashwarm-nope') });
  assert.equal(missing.size, 0);
});