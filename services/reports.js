const { vnDate } = require('./backup');

/**
 * Báo cáo doanh thu & lãi gộp cho admin.
 * Chỉ tính đơn đã nhận tiền (PAID / PROCESSING / COMPLETED).
 * Lãi gộp = tiền hàng khách trả − giá vốn DropBuy lúc đặt (phí ship thu của khách tính riêng,
 * vì phí ship thật do kho DropBuy báo khi đặt đơn).
 */
const PAID_STATUSES = new Set(['PAID', 'PROCESSING', 'COMPLETED']);

function orderMoney(o) {
  const items = o.items || [];
  const goods = Number.isFinite(o.subtotal) ? o.subtotal : items.reduce((s, i) => s + (i.price || 0) * (i.quantity || 0), 0);
  const cost = items.reduce((s, i) => s + (i.dropbuy_cost || 0) * (i.quantity || 0), 0);
  const costKnown = items.every(i => Number.isFinite(i.dropbuy_cost) && i.dropbuy_cost > 0);
  const costWholesale = items.every(i => i.cost_is_wholesale);
  return { goods, shipping: o.shipping_fee || 0, total: o.total_amount || goods, cost, costKnown, costWholesale };
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
  bucket.profit += m.goods - m.cost;
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
  const pipeline = { PENDING_PAYMENT: 0, PAYMENT_REPORTED: 0, PAID: 0, PROCESSING: 0, COMPLETED: 0, CANCELLED: 0 };

  for (const o of orders) {
    if (o.status in pipeline) pipeline[o.status] += 1;
    if (!PAID_STATUSES.has(o.status)) continue;
    const m = orderMoney(o);
    // Ngày bán = lúc nhận tiền (nếu có), không phải lúc tạo đơn
    const day = vnDate(new Date(o.paid_at || o.created_at));
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

module.exports = { salesReport, orderMoney, PAID_STATUSES };
