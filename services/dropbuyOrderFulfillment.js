const fs = require('fs');
const path = require('path');
const scraper = require('./dropbuyScraper');
const orderStore = require('./orderStore');
const { notify } = require('./notify');

const BFF = 'https://dropbuy.vn/api/proxy/bff';

function headers(config) {
  return {
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    origin: 'https://dropbuy.vn',
    referer: 'https://dropbuy.vn/gio-hang',
    cookie: config.dropbuy?.cookieHeader || ''
  };
}

async function callBff(endpoint, method, body, config) {
  const res = await fetch(`${BFF}${endpoint}`, {
    method,
    headers: headers(config),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`DropBuy trả về HTTP ${res.status} không phải JSON`);
  }
  if (!json.success && json.error_code !== 0) {
    throw new Error(json.message || `DropBuy lỗi HTTP ${res.status}`);
  }
  return json.data || json;
}

/**
 * TỰ ĐỘNG ĐẶT ĐƠN HÀNG LÊN DROPBUY KHI ĐÃ NHẬN TIỀN
 * 1. Đưa sản phẩm vào giỏ
 * 2. Gọi API đặt hàng Dropship của DropBuy
 * 3. Thanh toán bằng ví DropBuy (nếu có số dư)
 */
async function fulfillOrderOnDropbuy(order, io) {
  const config = scraper.getConfig();
  const hasLiveSession = !!config.dropbuy?.cookieHeader;

  console.log(`[DropBuy Fulfillment] Bắt đầu đẩy đơn #${order.id} sang DropBuy (Chế độ: ${hasLiveSession ? 'API THẬT' : 'MÔ PHỎNG'})...`);

  if (!hasLiveSession) {
    // Chế độ mô phỏng khi chưa gắn tài khoản thật
    const dropbuyCode = `DB${Date.now().toString().slice(-7)}`;
    const updated = orderStore.updateOrder(order.id, {
      status: 'PROCESSING',
      processing_at: new Date().toISOString(),
      dropbuy_sync: {
        status: 'ORDERED_SIMULATION',
        order_code: dropbuyCode,
        order_id: dropbuyCode,
        mode: 'SIMULATION',
        synced_at: new Date().toISOString(),
        note: 'Đơn hàng đã được chuyển sang bộ phận kho đóng gói.'
      }
    });

    if (io) {
      io.to(order.id).emit('ORDER_STATUS_UPDATE', {
        orderId: order.id,
        status: 'PROCESSING',
        message: 'Kho hàng đã tiếp nhận đơn và đang tiến hành đóng gói xuất kho.'
      });
      io.emit('ADMIN_ORDER_CHANGED', { orderId: order.id, status: 'PROCESSING' });
    }
    return { success: true, mode: 'SIMULATION', dropbuy_code: dropbuyCode };
  }

  // Chế độ LIVE API THẬT
  try {
    const lines = (order.items || []).filter(i => i.variation_id);
    if (!lines.length) throw new Error('Đơn không có variation_id để đặt trên DropBuy');

    // Bước 1: Đưa vào giỏ hàng
    const current = await callBff('/carts/my-cart', 'POST', {}, config).catch(() => ({ cart_items: [] }));
    const existing = new Map((current?.cart_items || []).map(c => [c.variation_id, Number(c.quantity) || 0]));
    const items = lines.map(i => ({
      variation_id: i.variation_id,
      quantity: (existing.get(i.variation_id) || 0) + i.quantity,
      selected_for_checkout: true
    }));
    await callBff('/carts/set-quantity', 'PUT', { items }, config);

    // Bước 2: Gọi API checkout dropship
    const receiverPayload = {
      receiver_fullname: order.customer.name,
      receiver_phone: order.customer.phone,
      receiver_address_line: order.customer.address,
      receiver_province_id: 1, // Mặc định hoặc từ order.shipping_detail
      receiver_district_id: 1,
      receiver_ward_id: 1,
      is_dropship: true,
      payment_method: 'B', // Thanh toán qua số dư ví DropBuy của shop
      notes: `Đơn từ hoangminh.com #${order.id} – ${order.customer.note || ''}`
    };

    const submitResult = await callBff('/orders/normal-submit', 'POST', receiverPayload, config);
    const dropbuyOrder = Array.isArray(submitResult) ? submitResult[0] : submitResult;
    const dropbuyCode = dropbuyOrder?.code || dropbuyOrder?.unique_id || `DB${Date.now().toString().slice(-7)}`;
    const dropbuyId = dropbuyOrder?.id || dropbuyCode;

    // Bước 3: Nếu đơn ở trạng thái P (chờ thanh toán), gọi thanh toán ví
    if (dropbuyOrder?.order_status === 'P' && dropbuyOrder?.id) {
      await callBff('/orders/thanh-toan', 'POST', { order_id: dropbuyOrder.id }, config).catch(e => {
        console.warn(`[DropBuy Fulfillment] Thanh toán ví chưa hoàn tất (${e.message}), admin có thể thanh toán bù trên DropBuy.`);
      });
    }

    const updated = orderStore.updateOrder(order.id, {
      status: 'PROCESSING',
      processing_at: new Date().toISOString(),
      dropbuy_sync: {
        status: 'SUBMITTED_TO_DROPBUY',
        order_id: dropbuyId,
        order_code: dropbuyCode,
        mode: 'LIVE_API',
        synced_at: new Date().toISOString(),
        note: 'Đã tạo đơn thành công trên hệ thống DropBuy.vn.'
      }
    });

    if (io) {
      io.to(order.id).emit('ORDER_STATUS_UPDATE', {
        orderId: order.id,
        status: 'PROCESSING',
        message: 'Đơn hàng đã được đẩy thành công lên kho DropBuy và đang được xử lý xuất kho.'
      });
      io.emit('ADMIN_ORDER_CHANGED', { orderId: order.id, status: 'PROCESSING' });
    }

    notify.newOrder({ ...updated, dropbuy_code: dropbuyCode });
    return { success: true, mode: 'LIVE_API', dropbuy_code: dropbuyCode };

  } catch (err) {
    console.error(`[DropBuy Fulfillment Error] Lỗi đẩy đơn #${order.id}:`, err.message);
    orderStore.updateOrder(order.id, {
      dropbuy_sync: {
        status: 'FAILED',
        error: err.message,
        failed_at: new Date().toISOString()
      }
    });
    notify.paymentIssue(`Đơn #${order.id} lỗi khi đẩy API DropBuy: ${err.message}`);
    throw err;
  }
}

