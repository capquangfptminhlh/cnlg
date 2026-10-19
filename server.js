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

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.HOANGMINH_PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Socket.io for Realtime QR Relay
io.on('connection', socket => {
  socket.on('join-order', orderId => {
    socket.join(orderId);
    console.log(`[Socket] Client joined room for order #${orderId}`);
  });
});

// --- API ROUTES ---

// 1. Get Categories
app.get('/api/categories', (req, res) => {
  try {
    const categories = scraper.getCategories();
    res.json({ success: true, data: categories });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Get Products (with pagination, category filtering, search, sorting, price range)
app.get('/api/products', (req, res) => {
  try {
    const { category, search, page = 1, limit = 24, sort = 'default', minPrice, maxPrice } = req.query;
    let products = scraper.getProducts();

    // Filter category
    if (category && category !== 'all') {
      const catId = parseInt(category, 10);
      products = products.filter(p => p.category_id === catId);
    }

    // Filter search
    if (search) {
      const q = search.toLowerCase().trim();
      products = products.filter(p => 
        (p.name && p.name.toLowerCase().includes(q)) || 
        (p.sku && p.sku.toLowerCase().includes(q))
      );
    }

    // Filter price range
    if (minPrice) {
      const min = parseInt(minPrice, 10);
      products = products.filter(p => p.price >= min);
    }
    if (maxPrice) {
      const max = parseInt(maxPrice, 10);
      products = products.filter(p => p.price <= max);
    }

    // Sorting
    if (sort === 'price-asc') {
      products.sort((a, b) => a.price - b.price);
    } else if (sort === 'price-desc') {
      products.sort((a, b) => b.price - a.price);
    } else if (sort === 'name-asc') {
      products.sort((a, b) => a.name.localeCompare(b.name));
    }

    const total = products.length;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 24;
    const startIndex = (pageNum - 1) * limitNum;
    const items = products.slice(startIndex, startIndex + limitNum);

    res.json({
      success: true,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum) || 1,
      data: items
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Get Single Product FULL DETAIL (Gallery images, video, specs, description)
app.get('/api/products/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const products = scraper.getProducts();
    const product = products.find(p => p.id === id);
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    // Fetch full detail on-demand (and cache locally)
    const fullDetail = await detailScraper.fetchProductFullDetail(product, false);
    res.json({ success: true, data: fullDetail });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Create Order & Trigger DropBuy Relay
app.post('/api/orders/checkout', async (req, res) => {
  try {
    const { customer, items, total_amount } = req.body;
    if (!customer || !customer.name || !customer.phone || !items || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Vui lòng cung cấp đầy đủ thông tin đặt hàng' });
    }

    const order = orderStore.createOrder({ customer, items, total_amount });
    console.log(`[Order] Đã tiếp nhận đơn hàng #${order.id} trị giá ${order.total_amount.toLocaleString('vi-VN')} đ`);

    // Asynchronously trigger Dropbuy Relay without blocking HTTP response
    setImmediate(() => {
      relay.processOrderFulfillment(order, io).catch(err => {
        console.error(`[Relay Error] Lỗi xử lý đơn #${order.id}:`, err);
      });
    });

    res.json({
      success: true,
      orderId: order.id,
      message: 'Đơn hàng đã được tạo. Đang kết nối DropBuy để khởi tạo mã thanh toán...'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Get Order Details
app.get('/api/orders/:id', (req, res) => {
  try {
    const order = orderStore.getOrderById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
    }
    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Confirm Order Payment (Webhook / Admin)
app.post('/api/orders/:id/confirm-payment', (req, res) => {
  try {
    const order = relay.confirmPayment(req.params.id, io);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
    }
    res.json({ success: true, message: 'Đã xác nhận thanh toán thành công!', order });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Admin - Get All Orders
app.get('/api/admin/orders', (req, res) => {
  try {
    const orders = orderStore.getOrders();
    res.json({ success: true, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Admin - Get Config
app.get('/api/admin/config', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    res.json({ success: true, data: config });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. Admin - Update Config
app.post('/api/admin/config', (req, res) => {
  try {
    const newConfig = req.body;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf8');
    res.json({ success: true, message: 'Đã lưu cấu hình thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10. Admin - Trigger Full Sync from DropBuy
app.post('/api/admin/sync', async (req, res) => {
  try {
    const { maxPages = 15 } = req.body;
    res.json({ success: true, message: 'Tiến trình đồng bộ 100% kho hàng DropBuy đã bắt đầu!' });

    scraper.syncCatalog({ maxPages, pageSize: 100 }).then(products => {
      io.emit('CATALOG_SYNC_COMPLETED', { total: products.length });
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 11. Admin - Scrape & Download All Images in Background
app.post('/api/admin/download-all-images', (req, res) => {
  const products = scraper.getProducts();
  res.json({ success: true, message: `Bắt đầu tiến trình cào full chi tiết & tải album ảnh cho ${products.length} sản phẩm ngầm!` });

  (async () => {
    let count = 0;
    for (const p of products) {
      try {
        await detailScraper.fetchProductFullDetail(p, true);
        count++;
        if (count % 10 === 0) {
          console.log(`[BatchDownloader] Đã tải xong ảnh & chi tiết ${count}/${products.length} sản phẩm...`);
          io.emit('DOWNLOAD_PROGRESS', { current: count, total: products.length });
        }
      } catch (e) {
        console.error(`[BatchDownloader] Lỗi #${p.id}:`, e.message);
      }
    }
    console.log(`[BatchDownloader] Hoàn thành tải 100% chi tiết & ảnh cho toàn bộ ${count} sản phẩm!`);
    io.emit('DOWNLOAD_COMPLETED', { total: count });
  })();
});

// 12. DropBuy Auth - Login with credentials
app.post('/api/dropbuy/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Vui lòng nhập tài khoản và mật khẩu DropBuy' });
    }
    const result = await dropbuyAuth.loginDropbuy(username, password);

    // Kích hoạt đồng bộ lại kho hàng ngầm với session mới để lấy giá sỉ
    scraper.syncCatalog().then(products => {
      io.emit('CATALOG_SYNC_COMPLETED', { total: products.length, wholesale: true });
    }).catch(err => console.error('[Sync Error after login]:', err.message));

    io.emit('DROPBUY_AUTH_CHANGED', { authenticated: true, user: result.user });
    res.json({ success: true, message: 'Đăng nhập DropBuy thành công! Đã kích hoạt giá sỉ đại lý F1.', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 13. DropBuy Auth - Set manual cookie
app.post('/api/dropbuy/set-cookie', async (req, res) => {
  try {
    const { cookie } = req.body;
    const result = await dropbuyAuth.setManualCookie(cookie);

    scraper.syncCatalog().then(products => {
      io.emit('CATALOG_SYNC_COMPLETED', { total: products.length, wholesale: true });
    }).catch(err => console.error('[Sync Error after set-cookie]:', err.message));

    io.emit('DROPBUY_AUTH_CHANGED', { authenticated: true, user: result.user });
    res.json({ success: true, message: result.message, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 14. DropBuy Auth - Get current authentication status
app.get('/api/dropbuy/auth-status', async (req, res) => {
  try {
    const status = await dropbuyAuth.getAuthStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 15. DropBuy Auth - Logout
app.post('/api/dropbuy/logout', (req, res) => {
  const result = dropbuyAuth.logout();
  io.emit('DROPBUY_AUTH_CHANGED', { authenticated: false });
  res.json(result);
});

// 16. Realtime Sync Status & Manual Trigger
app.get('/api/realtime/status', (req, res) => {
  res.json({ success: true, data: realtimeSync.getSyncStatus() });
});

app.post('/api/realtime/sync-now', async (req, res) => {
  try {
    res.json({ success: true, message: 'Đã kích hoạt quét đồng bộ 100% kho DropBuy ngay lập tức!' });
    realtimeSync.runFullSync5Min(io).catch(err => console.error('[Manual Sync Error]:', err.message));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start Server
server.listen(PORT, async () => {
  console.log(`================================================================`);
  console.log(`🚀 HOANGMINH.COM x DROPBUY.VN RELAY SYSTEM RUNNING ON PORT ${PORT}`);
  console.log(`🔗 Storefront: http://localhost:${PORT}`);
  console.log(`🔗 Admin Console: http://localhost:${PORT}/admin.html`);
  console.log(`================================================================`);

  // Khởi chạy tiến trình nạp liên tục 5 phút / 1 lần cho giá & tồn kho
  realtimeSync.startRealtimeSync(io, 5 * 60 * 1000);
});
