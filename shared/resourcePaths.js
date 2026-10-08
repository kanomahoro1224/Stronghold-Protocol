// Static board descriptions are asset metadata, separate from game data, language packs and executable code. Both the
// server manifest builder and the browser preload (public/js/resources/*) use these rules, so one URL has one identity
// everywhere: manifest entry, cache key, Service Worker lookup and ZIP record.
export function isBoardResourceJson(url) {
  let pathname;
  try { pathname = new URL(String(url), 'https://resources.invalid').pathname; } catch { return false; }
  if (pathname.startsWith('/build/')) return false;
  return /\/assets\/local\/map\/(?:fx\/(?:materials|prefab)|autochess\/(?:materials|tiles))\.json$/.test(pathname);
}

/** Match the renderer's encodeURI paths without changing CDN hosts or double-encoding existing escapes. */
export function canonicalResourceUrl(url) {
  const value = String(url);
  if (!value.startsWith('/') && !/^https?:\/\//i.test(value)) return value.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
  try {
    const parsed = new URL(value, 'https://resources.invalid');
    parsed.pathname = parsed.pathname.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
    return value.startsWith('/') && !value.startsWith('//') ? parsed.pathname + parsed.search + parsed.hash : parsed.href;
  } catch { return value; }
}
