'use strict';
/**
 * Phễu mua hàng ẩn danh: xem trang → xem SP → thêm giỏ → mở đặt hàng → đặt thành công.
 * Mỗi khách có 1 mã phiên ngẫu nhiên (sessionStorage, không gắn tên/SĐT/IP); máy chủ chỉ đếm
 * số lượt và số phiên khác nhau theo ngày (giờ VN). Dùng để biết khách bỏ ở bước nào.
 * data/funnel.json: { days: { 'YYYY-MM-DD': { events: {step: n}, sids: {step: [sid...]} } } } – giữ 90 ngày.
 */
const fs = require('fs');
const path = require('path');

const STEPS = ['view', 'product', 'cart', 'checkout', 'order'];
const LABELS = { view: 'Vào web', product: 'Xem sản phẩm', cart: 'Thêm vào giỏ', checkout: 'Mở bước đặt hàng', order: 'Đặt hàng thành công' };
const KEEP_DAYS = 90;
const MAX_SIDS_PER_STEP = 50000; // chặn phình bộ nhớ nếu bị spam
const FILE = () => process.env.HM_FUNNEL_FILE || path.join(__dirname, '..', 'data', 'funnel.json');
const SID_RE = /^[a-z0-9]{8,24}$/;
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|zalo|headless|lighthouse|preview|curl|wget|python|node-fetch/i;

const vnDay = (ms = Date.now()) => new Date(ms + 7 * 3600e3).toISOString().slice(0, 10);

let data = null;
let sets = new Map(); // `${day}|${step}` → Set(sid)
let dirty = false;

function load() {
  if (data) return data;
  try { data = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch (e) { data = null; }
  if (!data || typeof data !== 'object' || !data.days) data = { days: {} };
  sets = new Map();
  for (const [day, d] of Object.entries(data.days)) {
    for (const step of STEPS) sets.set(`${day}|${step}`, new Set((d.sids && d.sids[step]) || []));
  }
  return data;
}

function save() {
  if (!dirty || !data) return;
  // bỏ ngày cũ
  const days = Object.keys(data.days).sort();
  for (const old of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) {
    delete data.days[old];
    for (const step of STEPS) sets.delete(`${old}|${step}`);
  }
  for (const [day, d] of Object.entries(data.days)) {
    d.sids = Object.fromEntries(STEPS.map(s => [s, [...(sets.get(`${day}|${s}`) || [])]]));
  }
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    const tmp = FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, FILE());
    dirty = false;
  } catch (e) {}
}

/** Ghi 1 bước. Trả false nếu bị bỏ qua (bước lạ, mã phiên sai, bot). */
function record(step, sid, { userAgent = '', now = Date.now() } = {}) {
  if (!STEPS.includes(step) || !SID_RE.test(String(sid || '')) || BOT_RE.test(String(userAgent))) return false;
  load();
  const day = vnDay(now);
  const d = (data.days[day] ||= { events: {}, sids: {} });
  d.events[step] = (d.events[step] || 0) + 1;
  const key = `${day}|${step}`;
  if (!sets.has(key)) sets.set(key, new Set());
  const set = sets.get(key);
  if (set.size < MAX_SIDS_PER_STEP) set.add(sid);
  dirty = true;
  return true;
}

/**
 * Báo cáo `days` ngày gần nhất: số phiên khác nhau mỗi bước (gộp cả kỳ), tỉ lệ sang bước sau, theo ngày.
 */
function report({ days = 7, now = Date.now() } = {}) {
  load();
  const n = Math.max(1, Math.min(90, Number(days) || 7));
  const dayList = Array.from({ length: n }, (_, i) => vnDay(now - (n - 1 - i) * 86400e3));
  const uniq = Object.fromEntries(STEPS.map(s => [s, new Set()]));
  const events = Object.fromEntries(STEPS.map(s => [s, 0]));
  const perDay = dayList.map(day => {
    const row = { day };
    for (const s of STEPS) {
      const set = sets.get(`${day}|${s}`) || new Set();
      set.forEach(x => uniq[s].add(x));
      events[s] += (data.days[day]?.events?.[s]) || 0;
      row[s] = set.size;
    }
    return row;
  });
  const steps = STEPS.map((s, i) => {
    const sessions = uniq[s].size;
    const prev = i ? uniq[STEPS[i - 1]].size : null;
    return { step: s, label: LABELS[s], sessions, events: events[s], rate_from_prev: prev ? Math.round((sessions / prev) * 1000) / 10 : null };
  });
  const first = uniq.view.size || 0;
  return { days: n, steps, overall_rate: first ? Math.round((uniq.order.size / first) * 10000) / 100 : null, per_day: perDay };
}

function start() {
  load();
  return setInterval(save, 60e3).unref();
}

module.exports = { STEPS, LABELS, record, report, save, start, _reset: () => { data = null; sets = new Map(); dirty = false; } };
