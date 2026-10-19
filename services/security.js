const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET_FILE = path.join(__dirname, '..', 'data', 'admin-secret.json');

/**
 * Mật khẩu quản trị: ưu tiên biến môi trường ADMIN_PASSWORD.
 * Nếu chưa đặt, tự sinh một mật khẩu ngẫu nhiên lưu ở data/admin-secret.json (không commit) và in ra console 1 lần.
 */
function getAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
      if (saved.password) return saved.password;
    }
  } catch (e) {}
  const password = crypto.randomBytes(12).toString('base64url');
  fs.writeFileSync(SECRET_FILE, JSON.stringify({ password, created_at: new Date().toISOString() }, null, 2), 'utf8');
  console.log('================================================================');
  console.log(`🔐 Đã tạo mật khẩu quản trị mới (lưu tại data/admin-secret.json): ${password}`);
  console.log('   Đặt ADMIN_PASSWORD trong file .env để dùng mật khẩu của riêng bạn.');
  console.log('================================================================');
  return password;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// --- Giới hạn tần suất theo IP (bộ nhớ trong, đủ cho 1 server) ---
const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60 * 1000).unref();

function hit(key, windowMs, max) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  return { allowed: b.count <= max, retryAfter: Math.ceil((b.reset - now) / 1000) };
}

/** rateLimit('checkout', 10 * 60e3, 8) → tối đa 8 request / 10 phút / IP */
function rateLimit(name, windowMs, max) {
  return (req, res, next) => {
    const r = hit(`${name}:${req.ip}`, windowMs, max);
    if (r.allowed) return next();
    res.set('Retry-After', String(r.retryAfter));
    return res.status(429).json({ success: false, error: `Bạn thao tác quá nhanh, vui lòng thử lại sau ${Math.ceil(r.retryAfter / 60)} phút.` });
  };
}

/** Middleware bảo vệ API quản trị: header `x-admin-key: <mật khẩu>`. Sai quá 10 lần / 15 phút / IP → khoá tạm. */
function requireAdmin(req, res, next) {
  const lockKey = `admin-fail:${req.ip}`;
  const lock = buckets.get(lockKey);
  if (lock && lock.count >= 10 && lock.reset > Date.now()) {
    return res.status(429).json({ success: false, error: 'Sai mật khẩu quá nhiều lần, thử lại sau 15 phút.' });
  }
  const key = req.get('x-admin-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (key && safeEqual(key, getAdminPassword())) return next();
  if (key) hit(lockKey, 15 * 60 * 1000, 10);
  return res.status(401).json({ success: false, error: 'Cần đăng nhập quản trị (sai hoặc thiếu mật khẩu admin).' });
}

/** Header bảo mật cơ bản */
function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

/** Loại bỏ thẻ/thuộc tính nguy hiểm khỏi HTML mô tả lấy từ DropBuy trước khi trả cho trình duyệt. */
function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta|base)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta|base)[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*(javascript|vbscript|data:text\/html)[^"']*\2/gi, '$1="#"');
}

/** Che bớt số điện thoại / địa chỉ khi trả đơn hàng cho phía khách. */
function maskPhone(phone) {
  const s = String(phone || '');
  return s.length > 6 ? `${s.slice(0, 3)}****${s.slice(-3)}` : s;
}

module.exports = { getAdminPassword, requireAdmin, rateLimit, securityHeaders, sanitizeHtml, maskPhone };
