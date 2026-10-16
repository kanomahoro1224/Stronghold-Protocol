// 界面主题 (uiTheme): the lobby top bar's theme button, beside 添加到桌面 — it switches this branch's own dark
// interface and the 液态玻璃 skin (css/glass.css, the layered highlight structure of yzrt-master's pure-CSS liquid
// glass retuned for a dark backdrop).
//
// The choice is the settings store's `uiTheme` (ui/settings.js applyUiTheme → `<html data-ui-theme>`), so it is
// persisted with the other settings (`sp.pref.settings`, ui/store.js) and survives a reload. A skin only paints:
// no layout value, no readable font-size and no `--t` moves with it, so the two can be swapped at any moment —
// including during a match, which is why the button needs no confirmation and no restart.
//
// Icon-only square like its neighbours (⚙ / 玩法说明 / 大厅背景 / 全屏 / 音乐 / 添加到桌面): the glyph alone, the
// name stays in `title` and `aria-label`, and `aria-pressed` marks the 液态玻璃 skin as on.

import { html, Button } from './components.js';
import { t } from '../../../shared/i18n.js';
import { updateSettings, useSettings } from './settings.js';

/** The 液态玻璃 skin (css/glass.css). */
export const GLASS_THEME = 'glass';
/** This branch's own dark interface — the design the stylesheets paint with no `data-ui-theme` at all. */
export const DEFAULT_THEME = 'default';

/** Preact hook: the skin in use ('default' | 'glass'). */
export const useUiTheme = () => useSettings().uiTheme;

/**
 * Toggle the interface skin. Both directions are one click: the button always offers the other skin.
 * @param {'default'|'glass'} theme
 */
export function setUiTheme(theme) {
  updateSettings({ uiTheme: theme === GLASS_THEME ? GLASS_THEME : DEFAULT_THEME });
}

/** The lobby top bar's theme button. */
export function UiThemeButton({ class: cls = '', size = 'sm' }) {
  const glass = useUiTheme() === GLASS_THEME;
  const label = glass ? t('切换回默认主题') : t('液态玻璃主题');
  return html`<${Button} variant="secondary" size=${size} square=${true} class=${cls} icon="droplet"
    title=${label} aria-label=${label} active=${glass} data-testid="ui-theme"
    onClick=${() => setUiTheme(glass ? DEFAULT_THEME : GLASS_THEME)} />`;
}
