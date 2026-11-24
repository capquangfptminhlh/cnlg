'use strict';
// Chặn hồi quy tốc độ / xô lệch trên điện thoại (Core Web Vitals) và các lỗi SEO nhỏ đã sửa.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const index = read('public/index.html');
const motion = read('public/motion.js');
const server = read('server.js');

test('banner trang chủ: slide đầu trùng chữ trong HTML và không bị ghi lại lúc khởi động (LCP sớm)', () => {
  const copy = index.match(/<div class="market-banner-copy">([\s\S]*?)<a href/)[1];
  const first = motion.match(/const slides = \[\s*\{([\s\S]*?)\},/)[1];
  const val = k => first.match(new RegExp(k + ":'([^']*)'"))[1];
  assert.ok(copy.includes(val('label')), 'nhãn slide 0 phải trùng HTML');
  assert.ok(copy.includes(val('over')), 'dòng phụ slide 0 phải trùng HTML');
  assert.ok(copy.includes(val('headline')), 'tiêu đề slide 0 phải trùng HTML');
  assert.ok(copy.includes(val('description')), 'mô tả slide 0 phải trùng HTML');
  assert.doesNotMatch(motion, /applySlide\(0,\s*true\);/);
});

test('socket.io không chặn trang: không nạp trong <head>, app.js tự nạp sau khi trang tải xong', () => {
  assert.doesNotMatch(index, /<script[^>]*socket\.io\.js/);
  const app = read('public/app.js');
  assert.match(app, /s\.src = '\/socket\.io\/socket\.io\.js'/);
  assert.doesNotMatch(app, /^const socket = io\(\);/m);
});

test('thanh lọc có sẵn chỗ cho huy hiệu cập nhật; danh mục dựng bố cục danh mục ngay từ máy chủ', () => {
  assert.match(index, /id="liveSyncStamp" style="visibility:hidden"/);
  assert.match(server, /extra\.bodyClass = 'is-category-view'/);
  const seo = require('../services/seo');
  const req = { protocol: 'https', socket: { remoteAddress: '127.0.0.1' }, query: {}, originalUrl: '/danh-muc/1-x', get: h => (h.toLowerCase() === 'host' ? 'besi.com.vn' : '') };
  const html = seo.renderHomePage(req, {}, 10, { bodyClass: 'is-category-view', canonicalPath: '/danh-muc/1-x' });
  assert.match(html, /<body class="is-category-view">/);
});

test('trang 404: mã 404 thật, noindex, có ô tìm kiếm + danh mục; SP mất / URL lạ không chuyển về trang chủ', () => {
  const infoPages = require('../services/infoPages');
  const html = infoPages.renderNotFoundPage({ product: true, categories: [{ name: 'Điện thoại & phụ kiện', path: '/danh-muc/1-dien-thoai' }] });
  assert.match(html, /<meta name="robots" content="noindex, follow">/);
  assert.match(html, /Sản phẩm không còn bán/);
  assert.match(html, /role="search"/);
  assert.match(html, /href="\/danh-muc\/1-dien-thoai"/);
  assert.match(server, /if \(!product \|\| product\.removed_from_dropbuy\) return sendNotFound\(req, res, \{ product: true \}\);/);
  assert.match(server, /res\.status\(404\)\.type\('html'\)/);
});

test('www.besi.com.vn chuyển 301 về besi.com.vn; tham số theo dõi (utm, fbclid…) không làm noindex', () => {
  assert.match(server, /return res\.redirect\(301, 'https:\/\/besi\.com\.vn' \+ \(req\.originalUrl \|\| '\/'\)\);/);
  const m = server.match(/const TRACKING_PARAM = (\/.*\/i);/);
  const re = eval(m[1]);
  for (const k of ['utm_source', 'utm_campaign', 'fbclid', 'gclid', 'zarsrc']) assert.ok(re.test(k), k);
  for (const k of ['q', 'brand', 'min', 'sort']) assert.ok(!re.test(k), k);
});
