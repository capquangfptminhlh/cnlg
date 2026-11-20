'use strict';
/**
 * Làm nhẹ ảnh sản phẩm trước khi gửi khách: thu nhỏ (cạnh dài tối đa MAX_SIDE) + đổi sang WebP.
 * Ảnh PNG 60–160 KB của nguồn sỉ còn ~8–25 KB. Kết quả lưu trên ổ đĩa (data/img-cache) nên
 * khởi động lại máy chủ không phải tải + nén lại; thư mục tự dọn khi vượt IMG_CACHE_MB.
 *
 * Không có thư viện sharp (cài lỗi) → trả null, máy chủ gửi ảnh gốc như trước – không bao giờ làm hỏng ảnh.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let sharp = null;
try {
  sharp = require('sharp');
  sharp.cache(false); // không giữ ảnh đã giải mã trong RAM
  sharp.concurrency(1);
} catch (e) {
  console.warn('[Ảnh] Chưa có thư viện sharp – gửi ảnh gốc (chưa nén).');
}

const VERSION = 'v1';
const MAX_SIDE = 800;
const QUALITY = 78;
const CACHE_DIR = () => process.env.HM_IMG_CACHE_DIR || path.join(__dirname, '..', 'data', 'img-cache');
const CACHE_MB = () => Math.max(50, Number(process.env.IMG_CACHE_MB) || 800);
const OPTIMIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Nén tối đa 2 ảnh cùng lúc – không để trang nhiều ảnh làm nghẽn CPU của máy chủ
const MAX_JOBS = 2;
let jobs = 0;
const queue = [];
async function slot(fn) {
  if (jobs >= MAX_JOBS) await new Promise(r => queue.push(r));
  jobs++;
  try { return await fn(); } finally { jobs--; queue.shift()?.(); }
}

const available = () => !!sharp;
const keyOf = id => crypto.createHash('sha1').update(`${VERSION}|${MAX_SIDE}|${QUALITY}|${id}`).digest('hex');
const fileOf = key => path.join(CACHE_DIR(), key.slice(0, 2), `${key}.webp`);

function readCached(id) {
  try {
    const f = fileOf(keyOf(id));
    const buffer = fs.readFileSync(f);
    const now = new Date();
    fs.utimes(f, now, now, () => {}); // đánh dấu vừa dùng (dọn ảnh lâu không ai xem trước)
    return { buffer, mime: 'image/webp' };
  } catch (e) {
    return null;
  }
}

function writeCached(id, buffer) {
  try {
    const f = fileOf(keyOf(id));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, f);
  } catch (e) {}
}

/** Ảnh gốc → WebP đã thu nhỏ; null nếu không nén được / không nhẹ hơn rõ rệt (giữ ảnh gốc). */
async function toWebp(original) {
  if (!sharp || !original || !OPTIMIZABLE.has(original.mime)) return null;
  try {
    const out = await slot(() => sharp(original.buffer, { failOn: 'error', limitInputPixels: 40e6 })
      .rotate()
      .resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: QUALITY, effort: 4 })
      .toBuffer());
    // WebP sẵn của nguồn: chỉ thay khi nhẹ hơn ≥ 10%
    if (out.length >= original.buffer.length * 0.9) return null;
    return { buffer: out, mime: 'image/webp' };
  } catch (e) {
    return null;
  }
}

/**
 * Ảnh đã làm nhẹ của `id` (đường dẫn /cdn/…): ổ đĩa trước, không có thì tải gốc qua loadOriginal() rồi nén.
 * Không nén được → ảnh gốc.
 */
const inflight = new Map();
async function optimized(id, loadOriginal) {
  if (!sharp) return loadOriginal();
  const hit = readCached(id);
  if (hit) return hit;
  if (inflight.has(id)) return inflight.get(id);
  const task = (async () => {
    const original = await loadOriginal();
    const small = await toWebp(original);
    if (!small) return original;
    writeCached(id, small.buffer);
    return small;
  })();
  inflight.set(id, task);
  try { return await task; } finally { inflight.delete(id); }
}

/** Giữ thư mục cache dưới IMG_CACHE_MB: xoá ảnh lâu không ai xem nhất, còn ~80%. */
function prune() {
  const dir = CACHE_DIR();
  if (!fs.existsSync(dir)) return { removed: 0 };
  const files = [];
  let total = 0;
  for (const sub of fs.readdirSync(dir)) {
    const d = path.join(dir, sub);
    let names;
    try { names = fs.readdirSync(d); } catch (e) { continue; }
    for (const n of names) {
      const f = path.join(d, n);
      try {
        const st = fs.statSync(f);
        if (n.endsWith('.tmp') && Date.now() - st.mtimeMs > 3600e3) { fs.unlinkSync(f); continue; }
        files.push({ f, size: st.size, at: st.mtimeMs });
        total += st.size;
      } catch (e) {}
    }
  }
  const limit = CACHE_MB() * 1024 * 1024;
  if (total <= limit) return { removed: 0, total };
  files.sort((a, b) => a.at - b.at);
  let removed = 0;
  for (const x of files) {
    if (total <= limit * 0.8) break;
    try { fs.unlinkSync(x.f); total -= x.size; removed++; } catch (e) {}
  }
  return { removed, total };
}

function startPruning() {
  const tick = () => { try { const r = prune(); if (r.removed) console.log(`[Ảnh] Dọn ${r.removed} ảnh cũ trong cache.`); } catch (e) {} };
  setTimeout(tick, 60e3).unref();
  return setInterval(tick, 6 * 3600e3).unref();
}

module.exports = { available, optimized, toWebp, prune, startPruning, MAX_SIDE };
