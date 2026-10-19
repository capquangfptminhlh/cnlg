// Catalog: tìm kiếm/giá/tồn (public), quản lý sản phẩm của shop, bình luận/đánh giá, danh mục.
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { prisma, Decimal } from '../lib/db.js';
import { E, isT, tf } from '../lib/http.js';
import { route, body, query, params, input, arr } from '../lib/router.js';
import { currentUser, requireShop, requireUser, tenantOf, requireTenantOwner } from '../lib/auth.js';
import { paging, paged, opt } from '../lib/paging.js';
import { uuid, sku as genSku, slugify, code } from '../lib/ids.js';
import { priceVariations, activeFlashSales } from '../lib/pricing.js';
import { visibleProductWhere, productDetail, productCards, variationOut, stockByVariation } from '../lib/catalog.js';

type VarInput = {
  unique_id?: string; variation_id?: string; name?: string; sku?: string; price_public?: number; price_f1?: number; price_good?: number;
  current_stock?: number; variation_weight_vtp?: number; variation_weight?: number; res_thumbnail_url?: string; status?: string;
};

async function setStock(variation_id: string, depot_id: number, qty: number) {
  await prisma.stock.upsert({
    where: { variation_id_depot_id: { variation_id, depot_id } },
    create: { variation_id, depot_id, current_stock: Math.max(0, qty) },
    update: { current_stock: Math.max(0, qty) },
  });
}

async function depotFor(shop_id: number, depot_code?: string) {
  const d = depot_code
    ? await prisma.shopDepot.findUnique({ where: { depot_code } })
    : await prisma.shopDepot.findFirst({ where: { shop_id, status: 'A' }, orderBy: { id: 'asc' } });
  if (!d || d.shop_id !== shop_id) throw E.invalid('Shop chưa có kho (depot_code) hợp lệ – tạo kho ở /bff/shop-depots trước');
  return d;
}

async function ownProduct(shop_id: number, idOrUnique: string | number) {
  const p = typeof idOrUnique === 'number' || /^\d+$/.test(String(idOrUnique))
    ? await prisma.product.findUnique({ where: { id: Number(idOrUnique) } })
    : await prisma.product.findUnique({ where: { unique_id: String(idOrUnique) } });
  if (!p || p.shop_id !== shop_id || p.status === 'X') throw E.notFound('Sản phẩm');
  return p;
}

