import { unhashedUrl } from './assetPaths.js';

/**
 * Rewrite only root-relative asset URLs. Absolute URLs stay intact, including manifests already rewritten by a server.
 *
 * The content-hash segment comes off on the way out: a CDN mirrors the `public/assets/` layout as it is on disk
 * (docs/ASSETS.md「CDN」), so `/~<hash>/` is not a path it can answer. The hash is what the game server uses to give a
 * same-origin URL a year of caching (server/http/assetViews.js), and it stays in the manifests this server serves to
 * itself. Without a base nothing changes, so the same-origin form keeps its hash.
 */
export function rewriteAssetPaths(value, base) {
  if (!base || value === null || typeof value !== 'object') return value;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.startsWith('/assets/')) value[key] = base + unhashedUrl(entry);
    else if (entry !== null && typeof entry === 'object') rewriteAssetPaths(entry, base);
  }
  return value;
}

/** Route static game JSON directly to the data CDN; local art and generated preload manifests stay on the game origin. */
export function dataUrl(url, base) {
  if (!base || typeof url !== 'string') return url;
  const match = url.match(/^\/data\/([^/?#]+\.json)(?:[?#]|$)/);
  if (!match || ['local-assets.json', 'resource-manifest.json'].includes(match[1].toLowerCase())) return url;
  return base.replace(/\/+$/, '') + url;
}

/** Language JSON uses the assets CDN; the dynamic pack index and explicit external URLs stay unchanged. */
export function i18nUrl(url, base) {
  if (!base || typeof url !== 'string') return url;
  if (!/^\/(?:i18n\/[^/?#]+|data\/i18n\/[^/?#]+|packs\/[^/?#]+\/[^?#]+)\.json(?:[?#]|$)/.test(url)) return url;
  return base.replace(/\/+$/, '') + url;
}
