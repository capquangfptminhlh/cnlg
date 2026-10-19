import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { call, okCall, login, FX } from './helpers.js';

const db = new PrismaClient();
const bal = async (username: string, type = 'A') => {
  const u = await db.user.findUniqueOrThrow({ where: { username } });
  const b = await db.balance.findUnique({ where: { user_id_balance_type: { user_id: u.id, balance_type: type } } });
  return b ? b.amount.toNumber() : 0;
};
const stockOf = async (keyword: string) => {
  const card = (await okCall('POST', '/bff/variations/search', { keyword })).items[0];
  const s = await db.stock.findFirstOrThrow({ where: { variation_id: card.variation_id } });
  return { card, current: s.current_stock, pending: s.pending_stock };
};
const receiver = { receiver_fullname: 'Nguyễn B', receiver_phone: '0987654321', receiver_address_line: '5 Lê Lợi', receiver_province_id: 2, receiver_district_id: 135, receiver_ward_id: 1947 };

async function buy(username: string, keyword: string, qty: number, extra: Record<string, unknown> = {}) {
  const tok = await login(username);
  const { card } = await stockOf(keyword);
  const cart = await okCall('PUT', '/bff/carts/set-quantity', { items: [{ variation_id: card.variation_id, quantity: qty }] }, tok);
  const depot = cart.cart_items.find((c: any) => c.variation_id === card.variation_id).shop_depot_code;
  const res = await okCall('POST', `/bff/orders/${FX}/normal-submit`, { ...receiver, site_code: 'ROOT', order_options: [{ shop_depot_code: depot, shipping_method: 'V' }], payment_method: 'B', ...extra }, tok);
  return { tok, card, order: res[0] };
}

