// Truy vấn & serialize sản phẩm dùng chung cho catalog, giỏ, đơn, tenant.
import type { Product, Variation, Shop, Tenant, User } from '@prisma/client';
import { prisma } from './db.js';

export function images(p: Product): string[] {
  try {
    return JSON.parse(p.images);
  } catch {
    return [];
  }
}

/** Sản phẩm buyer được thấy trên tenant: đang bán, đã duyệt, shop không khoá, không bị chặn. */
export async function visibleProductWhere(tenant: Tenant, viewer: User | null) {
  const lockedShops = (await prisma.shop.findMany({ where: { OR: [{ status: { not: 'A' } }, { admin_status: 'L' }] }, select: { id: true } })).map((s) => s.id);
  const tenantBlocked = (await prisma.tenantBlockShop.findMany({ where: { tenant_id: tenant.id } })).map((b) => b.shop_id);
  const userBlocked = viewer ? (await prisma.userBlockShop.findMany({ where: { user_id: viewer.id } })).map((b) => b.shop_id) : [];
  const excluded = [...new Set([...lockedShops, ...tenantBlocked, ...userBlocked])];
  const where: Record<string, unknown> = { status: 'A', admin_status: 'A', ...(excluded.length ? { shop_id: { notIn: excluded } } : {}) };
  // Website con (không phải tenant gốc id=1): chỉ hiện sp đã thêm vào tenant hoặc của shop đang theo dõi
  if (tenant.id !== 1) {
    const tp = (await prisma.tenantProduct.findMany({ where: { tenant_id: tenant.id, status: 'A' }, select: { product_id: true } })).map((x) => x.product_id);
    const follow = (await prisma.tenantFollowShop.findMany({ where: { tenant_id: tenant.id }, select: { shop_id: true } })).map((x) => x.shop_id);
    where.OR = [{ id: { in: tp } }, { shop_id: { in: follow } }];
  }
  return where;
}

export async function stockByVariation(variationIds: string[]) {
  const rows = variationIds.length ? await prisma.stock.findMany({ where: { variation_id: { in: variationIds } } }) : [];
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.variation_id, (m.get(r.variation_id) ?? 0) + r.current_stock - r.pending_stock);
  return m;
}

export async function productDetail(p: Product, opts: { withAdmin?: boolean } = {}) {
  const [shop, category, vars, depots] = await Promise.all([
    prisma.shop.findUnique({ where: { id: p.shop_id } }),
    p.category_id ? prisma.category.findUnique({ where: { id: p.category_id } }) : null,
    prisma.variation.findMany({ where: { product_id: p.id, status: 'A' }, orderBy: [{ num: 'asc' }, { created_at: 'asc' }] }),
    prisma.shopDepot.findMany({ where: { shop_id: p.shop_id } }),
  ]);
  const stocks = vars.length ? await prisma.stock.findMany({ where: { variation_id: { in: vars.map((v) => v.id) } } }) : [];
  const depotById = new Map(depots.map((d) => [d.id, d]));
  const variations = vars.map((v) => variationOut(v, stocks.filter((s) => s.variation_id === v.id).reduce((a, s) => a + s.current_stock - s.pending_stock, 0)));
  const main = variations[0] ?? null;
  const summaries = new Map<string, { depot_code: string; depot_name: string; current_stock: number }>();
  for (const s of stocks) {
    const d = depotById.get(s.depot_id);
    if (!d) continue;
    const cur = summaries.get(d.depot_code) ?? { depot_code: d.depot_code, depot_name: d.name || d.fullname, current_stock: 0 };
    cur.current_stock += s.current_stock - s.pending_stock;
    summaries.set(d.depot_code, cur);
  }
  return {
    unique_id: p.unique_id,
    product_id: p.id,
    shop_id: p.shop_id,
    shop_name: shop?.display_name ?? null,
    shop_is_mall: shop?.is_mall ?? false,
    name: p.name,
    slug: p.slug,
    price_public: main?.price_public ?? null,
    price_f1: main?.price_f1 ?? null,
    body_content: p.description,
    variation_main: main,
    category_id: p.category_id,
    category_name: category?.name ?? null,
    res_thumbnail_url: p.thumbnail_url,
    media_data: images(p).map((url, i) => ({ id: i + 1, media_type: 'I', url })),
    main_video_link: p.main_video_link,
    warranty_type: p.warranty_type,
    warranty_duration: p.warranty_duration,
    variations,
    dump_at: p.dump_at,
    updated_at: p.updated_at,
    admin_updated_at: p.admin_updated_at,
    status: p.status,
    admin_status: p.admin_status,
    admin_comment: opts.withAdmin ? p.admin_comment : undefined,
    depot_summaries: [...summaries.values()],
    type: p.product_type,
    preorder_status: p.preorder_status,
    aff_enabled: p.aff_enabled,
    aff_rate: p.aff_rate,
    hang_xin: p.hang_xin,
    vat_include: p.vat_include,
    bought_count: p.sold_count,
    view_count: p.view_count,
    rate_avg: p.rate_avg,
    rate_count: p.rate_count,
    storage_id: 6,
    tenant_id: 1,
  };
}

