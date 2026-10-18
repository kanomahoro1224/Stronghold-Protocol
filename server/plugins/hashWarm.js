// server/plugins/hashWarm.js — warm a registry's file-hash cache from a background worker.
//
// Every accessor of a plugin registry calls refresh() synchronously and lazily (registry.js), so the scan cannot be
// made async without changing every caller. What it can do is find its hashes already computed: this walks the same
// folders the scan walks (listPluginFiles, so the same walk budgets apply) and hashes them in a worker. hashFile()
// still verifies each file's stat identity before trusting a cache entry, so a file that changed in the meantime is
// re-read on the main thread exactly as before - the cache is an optimisation, never a source of truth.
import path from 'node:path';

import { listPluginFiles } from './registry.js';
import { BackgroundClient } from '../workers/backgroundClient.js';

const HASH_WORKER = new URL('../workers/pluginHash.js', import.meta.url);

/** Files a plugin folder can shape a plugin with (same walk, same budgets as the scan). */
export function pluginHashTargets(dirs) {
  const roots = [dirs.pluginsDir, dirs.packsDir].filter(Boolean);
  const out = [];
  for (const dir of roots) {
    for (const f of listPluginFiles(dir)) if (!f.link) out.push(path.join(dir, f.rel));
  }
  return out;
}

/**
 * Hash the plugin folders in the background.
 * @param {{ pluginsDir?: string, packsDir?: string }} dirs
 * @param {{ log?: { warn?: (m: string) => void }, timeoutMs?: number }} [opts]
 * @returns {Promise<Map<string, { size: number, mtimeMs: number, ino: number, ctimeMs: number, sha256: string }>>}
 */
export async function warmPluginHashes(dirs, { log = {}, timeoutMs = 30_000 } = {}) {
  const files = pluginHashTargets(dirs);
  const cache = new Map();
  if (!files.length) return cache;
  const client = new BackgroundClient(HASH_WORKER, {}, timeoutMs);
  try {
    const entries = await client.request({ files });
    for (const [abs, rec] of entries) cache.set(abs, rec);
  } catch (e) {
    log.warn?.(`[plugins] background hash warm-up failed: ${e?.message || e}`);
  } finally { await client.close(); }
  return cache;
}