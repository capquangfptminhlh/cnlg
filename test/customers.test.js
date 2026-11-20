'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.HM_CUSTOMERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cust-'));
const express = require('express');
const customers = require('../services/customers');
const cp = require('../services/customerPricing');

const RULES = cp.normalizeRules({});
const cookieOf = c => `${customers.COOKIE}=${customers.sessionToken(c)}`;
const full = id => customers.getAll().find(c => c.id === id);

test('giá lẻ = giá sỉ +20%, làm tròn lên nghìn, không vượt giá niêm yết, không thấp hơn giá sỉ', () => {
  assert.equal(cp.retailPrice(100000, null, RULES), 120000);
  assert.equal(cp.retailPrice(99500, null, RULES), 120000); // 119.400 → 120.000
  assert.equal(cp.retailPrice(100000, 110000, RULES), 110000); // trần giá niêm yết
  assert.equal(cp.retailPrice(100000, 400000, RULES), 120000); // niêm yết ảo (>70%) không dùng làm trần
  assert.equal(cp.retailPrice(100000, 90000, RULES), 120000); // niêm yết thấp hơn giá sỉ: bỏ qua
  assert.equal(cp.retailPrice(100000, null, cp.normalizeRules({ capAtListed: false, markupPercent: 10 })), 110000);
  assert.equal(cp.retailPrice(100000, null, cp.normalizeRules({ enabled: false })), 100000);
  assert.equal(cp.retailPrice(0, null, RULES), 0);
});

test('đổi giá lẻ cho SP, phân loại lồng nhau và tính lại % giảm', () => {
  const out = cp.retailizeDeep({ success: true, total: 1, data: [{ id: 1, price: 100000, original_price: 200000, discount_percent: 50,
    variants: [{ id: 'a', price: 50000, original_price: 52000, discount_percent: 4 }] }] }, RULES);
  const p = out.data[0];
  assert.equal(p.price, 120000);
  assert.equal(p.original_price, 200000);
  assert.equal(p.discount_percent, 40);
  assert.equal(p.variants[0].price, 52000); // chạm trần niêm yết
  assert.equal(p.variants[0].original_price, null);
  assert.equal(p.variants[0].discount_percent, 0);
  assert.equal(out.total, 1);
});

test('đăng ký → chờ duyệt (giá lẻ) → duyệt (giá sỉ) → khoá / đổi mật khẩu làm mất phiên', () => {
  const v = customers.register({ phone: '0912 345 678', password: 'matkhau1', name: 'Shop Test', shop_name: 'Shop A' });
  assert.equal(v.status, 'pending');
  assert.equal(v.phone, '0912345678');
  assert.equal(JSON.stringify(v).includes('matkhau1'), false);
  assert.equal(JSON.stringify(customers.getAll()).includes('matkhau1'), false);
  assert.throws(() => customers.register({ phone: '+84912345678', password: 'xxxxxx', name: 'Trùng' }), /đã đăng ký/);
  assert.throws(() => customers.register({ phone: '12345', password: 'xxxxxx', name: 'A B' }), /không hợp lệ/);
  assert.throws(() => customers.register({ phone: '0987654321', password: '123', name: 'A B' }), /6 ký tự/);

  assert.equal(customers.login('0912345678', 'sai-mat-khau'), null);
  assert.equal(customers.login('0900000000', 'matkhau1'), null);
  const c = customers.login('0912345678', 'matkhau1');
  assert.ok(c);
  assert.equal(cp.tierOfCookie(cookieOf(c)), 'retail'); // chờ duyệt vẫn giá lẻ

  customers.setStatus(c.id, 'approved');
  const cookie = cookieOf(full(c.id));
  assert.equal(cp.tierOfCookie(cookie), 'wholesale');

  customers.setStatus(c.id, 'disabled');
  assert.equal(cp.tierOfCookie(cookie), 'retail');
  customers.setStatus(c.id, 'approved');
  assert.equal(cp.tierOfCookie(cookie), 'wholesale');

  customers.resetPassword(c.id, 'matkhau2');
  assert.equal(cp.tierOfCookie(cookie), 'retail'); // phiên cũ hết hiệu lực
  assert.ok(customers.login('0912345678', 'matkhau2'));
});

