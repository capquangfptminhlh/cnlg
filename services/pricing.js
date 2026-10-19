/**
 * Quy tắc giá bán của hoangminh.com (giống CTV: giá gốc DropBuy + % lãi).
 *
 * config.pricing = {
 *   markupPercent: 15,          // % lãi mặc định cộng trên giá gốc
 *   base: 'wholesale',          // 'wholesale' = giá CTV/F1 khi đã đăng nhập DropBuy; 'public' = giá niêm yết DropBuy
 *   minProfit: 0,               // lãi tối thiểu mỗi SP (đ)
 *   roundTo: 1000,              // làm tròn giá bán lên bội số này
 *   capAtPublic: false,         // không bán cao hơn giá niêm yết DropBuy (nếu vẫn còn lãi)
 *   categoryMarkups: { "1": 20 },              // % lãi riêng theo danh mục gốc (áp cả danh mục con)
 *   productOverrides: { "141073": { type: 'percent'|'fixed', value: 25 } }  // giá riêng từng SP
 * }
 */

const DEFAULTS = { markupPercent: 15, base: 'wholesale', minProfit: 0, roundTo: 1000, capAtPublic: false, categoryMarkups: {}, productOverrides: {} };

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** Chuẩn hoá + kiểm tra dữ liệu quy tắc giá (dùng khi đọc config và khi admin lưu). */
function normalizeRules(raw = {}) {
  const r = { ...DEFAULTS, ...raw };
  const out = {
    markupPercent: Math.min(300, Math.max(0, num(r.markupPercent, DEFAULTS.markupPercent))),
    base: r.base === 'public' ? 'public' : 'wholesale',
    minProfit: Math.max(0, num(r.minProfit, 0)),
    roundTo: [1, 100, 500, 1000, 5000, 10000].includes(num(r.roundTo, 1000)) ? num(r.roundTo, 1000) : 1000,
    capAtPublic: r.capAtPublic === true,
    categoryMarkups: {},
    productOverrides: {}
  };
  for (const [k, v] of Object.entries(r.categoryMarkups || {})) {
    const n = num(v, NaN);
    if (Number.isFinite(n) && n >= 0 && n <= 300) out.categoryMarkups[String(k)] = n;
  }
  for (const [k, v] of Object.entries(r.productOverrides || {})) {
    const value = num(v?.value, NaN);
    if (!Number.isFinite(value) || value < 0) continue;
    out.productOverrides[String(k)] = { type: v.type === 'fixed' ? 'fixed' : 'percent', value };
  }
  return out;
}

/** Map danh mục con → danh mục gốc để % theo danh mục gốc áp được cho cả danh mục con. */
function rootCategoryMap(categories = []) {
  const byId = new Map(categories.map(c => [c.id, c]));
  const root = new Map();
  for (const c of categories) {
    let cur = c;
    for (let i = 0; i < 10 && cur?.parent_id && byId.has(cur.parent_id); i++) cur = byId.get(cur.parent_id);
    root.set(c.id, cur?.id ?? c.id);
  }
  return root;
}

/**
 * Tính giá bán cho 1 SP.
 * @param {{id:number, category_id:number, wholesale:number|null, public_price:number}} p
 * @returns {{price:number, cost:number, base_used:'wholesale'|'public', markup_percent:number|null, rule:string, original_price:number|null}}
 */
function computePrice(p, rules, rootMap = new Map()) {
  const publicPrice = Number(p.public_price) || 0;
  const hasWholesale = Number(p.wholesale) > 0;
  const useWholesale = rules.base === 'wholesale' && hasWholesale;
  const cost = useWholesale ? Number(p.wholesale) : publicPrice;
  const round = v => Math.ceil(v / rules.roundTo) * rules.roundTo;

  let price;
  let rule;
  let markup = null;
  const ov = rules.productOverrides[String(p.id)];
  if (ov?.type === 'fixed') {
    price = Math.round(ov.value);
    rule = 'Giá cố định';
  } else {
    const rootId = rootMap.get(p.category_id) ?? p.category_id;
    markup = ov?.type === 'percent' ? ov.value
      : rules.categoryMarkups[String(p.category_id)] ?? rules.categoryMarkups[String(rootId)] ?? rules.markupPercent;
    rule = ov ? '% riêng SP' : (rules.categoryMarkups[String(p.category_id)] ?? rules.categoryMarkups[String(rootId)]) != null ? '% theo danh mục' : '% mặc định';
    price = round(cost * (1 + markup / 100));
    if (price - cost < rules.minProfit) {
      price = round(cost + rules.minProfit);
      rule += ' + lãi tối thiểu';
    }
    if (rules.capAtPublic && publicPrice > cost && price > publicPrice) {
      price = Math.max(round(cost + 1), Math.floor(publicPrice / rules.roundTo) * rules.roundTo);
      rule += ' (giới hạn giá niêm yết)';
    }
  }

  return {
    price,
    cost,
    base_used: useWholesale ? 'wholesale' : 'public',
    markup_percent: markup,
    rule,
    // Giá gạch ngang chỉ khi giá niêm yết DropBuy thật sự cao hơn giá bán
    original_price: publicPrice > price ? publicPrice : null
  };
}

module.exports = { DEFAULTS, normalizeRules, computePrice, rootCategoryMap };
