'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-img-'));
process.env.HM_IMG_CACHE_DIR = path.join(tmp, 'cache');
process.env.HM_MEDIA_SECRET_FILE = path.join(tmp, 'media-secret.json');
const sharp = require('sharp');
const opt = require('../services/imageOptimizer');
const ci = require('../services/catalogImage');

// Ảnh PNG "thật" 600×600 nhiều chi tiết (nhiễu) – PNG nặng như ảnh nguồn sỉ
async function noisyPng(size = 600) {
  const raw = Buffer.alloc(size * size * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761 >>> 24) ^ (i % size);
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

test('PNG nặng → WebP nhẹ hơn, cạnh dài không quá 800px', async () => {
  const png = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#f05a28' } }).png({ compressionLevel: 0 }).toBuffer();
  const out = await opt.toWebp({ buffer: png, mime: 'image/png' });
  assert.equal(out.mime, 'image/webp');
  assert.ok(out.buffer.length < png.length / 5);
  const m = await sharp(out.buffer).metadata();
  assert.equal(m.format, 'webp');
  assert.equal(m.width, 800);
  assert.equal(m.height, 500);
});

test('video / GIF / ảnh hỏng: không đụng tới (trả null → gửi ảnh gốc)', async () => {
  assert.equal(await opt.toWebp({ buffer: Buffer.from('x'), mime: 'video/mp4' }), null);
  assert.equal(await opt.toWebp({ buffer: Buffer.from('GIF89a....'), mime: 'image/gif' }), null);
  assert.equal(await opt.toWebp({ buffer: Buffer.from('không phải ảnh'), mime: 'image/png' }), null);
});

test('ảnh đã nén lưu ổ đĩa: lần sau không tải lại từ nguồn', async () => {
  const png = await noisyPng();
  let loads = 0;
  const load = async () => { loads++; return { buffer: png, mime: 'image/png' }; };
  const a = await opt.optimized('md/s-1/p-1/a_256x256.png', load);
  const b = await opt.optimized('md/s-1/p-1/a_256x256.png', load);
  assert.equal(loads, 1);
  assert.equal(a.mime, 'image/webp');
  assert.deepEqual(a.buffer, b.buffer);
  // tải gốc lỗi → báo lỗi (máy chủ trả 503 như trước), không lưu gì
  await assert.rejects(opt.optimized('md/loi.png', async () => { throw new Error('nguồn lỗi'); }));
});

test('dọn cache khi vượt dung lượng: xoá ảnh lâu không dùng trước', () => {
  const dir = path.join(tmp, 'prune');
  process.env.HM_IMG_CACHE_DIR = dir;
  process.env.IMG_CACHE_MB = '50';
  fs.mkdirSync(path.join(dir, 'aa'), { recursive: true });
  const big = Buffer.alloc(12 * 1024 * 1024);
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, 'aa', `f${i}.webp`);
    fs.writeFileSync(f, big);
    const t = new Date(Date.now() - (10 - i) * 60e3);
    fs.utimesSync(f, t, t);
  }
  const r = opt.prune();
  assert.ok(r.removed >= 2);
  assert.ok(r.total <= 40 * 1024 * 1024);
  assert.equal(fs.existsSync(path.join(dir, 'aa', 'f0.webp')), false); // cũ nhất bị xoá
  assert.equal(fs.existsSync(path.join(dir, 'aa', 'f5.webp')), true); // mới nhất còn
});

test('ảnh web ngoài: đi qua /cdn/x/ có chữ ký, không nhận link tuỳ ý / địa chỉ nội bộ', () => {
  const src = 'https://ae01.alicdn.com/kf/Sabc.jpg_640x640.jpg';
  const m = ci.maskMediaUrl(src);
  const [, sig, b64, ext] = m.match(/^\/cdn\/x\/([A-Za-z0-9_-]{16})\/([A-Za-z0-9_-]+)\.(\w+)$/);
  assert.equal(ext, 'jpg');
  assert.equal(m.includes('alicdn'), false);
  assert.equal(ci.externalFromSigned(sig, b64), src);
  assert.equal(ci.externalFromSigned('A'.repeat(16), b64), null); // chữ ký giả
  assert.equal(ci.externalFromSigned(sig, Buffer.from('https://evil.example/a.jpg').toString('base64url')), null);
  // không ký: IP, localhost, cổng lạ, không phải ảnh
  for (const u of ['http://127.0.0.1/a.jpg', 'https://10.0.0.5/a.png', 'https://localhost/a.jpg', 'https://a.com:8443/a.jpg', 'https://a.com/clip.mp4']) {
    assert.equal(ci.maskMediaUrl(u), u);
  }
  // nguồn sỉ vẫn che như cũ
  assert.equal(ci.maskMediaUrl('https://r6i.pen.dropbuy.vn/md/s-1/x.png'), '/cdn/md/s-1/x.png');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.equal(ci.privateIp(ip), true, ip);
  }
  assert.equal(ci.privateIp('8.8.8.8'), false);
});
