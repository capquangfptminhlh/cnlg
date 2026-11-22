'use strict';
/**
 * Đánh giá THẬT từ khách đã nhận hàng:
 *  - chỉ đơn đã giao thành công (COMPLETED), người gửi phải có vé của đơn (người đặt / tra đúng mã + SĐT /
 *    khách sỉ chủ đơn);
 *  - mỗi SP trong đơn đánh giá 1 lần; chờ cửa hàng duyệt mới hiện trên web;
 *  - tên hiển thị che bớt ("Anh T***"), không lộ SĐT / địa chỉ.
 * data/reviews.json: [{ id, order_id, product_id, product_name, rating, comment, name, created_at, status, status_at }]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = () => process.env.HM_REVIEWS_FILE || path.join(__dirname, '..', 'data', 'reviews.json');
const STATUSES = ['pending', 'approved', 'rejected'];

let cache = { mtime: -1, list: [] };
function getAll() {
  try {
    const m = fs.statSync(FILE()).mtimeMs;
    if (m !== cache.mtime) cache = { mtime: m, list: JSON.parse(fs.readFileSync(FILE(), 'utf8')) };
  } catch (e) {
    if (e.code === 'ENOENT') cache = { mtime: -1, list: [] };
  }
  return cache.list;
}
function saveAll(list) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, FILE());
  cache = { mtime: fs.statSync(FILE()).mtimeMs, list };
}

/** "Nguyễn Văn Tuấn" → "Tuấn N." ; trống → "Khách hàng" */
function maskName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Khách hàng';
  const last = parts[parts.length - 1];
  return parts.length > 1 ? `${last} ${parts[0][0].toUpperCase()}.` : `${last[0].toUpperCase()}***`;
}
const clean = s => String(s || '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').replace(/\s+\n/g, '\n').trim();

const canReview = order => !!order && order.status === 'COMPLETED' && !order.is_test;

/** SP trong đơn còn chưa đánh giá (gộp theo mã SP). */
function pendingItems(order) {
  const done = new Set(getAll().filter(r => r.order_id === order.id).map(r => Number(r.product_id)));
  const seen = new Set();
  return (order.items || []).filter(i => {
    const id = Number(i.id);
    if (!Number.isSafeInteger(id) || seen.has(id)) return false;
    seen.add(id);
    return !done.has(id);
  }).map(i => ({ product_id: Number(i.id), name: i.name, variant_name: i.variant_name || null, image: i.image || null }));
}

/** items: [{ product_id, rating 1–5, comment ≤ 500 }] → các đánh giá đã tạo (chờ duyệt). */
function submit(order, items) {
  if (!canReview(order)) throw new Error('Chỉ đánh giá được đơn đã giao thành công.');
  if (!Array.isArray(items) || !items.length) throw new Error('Chưa có đánh giá nào.');
  const allowed = new Map(pendingItems(order).map(i => [i.product_id, i]));
  const list = getAll().slice();
  const created = [];
  for (const it of items.slice(0, 30)) {
    const pid = Number(it.product_id);
    const rating = Math.round(Number(it.rating));
    if (!allowed.has(pid)) continue;
    if (!(rating >= 1 && rating <= 5)) throw new Error('Số sao từ 1 đến 5.');
    const comment = clean(it.comment).slice(0, 500);
    const r = {
      id: `RV${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
      order_id: order.id, product_id: pid, product_name: allowed.get(pid).name,
      rating, comment, name: maskName(order.customer?.name),
      created_at: new Date().toISOString(), status: 'pending'
    };
    list.push(r);
    created.push(r);
    allowed.delete(pid);
  }
  if (!created.length) throw new Error('Các sản phẩm này đã được đánh giá.');
  saveAll(list);
  return created;
}

function setStatus(id, status) {
  if (!STATUSES.includes(status)) throw new Error('Trạng thái không hợp lệ.');
  const list = getAll().slice();
  const i = list.findIndex(r => r.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], status, status_at: new Date().toISOString() };
  saveAll(list);
  return list[i];
}

/** Phần công khai của 1 SP (chỉ đánh giá đã duyệt). productIds: mã SP cha + mã các phân loại gộp. */
function forProduct(productIds, { limit = 10 } = {}) {
  const ids = new Set([].concat(productIds).map(Number));
  const ok = getAll().filter(r => r.status === 'approved' && ids.has(Number(r.product_id)))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const count = ok.length;
  const avg = count ? Math.round((ok.reduce((s, r) => s + r.rating, 0) / count) * 10) / 10 : null;
  return {
    count, average: avg,
    items: ok.slice(0, limit).map(r => ({ id: r.id, rating: r.rating, comment: r.comment, name: r.name, created_at: r.created_at }))
  };
}

/** Số lượng đã bán THẬT theo mã SP: đơn không huỷ, không phải đơn thử. */
function soldCounts(orders) {
  const m = new Map();
  for (const o of orders || []) {
    if (o.status === 'CANCELLED' || o.is_test || o.status === 'PENDING_PAYMENT') continue;
    for (const i of o.items || []) {
      const id = Number(i.id);
      if (Number.isSafeInteger(id)) m.set(id, (m.get(id) || 0) + (Number(i.quantity) || 0));
    }
  }
  return m;
}

module.exports = { STATUSES, getAll, maskName, canReview, pendingItems, submit, setStatus, forProduct, soldCounts };
