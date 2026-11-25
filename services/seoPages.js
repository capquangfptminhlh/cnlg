'use strict';
/**
 * Nội dung dựng sẵn ở máy chủ (SSR) cho Google và các AI (ChatGPT, Perplexity, Gemini…).
 *
 * Trước đây mọi trang gửi về cùng một khung trang chủ, sản phẩm chỉ hiện sau khi JavaScript gọi /api/.
 * Bot không chạy JS (GPTBot, PerplexityBot, ClaudeBot, Zalo…) thấy trang trống; Googlebot thì bị
 * robots.txt chặn /api/. Các hàm ở đây tạo HTML + JSON-LD thật cho từng trang; app.js vẫn vẽ lại
 * giao diện như cũ khi chạy.
 */
const { maskMediaUrl } = require('./catalogImage');
const { stripSupplierText } = require('./security');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const money = n => `${Math.round(Number(n) || 0).toLocaleString('vi-VN')} đ`;
const plainText = html => String(html || '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Giống slugifyQuery của app.js – link máy chủ tạo phải trùng link trình duyệt tạo. */
const slug = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

const productPath = p => `/sp/${p.id}-${String(p.slug || slug(p.name)).slice(0, 80)}`;
const categoryPath = c => `/danh-muc/${c.id}${slug(c.name) ? '-' + slug(c.name) : ''}`;
const brandPath = name => `/thuong-hieu/${slug(name)}`;
const abs = (base, url) => (!url ? '' : /^https?:\/\//i.test(url) ? url : base + (url.startsWith('/') ? url : '/' + url));
const imageOf = p => maskMediaUrl(p.image || p.image_hd || '') || '/besi-logo.svg';
const cleanName = s => stripSupplierText(String(s || '')).trim();

// ───────────── HTML ─────────────

function crumbsHtml(crumbs) {
  return `<nav class="ssr-crumbs" aria-label="Đường dẫn">${crumbs.map((c, i) => (i < crumbs.length - 1 && c.url
    ? `<a href="${esc(c.url)}">${esc(c.name)}</a>`
    : `<span aria-current="page">${esc(c.name)}</span>`)).join('<span class="ssr-sep" aria-hidden="true">›</span>')}</nav>`;
}

/** Thẻ SP dựng sẵn trong #productGrid (app.js thay bằng thẻ đầy đủ khi chạy). */
function cardsHtml(products) {
  return products.map(p => {
    const disc = Number(p.discount_percent) > 0 && Number(p.original_price) > Number(p.price);
    return `<article class="ssr-card">
      <a href="${esc(productPath(p))}">
        <img src="${esc(imageOf(p))}" alt="${esc(cleanName(p.name))}" width="400" height="400" loading="lazy" decoding="async">
        <h3>${esc(cleanName(p.name))}</h3>
        <p class="ssr-price"><strong>${money(p.price)}</strong>${disc ? ` <del>${money(p.original_price)}</del> <span>-${Number(p.discount_percent)}%</span>` : ''}</p>
        ${p.in_stock === false ? '<p class="ssr-stock out">Tạm hết hàng</p>' : ''}
      </a>
    </article>`;
  }).join('');
}

function pagerHtml(path, page, totalPages) {
  if (totalPages <= 1) return '';
  const link = n => `${path}${n > 1 ? `?page=${n}` : ''}`;
  const from = Math.max(1, page - 3);
  const to = Math.min(totalPages, page + 3);
  const nums = [];
  for (let n = from; n <= to; n++) nums.push(n === page ? `<span aria-current="page">${n}</span>` : `<a href="${esc(link(n))}">${n}</a>`);
  return `<nav class="ssr-pager" aria-label="Trang">
    ${page > 1 ? `<a rel="prev" href="${esc(link(page - 1))}">‹ Trang trước</a>` : ''}
    ${nums.join('')}
    ${page < totalPages ? `<a rel="next" href="${esc(link(page + 1))}">Trang sau ›</a>` : ''}
  </nav>`;
}

/** Đầu trang danh sách: đường dẫn + H1 + giới thiệu (+ danh mục con). */
function listingHeadHtml({ path, crumbs, h1, intro, links = [] }) {
  return `<header class="ssr-head" id="ssrHead" data-path="${esc(path)}">
    ${crumbsHtml(crumbs)}
    <h1>${esc(h1)}</h1>
    ${intro ? `<p>${esc(intro)}</p>` : ''}
    ${links.length ? `<ul class="ssr-sublinks">${links.map(l => `<li><a href="${esc(l.url)}">${esc(l.name)}</a></li>`).join('')}</ul>` : ''}
  </header>`;
}

/** Bài sản phẩm đầy đủ (bot đọc được; khách dùng JS vẫn thấy popup như cũ). */
function productArticleHtml({ product: p, gallery: detailGallery, crumbs, descHtml, related = [], category, qaHtml = '' }) {
  const name = cleanName(p.name);
  const variants = Array.isArray(p.variants) && p.variants.length > 1 ? p.variants : [];
  const prices = variants.length ? variants.map(v => Number(v.price) || 0).filter(x => x > 0) : [Number(p.price) || 0];
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const disc = Number(p.discount_percent) > 0 && Number(p.original_price) > Number(p.price);
  const big = [...(detailGallery || []), ...(p.gallery || [])].map(g => (typeof g === 'string' ? g : g && g.url)).filter(u => typeof u === 'string' && u).map(maskMediaUrl).filter(Boolean);
  const gallery = [...big, maskMediaUrl(p.image_hd || ''), imageOf(p)]
    .filter((u, i, a) => u && a.indexOf(u) === i).slice(0, 6);
  return `<article class="ssr-product" id="ssrProduct">
    ${crumbsHtml(crumbs)}
    <div class="ssr-product-main">
      <div class="ssr-product-media">
        <img src="${esc(gallery[0])}" alt="${esc(name)}" width="480" height="480" fetchpriority="high" decoding="async">
        ${gallery.length > 1 ? `<div class="ssr-thumbs">${gallery.slice(1).map((u, i) => `<img src="${esc(u)}" alt="${esc(name)} – ảnh ${i + 2}" width="72" height="72" loading="lazy" decoding="async">`).join('')}</div>` : ''}
      </div>
      <div class="ssr-product-info">
        <h1>${esc(name)}</h1>
        <p class="ssr-meta">${p.brand ? `Thương hiệu: <a href="${esc(brandPath(p.brand))}">${esc(p.brand)}</a>` : ''}${p.brand && p.sku ? ' · ' : ''}${p.sku ? `Mã: ${esc(p.sku)}` : ''}${category ? ` · Danh mục: <a href="${esc(categoryPath(category))}">${esc(cleanName(category.name))}</a>` : ''}</p>
        <p class="ssr-price"><strong>${lo === hi ? money(lo) : `${money(lo)} – ${money(hi)}`}</strong>${disc && !variants.length ? ` <del>${money(p.original_price)}</del> <span>-${Number(p.discount_percent)}%</span>` : ''}</p>
        <p class="ssr-stock${p.in_stock === false ? ' out' : ''}">${p.in_stock === false ? 'Tạm hết hàng' : 'Còn hàng – giao toàn quốc'}</p>
        ${variants.length ? `<h2>Phân loại</h2><ul class="ssr-variants">${variants.map(v => `<li>${esc(v.name)} – ${money(v.price)}${v.in_stock === false ? ' (hết hàng)' : ''}</li>`).join('')}</ul>` : ''}
        <ul class="ssr-benefits">
          ${p.warranty ? `<li>Bảo hành: ${esc(stripSupplierText(p.warranty))}</li>` : ''}
          <li>Kiểm tra hàng – trả tiền khi nhận (COD)</li>
          <li>Mua lẻ 1 món vẫn giá tốt; khách sỉ đăng nhập để xem giá sỉ</li>
        </ul>
      </div>
    </div>
    ${descHtml ? `<section class="ssr-desc"><h2>Mô tả sản phẩm</h2>${descHtml}</section>` : ''}
    ${qaHtml}
    ${related.length ? `<section class="ssr-related"><h2>Sản phẩm liên quan</h2><div class="ssr-grid">${cardsHtml(related)}</div></section>` : ''}
  </article>`;
}

/** Danh mục + thương hiệu ở chân trang: link nội bộ thật, ai cũng thấy. */
function footerLinksHtml(categories = [], brands = [], support = []) {
  if (!categories.length && !brands.length && !support.length) return '';
  return `<div class="container ssr-footer-links">
    ${categories.length ? `<nav aria-label="Danh mục sản phẩm"><h2>Danh mục</h2><ul>${categories.map(c => `<li><a href="${esc(categoryPath(c))}">${esc(cleanName(c.name))}</a></li>`).join('')}</ul></nav>` : ''}
    ${brands.length ? `<nav aria-label="Thương hiệu"><h2>Thương hiệu</h2><ul>${brands.map(b => `<li><a href="${esc(brandPath(b.name))}">${esc(b.name)}</a></li>`).join('')}</ul></nav>` : ''}
    ${support.length ? `<nav aria-label="Hỗ trợ khách hàng"><h2>Hỗ trợ khách hàng</h2><ul>${support.map(l => `<li><a href="${esc(l.url)}">${esc(l.name)}</a></li>`).join('')}</ul></nav>` : ''}
  </div>`;
}

// ───────────── JSON-LD ─────────────

const orgLd = base => ({
  '@type': 'Organization', '@id': `${base}/#organization`, name: 'BESI', url: `${base}/`,
  logo: `${base}/og-besi.png`, description: 'Sàn mua lẻ giá tốt, nhập sỉ từ nhiều tổng kho, giao hàng toàn quốc.'
});
const websiteLd = base => ({
  '@type': 'WebSite', '@id': `${base}/#website`, name: 'BESI', url: `${base}/`, inLanguage: 'vi-VN',
  publisher: { '@id': `${base}/#organization` },
  potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${base}/tim-kiem/{search_term_string}` }, 'query-input': 'required name=search_term_string' }
});
const breadcrumbLd = (base, crumbs) => ({
  '@type': 'BreadcrumbList',
  itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, ...(c.url ? { item: abs(base, c.url) } : {}) }))
});
const itemListLd = (base, products, offset = 0) => ({
  '@type': 'ItemList', numberOfItems: products.length,
  itemListElement: products.map((p, i) => ({ '@type': 'ListItem', position: offset + i + 1, url: abs(base, productPath(p)), name: cleanName(p.name) }))
});

function productLd(base, p, { description, category, reviews } = {}) {
  const url = abs(base, productPath(p));
  const variants = Array.isArray(p.variants) && p.variants.length > 1 ? p.variants : [];
  const inStock = p.in_stock !== false;
  const availability = `https://schema.org/${inStock ? 'InStock' : 'OutOfStock'}`;
  const images = [imageOf(p), ...((p.gallery || []).map(g => maskMediaUrl(g.url || g)))].filter((u, i, a) => u && a.indexOf(u) === i).slice(0, 6).map(u => abs(base, u));
  const validUntil = new Date(Date.now() + 30 * 86400e3).toISOString().slice(0, 10);
  let offers;
  if (variants.length) {
    const prices = variants.map(v => Number(v.price) || 0).filter(x => x > 0);
    offers = { '@type': 'AggregateOffer', url, priceCurrency: 'VND', lowPrice: Math.min(...prices), highPrice: Math.max(...prices), offerCount: variants.length, availability };
  } else {
    offers = {
      '@type': 'Offer', url, priceCurrency: 'VND', price: Number(p.price) || 0, priceValidUntil: validUntil,
      availability, itemCondition: 'https://schema.org/NewCondition', seller: { '@id': `${base}/#organization` },
      hasMerchantReturnPolicy: { '@id': `${base}/chinh-sach-doi-tra#policy` }
    };
  }
  return {
    '@type': 'Product', '@id': `${url}#product`, name: cleanName(p.name), url, image: images,
    ...(p.sku ? { sku: String(p.sku) } : {}),
    ...(description ? { description: description.slice(0, 500) } : {}),
    ...(p.brand ? { brand: { '@type': 'Brand', name: p.brand } } : {}),
    ...(category ? { category: cleanName(category.name) } : {}),
    ...(reviews && reviews.count > 0 ? {
      aggregateRating: { '@type': 'AggregateRating', ratingValue: reviews.average, reviewCount: reviews.count, bestRating: 5, worstRating: 1 },
      review: reviews.items.map(r => ({
        '@type': 'Review', author: { '@type': 'Person', name: r.name }, datePublished: String(r.created_at).slice(0, 10),
        reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5, worstRating: 1 }, ...(r.comment ? { reviewBody: r.comment } : {})
      }))
    } : {}),
    offers
  };
}

/** Một khối <script type="application/ld+json"> chứa @graph. */
function ldScript(nodes) {
  const graph = nodes.filter(Boolean);
  if (!graph.length) return '';
  return `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c')}</script>`;
}

module.exports = {
  esc, money, plainText, slug, productPath, categoryPath, brandPath, abs, imageOf,
  crumbsHtml, cardsHtml, pagerHtml, listingHeadHtml, productArticleHtml, footerLinksHtml,
  orgLd, websiteLd, breadcrumbLd, itemListLd, productLd, ldScript
};
