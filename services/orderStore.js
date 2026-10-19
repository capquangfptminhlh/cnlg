const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ORDERS_FILE = path.join(__dirname, '..', 'data', 'orders.json');

// Trạng thái: PENDING_PAYMENT → PAYMENT_REPORTED (khách báo đã CK) → PAID (admin xác nhận) → COMPLETED / CANCELLED
const STATUSES = ['PENDING_PAYMENT', 'PAYMENT_REPORTED', 'PAID', 'PROCESSING', 'COMPLETED', 'CANCELLED'];

function getOrders() {
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function saveOrders(orders) {
  // Ghi qua file tạm rồi đổi tên để không hỏng orders.json nếu tiến trình dừng giữa chừng
  const tmp = `${ORDERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(orders, null, 2), 'utf8');
  fs.renameSync(tmp, ORDERS_FILE);
}

/** Mã đơn khó đoán: HM + 8 ký tự ngẫu nhiên (trước đây là 6 số cuối timestamp, dễ dò để xem thông tin khách). */
function newOrderId(existing) {
  let id;
  do {
    id = `HM${crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 8)}`;
  } while (existing.some(o => o.id === id));
  return id;
}

function createOrder(orderData) {
  const orders = getOrders();
  const orderId = newOrderId(orders);

  const newOrder = {
    id: orderId,
    created_at: new Date().toISOString(),
    status: 'PENDING_PAYMENT',
    customer: {
      name: orderData.customer.name || '',
      phone: orderData.customer.phone || '',
      province: orderData.customer.province || '',
      address: orderData.customer.address || '',
      note: orderData.customer.note || ''
    },
    items: orderData.items || [],
    total_amount: orderData.total_amount || 0,
    dropbuy_sync: {
      status: 'INITIATING',
      order_id: null,
      relay_mode: 'AUTO',
      last_checked_at: new Date().toISOString()
    },
    payment: null
  };

  orders.unshift(newOrder);
  saveOrders(orders);
  return newOrder;
}

function updateOrder(orderId, updates) {
  const orders = getOrders();
  const index = orders.findIndex(o => o.id === orderId);
  if (index === -1) return null;

  orders[index] = {
    ...orders[index],
    ...updates,
    updated_at: new Date().toISOString()
  };

  saveOrders(orders);
  return orders[index];
}

function getOrderById(orderId) {
  const orders = getOrders();
  return orders.find(o => o.id === orderId) || null;
}

module.exports = {
  STATUSES,
  getOrders,
  createOrder,
  updateOrder,
  getOrderById
};
