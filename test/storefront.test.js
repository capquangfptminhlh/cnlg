'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Script } = require('node:vm');
const root = join(__dirname, '..');
const read = rel => readFileSync(join(root, rel), 'utf8');
const html=read('public/index.html');
const app=read('public/app.js');
const homepage=read('public/marketplace-home.js');
const favorites=read('public/favorites.js');
const motion=read('public/motion.js');
const motionCss=read('public/motion.css');
const finishCss=read('public/storefront-finish.css');
const experienceCss=read('public/storefront-experience.css');
const marketCss=read('public/marketplace-v3.css');

test('all storefront bundles are included in dependency order', () => {
  const scripts=['app.js','marketplace-home.js','favorites.js','motion.js'];
  const styles=['styles.css','marketplace.css','marketplace-v3.css','motion.css','storefront-premium.css','storefront-finish.css','storefront-experience.css'];
  const locations=scripts.map(x=>html.indexOf('src="/'+x+'"'));
  scripts.forEach((name,i)=>assert.notEqual(locations[i],-1,name+' missing'));
  for(let i=1;i<locations.length;i++)assert.ok(locations[i]>locations[i-1],'script order invalid');
  styles.forEach(name=>assert.ok(html.includes('href="/'+name+'"'),name+' missing'));
});

test('JS syntax passes Node script parsing',()=>{
  for(const file of ['public/app.js','public/marketplace-home.js','public/motion.js','public/favorites.js']){
    assert.doesNotThrow(()=>new Script(read(file),{filename:file}));
  }
});

test('all static element IDs are unique and key checkout hooks survive',()=>{
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);
  assert.equal(new Set(ids).size,ids.length,'duplicate id');
  for(const id of ['searchInput','searchBtn','categoriesContainer','productGrid','catalogCount','productDetailModal','cartDrawer','checkoutForm','qrModal','trackModal','openTrackBtn','openCartBtn']){
    assert.ok(ids.includes(id),id+' was removed');
  }
});

test('core interactive features are connected to real app events',()=>{
  assert.ok(app.includes("new CustomEvent('storefront:cart-add'"));
  assert.ok(app.includes("new CustomEvent('storefront:products'"));
  assert.ok(app.includes("new Event('storefront:loading'"));
  assert.ok(motion.includes("addEventListener('storefront:cart-add'"));
  assert.ok(homepage.includes("addEventListener('storefront:products'"));
  assert.ok(favorites.includes("'/api/products/'"));
  assert.ok(homepage.includes('storefront:favorites-changed'));
});

test('animation honors accessibility preferences and safe dismissal',()=>{
  assert.ok(motion.includes('prefers-reduced-motion'));
  assert.ok(motionCss.includes('@media (prefers-reduced-motion:reduce)'));
  assert.ok(motion.includes("e.key==='Escape'"));
  assert.ok(motion.includes("e.key!=='Tab'"));
  assert.ok(motion.includes('IntersectionObserver'));
  assert.ok(motion.includes("document.hidden"));
  assert.ok(motion.includes("click"));
});

