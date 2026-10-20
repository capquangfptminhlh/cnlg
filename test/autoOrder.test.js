const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Dữ liệu tạm – không ghi vào data/ thật, không gọi DropBuy thật
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-auto-'));
process.env.HM_ORDERS_FILE = path.join(tmp, 'orders.json');

const scraper = require('../services/dropbuyScraper');
const orderStore = require('../services/orderStore');
const fulfillment = require('../services/dropbuyOrderFulfillment');
const session = require('../services/dropbuySession');

let config;
scraper.getConfig = () => config;

/** DropBuy giả: giỏ, phí ship, số dư, đặt đơn. Ghi lại mọi request để kiểm tra. */
function fakeDropbuy({ balance = 5000000, cart = [], submit = 'ok', fee = 17000 } = {}) {
  const state = { cart: cart.map(x => ({ ...x })), calls: [], submits: [] };
  const catalog = {
    'var-a': { variation_id: 'var-a', product_name: 'Cáp A', shop_depot_code: 'DP-1', fe_price_override: 29000, allow_sm_v: 'T', allow_sm_s: 'T', province_id: 1, district_id: 20, ward_id: 419 },
    'var-b': { variation_id: 'var-b', product_name: 'Sạc B', shop_depot_code: 'DP-2', fe_price_override: 189000, allow_sm_v: 'F', allow_sm_s: 'T', province_id: 1, district_id: 22, ward_id: 449 },
    'var-x': { variation_id: 'var-x', product_name: 'Món riêng của shop', shop_depot_code: 'DP-9', fe_price_override: 15000, allow_sm_v: 'T', allow_sm_s: 'T', province_id: 12, district_id: 135, ward_id: 1947 }
  };
  const ok = data => ({ ok: true, status: 200, json: async () => ({ success: true, error_code: 0, data }) });
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    state.calls.push({ url: u, method: opts.method || 'GET', body, sid: opts.headers?.['x-foxing-sid'] });
    if (u.endsWith('/api/auth/session')) return { ok: true, status: 200, json: async () => ({ user: { sid: 's'.repeat(32), username: 'shop', expired_at: new Date(Date.now() + 86400e3).toISOString() }, expires: new Date(Date.now() + 86400e3).toISOString() }) };
    if (opts.headers?.['x-foxing-sid'] !== 's'.repeat(32)) return { ok: true, status: 200, json: async () => ({ success: false, error_code: 401, message: 'sid null' }) };
    if (u.endsWith('/carts/my-cart')) return ok({ cart_items: state.cart.map(c => ({ ...catalog[c.variation_id], ...c })) });
    if (u.endsWith('/carts/set-quantity')) {
      for (const it of body.items) {
        const cur = state.cart.find(c => c.variation_id === it.variation_id);
        if (cur) cur.quantity = it.quantity;
        else state.cart.push({ variation_id: it.variation_id, quantity: it.quantity, selected_for_checkout: false });
      }
      return ok({});
    }
    if (u.endsWith('/carts/set-selected-items')) {
      for (const it of body.items) {
        const cur = state.cart.find(c => c.variation_id === it.variation_id);
        if (cur) cur.selected_for_checkout = it.selected_for_checkout;
      }
      return ok({});
    }
    if (u.endsWith('/carts/get-shipping-fee')) return ok({ shipping_method: body.shipping_method, shipping_amount: body.shipping_method === 'S' ? fee - 6000 : fee });
    if (u.endsWith('/balance/my-balance')) return ok({ avail_balance_current: balance });
    if (u.includes('/normal-submit')) {
      state.submits.push(body);
      if (submit === 'timeout') throw new Error('network timeout');
      if (submit === 'reject') return { ok: true, status: 200, json: async () => ({ success: false, error_code: 400, message: 'Sản phẩm hết hàng' }) };
      // DropBuy xoá các món đã đặt khỏi giỏ
      state.cart = state.cart.filter(c => !c.selected_for_checkout);
      return ok(body.order_options.map((o, k) => ({ id: 1657154 + k, code: `D-261020-${1657154 + k}`, status: 'O', payment_method: 'P' })));
    }
    throw new Error('Chưa mô phỏng: ' + u);
  };
  return state;
}

