'use strict';
/* Safe read-only proxy for publicly published DropBuy PRODUCT thumbnails.
 * Never forwards user URLs, cookies, sid or credentials to other hosts.
 * Memory cache is bounded; no persistence of private inventory data. */
const MAX_ITEMS = 350;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const CACHE_AGE = 12 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;
const MAX_INFLIGHT = 10;
const MAX_WAITING = 100;
const ALLOWED_MEDIA_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif',
  'video/mp4', 'video/webm'
]);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const cache = new Map();
const pending = new Map();
let active = 0;
const waiters = [];

function allowedImage(value) {
  if (typeof value !== 'string' || value.length > 1800) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || !/^r6[is]\.pen\.dropbuy\.vn$/i.test(u.hostname) || u.port ||
       u.username || u.password || !/^\/md2?\//.test(u.pathname)) return null;
    return u;
  } catch { return null; }
}

function sniffMime(buffer, declaredMime, urlStr) {
  if (Buffer.isBuffer(buffer) && buffer.length >= 8) {
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
    if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (buffer.length >= 6 && buffer.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
    if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
      const brand = buffer.toString('ascii', 8, Math.min(buffer.length, 24));
      return (brand.includes('avif') || brand.includes('avis')) ? 'image/avif' : 'video/mp4';
    }
    if (buffer.length >= 4 && buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) return 'video/webm';
  }
  const clean = String(declaredMime || '').split(';')[0].toLowerCase().trim();
  if (clean === 'image/jfif' || clean === 'image/pjpeg' || clean === 'image/jpg') return 'image/jpeg';
  if (ALLOWED_MEDIA_MIMES.has(clean)) return clean;
  const ext = String(urlStr || '').split(/[?#]/)[0].split('.').pop().split(/[_]/)[0].toLowerCase();
  if (ext === 'jfif' || ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'avif') return 'image/avif';
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'webm') return 'video/webm';
  return null;
}

function mimeFor(response, url) {
  const mime = String(response?.headers?.get?.('content-type') || '').split(';')[0].toLowerCase().trim();
  if (['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'].includes(mime)) return mime;
  if (mime === 'image/jfif' || mime === 'image/pjpeg') return 'image/jpeg';
  const ext = String(url?.pathname || url || '').split(/[?#]/)[0].split('.').pop().toLowerCase();
  if (['jpg', 'jpeg', 'jfif'].includes(ext)) return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return null;
}

function allowedBytes(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 120 || buffer.length > MAX_BYTES) return false;
  if (mime === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (mime === 'image/webp') return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (mime === 'image/avif') return buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp' && buffer.toString('ascii', 8, 16).includes('avif');
  if (mime === 'image/gif') return buffer.length >= 6 && buffer.toString('ascii', 0, 3) === 'GIF';
  return false;
}

async function fetchOneMedia(urlStr, maxBytes = MAX_MEDIA_BYTES, { referer = 'https://dropbuy.vn/', accept = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' } = {}) {
  try {
    const response = await fetch(urlStr, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: {
        'accept': accept,
        'accept-language': 'vi,en-US;q=0.9,en;q=0.8',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        ...(referer ? { referer } : {}),
        'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'image',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-site': 'same-site'
      }
    });
    if (!response.ok) return null;
    const declaredMime = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase().trim();
    if (declaredMime === 'text/html' || declaredMime === 'text/plain' || declaredMime === 'application/json') {
      return null;
    }
    const declared = Number(response.headers.get('content-length'));
    if (declared > maxBytes) return null;
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) return null;
      chunks.push(Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks, bytes);
    if (buffer.length < 100 && buffer.toString('ascii').toLowerCase().includes('<html')) {
      return null;
    }
    const mime = sniffMime(buffer, declaredMime, urlStr);
    if (!mime || !ALLOWED_MEDIA_MIMES.has(mime)) return null;
    return { buffer, mime };
  } catch {
    return null;
  }
}

async function boundedFetch(url) {
  if (active >= MAX_INFLIGHT) {
    if (waiters.length >= MAX_WAITING) throw new Error('Ảnh đang được tải quá nhiều');
    await new Promise(resolve => waiters.push(resolve));
  }
  active++;
  try {
    let result = await fetchOneMedia(url.href, MAX_BYTES);
    if (!result && /_(?:1024x1024|512x512|256x256)\./.test(url.href)) {
      const rawUrl = url.href.replace(/_(?:1024x1024|512x512|256x256)\./, '.');
      result = await fetchOneMedia(rawUrl, MAX_BYTES);
      if (!result && !url.href.includes('_256x256')) {
        const thumbUrl = url.href.replace(/_(?:1024x1024|512x512)\./, '_256x256.');
        result = await fetchOneMedia(thumbUrl, MAX_BYTES);
      }
    }
    if (!result || !allowedBytes(result.buffer, result.mime)) throw new Error('Định dạng ảnh không hợp lệ');
    return result;
  } finally {
    active--;
    waiters.shift()?.();
  }
}

async function imageForProduct(product) {
  if (!product || !Number.isSafeInteger(Number(product.id))) return null;
  const url = allowedImage(product.image);
  if (!url) return null;
  const key = String(product.id) + '|' + url.href;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_AGE) {
    cache.delete(key); cache.set(key, hit);
    return hit.result;
  }
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    const result = await boundedFetch(url);
    cache.set(key, { at: Date.now(), result });
    while (cache.size > MAX_ITEMS) cache.delete(cache.keys().next().value);
    return result;
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}

// Ảnh nguồn sỉ khác đi qua /cdn/<mã>/… của cửa hàng – khách không thấy host nguồn
const MEDIA_ORIGINS = {
  p1: 'https://product.hstatic.net/',
  p2: 'https://cdn.hstatic.net/',
  p3: 'https://file.hstatic.net/',
  p4: 'https://techmall.vn/wp-content/uploads/'
};
const ORIGIN_RE = [
  [/^https?:\/\/product\.hstatic\.net\//i, 'p1'],
  [/^https?:\/\/cdn\.hstatic\.net\//i, 'p2'],
  [/^https?:\/\/file\.hstatic\.net\//i, 'p3'],
  [/^https?:\/\/(?:www\.)?techmall\.vn\/wp-content\/uploads\//i, 'p4']
];
const MEDIA_PATH = /^[A-Za-z0-9._/%+()~-]+$/;

function maskOrigin(url) {
  for (const [re, code] of ORIGIN_RE) {
    if (!re.test(url)) continue;
    const rest = url.replace(re, '').split(/[?#]/)[0];
    return MEDIA_PATH.test(rest) && !rest.includes('..') ? '/cdn/' + code + '/' + rest : '/logo.svg';
  }
  return url;
}

function maskMediaUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  const masked = maskOrigin(url).replace(/^https?:\/\/r6[is]\.pen\.dropbuy\.vn\/(md2?\/)/i, '/cdn/$1');
  if (/^(https?:)?\/\/(?:[\w-]+\.)*dropbuy\.vn(\/|$)/i.test(masked)) return '/logo.svg';
  return signExternal(masked);
}

// ───────── Ảnh nằm trên web khác (web hãng, AliExpress, máy chủ Trung Quốc…) ─────────
// Trước đây trình duyệt khách tải thẳng → chậm, hay lỗi, không qua Cloudflare.
// Giờ đi qua /cdn/x/<chữ ký>/<link mã hoá>.<đuôi> của cửa hàng. Máy chủ CHỈ tải link do chính nó ký
// (link lấy từ catalog), không nhận link tuỳ ý → không bị lợi dụng tải hộ trang khác.
const EXT_IMG = /\.(jpe?g|png|webp|gif)$/i;
let mediaKey = null;
function mediaSecret() {
  if (mediaKey) return mediaKey;
  const file = process.env.HM_MEDIA_SECRET_FILE || path.join(__dirname, '..', 'data', 'media-secret.json');
  try { mediaKey = Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).key, 'hex'); } catch (e) {}
  if (!mediaKey || mediaKey.length < 32) {
    mediaKey = crypto.randomBytes(32);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ key: mediaKey.toString('hex') }), { encoding: 'utf8', mode: 0o600 });
    } catch (e) {}
  }
  return mediaKey;
}
const extSig = href => crypto.createHmac('sha256', mediaSecret()).update(`ext-media:${href}`).digest('base64url').slice(0, 16);

