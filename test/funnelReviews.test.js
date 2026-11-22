'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-fr-'));
process.env.HM_FUNNEL_FILE = path.join(tmp, 'funnel.json');
process.env.HM_REVIEWS_FILE = path.join(tmp, 'reviews.json');
const funnel = require('../services/funnel');
const reviews = require('../services/reviews');

test('phễu: đếm phiên khác nhau mỗi bước, bỏ bot / mã phiên sai / bước lạ, tính tỉ lệ', () => {
  const now = Date.parse('2026-11-22T05:00:00Z');
  const ua = 'Mozilla/5.0 (iPhone)';
  for (let i = 0; i < 10; i++) funnel.record('view', `sessaaaa${i}`, { userAgent: ua, now });
  for (let i = 0; i < 6; i++) funnel.record('product', `sessaaaa${i}`, { userAgent: ua, now });
  funnel.record('product', 'sessaaaa0', { userAgent: ua, now }); // cùng phiên xem SP lần 2
  for (let i = 0; i < 3; i++) funnel.record('cart', `sessaaaa${i}`, { userAgent: ua, now });
  funnel.record('checkout', 'sessaaaa0', { userAgent: ua, now });
  funnel.record('order', 'sessaaaa0', { userAgent: ua, now });
  assert.equal(funnel.record('view', 'botsessio1', { userAgent: 'Googlebot/2.1', now }), false);
  assert.equal(funnel.record('view', 'SAI MA', { userAgent: ua, now }), false);
  assert.equal(funnel.record('hack', 'sessaaaa1', { userAgent: ua, now }), false);
  const r = funnel.report({ days: 7, now });
  const by = Object.fromEntries(r.steps.map(s => [s.step, s]));
  assert.equal(by.view.sessions, 10);
  assert.equal(by.product.sessions, 6);
  assert.equal(by.product.events, 7);
  assert.equal(by.product.rate_from_prev, 60);
  assert.equal(by.cart.sessions, 3);
  assert.equal(by.order.sessions, 1);
  assert.equal(r.overall_rate, 10);
  funnel.save();
  const saved = JSON.parse(fs.readFileSync(process.env.HM_FUNNEL_FILE, 'utf8'));
  assert.equal(saved.days['2026-11-22'].sids.view.length, 10);
  assert.doesNotMatch(JSON.stringify(saved), /Mozilla|iPhone/); // không lưu thông tin trình duyệt
  funnel._reset(); // đọc lại từ file sau khởi động lại
  assert.equal(funnel.report({ days: 7, now }).steps[0].sessions, 10);
});

const order = (status, extra = {}) => ({
  id: 'HMREV00001', status, customer: { name: 'Nguyễn Văn Tuấn', phone: '0912345678' },
  items: [{ id: 101, name: 'Cáp sạc', quantity: 2 }, { id: 102, name: 'Tai nghe', quantity: 1 }, { id: 101, name: 'Cáp sạc', variant_name: '2m', quantity: 1 }], ...extra
});

test('đánh giá: chỉ đơn đã giao, mỗi SP 1 lần, chờ duyệt, tên che bớt, lọc HTML', () => {
  assert.throws(() => reviews.submit(order('PROCESSING'), [{ product_id: 101, rating: 5 }]), /đã giao/);
  assert.throws(() => reviews.submit(order('COMPLETED', { is_test: true }), [{ product_id: 101, rating: 5 }]), /đã giao/);
  assert.deepEqual(reviews.pendingItems(order('COMPLETED')).map(i => i.product_id), [101, 102]);
  assert.throws(() => reviews.submit(order('COMPLETED'), [{ product_id: 101, rating: 9 }]), /1 đến 5/);
  const created = reviews.submit(order('COMPLETED'), [
    { product_id: 101, rating: 5, comment: '<script>x</script>Rất tốt <b>nha</b>' },
    { product_id: 999, rating: 1, comment: 'SP không có trong đơn' }
  ]);
  assert.equal(created.length, 1);
  assert.equal(created[0].status, 'pending');
  assert.equal(created[0].name, 'Tuấn N.');
  assert.doesNotMatch(created[0].comment, /<|script/);
  assert.match(created[0].comment, /Rất tốt nha/);
  assert.deepEqual(reviews.pendingItems(order('COMPLETED')).map(i => i.product_id), [102]);
  assert.throws(() => reviews.submit(order('COMPLETED'), [{ product_id: 101, rating: 4 }]), /đã được đánh giá/);
  // chưa duyệt → chưa hiện
  assert.equal(reviews.forProduct([101]).count, 0);
  reviews.setStatus(created[0].id, 'approved');
  const pub = reviews.forProduct([101, 555]);
  assert.equal(pub.count, 1);
  assert.equal(pub.average, 5);
  assert.equal(pub.items[0].name, 'Tuấn N.');
  assert.equal(JSON.stringify(pub).includes('0912345678'), false); // không lộ SĐT
  assert.equal(reviews.maskName('Lan'), 'L***');
  assert.equal(reviews.maskName(''), 'Khách hàng');
});

test('số đã bán: chỉ đơn thật, không tính đơn huỷ / đơn thử / chờ thanh toán', () => {
  const m = reviews.soldCounts([
    order('COMPLETED'), order('PROCESSING'),
    order('CANCELLED'), order('COMPLETED', { is_test: true }), order('PENDING_PAYMENT')
  ]);
  assert.equal(m.get(101), 6); // (2 + 1) × 2 đơn
  assert.equal(m.get(102), 2);
});
