// Chạy: npm test  (dùng node:test, không cần thư viện ngoài, không đụng dữ liệu thật)
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-test-'));
process.env.HM_ORDERS_FILE = path.join(tmp, 'orders.json');
process.env.HM_PAYMENTS_FILE = path.join(tmp, 'payments.json');

const pricing = require('../services/pricing');
const shipping = require('../services/shipping');
const orderStore = require('../services/orderStore');
const payments = require('../services/payments');
const orderExpiry = require('../services/orderExpiry');
const { sanitizeHtml, maskPhone } = require('../services/security');

describe('Giá bán (pricing)', () => {
  const rules = pricing.normalizeRules({ markupPercent: 15 });
  const p = { id: 1, category_id: 5, public_price: 2650000, wholesale: 639000 };

  test('giá CTV + % lãi, làm tròn lên 1.000đ, giá gạch ngang = giá niêm yết', () => {
    const r = pricing.computePrice(p, rules);
    assert.equal(r.cost, 639000);
    assert.equal(r.price, 735000); // 639.000 × 1,15 = 734.850 → 735.000
    assert.equal(r.base_used, 'wholesale');
    assert.equal(r.original_price, 2650000);
  });

  test('chưa có giá CTV → dùng giá niêm yết, không bịa giá gạch ngang', () => {
    const r = pricing.computePrice({ ...p, wholesale: null }, rules);
    assert.equal(r.cost, 2650000);
    assert.equal(r.price, 3048000);
    assert.equal(r.original_price, null);
  });

  test('markup 0% được giữ nguyên (không bị đổi thành 15%)', () => {
    assert.equal(pricing.normalizeRules({ markupPercent: 0 }).markupPercent, 0);
    assert.equal(pricing.computePrice(p, pricing.normalizeRules({ markupPercent: 0 })).price, 639000);
  });

  test('% theo danh mục gốc áp cho danh mục con; giá riêng SP ưu tiên nhất', () => {
    const root = pricing.rootCategoryMap([{ id: 1, parent_id: null }, { id: 5, parent_id: 1 }]);
    const r1 = pricing.computePrice(p, pricing.normalizeRules({ markupPercent: 15, categoryMarkups: { 1: 30 } }), root);
    assert.equal(r1.price, Math.ceil(639000 * 1.3 / 1000) * 1000);
    const r2 = pricing.computePrice(p, pricing.normalizeRules({ categoryMarkups: { 1: 30 }, productOverrides: { 1: { type: 'fixed', value: 799000 } } }), root);
    assert.equal(r2.price, 799000);
  });

  test('lãi tối thiểu và giới hạn không vượt giá niêm yết', () => {
    const cheap = { id: 2, category_id: 5, public_price: 30000, wholesale: 20000 };
    assert.equal(pricing.computePrice(cheap, pricing.normalizeRules({ markupPercent: 5, minProfit: 8000 })).price, 28000);
    const capped = pricing.computePrice({ ...cheap, wholesale: 28000 }, pricing.normalizeRules({ markupPercent: 50, capAtPublic: true }));
    assert.ok(capped.price <= 30000 && capped.price > 28000);
  });
});

describe('Phí vận chuyển (shipping)', () => {
  const rules = shipping.normalizeShipping({});

  test('34 tỉnh/thành, mỗi tỉnh thuộc 1 miền', () => {
    assert.equal(shipping.PROVINCES.length, 34);
    assert.equal(shipping.regionOf('Cà Mau'), 'south');
    assert.equal(shipping.regionOf('Huế'), 'central');
    assert.equal(shipping.regionOf('Không có'), null);
  });

  test('phí theo miền + phụ phí cân nặng; miễn phí từ ngưỡng', () => {
    assert.equal(shipping.quote({ province: 'Hà Nội', subtotal: 100000, lines: [{ quantity: 1, weight_gram: 300 }] }, rules).fee, 25000);
    // 2,6 kg → vượt 1 kg đầu 1,6 kg → làm tròn 2 kg × 5.000
    assert.equal(shipping.quote({ province: 'Đà Nẵng', subtotal: 100000, lines: [{ quantity: 2, weight_gram: 1300 }] }, rules).fee, 35000 + 2 * 5000);
    assert.equal(shipping.quote({ province: 'Cà Mau', subtotal: 600000, lines: [{ quantity: 1, weight_gram: 300 }] }, rules).fee, 0);
    assert.throws(() => shipping.quote({ province: '', subtotal: 1, lines: [] }, rules));
  });
});

