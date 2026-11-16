// server/accounts/teamStore.js — persistence for team-demo parts and canonical documents.
//
// Parts are gzip JSON in PostgreSQL (bytea), one row per (matchId, playerId). The canonical document is stored once
// and four accounts link to it (team_demo_links), so storage is not 4×. Storage only; merge math is in teamDemos.js.
import { gzipSync, gunzipSync } from 'node:zlib';
import { accountOfPlayer } from './store.js';
import { mergeTeamDemos, filterTeamDemoForViewer, fitTeamDemoToLimit, MAX_TEAM_PART_GZIP, MAX_TEAM_PART_JSON } from './teamDemos.js';

const PART_RETENTION_MS = 24 * 60 * 60 * 1000;
const PART_TIMEOUT_MS = 5 * 60 * 1000;

/** Thrown for client-facing part errors (the API maps code → HTTP 400/413). */
const fail = (code) => Object.assign(new Error(code), { code });

function decodePart(row) {
  const doc = JSON.parse(gunzipSync(row.doc).toString('utf8'));
  return { playerId: row.player_id, accountId: row.account_id == null ? null : String(row.account_id), doc, bytes: row.bytes };
}

/**
 * Store one player's part. Verifies that the playerId really belongs to the account (player_links), so a client cannot
 * claim a teammate's seat. Re-uploading the same (matchId, playerId) replaces the row idempotently.
 * @param {{ matchId: string, playerId: string, accountId: string, doc: any }} input
 */
export async function putTeamDemoPart(db, { matchId, playerId, accountId, doc } = {}) {
  if (!matchId || !playerId || !doc) throw fail('BAD_PART');
  if (String(doc.matchId || '') !== String(matchId)) throw fail('MATCH_ID_MISMATCH');
  // The outer playerId is what player_links verifies. Never let a document claim another seat as its recorder identity.
  if (doc.playerId && String(doc.playerId) !== String(playerId)) throw fail('PLAYER_ID_MISMATCH');
  const owner = await accountOfPlayer(db, playerId);
  if (!owner || String(owner.accountId) !== String(accountId)) throw fail('PLAYER_NOT_LINKED');
  let json;
  try { json = JSON.stringify(doc); } catch { throw fail('BAD_PART'); }
  // The API limit is bytes, not code units: a part full of non-ASCII text must not slip past a .length check.
  if (Buffer.byteLength(json, 'utf8') > MAX_TEAM_PART_JSON) throw fail('TOO_LARGE_JSON');
  const gz = gzipSync(Buffer.from(json));
  if (gz.length > MAX_TEAM_PART_GZIP) throw fail('TOO_LARGE');
  await db.query(
    `INSERT INTO team_demo_parts (match_id, player_id, account_id, doc, bytes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (match_id, player_id) DO UPDATE SET account_id = EXCLUDED.account_id, doc = EXCLUDED.doc,
       bytes = EXCLUDED.bytes, uploaded_at = now()`,
    [String(matchId), String(playerId), String(accountId), gz, gz.length]);
  // A player who rebinds to another account must not keep the old account's canonical download link. The new account
  // gets its link at the next merge; until then it can still inspect status through the part it just uploaded.
  await db.query(
    `DELETE FROM team_demo_links WHERE player_id = $1 AND account_id <> $2`,
    [String(playerId), String(accountId)]);
  return { ok: true, bytes: gz.length };
}

/**
 * Whether this account may inspect a team demo match: it uploaded a part, is linked to the canonical, or owns one of
 * the human playerIds declared by an uploaded part (the only participant list available before everyone uploads).
 */
export async function teamMatchForAccount(db, accountId, matchId) {
  const parts = await listTeamDemoParts(db, matchId);
  if (parts.some((p) => p.accountId != null && String(p.accountId) === String(accountId))) return true;
  const participants = participantsOf(parts);
  if (participants.length) {
    const linked = await db.query(
      `SELECT 1 FROM player_links WHERE account_id = $1 AND player_id = ANY($2::text[]) LIMIT 1`,
      [String(accountId), participants]);
    if (linked.rows[0]) return true;
  }
  const canonical = await db.query(
    `SELECT 1 FROM team_demos d JOIN team_demo_links l ON l.team_demo_id = d.id
      WHERE d.match_id = $1 AND l.account_id = $2 LIMIT 1`, [String(matchId), String(accountId)]);
  return !!canonical.rows[0];
}

