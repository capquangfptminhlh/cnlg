const dropbuyCart = require('./dropbuyCart');
const dropbuySession = require('./dropbuySession');

/**
 * Phí ship THẬT của DropBuy cho đúng các món + phường nhận (cần đăng nhập DropBuy).
 * DropBuy chỉ báo phí theo giỏ hàng → cho món vào giỏ shop, chỉ chọn chúng, hỏi phí từng kho, trả giỏ về.
 * Kết quả nhớ 30 phút theo (món × số lượng, phường, đơn vị vận chuyển) để không đụng giỏ mỗi lần khách đổi ô.
 */
const TTL_MS = 30 * 60 * 1000;
const MAX_CACHE = 500;
const cache = new Map();

function keyOf(lines, wardId, method) {
  return `${wardId}|${method}|${lines.map(l => `${l.variation_id}x${l.quantity}`).sort().join(',')}`;
}

/**
 * @param {{ lines: {variation_id:string, quantity:number, name?:string}[], provinceId:number, wardId:number, codAmount?:number, method?:'cheapest'|'V'|'S', config:object }} p
 * @returns {Promise<{fee:number, weight_gram:number|null, depots:{code:string, method:string, fee:number}[], cached:boolean}>}
 */
async function liveQuote({ lines, provinceId, wardId, codAmount = 0, method = 'cheapest', config }) {
  if (!lines.length || lines.some(l => !l.variation_id)) throw new Error('Thiếu mã phân loại để báo phí ship.');
  const key = keyOf(lines, wardId, method);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.result, cached: true };

  const session = await dropbuySession.ensureSession(config);
  if (!session) throw Object.assign(new Error('Chưa đăng nhập DropBuy – chưa lấy được phí ship thật.'), { code: 401 });

  const result = await dropbuyCart.withCartLock(async () => {
    const before = await dropbuyCart.snapshotCart(config);
    try {
      const picked = await dropbuyCart.selectOnly(lines, config);
      const depots = dropbuyCart.groupByDepot(picked);
      const receiver = { province_id: Number(provinceId), ward_id: Number(wardId) };
      const out = [];
      let weight = 0;
      for (const d of depots) {
        const ship = await dropbuyCart.shippingFor(d, receiver, codAmount, method, config);
        out.push({ code: d.code, method: ship.method, fee: ship.fee });
        weight += ship.weight || 0;
      }
      return { fee: out.reduce((s, d) => s + d.fee, 0), weight_gram: weight || null, depots: out };
    } finally {
      await dropbuyCart.restoreCart(before, lines, config);
    }
  });

  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), result });
  return { ...result, cached: false };
}

function clearCache() {
  cache.clear();
}

module.exports = { liveQuote, clearCache };
