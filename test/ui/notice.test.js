// test/ui/notice.test.js — 公告 (announcement, public/js/ui/notice.js): the 「公告」 entry the title screen puts next
// to 「玩法说明」 (public/js/screens/title.js .title-conn__actions) and the panel it opens (the shared components.js
// Modal, so Esc / the backdrop / its own button close it exactly like the settings and exit dialogs).
//
// Contract under test:
//   * the button is GuideButton's twin (ghost/sm, `notice-btn`, own title/aria) and sits IMMEDIATELY beside it;
//   * clicking it opens the panel; closing closes it again;
//   * /data/notice.json is read at runtime, root-relative and with `cache: 'no-cache'` (the data-only update path: a
//     republished file reaches players with no client rebuild), and every open re-reads it;
//   * 404 / network error / invalid JSON / a payload that is not an object renders the built-in NOTICE_FALLBACK and
//     never throws — a malformed notice must never break the title screen;
//   * the rendered text is capped (lines / line length / total characters) so a 100 KB body cannot blow up the layout;
//   * a sectioned payload (`sections: [{label, lines}]`) renders label row first, then its lines, in order; the older
//     flat `body` array still renders (as one unlabelled section) and the built-in fallback still renders;
//   * an inline link is STRUCTURED data ({ segments: [{ t, href }] }) — no markup is parsed, no HTML string is built —
//     and only a whitelisted href (https: on space.bilibili.com / ai.xiaolubao.com / wpa.qq.com / github.com, or
//     mailto:) ever becomes an <a>; javascript: / data: / http: / //host / off-site hrefs render as plain text;
//   * the panel's confirm button says 关闭 and its title comes from the data.
// No browser and no network: the client takes an injected fetch (like ui/buildGuard.js), and the button test stubs
// globalThis.fetch for the singleton the real UI uses.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOTICE_URL, NOTICE_FALLBACK, NOTICE_MAX_LINES, NOTICE_MAX_LINE, NOTICE_MAX_CHARS, NOTICE_LINK_HOSTS,
  NOTICE_MAX_LABEL, NOTICE_MAX_SECTIONS,
  normalizeNotice, fallbackNotice, createNoticeClient, noticeStore, openNotice, closeNotice, NoticeButton, NoticeHost,
  safeNoticeHref, noticeLineText, noticeSegmentNode, noticeLineNode, noticeSectionNode,
} from '../../public/js/ui/notice.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const TITLE_SRC = read('public/js/screens/title.js');
const NOTICE_SRC = read('public/js/ui/notice.js');
/** The same source with comments stripped: what the module actually does, not what it says about itself. */
const NOTICE_CODE = NOTICE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const MAIN_SRC = read('public/js/main.js');
const COMPONENTS_SRC = read('public/js/ui/components.js');
const CSS = read('public/css/screens/title.css');