/** All parts of one match, newest upload wins (the unique key already guarantees one row per player). */
export async function listTeamDemoParts(db, matchId) {
  const res = await db.query(
    `SELECT player_id, account_id, doc, bytes FROM team_demo_parts WHERE match_id = $1 ORDER BY player_id`,
    [String(matchId)]);
  return res.rows.map(decodePart);
}

/** Human participants declared by the first part's recorder document. */
function participantsOf(parts) {
  return [...new Set(parts.flatMap((p) => (Array.isArray(p.doc?.players) ? p.doc.players : [])
    .filter((x) => x && !x.isBot && x.playerId).map((x) => String(x.playerId))) )];
}

/** Status of one match's uploads: who is in, who is missing, whether a canonical exists. */
export async function getTeamDemoStatus(db, matchId) {
  const parts = await listTeamDemoParts(db, matchId);
  const participants = participantsOf(parts);
  const uploaded = [...new Set(parts.map((p) => p.playerId))];
  const missing = participants.filter((id) => !uploaded.includes(id));
  let row = await db.query(`SELECT id, partial, available_fields, bytes FROM team_demos WHERE match_id = $1`, [String(matchId)]);
  let merged = row.rows[0] || null;
  // 全员到齐但一次合并失败 / 还停在旧的 partial：状态查询本身要补合并。否则只有再上传一次 part 才会恢复，
  // 而客户端此时通常已经在等一个永远不会出现的 merged=true。
  if (parts.length && !missing.length && (!merged || merged.partial)) {
    const m = await mergeTeamDemo(db, matchId, { force: false });
    if (m.ok) merged = { id: m.id, partial: m.partial, available_fields: m.availableFields, bytes: m.bytes || 0 };
  }
  // 缺人超过 5 分钟时，下一次状态查询用已上传的 parts 生成 partial（不阻塞上传）。
  if (missing.length && !merged && parts.length) {
    const oldest = await db.query(`SELECT MIN(uploaded_at) AS oldest FROM team_demo_parts WHERE match_id = $1`, [String(matchId)]);
    const since = oldest.rows[0]?.oldest ? new Date(oldest.rows[0].oldest).getTime() : NaN;
    if (Number.isFinite(since) && Date.now() - since >= PART_TIMEOUT_MS) {
      const m = await mergeTeamDemo(db, matchId, { force: true });
      if (m.ok) merged = { id: m.id, partial: m.partial, available_fields: m.availableFields, bytes: m.bytes || 0 };
    }
  }
  return {
    ok: true,
    matchId, participants, uploaded, missing,
    waitingFor: missing,
    merged: !!merged,
    mergedId: merged?.id ? String(merged.id) : null,
    partial: merged ? !!merged.partial : missing.length > 0,
    bytes: merged ? Number(merged.bytes) || 0 : 0,
    availableFields: merged ? merged.available_fields || [] : [],
  };
}

/**
 * Merge every part currently stored. `force` makes a partial document after the timeout; without it, a missing
 * participant means no canonical yet (status still reports who is missing).
 */