describe('Bảo mật', () => {
  test('làm sạch HTML mô tả lấy từ DropBuy', () => {
    const out = sanitizeHtml('<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:evil()">x</a><img src=x onerror=alert(1)>');
    assert.ok(!/script|onclick|onerror|javascript:/i.test(out));
    assert.ok(out.includes('<p>Hi</p>'));
  });
  test('che số điện thoại', () => assert.equal(maskPhone('0912345678'), '091****678'));
});

describe('Thanh toán tự động qua webhook', () => {
  let order;
  const confirmed = [];
  const confirm = (id, meta) => {
    confirmed.push({ id, ...meta });
    return orderStore.updateOrder(id, { status: 'PAID', paid_at: new Date().toISOString() });
  };
  before(() => {
    order = orderStore.createOrder({ customer: { name: 'Test', phone: '0912345678', address: 'x' }, items: [], total_amount: 375000 });
  });

  const sepay = (id, amount, content) => payments.fromSepay({ id, transferType: 'in', transferAmount: amount, content, gateway: 'MBBank', transactionDate: '2026-10-19 16:00:00' })[0];

  test('mã đơn có dạng HM + 8 ký tự ngẫu nhiên', () => assert.match(order.id, /^HM[0-9A-F]{8}$/));

  test('thiếu tiền → chưa xác nhận; chuyển thêm đủ → tự xác nhận', () => {
    assert.equal(payments.handleTransaction(sepay(1, 300000, `HOANGMINH ${order.id}`), { confirm }).result, 'UNDERPAID');
    assert.equal(orderStore.getOrderById(order.id).status, 'PENDING_PAYMENT');
    assert.equal(payments.handleTransaction(sepay(2, 75000, `hoangminh ${order.id.toLowerCase()} ck them`), { confirm }).result, 'CONFIRMED_MULTI');
    assert.equal(orderStore.getOrderById(order.id).status, 'PAID');
  });

  test('cùng 1 giao dịch gửi 2 lần chỉ xử lý 1 lần', () => {
    assert.equal(payments.handleTransaction(sepay(2, 75000, order.id), { confirm }).result, 'DUPLICATE');
  });

  test('chuyển khoản không có mã đơn / tiền ra không được xác nhận', () => {
    assert.equal(payments.handleTransaction(sepay(3, 500000, 'chuyen tien'), { confirm }).result, 'UNMATCHED');
    assert.deepEqual(payments.fromSepay({ id: 4, transferType: 'out', transferAmount: 1, content: order.id }), []);
  });

  test('tiền về cho đơn đã huỷ → gắn cờ cho admin, không tự xác nhận', () => {
    const o = orderStore.createOrder({ customer: { name: 'T', phone: '0900000000', address: 'x' }, items: [], total_amount: 100000 });
    orderStore.updateOrder(o.id, { status: 'CANCELLED' });
    assert.equal(payments.handleTransaction(sepay(5, 100000, o.id), { confirm }).result, 'ORDER_CANCELLED');
    assert.equal(orderStore.getOrderById(o.id).needs_attention, true);
  });

  test('Casso: chuẩn hoá payload', () => {
    const txs = payments.fromCasso({ error: 0, data: [{ id: 9, tid: 'FT1', description: 'HM12345678', amount: 1000, when: '2026-10-19' }] });
    assert.equal(txs[0].tx_id, 'casso:9');
    assert.equal(txs[0].amount, 1000);
  });
});

