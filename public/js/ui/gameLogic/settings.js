// ui/gameLogic/settings.js — settings defaults and sanitising. Re-exported from ../gameLogic.js.

import { clamp, isObj } from './shared.js';
import { DEFAULT_HOTKEYS, sanitizeHotkeys } from './shortcuts.js';
import { VOICE_LANGS } from '../../audio.js';


// ---- settings ------------------------------------------------------------------------------------------------------

/** keys: the in-match shortcuts' key map (ui/gameLogic/shortcuts.js; settings → 快捷键). preload: 资源预载开关 (fork line).
 * preloadOptional: whether the optional tier (voices, SFX, music, tutorial pages) is part of that preload; a fork
 * default, like the switch itself — one click still saves everything, and the manager's 同时预载 checkbox unchecks it.
 * voiceLang: 配音语言 of the operator battle voice (audio.js VOICE_LANGS: 'cn' | 'jp') — 'cn' reads `audio.voice`,
 * 'jp' reads `audio.voiceAlt.jp` with a per-slot fallback to `audio.voice`, so a profile that picks a language a
 * deployment does not carry still hears the CN lines. */
export const DEFAULT_SETTINGS = Object.freeze({ bgm: 0.6, sfx: 0.8, voice: 0.8, muted: false, damageNumbers: true, quality: 'high', preload: false, preloadOptional: true, voiceLang: 'cn', keys: DEFAULT_HOTKEYS });
const QUALITIES = ['high', 'medium', 'low'];

/**
 * Sanitize persisted settings.
 * @param {any} raw
 * @returns {{ bgm: number, sfx: number, voice: number, muted: boolean, damageNumbers: boolean, quality: 'high'|'medium'|'low',
 *   preload: boolean, preloadOptional: boolean, voiceLang: 'cn'|'jp',
 *   keys: Record<'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready', string> }}
 */
export function sanitizeSettings(raw) {
  const r = isObj(raw) ? raw : {};
  const vol = (v, d) => (Number.isFinite(v) ? clamp(Math.round(v * 100) / 100, 0, 1) : d);
  return {
    bgm: vol(r.bgm, DEFAULT_SETTINGS.bgm),
    sfx: vol(r.sfx, DEFAULT_SETTINGS.sfx),
    voice: vol(r.voice, DEFAULT_SETTINGS.voice),
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SETTINGS.muted,
    damageNumbers: typeof r.damageNumbers === 'boolean' ? r.damageNumbers : DEFAULT_SETTINGS.damageNumbers,
    quality: QUALITIES.includes(r.quality) ? r.quality : DEFAULT_SETTINGS.quality,
    preload: typeof r.preload === 'boolean' ? r.preload : DEFAULT_SETTINGS.preload,
    preloadOptional: typeof r.preloadOptional === 'boolean' ? r.preloadOptional : DEFAULT_SETTINGS.preloadOptional,
    // 配音语言: any value the client does not know (a profile from a newer release, a hand-edited one) plays CN
    voiceLang: VOICE_LANGS.includes(r.voiceLang) ? r.voiceLang : DEFAULT_SETTINGS.voiceLang,
    keys: sanitizeHotkeys(r.keys),
  };
}
