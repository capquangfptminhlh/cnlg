import type { User, Tenant, Variation } from '@prisma/client';
import { Decimal, prisma } from './db.js';

export type PriceInfo = {
  variation_id: string;
  product_id: number;
  fe_price_public: Decimal;
  fe_price_override: Decimal;
  fe_price_override_source: 'P' | 'F1' | 'F2' | 'G' | 'FS';
  fs_program_code: string | null;
  fe_price_group: Decimal;
  sku: string | null;
  vat_include: string;
  /** Phần cộng thêm của website con trong giá (mỗi đơn vị) */
  tenant_markup: Decimal;
};

export type Markup = { rate: Decimal; perProduct: Map<number, Decimal> } | null;

/** Hoa hồng nhóm của cấp trên áp lên tài khoản cấp dưới (F2+) đã được duyệt vào nhóm. */
export async function markupOf(viewer: User | null): Promise<Markup> {
  if (!viewer || viewer.user_level === 1 || viewer.is_sa) return null;
  const ref = await prisma.userReferral.findUnique({ where: { user_id: viewer.id } });
  if (!ref || ref.status !== 'A' || !ref.referral_group_id) return null;
  const g = await prisma.userReferralGroup.findUnique({ where: { id: ref.referral_group_id } });
  if (!g) return null;
  const details = await prisma.userReferralGroupDetail.findMany({ where: { referral_group_id: g.id } });
  return { rate: g.commission, perProduct: new Map(details.map((d) => [d.product_id, d.commission])) };
}

/**
 * Giá theo nhóm người xem (chưa tính flash sale):
 * - SA / F1 (user_level 1): giá F1
 * - tài khoản cấp dưới trong nhóm hoa hồng: giá F1 × (1 + commission%)
 * - user thường / khách: giá public (hoặc giá F1 nếu tenant bật public_good_price)
 */
export function groupPrice(v: Variation, viewer: User | null, tenant: Tenant | null, markup: Markup = null): { price: Decimal; source: 'P' | 'F1' | 'F2' | 'G' } {
  if (viewer?.good_pricing === 'G' && v.price_good) return { price: v.price_good, source: 'G' };
  if (viewer && (viewer.user_level === 1 || viewer.is_sa)) return { price: v.price_f1, source: 'F1' };
  if (markup) {
    const r = markup.perProduct.get(v.product_id) ?? markup.rate;
    return { price: v.price_f1.mul(new Decimal(100).plus(r)).div(100).toDecimalPlaces(0), source: 'F2' };
  }
  if (!viewer && v.price_guest) return { price: v.price_guest, source: 'P' };
  if (tenant?.public_good_price) return { price: v.price_f1, source: 'F1' };
  return { price: v.price_public, source: 'P' };
}

/** Flash sale đang chạy cho các variation (program đang trong khung giờ và còn suất). */
export async function activeFlashSales(variationIds: string[], tenantId: number) {
  if (!variationIds.length) return new Map<string, { code: string; price: Decimal; remain: number }>();
  const now = new Date();
  const rows = await prisma.flashSaleStock.findMany({ where: { variation_id: { in: variationIds }, status: 'A' } });
  const progs = await prisma.flashSaleProgram.findMany({
    where: { code: { in: [...new Set(rows.map((r) => r.program_code))] }, status: 'A', from_time: { lte: now }, to_time: { gt: now }, tenant_id: tenantId },
  });
  const live = new Set(progs.map((p) => p.code));
  const m = new Map<string, { code: string; price: Decimal; remain: number }>();
  for (const r of rows) {
    if (!live.has(r.program_code) || r.sold_quantity >= r.quantity) continue;
    const cur = m.get(r.variation_id);
    if (!cur || r.price.lt(cur.price)) m.set(r.variation_id, { code: r.program_code, price: r.price, remain: r.quantity - r.sold_quantity });
  }
  return m;
}

export async function priceVariations(ids: string[], viewer: User | null, tenant: Tenant | null): Promise<PriceInfo[]> {
  const vs = await prisma.variation.findMany({ where: { id: { in: ids } } });
  const products = await prisma.product.findMany({ where: { id: { in: [...new Set(vs.map((v) => v.product_id))] } }, select: { id: true, vat_include: true } });
  const vat = new Map(products.map((p) => [p.id, p.vat_include]));
  const fs = await activeFlashSales(vs.map((v) => v.id), tenant?.id ?? 1);
  const markup = await markupOf(viewer);
  // Website con: cộng hoa hồng chủ website (% theo từng sp) cho người mua không phải F1
  const tp = tenant && tenant.id !== 1 && !(viewer && (viewer.user_level === 1 || viewer.is_sa))
    ? new Map((await prisma.tenantProduct.findMany({ where: { tenant_id: tenant.id, product_id: { in: vs.map((v) => v.product_id) } } })).map((x) => [x.product_id, x.commission]))
    : new Map<number, Decimal>();
  return vs.map((v) => {
    const g0 = groupPrice(v, viewer, tenant, markup);
    const c = tp.get(v.product_id);
    const tenant_markup = c && c.gt(0) ? g0.price.mul(c).div(100).toDecimalPlaces(0) : new Decimal(0);
    const g = { ...g0, price: g0.price.plus(tenant_markup) };
    const f = fs.get(v.id);
    const useFs = f && f.price.lt(g.price);
    return {
      variation_id: v.id,
      product_id: v.product_id,
      fe_price_public: v.price_public,
      fe_price_override: useFs ? f!.price : g.price,
      fe_price_override_source: useFs ? 'FS' : g.source,
      fs_program_code: useFs ? f!.code : null,
      fe_price_group: g.price,
      sku: null,
      vat_include: vat.get(v.product_id) ?? 'F',
      tenant_markup: useFs ? new Decimal(0) : tenant_markup,
    };
  });
}
