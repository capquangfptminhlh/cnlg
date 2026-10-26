const scraper = require('./dropbuyScraper');
const dropbuySession = require('./dropbuySession');
const catalogImage = require('./catalogImage');
const { emitAdmin, stripSupplierText } = require('./security');

/**
 * Đồng bộ realtime với DropBuy – 2 vòng độc lập:
 *  - Vòng TỒN KHO (mặc định 30s sau khi lượt trước xong): `variations/in-stock` cho toàn bộ SP (~14.000 SP ≈ 15s).
 *  - Vòng GIÁ & CATALOG (mặc định 600s): quét toàn bộ kho CTV `variations/search` (~143 trang, song song)
 *    + giá sỉ F1 khi đã đăng nhập,
 *    phát hiện SP mới / SP bị gỡ.
 * Mọi thay đổi được đẩy qua Socket.IO dạng `PRODUCTS_UPDATED` (chỉ các SP đổi) để trang khách cập nhật tại chỗ.
 * Lỗi mạng → giãn nhịp lũy thừa (tối đa 10 phút) để không dồn request vào DropBuy.
 */

const STOCK_INTERVAL_MS = Math.max(10, Number(process.env.STOCK_SYNC_SECONDS || 30)) * 1000;
const PRICE_INTERVAL_MS = Math.max(30, Number(process.env.PRICE_SYNC_SECONDS || 600)) * 1000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
let lastCompleteTotal = 0; // tổng SP của lần quét đủ gần nhất

// Tuỳ chọn: đẩy giá niêm yết mới sang DB của dropbuy-api (bản clone). Bật bằng DROPBUY_API_DIR trong .env.
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

let ioRef = null;
const loops = {
  stock: { name: 'stock', baseMs: STOCK_INTERVAL_MS, timer: null, running: false, failures: 0, lastRun: null, lastOk: null, nextRun: null, lastError: null, lastChanges: 0, lastDurationMs: null },
  price: { name: 'price', baseMs: PRICE_INTERVAL_MS, timer: null, running: false, failures: 0, lastRun: null, lastOk: null, nextRun: null, lastError: null, lastChanges: 0, lastDurationMs: null }
};

// Khoá ghi: 2 vòng + kiểm tra khi đặt hàng không ghi đè products.json lẫn nhau
let writeChain = Promise.resolve();
function withCatalogLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

/** Thông tin công khai của SP (khớp với publicProduct trong server.js) để gửi qua socket */
function publicPatch(p) {
  const rawDiscount = p.original_price && p.original_price > p.price ? Math.round((1 - p.price / p.original_price) * 100) : 0;
  const discount = rawDiscount > 70 ? 0 : rawDiscount;
  const original = rawDiscount > 70 ? null : p.original_price;
  return { id: p.id, name: stripSupplierText(p.name), price: p.price, original_price: original, discount_percent: discount, in_stock: p.in_stock !== false, image: catalogImage.maskMediaUrl(p.image), category_id: p.category_id, variant_count: p.variant_count, warranty: stripSupplierText(p.warranty || '') };
}

function emitChanges(changed, meta = {}) {
  if (!ioRef || changed.length === 0) return;
  ioRef.emit('PRODUCTS_UPDATED', { at: new Date().toISOString(), source: meta.source, items: changed.map(publicPatch), newCount: meta.newCount || 0 });
}

// ───────────────────────── Vòng tồn kho ─────────────────────────
async function runStockSync() {
  return withCatalogLock(async () => {
    const config = scraper.getConfig();
    const products = scraper.getProducts();
    const dropbuyProducts = products.filter(p => !p.supplier || p.supplier === 'dropbuy');
    const stock = await scraper.fetchStockMap(dropbuyProducts.map(p => p.id), config);
    const changed = [];
    for (const p of products) {
      if (!stock.has(p.id)) continue;
      const inStock = stock.get(p.id);
      if ((p.in_stock !== false) !== inStock) {
        p.in_stock = inStock;
        p.updated_at = new Date().toISOString();
        changed.push(p);
      }
    }
    if (changed.length) scraper.saveProducts(products);
    emitChanges(changed, { source: 'stock' });
    return changed.length;
  });
}

