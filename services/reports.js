const { vnDate } = require('./backup');

/**
 * Báo cáo doanh thu & lãi gộp cho admin.
 * Chỉ tính đơn đã có tiền: chuyển khoản đã nhận (PAID / PROCESSING / COMPLETED), COD đã giao xong (COMPLETED).
 * Lãi gộp: nếu đơn đã đặt trên DropBuy → khách trả − số DropBuy trừ quỹ (hàng + ship thật);
 * chưa đặt → tiền hàng − giá vốn lúc đặt (ship tính riêng).
 */
const PAID_STATUSES = new Set(['PAID', 'PROCESSING', 'COMPLETED']);

function isPaid(o) {
  return o.payment_method === 'COD' ? o.status === 'COMPLETED' : PAID_STATUSES.has(o.status);
}

function orderMoney(o) {
  const items = o.items || [];
  const goods = Number.isFinite(o.subtotal) ? o.subtotal : items.reduce((s, i) => s + (i.price || 0) * (i.quantity || 0), 0);
  const cost = items.reduce((s, i) => s + (i.dropbuy_cost || 0) * (i.quantity || 0), 0);
  const costKnown = items.every(i => Number.isFinite(i.dropbuy_cost) && i.dropbuy_cost > 0);
  const costWholesale = items.every(i => i.cost_is_wholesale);
  const total = o.total_amount || goods;
  const spend = o.dropbuy_sync?.spend;
  if (Number.isFinite(spend) && spend > 0) {
    return { goods, shipping: o.shipping_fee || 0, total, cost: spend, costKnown: true, costWholesale: true, profit: total - spend };
  }
  return { goods, shipping: o.shipping_fee || 0, total, cost, costKnown, costWholesale, profit: goods - cost };
}

function emptyBucket() {
  return { orders: 0, revenue: 0, goods: 0, shipping: 0, cost: 0, profit: 0, items: 0, cost_unknown_orders: 0, cost_public_orders: 0 };
}

function add(bucket, m, o) {
  bucket.orders += 1;
  bucket.revenue += m.total;
  bucket.goods += m.goods;
  bucket.shipping += m.shipping;
  bucket.cost += m.cost;
  bucket.profit += m.profit;
  bucket.items += (o.items || []).reduce((s, i) => s + (i.quantity || 0), 0);
  if (!m.costKnown) bucket.cost_unknown_orders += 1;
  else if (!m.costWholesale) bucket.cost_public_orders += 1;
}

function salesReport(orders, { days = 30, now = new Date() } = {}) {
  const today = vnDate(now);
  const dayKeys = [];
  for (let i = days - 1; i >= 0; i--) dayKeys.push(vnDate(new Date(now.getTime() - i * 86400000)));
  const byDay = Object.fromEntries(dayKeys.map(d => [d, emptyBucket()]));
  const totals = { today: emptyBucket(), last7: emptyBucket(), last30: emptyBucket(), all: emptyBucket() };
  const last7 = new Set(dayKeys.slice(-7));
  const products = new Map();
  const pipeline = { PENDING_PAYMENT: 0, PAYMENT_REPORTED: 0, CONFIRMED: 0, PAID: 0, PROCESSING: 0, COMPLETED: 0, CANCELLED: 0 };

  for (const o of orders) {
    if (o.status in pipeline) pipeline[o.status] += 1;
    if (!isPaid(o)) continue;
    const m = orderMoney(o);
    // Ngày bán = lúc nhận tiền (nếu có), không phải lúc tạo đơn
    const day = vnDate(new Date(o.paid_at || o.completed_at || o.created_at));
    add(totals.all, m, o);
    if (byDay[day]) { add(byDay[day], m, o); add(totals.last30, m, o); }
    if (last7.has(day)) add(totals.last7, m, o);
    if (day === today) add(totals.today, m, o);
    if (byDay[day]) {
      for (const i of o.items || []) {
        const k = `${i.id}:${i.variation_id || ''}`;
        const p = products.get(k) || { id: i.id, name: i.name, variant_name: i.variant_name || null, quantity: 0, revenue: 0, profit: 0 };
        p.quantity += i.quantity || 0;
        p.revenue += (i.price || 0) * (i.quantity || 0);
        p.profit += ((i.price || 0) - (i.dropbuy_cost || 0)) * (i.quantity || 0);
        products.set(k, p);
      }
    }
  }

  return {
    today,
    totals,
    pipeline,
    daily: dayKeys.map(d => ({ day: d, ...byDay[d] })),
    top_products: [...products.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10)
  };
}

module.exports = { salesReport, orderMoney, isPaid, PAID_STATUSES };
