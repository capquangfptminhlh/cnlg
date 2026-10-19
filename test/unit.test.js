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
