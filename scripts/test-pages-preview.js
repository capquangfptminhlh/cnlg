'use strict';
/* Test cached real retail catalog on GitHub Pages in headless Chrome.
   No real API, payments, or customer records are used. */
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {readFileSync,existsSync,mkdirSync}=require('node:fs');
const {resolve,join,sep,extname}=require('node:path');
const puppeteer=require('puppeteer-core');

(async()=>{
  const directory=resolve(__dirname,'..','.pages-preview-dist');
  const screenshots=resolve(__dirname,'..','preview-test-artifacts');
  const snapshotData=JSON.parse(readFileSync(join(directory,'products-public.json'),'utf8'));
  assert.ok(snapshotData.products.length>100,'complete cached catalog should be available');
  assert.ok(snapshotData.categories.length>10,'real category tree should be available');
  const matchingCat=snapshotData.categories.find(c=>c.parent_id===null&&c.product_count>0);
  assert.ok(matchingCat,'must have a populated top-level category');
  function categorySet(rootId) {
    const set=new Set([Number(rootId)]);let again=true;
    while(again){again=false;for(const c of snapshotData.categories)if(c.parent_id!=null&&set.has(Number(c.parent_id))&&!set.has(Number(c.id))){set.add(Number(c.id));again=true;}}
    return set;
  }
  const descendantSet=categorySet(matchingCat.id);
  const searchTerm=String(snapshotData.products.find(p=>p.name&&p.name.length>5)?.name||'').trim().split(/\s+/).slice(0,2).join(' ');
  assert.ok(searchTerm.length>1,'search term from catalog');

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
  const chrome=process.env.CHROME_PATH||['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/opt/google/chrome/chrome'].find(existsSync);
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
    assert.equal(Number(snapshot.total.replace(/\D/g,'')),snapshotData.products.length,
      'frontpage must show every existing cached product count');
    assert.equal(snapshot.featured,6,'featured section should display real API-shaped mock data');
    assert.equal(snapshot.demo,'true','DEMO must be visible');
    assert.ok(snapshot.disabledPayment,'payment must be disabled');
    await revealAll(page);
    // Cuộn tới đáy làm trang tự tải thêm (cuộn vô hạn); thẻ mới chỉ hiện dần khi được cuộn tới,
    // nên kiểm tra các thẻ của trang đầu – đã đi qua màn hình trong lúc cuộn
    const galleryHealth=await page.evaluate(initial=>{
      const cards=[...document.querySelectorAll('#productGrid .luxury-card')].slice(0,initial);
      const imgs=[...document.querySelectorAll('#productGrid .card-media img')];
      const last=[...document.querySelectorAll('#productGrid .luxury-card')].at(-1)?.getBoundingClientRect();
      const gridBottom=document.getElementById('productGrid')?.getBoundingClientRect().bottom;
      return {
        visible:cards.filter(card=>Number.parseFloat(getComputedStyle(card).opacity)>.94).length,
        loaded:imgs.filter(img=>img.complete&&img.naturalWidth>0).length,
        total:cards.length,
        bottomGap:last&&gridBottom?Math.round(gridBottom-last.bottom):9999
      };
    },snapshot.cards);
    assert.ok(galleryHealth.visible===galleryHealth.total,
      'some product cards are invisible after scroll: '+JSON.stringify(galleryHealth));
    assert.ok(galleryHealth.loaded>=Math.min(18,galleryHealth.total-2),
      'real product image thumbnails not loaded: '+JSON.stringify(galleryHealth));
    assert.ok(galleryHealth.bottomGap<110,'empty space under product grid: '+JSON.stringify(galleryHealth));
    console.log('Gallery visual quality:',JSON.stringify(galleryHealth));
    await page.screenshot({path:join(screenshots,'desktop.png'),fullPage:true});
    console.log('Desktop initial:',JSON.stringify(snapshot));
    console.log('Full retail snapshot:',JSON.stringify({items:snapshotData.products.length,categories:snapshotData.categories.length}));

    await page.click('.market-main-banner [data-market-next]');
    await page.waitForFunction(()=>document.querySelector('.market-main-banner').dataset.slide==='1');
    console.log('Banner next: PASS');
    await page.click('#categoriesContainer .cat-btn[data-id="'+matchingCat.id+'"]');
    await page.waitForFunction(id=>typeof state!=='undefined'&&String(state.currentCategory)===String(id)&&
      document.getElementById('catalogCount').getAttribute('aria-busy')==='false',{},matchingCat.id);
    assert.ok(await page.evaluate(ids=>state.products.every(p=>ids.includes(Number(p.category_id))),[...descendantSet]),
      'selected category includes child categories');
    assert.ok((await page.$$('#productGrid .luxury-card')).length>0);
    console.log('Category navigation: PASS');

    // Trong trang danh mục, cột danh mục trang chủ được ẩn; khách quay lại bằng "Trang chủ" trên dải đường dẫn
    assert.ok(await page.evaluate(()=>document.body.classList.contains('is-category-view')),'category page mode');
    await page.click('#categoryViewHead [data-cat-go="all"]');
    await page.waitForFunction(()=>String(state.currentCategory)==='all'&&state.products.length>10&&!document.body.classList.contains('is-category-view'));
    console.log('Back to home from category page: PASS');
    await page.click('.price-pill[data-min="0"][data-max="500000"]');
    await page.waitForFunction(()=>String(state.maxPrice)==='500000'&&state.products.every(p=>p.price<=500000));
    await page.select('#sortSelect','price-asc');
    await page.waitForFunction(()=>state.sort==='price-asc'&&state.products.length>1&&state.products[0].price<=state.products[1].price);
    console.log('Price filter + sort: PASS');
    // Search must use the full inventory, not the previous under-500K filter.
    await page.click('.price-pill[data-min=""][data-max=""]');
    await page.waitForFunction(()=>state.minPrice===''&&state.maxPrice===''&&
      document.getElementById('catalogCount').getAttribute('aria-busy')==='false');

    await page.click('#searchInput');
    await page.type('#searchInput',searchTerm);
    await page.click('#searchBtn');
    await page.waitForFunction(q=>state.searchQuery===q&&state.products.length>0&&
      document.getElementById('catalogCount').getAttribute('aria-busy')==='false',{},searchTerm);
    console.log('Search: PASS');

    // The autocomplete is a usable keyboard interaction, not decoration.
    await page.click('#searchClearBtn');
    await page.waitForFunction(()=>state.searchQuery==='');
    await page.type('#searchInput',searchTerm);
    await page.waitForSelector('#searchDropdown [data-preview-id]',{visible:true,timeout:10000});
    await page.keyboard.press('ArrowDown');
    const suggestionFocused=await page.evaluate(()=>document.activeElement?.hasAttribute('data-preview-id'));
    assert.equal(suggestionFocused,true,'ArrowDown should focus a real product suggestion');
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.getElementById('productDetailModal').classList.contains('open'),{timeout:10000});
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.getElementById('productDetailModal').classList.contains('open'));
    console.log('Modal checkpoint afterDetail:',JSON.stringify(await page.evaluate(()=>({className:document.getElementById('productDetailModal').className,hash:location.hash,path:location.pathname,display:getComputedStyle(document.getElementById('productDetailModal')).display}))));
    console.log('Autocomplete keyboard & real product details: PASS');
    // Closing detail while its API request is slow must not re-open it or
    // write a stale #/sp/ URL after the response eventually resolves.
    await page.evaluate(()=>{
      window.__baseDemoFetch=window.fetch;
      window.fetch=(input,init)=>typeof input==='string'&&/^\/api\/products\/\d+$/.test(input)
        ?new Promise(resolve=>setTimeout(()=>resolve(window.__baseDemoFetch(input,init)),450))
        :window.__baseDemoFetch(input,init);
    });
    await page.evaluate(id=>{window.openProductDetail(id);},snapshotData.products[0].id);
    await page.waitForFunction(()=>document.getElementById('productDetailModal').classList.contains('open'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.getElementById('productDetailModal').classList.contains('open'));
    await new Promise(resolve=>setTimeout(resolve,630));
    const afterSlowClose=await page.evaluate(()=>({
      open:document.getElementById('productDetailModal').classList.contains('open'),
      url:location.pathname+location.hash
    }));
    assert.ok(!afterSlowClose.open && !afterSlowClose.url.includes('/sp/'),
      'late product detail response changed closed dialog: '+JSON.stringify(afterSlowClose));
    await page.evaluate(()=>{window.fetch=window.__baseDemoFetch;delete window.__baseDemoFetch;});
    console.log('Close dialog before slow API finishes: PASS');


    await page.click('#searchClearBtn');
    await page.waitForFunction(()=>state.searchQuery==='' && state.products.length>10 && document.getElementById('catalogCount').getAttribute('aria-busy')==='false');
    await page.waitForSelector('#productGrid .btn-add-mini:not([disabled])');
    await page.click('#productGrid .btn-add-mini:not([disabled])');
    await page.waitForFunction(()=>document.getElementById('cartDrawer').classList.contains('open'));
    assert.equal(await page.evaluate(()=>state.cart.length),1,'cart should have an item');
    const cartToastOverlap=await page.evaluate(()=>{
      const note=document.querySelector('#toastNotification');
      const footer=document.querySelector('#cartDrawer .drawer-footer');
      if(!note||note.classList.contains('hidden'))return null;
      return {toastBottom:note.getBoundingClientRect().bottom,footerTop:footer.getBoundingClientRect().top};
    });
    if(cartToastOverlap)assert.ok(cartToastOverlap.toastBottom<=cartToastOverlap.footerTop+1,
      'cart notification blocks checkout button: '+JSON.stringify(cartToastOverlap));

    await page.screenshot({path:join(screenshots,'cart.png')});
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.getElementById('cartDrawer').classList.contains('open'));
    console.log('Modal checkpoint afterCart:',JSON.stringify(await page.evaluate(()=>({className:document.getElementById('productDetailModal').className,hash:location.hash,path:location.pathname,display:getComputedStyle(document.getElementById('productDetailModal')).display}))));
    console.log('Cart + keyboard close: PASS');

    await page.click('#productGrid .card-heart');
    await page.click('[data-store-action="favorites"]');
    await page.waitForFunction(()=>document.getElementById('favoritesModal')?.classList.contains('open'));
    await page.waitForSelector('.favorites-item',{timeout:10000});
    await page.screenshot({path:join(screenshots,'favorites.png')});
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.getElementById('favoritesModal').classList.contains('open'));
    console.log('Modal checkpoint afterFavorites:',JSON.stringify(await page.evaluate(()=>({className:document.getElementById('productDetailModal').className,hash:location.hash,path:location.pathname,display:getComputedStyle(document.getElementById('productDetailModal')).display}))));
    console.log('Favorites: PASS');

    await page.setViewport({width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true});
    await new Promise(resolve=>setTimeout(resolve,400));
    await revealAll(page);
    const overlayHealth=await page.evaluate(()=>[...document.querySelectorAll('.modal-backdrop')].map(el=>({
      id:el.id,classes:el.className,display:getComputedStyle(el).display,
      visible:el.getBoundingClientRect().height>0&&getComputedStyle(el).visibility!=='hidden'
    })));
    console.log('Mobile overlays:',JSON.stringify(overlayHealth));
    assert.ok(overlayHealth.every(x=>!x.visible),'modal remained visible behind mobile catalog: '+JSON.stringify(overlayHealth));
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

    // Purchase journey: genuine catalog product, mobile gallery, quantities,
    // checkout presentation. NEVER submit an order on the demo.
    const availableProduct=snapshotData.products.find(p=>p.in_stock!==false);
    await page.evaluate(id=>openProductDetail(id),availableProduct.id);
    await page.waitForFunction(()=>Boolean(document.querySelector('#productDetailModal.open .detail-title')));
    const initialQty=await page.$eval('#modalQtyDisplay',x=>x.textContent.trim());
    assert.equal(initialQty,'1');
    await page.click('#productDetailModal .qty-stepper button[aria-label="Tăng số lượng"]');
    assert.equal(await page.$eval('#modalQtyDisplay',x=>x.textContent.trim()),'2');
    await page.click('#productDetailModal .qty-stepper button[aria-label="Giảm số lượng"]');
    assert.equal(await page.$eval('#modalQtyDisplay',x=>x.textContent.trim()),'1');
    const productGeometry=await page.evaluate(()=>{
      const m=document.querySelector('#productDetailModal .product-modal-dialog');
      const content=document.querySelector('#productDetailModal .detail-modal-content');
      const grid=document.querySelector('#productDetailModal .product-detail-grid');
      const gallery=document.querySelector('#productDetailModal .detail-gallery');
      const info=document.querySelector('#productDetailModal .detail-info');
      const preview=document.querySelector('#productDetailModal .main-preview-box');
      const actions=document.querySelector('#productDetailModal .detail-actions-row');
      const close=document.getElementById('closeDetailModalBtn');
      const thumbs=[...document.querySelectorAll('#productDetailModal .thumb-item')];
      const bounds=m.getBoundingClientRect();
      const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width}};
      return {right:bounds.right,width:bounds.width,height:bounds.height,
        docWidth:document.documentElement.scrollWidth,thumbs:thumbs.length,
        buttons:thumbs.every(x=>x.tagName==='BUTTON'),aria:thumbs.every(x=>x.hasAttribute('aria-label')),
        content:rect(content),grid:rect(grid),gallery:rect(gallery),info:rect(info),
        preview:rect(preview),actions:rect(actions),closeFloat:getComputedStyle(close).float};
    });
    assert.ok(productGeometry.right<=mobile.width+2,
      'product sheet clips mobile: '+JSON.stringify(productGeometry));
    assert.equal(productGeometry.closeFloat,'none','close button must not float over product grid');
    assert.ok(productGeometry.content.width>=productGeometry.width-4 &&
      productGeometry.grid.width>=productGeometry.width-4 &&
      productGeometry.gallery.width>=productGeometry.width-4 &&
      productGeometry.info.width>=productGeometry.width-4,
      'product sheet leaves blank space on the right: '+JSON.stringify(productGeometry));
    assert.ok(productGeometry.preview.width>=productGeometry.gallery.width-28 &&
      productGeometry.actions.right<=productGeometry.right+2 &&
      productGeometry.actions.left>=-2,
      'product gallery or actions do not fit mobile sheet: '+JSON.stringify(productGeometry));
    assert.ok(productGeometry.buttons&&productGeometry.aria&&productGeometry.thumbs>0,
      'gallery thumbnails must be keyboard-accessible');
    await page.screenshot({path:join(screenshots,'detail-mobile.png')});
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.getElementById('productDetailModal').classList.contains('open'));

    await page.evaluate(()=>openCheckoutModal());
    await page.waitForFunction(()=>document.getElementById('checkoutModal').classList.contains('open'));
    assert.equal(await page.$eval('#submitOrderBtn',el=>el.disabled),true,
      'demo must not allow real orders');
    const checkoutGeometry=await page.evaluate(()=>{
      const m=document.querySelector('#checkoutModal .checkout-dialog');
      const r=m.getBoundingClientRect();
      return {width:r.width,right:r.right,scrollWidth:m.scrollWidth,clientWidth:m.clientWidth,
        codLabel:document.querySelector('#payOptCod strong')?.textContent.trim()};
    });
    assert.ok(checkoutGeometry.right<=mobile.width+2 &&
      checkoutGeometry.scrollWidth<=checkoutGeometry.clientWidth+3,
      'mobile checkout overflows: '+JSON.stringify(checkoutGeometry));
    await page.screenshot({path:join(screenshots,'checkout-mobile.png')});
    await page.click('#closeCheckoutBtn');
    await page.waitForFunction(()=>!document.getElementById('checkoutModal').classList.contains('open'));
    console.log('Mobile detail gallery + quantity + safe checkout: PASS',
      JSON.stringify({productGeometry,checkoutGeometry}));



    // Catch narrow-phone clipping and tablet sidebar/banner overflow.
    for(const width of [360,768]){
      await page.setViewport({width,height:800,deviceScaleFactor:1,isMobile:false,hasTouch:false});
      await new Promise(resolve=>setTimeout(resolve,220));
      const geometry=await page.evaluate(()=>{
        const hero=document.querySelector('.market-main-banner').getBoundingClientRect();
        const section=document.getElementById('featuredSection').getBoundingClientRect();
        const imgs=[...document.querySelectorAll('#featuredProducts .featured-media img')];
        return {
          width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
          heroLeft:Math.round(hero.left),heroRight:Math.round(hero.right),
          firstProductTop:Math.round(document.querySelector('#featuredProducts .featured-card').getBoundingClientRect().top+window.scrollY),
          featuredTop:Math.round(section.top+window.scrollY),
          photos:imgs.filter(x=>x.complete&&x.naturalWidth>0).length
        };
      });
      assert.ok(geometry.scrollWidth<=width+5,'horizontal overflow at '+width+': '+JSON.stringify(geometry));
      assert.ok(geometry.heroLeft>=-1&&geometry.heroRight<=width+1,'hero clipped at '+width+': '+JSON.stringify(geometry));
      if(width===360)assert.ok(geometry.firstProductTop<670,'products too far down on small phones: '+JSON.stringify(geometry));
      console.log('Responsive '+width+'px:',JSON.stringify(geometry));
    }

    assert.deepEqual(pageErrors,[],'browser must not emit unhandled exceptions');
    console.log('UI SMOKE TEST PASSED. Artifacts: desktop.png, cart.png, favorites.png, mobile.png, detail-mobile.png, checkout-mobile.png');
  } finally {
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(err=>{console.error(err.stack||err);process.exitCode=1;});
