const scraper = require('./dropbuyScraper');

/**
 * Đưa các món của 1 đơn đã thanh toán vào GIỎ HÀNG trên tài khoản DropBuy của shop
 * (BFF `carts/set-quantity`). Chỉ thao tác giỏ – không tự đặt đơn, không trừ tiền.
 * Admin vào dropbuy.vn/gio-hang, chọn giao tới địa chỉ khách (dropship) và đặt hàng.
 *
 * Lưu ý: set-quantity đặt SỐ LƯỢNG TUYỆT ĐỐI cho từng phân loại trong giỏ DropBuy.
 * Nếu giỏ DropBuy đang có sẵn cùng phân loại, số lượng đó sẽ được cộng dồn trước khi gửi.
 */
const { bff } = require('./dropbuySession');

const call = (path, method, body, config) => bff(path, { method, body, config });

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
