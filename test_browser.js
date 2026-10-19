const puppeteer = require('puppeteer-core');

async function testBrowser() {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  
  // Listen to network requests
  const apiUrls = [];
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('/api/') || url.includes('/v1/') || url.includes('/v2/') || res.request().resourceType() === 'fetch' || res.request().resourceType() === 'xhr') {
      apiUrls.push({ url, status: res.status() });
    }
  });

  console.log('Navigating to dropbuy.vn...');
  await page.goto('https://dropbuy.vn/', { waitUntil: 'networkidle2', timeout: 30000 });
  console.log('Title:', await page.title());

  console.log('Intercepted fetch/XHR requests:');
  for (const item of apiUrls) {
    console.log(` - [${item.status}] ${item.url}`);
  }

  await browser.close();
}

testBrowser().catch(err => console.error('Browser error:', err.message));
