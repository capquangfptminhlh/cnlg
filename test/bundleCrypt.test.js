const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { encrypt, decrypt } = require('../scripts/bundle-crypt');

test('Gói chuyển máy: mã hoá rồi giải mã ra đúng dữ liệu gốc', () => {
  const plain = crypto.randomBytes(200000);
  const enc = encrypt(plain, 'mat-khau-thu-dai-hon-16');
  assert.ok(!enc.includes(plain.subarray(0, 64)));
  assert.deepEqual(decrypt(enc, 'mat-khau-thu-dai-hon-16'), plain);
});

test('Gói chuyển máy: sai mật khẩu hoặc file bị sửa thì báo lỗi', () => {
  const enc = encrypt(Buffer.from('don hang'), 'mat-khau-thu-dai-hon-16');
  assert.throws(() => decrypt(enc, 'mat-khau-sai-dai-hon-16x'), /Sai mật khẩu/);
  const bad = Buffer.from(enc); bad[bad.length - 1] ^= 1;
  assert.throws(() => decrypt(bad, 'mat-khau-thu-dai-hon-16'), /Sai mật khẩu/);
  assert.throws(() => decrypt(Buffer.from('xx'), 'mat-khau-thu-dai-hon-16'), /sai định dạng/);
});
