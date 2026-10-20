const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return { dropbuy: {} };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function getBrowserExecutable() {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  if (fs.existsSync(chromePath)) return chromePath;
  if (fs.existsSync(edgePath)) return edgePath;
  return null;
}

/**
 * Kiểm tra session cookie trên DropBuy
 */
async function verifySession(cookieHeader) {
  if (!cookieHeader) return { valid: false, error: 'Chưa có cookie' };

  try {
    const res = await fetch('https://dropbuy.vn/api/auth/session', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookieHeader,
        'Origin': 'https://dropbuy.vn',
        'Referer': 'https://dropbuy.vn/'
      }
    });

    if (!res.ok) return { valid: false, error: `HTTP ${res.status}` };
    const session = await res.json();
    
    // Nếu NextAuth trả về user hoặc object session có dữ liệu
    // Phiên dùng được phải có sid (BFF xác thực bằng header x-foxing-sid) – không lưu sid xuống file
    if (session?.user?.sid) {
      const { sid, ...user } = session.user;
      return { valid: true, user, expires: session.user.expired_at || session.expires };
    }
    return { valid: false, session };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * Lấy trạng thái xác thực DropBuy hiện tại
 */
async function getAuthStatus() {
  const config = getConfig();
  const db = config.dropbuy || {};

  if (!db.cookieHeader && !db.sessionToken) {
    return {
      authenticated: false,
      username: db.username || null,
      message: 'Chưa đăng nhập DropBuy. Hệ thống đang đồng bộ theo giá bán lẻ công khai.'
    };
  }

  const check = await verifySession(db.cookieHeader);
  if (check.valid) {
    return {
      authenticated: true,
      username: db.username || check.user?.name || check.user?.email || 'Đại lý DropBuy',
      user: check.user,
      expires: check.expires,
      wholesaleActive: true,
      message: 'Đã kết nối tài khoản DropBuy. Giá sỉ đại lý F1 đang được kích hoạt.'
    };
  } else {
    return {
      authenticated: false,
      username: db.username,
      wholesaleActive: false,
      expired: true,
      message: 'Phiên đăng nhập DropBuy đã hết hạn. Vui lòng đăng nhập lại hoặc dán cookie mới.'
    };
  }
}

/**
 * Đăng nhập DropBuy siêu tốc qua NextAuth API, tự động fallback sang Puppeteer nếu cần
 * @param {string} username - SĐT / Email / Tên truy cập DropBuy
 * @param {string} password - Mật khẩu DropBuy
 * @param {string} [totpCode] - Mã xác minh 2 bước (chỉ khi tài khoản bật)
 */
