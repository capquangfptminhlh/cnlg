const fs = require('fs');
const path = require('path');
const orderStore = require('./orderStore');
const customerMessage = require('./customerMessage');
const { getAdminPassword, safeEqual } = require('./security');

/**
 * Thông báo qua Zalo Bot (bot-api.zaloplatforms.com) và/hoặc Telegram:
 * 1. Báo đơn mới / thanh toán cho CHỦ SHOP (các chat_id lưu trong data/zalo-bot.json hoặc ZALO_CHAT_ID).
 * 2. Tự động trả lời tra cứu đơn hàng cho KHÁCH HÀNG khi khách nhắn Mã đơn (HM...) hoặc SĐT vào Zalo Bot,
 *    đồng thời lưu chat_id của khách vào đơn để tự động bắn thông báo khi có mã vận đơn / giao thành công / huỷ đơn.
 */

const ZALO_STATE_FILE = path.join(__dirname, '..', 'data', 'zalo-bot.json');

function readZaloChatIds() {
  const ids = new Set();
  if (process.env.ZALO_CHAT_ID) {
    for (const id of String(process.env.ZALO_CHAT_ID).split(',').map(s => s.trim()).filter(Boolean)) ids.add(id);
  }
  try {
    if (fs.existsSync(ZALO_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(ZALO_STATE_FILE, 'utf8'));
      for (const id of data.chatIds || []) if (id) ids.add(String(id));
    }
  } catch (e) {}
  return [...ids];
}

function saveZaloChatId(chatId, meta = {}) {
  if (!chatId) return false;
  const idStr = String(chatId).trim();
  if (!idStr) return false;
  let data = { chatIds: [], chats: {} };
  try {
    if (fs.existsSync(ZALO_STATE_FILE)) {
      data = JSON.parse(fs.readFileSync(ZALO_STATE_FILE, 'utf8')) || data;
    }
  } catch (e) {}
  const list = new Set((data.chatIds || []).map(String));
  const isNew = !list.has(idStr);
  list.add(idStr);
  data.chatIds = [...list];
  data.chats = data.chats || {};
  data.chats[idStr] = { ...(data.chats[idStr] || {}), ...meta, updated_at: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(ZALO_STATE_FILE), { recursive: true });
    fs.writeFileSync(ZALO_STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {}
  return isNew;
}

function htmlToPlainText(html) {
  return String(html || '')
    .replace(/<\/?b>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function sendZaloToChat(chatId, text) {
  const token = process.env.ZALO_BOT_TOKEN;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://bot-api.zaloplatforms.com/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), text: htmlToPlainText(text) })
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || (json && json.ok === false)) {
      console.warn('[Notify] Zalo Bot HTTP', res.status, json?.description || '');
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[Notify] Không gửi được Zalo Bot:', e.message);
    return false;
  }
}

async function sendZalo(text) {
  const token = process.env.ZALO_BOT_TOKEN;
  if (!token) return false;
  const chatIds = readZaloChatIds();
  if (!chatIds.length) {
    console.warn('[Notify] Chưa có chat_id Zalo Bot của chủ shop.');
    return false;
  }
  const results = await Promise.all(chatIds.map(id => sendZaloToChat(id, text)));
  return results.some(Boolean);
}

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

async function sendAll(htmlText) {
  const [tg, zl] = await Promise.all([
    sendTelegram(htmlText),
    sendZalo(htmlText)
  ]);
  return tg || zl;
}

function siteBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || 'https://besi.com.vn').replace(/\/+$/, '');
}

const normPhone = v => String(v || '').replace(/\D/g, '').replace(/^84/, '0');

function buildOrderMessageForCustomer(order) {
  const base = siteBaseUrl();
  const trackUrl = `${base}/?tra-cuu=${encodeURIComponent(order.id)}`;
  const msg = customerMessage.buildCustomerMessage(order, { storeName: 'Hoàng Minh Store', trackUrl });
  const waybill = order.dropbuy_sync?.shipping_ref_code ? String(order.dropbuy_sync.shipping_ref_code).split(',')[0].trim() : '';
  return { ...msg, stageKey: `${msg.stage}:${waybill}` };
}

/**
 * Tự động gửi tin nhắn cập nhật trạng thái đơn hàng / mã vận đơn cho khách qua Zalo Bot
 * (nếu khách đã từng nhắn mã đơn hoặc SĐT vào Zalo Bot để đăng ký nhận thông báo).
 */
async function notifyCustomerOrder(orderOrId) {
  try {
    const id = typeof orderOrId === 'string' ? orderOrId : orderOrId?.id;
    if (!id) return false;
    const order = orderStore.getOrderById(id);
    if (!order || !order.customer_zalo_chat_id) return false;
    const { text, stageKey } = buildOrderMessageForCustomer(order);
    if (order.customer_zalo_stage === stageKey) return false;
    const ok = await sendZaloToChat(order.customer_zalo_chat_id, `📦 Cập nhật đơn hàng #${order.id}:\n${text}`);
    if (ok) {
      orderStore.updateOrder(order.id, { customer_zalo_stage: stageKey, customer_zalo_notified_at: new Date().toISOString() });
    }
    return ok;
  } catch (e) {
    console.warn('[ZaloBot] Lỗi gửi cập nhật đơn cho khách:', e.message);
    return false;
  }
}

