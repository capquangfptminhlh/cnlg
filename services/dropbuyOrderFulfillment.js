const scraper = require('./dropbuyScraper');
const orderStore = require('./orderStore');
const dropbuyCart = require('./dropbuyCart');
const { bff, ensureSession, DropbuyError } = require('./dropbuySession');
const { notify } = require('./notify');
const { vnDate } = require('./backup');

/**
 * VÒNG ĐỜI ĐƠN TRÊN DROPBUY
 *
 * Tự đặt (admin bật "Tự đặt đơn DropBuy"):
 *   đơn COD vừa xác nhận / đơn chuyển khoản vừa nhận tiền
 *   → đưa đúng các món vào giỏ DropBuy, chỉ chọn các món đó
 *   → tính phí ship từng kho → kiểm tra hạn mức, số dư quỹ, lãi
 *   → orders/{fx}/normal-submit (dropship, payment_method "P" = trừ quỹ DropBuy; cod_amount = tiền shipper thu của khách)
 *   → PROCESSING, lưu mã đơn DropBuy.
 * Tắt tự đặt: chỉ đưa vào giỏ, admin đặt tay rồi dán mã đơn DropBuy.
 * Mỗi 2 phút đọc orders/history: D/F → COMPLETED; C/B/X/N → huỷ (COD) hoặc báo hoàn tiền (đã chuyển khoản).
 *
 * Request đặt đơn được đối chiếu với 1 đơn thật đặt từ giao diện DropBuy (20/10/2026).
 * Đường dẫn là orders/{sid}/normal-submit – {sid} = mã phiên đăng nhập hiện tại (trang thanh toán DropBuy
 * dùng `sid` của phiên), KHÔNG phải mã cố định. Không bao giờ ghi sid vào mã nguồn / log.
 */
const DONE = new Set(['D', 'F']);
const FAILED = { C: 'DropBuy đã huỷ đơn', B: 'Khách bom hàng', X: 'Hàng hoàn về kho', N: 'Giao không thành công' };
const STATUS_LABEL = { U: 'Nháp', P: 'Chờ thanh toán', O: 'Đã thanh toán', W: 'Chờ đóng hàng', G: 'Đã đóng hàng', Q: 'Chờ lấy hàng', S: 'Đang giao', F: 'Đã giao', D: 'Hoàn thành', K: 'Đang khiếu nại', C: 'Đã huỷ', B: 'Bom hàng', X: 'Hoàn hàng', N: 'Giao không thành công' };
const LOCKED_SYNC = new Set(['SUBMITTING', 'ORDERED', 'SUBMIT_UNKNOWN']);

const AUTO_DEFAULTS = { enabled: false, maxOrderSpend: 3000000, maxDailySpend: 10000000, minBalance: 0, shippingMethod: 'cheapest', requireProfit: true };

function num(v, def, min = 0) {
  const x = Number(v);
  return Number.isFinite(x) && x >= min ? Math.round(x) : def;
}

function normalizeAutoOrder(raw = {}) {
  const r = { ...AUTO_DEFAULTS, ...raw };
  return {
    enabled: r.enabled === true,
    maxOrderSpend: num(r.maxOrderSpend, AUTO_DEFAULTS.maxOrderSpend),
    maxDailySpend: num(r.maxDailySpend, AUTO_DEFAULTS.maxDailySpend),
    minBalance: num(r.minBalance, AUTO_DEFAULTS.minBalance),
    shippingMethod: ['cheapest', 'V', 'S'].includes(r.shippingMethod) ? r.shippingMethod : 'cheapest',
    requireProfit: r.requireProfit !== false
  };
}

const inFlight = new Set();
const { withCartLock, snapshotCart, selectOnly, restoreCart, groupByDepot, shippingFor } = dropbuyCart;

function emit(io, order, status, message) {
  if (!io) return;
  if (message) io.to(order.id).emit('ORDER_STATUS_UPDATE', { orderId: order.id, status, message });
  io.emit('ADMIN_ORDER_CHANGED', { orderId: order.id, status });
}