describe('Tự huỷ đơn quá hạn', () => {
  test('đơn chờ thanh toán quá hạn bị huỷ; đơn đã báo CK chỉ bị gắn cờ', () => {
    const late = orderStore.createOrder({ customer: { name: 'A', phone: '0900000001', address: 'x' }, items: [], total_amount: 1 });
    const reported = orderStore.createOrder({ customer: { name: 'B', phone: '0900000002', address: 'x' }, items: [], total_amount: 1 });
    const fresh = orderStore.createOrder({ customer: { name: 'C', phone: '0900000003', address: 'x' }, items: [], total_amount: 1 });
    const old = new Date(Date.now() - 31 * 60000).toISOString();
    const veryOld = new Date(Date.now() - 13 * 3600000).toISOString();
    orderStore.updateOrder(late.id, { created_at: old });
    orderStore.updateOrder(reported.id, { created_at: veryOld, status: 'PAYMENT_REPORTED', payment_reported_at: veryOld });

    const events = [];
    const io = { to: () => ({ emit: (e) => events.push(e) }), emit: (e) => events.push(e) };
    orderExpiry.sweep(io, () => ({ orders: { paymentTimeoutMinutes: 30, reportedAlertHours: 12 } }));

    assert.equal(orderStore.getOrderById(late.id).status, 'CANCELLED');
    assert.equal(orderStore.getOrderById(reported.id).status, 'PAYMENT_REPORTED');
    assert.equal(orderStore.getOrderById(reported.id).needs_attention, true);
    assert.equal(orderStore.getOrderById(fresh.id).status, 'PENDING_PAYMENT');
    assert.ok(events.includes('ORDER_EXPIRED'));
  });
});

test('Admin: cùng 1 mật khẩu sai gửi nhiều lần chỉ tính 1 lần; 10 mật khẩu sai khác nhau mới khoá', () => {
  const { requireAdmin } = require('../services/security');
  const call = (key, ip = '10.9.8.7') => {
    let status = 200;
    const res = { status(c) { status = c; return this; }, json() { return this; } };
    let passed = false;
    requireAdmin({ ip, get: h => (h.toLowerCase() === 'x-admin-key' ? key : '') }, res, () => { passed = true; });
    return passed ? 200 : status;
  };
  for (let i = 0; i < 30; i++) assert.equal(call('sai-1'), 401); // 30 request song song cùng mật khẩu sai
  for (let i = 2; i <= 9; i++) assert.equal(call(`sai-${i}`), 401);
  assert.equal(call('sai-10'), 401);
  assert.equal(call('sai-11'), 429);
  assert.equal(call('sai-1', '10.9.8.8'), 401); // IP khác không bị ảnh hưởng
});

test('Catalog: giá sỉ trong wholesale_price được dùng làm giá vốn khi base = wholesale', () => {
  const scraper = require('../services/dropbuyScraper');
  const pricing = require('../services/pricing');
  const ctx = { rules: pricing.normalizeRules({ markupPercent: 15, base: 'wholesale', roundTo: 1000 }), rootMap: new Map() };
  const item = { product_id: 141073, unique_id: 'var-1', price_public: 1000000, product_name: 'Bàn là', slug: 'ban-la' };
  const p = scraper.mapItem(item, { ctx, priceMap: new Map([['var-1', { cost: 299000, source: 'F1' }]]) });
  assert.equal(p.wholesale_price, 299000);
  assert.equal(p.dropbuy_cost, 299000);
  assert.equal(p.price, 344000); // 299.000 × 1,15 làm tròn lên 1.000
  assert.equal(p.is_wholesale_price, true);
  const noLogin = scraper.mapItem(item, { ctx, priceMap: new Map() });
  assert.equal(noLogin.dropbuy_cost, 1000000);
});

