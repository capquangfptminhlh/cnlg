const fs = require('fs');
const path = require('path');
const pricing = require('./pricing');
const dropbuySession = require('./dropbuySession');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DROPBUY_API_SEARCH = 'https://dropbuy.vn/api/proxy/bff/variations/search';
const DROPBUY_API_PRICE = 'https://dropbuy.vn/api/proxy/bff/variations/get-price';
const DROPBUY_API_IN_STOCK = 'https://dropbuy.vn/api/proxy/bff/variations/in-stock';
const DROPBUY_CATEGORIES_URL = 'https://r6s.pen.dropbuy.vn/dalon-web-public/categories/categories-all.json';
const CDN_BASE = 'https://r6i.pen.dropbuy.vn';

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return { pricing: { markupPercent: 15 } };
}

/** Quy tắc giá bán (xem services/pricing.js) + bản đồ danh mục con → gốc */
function getPricingContext(config = getConfig()) {
  return { rules: pricing.normalizeRules(config.pricing || {}), rootMap: pricing.rootCategoryMap(getCategories()) };
}

/** Giữ tương thích: % lãi mặc định dạng thập phân */
function getMarkup(config = getConfig()) {
  return pricing.normalizeRules(config.pricing || {}).markupPercent / 100;
}

function dropbuyHeaders(config = getConfig()) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Origin': 'https://dropbuy.vn',
    'Referer': 'https://dropbuy.vn/'
  };
  if (config.dropbuy?.cookieHeader) headers['Cookie'] = config.dropbuy.cookieHeader;
  // BFF xác thực bằng sid của phiên (cookie không đủ)
  const sid = dropbuySession.currentSid(config);
  if (sid) headers['x-foxing-sid'] = sid;
  return headers;
}

// Format image URL from Dropbuy relative path
function formatImageUrl(pathOrUrl, size = '256x256') {
  if (!pathOrUrl) return 'https://dropbuy.vn/d/logo.png';
  if (pathOrUrl.startsWith('http')) return pathOrUrl;

  // Dropbuy CDN only supports _128x128, _256x256, _1024x1024
  let p = pathOrUrl;
  const validSize = (size === '1024x1024' || size === '128x128') ? size : '256x256';
  if (p.includes('_128x128')) {
    p = p.replace('_128x128', `_${validSize}`);
  }
  if (!p.startsWith('/')) p = '/' + p;
  return `${CDN_BASE}${p}`;
}

/** Tên danh mục gốc của DropBuy có dấu ";" thay cho dấu phẩy (vd "Tivi ; máy chiếu"). */
function cleanCategoryName(name) {
  return String(name || '').replace(/\s*;\s*/g, ', ').replace(/\s*,\s*/g, ', ').replace(/\s{2,}/g, ' ').trim();
}

// Fetch all categories from Dropbuy CDN
async function syncCategories() {
  try {
    const res = await fetch(DROPBUY_CATEGORIES_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const formatted = data.map(c => ({
      id: c.id,
      name: cleanCategoryName(c.name),
      slug: c.slug || `category-${c.id}`,
      parent_id: c.parent_id || null,
      icon: c.image_url ? formatImageUrl(c.image_url) : null
    }));

    fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(formatted, null, 2), 'utf8');
    console.log(`[Scraper] Synced ${formatted.length} categories from Dropbuy.`);
    return formatted;
  } catch (err) {
    console.error('[Scraper] Error syncing categories:', err.message);
    if (fs.existsSync(CATEGORIES_FILE)) {
      return JSON.parse(fs.readFileSync(CATEGORIES_FILE, 'utf8'));
    }
    return [];
  }
}

/** Tải toàn bộ danh sách sản phẩm (biến thể chính) từ API tìm kiếm của DropBuy. */
async function fetchAllSearchItems(config = getConfig(), { maxPages = 20, pageSize = 100, onProgress } = {}) {
  const items = [];
  let totalRecords = 0;
  let complete = false;
  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const res = await fetch(DROPBUY_API_SEARCH, {
      method: 'POST',
      headers: dropbuyHeaders(config),
      body: JSON.stringify({ page_num: pageNum, page_size: pageSize, in_stock_mode: 'ALL' })
    });
    if (!res.ok) {
      console.error(`[Scraper] Page ${pageNum} returned HTTP ${res.status}`);
      break;
    }
    const json = await res.json();
    if (!json.success || !json.data || !Array.isArray(json.data.items)) {
      console.warn(`[Scraper] Page ${pageNum} had unexpected format`);
      break;
    }
    totalRecords = json.data.total_records || totalRecords;
    if (json.data.items.length === 0) { complete = true; break; }
    items.push(...json.data.items);
    if (onProgress) onProgress({ current: items.length, total: totalRecords, page: pageNum });
    if (items.length >= totalRecords) { complete = true; break; }
    await new Promise(r => setTimeout(r, 200)); // giãn nhịp, tránh dồn tải lên DropBuy
  }
  return { items, totalRecords, complete };
}

