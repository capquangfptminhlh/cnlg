const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// File tạm – không đụng data/ thật
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-vault-'));
process.env.HM_CRED_FILE = path.join(tmp, 'cred.json');
process.env.HM_CRED_KEY_FILE = path.join(tmp, 'cred.key');
process.env.HM_ORDERS_FILE = path.join(tmp, 'orders.json');

const vault = require('../services/credentialVault');
const dropbuyAuth = require('../services/dropbuyAuth');
const dropbuySession = require('../services/dropbuySession');
const scraper = require('../services/dropbuyScraper');
const watchdog = require('../services/dropbuyWatchdog');

scraper.getConfig = () => ({ dropbuy: { cookieHeader: 'x=1' }, autoOrder: { enabled: false } });

test('Vault: mã hoá, đọc lại đúng; file không chứa mật khẩu rõ; sửa file → không đọc được', () => {
  vault.save('shop@example.com', 'mat-khau-rat-bi-mat');
  const raw = fs.readFileSync(process.env.HM_CRED_FILE, 'utf8');
  assert.ok(!raw.includes('mat-khau-rat-bi-mat'));
  assert.deepEqual(vault.load(), { username: 'shop@example.com', password: 'mat-khau-rat-bi-mat' });
  assert.equal(vault.info().saved, true);
  assert.equal(vault.info().username, 'shop@example.com');
  const rec = JSON.parse(raw);
  rec.data = Buffer.from('gia-mao').toString('base64');
  fs.writeFileSync(process.env.HM_CRED_FILE, JSON.stringify(rec));
  assert.equal(vault.load(), null);
  vault.clear();
  assert.equal(vault.info().saved, false);
});

test('Tự đăng nhập lại: chỉ khi phiên hết/sắp hết, giãn cách 30 phút, dừng khi sai mật khẩu', async () => {
  vault.save('shop@example.com', 'pw');
  let calls = 0;
  let mode = 'ok';
  dropbuyAuth.loginDropbuy = async () => {
    calls++;
    if (mode === 'wrong') throw new Error('Sai mật khẩu DropBuy.');
    return { success: true };
  };
  dropbuySession.ensureSession = async () => ({ sid: 's', expiresAt: new Date(Date.now() + 86400e3).toISOString() });

  // phiên còn dài → không đăng nhập
  assert.equal(await watchdog.maybeRelogin(null, { expiresAt: new Date(Date.now() + 86400e3).toISOString() }), null);
  assert.equal(calls, 0);

  // phiên còn 1 giờ → đăng nhập lại
  const s = await watchdog.maybeRelogin(null, { expiresAt: new Date(Date.now() + 3600e3).toISOString() });
  assert.equal(calls, 1);
  assert.ok(s?.sid);

  // gọi lại ngay → không thử dồn dập
  await watchdog.maybeRelogin(null, null);
  assert.equal(calls, 1);

  // sai mật khẩu → dừng hẳn, kể cả khi ép thử
  mode = 'wrong';
  await watchdog.maybeRelogin(null, null, { force: true });
  assert.equal(calls, 2);
  await watchdog.maybeRelogin(null, null, { force: true });
  assert.equal(calls, 2);
  assert.equal(watchdog.getState().relogin.stopped, true);

  // chủ shop đăng nhập tay → mở lại
  watchdog.resetRelogin();
  mode = 'ok';
  await watchdog.maybeRelogin(null, null, { force: true });
  assert.equal(calls, 3);

  // chưa lưu tài khoản → không làm gì
  vault.clear();
  await watchdog.maybeRelogin(null, null, { force: true });
  assert.equal(calls, 3);
});
