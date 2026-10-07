// 赞助 (support): the operator's donation QR. It is the RIGHT-HAND COLUMN of the 公告 panel (ui/notice.js NoticeHost),
// so the announcement reads the way the operator asked: the notice text on the left, the QR on the right.
//
// The QR is the operator's own screenshot (two panels side by side: the Alipay 赞赏码 and the “推荐使用支付宝” code).
// It lives at /img/sponsor-qr.png — public/ is the web root, so it needs no route, no data mount and no preload
// manifest entry (that manifest lists /assets and /fonts; this is one ~150 KB image loaded with the dialog).
// Replacing the code means replacing that file under a NEW name (or adding a query) and updating SPONSOR_QR: a browser
// caches an <img> by URL, so reusing the name would keep showing the old code.
//
// Nothing here fetches or stores anything, and there is no trigger button of its own: the only way in is 公告.

import { html } from './components.js';

/** The QR image (public/img/sponsor-qr.png — a committed file, not an asset-tree entry). */
export const SPONSOR_QR = '/img/sponsor-qr.png';
/** One line under the QR, in the operator's own words (the image itself already carries 鹿可 的赞赏码 / 推荐使用支付宝,
 *  and its own 「非常感谢使用我们的 app!」 line, so the operator had that sentence taken out of this hint on 2026-10-07). */
export const SPONSOR_HINT = '本服务器不要求赞助　扫码纯属自愿';

/**
 * The sponsorship block: the QR plus that line, sized by its container (the notice dialog's right column).
 * The intrinsic size is kept on the <img> so the column does not jump while the image loads.
 */
export function SponsorQr() {
  return html`<div class="sponsor">
    <img class="sponsor__qr" src=${SPONSOR_QR} alt="赞助码（支付宝）" width="1143" height="685" decoding="async" />
    <p class="sponsor__hint">${SPONSOR_HINT}</p>
  </div>`;
}
