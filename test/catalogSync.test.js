const test = require('node:test');
const assert = require('node:assert/strict');
const scraper = require('../services/dropbuyScraper');
const dropbuySession = require('../services/dropbuySession');

// Catalog giả trong bộ nhớ – không đụng data/products.json
let catalog = [];
scraper.getProducts = () => catalog;
scraper.saveProducts = list => { catalog = list; };
scraper.getConfig = () => ({ dropbuy: { cookieHeader: 'x=1' } });
scraper.fetchWholesalePrices = async () => new Map();
dropbuySession.ensureSession = async () => ({ sid: 's' });

const item = id => ({ product_id: id, unique_id: `v${id}`, product_name: `SP ${id}`, slug: `sp-${id}`, price_public: 100000, product_type: 'P' });
const product = id => ({ id, variation_id: `v${id}`, name: `SP ${id}`, price: 115000, public_price: 100000, dropbuy_cost: 100000, in_stock: true });

const realtimeSync = require('../services/realtimeSync');

test('Quét đủ nhưng kho tụt hẳn (mất phiên → chỉ thấy kho công khai) → không gỡ SP nào', async () => {
  catalog = Array.from({ length: 100 }, (_, i) => product(i + 1));
  scraper.fetchAllSearchItems = async () => ({ items: Array.from({ length: 10 }, (_, i) => item(i + 1)), totalRecords: 10, complete: true });
  await realtimeSync.runPriceSync();
  assert.equal(catalog.filter(p => p.removed_from_dropbuy).length, 0);
});

test('Quét đủ, kho bình thường → SP không còn trên DropBuy bị gỡ, SP quay lại được mở bán', async () => {
  catalog = Array.from({ length: 100 }, (_, i) => product(i + 1));
  catalog[0].removed_from_dropbuy = true;
  scraper.fetchAllSearchItems = async () => ({ items: Array.from({ length: 95 }, (_, i) => item(i + 1)), totalRecords: 95, complete: true });
  await realtimeSync.runPriceSync();
  assert.equal(catalog.filter(p => p.removed_from_dropbuy).length, 5);
  assert.ok(!catalog.find(p => p.id === 1).removed_from_dropbuy);
});

test('Quét thiếu trang → không gỡ SP nào', async () => {
  catalog = Array.from({ length: 100 }, (_, i) => product(i + 1));
  scraper.fetchAllSearchItems = async () => ({ items: Array.from({ length: 90 }, (_, i) => item(i + 1)), totalRecords: 100, complete: false });
  await realtimeSync.runPriceSync();
  assert.equal(catalog.filter(p => p.removed_from_dropbuy).length, 0);
});
