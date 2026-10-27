const scraper = require('./dropbuyScraper');
const detailScraper = require('./dropbuyDetailScraper');
const pricing = require('./pricing');

/**
 * Biến thể (màu/size...) của sản phẩm DropBuy.
 * Dữ liệu biến thể lấy từ trang chi tiết (cache 6h); giá CTV từng biến thể lấy qua get-price khi đã đăng nhập
 * (cache 2 phút khi lướt web; khi khách bấm Đặt hàng thì force=true quét trực tiếp 100% thời gian thực từ DropBuy).
 */

const wholesaleCache = new Map(); // variation_id -> { cost, public_price, fs_program_code, at }
const WHOLESALE_TTL_MS = 2 * 60 * 1000;

async function wholesaleFor(productId, variantIds, config, { force = false } = {}) {
  const out = new Map();
  if (!config.dropbuy?.cookieHeader) return out;
  const need = [];
  for (const id of variantIds) {
    if (!id) continue;
    const c = !force ? wholesaleCache.get(id) : null;
    if (c && Date.now() - c.at < WHOLESALE_TTL_MS) out.set(id, c.cost);
    else need.push(id);
  }
  if (need.length) {
    const map = await scraper.fetchWholesalePrices(need.map(id => ({ unique_id: id, product_id: productId })), config);
    for (const [id, v] of map) {
      wholesaleCache.set(id, { cost: v.cost, public_price: v.public_price || 0, fs_program_code: v.fs_program_code || null, at: Date.now() });
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
    const rawOriginal = p.original_price && p.original_price > p.price ? p.original_price : null;
    const rawDisc = rawOriginal ? Math.round((1 - p.price / rawOriginal) * 100) : 0;
    const original = rawDisc > 70 ? null : rawOriginal;
    return {
      id: v.id,
      sku: v.sku,
      name: v.name,
      is_default: v.is_default,
      in_stock: v.in_stock !== false && product.in_stock !== false,
      price: p.price,
      original_price: original,
      discount_percent: original ? rawDisc : 0,
      weight_gram: v.weight_gram || 0,
      warranty: v.warranty || null,
      image: v.image || null
    };
  });
}

/**
 * Kiểm tra trực tiếp 1 dòng đơn (SP + biến thể) trên DropBuy ngay lúc khách bấm Đặt hàng.
 * Luôn quét giá mới nhất (force: true, bỏ qua cache) để đảm bảo không bao giờ lệch giá hoặc bán lỗ.
 * @returns {{ ok:boolean, live:boolean, name, variant_name, sku, variation_id, price, cost, cost_is_wholesale, fs_program_code, in_stock, weight_gram, message? }}
 */
