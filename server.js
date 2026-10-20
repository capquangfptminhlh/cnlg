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
const { requireAdmin, rateLimit, securityHeaders, getAdminPassword, sanitizeHtml, maskPhone } = require('./services/security');
const pricing = require('./services/pricing');
const { checkDropbuy } = require('./services/dropbuyHealth');
const variants = require('./services/variants');
const shipping = require('./services/shipping');
const orderExpiry = require('./services/orderExpiry');
const payments = require('./services/payments');
const { notify } = require('./services/notify');
const dropbuyCart = require('./services/dropbuyCart');
const seo = require('./services/seo');
const backup = require('./services/backup');
const reports = require('./services/reports');
const dropbuyOrderFulfillment = require('./services/dropbuyOrderFulfillment');
const vnAddress = require('./services/vnAddress');
const dropbuySession = require('./services/dropbuySession');
const shippingLive = require('./services/shippingLive');
const catalogImage = require('./services/catalogImage');

const CARRIER = { V: 'Viettel Post', S: 'SPX Express' };
/**
 * Phí ship tính cho khách. Mặc định = phí thật DropBuy báo cho đúng các món + phường nhận (+ liveExtra),
 * miễn phí nếu đạt ngưỡng (shop chịu). Không lấy được (chưa đăng nhập / DropBuy lỗi) → bảng phí cố định, ghi "ước tính".
 * lines: [{ variation_id, quantity, name, weight_gram }]
 */
async function quoteShipping({ province, wardId, subtotal, lines, cfg = readConfig() }) {
  const rules = shipping.normalizeShipping(cfg.shipping);
  const flat = note => {
    const q = shipping.quote({ province, subtotal, lines }, cfg.shipping);
    return { ...q, source: 'flat', detail: note && !q.free_ship ? `${q.detail} (ước tính)` : q.detail, live_error: note || null };
  };
  if (rules.mode !== 'live' || !rules.enabled) return flat();
  if (!wardId) return flat('chọn phường/xã để tính phí thật');
  try {
    const addr = await vnAddress.resolve(province, wardId);
    if (!addr) return flat('phường/xã không hợp lệ');
    const live = await shippingLive.liveQuote({
      lines: lines.map(l => ({ variation_id: l.variation_id, quantity: l.quantity, name: l.name })),
      provinceId: addr.province.id,
      wardId: addr.ward.id,
      codAmount: subtotal,
      method: dropbuyOrderFulfillment.normalizeAutoOrder(cfg.autoOrder).shippingMethod,
      config: cfg
    });
    const carriers = [...new Set(live.depots.map(d => CARRIER[d.method] || d.method))].join(' + ');
    const base = { source: 'dropbuy', region: shipping.regionOf(province), weight_gram: live.weight_gram, live: { fee: live.fee, depots: live.depots, quoted_at: new Date().toISOString() } };
    if (rules.freeShipThreshold > 0 && subtotal >= rules.freeShipThreshold) {
      return { ...base, fee: 0, free_ship: true, detail: `Miễn phí ship cho đơn từ ${rules.freeShipThreshold.toLocaleString('vi-VN')} đ` };
    }
    const fee = live.fee + rules.liveExtra;
    return { ...base, fee, free_ship: false, detail: `${carriers}${live.depots.length > 1 ? ` – ${live.depots.length} kho` : ''}${live.weight_gram ? `, ${(live.weight_gram / 1000).toLocaleString('vi-VN')} kg` : ''}` };
  } catch (e) {
    console.warn('[Ship] Không lấy được phí ship DropBuy:', e.message);
    return flat(e.code === 401 ? 'chưa kết nối kho' : 'kho chưa phản hồi');
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || false, methods: ['GET', 'POST'] }
});

const PORT = process.env.HOANGMINH_PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const MAX_QTY_PER_ITEM = 50;

// Sau reverse proxy (nginx / Cloudflare) đặt TRUST_PROXY=1 để lấy đúng IP khách cho giới hạn tần suất
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(cors({ origin: process.env.CORS_ORIGIN || false }));
app.use(express.json({ limit: '100kb' }));
// --- Trang có SEO (render phía server) – đặt trước static để "/" không trả index.html trần ---
app.get('/', (req, res) => {
  res.type('html').send(seo.renderHomePage(req, readConfig(), scraper.getProducts().length));
});

app.get('/sp/:slugId', async (req, res) => {
  const id = parseInt(String(req.params.slugId), 10);
  const product = scraper.getProducts().find(p => p.id === id);
  if (!product) return res.redirect(302, '/');
  // Sai slug (tên SP đổi) → chuyển về URL chuẩn
  const canonical = seo.productPath(product);
  if (decodeURIComponent(req.path) !== canonical) return res.redirect(301, canonical);
  // Chỉ dùng chi tiết đã cache (không gọi DropBuy cho mỗi lượt bot Google/Facebook)
  let detail = null;
  try {
    const f = path.join(DATA_DIR, 'products_detail', `${id}.json`);
    if (fs.existsSync(f)) detail = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {}
  res.type('html').send(seo.renderProductPage(req, product, detail, readConfig()));
});

app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(seo.sitemapXml(req, scraper.getProducts())));
app.get('/robots.txt', (req, res) => res.type('text/plain').send(seo.robotsTxt(req)));

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

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
  const { dropbuy_cost, profit_margin, is_wholesale_price, public_price, wholesale_price, pricing_rule, ...rest } = p;
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
    subtotal: o.subtotal ?? o.total_amount,
    shipping_fee: o.shipping_fee || 0,
    shipping_detail: o.shipping_detail || null,
    cancel_reason: o.cancel_reason || null,
    items: (o.items || []).map(i => ({ id: i.id, name: i.name, variant_name: i.variant_name || null, price: i.price, quantity: i.quantity, image: i.image })),
    customer: { name: o.customer?.name, phone: maskPhone(o.customer?.phone), province: o.customer?.province || null, ward_name: o.customer?.ward_name || null },
    payment: o.payment,
    payment_method: o.payment_method || 'BANK',
    shipping_ref_code: o.dropbuy_sync?.shipping_ref_code || null,
    paid_at: o.paid_at || null
  };
}

