// Quản trị hệ thống (SA): website con, user, shop, sản phẩm, ví & giao dịch tay, cấu hình, danh mục dữ liệu, đơn hàng đặc biệt.
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { prisma, Decimal } from '../lib/db.js';
import { E, isT } from '../lib/http.js';
import { route, body, query, params, input, arr, type Req } from '../lib/router.js';
import { requireSA, requireMfa } from '../lib/auth.js';
import { paging, paged, opt, dateRange } from '../lib/paging.js';
import { code, hex } from '../lib/ids.js';
import { post, type BalanceTypeT } from '../lib/balance.js';
import { productDetail } from '../lib/catalog.js';
import { orderRows, orderFilter, transition } from '../lib/orders.js';
import { OrderTransitions, type OrderStatusT } from '../lib/enums.js';
import { shopOut } from '../lib/serialize.js';
import { tenantOut, siteData } from './tenant.js';

export default function admin(app: FastifyInstance) {
  // ───────────── Website con ─────────────
  const tenantBy = async (b: Record<string, any>) => {
    const t = b.tenant_id != null ? await prisma.tenant.findUnique({ where: { id: Number(b.tenant_id) } }) : await prisma.tenant.findUnique({ where: { fx_hash: String(b.tenant_fx_hash ?? b.unique_id ?? '') } });
    if (!t) throw E.notFound('Website');
    return t;
  };
  route(app, 'POST', '/bff/sa/tenants/:fx_hash/list', async (req) => {
    await requireSA(req);
    const b = body(req);
    const p = paging(b);
    const where: Prisma.TenantWhereInput = { ...(opt(b.status) ? { status: String(b.status) } : {}), ...(opt(b.biz_user_id) ? { owner_user_id: Number(b.biz_user_id) } : {}), ...(opt(b.keyword) ? { OR: [{ name: { contains: String(b.keyword) } }, { domain_primary: { contains: String(b.keyword) } }] } : {}) };
    const [total, rows] = await Promise.all([prisma.tenant.count({ where }), prisma.tenant.findMany({ where, orderBy: { id: 'asc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, rows.map(tenantOut));
  });
  route(app, 'GET', '/bff/sa/tenants/:fx_hash/get/:unique_id', async (req) => {
    await requireSA(req);
    const k = params(req).unique_id;
    const t = /^\d+$/.test(k) ? await prisma.tenant.findUnique({ where: { id: Number(k) } }) : await prisma.tenant.findUnique({ where: { fx_hash: k } });
    if (!t) throw E.notFound('Website');
    return tenantOut(t);
  });
  route(app, 'POST', '/bff/sa/tenants/:fx_hash/create', async (req) => {
    await requireSA(req);
    const b = body(req);
    if (!b.domain_primary || !b.site_name) throw E.invalid('Thiếu domain_primary / site_name');
    const t = await prisma.tenant.create({ data: { ...(siteData(b) as Prisma.TenantCreateInput), fx_hash: hex(16), code: String(b.code ?? code('T')).toUpperCase(), name: String(b.site_name), domain_primary: String(b.domain_primary).toLowerCase(), status: b.status ?? 'A', owner_user_id: b.biz_user_id != null ? Number(b.biz_user_id) : null } });
    return tenantOut(t);
  });
  route(app, 'POST', '/bff/sa/tenants/:fx_hash/update', async (req) => {
    await requireSA(req);
    const b = body(req);
    const t = await tenantBy(b);
    return tenantOut(await prisma.tenant.update({ where: { id: t.id }, data: { ...siteData(b), ...(b.status ? { status: String(b.status) } : {}), ...(b.domain_primary ? { domain_primary: String(b.domain_primary).toLowerCase() } : {}), ...(b.product_quantity_limit != null ? { product_quantity_limit: Number(b.product_quantity_limit) } : {}) } }));
  });
  route(app, 'POST', '/bff/sa/tenants/:fx_hash/dump-single', async (req) => {
    await requireSA(req);
    const t = await tenantBy(body(req));
    return { tenant: tenantOut(t), contracts: await prisma.tenantContract.findMany({ where: { tenant_id: t.id } }), product_count: await prisma.tenantProduct.count({ where: { tenant_id: t.id } }) };
  });
  route(app, 'POST', '/bff/sa/tenants/:fx_hash/set-owner', async (req) => {
    await requireSA(req);
    const b = body(req);
    const t = await tenantBy(b);
    const u = await prisma.user.findUnique({ where: { id: Number(b.biz_user_id ?? b.user_id) } });
    if (!u) throw E.notFound('Tài khoản');
    return tenantOut(await prisma.tenant.update({ where: { id: t.id }, data: { owner_user_id: u.id } }));
  });
  const flag = (field: 'cod_enabled' | 'guest_submit_enabled' | 'public_good_price' | 'gg_sso_enabled', keys: string[]) => async (req: Req) => {
    await requireSA(req);
    const b = body(req);
    const t = await tenantBy(b);
    const v = keys.map((k) => b[k]).find((x) => x !== undefined);
    return tenantOut(await prisma.tenant.update({ where: { id: t.id }, data: { [field]: isT(v) } }));
  };
  route(app, 'POST', '/bff/sa/tenants/:fx_hash/sa-set-cod', flag('cod_enabled', ['cod_enabled', 'enabled']));
  route(app, 'POST', '/bff/sa/tenants/:fx_hash/sa-set-guest-submit-order-enable', flag('guest_submit_enabled', ['guest_submit_order_enabled', 'enabled']));
  route(app, 'POST', '/bff/sa/tenants/:fx_hash/sa-set-public-good-price', flag('public_good_price', ['public_good_price', 'enabled']));
  route(app, 'POST', '/bff/sa/tenants/:fx_hash/change-gg-sso', flag('gg_sso_enabled', ['gg_sso_enabled', 'enabled']));

  route(app, 'POST', '/bff/sa/tenant-contracts/:fx_hash/list', async (req) => {
    await requireSA(req);
    const b = body(req);
    const p = paging(b);
    const where: Prisma.TenantContractWhereInput = { ...(opt(b.tenant_id) ? { tenant_id: Number(b.tenant_id) } : {}), ...(opt(b.status) ? { status: String(b.status) } : {}), ...(opt(b.domain_type) ? { domain_type: String(b.domain_type) } : {}), ...(opt(b.keyword) ? { domain_name: { contains: String(b.keyword) } } : {}) };
    const [total, rows] = await Promise.all([prisma.tenantContract.count({ where }), prisma.tenantContract.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, rows);
  });
  // Gia hạn hợp đồng website (SA thu phí tháng từ ví chủ website, hoặc miễn phí với free=true)
  route(app, 'POST', '/bff/sa/tenant-contracts/:fx_hash/ensure', async (req) => {
    await requireSA(req);
    const b = body(req);
    const t = await tenantBy(b);
    const c = await prisma.tenantContract.findFirst({ where: { tenant_id: t.id, contract_type: 'T' }, orderBy: { to_date: 'desc' } });
    if (!c) throw E.notFound('Hợp đồng website');
    const from = c.to_date > new Date() ? c.to_date : new Date();
    const up = await prisma.$transaction(async (tx) => {
      if (!isT(b.free) && t.owner_user_id && c.amount.gt(0)) await post(tx, t.owner_user_id, 'A', c.amount.neg(), { business_code: 'TENANT_CONTRACT', business_sub_code: 'RENEW', ref_code: c.code, allowNegative: isT(b.allow_debt) });
      await tx.tenant.update({ where: { id: t.id }, data: { status: 'A' } });
      return tx.tenantContract.update({ where: { id: c.id }, data: { to_date: new Date(from.getTime() + 30 * 86400_000), status: 'A', last_subscription_date: new Date(), last_subscription_amount: isT(b.free) ? 0 : c.amount } });
    });
    return up;
  });
  route(app, 'POST', '/bff/sa/tenant-contracts/:fx_hash/change-renew-status', async (req) => {
    await requireSA(req);
    const b = body(req);
    return prisma.tenantContract.update({ where: { code: String(b.code ?? '') }, data: { auto_renew: isT(b.renew_status) } });
  });

  // ───────────── User ─────────────
  const userRow = (u: Awaited<ReturnType<typeof prisma.user.findFirstOrThrow>>) => ({
    user_id: u.id, username: u.username, link_fb: u.link_fb, fullname: u.fullname, default_address: u.default_address, cccd: u.cccd, status: u.status, bank_ref_user_code: u.bank_ref_user_code,
    created_at: u.created_at, updated_at: u.updated_at, email: u.email, phone: u.phone, level: u.user_level, user_level: u.user_level, parent_user_id: u.parent_user_id, tenant_id: u.tenant_id,
    good_pricing: u.good_pricing, mfa_enabled: u.mfa_enabled, is_sa: u.is_sa, admin_comment: u.admin_comment,
  });
  route(app, 'GET', '/bff/sa/users/list', async (req) => {
    await requireSA(req);
    const q = query(req);
    const p = paging(q);
    const where: Prisma.UserWhereInput = { ...(opt(q.status) ? { status: String(q.status) } : {}), ...(opt(q.user_id) ? { id: Number(q.user_id) } : {}), ...(opt(q.user_level) ? { user_level: Number(q.user_level) } : {}), ...(opt(q.keyword) ? { OR: [{ username: { contains: String(q.keyword) } }, { phone: { contains: String(q.keyword) } }, { email: { contains: String(q.keyword) } }, { fullname: { contains: String(q.keyword) } }] } : {}) };
    const [total, rows] = await Promise.all([prisma.user.count({ where }), prisma.user.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, rows.map(userRow));
  });
  const targetUser = async (b: Record<string, any>) => {
    const u = await prisma.user.findUnique({ where: { id: Number(b.user_id) } });
    if (!u) throw E.notFound('Tài khoản');
    return u;
  };
  route(app, 'POST', '/bff/sa/users/lock', async (req) => {
    const sa = await requireSA(req);
    const b = body(req);
    const u = await targetUser(b);
    if (u.id === sa.id) throw E.invalid('Không tự khoá chính mình');
    const locked = b.locked !== undefined ? isT(b.locked) : b.status ? b.status === 'L' : u.status !== 'L';
    return userRow(await prisma.user.update({ where: { id: u.id }, data: { status: locked ? 'L' : 'A', admin_comment: b.admin_comment ?? u.admin_comment } }));
  });
  route(app, 'POST', '/bff/sa/users/:fx_hash/update-email', async (req) => {
    await requireSA(req);
    const b = body(req);
    const u = await targetUser(b);
    if (await prisma.user.findFirst({ where: { email: String(b.new_email), id: { not: u.id } } })) throw E.conflict('Email đã được dùng');
    return userRow(await prisma.user.update({ where: { id: u.id }, data: { email: String(b.new_email) } }));
  });
  route(app, 'POST', '/bff/sa/users/:fx_hash/update-info', async (req) => {
    await requireSA(req);
    const b = body(req);
    const u = await targetUser(b);
    return userRow(await prisma.user.update({ where: { id: u.id }, data: { email: b.new_email ?? undefined, fullname: b.new_fullname ?? undefined, phone: b.new_phone ?? undefined, user_level: b.new_user_level != null ? Number(b.new_user_level) : undefined } }));
  });
  route(app, 'POST', '/bff/sa/users/:fx_hash/reset-mfa', async (req) => {
    await requireSA(req);
    const u = await targetUser(body(req));
    return userRow(await prisma.user.update({ where: { id: u.id }, data: { mfa_enabled: false, mfa_secret: null, mfa_enabled_at: null } }));
  });
  route(app, 'POST', '/bff/sa/users/:fx_hash/change-good-pricing', async (req) => {
    const sa = await requireSA(req);
    const b = body(req);
    requireMfa(sa, b.totp_code);
    const v = b.good_pricing ?? b.good_prcing;
    const r = await prisma.user.updateMany({ where: { id: { in: arr<number>(b.user_ids).map(Number) } }, data: { good_pricing: isT(v) || v === 'G' ? 'G' : 'N' } });
    return { updated: r.count };
  });
  route(app, 'POST', '/bff/sa/users/:fx_hash/report', async (req) => {
    await requireSA(req);
    const [total_user, total_user_inactive, good_t, good_f, f2, f3] = await Promise.all([
      prisma.user.count(), prisma.user.count({ where: { status: { not: 'A' } } }),
      prisma.user.count({ where: { user_level: 1, good_pricing: 'G' } }), prisma.user.count({ where: { user_level: 1, good_pricing: { not: 'G' } } }),
      prisma.user.count({ where: { user_level: 2, status: 'A' } }), prisma.user.count({ where: { user_level: { gte: 3 }, status: 'A' } }),
    ]);
    return { total_user, total_user_inactive, total_user_f1_good_pricing_t: good_t, total_user_f1_good_pricing_f: good_f, total_user_f2_active: f2, total_user_f3_active: f3 };
  });

  // ───────────── Shop ─────────────
  route(app, 'GET', '/bff/sa/shops/list', async (req) => {
    await requireSA(req);
    const q = query(req);
    const p = paging(q);
    const where: Prisma.ShopWhereInput = { ...(opt(q.status) ? { status: String(q.status) } : {}), ...(opt(q.admin_status) ? { admin_status: String(q.admin_status) } : {}), ...(opt(q.shop_id) ? { id: Number(q.shop_id) } : {}), ...(opt(q.user_id) ? { user_id: Number(q.user_id) } : {}), ...(opt(q.keyword) ? { display_name: { contains: String(q.keyword) } } : {}) };
    const [total, rows] = await Promise.all([prisma.shop.count({ where }), prisma.shop.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, rows.map(shopOut));
  });
  route(app, 'POST', '/bff/sa/shops/change-admin-status', async (req) => {
    await requireSA(req);
    const b = body(req);
    if (!['A', 'W', 'L'].includes(String(b.admin_status))) throw E.invalid('admin_status: A | W | L');
    return shopOut(await prisma.shop.update({ where: { id: Number(b.shop_id) }, data: { admin_status: String(b.admin_status), notes: b.admin_status_notes ?? undefined } }));
  });
  route(app, 'POST', '/bff/sa/shops/enable-mall', async (req) => {
    await requireSA(req);
    const b = body(req);
    await prisma.product.updateMany({ where: { shop_id: Number(b.shop_id) }, data: { is_mall: isT(b.enable) } });
    return shopOut(await prisma.shop.update({ where: { id: Number(b.shop_id) }, data: { is_mall: isT(b.enable) } }));
  });
  route(app, 'POST', '/bff/sa/shops/:fx_hash/dump-custom', async (req) => {
    await requireSA(req);
    const ids = arr<number>(body(req).shop_ids).map(Number);
    const r = await prisma.product.updateMany({ where: ids.length ? { shop_id: { in: ids } } : {}, data: { dump_at: new Date() } });
    return { updated_products: r.count };
  });

  // ───────────── Sản phẩm ─────────────
  const productList = async (req: Req) => {
    const b = input(req);
    const p = paging(b);
    const where: Prisma.ProductWhereInput = { status: { not: 'X' }, ...(opt(b.status) ? { status: String(b.status) } : {}), ...(opt(b.admin_status) ? { admin_status: String(b.admin_status) } : {}), ...(opt(b.shop_id) ? { shop_id: Number(b.shop_id) } : {}), ...(opt(b.keyword) ? { name: { contains: String(b.keyword) } } : {}) };
    const [total, rows] = await Promise.all([prisma.product.count({ where }), prisma.product.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await Promise.all(rows.map((r) => productDetail(r, { withAdmin: true }))));
  };
  route(app, 'POST', '/bff/sa/products/:fx_hash/list-v2', async (req) => { await requireSA(req); return productList(req); });
  const decide = (admin_status: 'A' | 'L') => async (req: Req) => {
    await requireSA(req);
    const b = body(req);
    const ids = b.product_ids ? arr<number>(b.product_ids).map(Number) : [Number(b.product_id)];
    const r = await prisma.product.updateMany({ where: { id: { in: ids } }, data: { admin_status, admin_comment: b.admin_comment ?? null, admin_updated_at: new Date() } });
    return { updated: r.count };
  };
  route(app, 'PUT', '/bff/sa/products/approve', decide('A'));
  route(app, 'PUT', '/bff/sa/products/lock', decide('L'));
  // Sửa SKU nhập sai: gộp tồn & đổi mã trên dữ liệu liên quan
  route(app, 'POST', '/bff/sa/products/:fx_hash/correct-sku', async (req) => {
    await requireSA(req);
    const b = body(req);
    const wrong = await prisma.variation.findUnique({ where: { sku: String(b.sku_sai ?? '') } });
    if (!wrong) throw E.notFound('SKU sai');
    const right = String(b.sku_chuan ?? '').trim();
    if (!right) throw E.invalid('Thiếu sku_chuan');
    if (await prisma.variation.findUnique({ where: { sku: right } })) throw E.conflict('sku_chuan đã tồn tại');
    await prisma.$transaction([prisma.variation.update({ where: { id: wrong.id }, data: { sku: right } }), prisma.orderItem.updateMany({ where: { variation_id: wrong.id }, data: { sku: right } })]);
    return { variation_id: wrong.id, sku: right };
  });

  // ───────────── Ví & giao dịch ─────────────
  route(app, 'POST', '/bff/sa/balance/:fx_hash/report-top-balance', async (req) => {
    await requireSA(req);
    const b = body(req);
    const rows = await prisma.balance.findMany({ where: { balance_type: { in: arr<string>(b.balance_types).length ? arr<string>(b.balance_types) : ['A'] } }, orderBy: { amount: 'desc' }, take: Math.min(500, Number(b.top ?? 20)) });
    const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.user_id) } } });
    return rows.map((r) => ({ user_id: r.user_id, username: users.find((u) => u.id === r.user_id)?.username, display_name: users.find((u) => u.id === r.user_id)?.fullname, balance_type: r.balance_type, current_balance: r.amount, last_updated_time: r.updated_at }));
  });
  route(app, 'POST', '/bff/sa/balance/:fx_hash/get-summarize', async (req) => {
    await requireSA(req);
    const g = await prisma.balance.groupBy({ by: ['balance_type'], _sum: { amount: true }, _count: true });
    const pendingW = await prisma.dwTransaction.aggregate({ where: { dw_type: 'W', status: 'P' }, _sum: { amount: true }, _count: true });
    return { balances: g.map((x) => ({ balance_type: x.balance_type, total_amount: x._sum.amount ?? 0, account_count: x._count })), pending_withdraw_amount: pendingW._sum.amount ?? 0, pending_withdraw_count: pendingW._count };
  });
  // Danh sách tài khoản âm tiền (vd bị trừ phí bom hàng)
  route(app, 'POST', '/bff/sa/balance/:fx_hash/ds-am-tien', async (req) => {
    await requireSA(req);
    const rows = await prisma.balance.findMany({ where: { amount: { lt: 0 } }, orderBy: { amount: 'asc' } });
    const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.user_id) } } });
    return rows.map((r) => ({ user_id: r.user_id, username: users.find((u) => u.id === r.user_id)?.username, phone: users.find((u) => u.id === r.user_id)?.phone, balance_type: r.balance_type, current_balance: r.amount, last_updated_time: r.updated_at }));
  });
  // Tài khoản ngân hàng nhận tiền của sàn (hiển thị hướng dẫn nạp)
  route(app, 'POST', '/bff/sa/balances/get-balance-for-sa', async (req) => {
    await requireSA(req);
    return [{ unique_id: 'default', bank_code: process.env.QR_BANK_CODE ?? 'VCB', vietqr_bank_id: process.env.QR_BANK_BIN ?? '970436', account_no: process.env.QR_BANK_ACCOUNT ?? '0000000000', account_name: process.env.QR_BANK_ACCOUNT_NAME ?? 'DROPBUY', is_default: true, deposit_for_user_desc: '<mã tham chiếu> <mã lệnh nạp>', nap_xu_desc: '<mã tham chiếu> XU-...', deposit_for_ky_quy_desc: '<mã tham chiếu> NAP-... (ký quỹ)' }];
  });
  route(app, 'GET', '/bff/sa/trx/list', async (req) => {
    await requireSA(req);
    const q = query(req);
    const p = paging(q);
    const where: Prisma.BalanceTxnWhereInput = {};
    for (const k of ['action_code', 'business_code', 'business_sub_code', 'ref_code'] as const) if (opt(q[k])) where[k] = String(q[k]);
    if (opt(q.user_id)) where.user_id = Number(q.user_id);
    if (opt(q.balance_id)) where.balance_id = (await prisma.balance.findUnique({ where: { unique_id: String(q.balance_id) } }))?.id ?? -1;
    const r = dateRange(q.from_date, q.to_date);
    if (r) where.created_at = r;
    const [total, rows] = await Promise.all([prisma.balanceTxn.count({ where }), prisma.balanceTxn.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, rows);
  });
  // Điều chỉnh ví thủ công (bắt buộc MFA nếu SA bật). tx = { user_id, balance_type, amount (+/-), notes }
  route(app, 'POST', '/bff/sa/trx/submit-for-sa', async (req) => {
    const sa = await requireSA(req);
    const b = body(req);
    requireMfa(sa, b.totp_code);
    const tx0 = b.tx ?? b;
    const u = await prisma.user.findUnique({ where: { id: Number(tx0.user_id) } });
    if (!u) throw E.notFound('Tài khoản');
    const amt = new Decimal(String(tx0.amount ?? 0));
    if (amt.isZero()) throw E.invalid('amount khác 0');
    const crid = code('ADJ');
    const t = await prisma.$transaction((tx) => post(tx, u.id, (tx0.balance_type ?? 'A') as BalanceTypeT, amt, { business_code: 'ADJUST', business_sub_code: `SA:${sa.id}`, ref_code: tx0.ref_code ?? crid, notes: tx0.notes, allowNegative: isT(tx0.allow_negative) }));
    return { crid, submited_tx: t };
  });

  // ───────────── Cấu hình & danh mục ─────────────
  // user-settings: cấu hình hệ thống (user_id=0) hoặc theo user
  route(app, 'POST', '/bff/sa/user-settings/list', async (req) => {
    await requireSA(req);
    const b = body(req);
    return prisma.userSetting.findMany({ where: { ...(opt(b.name) ? { key: { contains: String(b.name) } } : {}), ...(b.apply_to_user_id != null ? { user_id: Number(b.apply_to_user_id) } : {}) }, orderBy: { key: 'asc' } });
  });
  route(app, 'POST', '/bff/sa/user-settings/update-batch', async (req) => {
    await requireSA(req);
    const b = body(req);
    const items = b.items ? arr<{ name: string; value: unknown; apply_to_user_id?: number }>(b.items) : [{ name: String(b.name), value: b.value, apply_to_user_id: b.apply_to_user_id }];
    const out = [];
    for (const it of items) {
      const user_id = Number(it.apply_to_user_id ?? 0);
      out.push(await prisma.userSetting.upsert({ where: { user_id_key: { user_id, key: it.name } }, create: { user_id, key: it.name, value: String(it.value) }, update: { value: String(it.value) } }));
    }
    return out;
  });

  // baseline-data: danh mục dữ liệu (lý do huỷ, lý do khiếu nại, ...). data = 1 bản ghi, batch_data = nhiều
  const blRows = (b: Record<string, any>) => (b.batch_data ? arr<Record<string, any>>(b.batch_data) : b.data ? [b.data] : [b]);
  route(app, 'POST', '/bff/sa/baseline-data/:fx_hash/list', async (req) => {
    const b = body(req);
    const p = paging(b, 100);
    const where: Prisma.BaselineDataWhereInput = { ...(opt(b.bl_type_id) ? { bl_type_id: Number(b.bl_type_id) } : {}), ...(opt(b.display_status) ? { display_status: String(b.display_status) } : {}), ...(opt(b.keyword) ? { bl_text: { contains: String(b.keyword) } } : {}) };
    const [total, rows] = await Promise.all([prisma.baselineData.count({ where }), prisma.baselineData.findMany({ where, orderBy: [{ bl_type_id: 'asc' }, { num: 'asc' }], skip: p.skip, take: p.take })]);
    return paged(p, total, rows.map((r) => ({ bl_id: r.id, ...r })));
  });
  route(app, 'POST', '/bff/sa/baseline-data/:fx_hash/submit', async (req) => {
    await requireSA(req);
    const out = [];
    for (const r of blRows(body(req))) out.push(await prisma.baselineData.create({ data: { bl_type_id: Number(r.bl_type_id), bl_text: String(r.bl_text), num: Number(r.num ?? 0), bl_s_value: r.bl_s_value ?? null, display_status: r.display_status ?? 'A' } }));
    return out.map((r) => ({ bl_id: r.id, ...r }));
  });
  route(app, 'PUT', '/bff/sa/baseline-data/:fx_hash/update', async (req) => {
    await requireSA(req);
    const out = [];
    for (const r of blRows(body(req))) out.push(await prisma.baselineData.update({ where: { id: Number(r.bl_id ?? r.id) }, data: { bl_text: r.bl_text ?? undefined, num: r.num != null ? Number(r.num) : undefined, bl_s_value: r.bl_s_value ?? undefined, display_status: r.display_status ?? undefined } }));
    return out.map((r) => ({ bl_id: r.id, ...r }));
  });
  route(app, 'DELETE', '/bff/sa/baseline-data/:fx_hash/delete', async (req) => {
    await requireSA(req);
    const ids = blRows(body(req)).map((r) => Number(r.bl_id ?? r.id));
    const r = await prisma.baselineData.deleteMany({ where: { id: { in: ids } } });
    return { deleted: r.count };
  });

  // Đội thi đua mùa 2: điểm = doanh số đơn hoàn thành của trưởng đội + tuyến dưới trực tiếp
  route(app, 'POST', '/bff/sa/teams/:fx_hash/recalc-season-2', async (req) => {
    await requireSA(req);
    const b = body(req);
    const teams = await prisma.team.findMany({ where: { season: 2, ...(b.team_owner_id ? { leader_user_id: Number(b.team_owner_id) } : {}) } });
    const out = [];
    for (const t of teams) {
      const members = [t.leader_user_id, ...(await prisma.user.findMany({ where: { parent_user_id: t.leader_user_id }, select: { id: true } })).map((u) => u.id)];
      const s = await prisma.order.aggregate({ where: { buyer_user_id: { in: members }, order_status: 'D' }, _sum: { commodity_amount: true } });
      out.push(await prisma.team.update({ where: { id: t.id }, data: { score: s._sum.commodity_amount ?? 0 } }));
    }
    return out.map((t) => ({ team_id: t.id, season_id: t.season, name: t.name, current_point: t.score, team_owner_id: t.leader_user_id, updated_at: t.updated_at }));
  });

  // ───────────── Đơn hàng (can thiệp của SA) ─────────────
  route(app, 'POST', '/bff/sa/orders/list', async (req) => {
    await requireSA(req);
    const b = input(req);
    const p = paging(b);
    const where: Prisma.OrderWhereInput = { ...orderFilter(b), ...(opt(b.shop_id) ? { shop_id: Number(b.shop_id) } : {}), ...(opt(b.tenant_id) ? { tenant_id: Number(b.tenant_id) } : {}), ...(opt(b.buyer_user_id) ? { buyer_user_id: Number(b.buyer_user_id) } : {}) };
    const [total, rows] = await Promise.all([prisma.order.count({ where }), prisma.order.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await orderRows(rows));
  });
  const saOrder = async (req: Req) => {
    const sa = await requireSA(req);
    const b = body(req);
    const o = await prisma.order.findFirst({ where: { OR: [{ id: Number(b.order_id) || -1 }, { unique_id: String(b.unique_id ?? b.order_id ?? '') }, { code: String(b.order_code ?? b.order_id ?? '') }] } });
    if (!o) throw E.notFound('Đơn hàng');
    return { sa, b, o };
  };
  route(app, 'POST', '/bff/sa/orders/cancel-by-sa', async (req) => {
    const { sa, b, o } = await saOrder(req);
    const x = await transition(o.id, 'C', { kind: 'A', id: sa.id }, { force: true, notes: b.reason ?? b.notes ?? 'SA huỷ' });
    return { order_id: x.id, order_status: x.order_status };
  });
  route(app, 'POST', '/bff/sa/order/mark-boom', async (req) => {
    const { sa, b, o } = await saOrder(req);
    if (!['S', 'N', 'Q'].includes(o.order_status)) throw E.business('Chỉ đánh dấu bom với đơn đang giao / giao thất bại');
    const reason = b.reason_id ? (await prisma.baselineData.findUnique({ where: { id: Number(b.reason_id) } }))?.bl_text : undefined;
    const x = await transition(o.id, 'B', { kind: 'A', id: sa.id }, { force: o.order_status === 'Q', notes: reason ?? b.notes ?? 'Bom hàng' });
    return { order_id: x.id, order_status: x.order_status };
  });
  // Kết thúc đơn: ship_back_to_shop/refund_amount → hoàn hàng + hoàn tiền (X); ngược lại hoàn thành (D)
  route(app, 'POST', '/bff/sa/order/mark-done', async (req) => {
    const { sa, b, o } = await saOrder(req);
    const refund = b.refund_amount != null ? new Decimal(String(b.refund_amount)) : null;
    const x = isT(b.ship_back_to_shop) || (refund && refund.gt(0))
      ? await transition(o.id, 'X', { kind: 'A', id: sa.id }, { force: true, refund_amount: refund ?? undefined, notes: b.notes })
      : await transition(o.id, 'D', { kind: 'A', id: sa.id }, { force: true, notes: b.notes });
    return { order_id: x.id, order_status: x.order_status };
  });
  route(app, 'POST', '/bff/sa/order/:fx_hash/change-status', async (req) => {
    const { sa, b, o } = await saOrder(req);
    const to = String(b.status ?? b.order_status) as OrderStatusT;
    if (!(to in OrderTransitions)) throw E.invalid('status không hợp lệ');
    const x = await transition(o.id, to, { kind: 'A', id: sa.id }, { force: isT(b.force), notes: b.notes ?? b.shop_notes });
    return { order_id: x.id, order_status: x.order_status };
  });
  // Huỷ tất toán (đảo các bút toán ORDER_SETTLE/hoa hồng/COD của đơn), đưa đơn về "đã giao"
  route(app, 'POST', '/bff/sa/order/:fx_hash/rollback-don-tat-toan', async (req) => {
    const { sa, o } = await saOrder(req);
    if (!o.settled) throw E.business('Đơn chưa tất toán');
    const codes = ['ORDER_SETTLE', 'AFF_COMMISSION', 'CTV_COMMISSION', 'COD_RETURN', 'TENANT_COMMISSION', 'REPUTATION'];
    const txns = await prisma.balanceTxn.findMany({ where: { ref_code: o.code, business_code: { in: codes } } });
    await prisma.$transaction(async (tx) => {
      for (const t of txns) {
        const bal = await tx.balance.findUniqueOrThrow({ where: { id: t.balance_id } });
        await post(tx, t.user_id, bal.balance_type as BalanceTypeT, t.action_code === 'I' ? t.amount.neg() : t.amount, { business_code: 'SETTLE_ROLLBACK', business_sub_code: t.business_code, ref_code: o.code, allowNegative: true });
      }
      await tx.order.update({ where: { id: o.id }, data: { settled: false, order_status: 'F', done_at: null } });
      await tx.orderEvent.create({ data: { order_id: o.id, from_status: o.order_status, to_status: 'F', actor: 'A', actor_id: sa.id, notes: 'Rollback tất toán' } });
    });
    return { order_id: o.id, order_status: 'F', reversed_entries: txns.length };
  });
  route(app, 'POST', '/bff/sa/orders/:fx_hash/dump-json', async (req) => {
    await requireSA(req);
    const ids = arr<number>(body(req).order_ids).map(Number);
    const rows = await prisma.order.findMany({ where: { id: { in: ids } } });
    const out = await orderRows(rows);
    return Promise.all(out.map(async (o) => ({ ...o, events: await prisma.orderEvent.findMany({ where: { order_id: o.id }, orderBy: { id: 'asc' } }) })));
  });
  // Xử lý thất lạc hàng: hoàn tiền buyer, shop chịu giá trị hàng (trừ ví shop)
  route(app, 'POST', '/bff/sa/orders/:fx_hash/xu-ly-mat-hang', async (req) => {
    const { sa, b, o } = await saOrder(req);
    if (!['Q', 'S', 'N'].includes(o.order_status)) throw E.business('Chỉ xử lý thất lạc với đơn đang vận chuyển');
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: o.shop_id } });
    const its = await prisma.orderItem.findMany({ where: { order_id: o.id } });
    const base = its.reduce((a, i) => a.plus(i.base_price.mul(i.quantity)), new Decimal(0));
    await prisma.$transaction(async (tx) => {
      if (o.buyer_user_id && o.paid_at) await post(tx, o.buyer_user_id, 'A', o.total_amount, { business_code: 'ORDER_LOST_REFUND', ref_code: o.code });
      if (isT(b.shop_pay ?? 'T')) await post(tx, shop.user_id, 'A', base.neg(), { business_code: 'ORDER_LOST_PENALTY', ref_code: o.code, allowNegative: true });
      await tx.order.update({ where: { id: o.id }, data: { order_status: 'C', cancel_reason: b.notes ?? 'Thất lạc hàng' } });
      await tx.orderEvent.create({ data: { order_id: o.id, from_status: o.order_status, to_status: 'C', actor: 'A', actor_id: sa.id, notes: 'Thất lạc hàng' } });
    });
    return { order_id: o.id, order_status: 'C', shop_penalty: base };
  });
  // Đồng bộ trạng thái từ đơn vị vận chuyển: đi qua chuỗi trạng thái hợp lệ tới trạng thái đích
  route(app, 'POST', '/bff/sa/orders/:fx_hash/sa-check-n-force-sync-shipping', async (req) => {
    const { sa, b, o } = await saOrder(req);
    const target = String(b.carrier_status ?? b.status ?? '') as OrderStatusT;
    const path: Record<string, OrderStatusT[]> = { Q: ['G', 'Q'], S: ['G', 'Q', 'S'], F: ['G', 'Q', 'S', 'F'], N: ['G', 'Q', 'S', 'N'], B: ['G', 'Q', 'S', 'B'] };
    if (!path[target]) throw E.invalid('carrier_status: Q | S | F | N | B');
    let cur = o.order_status as OrderStatusT;
    const steps: OrderStatusT[] = [];
    for (const s of path[target]) {
      if (cur === s || !OrderTransitions[cur]?.includes(s)) continue;
      await transition(o.id, s, { kind: 'A', id: sa.id }, { notes: 'Đồng bộ vận chuyển' });
      cur = s;
      steps.push(s);
    }
    if (b.shipping_ref_code) await prisma.order.update({ where: { id: o.id }, data: { shipping_ref_code: String(b.shipping_ref_code) } });
    if (b.weight_total_partner != null) await prisma.order.update({ where: { id: o.id }, data: { weight_total_partner: new Decimal(b.weight_total_partner), weight_fee_partner: b.weight_fee_partner != null ? new Decimal(b.weight_fee_partner) : undefined } });
    return { order_id: o.id, order_status: cur, applied: steps, already_synced: steps.length === 0 };
  });
}
