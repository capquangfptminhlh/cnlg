const scraper = require('./dropbuyScraper');
const { bff } = require('./dropbuySession');

/**
 * Thao tác GIỎ HÀNG DropBuy của shop (dùng chung cho: đưa đơn vào giỏ, báo phí ship thật, tự đặt đơn).
 *
 * Phí ship của DropBuy (`carts/get-shipping-fee`) tính theo các món ĐANG ĐƯỢC CHỌN trong giỏ của tài khoản,
 * không có API báo giá theo sản phẩm. Vì vậy báo giá = cho đúng các món vào giỏ, chỉ chọn chúng, hỏi phí từng kho,
 * rồi trả giỏ về như cũ. Giỏ dùng chung → mọi thao tác chạy tuần tự qua withCartLock.
 * set-quantity đặt SỐ LƯỢNG TUYỆT ĐỐI cho từng phân loại.
 */
const call = (path, method, body, config) => bff(path, { method, body, config });

let cartLock = Promise.resolve();
function withCartLock(fn) {
  const run = cartLock.then(fn, fn);
  cartLock = run.catch(() => {});
  return run;
}

async function snapshotCart(config) {
  const cart = await call('/carts/my-cart', 'POST', {}, config);
  return (cart?.cart_items || []).map(x => ({ variation_id: x.variation_id, quantity: Number(x.quantity) || 0, selected_for_checkout: !!x.selected_for_checkout }));
}

/**
 * Đặt đúng số lượng các món `lines` [{variation_id, quantity, name?}] và CHỈ chọn chúng.
 * Trả về các dòng giỏ tương ứng (có shop_depot_code, vị trí kho, giá F1, cờ đơn vị vận chuyển).
 */
async function selectOnly(lines, config) {
  const ours = new Set(lines.map(l => l.variation_id));
  await call('/carts/set-quantity', 'PUT', { items: lines.map(l => ({ variation_id: l.variation_id, quantity: l.quantity })) }, config);
  const cart1 = await call('/carts/my-cart', 'POST', {}, config);
  const sel = (cart1?.cart_items || []).map(x => ({ variation_id: x.variation_id, selected_for_checkout: ours.has(x.variation_id) }));
  await call('/carts/set-selected-items', 'PUT', { items: sel }, config);
  const cart = await call('/carts/my-cart', 'POST', {}, config);
  const picked = (cart?.cart_items || []).filter(x => ours.has(x.variation_id));
  for (const l of lines) {
    const x = picked.find(p => p.variation_id === l.variation_id);
    if (!x) throw new Error(`"${l.name || l.variation_id}" không vào được giỏ DropBuy (hết hàng / ngừng bán?).`);
    if (Number(x.quantity) !== l.quantity) throw new Error(`"${l.name || l.variation_id}": giỏ DropBuy có ${x.quantity}, cần ${l.quantity}.`);
  }
  return picked;
}

/** Trả giỏ về trạng thái trước (số lượng các món trùng + món nào đang được chọn). Không ném lỗi. */
async function restoreCart(before, lines, config) {
  try {
    const ours = new Set(lines.map(l => l.variation_id));
    const now0 = await call('/carts/my-cart', 'POST', {}, config);
    const had = new Map(before.map(c => [c.variation_id, c]));
    // Món chỉ thêm để báo giá/đặt → xoá; món vốn có → trả số lượng cũ
    const extra = (now0?.cart_items || []).filter(c => ours.has(c.variation_id) && !had.has(c.variation_id)).map(c => ({ variation_id: c.variation_id }));
    if (extra.length) await call('/carts/delete-items', 'PUT', { items: extra }, config).catch(() => {});
    const back = before.filter(c => ours.has(c.variation_id)).map(c => ({ variation_id: c.variation_id, quantity: c.quantity }));
    if (back.length) await call('/carts/set-quantity', 'PUT', { items: back }, config);
    const now = await call('/carts/my-cart', 'POST', {}, config);
    const items = (now?.cart_items || []).map(c => ({ variation_id: c.variation_id, selected_for_checkout: had.get(c.variation_id)?.selected_for_checkout || false }));
    if (items.length) await call('/carts/set-selected-items', 'PUT', { items }, config);
  } catch (e) {
    console.warn('[DropBuy] Không khôi phục được giỏ hàng cũ:', e.message);
  }
}

