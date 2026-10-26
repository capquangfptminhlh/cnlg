const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-sources-'));
process.env.HM_CRED_FILE = path.join(tmp, 'dropbuy-cred.json');
process.env.HM_CRED_KEY_FILE = path.join(tmp, 'cred.key');

const { createWooSource, parseJsonLoose, defaultRetail } = require('../services/sources/woo');
const { createStore } = require('../services/sources/store');
const vaultLib = require('../services/credentialVault');

// ── Web WooCommerce giả ──
const vnd = n => String(n);
function product(id, { dealer, retailHtml, images = 1, stock = true, cats = [{ id: 11, name: 'Cáp sạc' }] }) {
  return {
    id, name: `Cáp sạc &#8211; mẫu ${id}`, slug: `cap-${id}`, sku: `SKU-${id}`, permalink: `https://nguon.test/san-pham/cap-${id}/`,
    prices: { price: vnd(dealer), regular_price: vnd(dealer), currency_minor_unit: 0 },
    price_html: retailHtml, images: Array.from({ length: images }, (_, i) => ({ src: `https://nguon.test/img/${id}-${i}.jpg`, thumbnail: `https://nguon.test/img/${id}-${i}-300.jpg` })),
    categories: cats, attributes: [{ name: 'Thương hiệu', terms: [{ name: 'Baseus' }] }],
    is_in_stock: stock, is_purchasable: true, description: '<p>Mô tả</p>', weight: '0.2'
  };
}
const res = (status, body, headers = {}, setCookies = []) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: k => headers[k.toLowerCase()] ?? null, getSetCookie: () => setCookies },
  text: async () => (typeof body === 'string' ? body : 'Chọn mua' + JSON.stringify(body)) // rác trước JSON như web thật
});

function fakeSite({ products, failPage = null, loginOk = true }) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', cookie: opts.headers?.cookie || '' });
    const u = new URL(url);
    if (u.pathname === '/wp-json/wc/store/v1/products/categories') {
      return res(200, u.searchParams.get('page') === '1' ? [{ id: 11, name: 'Cáp sạc', parent: 10 }, { id: 10, name: 'Phụ kiện điện thoại', parent: 0 }, { id: 15, name: 'Chưa phân loại', parent: 0 }] : []);
    }
    const one = u.pathname.match(/^\/wp-json\/wc\/store\/v1\/products\/(\d+)$/);
    if (one) { const p = products.find(x => x.id === Number(one[1])); return p ? res(200, p) : res(404, { code: 'not_found' }); }
    if (u.pathname === '/wp-json/wc/store/v1/products') {
      const page = Number(u.searchParams.get('page'));
      if (page === failPage) return res(502, 'Bad gateway');
      const per = 2;
      return res(200, products.slice((page - 1) * per, page * per), { 'x-wp-total': String(products.length), 'x-wp-totalpages': String(Math.ceil(products.length / per)) });
    }
    if (u.host === 'product.hstatic.net') { // CDN ảnh: ảnh "chet" đã bị xoá
      const dead = /chet/.test(u.pathname) || /_large_large/.test(u.pathname);
      return { ok: !dead, status: dead ? 404 : 200, headers: { get: k => (k.toLowerCase() === 'content-type' ? (dead ? 'text/html' : 'image/jpeg') : null), getSetCookie: () => [] }, text: async () => '' };
    }
    const page = u.pathname.match(/^\/san-pham\/cap-(\d+)\/$/);
    if (page) {
      const id = Number(page[1]);
      return res(200, id === 3 ? '<meta property="og:image" content="https://nguon.test/wp-content/uploads/woocommerce-placeholder.png">'
        : id === 4 ? '<div class="woocommerce-product-gallery__image"><a href="https://product.hstatic.net/1/p/chet-4.jpg"><img></a></div>'
        : `<div class="woocommerce-product-gallery__image"><a href="https://product.hstatic.net/1/p/chet-${id}.jpg"></a></div><div class="woocommerce-product-gallery__image"><a href="https://product.hstatic.net/1/p/that-${id}_large.jpg"><img></a></div>`);
    }
    if (u.pathname === '/tai-khoan/' && (opts.method || 'GET') === 'GET') {
      const logged = /wordpress_logged_in_/.test(opts.headers?.cookie || '');
      return res(200, `<body class="${logged ? 'logged-in' : ''}"><form class="woocommerce-form-login"><input type="hidden" id="woocommerce-login-nonce" name="woocommerce-login-nonce" value="abc123" /><input type="hidden" name="_wp_http_referer" value="/tai-khoan/" /></form></body>`, {}, ['PHPSESSID=s1; path=/']);
    }
    if (u.pathname === '/tai-khoan/' && opts.method === 'POST') {
      const body = new URLSearchParams(String(opts.body));
      if (loginOk && body.get('woocommerce-login-nonce') === 'abc123' && body.get('password') === 'dung') {
        return res(302, '', {}, ['wordpress_logged_in_x=tok; path=/; HttpOnly', 'wordpress_sec_x=sec; path=/']);
      }
      return res(200, '<ul class="woocommerce-error"><li><strong>Lỗi:</strong> Mật khẩu không đúng.</li></ul>');
    }
    return res(404, 'not found');
  };
  return { fetchFn, calls };
}

