// Lõi nghiệp vụ đơn hàng: tạo đơn từ giỏ, máy trạng thái, tồn kho, tiền (thanh toán / hoàn / tất toán).
import type { Order, Prisma, Tenant, User } from '@prisma/client';
import { prisma, Decimal, type Tx } from './db.js';
import { E } from './http.js';
import { uuid, code } from './ids.js';
import { post } from './balance.js';
import { OrderTransitions, type OrderStatusT } from './enums.js';
import { loadCart, groupByShopDepot, computeVouchers, type CartLine } from './cart.js';
import { shippingFee } from './shipping.js';
import { locationNames } from './serialize.js';

export type Receiver = {
  receiver_fullname: string; receiver_phone: string; receiver_email?: string | null; receiver_address_line: string;
  receiver_province_id: number; receiver_district_id: number; receiver_ward_id: number;
};
export type OrderOption = {
  shop_depot_code: string; shipping_method?: string; delivery_option?: string; shipping_service_code?: string;
  notes?: string; cod_amount?: number; dong_kiem?: string;
};

export function receiverOf(b: Record<string, any>): Receiver {
  for (const k of ['receiver_fullname', 'receiver_phone', 'receiver_address_line', 'receiver_province_id', 'receiver_ward_id'])
    if (b[k] === undefined || b[k] === null || b[k] === '') throw E.invalid(`Thiếu ${k}`);
  return {
    receiver_fullname: String(b.receiver_fullname), receiver_phone: String(b.receiver_phone), receiver_email: b.receiver_email ?? null,
    receiver_address_line: String(b.receiver_address_line), receiver_province_id: Number(b.receiver_province_id),
    receiver_district_id: Number(b.receiver_district_id ?? 0), receiver_ward_id: Number(b.receiver_ward_id),
  };
}

/**
 * Tạo đơn từ các dòng đã chọn trong giỏ `owner_key`. Mỗi kho (shop_depot_code) → 1 đơn.
 * mode: N user thường, A affiliate (khách qua link), G khách vãng lai, V xuất từ kho ảo.
 */