function externalImageUrl(value) {
  if (typeof value !== 'string' || value.length > 1200) return null;
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port) return null;
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) || !u.hostname.includes('.') || /(^|\.)localhost$/i.test(u.hostname)) return null;
    if (!EXT_IMG.test(u.pathname)) return null;
    return u;
  } catch (e) { return null; }
}

function signExternal(url) {
  const u = /^https?:\/\//i.test(url) ? externalImageUrl(url) : null;
  if (!u) return url;
  const ext = u.pathname.match(EXT_IMG)[1].toLowerCase().replace('jpeg', 'jpg');
  return `/cdn/x/${extSig(u.href)}/${Buffer.from(u.href, 'utf8').toString('base64url')}.${ext}`;
}

/** /cdn/x/<sig>/<b64> → link gốc nếu đúng chữ ký của máy chủ, ngược lại null. */
function externalFromSigned(sig, b64) {
  let href;
  try { href = Buffer.from(String(b64), 'base64url').toString('utf8'); } catch (e) { return null; }
  const u = externalImageUrl(href);
  if (!u || u.href !== href) return null;
  const want = extSig(href);
  if (typeof sig !== 'string' || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  return href;
}

// Không tải địa chỉ nội bộ (máy chủ, mạng LAN) kể cả khi tên miền trỏ về đó
function privateIp(ip) {
  const v4 = ip.replace(/^::ffff:/i, '');
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const s = ip.toLowerCase();
  return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
}
async function publicHost(hostname) {
  try {
    const addrs = await dns.promises.lookup(hostname, { all: true });
    return addrs.length > 0 && addrs.every(a => !privateIp(a.address));
  } catch (e) { return false; }
}

async function mediaFromExternal(href) {
  const u = externalImageUrl(href);
  if (!u) return null;
  const hit = cache.get(href);
  if (hit && Date.now() - hit.at < CACHE_AGE) return hit.result;
  if (pending.has(href)) return pending.get(href);
  const task = (async () => {
    if (!await publicHost(u.hostname)) throw new Error('Địa chỉ ảnh không hợp lệ');
    // Không nhận AVIF (trình duyệt cũ không mở được); WebP/JPG/PNG thì máy chủ nén lại được
    const result = await fetchOneMedia(href, 8 * 1024 * 1024, { referer: null, accept: 'image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5' });
    if (!result || !result.mime.startsWith('image/')) throw new Error('Không phải ảnh hợp lệ');
    if (result.buffer.length <= MAX_BYTES) {
      cache.set(href, { at: Date.now(), result });
      while (cache.size > MAX_ITEMS) cache.delete(cache.keys().next().value);
    }
    return result;
  })();
  pending.set(href, task);
  try { return await task; } finally { pending.delete(href); }
}

function maskMediaHtml(html) {
  if (typeof html !== 'string' || !html) return html;
  return html
    .replace(/https?:\/\/(?:(?:product|cdn|file)\.hstatic\.net|(?:www\.)?techmall\.vn\/wp-content\/uploads)\/[^\s"'<>)]+/gi, maskOrigin)
    .replace(/https?:\/\/r6[is]\.pen\.dropbuy\.vn\/(md2?\/[A-Za-z0-9._/%+()~-]+)/gi, '/cdn/$1')
    .replace(/https?:\/\/(?:[\w-]+\.)*dropbuy\.vn\/[^\s"'<>)]*/gi, '/logo.svg');
}

async function mediaFromCdnPath(relPath) {
  const clean = String(relPath || '').replace(/^\/+/,'');
  if (!/^(?:md2?|p[1-4])\/[A-Za-z0-9._/%+()~-]+$/.test(clean) || clean.includes('..')) return null;
  const code = clean.split('/')[0];
  const fullUrl = MEDIA_ORIGINS[code]
    ? MEDIA_ORIGINS[code] + clean.slice(code.length + 1)
    : 'https://r6i.pen.dropbuy.vn/' + clean;
  const hit = cache.get(fullUrl);
  if (hit && Date.now() - hit.at < CACHE_AGE) {
    cache.delete(fullUrl); cache.set(fullUrl, hit);
    return hit.result;
  }
  if (pending.has(fullUrl)) return pending.get(fullUrl);
  const task = (async () => {
    let result = await fetchOneMedia(fullUrl, MAX_MEDIA_BYTES);
    if (!result && /_(?:1024x1024|512x512|256x256)\./.test(fullUrl)) {
      const rawUrl = fullUrl.replace(/_(?:1024x1024|512x512|256x256)\./, '.');
      result = await fetchOneMedia(rawUrl, MAX_MEDIA_BYTES);
      if (!result && !fullUrl.includes('_256x256')) {
        const thumbUrl = fullUrl.replace(/_(?:1024x1024|512x512)\./, '_256x256.');
        result = await fetchOneMedia(thumbUrl, MAX_MEDIA_BYTES);
      }
    }
    if (!result) throw new Error('Không phải media hợp lệ');
    if (result.buffer.length <= MAX_BYTES) {
      cache.set(fullUrl, { at: Date.now(), result });
      while (cache.size > MAX_ITEMS) cache.delete(cache.keys().next().value);
    }
    return result;
  })();
  pending.set(fullUrl, task);
  try { return await task; } finally { pending.delete(fullUrl); }
}

module.exports = {
  imageForProduct,
  allowedImage,
  allowedBytes,
  maskMediaUrl,
  maskMediaHtml,
  mediaFromCdnPath,
  mediaFromExternal,
  externalFromSigned,
  signExternal,
  privateIp,
  sniffMime
};
