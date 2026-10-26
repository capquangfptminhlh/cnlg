'use strict';
const fs = require('fs');
const path = require('path');
const techmallAuth = require('./techmallAuth');
const pricing = require('./pricing');
const { sanitizeHtml, stripSupplierText } = require('./security');
const { maskMediaUrl } = require('./catalogImage');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TECHMALL_PRODUCTS_FILE = path.join(DATA_DIR, 'techmall_products.json');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const TECHMALL_BASE_URL = 'https://techmall.vn';

/** Đọc cấu hình bảng giá riêng cho TechMall */
function getTechmallPricingRules(cfg = techmallAuth.readConfig()) {
  const raw = cfg.pricing_techmall || {
    markupPercent: 15,
    base: 'wholesale',
    minProfit: 0,
    roundTo: 1000,
    capAtPublic: false,
    categoryMarkups: {},
    productOverrides: {}
  };
  return pricing.normalizeRules(raw);
}

/** Đọc danh sách sản phẩm TechMall đã lưu */
function getTechmallProducts() {
  try {
    if (fs.existsSync(TECHMALL_PRODUCTS_FILE)) {
      return JSON.parse(fs.readFileSync(TECHMALL_PRODUCTS_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

/** Lưu danh sách sản phẩm TechMall */
function saveTechmallProducts(list) {
  const tmp = `${TECHMALL_PRODUCTS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, TECHMALL_PRODUCTS_FILE);
}

/** Trích xuất số tiền an toàn */
function parseVnd(val) {
  if (typeof val === 'number') return val;
  const s = String(val || '').replace(/[^\d]/g, '');
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Bóc tách ảnh đại diện từ item hoặc trang sản phẩm */
function extractImage(item) {
  if (Array.isArray(item.images) && item.images.length > 0 && item.images[0].src) {
    return item.images[0].src;
  }
  const desc = item.description || item.short_description || '';
  const imgMatch = desc.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch && imgMatch[1]) {
    let src = imgMatch[1].trim();
    if (src.startsWith('//')) src = 'https:' + src;
    return src;
  }
  return null;
}

/** Chuyển đổi 1 item từ WooCommerce Store API sang format chuẩn Hoàng Minh Store */
function mapTechmallItem(item, rules = getTechmallPricingRules()) {
  const tmId = Number(item.id);
  // Quy tắc ID duy nhất: 200.000 + techmall_id -> không trùng với DropBuy (100.000 - 150.000)
  const unifiedId = 200000 + tmId;

  const rawPrice = parseVnd(item.prices?.price || item.prices?.sale_price || 0);
  const rawRegular = parseVnd(item.prices?.regular_price || item.prices?.price || 0);

  // Khi đã đăng nhập đại lý, item.prices.price phản ánh giá đại lý (wholesale)
  const cost = rawPrice > 0 ? rawPrice : rawRegular;
  const publicPrice = rawRegular >= cost ? rawRegular : cost;

  const catName = Array.isArray(item.categories) && item.categories.length > 0 ? item.categories[0].name : 'Phụ kiện công nghệ';

  // Tính giá bán theo bảng giá riêng TechMall
  const priceItem = {
    id: unifiedId,
    category_id: 9000,
    wholesale: cost,
    public_price: publicPrice
  };
  const computed = pricing.computePrice(priceItem, rules);

  const cleanName = stripSupplierText(item.name || '').replace(/&#8211;/g, '-').replace(/&#8217;/g, "'").trim();
  const rawDesc = item.description || item.short_description || '';
  const cleanDesc = stripSupplierText(sanitizeHtml(rawDesc));

  // Kiểm tra thời hạn bảo hành từ mô tả
  let warranty = 'Bảo hành chính hãng 12 tháng';
  const wMatch = cleanDesc.match(/bảo\s*hành\s*(\d+)\s*(ngày|tháng|năm)/i);
  if (wMatch) {
    warranty = `Bảo hành ${wMatch[1]} ${wMatch[2].toLowerCase()}`;
  } else if (/không\s*bảo\s*hành/i.test(cleanDesc)) {
    warranty = 'Không bảo hành (Đồng kiểm khi nhận)';
  }

  // Ảnh đại diện
  let image = extractImage(item);
  if (!image) {
    // Dự phòng ảnh dựa trên slug
    image = `https://techmall.vn/wp-content/uploads/products/${item.slug}.jpg`;
  }

  return {
    id: unifiedId,
    supplier: 'techmall',
    techmall_id: tmId,
    name: cleanName,
    slug: item.slug || String(unifiedId),
    sku: item.sku || `TM-${tmId}`,
    price: computed.price,
    cost: cost,
    wholesale_price: cost,
    original_price: publicPrice > computed.price ? publicPrice : (computed.original_price || null),
    discount_percent: computed.discount_percent || 0,
    in_stock: item.is_in_stock !== false,
    image: image,
    gallery: Array.isArray(item.images) ? item.images.map(i => ({ url: i.src, thumb: i.src })) : [],
    category_id: 9000,
    category_name: catName,
    warranty: warranty,
    description: cleanDesc,
    has_options: !!item.has_options,
    permalink: item.permalink || `${TECHMALL_BASE_URL}/san-pham/${item.slug}/`,
    updated_at: new Date().toISOString()
  };
}

/** Tải 1 trang sản phẩm từ WooCommerce Store API của TechMall */
async function fetchProductsPage(page = 1, perPage = 100) {
  const url = `${TECHMALL_BASE_URL}/wp-json/wc/store/v1/products?per_page=${perPage}&page=${page}`;
  const headers = techmallAuth.getAuthHeaders();

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    throw new Error(`TechMall API returned HTTP ${res.status}`);
  }

  const text = await res.text();
  const startIdx = text.indexOf('[');
  if (startIdx === -1) {
    return { items: [], total: 0, totalPages: 0 };
  }

  const json = JSON.parse(text.slice(startIdx));
  const total = Number(res.headers.get('x-wp-total') || 0);
  const totalPages = Number(res.headers.get('x-wp-totalpages') || 0);

  return { items: json, total, totalPages };
}

/** Hợp nhất sản phẩm TechMall vào data/products.json của toàn bộ cửa hàng */
function mergeWithMainCatalog(techmallItems) {
  let mainCatalog = [];
  try {
    if (fs.existsSync(PRODUCTS_FILE)) {
      mainCatalog = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
    }
  } catch (e) {}

  // Lọc giữ lại toàn bộ sản phẩm không phải của TechMall (ví dụ DropBuy)
  const otherItems = mainCatalog.filter(p => p.supplier !== 'techmall');

  // Đưa TechMall items mới vào
  const merged = [...otherItems, ...techmallItems];

  const tmp = `${PRODUCTS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, PRODUCTS_FILE);

  console.log(`[TechMallScraper] Đã hợp nhất ${techmallItems.length} SP TechMall vào catalog chính (Tổng SP: ${merged.length})`);
  return merged;
}

/** Tải toàn bộ kho hoặc N trang sản phẩm từ TechMall.vn */
async function syncTechmallCatalog(maxPages = 20) {
  const rules = getTechmallPricingRules();
  console.log(`[TechMallScraper] Bắt đầu quét kho TechMall.vn (Tối đa ${maxPages} trang x 100 SP)...`);

  const allItems = [];
  let page = 1;
  let totalPages = 1;

  while (page <= maxPages && page <= totalPages) {
    try {
      console.log(`[TechMallScraper] Đang tải trang ${page}/${totalPages}...`);
      const data = await fetchProductsPage(page, 100);
      totalPages = data.totalPages || totalPages;

      if (!data.items.length) break;

      for (const raw of data.items) {
        try {
          const mapped = mapTechmallItem(raw, rules);
          allItems.push(mapped);
        } catch (err) {
          // Bỏ qua item lỗi
        }
      }

      page++;
      // Giãn cách nhẹ 200ms giữa các trang để tránh tải quá tải máy chủ
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.warn(`[TechMallScraper] Lỗi trang ${page}:`, err.message);
      break;
    }
  }

  if (allItems.length > 0) {
    saveTechmallProducts(allItems);
    mergeWithMainCatalog(allItems);
  }

  // Cập nhật trạng thái vào config
  const cfg = techmallAuth.readConfig();
  if (!cfg.techmall) cfg.techmall = {};
  cfg.techmall.totalProducts = allItems.length;
  cfg.techmall.lastCatalogSyncAt = new Date().toISOString();
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');

  return {
    success: true,
    totalFetched: allItems.length,
    pagesScanned: page - 1
  };
}

module.exports = {
  getTechmallPricingRules,
  getTechmallProducts,
  saveTechmallProducts,
  mapTechmallItem,
  fetchProductsPage,
  mergeWithMainCatalog,
  syncTechmallCatalog
};
