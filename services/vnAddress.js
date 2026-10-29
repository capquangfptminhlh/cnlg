const fs = require('fs');
const path = require('path');

/**
 * Danh mục tỉnh/phường mới (34 tỉnh, 2 cấp – không còn quận/huyện) theo đúng mã của DropBuy.
 * Nguồn công khai trên CDN của DropBuy; lưu bản sao ở data/address-v2.json, làm mới mỗi ngày.
 * Đơn dropship gửi DropBuy cần receiver_province_id + receiver_ward_id (district_id = 0).
 */
const CDN = 'https://r6s.pen.dropbuy.vn/dalon-web-public/address';
const CACHE_FILE = process.env.HM_ADDRESS_FILE || path.join(__dirname, '..', 'data', 'address-v2.json');
const MAX_AGE_MS = 24 * 3600 * 1000;

let mem = null; // { provinces: [{id,name}], wards: Map<provinceId, [{id,name}]>, byWard: Map<wardId, {...}>, loadedAt }

// So khớp tên tỉnh: bỏ dấu, bỏ "Thành phố / Tỉnh / TP."
function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/^(thanh pho|tinh|tp\.?)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function build(raw) {
  const provinces = (raw.provinces || []).map(p => ({ id: Number(p.PROVINCE_ID), name: p.PROVINCE_NAME }));
  const wards = new Map();
  const byWard = new Map();
  for (const w of raw.wards || []) {
    const item = { id: Number(w.WARDS_ID), name: w.WARDS_NAME, province_id: Number(w.PROVINCE_ID) };
    if (!wards.has(item.province_id)) wards.set(item.province_id, []);
    wards.get(item.province_id).push(item);
    byWard.set(item.id, item);
  }
  for (const list of wards.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  return { provinces, wards, byWard, loadedAt: raw.loadedAt || Date.now() };
}

async function download() {
  const get = async f => {
    const res = await fetch(`${CDN}/${f}`, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} khi tải ${f}`);
    return res.json();
  };
  const [p, w] = await Promise.all([get('provinces-v2.json'), get('wards-v2.json')]);
  if (!p?.provinces?.length || !w?.wards?.length) throw new Error('Danh mục địa chỉ DropBuy trống');
  const raw = { provinces: p.provinces, wards: w.wards, loadedAt: Date.now() };
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(`${CACHE_FILE}.tmp`, JSON.stringify(raw));
  fs.renameSync(`${CACHE_FILE}.tmp`, CACHE_FILE);
  return raw;
}

/** Danh mục đã nạp (tải lại khi cũ hơn 1 ngày; mạng lỗi thì dùng bản đã lưu) */
async function load() {
  if (mem && Date.now() - mem.loadedAt < MAX_AGE_MS) return mem;
  let raw = null;
  try {
    if (fs.existsSync(CACHE_FILE)) raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {}
  if (!raw || Date.now() - (raw.loadedAt || 0) > MAX_AGE_MS) {
    try {
      raw = await download();
    } catch (e) {
      if (!raw) throw e;
      console.warn('[Address] Không làm mới được danh mục, dùng bản đã lưu:', e.message);
    }
  }
  mem = build(raw);
  return mem;
}

/** Tỉnh DropBuy ứng với tên tỉnh trong form (vd "TP. Hồ Chí Minh" → {id: 2, name: "Thành phố Hồ Chí Minh"}) */
async function provinceByName(name) {
  const d = await load();
  const key = normName(name);
  return d.provinces.find(p => normName(p.name) === key) || null;
}

/** Tên tỉnh theo mã DropBuy (vd tỉnh của kho gửi). */
async function provinceById(id) {
  const d = await load();
  return d.provinces.find(p => p.id === Number(id))?.name || null;
}

async function wardsOfProvince(name) {
  const p = await provinceByName(name);
  if (!p) return null;
  const d = await load();
  return { province: p, wards: d.wards.get(p.id) || [] };
}

/** Kiểm tra phường thuộc đúng tỉnh. Trả về { province, ward } hoặc null. */
async function resolve(provinceName, wardId) {
  const p = await provinceByName(provinceName);
  if (!p) return null;
  const d = await load();
  const w = d.byWard.get(Number(wardId));
  if (!w || w.province_id !== p.id) return null;
  return { province: p, ward: w };
}

module.exports = { load, provinceByName, provinceById, wardsOfProvince, resolve, normName };
