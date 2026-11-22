'use strict';
/**
 * Mô tả RIÊNG của BESI cho từng SP (khác mô tả chép từ nguồn – tốt cho SEO và cho khách đọc).
 *  - content/product-copy.json (trong repo): bản soạn sẵn, trạng thái "draft";
 *  - data/product-copy.json (máy chủ): bản chủ shop đã sửa / duyệt ("published") hoặc ẩn ("hidden").
 * Chỉ bản "published" hiện cho khách; mô tả gốc vẫn giữ bên dưới (thông số đầy đủ).
 * Mỗi mục: { id, name, summary (1–2 câu, dùng cho meta description), html, status, updated_at }
 */
const fs = require('fs');
const path = require('path');

const SEED_FILE = path.join(__dirname, '..', 'content', 'product-copy.json');
const DATA_FILE = () => process.env.HM_PRODUCT_COPY_FILE || path.join(__dirname, '..', 'data', 'product-copy.json');
const STATUSES = ['draft', 'published', 'hidden'];

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) { return {}; }
}
let cache = { key: '', map: {} };
function stamp(file) { try { return String(fs.statSync(file).mtimeMs); } catch (e) { return '-'; } }

/** Bản gộp: bản soạn sẵn + bản trên máy chủ (máy chủ thắng). */
function all() {
  const key = stamp(SEED_FILE) + '|' + stamp(DATA_FILE());
  if (cache.key === key) return cache.map;
  const seed = readJson(SEED_FILE);
  const data = readJson(DATA_FILE());
  const map = {};
  for (const [id, v] of Object.entries(seed)) map[id] = { ...v, id: Number(id), status: 'draft', source: 'seed' };
  for (const [id, v] of Object.entries(data)) map[id] = { ...(map[id] || {}), ...v, id: Number(id), source: 'shop' };
  cache = { key, map };
  return map;
}

const published = id => { const c = all()[String(id)]; return c && c.status === 'published' && c.html ? c : null; };

/** Mô tả hiển thị: phần riêng của BESI trước, thông số gốc phía sau. */
function compose(copy, originalHtml) {
  const orig = String(originalHtml || '').trim();
  return `<div class="besi-copy">${copy.html}</div>` + (orig ? `<h3 class="desc-origin-title">Thông số &amp; mô tả từ nhà sản xuất</h3>${orig}` : '');
}

/** Lưu bản chủ shop sửa / duyệt. sanitize: hàm làm sạch HTML của máy chủ (services/security.sanitizeHtml). */
function save(id, { html, summary, status, name }, sanitize) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Mã sản phẩm không hợp lệ.');
  if (!STATUSES.includes(status)) throw new Error('Trạng thái không hợp lệ.');
  const cur = all()[String(n)] || {};
  const cleanHtml = sanitize(String(html ?? cur.html ?? '')).trim();
  if (status === 'published' && cleanHtml.replace(/<[^>]+>/g, '').trim().length < 80) throw new Error('Mô tả quá ngắn để đăng (tối thiểu ~80 ký tự).');
  if (cleanHtml.length > 20000) throw new Error('Mô tả quá dài.');
  const data = readJson(DATA_FILE());
  data[String(n)] = {
    name: String(name ?? cur.name ?? '').slice(0, 200),
    summary: String(summary ?? cur.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    html: cleanHtml, status, updated_at: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(DATA_FILE()), { recursive: true });
  const tmp = DATA_FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE());
  cache = { key: '', map: {} };
  return all()[String(n)];
}

module.exports = { STATUSES, all, published, compose, save, SEED_FILE };
