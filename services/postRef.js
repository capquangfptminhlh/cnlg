'use strict';
/**
 * Mã bài đăng (?r=...) — biết bài/nhóm Zalo nào mang khách tới và ra đơn.
 *
 * App LHMLead-CRM gửi link kiểu https://besi.com.vn/sp/123?r=k7f2 (mỗi nhóm một mã). Ở đây:
 *  - khách (người, không phải bot xem trước link) bấm link → lưu mã vào cookie 7 ngày + đếm lượt bấm;
 *  - khách đặt đơn trong 7 ngày → đơn mang mã đó (lần bấm gần nhất thắng);
 *  - app CRM đọc lại đơn qua API riêng bằng "khoá thống kê" — chỉ mã SP/số lượng/tiền/giờ,
 *    KHÔNG có tên, SĐT, địa chỉ khách.
 * Mã chỉ là chuỗi ngẫu nhiên; nghĩa của nó (bài nào, nhóm nào) chỉ app CRM biết.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseCookies, safeEqual } = require('./security');

const COOKIE = 'bref';
const MAX_AGE_S = 7 * 24 * 3600;
const CODE_RE = /^[a-z0-9_-]{3,32}$/i;
// Bot đọc trước link (ảnh/tiêu đề xem trước). KHÔNG chặn chữ "Zalo": trình duyệt trong app Zalo của khách
// thật có "Zalo" trong user-agent — chặn nó là mất gần hết đơn từ nhóm Zalo.
const BOT_RE = /bot|crawl|spider|facebookexternalhit|curl|wget|python|java\/|go-http|okhttp|preview|headless/i;
const KEEP_DAYS = 45;
const MAX_REFS = 20000;

const dataDir = () => process.env.HM_POSTREF_DIR || path.join(__dirname, '..', 'data');
const clicksFile = () => path.join(dataDir(), 'ref-clicks.json');
const keyFile = () => path.join(dataDir(), 'attribution-key.json');

const validCode = v => typeof v === 'string' && CODE_RE.test(v);
const isBot = ua => { const u = String(ua || ''); return !/mozilla\//i.test(u) || BOT_RE.test(u); };

/** Mã sản phẩm trong đường dẫn /sp/123 hoặc /sp/123-ten-sp. */
function productIdFromPath(p) {
  const m = String(p || '').match(/^\/sp\/(\d+)/);
  return m ? Number(m[1]) : null;
}

// ── Lượt bấm: gộp theo mã, ghi trễ để không ghi file mỗi lượt ───────────────────
let clicks = null;
let saveTimer = null;
function loadClicks() {
  if (clicks) return clicks;
  try { clicks = JSON.parse(fs.readFileSync(clicksFile(), 'utf8')); } catch { clicks = {}; }
  if (!clicks || typeof clicks !== 'object' || Array.isArray(clicks)) clicks = {};
  return clicks;
}
function pruneClicks(now = Date.now()) {
  const c = loadClicks();
  const cutoff = now - KEEP_DAYS * 86400e3;
  for (const [k, v] of Object.entries(c)) if (!(Date.parse(v.last) >= cutoff)) delete c[k];
  const keys = Object.keys(c);
  if (keys.length > MAX_REFS) {
    keys.sort((a, b) => Date.parse(c[a].last) - Date.parse(c[b].last));
    for (const k of keys.slice(0, keys.length - MAX_REFS)) delete c[k];
  }
}
function flushClicks() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!clicks) return;
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = clicksFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(clicks), 'utf8');
    fs.renameSync(tmp, clicksFile());
  } catch (e) {
    console.warn('[PostRef] Không ghi được lượt bấm:', e.message);
  }
}
function recordClick(code, productId, now = Date.now()) {
  const c = loadClicks();
  const at = new Date(now).toISOString();
  const row = c[code] || (c[code] = { clicks: 0, first: at, last: at, products: {} });
  row.clicks += 1;
  row.last = at;
  if (productId) row.products[productId] = (row.products[productId] || 0) + 1;
  if (!saveTimer) {
    saveTimer = setTimeout(() => { pruneClicks(); flushClicks(); }, 5000);
    if (saveTimer.unref) saveTimer.unref();
  }
}

