'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.HM_POSTREF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-postref-'));
delete process.env.ATTRIBUTION_KEY;
const express = require('express');
const postRef = require('../services/postRef');

function serve(app) {
  return new Promise(resolve => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => resolve(srv));
  });
}
function get(srv, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.address().port, path: p, headers }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}
const HUMAN = { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile' };

test('mã hợp lệ: chữ/số/-/_ dài 3–32', () => {
  assert.ok(postRef.validCode('k7f2'));
  assert.ok(postRef.validCode('c473-g12'));
  assert.ok(!postRef.validCode('ab'));
  assert.ok(!postRef.validCode('a b c'));
  assert.ok(!postRef.validCode('x'.repeat(33)));
  assert.ok(!postRef.validCode('<script>'));
});

test('đọc mã SP từ đường dẫn /sp/', () => {
  assert.equal(postRef.productIdFromPath('/sp/123'), 123);
  assert.equal(postRef.productIdFromPath('/sp/123-sac-du-phong'), 123);
  assert.equal(postRef.productIdFromPath('/danh-muc/sac'), null);
});

test('khách bấm link ?r= → có cookie, đếm lượt bấm; bot Zalo xem trước link thì không', async () => {
  postRef._reset();
  const app = express();
  app.use(postRef.capture);
  app.get('/sp/:id', (req, res) => res.redirect(301, `/sp/${req.params.id}-ten-sp`));
  const srv = await serve(app);
  try {
    const human = await get(srv, '/sp/555?r=k7f2', HUMAN);
    assert.equal(human.status, 301); // vẫn ghi cookie dù trang chuyển hướng sang đường dẫn chuẩn
    const cookie = String(human.headers['set-cookie'] || '');
    assert.match(cookie, /^bref=k7f2\.\d+;/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Max-Age=604800/);

    const bot = await get(srv, '/sp/555?r=k7f2', { 'user-agent': 'facebookexternalhit/1.1' });
    assert.equal(bot.headers['set-cookie'], undefined);
    const noUa = await get(srv, '/sp/555?r=k7f2', { 'user-agent': 'Zalo' });
    assert.equal(noUa.headers['set-cookie'], undefined);

    // Khách mở link ngay trong app Zalo (trình duyệt nhúng) — phải ghi nhận
    const zaloInApp = await get(srv, '/sp/556?r=k7f2', { 'user-agent': 'Mozilla/5.0 (Linux; Android 13; SM-A536E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36 Zalo android/12100651 ZaloTheme/light ZaloLanguage/vn' });
    assert.match(String(zaloInApp.headers['set-cookie'] || ''), /^bref=k7f2\./);

    const bad = await get(srv, '/sp/555?r=%3Cx%3E', HUMAN);
    assert.equal(bad.headers['set-cookie'], undefined);

    const rep = postRef.report([], new Date(Date.now() - 3600e3).toISOString());
    assert.equal(rep.clicks.k7f2.clicks, 2);
    assert.equal(rep.clicks.k7f2.products['555'], 1);
    assert.equal(rep.clicks.k7f2.products['556'], 1);
  } finally {
    srv.close();
  }
});

test('cookie còn hạn 7 ngày thì đơn mang mã, quá hạn hoặc giả mạo thì bỏ', () => {
  const now = Date.parse('2026-11-20T10:00:00Z');
  const sec = Math.floor(now / 1000);
  const req = c => ({ headers: { cookie: c } });
  assert.deepEqual(postRef.fromRequest(req(`bref=k7f2.${sec - 3600}`), now), { code: 'k7f2', clicked_at: new Date((sec - 3600) * 1000).toISOString() });
  assert.equal(postRef.fromRequest(req(`bref=k7f2.${sec - 8 * 86400}`), now), null);
  assert.equal(postRef.fromRequest(req(`bref=k7f2.${sec + 86400}`), now), null);
  assert.equal(postRef.fromRequest(req('bref=%3Cx%3E.1'), now), null);
  assert.equal(postRef.fromRequest(req('other=1'), now), null);
});

test('đơn gửi cho app CRM không có tên, SĐT, địa chỉ, giá vốn', () => {
  const o = postRef.anonymousOrder({
    id: 'HM1', created_at: '2026-11-19T05:20:00Z', status: 'CONFIRMED', payment_method: 'COD',
    customer: { name: 'Nguyễn A', phone: '0900000000', address: '1 Đường B', province_name: 'Hà Nội' },
    items: [{ id: 9, variation_id: 3, name: 'Giá đỡ K72', price: 15000, quantity: 10, dropbuy_cost: 9000, wholesale_price: 12000 }],
    subtotal: 150000, total_amount: 180000, post_ref: 'k7f2', post_ref_clicked_at: '2026-11-19T05:10:00Z',
  });
  const s = JSON.stringify(o);
  assert.ok(!/Nguyễn A|0900000000|Đường B|dropbuy_cost|wholesale_price|9000/.test(s));
  // SĐT chỉ có dạng dấu có khoá: cùng SĐT (mọi cách viết) → cùng dấu; khác khoá → khác dấu
  assert.match(o.phone_hash, /^[0-9a-f]{24}$/);
  assert.equal(o.phone_hash, postRef.phoneHash('+84 900 000 000'));
  assert.notEqual(postRef.phoneHash('0900000000', 'khoa-khac'), o.phone_hash);
  assert.equal(postRef.phoneHash('123'), null);
  assert.equal(o.ref, 'k7f2');
  assert.equal(o.province, 'Hà Nội');
  assert.deepEqual(o.items, [{ id: 9, variation_id: 3, name: 'Giá đỡ K72', price: 15000, quantity: 10 }]);
});

test('API thống kê: sai/thiếu khoá → 401; đúng khoá → chỉ đơn trong khoảng thời gian', async () => {
  const key = postRef.getKey();
  assert.ok(key.length >= 24);
  assert.equal(postRef.getKey(), key); // khoá được lưu, không đổi mỗi lần gọi
  const orders = [
    { id: 'OLD', created_at: '2026-10-01T00:00:00Z', items: [] },
    { id: 'NEW', created_at: '2026-11-19T05:20:00Z', items: [], post_ref: 'k7f2' },
  ];
  const app = express();
  app.get('/api/attribution/orders', postRef.requireKey, (req, res) => res.json({ success: true, data: postRef.report(orders, req.query.since) }));
  const srv = await serve(app);
  try {
    assert.equal((await get(srv, '/api/attribution/orders')).status, 401);
    assert.equal((await get(srv, '/api/attribution/orders', { 'x-attribution-key': 'sai' })).status, 401);
    const ok = await get(srv, '/api/attribution/orders?since=2026-11-01T00:00:00Z', { 'x-attribution-key': key });
    assert.equal(ok.status, 200);
    const ids = JSON.parse(ok.body).data.orders.map(o => o.id);
    assert.deepEqual(ids, ['NEW']);
  } finally {
    srv.close();
  }
});
