/**
 * Phí vận chuyển tính cho khách (cấu hình trong admin, lưu ở config.shipping).
 *
 * config.shipping = {
 *   enabled: true,
 *   fees: { north: 25000, central: 35000, south: 30000 },  // phí cơ bản theo miền của tỉnh nhận
 *   includedWeightGram: 1000,     // khối lượng đã gồm trong phí cơ bản
 *   perExtraKg: 5000,             // phụ phí mỗi kg (hoặc phần lẻ) vượt mức
 *   freeShipThreshold: 500000,    // đơn từ mức này được miễn phí ship (0 = tắt)
 *   defaultWeightGram: 500        // khối lượng giả định khi chưa biết khối lượng SP
 * }
 */

// 34 tỉnh/thành theo đơn vị hành chính mới (hiệu lực 01/07/2025), chia 3 miền để tính phí
const PROVINCES = [
  ['Hà Nội', 'north'], ['Hải Phòng', 'north'], ['Quảng Ninh', 'north'], ['Bắc Ninh', 'north'], ['Hưng Yên', 'north'],
  ['Ninh Bình', 'north'], ['Phú Thọ', 'north'], ['Thái Nguyên', 'north'], ['Tuyên Quang', 'north'], ['Lào Cai', 'north'],
  ['Lạng Sơn', 'north'], ['Cao Bằng', 'north'], ['Điện Biên', 'north'], ['Lai Châu', 'north'], ['Sơn La', 'north'],
  ['Thanh Hóa', 'central'], ['Nghệ An', 'central'], ['Hà Tĩnh', 'central'], ['Quảng Trị', 'central'], ['Huế', 'central'],
  ['Đà Nẵng', 'central'], ['Quảng Ngãi', 'central'], ['Gia Lai', 'central'], ['Khánh Hòa', 'central'], ['Đắk Lắk', 'central'],
  ['Lâm Đồng', 'central'],
  ['TP. Hồ Chí Minh', 'south'], ['Đồng Nai', 'south'], ['Tây Ninh', 'south'], ['Cần Thơ', 'south'], ['Vĩnh Long', 'south'],
  ['Đồng Tháp', 'south'], ['An Giang', 'south'], ['Cà Mau', 'south']
];
const REGION_LABEL = { north: 'Miền Bắc', central: 'Miền Trung', south: 'Miền Nam' };

const DEFAULTS = { enabled: true, fees: { north: 25000, central: 35000, south: 30000 }, includedWeightGram: 1000, perExtraKg: 5000, freeShipThreshold: 500000, defaultWeightGram: 500 };

function n(v, def, min = 0) {
  const x = Number(v);
  return Number.isFinite(x) && x >= min ? x : def;
}

function normalizeShipping(raw = {}) {
  const r = { ...DEFAULTS, ...raw, fees: { ...DEFAULTS.fees, ...(raw.fees || {}) } };
  return {
    enabled: r.enabled !== false,
    fees: { north: n(r.fees.north, DEFAULTS.fees.north), central: n(r.fees.central, DEFAULTS.fees.central), south: n(r.fees.south, DEFAULTS.fees.south) },
    includedWeightGram: n(r.includedWeightGram, DEFAULTS.includedWeightGram, 1),
    perExtraKg: n(r.perExtraKg, DEFAULTS.perExtraKg),
    freeShipThreshold: n(r.freeShipThreshold, DEFAULTS.freeShipThreshold),
    defaultWeightGram: n(r.defaultWeightGram, DEFAULTS.defaultWeightGram, 1)
  };
}

function regionOf(province) {
  const hit = PROVINCES.find(([name]) => name === province);
  return hit ? hit[1] : null;
}

/**
 * @param {{province:string, subtotal:number, lines:{quantity:number, weight_gram?:number}[]}} input
 * @returns {{fee:number, region:string, region_label:string, weight_gram:number, free_ship:boolean, detail:string}}
 */
function quote({ province, subtotal, lines }, rawRules) {
  const rules = normalizeShipping(rawRules);
  const region = regionOf(province);
  if (!region) throw new Error('Vui lòng chọn Tỉnh/Thành phố nhận hàng hợp lệ.');
  const weight = lines.reduce((s, l) => s + (Number(l.weight_gram) > 0 ? Number(l.weight_gram) : rules.defaultWeightGram) * l.quantity, 0);
  if (!rules.enabled) return { fee: 0, region, region_label: REGION_LABEL[region], weight_gram: weight, free_ship: true, detail: 'Miễn phí vận chuyển' };
  if (rules.freeShipThreshold > 0 && subtotal >= rules.freeShipThreshold) {
    return { fee: 0, region, region_label: REGION_LABEL[region], weight_gram: weight, free_ship: true, detail: `Miễn phí ship cho đơn từ ${rules.freeShipThreshold.toLocaleString('vi-VN')} đ` };
  }
  const extraKg = Math.max(0, Math.ceil((weight - rules.includedWeightGram) / 1000));
  const fee = rules.fees[region] + extraKg * rules.perExtraKg;
  const detail = `${REGION_LABEL[region]} ${rules.fees[region].toLocaleString('vi-VN')} đ${extraKg ? ` + ${extraKg} kg vượt mức × ${rules.perExtraKg.toLocaleString('vi-VN')} đ` : ''}`;
  return { fee, region, region_label: REGION_LABEL[region], weight_gram: weight, free_ship: false, detail };
}

module.exports = { PROVINCES, REGION_LABEL, DEFAULTS, normalizeShipping, regionOf, quote };