/** Express middleware: GET trang có ?r=mã → ghi cookie + đếm lượt bấm (bỏ qua bot xem trước link). */
function capture(req, res, next) {
  try {
    const code = req.method === 'GET' ? req.query?.r : null;
    if (validCode(code) && !String(req.path || '').startsWith('/api/') && !isBot(req.get?.('user-agent'))) {
      const secure = req.secure || String(req.get?.('x-forwarded-proto') || '').includes('https');
      const now = Date.now();
      res.append('Set-Cookie', `${COOKIE}=${code}.${Math.floor(now / 1000)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`);
      recordClick(code, productIdFromPath(req.path), now);
    }
  } catch (e) {
    console.warn('[PostRef] capture:', e.message);
  }
  next();
}

/** Mã bài của khách đang đặt đơn (còn hạn 7 ngày) hoặc null. */
function fromRequest(req, now = Date.now()) {
  const raw = parseCookies(req?.headers?.cookie)[COOKIE];
  if (!raw || raw.length > 64) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const code = raw.slice(0, dot);
  const sec = Number(raw.slice(dot + 1));
  if (!validCode(code) || !Number.isFinite(sec)) return null;
  if (now - sec * 1000 > MAX_AGE_S * 1000 || sec * 1000 > now + 60e3) return null;
  return { code, clicked_at: new Date(sec * 1000).toISOString() };
}

// ── Khoá thống kê: chỉ đọc được đơn ẩn danh, không làm được việc quản trị nào khác ─
function getKey() {
  if (process.env.ATTRIBUTION_KEY) return process.env.ATTRIBUTION_KEY;
  try {
    const k = JSON.parse(fs.readFileSync(keyFile(), 'utf8')).key;
    if (typeof k === 'string' && k.length >= 24) return k;
  } catch {}
  const key = crypto.randomBytes(24).toString('base64url');
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(keyFile(), JSON.stringify({ key, created_at: new Date().toISOString() }), 'utf8');
  } catch (e) {
    console.warn('[PostRef] Không lưu được khoá thống kê:', e.message);
  }
  return key;
}
function requireKey(req, res, next) {
  const got = String(req.get('x-attribution-key') || '');
  if (!got || !safeEqual(got, getKey())) return res.status(401).json({ success: false, error: 'Sai khoá thống kê.' });
  next();
}

/** SĐT Việt Nam về dạng 0xxxxxxxxx ('' nếu không hợp lệ). */
function normPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('84') && (d.length === 11 || d.length === 12)) d = '0' + d.slice(2);
  if (d.length === 9 && !d.startsWith('0')) d = '0' + d;
  return /^0\d{9,10}$/.test(d) ? d : '';
}

/**
 * Dấu SĐT có khoá: HMAC-SHA256(khoá thống kê, SĐT) cắt 24 ký tự. App CRM (giữ cùng khoá) tính dấu SĐT của khách
 * trong kho để GHÉP đơn ↔ khách mà không cần nhận SĐT thật. Không có khoá thì không suy ngược ra SĐT.
 */
function phoneHash(phone, key = getKey()) {
  const p = normPhone(phone);
  return p ? crypto.createHmac('sha256', String(key)).update(p).digest('hex').slice(0, 24) : null;
}

/** Đơn ẩn danh cho app CRM: không tên, không SĐT, không địa chỉ, không giá vốn (SĐT chỉ ở dạng dấu có khoá). */
function anonymousOrder(o) {
  return {
    phone_hash: phoneHash(o.customer?.phone),
    id: o.id,
    created_at: o.created_at,
    status: o.status,
    payment_method: o.payment_method,
    province: o.customer?.province_name || o.customer?.province || '',
    ref: o.post_ref || null,
    ref_clicked_at: o.post_ref_clicked_at || null,
    subtotal: Number(o.subtotal) || 0,
    total_amount: Number(o.total_amount) || 0,
    test: !!o.is_test || undefined,
    items: (o.items || []).map(i => ({ id: i.id, variation_id: i.variation_id ?? null, name: i.name, price: Number(i.price) || 0, quantity: Number(i.quantity) || 0 })),
  };
}

function report(orders, sinceIso, now = Date.now()) {
  const since = Date.parse(sinceIso) || now - 30 * 86400e3;
  const list = (orders || []).filter(o => Date.parse(o.created_at) >= since).map(anonymousOrder);
  const c = loadClicks();
  const refClicks = {};
  for (const [k, v] of Object.entries(c)) if (Date.parse(v.last) >= since) refClicks[k] = v;
  return { since: new Date(since).toISOString(), orders: list, clicks: refClicks };
}

module.exports = { COOKIE, MAX_AGE_S, validCode, isBot, productIdFromPath, capture, fromRequest, getKey, requireKey, normPhone, phoneHash, anonymousOrder, report, recordClick, flushClicks, _reset: () => { clicks = null; } };
