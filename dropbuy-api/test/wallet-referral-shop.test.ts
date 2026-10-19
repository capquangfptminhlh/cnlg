import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { call, okCall, login, FX } from './helpers.js';

const db = new PrismaClient();
const uid = async (username: string) => (await db.user.findUniqueOrThrow({ where: { username } })).id;
const bal = async (username: string, type = 'A') => {
  const b = await db.balance.findUnique({ where: { user_id_balance_type: { user_id: await uid(username), balance_type: type } } });
  return b ? b.amount.toNumber() : 0;
};
const setBal = async (username: string, type: string, amount: number) => {
  const user_id = await uid(username);
  await db.balance.upsert({ where: { user_id_balance_type: { user_id, balance_type: type } }, create: { unique_id: `${user_id}-${type}`, user_id, balance_type: type, amount }, update: { amount } });
};

describe('ví', () => {
  it('số dư, chuyển khả dụng ↔ đặt cọc, sao kê', async () => {
    const tok = await login('khach1');
    const before = await bal('khach1');
    await okCall('POST', `/bff/balance/${FX}/transfer-to-lock`, { transfer_amount: 100000 }, tok);
    expect(await bal('khach1')).toBe(before - 100000);
    expect(await bal('khach1', 'L')).toBe(100000);
    await okCall('POST', `/bff/balance/${FX}/transfer-to-avai`, { transfer_amount: 100000 }, tok);
    const my = await okCall('GET', '/bff/balance/my-balance', undefined, tok);
    expect(my.find((b: any) => b.type === 'A').current_balance).toBe(before);
    const sk = await okCall('POST', `/bff/balance/${FX}/sao-ke`, { balance_type: 'A' }, tok);
    expect(sk.items[0]).toMatchObject({ business_code: 'INTERNAL_TRANSFER', action_code: 'I', amount: 100000 });
    expect((await call('POST', `/bff/balance/${FX}/transfer-to-avai`, { transfer_amount: 1 }, tok)).body.error_code).toBe(3001);
  });

  it('nạp qua QR → SA xác nhận; rút → SA từ chối thì hoàn', async () => {
    const tok = await login('khach1');
    const sa = await login('admin');
    const before = await bal('khach1');
    const dep = await okCall('GET', '/bff/balance/get-deposit-link?amount=200000', undefined, tok);
    expect(dep.qr_link).toContain('vietqr');
    await okCall('PUT', `/bff/sa/dw-transactions/mark-confirm/${dep.code}`, { amount: 200000 }, sa);
    expect(await bal('khach1')).toBe(before + 200000);
    expect((await call('PUT', `/bff/sa/dw-transactions/mark-confirm/${dep.code}`, {}, sa)).body.message).toMatch(/đã được xử lý/);
    if (!(await db.userBankInfo.count({ where: { user_id: await uid('khach1') } }))) await okCall('POST', '/bff/user-bank-info', { bank_name: 'VCB', bank_code: 'VC', acc_number: '1', acc_name: 'A', is_default: true }, tok);
    const wd = await okCall('POST', '/bff/balance/wd', { amount: 150000 }, tok);
    expect(await bal('khach1')).toBe(before + 50000);
    await okCall('PUT', `/bff/sa/dw-transactions/mark-confirm/${wd.code}`, { reject: true }, sa);
    expect(await bal('khach1')).toBe(before + 200000);
    const list = await okCall('GET', '/bff/sa/dw-transactions/list?dw_type=W', undefined, sa);
    expect(list.items[0]).toMatchObject({ code: wd.code, status: 'R', username: 'khach1' });
  });

  it('chuyển xu P2P: giữ tiền → người nhận xác nhận; khiếu nại → SA cho người gửi thắng', async () => {
    await setBal('khach1', 'X', 1000);
    const a = await login('khach1');
    const b = await login('ctv1');
    const t = await okCall('POST', `/bff/balance-transfers/${FX}/transfer-xu-approve`, { transfer_amount: 300, to_user_id: await uid('ctv1') }, a);
    expect(await bal('khach1', 'X')).toBe(700);
    expect(await bal('ctv1', 'X')).toBe(0);
    await okCall('POST', `/bff/balance-transfers/${FX}/transfer-xu-confirm`, { code: t.code }, b);
    expect(await bal('ctv1', 'X')).toBe(300);
    await okCall('POST', `/bff/balance-transfers/${FX}/transfer-xu-complain-create`, { code: t.code, notes: 'Không nhận được hàng' }, a);
    await okCall('POST', `/bff/balance-transfers/${FX}/transfer-xu-complain-from-win`, { code: t.code }, await login('admin'));
    expect([await bal('khach1', 'X'), await bal('ctv1', 'X')]).toEqual([1000, 0]);
    const lst = await okCall('POST', `/bff/balance-transfers/${FX}/transfer-xu-list-for-from`, {}, a);
    expect(lst.items[0]).toMatchObject({ code: t.code, status: 'C', kn_status: 'F' });
  });

  it('sàn xu: lệnh bán chờ, lệnh mua giá cao hơn khớp theo giá bán, phần dư hoàn lại', async () => {
    await setBal('khach1', 'X', 1000);
    const seller = await login('khach1');
    const buyer = await login('ctv1');
    const sA = await bal('khach1');
    const bA = await bal('ctv1');
    const sell = await okCall('POST', `/bff/xu-exchange-requests/${FX}/sell`, { rate: 900, xu_volume: 100 }, seller);
    expect(sell.status).toBe('P');
    expect(await bal('khach1', 'X')).toBe(900);
    const buy = await okCall('POST', `/bff/xu-exchange-requests/${FX}/buy`, { rate: 1000, xu_volume: 60 }, buyer);
    expect(buy).toMatchObject({ status: 'D', total_xu_volume_mapping: 60, total_commodity_amount_mapping: 54000 });
    expect(await bal('ctv1', 'X')).toBe(60);
    expect(await bal('ctv1')).toBe(bA - 54000);
    expect(await bal('ctv1', 'L')).toBe(0);
    expect(await bal('khach1')).toBe(sA + 54000);
    // huỷ phần còn lại của lệnh bán → trả 40 xu
    await okCall('POST', `/bff/xu-exchange-requests/${FX}/cancel`, { id: sell.id }, seller);
    expect(await bal('khach1', 'X')).toBe(940);
  });
});