// ───────────────────────── Vòng giá & catalog ─────────────────────────
async function runPriceSync() {
  const config = scraper.getConfig();
  const ctx = scraper.getPricingContext(config);
  const keepWholesale = !!config.dropbuy?.cookieHeader;
  // Tải dữ liệu từ DropBuy bên ngoài khoá (mất vài giây), chỉ khoá lúc ghép & ghi
  // Nạp phiên TRƯỚC khi quét: thiếu sid thì DropBuy chỉ trả kho công khai (~1.300 SP) thay vì kho CTV (~14.000)
  if (config.dropbuy?.cookieHeader) await dropbuySession.ensureSession(config).catch(() => null);
  const { items, totalRecords, complete, skippedVirtual = 0, failedPages = 0 } = await scraper.fetchAllSearchItems(config);
  if (items.length === 0) throw new Error('DropBuy không trả về sản phẩm nào');
  const priceMap = await scraper.fetchWholesalePrices(items, config);

  return withCatalogLock(async () => {
    const products = scraper.getProducts();
    const byId = new Map(products.map(p => [p.id, p]));
    const liveIds = new Set();
    const changed = [];
    let newCount = 0;

    for (const item of items) {
      const cur = byId.get(item.product_id);
      const fresh = scraper.mapItem(item, { ctx, priceMap, previous: cur, keepWholesale });
      liveIds.add(fresh.id);
      if (!cur) {
        newCount++;
        products.push(fresh);
        byId.set(fresh.id, fresh);
        changed.push(fresh);
        continue;
      }
      const priceDiff = cur.price !== fresh.price || cur.original_price !== fresh.original_price || cur.dropbuy_cost !== fresh.dropbuy_cost;
      const infoDiff = cur.name !== fresh.name || cur.image !== fresh.image || cur.variant_count !== fresh.variant_count || cur.warranty !== fresh.warranty;
      // in_stock do vòng tồn kho quyết định (API in-stock chuẩn hơn cờ trong kết quả tìm kiếm)
      const keepStock = cur.in_stock;
      Object.assign(cur, fresh, { in_stock: keepStock, updated_at: priceDiff || infoDiff ? fresh.updated_at : cur.updated_at });
      delete cur.stock_qty;
      delete cur.removed_from_dropbuy;
      if (priceDiff || infoDiff) changed.push(cur);
    }

    // SP không còn trên DropBuy (chỉ kết luận khi đã quét đủ mọi trang) → ngừng bán
    // Kho bỗng nhỏ hơn hẳn lần quét đủ trước (vd phiên vừa hết hạn → chỉ thấy kho công khai) → không gỡ SP nào
    // Mốc so sánh: lần quét đủ trước, hoặc số SP đang bán trong catalog (giữ được qua lần khởi động lại)
    const baseline = Math.max(lastCompleteTotal, products.filter(p => (!p.supplier || p.supplier === 'dropbuy') && !p.removed_from_dropbuy).length);
    const shrunk = baseline > 0 && totalRecords < baseline * 0.5;
    if (shrunk) console.warn(`[RealtimeSync] DropBuy chỉ trả ${totalRecords} SP (mốc trước: ${baseline}) – bỏ qua bước gỡ SP.`);
    if (complete && !shrunk) {
      lastCompleteTotal = totalRecords;
      for (const p of products) {
        if (p.supplier && p.supplier !== 'dropbuy') continue;
        if (!liveIds.has(p.id) && !p.removed_from_dropbuy) {
          p.in_stock = false;
          p.removed_from_dropbuy = true;
          changed.push(p);
        }
      }
    }

    if (changed.length) scraper.saveProducts(products);
    emitChanges(changed, { source: 'price', newCount });

    if (prisma && changed.length) {
      for (const p of changed) {
        await prisma.variation.updateMany({ where: { product_id: p.id }, data: { price_public: p.public_price } }).catch(() => {});
      }
    }
    console.log(`[RealtimeSync] Giá & catalog: ${items.length}/${totalRecords} SP${skippedVirtual ? ` (bỏ ${skippedVirtual} kho ảo)` : ''}${failedPages ? `, ${failedPages} trang lỗi` : ''}, giá sỉ ${priceMap.size}, ${changed.length} thay đổi, ${newCount} SP mới.`);
    return changed.length;
  });
}

