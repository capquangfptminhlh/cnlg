import { describe, it, expect } from 'vitest';
import { call, okCall, login, FX } from './helpers.js';
import { totp } from '../src/lib/totp.js';

describe('tài khoản', () => {
  it('đăng ký → kích hoạt → đăng nhập → hồ sơ', async () => {
    const reg = await okCall('POST', '/bff/register', { username: 'newuser', password: 'secret1', fullname: 'Người Mới', phone: '0912345678', email: 'new@example.test', registration_code: 'CTV1AFF', user_source: 'W' });
    expect(reg.status).toBe('P');
    const fail = await call('POST', '/bff/auth/login', { username: 'newuser', password: 'secret1' });
    expect(fail.status).toBe(403);
    await okCall('GET', `/bff/register/verify-email/${reg.activation_code}`);
    const tok = (await okCall('POST', '/bff/auth/login', { username: 'newuser', password: 'secret1' })).access_token;
    const me = await okCall('GET', '/bff/profile/me', undefined, tok);
    expect(me).toMatchObject({ username: 'newuser', status: 'A', email: 'new@example.test' });
    expect(me.parent_user_id).toBeTypeOf('number');
  });

  it('sai mật khẩu bị từ chối, không có token bị 401', async () => {
    expect((await call('POST', '/bff/auth/login', { username: 'khach1', password: 'x' })).status).toBe(401);
    expect((await call('GET', '/bff/profile/me')).status).toBe(401);
  });

  it('quên mật khẩu → đặt lại', async () => {
    const d = await okCall('GET', '/bff/register/forgot-password?email=new@example.test');
    await okCall('POST', '/bff/register/reset-password', { token: d.reset_token, password: 'secret2' });
    await okCall('POST', '/bff/auth/login', { username: 'newuser', password: 'secret2' });
  });

  it('MFA bật/tắt, đăng nhập cần totp', async () => {
    const tok = await login('ctv1');
    const s = await okCall('POST', `/bff/profile/${FX}/mfa-on`, {}, tok);
    expect(s.secret).toMatch(/^[A-Z2-7]+$/);
    expect((await call('POST', `/bff/profile/${FX}/mfa-on`, { totp: '000000' }, tok)).status).toBe(403);
    await okCall('POST', `/bff/profile/${FX}/mfa-on`, { totp: totp(s.secret) }, tok);
    const l = await okCall('POST', '/bff/auth/login', { username: 'ctv1', password: '123456' });
    expect(l.mfa_required).toBe(true);
    await okCall('POST', '/bff/auth/login', { username: 'ctv1', password: '123456', totp_code: totp(s.secret) });
    await okCall('POST', `/bff/profile/${FX}/mfa-off`, { totp: totp(s.secret) }, tok);
  });

  it('sổ địa chỉ: tạo, mặc định, sửa, xoá', async () => {
    const tok = await login('khach1');
    const a = await okCall('POST', '/bff/my-address', { fullname: 'A', phone: '0901', address_line: '1 Phố', province_id: 1, district_id: 22, ward_id: 449 }, tok);
    expect(a.is_default).toBe(true);
    expect(a.province_name).toBe('Hà Nội');
    const b = await okCall('POST', '/bff/my-address', { fullname: 'B', phone: '0902', address_line: '2 Phố', province_id: 2, district_id: 135, ward_id: 1947, is_default: true }, tok);
    const list = await okCall('GET', '/bff/my-address/list', undefined, tok);
    expect(list.items[0].unique_id).toBe(b.unique_id);
    expect(list.items.filter((x: any) => x.is_default)).toHaveLength(1);
    await okCall('PUT', '/bff/my-address', { unique_id: a.unique_id, note: 'giao giờ hành chính' }, tok);
    await okCall('DELETE', `/bff/my-address/${a.unique_id}`, undefined, tok);
    expect((await okCall('GET', '/bff/my-address/list', undefined, tok)).total_records).toBe(1);
  });

  it('tài khoản ngân hàng', async () => {
    const tok = await login('khach1');
    await okCall('POST', '/bff/user-bank-info', { bank_name: 'Vietcombank', bank_code: 'VC', acc_number: '0011', acc_name: 'nguyen van a', is_default: false }, tok);
    const l = await okCall('GET', '/bff/user-bank-info/list', undefined, tok);
    expect(l.find((x: any) => x.acc_number === '0011')).toMatchObject({ acc_name: 'NGUYEN VAN A' });
    expect(l.filter((x: any) => x.is_default)).toHaveLength(1);
  });
});