export async function createOrders(args: {
  owner_key: string; tenant: Tenant; buyer: User | null; mode: 'N' | 'A' | 'G' | 'V';
  receiver: Receiver; options: OrderOption[]; payment_method: string; is_dropship?: boolean;
  aff_user_id?: number | null; guest_client_id?: string | null; buyer_vat_info?: unknown;
}) {
  const { owner_key, tenant, buyer, mode } = args;
  const { cart_items } = await loadCart(owner_key, buyer, tenant);
  const selected = cart_items.filter((l) => l.selected_for_checkout && (mode === 'V' ? !!l.product_variation_virtual_unique_id : !l.product_variation_virtual_unique_id));
  if (!selected.length) throw E.business('Chưa chọn sản phẩm nào để đặt hàng');
  const pm = args.payment_method || (buyer && mode === 'N' ? 'B' : 'C');
  if (pm === 'C' && !tenant.cod_enabled) throw E.business('Website chưa bật thanh toán COD');
  if (!['B', 'C', 'Q'].includes(pm)) throw E.invalid('payment_method chỉ nhận B (ví), C (COD), Q (chuyển khoản QR)');
  if ((mode === 'G' || mode === 'A') && pm === 'B') throw E.invalid('Khách không đăng nhập không thể thanh toán bằng ví');

  // Phí ship từng kho
  const depots = await prisma.shopDepot.findMany({ where: { depot_code: { in: [...new Set(selected.map((l) => l.shop_depot_code!).filter(Boolean))] } } });
  const groups = groupByShopDepot(selected);
  for (const g of groups) {
    const opt = args.options.find((o) => o.shop_depot_code === g.shop_depot_code) ?? args.options[0] ?? ({} as OrderOption);
    const d = depots.find((x) => x.depot_code === g.shop_depot_code);
    if (!d) throw E.business('Sản phẩm trong giỏ đã hết hàng ở mọi kho');
    const w = g.lines.reduce((a, l) => a + Number(opt.shipping_method === 'S' ? l.variation_weight_spx : l.variation_weight_vtp) * l.quantity, 0);
    g.shipping_amount = shippingFee({ weight_gram: w, from_province_id: d.province_id, to_province_id: args.receiver.receiver_province_id, method: opt.shipping_method, delivery_option: opt.delivery_option });
  }
  const v = mode === 'N' ? await computeVouchers(owner_key, groups) : null;

  // Shop chặn buyer?
  if (buyer) {
    const blocked = await prisma.shopBlockBuyer.findFirst({ where: { buyer_user_id: buyer.id, shop_id: { in: groups.map((g) => g.shop_id) } } });
    if (blocked) throw E.forbidden('Shop đã chặn tài khoản của bạn đặt hàng');
  }

  return prisma.$transaction(async (tx) => {
    const created: Order[] = [];
    for (const [i, g] of groups.entries()) {
      const opt = args.options.find((o) => o.shop_depot_code === g.shop_depot_code) ?? args.options[0] ?? ({} as OrderOption);
      const depot = depots.find((x) => x.depot_code === g.shop_depot_code)!;
      const ov = v?.orders[i];
      // Kho ảo: hàng đã thuộc về buyer → chỉ trả phí ship
      const commodity = mode === 'V' ? new Decimal(0) : g.commodity_amount;
      const shopV = ov?.shop_voucher_amount ?? new Decimal(0);
      const tenantV = ov?.tenant_voucher_amount ?? new Decimal(0);
      const shipV = ov?.shipping_voucher_amount ?? new Decimal(0);
      const total = commodity.plus(g.shipping_amount).minus(shopV).minus(tenantV).minus(shipV);
      const base = g.lines.reduce((a, l) => a.plus(l._base_price.mul(l.quantity)), new Decimal(0));
      const tenantProfit = mode === 'V' ? new Decimal(0) : g.lines.reduce((a, l) => a.plus(l._tenant_markup.mul(l.quantity)), new Decimal(0));
      // COD: mặc định thu đúng tổng tiền; dropship cho phép CTV đặt COD cao hơn (lãi)
      let cod = new Decimal(0);
      if (pm === 'C') cod = opt.cod_amount != null ? new Decimal(opt.cod_amount) : total;
      else if (args.is_dropship && opt.cod_amount != null) cod = new Decimal(opt.cod_amount);
      if (pm === 'C' && cod.lt(total)) throw E.invalid(`cod_amount (${cod}) không được nhỏ hơn tổng tiền đơn (${total})`);
      // profit_amount: lãi của CTV dropship (COD - tổng tiền) hoặc hoa hồng cấp trên/aff (giá bán - giá gốc F1)
      const ctvParent = mode === 'N' && buyer && buyer.user_level !== 1 && !buyer.is_sa && buyer.parent_user_id ? buyer.parent_user_id : null;
      let profit = new Decimal(0);
      // voucher shop do shop chịu (trừ vào doanh thu shop), voucher sàn do sàn chịu → không trừ hoa hồng
      if (mode === 'A' || ctvParent) profit = commodity.minus(tenantProfit).minus(base);
      else if (args.is_dropship && cod.gt(0)) profit = cod.minus(total);

      const status: OrderStatusT = pm === 'Q' ? 'P' : 'W';
      const o = await tx.order.create({
        data: {
          unique_id: uuid(), code: code('DB'), tenant_id: tenant.id, buyer_user_id: buyer?.id ?? null, guest_client_id: args.guest_client_id ?? null,
          aff_user_id: args.aff_user_id ?? null, ctv_parent_user_id: ctvParent, shop_id: g.shop_id, shop_depot_code: depot.depot_code,
          order_type: mode === 'A' ? 'A' : mode === 'V' ? 'V' : 'N', order_status: status, shipping_method: opt.shipping_method ?? 'V', delivery_option: opt.delivery_option ?? 'N',
          payment_method: pm, payment_balance_type: 'A', shipping_payment_balance_type: 'A',
          commodity_amount: commodity, shipping_amount: g.shipping_amount, voucher_amount: shopV.plus(tenantV).plus(shipV), shop_voucher_amount: shopV, tenant_voucher_amount: tenantV, shipping_voucher_amount: shipV,
          total_amount: total, cod_amount: cod, profit_amount: profit.isNegative() ? 0 : profit, tenant_profit_amount: tenantProfit,
          weight_total_user: g.lines.reduce((a, l) => a.plus(l.variation_weight_vtp.mul(l.quantity)), new Decimal(0)),
          ...args.receiver, is_dropship: args.is_dropship ? 'T' : 'F', notes: opt.notes ?? null,
          buyer_vat_info: args.buyer_vat_info == null ? null : typeof args.buyer_vat_info === 'string' ? args.buyer_vat_info : JSON.stringify(args.buyer_vat_info),
          paid_at: pm === 'B' ? new Date() : null,
        },
      });
      for (const l of g.lines) {
        await tx.orderItem.create({
          data: {
            order_id: o.id, product_id: l.product_id, variation_id: l.variation_id, product_name: l.product_name, variation_name: l.variation_name, sku: l.sku,
            res_thumbnail_url: l.res_thumbnail_url ?? '', quantity: l.quantity, price: mode === 'V' ? 0 : l.fe_price_override, public_price: l.fe_price_public, base_price: l._base_price,
            fs_program_code: l.fs_program_code, pvv_unique_id: l.product_variation_virtual_unique_id,
          },
        });
        if (mode === 'V') {
          const pvv = await tx.productVariationVirtual.findUnique({ where: { unique_id: l.product_variation_virtual_unique_id! } });
          if (!pvv || pvv.owner_user_id !== buyer?.id || pvv.quantity - pvv.pending_out < l.quantity) throw E.business(`Kho ảo không đủ hàng ${l.sku}`);
          await tx.productVariationVirtual.update({ where: { id: pvv.id }, data: { pending_out: { increment: l.quantity } } });
        } else {
          await reserveStock(tx, l, depot.id);
        }
        if (l.fs_program_code) {
          const fs = await tx.flashSaleStock.findUnique({ where: { program_code_variation_id: { program_code: l.fs_program_code, variation_id: l.variation_id } } });
          if (!fs || fs.sold_quantity + l.quantity > fs.quantity) throw E.business(`Suất flash sale ${l.sku} đã hết`);
          await tx.flashSaleStock.update({ where: { id: fs.id }, data: { sold_quantity: { increment: l.quantity } } });
        }
      }
      // Voucher đã dùng
      for (const x of [ov?.shop_voucher, ov?.tenant_voucher, ov?.shipping_voucher]) {
        if (!x) continue;
        await tx.voucherUsage.create({ data: { voucher_id: x.voucher_id, user_key: owner_key, order_id: o.id, amount: x.discount_amount } });
        await tx.voucher.update({ where: { id: x.voucher_id }, data: { used_quantity: { increment: 1 }, used_amount: { increment: x.discount_amount } } });
      }
      // Thanh toán ví
      if (pm === 'B') {
        if (!buyer) throw E.unauthorized();
        await post(tx, buyer.id, 'A', total.neg(), { business_code: 'ORDER_PAY', ref_code: o.code, notes: `Thanh toán đơn ${o.code}` });
      }
      await tx.orderEvent.create({ data: { order_id: o.id, to_status: status, actor: buyer ? 'U' : 'X', actor_id: buyer?.id, notes: `Tạo đơn (${pm})` } });
      created.push(o);
    }
    // Dọn giỏ + voucher đã áp
    await tx.cartItem.deleteMany({ where: { owner_key, variation_id: { in: selected.map((l) => l.variation_id) } } });
    await tx.cartVoucher.deleteMany({ where: { owner_key } });
    return created;
  });
}

