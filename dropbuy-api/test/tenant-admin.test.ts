import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { call, okCall, login, FX } from './helpers.js';
import { registry } from '../src/lib/router.js';

const db = new PrismaClient();

describe('website con', () => {
  it('mở website → thêm sp kèm hoa hồng → khách mua trên site con → chủ website nhận hoa hồng', async () => {
    const owner = await login('khach1');
    const u = await db.user.findUniqueOrThrow({ where: { username: 'khach1' } });
    await db.balance.update({ where: { user_id_balance_type: { user_id: u.id, balance_type: 'A' } }, data: { amount: 5_000_000 } });
    const c = await okCall('POST', `/bff/tenant-contracts/${FX}/submit`, { domain_name: 'myshop', product_quantity: 10, site_name: 'My Shop' }, owner);
    expect(c.tenant.domain_primary).toBe('myshop.dropbuy.local');
    const fx = c.tenant.fx_hash;
    const card = (await okCall('POST', '/bff/variations/search', { keyword: 'Máy hút' })).items[0];
    await okCall('POST', `/bff/tenant-products/${fx}/ensure`, { items: [{ product_id: card.product_id, commission: 10, home_status: 'H' }] }, owner);
    // public trên site con chỉ thấy sp đã thêm
    const onSite = await okCall('POST', '/bff/variations/search', {}, undefined).then(() => call('POST', '/bff/variations/search', {}));
    expect(onSite.body.data.total_records).toBeGreaterThan(1); // site gốc
    const a = await (await import('./helpers.js')).getApp();
    const r = await a.inject({ method: 'POST', url: '/bff/variations/search', payload: {}, headers: { 'x-tenant-fx-hash': fx } });
    expect(r.json().data.items.map((x: any) => x.product_id)).toEqual([card.product_id]);
    expect(r.json().data.items[0].fe_price_override).toBe(500000 * 1.1); // khách vãng lai: giá public + 10%
    const home = await okCall('GET', `/bff/tenant-owners/tenant-home-configs/${fx}/list`);
    expect(home[0].product_id).toBe(card.product_id);

    // khách vãng lai mua COD trên site con
    const cart = await a.inject({ method: 'PUT', url: '/bff/guest-cart/set-quantity', payload: { client_id: 'site-1', items: [{ variation_id: card.variation_id, quantity: 1 }] }, headers: { 'x-tenant-fx-hash': fx } });
    const depot = cart.json().data.cart_items[0].shop_depot_code;
    const sub = await a.inject({ method: 'POST', url: '/bff/orders/guest-submit', payload: { client_id: 'site-1', receiver_fullname: 'G', receiver_phone: '0977', receiver_address_line: 'x', receiver_province_id: 1, receiver_district_id: 24, receiver_ward_id: 482, order_option: [{ shop_depot_code: depot }] }, headers: { 'x-tenant-fx-hash': fx } });
    const oid = sub.json().data[0].id;
    const o = await db.order.findUniqueOrThrow({ where: { id: oid } });
    expect(o.tenant_profit_amount.toNumber()).toBe(50000);
    const ownerBefore = (await db.balance.findUniqueOrThrow({ where: { user_id_balance_type: { user_id: u.id, balance_type: 'A' } } })).amount.toNumber();
    const { transition } = await import('../src/lib/orders.js');
    for (const s of ['G', 'Q', 'S', 'F', 'D'] as const) await transition(oid, s, { kind: 'X' });
    const after = (await db.balance.findUniqueOrThrow({ where: { user_id_balance_type: { user_id: u.id, balance_type: 'A' } } })).amount.toNumber();
    expect(after).toBe(ownerBefore + 50000);
    const rep = await okCall('POST', `/bff/tenants/${fx}/r601-data-get`, {}, owner);
    expect(rep).toMatchObject({ tong_so_don: 1, loi_nhuan_ghi_nhan: 50000 });
    // quyền: người khác không quản trị được site này
    expect((await call('POST', `/bff/tenant-products/${fx}/list`, {}, await login('ctv1'))).status).toBe(403);
  });
});

