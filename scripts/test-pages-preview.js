'use strict';
/* Test the exact GitHub Pages artifact in headless Chrome using synthetic data.
   Does not connect to the live shop or perform any real checkout. */
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {readFileSync,existsSync,mkdirSync}=require('node:fs');
const {resolve,join,sep,extname}=require('node:path');
const puppeteer=require('puppeteer-core');

(async()=>{
  const directory=resolve(__dirname,'..','.pages-preview-dist');
  const screenshots=resolve(__dirname,'..','preview-test-artifacts');
  mkdirSync(screenshots,{recursive:true});
  const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml'};
  const server=createServer((req,res)=>{
    const pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
    const file=resolve(directory,'.'+pathname, pathname.endsWith('/')?'index.html':'');
    if(!file.startsWith(directory+sep)){
      res.writeHead(403).end();return;
    }
    try {
      const bytes=readFileSync(file);
      res.writeHead(200,{'content-type':(types[extname(file)]||'application/octet-stream')+'; charset=utf-8'});
      res.end(bytes);
    }catch(err){res.writeHead(404).end('Not found');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const chrome=['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/opt/google/chrome/chrome'].find(existsSync);
  if(!chrome)throw new Error('Chrome not available in runner');
  let browser;
  async function revealAll(page){
    await page.evaluate(async()=>{
      const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const step=Math.max(320,Math.floor(window.innerHeight*.72));
      const bottom=Math.max(0,document.documentElement.scrollHeight-window.innerHeight);
      for(let position=0;position<=bottom;position+=step){
        window.scrollTo(0,position);
        await pause(85);
      }
      window.scrollTo(0,bottom);
      await pause(250);
      window.scrollTo(0,0);
      await pause(500);
    });
  }
  try{
    browser=await puppeteer.launch({headless:true,executablePath:chrome,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();
    const pageErrors=[];
    page.on('pageerror',err=>pageErrors.push(err.message));
    await page.setViewport({width:1440,height:900,deviceScaleFactor:1});
    await page.goto('http://127.0.0.1:'+port+'/',{waitUntil:'domcontentloaded'});
    await page.waitForSelector('#productGrid .luxury-card',{timeout:15000});
    await page.waitForSelector('#featuredProducts .featured-card',{timeout:15000});
    let snapshot=await page.evaluate(()=>({
      cards:document.querySelectorAll('#productGrid .luxury-card').length,
      featured:document.querySelectorAll('#featuredProducts .featured-card').length,
      total:document.getElementById('heroTotalProd').textContent,
      disabledPayment:document.getElementById('submitOrderBtn').disabled,
      demo:document.body.dataset.demoMode
    }));
    assert.ok(snapshot.cards>=20,'catalog must display results');
    assert.equal(snapshot.featured,6,'featured section should display real API-shaped mock data');
    assert.equal(snapshot.demo,'true','DEMO must be visible');
    assert.ok(snapshot.disabledPayment,'payment must be disabled');
    await revealAll(page);
    await page.screenshot({path:join(screenshots,'desktop.png'),fullPage:true});
    console.log('Desktop initial:',JSON.stringify(snapshot));

    await page.click('.market-main-banner [data-market-next]');
    await page.waitForFunction(()=>document.querySelector('.market-main-banner').dataset.slide==='1');
    console.log('Banner next: PASS');
    await page.click('#categoriesContainer .cat-btn[data-id="2"]');
    await page.waitForFunction(()=>typeof state!=='undefined'&&String(state.currentCategory)==='2'&&state.products.every(p=>p.category_id===2));
    assert.ok((await page.$$('#productGrid .luxury-card')).length>0);
    console.log('Category navigation: PASS');

    await page.click('#categoriesContainer .cat-btn[data-id="all"]');
    await page.waitForFunction(()=>String(state.currentCategory)==='all'&&state.products.length>10);
    await page.click('.price-pill[data-min="0"][data-max="500000"]');
    await page.waitForFunction(()=>String(state.maxPrice)==='500000'&&state.products.every(p=>p.price<=500000));
    await page.select('#sortSelect','price-asc');
    await page.waitForFunction(()=>state.sort==='price-asc'&&state.products.length>1&&state.products[0].price<=state.products[1].price);
    console.log('Price filter + sort: PASS');

    await page.click('#searchInput');
    await page.type('#searchInput','tai nghe');
    await page.click('#searchBtn');
    await page.waitForFunction(()=>state.searchQuery==='tai nghe'&&state.products.length>0&&state.products.every(p=>p.name.toLowerCase().includes('tai nghe')));
    console.log('Search: PASS');

    await page.click('#searchClearBtn');
    await page.waitForFunction(()=>state.searchQuery==='' && state.products.length>10 && document.getElementById('catalogCount').getAttribute('aria-busy')==='false');
    await page.waitForSelector('#productGrid .btn-add-mini:not([disabled])');
    await page.click('#productGrid .btn-add-mini:not([disabled])');
    await page.waitForFunction(()=>document.getElementById('cartDrawer').classList.contains('open'));
    assert.equal(await page.evaluate(()=>state.cart.length),1,'cart should have an item');
    await page.screenshot({path:join(screenshots,'cart.png')});
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.getElementById('cartDrawer').classList.contains('open'));
    console.log('Cart + keyboard close: PASS');

    await page.click('#productGrid .card-heart');
    await page.click('[data-store-action="favorites"]');
    await page.waitForFunction(()=>document.getElementById('favoritesModal')?.classList.contains('open'));
    await page.waitForSelector('.favorites-item',{timeout:10000});
    await page.screenshot({path:join(screenshots,'favorites.png')});
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.getElementById('favoritesModal').classList.contains('open'));
    console.log('Favorites: PASS');

    await page.setViewport({width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true});
    await new Promise(resolve=>setTimeout(resolve,400));
    await revealAll(page);
    await page.screenshot({path:join(screenshots,'mobile.png'),fullPage:true});
    const mobile=await page.evaluate(()=>({
      width:window.innerWidth,scroll:document.documentElement.scrollWidth,
      nav:getComputedStyle(document.querySelector('.mobile-bottom-nav')).display,
      columns:getComputedStyle(document.getElementById('productGrid')).gridTemplateColumns.split(' ').length
    }));
    assert.ok(mobile.scroll<=mobile.width+5,'mobile must not overflow horizontally: '+JSON.stringify(mobile));
    assert.equal(mobile.columns,2,'mobile should show 2 products per row');
    assert.equal(mobile.nav,'grid','mobile bottom navigation must be visible');
    console.log('Mobile:',JSON.stringify(mobile));

    assert.deepEqual(pageErrors,[],'browser must not emit unhandled exceptions');
    console.log('UI SMOKE TEST PASSED. Artifacts: desktop.png, cart.png, favorites.png, mobile.png');
  } finally {
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(err=>{console.error(err.stack||err);process.exitCode=1;});
