'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.HM_PRODUCT_COPY_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hm-copy-')), 'product-copy.json');
const copy = require('../services/productCopy');
const { sanitizeHtml } = require('../services/security');

test('mô tả riêng: bản soạn sẵn luôn là nháp; chỉ bản đã duyệt mới ghép vào trang', () => {
  const seed = JSON.parse(fs.readFileSync(copy.SEED_FILE, 'utf8'));
  for (const id of Object.keys(seed)) {
    assert.equal(copy.all()[id].status, 'draft', `SP ${id} phải ở trạng thái nháp`);
    assert.equal(copy.published(id), null);
    assert.ok(String(seed[id].html || '').length > 200, `SP ${id}: mô tả quá ngắn`);
    assert.doesNotMatch(JSON.stringify(seed[id]), /drop\s*buy|techmall|tổng kho dropbuy/i, `SP ${id}: không nhắc tên nguồn hàng`);
  }
});

test('lưu: làm sạch HTML, chặn bản quá ngắn khi đăng, ẩn được, ghép trước thông số gốc', () => {
  assert.throws(() => copy.save(999001, { html: '<p>ngắn</p>', status: 'published' }, sanitizeHtml), /quá ngắn/);
  assert.throws(() => copy.save(999001, { html: 'x', status: 'xyz' }, sanitizeHtml), /Trạng thái/);
  const html = '<p>Sạc nhanh, gọn nhẹ, phù hợp mang theo khi đi làm. Cáp liền giúp không phải mang thêm dây. Có đèn báo dung lượng pin còn lại.</p><script>alert(1)</script>';
  const c = copy.save(999001, { html, summary: '  Sạc dự phòng   gọn nhẹ ', status: 'published', name: 'SDP' }, sanitizeHtml);
  assert.equal(c.status, 'published');
  assert.doesNotMatch(c.html, /<script/);
  assert.equal(c.summary, 'Sạc dự phòng gọn nhẹ');
  const out = copy.compose(copy.published(999001), '<p>Thông số gốc</p>');
  assert.ok(out.indexOf('besi-copy') < out.indexOf('Thông số gốc'));
  assert.match(out, /Thông số &amp; mô tả từ nhà sản xuất/);
  copy.save(999001, { status: 'hidden' }, sanitizeHtml);
  assert.equal(copy.published(999001), null);
});