async function reserveStock(tx: Tx, l: CartLine, depot_id: number) {
  const s = await tx.stock.findUnique({ where: { variation_id_depot_id: { variation_id: l.variation_id, depot_id } } });
  if (!s || s.current_stock - s.pending_stock < l.quantity) throw E.outOfStock(l.sku);
  await tx.stock.update({ where: { id: s.id }, data: { pending_stock: { increment: l.quantity } } });
}

export function qrOf(o: Order) {
  if (o.payment_method !== 'Q') return { qr_content: null, qr_image_url: null };
  const content = `TT ${o.code}`;
  const bank = process.env.QR_BANK_BIN ?? '970436';
  const acc = process.env.QR_BANK_ACCOUNT ?? '0000000000';
  return { qr_content: content, qr_image_url: `https://img.vietqr.io/image/${bank}-${acc}-compact2.png?amount=${o.total_amount}&addInfo=${encodeURIComponent(content)}` };
}

// ───────────── Chuyển trạng thái + tiền ─────────────

const STOCK_RESERVED: OrderStatusT[] = ['U', 'P', 'O', 'W']; // đã giữ pending, chưa xuất kho
const STOCK_SHIPPED: OrderStatusT[] = ['G', 'Q', 'S', 'F', 'N', 'K']; // đã xuất kho thật