async function checkLine(product, variationId, config = scraper.getConfig()) {
  // Nếu sản phẩm được gộp từ nhiều sản phẩm DropBuy (nhóm biến thể hoặc các kho)
  if (Array.isArray(product.variants) && variationId) {
    const matchedV = product.variants.find(v => String(v.id) === String(variationId) || String(v.product_id) === String(variationId));
    if (matchedV && matchedV.product_id && matchedV.product_id !== product.id) {
      const subProd = scraper.getProducts().find(p => p.id === matchedV.product_id);
      if (subProd) {
        return checkLine(subProd, matchedV.id === String(matchedV.product_id) ? null : matchedV.id, config);
      }
    }
  }

  const ctx = scraper.getPricingContext(config);
  let detail = null;
  try {
    detail = await detailScraper.fetchProductFullDetail(product, false);
  } catch (e) {}
  const variants = detail?.variations || [];

  let variant = null;
  if (variationId) {
    variant = variants.find(v => v.id === variationId) || null;
    if (!variant && variants.length > 0) {
      return { ok: false, message: `Phân loại đã chọn của "${product.name}" không còn tồn tại, vui lòng chọn lại.` };
    }
    if (!variant && variationId !== product.variation_id) {
      return { ok: false, message: `Phân loại đã chọn của "${product.name}" không còn tồn tại, vui lòng chọn lại.` };
    }
  } else if (variants.length > 1) {
    return { ok: false, message: `Vui lòng chọn phân loại (màu/size...) cho "${product.name}".` };
  } else {
    variant = variants[0] || null;
  }

  const sku = variant?.sku || product.sku;
  const targetVid = variant?.id || variationId || product.variation_id || null;
  const base = {
    name: product.name,
    variant_name: variants.length > 1 ? variant?.name : null,
    sku,
    variation_id: targetVid,
    weight_gram: variant?.weight_gram || 0
  };

  try {
    // 1. Tra cứu trực tiếp theo SKU và lấy giá sỉ thời gian thực (force: true, không dùng cache)
    const item = await scraper.searchBySku(sku, config).catch(() => null);
    const liveVid = item?.unique_id || targetVid;
    const wh = liveVid ? await wholesaleFor(product.id, [liveVid], config, { force: true }).catch(() => new Map()) : new Map();
    const cachedMeta = liveVid ? wholesaleCache.get(liveVid) : null;
    const fsCode = cachedMeta?.fs_program_code || (liveVid === product.variation_id ? product.fs_program_code : null) || null;

    if (item) {
      const pubPrice = Number(item.price_public) || cachedMeta?.public_price || variant?.public_price || product.public_price;
      const p = priceVariant(product, pubPrice, wh.get(liveVid) ?? null, ctx);
      const inStock = item.in_stock !== false && (variant ? variant.in_stock !== false : true) && product.in_stock !== false;
      return {
        ...base,
        variation_id: liveVid,
        ok: inStock,
        live: true,
        in_stock: inStock,
        price: p.price,
        cost: p.cost,
        cost_is_wholesale: p.is_wholesale,
        fs_program_code: fsCode,
        message: inStock ? null : `"${product.name}${base.variant_name ? ` – ${base.variant_name}` : ''}" vừa tạm hết hàng.`
      };
    }

    // 2. Nếu searchBySku không khớp từ khoá nhưng có variation_id và lấy được giá + tồn kho trực tiếp từ API get-price & in-stock
    if (liveVid && wh.has(liveVid)) {
      const stockMap = await scraper.fetchStockMap([product.id], config).catch(() => new Map());
      const inStock = (stockMap.has(product.id) ? stockMap.get(product.id) : product.in_stock !== false) && (variant ? variant.in_stock !== false : true);
      const pubPrice = cachedMeta?.public_price || variant?.public_price || product.public_price;
      const p = priceVariant(product, pubPrice, wh.get(liveVid), ctx);
      return {
        ...base,
        variation_id: liveVid,
        ok: inStock,
        live: true,
        in_stock: inStock,
        price: p.price,
        cost: p.cost,
        cost_is_wholesale: p.is_wholesale,
        fs_program_code: fsCode,
        message: inStock ? null : `"${product.name}${base.variant_name ? ` – ${base.variant_name}` : ''}" vừa tạm hết hàng.`
      };
    }

    return { ...base, ok: false, live: true, in_stock: false, message: `"${product.name}${base.variant_name ? ` – ${base.variant_name}` : ''}" hiện tạm ngừng kinh doanh.` };
  } catch (e) {
    // DropBuy không phản hồi: dùng dữ liệu đã đồng bộ gần nhất
    const p = variant && variant.id !== product.variation_id
      ? priceVariant(product, variant.public_price || product.public_price, null, ctx)
      : { price: product.price, cost: product.dropbuy_cost, is_wholesale: !!product.is_wholesale_price };
    const inStock = product.in_stock !== false && (variant ? variant.in_stock !== false : true);
    return { ...base, ok: inStock, live: false, in_stock: inStock, price: p.price, cost: p.cost, cost_is_wholesale: p.is_wholesale, fs_program_code: product.fs_program_code || null, message: inStock ? null : `"${product.name}" đã hết hàng.` };
  }
}

module.exports = { variantsWithPrices, checkLine };