function makeOrder({ method = 'COD', items, total, shipping_fee = 30000 } = {}) {
  items = items || [{ id: 1, name: 'Cáp A', price: 59000, quantity: 2, variation_id: 'var-a', dropbuy_cost: 29000 }];
  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
  const o = orderStore.createOrder({
    customer: { name: 'Chị Test', phone: '0909000111', address: '26 Nguyễn Minh Hoàng', province: 'TP. Hồ Chí Minh', province_id: 2, province_name: 'Thành phố Hồ Chí Minh', ward_id: 49290, ward_name: 'Phường An Hội Đông' },
    items,
    total_amount: total ?? subtotal + shipping_fee,
    payment_method: method
  });
  orderStore.updateOrder(o.id, { subtotal, shipping_fee });
  return method === 'COD' ? orderStore.getOrderById(o.id) : orderStore.updateOrder(o.id, { status: 'PAID', paid_at: new Date().toISOString() });
}

test.beforeEach(() => {
  session.invalidate();
  config = { dropbuy: { cookieHeader: '__Secure-next-auth.session-token=abc' }, autoOrder: { enabled: true, maxOrderSpend: 3000000, maxDailySpend: 10000000 } };
});

test('COD mới tạo ở trạng thái CONFIRMED, chuyển khoản ở PENDING_PAYMENT', () => {
  const a = orderStore.createOrder({ customer: { name: 'A', phone: '0900000000' }, items: [], total_amount: 1, payment_method: 'COD' });
  const b = orderStore.createOrder({ customer: { name: 'B', phone: '0900000000' }, items: [], total_amount: 1 });
  assert.equal(a.status, 'CONFIRMED');
  assert.equal(a.payment_method, 'COD');
  assert.equal(b.status, 'PENDING_PAYMENT');
  assert.equal(b.payment_method, 'BANK');
});

test('Đặt COD: đúng địa chỉ, COD = tổng khách trả, trừ quỹ, chỉ đặt món của đơn, trả lại giỏ cũ', async () => {
  const db = fakeDropbuy({ cart: [{ variation_id: 'var-x', quantity: 3, selected_for_checkout: true }] });
  const o = makeOrder();
  const r = await fulfillment.placeOrderOnDropbuy(o.id, null);
  assert.equal(r.success, true);
  assert.equal(db.submits.length, 1);
  const body = db.submits[0];
  assert.equal(body.is_dropship, 'D');
  assert.equal(body.payment_method, 'P');
  assert.equal(body.receiver_province_id, 2);
  assert.equal(body.receiver_district_id, 0);
  assert.equal(body.receiver_ward_id, 49290);
  assert.equal(body.receiver_phone, '0909000111');
  assert.equal(body.order_options.length, 1);
  assert.equal(body.order_options[0].cod_amount, o.total_amount); // 2×59.000 + 30.000
  assert.equal(body.order_options[0].shipping_method, 'S'); // rẻ hơn
  assert.deepEqual(body.order_options[0].items.map(i => i.variation_id), ['var-a']);
  assert.equal(r.spend, 2 * 29000 + 11000);
  const after = orderStore.getOrderById(o.id);
  assert.equal(after.status, 'PROCESSING');
  assert.equal(after.dropbuy_sync.status, 'ORDERED');
  assert.equal(after.dropbuy_sync.order_code, 'D-261020-1657154');
  // Món riêng của shop vẫn còn trong giỏ, vẫn được chọn như trước
  const x = db.cart.find(c => c.variation_id === 'var-x');
  assert.equal(x.quantity, 3);
  assert.equal(x.selected_for_checkout, true);
  // Mọi lệnh BFF đều kèm sid
  assert.ok(db.calls.filter(c => c.url.includes('/bff/')).every(c => c.sid));
});

test('Không đặt lặp 1 đơn', async () => {
  fakeDropbuy();
  const o = makeOrder();
  await fulfillment.placeOrderOnDropbuy(o.id, null);
  await assert.rejects(fulfillment.placeOrderOnDropbuy(o.id, null), /COD phải ở trạng thái|đã gửi sang DropBuy/);
});

test('Chuyển khoản: COD = 0; nhiều kho → mỗi kho 1 đơn, ship theo đơn vị kho cho phép', async () => {
  const db = fakeDropbuy();
  const o = makeOrder({ method: 'BANK', items: [
    { id: 1, name: 'Cáp A', price: 59000, quantity: 1, variation_id: 'var-a', dropbuy_cost: 29000 },
    { id: 2, name: 'Sạc B', price: 299000, quantity: 1, variation_id: 'var-b', dropbuy_cost: 189000 }
  ] });
  const r = await fulfillment.placeOrderOnDropbuy(o.id, null);
  const body = db.submits[0];
  assert.equal(body.order_options.length, 2);
  assert.ok(body.order_options.every(x => x.cod_amount === 0));
  assert.equal(body.order_options.find(x => x.shop_depot_code === 'DP-2').shipping_method, 'S'); // kho B không cho VTP
  assert.equal(r.orders.length, 2);
});

