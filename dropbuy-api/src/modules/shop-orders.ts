// Đơn hàng phía shop: duyệt/đóng gói/vận đơn/giao, in đơn, báo cáo doanh thu, chặn buyer, khiếu nại.
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { prisma, Decimal } from '../lib/db.js';
import { E } from '../lib/http.js';
import { route, body, query, input, params, arr, type Req } from '../lib/router.js';
import { requireShop, requireUser, requireSA, requireTenantOwner } from '../lib/auth.js';
import { paging, paged } from '../lib/paging.js';
import { uuid, code } from '../lib/ids.js';
import { transition, orderRows, lineRows, orderWhereWithItems } from '../lib/orders.js';
import { balancesOf } from '../lib/balance.js';

async function shopOrder(req: Req, order_id: unknown) {
  const { shop, user } = await requireShop(req);
  const o = await prisma.order.findFirst({ where: { OR: [{ id: Number(order_id) || -1 }, { unique_id: String(order_id) }, { code: String(order_id) }] } });
  if (!o || o.shop_id !== shop.id) throw E.notFound('Đơn hàng');
  return { shop, user, o };
}

const rng = (b: Record<string, any>) => {
  if (!b.from_date || !b.to_date) throw E.invalid('Thiếu from_date / to_date (yyyy-MM-dd)');
  const lt = new Date(`${String(b.to_date).slice(0, 10)}T00:00:00Z`);
  lt.setUTCDate(lt.getUTCDate() + 1);
  return { gte: new Date(`${String(b.from_date).slice(0, 10)}T00:00:00Z`), lt };
};
const DONEISH = ['F', 'D'];

