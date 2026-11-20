const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const seo = require('../services/seo');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('Shareable filter and search links: index.html, styles.css and app.js contract', () => {
  const html = read('public/index.html');
  const css = read('public/styles.css');
  const app = read('public/app.js');
  const catView = read('public/category-view.js');

  // 1. Check index.html has shareFilterBtn
  assert.ok(html.includes('id="shareFilterBtn"'), 'index.html must include #shareFilterBtn');
  assert.ok(html.includes('class="btn-share-filter"'), 'index.html must include .btn-share-filter class');
  assert.ok(html.includes('Sao chép link gửi khách'), 'index.html must include user-friendly button text');

  // 2. Check styles.css has styling
  assert.ok(css.includes('.btn-share-filter'), 'styles.css must style .btn-share-filter');
  assert.ok(css.includes('.btn-share-filter.copied'), 'styles.css must include .copied feedback state');
  assert.ok(css.includes('.btn-share-filter.is-highlighted'), 'styles.css must include .is-highlighted active state');

  // 3. Check app.js functions and handlers
  assert.ok(app.includes('function buildFilterUrl'), 'app.js must define buildFilterUrl');
  assert.ok(app.includes('function syncFilterUrl'), 'app.js must define syncFilterUrl');
  assert.ok(app.includes('function copyFilterLink'), 'app.js must define copyFilterLink');
  assert.ok(app.includes('function applyFilterFromUrl'), 'app.js must define applyFilterFromUrl');
  assert.ok(app.includes('applyFilterFromUrl({ initial: true'), 'app.js init must call applyFilterFromUrl');
  // Link gọn: /tim-kiem/<slug>, /danh-muc/<id>-<slug>, /thuong-hieu/<slug>; link cũ ?q= / ?search= vẫn đọc được
  assert.ok(app.includes("parts.push('tim-kiem', s)"), 'buildFilterUrl must put the search query in /tim-kiem/<slug>');
  assert.ok(app.includes("parts.push('danh-muc'"), 'buildFilterUrl must put the category in /danh-muc/<id>-<slug>');
  assert.ok(app.includes("sp.get('q') || sp.get('search')"), 'parseFilterLocation must still accept old q and search params');

  // 4. Check category-view.js integrates with filter URL
  assert.ok(catView.includes('buildFilterUrl'), 'category-view.js must use buildFilterUrl');
  assert.ok(catView.includes('syncFilterUrl'), 'category-view.js must use syncFilterUrl');
});