// ───────────────────────── Bộ lập lịch có giãn nhịp ─────────────────────────
function schedule(loop, fn, delayMs) {
  clearTimeout(loop.timer);
  loop.nextRun = new Date(Date.now() + delayMs).toISOString();
  loop.timer = setTimeout(() => tick(loop, fn), delayMs);
}

async function tick(loop, fn) {
  if (loop.running) return;
  loop.running = true;
  loop.lastRun = new Date().toISOString();
  const started = Date.now();
  try {
    loop.lastChanges = await fn();
    loop.lastOk = new Date().toISOString();
    loop.lastError = null;
    loop.failures = 0;
  } catch (err) {
    loop.failures++;
    loop.lastError = err.message;
    console.error(`[RealtimeSync:${loop.name}] Lỗi (lần ${loop.failures}):`, err.message);
  } finally {
    loop.lastDurationMs = Date.now() - started;
    loop.running = false;
    const delay = loop.failures ? Math.min(MAX_BACKOFF_MS, loop.baseMs * 2 ** loop.failures) : loop.baseMs;
    schedule(loop, fn, delay);
    if (ioRef) {
      ioRef.emit('REALTIME_HEARTBEAT', getPublicSyncStatus());
      emitAdmin(ioRef, 'ADMIN_REALTIME_HEARTBEAT', getSyncStatus());
    }
  }
}

function startRealtimeSync(io) {
  ioRef = io;
  console.log(`[RealtimeSync] ⚡ Tồn kho mỗi ${STOCK_INTERVAL_MS / 1000}s, giá & catalog mỗi ${PRICE_INTERVAL_MS / 1000}s.`);
  schedule(loops.price, runPriceSync, 3000);
  schedule(loops.stock, runStockSync, 8000);
}

/** Chạy ngay 1 vòng đầy đủ (admin bấm "Quét ngay") */
async function runFullSync5Min(io) {
  if (io) ioRef = io;
  await tick(loops.price, runPriceSync);
  await tick(loops.stock, runStockSync);
}

/**
 * Kiểm tra TRỰC TIẾP trên DropBuy ngay trước khi tạo đơn: giá theo SKU + tồn kho.
 * Cập nhật catalog nếu lệch và trả về danh sách SP mới nhất.
 * Lỗi mạng → { ok: false } để server quyết định dùng dữ liệu cache.
 */