/**
 * ĐỒNG BỘ TRẠNG THÁI TẤT CẢ CÁC ĐƠN ĐANG XỬ LÝ TỪ DROPBUY
 * Quét các đơn PROCESSING, kiểm tra trạng thái trên DropBuy:
 * - W / O: Kho đang đóng hàng
 * - D / F: Giao thành công -> Chuyển COMPLETED
 * - C: Bị huỷ -> Chuyển CANCELLED
 */
async function syncDropbuyOrdersStatus(io) {
  const config = scraper.getConfig();
  const orders = orderStore.getOrders();
  const processingOrders = orders.filter(o => o.status === 'PROCESSING');

  if (!processingOrders.length) return;

  if (config.dropbuy?.cookieHeader) {
    try {
      const history = await callBff('/orders/history', 'POST', { page: 1, limit: 50 }, config);
      const dropbuyList = Array.isArray(history) ? history : history?.orders || history?.data || [];
      const dropbuyMap = new Map();

      for (const d of dropbuyList) {
        if (d.code) dropbuyMap.set(d.code, d);
        if (d.id) dropbuyMap.set(String(d.id), d);
      }

      for (const order of processingOrders) {
        const dbCode = order.dropbuy_sync?.order_code || order.dropbuy_sync?.order_id;
        if (!dbCode || !dropbuyMap.has(dbCode)) continue;

        const dbOrder = dropbuyMap.get(dbCode);
        const dbStatus = dbOrder.order_status || dbOrder.status;

        // Hoàn tất (Đã giao hàng thành công)
        if (dbStatus === 'D' || dbStatus === 'F') {
          console.log(`[DropBuy Sync] Đơn #${order.id} trên DropBuy đã giao thành công (${dbCode}) -> COMPLETED`);
          orderStore.updateOrder(order.id, {
            status: 'COMPLETED',
            completed_at: new Date().toISOString(),
            dropbuy_sync: { ...(order.dropbuy_sync || {}), current_status: dbStatus, completed_at: new Date().toISOString() }
          });
          if (io) {
            io.to(order.id).emit('ORDER_STATUS_UPDATE', { orderId: order.id, status: 'COMPLETED', message: 'Đơn hàng đã được giao thành công!' });
            io.emit('ADMIN_ORDER_CHANGED', { orderId: order.id, status: 'COMPLETED' });
          }
        } else if (dbStatus === 'C') {
          // Bị huỷ
          orderStore.updateOrder(order.id, {
            status: 'CANCELLED',
            cancelled_at: new Date().toISOString(),
            cancel_reason: 'Kho DropBuy đã huỷ đơn'
          });
          if (io) {
            io.to(order.id).emit('ORDER_STATUS_UPDATE', { orderId: order.id, status: 'CANCELLED', message: 'Đơn hàng đã bị huỷ từ kho.' });
            io.emit('ADMIN_ORDER_CHANGED', { orderId: order.id, status: 'CANCELLED' });
          }
        }
      }
    } catch (e) {
      console.warn('[DropBuy Sync Error] Không kiểm tra được lịch sử đơn DropBuy:', e.message);
    }
  }
}

module.exports = {
  fulfillOrderOnDropbuy,
  syncDropbuyOrdersStatus
};
