// Image/background controls adapted from Stardust-minus/Stronghold-Protocol d6e96f4 (ui/hubBackdrop.js).
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { createStore, useStore, loadPref, savePref } from '../store.js';
import { createLocalMedia, mediaStorage } from './localMedia.js';
import { t, N_ } from '../../../shared/i18n.js';
import { ASSETS_CDN } from '../asset-cdn.js';

export const HUB_THEMES = Object.freeze([
  { id: 'night', name: N_('夜巡'), en: 'NIGHT WATCH' },
  { id: 'frost', name: N_('霜原'), en: 'FROSTLINE' },
  { id: 'ember', name: N_('烬野'), en: 'EMBERFIELD' },
  { id: 'calm', name: N_('静默'), en: 'SILENT' },
]);

/** Ten built-in photo backgrounds (用户 2026-10-16, 鹿乃1…鹿乃10). The images live in public/assets/local/hub/ and are
 *  uploaded to R2, so they are fetched from the assets CDN instead of shipping in the client bundle; `ASSETS_CDN` is empty
 *  for a same-origin deployment, in which case the URL stays root-relative. */
export const HUB_PHOTOS = Object.freeze([
  { id: 'kano1', name: N_('鹿乃1') },
  { id: 'kano2', name: N_('鹿乃2') },
  { id: 'kano3', name: N_('鹿乃3') },
  { id: 'kano4', name: N_('鹿乃4') },
  { id: 'kano5', name: N_('鹿乃5') },
  { id: 'kano6', name: N_('鹿乃6') },
  { id: 'kano7', name: N_('鹿乃7') },
  { id: 'kano8', name: N_('鹿乃8') },
  { id: 'kano9', name: N_('鹿乃9') },
  { id: 'kano10', name: N_('鹿乃10') },
]);
const PHOTO_IDS = new Set(HUB_PHOTOS.map((x) => x.id));
export const isHubPhoto = (theme) => PHOTO_IDS.has(theme);
export const hubPhotoUrl = (id) => `${ASSETS_CDN.replace(/\/+$/, '')}/assets/local/hub/${id}.jpg`;
/** Swatch preview: a 320px thumbnail, so opening the panel does not download the full 2560px frames. */
export const hubPhotoThumbUrl = (id) => `${ASSETS_CDN.replace(/\/+$/, '')}/assets/local/hub/thumb/${id}.jpg`;

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
/** Video background caps: 200MB (用户 2026-10-16) and 1080p at most. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_VIDEO_EDGE = 1920;
const MAX_EDGE = 2560;
const PREF_KEY = 'hub.backdrop';
export function sanitizeBackdrop(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const num = (n, fallback, max) => Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : fallback;
  return {
    theme: r.theme === 'custom' || HUB_THEMES.some((x) => x.id === r.theme) || PHOTO_IDS.has(r.theme) ? r.theme : 'night',
    dim: num(r.dim, 45, 85), blur: num(r.blur, 0, 16), overlay: r.overlay !== false, motion: r.motion !== false,
    // a local video backdrop: sound off and playing by default, old profiles and images simply get the defaults
    videoSound: r.videoSound === true, videoPaused: r.videoPaused === true,
  };
}

export function validateImage(file) {
  if (!file || file.size <= 0 || !/^image\//.test(file.type)) throw new Error(t('请选择有效的图片文件'));
  if (file.size > MAX_IMAGE_BYTES) throw new Error(t('图片太大（上限 30MB）'));
}

/** Re-encode on the device, keeping transparent images readable against the hub's ground colour. */
export async function prepareBackdrop(file) {
  validateImage(file);
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      const timer = setTimeout(() => { img.src = ''; reject(new Error(t('图片读取超时，请换一个文件试试'))); }, 15000);
      img.onload = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); reject(new Error(t('背景读取失败，换一个文件试试'))); };
      img.src = url;
    });
    const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(t('浏览器无法处理该图片'));
    ctx.fillStyle = '#0b1110'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    if (!blob) throw new Error(t('图片转换失败'));
    return { blob };
  } finally { URL.revokeObjectURL(url); }
}

export function validateVideo(file) {
  if (!file || file.size <= 0) throw new Error(t('请选择有效的视频文件'));
  if (file.size > MAX_VIDEO_BYTES) throw new Error(t('视频太大（上限 200MB）'));
  if (file.type && !file.type.startsWith('video/') && !/\.(mp4|webm|m4v)$/i.test(file.name || '')) {
    throw new Error(t('请选择 MP4 或 WebM 视频'));
  }
}