export default function shopOrders(app: FastifyInstance) {
  const sold = async (req: Req, extra: Prisma.OrderWhereInput = {}, mode: 'orders' | 'lines' = 'orders') => {
    const { shop } = await requireShop(req);
    const b = input(req);
    const p = paging(b);
    const where = await orderWhereWithItems({ shop_id: shop.id, order_status: { notIn: ['U', 'P'] }, ...extra }, b);
    if (b.buyer_id) where.buyer_user_id = Number(b.buyer_id);
    const [total, rows] = await Promise.all([prisma.order.count({ where }), prisma.order.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    if (mode === 'lines') return paged(p, total, await lineRows(rows));
    return paged(p, total, await orderRows(rows));
  };
  route(app, 'POST', '/bff/shop-orders/list-sold', (req) => sold(req));
  route(app, 'POST', '/bff/shop-orders/:fx_hash/list-sold-v3', (req) => sold(req));
  route(app, 'POST', '/bff/shop-orders/:fx_hash/r-100000', (req) => sold(req, { commodity_amount: { lt: 100000 } }));
  route(app, 'POST', '/bff/shop-orders/:fx_hash/aff-list-sold', (req) => sold(req, { order_type: 'A' }));
  route(app, 'POST', '/bff/shop-orders/:fx_hash/shop-nhan-don-bom', (req) => sold(req, { order_status: 'B' }, 'lines'));

  route(app, 'GET', '/bff/shop-orders/count-by-status', async (req) => {
    const { shop } = await requireShop(req);
    const g = await prisma.order.groupBy({ by: ['order_status'], where: { shop_id: shop.id, order_status: { notIn: ['U', 'P'] } }, _count: true });
    return g.map((r) => ({ order_status: r.order_status, counting: r._count }));
  });
  route(app, 'GET', '/bff/shop-orders/:fx_hash/count-by-status-for-aff', async (req) => {
    const { shop } = await requireShop(req);
    const g = await prisma.order.groupBy({ by: ['order_status'], where: { shop_id: shop.id, order_type: 'A' }, _count: true });
    return g.map((r) => ({ order_status: r.order_status, counting: r._count }));
  });

  // ── Luồng xử lý: W chờ đóng → G đã đóng → Q chờ lấy (có vận đơn) → S đang giao → F đã giao ──
  const step = (to: 'G' | 'Q' | 'S' | 'F' | 'C', check?: (o: { order_status: string }) => void) => async (req: Req) => {
    const b = body(req);
    const out = [];
    for (const id of b.order_id != null ? [b.order_id] : arr(b.order_ids)) {
      const { o, user } = await shopOrder(req, id);
      check?.(o);
      const extra: Prisma.OrderUpdateInput = {};
      if (to === 'Q' && !o.shipping_ref_code) extra.shipping_ref_code = b.shipping_ref_code ?? `${o.shipping_method === 'S' ? 'SPX' : 'VTP'}${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 90 + 10)}`;
      if (to === 'C') extra.cancel_reason = b.reason ?? 'Shop huỷ';
      const x = await transition(o.id, to, { kind: 'S', id: user.id }, { extra, notes: b.notes });
      out.push({ order_id: x.id, order_code: x.code, order_status: x.order_status, shipping_ref_code: x.shipping_ref_code });
    }
    return out.length === 1 ? out[0] : out;
  };

  // "cho-dong-goi": shop xác nhận nhận đơn kèm ghi chú (giữ ở W)
  route(app, 'POST', '/bff/shop-orders/cho-dong-goi', async (req) => {
    const b = body(req);
    const { o } = await shopOrder(req, b.order_id);
    if (o.order_status !== 'W') throw E.business('Đơn không ở trạng thái chờ đóng hàng');
    await prisma.order.update({ where: { id: o.id }, data: { shop_notes: b.shop_notes ?? o.shop_notes } });
    return { order_id: o.id, order_status: o.order_status };
  });
  route(app, 'POST', '/bff/shop-orders/da-dong-goi', step('G'));
  route(app, 'POST', '/bff/shop-orders/tao-van-don', async (req) => {
    const b = body(req);
    const { o } = await shopOrder(req, b.order_id);
    // tạo vận đơn được phép ngay từ W: tự đóng gói trước
    if (o.order_status === 'W') await transition(o.id, 'G', { kind: 'S' });
    return step('Q')(req);
  });
  route(app, 'POST', '/bff/shop-orders/mark-shipping', step('S'));
  route(app, 'POST', '/bff/shop-orders/mark-finish', step('F'));
  route(app, 'POST', '/bff/shop-orders/cancel-by-shop', step('C', (o) => {
    if (!['W', 'G'].includes(o.order_status)) throw E.business('Shop chỉ huỷ được đơn chưa bàn giao vận chuyển');
  }));

  route(app, 'PUT', '/bff/shop-orders/shop-notes', async (req) => {
    const b = body(req);
    const { o } = await shopOrder(req, b.order_id);
    await prisma.order.update({ where: { id: o.id }, data: { shop_notes: String(b.shop_notes ?? '') } });
    return null;
  });

  route(app, 'GET', '/bff/shop-orders/get-detail-for-print/:order_unique_id', async (req) => {
    const { o } = await shopOrder(req, params(req).order_unique_id);
    await prisma.order.update({ where: { id: o.id }, data: { count_print: { increment: 1 } } });
    const [row] = await orderRows([{ ...o, count_print: o.count_print + 1 }]);
    const vs = await prisma.variation.findMany({ where: { id: { in: row.items.map((i) => i.variation_id) } } });
    const ps = await prisma.product.findMany({ where: { id: { in: row.items.map((i) => i.product_id) } } });
    const stock = await prisma.stock.findMany({ where: { variation_id: { in: vs.map((v) => v.id) } } });
    const items = row.items.map((i) => {
      const p = ps.find((x) => x.id === i.product_id);
      return { ...i, slug: p?.slug, warranty_type: p?.warranty_type, warranty_duration: p?.warranty_duration, hang_xin: p?.hang_xin, vat_include: p?.vat_include, current_stock: stock.filter((s) => s.variation_id === i.variation_id).reduce((a, s) => a + s.current_stock, 0), payment_balance_type: o.payment_balance_type };
    });
    return { order: row, ...paged({ page_num: 1, page_size: items.length }, items.length, items) };
  });

  // ── Tiền dự kiến của shop: đơn đang xử lý chưa tất toán ──
  const pendingWhere = (shop_id: number): Prisma.OrderWhereInput => ({ shop_id, settled: false, order_status: { in: ['W', 'G', 'Q', 'S', 'F', 'K', 'N'] } });
  route(app, 'GET', '/bff/shop-orders/tien-du-kien-shop', async (req) => {
    const { shop } = await requireShop(req);
    const a = await prisma.order.aggregate({ where: pendingWhere(shop.id), _count: true, _sum: { commodity_amount: true, shop_voucher_amount: true } });
    return { name: shop.display_name, total_order: a._count, total_real_revenue: new Decimal(a._sum.commodity_amount ?? 0).minus(a._sum.shop_voucher_amount ?? 0) };
  });
  route(app, 'GET', '/bff/shop-orders/tien-du-kien-shop-detail', async (req) => {
    const { shop } = await requireShop(req);
    const p = paging(query(req));
    const where = pendingWhere(shop.id);
    const [total, rows] = await Promise.all([prisma.order.count({ where }), prisma.order.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, rows.map((o) => ({ order_id: o.id, order_unique_id: o.unique_id, order_code: o.code, total_revenue: o.commodity_amount, total_debt_shipping_fee: 0, total_real_revenue: o.commodity_amount.minus(o.shop_voucher_amount), customer_name: o.receiver_fullname, created_at: o.created_at })));
  });

  // ── Báo cáo ──
  route(app, 'POST', '/bff/shop-orders/:fx_hash/revenue-by-time', async (req) => {
    const { shop } = await requireShop(req);
    const b = body(req);
    const rows = await prisma.order.findMany({ where: { shop_id: shop.id, order_status: { in: DONEISH }, created_at: rng(b) } });
    const its = await prisma.orderItem.findMany({ where: { order_id: { in: rows.map((r) => r.id) } } });
    const key = (d: Date) => (b.group_by === 'M' ? d.toISOString().slice(0, 7) : d.toISOString().slice(0, 10));
    const m = new Map<string, { date: string; order_count: number; revenue: Decimal; quantity: number; cod_total: Decimal; shipping_total: Decimal }>();
    for (const o of rows) {
      const k = key(o.created_at);
      const r = m.get(k) ?? { date: k, order_count: 0, revenue: new Decimal(0), quantity: 0, cod_total: new Decimal(0), shipping_total: new Decimal(0) };
      r.order_count++;
      r.revenue = r.revenue.plus(o.commodity_amount.minus(o.shop_voucher_amount));
      r.cod_total = r.cod_total.plus(o.cod_amount);
      r.shipping_total = r.shipping_total.plus(o.shipping_amount);
      r.quantity += its.filter((i) => i.order_id === o.id).reduce((a, i) => a + i.quantity, 0);
      m.set(k, r);
    }
    return [...m.values()].sort((a, z) => a.date.localeCompare(z.date));
  });

  const bySku = async (shop_id: number, b: Record<string, any>) => {
    const orders = await prisma.order.findMany({ where: { shop_id, order_status: { in: DONEISH }, created_at: rng(b) }, select: { id: true } });
    const its = await prisma.orderItem.findMany({ where: { order_id: { in: orders.map((o) => o.id) } } });
    const m = new Map<string, { sku: string; product_id: number; variation_id: string; product_name: string; variation_name: string; res_thumbnail_url: string; storage_id: number; quantity: number; revenue: Decimal; order_ids: Set<number> }>();
    for (const i of its) {
      const r = m.get(i.sku) ?? { sku: i.sku, product_id: i.product_id, variation_id: i.variation_id, product_name: i.product_name, variation_name: i.variation_name, res_thumbnail_url: i.res_thumbnail_url, storage_id: 6, quantity: 0, revenue: new Decimal(0), order_ids: new Set<number>() };
      r.quantity += i.quantity;
      r.revenue = r.revenue.plus(i.price.mul(i.quantity));
      r.order_ids.add(i.order_id);
      m.set(i.sku, r);
    }
    return [...m.values()].map(({ order_ids, ...r }) => ({ ...r, order_count: order_ids.size, avg_price: r.quantity ? r.revenue.div(r.quantity).toDecimalPlaces(0) : 0 })).sort((a, z) => z.quantity - a.quantity);
  };
  route(app, 'POST', '/bff/shop-orders/:fx_hash/revenue-by-time/detail', async (req) => {
    const { shop } = await requireShop(req);
    const b = body(req);
    const p = paging(b);
    const list = await bySku(shop.id, b);
    return paged(p, list.length, list.slice(p.skip, p.skip + p.take));
  });

  // Các đơn đã bán của 1 SKU
  route(app, 'POST', '/bff/shop-orders/:fx_hash/product-sales', async (req) => {
    const { shop } = await requireShop(req);
    const b = body(req);
    const p = paging(b);
    const orders = await prisma.order.findMany({ where: { shop_id: shop.id, created_at: rng(b), ...(b.order_status_type === 'DONE' ? { order_status: { in: DONEISH } } : { order_status: { notIn: ['U', 'P'] } }) } });
    const its = await prisma.orderItem.findMany({ where: { order_id: { in: orders.map((o) => o.id) }, ...(b.sku ? { sku: String(b.sku) } : {}) }, orderBy: { id: 'desc' } });
    const buyers = await prisma.user.findMany({ where: { id: { in: orders.map((o) => o.buyer_user_id).filter((x): x is number => !!x) } } });
    const rows = its.map((i) => {
      const o = orders.find((x) => x.id === i.order_id)!;
      const u = buyers.find((x) => x.id === o.buyer_user_id);
      return { order_id: o.id, order_code: o.code, order_unique_id: o.unique_id, order_status: o.order_status, created_at: o.created_at, sku: i.sku, product_id: i.product_id, product_name: i.product_name, variation_name: i.variation_name, res_thumbnail_url: i.res_thumbnail_url, storage_id: 6, quantity: i.quantity, price: i.price, commodity_amount: i.price.mul(i.quantity), buyer_user_id: o.buyer_user_id, buyer_fullname: u?.fullname ?? o.receiver_fullname, buyer_phone: u?.phone ?? o.receiver_phone, shop_id: shop.id, shop_name: shop.display_name };
    });
    return paged(p, rows.length, rows.slice(p.skip, p.skip + p.take));
  });

  // Doanh thu theo khách hàng (buyer) và cấp trên F1
  route(app, 'POST', '/bff/shop-orders/:fx_hash/product-sales/detail', async (req) => {
    const { shop } = await requireShop(req);
    const b = body(req);
    const p = paging(b);
    const orders = await prisma.order.findMany({ where: { shop_id: shop.id, order_status: { in: DONEISH }, created_at: rng(b), buyer_user_id: { not: null } }, orderBy: { created_at: 'asc' } });
    const its = await prisma.orderItem.findMany({ where: { order_id: { in: orders.map((o) => o.id) } } });
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(orders.map((o) => o.buyer_user_id!))] } } });
    const parents = await prisma.user.findMany({ where: { id: { in: users.map((u) => u.parent_user_id).filter((x): x is number => !!x) } } });
    const m = new Map<number, any>();
    for (const o of orders) {
      const u = users.find((x) => x.id === o.buyer_user_id)!;
      const f1 = parents.find((x) => x.id === u.parent_user_id);
      const r = m.get(u.id) ?? { buyer_user_id: u.id, buyer_fullname: u.fullname, buyer_phone: u.phone, buyer_username: u.username, buyer_user_level: u.user_level, f1_user_id: f1?.id ?? null, f1_fullname: f1?.fullname ?? null, f1_phone: f1?.phone ?? null, f1_username: f1?.username ?? null, order_count: 0, revenue: new Decimal(0), quantity: 0, cod_total: new Decimal(0), first_order_at: o.created_at, last_order_at: o.created_at };
      r.order_count++;
      r.revenue = r.revenue.plus(o.commodity_amount);
      r.cod_total = r.cod_total.plus(o.cod_amount);
      r.quantity += its.filter((i) => i.order_id === o.id).reduce((a, i) => a + i.quantity, 0);
      r.last_order_at = o.created_at;
      m.set(u.id, r);
    }
    const list = [...m.values()].sort((a, z) => Number(z.revenue) - Number(a.revenue));
    return paged(p, list.length, list.slice(p.skip, p.skip + p.take));
  });

  // Điểm uy tín của buyer theo đơn (shop cân nhắc trước khi giao COD)
  route(app, 'POST', '/bff/shop-orders/:fx_hash/list-reputation-by-order', async (req) => {
    const { shop } = await requireShop(req);
    const b = body(req);
    const orders = await prisma.order.findMany({ where: { shop_id: shop.id, OR: [{ id: { in: arr<number>(b.order_ids).map(Number) } }, { code: { in: arr<string>(b.order_codes).map(String) } }] } });
    return Promise.all(orders.map(async (o) => {
      const bal = o.buyer_user_id ? (await balancesOf(o.buyer_user_id)).find((x) => x.balance_type === 'U') : null;
      return { order_id: o.id, order_code: o.code, buyer_reputation_balance_id: bal?.balance_unique_id ?? null, buyer_reputation_balance_current: bal?.balance_current ?? 0 };
    }));
  });

  // ── Shop chặn buyer ──
  const blockOut = async (rows: { unique_id: string; shop_id: number; buyer_user_id: number; block_type: string; created_at: Date }[]) => {
    const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.buyer_user_id) } } });
    const shops = await prisma.shop.findMany({ where: { id: { in: rows.map((r) => r.shop_id) } } });
    return rows.map((r) => {
      const u = users.find((x) => x.id === r.buyer_user_id);
      const s = shops.find((x) => x.id === r.shop_id);
      return { ...r, shop_user_id: s?.user_id, updated_at: r.created_at, shop_name: s?.display_name, shop_pic_name: s?.fullname, buyer_username: u?.username, buyer_fullname: u?.fullname, buyer_phone: u?.phone };
    });
  };
  route(app, 'GET', '/bff/shop/block-buyer/:fx_hash/list', async (req) => {
    const { shop } = await requireShop(req);
    const q = query(req);
    const p = paging(q);
    const where = { shop_id: shop.id, ...(q.user_id ? { buyer_user_id: Number(q.user_id) } : {}) };
    const [total, rows] = await Promise.all([prisma.shopBlockBuyer.count({ where }), prisma.shopBlockBuyer.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await blockOut(rows));
  });
  route(app, 'POST', '/bff/shop/block-buyer/:fx_hash/block-by-order', async (req) => {
    const { shop } = await requireShop(req);
    const b = body(req);
    let buyer_user_id = b.buyer_user_id != null ? Number(b.buyer_user_id) : null;
    let order_id: number | null = null;
    if (b.order_id != null) {
      const o = await prisma.order.findUnique({ where: { id: Number(b.order_id) } });
      if (!o || o.shop_id !== shop.id) throw E.notFound('Đơn hàng');
      buyer_user_id = o.buyer_user_id;
      order_id = o.id;
    }
    if (!buyer_user_id) throw E.invalid('Không xác định được buyer (đơn khách vãng lai không chặn được)');
    const r = await prisma.shopBlockBuyer.upsert({ where: { shop_id_buyer_user_id: { shop_id: shop.id, buyer_user_id } }, create: { unique_id: uuid(), shop_id: shop.id, buyer_user_id, order_id, block_type: order_id ? 'O' : 'M' }, update: {} });
    return (await blockOut([r]))[0];
  });
  route(app, 'POST', '/bff/shop/block-buyer/:fx_hash/unblock', async (req) => {
    const { shop } = await requireShop(req);
    const b = body(req);
    const where = b.buyer_user_id != null ? { shop_id: shop.id, buyer_user_id: Number(b.buyer_user_id) } : { shop_id: shop.id, order_id: Number(b.order_id) };
    await prisma.shopBlockBuyer.deleteMany({ where });
    return null;
  });

  // ── Khiếu nại ──
  const complainOut = (c: Awaited<ReturnType<typeof prisma.complainRequest.findFirstOrThrow>>) => ({
    unique_id: c.unique_id, order_id: c.order_id, complain_user_id: c.buyer_user_id, shop_id: c.shop_id, status: c.status, complain_type: c.complain_type,
    notes: c.notes, media: JSON.parse(c.media), refund_amount: c.refund_amount, judgement_status: ['U', 'H'].includes(c.status) ? c.status : null, judge_notes: c.judge_notes, created_at: c.created_at, updated_at: c.updated_at,
  });

  route(app, 'POST', '/bff/complain-requests', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    const o = await prisma.order.findUnique({ where: { id: Number(b.order_id) } });
    if (!o || o.buyer_user_id !== u.id) throw E.notFound('Đơn hàng');
    if (o.order_status !== 'F') throw E.business('Chỉ khiếu nại đơn đã giao (chưa xác nhận hoàn thành)');
    if (await prisma.complainRequest.findFirst({ where: { order_id: o.id, status: { in: ['P', 'J'] } } })) throw E.conflict('Đơn đang có khiếu nại');
    const refund = b.refund_amount != null ? Decimal.min(new Decimal(b.refund_amount), o.total_amount) : o.total_amount;
    const c = await prisma.complainRequest.create({ data: { unique_id: uuid(), order_id: o.id, buyer_user_id: u.id, shop_id: o.shop_id, tenant_id: o.tenant_id, complain_type: String(b.complain_type ?? 'O'), notes: b.notes ?? null, media: JSON.stringify(arr(b.media)), refund_amount: refund } });
    await transition(o.id, 'K', { kind: 'U', id: u.id }, { notes: `Khiếu nại ${c.unique_id}` });
    return complainOut(c);
  });

  route(app, 'POST', '/bff/complain-requests/cancel', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    const c = await prisma.complainRequest.findFirst({ where: { order_id: Number(b.order_id), buyer_user_id: u.id, status: { in: ['P', 'J'] } } });
    if (!c) throw E.notFound('Khiếu nại đang mở');
    await prisma.complainRequest.update({ where: { id: c.id }, data: { status: 'C' } });
    await transition(c.order_id, 'D', { kind: 'U', id: u.id }, { force: true, notes: 'Buyer rút khiếu nại → hoàn thành' });
    return complainOut({ ...c, status: 'C' });
  });

  /** Kết luận khiếu nại: U = buyer thắng (hoàn hàng/hoàn tiền), H = shop thắng (đơn hoàn thành). */
  async function judge(unique_id: string, winner: 'U' | 'H', actor: { kind: 'S' | 'A' | 'T'; id: number }, notes?: string, refund?: unknown) {
    const c = await prisma.complainRequest.findUnique({ where: { unique_id } });
    if (!c) throw E.notFound('Khiếu nại');
    if (!['P', 'J'].includes(c.status)) throw E.business('Khiếu nại đã được xử lý');
    const refund_amount = refund != null ? new Decimal(String(refund)) : c.refund_amount;
    if (winner === 'U') await transition(c.order_id, 'X', actor, { refund_amount, notes: notes ?? 'Khiếu nại: buyer thắng' });
    else await transition(c.order_id, 'D', actor, { notes: notes ?? 'Khiếu nại: shop thắng' });
    return complainOut(await prisma.complainRequest.update({ where: { id: c.id }, data: { status: winner, judge_notes: notes ?? null, judged_by: actor.id, refund_amount } }));
  }

  route(app, 'POST', '/bff/complain-requests/:fx_hash/shop-let-user-win', async (req) => {
    const { shop, user } = await requireShop(req);
    const b = body(req);
    const c = await prisma.complainRequest.findUnique({ where: { unique_id: String(b.unique_id) } });
    if (!c || c.shop_id !== shop.id) throw E.notFound('Khiếu nại');
    return judge(c.unique_id, 'U', { kind: 'S', id: user.id }, b.notes, b.refund_amount);
  });

  const complainList = async (req: Req, where: Prisma.ComplainRequestWhereInput) => {
    const b = input(req);
    const p = paging(b);
    const w = { ...where, ...(b.status ? { status: String(b.status) } : {}), ...(b.order_id ? { order_id: Number(b.order_id) } : {}) };
    const [total, rows] = await Promise.all([prisma.complainRequest.count({ where: w }), prisma.complainRequest.findMany({ where: w, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, rows.map(complainOut));
  };

  route(app, 'POST', '/bff/sa/complain-requests/details', async (req) => {
    await requireSA(req);
    const b = body(req);
    if (b.unique_id) {
      const c = await prisma.complainRequest.findUnique({ where: { unique_id: String(b.unique_id) } });
      if (!c) throw E.notFound('Khiếu nại');
      const [order] = await orderRows([await prisma.order.findUniqueOrThrow({ where: { id: c.order_id } })]);
      return { ...complainOut(c), order, events: await prisma.orderEvent.findMany({ where: { order_id: c.order_id }, orderBy: { id: 'asc' } }) };
    }
    return complainList(req, {});
  });
  route(app, 'POST', '/bff/sa/complain-requests/judge-user-win', async (req) => {
    const u = await requireSA(req);
    const b = body(req);
    return judge(String(b.unique_id), 'U', { kind: 'A', id: u.id }, b.notes, b.refund_amount);
  });
  route(app, 'POST', '/bff/sa/complain-requests/judge-shop-win', async (req) => {
    const u = await requireSA(req);
    const b = body(req);
    return judge(String(b.unique_id), 'H', { kind: 'A', id: u.id }, b.notes);
  });

  route(app, 'POST', '/bff/tenant-owners/complain-requests/:fx_hash/details', async (req) => {
    const { tenant } = await requireTenantOwner(req);
    return complainList(req, { tenant_id: tenant.id });
  });
  const ownerJudge = (w: 'U' | 'H') => async (req: Req) => {
    const { user, tenant } = await requireTenantOwner(req);
    const b = body(req);
    const c = await prisma.complainRequest.findUnique({ where: { unique_id: String(b.unique_id) } });
    if (!c || c.tenant_id !== tenant.id) throw E.notFound('Khiếu nại');
    return judge(c.unique_id, w, { kind: 'T', id: user.id }, b.notes, b.refund_amount);
  };
  route(app, 'POST', '/bff/tenant-owners/complain-requests/:fx_hash/judge-user-win', ownerJudge('U'));
  route(app, 'POST', '/bff/tenant-owners/complain-requests/:fx_hash/judge-shop-win', ownerJudge('H'));

  void code;
}
