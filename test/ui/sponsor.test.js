// The announcement QR (ui/sponsor.js) lives outside /assets, so it needs its own CDN prefix: the operator wants the
// announcement image served by R2 like the rest of the assets (2026-10-11). These assertions pin the join and the
// fallback, and check the component renders whatever SPONSOR_QR resolved to.
import test from 'node:test';
import assert from 'node:assert/strict';

import { SPONSOR_QR, SPONSOR_QR_PATH, sponsorQrUrl, SponsorQr } from '../../public/js/ui/sponsor.js';

test('the announcement QR is prefixed with the runtime asset CDN', () => {
  assert.equal(SPONSOR_QR_PATH, '/img/sponsor-qr.png');
  assert.equal(sponsorQrUrl(''), '/img/sponsor-qr.png', 'no CDN configured keeps the same-origin path');
  assert.equal(sponsorQrUrl(), SPONSOR_QR, 'the default base is the runtime ASSETS_CDN');
  assert.equal(sponsorQrUrl('https://local.xiaolubao.com/Stronghold-Protocol'),
    'https://local.xiaolubao.com/Stronghold-Protocol/img/sponsor-qr.png');
  assert.equal(sponsorQrUrl('https://cdn.example.com/base/'),
    'https://cdn.example.com/base/img/sponsor-qr.png', 'a trailing slash is not doubled');
  assert.equal(sponsorQrUrl(undefined), SPONSOR_QR);

  const children = SponsorQr().props.children;
  const img = (Array.isArray(children) ? children : [children]).find((c) => c?.type === 'img');
  assert.ok(img, 'the sponsor block renders the QR image');
  assert.equal(img.props.src, SPONSOR_QR);
  assert.equal(img.props.width, '1143');
  assert.equal(img.props.height, '685');
});
