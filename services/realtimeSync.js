const fs = require('fs');
const path = require('path');
const scraper = require('./dropbuyScraper');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Khởi tạo kết nối Prisma vào D:\dropbuy-api\prisma\dev.db
let prisma = null;
try {
  const { PrismaClient } = require('D:/dropbuy-api/node_modules/@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url: 'file:D:/dropbuy-api/prisma/dev.db' } } });
} catch (e) {
  console.warn('[RealtimeSync] Không thể nạp Prisma trực tiếp:', e.message);
}

let syncTimer = null;
let isSyncing = false;
let lastSyncTime = null;
let nextSyncTime = null;
let lastChangesCount = 0;
let syncIntervalMs = 5 * 60 * 1000; // 5 phút / lần (300,000 ms)

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

/**
 * Bắt đầu tiến trình nạp liên tục 5 phút / lần cho toàn bộ giá & tồn kho
 * @param {Object} io - Socket.io instance
 * @param {number} intervalMs - Khoảng thời gian (mặc định 5 phút)
 */
function startRealtimeSync(io, intervalMs = 5 * 60 * 1000) {
  syncIntervalMs = intervalMs;
  if (syncTimer) clearInterval(syncTimer);

  nextSyncTime = new Date(Date.now() + 5000).toISOString();
  console.log(`[RealtimeSync] ⚡ KÍCH HOẠT ĐỒNG BỘ LIÊN TỤC 5 PHÚT / 1 LẦN (Toàn bộ giá & tồn kho 1.316 SP)...`);

  // Chạy lần đầu sau 5 giây khi server khởi động
  setTimeout(() => {
    runFullSync5Min(io).catch(err => console.error('[RealtimeSync Error]:', err.message));
  }, 5000);

  // Lặp lại liên tục đúng 5 phút một lần
  syncTimer = setInterval(async () => {
    try {
      await runFullSync5Min(io);
    } catch (err) {
      console.error('[RealtimeSync Error]:', err.message);
    }
  }, syncIntervalMs);
}

/**
 * Quét toàn bộ 100% kho DropBuy (1.316 SP) để cập nhật giá sỉ và tồn kho
 */
async function runFullSync5Min(io) {
  if (isSyncing) {
    console.log('[RealtimeSync] Tiến trình trước đang chạy, bỏ qua chu kỳ này...');
    return;
  }
  isSyncing = true;
  const startTime = Date.now();

  try {
    const config = getConfig();
    const existingProducts = scraper.getProducts();
    const existingMap = new Map(existingProducts.map(p => [p.id, p]));
    const markup = (config.pricing?.markupPercent || 15) / 100;

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': 'https://dropbuy.vn',
      'Referer': 'https://dropbuy.vn/'
    };
    if (config.dropbuy?.cookieHeader) {
      headers['Cookie'] = config.dropbuy.cookieHeader;
    }

    console.log(`[RealtimeSync 5m] Bắt đầu quét 100% sản phẩm từ DropBuy (Chu kỳ 5 phút)...`);

    let pageNum = 1;
    let totalRecords = 1316;
    const allLiveItems = [];

    // Quét toàn bộ các trang (100 SP / trang)
    while (pageNum <= 20) {
      try {
        const res = await fetch('https://dropbuy.vn/api/proxy/bff/variations/search', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            page_num: pageNum,
            page_size: 100,
            in_stock_mode: 'ALL'
          })
        });

        if (!res.ok) break;
        const json = await res.json();
        if (!json.success || !json.data || !Array.isArray(json.data.items)) break;

        const items = json.data.items;
        totalRecords = json.data.total_records || totalRecords;
        if (items.length === 0) break;

        allLiveItems.push(...items);
        pageNum++;
      } catch (e) {
        console.error(`[RealtimeSync 5m] Lỗi trang ${pageNum}:`, e.message);
        break;
      }
    }

    console.log(`[RealtimeSync 5m] Đã tải về ${allLiveItems.length}/${totalRecords} sản phẩm từ DropBuy.`);

    let priceChangeCount = 0;
    let stockChangeCount = 0;
    let newProductCount = 0;
    const changedList = [];

    for (const item of allLiveItems) {
      const pid = item.product_id || item.id;
      const wholesaleCost = item.fe_price_override || item.price_f1 || item.price_good || item.price_public || item.regular_price || 0;
      const publicPrice = item.price_public || item.regular_price || wholesaleCost;
      const retailPrice = Math.round((wholesaleCost * (1 + markup)) / 1000) * 1000;
      const inStock = item.in_stock !== false;
      const stockQty = item.num || 99;

      const current = existingMap.get(pid);

      if (!current) {
        newProductCount++;
        const newProd = {
          id: pid,
          dropbuy_id: pid,
          sku: item.sku || `DB-${pid}`,
          name: item.product_name || item.name,
          slug: item.slug || `san-pham-${pid}`,
          dropbuy_url: `https://dropbuy.vn/${item.slug}_p${pid}`,
          category_id: item.category_id,
          category_name: item.category_name,
          price: retailPrice,
          original_price: publicPrice > retailPrice ? publicPrice : Math.round((retailPrice * 1.2) / 1000) * 1000,
          dropbuy_cost: wholesaleCost,
          public_price: publicPrice,
          profit_margin: retailPrice - wholesaleCost,
          is_wholesale_price: wholesaleCost < publicPrice,
          image: item.res_thumbnail_url?.startsWith('http') ? item.res_thumbnail_url : `https://r6i.pen.dropbuy.vn${item.res_thumbnail_url?.replace('_128x128', '_256x256') || ''}`,
          image_hd: item.res_thumbnail_url?.startsWith('http') ? item.res_thumbnail_url : `https://r6i.pen.dropbuy.vn${item.res_thumbnail_url?.replace('_128x128', '_1024x1024') || ''}`,
          in_stock: inStock,
          stock_qty: stockQty,
          warranty: item.warranty_duration ? `${item.warranty_duration} tháng` : 'Bảo hành chính hãng',
          is_mall: !!item.shop_is_mall,
          updated_at: new Date().toISOString()
        };
        existingProducts.push(newProd);
        existingMap.set(pid, newProd);
      } else {
        const priceDiff = Math.abs(current.price - retailPrice) > 500;
        const stockDiff = current.in_stock !== inStock || (stockQty > 0 && current.stock_qty !== stockQty);

        if (priceDiff || stockDiff) {
          if (priceDiff) priceChangeCount++;
          if (stockDiff) stockChangeCount++;

          changedList.push({
            id: pid,
            name: current.name,
            oldPrice: current.price,
            newPrice: retailPrice,
            oldStock: current.in_stock,
            newStock: inStock
          });

          // Cập nhật thuộc tính
          current.price = retailPrice;
          current.dropbuy_cost = wholesaleCost;
          current.public_price = publicPrice;
          current.profit_margin = retailPrice - wholesaleCost;
          current.in_stock = inStock;
          current.stock_qty = stockQty;
          current.updated_at = new Date().toISOString();
        }
      }
    }

    lastSyncTime = new Date().toISOString();
    nextSyncTime = new Date(Date.now() + syncIntervalMs).toISOString();
    lastChangesCount = priceChangeCount + stockChangeCount + newProductCount;

    // Lưu lại file products.json
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(existingProducts, null, 2), 'utf8');

    // Đồng bộ nhanh vào Prisma SQLite DB nếu có Prisma
    if (prisma && (priceChangeCount > 0 || stockChangeCount > 0 || newProductCount > 0)) {
      try {
        for (const ch of changedList) {
          await prisma.variation.updateMany({
            where: { product_id: ch.id },
            data: { price_public: ch.newPrice }
          });
        }
        console.log(`[RealtimeSync 5m] Đã cập nhật ${changedList.length} SP vào D:\\dropbuy-api\\prisma\\dev.db.`);
      } catch (dbErr) {
        console.warn('[RealtimeSync DB update warning]:', dbErr.message);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[RealtimeSync 5m] ✅ Hoàn tất quét sau ${duration}s. Tổng SP: ${existingProducts.length}. Biến động: ${priceChangeCount} đổi giá, ${stockChangeCount} đổi tồn kho, ${newProductCount} SP mới.`);

    // Bắn realtime WebSocket tới toàn bộ người dùng đang online
    if (io) {
      if (lastChangesCount > 0) {
        io.emit('REALTIME_CATALOG_SYNC', {
          updatedAt: lastSyncTime,
          nextSyncTime,
          totalProducts: existingProducts.length,
          priceChangeCount,
          stockChangeCount,
          newProductCount,
          message: `Kho DropBuy vừa đồng bộ realtime: ${priceChangeCount} SP đổi giá, ${stockChangeCount} SP đổi tồn kho.`
        });
      } else {
        io.emit('REALTIME_HEARTBEAT', {
          status: 'UP_TO_DATE',
          lastSyncTime,
          nextSyncTime,
          totalProducts: existingProducts.length,
          message: 'Kho hàng & tồn kho đang đồng bộ 100% với DropBuy.'
        });
      }
    }

  } catch (err) {
    console.error('[RealtimeSync 5m Error]:', err.message);
  } finally {
    isSyncing = false;
  }
}

function getSyncStatus() {
  return {
    active: true,
    intervalMinutes: Math.round(syncIntervalMs / 60000),
    intervalSeconds: Math.round(syncIntervalMs / 1000),
    isSyncing,
    lastSyncTime,
    nextSyncTime,
    lastChangesCount,
    totalProducts: scraper.getProducts().length
  };
}

module.exports = {
  startRealtimeSync,
  runFullSync5Min,
  getSyncStatus
};
