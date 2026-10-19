const puppeteer = require('puppeteer-core');

async function testCategory() {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  
  const apiUrls = [];
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('/api/') || url.includes('/v1/') || url.includes('/v2/') || res.request().resourceType() === 'fetch' || res.request().resourceType() === 'xhr') {
      try {
        const text = await res.text();
        apiUrls.push({ url, status: res.status(), len: text.length });
      } catch (e) {}
    }
  });

  console.log('Navigating to category...');
  await page.goto('https://dropbuy.vn/dien-thoai-phu-kien_c1', { waitUntil: 'networkidle2', timeout: 30000 });
  
  // Extract products rendered on the page
  const products = await page.evaluate(() => {
    const items = [];
    const links = document.querySelectorAll('a[href*="_p"]');
    links.forEach(a => {
      const titleEl = a.querySelector('h3, h4, .line-clamp-2, [class*="title"]') || a;
      const imgEl = a.querySelector('img');
      const priceEl = a.querySelector('[class*="price"], [class*="text-red"], [class*="font-bold"]');
      items.push({
        url: a.href,
        title: titleEl ? titleEl.innerText.trim() : '',
        img: imgEl ? imgEl.src : '',
        price: priceEl ? priceEl.innerText.trim() : ''
      });
    });
    return items;
  });

  console.log(`Found ${products.length} products on category page!`);
  console.log('Sample products:', products.slice(0, 3));

  console.log('Intercepted API calls:');
  for (const item of apiUrls) {
    console.log(` - [${item.status}] len=${item.len} ${item.url}`);
  }

  await browser.close();
}

testCategory().catch(err => console.error('Error:', err.message));
