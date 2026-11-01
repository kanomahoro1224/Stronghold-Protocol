// 自定义大厅音乐 (PR #643 split 8): the player's own track in place of the lobby's music (audio.js setLobbyTrack:
// wherever the lobby's music plays — title, lobby, room, briefing, draft, 协议启动, result — through the same 背景音乐
// volume; it also takes the place of a cosmetic plugin's audio.bgm.lobby in this browser).
//
// v0.3.3 shipped a second, redundant copy of the whole backdrop feature here (its own scene picker, its own picture /
// video slot and its own renderer over the lobby). The lobby's backdrop is ui/hubAppearance.js + ui/hubBackdrop.js only
// (大厅背景 panel, 2026-11-01), so that half is gone: this module is the music alone.
//
// The file stays in this browser: IndexedDB 'sp-lobby-media', one record ('music'), never uploaded and never seen by a
// teammate. The database is opened at start only when the track is switched on, else when the dialog opens (a visitor
// who never opens it never creates it). Whether it is on is a pref (lobby.media). A file is checked when it is chosen —
// its type and size, then that this browser can actually decode it, and its length — and refused with a message
// otherwise: music longer than 6 minutes is refused (it is decoded whole into PCM). One that stops working later
// (storage cleared, a codec gone) falls back to the official track with a toast. The site CSP allows blob: media for
// that length check (server/http/csp.js); the music itself is decoded from its bytes (no media element). Texts go
// through t() (docs/I18N.md).
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, MicroLabel, Modal } from './components.js';
import { createStore, useStore, loadPref, savePref } from '../store.js';
import { audio } from '../audio.js';
import { toast } from './toasts.js';
import { BackdropSettings } from './hubBackdrop.js';
import { useHubBackdrop } from './hubAppearance.js';
import { t, tc } from '../../../shared/i18n.js';

const MB = 1024 * 1024;
/** Size limit of the player's own track (bytes). [ASSUMED] A remake feature the official event does not have. */
export const MUSIC_LIMIT = 20 * MB;
/**
 * The longest own music (seconds). [ASSUMED] It is decoded whole: 6 minutes of 48 kHz stereo are ~138 MB of PCM, about
 * twice the longest official track (m_bat_kazimierz2_2_loop, 190.9 s); a song is 3–5 minutes.
 */
export const MUSIC_MAX_S = 6 * 60;
/** [ASSUMED] How long a check may take: the music's metadata, its decode, opening the database, a write. */
const TIMEOUTS = Object.freeze({ length: 5000, music: 20000, open: 8000, write: 30000 });
const MUSIC_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|weba|webm)$/i;
const PREF = 'lobby.media';
const DB = 'sp-lobby-media';
const TABLE = 'files';

/** The saved switch, sanitised: own music on (off by default). */
export function loadMediaPrefs(raw = loadPref(PREF, null)) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return { music: o.music === true };
}

/**
 * What a chosen file is for the music slot, or the reason it is refused (before anything is read): an audio file; a
 * type the browser names wins over the extension.
 * @param {{ name?: string, type?: string, size?: number } | null} file
 * @returns {{ ok: true, kind: 'music' } | { ok: false, reason: string }}
 */
export function classifyMusic(file) {
  if (!file || !(file.size > 0)) return { ok: false, reason: t('文件是空的') };
  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || '');
  const kind = type.startsWith('audio/') || ((!type || type === 'video/webm' || type === 'application/ogg') && MUSIC_EXT.test(name)) ? 'music' : null;
  if (!kind) return { ok: false, reason: t('请选择 MP3、M4A、OGG、WAV 等音频文件') };
  if (file.size > MUSIC_LIMIT) return { ok: false, reason: t('文件不能超过 {n} MB', { n: MUSIC_LIMIT / MB }) };
  return { ok: true, kind };
}

/** A promise that rejects with `msg` (an Error marked `timeout`) after `ms`. */
function withTimeout(p, ms, msg) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(msg), { timeout: true })), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

// ---- storage (IndexedDB; a browser without it keeps the official music) -------------------------------------------------