test('Chia COD theo kho: tổng đúng bằng tiền khách trả', () => {
  const order = { payment_method: 'COD', total_amount: 388000, shipping_fee: 30000, items: [
    { variation_id: 'var-a', price: 59000, quantity: 1 }, { variation_id: 'var-b', price: 299000, quantity: 1 }
  ] };
  const cods = fulfillment.codPerDepot(order, [{ lines: [{ variation_id: 'var-a' }] }, { lines: [{ variation_id: 'var-b' }] }]);
  assert.deepEqual(cods, [89000, 299000]);
  assert.equal(cods.reduce((a, b) => a + b, 0), 388000);
});

test('Chặn: lỗ, vượt hạn mức, quỹ không đủ – không gửi đơn', async () => {
  let db = fakeDropbuy();
  const loss = makeOrder({ items: [{ id: 1, name: 'Cáp A', price: 20000, quantity: 1, variation_id: 'var-a' }], shipping_fee: 0 });
  await assert.rejects(fulfillment.placeOrderOnDropbuy(loss.id, null), /Lỗ/);
  assert.equal(db.submits.length, 0);
  assert.equal(orderStore.getOrderById(loss.id).dropbuy_sync.status, 'FAILED');

  db = fakeDropbuy();
  config.autoOrder.maxOrderSpend = 50000;
  const big = makeOrder();
  await assert.rejects(fulfillment.placeOrderOnDropbuy(big.id, null), /hạn mức 1 đơn/);
  assert.equal(db.submits.length, 0);

  db = fakeDropbuy({ balance: 10000 });
  config.autoOrder.maxOrderSpend = 3000000;
  const poor = makeOrder();
  await assert.rejects(fulfillment.placeOrderOnDropbuy(poor.id, null), /Quỹ DropBuy không đủ/);
  assert.equal(db.submits.length, 0);
  // Bị chặn trước khi gửi → bấm lại được sau khi nạp quỹ
  fakeDropbuy();
  const r = await fulfillment.placeOrderOnDropbuy(poor.id, null);
  assert.equal(r.success, true);
});

test('Gửi đơn mà mất mạng → SUBMIT_UNKNOWN, khoá không gửi lại', async () => {
  const db = fakeDropbuy({ submit: 'timeout' });
  const o = makeOrder();
  await assert.rejects(fulfillment.placeOrderOnDropbuy(o.id, null));
  assert.equal(db.submits.length, 1);
  assert.equal(orderStore.getOrderById(o.id).dropbuy_sync.status, 'SUBMIT_UNKNOWN');
  fakeDropbuy();
  await assert.rejects(fulfillment.placeOrderOnDropbuy(o.id, null), /không đặt lại/);
});

test('DropBuy từ chối đơn → FAILED, đặt lại được', async () => {
  fakeDropbuy({ submit: 'reject' });
  const o = makeOrder();
  await assert.rejects(fulfillment.placeOrderOnDropbuy(o.id, null), /hết hàng/);
  assert.equal(orderStore.getOrderById(o.id).dropbuy_sync.status, 'FAILED');
});

test('Thiếu phường/xã → không đặt tự động', async () => {
  const db = fakeDropbuy();
  const o = orderStore.createOrder({ customer: { name: 'A', phone: '0900000000', province: 'Hà Nội' }, items: [{ id: 1, name: 'Cáp A', price: 59000, quantity: 1, variation_id: 'var-a' }], total_amount: 89000, payment_method: 'COD' });
  await assert.rejects(fulfillment.placeOrderOnDropbuy(o.id, null), /phường\/xã/);
  assert.equal(db.calls.length, 0);
});

test('Tắt tự đặt → handOff chỉ đưa vào giỏ', async () => {
  const db = fakeDropbuy();
  config.autoOrder.enabled = false;
  const o = makeOrder();
  const r = await fulfillment.handOff(o.id, null);
  assert.equal(r.mode, 'CART');
  assert.equal(db.submits.length, 0);
  assert.equal(orderStore.getOrderById(o.id).dropbuy_sync.status, 'IN_DROPBUY_CART');
});

test('Hết phiên DropBuy → WAITING_DROPBUY_LOGIN, không gửi', async () => {
  const db = fakeDropbuy();
  global.fetch = async (url) => (String(url).endsWith('/api/auth/session') ? { ok: true, status: 200, json: async () => ({}) } : db.calls.push(url));
  const o = makeOrder();
  await assert.rejects(fulfillment.placeOrderOnDropbuy(o.id, null), /đăng nhập/);
  assert.equal(orderStore.getOrderById(o.id).dropbuy_sync.status, 'WAITING_DROPBUY_LOGIN');
  assert.equal(db.submits.length, 0);
});
