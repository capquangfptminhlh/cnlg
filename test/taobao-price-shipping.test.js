'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const os=require('node:os'),fs=require('node:fs'),path=require('node:path');
const pricing=require('../services/taobaoPriceShipping');
const importer=require('../services/sources/taobaoImporter');
const preview=require('../services/taobaoPublic');
const now=Date.now();
const rate={
  currency_from:'CNY',currency_to:'VND',rate:3879,as_of:new Date(now-3600000).toISOString(),
  source:'ExchangeRate-API',fetched_at:new Date(now).toISOString()
};
const tariff={
  route:'CN-VN',currency:'VND',provider:'Contracted Carrier',
  updated_at:new Date().toISOString(),international_vnd_per_kg:26000,
  billing_step_kg:0.5,volumetric_divisor:6000,handling_vnd:5000,
  domestic_vnd:{hcm:30000,hn:28000,other:40000}
};
const p=(id='123456789012')=>({...importer.normalize({
  item_id:id,title:'手机充电线',zk_final_price:20,
  shipping_weight_kg:0.6,china_domestic_shipping_cny:2,
  dimensions_cm:{length:30,width:25,height:10}
},'手机'),title_vi:'Cáp sạc USB C',translation_status:'translated',
  preview_approved:true,rights_verified:true,published:true,purchasable:false,
  category_vi:'Phụ kiện điện thoại'});
test('Rate importer validates official open endpoint fields, freshness, base and currency',()=>{
  const response={result:'success',base_code:'CNY',rates:{VND:3879},
    time_last_update_unix:(now-3600000)/1000};
  const loaded=pricing.parseRate(response,now);
  assert.equal(loaded.rate,3879);
  assert.ok(pricing.currentRate(loaded,now));
  assert.equal(pricing.currentRate(loaded,now+49*3600000),null);
  assert.throws(()=>pricing.parseRate({...response,base_code:'USD'},now),/Invalid/);
  assert.throws(()=>pricing.parseRate({...response,rates:{VND:0}},now),/Invalid/);
  assert.throws(()=>pricing.parseRate({...response,time_last_update_unix:(now-99*3600000)/1000},now),/stale/);
});
test('FX refresh caches a validated rate and never stores a fabricated fallback',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'besi-fx-'));
  try{
    const file=path.join(dir,'rate.json');
    const response={result:'success',base_code:'CNY',rates:{VND:3879},
      time_last_update_unix:(now-3600000)/1000};
    const result=await pricing.refreshRate({now,file,fetchImpl:async url=>{
      assert.equal(url,pricing.RATE_URL);
      return {ok:true,json:async()=>response};
    }});
    assert.equal(pricing.getRate(file,now).rate,result.rate);
    await assert.rejects(()=>pricing.refreshRate({now,file,fetchImpl:async()=>({
      ok:true,json:async()=>({...response,rates:{VND:0}})})}),/Invalid/);
    assert.equal(pricing.getRate(file,now).rate,3879);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('CNY to VND quote includes parcel volumetric weight and both countries shipping',()=>{
  const quote=pricing.quote(p(),{now,rate,tariff,region:'hcm'});
  assert.equal(quote.status,'estimate');
  assert.equal(quote.item_vnd,77580);
  assert.equal(quote.billable_weight_kg,1.5);
  assert.equal(quote.china_domestic_shipping_vnd,7758);
  assert.equal(quote.international_shipping_vnd,39000);
  assert.equal(quote.domestic_vn_shipping_vnd,30000);
  assert.equal(quote.handling_vnd,5000);
  assert.equal(quote.shipping_vnd,81758);
  assert.equal(quote.total_vnd,159338);
  assert.equal(quote.can_order,false);
  assert.equal(quote.excludes_duty_tax,true);
  assert.equal(pricing.quote(p(),{now,rate,tariff,region:'hn'}).total_vnd,157338);
});
test('No invented shipping if carrier tariff, seller China postage or package weight is missing',()=>{
  const normal=p();
  assert.equal(pricing.quote(normal,{now,rate,region:'hcm'}).reason,'shipping_tariff_missing');
  assert.equal(pricing.quote({...normal,china_domestic_shipping_cny:null},{now,rate,tariff}).reason,
    'china_domestic_shipping_missing');
  assert.equal(pricing.quote({...normal,shipping_weight_kg:null},{now,rate,tariff}).reason,'shipping_weight_missing');
  assert.equal(pricing.quote(normal,{now,rate:null,tariff}).status,'unavailable');
  assert.equal(pricing.quote(normal,{now,rate,tariff,region:'invalid'}).status,'unavailable');
  assert.equal(pricing.quote({...normal,dimensions_cm:null},{now,rate,tariff}).reason,'dimensions_unverified');
  assert.equal(pricing.validateTariff({...tariff,domestic_vnd:{hcm:0,hn:null,other:0}}),null);
});
test('Public Taobao shows only VND estimates, not raw CNY, original IDs or supplier',()=>{
  const list=preview.getPublicCatalog([p()],{region:'hcm'},{rate,tariff});
  assert.equal(list.total,1);
  assert.equal(list.data[0].pricing.total_vnd,159338);
  assert.equal(list.data[0].pricing.item_vnd,77580);
  assert.equal(list.data[0].can_order,false);
  const exposed=JSON.stringify(list);
  assert.doesNotMatch(exposed,/price_cny_reference|shipping_weight_kg|china_domestic_shipping_cny|item\.taobao|123456789012|source_id/);
  assert.equal(list.data[0].pricing.rate_source,'ExchangeRate-API');
});
test('Feed imports shipping weight and package dimensions, explicitly free China shipping is zero',()=>{
  const raw=importer.normalize({item_id:'123456789012',title:'商品',zk_final_price:'20',
    shipping_weight_kg:'0.60',china_domestic_shipping_cny:0,
    dimensions_cm:{length:30,width:25,height:10}},'test');
  assert.equal(raw.shipping_weight_kg,0.6);
  assert.equal(raw.china_domestic_shipping_cny,0);
  assert.equal(raw.dimensions_cm.height,10);
  assert.equal(importer.normalize({item_id:'123456789012',title:'商品'},'test').china_domestic_shipping_cny,null);
});

test('New Taobao price updates existing approved preview and recalculates VND without republishing source',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'besi-taobao-reprice-'));
  const file=path.join(dir,'stage.json');
  try{
    const existing=p();
    importer.save(file,[existing]);
    await importer.sync(['手机'],{skipPermissionCheck:true,file,pages:1,noDelay:true,
      fetchPageImpl:async()=>[{item_id:'123456789012',title:'手机充电线',
        zk_final_price:'22',shipping_weight_kg:0.6,china_domestic_shipping_cny:2,
        dimensions_cm:{length:30,width:25,height:10}}],
      translateImpl:async()=>{throw Error('Price-only change must not translate again');}});
    const updated=importer.read(file).items[0];
    assert.equal(updated.preview_approved,true);
    assert.equal(updated.price_cny_reference,22);
    const result=preview.getPublicCatalog([updated],{region:'hcm'},{rate,tariff});
    assert.equal(result.data[0].pricing.item_vnd,85338);
    assert.equal(result.data[0].pricing.total_vnd,167096);
    assert.equal(result.data[0].can_order,false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