function setSync(id, patch, extra = {}) {
  const cur = orderStore.getOrderById(id);
  return orderStore.updateOrder(id, { ...extra, dropbuy_sync: { ...(cur?.dropbuy_sync || {}), ...patch, updated_at: new Date().toISOString() } });
}

function readyStatus(order) {
  return order.payment_method === 'COD' ? order.status === 'CONFIRMED' : order.status === 'PAID';
}

/** Tổng tiền đã đặt trên DropBuy hôm nay (giờ VN) */
function spentToday(orders = orderStore.getOrders()) {
  const today = vnDate();
  return orders.reduce((s, o) => {
    const d = o.dropbuy_sync;
    // Đơn đã huỷ trên DropBuy được hoàn quỹ → không tính vào hạn mức ngày
    return d?.status === 'ORDERED' && o.status !== 'CANCELLED' && d.current_status !== 'C' && d.ordered_at && vnDate(new Date(d.ordered_at)) === today ? s + (d.spend || 0) : s;
  }, 0);
}

/** Chia tiền thu hộ theo từng kho: tiền hàng của kho đó + toàn bộ phí ship khách trả cộng vào kho đầu tiên */
function codPerDepot(order, depots) {
  if (order.payment_method !== 'COD') return depots.map(() => 0);
  const byVariation = new Map((order.items || []).map(i => [i.variation_id, i]));
  const cods = depots.map(d => d.lines.reduce((s, c) => {
    const it = byVariation.get(c.variation_id);
    return s + (it ? it.price * it.quantity : 0);
  }, 0));
  if (cods.length) cods[0] += order.shipping_fee || 0;
  const diff = (order.total_amount || 0) - cods.reduce((a, b) => a + b, 0);
  if (cods.length) cods[0] += diff; // làm tròn để tổng COD = đúng số khách phải trả
  return cods;
}

/**
 * Đặt đơn dropship trên DropBuy, trừ quỹ. Ném lỗi kèm lý do nếu bị chặn; không bao giờ gửi lặp 1 đơn.
 */
