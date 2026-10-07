// 观战整备区的客户端(游玩记录 #2 item 1):被侦察玩家的手牌是 m.field(prep:true).units 里手牌行
// (row 7)上的单位——干员站立、道具 kind 'item'(浮牌),和自己整备区同一渲染路径;观战棋盘用
// prep 相机(收起商店形态,bench 行进画面)。battleView 为 kind 'item' 建 ItemView(图标/颜色客户端
// 解析,同 pieceInfo),prep 面上给带装备的队友干员挂 item pips。服务器侧:test/match/prep-bench.test.js。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

globalThis.fetch = async (url) => {
  const name = String(url).split('/').pop();
  try {
    const body = readFileSync(path.join(ROOT, 'data', name), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  } catch {
    return { ok: false, status: 404, json: async () => ({}) };
  }
};
const { data, getItem } = await import('../../public/js/data.js');
await data.loadAll('bonds', 'chess', 'items', 'assets');
const { resolveDetail } = await import('../../public/js/ui/detailPanel.js');
const { itemIconUrl } = await import('../../public/js/ui/assetUrls.js');

describe('the scouted prep board renders the hand like the own bench', () => {
  test('the game screen frames it with the prep camera in its shop-folded form (source)', () => {
    const game = read('public/js/screens/game.js');
    assert.match(game, /field\.prep \? 'prep' : \(field\.kind === 'hidden' \? 'boss' : field\.kind \|\| 'normal'\)/);
    assert.match(game, /field\.prep \? \{ shop: false \} : \{\}/);
    assert.match(game, /const scoutPid = watchingOther && field\?\.prep/);
    assert.ok(!game.includes('ScoutedBench'), 'the floating strip is gone — the hand rides the board');
    assert.ok(!read('public/css/screens/game.css').includes('.sbench'), 'its styles too');
  });

  test('battleView builds an ItemView for a hand item and item pips for a teammate operator (source)', () => {
    const app = read('public/js/render/app.js');
    assert.match(app, /info\.kind === 'item' \? new ItemView\(ctx, scoutItemInfo\(info\)\)/);
    assert.match(app, /battleMeta\?\.prep && Array\.isArray\(info\.items\) && info\.items\.length/);
    assert.match(app, /function scoutItemInfo\(info\)/);
  });

  // 线上实测（2026-10，「有的装备显示的是个问号」，棋盘底座）:scoutItemInfo() 只解析一次图标，而 data.item() 在
  // items.json/assets 还没 ready 时返回 null（data.js `lookup`:`status !== 'ready'` → null），于是退化成拿
  // chess_item_* 原 id 去查清单——清单键只有 trap_*，必然落空 → icon=null。旧代码每次同步又把那个缓存的 null
  // 原样回传，底座就永远停在 '?'：图片从未被请求，所以两台主机与对象存储上的 59 个图标全都完好。
  test('an item plate re-resolves its icon after the data landed late (source + lookup contract)', () => {
    const man = JSON.parse(read('data/assets.json'));
    const rec = getItem('chess_item_1_01_e_a');
    assert.ok(rec && rec.trapId && rec.iconId, 'the game-data record');
    assert.equal(itemIconUrl(man, 'chess_item_1_01_e_a'), null, 'a raw chess_item id is not a manifest key');
    assert.equal(itemIconUrl(man, { trapId: rec.trapId, iconId: rec.iconId }), man.items[rec.trapId]);
    const app = read('public/js/render/app.js');
    assert.match(app, /v\.setIcon\(scoutItemInfo\(info\)\.icon\)/, 'the per-sync recovery recomputes the icon');
    assert.ok(!/v\.setIcon\(info\.icon\)/.test(app), 'the cached null is not replayed');
  });

  test('ItemView syncs battle samples: a hand item rides the scouted field without breaking syncBattle (render layer: source)', () => {
    // syncBattle syncs EVERY unit of the field's snapshot (render/app.js `v.sync(s, renderT)`); the ItemView class
    // needs a sync of its own or the frame loop throws `v.sync is not a function` on every tick and the scouted
    // board's operators never draw (found in playtesting: only teammates with an item in hand / temp broke).
    const units = read('public/js/render/units.js');
    const start = units.indexOf('export class ItemView');
    assert.ok(start > 0, 'ItemView exists');
    const body = units.slice(start, units.indexOf('export class ', start + 1));
    assert.match(body, /\bsync\(s\) \{ this\.x = s\.x; this\.y = s\.y; \}/);
  });

  test('tapping a held item on the scouted board opens its card (resolveDetail unit → item)', () => {
    const IT = 'chess_item_1_01_e_a';
    const d = resolveDetail({ kind: 'unit', unit: { id: 3, kind: 'item', side: 'ally', ownerId: 'p2', defId: IT } }, new Map());
    assert.equal(d.type, 'item');
    assert.equal(d.item.itemId || d.item.id, IT);
    assert.equal(resolveDetail({ kind: 'unit', unit: { id: 4, kind: 'item', side: 'ally', ownerId: 'p2', defId: 'nope' } }, new Map()), null);
  });
});