/**
 * Giá sỉ đại lý: API tìm kiếm chỉ trả `price_public`, giá F1 phải lấy qua `variations/get-price`
 * (cần phiên đăng nhập DropBuy). `unique_id` của item tìm kiếm chính là variation_id của biến thể chính.
 * Trả về Map<variation_id, { cost, source, fs_program_code }>. Không đăng nhập → Map rỗng.
 */
async function fetchWholesalePrices(items, config = getConfig()) {
  const map = new Map();
  if (!config.dropbuy?.cookieHeader) return map;
  const session = await dropbuySession.ensureSession(config).catch(() => null);
  if (!session) {
    console.warn('[Scraper] Phiên DropBuy hết hạn – dùng giá công khai cho tới khi đăng nhập lại.');
    return map;
  }
  const reqItems = items.filter(i => i.unique_id && i.product_id).map(i => ({ variation_id: i.unique_id, product_id: i.product_id }));
  for (let i = 0; i < reqItems.length; i += 50) {
    try {
      const res = await fetch(DROPBUY_API_PRICE, { method: 'POST', headers: dropbuyHeaders(config), body: JSON.stringify({ items: reqItems.slice(i, i + 50) }) });
      const json = await res.json().catch(() => null);
      if (!json?.success || !Array.isArray(json.data)) {
        console.warn(`[Scraper] Không lấy được giá sỉ (lô ${i / 50 + 1}): ${json?.message || res.status}`);
        if (json?.error_code === 401) break; // phiên hết hạn → dừng, dùng giá công khai
        continue;
      }
      for (const p of json.data) {
        // fe_price_group = giá theo nhóm đại lý (không tính flash sale có thời hạn)
        const cost = Number(p.fe_price_group || p.fe_price_override || 0);
        if (cost > 0) map.set(p.variation_id, { cost, source: p.fe_price_override_source || 'F1' });
      }
    } catch (e) {
      console.warn('[Scraper] Lỗi lấy giá sỉ:', e.message);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return map;
}

/**
 * Chuyển 1 item tìm kiếm của DropBuy thành sản phẩm của hoangminh.com.
 * opts: { ctx: getPricingContext(), priceMap, previous (SP cũ), keepWholesale (đang đăng nhập nhưng lô giá lỗi → giữ giá sỉ cũ) }
 */
function mapItem(item, { ctx = getPricingContext(), priceMap, previous, keepWholesale } = {}) {
  const pid = item.product_id || item.id;
  const publicPrice = Number(item.price_public || item.regular_price || 0);
  const live = priceMap?.get(item.unique_id);
  const wholesale = live ? live.cost : keepWholesale && previous?.wholesale_price ? previous.wholesale_price : null;
  const base = {
    id: pid,
    dropbuy_id: pid,
    variation_id: item.unique_id || null,
    sku: item.sku || `DB-${pid}`,
    name: item.product_name || item.name,
    slug: item.slug || `san-pham-${pid}`,
    dropbuy_url: `https://dropbuy.vn/${item.slug}_p${pid}`,
    category_id: item.category_id,
    category_name: item.category_name,
    public_price: publicPrice,
    wholesale_price: wholesale,
    image: formatImageUrl(item.res_thumbnail_url, '256x256'),
    image_hd: formatImageUrl(item.res_thumbnail_url, '1024x1024'),
    in_stock: item.in_stock !== false,
    warranty: item.warranty_duration ? `${item.warranty_duration} tháng` : 'Bảo hành chính hãng',
    is_mall: !!item.shop_is_mall,
    shop_name: item.shop_name || null,
    is_flash_sale: !!item.is_flash_sale,
    variant_count: Number(item.total_variations) || 1,
    updated_at: new Date().toISOString()
  };
  return applyPricing(base, ctx);
}

/** Tính lại giá bán của 1 SP theo quy tắc hiện tại (không cần gọi DropBuy). */
function applyPricing(p, ctx = getPricingContext()) {
  // computePrice đọc giá sỉ ở trường `wholesale`; catalog lưu ở `wholesale_price`
  const r = pricing.computePrice({ ...p, wholesale: p.wholesale_price }, ctx.rules, ctx.rootMap);
  p.price = r.price;
  p.original_price = r.original_price;
  p.dropbuy_cost = r.cost;
  p.profit_margin = r.price - r.cost;
  p.is_wholesale_price = r.base_used === 'wholesale';
  p.pricing_rule = r.rule;
  return p;
}

/** Tính lại toàn bộ catalog sau khi admin đổi quy tắc giá. Trả về danh sách SP đổi giá. */
function repriceAll(products, ctx = getPricingContext()) {
  const changed = [];
  for (const p of products) {
    const before = `${p.price}|${p.original_price}`;
    applyPricing(p, ctx);
    if (`${p.price}|${p.original_price}` !== before) changed.push(p);
  }
  return changed;
}

// Sync catalog: page by page until complete or up to maxItems
async function syncCatalog(options = {}) {
  const { maxPages = 20, pageSize = 100, onProgress } = options;
  const config = getConfig();
  const ctx = getPricingContext(config);

  console.log(`[Scraper] Starting full catalog sync from Dropbuy (lãi mặc định +${ctx.rules.markupPercent}%)...`);
  await syncCategories();

  const { items, totalRecords } = await fetchAllSearchItems(config, { maxPages, pageSize, onProgress });
  const priceMap = await fetchWholesalePrices(items, config);
  console.log(`[Scraper] Đã tải ${items.length}/${totalRecords} SP; giá sỉ F1: ${priceMap.size} SP${config.dropbuy?.cookieHeader ? '' : ' (chưa đăng nhập DropBuy → dùng giá công khai)'}`);

  const previous = new Map(getProducts().map(p => [p.id, p]));
  const map = new Map();
  for (const item of items) {
    const p = mapItem(item, { ctx, priceMap, previous: previous.get(item.product_id), keepWholesale: !!config.dropbuy?.cookieHeader });
    if (!map.has(p.id)) map.set(p.id, p);
  }
  const uniqueProducts = Array.from(map.values());

  // Không ghi đè cache bằng danh sách rỗng khi DropBuy lỗi
  if (uniqueProducts.length === 0) {
    console.warn('[Scraper] Không tải được sản phẩm nào – giữ nguyên dữ liệu cũ.');
    return getProducts();
  }
  // Tồn kho chuẩn theo API in-stock (cấp sản phẩm, giống nhãn hết hàng trên dropbuy.vn)
  try {
    const stock = await fetchStockMap(uniqueProducts.map(p => p.id), config);
    for (const p of uniqueProducts) if (stock.has(p.id)) p.in_stock = stock.get(p.id);
  } catch (e) {
    console.warn('[Scraper] Không lấy được tồn kho in-stock:', e.message);
  }
  saveProducts(uniqueProducts);
  console.log(`[Scraper] DONE! Successfully saved ${uniqueProducts.length} products to ${PRODUCTS_FILE}`);
  return uniqueProducts;
}

/**
 * Tồn kho realtime: `variations/in-stock` nhận danh sách product_ids, trả [{product_id, in_stock}].
 * ~1,6s cho toàn bộ ~1.300 SP → đủ nhanh để quét mỗi 30 giây.
 */
async function fetchStockMap(ids, config = getConfig(), batchSize = 700) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += batchSize) {
    const res = await fetch(DROPBUY_API_IN_STOCK, { method: 'POST', headers: dropbuyHeaders(config), body: JSON.stringify({ product_ids: ids.slice(i, i + batchSize) }) });
    if (!res.ok) throw new Error(`in-stock HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success || !Array.isArray(json.data)) throw new Error(`in-stock: ${json.message || 'dữ liệu không hợp lệ'}`);
    for (const r of json.data) map.set(r.product_id, !!r.in_stock);
  }
  return map;
}

/** Tra 1 sản phẩm trực tiếp trên DropBuy theo SKU (dùng khi khách đặt hàng / mở chi tiết). */
async function searchBySku(sku, config = getConfig()) {
  const res = await fetch(DROPBUY_API_SEARCH, { method: 'POST', headers: dropbuyHeaders(config), body: JSON.stringify({ page_num: 1, page_size: 5, in_stock_mode: 'ALL', keyword: sku }) });
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.message || 'search lỗi');
  return (json.data.items || []).find(i => i.sku === sku) || null;
}

// --- Bộ nhớ đệm sản phẩm: tránh parse lại file JSON ~1,3MB ở mỗi request ---
let productsCache = null;
let productsMtime = 0;

function getProducts() {
  try {
    if (!fs.existsSync(PRODUCTS_FILE)) return [];
    const mtime = fs.statSync(PRODUCTS_FILE).mtimeMs;
    if (!productsCache || mtime !== productsMtime) {
      productsCache = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
      productsMtime = mtime;
    }
    return productsCache.slice();
  } catch (e) {
    return productsCache ? productsCache.slice() : [];
  }
}

/** Ghi products.json an toàn (file tạm + đổi tên) và cập nhật bộ nhớ đệm. */
function saveProducts(list) {
  const tmp = `${PRODUCTS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, PRODUCTS_FILE);
  productsCache = list;
  productsMtime = fs.statSync(PRODUCTS_FILE).mtimeMs;
}

// Get loaded categories
function getCategories() {
  try {
    if (fs.existsSync(CATEGORIES_FILE)) {
      return JSON.parse(fs.readFileSync(CATEGORIES_FILE, 'utf8')).map(c => ({ ...c, name: cleanCategoryName(c.name) }));
    }
  } catch (e) {}
  return [];
}

module.exports = {
  syncCategories,
  syncCatalog,
  fetchAllSearchItems,
  fetchWholesalePrices,
  mapItem,
  applyPricing,
  repriceAll,
  getPricingContext,
  getMarkup,
  getConfig,
  fetchStockMap,
  searchBySku,
  getProducts,
  saveProducts,
  getCategories,
  formatImageUrl,
  cleanCategoryName
};
