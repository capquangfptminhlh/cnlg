'use strict';
/**
 * Giá theo khách:
 *  - Khách sỉ đã duyệt (đăng nhập) → giá sỉ = giá bán đang có trong catalog (p.price).
 *  - Còn lại (chưa đăng nhập, chờ duyệt, bot/Google) → giá lẻ = giá sỉ + markupPercent, làm tròn LÊN,
 *    không vượt giá niêm yết (original_price) nếu bật capAtListed, và không bao giờ thấp hơn giá sỉ.
 *
 * Catalog, cache chi tiết… luôn giữ giá sỉ; giá lẻ chỉ đổi ở cổng ra (API, socket, SEO, giỏ, đặt hàng).
 * Mặc định an toàn là GIÁ LẺ: chỗ nào không xác định được khách thì không lộ giá sỉ.
 *
 * config.customerPricing = { enabled: true, markupPercent: 20, capAtListed: true, roundTo: 1000 }
 */
const customers = require('./customers');

const DEFAULTS = { enabled: true, markupPercent: 20, capAtListed: true, roundTo: 1000 };

function normalizeRules(raw = {}) {
  const r = { ...DEFAULTS, ...(raw || {}) };
  const num = (v, d, min, max) => { const x = Number(v); return Number.isFinite(x) && x >= min && x <= max ? x : d; };
  return {
    enabled: r.enabled !== false,
    markupPercent: num(r.markupPercent, DEFAULTS.markupPercent, 0, 200),
    capAtListed: r.capAtListed !== false,
    roundTo: num(r.roundTo, DEFAULTS.roundTo, 1, 100000)
  };
}

/** Giá lẻ từ giá sỉ `price` và giá niêm yết `listed` (có thể null). */
function retailPrice(price, listed, rules) {
  const p = Number(price);
  if (!rules.enabled || !(p > 0)) return price;
  // làm tròn tới đồng trước khi làm tròn lên (100.000 × 1,1 = 110.000,0000001 trong số thực)
  const raw = Math.round((p * (100 + rules.markupPercent)) / 100);
  let r = Math.ceil(raw / rules.roundTo) * rules.roundTo;
  const l = Number(listed);
  // giá niêm yết ảo (rẻ hơn >70%) web không hiện → cũng không dùng làm trần, cho khớp giá khách thấy
  if (rules.capAtListed && l > p && 1 - p / l <= 0.7) r = Math.min(r, l);
  return Math.max(r, p);
}

/** Đổi 1 object có `price` (SP, phân loại, dòng giỏ) sang giá lẻ; giữ giá niêm yết để gạch ngang. */
function retailizeItem(o, rules) {
  const price = retailPrice(o.price, o.original_price, rules);
  if (price === o.price) return o;
  const out = { ...o, price };
  if ('original_price' in o || 'discount_percent' in o) {
    const orig = Number(o.original_price);
    const d = orig > price ? Math.round((1 - price / orig) * 100) : 0;
    out.original_price = d > 0 && d <= 70 ? orig : null;
    out.discount_percent = d > 0 && d <= 70 ? d : 0;
  }
  return out;
}

/** Đi hết payload JSON, đổi mọi object có `price` dạng số (SP, phân loại, SP trong flash sale…). */
function retailizeDeep(value, rules, depth = 0) {
  if (depth > 8 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => retailizeDeep(v, rules, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = retailizeDeep(v, rules, depth + 1);
  return typeof out.price === 'number' ? retailizeItem(out, rules) : out;
}

/** 'wholesale' | 'retail' cho request / handshake socket. */
function tierOfCookie(cookieHeader) {
  return customers.isWholesale(customers.fromCookieHeader(cookieHeader)) ? 'wholesale' : 'retail';
}
const tierOf = req => tierOfCookie(req?.headers?.cookie);

/** Hàm lấy giá theo khách cho lọc/sắp xếp (giá sỉ thì giữ nguyên). */
function effectivePrice(tier, rules) {
  if (tier === 'wholesale' || !rules.enabled) return p => p.price;
  return p => retailPrice(p.price, p.original_price, rules);
}

/**
 * Middleware cho các API trả SẢN PHẨM: đổi giá ở res.json theo khách.
 * Khách sỉ: không cho cache chung (Cloudflare / proxy) để giá sỉ không lọt sang người khác.
 */
function priceResponses(getRules) {
  return (req, res, next) => {
    const tier = tierOf(req);
    req.priceTier = tier;
    res.vary('Cookie');
    const json = res.json.bind(res);
    res.json = body => {
      if (tier === 'wholesale') {
        res.set('Cache-Control', 'private, no-store');
        return json(body);
      }
      const rules = normalizeRules(getRules());
      return json(rules.enabled ? retailizeDeep(body, rules) : body);
    };
    next();
  };
}

/**
 * Socket.IO: mỗi kết nối vào phòng giá sỉ / giá lẻ theo cookie; `PRODUCTS_UPDATED` gửi đúng giá cho từng phòng.
 * Trả về object giống `io` để đưa cho các vòng đồng bộ (chúng chỉ cần emit / to / sockets).
 */
function tieredIo(io, getRules, { maskItem = x => x } = {}) {
  io.on('connection', socket => {
    socket.join(tierOfCookie(socket.handshake?.headers?.cookie) === 'wholesale' ? 'tier:wholesale' : 'tier:retail');
  });
  return {
    sockets: io.sockets,
    to: room => io.to(room),
    in: room => io.in(room),
    emit(event, payload) {
      if (event !== 'PRODUCTS_UPDATED' || !payload || !Array.isArray(payload.items)) return io.emit(event, payload);
      const items = payload.items.map(maskItem);
      io.to('tier:wholesale').emit(event, { ...payload, items });
      const rules = normalizeRules(getRules());
      io.to('tier:retail').emit(event, { ...payload, items: rules.enabled ? items.map(i => retailizeItem(i, rules)) : items });
      return true;
    }
  };
}

module.exports = { DEFAULTS, normalizeRules, retailPrice, retailizeItem, retailizeDeep, tierOf, tierOfCookie, effectivePrice, priceResponses, tieredIo };