export default function catalog(app: FastifyInstance) {
  // ── Danh mục (FE gốc lấy qua SSR; mở thêm endpoint để client dùng) ──
  route(app, 'GET', '/bff/categories', async () => prisma.category.findMany({ orderBy: [{ num: 'asc' }, { id: 'asc' }] }));

  // ── Tìm kiếm sản phẩm public ──
  route(app, 'POST', '/bff/variations/search', async (req) => {
    const b = input(req);
    const tenant = await tenantOf(req);
    const viewer = await currentUser(req);
    const p = paging(b, 40);
    const where: Prisma.ProductWhereInput = (await visibleProductWhere(tenant, viewer)) as Prisma.ProductWhereInput;
    const and: Prisma.ProductWhereInput[] = [];
    if (opt(b.keyword)) and.push({ OR: [{ name: { contains: String(b.keyword) } }, { slug: { contains: slugify(String(b.keyword)) } }] });
    if (opt(b.category_id)) {
      const cid = Number(b.category_id);
      const children = (await prisma.category.findMany({ where: { parent_id: cid } })).map((c) => c.id);
      and.push({ category_id: { in: [cid, ...children] } });
    }
    if (opt(b.shop_id)) and.push({ shop_id: Number(b.shop_id) });
    if (isT(b.aff_enabled)) and.push({ aff_enabled: true });
    if (isT(b.hang_xin)) and.push({ hang_xin: 'T' });
    if (opt(b.vat_include)) and.push({ vat_include: String(b.vat_include) });
    if (isT(b.shop_mall_only)) and.push({ shop_id: { in: (await prisma.shop.findMany({ where: { is_mall: true }, select: { id: true } })).map((s) => s.id) } });
    if (isT(b.is_flash_sale)) {
      const now = new Date();
      const progs = (await prisma.flashSaleProgram.findMany({ where: { tenant_id: tenant.id, status: 'A', from_time: { lte: now }, to_time: { gt: now } } })).map((x) => x.code);
      const pids = (await prisma.flashSaleStock.findMany({ where: { program_code: { in: progs }, status: 'A' }, select: { product_id: true } })).map((x) => x.product_id);
      and.push({ id: { in: pids } });
    }
    if (b.in_stock_mode === 'I' || isT(b.in_stock_mode)) {
      const inStock = await prisma.stock.findMany({ where: { current_stock: { gt: 0 } }, select: { variation_id: true } });
      const pids = (await prisma.variation.findMany({ where: { id: { in: inStock.map((s) => s.variation_id) } }, select: { product_id: true } })).map((v) => v.product_id);
      and.push({ id: { in: pids } });
    }
    const fullWhere = { ...where, AND: and };
    const sort = String(b.sort_by_string ?? '');
    const orderBy: Prisma.ProductOrderByWithRelationInput[] =
      sort === 'sold' || sort === 'best_seller' ? [{ sold_count: 'desc' }] : sort === 'newest' ? [{ created_at: 'desc' }] : sort === 'rate' ? [{ rate_avg: 'desc' }] : [{ is_mall: 'desc' }, { sold_count: 'desc' }, { id: 'desc' }];
    let [total, rows] = await Promise.all([prisma.product.count({ where: fullWhere }), prisma.product.findMany({ where: fullWhere, orderBy, skip: p.skip, take: p.take })]);
    let cards = await productCards(rows);
    // Giá theo người xem + flash sale
    const prices = await priceVariations(cards.map((c) => c.variation_id).filter(Boolean) as string[], viewer, tenant);
    const pm = new Map(prices.map((x) => [x.variation_id, x]));
    const out = cards.map((c) => {
      const pr = c.variation_id ? pm.get(c.variation_id) : undefined;
      return { ...c, fe_price_override: pr?.fe_price_override ?? null, fe_price_override_source: pr?.fe_price_override_source ?? null, is_flash_sale: pr?.fe_price_override_source === 'FS', fs_program_code: pr?.fs_program_code ?? null };
    });
    if (sort === 'price_asc' || sort === 'price_desc') {
      // sắp theo giá sau khi tính (trong trang hiện tại)
      out.sort((a, z) => (Number(a.fe_price_override ?? 0) - Number(z.fe_price_override ?? 0)) * (sort === 'price_asc' ? 1 : -1));
    }
    return paged(p, total, out);
  });

  const priceHandler = (guest: boolean) => async (req: Parameters<Parameters<typeof route>[3]>[0]) => {
    const items = arr<{ variation_id: string } | string>(body(req).items);
    const ids = items.map((i) => (typeof i === 'string' ? i : i.variation_id)).filter(Boolean);
    const tenant = await tenantOf(req);
    const viewer = guest ? null : await currentUser(req);
    const vs = await prisma.variation.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true } });
    const skus = new Map(vs.map((v) => [v.id, v.sku]));
    return (await priceVariations(ids, viewer, tenant)).map((x) => ({ ...x, sku: skus.get(x.variation_id) ?? null }));
  };
  route(app, 'POST', '/bff/variations/get-price', priceHandler(false));
  route(app, 'POST', '/bff/variations/get-price-guest', priceHandler(true));

  // Còn hàng theo sản phẩm: { product_ids } → [{ product_id, in_stock }]
  // Hoặc tra tồn theo kho: { depot_code, keyword } → page{ sku, current_stock ... }
  route(app, 'POST', '/bff/variations/in-stock', async (req) => {
    const b = body(req);
    if (b.product_ids) {
      const pids = arr<number>(b.product_ids).map(Number);
      const vs = await prisma.variation.findMany({ where: { product_id: { in: pids }, status: 'A' } });
      const st = await stockByVariation(vs.map((v) => v.id));
      return pids.map((pid) => ({ product_id: pid, in_stock: vs.some((v) => v.product_id === pid && (st.get(v.id) ?? 0) > 0) }));
    }
    const p = paging(b);
    const depot = opt(b.depot_code) ? await prisma.shopDepot.findUnique({ where: { depot_code: String(b.depot_code) } }) : null;
    const where: Prisma.StockWhereInput = depot ? { depot_id: depot.id } : {};
    const rows = await prisma.stock.findMany({ where, orderBy: { id: 'desc' } });
    const vs = await prisma.variation.findMany({ where: { id: { in: rows.map((r) => r.variation_id) } } });
    const ps = await prisma.product.findMany({ where: { id: { in: vs.map((v) => v.product_id) } } });
    const kw = opt(b.keyword) ? String(b.keyword).toLowerCase() : null;
    const list = rows
      .map((r) => {
        const v = vs.find((x) => x.id === r.variation_id)!;
        const pr = ps.find((x) => x.id === v?.product_id);
        return v && pr ? { sku: v.sku, product_id: pr.id, product_name: pr.name, varation_id: v.id, variation_id: v.id, variation_name: v.name, current_stock: r.current_stock - r.pending_stock } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x && (!kw || x.product_name.toLowerCase().includes(kw) || x.sku.toLowerCase().includes(kw)));
    return paged(p, list.length, list.slice(p.skip, p.skip + p.take));
  });

  // ── Chi tiết sản phẩm (public, theo id hoặc unique_id) ──
  route(app, 'GET', '/bff/products/:fx_hash/:unique_id', async (req) => {
    const tenant = await tenantOf(req);
    const viewer = await currentUser(req);
    const key = params(req).unique_id;
    const p = /^\d+$/.test(key) ? await prisma.product.findUnique({ where: { id: Number(key) } }) : await prisma.product.findUnique({ where: { unique_id: key } });
    if (!p || p.status === 'X') throw E.notFound('Sản phẩm');
    const shop = viewer ? await prisma.shop.findUnique({ where: { user_id: viewer.id } }) : null;
    const isOwner = shop?.id === p.shop_id;
    if (!isOwner && !viewer?.is_sa && (p.status !== 'A' || p.admin_status !== 'A')) throw E.notFound('Sản phẩm');
    if (!isOwner) await prisma.product.update({ where: { id: p.id }, data: { view_count: { increment: 1 } } });
    const d = await productDetail(p, { withAdmin: isOwner || !!viewer?.is_sa });
    const prices = await priceVariations(d.variations.map((v) => v.variation_id), viewer, tenant);
    return { ...d, prices };
  });

  // ── Tồn kho theo SKU + flash sale (trang chi tiết sp) ──
  route(app, 'POST', '/bff/products/:fx_hash/get-stock-by-sku', async (req) => {
    const b = body(req);
    const tenant = await tenantOf(req);
    const p = await prisma.product.findUnique({ where: { unique_id: String(b.product_unique_id) } });
    if (!p) throw E.notFound('Sản phẩm');
    const vs = await prisma.variation.findMany({ where: { product_id: p.id, status: 'A', ...(opt(b.sku) ? { sku: String(b.sku) } : {}) } });
    const stocks = await prisma.stock.findMany({ where: { variation_id: { in: vs.map((v) => v.id) } } });
    const depots = await prisma.shopDepot.findMany({ where: { id: { in: stocks.map((s) => s.depot_id) } } });
    const fs = await activeFlashSales(vs.map((v) => v.id), tenant.id);
    const progs = await prisma.flashSaleProgram.findMany({ where: { code: { in: [...new Set([...fs.values()].map((f) => f.code))] } } });
    return {
      product_unique_id: p.unique_id,
      product_id: p.id,
      sku: opt(b.sku) ?? null,
      stock_infos: stocks.map((s) => {
        const d = depots.find((x) => x.id === s.depot_id)!;
        const v = vs.find((x) => x.id === s.variation_id)!;
        return { depot_code: d.depot_code, depot_name: d.name || d.fullname, current_stocks: s.current_stock - s.pending_stock, sku: v.sku, variation_id: v.id };
      }),
      flash_sale_programs: progs.map((pg) => ({
        code: pg.code, name: pg.name, from_time: pg.from_time, to_time: pg.to_time,
        items: [...fs.entries()].filter(([, f]) => f.code === pg.code).map(([variation_id, f]) => ({ variation_id, price: f.price, remain_quantity: f.remain })),
      })),
    };
  });

  // ── Quản lý sản phẩm của shop ──
  route(app, 'POST', '/bff/products/:fx_hash/submit', async (req) => {
    const { shop } = await requireShop(req);
    const b = body(req);
    if (!b.id && !b.unique_id) {
      if (!b.name) throw E.invalid('Thiếu name');
      if (b.price_public == null || b.price_f1 == null) throw E.invalid('Thiếu price_public / price_f1');
    }
    const depot = await depotFor(shop.id, opt(b.depot_code) as string | undefined);
    const data = {
      name: b.name, slug: b.slug ? slugify(b.slug) : b.name ? slugify(b.name) : undefined, description: b.body_content, category_id: b.category_id != null ? Number(b.category_id) : undefined,
      thumbnail_url: b.res_thumbnail_url, warranty_type: b.warranty_type, warranty_duration: b.warranty_duration != null ? Number(b.warranty_duration) : undefined,
      product_type: b.type, preorder_status: b.preorder_status, hang_xin: b.hang_xin, vat_include: b.vat_include, main_video_link: b.main_video_link,
      weight_gram: b.variation_weight != null ? Number(b.variation_weight) : undefined, images: b.images ? JSON.stringify(arr(b.images)) : undefined,
      status: b.status === 'U' ? 'U' : b.status === 'A' ? 'A' : undefined, is_mall: shop.is_mall,
    };
    let p;
    if (b.id || b.unique_id) {
      const cur = await ownProduct(shop.id, b.unique_id ?? b.id);
      // Sửa nội dung → chờ duyệt lại (trừ shop mall được tự duyệt)
      p = await prisma.product.update({ where: { id: cur.id }, data: { ...data, admin_status: shop.is_mall ? 'A' : cur.admin_status === 'L' ? 'L' : 'W' } });
      const main = await prisma.variation.findFirst({ where: { product_id: p.id, status: 'A' }, orderBy: [{ num: 'asc' }, { created_at: 'asc' }] });
      if (main && (b.price_public != null || b.price_f1 != null || b.variation_weight_vtp != null))
        await prisma.variation.update({ where: { id: main.id }, data: { price_public: b.price_public ?? undefined, price_f1: b.price_f1 ?? undefined, weight_vtp: b.variation_weight_vtp ?? undefined, weight_spx: b.variation_weight_vtp ?? undefined } });
      if (main && b.current_stock != null) await setStock(main.id, depot.id, Number(b.current_stock));
    } else {
      p = await prisma.product.create({ data: { ...data, name: b.name, slug: data.slug!, unique_id: uuid(), shop_id: shop.id, admin_status: shop.is_mall ? 'A' : 'W', status: b.status === 'U' ? 'U' : 'A' } });
      const v = await prisma.variation.create({
        data: { id: uuid(), product_id: p.id, name: b.name, sku: genSku(shop.id, p.id), price_public: b.price_public, price_f1: b.price_f1, weight_vtp: b.variation_weight_vtp ?? b.variation_weight ?? 0, weight_spx: b.variation_weight_vtp ?? b.variation_weight ?? 0 },
      });
      await setStock(v.id, depot.id, Number(b.current_stock ?? 0));
    }
    return productDetail(p, { withAdmin: true });
  });

  // Thay toàn bộ bộ biến thể: generated_variation_data = [{unique_id?, name, sku?, price_public, price_f1, current_stock, ...}]
  route(app, 'PUT', '/bff/products/:fx_hash/update-variation', async (req) => {
    const { shop } = await requireShop(req);
    const b = body(req);
    const p = await ownProduct(shop.id, b.unique_id ?? b.product_id);
    const depot = await depotFor(shop.id, opt(b.depot_code) as string | undefined);
    const list = arr<VarInput>(b.generated_variation_data);
    if (!list.length) throw E.invalid('generated_variation_data rỗng');
    const existing = await prisma.variation.findMany({ where: { product_id: p.id } });
    const keep = new Set<string>();
    let i = 0;
    for (const x of list) {
      const id = x.unique_id ?? x.variation_id;
      const cur = id ? existing.find((e) => e.id === id) : x.sku ? existing.find((e) => e.sku === x.sku) : undefined;
      const fields = {
        name: x.name ?? cur?.name ?? p.name,
        price_public: new Decimal(x.price_public ?? cur?.price_public ?? 0),
        price_f1: new Decimal(x.price_f1 ?? cur?.price_f1 ?? 0),
        price_good: x.price_good != null ? new Decimal(x.price_good) : cur?.price_good ?? null,
        weight_vtp: new Decimal(x.variation_weight_vtp ?? x.variation_weight ?? cur?.weight_vtp ?? 0),
        weight_spx: new Decimal(x.variation_weight ?? x.variation_weight_vtp ?? cur?.weight_spx ?? 0),
        thumbnail_url: x.res_thumbnail_url ?? cur?.thumbnail_url ?? null,
        status: 'A',
        num: i++,
      };
      const v = cur
        ? await prisma.variation.update({ where: { id: cur.id }, data: fields })
        : await prisma.variation.create({ data: { ...fields, id: uuid(), product_id: p.id, sku: x.sku ?? genSku(shop.id, p.id) } });
      keep.add(v.id);
      if (x.current_stock != null) await setStock(v.id, depot.id, Number(x.current_stock));
    }
    await prisma.variation.updateMany({ where: { product_id: p.id, id: { notIn: [...keep] } }, data: { status: 'X' } });
    const up = await prisma.product.update({
      where: { id: p.id },
      data: { name: b.name ?? undefined, description: b.body_content ?? undefined, category_id: b.category_id != null ? Number(b.category_id) : undefined, aff_enabled: b.aff_enabled != null ? isT(b.aff_enabled) : undefined, vat_include: b.vat_include ?? undefined, admin_status: shop.is_mall ? 'A' : p.admin_status === 'L' ? 'L' : 'W' },
    });
    return productDetail(up, { withAdmin: true });
  });

  route(app, 'DELETE', '/bff/products/:fx_hash/:unique_id', async (req) => {
    const { shop } = await requireShop(req);
    const p = await ownProduct(shop.id, params(req).unique_id);
    await prisma.product.update({ where: { id: p.id }, data: { status: 'X' } });
    await prisma.cartItem.deleteMany({ where: { variation_id: { in: (await prisma.variation.findMany({ where: { product_id: p.id } })).map((v) => v.id) } } });
    return null;
  });

  const shopListWhere = async (shop_id: number, b: Record<string, any>): Promise<Prisma.ProductWhereInput> => {
    const w: Prisma.ProductWhereInput = { shop_id, status: { not: 'X' } };
    if (opt(b.status)) w.status = String(b.status);
    if (opt(b.admin_status)) w.admin_status = String(b.admin_status);
    if (opt(b.keyword)) w.OR = [{ name: { contains: String(b.keyword) } }, ...(/^\d+$/.test(String(b.keyword)) ? [{ id: Number(b.keyword) }] : [])];
    if (opt(b.aff_enabled)) w.aff_enabled = isT(b.aff_enabled);
    if (opt(b.vat_include)) w.vat_include = String(b.vat_include);
    if (opt(b.hang_xin)) w.hang_xin = String(b.hang_xin);
    if (isT(b.out_of_stock)) {
      const pids = (await prisma.product.findMany({ where: { shop_id }, select: { id: true } })).map((x) => x.id);
      const vs = await prisma.variation.findMany({ where: { product_id: { in: pids }, status: 'A' }, select: { id: true, product_id: true } });
      const st = await stockByVariation(vs.map((v) => v.id));
      const withStock = new Set(vs.filter((v) => (st.get(v.id) ?? 0) > 0).map((v) => v.product_id));
      w.id = { notIn: [...withStock] };
    }
    return w;
  };

  route(app, 'GET', '/bff/products/:fx_hash/list', async (req) => {
    const { shop } = await requireShop(req);
    const q = query(req);
    const p = paging(q);
    const where = await shopListWhere(shop.id, q);
    const [total, rows] = await Promise.all([prisma.product.count({ where }), prisma.product.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await Promise.all(rows.map((r) => productDetail(r, { withAdmin: true }))));
  });

  const compactList = (v3: boolean) => async (req: Parameters<Parameters<typeof route>[3]>[0]) => {
    const { shop } = await requireShop(req);
    const b = input(req);
    const p = paging(b);
    const where = await shopListWhere(shop.id, b);
    const [total, rows] = await Promise.all([prisma.product.count({ where }), prisma.product.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    const cards = await productCards(rows);
    return paged(p, total, cards.map((c, i) => ({
      unique_id: c.unique_id, product_id: c.product_id, name: c.name, slug: c.slug, price_public: c.price_public, price_f1: c.price_f1,
      res_thumbnail_url: c.res_thumbnail_url, res_low_file_name: c.res_thumbnail_url, current_stock: c.current_stock, storage_id: 6,
      ...(v3 ? { admin_status: rows[i].admin_status, admin_comment: rows[i].admin_comment, status: rows[i].status, from_tenant_id: 0 } : {}),
    })));
  };
  route(app, 'POST', '/bff/products/:fx_hash/list-v2', compactList(false));
  route(app, 'POST', '/bff/products/:fx_hash/list-v3', compactList(true));

  route(app, 'PUT', '/bff/products/:fx_hash/update-status-single', async (req) => {
    const { shop } = await requireShop(req);
    const b = body(req);
    const p = await ownProduct(shop.id, b.product_id);
    if (b.status_before && p.status !== b.status_before) throw E.conflict(`Trạng thái hiện tại là ${p.status}, không phải ${b.status_before}`);
    if (!['A', 'U'].includes(String(b.status_after))) throw E.invalid('status_after chỉ nhận A (đăng bán) hoặc U (ẩn)');
    await prisma.product.update({ where: { id: p.id }, data: { status: String(b.status_after) } });
    return null;
  });

  route(app, 'GET', '/bff/products/:fx_hash/count-by-status', async (req) => {
    const { shop } = await requireShop(req);
    const g = await prisma.product.groupBy({ by: ['status', 'admin_status'], where: { shop_id: shop.id, status: { not: 'X' } }, _count: true });
    const m = new Map<string, number>();
    for (const r of g) {
      m.set(r.status, (m.get(r.status) ?? 0) + r._count);
      m.set(`admin_${r.admin_status}`, (m.get(`admin_${r.admin_status}`) ?? 0) + r._count);
    }
    return [...m.entries()].map(([product_status, counting]) => ({ product_status, counting }));
  });

  route(app, 'POST', '/bff/products/:fx_hash/set-aff', async (req) => {
    const { shop } = await requireShop(req);
    const b = body(req);
    const r = await prisma.product.updateMany({ where: { shop_id: shop.id, id: { in: arr<number>(b.product_ids).map(Number) } }, data: { aff_enabled: isT(b.aff_enabled), ...(b.aff_rate != null ? { aff_rate: new Decimal(b.aff_rate) } : {}) } });
    return { updated: r.count };
  });

  route(app, 'POST', '/bff/products/:fx_hash/update-vat-include', async (req) => {
    const { shop } = await requireShop(req);
    const b = body(req);
    const r = await prisma.product.updateMany({ where: { shop_id: shop.id, id: { in: arr<number>(b.product_ids).map(Number) } }, data: { vat_include: isT(b.vat_include) ? 'T' : 'F' } });
    return { updated: r.count };
  });

  // Nhân bản sản phẩm (FE gọi "force-dump-thumb" khi copy sp) – tạo bản sao chờ duyệt
  route(app, 'POST', '/bff/products/:fx_hash/force-dump-thumb', async (req) => {
    const { shop } = await requireShop(req);
    const src = await ownProduct(shop.id, body(req).from_product_id);
    const { id: _id, unique_id: _u, created_at: _c, updated_at: _up, ...rest } = src;
    const p = await prisma.product.create({ data: { ...rest, unique_id: uuid(), name: `${src.name} (bản sao)`, admin_status: shop.is_mall ? 'A' : 'W', status: 'U', sold_count: 0, view_count: 0, dump_at: new Date() } });
    for (const v of await prisma.variation.findMany({ where: { product_id: src.id, status: 'A' } })) {
      const { id: _vid, product_id: _pid, sku: _sku, created_at: _vc, ...vr } = v;
      await prisma.variation.create({ data: { ...vr, id: uuid(), product_id: p.id, sku: genSku(shop.id, p.id) } });
    }
    return productDetail(p, { withAdmin: true });
  });

  // ── Bình luận / đánh giá ──
  const commentOut = (c: Awaited<ReturnType<typeof prisma.productComment.findFirst>>, replies = 0, shopReply: unknown = null) =>
    c && {
      id: c.id, code: c.code, reply_to: c.reply_to, shop_id: c.shop_id, product_id: c.product_id, user_id: c.user_id, fullname: c.fullname,
      comment_content: c.comment_content, comment_media: JSON.parse(c.comment_media), comment_at: c.created_at, rate: c.rate, reply_count: replies, shop_reply: shopReply, updated_at: c.created_at,
    };

  async function recalcRate(product_id: number) {
    const a = await prisma.productComment.aggregate({ where: { product_id, rate: { not: null }, reply_to: null, status: 'A' }, _avg: { rate: true }, _count: { rate: true } });
    await prisma.product.update({ where: { id: product_id }, data: { rate_avg: a._avg.rate ?? 0, rate_count: a._count.rate } });
  }

  route(app, 'POST', '/bff/product-comments/:fx_hash/list', async (req) => {
    const b = body(req);
    const p = paging(b);
    const where = { product_id: Number(b.product_id), reply_to: null, status: 'A' };
    const [total, rows] = await Promise.all([prisma.productComment.count({ where }), prisma.productComment.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    const replies = await prisma.productComment.findMany({ where: { reply_to: { in: rows.map((r) => r.code) }, status: 'A' }, orderBy: { id: 'asc' } });
    return paged(p, total, rows.map((r) => {
      const rs = replies.filter((x) => x.reply_to === r.code);
      const sr = rs.find((x) => x.user_id === null || x.fullname === '__shop__');
      return commentOut(r, rs.length, sr ? commentOut(sr) : null);
    }));
  });

  route(app, 'GET', '/bff/product-comments/:fx_hash/:code', async (req) => {
    const c = await prisma.productComment.findUnique({ where: { code: params(req).code } });
    if (!c) throw E.notFound('Bình luận');
    const replies = await prisma.productComment.findMany({ where: { reply_to: c.code, status: 'A' }, orderBy: { id: 'asc' } });
    return [commentOut(c, replies.length), ...replies.map((r) => commentOut(r))];
  });

  route(app, 'POST', '/bff/product-comments/:fx_hash/submit', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    if (!b.comment_content) throw E.invalid('Thiếu comment_content');
    const p = await prisma.product.findUnique({ where: { id: Number(b.product_id) } });
    if (!p) throw E.notFound('Sản phẩm');
    const shop = await prisma.shop.findUnique({ where: { user_id: u.id } });
    const isShopReply = !!b.reply_to && shop?.id === p.shop_id;
    let rate: number | null = null;
    if (!b.reply_to && b.rate != null) {
      rate = Math.min(5, Math.max(1, Number(b.rate)));
      // Chỉ người đã mua (đơn hoàn thành) mới được chấm sao
      const bought = await prisma.orderItem.findFirst({ where: { product_id: p.id, order_id: { in: (await prisma.order.findMany({ where: { buyer_user_id: u.id, order_status: { in: ['F', 'D'] } }, select: { id: true } })).map((o) => o.id) } } });
      if (!bought) throw E.business('Chỉ khách đã nhận hàng mới được đánh giá sao');
    }
    const c = await prisma.productComment.create({
      data: { code: code('CM'), product_id: p.id, shop_id: p.shop_id, user_id: isShopReply ? null : u.id, fullname: isShopReply ? '__shop__' : u.fullname || u.username, reply_to: b.reply_to ?? null, comment_content: String(b.comment_content), comment_media: JSON.stringify(arr(b.comment_media)), rate },
    });
    if (rate) await recalcRate(p.id);
    return commentOut(c);
  });

  // Gợi ý nội dung đánh giá (lấy các bình luận phổ biến của sp)
  route(app, 'POST', '/bff/product-comments/:fx_hash/suggest', async (req) => {
    const b = body(req);
    const p = paging(b, 10);
    const rows = await prisma.productComment.findMany({ where: { product_id: Number(b.product_id), reply_to: null, rate: { gte: 4 } }, orderBy: { id: 'desc' }, skip: p.skip, take: p.take });
    const defaults = ['Hàng đúng mô tả, đóng gói cẩn thận', 'Giao hàng nhanh, shop tư vấn nhiệt tình', 'Chất lượng tốt so với giá'];
    const items = rows.length ? rows.map((r) => ({ code: r.code, comment_content: r.comment_content })) : defaults.map((t, i) => ({ code: `SG-${i + 1}`, comment_content: t }));
    return paged(p, items.length, items);
  });

  // Chủ website con đăng đánh giá thủ công (seeding) cho sp trên site mình
  route(app, 'POST', '/bff/product-comments/:fx_hash/tenant-owner-submit', async (req) => {
    await requireTenantOwner(req);
    const b = body(req);
    const p = await prisma.product.findUnique({ where: { id: Number(b.product_id) } });
    if (!p) throw E.notFound('Sản phẩm');
    const c = await prisma.productComment.create({
      data: { code: code('CM'), product_id: p.id, shop_id: p.shop_id, user_id: null, fullname: String(b.fullname ?? 'Khách hàng'), comment_content: String(b.comment_content), comment_media: JSON.stringify(arr(b.comment_media)), rate: b.rate != null ? Math.min(5, Math.max(1, Number(b.rate))) : null },
    });
    if (c.rate) await recalcRate(p.id);
    return commentOut(c);
  });

  void tf;
  void variationOut;
}
