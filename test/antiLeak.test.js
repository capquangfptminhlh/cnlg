'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Script } = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SUPPLIER_RE = /drop\s*buy|r6[is]\.pen|\bfoxing\b|\bdalon\b|fs_program_code|dropbuy_cost|wholesale_price|dropbuyOrderId|qrDbCode/i;
const ADMIN_GATED_FILES = new Set(['admin.html', 'admin.js', 'admin-portal.css', 'admin-theme.css']);

describe('Chống lộ nguồn hàng & Bảo mật (Anti-Leak)', () => {
  test('Toàn bộ tài nguyên tĩnh công khai trong public/ tuyệt đối không chứa từ khoá nguồn cung cấp', () => {
    const pubDir = path.join(ROOT, 'public');
    const walk = dir => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === 'images') continue;
          walk(full);
          continue;
        }
        if (ADMIN_GATED_FILES.has(ent.name.toLowerCase())) continue;
        if (!/\.(html|js|css|svg|json|txt|xml|webmanifest)$/i.test(ent.name)) continue;
        const content = fs.readFileSync(full, 'utf8');
        const match = content.match(SUPPLIER_RE);
        assert.equal(match, null, `Phát hiện rò rỉ "${match?.[0]}" trong file công khai ${path.relative(ROOT, full)}`);
      }
    };
    walk(pubDir);
  });

  test('Cổng đăng nhập quản trị (renderAdminLoginGate) không lộ nguồn hàng hay đường dẫn nội bộ', () => {
    const { renderAdminLoginGate } = require('../services/security');
    const html = renderAdminLoginGate('Hoàng Minh Store');
    assert.doesNotMatch(html, /drop\s*buy|r6[is]\.pen|ctv|giá\s*sỉ|admin-secret|\.env/i);
    assert.match(html, /noindex,\s*nofollow,\s*noarchive/i);
    assert.match(html, /\/api\/admin\/session/);
  });

  test('robots.txt không quảng cáo đường dẫn /admin.html và trang SEO sản phẩm lọc sạch tên/ảnh nguồn', () => {
    const seo = require('../services/seo');
    const fakeReq = { protocol: 'https', socket: { remoteAddress: '127.0.0.1' }, get: h => (h.toLowerCase() === 'host' ? 'besi.com.vn' : '') };
    const robots = seo.robotsTxt(fakeReq);
    assert.doesNotMatch(robots, /admin/i);
    assert.doesNotMatch(robots, SUPPLIER_RE);

    const html = seo.renderProductPage(
      fakeReq,
      { id: 141095, name: 'Pin AAA Philips', slug: 'pin-aaa', sku: 'SKU1', price: 25000, image: 'https://r6i.pen.dropbuy.vn/md/s-1/p-141095/img.jpg', image_hd: 'https://dropbuy.vn/d/logo.png', in_stock: true },
      { description: '<p>Phân phối từ kho tổng DropBuy.vn chính hãng https://dropbuy.vn/sp_p141095</p>' },
      { store: { name: 'Hoàng Minh Store' } }
    );
    assert.doesNotMatch(html, SUPPLIER_RE);
  });

  test('maskMediaUrl & maskMediaHtml che giấu cả CDN r6i/r6s lẫn ảnh fallback dropbuy.vn', () => {
    const { maskMediaUrl, maskMediaHtml } = require('../services/catalogImage');
    assert.equal(maskMediaUrl('https://r6i.pen.dropbuy.vn/md/s-1/p-10/a.jpg'), '/cdn/md/s-1/p-10/a.jpg');
    assert.equal(maskMediaUrl('https://r6s.pen.dropbuy.vn/md2/s-2/p-20/b.webp'), '/cdn/md2/s-2/p-20/b.webp');
    assert.equal(maskMediaUrl('https://dropbuy.vn/d/logo.png'), '/logo.svg');
    const html = maskMediaHtml('<img src="https://r6i.pen.dropbuy.vn/md/s-1/p-10/a.jpg"><img src="https://dropbuy.vn/d/logo.png">');
    assert.doesNotMatch(html, SUPPLIER_RE);
    assert.match(html, /\/cdn\/md\/s-1\/p-10\/a\.jpg/);
    assert.match(html, /\/logo\.svg/);
  });

  test('realtimeSync.publicPatch & getPublicSyncStatus không lộ URL CDN nguồn, giá vốn hay thông báo lỗi nội bộ', () => {
    const { publicPatch, getPublicSyncStatus } = require('../services/realtimeSync');
    const patch = publicPatch({
      id: 99,
      name: 'Tai nghe Bluetooth',
      price: 150000,
      original_price: 2000000, // giảm > 70% → phải ẩn original_price
      dropbuy_cost: 95000,
      wholesale_price: 95000,
      fs_program_code: 'FS_SECRET',
      shop_name: 'Kho Nội Bộ',
      dropbuy_url: 'https://dropbuy.vn/sp_p99',
      image: 'https://r6i.pen.dropbuy.vn/md/s-1/p-99/main.jpg',
      in_stock: true,
      category_id: 3,
      variant_count: 2
    });
    assert.equal(patch.image, '/cdn/md/s-1/p-99/main.jpg');
    assert.equal(patch.original_price, null);
    assert.equal(patch.discount_percent, 0);
    assert.equal('dropbuy_cost' in patch, false);
    assert.equal('wholesale_price' in patch, false);
    assert.equal('fs_program_code' in patch, false);
    assert.equal('shop_name' in patch, false);
    assert.doesNotMatch(JSON.stringify(patch), SUPPLIER_RE);

    const status = getPublicSyncStatus();
    assert.equal('lastError' in status, false);
    assert.equal('lastError' in status.stock, false);
    assert.equal('lastError' in status.price, false);
    assert.doesNotMatch(JSON.stringify(status), SUPPLIER_RE);
  });

  test('stripSupplierText làm sạch hoàn toàn câu chữ có chứa DropBuy / URL nguồn', () => {
    const { stripSupplierText } = require('../services/security');
    const samples = [
      'Bảo hành chính hãng DropBuy 6 tháng',
      'Sản phẩm chính hãng chất lượng cao phân phối từ kho tổng DropBuy.vn.',
      '"Pin AAA" vừa hết hàng trên kho DropBuy.',
      'Xem tại https://dropbuy.vn/pin-aaa_p141095 hoặc https://r6i.pen.dropbuy.vn/md/s-1/x.jpg foxing dalon'
    ];
    for (const s of samples) {
      const cleaned = stripSupplierText(s);
      assert.doesNotMatch(cleaned, SUPPLIER_RE, `Còn sót từ khoá trong: ${cleaned}`);
    }
  });

  test('Phiên quản trị Cookie HttpOnly chặn CSRF khác nguồn và emitAdmin cô lập phòng admins', () => {
    const { ADMIN_COOKIE_NAME, adminSessionToken, isAdminRequest, emitAdmin, getAdminPassword } = require('../services/security');
    const validCookie = `${ADMIN_COOKIE_NAME}=${adminSessionToken()}`;
    const mkReq = (method, headers) => ({
      method,
      headers,
      get: h => headers[h.toLowerCase()] || ''
    });

    assert.equal(isAdminRequest(mkReq('GET', {})), false);
    assert.equal(isAdminRequest(mkReq('GET', { 'x-admin-key': getAdminPassword() })), true);
    assert.equal(isAdminRequest(mkReq('GET', { 'x-admin-key': 'wrong', cookie: validCookie })), false);
    assert.equal(isAdminRequest(mkReq('GET', { cookie: validCookie, host: 'besi.com.vn' })), true);
    assert.equal(isAdminRequest(mkReq('POST', { cookie: validCookie, host: 'besi.com.vn', origin: 'https://besi.com.vn' })), true);
    assert.equal(isAdminRequest(mkReq('POST', { cookie: validCookie, host: 'besi.com.vn', origin: 'https://evil.example' })), false);

    const roomEvents = [];
    let globalCalled = false;
    const realLikeIo = {
      sockets: {},
      to(room) {
        return { emit(ev, payload) { roomEvents.push({ room, ev, payload }); } };
      },
      emit() { globalCalled = true; }
    };
    emitAdmin(realLikeIo, 'ADMIN_ORDER_CHANGED', { orderId: 'HM12345678' });
    assert.equal(globalCalled, false, 'Không được phát io.emit toàn cục khi có io.sockets');
    assert.equal(roomEvents.length, 1);
    assert.equal(roomEvents[0].room, 'admins');
  });

  test('Cú pháp JavaScript của server.js và admin.js hợp lệ 100%', () => {
    for (const rel of ['server.js', 'public/admin.js', 'public/app.js']) {
      const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.doesNotThrow(() => new Script(code, { filename: rel }));
    }
  });
});
