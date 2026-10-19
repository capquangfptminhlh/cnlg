// Kiểm tra kết nối tới các API DropBuy mà hoangminh.com đang dùng.
// Chạy: npm run test:dropbuy
require('dotenv').config();
const { checkDropbuy } = require('../services/dropbuyHealth');

(async () => {
  const r = await checkDropbuy();
  console.log(`\nDropBuy API – ${new Date(r.checked_at).toLocaleString('vi-VN')} – ${r.authenticated ? 'ĐÃ đăng nhập' : 'CHƯA đăng nhập'}\n`);
  for (const c of r.checks) {
    const mark = c.ok ? '✅' : c.required ? '❌' : '⚠️ ';
    console.log(`${mark} ${c.name.padEnd(42)} ${String(c.ms).padStart(5)}ms  ${c.detail}`);
  }
  console.log(`\nKết luận: ${r.ok ? 'các API bắt buộc đều hoạt động' : 'CÓ API BẮT BUỘC LỖI'}\n`);
  process.exit(r.ok ? 0 : 1);
})();
