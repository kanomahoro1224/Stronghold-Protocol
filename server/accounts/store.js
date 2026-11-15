// server/accounts/store.js — cloud saves, match history, demo documents and player↔account links.
//
// A "cloud save" is one row per account holding three JSONB columns: loadouts (the 编队 document the settings modal
// keeps locally), settings (the client's settings object minus secrets) and stats (aggregates the client maintains).
// Last write wins; the client sends an updatedAt and the server keeps the newest.
//
// Match history: one row per account per match (match_records), written when a match ends for every playerId that
// has a link to an account. The demo (seed + recorded C2S events) is one row per match (demos), shared by every
// participant of that match.

export const MAX_SAVE_BYTES = 256 * 1024;
export const MAX_DEMO_EVENTS = 20_000;

/** Ask the DB for the account behind a playerId (player_links). @returns {Promise<{ accountId: string, email: string } | null>} */
export async function accountOfPlayer(db, playerId) {
  if (!db || !playerId) return null;
  const res = await db.query(
    `SELECT l.account_id, a.email FROM player_links l JOIN accounts a ON a.id = l.account_id WHERE l.player_id = $1`,
    [String(playerId)]);
  const row = res.rows[0];
  return row ? { accountId: String(row.account_id), email: row.email } : null;
}

/** Bind a playerId (the WS session identity) to an account. One playerId → one account; re-linking overwrites. */
export async function linkPlayer(db, accountId, playerId) {
  await db.query(
    `INSERT INTO player_links (player_id, account_id) VALUES ($1, $2)
     ON CONFLICT (player_id) DO UPDATE SET account_id = EXCLUDED.account_id, linked_at = now()`,
    [String(playerId), String(accountId)]);
  return { ok: true };
}

/** Load the cloud save (empty document when the row does not exist yet). */
export async function getProfile(db, accountId) {
  const res = await db.query(`SELECT loadouts, settings, stats, updated_at FROM profiles WHERE account_id = $1`, [String(accountId)]);
  const row = res.rows[0];
  if (!row) return { loadouts: {}, settings: {}, stats: {}, updatedAt: null };
  return { loadouts: row.loadouts || {}, settings: row.settings || {}, stats: row.stats || {}, updatedAt: row.updated_at };
}

/**
 * Upsert the cloud save. Rejects documents larger than MAX_SAVE_BYTES (the client keeps its own copy anyway).
 * @param {{ loadouts?: any, settings?: any, stats?: any }} patch — omitted keys keep their stored value
 */
export async function putProfile(db, accountId, patch = {}) {
  const body = JSON.stringify({ loadouts: patch.loadouts, settings: patch.settings, stats: patch.stats });
  if (Buffer.byteLength(body) > MAX_SAVE_BYTES) return { ok: false, code: 'TOO_LARGE' };
  await db.query(
    `INSERT INTO profiles (account_id, loadouts, settings, stats, updated_at)
     VALUES ($1, COALESCE($2::jsonb, '{}'::jsonb), COALESCE($3::jsonb, '{}'::jsonb), COALESCE($4::jsonb, '{}'::jsonb), now())
     ON CONFLICT (account_id) DO UPDATE SET
       loadouts = COALESCE($2::jsonb, profiles.loadouts),
       settings = COALESCE($3::jsonb, profiles.settings),
       stats    = COALESCE($4::jsonb, profiles.stats),
       updated_at = now()
     RETURNING updated_at`,
    [String(accountId), patch.loadouts === undefined ? null : JSON.stringify(patch.loadouts),
      patch.settings === undefined ? null : JSON.stringify(patch.settings),
      patch.stats === undefined ? null : JSON.stringify(patch.stats)]);
  return { ok: true };
}

