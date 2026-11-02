import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployFoldsShop, deployZoomsBoard, prepDeployCamera, prepCameraFor } from '../../public/js/ui/gameLogic.js';

// The fork's own `deploymentZoom` preference is back as 设置「部署时镜头缩放」 (`deployZoom`, 2026-11-02), next to the
// upstream 设置「部署时收起商店」 (`prepDeployFold`): the same deploy interaction, two switches — the shop's fold and the
// camera. Both default off. `prepDeployCamera` takes the camera from `deployZoom` alone, so a fold-only player keeps
// the camera they had (the bar's own fold still follows `shopFolded`).
const own = { ownPrep: true, editable: true, pen: false, drag: false, facing: false };

test('turning the deploy zoom off does not disable manual shop folding', () => {
  assert.equal(deployZoomsBoard({ ...own, drag: true, enabled: false }), false);
  const pub = { round: 1, bossRound: 14, hiddenRound: 15, players: [{ playerId: 'p', seat: 0, alive: true }] };
  assert.equal(prepCameraFor(pub, 'p', true).opts.shop, false);
  assert.equal(prepCameraFor(pub, 'p', false).opts.shop, true);
});

test('deployZoomsBoard: the deploy interaction takes the camera, on its own switch', () => {
  assert.equal(deployZoomsBoard({ ...own, drag: true, enabled: true }), true);
  assert.equal(deployZoomsBoard({ ...own, facing: true, enabled: true }), true);
  assert.equal(deployZoomsBoard({ ...own, drag: true }), false, 'enabled omitted stays off');
  assert.equal(deployZoomsBoard({ ...own, ownPrep: false, drag: true, enabled: true }), false);
  assert.equal(deployZoomsBoard({ ...own, editable: false, drag: true, enabled: true }), false);
  assert.equal(deployZoomsBoard({ ...own, pen: true, drag: true, enabled: true }), false);
  assert.equal(deployZoomsBoard(null), false);
  // the two switches are independent: the camera switch never folds the shop and vice versa
  assert.equal(deployFoldsShop({ ...own, drag: true, enabled: false }), false);
  assert.equal(deployFoldsShop({ ...own, drag: true, enabled: true }), true);
});

test('prepDeployCamera: the camera follows deployZoom, not the shop fold', () => {
  const pub = { round: 1, bossRound: 14, hiddenRound: 15, players: [{ playerId: 'p', seat: 0, alive: true }] };
  const base = { pub, myId: 'p', folded: false, ownPrep: true, pen: false, busy: false, current: null };
  assert.equal(prepDeployCamera({ ...base, deployZoom: true }).opts.shop, false, 'zoom on: the shop-collapsed framing');
  // already on the shop camera: the fold path asks for nothing (the zoom path would still ask for the collapsed one)
  const onShopCam = { ...base, current: { kind: 'prep', opts: { shop: true } } };
  assert.equal(prepDeployCamera({ ...onShopCam, deployZoom: false }), null, 'zoom off: the shop fold has nothing to fly to');
  assert.equal(prepDeployCamera({ ...onShopCam, deployZoom: true }).opts.shop, false, 'zoom on: still flies to the collapsed framing');
  // a fold-only player (`deployFold` true, `deployZoom` false) keeps the camera the shop fold asks for
  assert.equal(prepDeployCamera({ ...base, deployZoom: false, folded: true }).opts.shop, false);
});
