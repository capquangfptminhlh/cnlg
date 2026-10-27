'use strict';
/**
 * Danh mục bán cho khách = DropBuy (data/products.json) + các nguồn sỉ khác (services/sources).
 * Chỉ dùng để ĐỌC ở phía cửa hàng; mỗi nguồn tự ghi file của mình nên không bao giờ ghi đè nhau.
 */
const path = require('path');
const fs = require('fs');
const scraper = require('./dropbuyScraper');
const sources = require('./sources');
const variantGrouper = require('./variantGrouper');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');

function getDropbuyMtime() {
  try { return fs.statSync(PRODUCTS_FILE).mtimeMs; } catch { return 0; }
}

function getSourcesMtime() {
  return sources.all().reduce((sum, s) => {
    try {
      const f = path.join(DATA_DIR, `source-${s.def.key}-products.json`);
      return sum + (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0);
    } catch { return sum; }
  }, 0);
}

// Hàng nguồn khác từng bị ghi lẫn vào file DropBuy (bản TechMall cũ, trường supplier) → không hiện, tránh trùng
const isLegacyPartner = p => p.supplier && p.supplier !== 'dropbuy';

let dropbuyGroupedCache = null;
let lastDropbuyKey = null;

function dropbuyProducts() {
  const raw = scraper.getProducts().filter(p => !isLegacyPartner(p));
  const mtime = getDropbuyMtime();
  const key = `${raw.length}:${mtime}:${raw[0]?.updated_at || ''}`;
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
  const mtime = getSourcesMtime();
  let totalLen = 0;
  for (const s of allSources) {
    totalLen += s.store.getProducts().length;
  }
  const key = `${totalLen}:${mtime}`;
  if (sourceProductsCache && key === lastSourceKey) {
    return sourceProductsCache;
  }
  lastSourceKey = key;
  const rawSources = allSources.flatMap(s => s.store.getProducts().filter(p => !p.removed));
  sourceProductsCache = variantGrouper.groupProducts(rawSources);
  return sourceProductsCache;
}

let combinedCache = null;
let lastDpRef = null;
let lastSpRef = null;

function getProducts() {
  const dp = dropbuyProducts();
  const sp = sourceProducts();
  if (combinedCache && dp === lastDpRef && sp === lastSpRef) {
    return combinedCache;
  }
  lastDpRef = dp;
  lastSpRef = sp;
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
