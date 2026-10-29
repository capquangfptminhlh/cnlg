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
const { requireAdmin, rateLimit, securityHeaders, forceHttps, getAdminPassword, sanitizeHtml, maskPhone, isAdminCookie, isAdminRequest, setAdminCookie, clearAdminCookie, emitAdmin, safeEqual, stripSupplierText, renderAdminLoginGate } = require('./services/security');
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
const watchdog = require('./services/dropbuyWatchdog');
const vault = require('./services/credentialVault');
const customerMessage = require('./services/customerMessage');
const catalogImage = require('./services/catalogImage');
const storeCatalog = require('./services/catalog');   // DropBuy + các nguồn sỉ khác, chỉ đọc cho trang khách
const sources = require('./services/sources');
const besiMarketplace = require('./services/besi/routes');
const besiSpecs = require('./services/besi/specIndex');
const besiCategoryFacets = require('./services/besi/categoryFacets');
const { createStore: createSpecReviewStore } = require('./services/besi/specReviewStore');
const besiSpecLocalAI = require('./services/besi/specLocalAI');
const specReviewStore = createSpecReviewStore();
const shipments = require('./services/shipments');
const deliveryEta = require('./services/deliveryEta');

const CARRIER = { V: 'Viettel Post', S: 'SPX Express' };
/**
 * Phí ship tính cho khách. Mặc định = phí thật DropBuy báo cho đúng các món + phường nhận (+ liveExtra),
 * miễn phí nếu đạt ngưỡng (shop chịu). Không lấy được (chưa đăng nhập / DropBuy lỗi) → bảng phí cố định, ghi "ước tính".
 * lines: [{ variation_id, quantity, name, weight_gram }]
 */
/**
 * Phí ship cả giỏ = tổng phí từng KIỆN (services/shipments.js):
 *  - mỗi nguồn sỉ một nhà cung cấp (TechMall…) = 1 kiện, phí theo chính sách của nguồn;
 *  - DropBuy: mỗi kho / nhà phân phối = 1 kiện. Có phí thật (đủ phường/xã) thì lấy theo từng kho DropBuy trả về,
 *    không thì ước tính theo bảng phí cho TỪNG kiện. Mức miễn ship xét theo giá trị từng kiện, không gộp cả đơn.
 */
async function quoteShipping({ province, wardId, lines, cfg = readConfig() }) {
  const groups = shipments.groupShipments(lines, {
    sourceOf: id => storeCatalog.sourceOf(id),
    depotOf: id => storeCatalog.findProduct(id)?.depot_code || null
  });
  if (!groups.length) throw new Error('Giỏ hàng trống');
  const parts = [];
  const dropGroups = groups.filter(g => g.kind === 'dropbuy');
  if (dropGroups.length) parts.push(...await quoteDropbuyShipments({ province, wardId, groups: dropGroups, cfg }));
  for (const g of groups.filter(x => x.kind === 'source')) {
    parts.push({ ...g.source.shippingQuote({ province, subtotal: g.subtotal }), source: 'partner', key: g.key, items: g.lines.length, subtotal: g.subtotal, refs: g.lines.map(shipments.refOf), eta: deliveryEta.estimate({ fromProvince: g.source.def.originProvince, toProvince: province }) });
  }
  return shipments.combineQuotes(parts);
}

/** Phần khách xem: chỉ số kiện, phí, số món – không mã kho, không tên nguồn. */
const publicShipments = q => (q.shipments || []).map(x => ({ no: x.no, fee: x.fee, free_ship: x.free_ship, items: x.items, subtotal: x.subtotal, eta: x.eta?.text || null }));

