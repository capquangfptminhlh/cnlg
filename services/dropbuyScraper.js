const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DROPBUY_API_SEARCH = 'https://dropbuy.vn/api/proxy/bff/variations/search';
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
      name: c.name,
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

// Sync catalog: page by page until complete or up to maxItems
async function syncCatalog(options = {}) {
  const { maxPages = 20, pageSize = 100, onProgress } = options;
  const config = getConfig();
  const markup = (config.pricing && config.pricing.markupPercent) ? config.pricing.markupPercent / 100 : 0.15;

  console.log(`[Scraper] Starting full catalog sync from Dropbuy (Markup: +${markup * 100}%)...`);
  
  // Ensure categories are synced first
  await syncCategories();

  let allProducts = [];
  let pageNum = 1;
  let totalRecords = 0;

  while (pageNum <= maxPages) {
    try {
      const payload = {
        page_num: pageNum,
        page_size: pageSize,
        in_stock_mode: 'ALL'
      };

      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://dropbuy.vn',
        'Referer': 'https://dropbuy.vn/'
      };
      if (config.dropbuy?.cookieHeader) {
        headers['Cookie'] = config.dropbuy.cookieHeader;
      }

      const res = await fetch(DROPBUY_API_SEARCH, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        console.error(`[Scraper] Page ${pageNum} returned HTTP ${res.status}`);
        break;
      }

      const json = await res.json();
      if (!json.success || !json.data || !Array.isArray(json.data.items)) {
        console.warn(`[Scraper] Page ${pageNum} had unexpected format:`, json);
        break;
      }

      const items = json.data.items;
      totalRecords = json.data.total_records || items.length;

      if (items.length === 0) break;

      for (const item of items) {
        // Giá sỉ đại lý DropBuy (ưu tiên fe_price_override / price_f1 / price_good nếu đã đăng nhập)
        const wholesaleCost = item.fe_price_override || item.price_f1 || item.price_good || item.price_public || item.regular_price || 0;
        const publicRetailPrice = item.price_public || item.regular_price || wholesaleCost;
        
        // Giá bán trên hoangminh.com = Giá nhập sỉ + Markup (hoặc theo giá công khai nếu cấu hình)
        const retailPrice = Math.round((wholesaleCost * (1 + markup)) / 1000) * 1000;
        
        allProducts.push({
          id: item.product_id || item.id,
          dropbuy_id: item.product_id || item.id,
          sku: item.sku || `DB-${item.product_id}`,
          name: item.product_name || item.name,
          slug: item.slug || `san-pham-${item.product_id}`,
          dropbuy_url: `https://dropbuy.vn/${item.slug}_p${item.product_id}`,
          category_id: item.category_id,
          category_name: item.category_name,
          price: retailPrice,
          original_price: publicRetailPrice > retailPrice ? publicRetailPrice : Math.round((retailPrice * 1.2) / 1000) * 1000,
          dropbuy_cost: wholesaleCost,
          public_price: publicRetailPrice,
          profit_margin: retailPrice - wholesaleCost,
          is_wholesale_price: wholesaleCost < publicRetailPrice,
          image: formatImageUrl(item.res_thumbnail_url, '256x256'),
          image_hd: formatImageUrl(item.res_thumbnail_url, '1024x1024'),
          in_stock: item.in_stock !== false,
          stock_qty: item.num || 99,
          warranty: item.warranty_duration ? `${item.warranty_duration} tháng` : 'Bảo hành chính hãng',
          is_mall: !!item.shop_is_mall,
          updated_at: new Date().toISOString()
        });
      }

      console.log(`[Scraper] Synced page ${pageNum} (${allProducts.length}/${totalRecords} products)...`);
      if (onProgress) onProgress({ current: allProducts.length, total: totalRecords, page: pageNum });

      if (allProducts.length >= totalRecords) break;
      pageNum++;

      // Small throttle to be courteous
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`[Scraper] Error fetching page ${pageNum}:`, err.message);
      break;
    }
  }

  // De-duplicate by product ID
  const map = new Map();
  for (const p of allProducts) {
    if (!map.has(p.id)) {
      map.set(p.id, p);
    }
  }
  const uniqueProducts = Array.from(map.values());

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
      return JSON.parse(fs.readFileSync(CATEGORIES_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

module.exports = {
  syncCategories,
  syncCatalog,
  getProducts,
  getCategories,
  formatImageUrl
};