/** The account's match history, newest first. */
export async function listMatches(db, accountId, { limit = 50, before = null } = {}) {
  const params = [String(accountId), Math.min(200, Math.max(1, Number(limit) || 50))];
  let where = 'account_id = $1';
  if (before) { params.push(String(before)); where += ' AND ended_at < $3'; }
  const res = await db.query(
    `SELECT id, match_key, mode, difficulty, version, result, summary, started_at, ended_at,
            (SELECT d.id FROM demos d WHERE d.match_key = match_records.match_key) AS demo_id
       FROM match_records WHERE ${where} ORDER BY ended_at DESC LIMIT $2`, params);
  return res.rows.map((r) => ({
    id: String(r.id), matchKey: r.match_key, mode: r.mode, difficulty: r.difficulty, version: r.version,
    result: r.result, summary: r.summary || {}, startedAt: r.started_at, endedAt: r.ended_at,
    demoId: r.demo_id == null ? null : String(r.demo_id),
  }));
}

/** One demo document for playback (events + seed + participants). */
export async function getDemo(db, demoId) {
  const res = await db.query(
    `SELECT id, match_key, mode, difficulty, version, seed, players, events, snapshots, frames, created_at
       FROM demos WHERE id = $1`, [String(demoId)]);
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id), matchKey: row.match_key, mode: row.mode, difficulty: row.difficulty, version: row.version,
    seed: row.seed == null ? null : Number(row.seed), players: row.players || [], events: row.events || [],
    snapshots: row.snapshots || [],
    frames: Number(row.frames) || 0, createdAt: row.created_at,
  };
}

/** Whether `accountId` may watch `demoId` (a participant's account, or the demo has no records yet). */
export async function canWatchDemo(db, accountId, demoId) {
  const res = await db.query(
    `SELECT 1 FROM demos d
       WHERE d.id = $2 AND (
         EXISTS (SELECT 1 FROM match_records r WHERE r.match_key = d.match_key AND r.account_id = $1)
         OR NOT EXISTS (SELECT 1 FROM match_records r WHERE r.match_key = d.match_key)
       ) LIMIT 1`, [String(accountId), String(demoId)]);
  return !!res.rows[0];
}

/** Insert or replace a demo document for a match. */
export async function putDemo(db, doc) {
  const events = Array.isArray(doc.events) ? doc.events.slice(0, MAX_DEMO_EVENTS) : [];
  const bytes = Buffer.byteLength(JSON.stringify(events));
  const res = await db.query(
    `INSERT INTO demos (match_key, mode, difficulty, version, seed, players, events, snapshots, frames, bytes)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)
     ON CONFLICT (match_key) DO UPDATE SET
       mode = EXCLUDED.mode, difficulty = EXCLUDED.difficulty, version = EXCLUDED.version, seed = EXCLUDED.seed,
       players = EXCLUDED.players, events = EXCLUDED.events, snapshots = EXCLUDED.snapshots,
       frames = EXCLUDED.frames, bytes = EXCLUDED.bytes
     RETURNING id`,
    [doc.matchKey, doc.mode || null, doc.difficulty || null, doc.version || null,
      doc.seed == null ? null : String(doc.seed), JSON.stringify(doc.players || []), JSON.stringify(events),
      JSON.stringify(Array.isArray(doc.snapshots) ? doc.snapshots.slice(-400) : []),
      Number(doc.frames) || 0, bytes]);
  return String(res.rows[0].id);
}

/** Write one match record for an account. @returns {Promise<string>} record id */
export async function addMatchRecord(db, { accountId, playerId, matchKey, mode, difficulty, version, result, summary, startedAt, endedAt }) {
  const res = await db.query(
    `INSERT INTO match_records (account_id, player_id, match_key, mode, difficulty, version, result, summary, started_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, COALESCE($10, now())) RETURNING id`,
    [String(accountId), playerId || null, matchKey || null, mode || null, difficulty || null, version || null,
      result || null, JSON.stringify(summary || {}), startedAt || null, endedAt || null]);
  return String(res.rows[0].id);
}

// ---- 云端 Demo（每账号只保留最新 CLOUD_DEMOS 局；Demo 仍是本机录制、本机播放，云端只做跨设备备份） ----

export const CLOUD_DEMOS = 10;
export const MAX_CLOUD_DEMO_BYTES = 3 * 1024 * 1024;

/**
 * 上传一局 Demo 到账号，并裁到最新 CLOUD_DEMOS 局。
 * @returns {Promise<{ok: true, id: string} | {ok: false, code: string}>}
 */
