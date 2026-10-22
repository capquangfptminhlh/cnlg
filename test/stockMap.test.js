const test = require('node:test');
const assert = require('node:assert/strict');
const scraper = require('../services/dropbuyScraper');

const config = { dropbuy: { cookieHeader: 'x=1' } };
const ok = ids => ({ ok: true, status: 200, json: async () => ({ success: true, data: ids.map(id => ({ product_id: id, in_stock: id % 2 === 0 })) }) });
const bad = status => ({ ok: false, status, json: async () => ({}) });
const ids = Array.from({ length: 30 }, (_, i) => i + 1);
const opts = { retries: 2, retryDelayMs: 1 };

function withFetch(impl, fn) {
  const orig = global.fetch;
  global.fetch = impl;
  return fn().finally(() => { global.fetch = orig; });
}

test('Tồn kho: lô bị 502 một lần → thử lại và vẫn đủ kết quả', () => {
  const tries = new Map();
  return withFetch(async (url, init) => {
    const batch = JSON.parse(init.body).product_ids;
    const n = (tries.get(batch[0]) || 0) + 1;
    tries.set(batch[0], n);
    return batch[0] === 11 && n === 1 ? bad(502) : ok(batch);
  }, async () => {
    const map = await scraper.fetchStockMap(ids, config, 10, opts);
    assert.equal(map.size, 30);
    assert.equal(map.failedBatches, 0);
    assert.equal(tries.get(11), 2);
  });
});

test('Tồn kho: 1 lô lỗi mãi → bỏ qua lô đó, các lô khác vẫn cập nhật', () =>
  withFetch(async (url, init) => {
    const batch = JSON.parse(init.body).product_ids;
    return batch[0] === 11 ? bad(504) : ok(batch);
  }, async () => {
    const map = await scraper.fetchStockMap(ids, config, 10, opts);
    assert.equal(map.size, 20);
    assert.equal(map.failedBatches, 1);
    assert.ok(!map.has(11) && map.has(1) && map.has(21));
  }));

test('Tồn kho: mọi lô đều lỗi → báo lỗi cả vòng', () =>
  withFetch(async () => bad(502), async () => {
    await assert.rejects(scraper.fetchStockMap(ids, config, 10, opts), /in-stock HTTP 502/);
  }));
