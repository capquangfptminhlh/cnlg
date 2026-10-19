const fs = require('fs');

async function getFullProductDetail(slugOrUrl) {
  let url = slugOrUrl;
  if (!url.startsWith('http')) {
    url = `https://dropbuy.vn/${slugOrUrl}`;
  }

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // Extract RSC chunks
  const regex = /self\.__next_f\.push\(\[1,"(.*?)"\]\)/g;
  let match;
  let fullRsc = '';
  while ((match = regex.exec(html)) !== null) {
    fullRsc += match[1];
  }
  const unescaped = fullRsc.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

  // Look for rawProduct object
  const rawIdx = unescaped.indexOf('"rawProduct":');
  if (rawIdx !== -1) {
    // Extract JSON object starting after "rawProduct":
    const start = rawIdx + '"rawProduct":'.length;
    // Find balanced JSON object
    let depth = 0;
    let end = start;
    let inString = false;
    let escaped = false;

    for (let i = start; i < unescaped.length; i++) {
      const char = unescaped[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === '{') depth++;
        else if (char === '}') {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
    }

    const rawProductJson = unescaped.substring(start, end);
    try {
      const rawProduct = JSON.parse(rawProductJson);
      return rawProduct;
    } catch (e) {
      console.error('Failed to parse rawProduct JSON:', e.message);
    }
  }

  return null;
}

getFullProductDetail('may-loc-khong-khi-o-to-mosida-phim-cam-ung-khu-mui-diet-khuan-ion-am-khuyech-tan-tinh-dau_p141008')
  .then(prod => {
    console.log('Successfully extracted full rawProduct!');
    console.log('ID:', prod.product_id);
    console.log('Name:', prod.name);
    console.log('Variations count:', prod.variations ? prod.variations.length : 0);
    console.log('Media count:', prod.media_configs ? prod.media_configs.length : (prod.media_gallery ? prod.media_gallery.length : 'none'));
    if (prod.media_gallery) {
      console.log('Sample gallery item:', prod.media_gallery[0]);
    }
  })
  .catch(err => console.error('Error:', err));
