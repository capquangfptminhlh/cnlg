'use strict';
/* Standalone BESI demo QA: NEVER loads the private product catalog.
 * All catalog items in design-preview/index.html are synthetic.
 */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const puppeteer=require('puppeteer-core');

(async()=>{
  const site=path.resolve(__dirname,'../.pages-preview-dist/index.html');
  const html=fs.readFileSync(site,'utf8');
  assert.match(html,/<title>BESI/);
  assert.match(html,/280 sản phẩm mẫu/);
  assert.match(html,/noindex,nofollow,noarchive/);
  for(const forbidden of [
    /drop\s*buy/i,/\bcnlg\b/i,/wholesale_price/i,/supplier_cost/i,
    /source_url/i,/api_image/i,/\bfetch\s*\(/i,/XMLHttpRequest/i,/WebSocket/i
  ])assert.doesNotMatch(html,forbidden,'Public demo must never reveal supplier data or call production APIs');
  const chrome=process.env.CHROME_PATH||
    ['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium'].find(fs.existsSync);
  if(!chrome)throw Error('Chromium/Chrome not found');
  const out=path.resolve(__dirname,'../preview-test-artifacts');
  fs.mkdirSync(out,{recursive:true});
  const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  try{
    for(const [width,height,label,columns] of [[1440,900,'desktop',6],[390,844,'mobile',2],[320,720,'small-mobile',2]]){
      const page=await browser.newPage();
      const errors=[];
      page.on('pageerror',err=>errors.push(err.message));
      await page.setViewport({width,height,deviceScaleFactor:1});
      await page.goto(pathToFileURL(site).href,{waitUntil:'domcontentloaded',timeout:30000});
      await page.waitForSelector('#productGrid .product-card',{timeout:12000});
      const initial=await page.evaluate(()=>({
        cards:document.querySelectorAll('#productGrid .product-card').length,
        columns:getComputedStyle(document.querySelector('#productGrid')).gridTemplateColumns.split(' ').length,
        overflow:document.documentElement.scrollWidth>innerWidth+2,
        title:document.title,
        text:document.querySelector('#resultMessage')?.textContent||''
      }));
      assert.equal(initial.columns,columns,JSON.stringify({label,initial}));
      assert.ok(initial.cards>=36,JSON.stringify({label,initial}));
      assert.ok(!initial.overflow,JSON.stringify({label,initial}));
      assert.match(initial.text,/280/);
      await page.screenshot({path:path.join(out,label+'.png')});
      await page.click('#catalogCategories [data-cat="Công nghệ"]');
      await page.waitForFunction(()=>document.querySelector('#resultMessage')?.textContent?.includes('Công nghệ'));
      await page.select('#priceRange','300000');
      await page.click('#resetCatalog');
      await page.type('#searchInput','tai nghe');
      await page.click('#searchForm button[type=submit]');
      await page.waitForFunction(()=>document.querySelectorAll('#productGrid .product-card').length>0);
      await page.click('#resetCatalog');
      await page.$eval('#productGrid [data-add]',el=>el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}));
      const tapBefore=await page.$eval('#productGrid [data-add]',el=>{
        const r=el.getBoundingClientRect();
        const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
        return {x:r.x,y:r.y,w:r.width,h:r.height,hit:hit?.outerHTML.slice(0,180),scrollY:scrollY};
      });
      await page.click('#productGrid [data-add]');
      const countAfterTap=await page.$eval('#cartCount',el=>Number(el.textContent.trim()));
      if(countAfterTap===0){
        console.error('No cart update after user tap:',JSON.stringify({label,tapBefore,errors}));
        await page.screenshot({path:path.join(out,label+'-tap-debug.png')});
      }
      await page.waitForFunction(()=>Number(document.querySelector('#cartCount')?.textContent||0)>=1,{timeout:5000});
      const count=await page.$eval('#cartCount',el=>Number(el.textContent.trim()));
      assert.ok(count>=1,'add-to-cart failed');
      const checkout=await page.$eval('#drawer button[disabled]',el=>({
        disabled:el.disabled,
        label:el.textContent.trim()
      }));
      assert.equal(checkout.disabled,true,'real checkout must be disabled in demo');
      assert.match(checkout.label,/Thanh toán/);
      assert.deepEqual(errors,[],'JS page errors: '+errors.join('; '));
      console.log(label+': PASS',JSON.stringify(initial));
      await page.close();
    }
  }finally{
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
