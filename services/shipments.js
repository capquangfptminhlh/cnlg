'use strict';
/**
 * Chia giỏ hàng thành các KIỆN giao riêng – mỗi kiện một phí ship:
 *  - Nguồn sỉ một nhà cung cấp (TechMall…): mọi món của nguồn gộp 1 kiện (đặt chung 1 đơn bên đó).
 *  - DropBuy: hàng đến từ nhiều nhà phân phối / kho → mỗi kho 1 kiện (DropBuy cũng tách 1 đơn mỗi kho),
 *    nên phí ship và mức miễn ship phải xét theo TỪNG kiện, không gộp cả đơn (gộp thì lỗ ship).
 */

const sum = lines => lines.reduce((t, l) => t + Number(l.price || 0) * Number(l.quantity || 0), 0);
/** Mã nhận diện 1 dòng hàng trong kiện (SP + phân loại). */
const refOf = l => `${l.id}:${l.variation_id ?? ''}`;

/**
 * @param lines   [{ id, variation_id, price, quantity, ... }]
 * @param sourceOf  id → nguồn sỉ (có .def.key / .def.label) hoặc null nếu là DropBuy
 * @param depotOf   id → mã kho DropBuy của SP (null nếu chưa biết)
 * @returns [{ key, kind: 'source'|'dropbuy', source, depot, lines, subtotal }]
 */
function groupShipments(lines, { sourceOf, depotOf }) {
  const groups = new Map();
  for (const l of lines || []) {
    const src = sourceOf(l.id);
    const depot = src ? null : depotOf(l.id) || 'kho-chua-ro';
    const key = src ? `src:${src.def.key}` : `db:${depot}`;
    if (!groups.has(key)) groups.set(key, { key, kind: src ? 'source' : 'dropbuy', source: src || null, depot, lines: [] });
    groups.get(key).lines.push(l);
  }
  return [...groups.values()].map(g => ({ ...g, subtotal: sum(g.lines) }));
}

/** Gộp phí các kiện thành 1 kết quả cho giỏ / đơn hàng (khách không thấy tên nguồn hay mã kho). */
function combineQuotes(parts) {
  const shipments = parts.map((q, i) => ({
    no: i + 1, key: q.key, fee: q.fee, free_ship: !!q.free_ship, detail: q.detail,
    items: q.items || 0, subtotal: q.subtotal || 0, live: !!q.live_fee, refs: q.refs || []
  }));
  if (parts.length === 1) return { ...parts[0], shipments };
  const fee = parts.reduce((t, q) => t + q.fee, 0);
  const allLive = parts.every(q => q.source === 'dropbuy');
  return {
    fee,
    free_ship: fee === 0,
    source: allLive ? 'dropbuy' : 'mixed',
    region: parts.find(q => q.region)?.region,
    weight_gram: parts.reduce((t, q) => t + (q.weight_gram || 0), 0),
    shipments,
    detail: `Giao thành ${parts.length} kiện: ` + parts.map((q, i) => `kiện ${i + 1} ${q.fee ? q.fee.toLocaleString('vi-VN') + ' đ' : 'miễn phí'}`).join(' + ')
  };
}

module.exports = { groupShipments, combineQuotes, sum, refOf };