async function placeOrderOnDropbuy(orderId, io, { manual = false } = {}) {
  const order = orderStore.getOrderById(orderId);
  if (!order) throw new Error('Không tìm thấy đơn hàng');
  if (!readyStatus(order)) throw new Error(order.payment_method === 'COD' ? 'Đơn COD phải ở trạng thái đã xác nhận.' : 'Đơn chuyển khoản phải nhận tiền xong mới đặt kho.');
  if (LOCKED_SYNC.has(order.dropbuy_sync?.status)) throw new Error(`Đơn đã gửi sang DropBuy (${order.dropbuy_sync.status}) – không đặt lại để tránh trùng.`);
  if (inFlight.has(orderId)) throw new Error('Đơn đang được đặt.');
  const c = order.customer || {};
  if (!c.province_id || !c.ward_id) throw new Error('Đơn thiếu phường/xã theo danh mục DropBuy – đặt tay trên DropBuy.');
  const lines = (order.items || []).filter(i => i.variation_id);
  if (lines.length !== (order.items || []).length) throw new Error('Có sản phẩm thiếu mã phân loại DropBuy.');

  const config = scraper.getConfig();
  const rules = normalizeAutoOrder(config.autoOrder);

  inFlight.add(orderId);
  return withCartLock(async () => {
    let before = null;
    let submitted = false;
    try {
      // 1. Giỏ hiện tại (để khôi phục sau) → 2. đúng số lượng, chỉ chọn các món của đơn
      before = await snapshotCart(config);
      const picked = await selectOnly(lines, config);

      // 3. Gom theo kho, tính ship
      const depots = groupByDepot(picked);
      const cods = codPerDepot(order, depots);
      const receiver = { province_id: Number(c.province_id), ward_id: Number(c.ward_id) };
      for (let k = 0; k < depots.length; k++) {
        depots[k].ship = await shippingFor(depots[k], receiver, cods[k], rules.shippingMethod, config);
        depots[k].goods = depots[k].lines.reduce((s, x) => s + Number(x.fe_price_override || 0) * Number(x.quantity), 0);
      }
      const goods = depots.reduce((s, d) => s + d.goods, 0);
      const shipCost = depots.reduce((s, d) => s + d.ship.fee, 0);
      const spend = goods + shipCost;

      // 4. Chốt chặn tiền
      const revenue = order.total_amount || 0;
      if (rules.requireProfit && spend > revenue) throw new Error(`Lỗ: DropBuy tính ${spend.toLocaleString('vi-VN')} đ > khách trả ${revenue.toLocaleString('vi-VN')} đ (giá vốn/ship vừa đổi).`);
      if (spend > rules.maxOrderSpend) throw new Error(`Vượt hạn mức 1 đơn: ${spend.toLocaleString('vi-VN')} đ > ${rules.maxOrderSpend.toLocaleString('vi-VN')} đ.`);
      const today = spentToday();
      if (today + spend > rules.maxDailySpend) throw new Error(`Vượt hạn mức trong ngày: đã đặt ${today.toLocaleString('vi-VN')} đ, đơn này ${spend.toLocaleString('vi-VN')} đ, hạn mức ${rules.maxDailySpend.toLocaleString('vi-VN')} đ.`);
      const bal = await bff('/balance/my-balance', { config });
      const available = Number(bal?.avail_balance_current || 0);
      if (available - spend < rules.minBalance) throw new Error(`Quỹ DropBuy không đủ: còn ${available.toLocaleString('vi-VN')} đ, cần ${spend.toLocaleString('vi-VN')} đ${rules.minBalance ? ` (giữ lại ${rules.minBalance.toLocaleString('vi-VN')} đ)` : ''}.`);

      // 5. Gửi đơn – từ đây không tự gửi lại
      setSync(orderId, { status: 'SUBMITTING', mode: manual ? 'MANUAL_BUTTON' : 'AUTO', spend, goods_cost: goods, ship_cost: shipCost, error: null });
      submitted = true;
      const receiverInfo = {
        receiver_fullname: c.name,
        receiver_phone: c.phone,
        receiver_address_line: c.address,
        receiver_email: '',
        receiver_province_id: receiver.province_id,
        receiver_province_name: c.province_name || c.province,
        receiver_district_id: 0,
        receiver_district_name: '',
        receiver_ward_id: receiver.ward_id,
        receiver_ward_name: c.ward_name || ''
      };
      const body = {
        site_code: 'D',
        ...receiverInfo,
        order_options: depots.map((d, k) => ({
          shop_depot_code: d.code,
          order_type: 'N',
          shipping_method: d.ship.method,
          delivery_option: 'C',
          cod_amount: cods[k],
          weight_fee_user: d.ship.fee,
          ...(c.note ? { notes: String(c.note).slice(0, 200) } : {}),
          items: d.lines
        })),
        is_dropship: 'D',
        payment_method: 'P',
        receiver_address_id: '',
        dropshipAddress: {
          fullname: c.name, phone: c.phone, address_line: c.address, receiver_email: '',
          province_id: receiver.province_id, province_name: receiverInfo.receiver_province_name,
          district_id: 0, district_name: '', ward_id: receiver.ward_id, ward_name: receiverInfo.receiver_ward_name
        },
        is_dirty: true
      };
      const sess = await ensureSession(config);
      if (!sess) throw new DropbuyError('Phiên DropBuy vừa hết hạn – đăng nhập lại trong admin.', 401);
      const created = await bff(`/orders/${sess.sid}/normal-submit`, { method: 'POST', config, body, timeoutMs: 45000 });
      const list = (Array.isArray(created) ? created : [created]).filter(Boolean).map(x => ({ id: x.id, code: x.code, status: x.status }));
      if (!list.length || !list[0].code) throw Object.assign(new Error('DropBuy không trả về mã đơn.'), { unknown: true });
      const unpaid = list.filter(x => x.status !== 'O');
      const now = new Date().toISOString();
      const updated = setSync(orderId, {
        status: 'ORDERED',
        order_code: list[0].code,
        order_id: list[0].id,
        orders: list,
        ordered_at: now,
        problem: unpaid.length ? `Đơn DropBuy chưa thanh toán (${unpaid.map(x => x.code).join(', ')}) – vào DropBuy thanh toán.` : null
      }, { status: 'PROCESSING', processing_at: now, needs_attention: unpaid.length > 0 });
      emit(io, updated, 'PROCESSING', 'Kho đã nhận đơn và đang chuẩn bị hàng.');
      notify.paymentIssue(`✅ Đã đặt DropBuy cho đơn ${orderId}: ${list.map(x => x.code).join(', ')} – trừ quỹ ${spend.toLocaleString('vi-VN')} đ${order.payment_method === 'COD' ? `, thu hộ ${(order.total_amount || 0).toLocaleString('vi-VN')} đ` : ''}.`);
      return { success: true, orders: list, spend, goods_cost: goods, ship_cost: shipCost };
    } catch (err) {
      // Đã gửi mà không rõ kết quả (mạng/timeout) → không đoán, bắt admin kiểm tra trên DropBuy
      const unknown = submitted && (err.unknown || !(err instanceof DropbuyError));
      setSync(orderId, unknown
        ? { status: 'SUBMIT_UNKNOWN', error: `Không rõ DropBuy đã tạo đơn chưa: ${err.message}. Kiểm tra mục Đơn mua trên DropBuy rồi dán mã đơn.` }
        : { status: err.code === 401 ? 'WAITING_DROPBUY_LOGIN' : 'FAILED', error: err.message, failed_at: new Date().toISOString() },
        { needs_attention: true });
      emit(io, order, order.status);
      notify.paymentIssue(`Đơn ${orderId}: chưa đặt được trên DropBuy – ${err.message}`);
      throw err;
    } finally {
      if (before) await restoreCart(before, lines, config);
      inFlight.delete(orderId);
    }
  });
}

