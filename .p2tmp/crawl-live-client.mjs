// .p2tmp/crawl-live-client.mjs — crawl the LIVE client from index.html through every import/url() it pulls in and
// search the actual deployed bytes for an absolute R2 host or a prefix-less asset base. Read-only: GETs only.
const ORIGIN = 'https://game.xiaolubao.com';
const seen = new Map();          // url -> body
const queue = [`${ORIGIN}/`];
const refs = [];                 // { from, spec }

const resolve = (spec, base) => {
  try { return new URL(spec, base).href; } catch { return null; }
};

while (queue.length && seen.size < 200) {
  const url = queue.shift();
  if (seen.has(url)) continue;
  let res;
  try { res = await fetch(url, { redirect: 'follow' }); } catch (e) { seen.set(url, `FETCH FAILED: ${e.message}`); continue; }
  const ct = res.headers.get('content-type') ?? '';
  const body = ct.includes('image') || ct.includes('font') ? '' : await res.text();
  seen.set(url, body);
  if (!body) continue;
  const patterns = [
    /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:src|href)\s*=\s*['"]([^'"]+)['"]/g,
    /url\(\s*['"]?([^'")]+)['"]?\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of body.matchAll(re)) {
      const spec = m[1];
      if (/^(data:|https?:)?\/\//.test(spec) && !spec.includes('xiaolubao')) continue;
      const abs = resolve(spec, url);
      if (!abs || !abs.startsWith('http')) continue;
      if (seen.has(abs) || queue.includes(abs)) continue;
      refs.push({ from: url, spec });
      queue.push(abs);
    }
  }
}

console.log(`fetched ${seen.size} urls`);
const hits = [];
for (const [url, body] of seen) {
  if (!body) continue;
  for (const needle of ['local.xiaolubao.com', 'assets/local/ui/battle']) {
    const i = body.indexOf(needle);
    if (i >= 0) hits.push({ url, needle, ctx: body.slice(Math.max(0, i - 90), i + 90).replace(/\s+/g, ' ') });
  }
}
console.log(`hits: ${hits.length}`);
for (const h of hits.slice(0, 20)) console.log(`  [${h.needle}] ${h.url}\n     …${h.ctx}…`);
console.log('--- files fetched ---');
for (const u of [...seen.keys()].sort()) console.log('  ' + u.replace(ORIGIN, ''));
