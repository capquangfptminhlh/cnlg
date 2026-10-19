const fs = require('fs');
const path = require('path');
const scraper = require('./dropbuyScraper');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Tuỳ chọn: đẩy giá niêm yết mới sang DB của dropbuy-api (bản clone).
// Bật bằng DROPBUY_API_DIR=D:/dropbuy-api trong .env (trước đây hard-code đường dẫn và ghi nhầm giá bán lẻ vào price_public).
let prisma = null;
if (process.env.DROPBUY_API_DIR) {
  try {
    const dir = process.env.DROPBUY_API_DIR.replace(/\\/g, '/');
    const { PrismaClient } = require(`${dir}/node_modules/@prisma/client`);
    prisma = new PrismaClient({ datasources: { db: { url: `file:${dir}/prisma/dev.db` } } });
  } catch (e) {
    console.warn('[RealtimeSync] Không thể nạp Prisma của dropbuy-api:', e.message);
  }
}

let syncTimer = null;
let isSyncing = false;
let lastSyncTime = null;
let nextSyncTime = null;
let lastChangesCount = 0;
let lastError = null;
let syncIntervalMs = 5 * 60 * 1000;

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

/**
 * Bắt đầu tiến trình đồng bộ định kỳ giá & tồn kho
 */
function startRealtimeSync(io, intervalMs = 5 * 60 * 1000) {
  syncIntervalMs = intervalMs;
  if (syncTimer) clearInterval(syncTimer);

  nextSyncTime = new Date(Date.now() + 5000).toISOString();
  console.log(`[RealtimeSync] ⚡ Đồng bộ giá & tồn kho mỗi ${Math.round(intervalMs / 60000)} phút.`);

  setTimeout(() => {
    runFullSync5Min(io).catch(err => console.error('[RealtimeSync Error]:', err.message));
  }, 5000);

  syncTimer = setInterval(() => {
    runFullSync5Min(io).catch(err => console.error('[RealtimeSync Error]:', err.message));
  }, syncIntervalMs);
}

/**
 * Quét toàn bộ kho DropBuy để cập nhật giá (sỉ nếu đã đăng nhập) và tồn kho
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
    const markup = scraper.getMarkup(config);
    const existingProducts = scraper.getProducts();
    const existingMap = new Map(existingProducts.map(p => [p.id, p]));

    const { items, totalRecords, complete } = await scraper.fetchAllSearchItems(config);
    if (items.length === 0) throw new Error('DropBuy không trả về sản phẩm nào');
    const priceMap = await scraper.fetchWholesalePrices(items, config);
    console.log(`[RealtimeSync] Đã tải ${items.length}/${totalRecords} SP (giá sỉ: ${priceMap.size}).`);

    let priceChangeCount = 0;
    let stockChangeCount = 0;
    let newProductCount = 0;
    const changedList = [];
    const liveIds = new Set();

    for (const item of items) {
      const fresh = scraper.mapItem(item, { markup, priceMap });
      liveIds.add(fresh.id);
      const current = existingMap.get(fresh.id);

      if (!current) {
        newProductCount++;
        existingProducts.push(fresh);
        existingMap.set(fresh.id, fresh);
        continue;
      }

      const priceDiff = current.price !== fresh.price || current.dropbuy_cost !== fresh.dropbuy_cost;
      const stockDiff = current.in_stock !== fresh.in_stock;
      if (priceDiff) priceChangeCount++;
      if (stockDiff) stockChangeCount++;
      if (priceDiff || stockDiff) {
        changedList.push({ id: fresh.id, name: current.name, oldPrice: current.price, newPrice: fresh.price, publicPrice: fresh.public_price, oldStock: current.in_stock, newStock: fresh.in_stock });
      }
      // Luôn làm mới toàn bộ trường lấy từ DropBuy (tên, ảnh, danh mục, giá, tồn...)
      Object.assign(current, fresh, { updated_at: priceDiff || stockDiff ? fresh.updated_at : current.updated_at });
      delete current.stock_qty; // trường cũ lấy nhầm từ `num` (thứ tự sắp xếp), không phải tồn kho
    }

    // Sản phẩm không còn trên DropBuy (chỉ kết luận khi đã quét đủ) → ngừng bán
    if (complete) {
      for (const p of existingProducts) {
        if (!liveIds.has(p.id) && p.in_stock !== false) {
          p.in_stock = false;
          p.removed_from_dropbuy = true;
          stockChangeCount++;
          changedList.push({ id: p.id, name: p.name, oldStock: true, newStock: false });
        }
      }
    }

    lastSyncTime = new Date().toISOString();
    nextSyncTime = new Date(Date.now() + syncIntervalMs).toISOString();
    lastChangesCount = priceChangeCount + stockChangeCount + newProductCount;
    lastError = null;

    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(existingProducts, null, 2), 'utf8');

    if (prisma && changedList.length) {
      try {
        for (const ch of changedList) {
          if (ch.publicPrice) await prisma.variation.updateMany({ where: { product_id: ch.id }, data: { price_public: ch.publicPrice } });
        }
        console.log(`[RealtimeSync] Đã cập nhật ${changedList.length} SP vào DB dropbuy-api.`);
      } catch (dbErr) {
        console.warn('[RealtimeSync DB update warning]:', dbErr.message);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[RealtimeSync] ✅ Xong sau ${duration}s. Tổng SP: ${existingProducts.length}. ${priceChangeCount} đổi giá, ${stockChangeCount} đổi tồn kho, ${newProductCount} SP mới.`);

    if (io) {
      if (lastChangesCount > 0) {
        io.emit('REALTIME_CATALOG_SYNC', {
          updatedAt: lastSyncTime,
          nextSyncTime,
          totalProducts: existingProducts.length,
          priceChangeCount,
          stockChangeCount,
          newProductCount,
          message: `Kho DropBuy vừa cập nhật: ${priceChangeCount} SP đổi giá, ${stockChangeCount} SP đổi tồn kho.`
        });
      } else {
        io.emit('REALTIME_HEARTBEAT', { status: 'UP_TO_DATE', lastSyncTime, nextSyncTime, totalProducts: existingProducts.length });
      }
    }
  } catch (err) {
    lastError = err.message;
    nextSyncTime = new Date(Date.now() + syncIntervalMs).toISOString();
    console.error('[RealtimeSync Error]:', err.message);
  } finally {
    isSyncing = false;
  }
}

function getSyncStatus() {
  return {
    active: !!syncTimer,
    intervalMinutes: Math.round(syncIntervalMs / 60000),
    intervalSeconds: Math.round(syncIntervalMs / 1000),
    isSyncing,
    lastSyncTime,
    nextSyncTime,
    lastChangesCount,
    lastError,
    totalProducts: scraper.getProducts().length
  };
}

module.exports = {
  startRealtimeSync,
  runFullSync5Min,
  getSyncStatus
};
