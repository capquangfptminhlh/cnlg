/**
 * Thông báo cho chủ shop qua Telegram (tuỳ chọn).
 * Bật bằng TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID trong .env. Không cấu hình → bỏ qua, không lỗi.
 */
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    if (!res.ok) console.warn('[Notify] Telegram HTTP', res.status, (await res.text()).slice(0, 120));
    return res.ok;
  } catch (e) {
    console.warn('[Notify] Không gửi được Telegram:', e.message);
    return false;
  }
}

const money = n => `${Number(n || 0).toLocaleString('vi-VN')} đ`;
const escHtml = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function orderSummary(o) {
  const items = (o.items || []).map(i => `• ${escHtml(i.name)}${i.variant_name ? ` [${escHtml(i.variant_name)}]` : ''} × ${i.quantity}`).join('\n');
  return `<b>#${o.id}</b> – ${money(o.total_amount)}\n${escHtml(o.customer?.name)} · ${escHtml(o.customer?.phone)}\n${escHtml(o.customer?.address)}${o.customer?.province ? `, ${escHtml(o.customer.province)}` : ''}\n${items}`;
}

const notify = {
  newOrder: o => sendTelegram(`🛒 <b>Đơn mới</b>\n${orderSummary(o)}`),
  paymentReported: o => sendTelegram(`💬 <b>Khách báo đã chuyển khoản</b> – cần đối soát\n${orderSummary(o)}`),
  paymentConfirmed: (o, via) => sendTelegram(`✅ <b>Đã nhận tiền</b> (${escHtml(via)}) – đặt hàng bên DropBuy\n${orderSummary(o)}`),
  paymentIssue: (text) => sendTelegram(`⚠️ <b>Giao dịch cần kiểm tra</b>\n${escHtml(text)}`),
  alert: (text) => sendTelegram(`🔔 <b>Cần xử lý</b>\n${escHtml(text)}`),
  info: (text) => sendTelegram(`ℹ️ ${escHtml(text)}`)
};

module.exports = { sendTelegram, notify };
