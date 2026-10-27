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

  test('publicProduct che giấu hoàn toàn thông tin giá vốn, kho và ảnh nguồn trong variants', () => {
    const { publicProduct } = require('../server');
    const mockProduct = {
      id: 141328,
      name: 'Bàn là hơi nước mini cầm tay Bizond / STMR-010116 DropBuy',
      price: 298000,
      original_price: 799000,
      shop_id: 10426,
      depot_code: 'DP-10426-9542-11431',
      dropbuy_cost: 259000,
      profit_margin: 39000,
      pricing_rule: '% mặc định',
      image: 'https://r6i.pen.dropbuy.vn/md/s-10426/p-141328/img.png',
      image_hd: 'https://r6i.pen.dropbuy.vn/md/s-10426/p-141328/img_hd.png',
      warranty: 'Bảo hành DropBuy 3 tháng',
      _normName: 'ban la',
      _normBrand: '',
      _normSku: 's10426-141328',
      _hay: 'ban la hoi nuoc',
      _tokens: {},
      variants: [
        {
          id: '9a07acaf-292f-4952-a589-f1406e74c5d8',
          product_id: 141328,
          sku: 'S10426-141328-150625',
          name: 'Tiêu chuẩn DropBuy',
          is_default: true,
          in_stock: true,
          price: 298000,
          original_price: 799000,
          dealer_price: 240000,
          supplier_cost: 230000,
          dropbuy_cost: 259000,
          pricing_rule: '% mặc định',
          profit_margin: 39000,
          shop_id: 10426,
          depot_code: 'DP-10426-9542-11431',
          weight_gram: 500,
          warranty: 'Bảo hành DropBuy 3 tháng',
          image: 'https://r6i.pen.dropbuy.vn/md/s-10426/p-141328/variant.png',
          image_hd: 'https://r6i.pen.dropbuy.vn/md/s-10426/p-141328/variant_hd.png'
        }
      ]
    };

    const pub = publicProduct(mockProduct);
    const jsonStr = JSON.stringify(pub);

    // Không chứa các từ khóa nguồn nhạy cảm
    assert.doesNotMatch(jsonStr, SUPPLIER_RE);
    assert.doesNotMatch(jsonStr, /r6i\.pen|r6s\.pen|dropbuy/i);

    // Thuộc tính nhạy cảm phải bị loại bỏ ở cả cấp gốc và variants
    assert.equal('dropbuy_cost' in pub, false);
    assert.equal('profit_margin' in pub, false);
    assert.equal('dealer_price' in pub, false);
    assert.equal('supplier_cost' in pub, false);
    assert.equal('shop_id' in pub, false);
    assert.equal('depot_code' in pub, false);
    assert.equal('_normName' in pub, false);
    assert.equal('_tokens' in pub, false);

    assert.ok(Array.isArray(pub.variants) && pub.variants.length === 1);
    const v = pub.variants[0];
    assert.equal('dropbuy_cost' in v, false);
    assert.equal('profit_margin' in v, false);
    assert.equal('dealer_price' in v, false);
    assert.equal('supplier_cost' in v, false);
    assert.equal('pricing_rule' in v, false);
    assert.equal('shop_id' in v, false);
    assert.equal('depot_code' in v, false);

    // Ảnh phải được mask sang /cdn/
    assert.match(pub.image, /^\/cdn\/md\//);
    assert.match(v.image, /^\/cdn\/md\//);
    assert.match(v.image_hd, /^\/cdn\/md\//);

    // Tên và bảo hành phải được làm sạch câu chữ nhà cung cấp
    assert.doesNotMatch(pub.name, /DropBuy/i);
    assert.doesNotMatch(pub.warranty, /DropBuy/i);
    assert.doesNotMatch(v.name, /DropBuy/i);
    assert.doesNotMatch(v.warranty, /DropBuy/i);
  });

  test('Cú pháp JavaScript của server.js và admin.js hợp lệ 100%', () => {
    for (const rel of ['server.js', 'public/admin.js', 'public/app.js']) {
      const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.doesNotThrow(() => new Script(code, { filename: rel }));
    }
  });
});

describe('Ảnh nguồn sỉ khác đi qua /cdn của cửa hàng', () => {
  const { maskMediaUrl, maskMediaHtml } = require('../services/catalogImage');
  const { stripSupplierText } = require('../services/security');

  test('ảnh SP, gallery, ảnh mô tả không còn host nguồn', () => {
    assert.equal(maskMediaUrl('https://product.hstatic.net/200000567141/product/a_b_large.jpg?v=3'), '/cdn/p1/200000567141/product/a_b_large.jpg');
    assert.equal(maskMediaUrl('https://cdn.hstatic.net/products/1000152881/x_medium.jpg'), '/cdn/p2/products/1000152881/x_medium.jpg');
    assert.equal(maskMediaUrl('https://techmall.vn/wp-content/uploads/2024/01/baseus.jpg'), '/cdn/p4/2024/01/baseus.jpg');
    const html = '<p>Giới thiệu từ TechMall.vn</p><img src="https://file.hstatic.net/1000152881/file/moon-16_9a73.jpg"><a href="https://techmall.vn/san-pham/x/">xem</a>';
    const out = stripSupplierText(maskMediaHtml(html));
    assert.match(out, /<img src="\/cdn\/p3\/1000152881\/file\/moon-16_9a73\.jpg">/);
    assert.doesNotMatch(out, /techmall|hstatic/i);
  });

  test('đường dẫn /cdn lạ bị từ chối, không thành proxy mở', async () => {
    const { mediaFromCdnPath } = require('../services/catalogImage');
    assert.equal(await mediaFromCdnPath('p9/a.jpg'), null);
    assert.equal(await mediaFromCdnPath('p1/../../etc/passwd'), null);
    assert.equal(await mediaFromCdnPath('p1/a.jpg?x=https://evil.example'), null);
  });
});