describe('CTV & nhóm hoa hồng', () => {
  it('F1 tạo nhóm 10%, duyệt cấp dưới → cấp dưới mua giá F1+10%, F1 nhận chênh lệch khi hoàn thành', async () => {
    const f1 = await login('ctv1');
    await okCall('POST', '/bff/user-referral-groups/create', { title: 'Nhóm 10%', commission: 10 }, f1);
    const groups = await okCall('GET', '/bff/user-referral-groups/list', undefined, f1);
    const g = groups.items[0];
    expect(g).toMatchObject({ commission: 10, is_default: true });
    // đăng ký tài khoản mới dưới ctv1
    const reg = await okCall('POST', '/bff/register', { username: 'f2user', password: '123456', fullname: 'F2', phone: '0911111111', email: 'f2@example.test', registration_code: 'CTV1AFF', user_source: 'W' });
    await okCall('GET', `/bff/register/verify-email/${reg.activation_code}`);
    const pending = await okCall('GET', '/bff/user-referrals/list?pending_approve=T', undefined, f1);
    expect(pending.items.map((x: any) => x.username)).toContain('f2user');
    const ap = await okCall('PUT', '/bff/user-referrals/approve', { items: [{ user_id: reg.user_id, user_referral_group_id: g.id }] }, f1);
    expect(ap[0].message).toBe('OK');
    const f2 = await login('f2user');
    const card = (await okCall('POST', '/bff/variations/search', { keyword: 'Bình nước' })).items[0];
    const price = await okCall('POST', '/bff/variations/get-price', { items: [{ variation_id: card.variation_id }] }, f2);
    expect(price[0]).toMatchObject({ fe_price_group: 109999, fe_price_override_source: 'F2' }); // 99.999 × 1.1 = 109.998,9 → làm tròn
    // hoa hồng riêng cho sp này: 20%
    await okCall('POST', '/bff/user-referral-group-details/ensure', { referral_group_id: g.id, product_id: card.product_id, commission: 20 }, f1);
    expect((await okCall('POST', '/bff/variations/get-price', { items: [{ variation_id: card.variation_id }] }, f2))[0].fe_price_group).toBe(119999);
    // F2 nạp tiền, mua, đơn hoàn thành → F1 nhận 20.000
    await setBal('f2user', 'A', 1_000_000);
    const before = await bal('ctv1');
    const cart = await okCall('PUT', '/bff/carts/set-quantity', { items: [{ variation_id: card.variation_id, quantity: 1 }] }, f2);
    const [o] = await okCall('POST', `/bff/orders/${FX}/normal-submit`, { receiver_fullname: 'X', receiver_phone: '0900', receiver_address_line: 'a', receiver_province_id: 1, receiver_district_id: 22, receiver_ward_id: 449, order_options: [{ shop_depot_code: cart.cart_items[0].shop_depot_code }] }, f2);
    const shop = await login('shopdemo');
    for (const s of ['da-dong-goi', 'tao-van-don', 'mark-shipping', 'mark-finish']) await okCall('POST', `/bff/shop-orders/${s}`, { order_id: o.id }, shop);
    await okCall('POST', '/bff/orders/done-by-user', { order_id: o.id }, f2);
    expect(await bal('ctv1')).toBe(before + 20000);
    const ctvOrders = await okCall('POST', `/bff/orders/${FX}/list-ctv`, {}, f1);
    expect(ctvOrders.items.some((x: any) => x.id === o.id)).toBe(true);
  });

  it('đổi người giới thiệu: gửi → người mới duyệt', async () => {
    const me = await login('khach1');
    const req1 = await okCall('POST', `/bff/change-referral-requests/${FX}/submit`, { new_referral_user_id: await uid('shopdemo'), notes: 'chuyển nhóm' }, me);
    expect(req1.status).toBe('P');
    expect((await call('POST', `/bff/change-referral-requests/${FX}/submit`, { new_referral_user_id: await uid('admin') }, me)).status).toBe(409);
    const shop = await login('shopdemo');
    const lst = await okCall('POST', `/bff/change-referral-requests/${FX}/list`, { status: 'P' }, shop);
    expect(lst.items[0].unique_id).toBe(req1.unique_id);
    await okCall('POST', `/bff/change-referral-requests/${FX}/approve`, { unique_id: req1.unique_id }, shop);
    expect((await db.user.findUniqueOrThrow({ where: { username: 'khach1' } })).parent_user_id).toBe(await uid('shopdemo'));
  });
});

