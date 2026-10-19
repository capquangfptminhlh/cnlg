const puppeteer = require('puppeteer-core');

async function checkProductPage() {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  const url = 'https://dropbuy.vn/may-loc-khong-khi-o-to-mosida-phim-cam-ung-khu-mui-diet-khuan-ion-am-khuyech-tan-tinh-dau_p141008';
  console.log('Navigating to:', url);
  await page.goto(url, { waitUntil: 'networkidle2' });
  console.log('Final URL:', page.url());
  console.log('Title:', await page.title());

  await browser.close();
}

checkProductPage();
