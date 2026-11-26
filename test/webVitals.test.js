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

test('trang /sp/: bố cục "xem sản phẩm" từ máy chủ (bài SP ở đầu trang), đóng khung chi tiết thì gỡ', () => {
  const seo = read('services/seo.js');
  assert.match(seo, /demoteHero: true, bodyClass: 'is-product-view'/);
  assert.match(read('public/seo-ssr.css'), /body\.is-product-view #discovery/);
  const app = read('public/app.js');
  assert.match(app, /function clearProductHash\(\) \{\n\s*leaveProductView\(\);/);
});

test('bundle.css rút gọn an toàn: không còn chú thích, nhỏ hơn bản gốc, giữ nguyên quy tắc', () => {
  const seo = require('../services/seo');
  const { css } = seo.getCssBundle();
  assert.doesNotMatch(css, /\/\*/);
  const files = [...index.matchAll(/<link rel="stylesheet" href="(\/[a-zA-Z0-9_.-]+\.css)">/g)].map(m => m[1]);
  const raw = files.map(f => read('public' + f)).join('\n');
  assert.ok(css.length < raw.length * 0.9, `bundle ${css.length} B phải nhỏ hơn bản gốc ${raw.length} B`);
  const count = s => (s.replace(/\/\*[\s\S]*?\*\//g, '').match(/\{/g) || []).length;
  assert.equal(count(css), count(raw), 'số khối quy tắc phải giữ nguyên');
});

test('CSP cho phép thống kê Cloudflare Web Analytics', () => {
  const sec = read('services/security.js');
  assert.match(sec, /script-src 'self' 'unsafe-inline' https:\/\/cdnjs\.cloudflare\.com https:\/\/static\.cloudflareinsights\.com/);
  assert.match(sec, /connect-src 'self' ws: wss: https:\/\/cloudflareinsights\.com/);
});

test('trang SP dựng sẵn: ảnh chính là ảnh lớn của bộ ảnh chi tiết, không phải ảnh nhỏ 128px của thẻ', () => {
  const seoPages = require('../services/seoPages');
  const html = seoPages.productArticleHtml({
    product: { id: 1, name: 'Giá đỡ K72', slug: 'k72', price: 22000, image: 'https://r6i.pen.dropbuy.vn/md/s-1/p-1/a-1-128x128.jpg' },
    gallery: [{ url: 'https://r6i.pen.dropbuy.vn/md/s-1/p-1/a-1-1024x1024.jpg', thumb: 'https://r6i.pen.dropbuy.vn/md/s-1/p-1/a-1-128x128.jpg' }],
    crumbs: [{ name: 'Trang chủ', url: '/' }], descHtml: ''
  });
  const main = html.match(/class="ssr-product-media">\s*<img src="([^"]+)"/)[1];
  assert.equal(main, '/cdn/md/s-1/p-1/a-1-1024x1024.jpg');
  assert.doesNotMatch(html, /dropbuy/i);
});

test('<head>: bundle.css đứng đầu; Font Awesome tải sau lần hiện đầu, chèn trước bundle (giữ thứ tự cascade), có giữ chỗ biểu tượng', () => {
  const seo = require('../services/seo');
  const req = { protocol: 'https', socket: { remoteAddress: '127.0.0.1' }, query: {}, originalUrl: '/', get: h => (h.toLowerCase() === 'host' ? 'besi.com.vn' : '') };
  const html = seo.renderHomePage(req, {}, 10, { canonicalPath: '/' });
  const head = html.slice(0, html.indexOf('</head>'));
  const firstLink = head.match(/<link rel="stylesheet" href="([^"]+)"/)[1];
  assert.match(firstLink, /^\/bundle\.css\?v=/);
  assert.doesNotMatch(head, /<link rel="stylesheet" href="https:\/\/cdnjs[^"]+font-awesome[^"]+"(?![^<]*<\/noscript>)[^>]*media=/);
  assert.match(head, /requestAnimationFrame\(function\(\)\{setTimeout\(go,0\)\}\)/);
  assert.match(head, /document\.head\.insertBefore\(l,b\|\|null\)/);
  assert.match(head, /<noscript><link rel="stylesheet" href="https:\/\/cdnjs[^"]+font-awesome/);
  assert.match(read('public/besi-clean.css'), /:where\(html\.fa-pending\) :where\(i\.fa-solid/);
});

test('khung chi tiết SP có sẵn kích thước cuối ngay lúc đang tải (không bung ra gây xô lệch)', () => {
  const css = read('public/besi-clean.css');
  assert.match(css, /#productDetailModal \.product-modal-dialog \{ min-height: calc\(100dvh - 36px\); \}/);
  assert.match(css, /@media \(max-width: 760px\) \{\n  #productDetailModal \.product-modal-dialog \{ min-height: calc\(100dvh - 8px\); \}/);
});

test('làm nóng ảnh SP: dùng đúng ảnh chính của trang SSR + đúng khoá bộ nhớ đệm của route /cdn; tắt được', () => {
  const seoPages = require('../services/seoPages');
  const g = seoPages.productGallery({ id: 1, image: 'https://r6i.pen.dropbuy.vn/md/s-1/p-1/a-1-128x128.jpg' }, [{ url: 'https://r6i.pen.dropbuy.vn/md/s-1/p-1/a-1-1024x1024.jpg' }]);
  assert.equal(g[0], '/cdn/md/s-1/p-1/a-1-1024x1024.jpg');
  assert.match(server, /const job = cdnMediaJob\(seoPages\.productGallery\(p, savedProductDetail\(p\.id, p\)\?\.gallery\)\[0\]\);/);
  assert.match(server, /if \(imageOptimizer\.isCached\(job\.id\)\) \{ imgWarm\.cached\+\+; continue; \}/);
  assert.match(server, /process\.env\.HM_IMG_WARM !== '0'/);
  assert.equal(typeof require('../services/imageOptimizer').isCached, 'function');
});

test('dữ liệu nhúng trang /sp/: luôn áp giá theo loại khách (không lộ giá gốc/giá sỉ) và luôn có để khung chi tiết vẽ ngay', () => {
  const ssr = server.slice(server.indexOf("app.get('/sp/:slugId'"), server.indexOf("app.get('/bundle.css'"));
  assert.match(ssr, /const tier = customerPricing\.tierOf\(req\);/);
  assert.match(ssr, /const bootData = tier === 'wholesale' \|\| !priceRules\.enabled \? bootBase : customerPricing\.retailizeDeep\(bootBase, priceRules\);/);
  assert.match(ssr, /JSON\.stringify\(\{ \.\.\.bootData, description: '' \}\)/);
  assert.doesNotMatch(ssr, /JSON\.stringify\(\{ \.\.\.ready/);
  assert.match(ssr, /if \(tier === 'wholesale'\) res\.set\('Cache-Control', 'private, no-store'\);/);
  const cp = require('../services/customerPricing');
  const rules = cp.normalizeRules(null);
  const priced = cp.retailizeDeep({ price: 100000, variants: [{ price: 100000 }] }, rules);
  assert.ok(!rules.enabled || (priced.price > 100000 && priced.variants[0].price > 100000), 'giá khách lẻ phải cao hơn giá gốc khi bật quy tắc');
});

test('gọi DropBuy khi khách đang chờ có giới hạn thời gian; đồng bộ cả danh mục không bị giới hạn', () => {
  assert.match(read('services/variants.js'), /scraper\.fetchWholesalePrices\(.*, config, \{ timeoutMs: 8000 \}\);/);
  assert.match(read('services/dropbuyScraper.js'), /\.\.\.\(timeoutMs \? \{ signal: AbortSignal\.timeout\(timeoutMs\) \} : \{\}\)/);
  assert.match(read('services/dropbuyDetailScraper.js'), /signal: AbortSignal\.timeout\(10000\)/);
});