describe('đặt hàng & vòng đời đơn', () => {
  it('F1 trả bằng ví → shop xử lý → buyer xác nhận → tất toán cho shop', async () => {
    const before = await bal('ctv1');
    const shopBefore = await bal('shopdemo');
    const s0 = await stockOf('Tai nghe');
    const { tok, order } = await buy('ctv1', 'Tai nghe', 2);
    expect(order.status).toBe('W');
    const o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.commodity_amount.toNumber()).toBe(440000);
    expect(o.shipping_amount.toNumber()).toBe(30000); // HN → HCM, 300g
    expect(await bal('ctv1')).toBe(before - 470000);
    expect((await stockOf('Tai nghe')).pending).toBe(s0.pending + 2);
    // giỏ đã được dọn
    expect((await okCall('POST', '/bff/carts/my-cart', {}, tok)).cart_items).toHaveLength(0);

    const shop = await login('shopdemo');
    expect((await call('POST', '/bff/shop-orders/mark-shipping', { order_id: order.id }, shop)).body.error_code).toBe(3003);
    await okCall('POST', '/bff/shop-orders/da-dong-goi', { order_id: order.id }, shop);
    const s1 = await stockOf('Tai nghe');
    expect([s1.current, s1.pending]).toEqual([s0.current - 2, s0.pending]);
    const vd = await okCall('POST', '/bff/shop-orders/tao-van-don', { order_id: order.id }, shop);
    expect(vd.shipping_ref_code).toMatch(/^VTP/);
    await okCall('POST', '/bff/shop-orders/mark-shipping', { order_id: order.id }, shop);
    await okCall('POST', '/bff/shop-orders/mark-finish', { order_id: order.id }, shop);
    await okCall('POST', '/bff/orders/done-by-user', { order_id: order.id }, tok);
    expect(await bal('shopdemo')).toBe(shopBefore + 440000);
    expect(await bal('ctv1', 'U')).toBe(1);
    const hist = await okCall('POST', '/bff/orders/history', { status: 'D' }, tok);
    expect(hist.items[0]).toMatchObject({ code: o.code, order_status: 'D', first_variation_quantity: 2 });
    const cnt = await okCall('GET', '/bff/shop-orders/count-by-status', undefined, shop);
    expect(cnt.find((c: any) => c.order_status === 'D').counting).toBeGreaterThanOrEqual(1);
  });

  it('buyer huỷ đơn chưa đóng → hoàn tiền + nhả tồn', async () => {
    const before = await bal('ctv1');
    const s0 = await stockOf('Máy hút');
    const { tok, order } = await buy('ctv1', 'Máy hút', 1);
    await okCall('POST', '/bff/orders/cancel-by-user', { order_id: order.id }, tok);
    expect(await bal('ctv1')).toBe(before);
    expect((await stockOf('Máy hút')).pending).toBe(s0.pending);
  });

  it('không đủ số dư ví → lỗi 3001, không tạo đơn', async () => {
    const u = await db.user.findUniqueOrThrow({ where: { username: 'khach1' } });
    await db.balance.update({ where: { user_id_balance_type: { user_id: u.id, balance_type: 'A' } }, data: { amount: 1000 } });
    const tok = await login('khach1');
    const { card } = await stockOf('Sạc');
    const cart = await okCall('PUT', '/bff/carts/set-quantity', { items: [{ variation_id: card.variation_id, quantity: 1 }] }, tok);
    const r = await call('POST', `/bff/orders/${FX}/normal-submit`, { ...receiver, order_options: [{ shop_depot_code: cart.cart_items[0].shop_depot_code }], payment_method: 'B' }, tok);
    expect(r.body.error_code).toBe(3001);
    expect(await db.order.count({ where: { buyer_user_id: u.id } })).toBe(0);
    await db.balance.update({ where: { user_id_balance_type: { user_id: u.id, balance_type: 'A' } }, data: { amount: 5_000_000 } });
  });

  it('khách lẻ có cấp trên: CTV cấp trên hưởng chênh lệch khi đơn hoàn thành', async () => {
    const parentBefore = await bal('ctv1');
    const { tok, order } = await buy('khach1', 'Bình nước', 1);
    const o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    // khách lẻ: tenant gốc bật public_good_price nên khách cũng mua giá F1 → chênh lệch 0
    expect(o.ctv_parent_user_id).not.toBeNull();
    const shop = await login('shopdemo');
    for (const s of ['da-dong-goi', 'tao-van-don', 'mark-shipping', 'mark-finish']) await okCall('POST', `/bff/shop-orders/${s}`, { order_id: order.id }, shop);
    await okCall('POST', '/bff/orders/done-by-user', { order_id: order.id }, tok);
    expect(await bal('ctv1')).toBe(parentBefore + o.profit_amount.toNumber());
  });

  it('dropship COD: CTV đặt COD cao hơn → nhận lãi khi hoàn thành', async () => {
    const before = await bal('ctv1');
    const tok = await login('ctv1');
    const { card } = await stockOf('Tai nghe');
    const cart = await okCall('PUT', '/bff/carts/set-quantity', { items: [{ variation_id: card.variation_id, quantity: 1 }] }, tok);
    const [order] = await okCall('POST', `/bff/orders/${FX}/normal-submit`, { ...receiver, is_dropship: 'T', payment_method: 'C', order_options: [{ shop_depot_code: cart.cart_items[0].shop_depot_code, cod_amount: 400000 }] }, tok);
    const o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.profit_amount.toNumber()).toBe(400000 - 250000);
    expect(await bal('ctv1')).toBe(before); // COD: chưa trừ ví
    const du = await okCall('GET', '/bff/orders/tien-du-kien-buyer', undefined, tok);
    expect(du.total_profit).toBeGreaterThanOrEqual(150000);
    const shop = await login('shopdemo');
    for (const s of ['da-dong-goi', 'tao-van-don', 'mark-shipping', 'mark-finish']) await okCall('POST', `/bff/shop-orders/${s}`, { order_id: order.id }, shop);
    await okCall('POST', '/bff/orders/done-by-user', { order_id: order.id }, tok);
    expect(await bal('ctv1')).toBe(before + 150000);
  });

  it('bom hàng (SA đánh dấu sau khi giao thất bại) → trả hàng về kho, hoàn tiền hàng giữ phí ship', async () => {
    const before = await bal('ctv1');
    const s0 = await stockOf('Máy hút');
    const { order } = await buy('ctv1', 'Máy hút', 1);
    const shop = await login('shopdemo');
    for (const s of ['da-dong-goi', 'tao-van-don', 'mark-shipping']) await okCall('POST', `/bff/shop-orders/${s}`, { order_id: order.id }, shop);
    const o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    const { transition } = await import('../src/lib/orders.js');
    await transition(o.id, 'B', { kind: 'A' });
    expect(await bal('ctv1')).toBe(before - o.shipping_amount.toNumber());
    expect((await stockOf('Máy hút')).current).toBe(s0.current);
  });

  it('khiếu nại: shop chấp nhận → hoàn hàng & hoàn tiền', async () => {
    const before = await bal('ctv1');
    const { tok, order } = await buy('ctv1', 'Bình nước', 1);
    const shop = await login('shopdemo');
    for (const s of ['da-dong-goi', 'tao-van-don', 'mark-shipping', 'mark-finish']) await okCall('POST', `/bff/shop-orders/${s}`, { order_id: order.id }, shop);
    const c = await okCall('POST', '/bff/complain-requests', { order_id: order.id, complain_type: 'D', notes: 'Bình bị nứt' }, tok);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).order_status).toBe('K');
    expect((await call('POST', '/bff/orders/done-by-user', { order_id: order.id }, tok)).body.success).toBe(false);
    await okCall('POST', `/bff/complain-requests/${FX}/shop-let-user-win`, { unique_id: c.unique_id }, shop);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).order_status).toBe('X');
    expect(await bal('ctv1')).toBe(before);
  });

  it('khách vãng lai đặt COD; aff link đặt COD → người rải nhận hoa hồng', async () => {
    const { card } = await stockOf('Sạc');
    const c = await okCall('PUT', '/bff/guest-cart/set-quantity', { client_id: 'g-77', items: [{ variation_id: card.variation_id, quantity: 1 }] });
    const [g] = await okCall('POST', '/bff/orders/guest-submit', { client_id: 'g-77', ...receiver, order_option: [{ shop_depot_code: c.cart_items[0].shop_depot_code }] });
    expect(g.payment_method).toBe('C');
    const og = await db.order.findUniqueOrThrow({ where: { id: g.id } });
    expect(og.cod_amount.toNumber()).toBe(og.total_amount.toNumber());

    const t = await db.tenant.findFirstOrThrow();
    await db.tenant.update({ where: { id: t.id }, data: { public_good_price: false } });
    const before = await bal('ctv1');
    await okCall('PUT', `/bff/aff-carts/${FX}/set-quantity`, { aff_id: 'CTV1AFF', client_id: 'a-1', items: [{ variation_id: card.variation_id, quantity: 1 }] });
    const [a] = await okCall('POST', `/bff/orders/${FX}/aff-submit`, { aff_id: 'CTV1AFF', client_id: 'a-1', ...receiver, order_option: [{ shop_depot_code: c.cart_items[0].shop_depot_code }] });
    expect(a.aff_secure_code).toBeTruthy();
    const oa = await db.order.findUniqueOrThrow({ where: { id: a.id } });
    expect(oa.profit_amount.toNumber()).toBe(2650000 - 639000);
    const shop = await login('shopdemo');
    for (const s of ['da-dong-goi', 'tao-van-don', 'mark-shipping', 'mark-finish']) await okCall('POST', `/bff/shop-orders/${s}`, { order_id: a.id }, shop);
    const { transition } = await import('../src/lib/orders.js');
    await transition(a.id, 'D', { kind: 'X' });
    expect(await bal('ctv1')).toBe(before + 2650000 - 639000);
    const aff = await okCall('POST', `/bff/orders/${FX}/aff-list`, {}, await login('ctv1'));
    expect(aff.total_records).toBe(1);
    await db.tenant.update({ where: { id: t.id }, data: { public_good_price: true } });
  });
});