export async function putAccountDemo(db, accountId, doc = {}) {
  const players = Array.isArray(doc.players) ? doc.players.slice(0, 8) : [];
  const events = Array.isArray(doc.events) ? doc.events.slice(0, MAX_DEMO_EVENTS) : [];
  const snapshots = Array.isArray(doc.snapshots) ? doc.snapshots.slice(-400) : [];
  // 可视化回放的原始 S2C 帧（m.* / b.*）；旧文档没有这个字段时为空
  const wire = Array.isArray(doc.wire) ? doc.wire.slice(0, 20_000) : [];
  const body = JSON.stringify({ players, events, snapshots, wire });
  if (Buffer.byteLength(body) > MAX_CLOUD_DEMO_BYTES) return { ok: false, code: 'TOO_LARGE' };
  if (!doc.demoKey && !doc.id) return { ok: false, code: 'NO_KEY' };
  const demoKey = String(doc.demoKey || doc.id).slice(0, 64);
  const startedAt = Number.isFinite(Number(doc.startedAt)) ? new Date(Number(doc.startedAt)) : null;
  const res = await db.query(
    `INSERT INTO account_demos (account_id, demo_key, started_at, mode, difficulty, players, events, snapshots, wire, bytes)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10)
     ON CONFLICT (account_id, demo_key) DO UPDATE SET
       started_at = EXCLUDED.started_at, mode = EXCLUDED.mode, difficulty = EXCLUDED.difficulty,
       players = EXCLUDED.players, events = EXCLUDED.events, snapshots = EXCLUDED.snapshots,
       wire = EXCLUDED.wire, bytes = EXCLUDED.bytes
     RETURNING id`,
    [String(accountId), demoKey, startedAt, doc.mode || null, doc.difficulty || null,
      JSON.stringify(players), JSON.stringify(events), JSON.stringify(snapshots), JSON.stringify(wire), Buffer.byteLength(body)]);
  // 只保留最新 CLOUD_DEMOS 局（按开局时间，其次上传时间）
  await db.query(
    `DELETE FROM account_demos WHERE account_id = $1 AND id NOT IN (
       SELECT id FROM account_demos WHERE account_id = $1
        ORDER BY COALESCE(started_at, created_at) DESC, id DESC LIMIT $2)`,
    [String(accountId), CLOUD_DEMOS]);
  return { ok: true, id: String(res.rows[0].id) };
}

/** 账号的云端 Demo 列表（元数据，不含 events/snapshots），最新在前。 */
export async function listAccountDemos(db, accountId, { limit = CLOUD_DEMOS } = {}) {
  const res = await db.query(
    `SELECT id, demo_key, started_at, mode, difficulty, bytes,
            jsonb_array_length(events) AS event_count, jsonb_array_length(snapshots) AS frame_count
       FROM account_demos WHERE account_id = $1
       ORDER BY COALESCE(started_at, created_at) DESC, id DESC LIMIT $2`,
    [String(accountId), Math.min(CLOUD_DEMOS, Math.max(1, Number(limit) || CLOUD_DEMOS))]);
  return res.rows.map((r) => ({
    id: String(r.id), demoKey: r.demo_key, startedAt: r.started_at, mode: r.mode, difficulty: r.difficulty,
    bytes: Number(r.bytes) || 0, events: Number(r.event_count) || 0, frames: Number(r.frame_count) || 0,
  }));
}

/** 取回一局云端 Demo 的完整文档（仅本人）。 */
export async function getAccountDemo(db, accountId, id) {
  const res = await db.query(
    `SELECT id, demo_key, started_at, mode, difficulty, players, events, snapshots, wire
       FROM account_demos WHERE account_id = $1 AND id = $2`, [String(accountId), String(id)]);
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: `cloud_${row.id}`, demoKey: row.demo_key,
    startedAt: row.started_at ? new Date(row.started_at).getTime() : Date.now(),
    mode: row.mode, difficulty: row.difficulty,
    players: row.players || [], events: row.events || [], snapshots: row.snapshots || [], wire: row.wire || [],
  };
}
