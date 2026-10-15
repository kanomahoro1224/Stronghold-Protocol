import { normalizePreloadVoiceLang } from '../../resources/common.js';
import { normalizeFrameRate } from '../../frameRate.js';
// ui/gameLogic/settings.js — settings defaults and sanitising. Re-exported from ../gameLogic.js.

import { VOICE_LANGS, sanitizeVoiceOverrides } from '../../voicePrefs.js';
export { VOICE_LANGS } from '../../voicePrefs.js';

import { clamp, isObj } from './shared.js';


// ---- settings ------------------------------------------------------------------------------------------------------

/**
 * The operator voice dubs (settings 语音语言): 'cn' 中文 (`audio.voice`, the default) and 'jp' 日本語 (`audio.voiceJp`,
 * falling back to the Chinese line it lacks — public/js/audio.js voiceLine). Not tied to the interface language.
 */


/**
 * The steps of 设置 →「文字大小」 (textSize): the interface text root `--t` of css/theme.css — 'sm' is the design's own
 * sizes (`--t: 1rem`), the others lift the phone's 40 px root by a floor and grow the desktop gently. Text only: the
 * layout root `1rem` (and with it the field camera, the detail card's side and the DOM fallback board) never moves.
 */
export const TEXT_SIZES = Object.freeze(['sm', 'md', 'lg', 'xl']);

/**
 * The skins of 设置 →「界面主题」 (uiTheme, applied by ui/settings.js applyUiTheme → `<html data-ui-theme>`):
 * 'default' is this branch's own dark interface, 'glass' is the 液态玻璃 skin (css/glass.css — the layered
 * highlight structure of yzrt-master's pure-CSS liquid glass, retuned for a dark backdrop). A skin only paints:
 * no layout value, no readable font-size and no `--t` changes with it, so the two can be swapped at any moment.
 */
export const UI_THEMES = Object.freeze(['default', 'glass']);

/** keys: the in-match shortcuts' key map (ui/gameLogic/shortcuts.js; settings → 快捷键). voiceLang: VOICE_LANGS.
 *  textSize: TEXT_SIZES (css/theme.css `--t`, applied by ui/settings.js applyTextSize). ammoCount: 设置「弹药数量」 — the
 *  rounds left / the magazine under an ammo skill's bar (render/units.js; PR #552), off by default: the official HUD has no
 *  such number (the maintainer's decision of 2026-10-13). fpsLimit / preload*: this branch's frame-rate cap and the
 *  optional asset preload (docs/ASSETS.md「Preload」); the in-match shortcuts live in their own store (ui/settings.js
 *  shortcutsStore, ui/gameLogic/shortcuts.js DEFAULT_SHORTCUTS), not here. */
export const DEFAULT_SETTINGS = Object.freeze({ bgm: 0.6, sfx: 0.8, voice: 0.8, voiceLang: 'cn', voiceOverrides: Object.freeze({}), muted: false, damageNumbers: true, officialDamageNumbers: false, ammoCount: false, quality: 'high', textSize: 'sm', uiTheme: 'default', fpsLimit: 0, preload: false, preloadOptional: false, preloadVoiceLang: 'cn' });
const QUALITIES = ['high', 'medium', 'low'];

/**
 * Sanitize persisted settings.
 * @param {any} raw
 * @returns {{ bgm: number, sfx: number, voice: number, voiceLang: 'cn'|'jp', voiceOverrides: Record<string, string>, muted: boolean, damageNumbers: boolean, officialDamageNumbers: boolean, ammoCount: boolean, quality: 'high'|'medium'|'low',
 *   textSize: 'sm'|'md'|'lg'|'xl', keys: Record<'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready', string> }}
 */
export function sanitizeSettings(raw) {
  const r = isObj(raw) ? raw : {};
  const vol = (v, d) => (Number.isFinite(v) ? clamp(Math.round(v * 100) / 100, 0, 1) : d);
  return {
    bgm: vol(r.bgm, DEFAULT_SETTINGS.bgm),
    sfx: vol(r.sfx, DEFAULT_SETTINGS.sfx),
    voice: vol(r.voice, DEFAULT_SETTINGS.voice),
    voiceLang: VOICE_LANGS.includes(r.voiceLang) ? r.voiceLang : DEFAULT_SETTINGS.voiceLang,
    voiceOverrides: sanitizeVoiceOverrides(r.voiceOverrides),
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SETTINGS.muted,
    damageNumbers: typeof r.damageNumbers === 'boolean' ? r.damageNumbers : DEFAULT_SETTINGS.damageNumbers,
    officialDamageNumbers: typeof r.officialDamageNumbers === 'boolean' ? r.officialDamageNumbers : false,
    ammoCount: typeof r.ammoCount === 'boolean' ? r.ammoCount : DEFAULT_SETTINGS.ammoCount,
    quality: QUALITIES.includes(r.quality) ? r.quality : DEFAULT_SETTINGS.quality,
    fpsLimit: normalizeFrameRate(r.fpsLimit),
    // optional asset preload (docs/ASSETS.md「Preload」): off unless the player turned it on
    preload: typeof r.preload === 'boolean' ? r.preload : DEFAULT_SETTINGS.preload,
    preloadOptional: typeof r.preloadOptional === 'boolean' ? r.preloadOptional : DEFAULT_SETTINGS.preloadOptional,
    preloadVoiceLang: normalizePreloadVoiceLang(r.preloadVoiceLang, r.voiceLang),
    textSize: TEXT_SIZES.includes(r.textSize) ? r.textSize : DEFAULT_SETTINGS.textSize,
    uiTheme: UI_THEMES.includes(r.uiTheme) ? r.uiTheme : DEFAULT_SETTINGS.uiTheme,
  };
}