async function handleIncomingZaloMessage(m) {
  const rawText = String(m.text || '').trim();
  const adminIds = new Set(readZaloChatIds());

  // 1. Lệnh đăng ký thêm quản trị viên nhận thông báo chủ shop: "/admin <mật_khẩu_admin>"
  const adminMatch = rawText.match(/^\/?admin\s+(\S+)$/i);
  if (adminMatch && safeEqual(adminMatch[1], getAdminPassword())) {
    saveZaloChatId(m.chatId, { name: m.fromName, type: m.chatType, role: 'admin' });
    await sendZaloToChat(m.chatId, `✅ Đã đăng ký nhận thông báo Quản trị viên Hoàng Minh Store (Chat ID: ${m.chatId}).`);
    return;
  }

  // Đã bỏ cơ chế tự động gán tin nhắn đầu tiên làm admin để tránh lộ thông tin kho cho người lạ

  // 2. Khách (hoặc chủ shop) nhắn Mã đơn hàng (vd: "HM4715B58E" hoặc "Đơn HM4715B58E")
  const codeMatch = rawText.match(/\b(HM[A-Z0-9]{6,10})\b/i);
  if (codeMatch) {
    const code = codeMatch[1].toUpperCase();
    const order = orderStore.getOrderById(code);
    if (!order) {
      await sendZaloToChat(
        m.chatId,
        `❌ Không tìm thấy đơn hàng mã #${code}.\nAnh/chị vui lòng kiểm tra lại mã đơn (bắt đầu bằng chữ HM, ví dụ: HM4715B58E) hoặc gửi Số điện thoại đặt hàng nhé ạ!`
      );
      return;
    }
    const { text, stageKey } = buildOrderMessageForCustomer(order);
    orderStore.updateOrder(order.id, {
      customer_zalo_chat_id: m.chatId,
      customer_zalo_name: m.fromName || null,
      customer_zalo_stage: stageKey
    });
    await sendZaloToChat(
      m.chatId,
      `${text}\n\n🔔 Đã bật thông báo tự động trên Zalo: Ngay khi đơn #${order.id} có mã vận đơn hoặc cập nhật giao hàng, hệ thống sẽ tự nhắn báo cho anh/chị tại đây!`
    );
    return;
  }

  // 3. Khách nhắn Số điện thoại đặt hàng (vd: "0901234567")
  const phoneCandidate = normPhone(rawText);
  if (/^0\d{9,10}$/.test(phoneCandidate)) {
    const matched = orderStore.getOrders()
      .filter(o => !o.is_test && normPhone(o.customer?.phone) === phoneCandidate)
      .slice(0, 3);
    if (!matched.length) {
      await sendZaloToChat(
        m.chatId,
        `❌ Chưa tìm thấy đơn hàng nào với số điện thoại ${phoneCandidate}.\nAnh/chị vui lòng gửi Mã đơn hàng (ví dụ: HM4715B58E) hoặc kiểm tra lại số điện thoại lúc đặt hàng nhé ạ!`
      );
      return;
    }
    for (const order of matched) {
      const { text, stageKey } = buildOrderMessageForCustomer(order);
      orderStore.updateOrder(order.id, {
        customer_zalo_chat_id: m.chatId,
        customer_zalo_name: m.fromName || null,
        customer_zalo_stage: stageKey
      });
      await sendZaloToChat(
        m.chatId,
        `${text}\n\n🔔 Đã bật thông báo tự động trên Zalo cho đơn #${order.id}!`
      );
    }
    return;
  }

  // 4. Tin nhắn chào hỏi / khác
  if (adminIds.has(m.chatId) && /^\/?(status|test|ping|ok|hi|alo)$/i.test(rawText)) {
    await sendZaloToChat(
      m.chatId,
      `🟢 Bot thông báo Hoàng Minh Store (besi.com.vn) đang hoạt động.\n• Gửi Mã đơn (HM...) hoặc SĐT khách để tra cứu nhanh.\n• Khách hàng nhắn Mã đơn hoặc SĐT vào Bot cũng sẽ được tự động trả lời và nhận mã vận đơn khi hàng đi.`
    );
    return;
  }

  await sendZaloToChat(
    m.chatId,
    `👋 Hoàng Minh Store (${siteBaseUrl()}) xin chào anh/chị!\nĐể kiểm tra đơn hàng và đăng ký nhận mã vận đơn tự động qua Zalo, anh/chị vui lòng nhắn:\n• Mã đơn hàng (ví dụ: HM4715B58E)\n• Hoặc Số điện thoại đặt hàng của anh/chị vào đây nhé ạ!`
  );
}

