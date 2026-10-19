const scraper = require('./dropbuyScraper');

/**
 * Đưa các món của 1 đơn đã thanh toán vào GIỎ HÀNG trên tài khoản DropBuy của shop
 * (BFF `carts/set-quantity`). Chỉ thao tác giỏ – không tự đặt đơn, không trừ tiền.
 * Admin vào dropbuy.vn/gio-hang, chọn giao tới địa chỉ khách (dropship) và đặt hàng.
 *
 * Lưu ý: set-quantity đặt SỐ LƯỢNG TUYỆT ĐỐI cho từng phân loại trong giỏ DropBuy.
 * Nếu giỏ DropBuy đang có sẵn cùng phân loại, số lượng đó sẽ được cộng dồn trước khi gửi.
 */
const BFF = 'https://dropbuy.vn/api/proxy/bff';

function headers(config) {
  return {
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    origin: 'https://dropbuy.vn',
    referer: 'https://dropbuy.vn/gio-hang',
    cookie: config.dropbuy?.cookieHeader || ''
  };
}

async function call(path, method, body, config) {
  const res = await fetch(`${BFF}${path}`, { method, headers: headers(config), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`DropBuy trả về HTTP ${res.status} không phải JSON`);
  }
  if (!json.success) throw new Error(json.message || `DropBuy lỗi HTTP ${res.status}`);
  return json.data;
}

async function pushOrderToCart(order, config = scraper.getConfig()) {
  if (!config.dropbuy?.cookieHeader) throw new Error('Chưa đăng nhập DropBuy – đăng nhập ở mục DropBuy trong admin trước.');
  const lines = (order.items || []).filter(i => i.variation_id);
  if (!lines.length) throw new Error('Đơn không có mã phân loại DropBuy (variation_id) để đưa vào giỏ.');

  // Giỏ hiện tại → cộng dồn để không ghi đè số lượng đang có
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

module.exports = { pushOrderToCart };
