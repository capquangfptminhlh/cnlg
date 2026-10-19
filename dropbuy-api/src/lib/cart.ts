// Tính giỏ hàng (giá theo người xem, flash sale, tồn) + áp voucher. Dùng chung cho carts / guest-cart / aff-carts / orders.
import type { User, Tenant, Voucher } from '@prisma/client';
import { prisma, Decimal } from './db.js';
import { E } from './http.js';
import { priceVariations } from './pricing.js';
import { stockByVariation } from './catalog.js';

export const ownerKey = {
  user: (id: number) => `U:${id}`,
  guest: (client_id: string) => `G:${client_id}`,
  aff: (aff_id: string, client_id: string) => `A:${aff_id}:${client_id}`,
};

export type CartLine = Awaited<ReturnType<typeof loadCart>>['cart_items'][number];

export async function loadCart(owner_key: string, viewer: User | null, tenant: Tenant) {
  const items = await prisma.cartItem.findMany({ where: { owner_key }, orderBy: { id: 'asc' } });
  const vs = await prisma.variation.findMany({ where: { id: { in: items.map((i) => i.variation_id) } } });
  const ps = await prisma.product.findMany({ where: { id: { in: [...new Set(vs.map((v) => v.product_id))] } } });
  const shops = await prisma.shop.findMany({ where: { id: { in: [...new Set(ps.map((p) => p.shop_id))] } } });
  const stockRows = await prisma.stock.findMany({ where: { variation_id: { in: vs.map((v) => v.id) } } });
  const depots = await prisma.shopDepot.findMany({ where: { id: { in: [...new Set(stockRows.map((s) => s.depot_id))] } } });
  const prices = new Map((await priceVariations(vs.map((v) => v.id), viewer, tenant)).map((p) => [p.variation_id, p]));
  const avail = await stockByVariation(vs.map((v) => v.id));

  const cart_items = [];
  for (const it of items) {
    const v = vs.find((x) => x.id === it.variation_id);
    const p = v && ps.find((x) => x.id === v.product_id);
    if (!v || !p || p.status !== 'A' || p.admin_status !== 'A' || v.status !== 'A') {
      await prisma.cartItem.delete({ where: { id: it.id } }); // sp đã ngừng bán → tự loại khỏi giỏ
      continue;
    }
    const shop = shops.find((s) => s.id === p.shop_id)!;
    // Kho xuất hàng: kho còn nhiều hàng nhất của variation
    const st = stockRows.filter((s) => s.variation_id === v.id).sort((a, b) => b.current_stock - b.pending_stock - (a.current_stock - a.pending_stock))[0];
    let depot = st ? depots.find((d) => d.id === st.depot_id) : undefined;
    // Hàng kho ảo: xuất từ đúng kho đang giữ hàng của buyer
    if (it.pvv_unique_id) {
      const pvv = await prisma.productVariationVirtual.findUnique({ where: { unique_id: it.pvv_unique_id } });
      depot = pvv ? (await prisma.shopDepot.findUnique({ where: { depot_code: pvv.depot_code } })) ?? undefined : undefined;
    }
    const pr = prices.get(v.id)!;
    // Flash sale chỉ áp khi item được thêm với đúng fs_program_code đang chạy
    // Hàng kho ảo đã thuộc về buyer → không áp flash sale
    const useFs = !it.pvv_unique_id && pr.fe_price_override_source === 'FS' && (!it.fs_program_code || it.fs_program_code === pr.fs_program_code);
    const unit = useFs ? pr.fe_price_override : pr.fe_price_group;
    const changed = !!it.last_price && !it.last_price.eq(unit);
    if (!it.last_price || changed) await prisma.cartItem.update({ where: { id: it.id }, data: { last_price: unit } });
    cart_items.push({
      variation_id: v.id,
      product_name: p.name,
      product_type: p.product_type,
      shop_id: shop.id,
      shop_display_name: shop.display_name,
      product_id: p.id,
      variation_name: v.name,
      sku: v.sku,
      sub_amount: unit.mul(it.quantity),
      selected_for_checkout: it.selected,
      product_slug: p.slug,
      fe_price_public: v.price_public,
      fe_price_override: unit,
      fe_price_override_source: useFs ? 'FS' : pr.fe_price_override_source === 'FS' ? (viewer ? 'F1' : 'P') : pr.fe_price_override_source,
      fe_is_price_just_changed: changed,
      quantity: it.quantity,
      available_stock: avail.get(v.id) ?? 0,
      res_thumbnail_url: v.thumbnail_url ?? p.thumbnail_url,
      shop_depot_unique_id: depot?.unique_id ?? null,
      shop_depot_code: depot?.depot_code ?? null,
      province_id: depot?.province_id ?? null,
      district_id: depot?.district_id ?? null,
      ward_id: depot?.ward_id ?? null,
      variation_weight_vtp: v.weight_vtp,
      variation_weight_spx: v.weight_spx,
      product_variation_virtual_unique_id: it.pvv_unique_id,
      fs_program_code: useFs ? pr.fs_program_code : null,
      allow_sm_s: 'T',
      allow_sm_v: 'T',
      from_tenant_id: 0,
      from_tenant_domain: null,
      storage_id: depot?.storage_id ?? 6,
      vat_include: p.vat_include,
      // nội bộ
      _base_price: v.price_f1,
      _tenant_markup: useFs ? new Decimal(0) : pr.tenant_markup,
    });
  }
  const sel = cart_items.filter((c) => c.selected_for_checkout);
  const total_amount = sel.filter((c) => !c.product_variation_virtual_unique_id).reduce((a, c) => a.plus(c.sub_amount), new Decimal(0));
  const total_virtual_amount = sel.filter((c) => c.product_variation_virtual_unique_id).reduce((a, c) => a.plus(c.sub_amount), new Decimal(0));
  const total_weight = sel.reduce((a, c) => a.plus(c.variation_weight_vtp.mul(c.quantity)), new Decimal(0));
  return { cart_items, total_amount, total_virtual_amount, total_weight };
}

