const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { maskMediaUrl } = require('./catalogImage');
const { stripSupplierText } = require('./security');
const pages = require('./seoPages');
const infoPages = require('./infoPages');

/**
 * Trang sản phẩm có URL thật /sp/<id>-<slug> cho Google và ảnh xem trước khi chia sẻ (Facebook, Zalo...).
 * Server chèn title / meta / Open Graph / JSON-LD vào index.html; app.js mở popup sản phẩm như bình thường.
 */

const INDEX_FILE = path.join(__dirname, '..', 'public', 'index.html');
let template = null;
let templateMtime = 0;

// An automatic content fingerprint prevents returning old CSS/JS after deployment.
  // Compute once at server startup (the server restarts when a release is deployed).
const ASSET_VERSION = (() => {
  const html = fs.readFileSync(INDEX_FILE, 'utf8');
  const assets = [...new Set([...html.matchAll(/(?:href|src)="(\/[a-zA-Z0-9_.-]+\.(?:css|js))"/g)].map(m => m[1]))];
  const hash = crypto.createHash('sha256');
  for (const asset of assets) {
    const file = path.join(__dirname, '..', 'public', asset.slice(1));
    hash.update(asset);
    hash.update(fs.readFileSync(file));
  }
  return 'v=' + hash.digest('hex').slice(0, 12);
})();
function bustAssets(html) {
  return html
    .replace(/(href="\/[a-zA-Z0-9_\-\.]+\.css)(")/g, `$1?${ASSET_VERSION}$2`)
    .replace(/(src="\/[a-zA-Z0-9_\-\.]+\.js)(")/g, `$1?${ASSET_VERSION}$2`);
}

function getTemplate() {
  const mtime = fs.statSync(INDEX_FILE).mtimeMs;
  if (!template || mtime !== templateMtime) {
    // Chuẩn hoá xuống dòng (máy Windows checkout ra CRLF) để các mốc chèn nội dung luôn khớp
    template = bustAssets(fs.readFileSync(INDEX_FILE, 'utf8').replace(/\r\n/g, '\n'));
    templateMtime = mtime;
  }
  return template;
}

