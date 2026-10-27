'use strict';
/**
 * Danh mục bán cho khách = DropBuy (data/products.json) + các nguồn sỉ khác (services/sources).
 * Chỉ dùng để ĐỌC ở phía cửa hàng; mỗi nguồn tự ghi file của mình nên không bao giờ ghi đè nhau.
 */
const scraper = require('./dropbuyScraper');
const sources = require('./sources');
const variantGrouper = require('./variantGrouper');

// Hàng nguồn khác từng bị ghi lẫn vào file DropBuy (bản TechMall cũ, trường supplier) → không hiện, tránh trùng
const isLegacyPartner = p => p.supplier && p.supplier !== 'dropbuy';

let dropbuyGroupedCache = null;
let lastDropbuyKey = null;

function dropbuyProducts() {
  const raw = scraper.getProducts().filter(p => !isLegacyPartner(p));
  const key = `${raw.length}:${raw[0]?.updated_at || ''}`;
  if (dropbuyGroupedCache && key === lastDropbuyKey) {
    return dropbuyGroupedCache;
  }
  lastDropbuyKey = key;
  dropbuyGroupedCache = variantGrouper.groupProducts(raw);
  return dropbuyGroupedCache;
}

let sourceProductsCache = null;
let lastSourceKey = null;

function sourceProducts() {
  const allSources = sources.all();
  let totalLen = 0;
  for (const s of allSources) {
    const list = s.getProducts ? s.getProducts() : s.store.getProducts();
    totalLen += list.length;
  }
  const key = `${totalLen}`;
  if (sourceProductsCache && key === lastSourceKey) {
    return sourceProductsCache;
  }
  lastSourceKey = key;
  const rawSources = allSources.flatMap(s => (s.getProducts ? s.getProducts() : s.store.getProducts()).filter(p => !p.removed));
  sourceProductsCache = variantGrouper.groupProducts(rawSources);
  return sourceProductsCache;
}

let combinedCache = null;
let lastCombinedKey = null;

function getProducts() {
  const dp = dropbuyProducts();
  const sp = sourceProducts();
  const key = `${dp.length}:${sp.length}:${dp[0]?.id || ''}:${sp[0]?.id || ''}`;
  if (combinedCache && key === lastCombinedKey) {
    return combinedCache;
  }
  lastCombinedKey = key;
  combinedCache = dp.concat(sp);
  return combinedCache;
}

let categoriesCache = null;
let lastCategoriesKey = null;

function getCategories() {
  const sCats = scraper.getCategories();
  const extCats = sources.all().flatMap(s => s.store.getCategories());
  const key = `${sCats.length}:${extCats.length}`;
  if (categoriesCache && key === lastCategoriesKey) {
    return categoriesCache;
  }
  lastCategoriesKey = key;
  categoriesCache = sCats.concat(extCats);
  return categoriesCache;
}

function findProduct(id) {
  const n = Number(id);
  const s = sources.ofProduct(n);
  if (s) {
    return variantGrouper.findInGrouped(sourceProducts(), n) || null;
  }
  return variantGrouper.findInGrouped(dropbuyProducts(), n) || null;
}

function removeLegacyPartnerItems() {
  const all = scraper.getProducts();
  const keep = all.filter(p => !isLegacyPartner(p));
  if (keep.length === all.length) return 0;
  scraper.saveProducts(keep);
  return all.length - keep.length;
}

module.exports = { getProducts, getCategories, findProduct, sourceOf: sources.ofProduct, removeLegacyPartnerItems, dropbuyProducts, sourceProducts };