test('Báo cáo: đơn thử bị loại; đơn thiếu giá vốn không được tính cả tiền vào lãi', () => {
  const { salesReport } = require('../services/reports');
  const now = new Date();
  const at = now.toISOString();
  const orders = [
    { id: 'T1', is_test: true, status: 'PAID', paid_at: at, created_at: at, total_amount: 2278000, items: [{ price: 1139000, quantity: 2 }] },
    { id: 'A', status: 'PAID', paid_at: at, created_at: at, total_amount: 500000, subtotal: 500000, items: [{ price: 500000, quantity: 1 }] },
    { id: 'B', status: 'PAID', paid_at: at, created_at: at, total_amount: 300000, subtotal: 300000, items: [{ price: 300000, quantity: 1, dropbuy_cost: 200000, cost_is_wholesale: true }] },
    { id: 'C', payment_method: 'COD', status: 'PROCESSING', created_at: at, total_amount: 99000, items: [{ price: 99000, quantity: 1, dropbuy_cost: 50000 }] }
  ];
  const r = salesReport(orders, { now });
  assert.equal(r.test_orders, 1);
  assert.equal(r.totals.today.orders, 2);          // A, B (COD C chưa giao → chưa tính)
  assert.equal(r.totals.today.revenue, 800000);
  assert.equal(r.totals.today.profit, 100000);     // chỉ B; A thiếu vốn → 0, không phải 500.000
  assert.equal(r.totals.today.cost_unknown_orders, 1);
  assert.equal(r.totals.today.cost_unknown_revenue, 500000);
  assert.equal(r.pipeline.PAID, 2);                // đơn thử không vào "đã nhận tiền chưa đặt kho"
});

test('Tin nhắn cho khách: đúng giai đoạn, đủ mã vận đơn, không nhắc DropBuy', () => {
  const { buildCustomerMessage, zaloLink } = require('../services/customerMessage');
  const base = { id: 'HMAB12CD34', payment_method: 'COD', total_amount: 356000, customer: { name: 'Chị Lan', phone: '0901234567' }, items: [{ name: 'Bàn là mini', quantity: 1 }] };
  const opts = { storeName: 'Hoàng Minh Store', trackUrl: 'https://shop.vn/?tra-cuu=HMAB12CD34' };
  const confirmed = buildCustomerMessage({ ...base, status: 'CONFIRMED', dropbuy_sync: { status: 'WAITING_STAFF' } }, opts);
  assert.equal(confirmed.stage, 'confirmed');
  assert.match(confirmed.text, /HMAB12CD34/);
  assert.match(confirmed.text, /356\.000đ/);
  assert.match(confirmed.text, /Bàn là mini x1/);
  const shipping = buildCustomerMessage({ ...base, status: 'PROCESSING', dropbuy_sync: { status: 'ORDERED', order_code: 'D-261022-1', carrier: 'S', shipping_ref_code: 'SPXVN0123' } }, opts);
  assert.equal(shipping.stage, 'shipping');
  assert.match(shipping.text, /SPX Express/);
  assert.match(shipping.text, /SPXVN0123/);
  assert.match(shipping.text, /https:\/\/shop\.vn\/\?tra-cuu=HMAB12CD34/);
  assert.equal(buildCustomerMessage({ ...base, status: 'PROCESSING', dropbuy_sync: { status: 'ORDERED' } }, opts).stage, 'preparing');
  assert.equal(buildCustomerMessage({ ...base, status: 'COMPLETED' }, opts).stage, 'completed');
  assert.equal(buildCustomerMessage({ ...base, status: 'CANCELLED', cancel_reason: 'Khách đổi ý' }, opts).stage, 'cancelled');
  for (const t of [confirmed.text, shipping.text]) {
    assert.doesNotMatch(t, /dropbuy|D-261022/i); // không lộ nguồn hàng / mã đơn DropBuy
  }
  const cancelledLeak = buildCustomerMessage({ ...base, status: 'CANCELLED', cancel_reason: 'Admin huỷ đơn trên DropBuy' }, opts);
  assert.doesNotMatch(cancelledLeak.text, /dropbuy|admin/i);
  assert.equal(zaloLink('+84 901 234 567'), 'https://zalo.me/0901234567');
  assert.equal(zaloLink('123'), null);
});

test('IP khách sau Cloudflare Tunnel: tin CF-Connecting-IP chỉ khi kết nối từ máy này', () => {
  const { clientIp } = require('../services/security');
  const req = (peer, cf) => ({ ip: peer, socket: { remoteAddress: peer }, headers: cf ? { 'cf-connecting-ip': cf } : {} });
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.7')), '203.0.113.7');
  assert.equal(clientIp(req('::ffff:127.0.0.1', '2001:db8::1')), '2001:db8::1');
  assert.equal(clientIp(req('198.51.100.9', '203.0.113.7')), '198.51.100.9'); // từ ngoài → không tin header
  assert.equal(clientIp(req('127.0.0.1', 'bad<ip>')), '127.0.0.1');
  assert.equal(clientIp(req('127.0.0.1')), '127.0.0.1');
});

