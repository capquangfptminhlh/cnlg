const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { maskMediaUrl } = require('./catalogImage');
const { stripSupplierText } = require('./security');

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
    template = bustAssets(fs.readFileSync(INDEX_FILE, 'utf8'));
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

function productPath(p) {
  return `/sp/${p.id}-${String(p.slug || '').slice(0, 80)}`;
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
function renderProductPage(req, product, detail, config) {
  const base = baseUrl(req);
  const url = base + productPath(product);
  const name = storeName(config, req);
  const priceText = `${Number(product.price).toLocaleString('vi-VN')} đ`;
  const desc = stripSupplierText(stripHtml(detail?.description).slice(0, 160) || `${product.name} – Giá sỉ: ${priceText}. ${product.in_stock === false ? 'Tạm hết hàng.' : 'Còn hàng, giao toàn quốc, kiểm tra trước khi thanh toán.'}`);
  
  // Ưu tiên ảnh chuẩn 256x256 / 500px (< 150KB) để Zalo/Facebook bot tải ngay lập tức không bị timeout
  const chosenImg = product.image || product.image_hd;
  const maskedImg = maskMediaUrl(chosenImg);
  const image = maskedImg && maskedImg.startsWith('/') ? base + maskedImg : maskedImg;
  const mimeType = /\.(jpe?g|jfif)$/i.test(image) ? 'image/jpeg' : /\.webp$/i.test(image) ? 'image/webp' : /\.gif$/i.test(image) ? 'image/gif' : 'image/png';

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    image: [image],
    sku: product.sku,
    description: desc,
    brand: { '@type': 'Brand', name },
    category: product.category_name || undefined,
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: 'VND',
      price: product.price,
      availability: product.in_stock === false ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
      seller: { '@type': 'Organization', name }
    }
  };
  const head = `
  <title>${escAttr(product.name)} | ${escAttr(name)}</title>
  <meta name="description" content="${escAttr(desc)}">
  <link rel="canonical" href="${escAttr(url)}">
  
  <!-- Open Graph / Zalo / Facebook -->
  <meta property="og:type" content="website">
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

  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
  <script>window.__INITIAL_PRODUCT_ID__ = ${Number(product.id)};</script>`;
  return getTemplate()
    .replace(/<title>[\s\S]*?<\/title>/, '')
    .replace('</head>', `${head}\n</head>`);
}

/** HTML trang chủ kèm meta mô tả cửa hàng (tự động đổi theo từ khoá tìm kiếm / bộ lọc) */
function renderHomePage(req, config, total) {
  const name = storeName(config, req);
  const q = String(req.query?.q || req.query?.search || '').trim();
  const brand = String(req.query?.brand || '').trim();

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
  }

  const base = baseUrl(req);
  const canonicalUrl = `${base}${req.originalUrl || '/'}`;
  const head = `
  <title>${escAttr(pageTitle)}</title>
  <meta name="description" content="${escAttr(desc)}">
  <link rel="canonical" href="${escAttr(canonicalUrl)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${escAttr(name)}">
  <meta property="og:title" content="${escAttr(ogTitle)}">
  <meta property="og:description" content="${escAttr(desc)}">
  <meta property="og:image" content="${escAttr(base + (isBesiHost(req) ? '/besi-logo.svg' : '/logo.svg'))}">
  <meta property="og:url" content="${escAttr(canonicalUrl)}">`;
  return getTemplate()
    .replace(/<title>[\s\S]*?<\/title>/, '')
    .replace('</head>', `${head}\n</head>`);
}

function sitemapXml(req, products) {
  const base = baseUrl(req);
  const urls = [`  <url><loc>${base}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`]
    .concat(products.filter(p => p.in_stock !== false).map(p =>
      `  <url><loc>${escAttr(base + productPath(p))}</loc><lastmod>${String(p.updated_at || new Date().toISOString()).slice(0, 10)}</lastmod><changefreq>daily</changefreq></url>`));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

function robotsTxt(req) {
  return `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${baseUrl(req)}/sitemap.xml\n`;
}

module.exports = { renderProductPage, renderHomePage, sitemapXml, robotsTxt, productPath, baseUrl };
