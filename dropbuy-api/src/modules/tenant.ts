// Website con (tenant): đăng ký website, cấu hình, sản phẩm & shop theo dõi, trang chủ, quản trị dành cho chủ website.
import type { FastifyInstance } from 'fastify';
import type { Prisma, Tenant } from '@prisma/client';
import { prisma, Decimal } from '../lib/db.js';
import { E, isT } from '../lib/http.js';
import { route, body, query, input, arr, type Req } from '../lib/router.js';
import { requireUser, requireShop, requireTenantOwner, tenantOf, currentUser, requireMfa } from '../lib/auth.js';
import { paging, paged, opt, dateRange } from '../lib/paging.js';
import { code, hex, uuid, slugify } from '../lib/ids.js';
import { post } from '../lib/balance.js';
import { productDetail, productCards } from '../lib/catalog.js';
import { orderRows, orderFilter, transition } from '../lib/orders.js';
import { shopOut } from '../lib/serialize.js';

const SETUP_FEE = () => new Decimal(process.env.TENANT_SETUP_FEE ?? 500000);
const MONTHLY_FEE = (qty: number) => new Decimal(process.env.TENANT_MONTHLY_FEE ?? 200000).plus(new Decimal(qty).mul(process.env.TENANT_FEE_PER_PRODUCT ?? 1000));
const GG_SSO_FEE = () => new Decimal(process.env.TENANT_GG_SSO_FEE ?? 300000);
const AAP_FEE = () => new Decimal(process.env.TENANT_AAP_FEE ?? 100000);

export function tenantOut(t: Tenant) {
  return {
    tenant_id: t.id, fx_hash: t.fx_hash, code: t.code, domain_primary: t.domain_primary, domains: JSON.parse(t.domains), created_at: t.created_at, site_name: t.name, status: t.status,
    biz_user_id: t.owner_user_id, site_title: t.site_title, site_meta_desc: t.site_meta_desc, site_logo_path: t.site_logo_path, site_banner_path: t.site_banner_path, site_color: t.site_color,
    site_json_configs: t.site_json_configs ? JSON.parse(t.site_json_configs) : null, features: JSON.parse(t.features), notes: t.notes, updated_at: t.updated_at,
    cod_enabled: t.cod_enabled, guest_submit_order_enabled: t.guest_submit_enabled, public_good_price: t.public_good_price, gg_sso_enabled: t.gg_sso_enabled, xu_enabled: t.xu_enabled,
    product_quantity_limit: t.product_quantity_limit, shipping_markup_enabled: t.shipping_markup_enabled, shipping_markup_percent: t.shipping_markup_percent, shipping_markup_amount: t.shipping_markup_amount,
  };
}

/** Cập nhật cấu hình hiển thị website (dùng chung cho chủ website & SA). */
export function siteData(b: Record<string, any>): Prisma.TenantUpdateInput {
  const d: Prisma.TenantUpdateInput = {};
  if (b.site_name != null) d.name = String(b.site_name);
  for (const k of ['site_title', 'site_meta_desc', 'site_logo_path', 'site_banner_path', 'site_color', 'notes'] as const) if (b[k] !== undefined) (d as Record<string, unknown>)[k] = b[k];
  if (b.site_json_configs !== undefined) d.site_json_configs = b.site_json_configs == null ? null : typeof b.site_json_configs === 'string' ? b.site_json_configs : JSON.stringify(b.site_json_configs);
  if (b.features !== undefined) d.features = JSON.stringify(arr(b.features));
  if (b.domains !== undefined) d.domains = JSON.stringify(arr(b.domains));
  return d;
}

async function contractOut(c: Awaited<ReturnType<typeof prisma.tenantContract.findFirstOrThrow>>) {
  const t = await prisma.tenant.findUnique({ where: { id: c.tenant_id } });
  return {
    code: c.code, user_id: t?.owner_user_id, tenant_id: c.tenant_id, fx_hash: t?.fx_hash, from_date: c.from_date, to_date: c.to_date, contract_type: c.contract_type, domain_type: c.domain_type, domain_name: c.domain_name,
    product_quantity: c.product_quantity, status: c.to_date < new Date() && c.status === 'A' ? 'E' : c.status, one_time_setup_fee: c.one_time_setup_fee, monthly_fee: c.amount, renew_status: c.auto_renew ? 'T' : 'F',
    last_subscription_date: c.last_subscription_date, last_subscription_amount: c.last_subscription_amount, created_at: c.created_at,
  };
}