/**
 * Gọi khi đơn sẵn sàng (COD vừa xác nhận, chuyển khoản vừa nhận tiền).
 * Bật tự đặt → đặt luôn; tắt → chỉ đưa vào giỏ cho admin đặt tay.
 */
async function handOff(orderId, io) {
  const config = scraper.getConfig();
  const order = orderStore.getOrderById(orderId);
  if (!order || !readyStatus(order)) return { success: false, mode: 'NOT_READY' };
  if (!config.dropbuy?.cookieHeader) {
    setSync(orderId, { status: 'WAITING_DROPBUY_LOGIN', note: 'Chưa đăng nhập DropBuy trong admin.' }, { needs_attention: true });
    notify.paymentIssue(`Đơn ${orderId} chờ đặt kho nhưng admin chưa đăng nhập DropBuy.`);
    emit(io, order, order.status);
    return { success: false, mode: 'NO_SESSION' };
  }
  if (normalizeAutoOrder(config.autoOrder).enabled) {
    const r = await placeOrderOnDropbuy(orderId, io);
    return { ...r, mode: 'AUTO_ORDER' };
  }
  return fulfillOrderOnDropbuy(orderId, io);
}

/** Tắt tự đặt: đưa các món vào giỏ DropBuy để admin đặt tay. */
async function fulfillOrderOnDropbuy(orderOrId, io, { force = false } = {}) {
  const id = typeof orderOrId === 'string' ? orderOrId : orderOrId.id;
  const order = orderStore.getOrderById(id);
  if (!order) throw new Error('Không tìm thấy đơn hàng');
  if (!readyStatus(order)) throw new Error('Chỉ chuyển sang DropBuy khi đơn đã nhận tiền (hoặc đơn COD đã xác nhận) và chưa đặt kho.');
  const synced = order.dropbuy_sync?.status;
  if (LOCKED_SYNC.has(synced) || (synced === 'IN_DROPBUY_CART' && !force)) throw new Error('Đơn này đã được đưa sang DropBuy rồi.');
  if (inFlight.has(id)) throw new Error('Đơn đang được xử lý.');
  inFlight.add(id);
  try {
    const config = scraper.getConfig();
    if (!config.dropbuy?.cookieHeader) {
      setSync(id, { status: 'WAITING_DROPBUY_LOGIN', note: 'Chưa đăng nhập DropBuy trong admin.' }, { needs_attention: true });
      notify.paymentIssue(`Đơn ${id} chờ đặt kho nhưng admin chưa đăng nhập DropBuy – chưa đưa được vào giỏ.`);
      emit(io, order, order.status);
      return { success: false, mode: 'NO_SESSION' };
    }
    const cart = await withCartLock(() => dropbuyCart.pushOrderToCart(order, config));
    setSync(id, { status: 'IN_DROPBUY_CART', pushed_at: new Date().toISOString(), note: 'Đã vào giỏ DropBuy – đặt đơn dropship rồi dán mã đơn DropBuy vào admin.' }, { needs_attention: true });
    emit(io, order, order.status);
    return { success: true, mode: 'CART', ...cart };
  } catch (err) {
    setSync(id, { status: err.code === 401 ? 'WAITING_DROPBUY_LOGIN' : 'FAILED', error: err.message, failed_at: new Date().toISOString() }, { needs_attention: true });
    notify.paymentIssue(`Đơn ${id}: không đưa được vào giỏ DropBuy – ${err.message}`);
    throw err;
  } finally {
    inFlight.delete(id);
  }
}

