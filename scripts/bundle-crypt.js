'use strict';
/*
 * Mã hoá / giải mã gói dữ liệu chuyển máy (đơn hàng, tài khoản DropBuy, khoá tunnel…) để gửi qua kênh không tin cậy
 * (vd bản phát hành nháp trên GitHub). AES-256-GCM, khoá dẫn xuất từ mật khẩu bằng scrypt.
 *
 *   node scripts/bundle-crypt.js encrypt <vao.zip> <ra.hmenc>     mật khẩu lấy từ biến môi trường BUNDLE_PASS
 *   node scripts/bundle-crypt.js decrypt <vao.hmenc> <ra.zip>
 *
 * Mật khẩu gửi riêng (không để cùng chỗ với file). Sai mật khẩu hoặc file bị sửa → báo lỗi, không ghi file ra.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');

const MAGIC = Buffer.from('HMB1');
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function keyFrom(pass, salt) {
  return crypto.scryptSync(pass, salt, 32, SCRYPT);
}

function encrypt(plain, pass) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(pass, salt), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

function decrypt(data, pass) {
  if (data.length < 48 || !data.subarray(0, 4).equals(MAGIC)) throw new Error('Không phải gói dữ liệu chuyển máy (sai định dạng).');
  const salt = data.subarray(4, 20);
  const iv = data.subarray(20, 32);
  const tag = data.subarray(32, 48);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(pass, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data.subarray(48)), decipher.final()]);
  } catch {
    throw new Error('Sai mật khẩu hoặc file đã bị hỏng/sửa.');
  }
}

module.exports = { encrypt, decrypt };

if (require.main === module) {
  const [mode, input, output] = process.argv.slice(2);
  const pass = process.env.BUNDLE_PASS || '';
  try {
    if (!['encrypt', 'decrypt'].includes(mode) || !input || !output) throw new Error('Cách dùng: node scripts/bundle-crypt.js encrypt|decrypt <vào> <ra>  (mật khẩu trong biến BUNDLE_PASS)');
    if (pass.length < 16) throw new Error('Thiếu mật khẩu: đặt biến môi trường BUNDLE_PASS (ít nhất 16 ký tự).');
    const data = fs.readFileSync(input);
    const out = mode === 'encrypt' ? encrypt(data, pass) : decrypt(data, pass);
    fs.writeFileSync(output, out);
    console.log(`${mode === 'encrypt' ? 'Đã mã hoá' : 'Đã giải mã'}: ${output} (${(out.length / 1048576).toFixed(1)} MB)`);
  } catch (e) {
    console.error('Lỗi:', e.message);
    process.exit(1);
  }
}