export default function tenant(app: FastifyInstance) {
  // ── Thông tin website hiện tại (public) ──
  route(app, 'GET', '/bff/tenants/:fx_hash/my-tenant', async (req) => {
    const t = await tenantOf(req);
    const out = tenantOut(t);
    const u = await currentUser(req);
    return u && (u.id === t.owner_user_id || u.is_sa) ? out : { ...out, notes: undefined };
  });
  route(app, 'POST', '/bff/tenants/:fx_hash/update', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    return tenantOut(await prisma.tenant.update({ where: { id: t.id }, data: siteData(body(req)) }));
  });
  route(app, 'POST', '/bff/tenants/:fx_hash/set-cod', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    return tenantOut(await prisma.tenant.update({ where: { id: t.id }, data: { cod_enabled: isT(body(req).cod_enabled) } }));
  });
  // Xuất cấu hình website (dùng để build/caching FE)
  route(app, 'POST', '/bff/tenants/:fx_hash/dump-single', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const home = await prisma.tenantProduct.findMany({ where: { tenant_id: t.id, home_status: 'H', status: 'A' }, orderBy: { num: 'asc' } });
    return { tenant: tenantOut(t), home_product_ids: home.map((h) => h.product_id), dumped_at: new Date() };
  });

  // Báo cáo R601: doanh số & lợi nhuận đơn đặt trên website con
  const r601Where = (t: Tenant, b: Record<string, any>): Prisma.OrderWhereInput => ({ tenant_id: t.id, order_status: { notIn: ['C', 'U', 'P'] }, ...(dateRange(b.from_date, b.to_date) ? { created_at: dateRange(b.from_date, b.to_date) } : {}) });
  route(app, 'POST', '/bff/tenants/:fx_hash/r601-data-get', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const rows = await prisma.order.findMany({ where: r601Where(t, body(req)) });
    const done = rows.filter((o) => o.settled);
    const sum = (xs: typeof rows, f: (o: (typeof rows)[number]) => Decimal) => xs.reduce((a, o) => a.plus(f(o)), new Decimal(0));
    return {
      tong_so_don: rows.length, doanh_so: sum(rows, (o) => o.commodity_amount), tong_phi_ship: sum(rows, (o) => o.shipping_amount),
      loi_nhuan_ghi_nhan: sum(done, (o) => o.tenant_profit_amount), loi_nhuan_du_kien: sum(rows.filter((o) => !o.settled), (o) => o.tenant_profit_amount),
      tong_loi_nhuan: sum(rows, (o) => o.tenant_profit_amount),
    };
  });
  route(app, 'POST', '/bff/tenants/:fx_hash/r601-data-detail-get', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const b = body(req);
    const p = paging(b);
    const where = r601Where(t, b);
    const [total, rows] = await Promise.all([prisma.order.count({ where }), prisma.order.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, rows.map((o) => ({ ma_don_hang: o.code, ngay_mua: o.created_at, doanh_so: o.commodity_amount, phi_ship: o.shipping_amount, loi_nhuan_ghi_nhan: o.settled ? o.tenant_profit_amount : 0, loi_nhuan_du_kien: o.settled ? 0 : o.tenant_profit_amount, trang_thai: o.order_status })));
  });

  // ── Hợp đồng website con: đăng ký mở website, gia hạn số lượng sp, mua đăng nhập Google ──
  route(app, 'POST', '/bff/tenant-contracts/:fx_hash/submit', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    requireMfa(u, b.totp_code);
    const domain = String(b.domain_name ?? '').toLowerCase().trim();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(domain)) throw E.invalid('domain_name không hợp lệ');
    const domain_type = domain.includes('.') ? 'C' : 'S';
    const domain_primary = domain_type === 'S' ? `${domain}.${process.env.ROOT_DOMAIN ?? 'dropbuy.local'}` : domain;
    if (await prisma.tenant.findUnique({ where: { domain_primary } })) throw E.conflict('Tên miền đã được sử dụng');
    const qty = Number(b.product_quantity ?? 100);
    const setup = SETUP_FEE();
    const monthly = MONTHLY_FEE(qty);
    const out = await prisma.$transaction(async (tx) => {
      const t = await tx.tenant.create({ data: { fx_hash: hex(16), code: slugify(domain).replace(/-/g, '').slice(0, 12).toUpperCase() || code('T'), name: String(b.site_name ?? domain), domain_primary, owner_user_id: u.id, product_quantity_limit: qty, public_good_price: false } });
      const now = new Date();
      const c = await tx.tenantContract.create({
        data: { code: code('HDW'), tenant_id: t.id, contract_type: 'T', domain_type, domain_name: domain, product_quantity: qty, one_time_setup_fee: setup, amount: monthly, from_date: now, to_date: new Date(now.getTime() + 30 * 86400_000), last_subscription_date: now, last_subscription_amount: setup.plus(monthly),
          domain_dns_config: domain_type === 'C' ? JSON.stringify({ username: b.domain_dns_config_username, url: b.domain_dns_config_url, notes: b.domain_dns_config_notes }) : null },
      });
      await post(tx, u.id, 'A', setup.plus(monthly).neg(), { business_code: 'TENANT_CONTRACT', ref_code: c.code, notes: `Mở website ${domain_primary}` });
      return { t, c };
    });
    return { ...(await contractOut(out.c)), tenant: tenantOut(out.t) };
  });
  const ownContract = async (req: Req) => {
    const { tenant: t, user } = await requireTenantOwner(req);
    const c = await prisma.tenantContract.findUnique({ where: { code: String(body(req).code ?? '') } });
    if (!c || c.tenant_id !== t.id) throw E.notFound('Hợp đồng website');
    return { t, user, c };
  };
  route(app, 'POST', '/bff/tenant-contracts/:fx_hash/extend-product-quantity', async (req) => {
    const { t, user, c } = await ownContract(req);
    const qty = Number(body(req).product_quantity);
    if (!Number.isInteger(qty) || qty <= c.product_quantity) throw E.invalid('product_quantity mới phải lớn hơn hiện tại');
    const days = Math.max(1, Math.ceil((c.to_date.getTime() - Date.now()) / 86400_000));
    const diff = MONTHLY_FEE(qty).minus(c.amount).mul(days).div(30).toDecimalPlaces(0);
    const up = await prisma.$transaction(async (tx) => {
      if (diff.gt(0)) await post(tx, user.id, 'A', diff.neg(), { business_code: 'TENANT_CONTRACT', business_sub_code: 'EXTEND_QTY', ref_code: c.code });
      await tx.tenant.update({ where: { id: t.id }, data: { product_quantity_limit: qty } });
      return tx.tenantContract.update({ where: { id: c.id }, data: { product_quantity: qty, amount: MONTHLY_FEE(qty) } });
    });
    return contractOut(up);
  });
  route(app, 'POST', '/bff/tenant-contracts/:fx_hash/buy-gg-sso', async (req) => {
    const { t, user, c } = await ownContract(req);
    if (t.gg_sso_enabled) throw E.business('Website đã bật đăng nhập Google');
    await prisma.$transaction(async (tx) => {
      await post(tx, user.id, 'A', GG_SSO_FEE().neg(), { business_code: 'TENANT_CONTRACT', business_sub_code: 'GG_SSO', ref_code: c.code });
      await tx.tenant.update({ where: { id: t.id }, data: { gg_sso_enabled: true } });
    });
    return contractOut(c);
  });
  route(app, 'POST', '/bff/tenant-contracts/:fx_hash/change-renew-status', async (req) => {
    const { c } = await ownContract(req);
    return contractOut(await prisma.tenantContract.update({ where: { id: c.id }, data: { auto_renew: isT(body(req).renew_status ?? body(req).status) } }));
  });
  route(app, 'POST', '/bff/tenant-contracts/:fx_hash/list', async (req) => {
    const u = await requireUser(req);
    const b = input(req);
    const p = paging(b);
    const tenants = (await prisma.tenant.findMany({ where: { owner_user_id: u.id }, select: { id: true } })).map((t) => t.id);
    const where: Prisma.TenantContractWhereInput = { tenant_id: { in: tenants }, ...(opt(b.status) ? { status: String(b.status) } : {}), ...(opt(b.domain_type) ? { domain_type: String(b.domain_type) } : {}), ...(opt(b.keyword) ? { domain_name: { contains: String(b.keyword) } } : {}) };
    const [total, rows] = await Promise.all([prisma.tenantContract.count({ where }), prisma.tenantContract.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await Promise.all(rows.map(contractOut)));
  });

  // ── AAP: shop đăng ký tự động hiển thị sp trên website con (trả phí tháng cho chủ website) ──
  const aapOut = async (rows: Awaited<ReturnType<typeof prisma.tenantAapContract.findMany>>) => {
    const shops = await prisma.shop.findMany({ where: { id: { in: rows.map((r) => r.shop_id) } } });
    const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.user_id) } } });
    const tenants = await prisma.tenant.findMany({ where: { id: { in: rows.map((r) => r.tenant_id) } } });
    return rows.map((r) => {
      const u = users.find((x) => x.id === r.user_id);
      return { code: r.code, tenant_id: r.tenant_id, user_id: r.user_id, shop_id: r.shop_id, from_date: r.from_date, to_date: r.to_date, status: r.to_date < new Date() && r.status === 'A' ? 'E' : r.status, renew_status: r.auto_renew ? 'T' : 'F', last_subscription_date: r.last_subscription_date, last_subscription_amount: r.last_subscription_amount, created_at: r.created_at, shop_name: shops.find((s) => s.id === r.shop_id)?.display_name, username: u?.username, fullname: u?.fullname, phone: u?.phone, domain_primary: tenants.find((t) => t.id === r.tenant_id)?.domain_primary };
    });
  };
  route(app, 'POST', '/bff/tenant-aap-contracts/:fx_hash/submit', async (req) => {
    const { shop, user } = await requireShop(req);
    const t = await tenantOf(req);
    if (!t.owner_user_id || t.id === 1) throw E.business('Chỉ đăng ký được với website con');
    const fee = AAP_FEE();
    const now = new Date();
    const c = await prisma.$transaction(async (tx) => {
      const existing = await tx.tenantAapContract.findUnique({ where: { tenant_id_shop_id: { tenant_id: t.id, shop_id: shop.id } } });
      const from = existing && existing.to_date > now && existing.status === 'A' ? existing.to_date : now;
      const data = { from_date: existing?.status === 'A' ? existing.from_date : now, to_date: new Date(from.getTime() + 30 * 86400_000), status: 'A', last_subscription_date: now, last_subscription_amount: fee, amount: fee, auto_renew: isT(body(req).renew_status) };
      const c = existing ? await tx.tenantAapContract.update({ where: { id: existing.id }, data }) : await tx.tenantAapContract.create({ data: { ...data, code: code('AAP'), tenant_id: t.id, shop_id: shop.id, user_id: user.id } });
      await post(tx, user.id, 'A', fee.neg(), { business_code: 'TENANT_AAP', ref_code: c.code });
      await post(tx, t.owner_user_id!, 'A', fee, { business_code: 'TENANT_AAP', ref_code: c.code });
      // Tự động theo dõi shop → sp của shop hiện trên website con
      await tx.tenantFollowShop.upsert({ where: { tenant_id_shop_id: { tenant_id: t.id, shop_id: shop.id } }, create: { tenant_id: t.id, shop_id: shop.id }, update: {} });
      return c;
    });
    return (await aapOut([c]))[0];
  });
  route(app, 'POST', '/bff/tenant-aap-contracts/:fx_hash/change-renew-status', async (req) => {
    const { shop } = await requireShop(req);
    const t = await tenantOf(req);
    const c = await prisma.tenantAapContract.findUnique({ where: { tenant_id_shop_id: { tenant_id: t.id, shop_id: shop.id } } });
    if (!c) throw E.notFound('Hợp đồng AAP');
    return (await aapOut([await prisma.tenantAapContract.update({ where: { id: c.id }, data: { auto_renew: isT(body(req).renew_status) } })]))[0];
  });
  const aapList = (side: 'shop' | 'owner') => async (req: Req) => {
    const b = input(req);
    const p = paging(b);
    const where: Prisma.TenantAapContractWhereInput = side === 'shop' ? { shop_id: (await requireShop(req)).shop.id } : { tenant_id: (await requireTenantOwner(req)).tenant.id };
    if (opt(b.status)) where.status = String(b.status);
    const [total, rows] = await Promise.all([prisma.tenantAapContract.count({ where }), prisma.tenantAapContract.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await aapOut(rows));
  };
  route(app, 'POST', '/bff/tenant-aap-contracts/:fx_hash/list-for-shop', aapList('shop'));
  route(app, 'POST', '/bff/tenant-aap-contracts/:fx_hash/list-for-tenant-owner', aapList('owner'));

  // ── Theo dõi shop (toàn bộ sp của shop lên website) ──
  route(app, 'PUT', '/bff/tenant-follow-shop/:fx_hash/follow', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const shop_id = Number(body(req).shop_id);
    if (!(await prisma.shop.findUnique({ where: { id: shop_id } }))) throw E.notFound('Gian hàng');
    await prisma.tenantFollowShop.upsert({ where: { tenant_id_shop_id: { tenant_id: t.id, shop_id } }, create: { tenant_id: t.id, shop_id }, update: {} });
    return null;
  });
  route(app, 'PUT', '/bff/tenant-follow-shop/:fx_hash/un-follow', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const b = body(req);
    const shop_id = Number(b.shop_id);
    await prisma.tenantFollowShop.deleteMany({ where: { tenant_id: t.id, shop_id } });
    if (isT(b.also_delete_product)) {
      const pids = (await prisma.product.findMany({ where: { shop_id }, select: { id: true } })).map((p) => p.id);
      await prisma.tenantProduct.deleteMany({ where: { tenant_id: t.id, product_id: { in: pids } } });
    }
    return null;
  });
  route(app, 'POST', '/bff/tenant-follow-shop/:fx_hash/list', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const b = body(req);
    const p = paging(b);
    const where: Prisma.TenantFollowShopWhereInput = { tenant_id: t.id, ...(b.shop_ids ? { shop_id: { in: arr<number>(b.shop_ids).map(Number) } } : {}) };
    const [total, rows] = await Promise.all([prisma.tenantFollowShop.count({ where }), prisma.tenantFollowShop.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    const shops = await prisma.shop.findMany({ where: { id: { in: rows.map((r) => r.shop_id) } } });
    return paged(p, total, rows.map((r) => ({ unique_id: r.unique_id, tenant_id: r.tenant_id, shop_id: r.shop_id, tenant_biz_user_id: t.owner_user_id, created_at: r.created_at, shop_name: shops.find((s) => s.id === r.shop_id)?.display_name })));
  });

  // ── Sản phẩm trên website con ──
  const ensureQuota = async (t: Tenant, adding: number) => {
    if (!t.product_quantity_limit) return;
    const cur = await prisma.tenantProduct.count({ where: { tenant_id: t.id } });
    if (cur + adding > t.product_quantity_limit) throw E.business(`Vượt hạn mức ${t.product_quantity_limit} sản phẩm của hợp đồng website – nâng cấp qua extend-product-quantity`);
  };
  const tpOut = async (t: Tenant, rows: Awaited<ReturnType<typeof prisma.tenantProduct.findMany>>) => {
    const ps = await prisma.product.findMany({ where: { id: { in: rows.map((r) => r.product_id) } } });
    const cards = await productCards(ps);
    return rows.map((r) => {
      const c = cards.find((x) => x.product_id === r.product_id);
      const p = ps.find((x) => x.id === r.product_id);
      return { tenant_id: t.id, product_id: r.product_id, status: r.status, commission: r.commission, num: r.num, home_status: r.home_status, product_name: c?.name, shop_id: c?.shop_id, shop_name: c?.shop_name, price_public: c?.price_public, price_f1: c?.price_f1, res_thumbnail_url: c?.res_thumbnail_url, bought_count: p?.sold_count, view_count: p?.view_count, storage_id: 6, created_at: r.created_at };
    });
  };
  route(app, 'POST', '/bff/tenant-products/:fx_hash/ensure', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const items = arr<{ product_id: number; status?: string; commission?: number; num?: number; home_status?: string }>(body(req).items);
    const news = await prisma.tenantProduct.count({ where: { tenant_id: t.id, product_id: { in: items.map((i) => Number(i.product_id)) } } });
    await ensureQuota(t, items.length - news);
    for (const i of items) {
      const p = await prisma.product.findUnique({ where: { id: Number(i.product_id) } });
      if (!p || p.admin_status !== 'A') throw E.notFound(`Sản phẩm ${i.product_id}`);
      const data = { status: i.status ?? 'A', commission: new Decimal(i.commission ?? 0), num: Number(i.num ?? 0), home_status: i.home_status ?? 'N' };
      await prisma.tenantProduct.upsert({ where: { tenant_id_product_id: { tenant_id: t.id, product_id: p.id } }, create: { ...data, tenant_id: t.id, product_id: p.id }, update: data });
    }
    return tpOut(t, await prisma.tenantProduct.findMany({ where: { tenant_id: t.id, product_id: { in: items.map((i) => Number(i.product_id)) } } }));
  });
  // Thêm toàn bộ (hoặc 1 phần) sp của các shop đang theo dõi; chạy nền
  route(app, 'POST', '/bff/tenant-products/:fx_hash/ensure-from-shop', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const b = body(req);
    const ids = arr<number>(b.product_ids).map(Number);
    await ensureQuota(t, ids.length);
    const job = await prisma.asyncJob.create({ data: { id: `tp-${t.id}-${hex(4)}`, kind: 'TENANT_ENSURE_FROM_SHOP' } });
    setImmediate(async () => {
      let n = 0;
      for (const pid of ids) {
        await prisma.tenantProduct.upsert({ where: { tenant_id_product_id: { tenant_id: t.id, product_id: pid } }, create: { tenant_id: t.id, product_id: pid, home_status: b.home_status ?? 'N' }, update: { home_status: b.home_status ?? undefined } });
        n++;
      }
      await prisma.asyncJob.update({ where: { id: job.id }, data: { status: 'D', result: JSON.stringify({ added: n }) } });
    });
    return { job_id: job.id, status: job.status };
  });
  route(app, 'POST', '/bff/tenant-products/:fx_hash/ensure-from-shop-get-status', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const job = await prisma.asyncJob.findFirst({ where: { id: { startsWith: `tp-${t.id}-` } }, orderBy: { created_at: 'desc' } });
    return job ? { job_id: job.id, status: job.status, result: job.result ? JSON.parse(job.result) : null } : null;
  });
  route(app, 'POST', '/bff/tenant-products/:fx_hash/update-status', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const b = body(req);
    const r = await prisma.tenantProduct.updateMany({ where: { tenant_id: t.id, product_id: { in: arr<number>(b.product_ids ?? b.product_id).map(Number) } }, data: { status: b.status ?? undefined, home_status: b.home_status ?? undefined } });
    return { updated: r.count };
  });
  route(app, 'POST', '/bff/tenant-products/:fx_hash/delete', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    await prisma.tenantProduct.deleteMany({ where: { tenant_id: t.id, product_id: Number(body(req).product_id) } });
    return null;
  });
  route(app, 'POST', '/bff/tenant-products/:fx_hash/delete-batch', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const r = await prisma.tenantProduct.deleteMany({ where: { tenant_id: t.id, product_id: { in: arr<number>(body(req).product_ids).map(Number) } } });
    return { deleted: r.count };
  });
  const tpSearch = async (req: Req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const b = body(req);
    const p = paging(b);
    const where: Prisma.TenantProductWhereInput = { tenant_id: t.id, ...(opt(b.status) ? { status: String(b.status) } : {}), ...(opt(b.home_status) ? { home_status: String(b.home_status) } : {}) };
    if (opt(b.keyword) || opt(b.shop_id)) {
      where.product_id = { in: (await prisma.product.findMany({ where: { ...(opt(b.keyword) ? { name: { contains: String(b.keyword) } } : {}), ...(opt(b.shop_id) ? { shop_id: Number(b.shop_id) } : {}) }, select: { id: true } })).map((x) => x.id) };
    }
    const [total, rows] = await Promise.all([prisma.tenantProduct.count({ where }), prisma.tenantProduct.findMany({ where, orderBy: [{ num: 'asc' }, { id: 'desc' }], skip: p.skip, take: p.take })]);
    return paged(p, total, await tpOut(t, rows));
  };
  route(app, 'POST', '/bff/tenant-products/:fx_hash/list', tpSearch);
  route(app, 'POST', '/bff/tenant-products/:fx_hash/tenant-owner-search', tpSearch);
  // Tìm trong kho sp toàn sàn để chọn đưa lên website con
  route(app, 'POST', '/bff/tenant-products/:fx_hash/tenant-owner-search-for-homepage', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const b = body(req);
    const p = paging(b);
    const where: Prisma.ProductWhereInput = { status: 'A', admin_status: 'A', ...(opt(b.keyword) ? { name: { contains: String(b.keyword) } } : {}), ...(opt(b.category_id) ? { category_id: Number(b.category_id) } : {}), ...(opt(b.shop_id) ? { shop_id: Number(b.shop_id) } : {}), ...(isT(b.aff_enabled) ? { aff_enabled: true } : {}) };
    const [total, rows] = await Promise.all([prisma.product.count({ where }), prisma.product.findMany({ where, orderBy: { sold_count: 'desc' }, skip: p.skip, take: p.take })]);
    const added = new Set((await prisma.tenantProduct.findMany({ where: { tenant_id: t.id, product_id: { in: rows.map((r) => r.id) } } })).map((x) => x.product_id));
    return paged(p, total, (await productCards(rows)).map((c) => ({ ...c, added_to_tenant: added.has(c.product_id) })));
  });

  // ── Trang chủ website con: sp nổi bật ──
  route(app, 'GET', '/bff/tenant-owners/tenant-home-configs/:fx_hash/list', async (req) => {
    const t = await tenantOf(req);
    const rows = await prisma.tenantProduct.findMany({ where: { tenant_id: t.id, home_status: 'H', status: 'A' }, orderBy: { num: 'asc' } });
    const ps = await prisma.product.findMany({ where: { id: { in: rows.map((r) => r.product_id) } } });
    return rows.map((r) => {
      const p = ps.find((x) => x.id === r.product_id);
      return { tenant_id: t.id, product_id: r.product_id, num: r.num, home_status: r.home_status, created_at: r.created_at, product_name: p?.name, res_thumbnail_url: p?.thumbnail_url, slug: p?.slug, unique_id: p?.unique_id };
    });
  });
  route(app, 'POST', '/bff/tenant-owners/tenant-home-configs/:fx_hash/ensure', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const b = body(req);
    const pid = Number(b.product_id);
    const exist = await prisma.tenantProduct.findUnique({ where: { tenant_id_product_id: { tenant_id: t.id, product_id: pid } } });
    if (!exist) await ensureQuota(t, 1);
    await prisma.tenantProduct.upsert({ where: { tenant_id_product_id: { tenant_id: t.id, product_id: pid } }, create: { tenant_id: t.id, product_id: pid, num: Number(b.num ?? 0), home_status: String(b.home_status ?? 'H') }, update: { num: Number(b.num ?? 0), home_status: String(b.home_status ?? 'H') } });
    return null;
  });
  route(app, 'POST', '/bff/tenant-owners/tenant-home-configs/:fx_hash/remove', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    await prisma.tenantProduct.updateMany({ where: { tenant_id: t.id, product_id: Number(body(req).product_id) }, data: { home_status: 'N' } });
    return null;
  });

  // ── Quản trị của chủ website ──
  route(app, 'PUT', '/bff/tenant-owners/:fx_hash/block-shop', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const shop_id = Number(body(req).shop_id);
    await prisma.tenantBlockShop.upsert({ where: { tenant_id_shop_id: { tenant_id: t.id, shop_id } }, create: { tenant_id: t.id, shop_id }, update: {} });
    return null;
  });
  route(app, 'PUT', '/bff/tenant-owners/:fx_hash/unblock-shop', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    await prisma.tenantBlockShop.deleteMany({ where: { tenant_id: t.id, shop_id: Number(body(req).shop_id) } });
    return null;
  });

  // Shop đang bán trên website (theo dõi hoặc có sp trên site)
  route(app, 'GET', '/bff/tenant-owners/shops/:fx_hash/list', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const q = query(req);
    const p = paging(q);
    const followed = (await prisma.tenantFollowShop.findMany({ where: { tenant_id: t.id } })).map((f) => f.shop_id);
    const viaProducts = (await prisma.product.findMany({ where: { id: { in: (await prisma.tenantProduct.findMany({ where: { tenant_id: t.id } })).map((x) => x.product_id) } }, select: { shop_id: true } })).map((x) => x.shop_id);
    const blocked = new Set((await prisma.tenantBlockShop.findMany({ where: { tenant_id: t.id } })).map((b) => b.shop_id));
    const where: Prisma.ShopWhereInput = { id: { in: [...new Set([...followed, ...viaProducts])] }, ...(opt(q.keyword) ? { display_name: { contains: String(q.keyword) } } : {}) };
    const [total, rows] = await Promise.all([prisma.shop.count({ where }), prisma.shop.findMany({ where, skip: p.skip, take: p.take })]);
    return paged(p, total, rows.map((s) => ({ ...shopOut(s), tenant_block_shop_status: blocked.has(s.id) ? 'B' : 'A', followed: followed.includes(s.id) })));
  });
  route(app, 'POST', '/bff/tenant-owners/shops/:fx_hash/change-admin-status', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const b = body(req);
    // Với chủ website con: "khoá" = chặn shop trên site của mình
    if (t.id !== 1) {
      if (b.admin_status === 'L') await prisma.tenantBlockShop.upsert({ where: { tenant_id_shop_id: { tenant_id: t.id, shop_id: Number(b.shop_id) } }, create: { tenant_id: t.id, shop_id: Number(b.shop_id) }, update: {} });
      else await prisma.tenantBlockShop.deleteMany({ where: { tenant_id: t.id, shop_id: Number(b.shop_id) } });
      return null;
    }
    await prisma.shop.update({ where: { id: Number(b.shop_id) }, data: { admin_status: String(b.admin_status) } });
    return null;
  });
  route(app, 'POST', '/bff/tenant-owners/shops/:fx_hash/enable-mall', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    if (t.id !== 1) throw E.forbidden('Chỉ website gốc gắn nhãn Mall');
    const b = body(req);
    await prisma.shop.update({ where: { id: Number(b.shop_id) }, data: { is_mall: isT(b.enable) } });
    await prisma.product.updateMany({ where: { shop_id: Number(b.shop_id) }, data: { is_mall: isT(b.enable) } });
    return null;
  });

  // Duyệt / khoá sp trên website con (website gốc: duyệt sàn)
  route(app, 'GET', '/bff/tenant-owners/products/:fx_hash/list', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const q = query(req);
    const p = paging(q);
    const where: Prisma.ProductWhereInput = { status: { not: 'X' }, ...(opt(q.admin_status) ? { admin_status: String(q.admin_status) } : {}), ...(opt(q.shop_id) ? { shop_id: Number(q.shop_id) } : {}), ...(opt(q.keyword) ? { name: { contains: String(q.keyword) } } : {}) };
    if (t.id !== 1) where.id = { in: (await prisma.tenantProduct.findMany({ where: { tenant_id: t.id } })).map((x) => x.product_id) };
    const [total, rows] = await Promise.all([prisma.product.count({ where }), prisma.product.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await Promise.all(rows.map((r) => productDetail(r, { withAdmin: true }))));
  });
  const productDecision = (admin_status: 'A' | 'L') => async (req: Req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const b = body(req);
    const pid = Number(b.product_id);
    if (t.id === 1) await prisma.product.update({ where: { id: pid }, data: { admin_status, admin_comment: b.admin_comment ?? null, admin_updated_at: new Date() } });
    else await prisma.tenantProduct.updateMany({ where: { tenant_id: t.id, product_id: pid }, data: { status: admin_status === 'A' ? 'A' : 'H' } });
    return null;
  };
  route(app, 'PUT', '/bff/tenant-owners/products/:fx_hash/approve', productDecision('A'));
  route(app, 'PUT', '/bff/tenant-owners/products/:fx_hash/lock', productDecision('L'));

  route(app, 'POST', '/bff/tenant-owners/users/:fx_hash/list', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const b = body(req);
    const p = paging(b);
    const where: Prisma.UserWhereInput = { tenant_id: t.id, ...(opt(b.status) ? { status: String(b.status) } : {}), ...(opt(b.user_id) ? { id: Number(b.user_id) } : {}), ...(opt(b.keyword) ? { OR: [{ username: { contains: String(b.keyword) } }, { phone: { contains: String(b.keyword) } }, { email: { contains: String(b.keyword) } }] } : {}) };
    const [total, rows] = await Promise.all([prisma.user.count({ where }), prisma.user.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, rows.map((u) => ({ user_id: u.id, username: u.username, link_fb: u.link_fb, fullname: u.fullname, default_address: u.default_address, cccd: u.cccd, status: u.status, bank_ref_user_code: u.bank_ref_user_code, created_at: u.created_at, updated_at: u.updated_at, email: u.email, phone: u.phone, level: u.user_level, parent_user_id: u.parent_user_id })));
  });
  route(app, 'POST', '/bff/tenant-owners/users/:fx_hash/lock', async (req) => {
    const { tenant: t, user } = await requireTenantOwner(req);
    const b = body(req);
    const u = await prisma.user.findUnique({ where: { id: Number(b.user_id) } });
    if (!u || u.tenant_id !== t.id || u.id === user.id || u.is_sa) throw E.notFound('Tài khoản');
    await prisma.user.update({ where: { id: u.id }, data: { status: isT(b.locked) ? 'L' : 'A' } });
    return null;
  });

  route(app, 'POST', '/bff/tenant-owners/orders/:fx_hash/list', async (req) => {
    const { tenant: t } = await requireTenantOwner(req);
    const b = body(req);
    const p = paging(b);
    const where: Prisma.OrderWhereInput = { tenant_id: t.id, ...orderFilter(b) };
    const [total, rows] = await Promise.all([prisma.order.count({ where }), prisma.order.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await orderRows(rows));
  });
  // Chủ website huỷ đơn trên site của mình (vd đơn ảo/bom) – chỉ khi shop chưa giao vận chuyển
  route(app, 'POST', '/bff/tenant-owners/orders/:fx_hash/mark-cancel', async (req) => {
    const { tenant: t, user } = await requireTenantOwner(req);
    const b = body(req);
    const o = await prisma.order.findFirst({ where: { OR: [{ unique_id: String(b.unique_id ?? '') }, { id: Number(b.order_id) || -1 }] } });
    if (!o || o.tenant_id !== t.id) throw E.notFound('Đơn hàng');
    if (!['U', 'P', 'O', 'W', 'G'].includes(o.order_status)) throw E.business('Đơn đã bàn giao vận chuyển');
    const x = await transition(o.id, 'C', { kind: 'T', id: user.id }, { notes: b.notes ?? 'Chủ website huỷ' });
    return { order_id: x.id, order_status: x.order_status };
  });

  void uuid;
}
