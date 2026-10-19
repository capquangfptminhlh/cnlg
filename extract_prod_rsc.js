const fs = require('fs');

async function extractProductRsc() {
  const url = 'https://dropbuy.vn/may-loc-khong-khi-o-to-mosida-phim-cam-ung-khu-mui-diet-khuan-ion-am-khuyech-tan-tinh-dau_p141008';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const html = await res.text();
  console.log('HTML Length:', html.length);

  // Extract all RSC push lines
  const regex = /self\.__next_f\.push\(\[1,"(.*?)"\]\)/g;
  let match;
  let fullRsc = '';
  while ((match = regex.exec(html)) !== null) {
    fullRsc += match[1];
  }
  const unescaped = fullRsc.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

  fs.writeFileSync('C:/Users/nskka/.gemini/antigravity/scratch/hoangminh-dropbuy-relay/sample_product_rsc.txt', unescaped, 'utf8');
  console.log('Saved unescaped RSC text. Length:', unescaped.length);

  // Search for images, video, description, variations in unescaped
  const images = unescaped.match(/https:\/\/r6i\.pen\.dropbuy\.vn\/[^\"]+/g) || [];
  const videos = unescaped.match(/https:\/\/r6v\.pen\.dropbuy\.vn\/[^\"]+/g) || [];
  console.log('Images found in product RSC:', Array.from(new Set(images)));
  console.log('Videos found in product RSC:', Array.from(new Set(videos)));
}

extractProductRsc();