async function loginDropbuy(username, password, totpCode) {
  if (!username || !password) {
    throw new Error('Vui lòng nhập đầy đủ tài khoản và mật khẩu DropBuy!');
  }

  const cleanUser = String(username).trim();
  const cleanPass = String(password).trim();

  console.log(`[DropBuy Auth] Bắt đầu xác thực tài khoản: ${cleanUser}...`);

  // --- PHƯƠNG PHÁP 1: GỌI TRỰC TIẾP NHƯ TRANG ĐĂNG NHẬP DROPBUY (~1s) ---
  // B1: POST /api/proxy/login/get-challenge {username} → challenge_key, challenge_token (mfa_enabled, challenge_next)
  // B2: NextAuth credentials "password-login": username, hashed_password (= mật khẩu nguyên văn, trang DropBuy không băm),
  //     challenge_key, challenge_token, totp_code. Thành công → cookie session-token; phiên dùng được phải có user.sid.
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  let networkError = null;
  try {
    console.log('[DropBuy Auth] Lấy mã challenge đăng nhập...');
    const chRes = await fetch('https://dropbuy.vn/api/proxy/login/get-challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: 'https://dropbuy.vn', Referer: 'https://dropbuy.vn/dang-nhap' },
      body: JSON.stringify({ username: cleanUser })
    });
    const ch = await chRes.json().catch(() => null);
    if (!ch) throw new Error(`get-challenge HTTP ${chRes.status}`);
    if (!ch.success || !ch.data) {
      throw Object.assign(new Error(ch.message || 'Không lấy được mã đăng nhập DropBuy.'), { final: true });
    }
    if (ch.data.challenge_message && ch.data.challenge_next !== 'password') {
      throw Object.assign(new Error(ch.data.challenge_message), { final: true });
    }
    if (ch.data.mfa_enabled && !totpCode) {
      throw Object.assign(new Error('Tài khoản DropBuy bật xác minh 2 bước – nhập thêm mã 2 bước (OTP) rồi đăng nhập lại.'), { final: true, needTotp: true });
    }

    const csrfRes = await fetch('https://dropbuy.vn/api/auth/csrf', { headers: { 'User-Agent': UA } });
    const csrfData = await csrfRes.json();
    const rawCookies = csrfRes.headers.getSetCookie ? csrfRes.headers.getSetCookie() : [csrfRes.headers.get('set-cookie')];
    const initialCookie = rawCookies.filter(Boolean).map(c => c.split(';')[0]).join('; ');

    const loginRes = await fetch('https://dropbuy.vn/api/auth/callback/password-login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': initialCookie,
        'User-Agent': UA,
        'Origin': 'https://dropbuy.vn',
        'Referer': 'https://dropbuy.vn/dang-nhap'
      },
      body: new URLSearchParams({
        csrfToken: csrfData.csrfToken,
        username: cleanUser,
        hashed_password: cleanPass,
        challenge_key: ch.data.challenge_key || '',
        challenge_token: ch.data.challenge_token || '',
        totp_code: totpCode ? String(totpCode).trim() : '',
        callbackUrl: 'https://dropbuy.vn/',
        json: 'true'
      }),
      redirect: 'manual'
    });

    const setCookies = (loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie')]).filter(Boolean);
    const sessionTokenCookie = setCookies.find(c => c.includes('session-token'));
    if (sessionTokenCookie) {
      const fullCookieHeader = setCookies.map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
      const sessionCheck = await verifySession(fullCookieHeader);
      if (!sessionCheck.valid) throw new Error('Đăng nhập xong nhưng DropBuy không trả phiên làm việc (sid).');

      const cfg = getConfig();
      cfg.dropbuy = {
        ...cfg.dropbuy,
        username: cleanUser,
        authenticated: true,
        authenticatedAt: new Date().toISOString(),
        cookieHeader: fullCookieHeader,
        sessionToken: sessionTokenCookie.split(';')[0].split('=').slice(1).join('='),
        user: sessionCheck.user,
        simulationMode: false
      };
      saveConfig(cfg);

      console.log(`[DropBuy Auth] ✅ Đăng nhập DropBuy thành công cho user: ${cleanUser}`);
      return { success: true, username: cleanUser, user: cfg.dropbuy.user, method: 'API_DIRECT' };
    }

    const bodyText = await loginRes.text().catch(() => '');
    if (/CredentialsSignin|error=/.test(bodyText + (loginRes.headers.get('location') || '')) || loginRes.status === 401) {
      throw Object.assign(new Error(ch.data.mfa_enabled ? 'Sai mật khẩu hoặc mã 2 bước DropBuy.' : 'Sai mật khẩu DropBuy.'), { final: true });
    }
    throw new Error(`DropBuy trả về HTTP ${loginRes.status} khi đăng nhập`);
  } catch (apiErr) {
    if (apiErr.final) throw apiErr;
    networkError = apiErr;
    console.warn('[DropBuy Auth] Đăng nhập trực tiếp lỗi, thử trình duyệt ẩn:', apiErr.message);
  }

  // --- PHƯƠNG PHÁP 2: FALLBACK SANG HEADLESS PUPPETEER ---
  const executablePath = getBrowserExecutable();
  if (!executablePath) {
    throw new Error(`Không đăng nhập được DropBuy (${networkError?.message || 'lỗi mạng'}) và không có Chrome/Edge để thử cách khác.`);
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto('https://dropbuy.vn/dang-nhap', { waitUntil: 'networkidle2', timeout: 35000 });

    // Bước 1: Nhập username
    await page.waitForSelector('#username, input[name="username"]', { timeout: 12000 });
    await page.type('#username, input[name="username"]', cleanUser);
    await page.click('button[type="submit"]');

    // Chờ xuất hiện password hoặc lỗi
    await page.waitForFunction(() => {
      return document.querySelector('#password') || 
             document.querySelector('.ant-message-error') || 
             document.querySelector('[role="alert"]');
    }, { timeout: 12000 });

    const step1Error = await page.evaluate(() => {
      const el = document.querySelector('.ant-message-error, .text-danger, [role="alert"]');
      return el ? el.innerText.trim() : null;
    });

    if (step1Error && !step1Error.includes('Chào mừng')) {
      throw new Error(`Đăng nhập thất bại: ${step1Error}`);
    }

    // Bước 2: Nhập password
    await page.waitForSelector('#password', { timeout: 8000 });
    await page.type('#password', cleanPass);
    await page.click('button[type="submit"]');

    await new Promise(r => setTimeout(r, 2500));

    const step2Error = await page.evaluate(() => {
      const alerts = Array.from(document.querySelectorAll('.ant-message-error, .text-danger, [role="alert"], [class*="error"]'));
      for (const a of alerts) {
        const txt = a.innerText.trim();
        if (txt && (txt.includes('Mật khẩu') || txt.includes('không khớp') || txt.includes('thất bại'))) {
          return txt;
        }
      }
      return null;
    });

    if (step2Error) {
      throw new Error(`Đăng nhập thất bại: ${step2Error}`);
    }

    await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});

    // Trích xuất cookies
    const client = await page.target().createCDPSession();
    const { cookies } = await client.send('Network.getAllCookies');
    const dropbuyCookies = cookies.filter(c => c.domain.includes('dropbuy.vn'));

    const cookieHeader = dropbuyCookies.map(c => `${c.name}=${c.value}`).join('; ');
    const sessionCookie = dropbuyCookies.find(c => c.name.includes('session-token'));

    const sessionCheck = await verifySession(cookieHeader);

    const cfg = getConfig();
    cfg.dropbuy = {
      ...cfg.dropbuy,
      username: cleanUser,
      authenticated: true,
      authenticatedAt: new Date().toISOString(),
      cookieHeader,
      sessionToken: sessionCookie ? sessionCookie.value : '',
      cookies: dropbuyCookies,
      user: sessionCheck.valid ? sessionCheck.user : { name: cleanUser },
      simulationMode: false
    };
    saveConfig(cfg);

    console.log(`[DropBuy Auth] ✅ Đăng nhập DropBuy qua Puppeteer thành công cho user: ${cleanUser}!`);
    return {
      success: true,
      username: cleanUser,
      user: cfg.dropbuy.user,
      method: 'PUPPETEER'
    };

  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Lưu chuỗi Cookie DropBuy thủ công
 */
