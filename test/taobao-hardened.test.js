'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const importer=require('../services/sources/taobaoImporter');
const reviewer=require('../services/taobaoPreviewReview');
const publicData=require('../services/taobaoPublic');
const pricing=require('../services/taobaoPriceShipping');
const lock=require('../services/taobaoStageLock');
const ops=require('../scripts/taobao-ops');
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'taobao-hardening-'));
const priceRate={currency_from:'CNY',currency_to:'VND',rate:3850,
  as_of:new Date().toISOString(),source:'ExchangeRate-API'};
const tariff={route:'CN-VN',currency:'VND',provider:'Real Carrier',
  updated_at:new Date().toISOString(),international_vnd_per_kg:30000,
  billing_step_kg:0.5,volumetric_divisor:6000,handling_vnd:5000,
  domestic_vnd:{hcm:15000,hn:25000,other:40000}};
const variant=(sku,label,cny)=>({sku,label_zh:label,price_cny:cny,
  shipping_weight_kg:0.6,china_domestic_shipping_cny:2,
  dimensions_cm:{length:30,width:20,height:10}});
const product=(price=20)=>({
  item_id:'123456789012',title_zh:'手机数据线',description_zh:'快充 数据线',
  category_zh:'手机配件',price_cny:18,
  sku_variants:[variant('PRIVATE-RED','红色 1米',price),variant('PRIVATE-BLUE','蓝色 2米',price+10)]
});
const mockTranslate=async rows=>rows.map(x=>({...x,title_vi:'Cáp sạc điện thoại',
  description_vi:'Dây sạc nhanh',category_vi:'Phụ kiện điện thoại',
  options_vi:['Đỏ 1 mét','Xanh 2 mét'],translation_status:'translated'}));
const createFeed=(dir,row)=>{const src=path.join(dir,'licensed.jsonl');
  fs.writeFileSync(src,JSON.stringify(row)+'\n');return src;};
const opts=file=>({file,skipPermissionCheck:true,rightsConfirmed:true,translateImpl:mockTranslate});
const approve=file=>reviewer.approve('123456789012',{rightsConfirmed:true,
  translationReviewed:true,category:'Phụ kiện điện thoại'},{file});
