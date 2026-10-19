// Gian hàng, kho (depot), hợp đồng gửi kho, kho ảo (buyer sở hữu hàng nằm ở kho shop) + chuyển kho ảo giữa user.
import type { FastifyInstance } from 'fastify';
import type { Prisma, Shop, ShopDepotContract } from '@prisma/client';
import { prisma, Decimal, type Tx } from '../lib/db.js';
import { E, isT } from '../lib/http.js';
import { route, body, query, params, input, arr, type Req } from '../lib/router.js';
import { requireUser, requireShop, requireSA, tenantOf, currentUser, requireMfa } from '../lib/auth.js';
import { paging, paged, opt, dateRange } from '../lib/paging.js';
import { uuid, code, depotCode, hex } from '../lib/ids.js';
import { post } from '../lib/balance.js';
import { shopOut, locationNames } from '../lib/serialize.js';
import { productCards } from '../lib/catalog.js';
import { priceVariations } from '../lib/pricing.js';

// ───────────── helpers ─────────────

async function depotsOut(rows: Awaited<ReturnType<typeof prisma.shopDepot.findMany>>) {
  const names = await locationNames(rows.flatMap((d) => [d.province_id, d.district_id, d.ward_id]));
  const shops = await prisma.shop.findMany({ where: { id: { in: rows.map((r) => r.shop_id) } } });
  return rows.map((d) => ({
    unique_id: d.unique_id, depot_code: d.depot_code, id: d.id, shop_id: d.shop_id, user_id: shops.find((s) => s.id === d.shop_id)?.user_id, name: d.name, fullname: d.fullname, phone: d.phone,
    address_line: d.address_line, province_id: d.province_id, province_name: names.get(d.province_id) ?? null, district_id: d.district_id, district_name: names.get(d.district_id) ?? null,
    ward_id: d.ward_id, ward_name: names.get(d.ward_id) ?? null, created_at: d.created_at, updated_at: d.created_at, status: d.status, type: 'N', storage_id: d.storage_id,
  }));
}

/** Khối lượng (gram) hàng kho ảo của buyer đang chiếm tại 1 kho. */
async function usedCapacity(buyer_user_id: number, depot_code: string) {
  const pvvs = await prisma.productVariationVirtual.findMany({ where: { owner_user_id: buyer_user_id, depot_code, status: 'A' } });
  const pending = await prisma.pvvRequest.findMany({ where: { buyer_user_id, depot_code, status: 'P' } });
  const vs = await prisma.variation.findMany({ where: { id: { in: [...pvvs.map((p) => p.variation_id), ...pending.map((p) => p.variation_id)] } } });
  const w = (vid: string) => Number(vs.find((v) => v.id === vid)?.weight_vtp ?? 0);
  return pvvs.reduce((a, p) => a + w(p.variation_id) * p.quantity, 0) + pending.reduce((a, p) => a + w(p.variation_id) * p.quantity, 0);
}

async function contractsOut(rows: ShopDepotContract[]) {
  const shops = await prisma.shop.findMany({ where: { id: { in: rows.map((r) => r.shop_id) } } });
  const buyers = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.buyer_user_id) } }, select: { id: true, username: true, fullname: true } });
  return Promise.all(rows.map(async (c) => ({
    unique_id: c.unique_id, code: c.code, shop_id: c.shop_id, shop_name: shops.find((s) => s.id === c.shop_id)?.display_name, shop_user_id: shops.find((s) => s.id === c.shop_id)?.user_id,
    buyer_id: c.buyer_user_id, buyer_username: buyers.find((u) => u.id === c.buyer_user_id)?.username, from_date: c.from_date, to_date: c.to_date, rent_rate: c.rent_rate, contract_duration: c.contract_duration,
    rent_amount: c.amount, premium_type: c.contract_type, weight_capacity_total: c.weight_capacity_total, weight_capacity_current: await usedCapacity(c.buyer_user_id, c.depot_code),
    created_at: c.created_at, status: c.status === 'A' && c.to_date < new Date() ? 'E' : c.status, approved_at: c.approved_at, shop_depot_code: c.depot_code,
    extend_capacity: c.extend_capacity, extend_status: c.extend_status, extend_amount: c.extend_amount, extend_comment: c.extend_comment, auto_generate_next_contract: c.auto_generate_next_contract, notes: c.notes,
  })));
}

const log = (tx: Tx | typeof prisma, contract_id: number, action: string, notes?: string) => tx.shopDepotContractLog.create({ data: { contract_id, action, notes } });

/** Phí thuê: rent_rate (VND/kg/ngày) × kg × ngày */
const rentAmount = (rate: Decimal, gram: Decimal, days: number) => rate.mul(gram).div(1000).mul(days).toDecimalPlaces(0);

async function activeDepotContract(buyer_user_id: number, depot_code: string) {
  const now = new Date();
  return prisma.shopDepotContract.findFirst({ where: { buyer_user_id, depot_code, status: 'A', from_date: { lte: now }, to_date: { gt: now } }, orderBy: { to_date: 'desc' } });
}

async function pvvOut(rows: Awaited<ReturnType<typeof prisma.productVariationVirtual.findMany>>) {
  const vs = await prisma.variation.findMany({ where: { id: { in: rows.map((r) => r.variation_id) } } });
  const ps = await prisma.product.findMany({ where: { id: { in: rows.map((r) => r.product_id) } } });
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.owner_user_id) } }, select: { id: true, username: true } });
  const shops = await prisma.shop.findMany({ where: { id: { in: rows.map((r) => r.shop_id) } } });
  return rows.map((r) => {
    const v = vs.find((x) => x.id === r.variation_id);
    const p = ps.find((x) => x.id === r.product_id);
    return {
      id: r.id, unique_id: r.unique_id, depot_code: r.depot_code, sku: v?.sku, product_name: p?.name, product_type: p?.product_type, varriation_name: v?.name, variation_name: v?.name,
      user_id: r.owner_user_id, username: users.find((u) => u.id === r.owner_user_id)?.username, shop_id: r.shop_id, shop_name: shops.find((s) => s.id === r.shop_id)?.display_name,
      current_stock: r.quantity, pending_out_stock: r.pending_out, available_stock: r.quantity - r.pending_out, buyer_price: r.base_price, asset_amount: r.base_price.mul(r.quantity),
      res_thumbnail_url: v?.thumbnail_url ?? p?.thumbnail_url, product_id: r.product_id, weight_per_item: v?.weight_vtp ?? 0, variation_id_string: r.variation_id, status: r.status, updated_at: r.updated_at,
    };
  });
}

