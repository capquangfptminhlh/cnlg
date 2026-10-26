'use strict';
/**
 * Bộ đọc nguồn sỉ chạy WooCommerce (TechMall và các web sỉ tương tự) qua Store API công khai
 * /wp-json/wc/store/v1/products – không cần quyền quản trị của họ.
 *
 * - Đăng nhập bằng tài khoản đại lý (form "Tài khoản" của WooCommerce) để luôn thấy đúng giá đại lý của mình;
 *   mật khẩu lưu mã hoá (credentialVault) và tự đăng nhập lại khi phiên hết hạn.
 * - Mỗi sản phẩm: giá đại lý (prices.price) + giá lẻ đề xuất (đọc từ price_html) → giá bán theo quy tắc RIÊNG của nguồn.
 * - Mã SP / danh mục = idOffset + mã gốc, để không trùng DropBuy và các nguồn khác.
 * - Chỉ đánh dấu SP "đã gỡ" khi lần quét đủ trang (mạng chập chờn không làm mất hàng đang bán).
 */
const pricing = require('../pricing');
const vaultLib = require('../credentialVault');
const { createStore } = require('./store');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const SPAN = 10_000_000; // mỗi nguồn dùng dải mã [idOffset, idOffset + SPAN)
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Plugin của web nguồn đôi khi in chữ rác trước JSON ("Chọn muaChọn mua[...")
function parseJsonLoose(text) {
  const i = String(text).search(/[\[{]/);
  if (i < 0) throw new Error('Phản hồi không phải JSON');
  return JSON.parse(text.slice(i));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
const htmlText = s => decodeEntities(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const amountOf = s => { const d = String(s).replace(/[^\d]/g, ''); return d ? Number(d) : null; };
const slugify = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

function minorPrice(prices = {}, field = 'price') {
  const v = Number(prices[field]);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v / 10 ** (Number(prices.currency_minor_unit) || 0));
}

/** Giá lẻ đề xuất: đã đăng nhập → số sau "Giá lẻ đề xuất"; chưa đăng nhập → số đầu tiên trong price_html. */
function defaultRetail(raw, dealer) {
  const t = htmlText(raw.price_html);
  const m = t.match(/Giá lẻ đề xuất\s*:?\s*([\d.,]+)/i);
  if (m) return amountOf(m[1]);
  const first = t.match(/^([\d.,]+)/);
  const v = first ? amountOf(first[1]) : null;
  if (v && v > dealer) return v;
  const regular = minorPrice(raw.prices, 'regular_price');
  return regular > dealer ? regular : null;
}

function mergeCookies(jar, setCookies = []) {
  for (const c of setCookies) {
    const pair = String(c).split(';')[0];
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const val = pair.slice(i + 1).trim();
    if (!val || val === 'deleted') delete jar[name];
    else jar[name] = val;
  }
  return jar;
}
const cookieHeader = jar => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const inputValue = (html, name) => {
  const tag = (String(html).match(new RegExp(`<input[^>]*name="${name}"[^>]*>`, 'i')) || [])[0] || '';
  return (tag.match(/value="([^"]*)"/i) || [])[1] || null;
};

/** Quy tắc giá của 1 nguồn = quy tắc chung (pricing.js) + phụ phí cộng vào giá vốn (vd đơn đại lý nhỏ bị cộng 5–10%). */
function normalizeSourceRules(raw, defaults = {}) {
  const merged = { ...defaults, ...(raw || {}) };
  const base = pricing.normalizeRules({ ...merged, base: 'wholesale' });
  const s = Number(merged.surchargePercent);
  return { ...base, surchargePercent: Number.isFinite(s) ? Math.min(50, Math.max(0, s)) : 0 };
}

function normalizeShipping(raw, defaults = {}) {
  const m = { ...defaults, ...(raw || {}) };
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : d);
  return {
    hcmFreeFrom: n(m.hcmFreeFrom, 0), hcmFee: n(m.hcmFee, 0),
    otherFreeFrom: n(m.otherFreeFrom, 0), otherFee: n(m.otherFee, 0)
  };
}

const isSellable = p => !p.removed && Number(p.price) > 0 && !!p.image;

/** Ảnh Haravan (product.hstatic.net) có sẵn nhiều cỡ: tên_large.jpg (~40KB) thay vì ảnh gốc ~100KB. */
// Ảnh có thể đã sẵn là một cỡ (…_large.jpg) → thay cỡ đó, không gắn thêm (…_large_large.jpg là link hỏng)
const HSTATIC_SIZE = /_(?:pico|icon|thumb|small|compact|medium|large|grande|master|\d+x\d+)(?=\.(?:jpe?g|png|webp)(?:\?.*)?$)/i;
const hstaticSize = (url, size) => (/hstatic\.net\//i.test(url)
  ? url.replace(HSTATIC_SIZE, '').replace(/(\.(?:jpe?g|png|webp))(\?.*)?$/i, `_${size}$1`)
  : url);
// Đổi cách chọn ảnh → tăng số này để các SP đã đọc được kiểm tra lại theo cách mới
const IMAGE_RULES_VERSION = 2;

/** Ảnh thật trên trang sản phẩm: các ảnh trong gallery WooCommerce, không có thì og:image (bỏ ảnh mặc định "chưa có ảnh"). */
function pageImages(html) {
  const urls = [];
  for (const m of String(html).matchAll(/woocommerce-product-gallery__image[^>]*>\s*<a[^>]*href="([^"]+)"/gi)) urls.push(decodeEntities(m[1]));
  if (!urls.length) {
    const og = (String(html).match(/property="og:image"\s+content="([^"]+)"/i) || [])[1];
    if (og) urls.push(decodeEntities(og));
  }
  return [...new Set(urls)].filter(u => /^https?:\/\//i.test(u) && !/woocommerce-placeholder/i.test(u)).slice(0, 16);
}

function createWooSource(def) {
  const store = def.store || createStore(def.key);
  const vault = def.vault || vaultLib.create(def.key);
  const base = def.baseUrl.replace(/\/+$/, '');
  const accountPath = def.accountPath || '/my-account/';
  const rootId = def.idOffset;
  const getConfig = def.getConfig || (() => require('../dropbuyScraper').getConfig());
  const doFetch = def.fetch || fetch;
  let io = null;
  let syncing = null;
  let verifiedAt = 0;
  const state = { lastRun: null, lastOk: null, lastError: null, lastDurationMs: null, failures: 0, phase: null, progress: null };

  async function http(p, { cookie, method = 'GET', body, headers = {}, redirect = 'follow', timeout = 30000 } = {}) {
    return doFetch(p.startsWith('http') ? p : base + p, {
      method, body, redirect, signal: AbortSignal.timeout(timeout),
      headers: { 'user-agent': UA, 'accept-language': 'vi-VN,vi;q=0.9', ...(cookie ? { cookie } : {}), ...headers }
    });
  }

  const rules = (cfg = getConfig()) => normalizeSourceRules(cfg?.sources?.[def.key]?.pricing, def.pricingDefaults);
  const shippingRules = (cfg = getConfig()) => normalizeShipping(cfg?.sources?.[def.key]?.shipping, def.shippingDefaults);

  // ───────── Phiên đại lý ─────────
  async function login(username, password, { remember = true } = {}) {
    const jar = {};
    const r1 = await http(accountPath);
    mergeCookies(jar, r1.headers.getSetCookie?.() || []);
    const page = await r1.text();
    const nonce = inputValue(page, 'woocommerce-login-nonce');
    if (!nonce) throw new Error('Không thấy form đăng nhập của nguồn hàng');
    const form = new URLSearchParams({
      username: String(username), password: String(password),
      'woocommerce-login-nonce': nonce, _wp_http_referer: inputValue(page, '_wp_http_referer') || accountPath, login: 'Đăng nhập'
    });
    if (remember) form.set('rememberme', 'forever');
    const r2 = await http(accountPath, {
      method: 'POST', body: form, redirect: 'manual', cookie: cookieHeader(jar),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, referer: base + accountPath }
    });
    mergeCookies(jar, r2.headers.getSetCookie?.() || []);
    if (!Object.keys(jar).some(k => k.startsWith('wordpress_logged_in_'))) {
      const t = await r2.text().catch(() => '');
      const err = htmlText((t.match(/<ul[^>]*woocommerce-error[\s\S]*?<\/ul>/i) || [])[0] || '').replace(/Quên mật khẩu\??/i, '').trim();
      throw new Error(err || 'Sai tên đăng nhập hoặc mật khẩu');
    }
    store.saveSession({ cookie: cookieHeader(jar), username: String(username), logged_in_at: new Date().toISOString() });
    verifiedAt = Date.now();
    if (remember) vault.save(username, password);
    return { username: String(username) };
  }

  async function verify(cookie) {
    const res = await http(accountPath, { cookie, timeout: 20000 });
    const t = await res.text();
    return /class="[^"]*\blogged-in\b/.test(t) || /woocommerce-MyAccount-navigation/.test(t);
  }

  /** Cookie phiên đại lý còn hiệu lực (kiểm tra lại tối đa 30 phút/lần); hết hạn thì tự đăng nhập lại nếu đã ghi nhớ. */
  async function ensureSession({ force = false } = {}) {
    const s = store.getSession();
    if (s?.cookie && !force && Date.now() - verifiedAt < 30 * 60e3) return s.cookie;
    if (s?.cookie && await verify(s.cookie).catch(() => false)) { verifiedAt = Date.now(); return s.cookie; }
    const creds = vault.load();
    if (!creds) { if (s) store.clearSession(); return null; }
    console.log(`[Nguồn ${def.label}] Phiên hết hạn → tự đăng nhập lại`);
    await login(creds.username, creds.password);
    return store.getSession().cookie;
  }

  function logout() {
    store.clearSession();
    vault.clear();
    verifiedAt = 0;
  }

  // ───────── Đọc dữ liệu ─────────
  async function fetchPage(page, cookie) {
    for (let a = 0; ; a++) {
      try {
        const res = await http(`/wp-json/wc/store/v1/products?per_page=100&page=${page}&orderby=id&order=asc`, { cookie });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { items: parseJsonLoose(await res.text()), total: Number(res.headers.get('x-wp-total')) || null, pages: Number(res.headers.get('x-wp-totalpages')) || null };
      } catch (e) {
        if (a >= 2) throw e;
        await sleep(1500 * (a + 1));
      }
    }
  }

  async function fetchAllRaw(cookie) {
    const first = await fetchPage(1, cookie);
    const pages = first.pages || 1;
    const items = [...first.items];
    let failed = 0;
    let next = 2;
    await Promise.all([1, 2, 3].map(async () => {
      while (next <= pages) {
        const p = next++;
        try { items.push(...(await fetchPage(p, cookie)).items); } catch (e) { failed++; }
      }
    }));
    return { items, total: first.total, failed };
  }

  async function fetchCategories(cookie) {
    const all = [];
    for (let p = 1; p <= 50; p++) {
      const res = await http(`/wp-json/wc/store/v1/products/categories?per_page=100&page=${p}`, { cookie });
      if (!res.ok) break;
      const list = parseJsonLoose(await res.text());
      if (!Array.isArray(list) || list.length === 0) break;
      all.push(...list);
      if (list.length < 100) break;
    }
    return all;
  }

  function mapCategories(raw) {
    const cats = [{ id: rootId, name: def.rootCategoryName, parent_id: null, source: def.key }];
    const ignore = name => /^(chưa phân loại|uncategorized)$/i.test(name) || (def.ignoreCategories && def.ignoreCategories.test(name));
    const skip = new Set(raw.filter(c => ignore(htmlText(c.name))).map(c => c.id));
    for (const c of raw) {
      if (skip.has(c.id)) continue;
      cats.push({ id: rootId + c.id, name: htmlText(c.name), parent_id: c.parent && !skip.has(c.parent) ? rootId + c.parent : rootId, source: def.key });
    }
    const ids = new Set(cats.map(c => c.id));
    for (const c of cats) if (c.parent_id && !ids.has(c.parent_id)) c.parent_id = rootId;
    return cats;
  }

  /** Danh mục cụ thể nhất trong số danh mục được gán (bỏ "Chưa phân loại"); không có → danh mục gốc của nguồn. */
  function pickCategory(list = [], catMap) {
    const ids = list.map(c => rootId + c.id).filter(id => catMap.has(id));
    const parents = new Set(ids.map(id => catMap.get(id).parent_id));
    const leaf = ids.find(id => !parents.has(id)) ?? ids[0];
    const c = catMap.get(leaf) || catMap.get(rootId);
    return { id: c?.id ?? rootId, name: c?.name ?? def.rootCategoryName };
  }

  function mapItem(raw, catMap) {
    const dealer = minorPrice(raw.prices, 'price');
    const imgs = (raw.images || []).filter(i => i?.src && !/woocommerce-placeholder/i.test(i.src));
    const fromPage = !!def.resolvePageImages;
    const cat = pickCategory(raw.categories, catMap);
    const brand = (raw.attributes || []).find(a => /thương hiệu|brand/i.test(a.name))?.terms?.[0]?.name;
    const weightKg = parseFloat(raw.weight);
    return {
      id: def.idOffset + raw.id,
      source: def.key,
      source_id: raw.id,
      source_url: raw.permalink,
      sku: htmlText(raw.sku) || `${def.key}-${raw.id}`,
      name: htmlText(raw.name),
      slug: slugify(htmlText(raw.name)),
      category_id: cat.id,
      category_name: cat.name,
      brand: brand ? htmlText(brand) : null,
      // API ghi ảnh có hay không; ảnh thật (fromPage) đọc từ trang SP rồi mới gán – chưa đọc thì chưa lên kệ
      api_image: imgs[0]?.src || '',
      image: fromPage ? '' : (imgs[0] ? (imgs[0].thumbnail || imgs[0].src) : ''),
      image_hd: fromPage ? '' : (imgs[0]?.src || ''),
      gallery: fromPage ? [] : imgs.slice(0, 16).map(i => ({ url: i.src, thumb: i.thumbnail || i.src })),
      // Mô tả chỉ giữ cho SP có ảnh (SP không ảnh không lên kệ) – file dữ liệu gọn
      description: imgs.length ? String(raw.description || '') : '',
      in_stock: raw.is_in_stock !== false && raw.is_purchasable !== false,
      dealer_price: dealer,
      retail_price: (def.parseRetail || defaultRetail)(raw, dealer),
      weight_gram: Number.isFinite(weightKg) ? Math.round(weightKg * 1000) : 0,
      variant_count: 1,
      variation_id: String(def.idOffset + raw.id), // mã trung tính – khách không thấy tên nguồn
      updated_at: new Date().toISOString()
    };
  }

  const keepImages = (p, old) => {
    if (old && old.images_for && old.images_for === p.api_image && old.images_v === IMAGE_RULES_VERSION) {
      Object.assign(p, { image: old.image || '', image_hd: old.image_hd || '', gallery: old.gallery || [], images_for: old.images_for, images_v: old.images_v });
    }
    return p;
  };
  const needsImages = p => !p.removed && p.api_image && (p.images_for !== p.api_image || p.images_v !== IMAGE_RULES_VERSION);

  // Ảnh trên web nguồn có thể đã bị xoá (trang của họ cũng trắng) → chỉ nhận ảnh thật sự tải được
  async function alive(url) {
    try {
      const r = await doFetch(url, { method: 'HEAD', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) });
      return r.ok && /^image\//i.test(r.headers.get('content-type') || 'image/');
    } catch (e) { return false; }
  }
  async function pickLiveImages(urls) {
    const out = [];
    for (const u of urls.slice(0, 8)) {
      if (!await alive(u)) continue;
      const card = hstaticSize(u, 'large');
      // cỡ large tải được thì cỡ medium (cùng quy tắc tên) cũng có; không thì dùng ảnh gốc cho cả hai
      const sized = card === u || await alive(card);
      out.push({ url: u, card: sized ? card : u, thumb: sized ? hstaticSize(u, 'medium') : u });
      if (out.length >= 6) break;
    }
    return out;
  }

  async function resolveImages(list, budget = 600, onBatch = () => {}) {
    const todo = list.filter(needsImages).slice(0, budget);
    let next = 0;
    let done = 0;
    state.progress = { done: 0, total: todo.length };
    await Promise.all([1, 2, 3, 4].map(async () => {
      while (next < todo.length) {
        const p = todo[next++];
        try {
          const res = await http(new URL(p.source_url).pathname, { timeout: 20000 });
          if (!res.ok) continue;
          const live = await pickLiveImages(pageImages(await res.text()));
          // đã kiểm tra (kể cả khi không còn ảnh sống) → không đọc lại tới khi ảnh đổi
          Object.assign(p, {
            images_for: p.api_image, images_v: IMAGE_RULES_VERSION,
            image: live[0]?.card || '', image_hd: live[0]?.url || '',
            gallery: live.map(x => ({ url: x.url, thumb: x.thumb }))
          });
          done++;
          state.progress = { done, total: todo.length };
          if (done % 50 === 0) onBatch(); // lưu dần để admin/khách thấy SP lên kệ ngay, không chờ hết lượt
        } catch (e) { /* lượt sau thử lại */ }
      }
    }));
    return { checked: done, pending: list.filter(needsImages).length };
  }

  function applyPricing(p, r, rootMap) {
    const cost = Math.round(Number(p.dealer_price || 0) * (1 + r.surchargePercent / 100));
    const out = pricing.computePrice({ id: p.id, category_id: p.category_id, wholesale: cost, public_price: Number(p.retail_price) || 0 }, r, rootMap);
    p.supplier_cost = cost;
    p.dropbuy_cost = cost; // tên cũ: báo cáo lãi và bảng giá admin đọc giá vốn ở trường này
    p.price = cost > 0 ? out.price : 0;
    p.original_price = out.original_price;
    p.pricing_rule = out.rule;
    p.profit_margin = out.markup_percent;
    return p;
  }

  const publicPatch = p => {
    const discount = p.original_price && p.original_price > p.price ? Math.round((1 - p.price / p.original_price) * 100) : 0;
    return { id: p.id, name: p.name, price: p.price, original_price: p.original_price, discount_percent: discount, in_stock: p.in_stock !== false && !p.removed, image: p.image, category_id: p.category_id, variant_count: 1 };
  };
  function emit(changed) {
    const items = changed.filter(p => p.image).slice(0, 500).map(publicPatch);
    if (io && items.length) io.emit('PRODUCTS_UPDATED', { at: new Date().toISOString(), source: def.key, items, newCount: 0 });
  }

  // ───────── Đồng bộ ─────────
  async function syncAll() {
    if (syncing) return syncing;
    syncing = (async () => {
      const t0 = Date.now();
      state.lastRun = new Date().toISOString();
      state.phase = 'catalog';
      state.progress = null;
      try {
        const cookie = await ensureSession().catch(e => { console.warn(`[Nguồn ${def.label}] Đăng nhập lỗi:`, e.message); return null; });
        const meta = store.getMeta();
        let cats = store.getCategories();
        if (!cats.length || !meta.categoriesAt || Date.now() - Date.parse(meta.categoriesAt) > 6 * 3600e3) {
          const fresh = await fetchCategories(cookie);
          if (fresh.length) { cats = mapCategories(fresh); store.saveCategories(cats); meta.categoriesAt = new Date().toISOString(); }
        }
        const catMap = new Map(cats.map(c => [c.id, c]));
        const rootMap = pricing.rootCategoryMap(cats);
        const r = rules();
        const { items, total, failed } = await fetchAllRaw(cookie);
        const complete = failed === 0 && (!total || items.length >= total * 0.98);
        const prev = new Map(store.getProducts().map(p => [p.id, p]));
        const next = [];
        const changed = [];
        const seen = new Set();
        for (const raw of items) {
          const old0 = prev.get(def.idOffset + raw.id);
          const p = applyPricing(def.resolvePageImages ? keepImages(mapItem(raw, catMap), old0) : mapItem(raw, catMap), r, rootMap);
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          const old = prev.get(p.id);
          if (!old || old.price !== p.price || old.in_stock !== p.in_stock || old.image !== p.image || old.removed) changed.push(p);
          next.push(p);
        }
        for (const [id, old] of prev) {
          if (seen.has(id)) continue;
          if (complete && !old.removed) { const gone = { ...old, removed: true, in_stock: false }; next.push(gone); changed.push(gone); }
          else next.push(old); // quét thiếu trang → giữ nguyên, không gỡ nhầm
        }
        // Lưu ngay danh mục vừa tải (giá, tồn kho) – phần đọc ảnh có thể mất vài phút
        store.saveProducts(next);
        store.saveMeta({ ...meta, total: total || items.length, fetched: items.length, complete, logged_in: !!cookie });
        let images = null;
        if (def.resolvePageImages) {
          state.phase = 'images';
          const before = new Map(next.map(p => [p.id, p.image]));
          const flush = () => {
            const fresh = next.filter(p => p.image !== before.get(p.id));
            for (const p of fresh) before.set(p.id, p.image);
            store.saveProducts(next);
            emit(fresh);
          };
          images = await resolveImages(next, 600, flush);
          for (const p of next) if (p.image !== before.get(p.id) && !changed.includes(p)) changed.push(p);
        }
        store.saveProducts(next);
        const summary = {
          total: total || items.length, fetched: items.length, failedPages: failed, complete, logged_in: !!cookie,
          sellable: next.filter(isSellable).length, changed: changed.length,
          ...(images ? { images_pending: images.pending } : {})
        };
        store.saveMeta({ ...meta, lastSync: new Date().toISOString(), ...summary });
        state.lastOk = new Date().toISOString();
        state.lastError = null;
        state.failures = 0;
        emit(changed);
        console.log(`[Nguồn ${def.label}] ${summary.fetched}/${summary.total} SP${complete ? '' : ' (thiếu trang)'}, ${summary.sellable} lên kệ, ${summary.changed} thay đổi, ${cookie ? 'giá đại lý' : 'CHƯA đăng nhập'}${images?.pending ? `, còn ${images.pending} SP chờ đọc ảnh` : ''}.`);
        return summary;
      } catch (e) {
        state.failures++;
        state.lastError = e.message;
        throw e;
      } finally {
        state.lastDurationMs = Date.now() - t0;
        state.phase = null;
        state.progress = null;
        syncing = null;
      }
    })();
    return syncing;
  }

  /** Tính lại giá toàn bộ SP của nguồn theo quy tắc hiện tại (sau khi admin lưu thiết lập giá). */
  function reprice() {
    const cats = store.getCategories();
    const rootMap = pricing.rootCategoryMap(cats);
    const r = rules();
    const changed = [];
    const list = store.getProducts().map(p => {
      const before = p.price;
      const next = applyPricing({ ...p }, r, rootMap);
      if (next.price !== before) changed.push(next);
      return next;
    });
    store.saveProducts(list);
    emit(changed);
    return changed.length;
  }

  function updateOne(fresh) {
    const list = store.getProducts();
    const i = list.findIndex(p => p.id === fresh.id);
    if (i < 0) return;
    const old = list[i];
    const merged = { ...old, ...fresh, category_id: old.category_id, category_name: old.category_name, description: fresh.description || old.description };
    if (def.resolvePageImages) keepImages(merged, old);
    if (old.price === merged.price && old.in_stock === merged.in_stock && !old.removed === !merged.removed) return;
    const copy = list.slice();
    copy[i] = merged;
    store.saveProducts(copy);
    emit([merged]);
  }

  /** Kiểm tra trực tiếp 1 SP với web nguồn (lúc khách mở chi tiết / đặt hàng): giá đại lý + tồn kho mới nhất. */
  async function liveCheck(product) {
    const base = { sku: product.sku, variation_id: product.variation_id, name: product.name, variant_name: null, weight_gram: product.weight_gram || 0, cost_is_wholesale: true };
    try {
      const cookie = await ensureSession().catch(() => null);
      const res = await http(`/wp-json/wc/store/v1/products/${product.source_id}`, { cookie, timeout: 15000 });
      if (res.status === 404) {
        updateOne({ ...product, removed: true, in_stock: false });
        return { ...base, ok: false, live: true, in_stock: false, price: product.price, cost: product.supplier_cost, message: `"${product.name}" không còn bán.` };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cats = store.getCategories();
      const fresh = applyPricing(mapItem(parseJsonLoose(await res.text()), new Map(cats.map(c => [c.id, c]))), rules(), pricing.rootCategoryMap(cats));
      fresh.category_id = product.category_id;
      updateOne({ ...fresh, removed: false });
      const ok = fresh.in_stock && fresh.price > 0;
      return { ...base, ok, live: true, in_stock: fresh.in_stock, price: fresh.price, cost: fresh.supplier_cost, message: ok ? null : `"${product.name}" vừa hết hàng.` };
    } catch (e) {
      const ok = product.in_stock !== false && Number(product.price) > 0;
      return { ...base, ok, live: false, in_stock: product.in_stock !== false, price: product.price, cost: product.supplier_cost, message: ok ? null : `"${product.name}" đã hết hàng.` };
    }
  }

  const detail = product => ({ description: product.description || '', gallery: product.gallery || [], video_url: null });

  /** Phí ship cho phần hàng của nguồn này (theo chính sách giao hàng của nguồn, chỉnh được trong admin). */
  function shippingQuote({ province, subtotal }) {
    const s = shippingRules();
    const hcm = /hồ chí minh|ho chi minh|hcm/i.test(String(province || ''));
    const freeFrom = hcm ? s.hcmFreeFrom : s.otherFreeFrom;
    const fee = freeFrom > 0 && subtotal >= freeFrom ? 0 : (hcm ? s.hcmFee : s.otherFee);
    return { fee, free_ship: fee === 0, detail: hcm ? 'giao nội thành 1–2 ngày' : 'giao 2–5 ngày' };
  }

  function status() {
    const s = store.getSession();
    const list = store.getProducts();
    return {
      key: def.key, label: def.label, url: base,
      logged_in: !!s?.cookie, username: s?.username || vault.info().username || null, remembered: vault.info().saved,
      products: list.filter(p => !p.removed).length, sellable: list.filter(isSellable).length,
      in_stock: list.filter(p => !p.removed && p.in_stock).length,
      meta: store.getMeta(), sync: { ...state, running: !!syncing }
    };
  }

  return {
    def, store, vault, SPAN,
    setIo: x => { io = x; },
    login, logout, ensureSession, syncAll, reprice, liveCheck, detail, shippingQuote, status, rules, shippingRules,
    _test: { mapItem, applyPricing, mapCategories, pickCategory }
  };
}

module.exports = { createWooSource, parseJsonLoose, defaultRetail, htmlText, normalizeSourceRules, normalizeShipping, isSellable, pageImages, hstaticSize, IMAGE_RULES_VERSION, SPAN };
