// 液态玻璃界面主题 (uiTheme) — the static counterpart of test/ui/glass-theme.e2e.test.js (which needs SP_E2E=1 + Chrome
// and writes test/e2e/out/theme-*.png). Guards the wiring the browser test exercises: the closed set of skins and its
// default, applyUiTheme putting the skin on <html data-ui-theme>, the lobby button beside 添加到桌面, and the two
// promises css/glass.css makes — every glass rule is scoped to the attribute (the default look stays the stylesheet's
// own), a skin only paints, and the top black mask of the hub backdrop stays gone.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, UI_THEMES, sanitizeSettings } from '../../public/js/ui/gameLogic.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');

/** Rules as { selector, body } (flat; @media blocks are walked into, as test/client-static.test.js does). */
function cssRules(src) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src))) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

const GLASS = strip(read('public/css/glass.css'));
const RULES = cssRules(GLASS);
const SCOPE = 'html[data-ui-theme="glass"]';

describe('界面主题 (uiTheme)', () => {
  test('a closed set of skins, defaulting to this branch\'s own interface', () => {
    assert.deepEqual([...UI_THEMES], ['default', 'glass']);
    assert.equal(DEFAULT_SETTINGS.uiTheme, 'default');
    assert.equal(sanitizeSettings({ uiTheme: 'glass' }).uiTheme, 'glass');
    // an old profile, a hand-edited value or one a future version dropped falls back to the design's own look
    assert.equal(sanitizeSettings({ uiTheme: 'liquid' }).uiTheme, 'default');
    assert.equal(sanitizeSettings(null).uiTheme, 'default');
    assert.deepEqual(sanitizeSettings(null), { ...DEFAULT_SETTINGS });
  });

  test('applyUiTheme writes <html data-ui-theme>, at boot and on every settings change', () => {
    const src = read('public/js/ui/settings.js');
    assert.match(src, /export function applyUiTheme\(v\)/);
    assert.match(src, /dataset\.uiTheme = UI_THEMES\.includes\(v\) \? v : 'default'/, 'values outside UI_THEMES fall back');
    assert.match(src, /applyUiTheme\(s\.uiTheme\)/, 'the settings store applies it on every change');
    assert.match(src, /applyUiTheme\(settingsStore\.get\(\)\.uiTheme\)/, 'and before the first render');
    assert.match(src, /import \{[^}]*UI_THEMES[^}]*\} from '\.\/gameLogic\.js'/);
    // the attribute, not an inline style: without JavaScript the page is this branch's own design
    assert.doesNotMatch(src, /applyUiTheme[\s\S]{0,200}style\.setProperty/);
  });

  test('the lobby top bar renders the theme button third in the tool row', () => {
    const src = read('public/js/screens/lobby.js');
    const open = src.indexOf('<div class="topbar__tools">');
    const tools = src.slice(open, src.indexOf('</div>', open));
    const order = [...tools.matchAll(/<\$\{(\w+)/g)].map((m) => m[1]);
    assert.deepEqual(order.slice(0, 3), ['SettingsButton', 'GuideButton', 'UiThemeButton'], 'the user wants it in the third slot');
    assert.match(tools, /<\$\{UiThemeButton\} class="lobby-theme" \/>/);
    assert.match(tools, /<\$\{PwaInstallButton\} class="lobby-pwa" square=\$\{true\} \/>/, 'the 添加到桌面 button is still in the row');
    assert.match(src, /import \{ UiThemeButton \} from '\.\.\/ui\/theme\.js'/);
  });

  test('the button is icon-only square, named for screen readers, and toggles through the settings store', () => {
    const src = read('public/js/ui/theme.js');
    assert.match(src, /export const GLASS_THEME = 'glass'/);
    assert.match(src, /export function UiThemeButton\(/);
    assert.match(src, /square=\$\{true\}/);
    assert.match(src, /icon="droplet"/);
    assert.match(src, /title=\$\{label\} aria-label=\$\{label\}/);
    assert.match(src, /data-testid="ui-theme"/);
    assert.match(src, /active=\$\{glass\}/, 'aria-pressed marks the skin as on');
    assert.match(src, /updateSettings\(\{ uiTheme: theme === GLASS_THEME \? GLASS_THEME : DEFAULT_THEME \}\)/);
    // the glyph is a real ICONS entry (components.js), not a name that would render nothing
    assert.match(read('public/js/ui/components.js'), /^\s{2}droplet: \{ d: '/m);
  });

  test('glass.css is loaded last and every glass rule is scoped to the attribute', () => {
    const html = read('public/index.html');
    const sheets = [...html.matchAll(/<link rel="stylesheet" href="(\/css\/[^"]+)"/g)].map((m) => m[1]);
    assert.equal(sheets.at(-1), '/css/glass.css', 'glass.css must override devices.css and utility-mobile.css');
    for (const r of RULES) {
      if (!/backdrop-filter/.test(r.body)) continue;
      for (const sel of r.selector.split(',')) {
        assert.ok(sel.trim().startsWith(SCOPE), `unscoped glass rule '${sel.trim()}' would change the default look`);
      }
    }
    assert.match(GLASS, new RegExp(`${SCOPE.replace(/[[\]"]/g, '\\$&')} \\{`), 'the token block hangs off the attribute');
  });

  test('the skin only paints: no layout, no --t and no readable font-size move with it', () => {
    for (const r of RULES) {
      // the lens ring is a decorative overlay with its own box (::before, z-index: -1); the host must not move
      if (/::(before|after)/.test(r.selector)) continue;
      for (const d of r.body.split(';').map((x) => x.trim()).filter(Boolean)) {
        const prop = d.split(':')[0].trim();
        assert.ok(!['display', 'position', 'padding', 'margin', 'width', 'height', 'gap', 'inset', 'grid-template-columns'].includes(prop),
          `glass.css must not lay out (${r.selector} → ${prop})`);
        assert.notEqual(prop, 'font-size', `glass.css must not set a font-size (${r.selector})`);
        assert.notEqual(prop, '--t', 'only css/theme.css defines --t');
      }
    }
  });

  test('the hub keeps its identities in the glass skin', () => {
    assert.match(GLASS, /\.hub-tile \{ border-left: 3px solid var\(--mint-500\); \}/, 'the mint spine of the left column');
    assert.match(GLASS, /\.hub-recruit \{ border-top: 2px solid var\(--mint-500\); \}/, 'the mint crown of 缺人同盟');
    // 搜寻队友 (the CTA) is mint glass with light ink, and its grey subtitle turns pale green with the rest
    assert.match(GLASS, /\.hub-entry--bright \{[\s\S]*?background-color: rgba\(78, 216, 175, \.26\)/);
    assert.match(GLASS, /\.hub-entry--bright \{[\s\S]*?color: var\(--text-hi\)/, 'dark ink would smear on a translucent fill');
    // every grey label in the hub turns pale green: both grey text tokens are remapped for the whole screen
    // (--text-lo drives the ghost button labels 返回/公告, --text-dim the smaller captions), plus the few spots
    // that hard-code a colour (REPORT tag, the LOCAL line on a namecard, the RECRUITING pulse dot)
    assert.match(GLASS, /\.lobby-hub \{\n  --text-lo: var\(--glass-en\);\n  --text-dim: var\(--glass-en\);\n\}/, 'all hub grey text goes pale green');
    assert.match(GLASS, /\.hub-plate__tag \{ color: var\(--glass-en\)/);
    assert.match(GLASS, /\.acct-me\.has-nc \.acct-who small,[\s\S]*?\{ color: var\(--glass-en\); \}/);
    assert.match(GLASS, /\.hub-recruit__pulse \{ background: var\(--glass-en\); \}/);
    assert.match(GLASS, /\.hub-entry--bright \.hub-entry__en \{ color: var\(--glass-en\); \}/);
    assert.match(GLASS, /\.hub-plate \{[\s\S]*?--pl-ink: rgba\(226, 255, 246, \.42\)/, 'the plates keep their bracket marks');
    assert.match(GLASS, /\.hub-plate__label,[\s\S]*?\{ color: var\(--text-hi\); \}/, 'and their labels turn readable');
  });

  test('the top black mask of the hub backdrop stays gone (both skins)', () => {
    const vig = RULES.filter((r) => r.selector === '.hub-bg__vignette');
    assert.equal(vig.length, 1);
    assert.doesNotMatch(vig[0].body, /linear-gradient\(180deg, rgba\(0, 0, 0, \.42\)/, 'the 16 %-tall black band');
    assert.match(vig[0].body, /radial-gradient\(130% 95% at 50% 42%/, 'the corner vignette stays');
    const bar = RULES.filter((r) => r.selector === '.hub-topbar');
    assert.equal(bar.length, 1);
    assert.match(bar[0].body, /rgba\(4, 8, 8, \.5\)/, 'the top bar scrim is softened from .85');
    const glassBar = RULES.filter((r) => r.selector === `${SCOPE} .hub-topbar`);
    assert.equal(glassBar.length, 1);
    assert.match(glassBar[0].body, /rgba\(4, 8, 8, \.3\)/);
  });
});