test('SEO: renderHomePage dynamically generates OpenGraph and Title for search query links', () => {
  const cfg = { store: { name: 'Hoàng Minh Store', slogan: 'Slogan mẫu' } };
  const mockReq = (host, query = {}) => ({
    get: h => (h.toLowerCase() === 'host' ? host : ''),
    query,
    originalUrl: query.q ? `/?q=${encodeURIComponent(query.q)}` : (query.brand ? `/?brand=${encodeURIComponent(query.brand)}` : '/'),
    protocol: 'https',
    socket: { remoteAddress: '127.0.0.1' }
  });

  // When searching "máy sấy tóc" on besi.com.vn
  const resBesi = seo.renderHomePage(mockReq('besi.com.vn', { q: 'máy sấy tóc' }), cfg, 19450);
  assert.match(resBesi, /<title>Tìm kiếm &quot;máy sấy tóc&quot; \| BESI<\/title>/);
  assert.match(resBesi, /<meta property="og:title" content="Tìm kiếm &quot;máy sấy tóc&quot; \| BESI">/);
  assert.match(resBesi, /<meta name="description" content="Danh sách sản phẩm &quot;máy sấy tóc&quot; giá sỉ &amp; lẻ tốt nhất tại BESI/);
  assert.match(resBesi, /<link rel="canonical" href="https:\/\/besi\.com\.vn\/\?q=m%C3%A1y%20s%E1%BA%A5y%20t%C3%B3c">/);

  // When filtering brand "Havit" on besi.com.vn
  const resBrand = seo.renderHomePage(mockReq('besi.com.vn', { brand: 'Havit' }), cfg, 19450);
  assert.match(resBrand, /<title>Thương hiệu Havit \| BESI<\/title>/);
  assert.match(resBrand, /<meta property="og:title" content="Thương hiệu Havit \| BESI">/);

  // When visiting root without query params
  const resRoot = seo.renderHomePage(mockReq('besi.com.vn'), cfg, 19450);
  assert.match(resRoot, /<meta property="og:site_name" content="BESI">/);
  assert.match(resRoot, /<meta property="og:title" content="BESI">/);
  assert.match(resRoot, /<meta name="description" content="BESI tập hợp 19\.450 sản phẩm/);
});

test('SEO & Zalo: renderProductPage generates complete preview tags with secure_url, dimensions and type', () => {
  const cfg = { store: { name: 'BESI', slogan: 'Sàn giá sỉ' } };
  const mockReq = (host) => ({
    get: h => (h.toLowerCase() === 'host' ? host : ''),
    query: {},
    protocol: 'https',
    socket: { remoteAddress: '127.0.0.1' }
  });

  const product = {
    id: 141328,
    name: 'Bàn là hơi nước mini Bizond',
    slug: 'ban-la-hoi-nuoc-mini-bizond',
    price: 299000,
    sku: 'S1-141328',
    image: 'https://r6i.pen.dropbuy.vn/md/s-10426/p-141328/thumb_256x256.png',
    image_hd: 'https://r6i.pen.dropbuy.vn/md/s-10426/p-141328/hd_1024x1024.png',
    in_stock: true
  };
  const detail = { description: '<p>Bàn là mini công suất 850W...</p>' };

  const html = seo.renderProductPage(mockReq('besi.com.vn'), product, detail, cfg);

  // 1. Must use og:type website for universal Zalo compatibility
  assert.match(html, /<meta property="og:type" content="website">/);

  // 2. Must contain full Open Graph and secure_url tags
  assert.match(html, /<meta property="og:title" content="Bàn là hơi nước mini Bizond">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/besi\.com\.vn\/cdn\/md\/s-10426\/p-141328\/thumb_256x256\.png">/);
  assert.match(html, /<meta property="og:image:secure_url" content="https:\/\/besi\.com\.vn\/cdn\/md\/s-10426\/p-141328\/thumb_256x256\.png">/);
  assert.match(html, /<meta property="og:image:type" content="image\/png">/);
  assert.match(html, /<meta property="og:image:width" content="600">/);
  assert.match(html, /<meta property="og:image:height" content="600">/);

  // 3. Must contain Twitter Card tags
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /<meta name="twitter:title" content="Bàn là hơi nước mini Bizond">/);
  assert.match(html, /<meta name="twitter:image" content="https:\/\/besi\.com\.vn\/cdn\/md\/s-10426\/p-141328\/thumb_256x256\.png">/);
});

test('Storefront UI: stock pills rendered in cards and detail modal', () => {
  const css = read('public/styles.css');
  const app = read('public/app.js');

  assert.ok(css.includes('.stock-pill'), 'styles.css must style .stock-pill');
  assert.ok(css.includes('.stock-pill.is-in'), 'styles.css must style .stock-pill.is-in');
  assert.ok(css.includes('.stock-pill.is-out'), 'styles.css must style .stock-pill.is-out');

  assert.ok(app.includes('productStockBadge'), 'app.js must include productStockBadge function');
  assert.ok(app.includes('Sẵn kho:'), 'app.js must display stock count');
  assert.ok(app.includes('this.onerror=null'), 'img tags must protect against infinite error loop');
});

test('Link gọn: tạo và đọc lại đúng bộ lọc, không còn ký tự %, ?, + khi chỉ tìm / lọc danh mục', () => {
  const vm = require('node:vm');
  const src = read('public/app.js');
  const pick = name => {
    const start = src.indexOf(`function ${name}(`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(name);
  };
  const run = (stateInit, href, metaQ = '') => {
    const url = new URL(href || 'http://x/');
    const ctx = {
      state: { categories: [{ id: 1, name: 'Điện thoại & phụ kiện' }], currentCategory: 'all', currentBrand: 'all', searchQuery: '', ...stateInit },
      window: { location: url }, URLSearchParams,
      document: { querySelector: () => (metaQ ? { content: metaQ } : null) }
    };
    vm.createContext(ctx);
    vm.runInContext([pick('slugifyQuery'), pick('buildFilterUrl'), pick('parseFilterLocation')].join('\n') + ';this.b=buildFilterUrl;this.p=parseFilterLocation;', ctx);
    return ctx;
  };
  assert.equal(run({ searchQuery: 'tai nghe chống ồn' }).b(), '/tim-kiem/tai-nghe-chong-on');
  assert.equal(run({ currentCategory: '1', searchQuery: 'ốp lưng' }).b(), '/danh-muc/1-dien-thoai-phu-kien/tim-kiem/op-lung');
  assert.equal(run({ currentBrand: 'Lock&Lock', minPrice: '50000' }).b(), '/thuong-hieu/lock-lock?min=50000');
  assert.equal(run({ searchQuery: '+++' }).b(), '/?q=%2B%2B%2B');
  assert.equal(run({}).b(), '/');

  const parsed = run({}, 'http://x/danh-muc/1-dien-thoai-phu-kien/tim-kiem/op-lung?sort=price-asc').p();
  assert.equal(parsed.q, 'op lung');
  assert.equal(parsed.category, '1-dien-thoai-phu-kien');
  assert.equal(parsed.sort, 'price-asc');
  assert.equal(run({}, 'http://x/tim-kiem/tai-nghe-chong-on', 'tai nghe chống ồn').p().q, 'tai nghe chống ồn');
  assert.equal(run({}, 'http://x/tim-kiem/tai-nghe-chong-on', 'thứ khác').p().q, 'tai nghe chong on');
  const old = run({}, 'http://x/?q=tai+nghe&danh-muc=1-dien-thoai&brand=Baseus').p();
  assert.deepEqual([old.q, old.category, old.brand], ['tai nghe', '1-dien-thoai', 'Baseus']);
});

test('SEO: link gọn có tiêu đề xem trước đúng (từ khoá có dấu, danh mục)', () => {
  const req = { get: h => (h.toLowerCase() === 'host' ? 'besi.com.vn' : ''), query: {}, originalUrl: '/tim-kiem/may-say-toc', protocol: 'https', socket: { remoteAddress: '127.0.0.1' } };
  const html = seo.renderHomePage(req, { store: { name: 'Hoàng Minh Store' } }, 100, { q: 'máy sấy tóc' });
  assert.match(html, /<title>Tìm kiếm &quot;máy sấy tóc&quot; \| BESI<\/title>/);
  assert.match(html, /<meta name="besi:q" content="máy sấy tóc">/);
  const cat = seo.renderHomePage({ ...req, originalUrl: '/danh-muc/1-dien-thoai' }, { store: { name: 'Hoàng Minh Store' } }, 100, { category: 'Điện thoại & phụ kiện' });
  assert.match(cat, /<title>Điện thoại &amp; phụ kiện \| BESI<\/title>/);
});