describe('SA', () => {
  it('duyệt/khoá sp, khoá user, điều chỉnh ví, báo cáo', async () => {
    const sa = await login('admin');
    const pending = await okCall('POST', `/bff/sa/products/${FX}/list-v2`, { admin_status: 'W' }, sa);
    expect(pending.total_records).toBeGreaterThan(0);
    const pid = pending.items[0].product_id;
    await okCall('PUT', '/bff/sa/products/approve', { product_id: pid }, sa);
    expect((await db.product.findUniqueOrThrow({ where: { id: pid } })).admin_status).toBe('A');
    const k = await db.user.findUniqueOrThrow({ where: { username: 'f2user' } });
    await okCall('POST', '/bff/sa/users/lock', { user_id: k.id, locked: true }, sa);
    expect((await call('POST', '/bff/auth/login', { username: 'f2user', password: '123456' })).status).toBe(403);
    await okCall('POST', '/bff/sa/users/lock', { user_id: k.id, locked: false }, sa);
    const adj = await okCall('POST', '/bff/sa/trx/submit-for-sa', { tx: { user_id: k.id, balance_type: 'A', amount: 12345, notes: 'bù tiền' } }, sa);
    expect(adj.submited_tx.business_code).toBe('ADJUST');
    const top = await okCall('POST', `/bff/sa/balance/${FX}/report-top-balance`, { balance_types: ['A'], top: 3 }, sa);
    expect(top).toHaveLength(3);
    const rep = await okCall('POST', `/bff/sa/users/${FX}/report`, {}, sa);
    expect(rep.total_user).toBeGreaterThanOrEqual(5);
    expect((await call('GET', '/bff/sa/users/list', undefined, await login('ctv1'))).status).toBe(403);
  });

  it('rollback tất toán đảo các bút toán của đơn', async () => {
    const sa = await login('admin');
    const o = await db.order.findFirstOrThrow({ where: { settled: true, ctv_parent_user_id: null, aff_user_id: null }, orderBy: { id: 'asc' } });
    const shopUser = (await db.shop.findUniqueOrThrow({ where: { id: o.shop_id } })).user_id;
    const before = (await db.balance.findUniqueOrThrow({ where: { user_id_balance_type: { user_id: shopUser, balance_type: 'A' } } })).amount.toNumber();
    const r = await okCall('POST', `/bff/sa/order/${FX}/rollback-don-tat-toan`, { order_id: o.id }, sa);
    expect(r.order_status).toBe('F');
    const after = (await db.balance.findUniqueOrThrow({ where: { user_id_balance_type: { user_id: shopUser, balance_type: 'A' } } })).amount.toNumber();
    expect(after).toBe(before - o.commodity_amount.minus(o.shop_voucher_amount).minus(o.tenant_profit_amount).toNumber());
  });

  it('tích hợp (mock): cấu hình, map SKU, đẩy đơn sang KiotViet', async () => {
    process.env.INTEGRATION_MOCK = 'true';
    const shop = await login('shopdemo');
    expect((await call('POST', `/bff/kiotviet/${FX}/app-config/ensure`, { retailer: 'abc' }, shop)).body.message).toMatch(/Thiếu cấu hình/);
    const cfg = await okCall('POST', `/bff/kiotviet/${FX}/app-config/ensure`, { retailer: 'abc', client_id: 'id', client_secret: 'supersecret' }, shop);
    expect(cfg.config.client_secret).toBe('sup***');
    const found = await okCall('POST', `/bff/kiotviet/${FX}/search`, { keyword: 'TAI' }, shop);
    expect(found).toHaveLength(3);
    const o = await db.order.findFirstOrThrow({ where: { shop_id: (await db.shop.findFirstOrThrow({ where: { display_name: 'Shop Demo' } })).id } });
    const its = await db.orderItem.findMany({ where: { order_id: o.id } });
    expect((await call('POST', `/bff/kiotviet/${FX}/create-order`, { order_id: o.id }, shop)).body.message).toMatch(/Chưa map SKU/);
    await okCall('POST', `/bff/kiotviet/${FX}/product-mapping/bulk-upsert`, { items: its.map((i) => ({ sku: i.sku, external_code: `KV-${i.sku}` })) }, shop);
    const r = await okCall('POST', `/bff/kiotviet/${FX}/create-order`, { order_id: o.id }, shop);
    expect(r).toMatchObject({ external_code: `KIOTVIET-${o.code}`, already_created: false });
    expect((await okCall('POST', `/bff/kiotviet/${FX}/create-order`, { order_id: o.id }, shop)).already_created).toBe(true);
  });
});

describe('quét toàn bộ route', () => {
  it('không route nào văng lỗi 500 khi gọi với dữ liệu rỗng (SA, shop, khách)', async () => {
    const tokens = [await login('admin'), await login('shopdemo'), undefined];
    const crashes: string[] = [];
    for (const r of registry) {
      const url = r.path.replace(/:fx_hash/g, FX).replace(/:[a-z_]+/g, '999999');
      for (const t of tokens) {
        const res = await call(r.method, url, r.method === 'GET' || r.method === 'DELETE' ? undefined : {}, t);
        if (res.status >= 500) crashes.push(`${r.method} ${r.path} (${t ? 'auth' : 'guest'}) → ${res.status} ${res.body?.message}`);
      }
    }
    if (crashes.length) console.log(crashes.join('\n'));
    expect(crashes).toEqual([]);
  }, 300000);
});