let n = 0;
function makeSource(site, cfg = {}) {
  const key = `nguon${++n}`;
  return createWooSource({
    key, label: 'Nguồn thử', baseUrl: 'https://nguon.test', accountPath: '/tai-khoan/', idOffset: 20_000_000,
    rootCategoryName: 'Phụ kiện chính hãng',
    pricingDefaults: { markupPercent: 25, minProfit: 0, roundTo: 1000, capAtPublic: true, surchargePercent: 10 },
    shippingDefaults: { hcmFreeFrom: 200000, hcmFee: 20000, otherFreeFrom: 400000, otherFee: 30000 },
    store: createStore(key, tmp), vault: vaultLib.create(key), fetch: site.fetchFn, getConfig: () => cfg
  });
}

const LOGGED = v => `<span>${v.toLocaleString('en-US')}₫</span>(Giá đã gồm VAT) Giá lẻ đề xuất: ${'<b>'}${(v * 1.6).toLocaleString('en-US')}₫</b>`;

test('Nguồn sỉ: lọc chữ rác trước JSON, đọc giá lẻ đề xuất ở cả 2 dạng (đã / chưa đăng nhập)', () => {
  assert.deepEqual(parseJsonLoose('Chọn muaChọn mua[{"a":1}]'), [{ a: 1 }]);
  assert.equal(defaultRetail({ price_html: '685,000₫ (Giá đã gồm VAT) Giá lẻ đề xuất: 749,000₫' }, 685000), 749000);
  assert.equal(defaultRetail({ price_html: '<span>749,000 ₫</span> (Giá đã gồm VAT) Đăng nhập để xem giá đại lý' }, 685000), 749000);
  assert.equal(defaultRetail({ price_html: '<span>685,000 ₫</span>', prices: { regular_price: '685000' } }, 685000), null);
});

