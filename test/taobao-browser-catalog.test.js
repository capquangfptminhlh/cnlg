'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const catalog=require('../services/taobaoBrowserCatalog');
const pairing=require('../services/taobaoCatalogCaptureSession');
const importer=require('../services/sources/taobaoImporter');
const preview=require('../services/taobaoPublic');
const NOW=Date.now();
function record(extra={}){
  return {item_id:'123456789012',title_zh:'手机充电线',
    product_url:'https://item.taobao.com/item.htm?id=123456789012&share=ignored',
    page_type:'product',observed_at:new Date(NOW).toISOString(),
    price_cny:22,stock_status:'in_stock',stock_quantity:17,quantity_explicit:true,...extra};
}
const translated=async rows=>rows.map(r=>({...r,
  title_vi:'Dây cáp sạc điện thoại',description_vi:'',category_vi:'',
  options_vi:[],translation_status:'translated'}));
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'besi-taobao-catalog-'));
test('Capture checks matching Taobao URL, valid price, fresh observation and no redirects',()=>{
  const ok=catalog.normalizeObservation(record(),NOW);
  assert.equal(ok.id,'123456789012');
  assert.equal(ok.price_cny,22);
  assert.equal(ok.stock_quantity,17);
  assert.equal(ok.url,'https://item.taobao.com/item.htm?id=123456789012');
  assert.equal(catalog.normalizeObservation(record({
    product_url:'https://other.test/item.htm?id=123456789012'}),NOW),null);
  assert.equal(catalog.normalizeObservation(record({
    product_url:'https://item.taobao.com/item.htm?id=999999999999'}),NOW),null);
  assert.equal(catalog.normalizeObservation(record({
    observed_at:new Date(NOW-11*60000).toISOString()}),NOW),null);
  assert.equal(catalog.normalizeObservation(record({title_zh:''}),NOW),null);
  assert.equal(catalog.normalizeObservation(record({item_id:'abc'}),NOW),null);
});
test('Listing says available but does not reveal a precise stock count',()=>{
  const listing=catalog.normalizeObservation(record({page_type:'listing',quantity_explicit:true,
    stock_quantity:17}),NOW);
  assert.equal(listing.stock_status,'in_stock');
  assert.equal(listing.stock_quantity,null);
  assert.equal(listing.quantity_explicit,false);
  const noSignal=catalog.normalizeObservation(record({stock_status:'unknown',
    stock_quantity:10000,quantity_explicit:true}),NOW);
  assert.equal(noSignal.stock_status,'unknown');
  assert.equal(noSignal.stock_quantity,null);
  const wrong=catalog.normalizeObservation(record({price_cny:0}),NOW);
  assert.equal(wrong.price_cny,null);
});
test('Browser capture creates private Taobao staging but never publishes or authorizes checkout',async()=>{
  const dir=temp(),file=path.join(dir,'taobao-staging.json');
  try{
    await assert.rejects(catalog.ingest([record()],{file,now:NOW}),/permission/);
    await assert.rejects(catalog.ingest([],{file,now:NOW,rightsConfirmed:true}),/1-30/);
    const result=await catalog.ingest([record()],{file,now:NOW,
      rightsConfirmed:true,translateImpl:translated});
    assert.equal(result.fetched,1);
    assert.equal(result.inventory_observed,1);
    assert.equal(result.exact_stock_counts,1);
    assert.equal(result.checkout_enabled,false);
    const row=importer.read(file).items[0];
    assert.equal(row.price_cny_reference,22);
    assert.equal(row.stock_quantity,17);
    assert.equal(row.stock_status,'in_stock');
    assert.equal(row.stock_verified,true);
    assert.equal(row.catalog_observation_source,'operator_browser');
    assert.equal(row.purchasable,false);
    assert.equal(row.published,false);
    assert.equal(row.translation_status,'translated');
    assert.equal(preview.catalogFromStage({},()=>importer.read(file)).total,0);
    assert.deepEqual(catalog.availability(row,NOW).status,'in_stock');
    assert.deepEqual(catalog.availability(row,NOW+3*3600000).status,'unknown');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Another page observation preserves reviewed translation, supplier SKU detail and old price when not observed',async()=>{
  const dir=temp(),file=path.join(dir,'stage.json');
  try{
    await catalog.ingest([record()],{file,now:NOW,rightsConfirmed:true,
      translateImpl:translated});
    const stage=importer.read(file);
    const item=stage.items[0];
    item.description_zh='高速充电';item.description_vi='Sạc nhanh';
    item.options_zh=['红色'];item.options_vi=['Màu đỏ'];
    item.sku_variants=[{sku:'RED',label_zh:'红色',price_cny_reference:25,
      updated_at:new Date(NOW-3*3600000).toISOString()}];
    item.category_zh='手机配件';item.category_vi='Phụ kiện';
    item.title_vi='Dây cáp sạc điện thoại';
    item.translation_status='translated';
    item.preview_approved=true;item.rights_verified=true;
    item.published=true;item.purchasable=false;
    item.updated_at=new Date(NOW-6*86400000).toISOString();
    importer.save(file,stage.items);
    await catalog.ingest([record({price_cny:null,stock_status:'unknown',
      stock_quantity:null,quantity_explicit:false})],{
      file,now:NOW,rightsConfirmed:true,translateImpl:translated});
    const saved=importer.read(file).items[0];
    assert.equal(saved.price_cny_reference,22);
    assert.equal(saved.updated_at,item.updated_at,'no new price should not refresh old price time');
    assert.equal(saved.options_zh[0],'红色');
    assert.equal(saved.sku_variants[0].sku,'RED');
    assert.equal(saved.description_zh,'高速充电');
    assert.equal(saved.preview_approved,true);
    assert.equal(saved.published,true);
    assert.equal(saved.stock_quantity,17);
    assert.equal(preview.catalogFromStage({},()=>importer.read(file)).total,1);
    await catalog.ingest([record({title_zh:'完全不同的产品',stock_status:'out_of_stock',
      stock_quantity:null,quantity_explicit:false})],{
      file,now:NOW,rightsConfirmed:true,translateImpl:translated});
    const changed=importer.read(file).items[0];
    assert.equal(changed.preview_approved,false,'changed source title requires renewed review');
    assert.equal(changed.stock_status,'out_of_stock');
    assert.equal(changed.stock_quantity,null);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Browser catalog capture token is revocable, 20-minute-only and never part of Taobao login',()=>{
  pairing.revoke();
  const issued=pairing.issue(NOW);
  assert.match(issued.token,/^[A-Za-z0-9_-]{32,100}$/);
  assert.equal(pairing.verify(issued.token,NOW),true);
  assert.equal(pairing.status(NOW).active,true);
  pairing.recorded(5);
  assert.equal(pairing.status(NOW).accepted,5);
  assert.doesNotMatch(JSON.stringify(pairing.status(NOW)),new RegExp(issued.token));
  assert.equal(pairing.verify(issued.token,NOW+pairing.TTL+1),false);
  pairing.revoke();
  assert.equal(pairing.verify(issued.token,NOW),false);
});
test('Browser extension only observes visited Taobao pages; it never handles account secrets or automated purchase',()=>{
  const dir=path.resolve(__dirname,'../tools/taobao-chrome-extension');
  const m=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
  assert.equal(m.background.service_worker,'catalog-background.js');
  assert.equal(m.content_scripts[0].run_at,'document_idle');
  assert.ok(m.content_scripts[0].matches.includes('https://*.taobao.com/*'));
  for(const filename of ['catalog-background.js','catalog-content.js','popup.js']){
    const js=fs.readFileSync(path.join(dir,filename),'utf8');
    assert.doesNotThrow(()=>new vm.Script(js,{filename}));
    assert.doesNotMatch(js,/chrome\.cookies|document\.cookie|localStorage|sessionStorage|puppeteer|playwright|(?:placeOrder|confirmPayment)\(/);
  }
  const bg=fs.readFileSync(path.join(dir,'catalog-background.js'),'utf8');
  assert.match(bg,/chrome\.storage\.session/);
  assert.match(bg,/credentials:'omit'/);
  assert.match(bg,/BESI_CAPTURE_STOP/);
  const page=fs.readFileSync(path.join(dir,'catalog-content.js'),'utf8');
  assert.match(page,/BESI_TAOBAO_CATALOG_PAGE/);
  assert.doesNotMatch(page,/fetch\(|\.click\(|\.submit\(/);
  const popup=fs.readFileSync(path.join(dir,'popup.html'),'utf8');
  assert.match(popup,/id="catalogStart"/);
  assert.match(popup,/id="catalogScan"/);
  assert.match(popup,/id="catalogStop"/);
});