async function items(tx: Tx, order_id: number) {
  return tx.orderItem.findMany({ where: { order_id } });
}

async function depotId(tx: Tx, o: Order) {
  return (await tx.shopDepot.findUniqueOrThrow({ where: { depot_code: o.shop_depot_code } })).id;
}

/** Trả hàng về kho / kho ảo khi huỷ, bom, hoàn. */
async function releaseGoods(tx: Tx, o: Order, from: OrderStatusT) {
  const its = await items(tx, o.id);
  const did = await depotId(tx, o);
  for (const it of its) {
    if (it.pvv_unique_id) {
      const pvv = await tx.productVariationVirtual.findUnique({ where: { unique_id: it.pvv_unique_id } });
      if (!pvv) continue;
      if (STOCK_RESERVED.includes(from)) await tx.productVariationVirtual.update({ where: { id: pvv.id }, data: { pending_out: { decrement: it.quantity } } });
      else {
        const after = pvv.quantity + it.quantity;
        await tx.productVariationVirtual.update({ where: { id: pvv.id }, data: { quantity: after } });
        await tx.pvvLedger.create({ data: { pvv_id: pvv.id, action_code: 'I', business_code: 'ORDER_RETURN', quantity: it.quantity, quantity_after: after, ref_code: o.code } });
      }
      continue;
    }
    const s = await tx.stock.findUnique({ where: { variation_id_depot_id: { variation_id: it.variation_id, depot_id: did } } });
    if (!s) continue;
    if (STOCK_RESERVED.includes(from)) await tx.stock.update({ where: { id: s.id }, data: { pending_stock: { decrement: Math.min(it.quantity, s.pending_stock) } } });
    else await tx.stock.update({ where: { id: s.id }, data: { current_stock: { increment: it.quantity } } });
    if (it.fs_program_code && STOCK_RESERVED.includes(from))
      await tx.flashSaleStock.updateMany({ where: { program_code: it.fs_program_code, variation_id: it.variation_id }, data: { sold_quantity: { decrement: it.quantity } } });
  }
  if (STOCK_RESERVED.includes(from)) {
    const used = await tx.voucherUsage.findMany({ where: { order_id: o.id } });
    for (const u of used) await tx.voucher.update({ where: { id: u.voucher_id }, data: { used_quantity: { decrement: 1 }, used_amount: { decrement: u.amount } } });
    await tx.voucherUsage.deleteMany({ where: { order_id: o.id } });
  }
}