/** A fetch answering with `json` / `status`; collects the calls it saw. */
function fetchOf(json, { status = 200, ok = true, fail = null } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (fail) throw fail;
    return { ok, status, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}

describe('公告: the title-screen entry beside 玩法说明', () => {
  test('the button is placed immediately next to 玩法说明, inside the same row', () => {
    const start = TITLE_SRC.indexOf('<span class="title-conn__actions">');
    assert.ok(start >= 0, 'the title connection row exists');
    const row = TITLE_SRC.slice(start, TITLE_SRC.indexOf('</span>', start));
    assert.ok(row.includes('<${GuideButton} class="title-guide" />'), '玩法说明 is in the row');
    const lines = TITLE_SRC.split('\n');
    const at = lines.findIndex((l) => l.includes('<${GuideButton} class="title-guide" />'));
    assert.ok(lines[at + 1].includes('<${NoticeButton} class="title-notice" />'),
      '公告 is the very next entry after 玩法说明 — same row, no other control between them');
    assert.match(TITLE_SRC, /import \{ NoticeButton \} from '\.\.\/ui\/notice\.js';/);
  });

  test('the button mirrors GuideButton: same size / variant idiom, its own class, click opens the notice', () => {
    const v = NoticeButton({});
    assert.equal(v.props.size, 'sm', 'GuideButton default');
    assert.equal(v.props.variant, 'ghost', 'GuideButton default');
    assert.equal(v.props.icon, 'info');
    assert.equal(v.props.class, 'notice-btn');
    assert.equal(v.props.title, '公告');
    assert.equal(v.props['aria-label'], '公告');
    assert.equal(typeof v.props.onClick, 'function');
    assert.equal(v.props.onClick, openNotice, 'the click handler is the client\'s open()');
    // the same customisation surface GuideButton offers (a caller may pass its own class/label/square)
    assert.equal(NoticeButton({ class: 'title-notice' }).props.class, 'notice-btn title-notice');
    assert.equal(NoticeButton({ square: true }).props.class, 'notice-btn');
    // GuideButton's own markup, for comparison: the twin really is a twin
    const guide = read('public/js/ui/guide.js');
    assert.match(guide, /variant=\$\{variant\} size=\$\{size\} icon="book" square=\$\{square\} class=\$\{cx\('guide-btn', cls\)\}/);
    assert.match(CSS, /\.notice-btn \.btn__icon \{ color: var\(--mint-500\); \}/, 'same mint accent as .guide-btn');
    assert.match(read('public/css/screens/guide.css'), /\.guide-btn \.btn__icon \{ color: var\(--mint-500\); \}/);
  });
});

describe('公告: the panel', () => {
  test('it is the shared Modal — Esc / backdrop / its own 关闭 button close it — mounted once by main.js', () => {
    assert.match(NOTICE_SRC, /\$\{Modal\} open=\$\{open\} onClose=\$\{closeNotice\}/, 'the dialog closes through the shared Modal');    assert.match(NOTICE_SRC, /onClick=\$\{closeNotice\}>关闭/, 'and its own button says 关闭 (not 知道了)');
    assert.match(MAIN_SRC, /import \{ NoticeHost \} from '\.\/ui\/notice\.js';/);
    assert.match(MAIN_SRC, /<\$\{NoticeHost\} \/>/);
    assert.equal(typeof NoticeHost, 'function');
    // the affordances themselves are the shared ones (components.js Modal is used by the settings / exit dialogs too)
    assert.match(COMPONENTS_SRC, /if \(e\.key !== 'Escape' \|\| modalStack\[modalStack\.length - 1\] !== token/, 'Escape closes the topmost dialog');
    assert.match(COMPONENTS_SRC, /e\.target === e\.currentTarget && onClose/, 'a click outside the box closes it');
    // the long body scrolls inside the dialog instead of stretching it
    assert.match(read('public/css/components.css'), /\.modal__body \{[^}]*overflow: auto;/);
    assert.match(NOTICE_SRC, /class="notice__body"/);
  });

  test('closing works: openNotice / closeNotice / toggle drive the panel state', async () => {
    const fetchFn = fetchOf({ body: ['一行'] });
    const c = createNoticeClient({ fetch: fetchFn });
    assert.equal(c.store.get().open, false, 'closed to begin with');
    await c.open();
    assert.equal(c.store.get().open, true, 'clicking opens the panel');
    c.close();
    assert.equal(c.store.get().open, false, 'the close affordance closes it');
    await c.toggle();
    assert.equal(c.store.get().open, true, 'toggle opens');
    c.toggle();
    assert.equal(c.store.get().open, false, 'toggle closes');
  });
});

describe('公告: what the panel renders', () => {
  test('a well-formed payload renders as given (title, one plain-text line per body entry, updatedAt)', () => {
    const n = normalizeNotice({ title: '维护公告', body: ['第一行', '  第二行  '], updatedAt: '2026-10-05' });
    // the flat `body` form is one UNLABELLED section; `body` itself stays the flat view of every section's lines
    assert.deepEqual(n, {
      title: '维护公告',
      sections: [{ label: '', lines: ['第一行', '第二行'] }],
      body: ['第一行', '第二行'],
      updatedAt: '2026-10-05',
      fallback: false,
    });
    // one string is split on newlines (a hand-written file may hold the whole text in one field)
    assert.deepEqual(normalizeNotice({ body: 'a\n\nb\r\nc' }).body, ['a', 'b', 'c']);
    // a title may be left out, an unknown key (data/notice.json's own _doc) is ignored
    assert.equal(normalizeNotice({ body: ['x'] }).title, NOTICE_FALLBACK.title);
    assert.deepEqual(normalizeNotice({ _doc: 'x'.repeat(999), body: ['x'] }).body, ['x']);
    assert.equal(normalizeNotice({ body: ['x'] }).fallback, false);
  });

  test('a missing / malformed payload falls back to the built-in text and never throws', () => {
    const bad = [
      null, undefined, 0, 42, true, 'body', '{"body":[]}', [], ['line'],
      {}, { body: null }, { body: 42 }, { body: {} }, { body: [] }, { body: [null, undefined, {}, 7, ''] },
      { body: [''], title: 9 }, { title: null, body: [123] },
    ];
    for (const raw of bad) {
      let n;
      assert.doesNotThrow(() => { n = normalizeNotice(raw); }, `threw on ${JSON.stringify(raw)}`);
      assert.deepEqual(n.body, [...NOTICE_FALLBACK.body], `fallback body for ${JSON.stringify(raw)}`);
      assert.equal(n.fallback, true);
      assert.ok(n.title.length > 0, 'a title is always there');
    }
    // …and the fallback itself is usable content, not an empty panel
    assert.ok(NOTICE_FALLBACK.body.length >= 1);
    assert.deepEqual(fallbackNotice().body, [...NOTICE_FALLBACK.body]);
    assert.notEqual(fallbackNotice().body, NOTICE_FALLBACK.body, 'a copy, never the frozen constant');
  });

  test('the rendered text is capped: 40 lines, 200 chars a line, 4000 chars in total (a 100 KB body is safe)', () => {
    const many = normalizeNotice({ body: Array.from({ length: 100 }, (_, i) => `L${i}`) });
    assert.equal(many.body.length, NOTICE_MAX_LINES, 'at most 40 lines are rendered');
    const huge = normalizeNotice({ body: Array.from({ length: 500 }, () => 'x'.repeat(5000)) });
    assert.ok(huge.body.length <= NOTICE_MAX_LINES);
    assert.ok(huge.body.every((l) => l.length <= NOTICE_MAX_LINE));
    const total = huge.body.reduce((n, l) => n + l.length, 0);
    assert.ok(total <= NOTICE_MAX_CHARS, `the total cap holds (${total})`);
    assert.ok(huge.body.join('').length <= NOTICE_MAX_CHARS);
    // a 100 KB single paragraph does not become one 100 KB line
    const one = normalizeNotice({ body: ['y'.repeat(100 * 1024)] });
    assert.equal(one.body.length, 1);
    assert.equal(one.body[0].length, NOTICE_MAX_LINE);
    // a cut never leaves half a surrogate pair behind
    const emoji = normalizeNotice({ body: ['😀'.repeat(150)] }); // 300 UTF-16 units
    assert.ok(emoji.body[0].length <= NOTICE_MAX_LINE);
    assert.doesNotMatch(emoji.body[0], /[\ud800-\udbff]$/);
    const longTitle = normalizeNotice({ title: '标'.repeat(500), body: ['x'] });
    assert.equal(longTitle.title.length, 60);
  });
});

describe('公告: the sectioned layout (label row, then its lines)', () => {
  test('sections render in order: the label first, then its lines, one div per section', () => {
    const n = normalizeNotice({
      title: '服务器公告',
      sections: [
        { label: '服务说明', lines: ['第一行', '第二行'] },
        { label: '联系', lines: [{ segments: [{ t: 'QQ：' }, { t: '永远喜欢着鹿乃 🍓𐂂', href: 'https://wpa.qq.com/msgrd?v=3&uin=3497593286&site=qq&menu=yes' }] }] },
      ],
    });
    assert.equal(n.title, '服务器公告');
    assert.equal(n.fallback, false);
    assert.deepEqual(n.sections.map((s) => s.label), ['服务说明', '联系']);
    assert.deepEqual(n.sections[0].lines, ['第一行', '第二行']);
    // `body` stays the flat view of every section's lines, in order (a legacy reader keeps working)
    assert.deepEqual(n.body.map(noticeLineText), ['第一行', '第二行', 'QQ：永远喜欢着鹿乃 🍓𐂂']);
    // the label row comes BEFORE the content, and it carries the small dim class
    const div = noticeSectionNode(n.sections[0], 0);
    assert.equal(div.type, 'div');
    assert.equal(div.props.class, 'notice__section');
    const kids = [].concat(div.props.children).flat().filter(Boolean);
    assert.equal(kids[0].type, 'p');
    assert.equal(kids[0].props.class, 'notice__label');
    assert.equal(kids[0].props.children, '服务说明');
    assert.deepEqual(kids.slice(1).map((k) => k.props.class), ['notice__line', 'notice__line']);
    assert.deepEqual(kids.slice(1).map((k) => k.props.children), ['第一行', '第二行']);
    // order is data order
    const swapped = normalizeNotice({ sections: [{ label: 'B', lines: ['b'] }, { label: 'A', lines: ['a'] }] });
    assert.deepEqual(swapped.sections.map((s) => s.label), ['B', 'A']);
    const kidsOfSection = (section, key) => [].concat(noticeSectionNode(section, key).props.children).flat().filter(Boolean);
    assert.equal(kidsOfSection(swapped.sections[0], 0)[0].props.children, 'B');
    assert.equal(kidsOfSection(swapped.sections[1], 1)[0].props.children, 'A');
    // a section without a label renders no label row at all
    const unlabelled = kidsOfSection({ label: '', lines: ['x'] }, 0);
    assert.equal(unlabelled.length, 1);
    assert.equal(unlabelled[0].props.class, 'notice__line');
    // the label is the project's small dim idiom (not another body line)
    const rule = CSS.match(/\.notice__label \{[^}]*\}/);
    assert.ok(rule, '.notice__label is styled');
    assert.match(rule[0], /color: var\(--text-dim\);/);
    assert.match(rule[0], /letter-spacing: \.18em;/);
    assert.match(rule[0], /font-size: \.12rem;/);
  });

  test('the panel title comes from the data and the confirm button says 关闭', () => {
    assert.match(NOTICE_SRC, /title=\$\{notice\.title\}/);
    assert.match(NOTICE_SRC, /onClick=\$\{closeNotice\}>关闭<\//);
    assert.doesNotMatch(NOTICE_SRC, /知道了/);
    assert.match(NOTICE_SRC, /<\$\{Button\} variant="primary" icon="check" onClick=\$\{closeNotice\}>关闭<\//);
    assert.match(NOTICE_SRC, /\$\{notice\.sections\.map\(\(section, i\) => noticeSectionNode\(section, i\)\)\}/);
  });

  test('sections are capped and a broken section list never throws', () => {
    const many = normalizeNotice({ sections: Array.from({ length: 60 }, (_, i) => ({ label: `S${i}`, lines: [`L${i}`] })) });
    assert.ok(many.sections.length <= NOTICE_MAX_SECTIONS, `at most ${NOTICE_MAX_SECTIONS} sections`);
    const lines = normalizeNotice({ sections: [{ label: 'x', lines: Array.from({ length: 100 }, (_, i) => `L${i}`) }] });
    assert.equal(lines.body.length, NOTICE_MAX_LINES);
    const long = normalizeNotice({ sections: [{ label: '标'.repeat(200), lines: ['x'.repeat(9000)] }] });
    assert.equal(long.sections[0].label.length, NOTICE_MAX_LABEL);
    assert.equal(noticeLineText(long.sections[0].lines[0]).length, NOTICE_MAX_LINE);
    const total = normalizeNotice({ sections: [{ label: 'a', lines: Array.from({ length: 500 }, () => 'x'.repeat(5000)) }] });
    assert.ok(total.body.reduce((n, l) => n + noticeLineText(l).length, 0) <= NOTICE_MAX_CHARS);
    // junk in, built-in text out — and never a throw
    for (const v of [null, 0, 'sections', [], [null, 7], [{}], [{ label: 42, lines: 9 }], { sections: 'x' }, { sections: {} }]) {
      const asObject = v && typeof v === 'object' && !Array.isArray(v) ? v : { sections: v };
      let n;
      assert.doesNotThrow(() => { n = normalizeNotice(asObject); }, `threw on ${JSON.stringify(v)}`);
      assert.ok(n.sections.length >= 1 && n.body.length >= 1, `something to render for ${JSON.stringify(v)}`);
    }
    // a `sections` array that renders nothing falls back to the flat `body` (a half-migrated file keeps working)
    const half = normalizeNotice({ sections: [{}], body: ['旧结构'] });
    assert.equal(half.fallback, false);
    assert.deepEqual(half.body, ['旧结构']);
    assert.deepEqual(half.sections, [{ label: '', lines: ['旧结构'] }]);
  });

  test('the legacy body array and the built-in fallback still render', () => {
    const legacy = normalizeNotice({ body: ['一行', { spacer: true }, { segments: [{ t: 'x', href: 'https://ai.xiaolubao.com' }] }] });
    assert.deepEqual(legacy.sections.map((s) => s.label), [''], 'one unlabelled section');
    assert.deepEqual(legacy.body.map(noticeLineText), ['一行', '', 'x']);
    assert.equal(legacy.fallback, false);
    // …and the fallback is a section too, so the panel renders it down the very same path
    const fb = fallbackNotice();
    assert.deepEqual(fb.sections, [{ label: '', lines: [...NOTICE_FALLBACK.body] }]);
    assert.deepEqual(fb.body, [...NOTICE_FALLBACK.body]);
    assert.equal(fb.fallback, true);
    const broken = normalizeNotice({ body: 42 });
    assert.equal(broken.fallback, true);
    assert.deepEqual(broken.sections, [{ label: '', lines: [...NOTICE_FALLBACK.body] }]);
    assert.deepEqual(broken.body, [...NOTICE_FALLBACK.body]);
  });
});

describe('公告: inline links are structured data, never markup', () => {
  /** The children of a normalized line's <p>, whatever htm handed the vnode. */
  const kidsOf = (line, key = 0) => [].concat(noticeLineNode(line, key).props.children);

  test('a whitelisted href renders an <a>: underline class, new tab, noopener noreferrer', () => {
    const n = normalizeNotice({
      body: [{
        segments: [
          { t: 'BiliBili：鹿可可Official' },
          { t: '（' },
          { t: 'space.bilibili.com/426276698', href: 'https://space.bilibili.com/426276698' },
          { t: '）' },
        ],
      }],
    });
    assert.equal(n.fallback, false);
    assert.deepEqual(n.body[0].segments[2], { t: 'space.bilibili.com/426276698', href: 'https://space.bilibili.com/426276698' });
    const p = noticeLineNode(n.body[0], 0);
    assert.equal(p.type, 'p');
    assert.equal(p.props.class, 'notice__line');
    const kids = kidsOf(n.body[0]);
    assert.deepEqual(kids.map((k) => (k && k.type) || typeof k), ['string', 'string', 'a', 'string'], 'only the linked segment is an element');
    const a = kids.find((k) => k && k.type === 'a');
    assert.equal(a.props.class, 'notice__link', 'the underline class');
    assert.equal(a.props.href, 'https://space.bilibili.com/426276698');
    assert.equal(a.props.target, '_blank');
    assert.equal(a.props.rel, 'noopener noreferrer');
    assert.equal(a.props.children, 'space.bilibili.com/426276698');
    // the class is mint + underlined and NOTHING ELSE: no fill, no border, no box, no padding
    const rule = CSS.match(/\.notice__link \{[^}]*\}/);
    assert.ok(rule, '.notice__link is styled');
    assert.match(rule[0], /text-decoration: underline;/);
    assert.match(rule[0], /color: var\(--mint-500\);/);
    assert.doesNotMatch(rule[0], /background|border|box-shadow|outline|padding/, 'no filled box around the link text');
    const hover = CSS.match(/\.notice__link:hover,[^{]*\{[^}]*\}/);
    assert.ok(hover, 'the hover state is styled');
    assert.doesNotMatch(hover[0], /background|border|box-shadow|padding/, 'hover only changes the tone');
    // the standalone segment renderer (re-checked, so a hand-built notice cannot bypass the whitelist)
    assert.equal(noticeSegmentNode({ t: 'x' }), 'x');
    assert.equal(noticeSegmentNode({ t: 'x', href: 'javascript:alert(1)' }), 'x');
  });

  test('an off-whitelist href renders as PLAIN TEXT — no <a> is ever created', () => {
    const bad = [
      'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:msgbox(1)',
      'http://evil.example/x', 'http://space.bilibili.com/x', 'https://evil.example/x',
      'https://space.bilibili.com.evil.example/x', 'https://evil.space.bilibili.com/x',
      '//evil.example/x', '//space.bilibili.com/x', 'https://space.bilibili.com:8443/x',
      'https://user:pass@space.bilibili.com/x', 'https://space.bilibili.com/x y', 'space.bilibili.com',
      'ftp://space.bilibili.com/x', 'mailto:not-an-address', '',
    ];
    for (const href of bad) {
      assert.equal(safeNoticeHref(href), null, `${href} is refused`);
      const n = normalizeNotice({ body: [{ segments: [{ t: '点我', href }] }] });
      assert.equal(n.fallback, false);
      const kids = kidsOf(n.body[0]);
      assert.equal(kids.length, 1, `${href}: one node`);
      assert.equal(kids[0], '点我', `${href}: rendered as text`);
      assert.ok(!kids.some((k) => k && k.type === 'a'), `${href}: no link`);
      assert.equal(n.body[0].segments[0].href, undefined, `${href}: the href is dropped from the notice`);
    }
    // non-string hrefs are refused the same way (a number, an object, null)
    for (const href of [42, null, undefined, {}, ['https://space.bilibili.com/1']]) {
      assert.equal(safeNoticeHref(href), null);
    }
    // …and a refused href is the ONLY thing dropped: the segment's text survives
    const mixed = normalizeNotice({
      body: [{ segments: [{ t: 'a', href: 'https://space.bilibili.com/1' }, { t: 'b', href: 'javascript:x' }, { t: 'c', href: 'mailto:me@example.com' }] }],
    });
    const kids = kidsOf(mixed.body[0]);
    assert.deepEqual(kids.map((k) => (k && k.type) || typeof k), ['a', 'string', 'a']);
    assert.equal(kids[1], 'b');
  });

  test('the whitelist: https on the four known hosts, or a mailto: address — and nothing else', () => {
    assert.deepEqual([...NOTICE_LINK_HOSTS], ['space.bilibili.com', 'ai.xiaolubao.com', 'wpa.qq.com', 'github.com']);
    for (const href of [
      'https://space.bilibili.com/426276698',
      'https://ai.xiaolubao.com',
      'https://ai.xiaolubao.com/',
      'https://wpa.qq.com/msgrd?v=3&uin=3497593286&site=qq&menu=yes',
      'https://space.bilibili.com',
      'https://github.com/someone/stronghold-protocol',
      'https://github.com',
      'mailto:someone@example.com',
      'mailto:someone@example.com.cn',
    ]) {
      assert.equal(safeNoticeHref(href), href, `${href} is allowed through verbatim`);
    }
    // github.com is whitelisted EXACTLY — every look-alike spelling is still refused
    for (const href of [
      'https://github.com.evil.example/x', 'https://www.github.com/x', 'https://gist.github.com/x',
      'https://evil.github.com/x', 'http://github.com/x', '//github.com/x',
    ]) {
      assert.equal(safeNoticeHref(href), null, `${href} is refused`);
    }
    assert.equal(safeNoticeHref('  https://ai.xiaolubao.com  '), 'https://ai.xiaolubao.com', 'trimmed');
    assert.equal(safeNoticeHref(`https://space.bilibili.com/${'x'.repeat(400)}`), null, 'absurdly long');
  });

  test('the caps still apply to segment text (line, total, lines) and never split a surrogate pair', () => {
    const one = normalizeNotice({ body: [{ segments: [{ t: 'y'.repeat(5000) }] }] });
    assert.equal(one.body.length, 1);
    assert.equal(noticeLineText(one.body[0]).length, NOTICE_MAX_LINE);
    // a budget spread over several segments: the tail is cut, the earlier segments keep their links
    const spread = normalizeNotice({
      body: [{ segments: [{ t: 'a'.repeat(150), href: 'https://ai.xiaolubao.com' }, { t: 'b'.repeat(100) }, { t: 'c'.repeat(100) }] }],
    });
    const text = noticeLineText(spread.body[0]);
    assert.equal(text.length, NOTICE_MAX_LINE, `the line stops at ${NOTICE_MAX_LINE}`);
    assert.equal(text, 'a'.repeat(150) + 'b'.repeat(50), 'the tail segments are cut, not dropped mid-list');
    assert.equal(spread.body[0].segments[0].href, 'https://ai.xiaolubao.com', 'a kept prefix keeps its link');
    const emoji = normalizeNotice({ body: [{ segments: [{ t: '😀'.repeat(300) }] }] });
    assert.ok(noticeLineText(emoji.body[0]).length <= NOTICE_MAX_LINE);
    assert.doesNotMatch(noticeLineText(emoji.body[0]), /[\ud800-\udbff]$/);
    // line count / total characters
    const many = normalizeNotice({ body: Array.from({ length: 100 }, (_, i) => ({ segments: [{ t: `S${i}` }] })) });
    assert.equal(many.body.length, NOTICE_MAX_LINES);
    const huge = normalizeNotice({ body: Array.from({ length: 500 }, () => ({ segments: [{ t: 'x'.repeat(5000) }] })) });
    assert.ok(huge.body.length <= NOTICE_MAX_LINES);
    const total = huge.body.reduce((n, l) => n + noticeLineText(l).length, 0);
    assert.ok(total <= NOTICE_MAX_CHARS, `the total cap holds with segments (${total})`);
  });

  test('the plain-string form and the built-in fallback still work exactly as before', () => {
    // plain strings: unchanged shape, unchanged caps, no wrapper object
    assert.deepEqual(normalizeNotice({ body: ['第一行', '第二行'] }).body, ['第一行', '第二行']);
    assert.deepEqual(normalizeNotice({ body: 'a\n\nb\r\nc' }).body, ['a', 'b', 'c']);
    // both forms together, with an explicit blank line between groups
    const mixed = normalizeNotice({ body: ['标题行', { spacer: true }, { segments: [{ t: 'x', href: 'https://ai.xiaolubao.com' }] }] });
    assert.deepEqual(mixed.body.map(noticeLineText), ['标题行', '', 'x']);
    assert.equal(mixed.body[1].spacer, true);
    assert.equal(noticeLineNode(mixed.body[1], 1).props.class, 'notice__line notice__line--spacer');
    assert.equal(noticeLineNode(mixed.body[1], 1).props['aria-hidden'], 'true');
    // a structured entry that renders nothing is a blank line, but a body of ONLY blanks is still the fallback
    assert.equal(normalizeNotice({ body: [{ segments: [] }] }).fallback, true);
    assert.equal(normalizeNotice({ body: [[]] }).fallback, true);
    assert.deepEqual(fallbackNotice().body, [...NOTICE_FALLBACK.body]);
    const fb = normalizeNotice({ body: [{ segments: [{ t: '  ' }] }], title: 'T' });
    assert.equal(fb.fallback, true);
    assert.deepEqual(fb.body, [...NOTICE_FALLBACK.body]);
    assert.equal(fb.title, 'T');
  });

  test('markup-looking text stays literal text: nothing is parsed and no HTML string is built', () => {
    const n = normalizeNotice({ body: ['<b>粗体</b>', { segments: [{ t: '<img src=x onerror=alert(1)>' }, { t: '<a href="javascript:x">go</a>' }] }] });
    assert.equal(noticeLineText(n.body[0]), '<b>粗体</b>');
    const kids = kidsOf(n.body[1]);
    assert.deepEqual(kids, ['<img src=x onerror=alert(1)>', '<a href="javascript:x">go</a>']);
    assert.ok(!kids.some((k) => k && k.type), 'no element came out of markup-looking text');
    assert.doesNotMatch(NOTICE_CODE, /innerHTML|dangerouslySetInnerHTML|insertAdjacentHTML|outerHTML/);
    // the sections are rendered through the pure section renderer, never as one pre-built string
    assert.match(NOTICE_SRC, /notice\.sections\.map\(\(section, i\) => noticeSectionNode\(section, i\)\)/);
  });
});

describe('公告: reading /data/notice.json', () => {
  test('it reads the static /data file with cache no-cache (no new endpoint) and stores the notice', async () => {
    const fetchFn = fetchOf({ title: '服务器公告', body: ['一行', '两行'], updatedAt: '2026-10-05' });
    const c = createNoticeClient({ fetch: fetchFn });
    await c.open();
    assert.equal(fetchFn.calls.length, 1);
    assert.equal(fetchFn.calls[0].url, NOTICE_URL);
    assert.equal(NOTICE_URL, '/data/notice.json');
    assert.equal(fetchFn.calls[0].init.cache, 'no-cache', 'a republished notice is picked up without a client rebuild');
    const s = c.store.get();
    assert.equal(s.status, 'ready');
    assert.deepEqual(s.notice.body, ['一行', '两行']);
    assert.equal(s.notice.title, '服务器公告');
    assert.equal(s.notice.updatedAt, '2026-10-05');
    // the client never asks anything else: no server route, no second request
    assert.deepEqual([...new Set(fetchFn.calls.map((x) => x.url))], ['/data/notice.json']);
    assert.equal((NOTICE_SRC.match(/doFetch\(/g) || []).length, 1, 'exactly one request site');
  });

  test('every open re-reads the file (a republished notice shows up without a reload)', async () => {
    let body = ['旧公告'];
    const fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ body }) });
    const c = createNoticeClient({ fetch: fetchFn });
    await c.open();
    assert.deepEqual(c.store.get().notice.body, ['旧公告']);
    c.close();
    body = ['新公告'];
    await c.open();
    assert.deepEqual(c.store.get().notice.body, ['新公告'], 'the second open asked again');
  });

  test('404 / network error / invalid JSON fall back to the built-in notice without throwing', async () => {
    const cases = [
      fetchOf({}, { ok: false, status: 404 }),
      fetchOf({}, { ok: false, status: 500 }),
      fetchOf(null, { fail: new Error('offline') }),
    ];
    for (const c of cases) {
      const warned = [];
      const client = createNoticeClient({ fetch: c, warn: (m) => warned.push(m) });
      let n;
      await assert.doesNotReject(async () => { n = await client.open(); });
      assert.deepEqual(n.body, [...NOTICE_FALLBACK.body]);
      assert.deepEqual(client.store.get().notice.body, [...NOTICE_FALLBACK.body], 'the panel shows the fallback');
      assert.equal(client.store.get().status, 'failed');
      assert.equal(client.store.get().open, true, 'the panel still opens');
      assert.equal(warned.length, 1);
      assert.match(String(warned[0]), /notice\.json/);
    }
    // a 200 whose body is not valid JSON (res.json() rejects) — the same fallback, still no throw
    const broken = createNoticeClient({
      fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
      warn: () => {},
    });
    assert.deepEqual((await broken.open()).body, [...NOTICE_FALLBACK.body]);
    assert.equal(broken.store.get().status, 'failed');
    // a 200 whose JSON is the wrong shape: the notice is unusable, the built-in text shows, the code keeps going
    const weird = createNoticeClient({ fetch: fetchOf({ body: { a: 1 }, title: [] }), warn: () => {} });
    const w = await weird.open();
    assert.equal(w.fallback, true);
    assert.deepEqual(w.body, [...NOTICE_FALLBACK.body]);
    assert.equal(weird.store.get().status, 'ready', 'the file itself arrived');
  });

  test('parallel opens share one request', async () => {
    const fetchFn = fetchOf({ body: ['x'] });
    const c = createNoticeClient({ fetch: fetchFn });
    await Promise.all([c.open(), c.open(), c.refresh()]);
    assert.equal(fetchFn.calls.length, 1, 'an in-flight read is reused');
  });
});