test('cookie giả / sửa / hết hạn không được giá sỉ', () => {
  const v = customers.register({ phone: '0987000111', password: 'matkhau1', name: 'Shop B' });
  customers.setStatus(v.id, 'approved');
  const good = customers.sessionToken(full(v.id));
  const [id, exp, pwv, sig] = good.split('.');
  assert.equal(cp.tierOfCookie(`${customers.COOKIE}=${good}`), 'wholesale');
  assert.equal(cp.tierOfCookie(`${customers.COOKIE}=${id}.${Number(exp) + 999}.${pwv}.${sig}`), 'retail');
  assert.equal(cp.tierOfCookie(`${customers.COOKIE}=${id}.${exp}.${pwv}.AAAA${sig.slice(4)}`), 'retail');
  assert.equal(cp.tierOfCookie(`${customers.COOKIE}=${customers.sessionToken(full(v.id), Date.now() - 31 * 86400e3)}`), 'retail');
  assert.equal(cp.tierOfCookie(''), 'retail');
  assert.equal(cp.tierOfCookie(undefined), 'retail');
});

function listen(app) {
  return new Promise(resolve => {
    const srv = http.createServer(app).listen(0, () => resolve(srv));
  });
}

test('API sản phẩm: khách lẻ nhận giá lẻ, khách sỉ nhận giá sỉ và không cache chung', async () => {
  const v = customers.register({ phone: '0977111222', password: 'matkhau1', name: 'Shop C' });
  customers.setStatus(v.id, 'approved');
  const app = express();
  app.use('/api/products', cp.priceResponses(() => ({})));
  app.get('/api/products', (req, res) => res.set('Cache-Control', 'public, max-age=30').json({ success: true, data: [{ id: 1, price: 100000, original_price: null }] }));
  const srv = await listen(app);
  const url = `http://127.0.0.1:${srv.address().port}/api/products`;
  try {
    const guest = await fetch(url);
    assert.equal((await guest.json()).data[0].price, 120000);
    assert.match(guest.headers.get('vary') || '', /Cookie/i);
    const si = await fetch(url, { headers: { cookie: cookieOf(full(v.id)) } });
    assert.equal((await si.json()).data[0].price, 100000);
    assert.match(si.headers.get('cache-control'), /private/);
  } finally {
    srv.close();
  }
});

test('socket: giá đẩy realtime tách phòng sỉ / lẻ, ảnh qua bộ che nguồn', () => {
  const sent = [];
  const fakeIo = {
    on() {}, sockets: {},
    to: room => ({ emit: (ev, payload) => sent.push({ room, ev, payload }) }),
    emit: (ev, payload) => sent.push({ room: '*', ev, payload })
  };
  const tio = cp.tieredIo(fakeIo, () => ({}), { maskItem: i => ({ ...i, image: '/cdn/x.jpg' }) });
  tio.emit('PRODUCTS_UPDATED', { items: [{ id: 1, price: 100000, original_price: null, image: 'https://product.hstatic.net/a.jpg' }] });
  tio.emit('REALTIME_HEARTBEAT', { ok: 1 });
  const si = sent.find(x => x.room === 'tier:wholesale');
  const le = sent.find(x => x.room === 'tier:retail');
  assert.equal(si.payload.items[0].price, 100000);
  assert.equal(le.payload.items[0].price, 120000);
  assert.equal(le.payload.items[0].image, '/cdn/x.jpg');
  assert.equal(sent.some(x => x.room === '*' && x.ev === 'PRODUCTS_UPDATED'), false);
  assert.ok(sent.some(x => x.room === '*' && x.ev === 'REALTIME_HEARTBEAT'));
});
