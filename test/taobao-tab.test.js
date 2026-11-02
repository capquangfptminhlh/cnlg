'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {getPublicCatalog}=require('../services/taobaoPublic');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const source=id=>({id:String(id),title_zh:'手机壳',title_vi:'Ốp điện thoại iPhone',
  description_zh:'',description_vi:'Ốp mỏng nhiều màu',translation_status:'translated',
  category_vi:'Phụ kiện điện thoại',image_reference:'https://img.alicdn.com/item.jpg',
  price_cny_reference:12.5,link_reference:'https://item.taobao.com/item.htm?id=12345',
  published:false,preview_approved:false,rights_verified:false,purchasable:false});
test('Taobao is a distinct tab in BESI desktop and mobile menus',()=>{
  const home=read('public/index.html'),page=read('public/taobao.html');
  assert.match(home,/<a class="nav-taobao" href="\/taobao"/);
  assert.match(home,/<a href="\/taobao" class="mobile-taobao"/);
  assert.match(home,/href="\/taobao-nav\.css"/);
  assert.match(page,/href="\/taobao" class="tab-link active" aria-current="page"/);
  assert.match(page,/href="\/"/);
  assert.match(page,/id="taobaoSearch"/);
  assert.match(page,/id="taobaoProducts"/);
  assert.match(page,/id="taobaoCategories"/);
  assert.match(page,/id="taobaoMore"/);
  assert.doesNotMatch(page,/app\.js|id="cartDrawer"|id="checkoutForm"|id="openCartBtn"/);
  assert.match(read('server.js'),/app\.get\('\/taobao'/);
  assert.match(read('server.js'),/app\.get\('\/api\/taobao\/products'/);
});
test('Tab assets are parseable and self-contained',()=>{
  assert.doesNotThrow(()=>new vm.Script(read('public/taobao.js')));
  assert.ok(read('public/taobao.css').includes('@media(max-width:700px)'));
  assert.ok(read('public/taobao-nav.css').includes('repeat(6,minmax(0,1fr))'));
  assert.match(read('public/taobao.js'),/textContent/);
  assert.doesNotMatch(read('public/taobao.js'),/innerHTML|eval\(/);
});
test('Unapproved or untranslated Taobao staging data never leaks publicly',()=>{
  const raw=source(123456789012);
  const result=getPublicCatalog([raw,{...raw,published:true,preview_approved:true}],{});
  assert.deepEqual(result.data,[]);
  assert.equal(result.total,0);
  assert.deepEqual(result.categories,[]);
  assert.deepEqual(getPublicCatalog([{...raw,published:true,
    preview_approved:true,rights_verified:true,translation_status:'pending'}],{}).data,[]);
});
test('Approved private staged previews return only Vietnamese fields without source or pricing',()=>{
  const raw={...source(123456789012),published:true,
    preview_approved:true,rights_verified:true,besi_image:'/images/taobao/demo.jpg'};
  const result=getPublicCatalog([raw],{q:'ốp',limit:1,page:1});
  assert.equal(result.total,1);
  assert.equal(result.categories[0],'Phụ kiện điện thoại');
  assert.equal(result.data[0].name,'Ốp điện thoại iPhone');
  assert.equal(result.data[0].image,'/images/taobao/demo.jpg');
  assert.equal(result.data[0].can_order,false);
  assert.match(result.data[0].id,/^T[a-f0-9]{18}$/);
  assert.doesNotMatch(JSON.stringify(result),/taobao\.com|alicdn\.com|price_cny|123456789012|title_zh|source/);
  const missing=getPublicCatalog([raw],{q:'không tồn tại'});
  assert.equal(missing.total,0);
});
test('Unreviewed Chinese titles or unsafe media are never exposed',()=>{
  const raw={...source(123456789012),published:true,
    preview_approved:true,rights_verified:true,title_vi:'手机壳'};
  assert.equal(getPublicCatalog([raw]).total,0);
  const valid={...raw,title_vi:'Ốp lưng',
    besi_image:'https://img.alicdn.com/a.jpg'};
  const res=getPublicCatalog([valid]);
  assert.equal(res.total,1);
  assert.equal(res.data[0].image,null);
});
