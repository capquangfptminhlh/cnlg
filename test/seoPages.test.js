'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pages = require('../services/seoPages');
const seo = require('../services/seo');

const req = { get: h => (h === 'host' ? 'besi.com.vn' : ''), socket: {}, query: {}, protocol: 'https', originalUrl: '/' };
const base = 'https://besi.com.vn';

test('link máy chủ tạo trùng link trình duyệt tạo (slugifyQuery của app.js)', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const src = appJs.match(/function slugifyQuery\(s\) \{\s*return ([^\n]+);/)[1];
  // eslint-disable-next-line no-new-func
  const clientSlug = new Function('s', `return ${src};`);
  for (const s of ['Điện thoại & phụ kiện', 'Thiết bị điện gia dụng', 'Lock&Lock', 'Ốp lưng iPhone 16 Pro Max – trong suốt', 'Đồ chơi trẻ em (0-3 tuổi)']) {
    assert.equal(pages.slug(s), clientSlug(s), s);
  }
  assert.equal(pages.categoryPath({ id: 1, name: 'Điện thoại & phụ kiện' }), '/danh-muc/1-dien-thoai-phu-kien');
  assert.equal(pages.brandPath('Lock&Lock'), '/thuong-hieu/lock-lock');
});

test('JSON-LD sản phẩm: thương hiệu thật (không phải tên cửa hàng), phân loại → AggregateOffer', () => {
  const single = pages.productLd(base, { id: 5, slug: 'cap-sac', name: 'Cáp sạc', price: 120000, in_stock: true, brand: 'Baseus', sku: 'X1', image: '/cdn/md/a.png' });
  assert.deepEqual(single.brand, { '@type': 'Brand', name: 'Baseus' });
  assert.equal(single.offers['@type'], 'Offer');
  assert.equal(single.offers.price, 120000);
  assert.equal(single.offers.priceCurrency, 'VND');
  assert.equal(single.offers.availability, 'https://schema.org/InStock');
  assert.match(single.offers.priceValidUntil, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(single.image[0], 'https://besi.com.vn/cdn/md/a.png');

  const noBrand = pages.productLd(base, { id: 6, slug: 'x', name: 'Bàn là', price: 1, in_stock: false });
  assert.equal(noBrand.brand, undefined); // không bịa thương hiệu
  assert.equal(noBrand.offers.availability, 'https://schema.org/OutOfStock');

  const fam = pages.productLd(base, { id: 7, slug: 'hub', name: 'HUB', price: 253000, in_stock: true, variants: [{ name: 'VGA', price: 313000 }, { name: 'Mini DP', price: 253000 }, { name: 'HD4K + PD', price: 383000 }] });
  assert.equal(fam.offers['@type'], 'AggregateOffer');
  assert.equal(fam.offers.lowPrice, 253000);
  assert.equal(fam.offers.highPrice, 383000);
  assert.equal(fam.offers.offerCount, 3);

  const script = pages.ldScript([pages.orgLd(base), single, pages.breadcrumbLd(base, [{ name: 'Trang chủ', url: '/' }, { name: '</script><b>' }])]);
  assert.ok(!script.slice(0, -9).includes('</script>', 40)); // không thể đóng thẻ script sớm
  const json = JSON.parse(script.replace(/^<script[^>]*>|<\/script>$/g, ''));
  assert.deepEqual(json['@graph'].map(x => x['@type']), ['Organization', 'Product', 'BreadcrumbList']);
});

test('HTML dựng sẵn: thoát ký tự đặc biệt, thẻ SP có link + ảnh có alt', () => {
  const html = pages.cardsHtml([{ id: 9, slug: 'a', name: '<img src=x onerror=alert(1)>', price: 1000, image: '/cdn/md/x.png' }]);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('href="/sp/9-a"'));
  assert.match(html, /alt="&lt;img/);
  const head = pages.listingHeadHtml({ path: '/danh-muc/1-a', crumbs: [{ name: 'Trang chủ', url: '/' }, { name: 'A&B' }], h1: 'A&B "x"' });
  assert.match(head, /<h1>A&amp;B &quot;x&quot;<\/h1>/);
  assert.match(head, /data-path="\/danh-muc\/1-a"/);
});

test('trang danh sách: các mốc chèn còn trong index.html, khẩu hiệu thôi làm H1 khi có H1 riêng', () => {
  const html = seo.renderHomePage(req, {}, 100, {
    canonicalPath: '/danh-muc/1-dien-thoai-phu-kien', robots: 'index, follow',
    headHtml: pages.listingHeadHtml({ path: '/danh-muc/1-dien-thoai-phu-kien', crumbs: [{ name: 'Trang chủ', url: '/' }, { name: 'Điện thoại' }], h1: 'Điện thoại & phụ kiện' }),
    gridHtml: pages.cardsHtml([{ id: 1, slug: 'a', name: 'SP A', price: 1000 }]),
    pagerHtml: pages.pagerHtml('/danh-muc/1-dien-thoai-phu-kien', 1, 3),
    footerHtml: pages.footerLinksHtml([{ id: 1, name: 'Điện thoại & phụ kiện' }], [{ name: 'Baseus' }])
  });
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  assert.match(html, /<h1>Điện thoại &amp; phụ kiện<\/h1>/);
  assert.match(html, /class="hero-h1"/);
  assert.match(html, /<link rel="canonical" href="https:\/\/besi\.com\.vn\/danh-muc\/1-dien-thoai-phu-kien">/);
  assert.match(html, /<div class="product-grid" id="productGrid"><article class="ssr-card">/);
  assert.match(html, /rel="next" href="\/danh-muc\/1-dien-thoai-phu-kien\?page=2"/);
  assert.match(html, /href="\/thuong-hieu\/baseus"/);
  assert.match(html, /og-besi\.png/);
  // Trang chủ giữ khẩu hiệu làm H1
  const home = seo.renderHomePage(req, {}, 100, { canonicalPath: '/' });
  assert.match(home, /<h1>Giá tốt mỗi ngày\./);
});

test('robots.txt cho Google đọc dữ liệu SP, chặn phần riêng tư; sitemap chia tệp', () => {
  const robots = seo.robotsTxt(req);
  assert.ok(!/^Disallow: \/api\/$/m.test(robots));
  for (const p of ['/api/account/', '/api/orders/']) assert.ok(robots.includes(`Disallow: ${p}`));
  assert.doesNotMatch(robots, /admin/i); // không chỉ đường tới trang quản trị
  assert.match(robots, /Sitemap: https:\/\/besi\.com\.vn\/sitemap\.xml/);

  const products = Array.from({ length: 7300 }, (_, i) => ({ id: i + 1, slug: 's' + i, name: 'SP ' + i, updated_at: '2026-11-01T00:00:00Z' }));
  const idx = seo.sitemapIndexXml(req, products.length);
  assert.equal((idx.match(/<sitemap>/g) || []).length, 3); // trang + 2 tệp SP
  assert.match(idx, /sitemap-products-2\.xml/);
  assert.equal((seo.sitemapProductsXml(req, products, 2).match(/<loc>/g) || []).length, 2300);
  assert.equal(seo.sitemapProductsXml(req, products, 3), null);
  const pagesXml = seo.sitemapPagesXml(req, [{ id: 1, name: 'Điện thoại & phụ kiện' }], [{ name: 'Lock&Lock' }]);
  assert.match(pagesXml, /<loc>https:\/\/besi\.com\.vn\/danh-muc\/1-dien-thoai-phu-kien<\/loc>/);
  assert.match(pagesXml, /<loc>https:\/\/besi\.com\.vn\/thuong-hieu\/lock-lock<\/loc>/);
});
