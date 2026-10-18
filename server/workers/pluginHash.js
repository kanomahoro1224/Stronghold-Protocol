// server/workers/pluginHash.js — SHA-256 of plugin files, off the main thread.
//
// Hashing a large cosmetic plugin (its manifest, lock, assets and every referenced file) is the most expensive part
// of a scan and it is pure CPU on files whose identity the caller already knows. The main thread keeps its own
// synchronous scan; this worker only fills the cache that scan reads.
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const statIdentity = (st) => ({ size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, ctimeMs: st.ctimeMs });

parentPort.on('message', ({ id, payload: { files = [] } = {} }) => {
  const out = [];
  for (const abs of files) {
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      const id0 = statIdentity(st);
      out.push([abs, { ...id0, sha256: createHash('sha256').update(fs.readFileSync(abs)).digest('hex') }]);
    } catch { /* unreadable: the main thread's hashFile returns null for it too */ }
  }
  parentPort.postMessage({ id, value: out });
});