test('Link tuyệt đối (canonical, sitemap, link tra cứu) dùng https khi khách vào qua Cloudflare', () => {
  const { baseUrl } = require('../services/seo');
  const req = (peer, headers) => ({ protocol: 'http', socket: { remoteAddress: peer }, get: h => headers[h.toLowerCase()] || (h.toLowerCase() === 'host' ? 'shop.example' : undefined) });
  const saved = process.env.PUBLIC_BASE_URL; delete process.env.PUBLIC_BASE_URL;
  try {
    assert.equal(baseUrl(req('127.0.0.1', { 'cf-visitor': '{"scheme":"https"}' })), 'https://shop.example');
    assert.equal(baseUrl(req('::1', { 'x-forwarded-proto': 'https' })), 'https://shop.example');
    assert.equal(baseUrl(req('198.51.100.9', { 'x-forwarded-proto': 'https' })), 'http://shop.example'); // từ ngoài → không tin
    assert.equal(baseUrl(req('127.0.0.1', {})), 'http://shop.example');
    process.env.PUBLIC_BASE_URL = 'https://hoangminhstore.vn/';
    assert.equal(baseUrl(req('127.0.0.1', {})), 'https://hoangminhstore.vn');
  } finally { if (saved === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = saved; }
});

test('Khách vào http:// qua Cloudflare được chuyển sang https://, truy cập nội bộ giữ nguyên', () => {
  const { forceHttps } = require('../services/security');
  const run = (peer, headers, url = '/sp/1-a?x=1') => {
    let redirected = null, passed = false;
    forceHttps({ socket: { remoteAddress: peer }, headers, originalUrl: url }, { redirect: (code, to) => { redirected = [code, to]; } }, () => { passed = true; });
    return redirected || (passed ? 'next' : 'none');
  };
  assert.deepEqual(run('127.0.0.1', { 'cf-visitor': '{"scheme":"http"}', host: 'besi.com.vn' }), [301, 'https://besi.com.vn/sp/1-a?x=1']);
  assert.equal(run('127.0.0.1', { 'cf-visitor': '{"scheme":"https"}', host: 'besi.com.vn' }), 'next');
  assert.equal(run('127.0.0.1', { host: 'localhost:3000' }), 'next');                                        // mở thẳng trên máy
  assert.equal(run('198.51.100.9', { 'cf-visitor': '{"scheme":"http"}', host: 'besi.com.vn' }), 'next');   // từ ngoài → không tin header
  assert.equal(run('127.0.0.1', { 'cf-visitor': '{"scheme":"http"}', host: 'evil.com/"><x' }), 'next');    // host lạ → không chuyển
});


test('Bảo hành chuẩn xác từ DropBuy: ngày (D), tuần (W), tháng (M), năm (Y), không bảo hành', () => {
  const { formatWarranty } = require('../services/dropbuyScraper');
  assert.equal(formatWarranty('D', 7), 'Bảo hành 7 ngày');
  assert.equal(formatWarranty('D', 15), 'Bảo hành 15 ngày');
  assert.equal(formatWarranty('W', 1), 'Bảo hành 1 tuần');
  assert.equal(formatWarranty('M', 1), 'Bảo hành 1 tháng');
  assert.equal(formatWarranty('M', 6), 'Bảo hành 6 tháng');
  assert.equal(formatWarranty('M', 12), 'Bảo hành 12 tháng');
  assert.equal(formatWarranty('Y', 1), 'Bảo hành 1 năm');
  assert.equal(formatWarranty('Y', 2), 'Bảo hành 2 năm');
  assert.equal(formatWarranty('M', 9999), 'Bảo hành trọn đời');
  assert.equal(formatWarranty(null, null), 'Không bảo hành');
  assert.equal(formatWarranty('N', 0), 'Không bảo hành');
});
