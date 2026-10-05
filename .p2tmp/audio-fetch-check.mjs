// Reproduce the game's audio path exactly: same-origin fetch('/media/...') -> 302 -> R2, then decode.
// If the cached edge copy lacked access-control-allow-origin this throws a CORS error, exactly like
// the game would fail to load sound.
import puppeteer from 'puppeteer-core';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.SP_BASE || 'https://game.xiaolubao.com';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const netErrors = [];
page.on('requestfailed', (r) => netErrors.push(r.url().slice(0, 90) + ' :: ' + (r.failure()?.errorText ?? '?')));
page.on('pageerror', (e) => netErrors.push('pageerror: ' + e.message.slice(0, 160)));
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.online-pill', { timeout: 20000 });

const medias = ['/media/bgm/m_bat_abyssalhunters_loop', '/media/bgm/m_bat_act1autochess_loop'];
for (const m of medias) {
  const out = await page.evaluate(async (url) => {
    try {
      const res = await fetch(url);                      // identical to public/js/audio.js
      const buf = await res.arrayBuffer();
      const ac = new AudioContext();
      const decoded = await ac.decodeAudioData(buf.slice(0));
      await ac.close();
      return { ok: true, status: res.status, acao: res.headers.get('access-control-allow-origin'), bytes: buf.byteLength, seconds: +decoded.duration.toFixed(2), rate: decoded.sampleRate, ch: decoded.numberOfChannels };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 200) };
    }
  }, m);
  console.log(m, JSON.stringify(out));
}

// also confirm the spine/board data path still works after the rule edit
const json = await page.evaluate(async () => {
  try {
    const r = await fetch('/assets/local/map/autochess/tiles.json');
    return { ok: true, status: r.status, acao: r.headers.get('access-control-allow-origin'), bytes: (await r.arrayBuffer()).byteLength };
  } catch (e) { return { ok: false, error: String(e).slice(0, 200) }; }
});
console.log('/assets/local/map/autochess/tiles.json', JSON.stringify(json));
console.log('net errors:', JSON.stringify(netErrors.slice(0, 5)));
await browser.close();
