// Marketing: voucher (shop & sàn), flash sale (chương trình + suất), hợp đồng dịch vụ (flash-sale / buff / follow), vị trí hiển thị (bid).
import type { FastifyInstance } from 'fastify';
import type { Prisma, Voucher, Shop, User } from '@prisma/client';
import { prisma, Decimal } from '../lib/db.js';
import { E, isT } from '../lib/http.js';
import { route, body, params, input, arr, type Req } from '../lib/router.js';
import { requireShop, requireSA, requireTenantOwner, tenantOf, currentUser, requireMfa } from '../lib/auth.js';
import { paging, paged, opt } from '../lib/paging.js';
import { uuid, code, fsCode } from '../lib/ids.js';
import { post } from '../lib/balance.js';

// ───────────── Voucher ─────────────

async function voucherOut(v: Voucher) {
  return {
    voucher_id: v.id, tenant_id: v.tenant_id, owner_type: v.scope === 'S' ? 'SHOP' : 'TENANT', shop_id: v.shop_id, owner_user_id: v.owner_user_id,
    code: v.code, name: v.name, voucher_kind: v.voucher_kind, discount_type: v.discount_type, discount_value: v.discount_value, max_discount_amount: v.max_discount,
    min_order_amount: v.min_order_amount, scope: v.scope, display_type: v.display_type, max_quantity: v.quantity, used_quantity: v.used_quantity, per_user_limit: v.per_user_limit,
    budget_amount: v.budget_amount, used_amount: v.used_amount, from_time: v.from_time, to_time: v.to_time, status: v.status, created_at: v.created_at,
    products: JSON.parse(v.products), product_count: JSON.parse(v.products).length,
  };
}

function voucherData(b: Record<string, any>, partial = false): Prisma.VoucherUncheckedUpdateInput {
  const d: Prisma.VoucherUncheckedUpdateInput = {};
  if (!partial) for (const k of ['discount_type', 'discount_value', 'max_quantity', 'from_time', 'to_time']) if (b[k] == null) throw E.invalid(`Thiếu ${k}`);
  if (b.name != null) d.name = String(b.name);
  if (b.voucher_kind != null) d.voucher_kind = b.voucher_kind === 'S' ? 'S' : 'C';
  if (b.discount_type != null) {
    if (!['A', 'P'].includes(b.discount_type)) throw E.invalid('discount_type: A (số tiền) hoặc P (%)');
    d.discount_type = b.discount_type;
  }
  if (b.discount_value != null) {
    const v = new Decimal(b.discount_value);
    if (v.lte(0) || (b.discount_type === 'P' && v.gt(100))) throw E.invalid('discount_value không hợp lệ');
    d.discount_value = v;
  }
  if (b.max_discount_amount !== undefined) d.max_discount = b.max_discount_amount == null ? null : new Decimal(b.max_discount_amount);
  if (b.min_order_amount != null) d.min_order_amount = new Decimal(b.min_order_amount);
  if (b.display_type != null) d.display_type = String(b.display_type);
  if (b.max_quantity != null) d.quantity = Number(b.max_quantity);
  if (b.per_user_limit != null) d.per_user_limit = Number(b.per_user_limit);
  if (b.budget_amount !== undefined) d.budget_amount = b.budget_amount == null ? null : new Decimal(b.budget_amount);
  if (b.from_time != null) d.from_time = new Date(b.from_time);
  if (b.to_time != null) d.to_time = new Date(b.to_time);
  if (b.products != null) d.products = JSON.stringify(arr(b.products));
  return d;
}

const ACTIONS: Record<string, { from: string[]; to: string }> = {
  activate: { from: ['D'], to: 'A' }, resume: { from: ['D'], to: 'A' }, pause: { from: ['A'], to: 'D' }, end: { from: ['A', 'D'], to: 'E' }, delete: { from: ['A', 'D', 'E'], to: 'X' },
};

