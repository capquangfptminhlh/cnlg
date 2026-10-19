import { Decimal } from './db.js';

/**
 * Bảng phí ship mô phỏng (VTP/SPX): theo khối lượng quy đổi và nội/ngoại tỉnh.
 * Có thể thay bằng adapter gọi API đơn vị vận chuyển thật.
 */
export function shippingFee(opts: { weight_gram: number; from_province_id: number; to_province_id: number; method?: string; delivery_option?: string }) {
  const sameProvince = opts.from_province_id === opts.to_province_id;
  const base = sameProvince ? 18000 : 30000;
  const w = Math.max(0, opts.weight_gram);
  const extraSteps = w <= 500 ? 0 : Math.ceil((w - 500) / 500);
  const perStep = sameProvince ? 2500 : 5000;
  let fee = base + extraSteps * perStep;
  if (opts.method === 'S') fee = Math.round(fee * 0.95); // SPX rẻ hơn ~5%
  if (opts.delivery_option === 'X') fee = Math.round(fee * 1.5); // hoả tốc
  if (opts.method === 'T') fee = 0; // shop tự giao
  return new Decimal(fee);
}