describe('公告: the real singleton the UI uses', () => {
  test('clicking the real 公告 button opens the panel and shows the built-in text when the fetch fails', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    try {
      closeNotice();
      assert.equal(noticeStore.get().open, false);
      const button = NoticeButton({ class: 'title-notice' });
      await button.props.onClick({ type: 'click' }); // exactly what Preact calls on a click
      assert.equal(noticeStore.get().open, true, 'the panel is open');
      assert.equal(noticeStore.get().status, 'failed');
      assert.deepEqual(noticeStore.get().notice.body, [...NOTICE_FALLBACK.body]);
      closeNotice();
      assert.equal(noticeStore.get().open, false, 'and it closes again');
    } finally {
      globalThis.fetch = original;
      closeNotice();
    }
  });

  test('the shipped data/notice.json is well-formed and renders as given', () => {
    const raw = JSON.parse(read('data/notice.json'));
    const n = normalizeNotice(raw);
    assert.equal(n.fallback, false, 'the shipped file has a usable body');
    assert.equal(n.title, '服务器公告');
    assert.equal(n.updatedAt, '2026-10-07');
    assert.deepEqual(n.sections.map((s) => s.label), ['服务说明', '联系', '反馈', '制作中']);
    const text = n.body.map(noticeLineText);
    assert.ok(text.length >= 1);
    assert.ok(text.every((l) => l.length > 0), 'the sectioned file has no blank filler line');
    assert.ok(text.every((l) => l.length <= NOTICE_MAX_LINE));
    assert.match(raw._doc, /notice\.json/, 'the file documents its own shape and the republish-only update path');
    assert.match(raw._doc, /sections/, 'and the sectioned shape');
    assert.match(raw._doc, /联系邮箱/, 'and the sections that were deliberately left out');
    assert.match(raw._doc, /github\.com/i, 'and how to add the repository section later');
    // the operator's text, verbatim (looked up by label)
    const section = (label) => n.sections.find((s) => s.label === label);
    assert.deepEqual(section('服务说明').lines, [
      '本站为纯公益的非官方同人站点，与游戏官方及其关联方无关',
      '可能会不定期重启更新版本等　对此造成的游戏中断致歉',
      '闪断不丢掉游戏进度的功能将随本次更新上线：同盟对局与房间都能在闪断后回来',
    ]);
    assert.ok(text.some((l) => l === 'QQ：永远喜欢着鹿乃 🍓𐂂　3497593286'), 'the QQ row shows the user\'s own text plus the number he asked to add');
    assert.ok(text.includes('B 站：鹿可可Official'));
    assert.ok(text.includes('如遇服务器方面的问题，可以通过B站私信或发送邮件联系。'));
    // the sponsor row left the notice's text: the QR is the panel's right-hand column now (ui/sponsor.js)
    assert.ok(!text.some((l) => l.includes('花鹿云心AI中转站')), 'the old sponsor line is gone from the notice');
    assert.ok(!text.some((l) => l.includes('ai.xiaolubao.com')), 'nor is its domain displayed anywhere');
    assert.ok(text.some((l) => l.includes('目前正在制作功能：键位设置　皮肤功能（正在考量）')));
    // the QQ NUMBER is only in the href — it is never part of the visible text
    assert.ok(text.some((l) => l.includes('3497593286')), 'the QQ number is not displayed anywhere');
    assert.ok(JSON.stringify(raw).match(/"t":"[^"]*"/g).some((s) => s.includes('3497593286')), 'nor in any visible segment');
    const qq = section('联系').lines[0];
    assert.equal(qq.segments[0].t, 'QQ：');
    assert.equal(qq.segments[1].t, '永远喜欢着鹿乃 🍓𐂂');
    assert.equal(qq.segments[1].href, 'https://wpa.qq.com/msgrd?v=3&uin=3497593286&site=qq&menu=yes');
    assert.ok(qq.segments[1].href.includes('3497593286'), 'the number lives in the href only');
    // the emoji survive normalization intact (surrogate pairs are never split)
    assert.deepEqual([...qq.segments[1].t].slice(-2).map((c) => c.codePointAt(0)), [0x1f353, 0x10082], '🍓 and 𐂂');
    // exactly the two links the user asked for, all whitelisted as authored, all bare values (no brackets)
    const links = n.sections.flatMap((s) => s.lines)
      .flatMap((l) => (typeof l === 'string' || l.spacer ? [] : l.segments.filter((g) => g.href)));
    assert.deepEqual(links.map((g) => g.href), [
      'https://wpa.qq.com/msgrd?v=3&uin=3497593286&site=qq&menu=yes',
      'https://space.bilibili.com/426276698',
    ]);
    for (const g of links) assert.equal(safeNoticeHref(g.href), g.href, `${g.href} is whitelisted as authored`);
    for (const g of links) assert.doesNotMatch(g.t, /[（）()「」【】\[\]]/, `"${g.t}" is a bare value, no brackets`);
    assert.deepEqual(links.map((g) => g.t), ['永远喜欢着鹿乃 🍓𐂂', '鹿可可Official']);
    const authored = JSON.stringify(raw).match(/"href":"[^"]*"/g) || [];
    assert.equal(authored.length, links.length, 'no authored href was silently dropped');
    const anchors = n.sections.flatMap((s) => s.lines)
      .flatMap((l) => (typeof l === 'string' || l.spacer ? [] : [].concat(noticeLineNode(l, 0).props.children).filter(Boolean)))
      .filter((k) => k && k.type === 'a');
    assert.equal(anchors.length, 2, 'two clickable links in the panel');
    assert.deepEqual(anchors.map((a) => a.props.class), ['notice__link', 'notice__link']);
    assert.deepEqual(anchors.map((a) => a.props.target), ['_blank', '_blank']);
    assert.deepEqual(anchors.map((a) => a.props.rel), ['noopener noreferrer', 'noopener noreferrer']);
  });
});
