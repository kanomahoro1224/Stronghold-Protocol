// server/accounts/teamToken.js — signed upload token for a team-demo match.
//
// The matchId alone is public (m.public carries it), so knowing it must not let an arbitrary player append a part.
// The lobby stamps a token derived from the server secret into m.public; the recorder keeps it with the local demo;
// POST /api/team-demos/:matchId/parts rejects a body whose token does not match. This is verification, not a password
// stored in PostgreSQL: a match's token can be forgotten once the match ends, and rotating SP_TEAM_TOKEN_SECRET revokes
// every outstanding one.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET = String(process.env.SP_TEAM_TOKEN_SECRET || '') || randomBytes(32).toString('hex');
const PREFIX = 'stronghold-team-demo:';

/** Stable token for one matchId. The lobby and the accounts API share this module, so no DB round-trip is needed. */
export function teamMatchToken(matchId) {
  const id = String(matchId || '');
  if (!id) return '';
  return createHmac('sha256', SECRET).update(PREFIX + id).digest('base64url');
}

/** Constant-time comparison; false for empty/missing tokens or a different matchId. */
export function verifyTeamMatchToken(matchId, token) {
  const expected = teamMatchToken(matchId);
  const got = String(token || '');
  if (!expected || got.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(got), Buffer.from(expected)); } catch { return false; }
}
