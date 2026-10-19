const puppeteer = require('puppeteer-core');

async function inspectProductDom() {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  const url = 'https://dropbuy.vn/may-loc-khong-khi-o-to-mosida-phim-cam-ung-khu-mui-diet-khuan-ion-am-khuyech-tan-tinh-dau_p141008';
  await page.goto(url, { waitUntil: 'networkidle2' });

  const info = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim());
    const prices = Array.from(document.querySelectorAll('*'))
      .filter(el => el.children.length === 0 && el.innerText && el.innerText.includes('đ'))
      .map(el => el.innerText.trim());
    const images = Array.from(document.querySelectorAll('img')).map(img => img.src);
    return { buttons, prices: Array.from(new Set(prices)), images: images.slice(0, 5) };
  });

  console.log('Product Details:');
  console.log(' - Buttons:', info.buttons);
  console.log(' - Prices on page:', info.prices);
  console.log(' - Images:', info.images);

  await browser.close();
}

inspectProductDom();
