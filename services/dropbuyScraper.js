const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DROPBUY_API_SEARCH = 'https://dropbuy.vn/api/proxy/bff/variations/search';
const DROPBUY_API_PRICE = 'https://dropbuy.vn/api/proxy/bff/variations/get-price';
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

/** % lợi nhuận cộng thêm. Cho phép 0% (không dùng `||` để 0 không bị đổi thành 15). */
function getMarkup(config = getConfig()) {
  const m = Number(config.pricing?.markupPercent);
  return Number.isFinite(m) && m >= 0 ? m / 100 : 0.15;
}

function dropbuyHeaders(config = getConfig()) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Origin': 'https://dropbuy.vn',
    'Referer': 'https://dropbuy.vn/'
  };
  if (config.dropbuy?.cookieHeader) headers['Cookie'] = config.dropbuy.cookieHeader;
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

/** Chuyển 1 item tìm kiếm của DropBuy thành sản phẩm của hoangminh.com. */
function mapItem(item, { markup, priceMap }) {
  const pid = item.product_id || item.id;
  const publicPrice = Number(item.price_public || item.regular_price || 0);
  const wholesale = priceMap?.get(item.unique_id);
  const cost = wholesale ? wholesale.cost : publicPrice;
  const retailPrice = Math.round((cost * (1 + markup)) / 1000) * 1000;
  return {
    id: pid,
    dropbuy_id: pid,
    variation_id: item.unique_id || null,
    sku: item.sku || `DB-${pid}`,
    name: item.product_name || item.name,
    slug: item.slug || `san-pham-${pid}`,
    dropbuy_url: `https://dropbuy.vn/${item.slug}_p${pid}`,
    category_id: item.category_id,
    category_name: item.category_name,
    price: retailPrice,
    // Chỉ hiện giá gạch ngang khi có giá tham chiếu thật (giá niêm yết DropBuy) cao hơn giá bán
    original_price: publicPrice > retailPrice ? publicPrice : null,
    dropbuy_cost: cost,
    public_price: publicPrice,
    profit_margin: retailPrice - cost,
    is_wholesale_price: !!wholesale,
    image: formatImageUrl(item.res_thumbnail_url, '256x256'),
    image_hd: formatImageUrl(item.res_thumbnail_url, '1024x1024'),
    in_stock: item.in_stock !== false,
    warranty: item.warranty_duration ? `${item.warranty_duration} tháng` : 'Bảo hành chính hãng',
    is_mall: !!item.shop_is_mall,
    shop_name: item.shop_name || null,
    is_flash_sale: !!item.is_flash_sale,
    updated_at: new Date().toISOString()
  };
}

// Sync catalog: page by page until complete or up to maxItems
async function syncCatalog(options = {}) {
  const { maxPages = 20, pageSize = 100, onProgress } = options;
  const config = getConfig();
  const markup = getMarkup(config);

  console.log(`[Scraper] Starting full catalog sync from Dropbuy (Markup: +${markup * 100}%)...`);
  await syncCategories();

  const { items, totalRecords } = await fetchAllSearchItems(config, { maxPages, pageSize, onProgress });
  const priceMap = await fetchWholesalePrices(items, config);
  console.log(`[Scraper] Đã tải ${items.length}/${totalRecords} SP; giá sỉ F1: ${priceMap.size} SP${config.dropbuy?.cookieHeader ? '' : ' (chưa đăng nhập DropBuy → dùng giá công khai)'}`);

  const map = new Map();
  for (const item of items) {
    const p = mapItem(item, { markup, priceMap });
    if (!map.has(p.id)) map.set(p.id, p);
  }
  const uniqueProducts = Array.from(map.values());

  // Không ghi đè cache bằng danh sách rỗng khi DropBuy lỗi
  if (uniqueProducts.length === 0) {
    console.warn('[Scraper] Không tải được sản phẩm nào – giữ nguyên dữ liệu cũ.');
    return getProducts();
  }
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(uniqueProducts, null, 2), 'utf8');
  console.log(`[Scraper] DONE! Successfully saved ${uniqueProducts.length} products to ${PRODUCTS_FILE}`);
  return uniqueProducts;
}

// Get loaded products
function getProducts() {
  try {
    if (fs.existsSync(PRODUCTS_FILE)) {
      return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
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
  getMarkup,
  getProducts,
  getCategories,
  formatImageUrl,
  cleanCategoryName
};
