// 头像 P2P（user request 2026-10-15）: unit tests for the framing/validation helpers of
// public/js/ui/peerAvatars.js, plus the static contract that keeps the avatar off the server:
// the WebSocket carries signaling only, the image itself travels on the DataChannel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { avatarFrames, foldAvatarFrame, sanitizePeerAccount } from '../../public/js/ui/peerAvatars.js';
import { C2S, S2C, RTC_LIMITS, validateC2S } from '../../shared/protocol.js';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../../public/js/ui/gameLogic/settings.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');
const peer = read('public/js/ui/peerAvatars.js');
const lobby = read('server/lobby.js');
const net = read('server/net.js');
const accounts = read('public/js/ui/accounts.js');
const settingsUi = read('public/js/ui/settings.js');
const main = read('public/js/main.js');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

test('a payload that fits travels as one frame, a bigger one as numbered chunks', () => {
  assert.deepEqual(avatarFrames(''), []);
  const small = avatarFrames('hello', 16);
  assert.equal(small.length, 1);
  assert.deepEqual(JSON.parse(small[0]), { v: 1, s: 'hello' });

  const text = 'x'.repeat(100);
  const frames = avatarFrames(text, 16);
  assert.equal(frames.length, 7);
  assert.deepEqual(frames.map((f) => JSON.parse(f).i), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(frames.every((f) => JSON.parse(f).n === 7), true);
  // the default chunk stays well inside the SCTP message size every browser accepts
  const big = avatarFrames('y'.repeat(160_000));
  assert.equal(big.length > 1, true);
  assert.equal(Math.max(...big.map((f) => f.length)) < 16 * 1024, true);
});

test('frames reassemble in any order and reject a malformed one', () => {
  const text = JSON.stringify({ v: 1, name: '博士', tag: '1234', avatar: PNG });
  const frames = avatarFrames(text, 8).map((f) => JSON.parse(f));
  let buffer = null;
  // out of order on purpose: the fold only completes on the last missing chunk
  for (const f of [...frames].reverse().slice(0, -1)) {
    const res = foldAvatarFrame(buffer, JSON.stringify(f));
    assert.equal(res.text, undefined);
    buffer = res.buffer;
  }
  const last = frames.find((f) => !buffer || buffer[f.i] === undefined);
  const done = foldAvatarFrame(buffer, JSON.stringify(last));
  assert.equal(typeof done.text, 'string');
  assert.equal(JSON.parse(done.text).avatar, PNG);

  assert.deepEqual(foldAvatarFrame(null, 'not json'), { bad: true });
  assert.deepEqual(foldAvatarFrame(null, JSON.stringify({ v: 2, s: 'x' })), { bad: true });
  assert.deepEqual(foldAvatarFrame(null, JSON.stringify({ v: 1, i: 5, n: 3, s: 'x' })), { bad: true });
  assert.deepEqual(foldAvatarFrame(null, JSON.stringify({ v: 1, i: 0, n: 999, s: 'x' })), { bad: true });
});

test('a teammate account is accepted only when it carries a name or a data-URL avatar', () => {
  const ok = sanitizePeerAccount({ name: ' 博士 ', tag: '1234', avatar: PNG }, 'p_1');
  assert.deepEqual(ok, { id: 'p_1', name: '博士', tag: '1234', avatar: PNG, card: null, local: false });
  // an avatar-only account is valid (the name falls back to the seat's own)
  assert.equal(sanitizePeerAccount({ avatar: PNG }, 'p_1').avatar, PNG);
  // nothing usable
  assert.equal(sanitizePeerAccount(null, 'p_1'), null);
  assert.equal(sanitizePeerAccount({ name: '   ' }, 'p_1'), null);
  assert.equal(sanitizePeerAccount({ avatar: 'https://example.com/a.png' }, 'p_1'), null);
  assert.equal(sanitizePeerAccount({ avatar: `data:image/png;base64,${'A'.repeat(300_000)}` }, 'p_1'), null);
  // a bad #tag is dropped, the rest survives; the name is capped
  assert.equal(sanitizePeerAccount({ name: 'x', tag: 'abc' }, 'p_1').tag, null);
  assert.equal(sanitizePeerAccount({ name: 'x'.repeat(200) }, 'p_1').name.length, 64);
});

test('the protocol carries the signaling envelope and nothing else', () => {
  assert.equal(typeof C2S['rtc.signal'], 'object');
  assert.equal(S2C.includes('rtc.signal'), true);
  const to = 'p_abc';
  assert.equal(validateC2S({ t: 'rtc.signal', to, kind: 'offer', data: 'x' }), null);
  assert.match(validateC2S({ t: 'rtc.signal', to, kind: 'offer', data: 'x'.repeat(RTC_LIMITS.signalLen + 1) }), /bad field/);
  assert.match(validateC2S({ t: 'rtc.signal', to, kind: 'sdp', data: 'x' }), /bad field/);
  assert.match(validateC2S({ t: 'rtc.signal', kind: 'offer', data: 'x' }), /bad field/);
  // the cap is a signaling cap: a whole avatar would never fit through the server
  assert.equal(RTC_LIMITS.signalLen <= 64 * 1024, true);
});

test('the server relays signaling blind: same room only, rate limited, nothing stored', () => {
  const fn = lobby.slice(lobby.indexOf('  rtcSignal(session, { to, kind, data }) {'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(body, /room\.seatOf\(to\)/);
  assert.match(body, /room\.spectatorOf\(to\)/);
  // the rate limit lives in server/net.js (RTC_TYPES), next to the other per-connection buckets
  assert.match(net, /export const RTC_TYPES = new Set\(\['rtc\.signal'\]\);/);
  assert.match(net, /this\.rtc = new TokenBucket\(opts\.rtcPerSec, opts\.rtcBurst, now\);/);
  assert.match(net, /RTC_TYPES\.has\(msg\.t\) && !conn\.rtc\.take\(now\)/);
  assert.match(body, /sendSession\(peer, \{ t: 'rtc\.signal', from: session\.playerId, kind, data \}\)/);
  // no storage and no inspection of the payload
  assert.doesNotMatch(body, /JSON\.parse/);
  assert.doesNotMatch(body, /data\.(length|slice|split)/);
  assert.doesNotMatch(body, /this\.registry\.(add|set)\(/);
  assert.match(lobby, /case 'rtc\.signal': return this\.rtcSignal\(session, msg\);/);
});

test('the client sends the avatar over the DataChannel only, never through the socket', () => {
  // exactly one place talks to the server, and it is the signaling relay
  assert.equal(peer.split('netRef?.send(').length - 1, 1);
  assert.match(peer, /netRef\?\.send\('rtc\.signal', \{ to, kind, data \}\)/);
  // the payload goes to dc.send
  assert.match(peer, /dc\.send\(frame\)/);
  assert.doesNotMatch(peer, /sendLocal[\s\S]{0,200}netRef\?\.send/);
  assert.doesNotMatch(peer, /innerHTML|eval\(|new Function/);
  assert.match(peer, /new globalThis\.RTCPeerConnection\(\{ iceServers \}\)/);
  // a browser without WebRTC (and Node) simply does not start the mesh
  assert.match(peer, /typeof globalThis\.RTCPeerConnection !== 'function'/);
  // the local avatar cap matches what ui/accounts.js stores (AVATAR_MAX = 160 000)
  assert.match(peer, /const MAX_AVATAR = 200 \* 1024;/);
  assert.match(accounts, /const AVATAR_MAX = 160_000;/);
});

test('teammates are shown through accountOf/useAccount and the mesh starts at boot', () => {
  assert.match(accounts, /import \{ peerAccount, subscribePeerAccounts, setLocalPeerAccount, startPeerAvatars \} from '\.\/peerAvatars\.js';/);
  assert.match(accounts, /export function accountOf\(playerId\) \{ return isMe\(playerId\) \? currentAccount\(\) : peerAccount\(playerId\); \}/);
  assert.match(accounts, /return isMe\(playerId\) \? me : peerAccount\(playerId\);/);
  assert.match(accounts, /subscribePeerAccounts\(\(\) => bump/);
  // a local change (new avatar / rename) is offered to the open channels immediately
  assert.match(accounts, /setLocalPeerAccount\(currentAccount\(\)\)/);
  assert.match(accounts, /export function startAccounts\(\)[\s\S]{0,200}startPeerAvatars\(\);/);
  assert.match(main, /import \{ startAccounts \} from '\.\/ui\/accounts\.js';/);
  assert.match(main, /startAccounts\(\);/);
  // the account panel tells the truth about where the avatar goes
  assert.match(accounts, /只有和你同一个房间的队友会通过浏览器直连收到你的头像/);
});

test('there is no setting for it: 头像 P2P is simply always on (user 2026-10-15)', () => {
  // 「设置不要新增头像 P2P，我就是想要默认 P2P」— so the settings store must not carry the field at all,
  // and nothing may gate the mesh: it starts whenever the browser has WebRTC.
  assert.equal('p2pAvatar' in DEFAULT_SETTINGS, false);
  assert.equal('p2pAvatar' in sanitizeSettings({ p2pAvatar: false }), false, 'a stored false from an older build is ignored, not honoured');
  assert.doesNotMatch(settingsUi, /p2pAvatar|applyP2pAvatar|setPeerAvatarsEnabled/);
  assert.doesNotMatch(peer, /setPeerAvatarsEnabled|\benabled\b/);
  assert.match(peer, /export async function startPeerAvatars\(\) \{\n  if \(started\) return;/);
  assert.match(peer, /typeof globalThis\.RTCPeerConnection !== 'function'/);
});

test('when the direct connection cannot be made the seat falls back to the namecard, never to the server', () => {
  // The fallback is purely local: a seat without a peer account renders the namecard operator and the initial
  // (components.js AvatarFrame), and no code path hands the avatar to the socket — so a failed P2P costs the
  // server exactly nothing. `peerAccount()` is null until a DataChannel message arrived.
  assert.match(peer, /export function peerAccount\(playerId\) \{ return playerId \? peers\.get\(playerId\)\?\.account \|\| null : null; \}/);
  assert.equal(peer.split('netRef?.send(').length - 1, 1, 'the only socket call is the signaling relay');
  assert.doesNotMatch(peer, /dc\.onmessage[\s\S]{0,400}netRef/);
});