/** Admin đã đặt tay trên DropBuy (hoặc đối chiếu đơn SUBMIT_UNKNOWN) → gắn mã đơn để theo dõi tự động. */
function attachDropbuyCode(orderId, code, io) {
  const order = orderStore.getOrderById(orderId);
  if (!order) throw new Error('Không tìm thấy đơn hàng');
  if (!['PAID', 'CONFIRMED', 'PROCESSING'].includes(order.status)) throw new Error('Chỉ gắn mã DropBuy cho đơn đã nhận tiền hoặc đơn COD đã xác nhận.');
  const clean = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,40}$/.test(clean)) throw new Error('Mã đơn DropBuy không hợp lệ.');
  const dup = orderStore.getOrders().find(o => o.id !== orderId && o.dropbuy_sync?.order_code === clean);
  if (dup) throw new Error(`Mã này đã gắn cho đơn ${dup.id}.`);
  const now = new Date().toISOString();
  const updated = setSync(orderId, { status: 'ORDERED', order_code: clean, ordered_at: order.dropbuy_sync?.ordered_at || now, error: null, mode: 'MANUAL_CODE' },
    { status: 'PROCESSING', processing_at: order.processing_at || now, needs_attention: false });
  emit(io, updated, 'PROCESSING', 'Kho đã nhận đơn và đang chuẩn bị hàng.');
  return updated;
}

/** Huỷ đơn trên DropBuy (khi DropBuy còn cho huỷ – chưa đóng gói). Hoàn quỹ do DropBuy xử lý. */
async function cancelOnDropbuy(orderId, io) {
  const order = orderStore.getOrderById(orderId);
  const ids = (order?.dropbuy_sync?.orders || []).map(x => x.id).filter(Boolean);
  if (!ids.length && order?.dropbuy_sync?.order_id) ids.push(order.dropbuy_sync.order_id);
  if (!ids.length) throw new Error('Đơn chưa có mã đơn DropBuy (số) để huỷ – huỷ trực tiếp trên DropBuy.');
  const config = scraper.getConfig();
  for (const id of ids) await bff('/orders/cancel-by-user', { method: 'POST', config, body: { order_id: Number(id) } });
  const now = new Date().toISOString();
  const refund = order.payment_method !== 'COD' && ['PAID', 'PROCESSING'].includes(order.status) && order.paid_at;
  const updated = setSync(orderId, { current_status: 'C', current_label: STATUS_LABEL.C, cancelled_at: now },
    { status: 'CANCELLED', cancelled_at: now, cancel_reason: 'Admin huỷ đơn trên DropBuy', needs_attention: !!refund, ...(refund ? { refund_needed: true } : {}) });
  emit(io, updated, 'CANCELLED', 'Đơn hàng đã được huỷ.');
  return updated;
}

async function fetchHistory(config, orderCode) {
  const data = await bff('/orders/history', { method: 'POST', config, body: { order_code: orderCode, page_num: 1, page_size: 5 } });
  return data?.orders || data?.items || [];
}

