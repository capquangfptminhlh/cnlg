// Giỏ hàng: user đăng nhập (/carts), khách vãng lai (/guest-cart), khách qua link affiliate (/aff-carts) + voucher.
import type { FastifyInstance } from 'fastify';
import { prisma, Decimal } from '../lib/db.js';
import { E } from '../lib/http.js';
import { route, body, arr, type Req } from '../lib/router.js';
import { requireUser, tenantOf, clientIdOf, currentUser } from '../lib/auth.js';
import { loadCart, ownerKey, publicLine, setQuantity, setSelected, deleteItems, groupByShopDepot, computeVouchers, voucherUsable, voucherDiscount, isShipVoucher } from '../lib/cart.js';
import { shippingFee } from '../lib/shipping.js';
import { priceVariations } from '../lib/pricing.js';

type Items = { variation_id: string; quantity: number; fs_program_code?: string | null; selected?: boolean; product_variation_virtual_unique_id?: string }[];

async function feeFor(owner_key: string, req: Req) {
  const b = body(req);
  const tenant = await tenantOf(req);
  const viewer = owner_key.startsWith('U:') ? await currentUser(req) : null;
  const { cart_items } = await loadCart(owner_key, viewer, tenant);
  const lines = cart_items.filter((c) => c.selected_for_checkout && c.shop_depot_code === b.shop_depot_code);
  if (!lines.length) throw E.invalid('Không có sản phẩm được chọn thuộc kho shop_depot_code');
  const depot = await prisma.shopDepot.findUnique({ where: { depot_code: String(b.shop_depot_code) } });
  const total_weight = lines.reduce((a, l) => a + Number(b.shipping_method === 'S' ? l.variation_weight_spx : l.variation_weight_vtp) * l.quantity, 0);
  const total_public = lines.reduce((a, l) => a.plus(l.fe_price_public.mul(l.quantity)), new Decimal(0));
  const fee = shippingFee({ weight_gram: total_weight, from_province_id: Number(b.sender_province_id ?? depot?.province_id ?? 0), to_province_id: Number(b.receiver_province_id), method: b.shipping_method, delivery_option: b.delivery_option });
  // Bảo hiểm 0.5% giá trị khai báo khi > 1 triệu
  const phi_bao_hiem = total_public.gt(1_000_000) ? total_public.mul(0.005).toDecimalPlaces(0) : new Decimal(0);
  return {
    shipping_method: b.shipping_method,
    shipping_service_code: b.shipping_service_code ?? (b.shipping_method === 'S' ? 'SPX_STD' : 'VCN'),
    total_weight,
    total_public_commodity_amount: total_public,
    shipping_base_amount: fee,
    shipping_markup_amount: 0,
    phi_bao_hiem,
    shipping_amount: fee.plus(phi_bao_hiem),
    base_amount_for_cost: fee,
  };
}

function itemsOf(req: Req): Items {
  const items = arr<Items[number]>(body(req).items);
  if (!items.length) throw E.invalid('items rỗng');
  return items;
}

