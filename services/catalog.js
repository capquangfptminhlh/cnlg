'use strict';
/**
 * Danh mục bán cho khách = DropBuy (data/products.json) + các nguồn sỉ khác (services/sources).
 * Chỉ dùng để ĐỌC ở phía cửa hàng; mỗi nguồn tự ghi file của mình nên không bao giờ ghi đè nhau.
 */
const scraper = require('./dropbuyScraper');
const sources = require('./sources');

const sourceProducts = () => sources.all().flatMap(s => s.store.getProducts().filter(p => !p.removed));

// Hàng nguồn khác từng bị ghi lẫn vào file DropBuy (bản TechMall cũ, trường supplier) → không hiện, tránh trùng
const isLegacyPartner = p => p.supplier && p.supplier !== 'dropbuy';
const dropbuyProducts = () => scraper.getProducts().filter(p => !isLegacyPartner(p));

function getProducts() {
  return dropbuyProducts().concat(sourceProducts());
}

/** Dọn 1 lần lúc khởi động: gỡ hẳn hàng nguồn khác khỏi data/products.json (giờ mỗi nguồn có file riêng). */
function removeLegacyPartnerItems() {
  const all = scraper.getProducts();
  const keep = all.filter(p => !isLegacyPartner(p));
  if (keep.length === all.length) return 0;
  scraper.saveProducts(keep);
  return all.length - keep.length;
}

function getCategories() {
  return scraper.getCategories().concat(...sources.all().map(s => s.store.getCategories()));
}

function findProduct(id) {
  const n = Number(id);
  const s = sources.ofProduct(n);
  if (s) return s.store.getProducts().find(p => p.id === n && !p.removed) || null;
  return dropbuyProducts().find(p => p.id === n) || null;
}

module.exports = { getProducts, getCategories, findProduct, sourceOf: sources.ofProduct, removeLegacyPartnerItems };
