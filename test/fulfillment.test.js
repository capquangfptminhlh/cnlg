const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Dữ liệu tạm – không bao giờ ghi vào data/orders.json thật
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-fulfill-'));
process.env.HM_ORDERS_FILE = path.join(tmp, 'orders.json');

const scraper = require('../services/dropbuyScraper');
const orderStore = require('../services/orderStore');
const fulfillment = require('../services/dropbuyOrderFulfillment');

scraper.getConfig = () => ({ dropbuy: {} }); // chưa đăng nhập DropBuy

function makeOrder(status = 'PAID') {
  const o = orderStore.createOrder({
    customer: { name: 'Khách Test', phone: '0988776655', address: '1 Cầu Giấy', province: 'Hà Nội' },
    items: [{ id: 141073, name: 'Bàn là mini', price: 250000, quantity: 1, variation_id: '141073' }],
    total_amount: 250000
  });
  return status === 'PENDING_PAYMENT' ? o : orderStore.updateOrder(o.id, { status });
}

test('Fulfillment – không đẩy đơn chưa nhận tiền', async () => {
  const o = makeOrder('PENDING_PAYMENT');
  await assert.rejects(fulfillment.fulfillOrderOnDropbuy(o.id, null), /đã nhận tiền/);
  assert.equal(orderStore.getOrderById(o.id).status, 'PENDING_PAYMENT');
});

test('Fulfillment – chưa đăng nhập DropBuy thì không giả vờ đã đặt kho', async () => {
  const o = makeOrder('PAID');
  const r = await fulfillment.fulfillOrderOnDropbuy(o.id, null);
  assert.equal(r.success, false);
  const after = orderStore.getOrderById(o.id);
  assert.equal(after.status, 'PAID');
  assert.equal(after.dropbuy_sync.status, 'WAITING_DROPBUY_LOGIN');
  assert.equal(after.needs_attention, true);
});

test('Fulfillment – gắn mã DropBuy chuyển PROCESSING, chặn mã trùng và mã sai', () => {
  const a = makeOrder('PAID');
  const b = makeOrder('PAID');
  const updated = fulfillment.attachDropbuyCode(a.id, ' db123456 ', null);
  assert.equal(updated.status, 'PROCESSING');
  assert.equal(updated.dropbuy_sync.order_code, 'DB123456');
  assert.throws(() => fulfillment.attachDropbuyCode(b.id, 'DB123456', null), /đã gắn/);
  assert.throws(() => fulfillment.attachDropbuyCode(b.id, 'x', null), /không hợp lệ/);
  assert.throws(() => fulfillment.attachDropbuyCode(makeOrder('CANCELLED').id, 'DB999999', null), /đã nhận tiền/);
});

test('Fulfillment – đồng bộ trạng thái bỏ qua khi chưa đăng nhập', async () => {
  const r = await fulfillment.syncDropbuyOrdersStatus(null);
  assert.equal(r.skipped, 'NO_SESSION');
});
