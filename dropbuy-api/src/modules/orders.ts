// Đơn hàng phía người mua: đặt (thường / khách / affiliate / kho ảo), thanh toán, huỷ, nhận hàng, tra cứu, báo cáo CTV.
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { prisma, Decimal } from '../lib/db.js';
import { E } from '../lib/http.js';
import { route, body, query, input, arr, type Req } from '../lib/router.js';
import { requireUser, tenantOf, clientIdOf, requireMfa } from '../lib/auth.js';
import { paging, paged } from '../lib/paging.js';
import { ownerKey } from '../lib/cart.js';
import { post } from '../lib/balance.js';
import { createOrders, receiverOf, qrOf, transition, orderRows, lineRows, receiverBook, orderWhereWithItems, type OrderOption } from '../lib/orders.js';

async function myOrder(req: Req, order_id: unknown) {
  const u = await requireUser(req);
  const o = await prisma.order.findFirst({ where: { OR: [{ id: Number(order_id) || -1 }, { unique_id: String(order_id) }, { code: String(order_id) }] } });
  if (!o || o.buyer_user_id !== u.id) throw E.notFound('Đơn hàng');
  return { u, o };
}

const submitOut = (os: Awaited<ReturnType<typeof createOrders>>) => os.map((o) => ({ unique_id: o.unique_id, id: o.id, code: o.code, status: o.order_status, order_status: o.order_status, payment_method: o.payment_method, total_amount: o.total_amount, ...qrOf(o) }));

async function countBy(where: Prisma.OrderWhereInput) {
  const g = await prisma.order.groupBy({ by: ['order_status'], where, _count: true });
  return g.map((r) => ({ order_status: r.order_status, counting: r._count }));
}

