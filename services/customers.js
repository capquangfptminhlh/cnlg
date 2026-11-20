'use strict';
/**
 * Tài khoản KHÁCH SỈ: tự đăng ký bằng SĐT + mật khẩu → chờ admin duyệt → đăng nhập mới thấy giá sỉ.
 * Khách chưa đăng nhập / chưa duyệt luôn thấy giá lẻ (services/customerPricing.js).
 *
 * - data/customers.json: [{ id, phone, name, shop_name, status, pass: {salt, hash}, pwv, created_at, ... }]
 * - Cookie phiên `hm_cust` = id.hết_hạn.pwv.chữ_ký (HMAC, khoá trong data/customer-secret.json).
 *   Đổi mật khẩu / khoá tài khoản → pwv tăng hoặc status đổi → mọi phiên cũ mất hiệu lực ngay.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseCookies, safeEqual } = require('./security');

const DATA_DIR = process.env.HM_CUSTOMERS_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'customers.json');
const SECRET_FILE = path.join(DATA_DIR, 'customer-secret.json');
const COOKIE = 'hm_cust';
const MAX_AGE_S = 30 * 24 * 3600;
const STATUSES = ['pending', 'approved', 'rejected', 'disabled'];

let cache = { mtime: -1, list: [] };
function getAll() {
  try {
    const m = fs.statSync(FILE).mtimeMs;
    if (m !== cache.mtime) cache = { mtime: m, list: JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch (e) {
    if (e.code === 'ENOENT') cache = { mtime: -1, list: [] };
  }
  return cache.list;
}
function saveAll(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  cache = { mtime: fs.statSync(FILE).mtimeMs, list };
}

let secret = null;
function getSecret() {
  if (secret) return secret;
  try { secret = Buffer.from(JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8')).key, 'hex'); } catch (e) {}
  if (!secret || secret.length < 32) {
    secret = crypto.randomBytes(32);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SECRET_FILE, JSON.stringify({ key: secret.toString('hex') }), { encoding: 'utf8', mode: 0o600 });
  }
  return secret;
}

/** 0912 345 678 / +84912345678 → 0912345678; không phải SĐT di động VN → null */
function normPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '').replace(/^84(?=\d{9}$)/, '0');
  return /^0[35789]\d{8}$/.test(d) ? d : null;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}
function checkPassword(c, password) {
  if (!c?.pass?.salt || !c.pass.hash) return false;
  return safeEqual(hashPassword(password, c.pass.salt).hash, c.pass.hash);
}
// So mật khẩu cả khi không có tài khoản → thời gian trả lời không lộ SĐT nào đã đăng ký
const DUMMY = hashPassword('khong-co-tai-khoan');

/** Phần trả cho chính khách / admin – không bao giờ có mật khẩu. */
const view = c => (c ? {
  id: c.id, phone: c.phone, name: c.name, shop_name: c.shop_name || '', note: c.note || '', status: c.status,
  created_at: c.created_at, approved_at: c.approved_at || null, last_login_at: c.last_login_at || null
} : null);

function validPassword(p) {
  const s = String(p || '');
  if (s.length < 6) return 'Mật khẩu tối thiểu 6 ký tự.';
  if (s.length > 100) return 'Mật khẩu quá dài.';
  return null;
}

