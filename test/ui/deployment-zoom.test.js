import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployFoldsShop, prepCameraFor } from '../../public/js/ui/gameLogic.js';

// The fork's own `deploymentZoom` preference (and its settings toggle / i18n strings) was
// replaced by the upstream `prepDeployFold` behaviour, so its cases were dropped with the
// abandoned fork UI. The shop-folding contract itself is shared and stays covered here.
test('turning off automatic deployment zoom does not disable manual shop folding', () => {
  assert.equal(deployFoldsShop({ enabled: false, ownPrep: true, editable: true, drag: true }), false);
  const pub = { round: 1, bossRound: 14, hiddenRound: 15, players: [{ playerId: 'p', seat: 0, alive: true }] };
  assert.equal(prepCameraFor(pub, 'p', true).opts.shop, false);
  assert.equal(prepCameraFor(pub, 'p', false).opts.shop, true);
});