const SECRET_KEYS = ['password', 'cookieHeader', 'sessionToken', 'cookies'];
function redactConfig(cfg) {
  const out = JSON.parse(JSON.stringify(cfg || {}));
  if (out.dropbuy) for (const k of SECRET_KEYS) if (k in out.dropbuy) out.dropbuy[k] = out.dropbuy[k] ? '***' : '';
  if (out.dropbuy?.user?.sid) out.dropbuy.user.sid = '***';
  return out;
}

/** Hình thức thanh toán khách được chọn. COD: shipper thu hộ, DropBuy trả lại quỹ. BANK: khách chuyển khoản cho shop. */
const PAYMENT_DEFAULTS = { cod: { enabled: true, maxTotal: 5000000 }, bank: { enabled: true } };
function bankReady(cfg) {
  const b = cfg.bank || {};
  return /^\d{6}$/.test(String(b.bankId || '')) && /^\d{4,20}$/.test(String(b.accountNo || '')) && !!b.accountName;
}
function paymentOptions(cfg = readConfig()) {
  const p = cfg.payments || {};
  const codMax = Number(p.cod?.maxTotal);
  return {
    cod: { enabled: p.cod?.enabled !== false, maxTotal: Number.isFinite(codMax) && codMax > 0 ? codMax : PAYMENT_DEFAULTS.cod.maxTotal },
    bank: { enabled: p.bank?.enabled !== false && bankReady(cfg) }
  };
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

// Image fallback for browsers that cannot hotlink DropBuy's CDN.
// Strictly public catalog images; never proxies arbitrary URLs or account headers.
app.get('/api/catalog-image/:id', async (req, res) => {
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1)return res.sendStatus(404);
  const product=scraper.getProducts().find(p=>Number(p.id)===id);
  if(!product)return res.sendStatus(404);
  try {
    const result=await catalogImage.imageForProduct(product);
    if(!result)return res.sendStatus(404);
    res.set('Content-Type',result.mime);
    res.set('Cache-Control','public, max-age=43200');
    res.set('X-Content-Type-Options','nosniff');
    return res.send(result.buffer);
  }catch(error){
    res.set('Cache-Control','no-store');
    return res.status(503).type('text/plain').send('Ảnh tạm thời không tải được');
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

const liveRefreshAt = new Map();
app.get('/api/products/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const product = scraper.getProducts().find(p => p.id === id);
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    // Làm mới giá/tồn kho trực tiếp từ DropBuy (chạy nền, tối đa 1 lần / 30s mỗi SP); thay đổi được đẩy qua socket
    const last = liveRefreshAt.get(id) || 0;
    if (Date.now() - last > 30000) {
      liveRefreshAt.set(id, Date.now());
      realtimeSync.liveCheck([id]).catch(() => {});
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
    merged.variants = await variants.variantsWithPrices(product, detail).catch(() => []);
    merged.variation_options = detail.variation_options || [];
    delete merged.variations;
    res.json({ success: true, data: merged });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Vận chuyển ---
// Phường/xã mới (2 cấp) theo mã DropBuy – cần cho đơn dropship tự động
app.get('/api/address/wards', async (req, res) => {
  try {
    const r = await vnAddress.wardsOfProvince(String(req.query.province || ''));
    if (!r) return res.status(404).json({ success: false, error: 'Không tìm thấy tỉnh/thành' });
    res.set('Cache-Control', 'public, max-age=3600').json({ success: true, data: { province: r.province, wards: r.wards.map(w => ({ id: w.id, name: w.name })) } });
  } catch (e) {
    res.status(503).json({ success: false, error: 'Chưa tải được danh mục phường/xã' });
  }
});

app.get('/api/checkout/options', (req, res) => {
  res.json({ success: true, data: paymentOptions() });
});

app.get('/api/shipping/provinces', (req, res) => {
  res.json({ success: true, data: shipping.PROVINCES.map(([name, region]) => ({ name, region, region_label: shipping.REGION_LABEL[region] })) });
});

/** Tính giá & khối lượng từng dòng giỏ theo dữ liệu đã đồng bộ (không gọi trực tiếp DropBuy) */
async function priceCartLines(items) {
  const catalog = new Map(scraper.getProducts().map(p => [p.id, p]));
  const lines = [];
  for (const it of items) {
    const p = catalog.get(Number(it.id));
    if (!p) continue;
    const qty = Math.max(1, Math.min(MAX_QTY_PER_ITEM, Number(it.quantity) || 1));
    let price = p.price;
    let weight = 0;
    // Chi tiết (cache 6h) cho biết giá theo phân loại và khối lượng thật để tính phí ship
    const detail = await detailScraper.fetchProductFullDetail(p, false).catch(() => null);
    const vs = await variants.variantsWithPrices(p, detail).catch(() => []);
    const v = vs.find(x => x.id === it.variation_id) || vs.find(x => x.id === p.variation_id) || (vs.length === 1 ? vs[0] : null);
    if (v) { price = v.price; weight = v.weight_gram; }
    lines.push({ id: p.id, name: p.name, variation_id: v?.id || it.variation_id || p.variation_id || null, quantity: qty, price, weight_gram: weight });
  }
  return lines;
}

app.post('/api/shipping/quote', rateLimit('quote', 10 * 60e3, 60), async (req, res) => {
  try {
    const { province, items, ward_id } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ success: false, error: 'Giỏ hàng trống' });
    if (!shipping.regionOf(province)) return res.status(400).json({ success: false, error: 'Vui lòng chọn Tỉnh/Thành phố nhận hàng hợp lệ.' });
    const lines = await priceCartLines(items.slice(0, 30));
    const subtotal = lines.reduce((s, l) => s + l.price * l.quantity, 0);
    const q = await quoteShipping({ province, wardId: Number(ward_id) || null, subtotal, lines });
    res.json({ success: true, data: { subtotal, shipping_fee: q.fee, total: subtotal + q.fee, ...q } });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Tạo đơn: giá, tên, phân loại lấy từ DropBuy/catalog phía server – không tin dữ liệu giá client gửi lên
app.post('/api/orders/checkout', rateLimit('checkout', 10 * 60e3, 8), async (req, res) => {
  try {
    const { customer, items } = req.body || {};
    const name = String(customer?.name || '').trim();
    const phone = String(customer?.phone || '').replace(/[\s.-]/g, '');
    const address = String(customer?.address || '').trim();
    const province = String(customer?.province || '').trim();
    const paymentMethod = req.body?.payment_method === 'COD' ? 'COD' : 'BANK';
    const payOpts = paymentOptions();
    if (paymentMethod === 'COD' && !payOpts.cod.enabled) return res.status(400).json({ success: false, error: 'Cửa hàng chưa nhận thanh toán khi nhận hàng (COD).' });
    if (paymentMethod === 'BANK' && !payOpts.bank.enabled) return res.status(400).json({ success: false, error: 'Cửa hàng chưa nhận chuyển khoản – vui lòng chọn thanh toán khi nhận hàng.' });
    if (!name || !address || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Vui lòng cung cấp đầy đủ họ tên, số điện thoại, địa chỉ và sản phẩm.' });
    }
    if (!/^(0|\+84)\d{9,10}$/.test(phone)) {
      return res.status(400).json({ success: false, error: 'Số điện thoại không hợp lệ.' });
    }
    if (!shipping.regionOf(province)) return res.status(400).json({ success: false, error: 'Vui lòng chọn Tỉnh/Thành phố nhận hàng.' });
    if (items.length > 30) return res.status(400).json({ success: false, error: 'Tối đa 30 mặt hàng mỗi đơn.' });
    // Phường/xã phải đúng danh mục DropBuy để kho giao đúng địa chỉ
    let addr = null;
    try {
      addr = await vnAddress.resolve(province, customer?.ward_id);
    } catch (e) {
      console.warn('[Checkout] Không tải được danh mục phường/xã:', e.message);
    }
    if (!addr) return res.status(400).json({ success: false, error: 'Vui lòng chọn Phường/Xã nhận hàng.' });

    const known = new Map(scraper.getProducts().map(p => [p.id, p]));
    // Gộp theo SP + phân loại
    const merged = new Map();
    for (const it of items) {
      const id = Number(it?.id);
      const qty = Number(it?.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_ITEM) {
        return res.status(400).json({ success: false, error: `Số lượng không hợp lệ (1–${MAX_QTY_PER_ITEM}).` });
      }
      if (!known.has(id)) return res.status(400).json({ success: false, error: `Sản phẩm #${it?.id} không còn tồn tại.` });
      const vid = it?.variation_id ? String(it.variation_id) : null;
      const key = `${id}:${vid || ''}`;
      const cur = merged.get(key) || { id, variation_id: vid, quantity: 0, expected: null };
      cur.quantity = Math.min(MAX_QTY_PER_ITEM, cur.quantity + qty);
      if (Number.isFinite(Number(it?.price))) cur.expected = Number(it.price);
      merged.set(key, cur);
    }

    // Cập nhật catalog chung (giá/tồn kho cấp SP) chạy song song
    realtimeSync.liveCheck([...new Set([...merged.values()].map(l => l.id))]).catch(() => {});

    // Kiểm tra TRỰC TIẾP từng dòng (SKU phân loại) trên DropBuy
    const checked = await Promise.all([...merged.values()].map(async l => ({ line: l, r: await variants.checkLine(known.get(l.id), l.variation_id) })));
    const problems = [];
    for (const { line, r } of checked) {
      const label = `"${r.name || known.get(line.id).name}${r.variant_name ? ` – ${r.variant_name}` : ''}"`;
      if (!r.ok) problems.push({ id: line.id, variation_id: line.variation_id, reason: r.in_stock === false ? 'OUT_OF_STOCK' : 'INVALID', message: r.message || `${label} hiện không đặt được.` });
      else if (line.expected != null && line.expected !== r.price) problems.push({ id: line.id, variation_id: line.variation_id, reason: 'PRICE_CHANGED', old_price: line.expected, price: r.price, message: `Giá ${label} vừa đổi từ ${line.expected.toLocaleString('vi-VN')} đ thành ${r.price.toLocaleString('vi-VN')} đ.` });
    }
    if (problems.length) {
      return res.status(409).json({ success: false, error: problems.map(x => x.message).join(' '), problems, lines: checked.map(({ line, r }) => ({ id: line.id, variation_id: line.variation_id, price: r.price ?? null, in_stock: !!r.ok })) });
    }

    const orderItems = checked.map(({ line, r }) => {
      const p = known.get(line.id);
      return { id: line.id, sku: r.sku, variation_id: r.variation_id, variant_name: r.variant_name || null, name: p.name, price: r.price, quantity: line.quantity, image: p.image, weight_gram: r.weight_gram || 0, dropbuy_url: p.dropbuy_url, dropbuy_cost: r.cost, cost_is_wholesale: !!r.cost_is_wholesale, live_verified: r.live };
    });
    const subtotal = orderItems.reduce((s, i) => s + i.price * i.quantity, 0);
    // Cùng cách tính với lúc khách xem (phí DropBuy thật được nhớ 30 phút) → khách trả đúng số đã thấy
    const ship = await quoteShipping({ province, wardId: addr.ward.id, subtotal, lines: orderItems });
    const total_amount = subtotal + ship.fee;
    if (paymentMethod === 'COD' && total_amount > payOpts.cod.maxTotal) {
      return res.status(400).json({ success: false, error: `Đơn trên ${payOpts.cod.maxTotal.toLocaleString('vi-VN')} đ vui lòng chọn chuyển khoản.` });
    }

    const order = orderStore.createOrder({
      customer: {
        name: name.slice(0, 100), phone, province, address: address.slice(0, 300), note: String(customer?.note || '').slice(0, 500),
        province_id: addr.province.id, province_name: addr.province.name, ward_id: addr.ward.id, ward_name: addr.ward.name
      },
      items: orderItems,
      total_amount,
      payment_method: paymentMethod
    });
    orderStore.updateOrder(order.id, { subtotal, shipping_fee: ship.fee, shipping_detail: ship.detail, shipping_source: ship.source, shipping_live: ship.live || null, weight_gram: ship.weight_gram, live_verified: orderItems.every(i => i.live_verified) });
    order.subtotal = subtotal;
    order.shipping_fee = ship.fee;
    console.log(`[Order] Đã tiếp nhận đơn hàng #${order.id}: ${subtotal.toLocaleString('vi-VN')} đ + ship ${ship.fee.toLocaleString('vi-VN')} đ`);
    notify.newOrder({ ...order, items: orderItems });

    if (paymentMethod === 'COD') {
      // Không cần chờ tiền: đặt kho ngay (hoặc đưa vào giỏ nếu chưa bật tự đặt)
      setImmediate(() => {
        dropbuyOrderFulfillment.handOff(order.id, io).catch(err => console.error(`[DropBuy] Đơn COD ${order.id} chưa đặt được:`, err.message));
      });
      return res.json({
        success: true,
        orderId: order.id,
        payment_method: 'COD',
        subtotal,
        shipping_fee: ship.fee,
        shipping_detail: ship.detail,
        total_amount,
        items: orderItems.map(i => ({ id: i.id, variation_id: i.variation_id, variant_name: i.variant_name, name: i.name, price: i.price, quantity: i.quantity })),
        message: `Đặt hàng thành công! Bạn thanh toán ${total_amount.toLocaleString('vi-VN')} đ khi nhận hàng.`
      });
    }

    setImmediate(() => {
      relay.processOrderFulfillment(order, io).catch(err => {
        console.error(`[Relay Error] Lỗi xử lý đơn #${order.id}:`, err.message);
        io.to(order.id).emit('ORDER_STATUS_UPDATE', { orderId: order.id, status: 'ERROR', message: `Không tạo được mã thanh toán: ${err.message} Vui lòng liên hệ cửa hàng.` });
        notify.paymentIssue(`Đơn ${order.id}: không tạo được mã QR – ${err.message}`);
      });
    });

    const timeout = orderExpiry.normalizeOrderRules(readConfig().orders || {}).paymentTimeoutMinutes;
    res.json({
      success: true,
      orderId: order.id,
      subtotal,
      shipping_fee: ship.fee,
      shipping_detail: ship.detail,
      total_amount,
      payment_method: 'BANK',
      payment_timeout_minutes: timeout,
      items: orderItems.map(i => ({ id: i.id, variation_id: i.variation_id, variant_name: i.variant_name, name: i.name, price: i.price, quantity: i.quantity })),
      message: 'Đơn hàng đã được tạo. Đang khởi tạo mã thanh toán...'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/orders/:id', rateLimit('order', 10 * 60e3, 300), (req, res) => {
  const order = orderStore.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
  res.json({ success: true, data: publicOrder(order) });
});

// Khách báo đã chuyển khoản → chờ admin đối soát (KHÔNG tự đánh dấu đã thanh toán)
app.post('/api/orders/:id/report-paid', rateLimit('report', 10 * 60e3, 20), (req, res) => {
  const order = orderStore.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
  if (order.status !== 'PENDING_PAYMENT') {
    return res.json({ success: true, data: publicOrder(order), message: 'Đơn hàng đã được ghi nhận trước đó.' });
  }
  const updated = orderStore.updateOrder(order.id, { status: 'PAYMENT_REPORTED', payment_reported_at: new Date().toISOString() });
  io.emit('ADMIN_PAYMENT_REPORTED', { orderId: order.id, total_amount: order.total_amount });
  notify.paymentReported(updated);
  res.json({ success: true, data: publicOrder(updated), message: 'Đã ghi nhận. Cửa hàng sẽ xác nhận ngay khi nhận được tiền.' });
});

// Khách tra cứu đơn: cần đúng mã đơn + số điện thoại đặt hàng
const normPhone = v => String(v || '').replace(/\D/g, '').replace(/^84/, '0');
app.get('/api/orders/:id/track', rateLimit('track', 10 * 60e3, 30), (req, res) => {
  const order = orderStore.getOrderById(String(req.params.id || '').toUpperCase());
  if (!order || !req.query.phone || normPhone(order.customer?.phone) !== normPhone(req.query.phone)) {
    return res.status(404).json({ success: false, error: 'Không tìm thấy đơn với mã và số điện thoại này.' });
  }
  const timeline = [
    { status: 'CREATED', at: order.created_at, label: order.payment_method === 'COD' ? 'Đặt hàng – thanh toán khi nhận' : 'Đặt hàng' },
    order.payment_reported_at && { status: 'PAYMENT_REPORTED', at: order.payment_reported_at, label: 'Đã báo chuyển khoản' },
    order.paid_at && { status: 'PAID', at: order.paid_at, label: 'Cửa hàng đã nhận tiền' },
    order.processing_at && { status: 'PROCESSING', at: order.processing_at, label: order.dropbuy_sync?.shipping_ref_code ? `Đang giao – mã vận đơn ${order.dropbuy_sync.shipping_ref_code}` : 'Kho đang chuẩn bị hàng' },
    order.completed_at && { status: 'COMPLETED', at: order.completed_at, label: 'Giao hàng thành công' },
    order.cancelled_at && { status: 'CANCELLED', at: order.cancelled_at, label: order.cancel_reason || 'Đã huỷ' }
  ].filter(Boolean);
  res.json({ success: true, data: { ...publicOrder(order), address: order.customer?.address, timeline } });
});

/** Xác nhận đã nhận tiền (admin bấm tay hoặc webhook ngân hàng) – dùng chung để ghi nguồn & báo Telegram */
function confirmOrderPayment(orderId, meta = {}) {
  const order = relay.confirmPayment(orderId, io);
  if (!order) return null;
  const updated = orderStore.updateOrder(orderId, { payment_via: meta.via || 'admin', payment_tx: meta.tx_id || null, paid_amount: meta.amount ?? order.total_amount });
  io.emit('ADMIN_ORDER_CHANGED', { orderId, status: 'PAID' });
  notify.paymentConfirmed(updated, meta.via === 'admin' ? 'admin xác nhận' : `tự động qua ${meta.via}`);

  // Tự đặt đơn DropBuy (nếu bật) hoặc đưa vào giỏ cho admin đặt tay
  setImmediate(() => {
    dropbuyOrderFulfillment.handOff(orderId, io).catch(err => {
      console.error(`[DropBuy] Đơn #${orderId} chưa đặt được trên DropBuy:`, err.message);
    });
  });

  return updated;
}

function processBankTransactions(txs) {
  return txs.map(tx => payments.handleTransaction(tx, {
    confirm: (orderId, meta) => confirmOrderPayment(orderId, meta),
    onIssue: entry => {
      io.emit('ADMIN_ORDER_CHANGED', { orderId: entry.order_id });
      if (entry.result !== 'ALREADY_PAID') notify.paymentIssue(`${entry.result}: ${entry.amount.toLocaleString('vi-VN')} đ – "${entry.content}"${entry.note ? ` (${entry.note})` : ''}`);
    }
  }));
}

// Webhook SePay: cấu hình URL https://<domain>/api/webhooks/sepay, kiểu xác thực "API Key" = SEPAY_WEBHOOK_KEY
app.post('/api/webhooks/sepay', (req, res) => {
  const key = process.env.SEPAY_WEBHOOK_KEY;
  if (!key) return res.status(503).json({ success: false, error: 'Chưa cấu hình SEPAY_WEBHOOK_KEY' });
  const auth = String(req.get('authorization') || '').replace(/^Apikey\s+/i, '');
  if (!payments.safeEqual(auth, key)) return res.status(401).json({ success: false, error: 'Sai API key' });
  const results = processBankTransactions(payments.fromSepay(req.body));
  res.status(200).json({ success: true, results });
});

// Webhook Casso: header "secure-token" = CASSO_SECURE_TOKEN
app.post('/api/webhooks/casso', (req, res) => {
  const token = process.env.CASSO_SECURE_TOKEN;
  if (!token) return res.status(503).json({ error: 1, message: 'Chưa cấu hình CASSO_SECURE_TOKEN' });
  if (!payments.safeEqual(req.get('secure-token'), token)) return res.status(401).json({ error: 1, message: 'Sai secure-token' });
  const results = processBankTransactions(payments.fromCasso(req.body));
  res.json({ error: 0, message: 'ok', results });
});

// --- ADMIN API (cần header x-admin-key) ---

app.get('/api/admin/session', requireAdmin, (req, res) => res.json({ success: true }));

app.post('/api/orders/:id/confirm-payment', requireAdmin, (req, res) => {
  try {
    const order = confirmOrderPayment(req.params.id, { via: 'admin' });
    if (!order) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
    res.json({ success: true, message: 'Đã xác nhận thanh toán thành công!', order });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/orders/:id/status', requireAdmin, (req, res) => {
  const { status, note } = req.body || {};
  if (!orderStore.STATUSES.includes(status)) return res.status(400).json({ success: false, error: 'Trạng thái không hợp lệ' });
  const stamp = { PROCESSING: 'processing_at', COMPLETED: 'completed_at', CANCELLED: 'cancelled_at' }[status];
  const order = orderStore.updateOrder(req.params.id, { status, admin_note: note || undefined, ...(stamp ? { [stamp]: new Date().toISOString() } : {}), ...(status === 'CANCELLED' && !note ? { cancel_reason: 'Cửa hàng huỷ đơn' } : {}) });
  if (!order) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
  io.to(order.id).emit('ORDER_STATUS_UPDATE', { orderId: order.id, status, message: `Đơn hàng chuyển sang trạng thái ${status}` });
  res.json({ success: true, data: order });
});

// Đặt đơn dropship trên DropBuy ngay (trừ quỹ) – dùng khi tự đặt đang tắt hoặc lần tự đặt trước bị chặn
app.post('/api/admin/orders/:id/place-dropbuy', requireAdmin, async (req, res) => {
  try {
    const r = await dropbuyOrderFulfillment.placeOrderOnDropbuy(req.params.id, io, { manual: true });
    res.json({ success: true, message: `Đã đặt trên DropBuy: ${r.orders.map(x => x.code).join(', ')} – trừ quỹ ${r.spend.toLocaleString('vi-VN')} đ.`, data: r });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/orders/:id/cancel-dropbuy', requireAdmin, async (req, res) => {
  try {
    const order = await dropbuyOrderFulfillment.cancelOnDropbuy(req.params.id, io);
    res.json({ success: true, message: order.refund_needed ? 'Đã huỷ trên DropBuy. Khách đã chuyển khoản – nhớ hoàn tiền.' : 'Đã huỷ trên DropBuy.', data: order });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Cài đặt tự đặt đơn + hình thức thanh toán + tình trạng quỹ/phiên DropBuy
app.get('/api/admin/auto-order', requireAdmin, async (req, res) => {
  const cfg = readConfig();
  const out = {
    autoOrder: dropbuyOrderFulfillment.normalizeAutoOrder(cfg.autoOrder),
    payments: paymentOptions(cfg),
    paymentsSaved: cfg.payments || null,
    bankReady: bankReady(cfg),
    spentToday: dropbuyOrderFulfillment.spentToday(),
    session: null,
    balance: null
  };
  try {
    const s = await dropbuySession.ensureSession(cfg);
    if (s) {
      out.session = { username: s.user?.username, name: s.user?.name, expiresAt: s.expiresAt, otpRequiredAbove: s.user?.otp_required_above || 0 };
      const bal = await dropbuySession.bff('/balance/my-balance', { config: cfg });
      out.balance = { available: bal?.avail_balance_current ?? null, deposit: bal?.deposit_balance_current ?? null };
    }
  } catch (e) {
    out.sessionError = e.message;
  }
  res.json({ success: true, data: out });
});

app.post('/api/admin/auto-order', requireAdmin, (req, res) => {
  const b = req.body || {};
  const cfg = readConfig();
  if (b.autoOrder) cfg.autoOrder = dropbuyOrderFulfillment.normalizeAutoOrder({ ...(cfg.autoOrder || {}), ...b.autoOrder });
  if (b.payments) {
    const cur = cfg.payments || {};
    const maxTotal = Number(b.payments.cod?.maxTotal ?? cur.cod?.maxTotal);
    cfg.payments = {
      cod: { enabled: b.payments.cod?.enabled ?? cur.cod?.enabled ?? true, maxTotal: Number.isFinite(maxTotal) && maxTotal > 0 ? Math.round(maxTotal) : PAYMENT_DEFAULTS.cod.maxTotal },
      bank: { enabled: b.payments.bank?.enabled ?? cur.bank?.enabled ?? true }
    };
    if (!cfg.payments.cod.enabled && !(cfg.payments.bank.enabled && bankReady(cfg))) {
      return res.status(400).json({ success: false, error: 'Phải bật ít nhất 1 hình thức thanh toán (COD, hoặc chuyển khoản đã có tài khoản ngân hàng).' });
    }
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  res.json({ success: true, data: { autoOrder: dropbuyOrderFulfillment.normalizeAutoOrder(cfg.autoOrder), payments: paymentOptions(cfg) } });
});

app.get('/api/admin/report', requireAdmin, (req, res) => {
  const days = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 30));
  res.json({ success: true, data: reports.salesReport(orderStore.getOrders(), { days }) });
});

app.get('/api/admin/backups', requireAdmin, (req, res) => {
  res.json({ success: true, data: backup.listBackups() });
});

app.post('/api/admin/backups', requireAdmin, (req, res) => {
  try {
    const r = backup.runBackup({ force: true });
    res.json({ success: true, data: { day: path.basename(r.dir), files: r.copied } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/payments', requireAdmin, (req, res) => {
  res.json({ success: true, data: payments.recentPayments(50), configured: { sepay: !!process.env.SEPAY_WEBHOOK_KEY, casso: !!process.env.CASSO_SECURE_TOKEN, telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) } });
});

// Đưa đơn đã nhận tiền vào giỏ DropBuy (bấm tay = cho phép đưa lại)
app.post(['/api/admin/orders/:id/fulfill-dropbuy', '/api/admin/orders/:id/push-dropbuy-cart'], requireAdmin, async (req, res) => {
  try {
    const result = await dropbuyOrderFulfillment.fulfillOrderOnDropbuy(req.params.id, io, { force: true });
    if (!result.success) return res.status(400).json({ success: false, error: 'Chưa đăng nhập DropBuy – đăng nhập ở mục DropBuy trong admin trước.' });
    res.json({ success: true, message: 'Đã đưa vào giỏ DropBuy. Đặt đơn dropship tới khách rồi dán mã đơn DropBuy vào admin.', data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Admin đã đặt trên DropBuy → gắn mã đơn để tự theo dõi tới khi giao xong
app.post('/api/admin/orders/:id/dropbuy-code', requireAdmin, (req, res) => {
  try {
    const order = dropbuyOrderFulfillment.attachDropbuyCode(req.params.id, req.body?.code, io);
    res.json({ success: true, data: order });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Đồng bộ trạng thái các đơn đang xử lý từ DropBuy
app.post('/api/admin/orders/sync-dropbuy-status', requireAdmin, async (req, res) => {
  try {
    const r = await dropbuyOrderFulfillment.syncDropbuyOrdersStatus(io);
    if (r.skipped) return res.status(400).json({ success: false, error: 'Chưa đăng nhập DropBuy.' });
    res.json({ success: true, message: `Đã kiểm tra ${r.checked} đơn trên DropBuy.`, data: r });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  res.json({ success: true, data: orderStore.getOrders() });
});

app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json({ success: true, data: redactConfig(readConfig()) });
});

// Chỉ cho sửa các trường cấu hình an toàn; không ghi đè phiên đăng nhập DropBuy
app.post('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const cfg = readConfig();
    cfg.dropbuy = { ...(cfg.dropbuy || {}) };
    if (typeof b.dropbuy?.simulationMode === 'boolean') cfg.dropbuy.simulationMode = b.dropbuy.simulationMode;
    if (typeof b.dropbuy?.username === 'string') cfg.dropbuy.username = b.dropbuy.username.trim();
    if (b.pricing) {
      const m = Number(b.pricing.markupPercent);
      if (!Number.isFinite(m) || m < 0 || m > 300) return res.status(400).json({ success: false, error: 'Markup phải từ 0 đến 300%' });
      cfg.pricing = pricing.normalizeRules({ ...(cfg.pricing || {}), markupPercent: m });
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
    const changed = b.pricing ? await realtimeSync.repriceNow() : 0;
    res.json({ success: true, message: b.pricing ? `Đã lưu cấu hình và cập nhật giá ${changed} sản phẩm.` : 'Đã lưu cấu hình thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/sync', requireAdmin, (req, res) => {
  realtimeSync.runFullSync5Min(io)
    .then(() => io.emit('CATALOG_SYNC_COMPLETED', { total: scraper.getProducts().length }))
    .catch(err => console.error('[Manual sync]:', err.message));
  res.json({ success: true, message: 'Đã bắt đầu quét lại toàn bộ kho DropBuy (giá + tồn kho).' });
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
    const { username, password, totp_code } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Vui lòng nhập tài khoản và mật khẩu DropBuy' });
    }
    const result = await dropbuyAuth.loginDropbuy(username, password, totp_code);
    realtimeSync.runFullSync5Min(io).catch(err => console.error('[Sync after login]:', err.message));
    io.emit('DROPBUY_AUTH_CHANGED', { authenticated: true });
    res.json({ success: true, message: 'Đăng nhập DropBuy thành công! Đang đồng bộ lại giá sỉ.', data: { username: result.username, method: result.method } });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/dropbuy/set-cookie', requireAdmin, async (req, res) => {
  try {
    const result = await dropbuyAuth.setManualCookie(req.body?.cookie);
    realtimeSync.runFullSync5Min(io).catch(err => console.error('[Sync after set-cookie]:', err.message));
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

// --- Thiết lập giá bán (giá gốc DropBuy + % lãi) ---

function pricingStats(products) {
  const sellable = products.filter(p => p.in_stock !== false);
  const profits = sellable.map(p => p.price - (p.dropbuy_cost || 0));
  const belowPublic = products.filter(p => p.public_price && p.price <= p.public_price).length;
  return {
    total: products.length,
    wholesaleCount: products.filter(p => p.wholesale_price > 0).length,
    sellable: sellable.length,
    avgProfit: profits.length ? Math.round(profits.reduce((a, b) => a + b, 0) / profits.length) : 0,
    negativeProfit: products.filter(p => p.price < (p.dropbuy_cost || 0)).length,
    belowOrEqualPublic: belowPublic,
    abovePublic: products.length - belowPublic
  };
}

app.get('/api/admin/pricing', requireAdmin, async (req, res) => {
  const cfg = readConfig();
  const rules = pricing.normalizeRules(cfg.pricing || {});
  const products = scraper.getProducts();
  const rootMap = pricing.rootCategoryMap(scraper.getCategories());
  const roots = scraper.getCategories().filter(c => !c.parent_id).map(c => ({
    id: c.id,
    name: c.name,
    product_count: products.filter(p => (rootMap.get(p.category_id) ?? p.category_id) === c.id).length,
    markupPercent: rules.categoryMarkups[String(c.id)] ?? null
  })).filter(c => c.product_count > 0).sort((a, b) => b.product_count - a.product_count);
  const auth = await dropbuyAuth.getAuthStatus().catch(() => ({ authenticated: false }));
  res.json({ success: true, data: { rules, categories: roots, stats: pricingStats(products), dropbuy: { authenticated: !!auth.authenticated, username: auth.username || null, message: auth.message } } });
});

app.post('/api/admin/pricing', requireAdmin, async (req, res) => {
  try {
    const cfg = readConfig();
    const current = pricing.normalizeRules(cfg.pricing || {});
    const b = req.body || {};
    cfg.pricing = pricing.normalizeRules({
      ...current,
      ...b,
      // Ghi đè từng SP không bị xoá khi lưu form chung
      productOverrides: b.productOverrides ?? current.productOverrides
    });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    const changed = await realtimeSync.repriceNow();
    res.json({ success: true, message: `Đã lưu thiết lập giá. ${changed} sản phẩm được cập nhật giá ngay.`, data: { rules: cfg.pricing, stats: pricingStats(scraper.getProducts()) } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/pricing/products', requireAdmin, (req, res) => {
  const { search = '', page = 1, limit = 20, filter = '' } = req.query;
  const rules = pricing.normalizeRules(readConfig().pricing || {});
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
  let list = scraper.getProducts();
  if (search) list = list.filter(p => norm(p.name).includes(norm(search)) || norm(p.sku).includes(norm(search)) || String(p.id) === String(search));
  if (filter === 'override') list = list.filter(p => rules.productOverrides[String(p.id)]);
  if (filter === 'low') list = list.filter(p => p.price - (p.dropbuy_cost || 0) < Math.max(rules.minProfit, 1));
  if (filter === 'abovePublic') list = list.filter(p => p.public_price && p.price > p.public_price);
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const rows = list.slice((pageNum - 1) * lim, pageNum * lim).map(p => ({
    id: p.id, sku: p.sku, name: p.name, image: p.image, category_name: p.category_name, in_stock: p.in_stock !== false,
    public_price: p.public_price, wholesale_price: p.wholesale_price || null, cost: p.dropbuy_cost, price: p.price,
    profit: p.price - (p.dropbuy_cost || 0), rule: p.pricing_rule, override: rules.productOverrides[String(p.id)] || null, dropbuy_url: p.dropbuy_url
  }));
  res.json({ success: true, total: list.length, page: pageNum, totalPages: Math.ceil(list.length / lim) || 1, data: rows });
});

// Đặt giá riêng 1 SP: { product_id, type: 'percent'|'fixed', value } – value null/'' = xoá giá riêng
app.post('/api/admin/pricing/override', requireAdmin, async (req, res) => {
  const { product_id, type, value } = req.body || {};
  const id = Number(product_id);
  if (!scraper.getProducts().some(p => p.id === id)) return res.status(404).json({ success: false, error: 'Không tìm thấy sản phẩm' });
  const cfg = readConfig();
  const rules = pricing.normalizeRules(cfg.pricing || {});
  if (value === null || value === '' || value === undefined) delete rules.productOverrides[String(id)];
  else {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ success: false, error: 'Giá trị không hợp lệ' });
    rules.productOverrides[String(id)] = { type: type === 'fixed' ? 'fixed' : 'percent', value: v };
  }
  cfg.pricing = rules;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  await realtimeSync.repriceNow();
  const p = scraper.getProducts().find(x => x.id === id);
  res.json({ success: true, data: { id, price: p.price, cost: p.dropbuy_cost, profit: p.price - p.dropbuy_cost, rule: p.pricing_rule, override: rules.productOverrides[String(id)] || null } });
});

// --- Phí vận chuyển & hạn thanh toán ---
app.get('/api/admin/shipping', requireAdmin, (req, res) => {
  const cfg = readConfig();
  res.json({ success: true, data: { shipping: shipping.normalizeShipping(cfg.shipping || {}), orders: orderExpiry.normalizeOrderRules(cfg.orders || {}) } });
});

app.post('/api/admin/shipping', requireAdmin, (req, res) => {
  const cfg = readConfig();
  const b = req.body || {};
  if (b.shipping) cfg.shipping = shipping.normalizeShipping(b.shipping);
  if (b.orders) cfg.orders = orderExpiry.normalizeOrderRules(b.orders);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  res.json({ success: true, message: 'Đã lưu phí vận chuyển & hạn thanh toán.', data: { shipping: cfg.shipping, orders: cfg.orders } });
});

// Kiểm tra kết nối các API DropBuy
app.get('/api/admin/dropbuy-health', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: await checkDropbuy() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()), products: scraper.getProducts().length }));

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
  realtimeSync.startRealtimeSync(io);
  orderExpiry.startOrderExpiry(io, readConfig);
  backup.startBackups();

  // Định kỳ mỗi 2 phút đồng bộ trạng thái đơn hàng từ DropBuy đến khi hoàn tất
  setInterval(() => {
    dropbuyOrderFulfillment.syncDropbuyOrdersStatus(io).catch(err => {
      console.warn('[DropBuy Sync Interval Error]:', err.message);
    });
  }, 2 * 60 * 1000).unref();
});