test('Nguồn sỉ: quét đủ → mã cộng offset, danh mục gom về gốc, giá = đại lý +phụ phí +lãi, không vượt giá lẻ, chỉ SP có ảnh lên kệ', async () => {
  const site = fakeSite({ products: [
    product(1, { dealer: 100000, retailHtml: LOGGED(100000) }),             // vốn 110.000 → +25% = 137.500 → 138.000 (< lẻ 160.000)
    product(2, { dealer: 200000, retailHtml: LOGGED(200000).replace('320,000', '230,000') }), // vốn 220.000 → 275.000 > lẻ 230.000 → hạ về 230.000
    product(3, { dealer: 50000, retailHtml: LOGGED(50000), images: 0 }),     // không ảnh → không lên kệ
    product(4, { dealer: 70000, retailHtml: LOGGED(70000), cats: [{ id: 15, name: 'Chưa phân loại' }] })
  ] });
  const src = makeSource(site);
  const r = await src.syncAll();
  assert.equal(r.fetched, 4);
  assert.equal(r.complete, true);
  assert.equal(r.sellable, 3);
  const byId = new Map(src.store.getProducts().map(p => [p.id, p]));
  const p1 = byId.get(20_000_001);
  assert.equal(p1.name, 'Cáp sạc – mẫu 1');
  assert.equal(p1.supplier_cost, 110000);
  assert.equal(p1.price, 138000);
  assert.equal(p1.original_price, 160000);
  assert.equal(p1.category_id, 20_000_011);
  assert.equal(p1.brand, 'Baseus');
  assert.equal(p1.weight_gram, 200);
  assert.equal(byId.get(20_000_002).price, 230000);
  assert.equal(byId.get(20_000_003).image, '');
  assert.equal(byId.get(20_000_004).category_id, 20_000_000); // "Chưa phân loại" → danh mục gốc của nguồn
  const cats = src.store.getCategories();
  assert.deepEqual(cats.find(c => c.id === 20_000_011), { id: 20_000_011, name: 'Cáp sạc', parent_id: 20_000_010, source: src.def.key });
  assert.ok(!cats.some(c => c.name === 'Chưa phân loại'));
});

test('Nguồn sỉ: quét thiếu trang thì không gỡ SP; quét đủ mà mất SP thì mới gỡ', async () => {
  const products = [1, 2, 3, 4].map(id => product(id, { dealer: 100000, retailHtml: LOGGED(100000) }));
  const site = fakeSite({ products });
  const src = makeSource(site);
  await src.syncAll();
  products.splice(2, 2); // SP 3, 4 bị gỡ trên web nguồn
  const flaky = fakeSite({ products, failPage: 1 });
  const src2 = createWooSource({ ...src.def, store: src.store, vault: src.vault, fetch: flaky.fetchFn, getConfig: () => ({}) });
  await assert.rejects(src2.syncAll()); // trang 1 lỗi → báo lỗi, không ghi gì
  assert.equal(src.store.getProducts().filter(p => p.removed).length, 0);
  const ok = fakeSite({ products });
  const src3 = createWooSource({ ...src.def, store: src.store, vault: src.vault, fetch: ok.fetchFn, getConfig: () => ({}) });
  const r = await src3.syncAll();
  assert.equal(r.complete, true);
  assert.deepEqual(src.store.getProducts().filter(p => p.removed).map(p => p.id).sort(), [20_000_003, 20_000_004]);
});

test('Nguồn sỉ: đăng nhập đại lý lưu phiên + mật khẩu mã hoá; sai mật khẩu báo đúng lỗi của web nguồn', async () => {
  const site = fakeSite({ products: [] });
  const src = makeSource(site);
  await assert.rejects(src.login('dai-ly', 'sai'), /Mật khẩu không đúng/);
  assert.equal(src.store.getSession(), null);
  await src.login('dai-ly', 'dung');
  assert.match(src.store.getSession().cookie, /wordpress_logged_in_x=tok/);
  assert.deepEqual(src.vault.load(), { username: 'dai-ly', password: 'dung' });
  assert.equal(await src.ensureSession({ force: true }), src.store.getSession().cookie);
  src.logout();
  assert.equal(src.store.getSession(), null);
  assert.equal(src.vault.load(), null);
});