function register({ phone, password, name, shop_name, note }, { status = 'pending', created_by = 'self' } = {}) {
  const p = normPhone(phone);
  if (!p) throw new Error('Số điện thoại không hợp lệ.');
  const n = String(name || '').trim().slice(0, 80);
  if (n.length < 2) throw new Error('Vui lòng nhập họ tên.');
  const bad = validPassword(password);
  if (bad) throw new Error(bad);
  const list = getAll().slice();
  if (list.some(c => c.phone === p)) throw new Error('Số điện thoại này đã đăng ký. Vui lòng đăng nhập.');
  const c = {
    id: `KS${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
    phone: p, name: n, shop_name: String(shop_name || '').trim().slice(0, 120), note: String(note || '').trim().slice(0, 300),
    status, pass: hashPassword(password), pwv: 1, created_at: new Date().toISOString(),
    ...(created_by !== 'self' ? { created_by } : {}),
    ...(status === 'approved' ? { approved_at: new Date().toISOString() } : {})
  };
  list.push(c);
  saveAll(list);
  return view(c);
}

// Mật khẩu tự tạo cho khách admin tạo hộ: dễ đọc qua điện thoại (bỏ 0/O, 1/l/I)
const PASS_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function generatePassword(len = 8) {
  return Array.from(crypto.randomBytes(len), b => PASS_CHARS[b % PASS_CHARS.length]).join('');
}

/**
 * Admin tạo hộ khách sỉ quen (gọi điện / Zalo): ĐÃ DUYỆT luôn.
 * Không nhập mật khẩu → tự tạo; mật khẩu trả về MỘT lần để admin gửi khách (file chỉ lưu bản băm).
 */
function createByAdmin({ phone, password, name, shop_name, note }) {
  const pwd = String(password || '').trim() || generatePassword();
  const c = register({ phone, password: pwd, name, shop_name, note }, { status: 'approved', created_by: 'admin' });
  return { customer: c, password: pwd, generated: !String(password || '').trim() };
}

/** Đúng SĐT + mật khẩu → khách (mọi trạng thái, để báo "đang chờ duyệt"); sai → null. */
function login(phone, password) {
  const p = normPhone(phone);
  const c = p ? getAll().find(x => x.phone === p) : null;
  if (!c) { checkPassword({ pass: DUMMY }, password); return null; }
  if (!checkPassword(c, password)) return null;
  return update(c.id, { last_login_at: new Date().toISOString() }) || c;
}

function update(id, patch) {
  const list = getAll().slice();
  const i = list.findIndex(c => c.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch };
  saveAll(list);
  return list[i];
}

function setStatus(id, status) {
  if (!STATUSES.includes(status)) throw new Error('Trạng thái không hợp lệ.');
  const c = getAll().find(x => x.id === id);
  if (!c) return null;
  const now = new Date().toISOString();
  return view(update(id, { status, ...(status === 'approved' && !c.approved_at ? { approved_at: now } : {}), status_at: now }));
}

/** Admin đặt lại mật khẩu: phiên cũ của khách mất hiệu lực. */
function resetPassword(id, password) {
  const bad = validPassword(password);
  if (bad) throw new Error(bad);
  const c = getAll().find(x => x.id === id);
  if (!c) return null;
  return view(update(id, { pass: hashPassword(password), pwv: (c.pwv || 1) + 1 }));
}

function remove(id) {
  const list = getAll();
  const next = list.filter(c => c.id !== id);
  if (next.length === list.length) return false;
  saveAll(next);
  return true;
}

const sign = body => crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');

function sessionToken(c, now = Date.now()) {
  const body = `${c.id}.${Math.floor(now / 1000) + MAX_AGE_S}.${c.pwv || 1}`;
  return `${body}.${sign(body)}`;
}

/** Khách của cookie (đã kiểm chữ ký, hạn, mật khẩu chưa đổi) hoặc null. */
function fromCookieHeader(cookieHeader, now = Date.now()) {
  const tok = parseCookies(cookieHeader)[COOKIE];
  if (!tok || tok.length > 200) return null;
  const parts = tok.split('.');
  if (parts.length !== 4) return null;
  const [id, exp, pwv, sig] = parts;
  if (!safeEqual(sig, sign(`${id}.${exp}.${pwv}`))) return null;
  if (!(Number(exp) * 1000 > now)) return null;
  const c = getAll().find(x => x.id === id);
  if (!c || String(c.pwv || 1) !== pwv) return null;
  return c;
}

const fromRequest = req => fromCookieHeader(req?.headers?.cookie);
/** Chỉ khách sỉ ĐÃ DUYỆT mới được giá sỉ. */
const isWholesale = c => !!c && c.status === 'approved';

function setCookie(res, c, secure) {
  res.append('Set-Cookie', `${COOKIE}=${sessionToken(c)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`);
}
function clearCookie(res, secure) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

module.exports = {
  COOKIE, STATUSES, normPhone, register, createByAdmin, generatePassword, login, setStatus, resetPassword, remove, getAll, view,
  sessionToken, fromCookieHeader, fromRequest, isWholesale, setCookie, clearCookie
};