/** Xuất kho thật khi shop đóng gói xong. */
async function commitGoods(tx: Tx, o: Order) {
  const its = await items(tx, o.id);
  const did = await depotId(tx, o);
  for (const it of its) {
    if (it.pvv_unique_id) {
      const pvv = await tx.productVariationVirtual.findUniqueOrThrow({ where: { unique_id: it.pvv_unique_id } });
      const after = pvv.quantity - it.quantity;
      await tx.productVariationVirtual.update({ where: { id: pvv.id }, data: { quantity: after, pending_out: { decrement: it.quantity } } });
      await tx.pvvLedger.create({ data: { pvv_id: pvv.id, action_code: 'O', business_code: 'ORDER_OUT', quantity: it.quantity, quantity_after: after, ref_code: o.code } });
      continue;
    }
    await tx.stock.update({
      where: { variation_id_depot_id: { variation_id: it.variation_id, depot_id: did } },
      data: { current_stock: { decrement: it.quantity }, pending_stock: { decrement: it.quantity } },
    });
  }
}

/** Hoàn tiền buyer đã trả bằng ví (đơn trả trước). */
async function refundPaid(tx: Tx, o: Order, amount?: Decimal, reason = 'ORDER_REFUND') {
  // Trả trước bằng ví, hoặc COD đã thu tiền (đã giao) → hoàn về ví buyer. Khách vãng lai hoàn ngoài hệ thống.
  if (!o.buyer_user_id || (!o.paid_at && !o.delivered_at)) return;
  const a = amount ?? o.total_amount;
  if (a.gt(0)) await post(tx, o.buyer_user_id, 'A', a, { business_code: reason, ref_code: o.code, notes: `Hoàn tiền đơn ${o.code}` });
}

/** Tất toán khi đơn hoàn thành (D): shop nhận tiền hàng, CTV/aff nhận hoa hồng, COD dư trả về buyer. */
async function settle(tx: Tx, o: Order) {
  if (o.settled) return;
  const shop = await tx.shop.findUniqueOrThrow({ where: { id: o.shop_id } });
  const its = await items(tx, o.id);
  const base = its.reduce((a, i) => a.plus(i.base_price.mul(i.quantity)), new Decimal(0));
  // Shop: giá gốc (F1) cho đơn affiliate/khách lẻ có cấp trên; ngược lại tiền hàng trừ voucher shop tài trợ
  const shopRevenue = o.order_type === 'V' ? new Decimal(0) : o.aff_user_id || o.ctv_parent_user_id ? base.minus(o.shop_voucher_amount) : o.commodity_amount.minus(o.tenant_profit_amount).minus(o.shop_voucher_amount);
  if (shopRevenue.gt(0)) await post(tx, shop.user_id, 'A', shopRevenue, { business_code: 'ORDER_SETTLE', ref_code: o.code, notes: `Doanh thu đơn ${o.code}` });
  if (o.tenant_profit_amount.gt(0)) {
    const t = await tx.tenant.findUnique({ where: { id: o.tenant_id } });
    if (t?.owner_user_id) await post(tx, t.owner_user_id, 'A', o.tenant_profit_amount, { business_code: 'TENANT_COMMISSION', ref_code: o.code });
  }
  if (o.aff_user_id && o.profit_amount.gt(0)) await post(tx, o.aff_user_id, 'A', o.profit_amount, { business_code: 'AFF_COMMISSION', ref_code: o.code });
  if (o.ctv_parent_user_id && o.profit_amount.gt(0)) await post(tx, o.ctv_parent_user_id, 'A', o.profit_amount, { business_code: 'CTV_COMMISSION', ref_code: o.code });
  // Đơn của buyer có COD thu hộ: phần buyer được nhận về ví
  if (o.buyer_user_id && o.cod_amount.gt(0)) {
    const back = o.paid_at ? o.cod_amount : o.cod_amount.minus(o.total_amount);
    if (back.gt(0)) await post(tx, o.buyer_user_id, 'A', back, { business_code: 'COD_RETURN', ref_code: o.code, notes: `Tiền thu hộ đơn ${o.code}` });
  }
  // Điểm uy tín buyer +1 mỗi đơn hoàn thành
  if (o.buyer_user_id) await post(tx, o.buyer_user_id, 'U', 1, { business_code: 'REPUTATION', ref_code: o.code });
  for (const it of its) await tx.product.update({ where: { id: it.product_id }, data: { sold_count: { increment: it.quantity } } });
  await tx.order.update({ where: { id: o.id }, data: { settled: true } });
}

