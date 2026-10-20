const scraper = require('./dropbuyScraper');
const orderStore = require('./orderStore');
const dropbuyCart = require('./dropbuyCart');
const { notify } = require('./notify');

/**
 * VÒNG ĐỜI ĐƠN TRÊN DROPBUY
 *
 * 1. Đơn đã nhận tiền (PAID) → tự đưa các món vào giỏ DropBuy của shop (chỉ giỏ, không trừ tiền).
 * 2. Admin đặt đơn dropship trên DropBuy rồi dán mã đơn DropBuy vào admin → đơn chuyển PROCESSING.
 * 3. Mỗi 2 phút đọc lịch sử đơn DropBuy (orders/history) theo mã đó:
 *    D/F (hoàn thành / đã giao) → COMPLETED; C/B/X/N (huỷ, bom, hoàn, giao lỗi) → cần xử lý (hoàn tiền khách).
 *
 * Chưa tự gọi orders/{fx}/normal-submit: API cần mã tỉnh/quận/xã và mã kho (shop_depot_code) theo danh mục
 * của DropBuy mà cửa hàng chưa thu thập, gửi sai sẽ giao nhầm địa chỉ. Bật khi đã đối chiếu với 1 đơn thật.
 */
const BFF = 'https://dropbuy.vn/api/proxy/bff';
const DONE = new Set(['D', 'F']);
const FAILED = { C: 'DropBuy đã huỷ đơn', B: 'Khách bom hàng', X: 'Hàng hoàn về kho', N: 'Giao không thành công' };
const STATUS_LABEL = { U: 'Nháp', P: 'Chờ thanh toán', O: 'Đã thanh toán', W: 'Chờ đóng hàng', G: 'Đã đóng hàng', Q: 'Chờ lấy hàng', S: 'Đang giao', F: 'Đã giao', D: 'Hoàn thành', K: 'Đang khiếu nại', C: 'Đã huỷ', B: 'Bom hàng', X: 'Hoàn hàng', N: 'Giao không thành công' };

const inFlight = new Set();

function emit(io, order, status, message) {
  if (!io) return;
  if (message) io.to(order.id).emit('ORDER_STATUS_UPDATE', { orderId: order.id, status, message });
  io.emit('ADMIN_ORDER_CHANGED', { orderId: order.id, status });
}

/** Bước 1 – gọi sau khi xác nhận tiền về. Không đổi trạng thái khách nhìn thấy. */
async function fulfillOrderOnDropbuy(orderOrId, io, { force = false } = {}) {
  const id = typeof orderOrId === 'string' ? orderOrId : orderOrId.id;
  const order = orderStore.getOrderById(id);
  if (!order) throw new Error('Không tìm thấy đơn hàng');
  if (order.status !== 'PAID') throw new Error('Chỉ chuyển sang DropBuy khi đơn đã nhận tiền và chưa đặt kho.');
  const synced = order.dropbuy_sync?.status;
  if (synced === 'ORDERED' || (synced === 'IN_DROPBUY_CART' && !force)) throw new Error('Đơn này đã được đưa sang DropBuy rồi.');
  if (inFlight.has(id)) throw new Error('Đơn đang được xử lý.');
  inFlight.add(id);
  try {
    const config = scraper.getConfig();
    if (!config.dropbuy?.cookieHeader) {
      orderStore.updateOrder(id, {
        needs_attention: true,
        dropbuy_sync: { ...(order.dropbuy_sync || {}), status: 'WAITING_DROPBUY_LOGIN', note: 'Chưa đăng nhập DropBuy trong admin.', updated_at: new Date().toISOString() }
      });
      notify.paymentIssue(`Đơn ${id} đã nhận tiền nhưng admin chưa đăng nhập DropBuy – chưa đưa được vào giỏ.`);
      emit(io, order, order.status);
      return { success: false, mode: 'NO_SESSION' };
    }
    const cart = await dropbuyCart.pushOrderToCart(order, config);
    orderStore.updateOrder(id, {
      needs_attention: true,
      dropbuy_sync: { ...(order.dropbuy_sync || {}), status: 'IN_DROPBUY_CART', pushed_at: new Date().toISOString(), note: 'Đã vào giỏ DropBuy – đặt đơn dropship rồi dán mã đơn DropBuy vào admin.' }
    });
    emit(io, order, order.status);
    return { success: true, mode: 'CART', ...cart };
  } catch (err) {
    orderStore.updateOrder(id, {
      needs_attention: true,
      dropbuy_sync: { ...(order.dropbuy_sync || {}), status: 'FAILED', error: err.message, failed_at: new Date().toISOString() }
    });
    notify.paymentIssue(`Đơn ${id}: không đưa được vào giỏ DropBuy – ${err.message}`);
    throw err;
  } finally {
    inFlight.delete(id);
  }
}