export default function cart(app: FastifyInstance) {
  // ── Giỏ của user đăng nhập ──
  const userCart = async (req: Req) => {
    const u = await requireUser(req);
    const tenant = await tenantOf(req);
    const key = ownerKey.user(u.id);
    const c = await loadCart(key, u, tenant);
    const groups = groupByShopDepot(c.cart_items.filter((x) => x.selected_for_checkout), arr(body(req).shipping_fees));
    const v = await computeVouchers(key, groups);
    return { user_id: u.id, from_tenant_id: tenant.id, total_amount: c.total_amount, total_virtual_amount: c.total_virtual_amount, cart_items: c.cart_items.map(publicLine), applied_vouchers: v.vouchers.length ? v.applied : null };
  };
  route(app, 'POST', '/bff/carts/my-cart', userCart);
  route(app, 'PUT', '/bff/carts/set-quantity', async (req) => {
    const u = await requireUser(req);
    const tenant = await tenantOf(req);
    await setQuantity(ownerKey.user(u.id), tenant.id, itemsOf(req).map((i) => ({ ...i, pvv_unique_id: i.product_variation_virtual_unique_id })), body(req).mode === 'add' ? 'add' : 'set');
    return userCart(req);
  });
  route(app, 'PUT', '/bff/carts/set-selected-items', async (req) => {
    const u = await requireUser(req);
    await setSelected(ownerKey.user(u.id), arr(body(req).items));
    return userCart(req);
  });
  route(app, 'PUT', '/bff/carts/delete-items', async (req) => {
    const u = await requireUser(req);
    await deleteItems(ownerKey.user(u.id), itemsOf(req));
    return userCart(req);
  });
  route(app, 'POST', '/bff/carts/get-shipping-fee', async (req) => feeFor(ownerKey.user((await requireUser(req)).id), req));

  // ── Voucher trên giỏ ──
  const voucherState = async (req: Req) => {
    const u = await requireUser(req);
    const tenant = await tenantOf(req);
    const key = ownerKey.user(u.id);
    const c = await loadCart(key, u, tenant);
    const groups = groupByShopDepot(c.cart_items.filter((x) => x.selected_for_checkout), arr(body(req).shipping_fees));
    return { u, tenant, key, groups, v: await computeVouchers(key, groups) };
  };
  const voucherOut = (v: Awaited<ReturnType<typeof computeVouchers>>) => {
    const { vouchers: _v, ...rest } = v;
    return rest;
  };

  route(app, 'POST', '/bff/carts/:fx_hash/vouchers/available', async (req) => {
    const { tenant, key, groups, v } = await voucherState(req);
    const now = new Date();
    const shopIds = groups.map((g) => g.shop_id);
    const all = await prisma.voucher.findMany({ where: { status: 'A', from_time: { lte: now }, to_time: { gte: now }, OR: [{ scope: 'S', shop_id: { in: shopIds } }, { scope: 'T', tenant_id: tenant.id }] } });
    const commodity = groups.reduce((a, g) => a.plus(g.commodity_amount), new Decimal(0));
    const decorate = async (x: (typeof all)[number]) => {
      const reason = await voucherUsable(x, key);
      const base = x.scope === 'S' ? groups.filter((g) => g.shop_id === x.shop_id).reduce((a, g) => a.plus(g.commodity_amount), new Decimal(0)) : commodity;
      const est = isShipVoucher(x) ? null : voucherDiscount(x, base);
      return {
        voucher_id: x.id, code: x.code, name: x.name, shop_id: x.shop_id, discount_type: x.discount_type, discount_value: x.discount_value, max_discount: x.max_discount,
        min_order_amount: x.min_order_amount, to_time: x.to_time, remain_quantity: x.quantity - x.used_quantity,
        usable: !reason && base.gte(x.min_order_amount), reason: reason ?? (base.lt(x.min_order_amount) ? `Đơn tối thiểu ${x.min_order_amount}` : null), estimated_discount: est,
      };
    };
    return {
      shop_vouchers: await Promise.all(all.filter((x) => x.scope === 'S' && !isShipVoucher(x)).map(decorate)),
      tenant_vouchers: await Promise.all(all.filter((x) => x.scope === 'T' && !isShipVoucher(x)).map(decorate)),
      shipping_vouchers: await Promise.all(all.filter((x) => isShipVoucher(x)).map(decorate)),
      applied: v.applied,
    };
  });

  route(app, 'POST', '/bff/carts/:fx_hash/vouchers/apply', async (req) => {
    const { key, tenant } = await voucherState(req);
    const code = String(body(req).code ?? '').trim();
    const vch = await prisma.voucher.findUnique({ where: { code } });
    if (!vch || (vch.scope === 'T' && vch.tenant_id !== tenant.id)) throw E.notFound('Mã giảm giá');
    const reason = await voucherUsable(vch, key);
    if (reason) throw E.business(reason);
    // Mỗi loại chỉ 1 mã: 1 mã/shop, 1 mã sàn, 1 mã ship → thay mã cùng loại đang áp
    const current = await prisma.voucher.findMany({ where: { code: { in: (await prisma.cartVoucher.findMany({ where: { owner_key: key } })).map((c) => c.voucher_code) } } });
    const sameSlot = current.filter((c) => (isShipVoucher(vch) ? isShipVoucher(c) : !isShipVoucher(c) && c.scope === vch.scope && (vch.scope === 'T' || c.shop_id === vch.shop_id)));
    await prisma.cartVoucher.deleteMany({ where: { owner_key: key, voucher_code: { in: sameSlot.map((s) => s.code) } } });
    await prisma.cartVoucher.create({ data: { owner_key: key, voucher_code: vch.code } });
    const st = await voucherState(req);
    if (!st.v.applied.shop_codes.some((s) => s.code === code) && st.v.applied.tenant_code !== code && st.v.applied.shipping_code !== code) {
      await prisma.cartVoucher.deleteMany({ where: { owner_key: key, voucher_code: code } });
      throw E.business(`Giỏ hàng chưa đủ điều kiện dùng mã (đơn tối thiểu ${vch.min_order_amount})`);
    }
    return voucherOut(st.v);
  });

  route(app, 'POST', '/bff/carts/:fx_hash/vouchers/remove', async (req) => {
    const { key } = await voucherState(req);
    await prisma.cartVoucher.deleteMany({ where: { owner_key: key, voucher_code: String(body(req).code ?? '') } });
    return voucherOut((await voucherState(req)).v);
  });

  // ── Giỏ khách vãng lai (định danh bằng client_id do trình duyệt sinh) ──
  const guestCart = async (req: Req) => {
    const tenant = await tenantOf(req);
    const client_id = clientIdOf(req, body(req));
    const c = await loadCart(ownerKey.guest(client_id), null, tenant);
    return { client_id, tenant_id: tenant.id, total_amount: c.total_amount, total_weight: c.total_weight, cart_items: c.cart_items.map(publicLine) };
  };
  const guardGuest = async (req: Req) => {
    const tenant = await tenantOf(req);
    if (!tenant.guest_submit_enabled) throw E.forbidden('Website không cho phép khách vãng lai đặt hàng');
    return tenant;
  };
  route(app, 'POST', '/bff/guest-cart/my-cart', guestCart);
  route(app, 'PUT', '/bff/guest-cart/set-quantity', async (req) => {
    const tenant = await guardGuest(req);
    await setQuantity(ownerKey.guest(clientIdOf(req, body(req))), tenant.id, itemsOf(req), body(req).mode === 'add' ? 'add' : 'set');
    return guestCart(req);
  });
  route(app, 'PUT', '/bff/guest-cart/set-selected-items', async (req) => {
    await setSelected(ownerKey.guest(clientIdOf(req, body(req))), arr(body(req).items));
    return guestCart(req);
  });
  route(app, 'PUT', '/bff/guest-cart/delete-items', async (req) => {
    await deleteItems(ownerKey.guest(clientIdOf(req, body(req))), itemsOf(req));
    return guestCart(req);
  });
  route(app, 'POST', '/bff/guest-cart/get-shipping-fee', async (req) => feeFor(ownerKey.guest(clientIdOf(req, body(req))), req));

  // ── Giỏ affiliate: khách mua qua link của người rải (aff_id = aff_code), trả giá public ──
  const affOwner = async (req: Req) => {
    const b = body(req);
    if (!b.aff_id) throw E.invalid('Thiếu aff_id');
    const aff = await prisma.user.findUnique({ where: { aff_code: String(b.aff_id) } });
    if (!aff) throw E.notFound('Mã affiliate');
    return { aff, key: ownerKey.aff(String(b.aff_id), clientIdOf(req, b)) };
  };
  const affCart = async (req: Req) => {
    const tenant = await tenantOf(req);
    const { key } = await affOwner(req);
    const b = body(req);
    const c = await loadCart(key, null, tenant);
    // chỉ giữ sp có bật affiliate
    const lines = c.cart_items.filter((l) => l.product_type !== 'X');
    return { aff_id: b.aff_id, client_id: b.client_id, total_amount: c.total_amount, total_virtual_amount: c.total_virtual_amount, cart_items: lines.map(publicLine) };
  };
  route(app, 'POST', '/bff/aff-carts/:fx_hash/my-cart', affCart);
  route(app, 'PUT', '/bff/aff-carts/:fx_hash/set-quantity', async (req) => {
    const tenant = await tenantOf(req);
    const { key } = await affOwner(req);
    const items = itemsOf(req);
    const ps = await prisma.variation.findMany({ where: { id: { in: items.map((i) => i.variation_id) } } });
    const prods = await prisma.product.findMany({ where: { id: { in: ps.map((p) => p.product_id) } } });
    if (prods.some((p) => !p.aff_enabled)) throw E.business('Có sản phẩm không tham gia affiliate');
    await setQuantity(key, tenant.id, items, body(req).mode === 'add' ? 'add' : 'set');
    return affCart(req);
  });
  route(app, 'PUT', '/bff/aff-carts/:fx_hash/set-selected-items', async (req) => {
    const { key } = await affOwner(req);
    await setSelected(key, arr(body(req).items));
    return affCart(req);
  });
  route(app, 'PUT', '/bff/aff-carts/:fx_hash/delete-items', async (req) => {
    const { key } = await affOwner(req);
    await deleteItems(key, itemsOf(req));
    return affCart(req);
  });
  route(app, 'POST', '/bff/aff-carts/:fx_hash/get-shipping-fee', async (req) => feeFor((await affOwner(req)).key, req));
  route(app, 'POST', '/bff/aff-carts/:fx_hash/get-aff-price', async (req) => {
    const tenant = await tenantOf(req);
    const ids = arr<{ variation_id: string }>(body(req).items).map((i) => i.variation_id);
    const vs = await prisma.variation.findMany({ where: { id: { in: ids } } });
    return (await priceVariations(ids, null, tenant)).map((p) => ({ ...p, sku: vs.find((v) => v.id === p.variation_id)?.sku ?? null }));
  });
}