test('mobile grid & overlays have safety CSS',()=>{
  assert.ok(marketCss.includes('grid-template-columns:repeat(2,minmax(0,1fr))'));
  assert.ok(motionCss.includes('#cartBackdrop{'));
  assert.ok(/#cartBackdrop\s*\{[^}]*display:none/.test(motionCss),'cart overlay initially covers storefront');
  assert.ok(motionCss.includes('.mobile-bottom-nav'));
  assert.ok(motionCss.includes('.favorites-dialog'));
});

test('storefront enhancements never modify admin-only page',()=>{
  const admin=read('public/admin.html');
  assert.ok(!admin.includes('/motion.css'));
  assert.ok(!admin.includes('/motion.js'));
  assert.ok(!admin.includes('/favorites.js'));
});

test('layout and motion CSS braces remain balanced',()=>{
  for(const [name,css] of [['motion',motionCss],['marketplace-v3',marketCss],['finish',finishCss],['experience',experienceCss]]){
    const a=(css.match(/{/g)||[]).length,b=(css.match(/}/g)||[]).length;
    assert.equal(a,b,name+' CSS block mismatch');
  }
});

test('menu "Danh mục" (thanh dưới, lối tắt, tab) mở bảng danh mục thay vì chỉ nhảy tới #categoryPanel',()=>{
  const sheet=read('public/category-sheet.js');
  assert.match(html,/<script src="\/category-sheet\.js"><\/script>/);
  assert.match(html,/<link rel="stylesheet" href="\/storefront-match\.css">/);
  assert.match(sheet,/a\[href="#categoryPanel"\]/);
  assert.match(sheet,/preventDefault\(\)/);
  assert.match(sheet,/storefront:products/); // cuộn tới danh sách sau khi lọc xong
  assert.equal((html.match(/href="#categoryPanel"/g)||[]).length>=2,true);
});

test('vào danh mục là trang riêng: xem hết toàn bộ mục (cuộn vô hạn), có link riêng + nút Back',()=>{
  const view=read('public/category-view.js');
  const app=read('public/app.js');
  // phải nạp trước category-sheet.js để bảng Danh mục dùng được storeSelectCategory
  assert.ok(html.indexOf('/category-view.js')>0 && html.indexOf('/category-view.js')<html.indexOf('/category-sheet.js'));
  assert.match(view,/danh-muc/);
  assert.match(view,/popstate/);
  assert.match(view,/IntersectionObserver/);
  assert.match(view,/addEventListener\('scroll'/); // dự phòng khi nút "Tải thêm" đã nằm sẵn trong màn hình
  assert.match(app,/state\.loadingMore/);       // không nhảy cóc trang khi cuộn nhanh
  assert.match(app,/reqId !== state\.fetchSeq/); // bỏ kết quả cũ khi đổi mục giữa chừng
  assert.match(app,/insertAdjacentHTML\('beforeend'/); // tải thêm chỉ chèn thẻ mới
});


test('Flash Sale & Tổng Kho Giá Sỉ layer nạp đúng thứ tự, cân bằng ngoặc CSS và tôn trọng reduced-motion',()=>{
  const fsCss=read('public/flash-sale.css');
  const fsJs=read('public/flash-sale.js');
  assert.ok(html.includes('href="/flash-sale.css"'),'flash-sale.css missing');
  assert.ok(html.includes('src="/flash-sale.js"'),'flash-sale.js missing');
  assert.doesNotThrow(()=>new Script(fsJs,{filename:'public/flash-sale.js'}));
  const openBraces=(fsCss.match(/{/g)||[]).length, closeBraces=(fsCss.match(/}/g)||[]).length;
  assert.equal(openBraces,closeBraces,'flash-sale.css block mismatch');
  assert.match(fsCss,/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(fsCss,/body\.is-category-view\s+#flashSaleSection/);
  assert.match(fsJs,/\/api\/flash-sale/);
});


test('Đơn hàng ảo nhảy liên tục + Bảo hành DropBuy chính xác + Hiệu ứng khan hiếm nút mua',()=>{
  const fsCss=read('public/flash-sale.css');
  const fsJs=read('public/flash-sale.js');
  const appJs=read('public/app.js');
  const mHome=read('public/marketplace-home.js');
  assert.match(fsCss, /\.hm-live-order-toast/);
  assert.match(fsCss, /\.fs-warranty-line/);
  assert.match(fsCss, /\.detail-urgency-box/);
  assert.match(fsCss, /\.btn-order-now-large\.is-urgent-buy/);
  assert.match(fsJs, /hm-live-order-toast/);
  assert.match(appJs, /urgencyStatsFor/);
  assert.match(appJs, /detail-urgency-box/);
  assert.match(appJs, /is-urgent-buy/);
  assert.match(mHome, /fs-warranty-line/);
});


test('mobile header remains compact after global typography overrides',()=>{
  const css=read('public/storefront-match.css');
  const mobileStart=css.lastIndexOf('/* Mobile header sizing: override global typography');
  assert.ok(mobileStart>css.lastIndexOf('font-size: 23px !important'),
    'mobile logo size must override the final desktop font declaration');
  const mobile=css.slice(mobileStart);
  assert.match(mobile, /@media \(max-width: 700px\)/);
  assert.match(mobile, /font-size: clamp\(14px, 4\.2vw, 18px\) !important/);
  assert.match(mobile, /grid-template-columns: minmax\(0, 1fr\) 40px !important/);
  assert.match(mobile, /#productGrid\.product-grid/);
  assert.match(mobile, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});


test('approved BESI design is product-first and responsive',()=>{
  const css=read('public/besi-marketplace-2026.css');
  const index=read('public/index.html');
  assert.match(index, /<title>BESI/);
  assert.match(index, /Be\+Vietnam\+Pro:wght@400;500;600;700;800;900/);
  assert.match(index, /class="logo-mark-letter">b\.<\/span>/);
  assert.match(index, /href="\/besi-logo\.svg"/);
  assert.match(index, /href="\/besi-marketplace-2026\.css"/);
  assert.ok(index.indexOf('/besi-marketplace-2026.css')>index.indexOf('/flash-sale.css'),
    'final brand layer must load after previous CSS layers');
  assert.ok(index.indexOf('id="catalog"')<index.indexOf('id="flashSaleSection"'),
    'show full product catalog ahead of campaigns');
  for (const id of ['searchInput','categoriesContainer','productGrid','sortSelect','btnLoadMore','openCartBtn','checkoutForm']) {
    assert.match(index,new RegExp('id="'+id+'"'));
  }
  assert.match(css, /#productGrid\.product-grid\s*\{\s*grid-template-columns:\s*repeat\(6,minmax\(0,1fr\)\)/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /grid-template-columns:\s*repeat\(2,minmax\(0,1fr\)\)\s*!important/);
  assert.match(css, /font-family:\s*var\(--font\)\s*!important/);
  assert.equal((css.match(/\{/g)||[]).length,(css.match(/\}/g)||[]).length);
  assert.doesNotMatch(css,/drop\s*buy|source_url|supplier_cost|wholesale_price|api_image/i);
});


test('BESI V5 product-first desktop/mobile design keeps storefront interactions intact',()=>{
  const html=read('public/index.html');
  const css=read('public/besi-marketplace-v5.css');
  assert.match(html,/href="\/besi-marketplace-v5\.css"/);
  assert.ok(html.indexOf('/besi-marketplace-v5.css')>html.indexOf('/besi-marketplace-2026.css'));
  assert.ok(html.indexOf('id="catalog"')<html.indexOf('id="flashSaleSection"'));
  for(const id of ['searchInput','searchBtn','categoriesContainer','productGrid','sortSelect',
    'btnLoadMore','openCartBtn','checkoutForm','brandPills'])
    assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(css,/#productGrid\.product-grid\s*\{\s*grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
  assert.match(css,/@media\(min-width:1640px\)/);
  assert.match(css,/repeat\(7,minmax\(0,1fr\)\)/);
  assert.match(css,/@media\(max-width:700px\)/);
  assert.match(css,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css,/\.market-sidebar\s*\{\s*display:block !important;order:2 !important/);
  assert.equal((css.match(/\{/g)||[]).length,(css.match(/\}/g)||[]).length);
  assert.doesNotMatch(css,/dropbuy|cnlg|techmall|supplier_cost|source_url|wholesale_price|api_image/i);
  assert.match(html,/<title>BESI/);
  assert.doesNotMatch(html,/Rẻ hơn tới 70%|b class="shortcut-pop">-70%/);
});
test('BESI host uses correct SEO metadata while legacy host keeps its branding',()=>{
  const seo=require('../services/seo');
  const req=host=>({
    get(name){return name==='host'?host:undefined;},
    protocol:'https',
    socket:{remoteAddress:'127.0.0.1'}
  });
  const cfg={store:{name:'Hoàng Minh Store',slogan:'Slogan cũ'}};
  const besi=seo.renderHomePage(req('besi.com.vn'),cfg,25400);
  assert.match(besi,/<meta property="og:site_name" content="BESI">/);
  assert.match(besi,/<meta property="og:image" content="https:\/\/besi\.com\.vn\/besi-logo\.svg">/);
  assert.match(besi,/<meta name="description" content="BESI tập hợp 25\.400 sản phẩm/);
  assert.doesNotMatch(besi,/<meta property="og:site_name" content="Hoàng Minh Store">/);
  const www=seo.renderHomePage(req('www.besi.com.vn'),cfg,25400);
  assert.match(www,/<meta property="og:site_name" content="BESI">/);
  const legacy=seo.renderHomePage(req('unrelated.example'),cfg,10);
  assert.match(legacy,/<meta property="og:site_name" content="Hoàng Minh Store">/);
});


test('BESI conversion-first hero uses real public products, source-safe images and functional buy actions',()=>{
  const html=read('public/index.html');
  const js=read('public/besi-conversion.js');
  const css=read('public/besi-conversion.css');
  const {Script}=require('node:vm');
  assert.doesNotThrow(()=>new Script(js,{filename:'public/besi-conversion.js'}));
  assert.match(html,/id="besiPickList"/);
  assert.match(html,/id="besiLiveCount"/);
  assert.match(html,/Giá tốt mỗi ngày/);
  assert.match(html,/Xem sản phẩm &amp; giá/);
  assert.match(html,/\/besi-conversion\.js/);
  assert.match(html,/\/besi-conversion\.css/);
  assert.ok(html.indexOf('/besi-conversion.css')>html.indexOf('/besi-marketplace-v5.css'));
  assert.match(js,/addEventListener\('storefront:products'/);
  assert.match(js,/data.*shopProduct|dataset\.shopProduct/);
  assert.match(js,/dataset\.shopBuy/);
  assert.match(js,/safeImage = value/);
  assert.ok(js.includes('catalog-image'), 'Images must use first-party catalog proxy');
  assert.match(js,/Number\(item\.price\)/);
  assert.match(js,/item\.in_stock===false/);
  assert.match(js,/photographed\.slice\(0,3\)/);
  assert.doesNotMatch(js,/\bfetch\s*\(|XMLHttpRequest|source_url|dealer_price|wholesale_price/i);
  assert.doesNotMatch(html,/Rẻ hơn tới 70%/);
  assert.match(css,/@media\(max-width:700px\)/);
  assert.match(css,/overflow-x:auto/);
  assert.equal((css.match(/\{/g)||[]).length,(css.match(/\}/g)||[]).length);
  assert.doesNotMatch(css,/dropbuy|cnlg|techmall|supplier_cost|source_url/i);
});
