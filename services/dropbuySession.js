/**
 * Phiên đăng nhập DropBuy cho các API cần tài khoản (giá sỉ, giỏ, số dư, đặt đơn).
 *
 * BFF của DropBuy (`/api/proxy/bff/...`) không đọc cookie: nó cần header `x-foxing-sid`.
 * sid nằm trong phiên NextAuth (`/api/auth/session` → user.sid), lấy được từ cookie đã lưu ở admin.
 * Chỉ giữ sid trong bộ nhớ; cookie hết hạn thì sid cũng hết hạn → admin đăng nhập lại.
 */
const BASE = 'https://dropbuy.vn';
const BFF = `${BASE}/api/proxy/bff`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const RECHECK_MS = 10 * 60 * 1000;

let cache = { cookie: null, sid: null, exp: 0, checkedAt: 0, user: null };

class DropbuyError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function cookieOf(config) {
  return config?.dropbuy?.cookieHeader || '';
}

/** sid đang dùng được (đồng bộ, không gọi mạng) – để chèn vào header các request có sẵn */
function currentSid(config) {
  const cookie = cookieOf(config);
  if (!cookie || cache.cookie !== cookie || !cache.sid || Date.now() >= cache.exp) return null;
  return cache.sid;
}

/** Lấy (hoặc làm mới) sid từ cookie. Trả về { sid, user, expiresAt } hoặc null nếu chưa đăng nhập / hết hạn. */
async function ensureSession(config, { force = false } = {}) {
  const cookie = cookieOf(config);
  if (!cookie) return null;
  const fresh = cache.cookie === cookie && cache.sid && Date.now() < cache.exp - 60e3 && Date.now() - cache.checkedAt < RECHECK_MS;
  if (fresh && !force) return { sid: cache.sid, user: cache.user, expiresAt: new Date(cache.exp).toISOString() };

  const res = await fetch(`${BASE}/api/auth/session`, { headers: { 'user-agent': UA, cookie, referer: `${BASE}/` } });
  const session = await res.json().catch(() => null);
  const u = session?.user;
  if (!u?.sid) {
    cache = { cookie, sid: null, exp: 0, checkedAt: Date.now(), user: null };
    return null;
  }
  const exps = [Date.parse(u.expired_at), Date.parse(session.expires)].filter(Number.isFinite);
  cache = {
    cookie,
    sid: u.sid,
    exp: exps.length ? Math.min(...exps) : Date.now() + 60 * 60e3,
    checkedAt: Date.now(),
    user: { id: u.user_id ?? u.id, username: u.username, name: u.display_name || u.name, otp_required_above: u.order_comodity_amount_required_otp || 0, mfa_enabled: !!u.mfa_enabled }
  };
  return { sid: cache.sid, user: cache.user, expiresAt: new Date(cache.exp).toISOString() };
}

function invalidate() {
  cache = { cookie: null, sid: null, exp: 0, checkedAt: 0, user: null };
}

function headers(config, sid) {
  const h = { 'content-type': 'application/json', 'user-agent': UA, origin: BASE, referer: `${BASE}/` };
  const cookie = cookieOf(config);
  if (cookie) h.cookie = cookie;
  const s = sid || currentSid(config);
  if (s) h['x-foxing-sid'] = s;
  return h;
}

/**
 * Gọi BFF cần đăng nhập. Ném DropbuyError (code 401 = chưa đăng nhập / hết phiên).
 * Trả về json.data.
 */
async function bff(path, { method = 'GET', body, config, timeoutMs = 20000 } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await ensureSession(config, { force: attempt > 0 });
    if (!s) throw new DropbuyError('Chưa đăng nhập DropBuy hoặc phiên đã hết hạn – đăng nhập lại trong admin.', 401);
    const res = await fetch(`${BFF}${path}`, {
      method,
      headers: headers(config, s.sid),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const json = await res.json().catch(() => null);
    if (json?.success) return json.data;
    const code = json?.error_code ?? res.status;
    if (code === 401 && attempt === 0) continue; // sid vừa hết hạn → lấy lại 1 lần
    throw new DropbuyError(json?.message || `DropBuy lỗi HTTP ${res.status}`, code);
  }
}

module.exports = { BASE, BFF, ensureSession, currentSid, invalidate, headers, bff, DropbuyError };