async function quoteDropbuyShipments({ province, wardId, groups, cfg }) {
  const rules = shipping.normalizeShipping(cfg.shipping);
  const flat = note => groups.map(g => {
    const q = shipping.quote({ province, subtotal: g.subtotal, lines: g.lines }, cfg.shipping);
    return { ...q, source: 'flat', key: g.key, items: g.lines.length, subtotal: g.subtotal, refs: g.lines.map(shipments.refOf), eta: deliveryEta.estimate({ toProvince: province }), detail: note && !q.free_ship ? `${q.detail} (ước tính)` : q.detail, live_error: note || null };
  });
  if (rules.mode !== 'live' || !rules.enabled) return flat();
  if (!wardId) return flat('chọn phường/xã để tính phí thật');
  const lines = groups.flatMap(g => g.lines);
  try {
    const addr = await vnAddress.resolve(province, wardId);
    if (!addr) return flat('phường/xã không hợp lệ');
    const live = await shippingLive.liveQuote({
      lines: lines.map(l => ({ variation_id: l.variation_id, quantity: l.quantity, name: l.name })),
      provinceId: addr.province.id,
      wardId: addr.ward.id,
      codAmount: shipments.sum(lines),
      method: dropbuyOrderFulfillment.normalizeAutoOrder(cfg.autoOrder).shippingMethod,
      config: cfg
    });
    // Kho DropBuy trả về là căn cứ chia kiện (chuẩn hơn mã kho lưu trong catalog); tỉnh kho → ngày giao dự kiến
    const origins = await Promise.all(live.depots.map(d => (d.sender_province_id ? vnAddress.provinceById(d.sender_province_id).catch(() => null) : null)));
    const parts = live.depots.map((d, di) => {
      const mine = lines.filter(l => (d.variation_ids || []).includes(l.variation_id));
      const subtotal = shipments.sum(mine);
      const free = rules.freeShipThreshold > 0 && subtotal >= rules.freeShipThreshold;
      return {
        source: 'dropbuy', key: `db:${d.code}`, items: mine.length, subtotal, live_fee: d.fee, refs: mine.map(shipments.refOf),
        eta: deliveryEta.estimate({ fromProvince: origins[di], toProvince: province }),
        region: shipping.regionOf(province),
        fee: free ? 0 : d.fee + rules.liveExtra, free_ship: free,
        detail: free ? `Miễn phí ship cho kiện từ ${rules.freeShipThreshold.toLocaleString('vi-VN')} đ` : (CARRIER[d.method] || d.method)
      };
    });
    if (parts.length && parts.every(x => x.items > 0)) {
      parts[0].weight_gram = live.weight_gram;
      return parts;
    }
    // Bản báo phí cũ không kèm danh sách món từng kho → chia theo tỉ lệ không được, coi cả phần DropBuy là các kho đã báo
    const subtotal = shipments.sum(lines);
    return live.depots.map((d, i) => ({ source: 'dropbuy', key: `db:${d.code}`, items: i ? 0 : lines.length, subtotal: i ? 0 : subtotal, refs: i ? [] : lines.map(shipments.refOf), eta: deliveryEta.estimate({ fromProvince: origins[i], toProvince: province }), live_fee: d.fee, region: shipping.regionOf(province), fee: d.fee + rules.liveExtra, free_ship: false, detail: CARRIER[d.method] || d.method }));
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
app.use(forceHttps);
app.use(securityHeaders);
app.use(cors({ origin: process.env.CORS_ORIGIN || false }));
app.use(express.json({ limit: '100kb' }));
// --- Trang có SEO (render phía server) – đặt trước static để "/" không trả index.html trần ---
app.get('/', (req, res) => {
  res.type('html').send(seo.renderHomePage(req, readConfig(), storeCatalog.getProducts().length));
});

app.get('/sp/:slugId', async (req, res) => {
  try {
    const id = parseInt(String(req.params.slugId), 10);
    if (!Number.isFinite(id) || id <= 0) return res.redirect(302, '/');
    const product = storeCatalog.findProduct(id);
    if (!product) return res.redirect(302, '/');
    // Sai slug (tên SP đổi) → chuyển về URL chuẩn
    const canonical = seo.productPath(product);
    let decodedPath = req.path;
    try { decodedPath = decodeURIComponent(req.path); } catch {}
    if (decodedPath !== canonical) return res.redirect(301, canonical);
    // Chỉ dùng chi tiết đã cache (không gọi DropBuy cho mỗi lượt bot Google/Facebook)
    let detail = null;
    const src = storeCatalog.sourceOf(id);
    if (src) detail = src.detail(product);
    else try {
      const f = path.join(DATA_DIR, 'products_detail', `${id}.json`);
      if (fs.existsSync(f)) detail = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {}
    res.type('html').send(seo.renderProductPage(req, product, detail, readConfig()));
  } catch (err) {
    res.redirect(302, '/');
  }
});

app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(seo.sitemapXml(req, storeCatalog.getProducts().filter(p => Number(p.price) > 0 && !p.removed_from_dropbuy && scraper.hasRealPhoto(p)))));
app.get('/favicon.ico', (req, res) => res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').sendFile(path.join(__dirname, 'public', 'favicon.svg')));
app.get('/robots.txt', (req, res) => res.type('text/plain').send(seo.robotsTxt(req)));

// Cổng bảo vệ tài nguyên Quản trị phía server: chặn hoàn toàn khách chưa xác thực đọc admin.html / admin.js / CSS nội bộ
app.use((req, res, next) => {
  let decoded = req.path || '';
  try { decoded = decodeURIComponent(decoded); } catch (e) {}
  if (decoded.toLowerCase().startsWith('/api/')) return next();
  const base = path.posix.basename(decoded.replace(/[.\s/\\]+$/, '')).toLowerCase();
  if (!base.startsWith('admin')) return next();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  if (base === 'admin.html' || base === 'admin-besi.html') {
    if (!isAdminRequest(req)) {
      const cfg = readConfig();
      return res.status(200).type('html').send(renderAdminLoginGate(cfg.store?.name || 'Hoàng Minh Store'));
    }
    return res.sendFile(path.join(__dirname, 'public', base));
  }
  if (!isAdminRequest(req)) {
    return res.status(404).type('text/plain').send('Not Found');
  }
  const allowed = { 'admin.js': 'admin.js', 'admin-portal.css': 'admin-portal.css', 'admin-theme.css': 'admin-theme.css', 'admin-besi.js': 'admin-besi.js', 'admin-besi.css': 'admin-besi.css' }[base];
  if (!allowed) return res.status(404).type('text/plain').send('Not Found');
  return res.sendFile(path.join(__dirname, 'public', allowed));
});

app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders(res, filePath) {
    if (/admin\.(html|js)$|admin-(portal|theme)\.css$|dialogs\.js$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (/(storefront-match\.css|flash-sale\.(css|js)|app\.js|marketplace-home\.js|motion\.js)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');

    }
  }
}));

io.on('connection', socket => {
  if (isAdminCookie(socket.handshake?.headers?.cookie)) {
    socket.join('admins');
  }
  socket.on('join-admin', key => {
    if (typeof key === 'string' && key && safeEqual(key, getAdminPassword())) {
      socket.join('admins');
    }
  });
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
  // Không lộ nguồn hàng cho khách: bỏ giá vốn/biên lãi và link/mã SP bên nguồn
  const { dropbuy_cost, profit_margin, is_wholesale_price, public_price, wholesale_price, pricing_rule, dropbuy_url, dropbuy_id,
    shop_name, fs_program_code, removed_from_dropbuy, stock_qty, warranty_type, warranty_duration, cost, supplier, techmall_id, permalink,
    source, source_id, source_url, dealer_price, retail_price, supplier_cost, removed, description, gallery, api_image, images_for, images_v,
    shop_id, depot_code, _normName, _normBrand, _normSku, _hay, _tokens, variants, ...rest } = p;

  if (rest.image) rest.image = catalogImage.maskMediaUrl(rest.image);
  if (rest.image_hd) rest.image_hd = catalogImage.maskMediaUrl(rest.image_hd);
  if (rest.warranty) rest.warranty = stripSupplierText(rest.warranty);
  if (rest.name) rest.name = stripSupplierText(rest.name);
  if (rest.description) rest.description = stripSupplierText(rest.description);

  const discount = p.original_price && p.original_price > p.price ? Math.round((1 - p.price / p.original_price) * 100) : 0;
  const out = {
    ...rest,
    original_price: discount > 70 ? null : (p.original_price || null),
    discount_percent: discount > 70 ? 0 : discount
  };

  if (Array.isArray(variants)) {
    out.variants = variants.map(v => {
      const vDisc = v.original_price && v.original_price > v.price ? Math.round((1 - v.price / v.original_price) * 100) : 0;
      return {
        id: String(v.id),
        sku: v.sku || String(v.id),
        name: stripSupplierText(v.name),
        is_default: !!v.is_default,
        in_stock: v.in_stock !== false,
        price: v.price,
        original_price: vDisc > 70 ? null : (v.original_price || null),
        discount_percent: vDisc > 70 ? 0 : vDisc,
        weight_gram: v.weight_gram || 0,
        warranty: stripSupplierText(v.warranty || rest.warranty || 'Bảo hành chính hãng'),
        image: v.image ? catalogImage.maskMediaUrl(v.image) : null,
        image_hd: v.image_hd ? catalogImage.maskMediaUrl(v.image_hd) : null
      };
    });
  }

  return out;
}

// --- BỘ NHỚ ĐỆM TỐI ƯU HIỆU NĂNG DANH MỤC & SẢN PHẨM ---
let lastCatalogRef = null;
let lastCategoriesRef = null;
let cachedSellable = null;
let cachedBrandsJson = null;
let cachedCategoriesJson = null;
let cachedDefaultMixed = null;
let cachedCategoryIdsMap = new Map();
let cachedSpecsIndex = null;
let cachedCategoryFacetsIndex = null;
let categoryFacetsBuiltAt = 0;
let specsIndexBuiltAt = 0;
let specsIndexReviewedRev = -1;
let lastFsSlot = -1;
let cachedFsData = null;

function ensureCatalogCaches() {
  const rawProducts = storeCatalog.getProducts();
  const rawCategories = storeCatalog.getCategories();
  if (cachedSellable && rawProducts === lastCatalogRef && rawCategories === lastCategoriesRef) {
    return;
  }
  lastCatalogRef = rawProducts;
  lastCategoriesRef = rawCategories;
  cachedSpecsIndex = null; // catalog changed: invalidate server-side faceted index
  cachedCategoryFacetsIndex = null;

  // 1. Phả hệ danh mục con -> cha (tìm nhanh O(1))
  cachedCategoryIdsMap.clear();
  const childrenMap = new Map();
  for (const c of rawCategories) {
    if (c.parent_id) {
      if (!childrenMap.has(c.parent_id)) childrenMap.set(c.parent_id, []);
      childrenMap.get(c.parent_id).push(c.id);
    }
  }
  for (const c of rawCategories) {
    const ids = new Set([c.id]);
    const queue = [c.id];
    while (queue.length) {
      const curr = queue.shift();
      const kids = childrenMap.get(curr);
      if (kids) {
        for (const k of kids) {
          if (!ids.has(k)) {
            ids.add(k);
            queue.push(k);
          }
        }
      }
    }
    cachedCategoryIdsMap.set(c.id, ids);
  }

  // 2. Lọc sẵn sản phẩm đủ điều kiện mở bán & tiền xử lý chuỗi tìm kiếm
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
  const sellable = [];
  const perCat = new Map();
  const brandCounts = new Map();

  for (const p of rawProducts) {
    if (!(Number(p.price) > 0) || p.removed_from_dropbuy || !scraper.hasRealPhoto(p)) continue;
    sellable.push(p);

    perCat.set(p.category_id, (perCat.get(p.category_id) || 0) + 1);

    const b = (p.brand || '').trim();
    if (b) {
      const normName = b.toLowerCase() === 'ulanzi' ? 'Ulanzi' : b;
      brandCounts.set(normName, (brandCounts.get(normName) || 0) + 1);
    }

    const n = norm(p.name);
    const nb = norm(p.brand || '');
    p._normName = n;
    p._normBrand = nb;
    p._normSku = norm(p.sku);
    p._hay = n + ' ' + p._normSku + (nb ? ' ' + nb : '');
    p._tokens = new Set((n + ' ' + nb).split(/[^a-z0-9]+/));
  }
  cachedSellable = sellable;

  // 3. Chuỗi JSON danh sách thương hiệu (phục vụ /api/brands trong 0.1ms)
  const brands = [...brandCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  cachedBrandsJson = JSON.stringify({ success: true, data: brands });

  // 4. Chuỗi JSON danh mục kèm số lượng SP (phục vụ /api/categories trong 0.1ms)
  const withCount = rawCategories.map(c => {
    let n = 0;
    const ids = cachedCategoryIdsMap.get(c.id) || new Set([c.id]);
    for (const id of ids) n += perCat.get(id) || 0;
    const { source, source_id, source_url, ...pub } = c;
    return { ...pub, icon: c.icon ? catalogImage.maskMediaUrl(c.icon) : c.icon, product_count: n };
  });
  cachedCategoriesJson = JSON.stringify({ success: true, data: withCount });

  // 5. Danh sách SP mặc định trang chủ (đã xen kẽ nguồn sỉ & ưu tiên còn hàng)
  const mixed = mixSources(sellable);
  cachedDefaultMixed = [...mixed.filter(p => p.in_stock !== false), ...mixed.filter(p => p.in_stock === false)];
  cachedFsData = null; // Huỷ cache flash sale khi catalog đổi
}

/** Danh mục cha bao gồm mọi danh mục con. */
function categoryIdsFor(catId) {
  ensureCatalogCaches();
  return cachedCategoryIdsMap.get(catId) || new Set([catId]);
}

/** Không để chữ "DropBuy" (nguồn hàng) lọt ra phía khách */
// Chữ khách xem: bỏ tên nguồn hàng, đổi "Admin" (từ nội bộ, có ở đơn cũ) thành "Cửa hàng"
const customerSafe = t => (t ? stripSupplierText(String(t)).replace(/\badmin\b/gi, 'Cửa hàng').replace(/\s{2,}/g, ' ').trim() || 'Đã huỷ' : t);

/** Dữ liệu đơn trả cho khách: che bớt thông tin cá nhân, không lộ thông tin nội bộ. */
const cleanText = t => (t ? stripSupplierText(String(t)).trim() || null : null);
const publicTracking = t => (t ? { status: cleanText(t.status), location: cleanText(t.location), updated_at: t.updated_at || null, expected_delivery: cleanText(t.expected_delivery) } : null);

function publicOrder(o) {
  return {
    id: o.id,
    status: o.status,
    created_at: o.created_at,
    total_amount: o.total_amount,
    subtotal: o.subtotal ?? o.total_amount,
    shipping_fee: o.shipping_fee || 0,
    shipping_detail: stripSupplierText(o.shipping_detail) || null,
    cancel_reason: customerSafe(o.cancel_reason) || null,
    items: (o.items || []).map(i => ({ id: i.id, name: i.name, variant_name: i.variant_name || null, price: i.price, quantity: i.quantity, image: catalogImage.maskMediaUrl(i.image) })),
    customer: { name: o.customer?.name, phone: maskPhone(o.customer?.phone), province: o.customer?.province || null, ward_name: o.customer?.ward_name || null },
    payment: o.payment,
    payment_method: o.payment_method || 'BANK',
    shipping_ref_code: o.dropbuy_sync?.shipping_ref_code || null,
    shipping_carrier: o.dropbuy_sync?.carrier || null,
    // Trước khi ĐVVC nhận hàng: ước tính lúc đặt; sau đó: ngày giao dự kiến + vị trí thật từ hành trình vận đơn
    delivery_eta: o.delivery_eta?.text || null,
    tracking: publicTracking(o.dropbuy_sync?.tracking),
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

// BESI multi-supplier core: authenticated operations and opt-in public catalog.
// Existing checkout and supplier adapters remain unchanged until the new flow is approved.
besiMarketplace.attach(app);

// --- PUBLIC API ---

app.get('/api/categories', (req, res) => {
  try {
    ensureCatalogCaches();
    res.set('Cache-Control', 'public, max-age=60');
    res.type('json').send(cachedCategoriesJson);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/brands', (req, res) => {
  try {
    ensureCatalogCaches();
    res.set('Cache-Control', 'public, max-age=60');
    res.type('json').send(cachedBrandsJson);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Image fallback for browsers that cannot hotlink DropBuy's CDN.
// Strictly public catalog images; never proxies arbitrary URLs or account headers.
app.get('/api/catalog-image/:id', async (req, res) => {
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1)return res.sendStatus(404);
  const product=storeCatalog.findProduct(id);
  if(!product||product.source)return res.sendStatus(404);
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

app.get(/^\/cdn\/((?:md2?|p[1-4])\/.+)$/, async (req, res) => {
  try {
    const result = await catalogImage.mediaFromCdnPath(req.params[0]);
    if (!result) return res.sendStatus(404);
    res.set('Content-Type', result.mime);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    return res.send(result.buffer);
  } catch (error) {
    res.set('Cache-Control', 'no-store');
    return res.status(503).type('text/plain').send('\u1ea2nh t\u1ea1m th\u1eddi kh\u00f4ng t\u1ea3i \u0111\u01b0\u1ee3c');
  }
});

/** Xen 1 món nguồn khác sau mỗi `every - 1` món DropBuy (giữ nguyên thứ tự trong từng nhóm). */
function mixSources(products, every = 4) {
  const own = products.filter(p => !storeCatalog.sourceOf(p.id));
  const other = products.filter(p => storeCatalog.sourceOf(p.id));
  if (!other.length || !own.length) return products;

  // Cân bằng các thương hiệu trong other (round-robin: Baseus, Vention, USAMS, Ulanzi, Mcdodo, Mark Ryden...)
  // để trang chủ luôn có đa dạng thương hiệu thay vì dồn toàn bộ Baseus lên 200 trang đầu
  const byBrand = new Map();
  other.forEach(p => {
    const rawB = p.brand || 'Khác';
    const b = rawB.toLowerCase() === 'ulanzi' ? 'Ulanzi' : rawB;
    if (!byBrand.has(b)) byBrand.set(b, []);
    byBrand.get(b).push(p);
  });
  const balancedOther = [];
  let added = true;
  let round = 0;
  while (added) {
    added = false;
    for (const list of byBrand.values()) {
      if (round < list.length) {
        balancedOther.push(list[round]);
        added = true;
      }
    }
    round++;
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < own.length || j < balancedOther.length) {
    if (j < balancedOther.length && (out.length % every === every - 1 || i >= own.length)) out.push(balancedOther[j++]);
    else out.push(own[i++]);
  }
  return out;
}

/** Public, indexed specification search across the ENTIRE sellable catalog.
 * No upstream API calls or supplier credentials. Refresh index periodically to
 * catch in-place stock/price updates, and immediately when catalog refs change.
 */
function specificationIndex(){
  ensureCatalogCaches();
  const reviewed=specReviewStore.snapshot();
  if(!cachedSpecsIndex||Date.now()-specsIndexBuiltAt>120000
    ||specsIndexReviewedRev!==reviewed.revision){
    cachedSpecsIndex=besiSpecs.buildIndex(cachedSellable,reviewed.records);
    specsIndexReviewedRev=reviewed.revision;
    specsIndexBuiltAt=Date.now();
  }
  return cachedSpecsIndex;
}
/** Category-specific full catalog facets: cases, chargers, power banks.
 * Prices / product identities always projected from the public catalog DTO.
 */
function categoryFacetIndex(){
  ensureCatalogCaches();
  if(!cachedCategoryFacetsIndex||Date.now()-categoryFacetsBuiltAt>120000){
    cachedCategoryFacetsIndex=besiCategoryFacets.buildIndex(cachedSellable);
    categoryFacetsBuiltAt=Date.now();
  }
  return cachedCategoryFacetsIndex;
}
// Values shown in accessory dropdowns are discovered from the current
// sellable catalog, not a frozen selection of old phone generations.
app.get('/api/products/category-facets',rateLimit('besi-category-options',60e3,80),(req,res)=>{
  try{
    const options=besiCategoryFacets.availableOptions(categoryFacetIndex(),String(req.query.category||''));
    res.set('Cache-Control','public, max-age=30').json({success:true,...options});
  }catch(e){
    const status=e.status===400?400:500;
    res.status(status).json({success:false,error:status===400?'Nhóm hàng không hợp lệ':'Không thể tải thông số'});
  }
});
app.get('/api/products/category-specs',rateLimit('besi-category-specs',60e3,60),(req,res)=>{
  try{
    const result=besiCategoryFacets.searchIndex(categoryFacetIndex(),req.query);
    const project=(row,reasons=[])=>{
      const {product,variant}=row;
      const pub=publicProduct(product);
      const match=variant?(pub.variants||[]).find(v=>String(v.id)===String(variant.id)):null;
      return {...pub,matched_variant:match?{
        id:match.id,name:match.name,price:match.price,
        image:match.image||null,in_stock:match.in_stock
      }:null,verified_spec:reasons.length===0,missing_specs:reasons};
    };
    res.set('Cache-Control','public, max-age=20');
    res.json({success:true,total:result.total,page:result.page,
      totalPages:result.totalPages,data:result.matched.map(row=>project(row)),
      possibleTotal:result.possibleTotal,possiblePage:result.possiblePage,
      possiblePages:result.possiblePages,
      possible:result.possible.map(({row,reasons})=>project(row,reasons))});
  }catch(e){
    res.status(e.status===400?400:500).json({success:false,
      error:e.status===400?'Bộ lọc ngành hàng không hợp lệ':'Không thể tìm kiếm lúc này'});
  }
});

app.get('/api/products/specs', rateLimit('besi-specs', 60e3, 60), (req,res)=>{
  try{
    const found=besiSpecs.searchIndex(specificationIndex(),req.query);
    const project=(row,reasons=[])=>{
      const {product,variant}=row;
      const pub=publicProduct(product);
      const matched=variant?(pub.variants||[]).find(v=>String(v.id)===String(variant.id)):null;
      return {...pub,matched_variant:matched?{
        id:matched.id,name:matched.name,price:matched.price,
        image:matched.image||null,in_stock:matched.in_stock
      }:null,verified_spec:reasons.length===0,
        missing_specs:reasons};
    };
    const data=found.matched.map(row=>project(row));
    const possible=found.possible.map(({row,reasons})=>project(row,reasons));
    res.set('Cache-Control','public, max-age=20');
    return res.json({success:true,total:found.total,page:found.page,
      totalPages:found.totalPages,data,
      possibleTotal:found.possibleTotal,possiblePage:found.possiblePage,
      possiblePages:found.possiblePages,possible});
  }catch(e){
    const status=e.status===400?400:500;
    return res.status(status).json({success:false,
      error:status===400?'Bộ lọc thông số không hợp lệ':'Không thể tìm kiếm lúc này'});
  }
});

/** Admin coverage dashboard: which source names require manual spec verification?
 * No supplier metadata or internal source prices are returned.
 */
app.get('/api/admin/besi/spec-coverage', requireAdmin, (req,res)=>{
  try{
    const summary=besiSpecs.coverage(specificationIndex(),{page:req.query.page||1,limit:50});
    res.set('Cache-Control','no-store').json({success:true,
      cableProducts:summary.cableProducts,indexedVariations:summary.indexedVariations,
      needsReview:summary.reviewCount,reviewedVariations:summary.reviewedVariations,
      page:summary.page,totalPages:summary.totalPages,
      review:summary.review.map(({product,reason})=>{
        const pub=publicProduct(product);
        return {id:pub.id,name:pub.name,reason};
      })});
  }catch(_){
    res.status(500).json({success:false,error:'Không thể tạo báo cáo thông số'});
  }
});

// All attribute corrections are private and require the existing admin gate.
// Product and variation IDs are resolved against the current catalog before
// saving; never accept a source URL, price or supplier name from the editor.
app.get('/api/admin/besi/spec-review/:id', requireAdmin, (req,res)=>{
  try{
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({success:false,error:'Mã sản phẩm không hợp lệ'});
    const item=storeCatalog.findProduct(id);
    if(!item)return res.status(404).json({success:false,error:'Sản phẩm không tồn tại'});
    const pub=publicProduct(item);
    const rows=(Array.isArray(pub.variants)&&pub.variants.length?
      pub.variants:[{id:'',name:'Thông số sản phẩm'}]).map(v=>{
      const key=String(id)+':'+String(v.id||'');
      const existing=specReviewStore.snapshot().records[key]||null;
      const combined=String(pub.name||'')+' '+String(v.name||'');
      return {id:v.id||'',name:v.name||'Sản phẩm',
        in_stock:v.in_stock!==false,proposed:{
          connector:besiSpecs.connectorOf(combined),
          length:besiSpecs.lengthOf(combined)||null,
          power:besiSpecs.powerOf(combined)||null,
          color:besiSpecs.colorOf(combined)||null,
          status:'gợi ý từ tên, chưa xác minh'
        },verified:existing};
    });
    res.set('Cache-Control','no-store').json({success:true,
      product:{id:pub.id,name:pub.name,variant_count:pub.variant_count||rows.length},
      variations:rows});
  }catch(_){res.status(500).json({success:false,error:'Không thể đọc thông số sản phẩm'});}
});
// Opt-in AI runs ONLY on local loopback. Suggestions never enter the
// verified index without the separate human-confirmed PUT action.
app.post('/api/admin/besi/spec-ai-suggest/:id',requireAdmin,rateLimit('spec-local-ai',60e3,6),async(req,res)=>{
  try{
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({success:false,error:'Mã sản phẩm không hợp lệ'});
    const product=storeCatalog.findProduct(id);
    if(!product)return res.status(404).json({success:false,error:'Không có sản phẩm'});
    const pub=publicProduct(product),variantId=String(req.body?.variantId||'');
    const variations=Array.isArray(pub.variants)?pub.variants:[];
    const variant=variantId?variations.find(x=>String(x.id)===variantId):null;
    if(variantId&&!variant)return res.status(404).json({success:false,error:'Không có phân loại'});
    if(!variantId&&(variations.length>1||Number(pub.variant_count||0)>1))
      return res.status(400).json({success:false,error:'Phải chọn đúng phân loại trước khi hỏi AI'});
    const suggestion=await besiSpecLocalAI.suggest({name:pub.name,variantName:variant?.name||''});
    res.set('Cache-Control','no-store').json({success:true,data:suggestion});
  }catch(e){
    const status=e.status===503?503:500;
    res.status(status).json({success:false,error:status===503?'AI nội bộ chưa được cấu hình':'Không lấy được gợi ý AI'});
  }
});
app.put('/api/admin/besi/spec-review/:id', requireAdmin, rateLimit('spec-review-write',60e3,45),(req,res)=>{
  try{
    if(String(req.body?.productId)!==String(req.params.id))
      return res.status(400).json({success:false,error:'Mã sản phẩm không khớp'});
    const result=specReviewStore.save(req.body,id=>storeCatalog.findProduct(id));
    cachedSpecsIndex=null;
    res.set('Cache-Control','no-store').json({success:true,record:result.record});
  }catch(e){res.status(e.status||500).json({success:false,
    error:e.status?e.message:'Không thể lưu thông số'});}
});
app.delete('/api/admin/besi/spec-review/:id', requireAdmin,rateLimit('spec-review-delete',60e3,45),(req,res)=>{
  try{
    const result=specReviewStore.remove(req.params.id,req.query.variantId||'');
    cachedSpecsIndex=null;
    res.set('Cache-Control','no-store').json({success:true,...result});
  }catch(e){res.status(e.status||500).json({success:false,error:e.status?e.message:'Không thể hủy xác minh'});}
});

app.get('/api/products', (req, res) => {
  try {
    const { category, search, brand, page = 1, limit = 24, sort = 'default', minPrice, maxPrice, inStock, flashSale } = req.query;
    ensureCatalogCaches();

    const isDefaultQuery = (!category || category === 'all') &&
      !search &&
      (!brand || brand === 'all') &&
      !minPrice &&
      !maxPrice &&
      !inStock &&
      !flashSale &&
      sort === 'default';

    let products;
    if (isDefaultQuery) {
      products = cachedDefaultMixed;
    } else {
      products = cachedSellable;

      if (category && category !== 'all') {
        const ids = categoryIdsFor(parseInt(category, 10));
        products = products.filter(p => ids.has(p.category_id));
      }

      if (brand && brand !== 'all') {
        const normB = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
        const targetBrand = normB(brand);
        products = products.filter(p => (p._normBrand || normB(p.brand || '')) === targetBrand);
      }

      let relevance = null;
      if (search) {
        const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
        const q = norm(search);
        const words = q.split(' ').filter(Boolean);
        const raw = String(search).toLowerCase().replace(/\s+/g, ' ').trim();
        relevance = new Map();
        products = products.filter(p => {
          const name = p._normName || norm(p.name);
          const brand = p._normBrand || norm(p.brand || '');
          const hay = p._hay || (name + ' ' + norm(p.sku) + (brand ? ' ' + brand : ''));
          const tokens = p._tokens || new Set((name + ' ' + brand).split(/[^a-z0-9]+/));
          if (!words.every(w => (w.length === 1 ? tokens.has(w) : hay.includes(w)))) return false;
          let score = 0;
          if (name.includes(q)) score += 4;
          if (name.startsWith(q)) score += 2;
          score += words.filter(w => tokens.has(w)).length / words.length * 2;
          if (String(p.name).toLowerCase().includes(raw)) score += 3;
          if ((p._normSku || norm(p.sku)) === q) score += 10;
          if (brand && brand === q) score += 20;
          else if (brand && brand.includes(q)) score += 10;
          relevance.set(p.id, score);
          return true;
        });
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
      if (flashSale === '1') products = products.filter(p => p.is_flash_sale && p.in_stock !== false);

      const validDisc = p => {
        if (!p.original_price || p.original_price <= p.price) return 0;
        const d = Math.round((1 - p.price / p.original_price) * 100);
        return d > 70 ? 0 : d;
      };

      if (sort === 'price-asc') {
        products.sort((a, b) => a.price - b.price);
      } else if (sort === 'price-desc') {
        products.sort((a, b) => b.price - a.price);
      } else if (sort === 'name-asc') {
        products.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
      } else if (sort === 'discount-desc') {
        products.sort((a, b) => (validDisc(b) - validDisc(a)) || ((b.is_flash_sale ? 1 : 0) - (a.is_flash_sale ? 1 : 0)) || (a.price - b.price));
      } else if (relevance) {
        products.sort((a, b) => relevance.get(b.id) - relevance.get(a.id));
      } else {
        products = mixSources(products);
      }
      products = [...products.filter(p => p.in_stock !== false), ...products.filter(p => p.in_stock === false)];
    }

    const total = products.length;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 24));
    const startIndex = (pageNum - 1) * limitNum;
    const items = products.slice(startIndex, startIndex + limitNum).map(publicProduct);

    res.set('Cache-Control', 'public, max-age=15');
    res.json({ success: true, total, page: pageNum, totalPages: Math.ceil(total / limitNum) || 1, data: items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Khung giờ Flash Sale Giá Sỉ trực tiếp từ catalog thật (xoay theo khung 3 giờ giờ Việt Nam)
app.get('/api/flash-sale', (req, res) => {
  try {
    ensureCatalogCaches();
    const vnOffsetMs = 7 * 3600 * 1000;
    const slotMs = 3 * 3600 * 1000;
    const nowMs = Date.now();
    const slotIndex = Math.floor((nowMs + vnOffsetMs) / slotMs);

    if (cachedFsData && lastFsSlot === slotIndex) {
      res.set('Cache-Control', 'public, max-age=60');
      return res.json(cachedFsData);
    }

    const sellable = cachedSellable.filter(p => p.in_stock !== false);
    const discOf = p => {
      if (!p.original_price || p.original_price <= p.price) return 0;
      const d = Math.round((1 - p.price / p.original_price) * 100);
      return d > 70 ? 0 : d;
    };
    const fsPool = sellable.filter(p => p.is_flash_sale && discOf(p) >= 15);
    const dealPool = fsPool.length >= 18 ? fsPool : sellable.filter(p => discOf(p) >= 25);

    const slotStartMs = slotIndex * slotMs - vnOffsetMs;
    const slotEndMs = slotStartMs + slotMs;
    const fmtHour = ms => {
      const h = new Date(ms + vnOffsetMs).getUTCHours();
      return `${String(h).padStart(2, '0')}:00`;
    };

    const byCat = new Map();
    const sorted = [...dealPool].sort((a, b) => discOf(b) - discOf(a));
    for (const p of sorted) {
      const cid = p.category_id || 0;
      if (!byCat.has(cid)) byCat.set(cid, []);
      byCat.get(cid).push(p);
    }
    const picked = [];
    const catLists = [...byCat.values()];
    let round = 0;
    while (picked.length < 18 && round < 10) {
      for (let i = 0; i < catLists.length && picked.length < 18; i++) {
        const list = catLists[(i + slotIndex) % catLists.length];
        const idx = (round + (slotIndex % Math.max(1, Math.min(5, list.length)))) % list.length;
        const cand = list[idx];
        if (cand && !picked.some(x => x.id === cand.id)) picked.push(cand);
      }
      round++;
    }

    const fsResult = {
      success: true,
      data: {
        slotLabel: `${fmtHour(slotStartMs)} – ${fmtHour(slotEndMs)}`,
        nextSlotLabel: fmtHour(slotEndMs),
        slotEndsAt: new Date(slotEndMs).toISOString(),
        stats: {
          totalSellable: sellable.length,
          totalFlashSale: sellable.filter(p => p.is_flash_sale).length,
          under99kCount: sellable.filter(p => p.price <= 99000).length,
          deepDealCount: sellable.filter(p => discOf(p) >= 25).length
        },
        items: picked.map(publicProduct)
      }
    };
    lastFsSlot = slotIndex;
    cachedFsData = fsResult;
    res.set('Cache-Control', 'public, max-age=60');
    res.json(fsResult);
  } catch (err) {
    res.status(500).json({ success: false, error: stripSupplierText(err.message) });
  }
});

const liveRefreshAt = new Map();
const productDetailCache = new Map();
const PRODUCT_DETAIL_TTL_MS = 60000;
const PRODUCT_DETAIL_MAX_SIZE = 500;

function setProductDetailCache(id, data) {
  if (productDetailCache.size >= PRODUCT_DETAIL_MAX_SIZE) {
    const now = Date.now();
    for (const [k, v] of productDetailCache.entries()) {
      if (now - v.at >= PRODUCT_DETAIL_TTL_MS) productDetailCache.delete(k);
    }
    while (productDetailCache.size >= PRODUCT_DETAIL_MAX_SIZE) {
      const oldestKey = productDetailCache.keys().next().value;
      productDetailCache.delete(oldestKey);
    }
  }
  productDetailCache.set(id, { data, at: Date.now() });
}

app.get('/api/products/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const cached = productDetailCache.get(id);
    if (cached && Date.now() - cached.at < PRODUCT_DETAIL_TTL_MS) {
      res.setHeader('Cache-Control', 'public, max-age=30');
      return res.json({ success: true, data: cached.data });
    }

    const product = storeCatalog.findProduct(id);
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    const src = storeCatalog.sourceOf(id);
    if (src) {
      // Nguồn sỉ khác: kiểm tra trực tiếp giá đại lý + tồn kho (chạy nền, tối đa 1 lần / 30s mỗi SP)
      if (Date.now() - (liveRefreshAt.get(id) || 0) > 30000) {
        liveRefreshAt.set(id, Date.now());
        src.liveCheck(product).catch(() => {});
      }
      const d = src.detail(product);
      const pub = publicProduct(product);
      const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;
      const variants = hasVariants
        ? product.variants.map(v => ({
            id: String(v.id), sku: v.sku || String(v.id), name: v.name, is_default: !!v.is_default, in_stock: v.in_stock !== false,
            price: v.price, original_price: v.original_price || null,
            discount_percent: v.original_price && v.original_price > v.price ? Math.round((1 - v.price / v.original_price) * 100) : 0,
            weight_gram: v.weight_gram || 0,
            warranty: stripSupplierText(v.warranty || product.warranty || 'Bảo hành chính hãng'),
            image: v.image ? catalogImage.maskMediaUrl(v.image) : null
          }))
        : [{ id: product.variation_id, sku: product.sku, name: 'Mặc định', is_default: true, in_stock: product.in_stock !== false,
            price: product.price, original_price: pub.original_price || null, discount_percent: pub.discount_percent || 0, weight_gram: product.weight_gram || 0, image: null }];

      const responseData = {
        ...pub, description: stripSupplierText(catalogImage.maskMediaHtml(sanitizeHtml(d.description))), video_url: null,
        variation_options: product.variation_options || [],
        gallery: (d.gallery || []).map(g => ({ url: catalogImage.maskMediaUrl(g.url), thumb: catalogImage.maskMediaUrl(g.thumb || g.url) })),
        variants
      };
      setProductDetailCache(id, responseData);
      res.setHeader('Cache-Control', 'public, max-age=30');
      return res.json({ success: true, data: responseData });
    }
    const isDropbuy = !product.supplier || product.supplier === 'dropbuy';
    if (isDropbuy) {
      const last = liveRefreshAt.get(id) || 0;
      if (Date.now() - last > 30000) {
        liveRefreshAt.set(id, Date.now());
        realtimeSync.liveCheck([id]).catch(() => {});
      }
    }
    const freshProduct = scraper.getProducts().find(p => p.id === id) || product;
    let detail;
    if (isDropbuy) {
      detail = await detailScraper.fetchProductFullDetail(freshProduct, false);
    } else {
      detail = {
        id: freshProduct.id,
        name: freshProduct.name,
        slug: freshProduct.slug,
        sku: freshProduct.sku,
        price: freshProduct.price,
        description: freshProduct.description || '',
        gallery: (freshProduct.gallery && freshProduct.gallery.length) ? freshProduct.gallery : [{ url: freshProduct.image, thumb: freshProduct.image }],
        warranty: freshProduct.warranty || 'Bảo hành chính hãng',
        in_stock: freshProduct.in_stock !== false,
        variations: [],
        variation_options: []
      };
    }
    // Giá / tồn kho luôn lấy từ catalog hiện tại (bản cache chi tiết có thể đã cũ)
    const merged = {
      ...detail,
      ...publicProduct(freshProduct),
      description: stripSupplierText(catalogImage.maskMediaHtml(sanitizeHtml(detail.description))),
      warranty: stripSupplierText((!detail.fetch_failed && detail.warranty) || freshProduct.warranty || 'Không bảo hành'),
      gallery: (detail.gallery || []).map(g => ({ ...g, url: catalogImage.maskMediaUrl(g.url), thumb: g.thumb ? catalogImage.maskMediaUrl(g.thumb) : g.thumb })),
      variations: detail.variations,
      video_url: catalogImage.maskMediaUrl(detail.video_url)
    };
    delete merged.dropbuy_cost;
    delete merged.dropbuy_url;
    delete merged.dropbuy_id;
    delete merged.rating;
    delete merged.sold_count;
    delete merged.shop_name;
    delete merged.fs_program_code;
    delete merged.removed_from_dropbuy;
    delete merged.stock_qty;
    delete merged.cache_version;
    delete merged.cached_at;
    delete merged.fetch_failed;

    const hasGroupedVariants = Array.isArray(product.variants) && product.variants.length > 0;
    if (hasGroupedVariants) {
      merged.variants = product.variants.map(v => ({
        id: String(v.id), sku: v.sku || String(v.id), name: v.name, is_default: !!v.is_default, in_stock: v.in_stock !== false,
        price: v.price, original_price: v.original_price || null,
        discount_percent: v.original_price && v.original_price > v.price ? Math.round((1 - v.price / v.original_price) * 100) : 0,
        weight_gram: v.weight_gram || 0,
        warranty: stripSupplierText(v.warranty || product.warranty || 'Bảo hành chính hãng'),
        image: v.image ? catalogImage.maskMediaUrl(v.image) : null
      }));
      merged.variation_options = product.variation_options || [];
    } else {
      merged.variants = (await variants.variantsWithPrices(freshProduct, detail).catch(() => [])).map(v => ({ ...v, image: v.image ? catalogImage.maskMediaUrl(v.image) : v.image }));
      merged.variation_options = detail.variation_options || [];
    }
    delete merged.variations;
    setProductDetailCache(id, merged);
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.json({ success: true, data: merged });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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
  const catalog = new Map(storeCatalog.getProducts().map(p => [p.id, p]));
  const lines = [];
  for (const it of items) {
    const p = catalog.get(Number(it.id));
    if (!p) continue;
    const qty = Math.max(1, Math.min(MAX_QTY_PER_ITEM, Number(it.quantity) || 1));
    if (p.source) {
      lines.push({ id: p.id, name: p.name, variation_id: p.variation_id, quantity: qty, price: p.price, weight_gram: p.weight_gram || 0, source: p.source });
      continue;
    }
    let price = p.price;
    let weight = 0;
    // Chi tiết (cache 6h) cho biết giá theo phân loại và khối lượng thật để tính phí ship
    let detail = null;
    if (!p.supplier || p.supplier === 'dropbuy') {
      detail = await detailScraper.fetchProductFullDetail(p, false).catch(() => null);
    }
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
    res.json({ success: true, data: { subtotal, fee: q.fee, shipping_fee: q.fee, total: subtotal + q.fee, free_ship: !!q.free_ship, region: q.region, weight_gram: q.weight_gram || 0, source: q.source === 'dropbuy' ? 'live' : 'flat', detail: stripSupplierText(q.detail || ''), shipments: publicShipments(q), eta: q.eta || null } });
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

    const known = new Map(storeCatalog.getProducts().map(p => [p.id, p]));
    // Gộp theo SP + phân loại
    const merged = new Map();
    for (const it of items) {
      const id = Number(it?.id);
      const qty = Number(it?.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_ITEM) {
        return res.status(400).json({ success: false, error: `Số lượng không hợp lệ (1–${MAX_QTY_PER_ITEM}).` });
      }
      if (!known.has(id)) {
        const found = storeCatalog.findProduct(id);
        if (found) known.set(id, found);
      }
      if (!known.has(id)) return res.status(400).json({ success: false, error: `Sản phẩm #${it?.id} không còn tồn tại.` });
      const vid = it?.variation_id ? String(it.variation_id) : null;
      const key = `${id}:${vid || ''}`;
      const cur = merged.get(key) || { id, variation_id: vid, quantity: 0, expected: null };
      cur.quantity = Math.min(MAX_QTY_PER_ITEM, cur.quantity + qty);
      if (Number.isFinite(Number(it?.price))) cur.expected = Number(it.price);
      merged.set(key, cur);
    }

    // Quét TRỰC TIẾP giá & tồn kho DropBuy ngay lúc khách bấm Đặt hàng (SP nguồn sỉ khác kiểm tra với nguồn của nó)
    await realtimeSync.liveCheck([...new Set([...merged.values()].map(l => l.id))].filter(id => !storeCatalog.sourceOf(id))).catch(() => {});
    const freshKnown = new Map(storeCatalog.getProducts().map(p => [p.id, p]));

    // Kiểm tra TRỰC TIẾP từng dòng (SKU phân loại + get-price không cache) trên DropBuy / nguồn sỉ
    const checked = await Promise.all([...merged.values()].map(async l => {
      const src = storeCatalog.sourceOf(l.id);
      const prod = freshKnown.get(l.id) || known.get(l.id);
      return { line: l, r: src ? await src.liveCheck(prod, l.variation_id) : await variants.checkLine(prod, l.variation_id) };
    }));
    const problems = [];
    for (const { line, r } of checked) {
      const label = `"${r.name || (freshKnown.get(line.id) || known.get(line.id)).name}${r.variant_name ? ` – ${r.variant_name}` : ''}"`;
      if (!r.ok) problems.push({ id: line.id, variation_id: line.variation_id, reason: r.in_stock === false ? 'OUT_OF_STOCK' : 'INVALID', message: stripSupplierText(r.message) || `${label} hiện không đặt được.` });
      else if (!(Number(r.price) > 0) || (Number(r.cost) > 0 && Number(r.price) < Number(r.cost))) problems.push({ id: line.id, variation_id: line.variation_id, reason: 'INVALID', message: `${label} đang cập nhật lại giá từ kho, vui lòng thử lại sau giây lát.` });
      else if (line.expected != null && line.expected !== r.price) problems.push({ id: line.id, variation_id: line.variation_id, reason: 'PRICE_CHANGED', old_price: line.expected, price: r.price, message: `Giá ${label} vừa đổi từ ${line.expected.toLocaleString('vi-VN')} đ thành ${r.price.toLocaleString('vi-VN')} đ.` });
    }
    if (problems.length) {
      return res.status(409).json({ success: false, error: problems.map(x => x.message).join(' '), problems, lines: checked.map(({ line, r }) => ({ id: line.id, variation_id: line.variation_id, price: r.price ?? null, in_stock: !!r.ok })) });
    }

    const orderItems = checked.map(({ line, r }) => {
      const p = known.get(line.id);
      return { id: line.id, sku: r.sku, variation_id: r.variation_id, variant_name: r.variant_name || null, name: p.name, price: r.price, quantity: line.quantity, image: p.image, weight_gram: r.weight_gram || 0, dropbuy_url: p.dropbuy_url, source: p.source || 'dropbuy', source_url: p.source_url || null, dropbuy_cost: r.cost, cost_is_wholesale: !!r.cost_is_wholesale, fs_program_code: r.fs_program_code || p.fs_program_code || null, live_verified: r.live };
    });
    const subtotal = orderItems.reduce((s, i) => s + i.price * i.quantity, 0);
    // Cùng cách tính với lúc khách xem (phí DropBuy thật được nhớ 30 phút) → khách trả đúng số đã thấy
    const ship = await quoteShipping({ province, wardId: addr.ward.id, subtotal, lines: orderItems });
    const total_amount = subtotal + ship.fee;
    for (const it of orderItems) it.shipment_no = (ship.shipments || []).find(x => x.refs.includes(shipments.refOf(it)))?.no || 1;
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
    orderStore.updateOrder(order.id, { subtotal, shipping_fee: ship.fee, shipping_detail: ship.detail, shipping_source: ship.source, shipping_live: ship.live || null, shipments: (ship.shipments || []).map(({ refs, ...x }) => x), delivery_eta: ship.eta || null, weight_gram: ship.weight_gram, live_verified: orderItems.every(i => i.live_verified) });
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
        delivery_eta: ship.eta?.text || null,
        total_amount,
        items: orderItems.map(i => ({ id: i.id, variation_id: i.variation_id, variant_name: i.variant_name, name: i.name, price: i.price, quantity: i.quantity })),
        message: `Đặt hàng thành công! Bạn thanh toán ${total_amount.toLocaleString('vi-VN')} đ khi nhận hàng.`
      });
    }

    setImmediate(() => {
      relay.processOrderFulfillment(order, io).catch(err => {
        console.error(`[Relay Error] Lỗi xử lý đơn #${order.id}:`, err.message);
        io.to(order.id).emit('ORDER_STATUS_UPDATE', { orderId: order.id, status: 'ERROR', message: 'Chưa tạo được mã thanh toán tự động. Vui lòng liên hệ cửa hàng để được hỗ trợ ngay.' });
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
      delivery_eta: ship.eta?.text || null,
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
  emitAdmin(io, 'ADMIN_PAYMENT_REPORTED', { orderId: order.id, total_amount: order.total_amount });
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
    order.cancelled_at && { status: 'CANCELLED', at: order.cancelled_at, label: customerSafe(order.cancel_reason) || 'Đã huỷ' }
  ].filter(Boolean);
  res.json({ success: true, data: { ...publicOrder(order), address: order.customer?.address, timeline } });
});

/** Xác nhận đã nhận tiền (admin bấm tay hoặc webhook ngân hàng) – dùng chung để ghi nguồn & báo Telegram */
function confirmOrderPayment(orderId, meta = {}) {
  const order = relay.confirmPayment(orderId, io);
  if (!order) return null;
  const updated = orderStore.updateOrder(orderId, { payment_via: meta.via || 'admin', payment_tx: meta.tx_id || null, paid_amount: meta.amount ?? order.total_amount });
  emitAdmin(io, 'ADMIN_ORDER_CHANGED', { orderId, status: 'PAID' });
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
      emitAdmin(io, 'ADMIN_ORDER_CHANGED', { orderId: entry.order_id });
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

app.all('/api/admin/session', requireAdmin, (req, res) => {
  setAdminCookie(req, res);
  res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  clearAdminCookie(req, res);
  res.json({ success: true });
});

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
  notify.notifyCustomerOrder(order).catch(() => {});
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
    watchdog: watchdog.getState(),
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

// Tin nhắn cho khách (nhân viên sao chép, gửi qua Zalo / SMS) theo trạng thái đơn
app.get('/api/admin/orders/:id/customer-message', requireAdmin, (req, res) => {
  const order = orderStore.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
  const base = seo.baseUrl(req);
  const cfg = readConfig();
  const msg = customerMessage.buildCustomerMessage(order, { storeName: cfg.store?.name || 'Hoàng Minh Store', trackUrl: `${base}/?tra-cuu=${encodeURIComponent(order.id)}` });
  res.json({ success: true, data: { ...msg, zalo: customerMessage.zaloLink(order.customer?.phone), phone: order.customer?.phone || null, local_link: !process.env.PUBLIC_BASE_URL } });
});

// Đánh dấu đơn thử (loại khỏi báo cáo, không tự đặt DropBuy)
app.post('/api/admin/orders/:id/test-flag', requireAdmin, (req, res) => {
  const o = orderStore.updateOrder(req.params.id, { is_test: req.body?.is_test !== false });
  if (!o) return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
  emitAdmin(io, 'ADMIN_ORDER_CHANGED', { orderId: o.id, status: o.status });
  res.json({ success: true, data: o });
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
    .then(() => emitAdmin(io, 'CATALOG_SYNC_COMPLETED', { total: scraper.getProducts().length }))
    .catch(err => console.error('[Manual sync]:', err.message));
  res.json({ success: true, message: 'Đã bắt đầu quét lại toàn bộ kho DropBuy (giá + tồn kho).' });
});

app.post('/api/admin/restart', requireAdmin, (req, res) => {
  res.json({ success: true, message: 'Cửa hàng đang khởi động lại (sẽ sẵn sàng sau ~5 giây)...' });
  console.log('[Admin] Nhận lệnh khởi động lại từ trang quản trị. Đang thoát tiến trình...');
  setTimeout(() => process.exit(0), 600);
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
        if (count % 10 === 0) emitAdmin(io, 'DOWNLOAD_PROGRESS', { current: count, total: products.length });
      } catch (e) {
        console.error(`[BatchDownloader] Lỗi #${p.id}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 300));
    }
    imageJobRunning = false;
    emitAdmin(io, 'DOWNLOAD_COMPLETED', { total: count });
  })();
});

app.post('/api/dropbuy/login', requireAdmin, async (req, res) => {
  try {
    const { username, password, totp_code, remember } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Vui lòng nhập tài khoản và mật khẩu DropBuy' });
    }
    const result = await dropbuyAuth.loginDropbuy(username, password, totp_code);
    // Ghi nhớ (mã hoá) để tự đăng nhập lại khi phiên hết hạn – chỉ khi chủ shop chọn, không áp dụng tài khoản có mã 2 bước
    if (remember === true && !totp_code) vault.save(String(username).trim(), String(password).trim());
    else if (remember === false) vault.clear();
    watchdog.resetRelogin();
    realtimeSync.runFullSync5Min(io).catch(err => console.error('[Sync after login]:', err.message));
    watchdog.tick(io).catch(err => console.error('[Watchdog after login]:', err.message));
    emitAdmin(io, 'DROPBUY_AUTH_CHANGED', { authenticated: true });
    res.json({ success: true, message: 'Đăng nhập DropBuy thành công! Đang đồng bộ lại giá sỉ.', data: { username: result.username, method: result.method } });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/dropbuy/set-cookie', requireAdmin, async (req, res) => {
  try {
    const result = await dropbuyAuth.setManualCookie(req.body?.cookie);
    realtimeSync.runFullSync5Min(io).catch(err => console.error('[Sync after set-cookie]:', err.message));
    watchdog.tick(io).catch(err => console.error('[Watchdog after set-cookie]:', err.message));
    emitAdmin(io, 'DROPBUY_AUTH_CHANGED', { authenticated: true });
    res.json({ success: true, message: result.message });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/dropbuy/forget-credentials', requireAdmin, (req, res) => {
  vault.clear();
  res.json({ success: true, message: 'Đã xoá tài khoản DropBuy đã lưu – sẽ không tự đăng nhập lại.' });
});

app.get('/api/dropbuy/auth-status', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: { ...(await dropbuyAuth.getAuthStatus()), remember: vault.info() } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/dropbuy/logout', requireAdmin, (req, res) => {
  const result = dropbuyAuth.logout();
  vault.clear(); // đăng xuất = không tự đăng nhập lại nữa
  emitAdmin(io, 'DROPBUY_AUTH_CHANGED', { authenticated: false });
  res.json(result);
});

// --- Thiết lập giá bán (giá gốc DropBuy + % lãi) ---

// Giá vốn / giá tham chiếu của 1 SP (DropBuy: giá niêm yết; nguồn sỉ khác: giá lẻ đề xuất)
const refPrice = p => p.public_price || p.retail_price || 0;

function pricingStats(products) {
  const sellable = products.filter(p => p.in_stock !== false);
  const profits = sellable.map(p => p.price - (p.dropbuy_cost || p.cost || 0));
  const belowPublic = products.filter(p => refPrice(p) && p.price <= refPrice(p)).length;
  return {
    total: products.length,
    wholesaleCount: products.filter(p => p.wholesale_price > 0 || p.dealer_price > 0 || p.cost > 0).length,
    sellable: sellable.length,
    avgProfit: profits.length ? Math.round(profits.reduce((a, b) => a + b, 0) / profits.length) : 0,
    negativeProfit: products.filter(p => p.price < (p.dropbuy_cost || p.cost || 0)).length,
    belowOrEqualPublic: belowPublic,
    abovePublic: products.length - belowPublic
  };
}

/**
 * Thiết lập giá theo từng nguồn: ?source=dropbuy (mặc định) hoặc mã nguồn sỉ (vd techmall).
 * Mỗi nguồn một bộ quy tắc riêng: DropBuy ở config.pricing, nguồn khác ở config.sources.<mã>.pricing.
 */
function pricingSource(key) {
  if (!key || key === 'dropbuy') {
    return {
      key: 'dropbuy', label: 'DropBuy',
      products: () => scraper.getProducts(),
      categories: () => scraper.getCategories(),
      rules: cfg => pricing.normalizeRules(cfg.pricing || {}),
      normalize: raw => pricing.normalizeRules(raw),
      store: (cfg, rules) => { cfg.pricing = rules; },
      reprice: () => realtimeSync.repriceNow()
    };
  }
  const src = sources.get(String(key));
  if (!src) return null;
  return {
    key: src.def.key, label: src.def.label,
    products: () => src.store.getProducts().filter(p => !p.removed),
    categories: () => src.store.getCategories(),
    rules: cfg => src.rules(cfg),
    normalize: raw => normalizeSourceRules(raw, src.def.pricingDefaults),
    store: (cfg, rules) => { cfg.sources = cfg.sources || {}; cfg.sources[src.def.key] = { ...(cfg.sources[src.def.key] || {}), pricing: rules }; },
    reprice: async () => src.reprice()
  };
}
const { normalizeSourceRules, isSellable } = require('./services/sources/woo');

function withPricingSource(handler) {
  return async (req, res) => {
    const ps = pricingSource(req.query.source || req.body?.source);
    if (!ps) return res.status(404).json({ success: false, error: 'Không có nguồn hàng này' });
    try { await handler(req, res, ps); } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  };
}

app.get('/api/admin/pricing', requireAdmin, withPricingSource(async (req, res, ps) => {
  const rules = ps.rules(readConfig());
  const products = ps.products();
  const cats = ps.categories();
  const rootMap = pricing.rootCategoryMap(cats);
  // Nguồn khác gom dưới 1 danh mục gốc → hiện các danh mục cấp 2 để đặt % riêng cho có ý nghĩa
  const topLevel = ps.key === 'dropbuy' ? cats.filter(c => !c.parent_id) : cats.filter(c => c.parent_id && !cats.find(x => x.id === c.parent_id)?.parent_id);
  const groupOf = id => {
    if (ps.key === 'dropbuy') return rootMap.get(id) ?? id;
    let cur = cats.find(c => c.id === id);
    while (cur && cur.parent_id && cats.find(x => x.id === cur.parent_id)?.parent_id) cur = cats.find(x => x.id === cur.parent_id);
    return cur?.id ?? id;
  };
  const counts = new Map();
  for (const p of products) counts.set(groupOf(p.category_id), (counts.get(groupOf(p.category_id)) || 0) + 1);
  const categories = topLevel.map(c => ({ id: c.id, name: c.name, product_count: counts.get(c.id) || 0, markupPercent: rules.categoryMarkups[String(c.id)] ?? null }))
    .filter(c => c.product_count > 0).sort((a, b) => b.product_count - a.product_count);
  const data = { source: ps.key, label: ps.label, rules, categories, stats: pricingStats(products), sources: [{ key: 'dropbuy', label: 'DropBuy' }, ...sources.all().map(x => ({ key: x.def.key, label: x.def.label }))] };
  if (ps.key === 'dropbuy') {
    const auth = await dropbuyAuth.getAuthStatus().catch(() => ({ authenticated: false }));
    data.dropbuy = { authenticated: !!auth.authenticated, username: auth.username || null, message: auth.message };
  } else {
    const st = sources.get(ps.key).status();
    data.partner = { logged_in: st.logged_in, username: st.username, sellable: st.sellable };
  }
  res.json({ success: true, data });
}));

app.post('/api/admin/pricing', requireAdmin, withPricingSource(async (req, res, ps) => {
  const cfg = readConfig();
  const current = ps.rules(cfg);
  const b = { ...(req.body || {}) };
  delete b.source;
  const rules = ps.normalize({
    ...current,
    ...b,
    // Ghi đè từng SP không bị xoá khi lưu form chung
    productOverrides: b.productOverrides ?? current.productOverrides
  });
  ps.store(cfg, rules);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  const changed = await ps.reprice();
  res.json({ success: true, message: `Đã lưu thiết lập giá ${ps.label}. ${changed} sản phẩm được cập nhật giá ngay.`, data: { rules, stats: pricingStats(ps.products()) } });
}));

app.get('/api/admin/pricing/products', requireAdmin, withPricingSource(async (req, res, ps) => {
  const { search = '', page = 1, limit = 20, filter = '' } = req.query;
  const rules = ps.rules(readConfig());
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
  let list = ps.products();
  if (ps.key !== 'dropbuy' && filter !== 'all') list = list.filter(p => p.image); // SP nguồn khác chưa có ảnh không lên kệ
  if (search) list = list.filter(p => norm(p.name).includes(norm(search)) || norm(p.sku).includes(norm(search)) || String(p.id) === String(search));
  if (filter === 'override') list = list.filter(p => rules.productOverrides[String(p.id)]);
  if (filter === 'low') list = list.filter(p => p.price - (p.dropbuy_cost || 0) < Math.max(rules.minProfit, 1));
  if (filter === 'abovePublic') list = list.filter(p => refPrice(p) && p.price > refPrice(p));
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const rows = list.slice((pageNum - 1) * lim, pageNum * lim).map(p => ({
    id: p.id, sku: p.sku, name: p.name, image: p.image, category_name: p.category_name, in_stock: p.in_stock !== false,
    public_price: refPrice(p), wholesale_price: p.wholesale_price || p.dealer_price || null, cost: p.dropbuy_cost, price: p.price,
    profit: p.price - (p.dropbuy_cost || 0), rule: p.pricing_rule, override: rules.productOverrides[String(p.id)] || null, dropbuy_url: p.dropbuy_url || p.source_url, is_flash_sale: !!p.is_flash_sale
  }));
  res.json({ success: true, total: list.length, page: pageNum, totalPages: Math.ceil(list.length / lim) || 1, data: rows });
}));

// Đặt giá riêng 1 SP: { product_id, type: 'percent'|'fixed', value, source } – value null/'' = xoá giá riêng
app.post('/api/admin/pricing/override', requireAdmin, withPricingSource(async (req, res, ps) => {
  const { product_id, type, value } = req.body || {};
  const id = Number(product_id);
  if (!ps.products().some(p => p.id === id)) return res.status(404).json({ success: false, error: 'Không tìm thấy sản phẩm' });
  const cfg = readConfig();
  const rules = ps.rules(cfg);
  if (value === null || value === '' || value === undefined) delete rules.productOverrides[String(id)];
  else {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ success: false, error: 'Giá trị không hợp lệ' });
    rules.productOverrides[String(id)] = { type: type === 'fixed' ? 'fixed' : 'percent', value: v };
  }
  ps.store(cfg, rules);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  await ps.reprice();
  const p = ps.products().find(x => x.id === id);
  res.json({ success: true, data: { id, price: p.price, cost: p.dropbuy_cost, profit: p.price - p.dropbuy_cost, rule: p.pricing_rule, override: rules.productOverrides[String(id)] || null } });
}));

// --- Nguồn hàng sỉ khác (TechMall, …): trạng thái, đăng nhập đại lý, quét ngay, cài đặt ---
const sourceOr404 = (req, res) => {
  const src = sources.get(req.params.key);
  if (!src) res.status(404).json({ success: false, error: 'Không có nguồn hàng này' });
  return src;
};

app.get('/api/admin/sources', requireAdmin, (req, res) => {
  const cfg = readConfig();
  res.json({ success: true, data: sources.all().map(s => ({
    ...s.status(),
    enabled: cfg.sources?.[s.def.key]?.enabled !== false,
    intervalMinutes: Number(cfg.sources?.[s.def.key]?.intervalMinutes) || s.def.intervalMinutes || 10,
    shipping: s.shippingRules(cfg)
  })) });
});

app.post('/api/admin/sources/:key/login', requireAdmin, rateLimit('srcLogin', 15 * 60e3, 10), async (req, res) => {
  const src = sourceOr404(req, res);
  if (!src) return;
  const { username, password, remember } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, error: 'Nhập tên đăng nhập và mật khẩu đại lý.' });
  try {
    await src.login(String(username).trim(), String(password), { remember: remember !== false });
    res.json({ success: true, message: `Đã đăng nhập ${src.def.label}. Đang quét lại giá đại lý...` });
    src.syncAll().catch(e => console.error(`[Nguồn ${src.def.label}]`, e.message));
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/sources/:key/logout', requireAdmin, (req, res) => {
  const src = sourceOr404(req, res);
  if (!src) return;
  src.logout();
  res.json({ success: true, message: `Đã đăng xuất ${src.def.label} và xoá mật khẩu đã lưu.` });
});

app.post('/api/admin/sources/:key/sync', requireAdmin, async (req, res) => {
  const src = sourceOr404(req, res);
  if (!src) return;
  try {
    const r = await src.syncAll();
    res.json({ success: true, message: `Đã quét ${r.fetched}/${r.total} SP, ${r.sellable} SP lên kệ, ${r.changed} thay đổi.`, data: r });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

// { enabled, intervalMinutes, shipping: { hcmFreeFrom, hcmFee, otherFreeFrom, otherFee } }
app.post('/api/admin/sources/:key/settings', requireAdmin, (req, res) => {
  const src = sourceOr404(req, res);
  if (!src) return;
  const b = req.body || {};
  const cfg = readConfig();
  cfg.sources = cfg.sources || {};
  const cur = cfg.sources[src.def.key] || {};
  cfg.sources[src.def.key] = {
    ...cur,
    enabled: b.enabled === undefined ? cur.enabled !== false : !!b.enabled,
    intervalMinutes: Math.min(180, Math.max(5, Number(b.intervalMinutes) || cur.intervalMinutes || src.def.intervalMinutes || 10)),
    shipping: b.shipping ? src.shippingRules({ sources: { [src.def.key]: { shipping: b.shipping } } }) : cur.shipping
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  res.json({ success: true, message: 'Đã lưu cài đặt nguồn hàng.', data: cfg.sources[src.def.key] });
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

// A public release fingerprint helps confirm that the running Windows
// process actually restarted on the newest GitHub commit (no secrets).
const besiRelease = (() => {
  const supplied = String(process.env.BESI_DEPLOY_SHA || '').trim();
  if (/^[0-9a-f]{7,40}$/i.test(supplied)) return supplied.slice(0, 12);
  try {
    const { execFileSync } = require('node:child_process');
    const sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: __dirname, timeout: 1200, encoding: 'utf8', windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return /^[0-9a-f]{7,12}$/i.test(sha) ? sha : 'unknown';
  } catch (_) { return 'unknown'; }
})();
app.get('/healthz', (req, res) => res.json({
  ok: true, uptime: Math.round(process.uptime()),
  products: storeCatalog.getProducts().length, release: besiRelease
}));

app.get('/api/realtime/status', (req, res) => {
  res.json({ success: true, data: realtimeSync.getPublicSyncStatus() });
});

app.get('/api/admin/realtime-status', requireAdmin, (req, res) => {
  res.json({ success: true, data: realtimeSync.getSyncStatus() });
});

app.post('/api/realtime/sync-now', requireAdmin, (req, res) => {
  res.json({ success: true, message: 'Đã kích hoạt quét đồng bộ kho DropBuy ngay lập tức!' });
  realtimeSync.runFullSync5Min(io).catch(err => console.error('[Manual Sync Error]:', err.message));
});


// ==========================================
// QUẢN TRỊ KHO TECHMALL.VN & GIÁ BÁN RIÊNG
// Trang "Kho TechMall" của admin dùng các đường dưới; bên dưới chạy bằng khung nguồn hàng (services/sources).
// ==========================================
const techmallSource = () => sources.get('techmall');

function techmallStatus() {
  const src = techmallSource();
  const st = src.status();
  const cfg = readConfig();
  const minutes = Math.min(180, Math.max(5, Number(cfg.sources?.techmall?.intervalMinutes) || src.def.intervalMinutes || 10));
  const last = st.meta.lastSync || st.sync.lastOk;
  return {
    active: cfg.sources?.techmall?.enabled !== false,
    running: !!st.sync.running,
    intervalMinutes: minutes,
    lastRun: st.sync.lastRun,
    lastOk: last,
    nextRun: last ? new Date(Date.parse(last) + minutes * 60e3).toISOString() : null,
    lastError: st.sync.lastError,
    lastChanges: st.meta.changed || 0,
    totalProducts: st.products,
    sellable: st.sellable,
    inStock: st.in_stock,
    imagesPending: src.store.getProducts().filter(p => !p.removed && p.in_stock !== false && !isSellable(p)).length,
    phase: st.sync.phase || null,
    progress: st.sync.progress || null,
    complete: st.meta.complete !== false,
    auth: { authenticated: st.logged_in, username: st.username, authenticatedAt: src.store.getSession()?.logged_in_at || null, remembered: st.remembered }
  };
}

app.get('/api/admin/techmall/status', requireAdmin, (req, res) => {
  res.json({ success: true, data: techmallStatus() });
});

app.post('/api/admin/techmall/login', requireAdmin, rateLimit('srcLogin', 15 * 60e3, 10), async (req, res) => {
  try {
    const { username, password, remember = true } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, error: 'Nhập tài khoản và mật khẩu đại lý TechMall.' });
    const src = techmallSource();
    const r = await src.login(String(username).trim(), String(password), { remember: remember !== false });
    src.syncAll().catch(e => console.warn('[Nguồn TechMall] Lỗi quét sau đăng nhập:', e.message));
    res.json({ success: true, message: 'Đã kết nối tài khoản đại lý TechMall: ' + r.username + '. Đang quét lại giá đại lý...', data: r });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/techmall/logout', requireAdmin, (req, res) => {
  techmallSource().logout();
  res.json({ success: true, message: 'Đã ngắt kết nối tài khoản TechMall và xoá mật khẩu đã lưu.' });
});

app.get('/api/admin/techmall/pricing', requireAdmin, (req, res) => {
  const src = techmallSource();
  const list = src.store.getProducts().filter(p => !p.removed);
  const st = src.status();
  const stats = { ...pricingStats(list), sellable: st.sellable, inStock: st.in_stock, waiting: list.filter(p => p.in_stock !== false && !isSellable(p)).length };
  res.json({ success: true, data: { rules: src.rules(readConfig()), stats, auth: techmallStatus().auth } });
});

// { markupPercent, minProfit, roundTo, capAtPublic, surchargePercent, categoryMarkups? }
app.post('/api/admin/techmall/pricing', requireAdmin, async (req, res) => {
  try {
    const src = techmallSource();
    const cfg = readConfig();
    const current = src.rules(cfg);
    const b = { ...(req.body || {}) };
    delete b.base; // nguồn sỉ luôn tính trên giá đại lý
    const rules = normalizeSourceRules({ ...current, ...b, productOverrides: b.productOverrides ?? current.productOverrides }, src.def.pricingDefaults);
    cfg.sources = cfg.sources || {};
    cfg.sources.techmall = { ...(cfg.sources.techmall || {}), pricing: rules };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    const changed = src.reprice();
    const list = src.store.getProducts().filter(p => !p.removed);
    res.json({ success: true, message: 'Đã lưu bảng giá riêng TechMall. Đã cập nhật giá bán cho ' + changed + ' sản phẩm.', data: { rules, stats: { ...pricingStats(list), sellable: src.status().sellable } } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Một lần quét = toàn bộ kho (~10.000 SP, ~1 phút) + đọc ảnh SP mới, nên "đồng bộ ngay" và "tải toàn bộ" là một việc
function startTechmallSync(res, message) {
  const src = techmallSource();
  if (src.status().sync.running) return res.json({ success: true, message: 'TechMall đang được quét, vui lòng chờ…', data: techmallStatus() });
  src.syncAll().catch(err => console.error('[Nguồn TechMall] Lỗi quét:', err.message));
  res.json({ success: true, message, data: techmallStatus() });
}
app.post('/api/admin/techmall/sync', requireAdmin, (req, res) => startTechmallSync(res, 'Đang quét giá đại lý & tồn kho toàn bộ kho TechMall (khoảng 1–3 phút)...'));
app.post('/api/admin/techmall/fetch-all', requireAdmin, (req, res) => startTechmallSync(res, 'Đang tải toàn bộ kho TechMall trong nền (khoảng 1–3 phút, SP mới cần thêm vài phút để đọc ảnh)...'));

app.get('/api/admin/techmall/brands', requireAdmin, (req, res) => {
  const srcTm = techmallSource();
  const list = srcTm.store.getProducts().filter(p => !p.removed);
  const counts = {};
  list.forEach(p => {
    const b = p.brand || 'Khác';
    counts[b] = (counts[b] || 0) + 1;
  });
  const data = Object.entries(counts).map(([name, total]) => ({
    name,
    total,
    sellable: list.filter(p => (p.brand || 'Khác') === name && isSellable(p)).length
  })).sort((a, b) => b.total - a.total);
  res.json({ success: true, data });
});

app.get('/api/admin/techmall/products', requireAdmin, (req, res) => {
  const { search = '', page = 1, limit = 20, all = '', brand = '' } = req.query;
  const view = all === '1' ? 'all' : String(req.query.view || 'selling');
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  const inView = { selling: isSellable, instock: p => p.in_stock !== false, waiting: p => p.in_stock !== false && !isSellable(p), out: p => p.in_stock === false, all: () => true }[view] || isSellable;
  const srcTm = techmallSource();
  let list = (srcTm.getProducts ? srcTm.getProducts() : srcTm.store.getProducts()).filter(p => !p.removed && inView(p));
  if (brand && brand !== 'all') {
    list = list.filter(p => norm(p.brand || 'Khác') === norm(brand));
  }
  if (search) {
    const filterFn = p => norm(p.name).includes(norm(search)) || norm(p.sku || '').includes(norm(search)) || norm(p.brand || '').includes(norm(search)) || String(p.id) === String(search) || (p.variants && p.variants.some(v => norm(v.name).includes(norm(search)) || norm(v.sku || '').includes(norm(search))));
    const matched = list.filter(filterFn);
    if (matched.length === 0 && view === 'selling') {
      const allList = (srcTm.getProducts ? srcTm.getProducts() : srcTm.store.getProducts()).filter(p => !p.removed);
      list = allList.filter(filterFn);
    } else {
      list = matched;
    }
  }
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const rows = list.slice((pageNum - 1) * lim, pageNum * lim).map(p => ({
    id: p.id, sku: p.sku, name: p.name, brand: p.brand, image: p.image, category_name: p.category_name, in_stock: p.in_stock !== false, variant_count: p.variant_count || 1,
    cost: p.supplier_cost, wholesale_price: p.dealer_price, retail_price: p.retail_price, price: p.price, rule: p.pricing_rule, source_url: p.source_url
  }));
  res.json({ success: true, total: list.length, page: pageNum, totalPages: Math.ceil(list.length / lim) || 1, data: rows });
});

// Bắt 404 cho toàn bộ API routes
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint không tồn tại' });
});

// Middleware xử lý ngoại lệ toàn cục (chống lộ stack trace / đường dẫn file)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof URIError) {
    return res.redirect(302, '/');
  }
  const isApi = (req.path || '').startsWith('/api');
  const status = err.status || err.statusCode || (err instanceof SyntaxError && err.status === 400 ? 400 : 500);
  const msg = err instanceof SyntaxError && status === 400 ? 'Dữ liệu JSON gửi lên không hợp lệ' : (err.message || 'Lỗi hệ thống');
  if (isApi) {
    return res.status(status).json({ success: false, error: stripSupplierText(msg) });
  }
  res.status(status).type('text/plain').send(stripSupplierText(msg));
});

process.on('uncaughtException', err => {
  console.error('[CRITICAL Uncaught Exception]:', err.message);
});

process.on('unhandledRejection', reason => {
  console.error('[CRITICAL Unhandled Rejection]:', reason);
});

if (require.main === module) {
  server.listen(PORT, () => {
    getAdminPassword(); // tạo mật khẩu admin nếu chưa có
    console.log(`================================================================`);
    console.log(`🚀 HOANGMINH.COM x DROPBUY.VN RELAY SYSTEM RUNNING ON PORT ${PORT}`);
    console.log(`🔗 Storefront: http://localhost:${PORT}`);
    console.log(`🔗 Admin Console: http://localhost:${PORT}/admin.html`);
    console.log(`================================================================`);
    const legacy = storeCatalog.removeLegacyPartnerItems();
    if (legacy) console.log(`[Nguồn hàng] Đã gỡ ${legacy} SP TechMall cũ khỏi data/products.json (nay ở data/source-techmall-*.json).`);
    realtimeSync.startRealtimeSync(io);
    sources.start(io, readConfig);
    orderExpiry.startOrderExpiry(io, readConfig);
    backup.startBackups();
    watchdog.startWatchdog(io);
    notify.startZaloBotPolling();

    // Định kỳ mỗi 2 phút đồng bộ trạng thái đơn hàng từ DropBuy đến khi hoàn tất
    setInterval(() => {
      dropbuyOrderFulfillment.syncDropbuyOrdersStatus(io).catch(err => {
        console.warn('[DropBuy Sync Interval Error]:', err.message);
      });
    }, 2 * 60 * 1000).unref();
  });
}

module.exports = { app, server, publicProduct };