export type Actor = { kind: 'U' | 'S' | 'A' | 'T' | 'X'; id?: number };

/** Chuyển trạng thái đơn với đầy đủ hệ quả (kho, tiền, mốc thời gian). */
export async function transition(order_id: number, to: OrderStatusT, actor: Actor, opts: { notes?: string; force?: boolean; extra?: Prisma.OrderUpdateInput; refund_amount?: Decimal } = {}) {
  return prisma.$transaction(async (tx) => {
    const o = await tx.order.findUnique({ where: { id: order_id } });
    if (!o) throw E.notFound('Đơn hàng');
    const from = o.order_status as OrderStatusT;
    if (from === to) return o;
    if (!opts.force && !OrderTransitions[from]?.includes(to)) throw E.badTransition(from, to);
    const stamp: Prisma.OrderUpdateInput = {};
    if (to === 'G') { await commitGoods(tx, o); stamp.packed_at = new Date(); }
    if (to === 'S') stamp.shipping_at = new Date();
    if (to === 'F') stamp.delivered_at = new Date();
    if (to === 'O') stamp.paid_at = new Date();
    if (to === 'C') {
      // Huỷ khi đã xuất kho (force bởi SA) → trả hàng thật, ngược lại nhả pending
      await releaseGoods(tx, o, from);
      await refundPaid(tx, o);
      stamp.cancel_reason = opts.notes ?? null;
    }
    if (to === 'B') {
      // Bom hàng: trả hàng về kho; đơn trả trước hoàn tiền hàng nhưng giữ phí ship; đơn COD của buyer bị trừ phí ship
      await releaseGoods(tx, o, STOCK_SHIPPED.includes(from) ? from : 'S');
      if (o.paid_at) await refundPaid(tx, o, o.total_amount.minus(o.shipping_amount));
      else if (o.buyer_user_id) await post(tx, o.buyer_user_id, 'A', o.shipping_amount.neg(), { business_code: 'BOOM_PENALTY', ref_code: o.code, allowNegative: true });
      if (o.buyer_user_id) await post(tx, o.buyer_user_id, 'U', -5, { business_code: 'REPUTATION', ref_code: o.code, allowNegative: true });
    }
    if (to === 'X') {
      // Hoàn hàng sau khiếu nại: hàng về kho, hoàn tiền (một phần hoặc toàn bộ tiền hàng)
      await releaseGoods(tx, o, from);
      await refundPaid(tx, o, opts.refund_amount ?? o.total_amount);
    }
    if (to === 'D') { stamp.done_at = new Date(); await settle(tx, { ...o, order_status: 'D' }); }
    if (to === 'K') stamp.is_kn = 'T';
    if (from === 'K') stamp.is_kn = 'F';
    const up = await tx.order.update({ where: { id: o.id }, data: { order_status: to, ...stamp, ...opts.extra } });
    await tx.orderEvent.create({ data: { order_id: o.id, from_status: from, to_status: to, actor: actor.kind, actor_id: actor.id, notes: opts.notes } });
    return up;
  });
}

// ───────────── Serialize ─────────────