async function list(req: Req, base: Prisma.OrderWhereInput, mode: 'orders' | 'lines' = 'orders') {
  const b = input(req);
  const p = paging(b);
  const where = await orderWhereWithItems(base, b);
  const [total, rows] = await Promise.all([prisma.order.count({ where }), prisma.order.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
  if (mode === 'lines') return paged(p, total, await lineRows(rows));
  const out = await orderRows(rows);
  return { ...paged(p, total, out), orders: out };
}

export default function orders(app: FastifyInstance) {
  // ── Đặt hàng ──
  const options = (b: Record<string, any>) => arr<OrderOption>(b.order_options ?? b.order_option);

  route(app, 'POST', '/bff/orders/:fx_hash/normal-submit', async (req) => {
    const u = await requireUser(req);
    const tenant = await tenantOf(req);
    const b = body(req);
    if (b.payment_method === 'B' || !b.payment_method) requireMfa(u, b.totp_code);
    return submitOut(await createOrders({ owner_key: ownerKey.user(u.id), tenant, buyer: u, mode: 'N', receiver: receiverOf(b), options: options(b), payment_method: b.payment_method ?? 'B', is_dropship: b.is_dropship === 'T' || b.is_dropship === true, buyer_vat_info: b.buyer_vat_info }));
  });

  // Xuất hàng từ kho ảo của chính buyer (chỉ trả phí ship)
  route(app, 'POST', '/bff/orders/:fx_hash/pvv-submit', async (req) => {
    const u = await requireUser(req);
    const tenant = await tenantOf(req);
    const b = body(req);
    requireMfa(u, b.totp_code);
    return submitOut(await createOrders({ owner_key: ownerKey.user(u.id), tenant, buyer: u, mode: 'V', receiver: receiverOf(b), options: options(b), payment_method: 'B', is_dropship: b.is_dropship === 'T' || b.is_dropship === true }));
  });

  route(app, 'POST', '/bff/orders/guest-submit', async (req) => {
    const tenant = await tenantOf(req);
    if (!tenant.guest_submit_enabled) throw E.forbidden('Website không cho phép khách vãng lai đặt hàng');
    const b = body(req);
    const client_id = clientIdOf(req, b);
    const os = await createOrders({ owner_key: ownerKey.guest(client_id), tenant, buyer: null, mode: 'G', receiver: receiverOf(b), options: options(b), payment_method: b.payment_method ?? 'C', guest_client_id: client_id });
    return submitOut(os);
  });

  route(app, 'POST', '/bff/orders/:fx_hash/aff-submit', async (req) => {
    const tenant = await tenantOf(req);
    const b = body(req);
    const aff = await prisma.user.findUnique({ where: { aff_code: String(b.aff_id ?? '') } });
    if (!aff) throw E.notFound('Mã affiliate');
    const client_id = clientIdOf(req, b);
    const os = await createOrders({ owner_key: ownerKey.aff(String(b.aff_id), client_id), tenant, buyer: null, mode: 'A', receiver: receiverOf(b), options: options(b), payment_method: b.payment_method ?? 'C', aff_user_id: aff.id, guest_client_id: client_id });
    const rows = await orderRows(os);
    // aff_secure_code: khách dùng để tra cứu đơn mà không cần đăng nhập
    return rows.map((r) => ({ ...r, aff_secure_code: Buffer.from(`${r.unique_id}:${client_id}`).toString('base64url') }));
  });

  // ── Thanh toán đơn chờ thanh toán (P) bằng ví ──
  route(app, 'POST', '/bff/orders/thanh-toan', async (req) => {
    const b = body(req);
    const { u, o } = await myOrder(req, b.order_id);
    requireMfa(u, b.totp_code);
    if (o.order_status !== 'P') throw E.business('Đơn không ở trạng thái chờ thanh toán');
    await prisma.$transaction((tx) => post(tx, u.id, 'A', o.total_amount.neg(), { business_code: 'ORDER_PAY', ref_code: o.code }));
    await transition(o.id, 'O', { kind: 'U', id: u.id }, { extra: { payment_method: 'B' } });
    return transition(o.id, 'W', { kind: 'X' }, { notes: 'Đã thanh toán, chuyển shop đóng hàng' }).then((x) => ({ order_id: x.id, order_status: x.order_status }));
  });

  route(app, 'POST', '/bff/orders/cancel-by-user', async (req) => {
    const b = body(req);
    const { u, o } = await myOrder(req, b.order_id);
    if (!['U', 'P', 'O', 'W'].includes(o.order_status)) throw E.business('Chỉ huỷ được đơn chưa đóng hàng');
    const x = await transition(o.id, 'C', { kind: 'U', id: u.id }, { notes: b.reason ?? 'Khách huỷ' });
    return { order_id: x.id, order_status: x.order_status };
  });

  // Buyer xác nhận đã nhận hàng → hoàn thành (FE gốc gửi order_id hoặc danh sách order_id_sources)
  route(app, 'POST', '/bff/orders/done-by-user', async (req) => {
    const b = body(req);
    const ids = b.order_id != null ? [b.order_id] : arr(b.order_id_sources);
    const out = [];
    for (const id of ids) {
      const { u, o } = await myOrder(req, id);
      if (o.order_status !== 'F') throw E.business(`Đơn ${o.code} chưa giao thành công`);
      const x = await transition(o.id, 'D', { kind: 'U', id: u.id });
      out.push({ order_id: x.id, order_status: x.order_status });
    }
    return out;
  });

  route(app, 'PUT', '/bff/orders/update-notes', async (req) => {
    const b = body(req);
    const { o } = await myOrder(req, b.order_id);
    if (!['U', 'P', 'O', 'W'].includes(o.order_status)) throw E.business('Không sửa ghi chú khi shop đã đóng hàng');
    await prisma.order.update({ where: { id: o.id }, data: { notes: String(b.notes ?? '') } });
    return null;
  });
  route(app, 'POST', '/bff/orders/set-attachment-file-name', async (req) => {
    const b = body(req);
    const { o } = await myOrder(req, b.order_id);
    await prisma.order.update({ where: { id: o.id }, data: { attachment_file_name: String(b.attachment_file_name ?? '') } });
    return null;
  });
  route(app, 'POST', '/bff/orders/:fx_hash/update-buyer-vat-info', async (req) => {
    const b = body(req);
    const { o } = await myOrder(req, b.order_id);
    const v = b.buyer_vat_info ?? b.vat_info;
    await prisma.order.update({ where: { id: o.id }, data: { buyer_vat_info: v == null ? null : typeof v === 'string' ? v : JSON.stringify(v) } });
    return null;
  });

  // ── Danh sách / đếm ──
  route(app, 'POST', '/bff/orders/history', async (req) => list(req, { buyer_user_id: (await requireUser(req)).id }));
  route(app, 'GET', '/bff/orders/count-by-status', async (req) => countBy({ buyer_user_id: (await requireUser(req)).id }));
  route(app, 'POST', '/bff/orders/:fx_hash/list-bought', async (req) => list(req, { buyer_user_id: (await requireUser(req)).id }, 'lines'));
  route(app, 'POST', '/bff/orders/order-shipping-info/:fx_hash/search', async (req) => list(req, { buyer_user_id: (await requireUser(req)).id }, 'lines'));
  route(app, 'POST', '/bff/orders/:fx_hash/pvv-import', async (req) => list(req, { buyer_user_id: (await requireUser(req)).id, order_type: 'V' }));

  // Affiliate: đơn khách đặt qua link của tôi
  route(app, 'POST', '/bff/orders/:fx_hash/aff-list', async (req) => list(req, { aff_user_id: (await requireUser(req)).id }));
  route(app, 'GET', '/bff/orders/aff-count-by-status', async (req) => countBy({ aff_user_id: (await requireUser(req)).id }));

  // CTV: đơn của các tài khoản cấp dưới (F-n trỏ về tôi)
  route(app, 'POST', '/bff/orders/:fx_hash/list-ctv', async (req) => {
    const u = await requireUser(req);
    const b = input(req);
    const children = (await prisma.user.findMany({ where: { parent_user_id: u.id, ...(b.user_id ? { id: Number(b.user_id) } : {}) }, select: { id: true } })).map((x) => x.id);
    return list(req, { buyer_user_id: { in: children } });
  });
  route(app, 'GET', '/bff/orders/ctv-count-by-status', async (req) => countBy({ ctv_parent_user_id: (await requireUser(req)).id }));

  // Tiền dự kiến: hoa hồng/lãi của các đơn chưa hoàn thành (chưa tất toán)
  const pendingProfitWhere = (uid: number): Prisma.OrderWhereInput => ({
    settled: false, order_status: { notIn: ['C', 'B', 'X'] }, profit_amount: { gt: 0 },
    OR: [{ buyer_user_id: uid, is_dropship: 'T' }, { aff_user_id: uid }, { ctv_parent_user_id: uid }],
  });
  route(app, 'GET', '/bff/orders/tien-du-kien-buyer', async (req) => {
    const u = await requireUser(req);
    const a = await prisma.order.aggregate({ where: pendingProfitWhere(u.id), _count: true, _sum: { profit_amount: true, total_amount: true, cod_amount: true } });
    return { name: u.fullname || u.username, total_order: a._count, total_profit: a._sum.profit_amount ?? 0, total_amount: a._sum.total_amount ?? 0, total_revenue: a._sum.cod_amount ?? 0 };
  });
  route(app, 'GET', '/bff/orders/tien-du-kien-buyer-detail', async (req) => {
    const u = await requireUser(req);
    const p = paging(query(req));
    const where = pendingProfitWhere(u.id);
    const [total, rows] = await Promise.all([prisma.order.count({ where }), prisma.order.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, rows.map((o) => ({ order_id: o.id, order_unique_id: o.unique_id, order_code: o.code, total_amount: o.total_amount, total_revenue: o.cod_amount, profit: o.profit_amount, customer_name: o.receiver_fullname, created_at: o.created_at, order_status: o.order_status })));
  });

  // Sổ người nhận (gợi ý khi dropship)
  route(app, 'POST', '/bff/orders/:fx_hash/receiver-address-book', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    const p = paging(b);
    const kw = b.keyword ? String(b.keyword) : null;
    const rows = await prisma.order.findMany({
      where: { buyer_user_id: u.id, ...(b.is_dropship ? { is_dropship: String(b.is_dropship) } : {}), ...(kw ? { OR: [{ receiver_fullname: { contains: kw } }, { receiver_phone: { contains: kw } }] } : {}) },
      orderBy: { id: 'desc' }, take: 1000,
    });
    const book = await receiverBook(rows);
    return paged(p, book.length, book.slice(p.skip, p.skip + p.take));
  });

  // Khách vãng lai tra cứu thông tin nhận hàng cũ theo số điện thoại (để điền nhanh)
  route(app, 'POST', '/bff/orders/order-shipping-info/search-by-guest', async (req) => {
    const phone = String(body(req).phone ?? '').trim();
    if (phone.length < 9) throw E.invalid('Số điện thoại không hợp lệ');
    const rows = await prisma.order.findMany({ where: { receiver_phone: phone, buyer_user_id: null }, orderBy: { id: 'desc' }, take: 5 });
    // Che bớt địa chỉ để tránh lộ thông tin người khác
    return (await receiverBook(rows)).map((r) => ({ ...r, receiver_address_line: r.receiver_address_line.replace(/^(.{0,6}).*$/, '$1***') }));
  });

  void Decimal;
}
