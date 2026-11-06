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

async function boundedFetch(url) {
  if (active >= MAX_INFLIGHT) {
    if (waiters.length >= MAX_WAITING) throw new Error('Ảnh đang được tải quá nhiều');
    await new Promise(resolve => waiters.push(resolve));
  }
  active++;
  try {
    const response = await fetch(url.href, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*', 'user-agent': 'HoangMinhStore/1.0' }
    });
    if (!response.ok) throw new Error('CDN ' + response.status);
    const declaredMime = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase().trim();
    if (declaredMime && !ALLOWED_MEDIA_MIMES.has(declaredMime) &&
        declaredMime !== 'application/octet-stream' && declaredMime !== 'binary/octet-stream' &&
        declaredMime !== 'image/jfif' && declaredMime !== 'image/pjpeg' && declaredMime !== 'image/jpg') {
      throw new Error('Không phải ảnh hợp lệ');
    }
    const declared = Number(response.headers.get('content-length'));
    if (declared > MAX_BYTES) throw new Error('Ảnh quá lớn');
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_BYTES) throw new Error('Ảnh quá lớn');
      chunks.push(Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks, bytes);
    const mime = sniffMime(buffer, declaredMime, url.href);
    if (!mime || !allowedBytes(buffer, mime)) throw new Error('Định dạng ảnh không hợp lệ');
    return { buffer, mime };
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
  return masked;
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
    const response = await fetch(fullUrl, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: {
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,video/mp4,video/webm,*/*',
        'user-agent': 'HoangMinhStore/1.0'
      }
    });
    if (!response.ok) throw new Error('CDN ' + response.status);
    const declaredMime = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase().trim();
    if (declaredMime && !ALLOWED_MEDIA_MIMES.has(declaredMime) &&
        declaredMime !== 'application/octet-stream' && declaredMime !== 'binary/octet-stream' &&
        declaredMime !== 'image/jfif' && declaredMime !== 'image/pjpeg' && declaredMime !== 'image/jpg') {
      throw new Error('Không phải media hợp lệ');
    }
    const declared = Number(response.headers.get('content-length'));
    if (declared > MAX_MEDIA_BYTES) throw new Error('Media quá lớn');
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_MEDIA_BYTES) throw new Error('Media quá lớn');
      chunks.push(Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks, bytes);
    const mime = sniffMime(buffer, declaredMime, fullUrl);
    if (!mime || !ALLOWED_MEDIA_MIMES.has(mime)) throw new Error('Không phải media hợp lệ');
    const result = { buffer, mime };
    if (bytes <= MAX_BYTES) {
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
  sniffMime
};
