'use strict';
const fs = require('fs');
const path = require('path');
const techmallAuth = require('./techmallAuth');
const techmallScraper = require('./techmallScraper');
const { withCatalogLock, emitChanges } = require('./realtimeSync');
const { emitAdmin } = require('./security');

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 phút / lần theo yêu cầu
const DATA_DIR = path.join(__dirname, '..', 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const TECHMALL_PRODUCTS_FILE = path.join(DATA_DIR, 'techmall_products.json');

let ioRef = null;
let syncTimer = null;
const state = {
  active: false,
  running: false,
  intervalMinutes: 5,
  lastRun: null,
  lastOk: null,
  nextRun: null,
  lastError: null,
  lastChanges: 0,
  failures: 0,
  totalProducts: 0
};

/** Đọc danh sách toàn bộ sản phẩm */
function readAllProducts() {
  try {
    if (fs.existsSync(PRODUCTS_FILE)) {
      return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

/** Lưu danh sách sản phẩm */
function saveAllProducts(list) {
  const tmp = `${PRODUCTS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, PRODUCTS_FILE);
}

/** Đồng bộ định kỳ 5 phút: Quét nhanh giá bán & tồn kho TechMall */
async function runSync(options = {}) {
  if (state.running) {
    console.log('[TechMallSync] Đồng bộ đang chạy, bỏ qua lượt gọi trùng.');
    return 0;
  }
  state.running = true;
  state.lastRun = new Date().toISOString();
  const maxPages = options.pages || 5; // Mặc định quét 5 trang (500 SP) mỗi 5 phút

  try {
    // 1. Kiểm tra phiên đăng nhập
    const session = await techmallAuth.checkSession().catch(err => ({ authenticated: false, error: err.message }));
    const rules = techmallScraper.getTechmallPricingRules();

    console.log(`[TechMallSync] Bắt đầu đồng bộ giá & tồn kho 5 phút/lần (${session.authenticated ? 'Đã login đại lý' : 'Chưa login đại lý'})...`);

    // 2. Tải sản phẩm từ TechMall
    const fetchedItems = [];
    for (let page = 1; page <= maxPages; page++) {
      try {
        const res = await techmallScraper.fetchProductsPage(page, 100);
        if (!res.items || res.items.length === 0) break;
        for (const raw of res.items) {
          try {
            fetchedItems.push(techmallScraper.mapTechmallItem(raw, rules));
          } catch (e) {}
        }
        if (page >= (res.totalPages || 1)) break;
      } catch (err) {
        console.warn(`[TechMallSync] Lỗi tải trang ${page}:`, err.message);
        break;
      }
    }

    if (fetchedItems.length === 0) {
      throw new Error('TechMall không trả về dữ liệu sản phẩm');
    }

    // 3. Khóa catalog và cập nhật giá + tồn kho
    const changed = await withCatalogLock(async () => {
      const allProducts = readAllProducts();
      const byTmId = new Map();
      const byUnifiedId = new Map();

      // Lưu trữ chỉ mục sản phẩm hiện có
      for (const p of allProducts) {
        if (p.supplier === 'techmall') {
          if (p.techmall_id) byTmId.set(Number(p.techmall_id), p);
          byUnifiedId.set(Number(p.id), p);
        }
      }

      const diffs = [];
      let newCount = 0;

      for (const fresh of fetchedItems) {
        const cur = byTmId.get(fresh.techmall_id) || byUnifiedId.get(fresh.id);
        if (!cur) {
          // Thêm sản phẩm TechMall mới
          allProducts.push(fresh);
          byTmId.set(fresh.techmall_id, fresh);
          byUnifiedId.set(fresh.id, fresh);
          diffs.push(fresh);
          newCount++;
          continue;
        }

        // Kiểm tra biến động giá bán, giá vốn, hoặc tồn kho
        const priceDiff = cur.price !== fresh.price || cur.original_price !== fresh.original_price || cur.cost !== fresh.cost;
        const stockDiff = (cur.in_stock !== false) !== (fresh.in_stock !== false);
        const infoDiff = cur.name !== fresh.name || cur.warranty !== fresh.warranty || cur.image !== fresh.image;

        if (priceDiff || stockDiff || infoDiff) {
          Object.assign(cur, fresh, {
            updated_at: new Date().toISOString()
          });
          diffs.push(cur);
        }
      }

      if (diffs.length > 0) {
        saveAllProducts(allProducts);

        // Cập nhật riêng file techmall_products.json
        const tmOnly = allProducts.filter(p => p.supplier === 'techmall');
        techmallScraper.saveTechmallProducts(tmOnly);
      }

      state.totalProducts = allProducts.filter(p => p.supplier === 'techmall').length;
      return diffs;
    });

    state.lastOk = new Date().toISOString();
    state.lastError = null;
    state.lastChanges = changed.length;
    state.failures = 0;

    console.log(`[TechMallSync] ✅ Hoàn tất đồng bộ 5 phút: Quét ${fetchedItems.length} SP, phát hiện ${changed.length} thay đổi.`);

    // 4. Phát tín hiệu cập nhật thời gian thực
    if (changed.length > 0 && ioRef) {
      emitChanges(changed, { source: 'techmall_sync' });
    }

    if (ioRef) {
      emitAdmin(ioRef, 'ADMIN_TECHMALL_SYNC', getStatus());
    }

    return changed.length;
  } catch (err) {
    state.failures++;
    state.lastError = err.message;
    console.warn('[TechMallSync] ❌ Lỗi đồng bộ:', err.message);
    if (ioRef) {
      emitAdmin(ioRef, 'ADMIN_TECHMALL_SYNC', getStatus());
    }
    return 0;
  } finally {
    state.running = false;
    scheduleNext();
  }
}

/** Tính lại toàn bộ giá sản phẩm TechMall khi đổi bảng giá trong Admin */
async function repriceAllTechmall(io = ioRef) {
  const rules = techmallScraper.getTechmallPricingRules();
  const pricing = require('./pricing');

  return withCatalogLock(async () => {
    const allProducts = readAllProducts();
    const changed = [];

    for (const p of allProducts) {
      if (p.supplier !== 'techmall') continue;
      const cost = Number(p.cost || p.wholesale_price || p.price);
      const publicPrice = Number(p.original_price || p.public_price || p.price);

      const computed = pricing.computePrice({
        id: p.id,
        category_id: p.category_id || 9000,
        wholesale: cost,
        public_price: publicPrice
      }, rules);

      const before = `${p.price}|${p.original_price}`;
      p.price = computed.price;
      p.original_price = publicPrice > computed.price ? publicPrice : null;
      p.discount_percent = computed.discount_percent || 0;
      p.pricing_rule = computed.rule;
      p.updated_at = new Date().toISOString();

      if (`${p.price}|${p.original_price}` !== before) {
        changed.push(p);
      }
    }

    if (changed.length > 0) {
      saveAllProducts(allProducts);
      const tmOnly = allProducts.filter(p => p.supplier === 'techmall');
      techmallScraper.saveTechmallProducts(tmOnly);

      if (io) {
        emitChanges(changed, { source: 'techmall_reprice' });
        emitAdmin(io, 'ADMIN_TECHMALL_SYNC', getStatus());
      }
    }

    console.log(`[TechMallSync] Đã cập nhật giá riêng TechMall cho ${changed.length}/${allProducts.filter(p => p.supplier === 'techmall').length} SP`);
    return changed.length;
  });
}

/** Quét tải toàn bộ kho TechMall (chạy nền) */
async function crawlFullCatalog(maxPages = 50, io = ioRef) {
  state.running = true;
  state.lastRun = new Date().toISOString();
  try {
    const res = await techmallScraper.syncTechmallCatalog(maxPages);
    state.lastOk = new Date().toISOString();
    state.lastError = null;
    const tmProducts = techmallScraper.getTechmallProducts();
    state.totalProducts = tmProducts.length;

    if (io) {
      emitAdmin(io, 'ADMIN_TECHMALL_SYNC', getStatus());
      io.emit('PRODUCTS_UPDATED', {
        at: new Date().toISOString(),
        source: 'techmall_full_sync',
        items: [],
        newCount: tmProducts.length
      });
    }
    return res;
  } catch (err) {
    state.lastError = err.message;
    throw err;
  } finally {
    state.running = false;
    scheduleNext();
  }
}

/** Lập lịch chạy lượt tiếp theo sau 5 phút */
function scheduleNext() {
  if (!state.active) return;
  clearTimeout(syncTimer);
  state.nextRun = new Date(Date.now() + SYNC_INTERVAL_MS).toISOString();
  syncTimer = setTimeout(() => {
    runSync().catch(() => {});
  }, SYNC_INTERVAL_MS);
}

/** Bắt đầu vòng đồng bộ tự động 5 phút/lần */
function startAutoSync(io = null) {
  if (io) ioRef = io;
  if (state.active) return;
  state.active = true;

  // Cập nhật số lượng SP TechMall hiện tại
  const all = readAllProducts();
  state.totalProducts = all.filter(p => p.supplier === 'techmall').length;

  console.log('[TechMallSync] 🚀 Đã khởi động bộ đồng bộ Realtime TechMall (Chu kỳ: 5 phút / lần)');

  // Chạy lần đầu sau 10 giây để không nghẽn khởi động server
  clearTimeout(syncTimer);
  state.nextRun = new Date(Date.now() + 10000).toISOString();
  syncTimer = setTimeout(() => {
    runSync().catch(() => {});
  }, 10000);
}

/** Dừng đồng bộ tự động */
function stopAutoSync() {
  state.active = false;
  clearTimeout(syncTimer);
  syncTimer = null;
  state.nextRun = null;
}

/** Lấy trạng thái hiện tại của đồng bộ TechMall */
function getStatus() {
  const cfg = techmallAuth.readConfig();
  const tmAuth = cfg.techmall || {};
  return {
    active: state.active,
    running: state.running,
    intervalMinutes: state.intervalMinutes,
    lastRun: state.lastRun,
    lastOk: state.lastOk,
    nextRun: state.nextRun,
    lastError: state.lastError,
    lastChanges: state.lastChanges,
    totalProducts: state.totalProducts || techmallScraper.getTechmallProducts().length,
    auth: {
      authenticated: !!tmAuth.authenticated,
      username: tmAuth.username || null,
      authenticatedAt: tmAuth.authenticatedAt || null
    }
  };
}

module.exports = {
  startAutoSync,
  stopAutoSync,
  runSync,
  syncNow: runSync,
  crawlFullCatalog,
  repriceAllTechmall,
  getStatus
};