export async function orderRows(orders: Order[]) {
  const ids = orders.map((o) => o.id);
  const [its, shops, buyers, tenants] = await Promise.all([
    prisma.orderItem.findMany({ where: { order_id: { in: ids } }, orderBy: { id: 'asc' } }),
    prisma.shop.findMany({ where: { id: { in: [...new Set(orders.map((o) => o.shop_id))] } } }),
    prisma.user.findMany({ where: { id: { in: orders.map((o) => o.buyer_user_id).filter((x): x is number => !!x) } } }),
    prisma.tenant.findMany({ where: { id: { in: [...new Set(orders.map((o) => o.tenant_id))] } } }),
  ]);
  return orders.map((o) => {
    const oi = its.filter((i) => i.order_id === o.id);
    const f = oi[0];
    const b = buyers.find((x) => x.id === o.buyer_user_id);
    return {
      unique_id: o.unique_id, id: o.id, code: o.code, commodity_amount: o.commodity_amount, shipping_amount: o.shipping_amount, total_amount: o.total_amount,
      order_status: o.order_status, order_type: o.order_type, shipping_method: o.shipping_method, delivery_option: o.delivery_option, cod_amount: o.cod_amount,
      weight_total_user: o.weight_total_user, weight_total_partner: o.weight_total_partner, weight_fee_partner: o.weight_fee_partner, shipping_ref_code: o.shipping_ref_code,
      created_date: o.created_at, created_at: o.created_at, updated_at: o.updated_at,
      first_variation_name: f?.variation_name ?? null, first_variation_res_thumbnail_url: f?.res_thumbnail_url ?? null, first_variation_quantity: f?.quantity ?? 0,
      total_variation_count: oi.length, first_variation_price: f?.price ?? null, first_variation_public_price: f?.public_price ?? null,
      shop_name: shops.find((s) => s.id === o.shop_id)?.display_name ?? null, shop_depot_code: o.shop_depot_code, shop_id: o.shop_id,
      buyer_user_id: o.buyer_user_id, buyer_username: b?.username ?? null, buyer_fullname: b?.fullname ?? null,
      receiver_fullname: o.receiver_fullname, receiver_phone: o.receiver_phone, receiver_address_line: o.receiver_address_line,
      receiver_province_id: o.receiver_province_id, receiver_district_id: o.receiver_district_id, receiver_ward_id: o.receiver_ward_id,
      is_dropship: o.is_dropship, count_print: o.count_print, notes: o.notes, shop_notes: o.shop_notes, attachment_file_name: o.attachment_file_name,
      is_kn: o.is_kn, ...qrOf(o), tenant_id: o.tenant_id, domain_primary: tenants.find((t) => t.id === o.tenant_id)?.domain_primary ?? null,
      payment_method: o.payment_method, profit_amount: o.profit_amount, payment_balance_type: o.payment_balance_type, shipping_payment_balance_type: o.shipping_payment_balance_type,
      voucher_amount: o.voucher_amount, shop_voucher_amount: o.shop_voucher_amount, tenant_voucher_amount: o.tenant_voucher_amount, shipping_voucher_amount: o.shipping_voucher_amount,
      buyer_vat_info: o.buyer_vat_info, cancel_reason: o.cancel_reason,
      items: oi.map((i) => ({ order_detail_unique_id: `${o.unique_id}:${i.id}`, variation_id: i.variation_id, product_id: i.product_id, product_name: i.product_name, variation_name: i.variation_name, sku: i.sku, quantity: i.quantity, price: i.price, price_public: i.public_price, commodity_amount: i.price.mul(i.quantity), res_thumbnail_url: i.res_thumbnail_url, fs_program_code: i.fs_program_code, product_variation_virtual_unique_id: i.pvv_unique_id, storage_id: 6 })),
    };
  });
}

/** Danh sách theo dòng sản phẩm (list-bought / order-shipping-info). */
export async function lineRows(orders: Order[]) {
  const rows = await orderRows(orders);
  return rows.flatMap((o) => o.items.map((i) => ({
    order_id: o.id, order_unique_id: o.unique_id, order_code: o.code, order_status: o.order_status, shipping_method: o.shipping_method, shipping_ref_code: o.shipping_ref_code,
    is_dropship: o.is_dropship, order_type: o.order_type, shop_name: o.shop_name, shop_id: o.shop_id, commodity_amount: o.commodity_amount, shipping_amount: o.shipping_amount,
    total_amount: o.total_amount, voucher_amount: o.voucher_amount, shop_voucher_amount: o.shop_voucher_amount, tenant_voucher_amount: o.tenant_voucher_amount, shipping_voucher_amount: o.shipping_voucher_amount,
    delivery_option: o.delivery_option, cod_amount: o.cod_amount, tenant_id: o.tenant_id, domain_primary: o.domain_primary, qr_image_url: o.qr_image_url, qr_content: o.qr_content, shop_depot_code: o.shop_depot_code,
    receiver_fullname: o.receiver_fullname, receiver_phone: o.receiver_phone, created_at: o.created_at,
    product_id: i.product_id, product_name: i.product_name, sku: i.sku, variation_name: i.variation_name, quantity: i.quantity, price: i.price, res_thumbnail_url: i.res_thumbnail_url, storage_id: 6, hang_xin: 'F',
  })));
}