test('Licensed SKU prices, parcel metadata and Vietnamese variant labels stay private by default',async()=>{
  const dir=temp(),file=path.join(dir,'staging.json');
  try{
    const src=createFeed(dir,product());
    await importer.importFeed(src,opts(file));
    const staged=importer.read(file).items[0];
    assert.equal(staged.detail_source,'licensed_feed');
    assert.deepEqual(staged.options_zh,['红色 1米','蓝色 2米']);
    assert.equal(staged.sku_variants.length,2);
    assert.equal(staged.sku_variants[1].price_cny_reference,30);
    assert.equal(publicData.catalogFromStage({},()=>importer.read(file)).total,0);
    approve(file);
    const catalog=publicData.catalogFromStage({region:'hcm'},()=>importer.read(file),
      {rate:priceRate,tariff});
    assert.equal(catalog.total,1);
    assert.equal(catalog.data[0].variants.length,2);
    assert.deepEqual(catalog.data[0].variants.map(v=>v.label),['Đỏ 1 mét','Xanh 2 mét']);
    assert.equal(catalog.data[0].variants[0].pricing.item_vnd,77000);
    assert.equal(catalog.data[0].variants[1].pricing.item_vnd,115500);
    assert.equal(catalog.data[0].variants[0].pricing.status,'estimate');
    const exposed=JSON.stringify(catalog);
    assert.doesNotMatch(exposed,/PRIVATE-RED|PRIVATE-BLUE|123456789012|price_cny_reference|link_reference|detail_source/);
    assert.equal(catalog.data[0].can_order,false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Affiliate price-only re-sync cannot erase licensed detail, parcel dimensions, SKU list or review',async()=>{
  const dir=temp(),file=path.join(dir,'stage.json');
  try{
    await importer.importFeed(createFeed(dir,product()),opts(file));approve(file);
    await importer.sync(['手机数据线'],{file,skipPermissionCheck:true,pages:1,noDelay:true,
      fetchPageImpl:async()=>[{item_id:'123456789012',title:'手机数据线',zk_final_price:'19'}],
      translateImpl:async()=>{throw Error('Unchanged source text must not be retranslated');}});
    const after=importer.read(file).items[0];
    assert.equal(after.price_cny_reference,19);
    assert.equal(after.detail_source,'licensed_feed');
    assert.equal(after.description_zh,'快充 数据线');
    assert.equal(after.sku_variants.length,2);
    assert.equal(after.dimensions_cm,null); // per-variant dimension data retained
    assert.equal(after.sku_variants[1].dimensions_cm.length,30);
    assert.equal(after.preview_approved,true);
    assert.equal(publicData.catalogFromStage({},()=>importer.read(file)).total,1);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Licensed per-SKU price-only update recalculates VND without invalidating reviewed copy',async()=>{
  const dir=temp(),file=path.join(dir,'stage.json');
  try{
    const src=createFeed(dir,product(20));
    await importer.importFeed(src,opts(file));approve(file);
    createFeed(dir,product(25));
    await importer.importFeed(src,opts(file));
    const updated=publicData.catalogFromStage({region:'hcm'},()=>importer.read(file),
      {rate:priceRate,tariff});
    assert.equal(updated.total,1);
    assert.equal(updated.data[0].variants[0].pricing.item_vnd,96250);
    assert.equal(updated.data[0].variants[1].pricing.item_vnd,134750);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Changing SKU identities or translated source text invalidates public review and requires fresh approval',async()=>{
  const dir=temp(),file=path.join(dir,'stage.json');
  try{
    const original=product(),src=createFeed(dir,original);
    await importer.importFeed(src,opts(file));approve(file);
    createFeed(dir,{...original,sku_variants:[
      variant('PRIVATE-RED','红色 3米',20),variant('PRIVATE-BLUE','蓝色 2米',30)]});
    await importer.importFeed(src,opts(file));
    assert.equal(importer.read(file).items[0].preview_approved,false);
    assert.equal(publicData.catalogFromStage({},()=>importer.read(file)).total,0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Concurrent import and human preview approval are serialized with an explicit cross-process lock',async()=>{
  const dir=temp(),file=path.join(dir,'stage.json');
  try{
    await importer.importFeed(createFeed(dir,product()),opts(file));
    let release,entered=false;
    const pending=importer.sync(['手机'],{file,skipPermissionCheck:true,pages:1,noDelay:true,
      fetchPageImpl:async()=>{entered=true;return await new Promise(resolve=>{release=resolve;});},
      translateImpl:mockTranslate});
    assert.equal(entered,true);
    assert.equal(lock.lockState(file).busy,true);
    assert.throws(()=>approve(file),/staging busy/);
    release([]);
    await pending;
    assert.equal(lock.lockState(file).busy,false);
    approve(file);
    assert.equal(publicData.catalogFromStage({},()=>importer.read(file)).total,1);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Duplicate or malformed SKU identities are rejected rather than ambiguously priced',()=>{
  const raw={item_id:'123456789012',title:'手机',sku_variants:[
    variant('A','红色',20),variant('A','蓝色',30)]};
  assert.equal(importer.normalize(raw,'partner-feed'),null);
  assert.equal(importer.normalize({...raw,sku_variants:[null]},'partner-feed'),null);
  assert.equal(importer.normalize({...raw,sku_variants:[variant('A','红色',20)]},'partner-feed').sku_variants.length,1);
});
test('Operator status never prints supplier details and rejects unverified/fake carrier tariffs',()=>{
  const dir=temp(),file=path.join(dir,'stage.json'),cfg=path.join(dir,'shipping.json');
  try{
    importer.save(file,[]);
    const s=ops.status({file,rate:priceRate,tariff:null,env:{}});
    assert.equal(s.counts.staged,0);
    assert.equal(s.freight_tariff.ready,false);
    assert.equal(s.fx.ready,true);
    assert.doesNotMatch(JSON.stringify(s),/PRIVATE-RED|TAOBAO_APP_SECRET|123456789012/);
    const src=path.join(dir,'carrier.json');
    fs.writeFileSync(src,JSON.stringify({...tariff,provider:'REPLACE_WITH_CARRIER'}));
    assert.throws(()=>ops.installTariff(src,{confirmed:true,file:cfg}),/minh hoạ/);
    fs.writeFileSync(src,JSON.stringify(tariff));
    assert.throws(()=>ops.installTariff(src,{file:cfg}),/xác nhận/);
    const installed=ops.installTariff(src,{confirmed:true,file:cfg});
    assert.equal(installed.ready,true);
    assert.equal(pricing.getTariff(cfg).provider,'Real Carrier');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Old Taobao product price is not displayed even if the currency rate is current',()=>{
  const row=importer.normalize({item_id:'123456789012',title:'手机',zk_final_price:20,
    shipping_weight_kg:1,china_domestic_shipping_cny:0,
    dimensions_cm:{length:20,width:20,height:20}},'partner-feed');
  row.updated_at=new Date(Date.now()-8*86400e3).toISOString();
  const quoted=pricing.quote(row,{rate:priceRate,tariff,region:'hcm'});
  assert.equal(quoted.status,'unavailable');
  assert.equal(quoted.reason,'product_price_stale');
  assert.equal(quoted.can_order,undefined); // unavailable never contains checkout
});

test('Affiliate catalog refresh never refreshes an outdated supplier SKU price timestamp',async()=>{
  const dir=temp(),file=path.join(dir,'stage.json');
  try{
    await importer.importFeed(createFeed(dir,product()),opts(file));approve(file);
    const stage=importer.read(file);
    for(const sku of stage.items[0].sku_variants)
      sku.updated_at=new Date(Date.now()-8*86400e3).toISOString();
    importer.save(file,stage.items);
    await importer.sync(['手机数据线'],{file,skipPermissionCheck:true,pages:1,noDelay:true,
      fetchPageImpl:async()=>[{item_id:'123456789012',title:'手机数据线',zk_final_price:21}],
      translateImpl:mockTranslate});
    const result=publicData.catalogFromStage({},()=>importer.read(file),
      {rate:priceRate,tariff});
    assert.equal(result.total,1);
    assert.equal(result.data[0].variants[0].pricing.status,'unavailable');
    assert.equal(result.data[0].variants[0].pricing.reason,'product_price_stale');
    assert.equal(result.data[0].can_order,false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
