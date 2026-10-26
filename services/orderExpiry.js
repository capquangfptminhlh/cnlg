const orderStore = require('./orderStore');
const { emitAdmin } = require('./security');

/**
 * Tự huỷ đơn chờ thanh toán quá hạn (config.orders.paymentTimeoutMinutes, mặc định 30 phút).
 * Đơn khách đã báo chuyển khoản (PAYMENT_REPORTED) KHÔNG bị huỷ tự động – chỉ gắn cờ cần xử lý
 * nếu quá `reportedAlertHours` (mặc định 12 giờ) mà admin chưa xác nhận.
 */

const DEFAULTS = { paymentTimeoutMinutes: 30, reportedAlertHours: 12 };

function normalizeOrderRules(raw = {}) {
  const t = Number(raw.paymentTimeoutMinutes);
  const h = Number(raw.reportedAlertHours);
  return {
    paymentTimeoutMinutes: Number.isFinite(t) && t >= 5 && t <= 7 * 24 * 60 ? Math.round(t) : DEFAULTS.paymentTimeoutMinutes,
    reportedAlertHours: Number.isFinite(h) && h >= 1 && h <= 240 ? h : DEFAULTS.reportedAlertHours
  };
}

let timer = null;

function sweep(io, getConfig) {
  const rules = normalizeOrderRules(getConfig().orders || {});
  const now = Date.now();
  let cancelled = 0;
  for (const o of orderStore.getOrders()) {
    const created = new Date(o.created_at).getTime();
    if (o.status === 'PENDING_PAYMENT' && now - created > rules.paymentTimeoutMinutes * 60000) {
      const reason = `Tự huỷ: quá ${rules.paymentTimeoutMinutes} phút chưa thanh toán`;
      orderStore.updateOrder(o.id, { status: 'CANCELLED', cancelled_at: new Date().toISOString(), cancel_reason: reason });
      cancelled++;
      if (io) {
        io.to(o.id).emit('ORDER_EXPIRED', { orderId: o.id, message: `Đơn ${o.id} đã tự huỷ vì quá ${rules.paymentTimeoutMinutes} phút chưa thanh toán. Vui lòng đặt lại nếu bạn vẫn muốn mua.` });
        emitAdmin(io, 'ADMIN_ORDER_CHANGED', { orderId: o.id, status: 'CANCELLED' });
      }
    } else if (o.status === 'PAYMENT_REPORTED' && !o.needs_attention) {
      const reported = new Date(o.payment_reported_at || o.created_at).getTime();
      if (now - reported > rules.reportedAlertHours * 3600000) {
        orderStore.updateOrder(o.id, { needs_attention: true });
        if (io) emitAdmin(io, 'ADMIN_ORDER_CHANGED', { orderId: o.id, status: o.status, needs_attention: true });
      }
    }
  }
  if (cancelled) console.log(`[OrderExpiry] Đã tự huỷ ${cancelled} đơn quá hạn thanh toán.`);
  return cancelled;
}

function startOrderExpiry(io, getConfig) {
  clearInterval(timer);
  sweep(io, getConfig);
  timer = setInterval(() => {
    try {
      sweep(io, getConfig);
    } catch (e) {
      console.error('[OrderExpiry] Lỗi:', e.message);
    }
  }, 60 * 1000);
}

module.exports = { DEFAULTS, normalizeOrderRules, startOrderExpiry, sweep };