let dbOpen = null;
function db() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('no IndexedDB'));
  if (dbOpen) return dbOpen;
  let late = false;
  const open = withTimeout(new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(TABLE);
    req.onsuccess = () => {
      const d = req.result;
      if (late) { d.close(); return; } // it answered after the timeout: the next try opens it again
      d.onversionchange = () => { d.close(); dbOpen = null; };
      resolve(d);
    };
    req.onerror = () => reject(req.error || new Error('IndexedDB'));
  }), TIMEOUTS.open, 'IndexedDB open timed out');
  dbOpen = open.catch((err) => { late = true; dbOpen = null; throw err; });
  return dbOpen;
}
async function idb(mode, fn) {
  const d = await db();
  return withTimeout(new Promise((resolve, reject) => {
    const tx = d.transaction(TABLE, mode);
    const req = fn(tx.objectStore(TABLE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error || req?.error || new Error('IndexedDB'));
  }), TIMEOUTS.write, 'IndexedDB timed out');
}
const readRecord = () => idb('readonly', (s) => s.get('music'));
const writeRecord = (rec) => idb('readwrite', (s) => (rec ? s.put(rec, 'music') : s.delete('music')));
/** The message of a save that failed: 浏览器存储空间不足 only when the browser says the quota is full. */
export function storageError(err) {
  const name = String(err?.name || '');
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
    ? t('浏览器存储空间不足，未能保存') : t('浏览器存储不可用，未能保存');
}

// ---- state ------------------------------------------------------------------------------------------------------------

/** { prefs: { music }, music: { name, size, id } | null, busy: null | 'music' } */
export const mediaStore = createStore({ prefs: loadMediaPrefs(), music: null, busy: null });
let musicBlob = null;
/** Bumped when the file is chosen or deleted: a read of the saved file that started before it is stale. */
let revision = 0;
const savePrefs = (patch) => {
  const prefs = { ...mediaStore.get().prefs, ...patch };
  savePref(PREF, prefs);
  mediaStore.set({ prefs });
};
/** The own track to the audio manager (or none); `decoded`: the file's check already decoded it (no second decode). */
const syncMusic = (decoded = null) => {
  const { prefs, music } = mediaStore.get();
  audio.setLobbyTrack(prefs.music && music && musicBlob ? { id: music.id, read: () => musicBlob.arrayBuffer(), decoded } : null);
};
function keepMusic(rec, decoded = null) {
  musicBlob = rec ? rec.blob : null;
  mediaStore.set({ music: rec ? { name: rec.name, size: rec.blob.size, id: String(rec.savedAt) } : null });
  syncMusic(decoded);
}

let loading = null;
/** Read the saved file (once; again after a failure): at start when it is on, else when the dialog opens. */
export function loadSavedMedia() {
  if (loading) return loading;
  const rev = revision;
  loading = (async () => {
    try {
      const music = await readRecord();
      if (rev === revision && music?.blob instanceof Blob) keepMusic(music);
    } catch { loading = null; /* no storage: the official music */ }
  })();
  return loading;
}

let installed = false;
/** Main.js, at start: the saved file when it is on (the music applies from the title screen on). */
export function installLobbyMedia() {
  if (installed) return Promise.resolve();
  installed = true;
  audio.onLobbyTrackFailed = () => {
    savePrefs({ music: false });
    toast(t('自定义大厅音乐无法播放，已换回默认音乐'), 'warn');
  };
  return mediaStore.get().prefs.music ? loadSavedMedia() : Promise.resolve();
}

// ---- checks that need the browser ------------------------------------------------------------------------------------

/** The music's length from its metadata (an <audio> element, nothing decoded), or null when this browser cannot tell soon. */
function musicLength(file) {
  if (!globalThis.document) return Promise.resolve(null);
  const url = URL.createObjectURL(file);
  const el = document.createElement('audio');
  return withTimeout(new Promise((resolve) => {
    el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    el.onerror = () => resolve(null);
    el.muted = true; el.preload = 'metadata';
    el.src = url;
  }), TIMEOUTS.length, '').catch(() => null).finally(() => {
    el.onloadedmetadata = el.onerror = null;
    el.removeAttribute('src');
    el.load();
    URL.revokeObjectURL(url);
  });
}

/**
 * That the music decodes and is at most MUSIC_MAX_S long. A file whose metadata says it is clearly longer (by more than
 * 30 s) is refused before anything is decoded; otherwise it is decoded once and its decoded length decides — in the
 * audio manager's context, whose buffer then becomes the track (no second decode), or offline before any gesture.
 * A check that takes too long and a file that does not decode are told apart.
 * @returns {Promise<AudioBuffer|null>} the decoded track when the audio manager's context decoded it
 */
async function probeMusic(file) {
  const tooLong = () => new Error(t('音乐不能超过 {n} 分钟', { n: MUSIC_MAX_S / 60 }));
  const len = await musicLength(file);
  if (len != null && len > MUSIC_MAX_S + 30) throw tooLong();
  const live = audio.ctx;
  const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!live && !Ctx) return null;
  const decode = async () => {
    const ab = await file.arrayBuffer().catch(() => { throw new Error(t('未能读取这个文件')); });
    if (live) return audio.decodeBytes(ab);
    const ctx = new Ctx(1, 1, 44100);
    return new Promise((resolve) => {
      try {
        const r = ctx.decodeAudioData(ab, resolve, () => resolve(null));
        if (r && typeof r.then === 'function') r.then(resolve, () => resolve(null));
      } catch { resolve(null); }
    });
  };
  const buf = await withTimeout(decode(), TIMEOUTS.music, t('读取文件超时，请换一个文件'));
  if (!buf || !(buf.duration > 0)) throw new Error(t('这台浏览器无法播放这段音乐，请换成 MP3 或 M4A'));
  if (buf.duration > MUSIC_MAX_S + 1) throw tooLong();
  return live ? buf : null;
}

/**
 * Take the player's music file: checked, saved in this browser, switched on.
 * @param {File} file
 * @returns {Promise<boolean>} whether it was taken (a refusal shows its reason)
 */