export const publicLine = ({ _base_price, _tenant_markup, ...rest }: CartLine) => rest;

/** Thêm/cập nhật số lượng. quantity <= 0 → xoá dòng. */
export async function setQuantity(owner_key: string, tenant_id: number, items: { variation_id: string; quantity: number; fs_program_code?: string | null; pvv_unique_id?: string | null }[], mode: 'set' | 'add' = 'set') {
  const ids = items.map((i) => i.variation_id);
  const avail = await stockByVariation(ids);
  for (const i of items) {
    const v = await prisma.variation.findUnique({ where: { id: i.variation_id } });
    if (!v || v.status !== 'A') throw E.notFound(`Biến thể ${i.variation_id}`);
    const fs = i.fs_program_code ?? null;
    const cur = await prisma.cartItem.findFirst({ where: { owner_key, variation_id: i.variation_id, fs_program_code: fs, pvv_unique_id: i.pvv_unique_id ?? null } });
    const qty = mode === 'add' ? (cur?.quantity ?? 0) + Number(i.quantity) : Number(i.quantity);
    if (qty <= 0) {
      if (cur) await prisma.cartItem.delete({ where: { id: cur.id } });
      continue;
    }
    if (i.pvv_unique_id) {
      const pvv = await prisma.productVariationVirtual.findUnique({ where: { unique_id: i.pvv_unique_id } });
      if (!pvv || `U:${pvv.owner_user_id}` !== owner_key || pvv.variation_id !== v.id || pvv.status !== 'A') throw E.notFound('Hàng kho ảo');
      if (qty > pvv.quantity - pvv.pending_out) throw E.outOfStock(v.sku);
    } else if (qty > (avail.get(i.variation_id) ?? 0)) throw E.outOfStock(v.sku);
    if (cur) await prisma.cartItem.update({ where: { id: cur.id }, data: { quantity: qty, pvv_unique_id: i.pvv_unique_id ?? cur.pvv_unique_id } });
    else await prisma.cartItem.create({ data: { owner_key, tenant_id, variation_id: i.variation_id, quantity: qty, fs_program_code: fs, pvv_unique_id: i.pvv_unique_id ?? null, selected: true } });
  }
}

export async function setSelected(owner_key: string, items: { variation_id: string; selected?: boolean; selected_for_checkout?: boolean }[]) {
  // FE gốc gửi danh sách variation được chọn; dòng không có trong danh sách → bỏ chọn
  const explicit = items.some((i) => i.selected !== undefined || i.selected_for_checkout !== undefined);
  if (explicit) {
    for (const i of items) await prisma.cartItem.updateMany({ where: { owner_key, variation_id: i.variation_id }, data: { selected: !!(i.selected ?? i.selected_for_checkout) } });
  } else {
    await prisma.cartItem.updateMany({ where: { owner_key }, data: { selected: false } });
    await prisma.cartItem.updateMany({ where: { owner_key, variation_id: { in: items.map((i) => i.variation_id) } }, data: { selected: true } });
  }
}