describe('voucher & flash sale', () => {
  it('shop tạo voucher → buyer áp vào giỏ → giảm trên đơn → hết lượt', async () => {
    const shop = await login('shopdemo');
    const now = Date.now();
    const v = await okCall('POST', `/bff/shop-vouchers/${FX}/create`, { code: 'GIAM50', name: 'Giảm 50k', voucher_kind: 'C', discount_type: 'A', discount_value: 50000, min_order_amount: 200000, scope: 'S', display_type: 'P', max_quantity: 1, from_time: new Date(now - 1000).toISOString(), to_time: new Date(now + 86400000).toISOString() }, shop);
    expect(v.code).toMatch(/^S\d+GIAM50$/);
    const tok = await login('ctv1');
    const { card } = await stockOf('Tai nghe');
    await okCall('PUT', '/bff/carts/set-quantity', { items: [{ variation_id: card.variation_id, quantity: 1 }] }, tok);
    const av = await okCall('POST', `/bff/carts/${FX}/vouchers/available`, {}, tok);
    expect(av.shop_vouchers.find((x: any) => x.code === v.code).usable).toBe(true);
    const ap = await okCall('POST', `/bff/carts/${FX}/vouchers/apply`, { code: v.code }, tok);
    expect(ap.shop_voucher_amount).toBe(50000);
    const cart = await okCall('POST', '/bff/carts/my-cart', {}, tok);
    expect(cart.applied_vouchers.shop_codes[0].code).toBe(v.code);
    const [o] = await okCall('POST', `/bff/orders/${FX}/normal-submit`, { ...receiver, order_options: [{ shop_depot_code: cart.cart_items[0].shop_depot_code }] }, tok);
    const ord = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(ord.shop_voucher_amount.toNumber()).toBe(50000);
    expect(ord.total_amount.toNumber()).toBe(220000 + 30000 - 50000);
    // hết lượt
    await okCall('PUT', '/bff/carts/set-quantity', { items: [{ variation_id: card.variation_id, quantity: 1 }] }, tok);
    expect((await call('POST', `/bff/carts/${FX}/vouchers/apply`, { code: v.code }, tok)).body.message).toMatch(/hết lượt/);
    // huỷ đơn → trả lượt
    await okCall('POST', '/bff/orders/cancel-by-user', { order_id: o.id }, tok);
    await okCall('POST', `/bff/carts/${FX}/vouchers/apply`, { code: v.code }, tok);
    await okCall('PUT', '/bff/carts/delete-items', { items: [{ variation_id: card.variation_id }] }, tok);
  });

  it('flash sale: cần hợp đồng → tạo chương trình → thêm suất → giá FS khi mua', async () => {
    const shop = await login('shopdemo');
    const now = Date.now();
    const prog = { name: 'Sale trưa', from_time: new Date(now - 60000).toISOString(), to_time: new Date(now + 3600000).toISOString() };
    expect((await call('POST', `/bff/flash-sale-programs/${FX}/submit`, prog, shop)).body.message).toMatch(/hợp đồng/);
    const before = await bal('shopdemo');
    const hd = await okCall('POST', `/bff/flash-sale-contracts/${FX}/submit`, { contract_duration: 7, contract_type: 'N' }, shop);
    expect(hd.rent_amount).toBe(70000);
    expect(await bal('shopdemo')).toBe(before - 70000);
    const p = await okCall('POST', `/bff/flash-sale-programs/${FX}/submit`, prog, shop);
    const { card } = await stockOf('Tai nghe');
    const vrow = await db.variation.findUniqueOrThrow({ where: { id: card.variation_id } });
    expect((await call('POST', `/bff/flash-sale-stocks/${FX}/add`, { program_code: p.code, items: [{ sku: vrow.sku, price_flash_sale: 300000, max_stock: 3 }] }, shop)).body.error_code).toBe(2001);
    const st = await okCall('POST', `/bff/flash-sale-stocks/${FX}/add`, { program_code: p.code, items: [{ sku: vrow.sku, price_flash_sale: 150000, max_stock: 3 }] }, shop);
    expect(st[0]).toMatchObject({ max_stock: 3, sold_stock: 0, price_flash_sale: 150000 });
    const price = await okCall('POST', '/bff/variations/get-price', { items: [{ variation_id: card.variation_id }] }, await login('ctv1'));
    expect(price[0]).toMatchObject({ fe_price_override: 150000, fe_price_override_source: 'FS', fs_program_code: p.code });
    const { order } = await buy('ctv1', 'Tai nghe', 2);
    const ord = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(ord.commodity_amount.toNumber()).toBe(300000);
    expect((await db.flashSaleStock.findFirstOrThrow({ where: { program_code: p.code } })).sold_quantity).toBe(2);
  });
});
