require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const scraper = require('./services/dropbuyScraper');
const detailScraper = require('./services/dropbuyDetailScraper');
const orderStore = require('./services/orderStore');
const relay = require('./services/dropbuyRelay');
const dropbuyAuth = require('./services/dropbuyAuth');
const realtimeSync = require('./services/realtimeSync');
const { requireAdmin, getAdminPassword, sanitizeHtml, maskPhone } = require('./services/security');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || false, methods: ['GET', 'POST'] }
});

const PORT = process.env.HOANGMINH_PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const MAX_QTY_PER_ITEM = 50;

app.use(cors({ origin: process.env.CORS_ORIGIN || false }));
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', socket => {
  socket.on('join-order', orderId => {
    if (typeof orderId === 'string' && /^HM[A-Z0-9]{6,10}$/.test(orderId)) socket.join(orderId);
  });
});

// --- Helpers ---

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

/** Trường nội bộ (giá vốn, lãi) không được trả ra cho khách. */
function publicProduct(p) {
  if (!p) return p;
  const { dropbuy_cost, profit_margin, is_wholesale_price, public_price, ...rest } = p;
  const discount = p.original_price && p.original_price > p.price ? Math.round((1 - p.price / p.original_price) * 100) : 0;
  return { ...rest, discount_percent: discount };
}

/** Danh mục cha bao gồm mọi danh mục con. */
function categoryIdsFor(catId) {
  const cats = scraper.getCategories();
  const ids = new Set([catId]);
  let added = true;
  while (added) {
    added = false;
    for (const c of cats) {
      if (c.parent_id && ids.has(c.parent_id) && !ids.has(c.id)) {
        ids.add(c.id);
        added = true;
      }
    }
  }
  return ids;
}

/** Dữ liệu đơn trả cho khách: che bớt thông tin cá nhân, không lộ thông tin nội bộ. */
function publicOrder(o) {
  return {
    id: o.id,
    status: o.status,
    created_at: o.created_at,
    total_amount: o.total_amount,
    items: (o.items || []).map(i => ({ id: i.id, name: i.name, price: i.price, quantity: i.quantity, image: i.image })),
    customer: { name: o.customer?.name, phone: maskPhone(o.customer?.phone) },
    payment: o.payment,
    paid_at: o.paid_at || null
  };
}

const SECRET_KEYS = ['password', 'cookieHeader', 'sessionToken', 'cookies'];
function redactConfig(cfg) {
  const out = JSON.parse(JSON.stringify(cfg || {}));
  if (out.dropbuy) for (const k of SECRET_KEYS) if (k in out.dropbuy) out.dropbuy[k] = out.dropbuy[k] ? '***' : '';
  return out;
}

// --- PUBLIC API ---