export async function deleteItems(owner_key: string, items: { variation_id: string }[]) {
  await prisma.cartItem.deleteMany({ where: { owner_key, variation_id: { in: items.map((i) => i.variation_id) } } });
}

// ───────────── Voucher ─────────────

export const isShipVoucher = (v: Pick<Voucher, 'voucher_kind' | 'discount_type'>) => v.voucher_kind === 'S' || v.discount_type === 'S';

export function voucherDiscount(v: Voucher, base: Decimal) {
  if (base.lt(v.min_order_amount)) return new Decimal(0);
  let d = v.discount_type === 'P' ? base.mul(v.discount_value).div(100) : v.discount_type === 'S' ? base : new Decimal(v.discount_value);
  if (v.max_discount && d.gt(v.max_discount)) d = new Decimal(v.max_discount);
  return Decimal.min(d, base).toDecimalPlaces(0);
}

export async function voucherUsable(v: Voucher, user_key: string) {
  const now = new Date();
  if (v.status !== 'A') return 'Mã đã ngừng';
  if (v.from_time > now || v.to_time < now) return 'Mã chưa bắt đầu hoặc đã hết hạn';
  if (v.used_quantity >= v.quantity) return 'Mã đã hết lượt';
  if (v.budget_amount && v.used_amount.gte(v.budget_amount)) return 'Mã đã hết ngân sách';
  const used = await prisma.voucherUsage.count({ where: { voucher_id: v.id, user_key } });
  if (used >= v.per_user_limit) return 'Bạn đã dùng hết lượt của mã này';
  return null;
}

export type ShopGroup = { shop_id: number; shop_depot_code: string | null; commodity_amount: Decimal; shipping_amount: Decimal; lines: CartLine[] };

export function groupByShopDepot(lines: CartLine[], shippingFees: { shop_depot_code?: string; shipping_amount?: number }[] = []) {
  const m = new Map<string, ShopGroup>();
  for (const l of lines) {
    const k = `${l.shop_id}|${l.shop_depot_code}`;
    const g = m.get(k) ?? { shop_id: l.shop_id, shop_depot_code: l.shop_depot_code, commodity_amount: new Decimal(0), shipping_amount: new Decimal(0), lines: [] };
    g.commodity_amount = g.commodity_amount.plus(l.sub_amount);
    g.lines.push(l);
    m.set(k, g);
  }
  const groups = [...m.values()];
  groups.forEach((g, i) => {
    const f = shippingFees.find((s) => s.shop_depot_code === g.shop_depot_code) ?? shippingFees[i];
    if (f?.shipping_amount != null) g.shipping_amount = new Decimal(f.shipping_amount);
  });
  return groups;
}

