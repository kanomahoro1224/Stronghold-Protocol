// 皮肤选择器 (docs/SKINS.md) — the 皮肤 section of the 干员调配 screen's detail panel.
//
// Self-contained on purpose: screens/loadout.js only imports this and drops `<${SkinSection} chess=… />` into its
// detail body, so upstream rewriting that screen (it is one of the two files most likely to change) costs one
// line here rather than a merge conflict over the whole panel.
//
// Every skin the catalogue lists is installed ahead of time and served from the CDN (docs/SKINS.md), so there is no
// install step in the game: 默认 clears the choice and any other button selects that skin. A skin whose model this
// install does not have is not listed at all (ui/skins.js availableSkins).

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { t } from '../../../shared/i18n.js';
import { html, MicroLabel } from './components.js';
import { useStore, shallowEqual } from '../store.js';
import { data } from '../data.js';
import { skinsStore, availableSkins, loadSkinData, setSkin, clearSkin } from './skins.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/**
 * The skin's 180×180 avatar URL, or null when the manifest has no entry for it.
 *
 * Keyed by OPERATOR id, not by chess id: data/assets.json groups everything under `chars[charId]`, and the skin
 * catalogue does the same. A chess record carries both (`chess_char_1_01_a` → `charId: char_498_inside`), and
 * getting the two the wrong way round makes the whole section silently empty.
 */
function skinAvatar(charId, skinId) {
  return data.get('assets')?.chars?.[charId]?.skins?.[skinId]?.avatar || null;
}

/**
 * 皮肤 section for one operator.
 * @param {{ chess: any }} props `chess` is the chess record of the detail panel
 */
export function SkinSection({ chess }) {
  const s = useStore((v) => v, shallowEqual, skinsStore);
  const [, bump] = useState(0);
  // Two ids, and they are not interchangeable: the CHOICE is stored per chess (like the loadout, and that is the
  // key the server validates and the renderer reads), while the catalogue and the asset manifest are per operator.
  const chessId = chess && chess.chessId;
  const charId = chess && chess.charId;
  // the catalogue lives in data/skins.json and the models in data/assets.json; both may still be loading
  useEffect(() => {
    let dead = false;
    loadSkinData();
    const off = data.subscribe?.(() => { if (!dead) bump((n) => n + 1); });
    const t = setInterval(() => { if (!dead) bump((n) => n + 1); }, 500);
    return () => { dead = true; clearInterval(t); off?.(); };
  }, [chessId]);

  if (!chessId || !charId) return null;
  const list = availableSkins(charId);
  if (!list.length) return null; // this operator has no skins at all — say nothing rather than show an empty section

  const chosen = s.entries[chessId] || null;

  return html`<section class="lo-sec lo-sec--skin" data-testid="skin-section">
    <header class="lo-sec__head">
      <h3>${t('皮肤')}<${MicroLabel}>SKIN<//></h3>
      <span class="lo-sec__note">${t('{n} 款', { n: list.length })}</span>
    </header>
    <div class="lo-skins" role="radiogroup" aria-label=${t('选择皮肤')}>
      <button type="button" role="radio" aria-checked=${chosen ? 'false' : 'true'} data-skin=""
        class=${cx('lo-skin', 'lo-skin--default', !chosen && 'is-on')} onClick=${() => clearSkin(chessId)}>
        <span class="lo-skin__art lo-skin__art--none"></span>
        <span class="lo-skin__text"><b class="lo-skin__name">${t('默认')}</b><span class="lo-skin__group">DEFAULT</span></span>
      </button>
      ${list.map((x) => {
        const art = skinAvatar(charId, x.id);
        return html`<button key=${x.id} type="button" role="radio" aria-checked=${chosen === x.id ? 'true' : 'false'}
            data-skin=${x.id} class=${cx('lo-skin', chosen === x.id && 'is-on')}
            onClick=${() => setSkin(chessId, x.id)}>
          <span class="lo-skin__art">
            ${art ? html`<img src=${art} alt="" loading="lazy" />` : html`<span class="lo-skin__art--none"></span>`}
          </span>
          <span class="lo-skin__text">
            <b class="lo-skin__name">${x.name}</b>
            <span class="lo-skin__group">${x.group}</span>
          </span>
        </button>`;
      })}
    </div>
  </section>`;
}