function extractZaloMessages(payload) {
  const out = [];
  if (!payload || !payload.result) return out;
  const items = Array.isArray(payload.result) ? payload.result : [payload.result];
  for (const item of items) {
    const msg = item?.message || item;
    const chatId = msg?.chat?.id || item?.chat?.id || msg?.from?.id;
    if (chatId) {
      out.push({
        chatId: String(chatId),
        text: String(msg?.text || ''),
        fromName: msg?.from?.display_name || msg?.from?.name || msg?.chat?.title || '',
        chatType: msg?.chat?.chat_type || ''
      });
    }
  }
  return out;
}

let pollingActive = false;
function startZaloBotPolling() {
  const token = process.env.ZALO_BOT_TOKEN;
  if (!token || pollingActive) return;
  pollingActive = true;
  console.log(`[ZaloBot] Đang lắng nghe tin nhắn Zalo Bot (đã lưu ${readZaloChatIds().length} cuộc trò chuyện quản trị).`);

  (async () => {
    while (pollingActive) {
      try {
        const res = await fetch(`https://bot-api.zaloplatforms.com/bot${token}/getUpdates`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ timeout: 25 }),
          signal: AbortSignal.timeout(35000)
        });
        const data = await res.json().catch(() => null);
        if (data && data.ok && data.result) {
          const msgs = extractZaloMessages(data);
          for (const m of msgs) {
            console.log(`[ZaloBot] Nhận tin nhắn từ ${m.fromName || m.chatId} (${m.chatId}): "${m.text}"`);
            await handleIncomingZaloMessage(m);
          }
        } else if (data && data.error_code && data.error_code !== 408) {
          await new Promise(r => setTimeout(r, 5000));
        }
      } catch (e) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  })();
}

const money = n => `${Number(n || 0).toLocaleString('vi-VN')} đ`;
const escHtml = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function orderSummary(o) {
  const base = siteBaseUrl();
  const items = (o.items || []).map(i => {
    const prodUrl = i.id ? `\n  🔗 Web: ${base}/sp/${i.id}` : '';
    const sourceUrl = i.dropbuy_url ? `\n  📦 Kho: ${i.dropbuy_url}` : '';
    const priceStr = i.price ? ` (${money(i.price)})` : '';
    return `• ${escHtml(i.name)}${i.variant_name ? ` [${escHtml(i.variant_name)}]` : ''} × ${i.quantity}${priceStr}${prodUrl}${sourceUrl}`;
  }).join('\n');
  const payLabel = o.payment_method === 'COD' ? '💵 COD (Thu hộ khi giao)' : '🏦 Chuyển khoản ngân hàng';
  const shipText = o.shipping_fee != null ? ` (Gồm ship: ${money(o.shipping_fee)})` : '';
  const cleanPhone = String(o.customer?.phone || '').replace(/[^\d+]/g, '').replace(/^\+84/, '0');
  const zaloCustomer = /^0\d{9,10}$/.test(cleanPhone) ? `\n💬 Zalo khách: https://zalo.me/${cleanPhone}` : '';
  const adminUrl = `\n⚙️ Quản trị đơn: ${base}/admin.html`;
  return `<b>#${o.id}</b> – ${money(o.total_amount)}${shipText}\n${payLabel}\n👤 ${escHtml(o.customer?.name)} · 📞 ${escHtml(o.customer?.phone)}\n📍 ${escHtml(o.customer?.address)}${o.customer?.ward_name ? `, ${escHtml(o.customer.ward_name)}` : ''}${o.customer?.province ? `, ${escHtml(o.customer.province)}` : ''}\n${items}${zaloCustomer}${adminUrl}`;
}

const notify = {
  newOrder: async o => {
    const res = await sendAll(`🛒 <b>Đơn hàng mới</b>\n${orderSummary(o)}`);
    try {
      const ph = normPhone(o?.customer?.phone);
      if (ph && o?.id) {
        const prev = orderStore.getOrders().find(x => x.id !== o.id && x.customer_zalo_chat_id && normPhone(x.customer?.phone) === ph);
        if (prev?.customer_zalo_chat_id) {
          orderStore.updateOrder(o.id, { customer_zalo_chat_id: prev.customer_zalo_chat_id });
          await notifyCustomerOrder(o.id);
        }
      }
    } catch (e) {}
    return res;
  },
  paymentReported: o => sendAll(`💬 <b>Khách báo đã chuyển khoản</b> – cần đối soát\n${orderSummary(o)}`),
  paymentConfirmed: (o, via) => sendAll(`✅ <b>Đã nhận tiền</b> (${escHtml(via)}) – đặt hàng bên DropBuy\n${orderSummary(o)}`),
  paymentIssue: (text) => sendAll(`⚠️ <b>Giao dịch cần kiểm tra</b>\n${escHtml(text)}`),
  alert: (text) => sendAll(`🔔 <b>Cần xử lý</b>\n${escHtml(text)}`),
  info: (text) => sendAll(`ℹ️ ${escHtml(text)}`),
  notifyCustomerOrder,
  handleIncomingZaloMessage,
  startZaloBotPolling,
  readZaloChatIds
};

module.exports = { sendTelegram, sendZalo, notify };