export async function mergeTeamDemo(db, matchId, { force = false } = {}) {
  const parts = await listTeamDemoParts(db, matchId);
  const participants = participantsOf(parts);
  if (!parts.length) return { ok: false, code: 'NO_PARTS' };
  const missing = participants.filter((id) => !parts.some((p) => p.playerId === id));
  if (missing.length && !force) return { ok: false, code: 'WAITING', waitingFor: missing };
  const mergedDoc = mergeTeamDemos(parts, { matchId, participants });
  // 8 MB is a hard storage limit, not a label: fitTeamDemoToLimit always returns a gzip <= 8 MB (downsample, slim,
  // then a tiny replayable fallback). A missing-participant partial keeps its `partial:true`; size alone no longer
  // pretends the document is incomplete.
  const fitted = fitTeamDemoToLimit(mergedDoc);
  const doc = fitted.doc;
  const gz = fitted.gz;
  const res = await db.query(
    `INSERT INTO team_demos (match_id, canonical, bytes, partial, available_fields)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (match_id) DO UPDATE SET canonical = EXCLUDED.canonical, bytes = EXCLUDED.bytes,
       partial = EXCLUDED.partial, available_fields = EXCLUDED.available_fields, created_at = now()
     RETURNING id`,
    [String(matchId), gz, gz.length, !!doc.partial, JSON.stringify(doc.availableFields)]);
  const teamDemoId = String(res.rows[0].id);
  const links = [];
  for (const p of parts) {
    const owner = await accountOfPlayer(db, p.playerId);
    if (!owner) continue;
    await db.query(
      `INSERT INTO team_demo_links (team_demo_id, account_id, player_id) VALUES ($1, $2, $3)
       ON CONFLICT (team_demo_id, account_id, player_id) DO NOTHING`,
      [teamDemoId, String(owner.accountId), p.playerId]);
    links.push({ accountId: String(owner.accountId), playerId: p.playerId });
  }
  // Remove links from an earlier canonical only after every new link is in place: a mid-merge failure must not
  // revoke the old participants' access. A re-merge without one participant still drops that stale link.
  const accountIds = links.map((l) => l.accountId);
  if (accountIds.length) {
    await db.query(`DELETE FROM team_demo_links WHERE team_demo_id = $1 AND NOT (account_id = ANY($2::bigint[]))`,
      [teamDemoId, accountIds]);
  } else {
    await db.query(`DELETE FROM team_demo_links WHERE team_demo_id = $1`, [teamDemoId]);
  }
  return { ok: true, id: teamDemoId, partial: !!doc.partial, availableFields: doc.availableFields, bytes: gz.length, links };
}

/** Purge parts older than 24h (call opportunistically after an upload/merge). */
export async function pruneTeamParts(db, now = Date.now()) {
  const cutoff = new Date(Number(now) - PART_RETENTION_MS);
  await db.query(`DELETE FROM team_demo_parts WHERE uploaded_at < $1`, [cutoff]);
}

/** The merged demos this account participates in, newest first (metadata only). */
export async function listTeamDemosForAccount(db, accountId, { limit = 10 } = {}) {
  const res = await db.query(
    `SELECT d.id, d.match_id, d.partial, d.bytes, d.available_fields, d.created_at,
            array_agg(l.player_id ORDER BY l.player_id) AS player_ids
       FROM team_demo_links l JOIN team_demos d ON d.id = l.team_demo_id
      WHERE l.account_id = $1
      GROUP BY d.id, d.match_id, d.partial, d.bytes, d.available_fields, d.created_at
      ORDER BY d.created_at DESC, d.id DESC LIMIT $2`,
    [String(accountId), Math.min(10, Math.max(1, Number(limit) || 10))]);
  return res.rows.map((r) => ({
    id: String(r.id), matchId: r.match_id, partial: !!r.partial, bytes: Number(r.bytes) || 0,
    availableFields: r.available_fields || [], playerId: r.player_ids?.[0] || null,
    playerIds: r.player_ids || [], createdAt: r.created_at,
  }));
}

/** Read one canonical for an account, filtering every other player's private stream out. */
export async function getTeamDemoForViewer(db, accountId, teamDemoId) {
  const link = await db.query(
    `SELECT l.player_id, d.id, d.match_id, d.canonical, d.partial, d.available_fields
       FROM team_demo_links l JOIN team_demos d ON d.id = l.team_demo_id
      WHERE l.team_demo_id = $1 AND l.account_id = $2 ORDER BY l.player_id`,
    [String(teamDemoId), String(accountId)]);
  const row = link.rows[0];
  if (!row) return null;
  let doc;
  try { doc = JSON.parse(gunzipSync(row.canonical).toString('utf8')); } catch { return null; }
  const filtered = filterTeamDemoForViewer(doc, link.rows.map((x) => x.player_id));
  return { ...filtered, id: `team_${row.id}`, teamDemoId: String(row.id), partial: !!row.partial, availableFields: row.available_fields || [] };
}