test('Nguồn sỉ: phí ship theo chính sách của nguồn; kiểm tra trực tiếp báo hết hàng / đã gỡ', async () => {
  const products = [product(1, { dealer: 100000, retailHtml: LOGGED(100000) })];
  const site = fakeSite({ products });
  const src = makeSource(site, { sources: {} });
  assert.deepEqual(src.shippingQuote({ province: 'TP. Hồ Chí Minh', subtotal: 150000 }).fee, 20000);
  assert.deepEqual(src.shippingQuote({ province: 'TP. Hồ Chí Minh', subtotal: 250000 }).fee, 0);
  assert.deepEqual(src.shippingQuote({ province: 'Hà Nội', subtotal: 300000 }).fee, 30000);
  await src.syncAll();
  const p = src.store.getProducts()[0];
  products[0].is_in_stock = false;
  const r = await src.liveCheck(p);
  assert.equal(r.ok, false);
  assert.equal(r.live, true);
  assert.equal(src.store.getProducts()[0].in_stock, false);
  products.length = 0;
  const gone = await src.liveCheck(p);
  assert.match(gone.message, /không còn bán/);
  assert.equal(src.store.getProducts()[0].removed, true);
});

test('Nguồn sỉ: mỗi nguồn một bộ quy tắc giá riêng (config.sources.<mã>.pricing)', async () => {
  const site = fakeSite({ products: [product(1, { dealer: 100000, retailHtml: LOGGED(100000) })] });
  const cfg = {};
  const src = makeSource(site, cfg);
  await src.syncAll();
  assert.equal(src.store.getProducts()[0].price, 138000);
  cfg.sources = { [src.def.key]: { pricing: { markupPercent: 40, surchargePercent: 0, capAtPublic: false } } };
  assert.equal(src.reprice(), 1);
  assert.equal(src.store.getProducts()[0].price, 140000);
  assert.equal(src.rules().surchargePercent, 0);
});


test('Nguồn sỉ: ảnh API hỏng → đọc ảnh thật từ trang SP (CDN), chỉ lên kệ khi có ảnh thật, kiểm tra trực tiếp không làm mất ảnh', async () => {
  const products = [product(1, { dealer: 100000, retailHtml: LOGGED(100000) }), product(3, { dealer: 50000, retailHtml: LOGGED(50000) }), product(4, { dealer: 60000, retailHtml: LOGGED(60000) })];
  const site = fakeSite({ products });
  const src = makeSource(site);
  src.def.resolvePageImages = true;
  const r = await src.syncAll();
  const p1 = src.store.getProducts().find(p => p.id === 20_000_001);
  // ảnh chết bị bỏ qua; ảnh đã sẵn cỡ _large không bị gắn thêm _large
  assert.equal(p1.image, 'https://product.hstatic.net/1/p/that-1_large.jpg');
  assert.equal(p1.image_hd, 'https://product.hstatic.net/1/p/that-1_large.jpg');
  assert.equal(p1.gallery.length, 1);
  assert.equal(p1.gallery[0].thumb, 'https://product.hstatic.net/1/p/that-1_medium.jpg');
  assert.equal(src.store.getProducts().find(p => p.id === 20_000_003).image, ''); // trang chỉ có ảnh mặc định
  assert.equal(src.store.getProducts().find(p => p.id === 20_000_004).image, ''); // mọi ảnh đều đã bị xoá
  assert.equal(r.sellable, 1);
  const pages = site.calls.filter(c => c.url.includes('/san-pham/')).length;
  await src.syncAll();
  assert.equal(site.calls.filter(c => c.url.includes('/san-pham/')).length, pages); // đã nhớ → không đọc lại trang
  await src.liveCheck(p1);
  assert.equal(src.store.getProducts().find(p => p.id === 20_000_001).image, p1.image);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('Bảo hành đọc từ trang SP nguồn', () => {
  const { pageWarranty } = require('../services/sources/woo');
  assert.strictEqual(pageWarranty('<li class="bullet-checkmark">Thời gian bảo hành: 1 năm </li>'), 'Bảo hành 1 năm');
  assert.strictEqual(pageWarranty('<li>Thời gian bảo hành: <b>6 Tháng</b></li>'), 'Bảo hành 6 tháng');
  assert.strictEqual(pageWarranty('<li>Thời gian bảo hành: Không bảo hành</li>'), 'Không bảo hành');
  assert.strictEqual(pageWarranty('<p>không ghi</p>'), 'Bảo hành chính hãng');
});
