// Signed team-demo upload token: deterministic for one match, reject a guessed matchId / altered token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamMatchToken, verifyTeamMatchToken } from '../server/accounts/teamToken.js';

test('team upload token: stable per match, not transferable, constant-time verifier', () => {
  const id = 'm_TEST_1_42';
  const token = teamMatchToken(id);
  assert.equal(token, teamMatchToken(id), 'the lobby and API derive the same token');
  assert.notEqual(token, teamMatchToken('m_TEST_2_42'), 'a different match has a different token');
  assert.equal(verifyTeamMatchToken(id, token), true);
  assert.equal(verifyTeamMatchToken(id, `${token.slice(0, -1)}x`), false);
  assert.equal(verifyTeamMatchToken('m_OTHER', token), false);
  assert.equal(verifyTeamMatchToken(id, ''), false);
});