async function liveCheck(productIds) {
  const config = scraper.getConfig();
  const ctx = scraper.getPricingContext(config);
  const products = scraper.getProducts();
  const targets = productIds.map(id => products.find(p => p.id === id)).filter(Boolean);
  try {
    const [stock, liveItems] = await Promise.all([
      scraper.fetchStockMap(targets.map(p => p.id), config),
      Promise.all(targets.map(p => scraper.searchBySku(p.sku, config).catch(() => null)))
    ]);
    const priceMap = await scraper.fetchWholesalePrices(liveItems.filter(Boolean), config);
    return await withCatalogLock(async () => {
      const all = scraper.getProducts();
      const changed = [];
      const result = new Map();
      targets.forEach((t, i) => {
        const cur = all.find(p => p.id === t.id);
        const item = liveItems[i];
        if (item) {
          const fresh = scraper.mapItem(item, { ctx, priceMap, previous: cur, keepWholesale: !!config.dropbuy?.cookieHeader });
          if (fresh.price !== cur.price || fresh.original_price !== cur.original_price || fresh.warranty !== cur.warranty) {
            Object.assign(cur, { price: fresh.price, original_price: fresh.original_price, dropbuy_cost: fresh.dropbuy_cost, public_price: fresh.public_price, wholesale_price: fresh.wholesale_price, is_flash_sale: fresh.is_flash_sale, fs_program_code: fresh.fs_program_code, profit_margin: fresh.profit_margin, is_wholesale_price: fresh.is_wholesale_price, pricing_rule: fresh.pricing_rule, warranty: fresh.warranty, warranty_type: fresh.warranty_type, warranty_duration: fresh.warranty_duration, updated_at: fresh.updated_at });
            changed.push(cur);
          }
        }
        if (stock.has(cur.id) && (cur.in_stock !== false) !== stock.get(cur.id)) {
          cur.in_stock = stock.get(cur.id);
          if (!changed.includes(cur)) changed.push(cur);
        }
        result.set(cur.id, { ...cur, live_found: !!item });
      });
      if (changed.length) {
        scraper.saveProducts(all);
        emitChanges(changed, { source: 'live' });
      }
      return { ok: true, products: result, changed: changed.map(p => p.id) };
    });
  } catch (err) {
    console.warn('[RealtimeSync] Kiểm tra trực tiếp thất bại, dùng dữ liệu cache:', err.message);
    return { ok: false, error: err.message, products: new Map(targets.map(p => [p.id, p])), changed: [] };
  }
}

/** Áp quy tắc giá mới cho toàn bộ catalog ngay lập tức và đẩy realtime xuống trang khách. */
async function repriceNow() {
  return withCatalogLock(async () => {
    const products = scraper.getProducts();
    const changed = scraper.repriceAll(products);
    if (changed.length) {
      scraper.saveProducts(products);
      emitChanges(changed, { source: 'pricing' });
    }
    return changed.length;
  });
}

function getSyncStatus() {
  const view = l => ({ intervalSeconds: l.baseMs / 1000, running: l.running, lastRun: l.lastRun, lastOk: l.lastOk, nextRun: l.nextRun, lastError: l.lastError, failures: l.failures, lastChanges: l.lastChanges, lastDurationMs: l.lastDurationMs });
  return {
    active: !!(loops.stock.timer || loops.price.timer),
    stock: view(loops.stock),
    price: view(loops.price),
    // giữ các trường cũ cho giao diện admin
    intervalMinutes: Math.round(loops.price.baseMs / 60000) || 1,
    lastSyncTime: loops.stock.lastOk || loops.price.lastOk,
    nextSyncTime: [loops.stock.nextRun, loops.price.nextRun].filter(Boolean).sort()[0] || null,
    lastError: loops.stock.lastError || loops.price.lastError,
    totalProducts: scraper.getProducts().length
  };
}

function getPublicSyncStatus() {
  const pubView = l => ({ intervalSeconds: l.baseMs / 1000, running: l.running, lastOk: l.lastOk, nextRun: l.nextRun });
  return {
    active: !!(loops.stock.timer || loops.price.timer),
    stock: pubView(loops.stock),
    price: pubView(loops.price),
    intervalMinutes: Math.round(loops.price.baseMs / 60000) || 1,
    lastSyncTime: loops.stock.lastOk || loops.price.lastOk,
    nextSyncTime: [loops.stock.nextRun, loops.price.nextRun].filter(Boolean).sort()[0] || null,
    totalProducts: scraper.getProducts().filter(p => Number(p.price) > 0 && !p.removed_from_dropbuy && scraper.hasRealPhoto(p)).length
  };
}

module.exports = {
  startRealtimeSync,
  runFullSync5Min,
  runStockSync,
  runPriceSync,
  liveCheck,
  repriceNow,
  getSyncStatus,
  getPublicSyncStatus,
  publicPatch,
  withCatalogLock,
  emitChanges
};