function voucherRoutes(app: FastifyInstance, base: string, owner: (req: Req) => Promise<{ scope: 'S' | 'T'; shop_id: number | null; tenant_id: number; user: User; shop?: Shop; prefix: string }>) {
  route(app, 'GET', `${base}/:fx_hash/feature-info`, async (req) => {
    const o = await owner(req);
    const products = o.scope === 'S' ? await prisma.product.count({ where: { shop_id: o.shop_id!, status: 'A', admin_status: 'A' } }) : await prisma.product.count({ where: { status: 'A', admin_status: 'A' } });
    const required = o.scope === 'S' ? 5 : 0;
    return { enabled: products >= required, owner_type: o.scope === 'S' ? 'SHOP' : 'TENANT', product_quantity: products, required_product_quantity: required, code_prefix: o.prefix, code_suffix_max_length: 10, message: products >= required ? null : `Cần tối thiểu ${required} sản phẩm đang bán để tạo mã` };
  });

  route(app, 'POST', `${base}/:fx_hash/create`, async (req) => {
    const o = await owner(req);
    const b = body(req);
    const suffix = String(b.code ?? code('V').slice(-6)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    const full = suffix.startsWith(o.prefix) ? suffix : `${o.prefix}${suffix}`;
    const d = voucherData(b) as Prisma.VoucherUncheckedCreateInput;
    if ((d.from_time as Date) >= (d.to_time as Date)) throw E.invalid('from_time phải trước to_time');
    const v = await prisma.voucher.create({
      data: { ...d, code: full, name: String(b.name ?? full), scope: o.scope, shop_id: o.shop_id, tenant_id: o.tenant_id, owner_user_id: o.user.id, status: b.activate === false || b.activate === 'F' ? 'D' : 'A' },
    });
    return voucherOut(v);
  });

  const mine = async (req: Req, id: unknown) => {
    const o = await owner(req);
    const v = await prisma.voucher.findUnique({ where: { id: Number(id) } });
    if (!v || v.scope !== o.scope || (o.scope === 'S' ? v.shop_id !== o.shop_id : v.tenant_id !== o.tenant_id) || v.status === 'X') throw E.notFound('Voucher');
    return v;
  };

  route(app, 'POST', `${base}/:fx_hash/update`, async (req) => {
    const b = body(req);
    const v = await mine(req, b.voucher_id);
    // Đã có lượt dùng → chỉ cho sửa tên, số lượng, thời gian kết thúc
    const d = voucherData(b, true);
    if (v.used_quantity > 0) for (const k of ['discount_type', 'discount_value', 'min_order_amount', 'voucher_kind', 'from_time'] as const) delete d[k];
    if (d.quantity != null && Number(d.quantity) < v.used_quantity) throw E.invalid('max_quantity nhỏ hơn số lượt đã dùng');
    return voucherOut(await prisma.voucher.update({ where: { id: v.id }, data: d }));
  });

  route(app, 'POST', `${base}/:fx_hash/change-status`, async (req) => {
    const b = body(req);
    const v = await mine(req, b.voucher_id);
    const a = ACTIONS[String(b.action)];
    if (!a) throw E.invalid('action: activate | pause | resume | end | delete');
    if (!a.from.includes(v.status)) throw E.badTransition(v.status, a.to);
    return voucherOut(await prisma.voucher.update({ where: { id: v.id }, data: { status: a.to } }));
  });

  route(app, 'POST', `${base}/:fx_hash/list`, async (req) => {
    const o = await owner(req);
    const b = input(req);
    const p = paging(b);
    const where: Prisma.VoucherWhereInput = { scope: o.scope, status: { not: 'X' }, ...(o.scope === 'S' ? { shop_id: o.shop_id } : { tenant_id: o.tenant_id }) };
    if (opt(b.status)) where.status = String(b.status);
    if (opt(b.keyword)) where.OR = [{ code: { contains: String(b.keyword) } }, { name: { contains: String(b.keyword) } }];
    const [total, rows] = await Promise.all([prisma.voucher.count({ where }), prisma.voucher.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await Promise.all(rows.map(voucherOut)));
  });

  route(app, 'GET', `${base}/:fx_hash/detail/:voucher_id`, async (req) => {
    const v = await mine(req, params(req).voucher_id);
    const usage = await prisma.voucherUsage.findMany({ where: { voucher_id: v.id } });
    const orders = await prisma.order.findMany({ where: { id: { in: usage.map((u) => u.order_id) } }, select: { id: true, commodity_amount: true, order_status: true } });
    return {
      voucher: await voucherOut(v),
      report: { order_count: usage.length, discount_amount: usage.reduce((a, u) => a.plus(u.amount), new Decimal(0)), revenue: orders.filter((x) => x.order_status !== 'C').reduce((a, x) => a.plus(x.commodity_amount), new Decimal(0)) },
    };
  });
}

// ───────────── Hợp đồng dịch vụ ─────────────

const RATE: Record<string, { N: number; V: number }> = { FS: { N: 10000, V: 20000 }, B: { N: 15000, V: 30000 }, F: { N: 8000, V: 16000 } };
const quote = (kind: string, type: string, days: number) => new Decimal((RATE[kind] ?? RATE.FS)[type === 'V' ? 'V' : 'N']).mul(days);

async function contractOut(c: Awaited<ReturnType<typeof prisma.serviceContract.findFirstOrThrow>>) {
  return {
    contract_id: c.id, unique_id: c.code, code: c.code, contract_code: c.code, kind: c.kind, contract_type: c.contract_type, tenant_id: c.tenant_id, biz_user_id: c.shop_user_id,
    shop_id: c.shop_id, shop_user_id: c.shop_user_id, from_date: c.from_date, to_date: c.to_date, contract_duration: c.contract_duration,
    rent_rate: (RATE[c.kind] ?? RATE.FS)[c.contract_type === 'V' ? 'V' : 'N'], rent_amount: c.amount, created_at: c.created_at, status: c.to_date < new Date() && c.status === 'A' ? 'E' : c.status,
    auto_generate_next_contract: c.auto_generate_next_contract, renew_status: c.auto_generate_next_contract ? 'T' : 'F', payment_balance_type: 'A',
  };
}

export async function activeContract(shop_id: number, kind: string) {
  const now = new Date();
  return prisma.serviceContract.findFirst({ where: { shop_id, kind, status: 'A', from_date: { lte: now }, to_date: { gt: now } } });
}

function contractRoutes(app: FastifyInstance, base: string, kindOf: (b: Record<string, any>) => string) {
  route(app, 'POST', `${base}/:fx_hash/submit`, async (req) => {
    const { shop, user } = await requireShop(req);
    const tenant = await tenantOf(req);
    const b = body(req);
    requireMfa(user, b.totp_code);
    const kind = kindOf(b);
    const days = Number(b.contract_duration ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw E.invalid('contract_duration 1..365 ngày');
    const type = b.contract_type === 'V' ? 'V' : 'N';
    const amount = quote(kind, type, days);
    // Hợp đồng nối tiếp: bắt đầu sau hợp đồng đang chạy
    const cur = await prisma.serviceContract.findFirst({ where: { shop_id: shop.id, kind, status: 'A', to_date: { gt: new Date() } }, orderBy: { to_date: 'desc' } });
    const from = cur ? cur.to_date : new Date();
    const to = new Date(from.getTime() + days * 86400_000);
    const c = await prisma.$transaction(async (tx) => {
      const c = await tx.serviceContract.create({ data: { code: code(`HD${kind}`), kind, tenant_id: tenant.id, shop_id: shop.id, shop_user_id: user.id, contract_type: type, from_date: from, to_date: to, contract_duration: days, amount, auto_generate_next_contract: isT(b.auto_generate_next_contract) } });
      await post(tx, user.id, 'A', amount.neg(), { business_code: 'CONTRACT_FEE', business_sub_code: kind, ref_code: c.code, notes: `Phí hợp đồng ${c.code}` });
      return c;
    });
    return contractOut(c);
  });
  route(app, 'POST', `${base}/:fx_hash/list`, async (req) => {
    const { shop } = await requireShop(req);
    const b = input(req);
    const p = paging(b);
    const where: Prisma.ServiceContractWhereInput = { shop_id: shop.id, ...(b.kind || base.includes('flash') ? { kind: kindOf(b) } : {}), ...(opt(b.status) ? { status: String(b.status) } : {}) };
    const [total, rows] = await Promise.all([prisma.serviceContract.count({ where }), prisma.serviceContract.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await Promise.all(rows.map(contractOut)));
  });
  route(app, 'POST', `${base}/:fx_hash/update-auto-generate`, async (req) => {
    const { shop } = await requireShop(req);
    const b = body(req);
    const c = await prisma.serviceContract.findFirst({ where: { OR: [{ code: String(b.code ?? '') }, { id: Number(b.contract_id) || -1 }] } });
    if (!c || c.shop_id !== shop.id) throw E.notFound('Hợp đồng');
    const v = b.auto_generate_next_contract ?? b.renew_status;
    return contractOut(await prisma.serviceContract.update({ where: { id: c.id }, data: { auto_generate_next_contract: isT(v) } }));
  });
}

// ───────────── Flash sale ─────────────

async function programOut(p: Awaited<ReturnType<typeof prisma.flashSaleProgram.findFirstOrThrow>>) {
  const [count, sold] = await Promise.all([
    prisma.flashSaleStock.count({ where: { program_code: p.code } }),
    prisma.flashSaleStock.aggregate({ where: { program_code: p.code }, _sum: { sold_quantity: true } }),
  ]);
  const now = new Date();
  return {
    unique_id: p.code, code: p.code, tenant_id: p.tenant_id, shop_id: p.shop_id, name: p.name, body: p.body, banner_image_url: p.banner_image_url,
    from_time: p.from_time, to_time: p.to_time, status: p.status, created_at: p.created_at,
    running: p.status === 'A' && p.from_time <= now && p.to_time > now, item_count: count, sold_quantity: sold._sum.sold_quantity ?? 0,
  };
}

async function stockOut(rows: Awaited<ReturnType<typeof prisma.flashSaleStock.findMany>>) {
  const vs = await prisma.variation.findMany({ where: { id: { in: rows.map((r) => r.variation_id) } } });
  const ps = await prisma.product.findMany({ where: { id: { in: rows.map((r) => r.product_id) } } });
  const progs = await prisma.flashSaleProgram.findMany({ where: { code: { in: [...new Set(rows.map((r) => r.program_code))] } } });
  const st = await prisma.stock.findMany({ where: { variation_id: { in: vs.map((v) => v.id) } } });
  return rows.map((r, i) => {
    const v = vs.find((x) => x.id === r.variation_id);
    const p = ps.find((x) => x.id === r.product_id);
    const pg = progs.find((x) => x.code === r.program_code);
    return {
      unique_id: r.unique_id, program_code: r.program_code, shop_id: r.shop_id, product_id: r.product_id, variation_id: r.variation_id, sku: v?.sku, max_stock: r.quantity, sold_stock: r.sold_quantity,
      stock_limit_to_buyer: r.limit_per_user, price_flash_sale: r.price, created_at: r.created_at, updated_at: r.created_at, status: r.status, product_name: p?.name, variation_name: v?.name,
      current_stock: st.filter((s) => s.variation_id === r.variation_id).reduce((a, s) => a + s.current_stock - s.pending_stock, 0), price_public: v?.price_public, price_f1: v?.price_f1,
      res_thumbnail_url: v?.thumbnail_url ?? p?.thumbnail_url, num: i, from_time: pg?.from_time, to_time: pg?.to_time,
    };
  });
}

/** Ai được sửa chương trình: chủ shop (chương trình của shop) hoặc SA/tenant owner (chương trình sàn). */
async function programAccess(req: Req, codeOrId: unknown) {
  const p = await prisma.flashSaleProgram.findUnique({ where: { code: String(codeOrId ?? '') } });
  if (!p) throw E.notFound('Chương trình flash sale');
  const u = await currentUser(req);
  if (!u) throw E.unauthorized();
  const shop = await prisma.shop.findUnique({ where: { user_id: u.id } });
  const tenant = await prisma.tenant.findUnique({ where: { id: p.tenant_id } });
  const canManage = u.is_sa || (p.shop_id ? shop?.id === p.shop_id : tenant?.owner_user_id === u.id);
  return { p, u, shop, canManage };
}

export default function marketing(app: FastifyInstance) {
  voucherRoutes(app, '/bff/shop-vouchers', async (req) => {
    const { shop, user } = await requireShop(req);
    const tenant = await tenantOf(req);
    return { scope: 'S', shop_id: shop.id, tenant_id: tenant.id, user, shop, prefix: `S${shop.id}` };
  });
  voucherRoutes(app, '/bff/tenant-owners/vouchers', async (req) => {
    const { user, tenant } = await requireTenantOwner(req);
    return { scope: 'T', shop_id: null, tenant_id: tenant.id, user, prefix: tenant.code.slice(0, 6).toUpperCase() };
  });

  contractRoutes(app, '/bff/flash-sale-contracts', () => 'FS');
  contractRoutes(app, '/bff/generic-contracts', (b) => (['B', 'F', 'FS'].includes(String(b.kind)) ? String(b.kind) : b.contract_kind === 'F' ? 'F' : 'B'));
  route(app, 'POST', '/bff/flash-sale-contracts/:fx_hash/preview', async (req) => {
    const b = body(req);
    const days = Number(b.contract_duration ?? 30);
    return { contract_duration: days, contract_type: b.contract_type === 'V' ? 'V' : 'N', rent_rate: RATE.FS[b.contract_type === 'V' ? 'V' : 'N'], rent_amount: quote('FS', String(b.contract_type), days) };
  });

  route(app, 'POST', '/bff/sa/flash-sale-contracts/:fx_hash/list', async (req) => {
    await requireSA(req);
    const b = body(req);
    const p = paging(b);
    const where: Prisma.ServiceContractWhereInput = { ...(opt(b.kind) ? { kind: String(b.kind) } : {}), ...(opt(b.shop_id) ? { shop_id: Number(b.shop_id) } : {}), ...(opt(b.status) ? { status: String(b.status) } : {}) };
    const [total, rows] = await Promise.all([prisma.serviceContract.count({ where }), prisma.serviceContract.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await Promise.all(rows.map(contractOut)));
  });
  route(app, 'POST', '/bff/sa/flash-sale-contracts/:fx_hash/cancel', async (req) => {
    await requireSA(req);
    const b = body(req);
    const c = await prisma.serviceContract.findUnique({ where: { code: String(b.code ?? '') } });
    if (!c || c.status !== 'A') throw E.notFound('Hợp đồng đang hiệu lực');
    // Hoàn phí theo số ngày chưa dùng
    const now = Date.now();
    const remainDays = Math.max(0, Math.floor((c.to_date.getTime() - Math.max(now, c.from_date.getTime())) / 86400_000));
    const refund = c.amount.mul(remainDays).div(c.contract_duration).toDecimalPlaces(0);
    const up = await prisma.$transaction(async (tx) => {
      if (refund.gt(0)) await post(tx, c.shop_user_id, 'A', refund, { business_code: 'CONTRACT_REFUND', ref_code: c.code });
      return tx.serviceContract.update({ where: { id: c.id }, data: { status: 'C' } });
    });
    return { ...(await contractOut(up)), refund_amount: refund };
  });

  // Chương trình flash sale
  route(app, 'POST', '/bff/flash-sale-programs/:fx_hash/submit', async (req) => {
    const tenant = await tenantOf(req);
    const u = await currentUser(req);
    if (!u) throw E.unauthorized();
    const b = body(req);
    const shop = await prisma.shop.findUnique({ where: { user_id: u.id } });
    const platform = u.is_sa || tenant.owner_user_id === u.id;
    if (!platform) {
      if (!shop) throw E.forbidden('Bạn chưa có gian hàng');
      if (!(await activeContract(shop.id, 'FS'))) throw E.business('Gian hàng cần hợp đồng flash sale còn hiệu lực (/bff/flash-sale-contracts/{fx_hash}/submit)');
    }
    if (!b.name || !b.from_time || !b.to_time) throw E.invalid('Thiếu name / from_time / to_time');
    const from = new Date(b.from_time), to = new Date(b.to_time);
    if (from >= to) throw E.invalid('from_time phải trước to_time');
    if (to.getTime() - from.getTime() > 7 * 86400_000) throw E.invalid('Một chương trình tối đa 7 ngày');
    const n = (await prisma.flashSaleProgram.count()) + 1;
    const p = await prisma.flashSaleProgram.create({ data: { code: fsCode(n), tenant_id: tenant.id, shop_id: platform && !isT(b.as_shop) ? null : shop!.id, name: String(b.name), body: b.body ?? null, banner_image_url: b.banner_image_url ?? null, from_time: from, to_time: to } });
    return programOut(p);
  });
  route(app, 'POST', '/bff/flash-sale-programs/:fx_hash/update', async (req) => {
    const b = body(req);
    const { p, canManage } = await programAccess(req, b.code ?? b.unique_id);
    if (!canManage) throw E.forbidden();
    if (p.from_time <= new Date() && (b.from_time || b.to_time)) throw E.business('Chương trình đã bắt đầu, không đổi được thời gian');
    return programOut(await prisma.flashSaleProgram.update({ where: { id: p.id }, data: { name: b.name ?? undefined, body: b.body ?? undefined, banner_image_url: b.banner_image_url ?? undefined, from_time: b.from_time ? new Date(b.from_time) : undefined, to_time: b.to_time ? new Date(b.to_time) : undefined } }));
  });
  route(app, 'POST', '/bff/flash-sale-programs/:fx_hash/change-status', async (req) => {
    const b = body(req);
    const { p, canManage } = await programAccess(req, b.code ?? b.unique_id);
    if (!canManage) throw E.forbidden();
    if (!['A', 'D', 'C'].includes(String(b.status))) throw E.invalid('status: A | D (tạm dừng) | C (huỷ)');
    return programOut(await prisma.flashSaleProgram.update({ where: { id: p.id }, data: { status: String(b.status) } }));
  });
  route(app, 'POST', '/bff/flash-sale-programs/:fx_hash/list', async (req) => {
    const tenant = await tenantOf(req);
    const b = input(req);
    const p = paging(b);
    const u = await currentUser(req);
    const shop = u ? await prisma.shop.findUnique({ where: { user_id: u.id } }) : null;
    const now = new Date();
    const where: Prisma.FlashSaleProgramWhereInput = { tenant_id: tenant.id };
    if (isT(b.mine) && shop) where.shop_id = shop.id;
    else if (opt(b.shop_id)) where.shop_id = Number(b.shop_id);
    if (opt(b.status)) where.status = String(b.status);
    if (b.time === 'running') Object.assign(where, { status: 'A', from_time: { lte: now }, to_time: { gt: now } });
    if (b.time === 'upcoming') Object.assign(where, { status: 'A', from_time: { gt: now } });
    if (opt(b.keyword)) where.name = { contains: String(b.keyword) };
    const [total, rows] = await Promise.all([prisma.flashSaleProgram.count({ where }), prisma.flashSaleProgram.findMany({ where, orderBy: { from_time: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await Promise.all(rows.map(programOut)));
  });
  route(app, 'GET', '/bff/flash-sale-programs/:fx_hash/:unique_id', async (req) => {
    const p = await prisma.flashSaleProgram.findUnique({ where: { code: params(req).unique_id } });
    if (!p) throw E.notFound('Chương trình flash sale');
    const rows = await prisma.flashSaleStock.findMany({ where: { program_code: p.code, status: 'A' } });
    return { ...(await programOut(p)), items: await stockOut(rows) };
  });

  // Suất flash sale của shop trong chương trình
  const shopProgram = async (req: Req, program_code: unknown) => {
    const { shop, user } = await requireShop(req);
    const p = await prisma.flashSaleProgram.findUnique({ where: { code: String(program_code ?? '') } });
    if (!p) throw E.notFound('Chương trình flash sale');
    if (p.shop_id && p.shop_id !== shop.id) throw E.forbidden('Chương trình của shop khác');
    if (!p.shop_id && !(await activeContract(shop.id, 'FS'))) throw E.business('Cần hợp đồng flash sale còn hiệu lực để tham gia chương trình của sàn');
    return { shop, user, p };
  };
  type FsItem = { sku?: string; variation_id?: string; unique_id?: string; price_flash_sale?: number; max_stock?: number; stock_limit_to_buyer?: number };
  const resolveVar = async (shop_id: number, it: FsItem) => {
    const v = it.variation_id ? await prisma.variation.findUnique({ where: { id: it.variation_id } }) : it.sku ? await prisma.variation.findUnique({ where: { sku: it.sku } }) : null;
    if (!v) throw E.notFound(`Biến thể ${it.sku ?? it.variation_id}`);
    const prod = await prisma.product.findUnique({ where: { id: v.product_id } });
    if (!prod || prod.shop_id !== shop_id) throw E.forbidden(`SKU ${v.sku} không thuộc shop`);
    return v;
  };
  const upsertItem = async (shop_id: number, program_code: string, it: FsItem) => {
    const v = await resolveVar(shop_id, it);
    const price = new Decimal(it.price_flash_sale ?? 0);
    if (price.lte(0) || price.gte(v.price_f1)) throw E.invalid(`Giá flash sale của ${v.sku} phải > 0 và thấp hơn giá F1 (${v.price_f1})`);
    const q = Number(it.max_stock ?? 0);
    if (q <= 0) throw E.invalid('max_stock phải > 0');
    return prisma.flashSaleStock.upsert({
      where: { program_code_variation_id: { program_code, variation_id: v.id } },
      create: { unique_id: uuid(), program_code, shop_id, product_id: v.product_id, variation_id: v.id, price, quantity: q, limit_per_user: Number(it.stock_limit_to_buyer ?? 0) },
      update: { price, quantity: q, limit_per_user: Number(it.stock_limit_to_buyer ?? 0), status: 'A' },
    });
  };
  route(app, 'POST', '/bff/flash-sale-stocks/:fx_hash/add', async (req) => {
    const b = body(req);
    const { shop, p } = await shopProgram(req, b.program_code);
    if (p.to_time <= new Date()) throw E.business('Chương trình đã kết thúc');
    const out = [];
    for (const it of arr<FsItem>(b.items)) out.push(await upsertItem(shop.id, p.code, it));
    return stockOut(out);
  });
  route(app, 'POST', '/bff/flash-sale-stocks/:fx_hash/update-batch', async (req) => {
    const b = body(req);
    const { shop, p } = await shopProgram(req, b.program_code);
    const out = [];
    for (const it of arr<FsItem>(b.items)) out.push(await upsertItem(shop.id, p.code, it));
    return stockOut(out);
  });
  route(app, 'POST', '/bff/flash-sale-stocks/:fx_hash/remove', async (req) => {
    const b = body(req);
    const { shop, p } = await shopProgram(req, b.program_code);
    const keys = arr<FsItem | string>(b.items).map((x) => (typeof x === 'string' ? x : x.unique_id ?? x.sku ?? x.variation_id));
    const vs = await prisma.variation.findMany({ where: { sku: { in: keys.filter(Boolean) as string[] } } });
    const rows = await prisma.flashSaleStock.findMany({ where: { program_code: p.code, shop_id: shop.id, OR: [{ unique_id: { in: keys as string[] } }, { variation_id: { in: [...(keys as string[]), ...vs.map((v) => v.id)] } }] } });
    if (rows.some((r) => r.sold_quantity > 0)) throw E.business('Không xoá được suất đã có người mua – hãy tạm dừng (change-status D)');
    await prisma.flashSaleStock.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return stockOut(rows);
  });
  const ownStock = async (req: Req, unique_id: unknown) => {
    const { shop } = await requireShop(req);
    const r = await prisma.flashSaleStock.findUnique({ where: { unique_id: String(unique_id ?? '') } });
    if (!r || r.shop_id !== shop.id) throw E.notFound('Suất flash sale');
    return r;
  };
  route(app, 'POST', '/bff/flash-sale-stocks/:fx_hash/update', async (req) => {
    const b = body(req);
    const r = await ownStock(req, b.unique_id);
    const v = await prisma.variation.findUniqueOrThrow({ where: { id: r.variation_id } });
    const price = b.price_flash_sale != null ? new Decimal(b.price_flash_sale) : r.price;
    if (price.lte(0) || price.gte(v.price_f1)) throw E.invalid('Giá flash sale phải thấp hơn giá F1');
    const q = b.max_stock != null ? Number(b.max_stock) : r.quantity;
    if (q < r.sold_quantity) throw E.invalid('max_stock nhỏ hơn số đã bán');
    return (await stockOut([await prisma.flashSaleStock.update({ where: { id: r.id }, data: { price, quantity: q, limit_per_user: b.stock_limit_to_buyer != null ? Number(b.stock_limit_to_buyer) : undefined } })]))[0];
  });
  route(app, 'POST', '/bff/flash-sale-stocks/:fx_hash/change-status', async (req) => {
    const b = body(req);
    const r = await ownStock(req, b.unique_id);
    if (!['A', 'D'].includes(String(b.status))) throw E.invalid('status: A | D');
    return (await stockOut([await prisma.flashSaleStock.update({ where: { id: r.id }, data: { status: String(b.status) } })]))[0];
  });
  route(app, 'POST', '/bff/flash-sale-stocks/:fx_hash/list-v2', async (req) => {
    const b = body(req);
    const u = await currentUser(req);
    const shop = u ? await prisma.shop.findUnique({ where: { user_id: u.id } }) : null;
    const where: Prisma.FlashSaleStockWhereInput = { program_code: String(b.program_code ?? '') };
    if (shop && !isT(b.all)) where.shop_id = shop.id;
    let rows = await stockOut(await prisma.flashSaleStock.findMany({ where, orderBy: { id: 'asc' } }));
    if (opt(b.keyword)) rows = rows.filter((r) => `${r.product_name} ${r.sku}`.toLowerCase().includes(String(b.keyword).toLowerCase()));
    return rows;
  });
  // Sản phẩm của shop kèm trạng thái đã tham gia chương trình chưa (màn chọn sp)
  route(app, 'POST', '/bff/flash-sale-stocks/:fx_hash/list-by-product', async (req) => {
    const { shop } = await requireShop(req);
    const b = body(req);
    const p = paging(b);
    const where: Prisma.ProductWhereInput = { shop_id: shop.id, status: 'A', admin_status: 'A', ...(opt(b.keyword) ? { name: { contains: String(b.keyword) } } : {}) };
    const [total, prods] = await Promise.all([prisma.product.count({ where }), prisma.product.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    const vs = await prisma.variation.findMany({ where: { product_id: { in: prods.map((x) => x.id) }, status: 'A' } });
    const joined = await prisma.flashSaleStock.findMany({ where: { program_code: String(b.program_code ?? ''), variation_id: { in: vs.map((v) => v.id) } } });
    return paged(p, total, prods.map((pr) => ({
      product_id: pr.id, unique_id: pr.unique_id, name: pr.name, res_thumbnail_url: pr.thumbnail_url,
      variations: vs.filter((v) => v.product_id === pr.id).map((v) => ({ variation_id: v.id, sku: v.sku, name: v.name, price_public: v.price_public, price_f1: v.price_f1, joined: joined.some((j) => j.variation_id === v.id), flash_sale_unique_id: joined.find((j) => j.variation_id === v.id)?.unique_id ?? null })),
    })));
  });
  // Tra cứu SKU đang ở những chương trình nào
  route(app, 'POST', '/bff/flash-sale-stocks/:fx_hash/look-up', async (req) => {
    const b = body(req);
    const skus = arr<string>(b.skus ?? b.sku);
    const vs = await prisma.variation.findMany({ where: { sku: { in: skus } } });
    const rows = await prisma.flashSaleStock.findMany({ where: { OR: [{ unique_id: { in: arr<string>(b.unique_ids) } }, { variation_id: { in: vs.map((v) => v.id) } }] } });
    return stockOut(rows);
  });

  // ───────────── Vị trí hiển thị (bid) ─────────────
  const timeOut = (t: Awaited<ReturnType<typeof prisma.bidTime.findFirstOrThrow>>) => ({ unique_id: t.unique_id, month: t.month, year: t.year, display: t.display, created_at: t.created_at });
  const slotOut = async (rows: Awaited<ReturnType<typeof prisma.bidSlot.findMany>>) => {
    const times = await prisma.bidTime.findMany({ where: { id: { in: rows.map((r) => r.bid_time_id) } } });
    const shops = await prisma.shop.findMany({ where: { id: { in: rows.map((r) => r.shop_id).filter((x): x is number => !!x) } } });
    return rows.map((r) => {
      const t = times.find((x) => x.id === r.bid_time_id)!;
      return { unique_id: r.unique_id, bid_time_unique_id: t.unique_id, month: t.month, year: t.year, site_code: r.site_code, order: r.order, shop_id: r.shop_id, shop_name: shops.find((s) => s.id === r.shop_id)?.display_name ?? null, price: r.price, enable: r.enable, created_at: r.created_at };
    });
  };
  const detailOut = async (rows: Awaited<ReturnType<typeof prisma.bidSlotDetail.findMany>>) => {
    const slots = await prisma.bidSlot.findMany({ where: { id: { in: rows.map((r) => r.bid_slot_id) } } });
    const ps = await prisma.product.findMany({ where: { id: { in: rows.map((r) => r.product_id) } } });
    return rows.map((r) => {
      const p = ps.find((x) => x.id === r.product_id);
      return { unique_id: r.unique_id, bid_slot_unique_id: slots.find((s) => s.id === r.bid_slot_id)?.unique_id, shop_id: r.shop_id, product_id: r.product_id, product_unique_id: p?.unique_id, sku: r.sku, num: r.num, display: r.display, created_at: r.created_at, product_name: p?.name, product_res_thumbnail_url: p?.thumbnail_url, image_url: r.image_url };
    });
  };

  route(app, 'POST', '/bff/sa/bid-times/:fx_hash/create', async (req) => {
    await requireSA(req);
    const b = body(req);
    const m = Number(b.month), y = Number(b.year);
    if (!(m >= 1 && m <= 12) || !(y >= 2000)) throw E.invalid('month/year không hợp lệ');
    return timeOut(await prisma.bidTime.create({ data: { unique_id: uuid(), month: m, year: y, display: b.display === 'F' ? 'F' : 'T' } }));
  });
  route(app, 'POST', '/bff/sa/bid-times/:fx_hash/update', async (req) => {
    await requireSA(req);
    const b = body(req);
    return timeOut(await prisma.bidTime.update({ where: { unique_id: String(b.unique_id) }, data: { month: b.month != null ? Number(b.month) : undefined, year: b.year != null ? Number(b.year) : undefined, display: b.display ?? undefined } }));
  });
  route(app, 'POST', '/bff/sa/bid-times/:fx_hash/list', async (req) => {
    await requireSA(req);
    const b = body(req);
    return (await prisma.bidTime.findMany({ where: { ...(b.year ? { year: Number(b.year) } : {}), ...(b.display ? { display: String(b.display) } : {}) }, orderBy: [{ year: 'desc' }, { month: 'desc' }] })).map(timeOut);
  });

  // SA cấp slot cho shop; nếu có giá thì trừ ví shop ngay
  route(app, 'POST', '/bff/sa/bid-slots/:fx_hash/create', async (req) => {
    await requireSA(req);
    const b = body(req);
    const t = await prisma.bidTime.findUnique({ where: { unique_id: String(b.bid_time_unique_id ?? '') } });
    if (!t) throw E.notFound('Kỳ hiển thị (bid_time)');
    const shop = b.shop_id ? await prisma.shop.findUnique({ where: { id: Number(b.shop_id) } }) : null;
    const price = new Decimal(b.price ?? 0);
    const s = await prisma.$transaction(async (tx) => {
      const s = await tx.bidSlot.create({ data: { unique_id: uuid(), bid_time_id: t.id, site_code: String(b.site_code ?? 'HOME'), order: Number(b.order ?? 1), shop_id: shop?.id ?? null, price, enable: b.enable === 'F' ? 'F' : 'T' } });
      if (shop && price.gt(0)) await post(tx, shop.user_id, 'A', price.neg(), { business_code: 'BID_SLOT_FEE', ref_code: s.unique_id });
      return s;
    });
    return (await slotOut([s]))[0];
  });
  route(app, 'POST', '/bff/sa/bid-slots/:fx_hash/update', async (req) => {
    await requireSA(req);
    const b = body(req);
    const s = await prisma.bidSlot.update({ where: { unique_id: String(b.unique_id) }, data: { order: b.order != null ? Number(b.order) : undefined, enable: b.enable ?? undefined, site_code: b.site_code ?? undefined, shop_id: b.shop_id !== undefined ? (b.shop_id == null ? null : Number(b.shop_id)) : undefined } });
    return (await slotOut([s]))[0];
  });
  route(app, 'POST', '/bff/sa/bid-slots/:fx_hash/list', async (req) => {
    await requireSA(req);
    const b = body(req);
    const times = await prisma.bidTime.findMany({ where: { ...(b.year ? { year: Number(b.year) } : {}), ...(b.month ? { month: Number(b.month) } : {}) } });
    return slotOut(await prisma.bidSlot.findMany({ where: { bid_time_id: { in: times.map((t) => t.id) } }, orderBy: [{ site_code: 'asc' }, { order: 'asc' }] }));
  });
  // Xuất dữ liệu vị trí đang hiệu lực (dùng render trang chủ)
  route(app, 'POST', '/bff/sa/bid-slots/:fx_hash/dump-json', async (req) => {
    await requireSA(req);
    const now = new Date();
    const t = await prisma.bidTime.findFirst({ where: { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, display: 'T' } });
    if (!t) return [];
    const slots = await prisma.bidSlot.findMany({ where: { bid_time_id: t.id, enable: 'T' }, orderBy: { order: 'asc' } });
    const details = await prisma.bidSlotDetail.findMany({ where: { bid_slot_id: { in: slots.map((s) => s.id) }, display: 'T' }, orderBy: { num: 'asc' } });
    const so = await slotOut(slots);
    const dout = await detailOut(details);
    return so.map((s) => ({ ...s, details: dout.filter((d) => d.bid_slot_unique_id === s.unique_id) }));
  });

  route(app, 'POST', '/bff/shop/bid-slots/:fx_hash/list', async (req) => {
    const { shop } = await requireShop(req);
    const b = body(req);
    const times = await prisma.bidTime.findMany({ where: { ...(b.year ? { year: Number(b.year) } : {}), ...(b.month ? { month: Number(b.month) } : {}) } });
    return slotOut(await prisma.bidSlot.findMany({ where: { shop_id: shop.id, bid_time_id: { in: times.map((t) => t.id) } }, orderBy: { order: 'asc' } }));
  });
  route(app, 'GET', '/bff/shop/bid-slots/:fx_hash/:unique_id', async (req) => {
    const { shop } = await requireShop(req);
    const s = await prisma.bidSlot.findUnique({ where: { unique_id: params(req).unique_id } });
    if (!s || s.shop_id !== shop.id) throw E.notFound('Vị trí');
    return (await slotOut([s]))[0];
  });
  const mySlot = async (shop_id: number, unique_id: unknown) => {
    const s = await prisma.bidSlot.findUnique({ where: { unique_id: String(unique_id ?? '') } });
    if (!s || s.shop_id !== shop_id) throw E.notFound('Vị trí');
    return s;
  };
  route(app, 'POST', '/bff/shop/bid-slot-details/:fx_hash/create', async (req) => {
    const { shop } = await requireShop(req);
    const b = body(req);
    const s = await mySlot(shop.id, b.bid_slot_unique_id);
    const p = await prisma.product.findUnique({ where: { id: Number(b.product_id) } });
    if (!p || p.shop_id !== shop.id) throw E.notFound('Sản phẩm');
    if ((await prisma.bidSlotDetail.count({ where: { bid_slot_id: s.id } })) >= 10) throw E.business('Mỗi vị trí tối đa 10 sản phẩm');
    const d = await prisma.bidSlotDetail.create({ data: { unique_id: uuid(), bid_slot_id: s.id, shop_id: shop.id, product_id: p.id, sku: b.sku ?? null, num: Number(b.num ?? 0), display: b.display === 'F' ? 'F' : 'T', image_url: b.image_url ?? null } });
    return (await detailOut([d]))[0];
  });
  route(app, 'POST', '/bff/shop/bid-slot-details/:fx_hash/update', async (req) => {
    const { shop } = await requireShop(req);
    const b = body(req);
    const d = await prisma.bidSlotDetail.findUnique({ where: { unique_id: String(b.unique_id ?? '') } });
    if (!d || d.shop_id !== shop.id) throw E.notFound('Chi tiết vị trí');
    if (b.product_id != null) {
      const p = await prisma.product.findUnique({ where: { id: Number(b.product_id) } });
      if (!p || p.shop_id !== shop.id) throw E.notFound('Sản phẩm');
    }
    const up = await prisma.bidSlotDetail.update({ where: { id: d.id }, data: { product_id: b.product_id != null ? Number(b.product_id) : undefined, sku: b.sku ?? undefined, num: b.num != null ? Number(b.num) : undefined, display: b.display ?? undefined, image_url: b.image_url ?? undefined } });
    return (await detailOut([up]))[0];
  });
  route(app, 'POST', '/bff/shop/bid-slot-details/:fx_hash/list', async (req) => {
    const { shop } = await requireShop(req);
    const s = await mySlot(shop.id, body(req).bid_slot_unique_id);
    return detailOut(await prisma.bidSlotDetail.findMany({ where: { bid_slot_id: s.id }, orderBy: { num: 'asc' } }));
  });
  route(app, 'POST', '/bff/shop/bid-slot-details/:fx_hash/delete', async (req) => {
    const { shop } = await requireShop(req);
    const r = await prisma.bidSlotDetail.deleteMany({ where: { shop_id: shop.id, unique_id: { in: arr<string>(body(req).ids) } } });
    return { deleted: r.count };
  });
}
