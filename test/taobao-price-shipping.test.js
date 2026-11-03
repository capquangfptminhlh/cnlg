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
  const missingVolume=pricing.quote({...normal,dimensions_cm:null},{now,rate,tariff});
  assert.equal(missingVolume.reason,'dimensions_unverified');
  assert.equal(missingVolume.status,'partial');
  assert.equal(missingVolume.item_vnd,77580);
  assert.equal(missingVolume.shipping_vnd,null);
  assert.equal(missingVolume.total_vnd,null);
  assert.equal(missingVolume.can_order,false);
  const zeroVolume=pricing.quote({...normal,dimensions_cm:{length:0,width:25,height:10}},{now,rate,tariff});
  assert.equal(zeroVolume.total_vnd,null);
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


test('Freight-only admin checks do not invent a product price, but include regional and minimum charges',()=>{
  const prices={...tariff,
    international_vnd_per_kg_by_region:{hcm:29000,hn:23000,other:31000},
    minimum_billable_kg:0.2,minimum_international_vnd:20000};
  assert.equal(pricing.validateTariff(prices),prices);
  const row={shipping_weight_kg:0.1,china_domestic_shipping_cny:0,
    dimensions_cm:{length:4,width:4,height:4}};
  const hcm=pricing.quote(row,{freightOnly:true,now,rate,tariff:prices,region:'hcm'});
  const hn=pricing.quote(row,{freightOnly:true,now,rate,tariff:prices,region:'hn'});
  assert.equal(hcm.status,'estimate');
  assert.equal(hcm.item_vnd,null);
  assert.equal(hcm.total_vnd,null);
  assert.equal(hcm.can_order,false);
  assert.equal(hcm.billable_weight_kg,0.5);
  assert.equal(hcm.international_shipping_vnd,20000);
  assert.equal(hcm.shipping_vnd,55000); // 20k intl + 30k VN last mile + 5k handling
  assert.equal(hn.international_shipping_vnd,20000);
  assert.equal(hn.shipping_vnd,53000);
  const noTariff=pricing.quote(row,{freightOnly:true,now,rate,tariff:null});
  assert.equal(noTariff.status,'partial');
  assert.equal(noTariff.shipping_vnd,null);
  assert.equal(noTariff.total_vnd,null);
});
test('Region-specific carrier rates are applied to volumetric parcels and invalid fee configurations fail closed',()=>{
  const prices={...tariff,international_vnd_per_kg_by_region:{hcm:29000,hn:23000,other:31000}};
  const hcm=pricing.quote(p(),{now,rate,tariff:prices,region:'hcm'});
  const hn=pricing.quote(p(),{now,rate,tariff:prices,region:'hn'});
  assert.equal(hcm.international_shipping_vnd,43500); // 1.5 kg x 29k/kg
  assert.equal(hn.international_shipping_vnd,34500); // 1.5 kg x 23k/kg
  assert.equal(hcm.can_order,false);
  assert.equal(pricing.validateTariff({...prices,international_vnd_per_kg_by_region:{hcm:29000,hn:-1,other:31000}}),null);
  assert.equal(pricing.validateTariff({...prices,minimum_international_vnd:-1}),null);
  assert.equal(pricing.validateTariff({...prices,minimum_billable_kg:-1}),null);
  assert.equal(pricing.quote({...p(),dimensions_cm:{length:1000,width:10,height:10}},{now,rate,tariff:prices}).total_vnd,null);
});
