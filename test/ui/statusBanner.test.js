// The emergency / maintenance banner is operator-issued from a JSON file on the server, so the normaliser is the piece
// worth pinning: a malformed file must simply show nothing, the link whitelist must reject anything but https, and
// 紧急 / 维护 are the two tones in use.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStatus, normalizeLink, STATUS_SOURCE } from '../../public/js/ui/statusBanner.js';

test('status banner: reads the operator file outside the code deploy', () => {
  assert.equal(STATUS_SOURCE, '/runtime/status.json');
});

test('status banner: emergency and maintenance keep their identity', () => {
  const emergency = normalizeStatus({ id: 'm1', tone: 'emergency', text: '服务器异常，正在抢修' });
  assert.equal(emergency.tone, 'emergency');
  assert.equal(emergency.text, '服务器异常，正在抢修');
  assert.equal(emergency.id, 'm1');
  assert.equal(emergency.detail, '');
  assert.equal(emergency.link, null);

  const maint = normalizeStatus({ tone: 'maintenance', text: '23:30 维护重启，约 5 分钟', detail: '请提前结束对局' });
  assert.equal(maint.tone, 'maintenance');
  assert.equal(maint.detail, '请提前结束对局');
  assert.equal(maint.id, 'maintenance:23:30 维护重启，约 5 分钟', 'id falls back to tone:text so a new notice re-shows');
});

test('status banner: an unknown tone degrades to info, never throws', () => {
  assert.equal(normalizeStatus({ tone: 'nope', text: 'x' }).tone, 'info');
  assert.equal(normalizeStatus({ text: 'x' }).tone, 'info');
});

test('status banner: nothing to show without usable text', () => {
  for (const raw of [null, undefined, 0, 'text', [], {}, { text: '' }, { text: '   ' }, { text: 42 }]) {
    assert.equal(normalizeStatus(raw), null, `${JSON.stringify(raw)} shows no banner`);
  }
});

test('status banner: whitespace is trimmed and detail is optional', () => {
  const s = normalizeStatus({ tone: 'maintenance', text: '  维护重启  ', detail: '  5 分钟  ' });
  assert.equal(s.text, '维护重启');
  assert.equal(s.detail, '5 分钟');
  assert.equal(normalizeStatus({ tone: 'maintenance', text: '维护', detail: 7 }).detail, '');
});

test('status banner: the split-line link is https only and gets an underlined anchor', () => {
  const s = normalizeStatus({
    tone: 'emergency',
    text: '服务器资源吃紧，与朋友联机请前往分线：',
    link: { label: 'game.kafuno.cn', href: 'https://game.kafuno.cn' },
    detail: '匹配可留在此服务器',
  });
  assert.deepEqual(s.link, { label: 'game.kafuno.cn', href: 'https://game.kafuno.cn' });
  assert.equal(s.detail, '匹配可留在此服务器');
});

test('status banner: link label falls back to the host, and unsafe hrefs are dropped', () => {
  assert.deepEqual(normalizeLink({ href: 'https://game.kafuno.cn/' }), { label: 'game.kafuno.cn', href: 'https://game.kafuno.cn/' });
  assert.deepEqual(normalizeLink({ label: '  分线  ', href: 'https://game.kafuno.cn' }), { label: '分线', href: 'https://game.kafuno.cn' });
  for (const bad of [
    null, undefined, 'https://x.cn', [], {},
    { href: 'javascript:alert(1)' },
    { href: 'http://game.kafuno.cn' },
    { href: 'data:text/html,x' },
    { href: '/relative' },
    { href: 'https://' },
    { href: 42 },
  ]) {
    assert.equal(normalizeLink(bad), null, `${JSON.stringify(bad)} is refused`);
  }
});
