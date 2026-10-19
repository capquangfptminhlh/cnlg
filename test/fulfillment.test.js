const test = require('node:test');
const assert = require('node:assert/strict');
const dropbuyOrderFulfillment = require('../services/dropbuyOrderFulfillment');
const orderStore = require('../services/orderStore');

test('Fulfillment - Tự động tạo đơn hàng DropBuy và cập nhật trạng thái', async () => {
  const sampleOrder = orderStore.createOrder({
    customer: { name: 'Nguyễn Văn Test', phone: '0988776655', address: '123 Đường Cầu Giấy, Hà Nội' },
    items: [{ id: 141073, name: 'Bàn là hơi nước mini', price: 250000, quantity: 1, variation_id: 'v-141073' }],
    total_amount: 250000
  });

  assert.equal(sampleOrder.status, 'PENDING_PAYMENT');

  // Gọi fulfillment
  const res = await dropbuyOrderFulfillment.fulfillOrderOnDropbuy(sampleOrder, null);
  assert.equal(res.success, true);
  assert.ok(res.dropbuy_code);

  const updated = orderStore.getOrderById(sampleOrder.id);
  assert.equal(updated.status, 'PROCESSING');
  assert.ok(updated.dropbuy_sync);
  assert.ok(updated.dropbuy_sync.order_code);
});
