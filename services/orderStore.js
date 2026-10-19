const fs = require('fs');
const path = require('path');

const ORDERS_FILE = path.join(__dirname, '..', 'data', 'orders.json');

function getOrders() {
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');
}

function createOrder(orderData) {
  const orders = getOrders();
  const orderId = `HM${Date.now().toString().slice(-6)}`;
  
  const newOrder = {
    id: orderId,
    created_at: new Date().toISOString(),
    status: 'PENDING_PAYMENT', // PENDING_PAYMENT -> PAID -> PROCESSING -> COMPLETED / CANCELLED
    customer: {
      name: orderData.customer.name || '',
      phone: orderData.customer.phone || '',
      address: orderData.customer.address || '',
      note: orderData.customer.note || ''
    },
    items: orderData.items || [],
    total_amount: orderData.total_amount || 0,
    dropbuy_sync: {
      status: 'INITIATING', // INITIATING -> SUCCESS -> FAILED
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
  getOrders,
  createOrder,
  updateOrder,
  getOrderById
};