const escAttr = s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stripHtml = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const isBesi = isBesiHost(req);
  const peer = String(req.socket?.remoteAddress || '');
  const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const viaHttps = isBesi || (local && (/"scheme"\s*:\s*"https"/.test(String(req.get('cf-visitor') || '')) || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https'));
  const host = isBesi ? 'besi.com.vn' : (req.get('host') || 'localhost:3000');
  return `${viaHttps ? 'https' : req.protocol}://${host}`;
}

const productPath = pages.productPath;

/**
 * Chèn nội dung dựng sẵn vào index.html:
 *  head   → cuối <head> · top → đầu <main> · grid → #productGrid · pager → #pagination · footer → trong <footer>
 *  demoteHero: trang không phải trang chủ → khẩu hiệu "Giá tốt mỗi ngày" thôi làm H1 (H1 là tên SP / danh mục)
 */
const MARK = {
  main: '<main class="container main-layout" id="catalog">',
  grid: '<div class="product-grid" id="productGrid">\n      <!-- Injected via JS -->\n    </div>',
  pager: '<div class="pagination-wrapper flex-center" id="pagination">\n      <!-- Injected via JS -->\n    </div>',
  footer: '<footer class="main-footer">',
  heroH1: /<h1>(Giá tốt mỗi ngày\.[\s\S]*?)<\/h1>/
};
function inject(html, { head = '', top = '', grid = '', pager = '', footer = '', demoteHero = false } = {}) {
  let out = html.replace(/<title>[\s\S]*?<\/title>/, '').replace('</head>', `${head}\n</head>`);
  if (top) out = out.replace(MARK.main, `${MARK.main}\n${top}`);
  if (grid) out = out.replace(MARK.grid, `<div class="product-grid" id="productGrid">${grid}</div>`);
  if (pager) out = out.replace(MARK.pager, `<div class="pagination-wrapper flex-center" id="pagination">${pager}</div>`);
  if (footer) out = out.replace(MARK.footer, `${MARK.footer}\n${footer}`);
  if (demoteHero) out = out.replace(MARK.heroH1, '<div class="hero-h1" role="heading" aria-level="2">$1</div>');
  return out;
}

// BESI storefront metadata must be correct even if legacy store configuration
// still contains the old retail name. Do not change any other host.
function isBesiHost(req) {
  return /(^|\.)besi\.com\.vn(?::\d+)?$/i.test(String(req.get('host') || ''));
}
function storeName(config, req) {
  return isBesiHost(req) ? 'BESI' : (config.store?.name || 'Hoàng Minh Store');
}

/** HTML trang sản phẩm (index.html + thẻ SEO / OpenGraph tối ưu cho Zalo, Facebook, Messenger) */
function renderProductPage(req, product, detail, config, extra = {}) {
  const base = baseUrl(req);
  const url = base + productPath(product);
  const name = storeName(config, req);
  const priceText = `${Number(product.price).toLocaleString('vi-VN')} đ`;
  // Mô tả: tên + giá + tình trạng trước (đúng ý người tìm), rồi đoạn đầu mô tả SP
  const lead = `${product.name}${product.brand ? ` chính hãng ${product.brand}` : ''}, giá ${priceText}. ${product.in_stock === false ? 'Tạm hết hàng.' : 'Còn hàng, giao toàn quốc, kiểm tra trước khi thanh toán.'}`;
  const desc = stripSupplierText(`${lead} ${stripHtml(detail?.description)}`).slice(0, 158).replace(/\s+\S*$/, '') + '…';
  
  // Ưu tiên ảnh chuẩn 256x256 / 500px (< 150KB) để Zalo/Facebook bot tải ngay lập tức không bị timeout
  const chosenImg = product.image || product.image_hd;
  const maskedImg = maskMediaUrl(chosenImg);
  const image = maskedImg && maskedImg.startsWith('/') ? base + maskedImg : maskedImg;
  const mimeType = /\.(jpe?g|jfif)$/i.test(image) ? 'image/jpeg' : /\.webp$/i.test(image) ? 'image/webp' : /\.gif$/i.test(image) ? 'image/gif' : 'image/png';

  const crumbs = extra.crumbs || [{ name: 'Trang chủ', url: '/' }, { name: product.name }];
  const ld = pages.ldScript([
    infoPages.organizationLd(base, config),
    infoPages.returnPolicyLd(base),
    pages.productLd(base, product, { description: stripSupplierText(stripHtml(detail?.description)) || desc, category: extra.category }),
    pages.breadcrumbLd(base, crumbs)
  ]);
  const head = `
  <title>${escAttr(product.name)} | ${escAttr(name)}</title>
  <meta name="description" content="${escAttr(desc)}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <link rel="canonical" href="${escAttr(url)}">
  
  <!-- Open Graph / Zalo / Facebook -->
  <meta property="og:type" content="website">
  <meta property="og:locale" content="vi_VN">
  <meta property="og:site_name" content="${escAttr(name)}">
  <meta property="og:url" content="${escAttr(url)}">
  <meta property="og:title" content="${escAttr(product.name)}">
  <meta property="og:description" content="${escAttr(`${priceText} – ${desc}`)}">
  <meta property="og:image" content="${escAttr(image)}">
  <meta property="og:image:secure_url" content="${escAttr(image)}">
  <meta property="og:image:type" content="${escAttr(mimeType)}">
  <meta property="og:image:width" content="600">
  <meta property="og:image:height" content="600">
  <meta property="og:image:alt" content="${escAttr(product.name)}">
  <meta property="product:price:amount" content="${product.price}">
  <meta property="product:price:currency" content="VND">

  <!-- Twitter Card / Telegram -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escAttr(product.name)}">
  <meta name="twitter:description" content="${escAttr(`${priceText} – ${desc}`)}">
  <meta name="twitter:image" content="${escAttr(image)}">

  ${ld}
  <script>window.__INITIAL_PRODUCT_ID__ = ${Number(product.id)};</script>`;
  return inject(getTemplate(), { head, top: extra.articleHtml || '', footer: extra.footerHtml || '', demoteHero: true });
}

/** HTML trang chủ kèm meta mô tả cửa hàng (tự động đổi theo từ khoá tìm kiếm / bộ lọc) */
/** extra: bộ lọc đọc từ link gọn /tim-kiem/…, /thuong-hieu/…, /danh-muc/… (đã khôi phục dấu) */
function renderHomePage(req, config, total, extra = {}) {
  const name = storeName(config, req);
  const q = String(extra.q || req.query?.q || req.query?.search || '').trim();
  const brand = String(extra.brand || req.query?.brand || '').trim();
  const category = String(extra.category || '').trim();

  let pageTitle = isBesiHost(req) ? 'BESI | Sàn mua lẻ giá tốt, nhập sỉ từ nhiều tổng kho' : (config.store?.slogan ? `${name} | ${config.store.slogan}` : name);
  let ogTitle = name;
  let desc = isBesiHost(req)
    ? `BESI tập hợp ${total.toLocaleString('vi-VN')} sản phẩm từ nhiều tổng kho và nhà phân phối. Mua lẻ giá tốt, nhập sỉ số lượng lớn và khám phá nhiều ngành hàng trong một nơi.`
    : `${config.store?.slogan || 'Tổng kho phân phối sỉ & lẻ chính hãng'} – Hơn ${total.toLocaleString('vi-VN')} sản phẩm công nghệ & gia dụng chính hãng, giao toàn quốc, kiểm tra hàng – trả tiền khi nhận.`;

  if (q) {
    pageTitle = `Tìm kiếm "${q}" | ${name}`;
    ogTitle = `Tìm kiếm "${q}" | ${name}`;
    desc = `Danh sách sản phẩm "${q}" giá sỉ & lẻ tốt nhất tại ${name}. Hơn ${total.toLocaleString('vi-VN')} sản phẩm chính hãng, kiểm tra trước khi nhận, giao hàng toàn quốc.`;
  } else if (brand && brand !== 'all') {
    pageTitle = `Thương hiệu ${brand} | ${name}`;
    ogTitle = `Thương hiệu ${brand} | ${name}`;
    desc = `Khám phá các sản phẩm thương hiệu ${brand} chính hãng, giá sỉ tốt nhất tại ${name}.`;
  } else if (category) {
    pageTitle = `${category} | ${name}`;
    ogTitle = `${category} | ${name}`;
    desc = `Danh mục ${category} tại ${name}: hàng chính hãng từ nhiều tổng kho, kiểm tra trước khi nhận, giao hàng toàn quốc.`;
  }

  if (extra.page > 1) {
    pageTitle = `${pageTitle} – Trang ${extra.page}`;
    desc = `Trang ${extra.page}: ${desc}`;
  }
  const base = baseUrl(req);
  // Canonical: link chuẩn của trang (không kèm ?sort=, ?min=…), giữ ?page=N
  const canonicalUrl = `${base}${extra.canonicalPath || req.originalUrl || '/'}`;
  // Ảnh chia sẻ PNG (Zalo / Facebook không hiện SVG); tên miền cũ giữ logo cũ
  const ogImage = pages.abs(base, extra.ogImage || (isBesiHost(req) ? '/og-besi.png' : '/logo.svg'));
  const robots = extra.robots || 'index, follow, max-image-preview:large';
  const head = `
  <title>${escAttr(pageTitle)}</title>
  <meta name="description" content="${escAttr(desc)}">
  <meta name="robots" content="${escAttr(robots)}">
  <link rel="canonical" href="${escAttr(canonicalUrl)}">${extra.prevPath ? `
  <link rel="prev" href="${escAttr(base + extra.prevPath)}">` : ''}${extra.nextPath ? `
  <link rel="next" href="${escAttr(base + extra.nextPath)}">` : ''}
  <meta property="og:type" content="website">
  <meta property="og:locale" content="vi_VN">
  <meta property="og:site_name" content="${escAttr(name)}">
  <meta property="og:title" content="${escAttr(ogTitle)}">
  <meta property="og:description" content="${escAttr(desc)}">
  <meta property="og:image" content="${escAttr(ogImage)}">
  <meta property="og:url" content="${escAttr(canonicalUrl)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escAttr(ogTitle)}">
  <meta name="twitter:description" content="${escAttr(desc)}">
  <meta name="twitter:image" content="${escAttr(ogImage)}">${q ? `
  <meta name="besi:q" content="${escAttr(q)}">` : ''}
  ${extra.ld || ''}`;
  return inject(getTemplate(), {
    head, top: extra.headHtml || '', grid: extra.gridHtml || '', pager: extra.pagerHtml || '',
    footer: extra.footerHtml || '', demoteHero: !!extra.headHtml
  });
}

const SITEMAP_CHUNK = 5000;
const xmlEsc = v => escAttr(v).replace(/'/g, '&apos;');
const urlset = rows => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`;
const day = v => String(v || new Date().toISOString()).slice(0, 10);

/** /sitemap.xml = chỉ mục: trang (chủ, danh mục, thương hiệu) + SP chia nhiều tệp */
function sitemapIndexXml(req, productCount) {
  const base = baseUrl(req);
  const today = day();
  const files = ['/sitemap-pages.xml'];
  for (let i = 1; i <= Math.max(1, Math.ceil(productCount / SITEMAP_CHUNK)); i++) files.push(`/sitemap-products-${i}.xml`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${files.map(f => `  <sitemap><loc>${xmlEsc(base + f)}</loc><lastmod>${today}</lastmod></sitemap>`).join('\n')}\n</sitemapindex>\n`;
}

function sitemapPagesXml(req, categories, brands, infoPaths = []) {
  const base = baseUrl(req);
  const rows = [`  <url><loc>${base}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`]
    .concat(infoPaths.map(p => `  <url><loc>${xmlEsc(base + p)}</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>`))
    .concat(categories.map(c => `  <url><loc>${xmlEsc(base + pages.categoryPath(c))}</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`))
    .concat(brands.map(b => `  <url><loc>${xmlEsc(base + pages.brandPath(b.name))}</loc><changefreq>daily</changefreq><priority>0.6</priority></url>`));
  return urlset(rows);
}

/** chunk bắt đầu từ 1; null nếu ngoài phạm vi */
function sitemapProductsXml(req, products, chunk) {
  const base = baseUrl(req);
  const list = products.slice((chunk - 1) * SITEMAP_CHUNK, chunk * SITEMAP_CHUNK);
  if (chunk < 1 || !list.length) return null;
  return urlset(list.map(p => `  <url><loc>${xmlEsc(base + productPath(p))}</loc><lastmod>${day(p.updated_at)}</lastmod><changefreq>daily</changefreq></url>`));
}

// Giữ cho mã cũ / test cũ: 1 tệp gồm trang chủ + mọi SP còn hàng
function sitemapXml(req, products) {
  const base = baseUrl(req);
  return urlset([`  <url><loc>${base}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`]
    .concat(products.filter(p => p.in_stock !== false).map(p => `  <url><loc>${xmlEsc(base + productPath(p))}</loc><lastmod>${day(p.updated_at)}</lastmod><changefreq>daily</changefreq></url>`)));
}

function robotsTxt(req) {
  return [
    'User-agent: *',
    'Allow: /',
    // Phần riêng tư / không có giá trị tìm kiếm
    'Disallow: /api/account/',
    'Disallow: /api/orders/',
    // Bộ lọc giá / sắp xếp tạo vô số link trùng nội dung
    'Disallow: /*?*sort=',
    'Disallow: /*?*min=',
    'Disallow: /*?*max=',
    '',
    `Sitemap: ${baseUrl(req)}/sitemap.xml`,
    ''
  ].join('\n');
}

module.exports = { ASSET_VERSION, renderProductPage, renderHomePage, sitemapXml, sitemapIndexXml, sitemapPagesXml, sitemapProductsXml, SITEMAP_CHUNK, robotsTxt, productPath, baseUrl, isBesiHost, MARK };
