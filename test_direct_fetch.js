const fs = require('fs');

fetch('https://dropbuy.vn/api/proxy/bff/variations/search', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Origin': 'https://dropbuy.vn',
    'Referer': 'https://dropbuy.vn/dien-thoai-phu-kien_c1'
  },
  body: JSON.stringify({ page_num: 1, page_size: 10, category_id: 1 })
})
.then(async res => {
  console.log('Status:', res.status);
  const text = await res.text();
  console.log('Response length:', text.length);
  try {
    const json = JSON.parse(text);
    console.log('Keys:', Object.keys(json));
    console.log('Sample data keys:', json.data ? Object.keys(json.data) : 'no data key');
    if (json.data && Array.isArray(json.data)) {
      console.log('Product 0:', json.data[0].product_name || json.data[0].name || json.data[0]);
    } else {
      console.log('JSON preview:', text.substring(0, 300));
    }
  } catch (e) {
    console.log('Not JSON:', text.substring(0, 300));
  }
})
.catch(err => console.error('Error:', err));