async function pvvrOut(rows: Awaited<ReturnType<typeof prisma.pvvRequest.findMany>>) {
  const vs = await prisma.variation.findMany({ where: { id: { in: rows.map((r) => r.variation_id) } } });
  const ps = await prisma.product.findMany({ where: { id: { in: vs.map((v) => v.product_id) } } });
  const shops = await prisma.shop.findMany({ where: { id: { in: rows.map((r) => r.shop_id) } } });
  const buyers = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.buyer_user_id) } }, select: { id: true, username: true } });
  return rows.map((r) => {
    const v = vs.find((x) => x.id === r.variation_id);
    const p = ps.find((x) => x.id === v?.product_id);
    const s = shops.find((x) => x.id === r.shop_id);
    return {
      unique_id: r.unique_id, code: r.code, buyer_id: r.buyer_user_id, buyer_username: buyers.find((u) => u.id === r.buyer_user_id)?.username, shop_id: r.shop_id, shop_user_id: s?.user_id, shop_name: s?.display_name,
      shop_depot_code: r.depot_code, product_id: p?.id, product_name: p?.name, sku: v?.sku, variation_name: v?.name, variation_unique_id: r.variation_id, buyer_price: r.unit_price, quantity: r.quantity,
      commodity_amount: r.total_amount, status: r.status, shop_comment: r.shop_comment, created_at: r.created_at, created_date: r.created_at, approved_at: r.approved_at, rejected_at: r.rejected_at,
      res_thumbnail_url: v?.thumbnail_url ?? p?.thumbnail_url, depot_action_code: r.depot_action_code, depot_notes: r.notes, fs_program_code: r.fs_program_code, payment_balance_type: 'A', variation_weight_vtp: v?.weight_vtp,
    };
  });
}

async function transfersOut(rows: Awaited<ReturnType<typeof prisma.pvvTransfer.findMany>>, showOtp: (t: (typeof rows)[number]) => boolean) {
  const pvvs = await prisma.productVariationVirtual.findMany({ where: { id: { in: rows.map((r) => r.pvv_id) } } });
  const vs = await prisma.variation.findMany({ where: { id: { in: pvvs.map((p) => p.variation_id) } } });
  return rows.map((t) => {
    const p = pvvs.find((x) => x.id === t.pvv_id);
    return {
      unique_id: t.unique_id, code: t.code, sku: vs.find((v) => v.id === p?.variation_id)?.sku, product_id: p?.product_id, from_depot_code: p?.depot_code, from_shop_id: p?.shop_id, from_user_id: t.from_user_id,
      transfer_quantity: t.quantity, to_depot_code: t.to_depot_code ?? p?.depot_code, to_user_id: t.to_user_id, transfer_balance_type: 'A', status: t.status, transfer_amount: t.price,
      otp_code: showOtp(t) ? t.otp_code : null, otp_retry: t.otp_retry, created_at: t.created_at, confirm_at: t.confirm_at, notes: t.notes, cancelled_at: t.cancelled_at,
    };
  });
}

/** Ghi sổ kho ảo + cập nhật số lượng (atomic). */
async function pvvMove(tx: Tx, pvv_id: number, delta: number, business_code: string, ref_code?: string) {
  const p = await tx.productVariationVirtual.findUniqueOrThrow({ where: { id: pvv_id } });
  const after = p.quantity + delta;
  if (after < 0) throw E.business('Kho ảo không đủ số lượng');
  await tx.productVariationVirtual.update({ where: { id: p.id }, data: { quantity: after } });
  await tx.pvvLedger.create({ data: { pvv_id: p.id, action_code: delta >= 0 ? 'I' : 'O', business_code, quantity: Math.abs(delta), quantity_after: after, ref_code } });
}