/** Tính giảm giá cho các mã đang áp trên giỏ (owner_key). */
export async function computeVouchers(owner_key: string, groups: ShopGroup[]) {
  const codes = (await prisma.cartVoucher.findMany({ where: { owner_key } })).map((c) => c.voucher_code);
  const vouchers = codes.length ? await prisma.voucher.findMany({ where: { code: { in: codes } } }) : [];
  const shopVouchers: { shop_id: number; code: string; voucher_id: number; discount_amount: Decimal; name: string }[] = [];
  let tenant: { voucher_id: number; code: string; name: string; discount_amount: Decimal } | null = null;
  let shipping: { voucher_id: number; code: string; name: string; discount_amount: Decimal } | null = null;
  const perGroup = groups.map(() => ({ shop: new Decimal(0), tenant: new Decimal(0), shipping: new Decimal(0) }));
  for (const v of vouchers) {
    if (await voucherUsable(v, owner_key)) continue;
    if (v.scope === 'S' && !isShipVoucher(v)) {
      const idx = groups.map((g, i) => (g.shop_id === v.shop_id ? i : -1)).filter((i) => i >= 0);
      const base = idx.reduce((a, i) => a.plus(groups[i].commodity_amount), new Decimal(0));
      const d = voucherDiscount(v, base);
      if (d.gt(0)) {
        shopVouchers.push({ shop_id: v.shop_id!, code: v.code, voucher_id: v.id, name: v.name, discount_amount: d });
        let left = d;
        idx.forEach((i, k) => {
          const part = k === idx.length - 1 ? left : d.mul(groups[i].commodity_amount).div(base).toDecimalPlaces(0);
          perGroup[i].shop = perGroup[i].shop.plus(part);
          left = left.minus(part);
        });
      }
    } else if (isShipVoucher(v)) {
      const base = groups.reduce((a, g) => a.plus(g.shipping_amount), new Decimal(0));
      const commodity = groups.reduce((a, g) => a.plus(g.commodity_amount), new Decimal(0));
      if (commodity.lt(v.min_order_amount) || base.lte(0)) continue;
      const d = voucherDiscount({ ...v, min_order_amount: new Decimal(0) }, base);
      shipping = { voucher_id: v.id, code: v.code, name: v.name, discount_amount: d };
      let left = d;
      groups.forEach((g, i) => {
        const part = i === groups.length - 1 ? left : d.mul(g.shipping_amount).div(base).toDecimalPlaces(0);
        perGroup[i].shipping = part;
        left = left.minus(part);
      });
    } else {
      const base = groups.reduce((a, g, i) => a.plus(g.commodity_amount.minus(perGroup[i].shop)), new Decimal(0));
      const d = voucherDiscount(v, base);
      if (d.lte(0)) continue;
      tenant = { voucher_id: v.id, code: v.code, name: v.name, discount_amount: d };
      let left = d;
      groups.forEach((g, i) => {
        const gb = g.commodity_amount.minus(perGroup[i].shop);
        const part = i === groups.length - 1 ? left : d.mul(gb).div(base).toDecimalPlaces(0);
        perGroup[i].tenant = part;
        left = left.minus(part);
      });
    }
  }
  const commodity_amount = groups.reduce((a, g) => a.plus(g.commodity_amount), new Decimal(0));
  const shipping_amount = groups.reduce((a, g) => a.plus(g.shipping_amount), new Decimal(0));
  const shop_voucher_amount = perGroup.reduce((a, p) => a.plus(p.shop), new Decimal(0));
  const tenant_voucher_amount = perGroup.reduce((a, p) => a.plus(p.tenant), new Decimal(0));
  const shipping_voucher_amount = perGroup.reduce((a, p) => a.plus(p.shipping), new Decimal(0));
  const total_discount_amount = shop_voucher_amount.plus(tenant_voucher_amount).plus(shipping_voucher_amount);
  const applied = {
    tenant_code: tenant?.code ?? null,
    shipping_code: shipping?.code ?? null,
    shop_codes: shopVouchers.map((s) => ({ shop_id: s.shop_id, code: s.code, voucher_id: s.voucher_id, discount_amount: s.discount_amount })),
    tenant_voucher_id: tenant?.voucher_id ?? null,
    shipping_voucher_id: shipping?.voucher_id ?? null,
    commodity_discount_amount: shop_voucher_amount.plus(tenant_voucher_amount),
    tenant_commodity_discount_amount: tenant_voucher_amount,
    shipping_discount_amount: shipping_voucher_amount,
  };
  return {
    orders: groups.map((g, i) => ({
      shop_id: g.shop_id,
      shop_depot_code: g.shop_depot_code,
      commodity_amount: g.commodity_amount,
      shipping_amount: g.shipping_amount,
      shop_voucher: shopVouchers.find((s) => s.shop_id === g.shop_id) ?? null,
      tenant_voucher: tenant && perGroup[i].tenant.gt(0) ? { ...tenant, discount_amount: perGroup[i].tenant } : null,
      shipping_voucher: shipping && perGroup[i].shipping.gt(0) ? { ...shipping, discount_amount: perGroup[i].shipping } : null,
      shop_voucher_amount: perGroup[i].shop,
      tenant_voucher_amount: perGroup[i].tenant,
      shipping_voucher_amount: perGroup[i].shipping,
      total_amount: g.commodity_amount.plus(g.shipping_amount).minus(perGroup[i].shop).minus(perGroup[i].tenant).minus(perGroup[i].shipping),
    })),
    commodity_amount,
    shipping_amount,
    shop_voucher_amount,
    tenant_voucher_amount,
    shipping_voucher_amount,
    total_discount_amount,
    total_amount: commodity_amount.plus(shipping_amount).minus(total_discount_amount),
    applied,
    vouchers,
  };
}
