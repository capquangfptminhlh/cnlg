const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Lưu tài khoản DropBuy (đã mã hoá AES-256-GCM) để tự đăng nhập lại khi phiên ~2 ngày hết hạn.
 * Chỉ lưu khi chủ shop tick "Ghi nhớ" lúc đăng nhập trong admin.
 * Khoá: biến DROPBUY_CRED_KEY (64 ký tự hex) nếu có, không thì file data/cred.key tự sinh.
 * Cả hai file đều nằm trong data/ và bị .gitignore – không bao giờ lên git. Ai đọc được cả khoá lẫn
 * file mã hoá trên máy này thì giải được mật khẩu: đây là đánh đổi chủ shop đã chọn.
 */
const DATA_DIR = path.join(__dirname, '..', 'data');
const CRED_FILE = process.env.HM_CRED_FILE || path.join(DATA_DIR, 'dropbuy-cred.json');
const KEY_FILE = process.env.HM_CRED_KEY_FILE || path.join(DATA_DIR, 'cred.key');

function getKey() {
  const env = process.env.DROPBUY_CRED_KEY;
  if (env && /^[0-9a-f]{64}$/i.test(env)) return Buffer.from(env, 'hex');
  if (!fs.existsSync(KEY_FILE)) {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  const hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('data/cred.key hỏng');
  return Buffer.from(hex, 'hex');
}

function save(username, password) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify({ u: String(username), p: String(password) }), 'utf8'), cipher.final()]);
  const rec = { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'), username: String(username), saved_at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
  fs.writeFileSync(`${CRED_FILE}.tmp`, JSON.stringify(rec), { mode: 0o600 });
  fs.renameSync(`${CRED_FILE}.tmp`, CRED_FILE);
}

/** { username, password } hoặc null (chưa lưu / khoá đổi / file hỏng) */
function load() {
  try {
    if (!fs.existsSync(CRED_FILE)) return null;
    const rec = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(rec.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(rec.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(rec.data, 'base64')), decipher.final()]).toString('utf8');
    const { u, p } = JSON.parse(plain);
    return { username: u, password: p };
  } catch (e) {
    console.warn('[Vault] Không đọc được tài khoản DropBuy đã lưu:', e.message);
    return null;
  }
}

/** Thông tin không nhạy cảm để hiện trong admin */
function info() {
  try {
    if (!fs.existsSync(CRED_FILE)) return { saved: false };
    const rec = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    return { saved: true, username: rec.username, saved_at: rec.saved_at };
  } catch (e) {
    return { saved: false };
  }
}

function clear() {
  try { fs.unlinkSync(CRED_FILE); } catch (e) {}
}

module.exports = { save, load, info, clear };
