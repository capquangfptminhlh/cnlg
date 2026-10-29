'use strict';
/**
 * Thời gian giao dự kiến cho khách.
 *  - TRƯỚC khi đặt: DropBuy chỉ báo phí (carts/get-shipping-fee không có ngày giao) → ước tính theo tỉnh KHO THẬT
 *    của từng kiện (DropBuy trả về lúc báo phí) → tỉnh nhận, cộng giờ chốt đơn của kho.
 *  - SAU khi đặt: hành trình vận đơn (orders/history → journeys) có `expected_delivery` của ĐVVC → dùng số thật.
 */
const shipping = require('./shipping');
const { normName } = require('./vnAddress');

const VN_OFFSET_MS = 7 * 3600e3;
const CUTOFF_HOUR = 16; // kho thường bàn giao ĐVVC trong ngày nếu đơn chốt trước 16h
const ADJACENT = { north: 'central', central: null, south: 'central' };
const WEEKDAY = ['CN', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];

const REGION_BY_NAME = new Map(shipping.PROVINCES.map(([name, region]) => [normName(name), region]));
const regionOf = name => (name ? REGION_BY_NAME.get(normName(name)) || null : null);

/** Số ngày vận chuyển [ít nhất, nhiều nhất] giữa 2 tỉnh (không tính ngày kho xử lý). */
function transitDays(fromProvince, toProvince) {
  const a = regionOf(fromProvince);
  const b = regionOf(toProvince);
  if (!a || !b) return [2, 5]; // chưa biết kho ở đâu
  if (normName(fromProvince) === normName(toProvince)) return [1, 2];
  if (a === b) return [2, 3];
  if (ADJACENT[a] === b || ADJACENT[b] === a) return [3, 4];
  return [3, 5]; // Bắc ↔ Nam
}

/** Ngày theo giờ Việt Nam, dạng "Thứ 6 31/10". */
function vnDay(ms) {
  const d = new Date(ms + VN_OFFSET_MS);
  return `${WEEKDAY[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * @param {{ fromProvince?: string|null, toProvince: string, now?: number }} p
 * @returns {{ min_days:number, max_days:number, from_date:string, to_date:string, text:string, known_origin:boolean }}
 */
function estimate({ fromProvince = null, toProvince, now = Date.now() }) {
  const [lo, hi] = transitDays(fromProvince, toProvince);
  const late = new Date(now + VN_OFFSET_MS).getUTCHours() >= CUTOFF_HOUR ? 1 : 0;
  const min = lo + late;
  const max = hi + late;
  const fromDate = vnDay(now + min * 86400e3);
  const toDate = vnDay(now + max * 86400e3);
  return {
    min_days: min, max_days: max, from_date: fromDate, to_date: toDate, known_origin: !!regionOf(fromProvince),
    text: min === max ? `Dự kiến giao ${fromDate}` : `Dự kiến giao ${fromDate} – ${toDate}`
  };
}

/** Gộp nhiều kiện: khách nhận đủ hàng khi kiện chậm nhất tới. */
function combine(etas) {
  const list = etas.filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const slow = list.reduce((a, b) => (b.max_days > a.max_days || (b.max_days === a.max_days && b.min_days > a.min_days) ? b : a));
  const min = Math.max(...list.map(e => e.min_days));
  const fromDate = list.find(e => e.min_days === min).from_date;
  return {
    min_days: min, max_days: slow.max_days, from_date: fromDate, to_date: slow.to_date, known_origin: list.every(e => e.known_origin),
    text: min === slow.max_days ? `Dự kiến nhận đủ hàng ${fromDate}` : `Dự kiến nhận đủ hàng ${fromDate} – ${slow.to_date}`
  };
}

/** "dd/MM/yyyy HH:mm:ss" (VTP) hoặc ISO → ISO; không đọc được thì null. */
function parseVnDate(s) {
  const str = String(s || '').trim();
  if (!str) return null;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const ms = Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - VN_OFFSET_MS;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const t = Date.parse(str);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Hành trình vận đơn DropBuy (VTP) → thông tin cho khách: trạng thái mới nhất, vị trí, ngày giao dự kiến của ĐVVC.
 * Trả null khi chưa có hành trình (kho chưa bàn giao ĐVVC).
 */
function fromJourneys(journeys) {
  const list = (Array.isArray(journeys) ? journeys : [])
    .map(j => ({ ...j, at: parseVnDate(j.order_statusdate) }))
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  if (!list.length) return null;
  const last = list[list.length - 1];
  const expected = [...list].reverse().map(j => j.expected_delivery).find(Boolean) || null;
  return {
    status: last.status_name || null,
    location: last.location_currently || null,
    updated_at: last.at,
    expected_delivery: expected ? String(expected).trim() : null,
    expected_at: expected ? parseVnDate(expected) : null
  };
}

module.exports = { estimate, combine, transitDays, fromJourneys, parseVnDate, regionOf, CUTOFF_HOUR };
