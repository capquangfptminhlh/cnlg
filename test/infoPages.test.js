'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const info = require('../services/infoPages');

const base = 'https://besi.com.vn';
const stats = { products: 20105, categories: 115, brands: 240 };
const ldOf = html => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];

test('chính sách chủ shop đã chốt: đổi trả 7 ngày, shop chịu phí khi lỗi, không nhận đổi ý', () => {
  assert.deepEqual(info.POLICY, { returnDays: 7, returnShippingByShop: true, changeOfMind: false, warranty: 'per-product' });
  const html = info.renderInfoPage({ slug: 'chinh-sach-doi-tra', base, cfg: {}, stats });
  assert.match(html, /<h1>Chính sách đổi trả 7 ngày<\/h1>/);
  assert.match(html, /Cửa hàng chịu phí vận chuyển/);
  assert.match(html, /Đổi ý khi sản phẩm không lỗi/);
  const rp = ldOf(html).find(x => x['@type'] === 'MerchantReturnPolicy');
  assert.equal(rp.merchantReturnDays, 7);
  assert.equal(rp.itemDefectReturnFees, 'https://schema.org/FreeReturn');
  assert.equal(rp.returnPolicyCategory, 'https://schema.org/MerchantReturnFiniteReturnWindow');
});

test('8 trang đều có H1, canonical, mô tả, JSON-LD; FAQ có câu hỏi + câu trả lời', () => {
  assert.equal(info.SLUGS.length, 8);
  for (const slug of info.SLUGS) {
    const html = info.renderInfoPage({ slug, base, cfg: {}, stats });
    assert.equal((html.match(/<h1>/g) || []).length, 1, slug);
    assert.match(html, new RegExp(`<link rel="canonical" href="${base}/${slug}">`), slug);
    assert.match(html, /<meta name="description" content="[^"]{40,}">/, slug);
    const graph = ldOf(html);
    assert.ok(graph.some(x => x['@type'] === 'Organization'), slug);
    assert.ok(graph.some(x => x['@type'] === 'BreadcrumbList'), slug);
  }
  const faq = ldOf(info.renderInfoPage({ slug: 'cau-hoi-thuong-gap', base, cfg: {}, stats })).find(x => x['@type'] === 'FAQPage');
  assert.equal(faq.mainEntity.length, 12);
  for (const q of faq.mainEntity) {
    assert.equal(q['@type'], 'Question');
    assert.ok(q.acceptedAnswer.text.length > 30);
    assert.ok(!/<[a-z]/i.test(q.acceptedAnswer.text)); // câu trả lời dạng chữ thường, không có thẻ HTML
  }
  assert.equal(info.renderInfoPage({ slug: 'khong-co', base, cfg: {}, stats }), null);
});

test('không bịa thông tin liên hệ: chưa điền thì không hiện SĐT / MST / địa chỉ', () => {
  const cfg = { store: { hotline: '1900 6868', address: 'Hà Nội, Việt Nam' } }; // số mẫu cũ trong cấu hình
  for (const slug of info.SLUGS) {
    const html = info.renderInfoPage({ slug, base, cfg, stats });
    assert.doesNotMatch(html, /1900 ?6868/, slug);
  }
  const contact = info.renderInfoPage({ slug: 'lien-he', base, cfg: {}, stats });
  assert.match(contact, /Thông tin liên hệ đang được cập nhật/);
  const org = info.organizationLd(base, {});
  assert.equal(org.telephone, undefined);
  assert.equal(org.address, undefined);
  assert.equal(org.taxID, undefined);
});

test('thông tin admin điền: kiểm tra định dạng, chuẩn hoá SĐT, hiện đúng nơi', () => {
  assert.throws(() => info.normalizeStoreInfo({ taxId: '123' }), /Mã số thuế/);
  assert.throws(() => info.normalizeStoreInfo({ hotline: '12345' }), /hotline/);
  assert.throws(() => info.normalizeStoreInfo({ email: 'abc' }), /Email/);
  assert.throws(() => info.normalizeStoreInfo({ facebook: 'javascript:alert(1)' }), /Facebook/);
  assert.throws(() => info.normalizeStoreInfo({ address: 'x'.repeat(300) }), /quá dài/);
  const v = info.normalizeStoreInfo({ legalName: ' Hộ KD  Hoàng Minh ', taxId: '0101234567', hotline: '0912 345 678', zalo: '+84912345678', email: 'a@b.vn', facebook: 'https://facebook.com/besi', unknown: 'bỏ qua' });
  assert.equal(v.legalName, 'Hộ KD Hoàng Minh');
  assert.equal(v.hotline, '0912345678');
  assert.equal(v.zalo, '0912345678');
  assert.equal(v.unknown, undefined);

  const cfg = { storeInfo: v };
  const org = info.organizationLd(base, cfg);
  assert.equal(org.legalName, 'Hộ KD Hoàng Minh');
  assert.equal(org.taxID, '0101234567');
  assert.equal(org.telephone, '0912345678');
  assert.deepEqual(org.sameAs, ['https://facebook.com/besi', 'https://zalo.me/0912345678']);
  const contact = info.renderInfoPage({ slug: 'lien-he', base, cfg, stats });
  assert.match(contact, /href="tel:0912345678"/);
  assert.match(contact, /0912 345 678/);
  const llms = info.llmsTxt({ base, cfg, stats, categories: [{ id: 1, name: 'Điện thoại & phụ kiện', product_count: 4105 }], brands: [{ name: 'Baseus' }] });
  assert.match(llms, /^# BESI/);
  assert.match(llms, /Hotline: 0912 345 678/);
  assert.match(llms, /\(https:\/\/besi\.com\.vn\/danh-muc\/1-dien-thoai-phu-kien\): 4\.105 sản phẩm/);
  assert.match(llms, /Đơn vị vận hành: Hộ KD Hoàng Minh \(MST 0101234567\)/);
});

test('hỏi đáp nhanh trên trang SP: bảo hành của chính SP + link chính sách', () => {
  const html = info.productQaHtml({ warranty: 'Bảo hành 12 tháng' }, {});
  assert.match(html, /Bảo hành 12 tháng/);
  assert.match(html, /href="\/chinh-sach-doi-tra"/);
  assert.match(html, /7 ngày/);
});
