const scraper = require('./dropbuyScraper');

const BFF = 'https://dropbuy.vn/api/proxy/bff';
const TENANT_FX = 'afa4cf0301eb4a75882dd5df30cc54a5';

function headers(config, withCookie = true) {
  const h = { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', origin: 'https://dropbuy.vn', referer: 'https://dropbuy.vn/' };
  if (withCookie && config.dropbuy?.cookieHeader) h.cookie = config.dropbuy.cookieHeader;
  return h;
}

async function timed(name, fn, { required = true } = {}) {
  const started = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, ms: Date.now() - started, detail, required };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - started, detail: e.message, required };
  }
}

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}: phản hồi không phải JSON (${text.slice(0, 80)})`);
  }
}

/**
 * Kiểm tra toàn bộ các API DropBuy mà hệ thống đang dùng.
 * Trả về { ok, authenticated, checks: [{ name, ok, ms, detail, required }] }
 */
async function checkDropbuy() {
  const config = scraper.getConfig();
  const authenticated = !!config.dropbuy?.cookieHeader;
  let sample = null;
  const checks = [];

  checks.push(await timed('Danh mục (CDN)', async () => {
    const res = await fetch('https://r6s.pen.dropbuy.vn/dalon-web-public/categories/categories-all.json', { headers: { 'user-agent': 'Mozilla/5.0' } });
    const data = await json(res);
    if (!Array.isArray(data) || !data.length) throw new Error('Không có danh mục');
    return `${data.length} danh mục`;
  }));

  checks.push(await timed('Tìm kiếm sản phẩm (variations/search)', async () => {
    const res = await fetch(`${BFF}/variations/search`, { method: 'POST', headers: headers(config), body: JSON.stringify({ page_num: 1, page_size: 5, in_stock_mode: 'ALL' }) });
    const j = await json(res);
    if (!j.success || !j.data?.items?.length) throw new Error(j.message || `HTTP ${res.status}`);
    sample = j.data.items[0];
    return `${j.data.total_records} SP trên DropBuy`;
  }));

  checks.push(await timed('Tra theo SKU (kiểm tra khi đặt hàng)', async () => {
    if (!sample) throw new Error('Bỏ qua: chưa có SP mẫu');
    const item = await scraper.searchBySku(sample.sku, config);
    if (!item) throw new Error(`Không tìm thấy SKU ${sample.sku}`);
    return `${sample.sku} → ${item.price_public.toLocaleString('vi-VN')} đ`;
  }));

  checks.push(await timed('Tồn kho realtime (variations/in-stock)', async () => {
    const ids = scraper.getProducts().map(p => p.id);
    if (!ids.length) throw new Error('Catalog trống');
    const map = await scraper.fetchStockMap(ids, config);
    const inStock = [...map.values()].filter(Boolean).length;
    return `${map.size}/${ids.length} SP, ${inStock} còn hàng`;
  }));

  checks.push(await timed('Trang chi tiết sản phẩm', async () => {
    if (!sample) throw new Error('Bỏ qua: chưa có SP mẫu');
    const res = await fetch(`https://dropbuy.vn/${sample.slug}_p${sample.product_id}`, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const html = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!html.includes('rawProduct')) throw new Error('Không tìm thấy dữ liệu rawProduct (cấu trúc trang đã đổi?)');
    return `HTTP 200, ${(html.length / 1024).toFixed(0)} KB`;
  }));

  checks.push(await timed('Ảnh sản phẩm (CDN)', async () => {
    if (!sample?.res_thumbnail_url) throw new Error('Bỏ qua: chưa có SP mẫu');
    const res = await fetch(scraper.formatImageUrl(sample.res_thumbnail_url, '256x256'), { method: 'HEAD' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.headers.get('content-type');
  }));

  checks.push(await timed('Phiên đăng nhập DropBuy', async () => {
    if (!authenticated) throw new Error('Chưa đăng nhập – đang dùng giá niêm yết công khai');
    const res = await fetch('https://dropbuy.vn/api/auth/session', { headers: headers(config) });
    const s = await json(res);
    if (!s?.user) throw new Error('Phiên đã hết hạn – đăng nhập lại ở mục DropBuy');
    return s.user.name || s.user.email || 'Đã đăng nhập';
  }, { required: false }));

  checks.push(await timed('Giá CTV/F1 (variations/get-price)', async () => {
    if (!sample) throw new Error('Bỏ qua: chưa có SP mẫu');
    const res = await fetch(`${BFF}/variations/get-price`, { method: 'POST', headers: headers(config), body: JSON.stringify({ items: [{ variation_id: sample.unique_id, product_id: sample.product_id }] }) });
    const j = await json(res);
    if (!j.success) throw new Error(authenticated ? `${j.message} (phiên hết hạn?)` : 'Cần đăng nhập DropBuy để lấy giá CTV');
    const p = j.data?.[0];
    return `${sample.sku}: niêm yết ${Number(p.fe_price_public).toLocaleString('vi-VN')} đ → giá của bạn ${Number(p.fe_price_group || p.fe_price_override).toLocaleString('vi-VN')} đ (${p.fe_price_override_source})`;
  }, { required: false }));

  checks.push(await timed('Đăng nhập: lấy CSRF (NextAuth)', async () => {
    const res = await fetch('https://dropbuy.vn/api/auth/csrf', { headers: { 'user-agent': 'Mozilla/5.0' } });
    const j = await json(res);
    if (!j.csrfToken) throw new Error('Không có csrfToken');
    const prov = await json(await fetch('https://dropbuy.vn/api/auth/providers', { headers: { 'user-agent': 'Mozilla/5.0' } }));
    if (!prov['password-login']) throw new Error('DropBuy đã đổi cách đăng nhập (không còn provider password-login)');
    return 'csrf OK, provider password-login có sẵn';
  }, { required: false }));

  return { ok: checks.filter(c => c.required).every(c => c.ok), authenticated, checked_at: new Date().toISOString(), checks };
}

module.exports = { checkDropbuy, TENANT_FX };