/** Đồng bộ trạng thái các đơn PROCESSING đã có mã DropBuy. */
async function syncDropbuyOrdersStatus(io) {
  const config = scraper.getConfig();
  if (!config.dropbuy?.cookieHeader) return { checked: 0, skipped: 'NO_SESSION' };
  const targets = orderStore.getOrders().filter(o => o.status === 'PROCESSING' && o.dropbuy_sync?.order_code);
  let checked = 0;
  for (const order of targets) {
    const codes = (order.dropbuy_sync.orders || []).map(x => x.code).filter(Boolean);
    if (!codes.length) codes.push(order.dropbuy_sync.order_code);
    const found = [];
    for (const code of codes) {
      const items = await fetchHistory(config, code);
      const d = items.find(x => String(x.code).toUpperCase() === String(code).toUpperCase());
      if (d) found.push(d);
    }
    checked += 1;
    if (!found.length) continue;
    // Nhiều kho: lấy trạng thái "chậm nhất" để quyết định
    const sts = found.map(d => d.order_status);
    const failed = sts.find(s => FAILED[s]);
    const allDone = sts.every(s => DONE.has(s));
    const head = found[0];
    const now = new Date().toISOString();
    const sync = {
      ...order.dropbuy_sync,
      current_status: failed || (allDone ? head.order_status : sts.find(s => !DONE.has(s)) || head.order_status),
      shipping_ref_code: found.map(d => d.shipping_ref_code).filter(Boolean).join(', ') || order.dropbuy_sync.shipping_ref_code || null,
      dropbuy_total: found.reduce((s, d) => s + (d.total_amount || 0), 0),
      dropbuy_profit: found.reduce((s, d) => s + (d.profit_amount || 0), 0),
      checked_at: now
    };
    sync.current_label = STATUS_LABEL[sync.current_status] || sync.current_status;
    if (allDone) {
      const updated = orderStore.updateOrder(order.id, { status: 'COMPLETED', completed_at: now, dropbuy_sync: sync, ...(order.payment_method === 'COD' ? { paid_at: order.paid_at || now } : {}) });
      emit(io, updated, 'COMPLETED', 'Đơn hàng đã giao thành công!');
    } else if (failed) {
      if (order.payment_method === 'COD') {
        // Khách chưa trả tiền → huỷ đơn bên mình, quỹ do DropBuy hoàn/trừ theo chính sách của họ
        const updated = orderStore.updateOrder(order.id, { status: 'CANCELLED', cancelled_at: now, cancel_reason: FAILED[failed], dropbuy_sync: { ...sync, problem: FAILED[failed] }, needs_attention: failed !== 'C' });
        emit(io, updated, 'CANCELLED', 'Đơn hàng đã bị huỷ.');
        if (failed !== 'C') notify.paymentIssue(`Đơn COD ${order.id} (DropBuy ${codes.join(', ')}): ${FAILED[failed]} – kiểm tra phí hoàn trên DropBuy.`);
      } else {
        // Khách đã chuyển khoản → không tự huỷ, báo admin hoàn tiền
        if (!order.needs_attention) notify.paymentIssue(`Đơn ${order.id} (DropBuy ${codes.join(', ')}): ${FAILED[failed]} – cần hoàn tiền hoặc xử lý cho khách.`);
        orderStore.updateOrder(order.id, { needs_attention: true, dropbuy_sync: { ...sync, problem: FAILED[failed] } });
        emit(io, order, order.status);
      }
    } else if (sync.current_status !== order.dropbuy_sync.current_status || sync.shipping_ref_code !== order.dropbuy_sync.shipping_ref_code) {
      orderStore.updateOrder(order.id, { dropbuy_sync: sync });
      emit(io, order, order.status);
    }
  }
  return { checked };
}

module.exports = {
  placeOrderOnDropbuy,
  handOff,
  fulfillOrderOnDropbuy,
  attachDropbuyCode,
  cancelOnDropbuy,
  syncDropbuyOrdersStatus,
  normalizeAutoOrder,
  codPerDepot,
  spentToday,
  STATUS_LABEL
};