describe('gian hàng, kho, kho ảo', () => {
  it('đăng ký shop → tạo kho → không xoá được kho còn hàng', async () => {
    const tok = await login('f2user');
    const s = await okCall('POST', '/bff/shop/register', { shop_name: 'Shop F2', province_id: 2, district_id: 135, ward_id: 1947, address_line: '9 Nguyễn Huệ', pic_phone: '0933' }, tok);
    expect(s.default_depot_code).toMatch(/^DP-/);
    const d = await okCall('POST', '/bff/shop-depots', { fullname: 'Kho 2', phone: '0933', address_line: 'x', province_id: 1, district_id: 22, ward_id: 449 }, tok);
    const list = await okCall('GET', '/bff/shop-depots/list', undefined, tok);
    expect(list.total_records).toBe(2);
    await okCall('POST', `/bff/products/${FX}/submit`, { name: 'Áo thun', price_public: 150000, price_f1: 60000, current_stock: 5, depot_code: d.depot_code }, tok);
    expect((await call('DELETE', `/bff/shop-depots/${d.unique_id}`, undefined, tok)).body.message).toMatch(/còn hàng/);
    expect((await okCall('POST', '/bff/shop/search', { keyword: 'Shop F2' })).total_records).toBe(1);
  });

  it('thuê kho → nhập hàng kho ảo → xuất đơn từ kho ảo (chỉ trả ship) → chuyển kho ảo cho người khác', async () => {
    const buyer = await login('ctv1');
    const shop = await login('shopdemo');
    const shopRow = await db.shop.findFirstOrThrow({ where: { user: undefined, display_name: 'Shop Demo' } as never });
    const depot = await db.shopDepot.findFirstOrThrow({ where: { shop_id: shopRow.id } });
    await setBal('ctv1', 'A', 5_000_000);
    const c = await okCall('POST', '/bff/shop-depot-contracts/submit', { shop_id: shopRow.id, contract_duration: 30, weight_capacity_total: 5000 }, buyer);
    expect(c.rent_amount).toBe(2000 * 5 * 30);
    expect(await bal('ctv1', 'L')).toBe(300000);
    const shopBefore = await bal('shopdemo');
    await okCall('POST', '/bff/shop-depot-contracts/shop-approved-contract', { unique_id: c.unique_id }, shop);
    expect(await bal('shopdemo')).toBe(shopBefore + 300000);
    expect((await okCall('GET', '/bff/shop-depot-contracts/my-available-list', undefined, buyer))).toHaveLength(1);

    const v = await db.variation.findFirstOrThrow({ where: { name: 'Tai nghe Bluetooth K5' } });
    const st0 = (await db.stock.findFirstOrThrow({ where: { variation_id: v.id } })).current_stock;
    // 150g × 40 = 6000g > 5000g sức chứa
    expect((await call('POST', '/bff/product-variation-virtual-request/submit', { variation_unique_id: v.id, from_shop_depot_code: depot.depot_code, quantity: 40 }, buyer)).body.message).toMatch(/sức chứa/);
    const r = await okCall('POST', '/bff/product-variation-virtual-request/submit', { variation_unique_id: v.id, from_shop_depot_code: depot.depot_code, quantity: 10 }, buyer);
    expect(r.status).toBe('P');
    await okCall('POST', '/bff/shop-depots/product-variation-virtual-request/approve', { unique_id: r.unique_id }, shop);
    expect((await db.stock.findFirstOrThrow({ where: { variation_id: v.id } })).current_stock).toBe(st0 - 10);
    const mine = await okCall('POST', '/bff/product-variation-virtuals/search-by-buyer', {}, buyer);
    const pvv = mine.items[0];
    expect(pvv).toMatchObject({ current_stock: 10, buyer_price: 220000 });

    // xuất 2 cái từ kho ảo
    const aBefore = await bal('ctv1');
    await okCall('PUT', '/bff/carts/set-quantity', { items: [{ variation_id: v.id, quantity: 2, product_variation_virtual_unique_id: pvv.unique_id }] }, buyer);
    const [o] = await okCall('POST', `/bff/orders/${FX}/pvv-submit`, { receiver_fullname: 'K', receiver_phone: '09', receiver_address_line: 'a', receiver_province_id: 1, receiver_district_id: 24, receiver_ward_id: 482, order_options: [{ shop_depot_code: depot.depot_code }] }, buyer);
    const ord = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(ord.commodity_amount.toNumber()).toBe(0);
    expect(await bal('ctv1')).toBe(aBefore - ord.shipping_amount.toNumber());
    await okCall('POST', '/bff/shop-orders/da-dong-goi', { order_id: o.id }, shop);
    expect((await db.productVariationVirtual.findUniqueOrThrow({ where: { unique_id: pvv.unique_id } })).quantity).toBe(8);

    // chuyển 3 cái cho khach1 giá 500.000
    const t = await okCall('POST', `/bff/product-variation-virtual-transfers/${FX}/submit`, { pvv_unique_id: pvv.unique_id, to_user_id: await uid('khach1'), transfer_quantity: 3, transfer_amount: 500000 }, buyer);
    const k = await login('khach1');
    expect((await call('POST', `/bff/product-variation-virtual-transfers/${FX}/b-confirm`, { unique_id: t.unique_id, otp_code: '000000' }, k)).body.error_code).toBe(2001);
    const kBefore = await bal('khach1');
    await okCall('POST', `/bff/product-variation-virtual-transfers/${FX}/b-confirm`, { unique_id: t.unique_id, otp_code: t.otp_code }, k);
    expect(await bal('khach1')).toBe(kBefore - 500000);
    const kMine = await okCall('POST', '/bff/product-variation-virtuals/search-by-buyer', {}, k);
    expect(kMine.items[0].current_stock).toBe(3);
    const sk = await okCall('POST', `/bff/product-variation-virtuals/${FX}/sao-ke`, { sku: v.sku }, buyer);
    expect(sk.items.map((x: any) => x.business_code)).toEqual(expect.arrayContaining(['REQUEST_IN', 'ORDER_OUT', 'TRANSFER_OUT']));
  });
});