async function setManualCookie(cookieString) {
  if (!cookieString || typeof cookieString !== 'string') {
    throw new Error('Vui lòng dán chuỗi cookie hợp lệ!');
  }

  let cleanCookie = cookieString.trim();
  // Nếu người dùng chỉ dán mỗi giá trị token: thử cả tên cookie https (__Secure-) và thường
  let sessionCheck;
  if (!cleanCookie.includes('=')) {
    const token = cleanCookie;
    for (const name of ['__Secure-next-auth.session-token', 'next-auth.session-token']) {
      cleanCookie = `${name}=${token}`;
      sessionCheck = await verifySession(cleanCookie);
      if (sessionCheck.valid) break;
    }
  } else {
    sessionCheck = await verifySession(cleanCookie);
  }

  if (!sessionCheck.valid) {
    throw new Error('Cookie DropBuy không hợp lệ hoặc đã hết hạn. Vui lòng lấy cookie mới trên trình duyệt.');
  }

  const cfg = getConfig();
  cfg.dropbuy = {
    ...cfg.dropbuy,
    authenticated: true,
    authenticatedAt: new Date().toISOString(),
    cookieHeader: cleanCookie,
    user: sessionCheck.user,
    simulationMode: false
  };
  saveConfig(cfg);

  console.log('[DropBuy Auth] ✅ Đã lưu và xác thực cookie DropBuy thành công!');
  return {
    success: true,
    user: sessionCheck.user,
    message: 'Đã lưu và kích hoạt cookie giá sỉ DropBuy thành công!'
  };
}

/**
 * Đăng xuất tài khoản DropBuy
 */
function logout() {
  const cfg = getConfig();
  if (cfg.dropbuy) {
    cfg.dropbuy.authenticated = false;
    cfg.dropbuy.cookieHeader = '';
    cfg.dropbuy.sessionToken = '';
    cfg.dropbuy.cookies = [];
    cfg.dropbuy.user = null;
  }
  saveConfig(cfg);
  return { success: true, message: 'Đã đăng xuất tài khoản DropBuy.' };
}

module.exports = {
  loginDropbuy,
  setManualCookie,
  verifySession,
  getAuthStatus,
  logout
};