export async function chooseMusic(file) {
  if (mediaStore.get().busy) return false;
  const c = classifyMusic(file);
  if (!c.ok) { toast(c.reason, 'warn'); return false; }
  mediaStore.set({ busy: 'music' });
  try {
    const decoded = await probeMusic(file);
    const rec = { blob: file, name: String(file.name || '').slice(0, 120), kind: 'music', savedAt: Date.now() };
    try { await writeRecord(rec); } catch (err) { throw new Error(storageError(err), { cause: err }); }
    revision++;
    savePrefs({ music: true });
    keepMusic(rec, decoded);
    return true;
  } catch (err) {
    toast(err?.message || t('未能读取这个文件'), 'warn');
    return false;
  } finally { mediaStore.set({ busy: null }); }
}

/** Delete the player's track (back to the official one). */
export async function removeMusic() {
  try { await writeRecord(null); } catch { /* the record goes with the storage anyway */ }
  revision++;
  keepMusic(null);
  savePrefs({ music: false });
}

/** Switch the player's track on or off (kept either way). */
export function setMusicOn(on) {
  savePrefs({ music: !!on });
  syncMusic();
}

// ---- views ------------------------------------------------------------------------------------------------------------

const sizeText = (n) => `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;

/** 大厅音乐: the chosen file, its switch and its buttons. */
function MusicRow({ file, on, busy }) {
  const input = useRef(null);
  return html`<section class="lmedia__part" data-slot="music">
    <header class="lmedia__head"><b>${t('大厅音乐')}</b><${MicroLabel}>MUSIC<//></header>
    <div class="lmedia__now">
      <${Icon} name="music" />
      <span class="lmedia__name" data-testid="media-music-name">${file && on ? file.name : t('默认音乐')}</span>
      ${file ? html`<span class="lmedia__size num">${sizeText(file.size)}</span>` : null}
    </div>
    <div class="lmedia__btns">
      <input ref=${input} type="file" hidden accept="audio/*,.mp3,.m4a,.aac,.ogg,.opus,.wav,.flac,.webm" data-testid="media-music-file"
        onChange=${(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) chooseMusic(f); }} />
      <${Button} size="sm" icon="plus" loading=${busy === 'music'} onClick=${() => input.current?.click()}>${t('选择音乐文件')}<//>
      ${file ? html`<button type="button" class=${`set-toggle${on ? ' is-on' : ''}`} role="switch" aria-checked=${on ? 'true' : 'false'}
          data-testid="media-music-on" onClick=${() => setMusicOn(!on)}><i></i><span>${on ? tc('toggle', '开启') : tc('toggle', '关闭')}</span></button>` : null}
      ${file ? html`<${Button} size="sm" variant="ghost" icon="close" data-testid="media-music-remove" onClick=${() => removeMusic()}>${t('删除')}<//>` : null}
    </div>
  </section>`;
}

/** The 大厅背景与音乐 dialog: the lobby's backdrop (ui/hubBackdrop.js 大厅背景 panel) and the player's own music. */
export function LobbyMediaDialog({ onClose }) {
  const s = useStore((x) => x, undefined, mediaStore);
  const bg = useHubBackdrop();
  useEffect(() => { loadSavedMedia(); }, []);
  return html`<${Modal} open=${true} class="lmedia hub-backdrop-panel" micro="LOBBY BACKDROP & MUSIC" title=${t('大厅背景与音乐')} width="min(8.6rem, 96vw)"
      onClose=${onClose} actions=${html`<${Button} variant="ghost" onClick=${onClose} data-autofocus="">${t('完成')}<//>`}>
    <${BackdropSettings} bg=${bg} />
    <${MusicRow} file=${s.music} on=${s.prefs.music} busy=${s.busy} />
    <p class="lmedia__note"><${Icon} name="info" />${t('文件只保存在这台浏览器里，不会上传，队友也看不到。音乐不超过 20 MB、6 分钟，替换标题、大厅、房间、开局前和结算时的音乐（外观插件的大厅音乐也被替换），音量跟随「背景音乐」。')}</p>
  <//>`;
}

/**
 * The lobby's entry: a square button that opens the dialog. It is a plain Button with a `title` (like its neighbours
 * 设置 / 玩法说明 / 界面主题): a Tooltip wraps the anchor in a `.tt-anchor` span, which the top bar's glass rules
 * (css/glass.css `.topbar__tools > .btn`) do not match, so the button stayed bare (2026-11-01).
 */
export function LobbyMediaButton({ class: cls = '' }) {
  const [open, setOpen] = useState(false);
  return html`<${Button} variant="secondary" size="sm" square=${true} icon="image" class=${`lobby-media ${cls}`.trim()} data-testid="lobby-media"
      title=${t('大厅背景与音乐')} aria-label=${t('大厅背景与音乐')} onClick=${() => setOpen(true)} />
    ${open ? html`<${LobbyMediaDialog} onClose=${() => setOpen(false)} />` : null}`;
}
