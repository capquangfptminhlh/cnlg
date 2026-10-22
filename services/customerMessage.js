/**
 * Tin nhắn nhân viên gửi khách (dán vào Zalo / SMS) theo trạng thái đơn.
 * Không nhắc tới DropBuy: khách chỉ thấy mã đơn HM của shop và mã vận đơn của hãng vận chuyển.
 */
const CARRIERS = {
  S: { name: 'SPX Express', url: 'https://spx.vn/' },
  V: { name: 'Viettel Post', url: 'https://viettelpost.com.vn/tra-cuu-hanh-trinh-don/' }
};

const money = n => `${Number(n || 0).toLocaleString('vi-VN')}đ`;
// Lý do nội bộ có thể nhắc nguồn hàng → bỏ khỏi tin nhắn
const safeReason = r => (r && !/drop\s*buy|admin|nội bộ/i.test(r) ? r : null);

function carrierOf(order) {
  const sync = order.dropbuy_sync || {};
  if (CARRIERS[sync.carrier]) return CARRIERS[sync.carrier];
  if (/^SPX/i.test(sync.shipping_ref_code || '')) return CARRIERS.S;
  return null;
}

/**
 * @param {object} order  đơn trong orders.json
 * @param {{ storeName?: string, trackUrl: string }} opts  trackUrl = link mở sẵn ô tra cứu đơn này
 * @returns {{ stage: string, text: string }}
 */
function buildCustomerMessage(order, { storeName = 'Hoàng Minh Store', trackUrl }) {
  const c = order.customer || {};
  const greet = `${storeName} xin chào anh/chị ${c.name || ''}`.trim() + '.';
  const items = (order.items || []).map(i => `- ${i.name}${i.variant_name ? ` (${i.variant_name})` : ''} x${i.quantity}`).join('\n');
  const pay = order.payment_method === 'COD'
    ? `Tổng thanh toán khi nhận hàng: ${money(order.total_amount)}`
    : `Tổng đơn: ${money(order.total_amount)} (đã thanh toán)`;
  const sync = order.dropbuy_sync || {};
  const waybill = sync.shipping_ref_code ? String(sync.shipping_ref_code).split(',')[0].trim() : null;
  const carrier = carrierOf(order);
  const track = `Tra cứu đơn: ${trackUrl} (nhập số điện thoại đặt hàng)`;

  let stage;
  let body;
  if (order.status === 'CANCELLED') {
    stage = 'cancelled';
    body = `Rất tiếc, đơn ${order.id} đã được huỷ${safeReason(order.cancel_reason) ? ` (${safeReason(order.cancel_reason)})` : ''}. Nếu anh/chị vẫn cần sản phẩm, shop sẵn sàng hỗ trợ đặt lại ạ.`;
  } else if (order.status === 'COMPLETED') {
    stage = 'completed';
    body = `Đơn ${order.id} đã giao thành công. Cảm ơn anh/chị đã mua hàng! Nếu có gì chưa hài lòng, anh/chị nhắn shop để được hỗ trợ ạ.`;
  } else if (order.status === 'PROCESSING' && waybill) {
    stage = 'shipping';
    body = [
      `Đơn ${order.id} đã được gửi đi${carrier ? ` qua ${carrier.name}` : ''}.`,
      `Mã vận đơn: ${waybill}`,
      carrier ? `Theo dõi trên ${carrier.name}: ${carrier.url}` : null,
      pay,
      track
    ].filter(Boolean).join('\n');
  } else if (order.status === 'PROCESSING') {
    stage = 'preparing';
    body = `Đơn ${order.id} đang được đóng gói, shop sẽ gửi mã vận đơn ngay khi giao cho đơn vị vận chuyển.\n${pay}\n${track}`;
  } else {
    stage = 'confirmed';
    body = `Shop đã nhận đơn ${order.id}:\n${items}\n${pay}\nShop sẽ báo mã vận đơn khi gửi hàng.\n${track}`;
  }
  return { stage, text: `${greet}\n${body}` };
}

/** Link mở Zalo tới số khách (zalo.me/<sđt>) */
function zaloLink(phone) {
  const p = String(phone || '').replace(/[^\d+]/g, '').replace(/^\+84/, '0');
  return /^0\d{9,10}$/.test(p) ? `https://zalo.me/${p}` : null;
}

module.exports = { buildCustomerMessage, zaloLink, CARRIERS };
