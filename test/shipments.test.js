'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { groupShipments, combineQuotes, refOf } = require('../services/shipments');

const tm = { def: { key: 'techmall', label: 'TechMall' } };
const sourceOf = id => (id >= 10_000_000 ? tm : null);
const depots = { 1: 'DP-A', 2: 'DP-A', 3: 'DP-B' };
const depotOf = id => depots[id] || null;
const line = (id, price, quantity = 1) => ({ id, variation_id: String(id), price, quantity });

test('TechMall gộp 1 kiện, DropBuy tách theo kho', () => {
  const g = groupShipments([line(1, 100), line(10_000_001, 50, 2), line(3, 70), line(2, 30), line(10_000_002, 20), line(9, 5)], { sourceOf, depotOf });
  assert.deepStrictEqual(g.map(x => [x.key, x.lines.length, x.subtotal]), [
    ['db:DP-A', 2, 130],
    ['src:techmall', 2, 120],
    ['db:DP-B', 1, 70],
    ['db:kho-chua-ro', 1, 5]
  ]);
});

test('Một kiện giữ nguyên báo phí, nhiều kiện cộng phí từng kiện', () => {
  const one = combineQuotes([{ key: 'db:DP-A', fee: 25000, detail: 'Viettel Post', source: 'dropbuy', refs: ['1:1'] }]);
  assert.strictEqual(one.fee, 25000);
  assert.strictEqual(one.detail, 'Viettel Post');
  assert.strictEqual(one.shipments.length, 1);

  const many = combineQuotes([
    { key: 'db:DP-A', fee: 25000, source: 'dropbuy', items: 2, refs: ['1:1', '2:2'] },
    { key: 'db:DP-B', fee: 0, free_ship: true, source: 'dropbuy', items: 1, refs: ['3:3'] },
    { key: 'src:techmall', fee: 30000, source: 'partner', items: 1, refs: ['10000001:10000001'] }
  ]);
  assert.strictEqual(many.fee, 55000);
  assert.strictEqual(many.free_ship, false);
  assert.strictEqual(many.source, 'mixed');
  assert.match(many.detail, /Giao thành 3 kiện: kiện 1 25\.000 đ \+ kiện 2 miễn phí \+ kiện 3 30\.000 đ/);
  assert.strictEqual(many.shipments.find(s => s.refs.includes(refOf(line(3, 70)))).no, 2);
});
