const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET_FILE = path.join(__dirname, '..', 'data', 'admin-secret.json');
const ADMIN_COOKIE_NAME = 'hm_admin_sess';
const ADMIN_COOKIE_MAX_AGE = 12 * 3600; // 12 giờ

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

/** Mã phiên quản trị ký HMAC từ mật khẩu hiện tại (đổi mật khẩu → mọi cookie cũ tự hết hiệu lực). */
function adminSessionToken() {
  return crypto.createHmac('sha256', String(getAdminPassword())).update('hm-admin-session-v1').digest('hex');
}

function parseCookies(cookieHeader) {
  const out = Object.create(null);
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
  }
  return out;
}

function isAdminCookie(cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  const val = cookies[ADMIN_COOKIE_NAME];
  return !!(val && safeEqual(val, adminSessionToken()));
}

function reqHeader(req, name) {
  if (!req) return '';
  if (typeof req.get === 'function') {
    const v = req.get(name);
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return String(req.headers?.[name.toLowerCase()] || '');
}

function isHttpsRequest(req) {
  if (req?.secure) return true;
  const peer = String(req?.socket?.remoteAddress || '');
  const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (!local) return false;
  const visitor = reqHeader(req, 'cf-visitor');
  const proto = reqHeader(req, 'x-forwarded-proto').split(',')[0].trim();
  return /"scheme"\s*:\s*"https"/.test(visitor) || proto === 'https';
}

function setAdminCookie(req, res) {
  const secure = isHttpsRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE_NAME}=${adminSessionToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_COOKIE_MAX_AGE}${secure}`);
}

function clearAdminCookie(req, res) {
  const secure = isHttpsRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

function isSameOriginMutation(req) {
  const host = reqHeader(req, 'host').toLowerCase();
  if (!host) return true;
  const origin = reqHeader(req, 'origin');
  if (origin) {
    try { return new URL(origin).host.toLowerCase() === host; } catch { return false; }
  }
  const referer = reqHeader(req, 'referer');
  if (referer) {
    try { return new URL(referer).host.toLowerCase() === host; } catch { return false; }
  }
  return true;
}

function extractAdminKey(req) {
  const direct = reqHeader(req, 'x-admin-key');
  if (direct) return direct;
  const auth = reqHeader(req, 'authorization');
  return auth ? auth.replace(/^Bearer\s+/i, '') : '';
}

/** Kiểm tra request có quyền quản trị hợp lệ (header x-admin-key / Bearer HOẶC cookie phiên HttpOnly). */
function isAdminRequest(req) {
  const key = extractAdminKey(req);
  if (key) return safeEqual(key, getAdminPassword());
  const cookieHeader = reqHeader(req, 'cookie');
  if (!isAdminCookie(cookieHeader)) return false;
  const method = String(req?.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && !isSameOriginMutation(req)) return false;
  return true;
}

/** Chỉ phát sự kiện nội bộ quản trị vào phòng 'admins', tuyệt đối không phát ra toàn bộ trình duyệt khách. */
function emitAdmin(io, event, payload) {
  if (!io) return;
  if (io.sockets && typeof io.to === 'function') {
    io.to('admins').emit(event, payload);
  } else if (typeof io.emit === 'function') {
    io.emit(event, payload);
  }
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

/**
 * IP thật của khách. Qua Cloudflare Tunnel, mọi request tới từ cloudflared chạy trên chính máy này (127.0.0.1)
 * → nếu dùng IP kết nối thì cả web chung 1 IP: chung hạn mức đặt đơn, và 1 kẻ dò mật khẩu admin khoá luôn chủ shop.
 * Chỉ tin header CF-Connecting-IP khi kết nối tới từ máy này (ngoài mạng không giả được).
 */
function clientIp(req) {
  const peer = String(req?.socket?.remoteAddress || '');
  const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const cf = String(req?.headers?.['cf-connecting-ip'] || '').trim();
  if (local && cf && /^[0-9a-f.:]{3,45}$/i.test(cf)) return cf;
  return req?.ip || peer;
}

/**
 * Khách vào bằng http:// qua Cloudflare → chuyển sang https:// (không thì giỏ hàng, số điện thoại đi qua mạng không mã hoá).
 * Chỉ xét header Cloudflare khi kết nối đến từ cloudflared trên chính máy này; truy cập thẳng http://localhost giữ nguyên.
 */
function forceHttps(req, res, next) {
  const peer = String(req.socket?.remoteAddress || '');
  const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const visitor = String(req.headers?.['cf-visitor'] || '');
  const host = String(req.headers?.host || '');
  if (local && /"scheme"\s*:\s*"http"/.test(visitor) && /^[a-z0-9.-]+$/i.test(host) && !/^(localhost|127\.0\.0\.1)$/i.test(host)) {
    return res.redirect(301, `https://${host}${req.originalUrl || req.url || '/'}`);
  }
  next();
}