/** Video backgrounds are stored as-is (no re-encode): only metadata is probed, capping size, duration and resolution. */
export async function prepareVideo(file) {
  validateVideo(file);
  const blob = new Blob([file], { type: file.type || (/\.webm$/i.test(file.name || '') ? 'video/webm' : 'video/mp4') });
  const url = URL.createObjectURL(blob), probe = document.createElement('video');
  probe.preload = 'metadata';
  probe.muted = true;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { probe.removeAttribute('src'); reject(new Error(t('视频读取超时，请换一个文件试试'))); }, 15000);
      probe.onloadedmetadata = () => {
        clearTimeout(timer);
        if (!Number.isFinite(probe.duration) || probe.duration <= 0 || !probe.videoWidth || !probe.videoHeight) {
          reject(new Error(t('视频无效或时长不可读')));
        } else if (probe.videoWidth * probe.videoHeight > 1920 * 1080 || Math.max(probe.videoWidth, probe.videoHeight) > MAX_VIDEO_EDGE) {
          reject(new Error(t('请使用最高 1080p 的视频')));
        } else resolve();
      };
      probe.onerror = () => { clearTimeout(timer); reject(new Error(t('浏览器无法播放该视频，请尝试 MP4 或 WebM'))); };
      probe.src = url;
    });
    return { blob };
  } finally {
    probe.onloadedmetadata = probe.onerror = null;
    probe.removeAttribute('src'); probe.load(); URL.revokeObjectURL(url);
  }
}

const images = createLocalMedia({ storage: mediaStorage('sp-hub-backdrop', 'kv', 'image'),
  valid: (r) => {
    if (!(r?.blob instanceof Blob) || r.blob.size <= 0) return false;
    if (r.blob.type.startsWith('video/')) return r.blob.size <= MAX_VIDEO_BYTES;
    return /^image\//.test(r.blob.type) && r.blob.size <= MAX_IMAGE_BYTES;
  } });
const preferences = createStore(sanitizeBackdrop(loadPref(PREF_KEY, null)));
preferences.subscribe((pref) => savePref(PREF_KEY, pref));

export function useHubBackdrop() {
  const pref = useStore((s) => s, Object.is, preferences);
  const [image, setImage] = useState(images.get);
  useEffect(() => {
    const off = images.subscribe(setImage);
    setImage(images.get()); images.load();
    return off;
  }, []);
  // A file import can finish after navigating away; its choice must still be available on the next visit.
  const update = (patch) => preferences.set(sanitizeBackdrop({ ...preferences.get(), ...patch }));
  return { pref, update, imageUrl: image.url, ready: image.ready, busy: image.busy,
    // 'video' when the stored local backdrop is a video blob, which is what the renderer and the panel branch on
    mediaKind: image.record?.blob && String(image.record.blob.type).startsWith('video/') ? 'video' : 'image',
    async setImage(file) {
      const isVideo = file?.type?.startsWith('video/') || /\.(mp4|webm|m4v)$/i.test(file?.name || '');
      if (!isVideo && !/^image\//.test(file?.type || '')) throw new Error(t('请选择图片、MP4 或 WebM 视频'));
      if (await images.change(() => (isVideo ? prepareVideo(file) : prepareBackdrop(file)))) {
        update({ theme: 'custom', videoPaused: false, videoSound: false });
      }
    },
    async clearImage() { if (await images.change(() => null)) update({ theme: 'night', dim: 45, blur: 0, videoPaused: false, videoSound: false }); },
  };
}

export function backdropScene(bg) {
  const theme = bg.pref.theme;
  if (PHOTO_IDS.has(theme)) return 'photo';
  return theme !== 'custom' ? theme : bg.imageUrl ? 'photo' : bg.ready ? 'night' : 'blank';
}
/** The image behind a photo scene: the CDN copy for a built-in 鹿乃 background, the local blob for a custom import. */
export function backdropImage(bg) {
  const theme = bg.pref.theme;
  if (PHOTO_IDS.has(theme)) return hubPhotoUrl(theme);
  return theme === 'custom' ? bg.imageUrl || '' : '';
}
export function backdropTheme(bg) {
  const scene = backdropScene(bg);
  return scene === 'photo' ? 'custom' : scene === 'blank' ? 'night' : scene;
}
