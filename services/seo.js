const fs = require('fs');
const path = require('path');

/**
 * Trang sản phẩm có URL thật /sp/<id>-<slug> cho Google và ảnh xem trước khi chia sẻ (Facebook, Zalo...).
 * Server chèn title / meta / Open Graph / JSON-LD vào index.html; app.js mở popup sản phẩm như bình thường.
 */

const INDEX_FILE = path.join(__dirname, '..', 'public', 'index.html');
let template = null;
let templateMtime = 0;

function getTemplate() {
  const mtime = fs.statSync(INDEX_FILE).mtimeMs;
  if (!template || mtime !== templateMtime) {
    template = fs.readFileSync(INDEX_FILE, 'utf8');
    templateMtime = mtime;
  }
  return template;
}

const escAttr = s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stripHtml = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function productPath(p) {
  return `/sp/${p.id}-${String(p.slug || '').slice(0, 80)}`;
}

function storeName(config) {
  return config.store?.name || 'Hoàng Minh Store';
}

/** HTML trang sản phẩm (index.html + thẻ SEO) */
function renderProductPage(req, product, detail, config) {
  const base = baseUrl(req);
  const url = base + productPath(product);
  const name = storeName(config);
  const priceText = `${Number(product.price).toLocaleString('vi-VN')} đ`;
  const desc = (stripHtml(detail?.description).slice(0, 155) || `${product.name} – ${priceText}. ${product.in_stock === false ? 'Tạm hết hàng.' : 'Còn hàng, giao toàn quốc, thanh toán VietQR.'}`);
  const image = product.image_hd || product.image;
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
  <meta property="og:type" content="product">
  <meta property="og:site_name" content="${escAttr(name)}">
  <meta property="og:title" content="${escAttr(product.name)}">
  <meta property="og:description" content="${escAttr(`${priceText} – ${desc}`)}">
  <meta property="og:image" content="${escAttr(image)}">
  <meta property="og:url" content="${escAttr(url)}">
  <meta property="product:price:amount" content="${product.price}">
  <meta property="product:price:currency" content="VND">
  <meta name="twitter:card" content="summary_large_image">
  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
  <script>window.__INITIAL_PRODUCT_ID__ = ${Number(product.id)};</script>`;
  return getTemplate()
    .replace(/<title>[\s\S]*?<\/title>/, '')
    .replace('</head>', `${head}\n</head>`);
}

/** HTML trang chủ kèm meta mô tả cửa hàng */
function renderHomePage(req, config, total) {
  const name = storeName(config);
  const desc = `${config.store?.slogan || 'Tổng kho phân phối sỉ & lẻ chính hãng'} – Hơn ${total.toLocaleString('vi-VN')} sản phẩm công nghệ & gia dụng chính hãng, giao toàn quốc, thanh toán VietQR tự động.`;
  const head = `
  <meta name="description" content="${escAttr(desc)}">
  <link rel="canonical" href="${escAttr(baseUrl(req) + '/')}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${escAttr(name)}">
  <meta property="og:title" content="${escAttr(name)}">
  <meta property="og:description" content="${escAttr(desc)}">
  <meta property="og:url" content="${escAttr(baseUrl(req) + '/')}">`;
  return getTemplate().replace('</head>', `${head}\n</head>`);
}

function sitemapXml(req, products) {
  const base = baseUrl(req);
  const urls = [`  <url><loc>${base}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`]
    .concat(products.filter(p => p.in_stock !== false).map(p =>
      `  <url><loc>${escAttr(base + productPath(p))}</loc><lastmod>${String(p.updated_at || new Date().toISOString()).slice(0, 10)}</lastmod><changefreq>daily</changefreq></url>`));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

function robotsTxt(req) {
  return `User-agent: *\nAllow: /\nDisallow: /admin.html\nDisallow: /api/\n\nSitemap: ${baseUrl(req)}/sitemap.xml\n`;
}

module.exports = { renderProductPage, renderHomePage, sitemapXml, robotsTxt, productPath };
