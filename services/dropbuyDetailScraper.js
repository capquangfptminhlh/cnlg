const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DETAILS_DIR = path.join(DATA_DIR, 'products_detail');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images', 'products');

if (!fs.existsSync(DETAILS_DIR)) fs.mkdirSync(DETAILS_DIR, { recursive: true });
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

const CDN_BASE = 'https://r6i.pen.dropbuy.vn';

/**
 * Format media item to full URL
 */
function formatMediaUrl(location, fileName) {
  if (!fileName) return null;
  if (fileName.startsWith('http')) return fileName;
  const loc = location ? (location.startsWith('/') ? location : '/' + location) : '/';
  return `${CDN_BASE}${loc}${fileName}`;
}

/**
 * Tải file ảnh/video về lưu trữ cục bộ
 */
async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1000) {
      return resolve(destPath);
    }

    const file = fs.createWriteStream(destPath);
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 200) {
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => resolve(destPath));
        });
      } else {
        file.close();
        fs.unlink(destPath, () => {});
        reject(new Error(`HTTP ${res.statusCode}`));
      }
    });

    req.on('error', err => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(err);
    });

    req.setTimeout(15000, () => {
      req.abort();
      file.close();
      fs.unlink(destPath, () => {});
      reject(new Error('Timeout'));
    });
  });
}

/**
 * Cào toàn bộ chi tiết sản phẩm từ Dropbuy (Bao gồm Album ảnh, Video, Mô tả, Thông số kỹ thuật)
 */
