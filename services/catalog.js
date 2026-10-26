'use strict';
/**
 * Danh mục bán cho khách = DropBuy (data/products.json) + các nguồn sỉ khác (services/sources).
 * Chỉ dùng để ĐỌC ở phía cửa hàng; mỗi nguồn tự ghi file của mình nên không bao giờ ghi đè nhau.
 */
const scraper = require('./dropbuyScraper');
const sources = require('./sources');

const sourceProducts = () => sources.all().flatMap(s => s.store.getProducts().filter(p => !p.removed));

function getProducts() {
  return scraper.getProducts().concat(sourceProducts());
}

function getCategories() {
  return scraper.getCategories().concat(...sources.all().map(s => s.store.getCategories()));
}

function findProduct(id) {
  const n = Number(id);
  const s = sources.ofProduct(n);
  if (s) return s.store.getProducts().find(p => p.id === n && !p.removed) || null;
  return scraper.getProducts().find(p => p.id === n) || null;
}

module.exports = { getProducts, getCategories, findProduct, sourceOf: sources.ofProduct };
