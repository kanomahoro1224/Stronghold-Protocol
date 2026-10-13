// 赞助 (support): the operator's donation QR. It is the RIGHT-HAND COLUMN of the 公告 panel (ui/notice.js NoticeHost),
// so the announcement reads the way the operator asked: the notice text on the left, the QR on the right.
//
// The QR is the operator's own screenshot (two panels side by side: the Alipay 赞赏码 and the “推荐使用支付宝” code).
// It lives at /img/sponsor-qr.png — public/ is the web root, so it needs no route and no data mount. It is mirrored to
// R2 at <ASSETS_CDN>/img/sponsor-qr.png and the URL below is prefixed with the runtime CDN, so the announcement image
// is served by the CDN like every other asset instead of the game server (user request 2026-10-11).
// Replacing the code means replacing that file under a NEW name (or adding a query) and updating SPONSOR_QR_PATH: a
// browser caches an <img> by URL, so reusing the name would keep showing the old code.
//
// Nothing here fetches or stores anything, and there is no trigger button of its own: the only way in is 公告.

import { html } from './components.js';
import { t, N_ } from '../../../shared/i18n.js';
import { ASSETS_CDN } from '../asset-cdn.js';

/** The QR image path on disk (public/img/sponsor-qr.png — a committed file, not an asset-tree entry). */
export const SPONSOR_QR_PATH = '/img/sponsor-qr.png';

/**
 * The QR lives outside `/assets`, so `shared/cdn.js` never rewrites it; prefix the runtime asset CDN here instead
 * (empty base ⇒ the same-origin path, as in the source checkout and the tests).
 * @param {string} [base] CDN base, defaults to the runtime `ASSETS_CDN`
 */
export function sponsorQrUrl(base = ASSETS_CDN) {
  const b = typeof base === 'string' ? base.replace(/\/+$/, '') : '';
  return b ? b + SPONSOR_QR_PATH : SPONSOR_QR_PATH;
}

/** The QR image the announcement panel renders. */
export const SPONSOR_QR = sponsorQrUrl();
/** One line under the QR, in the operator's own words (the image itself already carries 鹿可 的赞赏码 / 推荐使用支付宝,
 *  and its own 「非常感谢使用我们的 app!」 line, so the operator had that sentence taken out of this hint on 2026-10-07). */
export const SPONSOR_HINT = N_('本服务器不要求赞助　扫码纯属自愿');

/**
 * The sponsorship block: the QR plus that line, sized by its container (the notice dialog's right column).
 * The intrinsic size is kept on the <img> so the column does not jump while the image loads.
 */
export function SponsorQr() {
  return html`<div class="sponsor">
    <img class="sponsor__qr" src=${SPONSOR_QR} alt=${t('赞助码（支付宝）')} width="1143" height="685" decoding="async" />
    <p class="sponsor__hint">${t(SPONSOR_HINT)}</p>
  </div>`;
}
