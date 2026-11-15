// server/accounts/teamStore.js — persistence for team-demo parts and canonical documents.
//
// Parts are gzip JSON in PostgreSQL (bytea), one row per (matchId, playerId). The canonical document is stored once
// and four accounts link to it (team_demo_links), so storage is not 4×. Storage only; merge math is in teamDemos.js.
import { gzipSync, gunzipSync } from 'node:zlib';
import { accountOfPlayer } from './store.js';
import { mergeTeamDemos, filterTeamDemoForViewer, MAX_TEAM_PART_GZIP, MAX_TEAM_PART_JSON } from './teamDemos.js';

const PART_RETENTION_MS = 24 * 60 * 60 * 1000;

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
  const owner = await accountOfPlayer(db, playerId);
  if (!owner || String(owner.accountId) !== String(accountId)) throw fail('PLAYER_NOT_LINKED');
  let json;
  try { json = JSON.stringify(doc); } catch { throw fail('BAD_PART'); }
  if (json.length > MAX_TEAM_PART_JSON) throw fail('TOO_LARGE_JSON');
  const gz = gzipSync(Buffer.from(json));
  if (gz.length > MAX_TEAM_PART_GZIP) throw fail('TOO_LARGE');
  await db.query(
    `INSERT INTO team_demo_parts (match_id, player_id, account_id, doc, bytes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (match_id, player_id) DO UPDATE SET doc = EXCLUDED.doc, bytes = EXCLUDED.bytes, uploaded_at = now()`,
    [String(matchId), String(playerId), String(accountId), gz, gz.length]);
  return { ok: true, bytes: gz.length };
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
  const row = await db.query(`SELECT partial, available_fields, bytes FROM team_demos WHERE match_id = $1`, [String(matchId)]);
  const merged = row.rows[0] || null;
  return {
    ok: true,
    matchId, participants, uploaded, missing,
    waitingFor: missing,
    merged: !!merged,
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
  const doc = mergeTeamDemos(parts, { matchId, participants });
  const json = JSON.stringify(doc);
  const gz = gzipSync(Buffer.from(json));
  const res = await db.query(
    `INSERT INTO team_demos (match_id, canonical, bytes, partial, available_fields)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (match_id) DO UPDATE SET canonical = EXCLUDED.canonical, bytes = EXCLUDED.bytes,
       partial = EXCLUDED.partial, available_fields = EXCLUDED.available_fields
     RETURNING id`,
    [String(matchId), gz, gz.length, !!doc.partial, JSON.stringify(doc.availableFields)]);
  const teamDemoId = String(res.rows[0].id);
  const links = [];
  for (const p of parts) {
    const owner = await accountOfPlayer(db, p.playerId);
    if (!owner) continue;
    await db.query(
      `INSERT INTO team_demo_links (team_demo_id, account_id, player_id) VALUES ($1, $2, $3)
       ON CONFLICT (team_demo_id, account_id) DO UPDATE SET player_id = EXCLUDED.player_id`,
      [teamDemoId, String(owner.accountId), p.playerId]);
    links.push({ accountId: String(owner.accountId), playerId: p.playerId });
  }
  return { ok: true, id: teamDemoId, partial: !!doc.partial, availableFields: doc.availableFields, links };
}

/** Purge parts older than 24h (call opportunistically after an upload/merge). */
export async function pruneTeamParts(db, now = Date.now()) {
  const cutoff = new Date(Number(now) - PART_RETENTION_MS);
  await db.query(`DELETE FROM team_demo_parts WHERE uploaded_at < $1`, [cutoff]);
}

/** The merged demos this account participates in, newest first (metadata only). */
export async function listTeamDemosForAccount(db, accountId, { limit = 10 } = {}) {
  const res = await db.query(
    `SELECT d.id, d.match_id, d.partial, d.bytes, d.available_fields, d.created_at, l.player_id
       FROM team_demo_links l JOIN team_demos d ON d.id = l.team_demo_id
      WHERE l.account_id = $1 ORDER BY d.created_at DESC, d.id DESC LIMIT $2`,
    [String(accountId), Math.min(10, Math.max(1, Number(limit) || 10))]);
  return res.rows.map((r) => ({
    id: String(r.id), matchId: r.match_id, partial: !!r.partial, bytes: Number(r.bytes) || 0,
    availableFields: r.available_fields || [], playerId: r.player_id, createdAt: r.created_at,
  }));
}

/** Read one canonical for an account, filtering every other player's private stream out. */
export async function getTeamDemoForViewer(db, accountId, teamDemoId) {
  const link = await db.query(
    `SELECT l.player_id, d.id, d.match_id, d.canonical, d.partial, d.available_fields
       FROM team_demo_links l JOIN team_demos d ON d.id = l.team_demo_id
      WHERE l.team_demo_id = $1 AND l.account_id = $2`,
    [String(teamDemoId), String(accountId)]);
  const row = link.rows[0];
  if (!row) return null;
  let doc;
  try { doc = JSON.parse(gunzipSync(row.canonical).toString('utf8')); } catch { return null; }
  const filtered = filterTeamDemoForViewer(doc, row.player_id);
  return { ...filtered, id: `team_${row.id}`, teamDemoId: String(row.id), partial: !!row.partial, availableFields: row.available_fields || [] };
}