/** Gom các dòng giỏ đã chọn theo kho */
function groupByDepot(picked) {
  const map = new Map();
  for (const x of picked) {
    if (!map.has(x.shop_depot_code)) map.set(x.shop_depot_code, { code: x.shop_depot_code, lines: [] });
    map.get(x.shop_depot_code).lines.push({ ...x, selected_for_checkout: true });
  }
  return [...map.values()];
}

/** Phí ship 1 kho tới phường nhận: thử các đơn vị kho cho phép, lấy rẻ nhất (hoặc đúng đơn vị chỉ định). */
async function shippingFor(depot, receiver, cod, method, config) {
  const first = depot.lines[0];
  const allowV = depot.lines.every(l => l.allow_sm_v === 'T');
  const allowS = depot.lines.every(l => l.allow_sm_s === 'T');
  const candidates = method === 'V' ? ['V'] : method === 'S' ? ['S'] : ['V', 'S'];
  const options = [];
  for (const m of candidates) {
    if ((m === 'V' && !allowV) || (m === 'S' && !allowS)) continue;
    const r = await call('/carts/get-shipping-fee', 'POST', {
      cod_amount: cod,
      order_type: 'N',
      receiver_province_id: receiver.province_id,
      receiver_district_id: 0,
      receiver_ward_id: receiver.ward_id,
      sender_province_id: first.province_id,
      sender_district_id: first.district_id,
      sender_ward_id: first.ward_id,
      shipping_method: m,
      shop_depot_code: depot.code
    }, config);
    if (Number.isFinite(Number(r?.shipping_amount))) options.push({ method: m, fee: Number(r.shipping_amount), weight: Number(r.total_weight) || null });
  }
  if (!options.length) throw new Error(`Kho ${depot.code} không có đơn vị vận chuyển phù hợp (${method}).`);
  return options.sort((a, b) => a.fee - b.fee)[0];
}

/** Đưa các món của 1 đơn vào giỏ cho admin đặt tay (cộng dồn số lượng đang có). */
async function pushOrderToCart(order, config = scraper.getConfig()) {
  if (!config.dropbuy?.cookieHeader) throw new Error('Chưa đăng nhập DropBuy – đăng nhập ở mục DropBuy trong admin trước.');
  const lines = (order.items || []).filter(i => i.variation_id);
  if (!lines.length) throw new Error('Đơn không có mã phân loại DropBuy (variation_id) để đưa vào giỏ.');

  const current = await call('/carts/my-cart', 'POST', {}, config);
  const existing = new Map((current?.cart_items || []).map(c => [c.variation_id, Number(c.quantity) || 0]));

  const items = lines.map(i => ({ variation_id: i.variation_id, quantity: (existing.get(i.variation_id) || 0) + i.quantity }));
  const cart = await call('/carts/set-quantity', 'PUT', { items }, config);
  const inCart = new Map((cart?.cart_items || []).map(c => [c.variation_id, c]));
  return {
    pushed: lines.map(i => ({ sku: i.sku, name: i.name, variant_name: i.variant_name, quantity: i.quantity, in_cart: inCart.has(i.variation_id), dropbuy_price: inCart.get(i.variation_id)?.fe_price_override ?? null })),
    cart_url: 'https://dropbuy.vn/gio-hang'
  };
}

module.exports = { withCartLock, snapshotCart, selectOnly, restoreCart, groupByDepot, shippingFor, pushOrderToCart };
