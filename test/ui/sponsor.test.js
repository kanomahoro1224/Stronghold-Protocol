// test/ui/sponsor.test.js — 赞助 (support, public/js/ui/sponsor.js): the QR that the 公告 panel shows in its right-hand
// column (text left, image right), and the committed file behind it.
//
// The block is one image plus one line of text, so the assertions are about the FILE (a real PNG under the web root,
// where a code deploy carries it) and about the two-column markup notice.js embeds.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SponsorQr, SPONSOR_QR, SPONSOR_HINT } from '../../public/js/ui/sponsor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const NOTICE_SRC = read('public/js/ui/notice.js');

describe('赞助: the QR in the 公告 panel', () => {
  test('the block is the QR image plus one line — no network, no state, no trigger of its own', () => {
    const v = SponsorQr({});
    assert.equal(v.type, 'div');
    assert.equal(v.props.class, 'sponsor');
    const [img, hint] = v.props.children;
    assert.equal(img.type, 'img');
    assert.equal(img.props.class, 'sponsor__qr');
    assert.equal(img.props.src, SPONSOR_QR);
    assert.equal(img.props.width, '1143', 'the intrinsic size keeps the column from jumping while the image loads');
    assert.equal(img.props.height, '685');
    assert.match(img.props.alt, /赞助/);
    assert.equal(hint.type, 'p');
    assert.equal(hint.props.class, 'sponsor__hint');
    assert.equal(hint.props.children, SPONSOR_HINT);
    assert.match(SPONSOR_HINT, /本服务器不要求赞助/);
    assert.ok(!/fetch\(|createStore/.test(read('public/js/ui/sponsor.js')), 'nothing to fetch, nothing to remember');
  });

  test('the QR is a committed PNG under the web root (a code deploy carries it)', () => {
    assert.equal(SPONSOR_QR, '/img/sponsor-qr.png');
    const bytes = fs.readFileSync(path.join(ROOT, 'public', SPONSOR_QR.replace(/^\//, '')));
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a real PNG');
    assert.equal(bytes.readUInt32BE(16), 1143, 'the operator\'s screenshot: 1143 wide');
    assert.equal(bytes.readUInt32BE(20), 685);
    assert.ok(bytes.length > 20000, 'not a placeholder');
    // public/assets and public/fonts are gitignored and CDN-mirrored: the QR must NOT live there
    assert.ok(!SPONSOR_QR.startsWith('/assets/'), 'not under the mirrored asset tree');
    assert.match(read('.gitignore'), /^public\/assets\/$/m);
    assert.match(read('.gitignore'), /^public\/fonts\/$/m);
  });

  test('the panel is two columns — text left, QR right — and stacks on a narrow screen', () => {
    assert.match(NOTICE_SRC, /import \{ SponsorQr \} from '\.\/sponsor\.js';/);
    assert.match(NOTICE_SRC, /<div class="notice__layout">/);
    assert.match(NOTICE_SRC, /class="notice__body"[\s\S]*?<aside class="notice__side"><\$\{SponsorQr\} \/><\/aside>/,
      'the QR is the layout\'s second column, after the text');
    assert.match(NOTICE_SRC, /width="min\(9\.6rem, 94vw\)"/, 'a wider dialog that still fits a phone');
    const css = read('public/css/screens/title.css');
    assert.match(css, /\.notice__layout \{ display: flex;/);
    assert.match(css, /\.notice__side \{ flex: 0 0 3\.5rem;/);
    assert.match(css, /@media \(max-width: 760px\) \{\s*\.notice__layout \{ flex-direction: column; \}/);
    assert.match(css, /\.sponsor__qr \{[\s\S]*?width: 100%/);
  });

  test('nothing shows the old textual sponsor row any more', () => {
    assert.ok(!read('public/js/screens/title.js').includes('花鹿云心'), 'the footer sponsor line is gone');
    assert.ok(!read('public/js/screens/title.js').includes('title-foot__link'), 'and its link');
    assert.ok(!read('data/notice.json').includes('花鹿云心'), 'the notice section was removed too');
    assert.ok(!read('data/notice.json').includes('维护提醒'), 'and the outdated maintenance reminder with it');
  });
});