async function fetchProductFullDetail(product, downloadImagesLocally = false) {
  const productId = product.id || product.dropbuy_id;
  const cacheFile = path.join(DETAILS_DIR, `${productId}.json`);

  // Nếu đã có cache và không yêu cầu download lại ảnh
  if (fs.existsSync(cacheFile) && !downloadImagesLocally) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) {}
  }

  const dropbuyUrl = product.dropbuy_url || `https://dropbuy.vn/${product.slug}_p${productId}`;
  console.log(`[DetailScraper] Đang cào full chi tiết SP #${productId} (${dropbuyUrl})...`);

  try {
    const res = await fetch(dropbuyUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    // 1. Bóc tách mô tả từ og:description
    const ogDescMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]*)"/i) ||
                        html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
    let description = ogDescMatch ? ogDescMatch[1].replace(/\\n/g, '\n').replace(/&quot;/g, '"') : '';

    // 2. Bóc tách toàn bộ RSC payload
    const regex = /self\.__next_f\.push\(\[1,"(.*?)"\]\)/g;
    let match;
    let fullRsc = '';
    while ((match = regex.exec(html)) !== null) {
      fullRsc += match[1];
    }
    const unescaped = fullRsc.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

    // 3. Bóc tách rawProduct JSON
    let gallery = [];
    let videoUrl = null;
    let variations = [];
    let specs = {};

    const rawIdx = unescaped.indexOf('"rawProduct":');
    if (rawIdx !== -1) {
      const start = rawIdx + '"rawProduct":'.length;
      let depth = 0;
      let end = start;
      let inString = false;
      let escaped = false;

      for (let i = start; i < unescaped.length; i++) {
        const char = unescaped[i];
        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if (char === '"') { inString = !inString; continue; }
        if (!inString) {
          if (char === '{') depth++;
          else if (char === '}') {
            depth--;
            if (depth === 0) { end = i + 1; break; }
          }
        }
      }

      try {
        const raw = JSON.parse(unescaped.substring(start, end));
        if (raw.media_data && Array.isArray(raw.media_data)) {
          gallery = raw.media_data.map(m => {
            const isVideo = (m.res_origin_file_name && (m.res_origin_file_name.endsWith('.mov') || m.res_origin_file_name.endsWith('.mp4')));
            const imgFull = formatMediaUrl(m.res_location, m.res_med_file_name || m.res_origin_file_name);
            const imgThumb = formatMediaUrl(m.res_location, m.res_thumb_file_name || m.res_low_file_name);
            if (isVideo) {
              videoUrl = formatMediaUrl(m.res_location, m.res_med_file_name || m.res_origin_file_name);
            }
            return {
              id: m.unique_id,
              is_video: isVideo,
              url: imgFull,
              thumb: imgThumb
            };
          });
        }

        if (raw.variations && Array.isArray(raw.variations)) {
          variations = raw.variations.map(v => ({
            id: v.variation_id,
            sku: v.sku,
            name: v.name,
            in_stock: v.in_stock,
            specs: v.specs || {}
          }));
        }

        if (raw.body_content && !raw.body_content.startsWith('$')) {
          description = raw.body_content;
        }
      } catch (err) {
        console.warn(`[DetailScraper] Lỗi parse rawProduct JSON cho #${productId}:`, err.message);
      }
    }

    // Nếu không bóc tách được media_data qua JSON, regex trực tiếp ảnh của product đó
    if (gallery.length === 0) {
      const imgMatches = Array.from(new Set(unescaped.match(new RegExp(`/md/s-\\d+/p-${productId}/[^"]+`, 'g')) || []));
      gallery = imgMatches.map((img, idx) => ({
        id: `img-${idx}`,
        is_video: img.endsWith('.mov') || img.endsWith('.mp4'),
        url: `${CDN_BASE}${img.replace('_128x128', '_1024x1024')}`,
        thumb: `${CDN_BASE}${img}`
      }));
    }

    // Thêm ảnh đại diện chính nếu gallery vẫn rỗng
    if (gallery.length === 0 && product.image) {
      gallery.push({ id: 'main', is_video: false, url: product.image_hd || product.image, thumb: product.image });
    }

    // 4. Tải ảnh về máy chủ cục bộ nếu được bật
    const prodImgDir = path.join(IMAGES_DIR, String(productId));
    if (downloadImagesLocally) {
      if (!fs.existsSync(prodImgDir)) fs.mkdirSync(prodImgDir, { recursive: true });
      for (let i = 0; i < gallery.length; i++) {
        const item = gallery[i];
        if (item.url && !item.is_video) {
          const ext = path.extname(item.url.split('?')[0]) || '.jpg';
          const localFileName = `photo_${i + 1}${ext}`;
          const localFilePath = path.join(prodImgDir, localFileName);
          try {
            await downloadFile(item.url, localFilePath);
            item.local_url = `/images/products/${productId}/${localFileName}`;
          } catch (e) {
            console.warn(`[DetailScraper] Không tải được ảnh ${item.url}:`, e.message);
          }
        }
      }
    }

    const fullDetail = {
      id: productId,
      name: product.name,
      slug: product.slug,
      sku: product.sku,
      price: product.price,
      original_price: product.original_price,
      dropbuy_cost: product.dropbuy_cost,
      dropbuy_url: dropbuyUrl,
      category_id: product.category_id,
      category_name: product.category_name,
      warranty: product.warranty || 'Bảo hành chính hãng DropBuy 6 tháng',
      in_stock: product.in_stock !== false,
      description: description || 'Sản phẩm chính hãng chất lượng cao phân phối từ kho tổng DropBuy.vn.',
      gallery: gallery,
      video_url: videoUrl,
      variations: variations,
      rating: 5.0,
      sold_count: 89 + (productId % 150),
      cached_at: new Date().toISOString()
    };

    fs.writeFileSync(cacheFile, JSON.stringify(fullDetail, null, 2), 'utf8');
    return fullDetail;

  } catch (err) {
    console.error(`[DetailScraper] Lỗi khi cào chi tiết SP #${productId}:`, err.message);
    // Trả về dữ liệu cơ bản nếu cào lỗi
    return {
      id: productId,
      name: product.name,
      slug: product.slug,
      sku: product.sku,
      price: product.price,
      original_price: product.original_price,
      dropbuy_url: dropbuyUrl,
      category_id: product.category_id,
      category_name: product.category_name,
      description: 'Sản phẩm chính hãng chất lượng cao phân phối từ kho tổng DropBuy.vn.',
      gallery: [{ id: 'main', is_video: false, url: product.image_hd || product.image, thumb: product.image }],
      rating: 5.0,
      sold_count: 89,
      cached_at: new Date().toISOString()
    };
  }
}

module.exports = {
  fetchProductFullDetail,
  downloadFile
};