app.get('/api/categories', (req, res) => {
  try {
    const products = scraper.getProducts();
    const cats = scraper.getCategories();
    const withCount = cats.map(c => {
      const ids = categoryIdsFor(c.id);
      return { ...c, product_count: products.filter(p => ids.has(p.category_id)).length };
    });
    res.json({ success: true, data: withCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/products', (req, res) => {
  try {
    const { category, search, page = 1, limit = 24, sort = 'default', minPrice, maxPrice, inStock } = req.query;
    let products = scraper.getProducts();

    if (category && category !== 'all') {
      const ids = categoryIdsFor(parseInt(category, 10));
      products = products.filter(p => ids.has(p.category_id));
    }

    if (search) {
      const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
      const q = norm(search).trim();
      products = products.filter(p => norm(p.name).includes(q) || norm(p.sku).includes(q));
    }

    if (minPrice) {
      const min = parseInt(minPrice, 10);
      products = products.filter(p => p.price >= min);
    }
    if (maxPrice) {
      const max = parseInt(maxPrice, 10);
      products = products.filter(p => p.price <= max);
    }
    if (inStock === '1') products = products.filter(p => p.in_stock !== false);

    if (sort === 'price-asc') {
      products.sort((a, b) => a.price - b.price);
    } else if (sort === 'price-desc') {
      products.sort((a, b) => b.price - a.price);
    } else if (sort === 'name-asc') {
      products.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    } else {
      // Mặc định: còn hàng lên trước
      products = [...products.filter(p => p.in_stock !== false), ...products.filter(p => p.in_stock === false)];
    }

    const total = products.length;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 24));
    const startIndex = (pageNum - 1) * limitNum;
    const items = products.slice(startIndex, startIndex + limitNum).map(publicProduct);

    res.json({ success: true, total, page: pageNum, totalPages: Math.ceil(total / limitNum) || 1, data: items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const product = scraper.getProducts().find(p => p.id === id);
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    const detail = await detailScraper.fetchProductFullDetail(product, false);
    // Giá / tồn kho luôn lấy từ catalog hiện tại (bản cache chi tiết có thể đã cũ)
    const merged = {
      ...detail,
      ...publicProduct(product),
      description: sanitizeHtml(detail.description),
      gallery: detail.gallery,
      variations: detail.variations,
      video_url: detail.video_url
    };
    delete merged.dropbuy_cost;
    delete merged.rating;
    delete merged.sold_count;
    res.json({ success: true, data: merged });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Tạo đơn: giá, tên, ảnh lấy từ catalog phía server – không tin dữ liệu giá client gửi lên
app.post('/api/orders/checkout', async (req, res) => {
  try {
    const { customer, items } = req.body || {};
    const name = String(customer?.name || '').trim();
    const phone = String(customer?.phone || '').replace(/[\s.-]/g, '');
    const address = String(customer?.address || '').trim();
    if (!name || !address || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Vui lòng cung cấp đầy đủ họ tên, số điện thoại, địa chỉ và sản phẩm.' });
    }
    if (!/^(0|\+84)\d{9,10}$/.test(phone)) {
      return res.status(400).json({ success: false, error: 'Số điện thoại không hợp lệ.' });
    }
    if (items.length > 30) return res.status(400).json({ success: false, error: 'Tối đa 30 mặt hàng mỗi đơn.' });

    const catalog = new Map(scraper.getProducts().map(p => [p.id, p]));
    const merged = new Map();
    for (const it of items) {
      const id = Number(it?.id);
      const qty = Number(it?.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_ITEM) {
        return res.status(400).json({ success: false, error: `Số lượng không hợp lệ (1–${MAX_QTY_PER_ITEM}).` });
      }
      const p = catalog.get(id);
      if (!p) return res.status(400).json({ success: false, error: `Sản phẩm #${it?.id} không còn tồn tại.` });
      if (p.in_stock === false) return res.status(400).json({ success: false, error: `"${p.name}" đã hết hàng.` });
      merged.set(id, (merged.get(id) || 0) + qty);
    }

    const orderItems = [...merged.entries()].map(([id, quantity]) => {
      const p = catalog.get(id);
      return { id, sku: p.sku, variation_id: p.variation_id || null, name: p.name, price: p.price, quantity, image: p.image, dropbuy_url: p.dropbuy_url, dropbuy_cost: p.dropbuy_cost };
    });
    const total_amount = orderItems.reduce((s, i) => s + i.price * i.quantity, 0);

    const order = orderStore.createOrder({
      customer: { name: name.slice(0, 100), phone, address: address.slice(0, 300), note: String(customer?.note || '').slice(0, 500) },
      items: orderItems,
      total_amount
    });
    console.log(`[Order] Đã tiếp nhận đơn hàng #${order.id} trị giá ${order.total_amount.toLocaleString('vi-VN')} đ`);

    setImmediate(() => {
      relay.processOrderFulfillment(order, io).catch(err => {
        console.error(`[Relay Error] Lỗi xử lý đơn #${order.id}:`, err);
      });
    });

    res.json({
      success: true,
      orderId: order.id,
      total_amount,
      items: orderItems.map(i => ({ id: i.id, name: i.name, price: i.price, quantity: i.quantity })),
      message: 'Đơn hàng đã được tạo. Đang khởi tạo mã thanh toán...'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/orders/:id', (req, res) => {
  const order = orderStore.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
  res.json({ success: true, data: publicOrder(order) });
});

// Khách báo đã chuyển khoản → chờ admin đối soát (KHÔNG tự đánh dấu đã thanh toán)
app.post('/api/orders/:id/report-paid', (req, res) => {
  const order = orderStore.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
  if (order.status !== 'PENDING_PAYMENT') {
    return res.json({ success: true, data: publicOrder(order), message: 'Đơn hàng đã được ghi nhận trước đó.' });
  }
  const updated = orderStore.updateOrder(order.id, { status: 'PAYMENT_REPORTED', payment_reported_at: new Date().toISOString() });
  io.emit('ADMIN_PAYMENT_REPORTED', { orderId: order.id, total_amount: order.total_amount });
  res.json({ success: true, data: publicOrder(updated), message: 'Đã ghi nhận. Cửa hàng sẽ xác nhận ngay khi nhận được tiền.' });
});

// --- ADMIN API (cần header x-admin-key) ---

app.get('/api/admin/session', requireAdmin, (req, res) => res.json({ success: true }));

app.post('/api/orders/:id/confirm-payment', requireAdmin, (req, res) => {
  try {
    const order = relay.confirmPayment(req.params.id, io);
    if (!order) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
    res.json({ success: true, message: 'Đã xác nhận thanh toán thành công!', order });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/orders/:id/status', requireAdmin, (req, res) => {
  const { status, note } = req.body || {};
  if (!orderStore.STATUSES.includes(status)) return res.status(400).json({ success: false, error: 'Trạng thái không hợp lệ' });
  const order = orderStore.updateOrder(req.params.id, { status, admin_note: note || undefined });
  if (!order) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
  io.to(order.id).emit('ORDER_STATUS_UPDATE', { orderId: order.id, status, message: `Đơn hàng chuyển sang trạng thái ${status}` });
  res.json({ success: true, data: order });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  res.json({ success: true, data: orderStore.getOrders() });
});

app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json({ success: true, data: redactConfig(readConfig()) });
});

// Chỉ cho sửa các trường cấu hình an toàn; không ghi đè phiên đăng nhập DropBuy
app.post('/api/admin/config', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const cfg = readConfig();
    cfg.dropbuy = { ...(cfg.dropbuy || {}) };
    if (typeof b.dropbuy?.simulationMode === 'boolean') cfg.dropbuy.simulationMode = b.dropbuy.simulationMode;
    if (typeof b.dropbuy?.username === 'string') cfg.dropbuy.username = b.dropbuy.username.trim();
    if (b.pricing) {
      const m = Number(b.pricing.markupPercent);
      if (!Number.isFinite(m) || m < 0 || m > 300) return res.status(400).json({ success: false, error: 'Markup phải từ 0 đến 300%' });
      cfg.pricing = { ...(cfg.pricing || {}), markupPercent: m };
    }
    if (b.bank) {
      const { bankId, bankName, accountNo, accountName } = b.bank;
      if (!/^\d{6}$/.test(String(bankId || '')) || !/^\d{4,20}$/.test(String(accountNo || '').trim())) {
        return res.status(400).json({ success: false, error: 'Mã ngân hàng (BIN 6 số) hoặc số tài khoản không hợp lệ' });
      }
      cfg.bank = { bankId: String(bankId), bankName: String(bankName || ''), accountNo: String(accountNo).trim(), accountName: String(accountName || '').trim().toUpperCase() };
    }
    if (b.store) cfg.store = { ...(cfg.store || {}), ...b.store };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    res.json({ success: true, message: 'Đã lưu cấu hình thành công! Giá mới áp dụng từ lần đồng bộ kế tiếp.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

let catalogSyncRunning = false;
function runCatalogSync(opts, wholesale) {
  if (catalogSyncRunning) return false;
  catalogSyncRunning = true;
  scraper.syncCatalog(opts)
    .then(products => io.emit('CATALOG_SYNC_COMPLETED', { total: products.length, wholesale }))
    .catch(err => console.error('[Sync Error]:', err.message))
    .finally(() => { catalogSyncRunning = false; });
  return true;
}

app.post('/api/admin/sync', requireAdmin, (req, res) => {
  const started = runCatalogSync({ maxPages: Number(req.body?.maxPages) || 20, pageSize: 100 }, false);
  res.json({ success: true, message: started ? 'Tiến trình đồng bộ kho hàng DropBuy đã bắt đầu!' : 'Đồng bộ đang chạy, vui lòng chờ.' });
});

let imageJobRunning = false;
app.post('/api/admin/download-all-images', requireAdmin, (req, res) => {
  if (imageJobRunning) return res.json({ success: true, message: 'Tiến trình tải ảnh đang chạy.' });
  const products = scraper.getProducts();
  imageJobRunning = true;
  res.json({ success: true, message: `Bắt đầu tải chi tiết & album ảnh cho ${products.length} sản phẩm (chạy nền).` });

  (async () => {
    let count = 0;
    for (const p of products) {
      try {
        await detailScraper.fetchProductFullDetail(p, true);
        count++;
        if (count % 10 === 0) io.emit('DOWNLOAD_PROGRESS', { current: count, total: products.length });
      } catch (e) {
        console.error(`[BatchDownloader] Lỗi #${p.id}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 300));
    }
    imageJobRunning = false;
    io.emit('DOWNLOAD_COMPLETED', { total: count });
  })();
});

app.post('/api/dropbuy/login', requireAdmin, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Vui lòng nhập tài khoản và mật khẩu DropBuy' });
    }
    const result = await dropbuyAuth.loginDropbuy(username, password);
    runCatalogSync({}, true);
    io.emit('DROPBUY_AUTH_CHANGED', { authenticated: true });
    res.json({ success: true, message: 'Đăng nhập DropBuy thành công! Đang đồng bộ lại giá sỉ.', data: { username: result.username, method: result.method } });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/dropbuy/set-cookie', requireAdmin, async (req, res) => {
  try {
    const result = await dropbuyAuth.setManualCookie(req.body?.cookie);
    runCatalogSync({}, true);
    io.emit('DROPBUY_AUTH_CHANGED', { authenticated: true });
    res.json({ success: true, message: result.message });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/dropbuy/auth-status', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: await dropbuyAuth.getAuthStatus() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/dropbuy/logout', requireAdmin, (req, res) => {
  const result = dropbuyAuth.logout();
  io.emit('DROPBUY_AUTH_CHANGED', { authenticated: false });
  res.json(result);
});

app.get('/api/realtime/status', (req, res) => {
  res.json({ success: true, data: realtimeSync.getSyncStatus() });
});

app.post('/api/realtime/sync-now', requireAdmin, (req, res) => {
  res.json({ success: true, message: 'Đã kích hoạt quét đồng bộ kho DropBuy ngay lập tức!' });
  realtimeSync.runFullSync5Min(io).catch(err => console.error('[Manual Sync Error]:', err.message));
});

process.on('uncaughtException', err => {
  console.error('[CRITICAL Uncaught Exception]:', err.message);
});

process.on('unhandledRejection', reason => {
  console.error('[CRITICAL Unhandled Rejection]:', reason);
});

server.listen(PORT, () => {
  getAdminPassword(); // tạo mật khẩu admin nếu chưa có
  console.log(`================================================================`);
  console.log(`🚀 HOANGMINH.COM x DROPBUY.VN RELAY SYSTEM RUNNING ON PORT ${PORT}`);
  console.log(`🔗 Storefront: http://localhost:${PORT}`);
  console.log(`🔗 Admin Console: http://localhost:${PORT}/admin.html`);
  console.log(`================================================================`);
  realtimeSync.startRealtimeSync(io, 5 * 60 * 1000);
});