export default function shop(app: FastifyInstance) {
  // ───────────── Gian hàng ─────────────
  const shopFull = async (s: Shop) => {
    const depot = await prisma.shopDepot.findFirst({ where: { shop_id: s.id, status: 'A' }, orderBy: { id: 'asc' } });
    const u = await prisma.user.findUnique({ where: { id: s.user_id }, select: { username: true, tenant_id: true } });
    return {
      ...shopOut(s), shop_is_mall: s.is_mall, pic_name: s.fullname, pic_phone: s.phone, username: u?.username, tenant_id: u?.tenant_id ?? 1, enable_aff: s.enable_aff, enable_xu: s.enable_xu,
      reject_shop_depot_contract: s.reject_shop_depot_contract, virtual_depot_rent_rate_normal: s.virtual_depot_rent_rate_normal, virtual_depot_rent_rate_vip: s.virtual_depot_rent_rate_vip,
      virtual_depot_rent_rate: s.virtual_depot_rent_rate_normal, auto_approve_virtual_item: s.auto_approve_virtual_item, default_depot_code: depot?.depot_code ?? null, storage_id: 6, allow_sm_s: 'T', allow_sm_v: 'T', allow_submit_order: 'T',
    };
  };

  route(app, 'POST', '/bff/shop/register', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    if (!b.shop_name) throw E.invalid('Thiếu shop_name');
    if (await prisma.shop.findUnique({ where: { user_id: u.id } })) throw E.conflict('Tài khoản đã có gian hàng');
    const s = await prisma.shop.create({
      data: {
        user_id: u.id, name: String(b.shop_name), display_name: String(b.shop_name), link_fb: b.link_fb ?? u.link_fb, fullname: b.pic_name ?? b.fullname ?? u.fullname, phone: b.pic_phone ?? b.phone ?? u.phone ?? '',
        address_line: b.address_line ?? '', province_id: Number(b.province_id ?? 0), district_id: Number(b.district_id ?? 0), ward_id: Number(b.ward_id ?? 0), notes: b.notes ?? null,
        enable_virtual_depot: isT(b.enable_virtual_depot), admin_status: process.env.SHOP_REQUIRE_APPROVAL === 'true' ? 'W' : 'A',
      },
    });
    // Kho mặc định theo địa chỉ đăng ký
    if (s.province_id && s.ward_id) await prisma.shopDepot.create({ data: { unique_id: uuid(), depot_code: depotCode(s.id), shop_id: s.id, name: 'Kho chính', fullname: s.fullname, phone: s.phone, address_line: s.address_line, province_id: s.province_id, district_id: s.district_id, ward_id: s.ward_id } });
    return shopFull(s);
  });

  route(app, 'GET', '/bff/shop/my-shop', async (req) => {
    const u = await requireUser(req);
    const s = await prisma.shop.findUnique({ where: { user_id: u.id } });
    if (!s) throw E.notFound('Gian hàng');
    return shopFull(s);
  });

  route(app, 'PUT', '/bff/shop/update', async (req) => {
    const { shop: s } = await requireShop(req);
    const b = body(req);
    const data: Prisma.ShopUpdateInput = {};
    if (b.shop_name != null) { data.display_name = String(b.shop_name); data.name = String(b.shop_name); }
    if (b.link_fb != null) data.link_fb = String(b.link_fb);
    if (b.address_line != null) data.address_line = String(b.address_line);
    if (b.notes !== undefined) data.notes = b.notes;
    if (b.pic_name != null) data.fullname = String(b.pic_name);
    if (b.pic_phone != null) data.phone = String(b.pic_phone);
    if (b.description !== undefined) data.description = b.description;
    if (b.avatar_url !== undefined) data.avatar_url = b.avatar_url;
    if (b.banner_url !== undefined) data.banner_url = b.banner_url;
    for (const k of ['enable_virtual_depot', 'enable_aff', 'enable_xu', 'reject_shop_depot_contract', 'auto_approve_virtual_item'] as const) if (b[k] != null) (data as Record<string, unknown>)[k] = isT(b[k]);
    for (const k of ['virtual_depot_rent_rate_normal', 'virtual_depot_rent_rate_vip'] as const) if (b[k] != null) (data as Record<string, unknown>)[k] = new Decimal(b[k]);
    return shopFull(await prisma.shop.update({ where: { id: s.id }, data }));
  });

  const search = async (req: Req) => {
    const b = input(req);
    const p = paging(b);
    const where: Prisma.ShopWhereInput = { status: 'A', admin_status: { not: 'L' } };
    if (opt(b.keyword)) where.OR = [{ display_name: { contains: String(b.keyword) } }, ...(/^\d+$/.test(String(b.keyword)) ? [{ id: Number(b.keyword) }] : [])];
    if (isT(b.mall_only)) where.is_mall = true;
    const [total, rows] = await Promise.all([prisma.shop.count({ where }), prisma.shop.findMany({ where, orderBy: [{ is_mall: 'desc' }, { id: 'asc' }], skip: p.skip, take: p.take })]);
    return paged(p, total, rows.map((s) => ({ id: s.id, user_id: s.user_id, name: s.display_name, enable_virtual_depot: s.enable_virtual_depot, link_fb: s.link_fb, address_line: s.address_line, pic_phone: s.phone, shop_is_mall: s.is_mall, avatar_url: s.avatar_url, tenant_id: 1 })));
  };
  route(app, 'POST', '/bff/shop/search', search);
  route(app, 'POST', '/bff/shop/:fx_hash/search', search);

  // Shop tạm nghỉ bán (ẩn toàn bộ sp) / mở lại
  route(app, 'POST', '/bff/shop/:fx_hash/suspend', async (req) => {
    const u = await requireUser(req);
    const s = await prisma.shop.findUnique({ where: { user_id: u.id } });
    if (!s) throw E.notFound('Gian hàng');
    if (s.admin_status === 'L') throw E.forbidden('Gian hàng đang bị khoá bởi quản trị');
    return shopFull(await prisma.shop.update({ where: { id: s.id }, data: { status: isT(body(req).suspended) ? 'S' : 'A' } }));
  });

  // Xuất danh sách sp (FE tự dựng file Excel từ dữ liệu này)
  route(app, 'POST', '/bff/shop/:fx_hash/export', async (req) => {
    const { shop: s } = await requireShop(req);
    const b = body(req);
    const where: Prisma.ProductWhereInput = { shop_id: s.id, status: { not: 'X' }, ...(opt(b.keyword) ? { name: { contains: String(b.keyword) } } : {}) };
    if (opt(b.fs_code)) where.id = { in: (await prisma.flashSaleStock.findMany({ where: { program_code: String(b.fs_code), shop_id: s.id } })).map((x) => x.product_id) };
    const prods = await prisma.product.findMany({ where, orderBy: { id: 'asc' } });
    const vs = await prisma.variation.findMany({ where: { product_id: { in: prods.map((p) => p.id) }, status: 'A' } });
    const st = await prisma.stock.findMany({ where: { variation_id: { in: vs.map((v) => v.id) } } });
    return vs.map((v) => {
      const p = prods.find((x) => x.id === v.product_id)!;
      return { product_id: p.id, product_name: p.name, sku: v.sku, variation_name: v.name, price_public: v.price_public, price_f1: v.price_f1, weight_vtp: v.weight_vtp, current_stock: st.filter((x) => x.variation_id === v.id).reduce((a, x) => a + x.current_stock, 0), status: p.status, admin_status: p.admin_status };
    });
  });

  // "Dump" = làm mới dữ liệu hiển thị (ảnh thu nhỏ, chỉ mục tìm kiếm). Chạy nền, trả job id.
  route(app, 'POST', '/bff/shop/:fx_hash/dump-products', async (req) => {
    const { shop: s } = await requireShop(req);
    const ids = arr<number>(body(req).product_ids_to_dump).map(Number);
    const job = await prisma.asyncJob.create({ data: { id: `dump-${s.id}-${hex(4)}`, kind: 'DUMP_PRODUCTS' } });
    setImmediate(async () => {
      const r = await prisma.product.updateMany({ where: { shop_id: s.id, ...(ids.length ? { id: { in: ids } } : {}) }, data: { dump_at: new Date() } });
      await prisma.asyncJob.update({ where: { id: job.id }, data: { status: 'D', result: JSON.stringify({ updated: r.count }) } });
    });
    return { job_id: job.id, status: job.status };
  });
  route(app, 'POST', '/bff/shop/:fx_hash/dump-products-get-status', async (req) => {
    const { shop: s } = await requireShop(req);
    const job = await prisma.asyncJob.findFirst({ where: { id: { startsWith: `dump-${s.id}-` } }, orderBy: { created_at: 'desc' } });
    return job ? { job_id: job.id, status: job.status, result: job.result ? JSON.parse(job.result) : null, updated_at: job.updated_at } : null;
  });

  // ───────────── Kho của shop ─────────────
  const ownDepot = async (req: Req, unique_id: unknown) => {
    const { shop: s } = await requireShop(req);
    const d = await prisma.shopDepot.findUnique({ where: { unique_id: String(unique_id ?? '') } });
    if (!d || d.shop_id !== s.id) throw E.notFound('Kho');
    return { s, d };
  };
  route(app, 'POST', '/bff/shop-depots', async (req) => {
    const { shop: s } = await requireShop(req);
    const b = body(req);
    for (const k of ['fullname', 'phone', 'address_line', 'province_id', 'ward_id']) if (b[k] == null || b[k] === '') throw E.invalid(`Thiếu ${k}`);
    const d = await prisma.shopDepot.create({ data: { unique_id: uuid(), depot_code: depotCode(s.id), shop_id: s.id, name: String(b.name ?? b.fullname), fullname: String(b.fullname), phone: String(b.phone), address_line: String(b.address_line), province_id: Number(b.province_id), district_id: Number(b.district_id ?? 0), ward_id: Number(b.ward_id) } });
    return (await depotsOut([d]))[0];
  });
  route(app, 'PUT', '/bff/shop-depots', async (req) => {
    const b = body(req);
    const { d } = await ownDepot(req, b.unique_id ?? (await prisma.shopDepot.findUnique({ where: { depot_code: String(b.depot_code ?? '') } }))?.unique_id);
    const up = await prisma.shopDepot.update({
      where: { id: d.id },
      data: { name: b.name ?? undefined, fullname: b.fullname ?? undefined, phone: b.phone ?? undefined, address_line: b.address_line ?? undefined, province_id: b.province_id != null ? Number(b.province_id) : undefined, district_id: b.district_id != null ? Number(b.district_id) : undefined, ward_id: b.ward_id != null ? Number(b.ward_id) : undefined, status: b.status ?? undefined },
    });
    return (await depotsOut([up]))[0];
  });
  route(app, 'DELETE', '/bff/shop-depots/:unique_id', async (req) => {
    const { d } = await ownDepot(req, params(req).unique_id);
    const hasStock = await prisma.stock.count({ where: { depot_id: d.id, OR: [{ current_stock: { gt: 0 } }, { pending_stock: { gt: 0 } }] } });
    const hasVirtual = await prisma.productVariationVirtual.count({ where: { depot_code: d.depot_code, quantity: { gt: 0 } } });
    if (hasStock || hasVirtual) throw E.business('Kho còn hàng (hoặc hàng kho ảo của khách) – không xoá được');
    const up = await prisma.shopDepot.update({ where: { id: d.id }, data: { status: 'X' } });
    return (await depotsOut([up]))[0];
  });
  route(app, 'GET', '/bff/shop-depots/list', async (req) => {
    const q = query(req);
    const p = paging(q, 50);
    // shop_id truyền vào → xem kho của shop khác (để thuê kho); mặc định kho của mình
    let shop_id = q.shop_id ? Number(q.shop_id) : null;
    if (!shop_id) shop_id = (await requireShop(req)).shop.id;
    const where: Prisma.ShopDepotWhereInput = { shop_id, status: 'A', ...(opt(q.keyword) ? { OR: [{ name: { contains: String(q.keyword) } }, { depot_code: { contains: String(q.keyword) } }] } : {}) };
    const [total, rows] = await Promise.all([prisma.shopDepot.count({ where }), prisma.shopDepot.findMany({ where, orderBy: { id: 'asc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await depotsOut(rows));
  });

  // ───────────── Hợp đồng gửi kho (buyer thuê sức chứa tại kho shop) ─────────────
  route(app, 'POST', '/bff/shop-depot-contracts/submit', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    requireMfa(u, b.totp_code);
    const s = await prisma.shop.findUnique({ where: { id: Number(b.shop_id) } });
    if (!s || s.status !== 'A') throw E.notFound('Gian hàng');
    if (!s.enable_virtual_depot || s.reject_shop_depot_contract) throw E.business('Gian hàng không nhận gửi kho');
    if (s.user_id === u.id) throw E.invalid('Không thể thuê kho của chính mình');
    const depot = b.shop_depot_code ? await prisma.shopDepot.findUnique({ where: { depot_code: String(b.shop_depot_code) } }) : await prisma.shopDepot.findFirst({ where: { shop_id: s.id, status: 'A' }, orderBy: { id: 'asc' } });
    if (!depot || depot.shop_id !== s.id) throw E.notFound('Kho của shop');
    const days = Number(b.contract_duration);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw E.invalid('contract_duration 1..365 ngày');
    const type = b.premium_type === 'V' ? 'V' : 'N';
    const rate = type === 'V' ? s.virtual_depot_rent_rate_vip : s.virtual_depot_rent_rate_normal;
    const gram = new Decimal(b.weight_capacity_total ?? b.weight_capacity ?? 10000);
    const amount = rentAmount(rate, gram, days);
    const cur = await activeDepotContract(u.id, depot.depot_code);
    const from = cur ? cur.to_date : new Date();
    const c = await prisma.$transaction(async (tx) => {
      const c = await tx.shopDepotContract.create({ data: { unique_id: uuid(), code: code('HDK'), shop_id: s.id, buyer_user_id: u.id, depot_code: depot.depot_code, contract_type: type, from_date: from, to_date: new Date(from.getTime() + days * 86400_000), contract_duration: days, rent_rate: rate, weight_capacity_total: gram, amount, auto_generate_next_contract: isT(b.auto_generate_next_contract) } });
      // Giữ tiền thuê ở ví đặt cọc tới khi shop duyệt
      await post(tx, u.id, 'A', amount.neg(), { business_code: 'DEPOT_RENT', business_sub_code: 'HOLD', ref_code: c.code });
      await post(tx, u.id, 'L', amount, { business_code: 'DEPOT_RENT', business_sub_code: 'HOLD', ref_code: c.code });
      await log(tx, c.id, 'SUBMIT', `${gram}g × ${days} ngày = ${amount}`);
      return c;
    });
    return (await contractsOut([c]))[0];
  });

  const contractFor = async (unique_id: unknown) => {
    const c = await prisma.shopDepotContract.findUnique({ where: { unique_id: String(unique_id ?? '') } });
    if (!c) throw E.notFound('Hợp đồng gửi kho');
    return c;
  };
  const asShop = async (req: Req) => {
    const { shop: s, user } = await requireShop(req);
    const c = await contractFor(body(req).unique_id);
    if (c.shop_id !== s.id) throw E.notFound('Hợp đồng gửi kho');
    return { s, user, c };
  };
  const asBuyer = async (req: Req) => {
    const u = await requireUser(req);
    const c = await contractFor(body(req).unique_id);
    if (c.buyer_user_id !== u.id) throw E.notFound('Hợp đồng gửi kho');
    return { u, c };
  };

  route(app, 'POST', '/bff/shop-depot-contracts/shop-approved-contract', async (req) => {
    const { s, c } = await asShop(req);
    if (c.status !== 'P') throw E.business('Hợp đồng không chờ duyệt');
    const up = await prisma.$transaction(async (tx) => {
      await post(tx, c.buyer_user_id, 'L', c.amount.neg(), { business_code: 'DEPOT_RENT', business_sub_code: 'PAY', ref_code: c.code });
      await post(tx, s.user_id, 'A', c.amount, { business_code: 'DEPOT_RENT', business_sub_code: 'RECEIVE', ref_code: c.code });
      await log(tx, c.id, 'APPROVE');
      return tx.shopDepotContract.update({ where: { id: c.id }, data: { status: 'A', approved_at: new Date() } });
    });
    return (await contractsOut([up]))[0];
  });
  route(app, 'POST', '/bff/shop-depot-contracts/shop-reject-contract', async (req) => {
    const { c } = await asShop(req);
    if (c.status !== 'P') throw E.business('Hợp đồng không chờ duyệt');
    const up = await prisma.$transaction(async (tx) => {
      await post(tx, c.buyer_user_id, 'L', c.amount.neg(), { business_code: 'DEPOT_RENT', business_sub_code: 'REFUND', ref_code: c.code });
      await post(tx, c.buyer_user_id, 'A', c.amount, { business_code: 'DEPOT_RENT', business_sub_code: 'REFUND', ref_code: c.code });
      await log(tx, c.id, 'REJECT', body(req).notes);
      return tx.shopDepotContract.update({ where: { id: c.id }, data: { status: 'R' } });
    });
    return (await contractsOut([up]))[0];
  });

  // Xin thêm sức chứa (gram) cho phần thời gian còn lại
  route(app, 'POST', '/bff/shop-depot-contracts/extend-contract', async (req) => {
    const { u, c } = await asBuyer(req);
    if (c.status !== 'A' || c.to_date < new Date()) throw E.business('Hợp đồng không còn hiệu lực');
    if (c.extend_status === 'P') throw E.conflict('Đang có yêu cầu gia hạn chờ duyệt');
    const gram = new Decimal(body(req).extend_value ?? 0);
    if (gram.lte(0)) throw E.invalid('extend_value (gram) phải > 0');
    const days = Math.max(1, Math.ceil((c.to_date.getTime() - Date.now()) / 86400_000));
    const amount = rentAmount(c.rent_rate, gram, days);
    const up = await prisma.$transaction(async (tx) => {
      await post(tx, u.id, 'A', amount.neg(), { business_code: 'DEPOT_RENT', business_sub_code: 'EXTEND_HOLD', ref_code: c.code });
      await post(tx, u.id, 'L', amount, { business_code: 'DEPOT_RENT', business_sub_code: 'EXTEND_HOLD', ref_code: c.code });
      await log(tx, c.id, 'EXTEND_REQUEST', `+${gram}g`);
      return tx.shopDepotContract.update({ where: { id: c.id }, data: { extend_status: 'P', extend_capacity: gram, extend_amount: amount } });
    });
    return (await contractsOut([up]))[0];
  });
  const decideExtend = (approve: boolean) => async (req: Req) => {
    const { s, c } = await asShop(req);
    if (c.extend_status !== 'P' || !c.extend_amount || !c.extend_capacity) throw E.business('Không có yêu cầu gia hạn chờ duyệt');
    const up = await prisma.$transaction(async (tx) => {
      await post(tx, c.buyer_user_id, 'L', c.extend_amount!.neg(), { business_code: 'DEPOT_RENT', business_sub_code: approve ? 'EXTEND_PAY' : 'EXTEND_REFUND', ref_code: c.code });
      if (approve) await post(tx, s.user_id, 'A', c.extend_amount!, { business_code: 'DEPOT_RENT', business_sub_code: 'EXTEND_RECEIVE', ref_code: c.code });
      else await post(tx, c.buyer_user_id, 'A', c.extend_amount!, { business_code: 'DEPOT_RENT', business_sub_code: 'EXTEND_REFUND', ref_code: c.code });
      await log(tx, c.id, approve ? 'EXTEND_APPROVE' : 'EXTEND_REJECT', body(req).extend_comment);
      return tx.shopDepotContract.update({ where: { id: c.id }, data: { extend_status: approve ? 'A' : 'R', extend_comment: body(req).extend_comment ?? null, ...(approve ? { weight_capacity_total: c.weight_capacity_total.plus(c.extend_capacity!), amount: c.amount.plus(c.extend_amount!) } : {}) } });
    });
    return (await contractsOut([up]))[0];
  };
  route(app, 'POST', '/bff/shop-depot-contracts/shop-approved-extend', decideExtend(true));
  route(app, 'POST', '/bff/shop-depot-contracts/shop-rejected-extend', decideExtend(false));

  route(app, 'POST', '/bff/shop-depot-contracts/set-auto-generate-next-contract', async (req) => {
    const { c } = await asBuyer(req);
    const up = await prisma.shopDepotContract.update({ where: { id: c.id }, data: { auto_generate_next_contract: isT(body(req).auto_generate_next_contract) } });
    return (await contractsOut([up]))[0];
  });

  // Nâng hạng VIP: trả chênh lệch đơn giá cho phần thời gian còn lại (thanh toán thẳng cho shop)
  route(app, 'POST', '/bff/shop-depot-contracts/:fx_hash/upgrade-vip', async (req) => {
    const { u, c } = await asBuyer(req);
    if (c.status !== 'A' || c.contract_type === 'V') throw E.business('Chỉ nâng hạng hợp đồng thường đang hiệu lực');
    const s = await prisma.shop.findUniqueOrThrow({ where: { id: c.shop_id } });
    const days = Math.max(1, Math.ceil((c.to_date.getTime() - Date.now()) / 86400_000));
    const diff = rentAmount(s.virtual_depot_rent_rate_vip.minus(c.rent_rate), c.weight_capacity_total, days);
    const up = await prisma.$transaction(async (tx) => {
      if (diff.gt(0)) {
        await post(tx, u.id, 'A', diff.neg(), { business_code: 'DEPOT_RENT', business_sub_code: 'UPGRADE_VIP', ref_code: c.code });
        await post(tx, s.user_id, 'A', diff, { business_code: 'DEPOT_RENT', business_sub_code: 'UPGRADE_VIP', ref_code: c.code });
      }
      await log(tx, c.id, 'UPGRADE_VIP', String(diff));
      return tx.shopDepotContract.update({ where: { id: c.id }, data: { contract_type: 'V', rent_rate: s.virtual_depot_rent_rate_vip, amount: c.amount.plus(diff) } });
    });
    return (await contractsOut([up]))[0];
  });
  route(app, 'POST', '/bff/shop-depot-contracts/:fx_hash/logs-for-buyer', async (req) => {
    const { c } = await asBuyer(req);
    return prisma.shopDepotContractLog.findMany({ where: { contract_id: c.id }, orderBy: { id: 'asc' } });
  });

  const contractList = (side: 'buyer' | 'shop') => async (req: Req) => {
    const b = input(req);
    const p = paging(b);
    const where: Prisma.ShopDepotContractWhereInput = side === 'buyer' ? { buyer_user_id: (await requireUser(req)).id } : { shop_id: (await requireShop(req)).shop.id };
    if (opt(b.status)) where.status = String(b.status);
    if (opt(b.extend_status)) where.extend_status = String(b.extend_status);
    if (opt(b.keyword)) where.code = { contains: String(b.keyword) };
    const r = dateRange(b.from_date, b.to_date);
    if (r) where.created_at = r;
    const [total, rows] = await Promise.all([prisma.shopDepotContract.count({ where }), prisma.shopDepotContract.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await contractsOut(rows));
  };
  route(app, 'POST', '/bff/shop-depot-contracts/list-for-buyer', contractList('buyer'));
  route(app, 'POST', '/bff/shop-depot-contracts/list-for-shop', contractList('shop'));
  route(app, 'GET', '/bff/shop-depot-contracts/my-available-list', async (req) => {
    const u = await requireUser(req);
    const now = new Date();
    return contractsOut(await prisma.shopDepotContract.findMany({ where: { buyer_user_id: u.id, status: 'A', from_date: { lte: now }, to_date: { gt: now } }, orderBy: { to_date: 'asc' } }));
  });

  // ───────────── Yêu cầu nhập hàng vào kho ảo ─────────────
  async function approvePvvr(tx: Tx, r: Awaited<ReturnType<typeof prisma.pvvRequest.findUniqueOrThrow>>, shopUserId: number) {
    const depot = await tx.shopDepot.findUniqueOrThrow({ where: { depot_code: r.depot_code } });
    const v = await tx.variation.findUniqueOrThrow({ where: { id: r.variation_id } });
    await tx.stock.update({ where: { variation_id_depot_id: { variation_id: r.variation_id, depot_id: depot.id } }, data: { current_stock: { decrement: r.quantity }, pending_stock: { decrement: r.quantity } } });
    const pvv = await tx.productVariationVirtual.upsert({
      where: { owner_user_id_variation_id_depot_code: { owner_user_id: r.buyer_user_id, variation_id: r.variation_id, depot_code: r.depot_code } },
      create: { unique_id: uuid(), owner_user_id: r.buyer_user_id, shop_id: r.shop_id, depot_code: r.depot_code, product_id: v.product_id, variation_id: v.id, quantity: 0, base_price: r.unit_price },
      update: {},
    });
    // giá vốn bình quân
    const newBase = pvv.quantity + r.quantity > 0 ? pvv.base_price.mul(pvv.quantity).plus(r.total_amount).div(pvv.quantity + r.quantity).toDecimalPlaces(0) : r.unit_price;
    await tx.productVariationVirtual.update({ where: { id: pvv.id }, data: { base_price: newBase, status: 'A' } });
    await pvvMove(tx, pvv.id, r.quantity, 'REQUEST_IN', r.code);
    await post(tx, r.buyer_user_id, 'L', r.total_amount.neg(), { business_code: 'PVV_REQUEST', business_sub_code: 'PAY', ref_code: r.code });
    await post(tx, shopUserId, 'A', r.total_amount, { business_code: 'PVV_REQUEST', business_sub_code: 'RECEIVE', ref_code: r.code });
    return tx.pvvRequest.update({ where: { id: r.id }, data: { status: 'A', approved_at: new Date() } });
  }
  async function releasePvvr(tx: Tx, r: Awaited<ReturnType<typeof prisma.pvvRequest.findUniqueOrThrow>>, status: 'R' | 'C', comment?: string) {
    const depot = await tx.shopDepot.findUniqueOrThrow({ where: { depot_code: r.depot_code } });
    await tx.stock.update({ where: { variation_id_depot_id: { variation_id: r.variation_id, depot_id: depot.id } }, data: { pending_stock: { decrement: r.quantity } } });
    await post(tx, r.buyer_user_id, 'L', r.total_amount.neg(), { business_code: 'PVV_REQUEST', business_sub_code: 'REFUND', ref_code: r.code });
    await post(tx, r.buyer_user_id, 'A', r.total_amount, { business_code: 'PVV_REQUEST', business_sub_code: 'REFUND', ref_code: r.code });
    if (r.fs_program_code) await tx.flashSaleStock.updateMany({ where: { program_code: r.fs_program_code, variation_id: r.variation_id }, data: { sold_quantity: { decrement: r.quantity } } });
    return tx.pvvRequest.update({ where: { id: r.id }, data: { status, rejected_at: new Date(), shop_comment: comment ?? r.shop_comment } });
  }

  route(app, 'POST', '/bff/product-variation-virtual-request/submit', async (req) => {
    const u = await requireUser(req);
    const tenant = await tenantOf(req);
    const b = body(req);
    requireMfa(u, b.totp_code);
    const qty = Number(b.quantity);
    if (!Number.isInteger(qty) || qty < 1) throw E.invalid('quantity phải là số nguyên ≥ 1');
    const v = await prisma.variation.findUnique({ where: { id: String(b.variation_unique_id ?? b.variation_id ?? '') } });
    if (!v || v.status !== 'A') throw E.notFound('Biến thể');
    const p = await prisma.product.findUniqueOrThrow({ where: { id: v.product_id } });
    const s = await prisma.shop.findUniqueOrThrow({ where: { id: p.shop_id } });
    if (!s.enable_virtual_depot) throw E.business('Shop không bật kho ảo');
    const depot = await prisma.shopDepot.findUnique({ where: { depot_code: String(b.from_shop_depot_code ?? '') } });
    if (!depot || depot.shop_id !== s.id) throw E.notFound('Kho xuất (from_shop_depot_code)');
    const contract = await activeDepotContract(u.id, depot.depot_code);
    if (!contract) throw E.business('Cần hợp đồng gửi kho còn hiệu lực tại kho này');
    const need = Number(v.weight_vtp) * qty;
    if ((await usedCapacity(u.id, depot.depot_code)) + need > Number(contract.weight_capacity_total)) throw E.business('Vượt sức chứa hợp đồng gửi kho – hãy xin thêm sức chứa');
    const [price] = await priceVariations([v.id], u, tenant);
    const useFs = !!b.fs_program_code && price.fs_program_code === b.fs_program_code;
    const unit = useFs ? price.fe_price_override : price.fe_price_group;
    const total = unit.mul(qty);
    const r = await prisma.$transaction(async (tx) => {
      const st = await tx.stock.findUnique({ where: { variation_id_depot_id: { variation_id: v.id, depot_id: depot.id } } });
      if (!st || st.current_stock - st.pending_stock < qty) throw E.outOfStock(v.sku);
      await tx.stock.update({ where: { id: st.id }, data: { pending_stock: { increment: qty } } });
      if (useFs) await tx.flashSaleStock.update({ where: { program_code_variation_id: { program_code: String(b.fs_program_code), variation_id: v.id } }, data: { sold_quantity: { increment: qty } } });
      const r = await tx.pvvRequest.create({ data: { unique_id: uuid(), code: code('NKA'), contract_id: contract.id, buyer_user_id: u.id, shop_id: s.id, depot_code: depot.depot_code, variation_id: v.id, quantity: qty, unit_price: unit, total_amount: total, fs_program_code: useFs ? String(b.fs_program_code) : null, notes: b.notes ?? null } });
      await post(tx, u.id, 'A', total.neg(), { business_code: 'PVV_REQUEST', business_sub_code: 'HOLD', ref_code: r.code });
      await post(tx, u.id, 'L', total, { business_code: 'PVV_REQUEST', business_sub_code: 'HOLD', ref_code: r.code });
      return s.auto_approve_virtual_item ? approvePvvr(tx, r, s.user_id) : r;
    });
    return (await pvvrOut([r]))[0];
  });
  route(app, 'POST', '/bff/product-variation-virtual-request/buyer-huy', async (req) => {
    const u = await requireUser(req);
    const r = await prisma.pvvRequest.findUnique({ where: { unique_id: String(body(req).unique_id ?? '') } });
    if (!r || r.buyer_user_id !== u.id) throw E.notFound('Yêu cầu nhập kho ảo');
    if (r.status !== 'P') throw E.business('Yêu cầu đã được shop xử lý');
    return (await pvvrOut([await prisma.$transaction((tx) => releasePvvr(tx, r, 'C'))]))[0];
  });
  const pvvrList = (side: 'buyer' | 'shop') => async (req: Req) => {
    const b = input(req);
    const p = paging(b);
    const where: Prisma.PvvRequestWhereInput = side === 'buyer' ? { buyer_user_id: (await requireUser(req)).id } : { shop_id: (await requireShop(req)).shop.id };
    if (opt(b.status)) where.status = String(b.status);
    if (opt(b.depot_action_code)) where.depot_action_code = String(b.depot_action_code);
    if (opt(b.keyword)) where.code = { contains: String(b.keyword) };
    const r = dateRange(b.from_date, b.to_date);
    if (r) where.created_at = r;
    const [total, rows] = await Promise.all([prisma.pvvRequest.count({ where }), prisma.pvvRequest.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await pvvrOut(rows));
  };
  route(app, 'POST', '/bff/product-variation-virtual-request/list-for-buyer', pvvrList('buyer'));
  route(app, 'POST', '/bff/shop-depots/product-variation-virtual-request/list-for-shop', pvvrList('shop'));
  const shopPvvr = async (req: Req, unique_id: unknown) => {
    const { shop: s, user } = await requireShop(req);
    const r = await prisma.pvvRequest.findUnique({ where: { unique_id: String(unique_id ?? '') } });
    if (!r || r.shop_id !== s.id) throw E.notFound('Yêu cầu nhập kho ảo');
    return { s, user, r };
  };
  route(app, 'POST', '/bff/shop-depots/product-variation-virtual-request/approve', async (req) => {
    const b = body(req);
    const { s, user, r } = await shopPvvr(req, b.unique_id ?? b.pvvr_unique_id);
    requireMfa(user, b.totp_code);
    if (r.status !== 'P') throw E.business('Yêu cầu không ở trạng thái chờ duyệt');
    const up = await prisma.$transaction(async (tx) => {
      const x = await approvePvvr(tx, r, s.user_id);
      return b.shop_comment ? tx.pvvRequest.update({ where: { id: x.id }, data: { shop_comment: String(b.shop_comment) } }) : x;
    });
    return (await pvvrOut([up]))[0];
  });
  route(app, 'POST', '/bff/shop-depots/product-variation-virtual-request/reject', async (req) => {
    const b = body(req);
    const { r } = await shopPvvr(req, b.unique_id);
    if (r.status !== 'P') throw E.business('Yêu cầu không ở trạng thái chờ duyệt');
    return (await pvvrOut([await prisma.$transaction((tx) => releasePvvr(tx, r, 'R', b.shop_comment))]))[0];
  });
  route(app, 'POST', '/bff/shop-depots/product-variation-virtual-request/update-depot-action-code', async (req) => {
    const b = body(req);
    const { r } = await shopPvvr(req, b.unique_id);
    return (await pvvrOut([await prisma.pvvRequest.update({ where: { id: r.id }, data: { depot_action_code: String(b.depot_action_code ?? r.depot_action_code), notes: b.depot_notes ?? b.shop_comment ?? r.notes } })]))[0];
  });
  route(app, 'POST', '/bff/shop-depots/product-variation-virtual-request/update-batch-depot-action-code', async (req) => {
    const { shop: s } = await requireShop(req);
    const b = body(req);
    const ids = arr<string>(b.unique_ids ?? b.unique_id);
    await prisma.pvvRequest.updateMany({ where: { shop_id: s.id, unique_id: { in: ids } }, data: { depot_action_code: String(b.depot_action_code), notes: b.depot_notes ?? undefined } });
    return pvvrOut(await prisma.pvvRequest.findMany({ where: { unique_id: { in: ids } } }));
  });
  route(app, 'POST', '/bff/shop-depots/:fx_hash/product-variation-virtual-get-summary-for-shop', async (req) => {
    const { shop: s } = await requireShop(req);
    const rows = await prisma.productVariationVirtual.findMany({ where: { shop_id: s.id, status: 'A', quantity: { gt: 0 } } });
    const byBuyer = new Map<number, { user_id: number; total_quantity: number; total_asset_amount: Decimal; sku_count: number }>();
    for (const r of rows) {
      const x = byBuyer.get(r.owner_user_id) ?? { user_id: r.owner_user_id, total_quantity: 0, total_asset_amount: new Decimal(0), sku_count: 0 };
      x.total_quantity += r.quantity;
      x.total_asset_amount = x.total_asset_amount.plus(r.base_price.mul(r.quantity));
      x.sku_count++;
      byBuyer.set(r.owner_user_id, x);
    }
    return { total_buyer: byBuyer.size, total_quantity: rows.reduce((a, r) => a + r.quantity, 0), details: [...byBuyer.values()] };
  });

  // ───────────── Kho ảo ─────────────
  const pvvSearch = (side: 'buyer' | 'shop') => async (req: Req) => {
    const b = input(req);
    const p = paging(b);
    const where: Prisma.ProductVariationVirtualWhereInput = side === 'buyer' ? { owner_user_id: (await requireUser(req)).id } : { shop_id: (await requireShop(req)).shop.id };
    where.status = 'A';
    if (isT(b.show_in_stock_only) || side === 'buyer') where.quantity = { gt: 0 };
    if (opt(b.keyword)) {
      const vs = await prisma.variation.findMany({ where: { OR: [{ sku: { contains: String(b.keyword) } }, { name: { contains: String(b.keyword) } }] }, select: { id: true } });
      where.variation_id = { in: vs.map((v) => v.id) };
    }
    if (opt(b.shop_keyword)) where.shop_id = { in: (await prisma.shop.findMany({ where: { display_name: { contains: String(b.shop_keyword) } }, select: { id: true } })).map((s) => s.id) };
    if (opt(b.customer_keyword)) where.owner_user_id = { in: (await prisma.user.findMany({ where: { OR: [{ username: { contains: String(b.customer_keyword) } }, { phone: { contains: String(b.customer_keyword) } }] }, select: { id: true } })).map((x) => x.id) };
    const [total, rows] = await Promise.all([prisma.productVariationVirtual.count({ where }), prisma.productVariationVirtual.findMany({ where, orderBy: { updated_at: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await pvvOut(rows));
  };
  route(app, 'POST', '/bff/product-variation-virtuals/search-by-buyer', pvvSearch('buyer'));
  route(app, 'POST', '/bff/product-variation-virtuals/search-by-shop', pvvSearch('shop'));
  route(app, 'GET', '/bff/product-variation-virtuals/:fx_hash/get-summary', async (req) => {
    const u = await requireUser(req);
    const rows = await prisma.productVariationVirtual.findMany({ where: { owner_user_id: u.id, status: 'A', quantity: { gt: 0 } } });
    const shops = await prisma.shop.findMany({ where: { id: { in: rows.map((r) => r.shop_id) } } });
    const details = shops.map((s) => {
      const mine = rows.filter((r) => r.shop_id === s.id);
      return { shop_id: s.id, shop_name: s.display_name, total_quantity: mine.reduce((a, r) => a + r.quantity, 0), total_asset_amount: mine.reduce((a, r) => a.plus(r.base_price.mul(r.quantity)), new Decimal(0)) };
    });
    return { total_asset_amount: details.reduce((a, d) => a.plus(d.total_asset_amount), new Decimal(0)), total_shop: shops.length, details };
  });
  route(app, 'POST', '/bff/product-variation-virtuals/:fx_hash/sao-ke', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    const p = paging(b);
    const v = await prisma.variation.findUnique({ where: { sku: String(b.sku ?? '') } });
    if (!v) throw E.notFound('SKU');
    const pvvs = await prisma.productVariationVirtual.findMany({ where: { variation_id: v.id, OR: [{ owner_user_id: u.id }, { shop_id: (await prisma.shop.findUnique({ where: { user_id: u.id } }))?.id ?? -1 }] } });
    const where: Prisma.PvvLedgerWhereInput = { pvv_id: { in: pvvs.map((x) => x.id) } };
    const r = dateRange(b.from_date, b.to_date);
    if (r) where.created_at = r;
    const [total, rows] = await Promise.all([prisma.pvvLedger.count({ where }), prisma.pvvLedger.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, rows.map((x) => ({ ...x, sku: v.sku, pvv_unique_id: pvvs.find((y) => y.id === x.pvv_id)?.unique_id, owner_user_id: pvvs.find((y) => y.id === x.pvv_id)?.owner_user_id })));
  });

  // Chuyển hàng kho ảo A → B (B xác nhận bằng mã OTP do A gửi; transfer_amount = giá B trả cho A)
  route(app, 'POST', '/bff/product-variation-virtual-transfers/:fx_hash/submit', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    requireMfa(u, b.totp_code);
    const pvv = await prisma.productVariationVirtual.findUnique({ where: { unique_id: String(b.pvv_unique_id ?? '') } });
    if (!pvv || pvv.owner_user_id !== u.id || pvv.status !== 'A') throw E.notFound('Hàng kho ảo');
    const qty = Number(b.transfer_quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > pvv.quantity - pvv.pending_out) throw E.invalid('transfer_quantity vượt số lượng khả dụng');
    const to = b.to_user_id ? await prisma.user.findUnique({ where: { id: Number(b.to_user_id) } }) : await prisma.user.findUnique({ where: { username: String(b.to_username ?? '') } });
    if (!to || to.id === u.id) throw E.notFound('Người nhận');
    const t = await prisma.$transaction(async (tx) => {
      await tx.productVariationVirtual.update({ where: { id: pvv.id }, data: { pending_out: { increment: qty } } });
      return tx.pvvTransfer.create({ data: { unique_id: uuid(), code: code('CKA'), from_user_id: u.id, to_user_id: to.id, pvv_id: pvv.id, quantity: qty, price: new Decimal(b.transfer_amount ?? 0), to_depot_code: b.to_depot_code ?? pvv.depot_code, otp_code: String(Math.floor(100000 + Math.random() * 900000)), notes: b.notes ?? null } });
    });
    return (await transfersOut([t], () => true))[0];
  });
  const myTransfer = async (req: Req, as: 'a' | 'b') => {
    const u = await requireUser(req);
    const t = await prisma.pvvTransfer.findUnique({ where: { unique_id: String(body(req).unique_id ?? '') } });
    if (!t || (as === 'a' ? t.from_user_id : t.to_user_id) !== u.id) throw E.notFound('Lệnh chuyển kho ảo');
    if (t.status !== 'P') throw E.business('Lệnh đã được xử lý');
    return { u, t };
  };
  route(app, 'POST', '/bff/product-variation-virtual-transfers/:fx_hash/a-cancel', async (req) => {
    const { u, t } = await myTransfer(req, 'a');
    await prisma.$transaction([
      prisma.productVariationVirtual.update({ where: { id: t.pvv_id }, data: { pending_out: { decrement: t.quantity } } }),
      prisma.pvvTransfer.update({ where: { id: t.id }, data: { status: 'C', cancelled_at: new Date() } }),
    ]);
    void u;
    return null;
  });
  route(app, 'POST', '/bff/product-variation-virtual-transfers/:fx_hash/b-confirm', async (req) => {
    const { u, t } = await myTransfer(req, 'b');
    if (String(body(req).otp_code ?? '') !== t.otp_code) {
      const up = await prisma.pvvTransfer.update({ where: { id: t.id }, data: { otp_retry: { increment: 1 } } });
      if (up.otp_retry >= 5) {
        await prisma.$transaction([prisma.productVariationVirtual.update({ where: { id: t.pvv_id }, data: { pending_out: { decrement: t.quantity } } }), prisma.pvvTransfer.update({ where: { id: t.id }, data: { status: 'C', cancelled_at: new Date() } })]);
        throw E.business('Sai OTP quá 5 lần – lệnh chuyển đã bị huỷ');
      }
      throw E.invalid('Mã OTP không đúng');
    }
    await prisma.$transaction(async (tx) => {
      const src = await tx.productVariationVirtual.findUniqueOrThrow({ where: { id: t.pvv_id } });
      await tx.productVariationVirtual.update({ where: { id: src.id }, data: { pending_out: { decrement: t.quantity } } });
      await pvvMove(tx, src.id, -t.quantity, 'TRANSFER_OUT', t.code);
      const dst = await tx.productVariationVirtual.upsert({
        where: { owner_user_id_variation_id_depot_code: { owner_user_id: u.id, variation_id: src.variation_id, depot_code: src.depot_code } },
        create: { unique_id: uuid(), owner_user_id: u.id, shop_id: src.shop_id, depot_code: src.depot_code, product_id: src.product_id, variation_id: src.variation_id, quantity: 0, base_price: t.quantity ? t.price.div(t.quantity).toDecimalPlaces(0) : src.base_price },
        update: {},
      });
      await pvvMove(tx, dst.id, t.quantity, 'TRANSFER_IN', t.code);
      if (t.price.gt(0)) {
        await post(tx, u.id, 'A', t.price.neg(), { business_code: 'PVV_TRANSFER', ref_code: t.code });
        await post(tx, t.from_user_id, 'A', t.price, { business_code: 'PVV_TRANSFER', ref_code: t.code });
      }
      await tx.pvvTransfer.update({ where: { id: t.id }, data: { status: 'D', confirm_at: new Date() } });
    });
    return null;
  });
  const transferList = (side: 'a' | 'b' | 'sa') => async (req: Req) => {
    const u = side === 'sa' ? await requireSA(req) : await requireUser(req);
    const b = body(req);
    const p = paging(b);
    const where: Prisma.PvvTransferWhereInput = side === 'a' ? { from_user_id: u.id } : side === 'b' ? { to_user_id: u.id } : {};
    if (opt(b.status)) where.status = String(b.status);
    if (opt(b.keyword)) where.code = { contains: String(b.keyword) };
    const [total, rows] = await Promise.all([prisma.pvvTransfer.count({ where }), prisma.pvvTransfer.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await transfersOut(rows, (t) => side !== 'b' && t.from_user_id === u.id));
  };
  route(app, 'POST', '/bff/product-variation-virtual-transfers/:fx_hash/list-for-a', transferList('a'));
  route(app, 'POST', '/bff/product-variation-virtual-transfers/:fx_hash/list-for-b', transferList('b'));
  route(app, 'POST', '/bff/sa/product-variation-virtual-transfers/:fx_hash/list-for-sa', transferList('sa'));

  // SA: danh sách & huỷ hàng kho ảo (trả hàng về kho shop, hoàn giá vốn cho buyer từ ví shop)
  route(app, 'POST', '/bff/sa/product-variation-virtuals/:fx_hash/list', async (req) => {
    await requireSA(req);
    const b = body(req);
    const p = paging(b);
    const where: Prisma.ProductVariationVirtualWhereInput = { ...(opt(b.shop_id) ? { shop_id: Number(b.shop_id) } : {}), ...(opt(b.user_id) ? { owner_user_id: Number(b.user_id) } : {}), ...(opt(b.status) ? { status: String(b.status) } : {}) };
    if (opt(b.sku)) where.variation_id = (await prisma.variation.findUnique({ where: { sku: String(b.sku) } }))?.id ?? '-';
    const [total, rows] = await Promise.all([prisma.productVariationVirtual.count({ where }), prisma.productVariationVirtual.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await pvvOut(rows));
  });
  route(app, 'POST', '/bff/sa/product-variation-virtuals/:fx_hash/cancel', async (req) => {
    await requireSA(req);
    const pvv = await prisma.productVariationVirtual.findUnique({ where: { unique_id: String(body(req).unique_id ?? '') } });
    if (!pvv || pvv.status !== 'A') throw E.notFound('Hàng kho ảo');
    if (pvv.pending_out > 0) throw E.business('Đang có đơn/lệnh chuyển chờ xuất – xử lý trước');
    const s = await prisma.shop.findUniqueOrThrow({ where: { id: pvv.shop_id } });
    const depot = await prisma.shopDepot.findUniqueOrThrow({ where: { depot_code: pvv.depot_code } });
    const refund = pvv.base_price.mul(pvv.quantity);
    await prisma.$transaction(async (tx) => {
      if (pvv.quantity > 0) {
        await tx.stock.upsert({ where: { variation_id_depot_id: { variation_id: pvv.variation_id, depot_id: depot.id } }, create: { variation_id: pvv.variation_id, depot_id: depot.id, current_stock: pvv.quantity }, update: { current_stock: { increment: pvv.quantity } } });
        await pvvMove(tx, pvv.id, -pvv.quantity, 'CANCEL');
        await post(tx, s.user_id, 'A', refund.neg(), { business_code: 'PVV_CANCEL', ref_code: pvv.unique_id, allowNegative: true });
        await post(tx, pvv.owner_user_id, 'A', refund, { business_code: 'PVV_CANCEL', ref_code: pvv.unique_id });
      }
      await tx.productVariationVirtual.update({ where: { id: pvv.id }, data: { status: 'C' } });
    });
    return { unique_id: pvv.unique_id, refund_amount: refund, returned_quantity: pvv.quantity };
  });

  void currentUser;
  void productCards;
}
