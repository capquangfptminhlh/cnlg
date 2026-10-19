const puppeteer = require('puppeteer-core');

async function capture() {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,900']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });

  // Wait for product cards to render
  await page.waitForSelector('.luxury-card');

  // Check how many images loaded successfully
  const imgStats = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('.card-media img'));
    return imgs.map(img => ({
      src: img.src,
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight
    }));
  });

  console.log(`Rendered ${imgStats.length} product cards on page.`);
  console.log('First 5 image statuses:');
  for (let i = 0; i < Math.min(5, imgStats.length); i++) {
    const s = imgStats[i];
    console.log(` - Image ${i + 1}: ${s.naturalWidth}x${s.naturalHeight}px (Loaded: ${s.naturalWidth > 0}) -> ${s.src}`);
  }

  await browser.close();
}

capture().catch(err => console.error('Capture error:', err));
