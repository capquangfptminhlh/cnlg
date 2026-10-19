const puppeteer = require('puppeteer-core');

async function inspectSearchApi() {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  
  page.on('request', req => {
    if (req.url().includes('/api/proxy/bff/variations/search')) {
      console.log('Search API Request Method:', req.method());
      console.log('Headers:', req.headers());
      console.log('Post Data:', req.postData());
    }
  });

  page.on('response', async res => {
    if (res.url().includes('/api/proxy/bff/variations/search')) {
      const json = await res.json();
      console.log('Response JSON keys:', Object.keys(json));
      if (Array.isArray(json)) {
        console.log(`Array of ${json.length} items`);
        console.log('Sample item:', JSON.stringify(json[0], null, 2));
      } else if (json.data) {
        console.log(`Data count: ${json.data.length || Object.keys(json.data).length}`);
        console.log('Sample item:', JSON.stringify(json.data[0] || json.data, null, 2));
      } else {
        console.log('Sample keys:', Object.keys(json));
        console.log('Sample data:', JSON.stringify(json, null, 2).substring(0, 1000));
      }
    }
  });

  await page.goto('https://dropbuy.vn/dien-thoai-phu-kien_c1', { waitUntil: 'networkidle2', timeout: 30000 });
  await browser.close();
}

inspectSearchApi().catch(err => console.error('Error:', err.message));