export function variationOut(v: Variation, current_stock?: number) {
  return {
    unique_id: v.id,
    variation_id: v.id,
    product_id: v.product_id,
    name: v.name,
    variation_name: v.name,
    sku: v.sku,
    price_public: v.price_public,
    price_f1: v.price_f1,
    variation_weight_vtp: v.weight_vtp,
    variation_weight_spx: v.weight_spx,
    res_thumbnail_url: v.thumbnail_url,
    status: v.status,
    current_stock: current_stock ?? null,
    in_stock: (current_stock ?? 0) > 0,
  };
}

/** Thẻ sản phẩm trong danh sách/tìm kiếm (variations/search) */
export async function productCards(products: Product[], shops?: Map<number, Shop>) {
  const ids = products.map((p) => p.id);
  const vars = ids.length ? await prisma.variation.findMany({ where: { product_id: { in: ids }, status: 'A' }, orderBy: [{ num: 'asc' }, { created_at: 'asc' }] }) : [];
  const stock = await stockByVariation(vars.map((v) => v.id));
  const sm = shops ?? new Map((await prisma.shop.findMany({ where: { id: { in: [...new Set(products.map((p) => p.shop_id))] } } })).map((s) => [s.id, s]));
  const cats = new Map((await prisma.category.findMany()).map((c) => [c.id, c.name]));
  return products.map((p) => {
    const vs = vars.filter((v) => v.product_id === p.id);
    const main = vs[0];
    const total = vs.reduce((a, v) => a + (stock.get(v.id) ?? 0), 0);
    return {
      unique_id: p.unique_id,
      product_id: p.id,
      product_name: p.name,
      name: p.name,
      slug: p.slug,
      price_public: main?.price_public ?? null,
      price_f1: main?.price_f1 ?? null,
      sku: main?.sku ?? null,
      variation_id: main?.id ?? null,
      category_id: p.category_id,
      category_name: p.category_id ? cats.get(p.category_id) ?? null : null,
      warranty_type: p.warranty_type,
      warranty_duration: p.warranty_duration,
      in_stock: total > 0,
      current_stock: total,
      res_thumbnail_url: p.thumbnail_url,
      dump_at: p.dump_at,
      shop_is_mall: sm.get(p.shop_id)?.is_mall ?? false,
      shop_name: sm.get(p.shop_id)?.display_name ?? null,
      shop_id: p.shop_id,
      product_type: p.product_type,
      preorder_status: p.preorder_status,
      total_variations: vs.length,
      aff_enabled: p.aff_enabled,
      hang_xin: p.hang_xin,
      vat_include: p.vat_include,
      sold_count: p.sold_count,
      storage_id: 6,
      from_tenant_id: 0,
    };
  });
}
