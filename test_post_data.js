const puppeteer = require('puppeteer-core');

async function checkPostData() {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  
  page.on('request', req => {
    if (req.url().includes('/api/proxy/bff/variations/search')) {
      console.log('Method:', req.method());
      console.log('PostData:', req.postData());
    }
  });

  await page.goto('https://dropbuy.vn/dien-thoai-phu-kien_c1', { waitUntil: 'networkidle2' });
  await browser.close();
}

checkPostData();
