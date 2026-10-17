/**
 * One root-relative asset URL on the assets CDN — the same rule `rewriteAssetPaths` applies to a whole manifest, for a
 * URL built in code instead of read from one (shared/constants.js CUSTOM_EMOTE_ART ships with the server and no manifest
 * lists it, so nothing rewrites it on our behalf). Absolute URLs and other paths are unchanged, as is everything when no
 * CDN is configured.
 */
export function assetUrl(url, base) {
  return base && typeof url === 'string' && url.startsWith('/assets/') ? base + url : url;
}

/** Rewrite only root-relative asset URLs. Absolute URLs stay intact, including manifests already rewritten by a server. */
export function rewriteAssetPaths(value, base) {
  if (!base || value === null || typeof value !== 'object') return value;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') { const next = assetUrl(entry, base); if (next !== entry) value[key] = next; }
    else if (entry !== null && typeof entry === 'object') rewriteAssetPaths(entry, base);
  }
  return value;
}

/** Route every same-origin data JSON, including local art manifests and generated preload indexes, to the data CDN. */
export function dataUrl(url, base) {
  if (!base || typeof url !== 'string') return url;
  const match = url.match(/^\/data\/((?:[^/?#]+\/)*[^/?#]+\.json)(?:[?#]|$)/);
  if (!match) return url;
  try {
    if (match[1].split('/').some((part) => {
      const decoded = decodeURIComponent(part);
      return decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\');
    })) return url;
  } catch { return url; }
  return base.replace(/\/+$/, '') + url;
}

/** UI/installed-pack text uses the assets CDN; data language JSON uses the data CDN. */
export function i18nUrl(url, assetsBase, dataBase = assetsBase) {
  if (typeof url !== 'string') return url;
  const isDataText = url.startsWith('/data/i18n/') || /^\/packs\/[^/?#]+\/texts\//.test(url);
  const base = isDataText ? dataBase : assetsBase;
  if (!base) return url;
  if (!/^\/(?:i18n\/[^/?#]+|data\/i18n\/[^/?#]+|packs\/[^/?#]+\/[^?#]+)\.json(?:[?#]|$)/.test(url)) return url;
  return base.replace(/\/+$/, '') + url;
}
