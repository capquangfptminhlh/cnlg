'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const eta = require('../services/deliveryEta');

// 10:00 giờ VN thứ 5 29/10/2026 (trước giờ chốt kho)
const MORNING = Date.parse('2026-10-29T03:00:00Z');
// 17:00 giờ VN cùng ngày (sau giờ chốt → +1 ngày)
const EVENING = Date.parse('2026-10-29T10:00:00Z');

test('thời gian vận chuyển theo tỉnh kho → tỉnh nhận', () => {
  assert.deepEqual(eta.transitDays('Thành phố Hà Nội', 'Hà Nội'), [1, 2]);
  assert.deepEqual(eta.transitDays('Hà Nội', 'Hải Phòng'), [2, 3]);
  assert.deepEqual(eta.transitDays('Hà Nội', 'Đà Nẵng'), [3, 4]);
  assert.deepEqual(eta.transitDays('Hà Nội', 'TP. Hồ Chí Minh'), [3, 5]);
  assert.deepEqual(eta.transitDays(null, 'Hà Nội'), [2, 5]);
});

test('ngày giao dự kiến tính theo giờ Việt Nam và giờ chốt đơn của kho', () => {
  const a = eta.estimate({ fromProvince: 'Thành phố Hồ Chí Minh', toProvince: 'TP. Hồ Chí Minh', now: MORNING });
  assert.equal(a.text, 'Dự kiến giao Thứ 6 30/10 – Thứ 7 31/10');
  const b = eta.estimate({ fromProvince: 'Thành phố Hồ Chí Minh', toProvince: 'TP. Hồ Chí Minh', now: EVENING });
  assert.equal(b.text, 'Dự kiến giao Thứ 7 31/10 – CN 01/11');
  assert.equal(b.known_origin, true);
  assert.equal(eta.estimate({ toProvince: 'Hà Nội', now: MORNING }).known_origin, false);
});

test('nhiều kiện: báo ngày nhận đủ theo kiện chậm nhất', () => {
  const near = eta.estimate({ fromProvince: 'Hà Nội', toProvince: 'Hà Nội', now: MORNING });
  const far = eta.estimate({ fromProvince: 'TP. Hồ Chí Minh', toProvince: 'Hà Nội', now: MORNING });
  const all = eta.combine([near, far]);
  assert.equal(all.max_days, far.max_days);
  assert.match(all.text, /^Dự kiến nhận đủ hàng /);
  assert.equal(eta.combine([near]), near);
  assert.equal(eta.combine([]), null);
});

test('hành trình vận đơn → trạng thái mới nhất + ngày giao dự kiến của hãng', () => {
  const t = eta.fromJourneys([
    { order_statusdate: '29/10/2026 15:00:00', status_name: 'Đang vận chuyển', location_currently: 'Kho trung chuyển' },
    { order_statusdate: '29/10/2026 09:10:00', status_name: 'Đã lấy hàng', location_currently: 'Bưu cục gửi', expected_delivery: '31/10/2026 18:00:00' }
  ]);
  assert.equal(t.status, 'Đang vận chuyển');
  assert.equal(t.location, 'Kho trung chuyển');
  assert.equal(t.expected_delivery, '31/10/2026 18:00:00');
  assert.equal(t.expected_at, '2026-10-31T11:00:00.000Z');
  assert.equal(eta.fromJourneys([]), null);
  assert.equal(eta.fromJourneys(undefined), null);
});
