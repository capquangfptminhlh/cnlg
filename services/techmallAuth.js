'use strict';
const fs = require('fs');
const path = require('path');
const credentialVault = require('./credentialVault');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const TECHMALL_BASE_URL = 'https://techmall.vn';

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function writeConfig(cfg) {
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
}

/** Trích xuất cookie từ mảng set-cookie */
function extractCookieHeader(setCookieHeaders) {
  if (!setCookieHeaders) return '';
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  const jar = new Map();
  for (const str of list) {
    if (!str || typeof str !== 'string') continue;
    const parts = str.split(';');
    const first = parts[0]?.trim();
    if (!first) continue;
    const eqIdx = first.indexOf('=');
    if (eqIdx > 0) {
      const k = first.slice(0, eqIdx).trim();
      const v = first.slice(eqIdx + 1).trim();
      jar.set(k, v);
    }
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Hợp nhất cookie mới vào cookie cũ */
function mergeCookies(oldCookieHeader, newSetCookieHeaders) {
  const jar = new Map();
  if (oldCookieHeader) {
    for (const part of oldCookieHeader.split(';')) {
      const p = part.trim();
      const idx = p.indexOf('=');
      if (idx > 0) jar.set(p.slice(0, idx).trim(), p.slice(idx + 1).trim());
    }
  }
  if (newSetCookieHeaders) {
    const list = Array.isArray(newSetCookieHeaders) ? newSetCookieHeaders : [newSetCookieHeaders];
    for (const str of list) {
      if (!str || typeof str !== 'string') continue;
      const first = str.split(';')[0]?.trim();
      const idx = first ? first.indexOf('=') : -1;
      if (idx > 0) jar.set(first.slice(0, idx).trim(), first.slice(idx + 1).trim());
    }
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Lấy login nonce từ trang /tai-khoan/ */
async function getLoginNonce() {
  const res = await fetch(`${TECHMALL_BASE_URL}/tai-khoan/`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    signal: AbortSignal.timeout(12000)
  });
  const html = await res.text();
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  const nonceMatch = html.match(/name="woocommerce-login-nonce"\s+value="([^"]+)"/i);
  return {
    nonce: nonceMatch ? nonceMatch[1] : null,
    cookies: extractCookieHeader(setCookies)
  };
}

/** Đăng nhập tài khoản TechMall.vn */
async function login(username, password, remember = true) {
  const userStr = String(username || '').trim();
  const passStr = String(password || '');
  if (!userStr || !passStr) {
    throw new Error('Vui lòng nhập tài khoản và mật khẩu TechMall');
  }

  const { nonce, cookies: initialCookies } = await getLoginNonce();
  if (!nonce) {
    throw new Error('Không thể lấy mã bảo mật đăng nhập (nonce) từ TechMall.vn');
  }

  const params = new URLSearchParams();
  params.set('username', userStr);
  params.set('password', passStr);
  params.set('woocommerce-login-nonce', nonce);
  params.set('_wp_http_referer', '/tai-khoan/');
  params.set('login', 'Đăng nhập');
  params.set('rememberme', 'forever');

  const res = await fetch(`${TECHMALL_BASE_URL}/tai-khoan/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Cookie': initialCookies,
      'Referer': `${TECHMALL_BASE_URL}/tai-khoan/`
    },
    body: params.toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(15000)
  });

  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  const mergedCookies = mergeCookies(initialCookies, setCookies);

  // Kiểm tra cookie đăng nhập WordPress
  const hasLoggedInCookie = /wordpress_logged_in_/i.test(mergedCookies);

  // Nếu trả về HTML (không redirect), kiểm tra thông báo lỗi
  let errorMsg = null;
  if (!hasLoggedInCookie) {
    const text = await res.text();
    const errMatch = text.match(/<ul[^>]*class="[^"]*woocommerce-error[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
    if (errMatch) {
      errorMsg = errMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    throw new Error(errorMsg || 'Đăng nhập TechMall không thành công. Vui lòng kiểm tra lại tài khoản hoặc mật khẩu.');
  }

  // Lưu thông tin phiên
  const cfg = readConfig();
  cfg.techmall = {
    username: userStr,
    authenticated: true,
    authenticatedAt: new Date().toISOString(),
    cookieHeader: mergedCookies,
    remember: !!remember
  };
  writeConfig(cfg);

  // Nếu tick ghi nhớ, lưu vào credential vault an toàn
  if (remember) {
    saveVaultCredentials(userStr, passStr);
  }

  console.log(`[TechMallAuth] ✅ Đăng nhập thành công tài khoản TechMall: ${userStr}`);
  return {
    success: true,
    username: userStr,
    authenticatedAt: cfg.techmall.authenticatedAt
  };
}

/** Lưu thông tin xác thực TechMall mã hoá AES-256-GCM */
const TECHMALL_CRED_FILE = path.join(DATA_DIR, 'techmall-cred.json');
function saveVaultCredentials(username, password) {
  try {
    const iv = require('crypto').randomBytes(12);
    // Sử dụng helper vault có sẵn
    const key = credentialVault.getKey ? credentialVault.getKey() : require('crypto').scryptSync('hm-tm-secret', 'salt', 32);
    const cipher = require('crypto').createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify({ u: String(username), p: String(password) }), 'utf8'), cipher.final()]);
    const rec = { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'), username: String(username), saved_at: new Date().toISOString() };
    fs.mkdirSync(path.dirname(TECHMALL_CRED_FILE), { recursive: true });
    fs.writeFileSync(TECHMALL_CRED_FILE, JSON.stringify(rec), { mode: 0o600 });
  } catch (err) {
    console.warn('[TechMallAuth] Lỗi lưu thông tin mật khẩu TechMall:', err.message);
  }
}

/** Đọc mật khẩu đã lưu để tự đăng nhập lại khi cần */
function loadVaultCredentials() {
  try {
    if (!fs.existsSync(TECHMALL_CRED_FILE)) return null;
    const rec = JSON.parse(fs.readFileSync(TECHMALL_CRED_FILE, 'utf8'));
    const key = credentialVault.getKey ? credentialVault.getKey() : require('crypto').scryptSync('hm-tm-secret', 'salt', 32);
    const decipher = require('crypto').createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(rec.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(rec.data, 'base64')), decipher.final()]).toString('utf8');
    const { u, p } = JSON.parse(plain);
    return { username: u, password: p };
  } catch (err) {
    return null;
  }
}

/** Kiểm tra phiên hiện tại còn hiệu lực không */
async function checkSession() {
  const cfg = readConfig();
  const tm = cfg.techmall || {};
  if (!tm.cookieHeader) {
    return { authenticated: false, message: 'Chưa có phiên đăng nhập TechMall' };
  }

  try {
    const res = await fetch(`${TECHMALL_BASE_URL}/tai-khoan/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': tm.cookieHeader
      },
      signal: AbortSignal.timeout(10000)
    });
    const html = await res.text();
    const isLoggedIn = html.includes('woocommerce-MyAccount-navigation') || html.includes('customer-logout');
    if (isLoggedIn) {
      return {
        authenticated: true,
        username: tm.username,
        authenticatedAt: tm.authenticatedAt
      };
    }

    // Phiên đã hết hạn -> thử tự đăng nhập lại nếu có lưu credentials
    const creds = loadVaultCredentials();
    if (creds && creds.username && creds.password) {
      console.log('[TechMallAuth] Phiên hết hạn, đang tự đăng nhập lại TechMall...');
      const relogin = await login(creds.username, creds.password, true);
      return {
        authenticated: true,
        username: relogin.username,
        authenticatedAt: relogin.authenticatedAt,
        reauthenticated: true
      };
    }

    // Cập nhật trạng thái chưa kết nối
    tm.authenticated = false;
    cfg.techmall = tm;
    writeConfig(cfg);
    return { authenticated: false, message: 'Phiên TechMall đã hết hạn' };
  } catch (err) {
    return { authenticated: tm.authenticated || false, username: tm.username, error: err.message };
  }
}

/** Đăng xuất TechMall */
function logout() {
  const cfg = readConfig();
  if (cfg.techmall) {
    cfg.techmall.authenticated = false;
    cfg.techmall.cookieHeader = '';
  }
  writeConfig(cfg);
  try {
    if (fs.existsSync(TECHMALL_CRED_FILE)) fs.unlinkSync(TECHMALL_CRED_FILE);
  } catch (e) {}
  return { success: true };
}

/** Lấy headers chuẩn kèm cookie để gọi API TechMall */
function getAuthHeaders() {
  const cfg = readConfig();
  const tm = cfg.techmall || {};
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
  };
  if (tm.cookieHeader) {
    headers['Cookie'] = tm.cookieHeader;
  }
  return headers;
}

module.exports = {
  login,
  checkSession,
  logout,
  getAuthHeaders,
  loadVaultCredentials,
  readConfig
};
