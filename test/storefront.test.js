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
