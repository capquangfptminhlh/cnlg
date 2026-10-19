const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const orderStore = require('./orderStore');

/**
 * Tự động xác nhận thanh toán từ webhook ngân hàng (SePay / Casso).
 * - Nội dung chuyển khoản phải chứa mã đơn (dạng HMxxxxxxxx, chính là nội dung trong mã VietQR).
 * - Đủ tiền → đơn chuyển PAID ngay. Thiếu tiền / đơn đã huỷ / không khớp đơn → ghi nhận & gắn cờ cho admin.
 * - Mỗi giao dịch chỉ xử lý 1 lần (lưu ở data/payments.json – không commit).
 */

const PAYMENTS_FILE = process.env.HM_PAYMENTS_FILE || path.join(__dirname, '..', 'data', 'payments.json');
const ORDER_CODE_RE = /HM[0-9A-F]{8}/i;

function readLog() {
  try {
    return JSON.parse(fs.readFileSync(PAYMENTS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeLog(list) {
  const tmp = `${PAYMENTS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list.slice(0, 1000), null, 2), 'utf8');
  fs.renameSync(tmp, PAYMENTS_FILE);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Chuẩn hoá payload SePay: { id, transferType:'in', transferAmount, content, referenceCode, gateway, transactionDate, accountNumber } */
function fromSepay(body) {
  if (!body || body.transferType !== 'in') return [];
  return [{ provider: 'sepay', tx_id: `sepay:${body.id}`, amount: Number(body.transferAmount) || 0, content: String(body.content || body.description || ''), bank: body.gateway || null, account: body.accountNumber || null, reference: body.referenceCode || null, at: body.transactionDate || new Date().toISOString() }];
}

/** Chuẩn hoá payload Casso: { error: 0, data: [{ id, tid, description, amount, when, bank_sub_acc_id }] } */
function fromCasso(body) {
  const list = Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [];
  return list.filter(t => Number(t.amount) > 0).map(t => ({ provider: 'casso', tx_id: `casso:${t.id ?? t.tid}`, amount: Number(t.amount), content: String(t.description || ''), bank: null, account: t.bank_sub_acc_id || t.subAccId || null, reference: t.tid || null, at: t.when || new Date().toISOString() }));
}

/**
 * Xử lý 1 giao dịch tiền vào.
 * @param {(orderId:string, meta:object)=>object} confirm - hàm xác nhận thanh toán (relay.confirmPayment)
 * @returns {{ result: string, order_id?: string }}
 */
function handleTransaction(tx, { confirm, onIssue, onConfirmed } = {}) {
  const log = readLog();
  if (log.some(l => l.tx_id === tx.tx_id)) return { result: 'DUPLICATE' };

  const entry = { ...tx, received_at: new Date().toISOString(), result: null, order_id: null, note: null };
  const code = (tx.content.match(ORDER_CODE_RE) || [])[0]?.toUpperCase() || null;
  const order = code ? orderStore.getOrderById(code) : null;
  entry.order_id = order?.id || code;

  if (!order) {
    entry.result = 'UNMATCHED';
    entry.note = code ? `Không có đơn ${code}` : 'Nội dung chuyển khoản không chứa mã đơn';
  } else if (['PAID', 'PROCESSING', 'COMPLETED'].includes(order.status)) {
    entry.result = 'ALREADY_PAID';
    entry.note = 'Đơn đã thanh toán trước đó – có thể khách chuyển 2 lần';
  } else if (order.status === 'CANCELLED') {
    entry.result = 'ORDER_CANCELLED';
    entry.note = 'Tiền về sau khi đơn đã huỷ – cần liên hệ khách để giao lại hoặc hoàn tiền';
    orderStore.updateOrder(order.id, { needs_attention: true, late_payment: { amount: tx.amount, tx_id: tx.tx_id, at: entry.received_at } });
  } else if (tx.amount < order.total_amount) {
    entry.result = 'UNDERPAID';
    entry.note = `Thiếu ${(order.total_amount - tx.amount).toLocaleString('vi-VN')} đ`;
    const paidSoFar = (order.bank_received || 0) + tx.amount;
    orderStore.updateOrder(order.id, { needs_attention: true, bank_received: paidSoFar });
    // Khách chuyển nhiều lần đủ tổng tiền → xác nhận
    if (paidSoFar >= order.total_amount && confirm) {
      confirm(order.id, { via: tx.provider, tx_id: tx.tx_id, amount: paidSoFar });
      entry.result = 'CONFIRMED_MULTI';
      entry.note = 'Đủ tiền sau nhiều lần chuyển';
    }
  } else {
    if (confirm) confirm(order.id, { via: tx.provider, tx_id: tx.tx_id, amount: tx.amount });
    entry.result = 'CONFIRMED';
    if (tx.amount > order.total_amount) entry.note = `Thừa ${(tx.amount - order.total_amount).toLocaleString('vi-VN')} đ`;
  }

  log.unshift(entry);
  writeLog(log);
  if (entry.result.startsWith('CONFIRMED')) onConfirmed?.(entry);
  else if (entry.result !== 'DUPLICATE') onIssue?.(entry);
  return { result: entry.result, order_id: entry.order_id };
}

function recentPayments(limit = 50) {
  return readLog().slice(0, limit);
}

module.exports = { fromSepay, fromCasso, handleTransaction, recentPayments, safeEqual, ORDER_CODE_RE };
