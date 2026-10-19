const scraper = require('./dropbuyScraper');
const detailScraper = require('./dropbuyDetailScraper');
const pricing = require('./pricing');

/**
 * Biến thể (màu/size...) của sản phẩm DropBuy.
 * Dữ liệu biến thể lấy từ trang chi tiết (cache 6h); giá CTV từng biến thể lấy qua get-price khi đã đăng nhập
 * (cache 2 phút trong bộ nhớ); khi khách đặt hàng thì tra trực tiếp theo SKU biến thể.
 */

const wholesaleCache = new Map(); // variation_id -> { cost, at }
const WHOLESALE_TTL_MS = 2 * 60 * 1000;

async function wholesaleFor(productId, variantIds, config) {
  const out = new Map();
  if (!config.dropbuy?.cookieHeader) return out;
  const need = [];
  for (const id of variantIds) {
    const c = wholesaleCache.get(id);
    if (c && Date.now() - c.at < WHOLESALE_TTL_MS) out.set(id, c.cost);
    else need.push(id);
  }
  if (need.length) {
    const map = await scraper.fetchWholesalePrices(need.map(id => ({ unique_id: id, product_id: productId })), config);
    for (const [id, v] of map) {
      wholesaleCache.set(id, { cost: v.cost, at: Date.now() });
      out.set(id, v.cost);
    }
  }
  return out;
}

function priceVariant(product, publicPrice, wholesale, ctx) {
  const r = pricing.computePrice({ id: product.id, category_id: product.category_id, public_price: publicPrice, wholesale }, ctx.rules, ctx.rootMap);
  return { price: r.price, original_price: r.original_price, cost: r.cost, is_wholesale: r.base_used === 'wholesale' };
}

/** Danh sách biến thể kèm giá bán, dùng cho trang chi tiết. */
async function variantsWithPrices(product, detail, config = scraper.getConfig()) {
  const list = detail?.variations || [];
  if (list.length === 0) return [];
  const ctx = scraper.getPricingContext(config);
  const wholesale = await wholesaleFor(product.id, list.map(v => v.id), config).catch(() => new Map());
  return list.map(v => {
    // Biến thể chính: dùng giá catalog (đã đồng bộ realtime); biến thể khác: tính từ giá niêm yết của biến thể
    const isMain = v.id === product.variation_id;
    const p = isMain && !wholesale.has(v.id)
      ? { price: product.price, original_price: product.original_price }
      : priceVariant(product, v.public_price || product.public_price, wholesale.get(v.id) ?? (isMain ? product.wholesale_price : null), ctx);
    const original = p.original_price && p.original_price > p.price ? p.original_price : null;
    return {
      id: v.id,
      sku: v.sku,
      name: v.name,
      is_default: v.is_default,
      in_stock: v.in_stock !== false && product.in_stock !== false,
      price: p.price,
      original_price: original,
      discount_percent: original ? Math.round((1 - p.price / original) * 100) : 0,
      weight_gram: v.weight_gram || 0,
      image: v.image || null
    };
  });
}

/**
 * Kiểm tra trực tiếp 1 dòng đơn (SP + biến thể) trên DropBuy.
 * @returns {{ ok:boolean, live:boolean, name, variant_name, sku, variation_id, price, cost, cost_is_wholesale, in_stock, weight_gram, message? }}
 */
async function checkLine(product, variationId, config = scraper.getConfig()) {
  const ctx = scraper.getPricingContext(config);
  let detail = null;
  try {
    detail = await detailScraper.fetchProductFullDetail(product, false);
  } catch (e) {}
  const variants = detail?.variations || [];

  let variant = null;
  if (variationId) {
    variant = variants.find(v => v.id === variationId);
    if (!variant) return { ok: false, message: `Phân loại đã chọn của "${product.name}" không còn tồn tại, vui lòng chọn lại.` };
  } else if (variants.length > 1) {
    return { ok: false, message: `Vui lòng chọn phân loại (màu/size...) cho "${product.name}".` };
  } else {
    variant = variants[0] || null;
  }

  const sku = variant?.sku || product.sku;
  const base = {
    name: product.name,
    variant_name: variants.length > 1 ? variant?.name : null,
    sku,
    variation_id: variant?.id || product.variation_id || null,
    weight_gram: variant?.weight_gram || 0
  };

  try {
    const item = await scraper.searchBySku(sku, config);
    if (!item) return { ...base, ok: false, live: true, in_stock: false, message: `"${product.name}${base.variant_name ? ` – ${base.variant_name}` : ''}" không còn bán trên DropBuy.` };
    const wh = await wholesaleFor(product.id, [item.unique_id], config).catch(() => new Map());
    const p = priceVariant(product, Number(item.price_public), wh.get(item.unique_id) ?? null, ctx);
    const inStock = item.in_stock !== false && (variant ? variant.in_stock !== false : true) && product.in_stock !== false;
    return { ...base, ok: inStock, live: true, in_stock: inStock, price: p.price, cost: p.cost, cost_is_wholesale: p.is_wholesale, message: inStock ? null : `"${product.name}${base.variant_name ? ` – ${base.variant_name}` : ''}" vừa hết hàng trên kho DropBuy.` };
  } catch (e) {
    // DropBuy không phản hồi: dùng dữ liệu đã đồng bộ gần nhất
    const p = variant && variant.id !== product.variation_id
      ? priceVariant(product, variant.public_price || product.public_price, null, ctx)
      : { price: product.price, cost: product.dropbuy_cost, is_wholesale: !!product.is_wholesale_price };
    const inStock = product.in_stock !== false && (variant ? variant.in_stock !== false : true);
    return { ...base, ok: inStock, live: false, in_stock: inStock, price: p.price, cost: p.cost, cost_is_wholesale: p.is_wholesale, message: inStock ? null : `"${product.name}" đã hết hàng.` };
  }
}

module.exports = { variantsWithPrices, checkLine };