describe('catalog & giá', () => {
  it('tìm kiếm public, giá khách vs F1', async () => {
    const pub = await okCall('POST', '/bff/variations/search', { keyword: 'Sạc' });
    expect(pub.total_records).toBe(1);
    const card = pub.items[0];
    const guest = await okCall('POST', '/bff/variations/get-price-guest', { items: [{ variation_id: card.variation_id }] });
    const f1 = await okCall('POST', '/bff/variations/get-price', { items: [{ variation_id: card.variation_id }] }, await login('ctv1'));
    expect(f1[0]).toMatchObject({ fe_price_public: 2650000, fe_price_override: 639000, fe_price_override_source: 'F1' });
    // tenant gốc bật public_good_price → khách cũng thấy giá tốt
    expect(guest[0].fe_price_override).toBe(639000);
  });

  it('chi tiết sp + tồn theo kho + còn hàng', async () => {
    const card = (await okCall('POST', '/bff/variations/search', { keyword: 'Sạc' })).items[0];
    const d = await okCall('GET', `/bff/products/${FX}/${card.unique_id}`);
    expect(d.variations).toHaveLength(2);
    const st = await okCall('POST', `/bff/products/${FX}/get-stock-by-sku`, { product_unique_id: card.unique_id });
    expect(st.stock_infos[0].current_stocks).toBeGreaterThan(170); // seed 177, các test đơn có thể đã giữ vài cái
    const ins = await okCall('POST', '/bff/variations/in-stock', { product_ids: [card.product_id] });
    expect(ins).toEqual([{ product_id: card.product_id, in_stock: true }]);
  });

  it('shop tạo sp → chờ duyệt (không public) → biến thể', async () => {
    const tok = await login('shopdemo');
    const p = await okCall('POST', `/bff/products/${FX}/submit`, { name: 'Ốp lưng iPhone', price_public: 200000, price_f1: 50000, current_stock: 10, variation_weight_vtp: 100, category_id: 9 }, tok);
    expect(p.admin_status).toBe('W');
    expect((await call('GET', `/bff/products/${FX}/${p.unique_id}`)).status).toBe(404);
    const up = await okCall('PUT', `/bff/products/${FX}/update-variation`, {
      unique_id: p.unique_id,
      generated_variation_data: [{ name: 'iPhone 15', price_public: 200000, price_f1: 50000, current_stock: 5 }, { name: 'iPhone 16', price_public: 220000, price_f1: 60000, current_stock: 7 }],
    }, tok);
    expect(up.variations.map((v: any) => v.name)).toEqual(['iPhone 15', 'iPhone 16']);
    const list = await okCall('GET', `/bff/products/${FX}/list?admin_status=W`, undefined, tok);
    expect(list.total_records).toBe(1);
    const counts = await okCall('GET', `/bff/products/${FX}/count-by-status`, undefined, tok);
    expect(counts.find((c: any) => c.product_status === 'admin_W').counting).toBe(1);
  });
});

describe('giỏ hàng', () => {
  it('giỏ user: thêm, vượt tồn, chọn, xoá', async () => {
    const tok = await login('khach1');
    const card = (await okCall('POST', '/bff/variations/search', { keyword: 'Tai nghe' })).items[0];
    const c = await okCall('PUT', '/bff/carts/set-quantity', { items: [{ variation_id: card.variation_id, quantity: 2 }] }, tok);
    const line = c.cart_items[0];
    expect(line).toMatchObject({ quantity: 2, selected_for_checkout: true });
    expect(line.sub_amount).toBe(line.fe_price_override * 2);
    expect(c.total_amount).toBe(line.sub_amount);
    expect((await call('PUT', '/bff/carts/set-quantity', { items: [{ variation_id: card.variation_id, quantity: 999 }] }, tok)).body.error_code).toBe(3002);
    const s = await okCall('PUT', '/bff/carts/set-selected-items', { items: [] }, tok);
    expect(s.total_amount).toBe(0);
    const d = await okCall('PUT', '/bff/carts/delete-items', { items: [{ variation_id: card.variation_id }] }, tok);
    expect(d.cart_items).toHaveLength(0);
  });

  it('giỏ khách vãng lai theo client_id + phí ship', async () => {
    const card = (await okCall('POST', '/bff/variations/search', { keyword: 'Máy hút' })).items[0];
    const c = await okCall('PUT', '/bff/guest-cart/set-quantity', { client_id: 'browser-1', items: [{ variation_id: card.variation_id, quantity: 1 }] });
    expect(c.total_weight).toBe(1200);
    const fee = await okCall('POST', '/bff/guest-cart/get-shipping-fee', { client_id: 'browser-1', shop_depot_code: c.cart_items[0].shop_depot_code, shipping_method: 'V', receiver_province_id: 2, receiver_ward_id: 1947 });
    expect(fee.shipping_amount).toBe(30000 + 2 * 5000);
    const other = await okCall('POST', '/bff/guest-cart/my-cart', { client_id: 'browser-2' });
    expect(other.cart_items).toHaveLength(0);
  });

  it('giỏ affiliate dùng aff_code', async () => {
    const card = (await okCall('POST', '/bff/variations/search', { keyword: 'Bình nước' })).items[0];
    const c = await okCall('PUT', `/bff/aff-carts/${FX}/set-quantity`, { aff_id: 'CTV1AFF', client_id: 'b-9', items: [{ variation_id: card.variation_id, quantity: 1 }] });
    expect(c.cart_items).toHaveLength(1);
    expect((await call('POST', `/bff/aff-carts/${FX}/my-cart`, { aff_id: 'NOPE', client_id: 'b-9' })).status).toBe(404);
  });
});