export async function receiverBook(orders: Order[]) {
  const seen = new Map<string, Order>();
  for (const o of orders) {
    const k = `${o.receiver_phone}|${o.receiver_address_line}`;
    if (!seen.has(k)) seen.set(k, o);
  }
  const list = [...seen.values()];
  const names = await locationNames(list.flatMap((o) => [o.receiver_province_id, o.receiver_district_id, o.receiver_ward_id]));
  return list.map((o) => ({
    receiver_fullname: o.receiver_fullname, receiver_address_line: o.receiver_address_line, receiver_phone: o.receiver_phone,
    receiver_province_id: o.receiver_province_id, receiver_province_name: names.get(o.receiver_province_id) ?? null,
    receiver_district_id: o.receiver_district_id, receiver_district_name: names.get(o.receiver_district_id) ?? null,
    receiver_ward_id: o.receiver_ward_id, receiver_ward_name: names.get(o.receiver_ward_id) ?? null, is_dropship: o.is_dropship, created_at: o.created_at,
  }));
}

/** Bộ lọc chung cho các màn danh sách đơn. */
export function orderFilter(b: Record<string, any>): Prisma.OrderWhereInput {
  const w: Prisma.OrderWhereInput = {};
  const s = b.status ?? b.order_status;
  if (s !== undefined && s !== '' && s !== null) w.order_status = Array.isArray(s) ? { in: s } : String(s).includes(',') ? { in: String(s).split(',') } : String(s);
  for (const k of ['order_type', 'shipping_method', 'delivery_option', 'shipping_ref_code', 'is_dropship', 'payment_balance_type', 'shipping_payment_balance_type'] as const)
    if (b[k] !== undefined && b[k] !== '' && b[k] !== null) (w as Record<string, unknown>)[k] = String(b[k]);
  if (b.order_code) w.code = { contains: String(b.order_code) };
  if (b.is_printed === 'T') w.count_print = { gt: 0 };
  if (b.is_printed === 'F') w.count_print = 0;
  const kw = b.customer_keyword ?? b.keyword ?? b.receiver_name ?? b.receiver_phone;
  if (kw) w.OR = [{ receiver_fullname: { contains: String(kw) } }, { receiver_phone: { contains: String(kw) } }, { code: { contains: String(kw) } }];
  if (b.from_date || b.to_date) {
    const r: { gte?: Date; lt?: Date } = {};
    if (b.from_date) r.gte = new Date(`${String(b.from_date).slice(0, 10)}T00:00:00Z`);
    if (b.to_date) { const d = new Date(`${String(b.to_date).slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); r.lt = d; }
    w.created_at = r;
  }
  return w;
}

export async function orderWhereWithItems(base: Prisma.OrderWhereInput, b: Record<string, any>) {
  const where: Prisma.OrderWhereInput = { ...base, ...orderFilter(b) };
  const itemCond: Prisma.OrderItemWhereInput = {};
  if (b.sku) itemCond.sku = { contains: String(b.sku) };
  if (b.product_id) itemCond.product_id = Number(b.product_id);
  if (b.product_name) itemCond.product_name = { contains: String(b.product_name) };
  if (Object.keys(itemCond).length) {
    const ids = (await prisma.orderItem.findMany({ where: itemCond, select: { order_id: true } })).map((i) => i.order_id);
    where.id = { in: ids };
  }
  return where;
}