/** rateLimit('checkout', 10 * 60e3, 8) → tối đa 8 request / 10 phút / IP */
function rateLimit(name, windowMs, max) {
  return (req, res, next) => {
    const r = hit(`${name}:${clientIp(req)}`, windowMs, max);
    if (r.allowed) return next();
    res.set('Retry-After', String(r.retryAfter));
    return res.status(429).json({ success: false, error: `Bạn thao tác quá nhanh, vui lòng thử lại sau ${Math.ceil(r.retryAfter / 60)} phút.` });
  };
}

/** Middleware bảo vệ API quản trị: header `x-admin-key: <mật khẩu>` hoặc cookie phiên HttpOnly. Sai quá 10 lần / 15 phút / IP → khoá tạm. */
// Khoá theo số MẬT KHẨU SAI KHÁC NHAU (không theo số request): trang admin gửi nhiều request song song
// với cùng 1 mật khẩu, nhập sai 1 lần không được tính thành nhiều lần.
const adminFails = new Map(); // ip -> { keys: Set<hash>, reset }
const ADMIN_LOCK_MS = 15 * 60 * 1000;
const ADMIN_MAX_WRONG = 10;

function requireAdmin(req, res, next) {
  const now = Date.now();
  const ip = clientIp(req);
  let f = adminFails.get(ip);
  if (f && f.reset < now) {
    adminFails.delete(ip);
    f = null;
  }
  if (f && f.keys.size >= ADMIN_MAX_WRONG) {
    return res.status(429).json({ success: false, error: `Sai mật khẩu quá nhiều lần, thử lại sau ${Math.ceil((f.reset - now) / 60000)} phút.` });
  }
  if (isAdminRequest(req)) return next();
  const key = extractAdminKey(req);
  if (key) {
    if (!f) adminFails.set(ip, (f = { keys: new Set(), reset: now + ADMIN_LOCK_MS }));
    f.keys.add(crypto.createHash('sha256').update(key).digest('hex'));
  }
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

/** Loại bỏ thẻ/thuộc tính nguy hiểm khỏi HTML mô tả trước khi trả cho trình duyệt. */
function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta|base)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta|base)[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*(javascript|vbscript|data:text\/html)[^"']*\2/gi, '$1="#"');
}

/** Loại bỏ triệt để tên/tên miền nguồn cung cấp khỏi chuỗi văn bản/HTML trả ra công khai. */
function stripSupplierText(input) {
  if (input == null || typeof input !== 'string') return input;
  if (!/drop\s*buy|r6[is]\.pen|\bfoxing\b|\bdalon\b|techmall(?:\.vn)?|hstatic\.net|geektek/i.test(input)) return input;
  return input
    .replace(/https?:\/\/(?:[\w-]+\.)*dropbuy\.vn[^\s"'<>)]*/gi, '')
    .replace(/https?:\/\/(?:[\w-]+\.)*techmall\.vn[^\s"'<>)]*/gi, '')
    .replace(/bảo hành chính hãng\s+(?:drop\s*buy|techmall)(?:\.vn)?/gi, 'Bảo hành chính hãng')
    .replace(/phân phối từ kho tổng\s+(?:drop\s*buy|techmall)(?:\.vn)?/gi, 'phân phối bởi Hoàng Minh Store')
    .replace(/(?:trên|từ)\s+kho\s+(?:drop\s*buy|techmall)(?:\.vn)?/gi, 'tại kho')
    .replace(/(?:trên|từ|của|bên)\s+(?:drop\s*buy|techmall)(?:\.vn)?/gi, 'tại cửa hàng')
    .replace(/drop\s*buy(?:\.vn)?/gi, 'Hoàng Minh Store')
    .replace(/techmall(?:\.vn)?/gi, 'Hoàng Minh Store')
    .replace(/https?:\/\/(?:[\w-]+\.)*hstatic\.net[^\s"'<>)]*/gi, '')
    .replace(/\br6[is]\.pen\b/gi, '')
    .replace(/\b(?:foxing|dalon|geektek)\b/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Che bớt số điện thoại / địa chỉ khi trả đơn hàng cho phía khách. */
function maskPhone(phone) {
  const s = String(phone || '');
  return s.length > 6 ? `${s.slice(0, 3)}****${s.slice(-3)}` : s;
}

/** Trang cổng đăng nhập quản trị phía server (không chứa bất kỳ mã nguồn hay tên nhà cung cấp nào). */
function renderAdminLoginGate(storeName = 'Hoàng Minh Store') {
  const safeStore = String(storeName).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>Đăng nhập Quản trị | ${safeStore}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 20px;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: radial-gradient(circle at top, #1e293b 0%, #0f172a 65%);
      color: #0f172a;
      -webkit-font-smoothing: antialiased;
    }
    .gate-card {
      width: 100%;
      max-width: 410px;
      background: #ffffff;
      border-radius: 16px;
      padding: 32px 28px 28px;
      box-shadow: 0 24px 60px rgba(2, 6, 23, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.08);
    }
    .gate-brand {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
    }
    .gate-brand img {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      flex-shrink: 0;
    }
    .gate-brand-title {
      font-size: 17px;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: #0f172a;
      line-height: 1.25;
    }
    .gate-brand-sub {
      font-size: 12.5px;
      font-weight: 500;
      color: #64748b;
      margin-top: 2px;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: #0f172a;
    }
    .gate-desc {
      margin: 0 0 20px;
      font-size: 13.5px;
      line-height: 1.5;
      color: #475569;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #334155;
      margin-bottom: 6px;
    }
    .pwd-wrap {
      position: relative;
      display: flex;
      align-items: center;
    }
    input[type="password"], input[type="text"] {
      width: 100%;
      height: 44px;
      padding: 0 42px 0 14px;
      font-family: inherit;
      font-size: 14px;
      color: #0f172a;
      background: #f8fafc;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
    }
    input:focus {
      background: #ffffff;
      border-color: #ea580c;
      box-shadow: 0 0 0 3px rgba(234, 88, 12, 0.15);
    }
    .pwd-toggle {
      position: absolute;
      right: 8px;
      background: none;
      border: none;
      padding: 6px;
      cursor: pointer;
      color: #64748b;
      font-size: 12px;
      font-weight: 600;
      font-family: inherit;
    }
    .pwd-toggle:hover { color: #0f172a; }
    .gate-error {
      display: none;
      margin-top: 12px;
      padding: 10px 12px;
      border-radius: 8px;
      background: #fef2f2;
      border: 1px solid #fecaca;
      color: #dc2626;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.45;
    }
    .gate-submit {
      margin-top: 18px;
      width: 100%;
      height: 44px;
      border: none;
      border-radius: 10px;
      background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
      color: #ffffff;
      font-family: inherit;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 6px 16px rgba(234, 88, 12, 0.28);
      transition: transform 0.12s, box-shadow 0.12s, opacity 0.12s;
    }
    .gate-submit:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 8px 20px rgba(234, 88, 12, 0.36);
    }
    .gate-submit:disabled {
      opacity: 0.65;
      cursor: wait;
    }
    .gate-back {
      display: block;
      margin-top: 18px;
      text-align: center;
      font-size: 13px;
      font-weight: 500;
      color: #64748b;
      text-decoration: none;
    }
    .gate-back:hover { color: #0f172a; }
  </style>
</head>
<body>
  <main class="gate-card">
    <div class="gate-brand">
      <img src="/favicon.svg" alt="">
      <div>
        <div class="gate-brand-title">${safeStore}</div>
        <div class="gate-brand-sub">Hệ thống Quản trị Nội bộ</div>
      </div>
    </div>
    <h1>Xác thực Quản trị viên</h1>
    <p class="gate-desc">Vui lòng nhập mật khẩu quản trị để mở bảng điều khiển cửa hàng.</p>
    <form id="gateForm" autocomplete="off">
      <label for="gatePwd">Mật khẩu quản trị</label>
      <div class="pwd-wrap">
        <input id="gatePwd" name="password" type="password" placeholder="Nhập mật khẩu..." required autofocus>
        <button type="button" class="pwd-toggle" id="pwdToggle">Hiện</button>
      </div>
      <div id="gateErr" class="gate-error" role="alert"></div>
      <button type="submit" class="gate-submit" id="gateBtn">Đăng nhập</button>
    </form>
    <a href="/" class="gate-back">← Quay về trang mua sắm</a>
  </main>
  <script>
    (function () {
      var form = document.getElementById('gateForm');
      var inp = document.getElementById('gatePwd');
      var btn = document.getElementById('gateBtn');
      var err = document.getElementById('gateErr');
      var tog = document.getElementById('pwdToggle');
      tog.addEventListener('click', function () {
        var show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        tog.textContent = show ? 'Ẩn' : 'Hiện';
        inp.focus();
      });
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var pwd = (inp.value || '').trim();
        if (!pwd) return;
        err.style.display = 'none';
        btn.disabled = true;
        btn.textContent = 'Đang xác thực...';
        try {
          var res = await fetch('/api/admin/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-key': pwd },
            credentials: 'same-origin'
          });
          if (res.ok) {
            try { sessionStorage.setItem('hm_admin_key', pwd); } catch (_) {}
            location.reload();
            return;
          }
          var data = await res.json().catch(function () { return {}; });
          err.textContent = data.error || 'Mật khẩu quản trị không đúng.';
          err.style.display = 'block';
          inp.select();
        } catch (ex) {
          err.textContent = 'Không thể kết nối máy chủ. Vui lòng thử lại.';
          err.style.display = 'block';
        } finally {
          btn.disabled = false;
          btn.textContent = 'Đăng nhập';
        }
      });
    })();
  </script>
</body>
</html>`;
}

module.exports = {
  ADMIN_COOKIE_NAME,
  adminSessionToken,
  parseCookies,
  isAdminCookie,
  setAdminCookie,
  clearAdminCookie,
  isAdminRequest,
  emitAdmin,
  safeEqual,
  clientIp,
  forceHttps,
  getAdminPassword,
  requireAdmin,
  rateLimit,
  securityHeaders,
  sanitizeHtml,
  stripSupplierText,
  maskPhone,
  renderAdminLoginGate
};
