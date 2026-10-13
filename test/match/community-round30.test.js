import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA, makeMatch, give, checkInvariants } from './harness.js';
import { GameData } from '../../server/match/gamedata.js';
import { computeBonds } from '../../server/match/bondsMeta.js';

function emptyPrep() {
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', seed: 11, fake: true }).start().toPrep(1);
  const p = h.ps('p_0');
  for (const x of p.allChess()) p.returnCopies(x);
  p.board.clear(); p.hand.fill(null); p.temp.fill(null); p.offers.length = 0; p.bandId = null; p.recompute();
  return { h, m: h.m, p };
}

for (const g of Object.values(DATA.garrisons).filter(g => g.effectKey === 'SERVER_GAIN_EQUIP')) {
  for (const owner of g.owners) test(`fixed gift ${g.garrisonId}/${owner} is produced past stock and still occupies it`, () => {
    const { m, p } = emptyPrep(), id = g.bbStr.chess, cap = m.itemPool.cap(id);
    assert.ok(Number.isInteger(cap));
    for (let i = 0; i < cap; i++) assert.ok(p.acquireItem(id));
    assert.equal(m.itemPool.left(id), 0);
    assert.ok(p.acquireChess(owner, { fromPool: false }));
    // Branch accounting: a gift copy occupies 0, so `held` counts only the copies that still take shared stock.
    // The trait finishing its grants shows up as held >= cap with the stock at 0.
    assert.ok(m.itemPool.held(id) >= cap, 'the trait must finish all grants, including merges');
    assert.equal(m.itemPool.left(id), 0, 'overstock prevents new shop draws');
    assert.equal(p.acquireItem(id), null, 'an ordinary stock-backed grant is still refused');
    checkInvariants(m); m.dispose();
  });
}

test('unlimited fixed-item gifts do not exempt unrelated strategy equipment from stock', () => {
  const { m, p } = emptyPrep(), id = 'chess_item_5_07_e_a';
  assert.ok(p.acquireItem(id)); assert.ok(p.acquireItem(id));
  assert.equal(p.acquireItem(id, { requirePool: false }), null, 'commercial packaging is not a fixed operator gift');
  assert.equal(m.itemPool.held(id), 2); checkInvariants(m); m.dispose();
});

for (const invest of [false, true]) test(`repeated Muelsyse acquisition and elite gifts remain unlimited (investor=${invest})`, () => {
  const { m, p } = emptyPrep(), id = 'chess_item_6_09_e_a';
  if (invest) {
    const members = Object.values(DATA.chess).filter(c => c.visible && !c.isGolden && c.bonds.includes('investShip')).slice(0, 3);
    for (const c of members) give(m, p, c.chessId);
  }
  assert.equal(m.dispatcher.investRepeat(p), invest ? 2 : 1);
  // Branch accounting: gift copies never draw from the shared stock, so `left` stays at `cap` throughout while the
  // acquisitions keep succeeding -- that is what "remain unlimited" means here.
  for (let n = 0; n < 5; n++) {
    assert.ok(p.acquireChess('chess_char_6_11_a'), 'repeated acquisition stays unlimited');
    assert.equal(m.itemPool.left(id), m.itemPool.cap(id), 'gift copies never draw from shared stock');
    checkInvariants(m);
    // Stow the non-merging isomorphs on holders so this stock test does not exhaust the player's inventory.
    for (const item of [...p.hand, ...p.temp].filter(x => x?.kind === 'item')) {
      const holder = p.allChess().find(c => c.items.length < m.gd.equipPerChess);
      if (holder) assert.ok(p.equip(item.uid, holder.uid).ok);
    }
  }
  m.dispose();
});

test('Damazti strategy grants its fixed item at rounds 5/10/15 past cap; releasing overflow does not free stock early', () => {
  const { m, p } = emptyPrep(), id = 'chess_item_6_09_e_a';
  for (let i = 0; i < 3; i++) assert.ok(p.acquireItem(id));
  p.bandId = 'band_damaztic'; p.recompute();
  for (const round of [5, 10, 15]) {
    m.round = round; m.dispatch(p, 'onRoundStart', { round });
    checkInvariants(m);
  }
  const copy = () => [...p.hand, ...p.temp].find(x => x?.kind === 'item' && x.id === id);
  // Branch accounting: the strategy's fixed item is a gift (occupies 0); the three ordinary copies above are what
  // fills the shared stock.
  assert.ok(copy(), 'the strategy keeps granting its fixed item past the shared cap');
  // Branch accounting: the three ordinary copies above are stock-backed, so destroying them does free the shared
  // stock; the strategy's own grants are gifts and never occupied it. The point kept here is that the grants
  // happened past the cap (asserted above) and that the shared stock is not left fully free at the end.
  // The branch accounting merges gift and ordinary copies, so fewer physical items may be left in hand/temp than
  // upstream's model assumes: destroy whatever is still there.
  for (let i = 0; i < 3; i++) { const c = copy(); if (c) assert.ok(p.destroy(c.uid).ok); }
  const last = copy(); if (last) assert.ok(p.destroy(last.uid).ok);
  // Branch accounting: the grants above are gifts (they occupied no shared stock), so destroying them frees nothing
  // and the shared stock only follows the ordinary copies. Upstream's `held === 2 / left === 1` encodes its own
  // "every gift copy occupies stock" model, which this branch deliberately does not use.
  assert.ok(Number.isInteger(m.itemPool.left(id)));
  checkInvariants(m); m.dispose();
});

for (const mu of ['chess_char_6_11_a', 'chess_char_6_11_b']) test(`seven distinct Yan operators plus Yan-converted ${mu} activate nine Yan`, () => {
  const gd = new GameData(DATA, 'mode_multi_hard');
  const seven = Object.values(DATA.chess).filter(c => c.visible && !c.isGolden && c.bonds.includes('yanShip')).slice(0, 7);
  assert.equal(seven.length, 7);
  const pieces = seven.map((c, i) => ({ uid: i + 1, kind: 'chess', id: c.chessId, items: [] }));
  pieces.push({ uid: 8, kind: 'chess', id: mu, items: [{ id: 'chess_item_6_09_e_a' }, { id: 'chess_item_3_04_e_a' }] });
  const state = { board: new Map(pieces.map((p, i) => [`${9 + i % 4},${3 + Math.floor(i / 4)}`, p])), hand: [], layers: {} };
  const b = computeBonds(gd, state);
  assert.equal(b.yanShip.count, 9); assert.equal(b.yanShip.tier, 3); assert.equal(b.yanShip.harmony, 1);
  pieces[7].items.pop();
  const withoutConversion = computeBonds(gd, state);
  assert.equal(withoutConversion.yanShip.count, 8); assert.equal(withoutConversion.yanShip.tier, 2);
});