/** Bước 2 – admin đã đặt trên DropBuy, gắn mã đơn DropBuy để theo dõi tự động. */
function attachDropbuyCode(orderId, code, io) {
  const order = orderStore.getOrderById(orderId);
  if (!order) throw new Error('Không tìm thấy đơn hàng');
  if (!['PAID', 'PROCESSING'].includes(order.status)) throw new Error('Chỉ gắn mã DropBuy cho đơn đã nhận tiền.');
  const clean = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,40}$/.test(clean)) throw new Error('Mã đơn DropBuy không hợp lệ.');
  const dup = orderStore.getOrders().find(o => o.id !== orderId && o.dropbuy_sync?.order_code === clean);
  if (dup) throw new Error(`Mã này đã gắn cho đơn ${dup.id}.`);
  const now = new Date().toISOString();
  const updated = orderStore.updateOrder(orderId, {
    status: 'PROCESSING',
    processing_at: order.processing_at || now,
    needs_attention: false,
    dropbuy_sync: { ...(order.dropbuy_sync || {}), status: 'ORDERED', order_code: clean, ordered_at: now, error: null }
  });
  emit(io, updated, 'PROCESSING', 'Kho đã nhận đơn và đang chuẩn bị hàng.');
  return updated;
}

async function fetchHistory(config, orderCode) {
  const res = await fetch(`${BFF}/orders/history`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      origin: 'https://dropbuy.vn',
      referer: 'https://dropbuy.vn/',
      cookie: config.dropbuy.cookieHeader
    },
    body: JSON.stringify({ order_code: orderCode, page_num: 1, page_size: 5 })
  });
  const json = await res.json().catch(() => null);
  if (!json?.success) throw new Error(json?.message || `DropBuy lỗi HTTP ${res.status}`);
  return json.data?.items || [];
}

/** Bước 3 – đồng bộ trạng thái các đơn PROCESSING đã có mã DropBuy. */
async function syncDropbuyOrdersStatus(io) {
  const config = scraper.getConfig();
  if (!config.dropbuy?.cookieHeader) return { checked: 0, skipped: 'NO_SESSION' };
  const targets = orderStore.getOrders().filter(o => o.status === 'PROCESSING' && o.dropbuy_sync?.order_code);
  let checked = 0;
  for (const order of targets) {
    const code = order.dropbuy_sync.order_code;
    const items = await fetchHistory(config, code);
    const d = items.find(x => String(x.code).toUpperCase() === code);
    checked += 1;
    if (!d) continue;
    const st = d.order_status;
    const now = new Date().toISOString();
    const sync = {
      ...order.dropbuy_sync,
      current_status: st,
      current_label: STATUS_LABEL[st] || st,
      shipping_ref_code: d.shipping_ref_code || order.dropbuy_sync.shipping_ref_code || null,
      dropbuy_total: d.total_amount ?? null,
      dropbuy_profit: d.profit_amount ?? null,
      checked_at: now
    };
    if (DONE.has(st)) {
      const updated = orderStore.updateOrder(order.id, { status: 'COMPLETED', completed_at: now, dropbuy_sync: sync });
      emit(io, updated, 'COMPLETED', 'Đơn hàng đã giao thành công!');
    } else if (FAILED[st]) {
      // Khách đã trả tiền cho shop → không tự huỷ, báo admin hoàn tiền / xử lý
      if (!order.needs_attention) notify.paymentIssue(`Đơn ${order.id} (DropBuy ${code}): ${FAILED[st]} – cần hoàn tiền hoặc xử lý cho khách.`);
      orderStore.updateOrder(order.id, { needs_attention: true, dropbuy_sync: { ...sync, problem: FAILED[st] } });
      emit(io, order, order.status);
    } else if (st !== order.dropbuy_sync.current_status || sync.shipping_ref_code !== order.dropbuy_sync.shipping_ref_code) {
      orderStore.updateOrder(order.id, { dropbuy_sync: sync });
      emit(io, order, order.status);
    }
  }
  return { checked };
}

module.exports = { fulfillOrderOnDropbuy, attachDropbuyCode, syncDropbuyOrdersStatus, STATUS_LABEL };
