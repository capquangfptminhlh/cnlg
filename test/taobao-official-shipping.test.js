'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const official=require('../services/taobaoOfficialShipping');
const pairing=require('../services/taobaoBrowserPairing');
const catalog=require('../services/taobaoPublic');
const shipping=require('../services/taobaoPriceShipping');
const now=Date.now();
const rate={currency_from:'CNY',currency_to:'VND',rate:3879,
  as_of:new Date(now-3600e3).toISOString(),source:'ExchangeRate-API'};
const tariff={route:'CN-VN',currency:'VND',provider:'Contract carrier',
  updated_at:new Date(now).toISOString(),international_vnd_per_kg:26000,
  billing_step_kg:0.5,volumetric_divisor:6000,handling_vnd:5000,
  domestic_vnd:{hcm:30000,hn:28000,other:40000}};
const quote=(override={})=>({
  item_id:'123456789012',sku:'SKU-RED',region:'hcm',method:'direct',
  quote_state:'quoted',source:'taobao_checkout',destination_country:'VN',
  quantity:1,covers:'door_to_door',confirmedFromCheckout:true,
  shipping_amount:35.2,currency:'CNY',
  checked_at:new Date(now-3600e3).toISOString(),...override
});
const product=(id='123456789012')=>({
  id,title_vi:'Cáp sạc USB C',description_vi:'',category_vi:'Phụ kiện',
  options_zh:['红色 1米'],options_vi:['Đỏ 1 mét'],
  sku_variants:[{sku:'SKU-RED',label_zh:'红色 1米',price_cny_reference:20,
    shipping_weight_kg:0.6,china_domestic_shipping_cny:2,
    dimensions_cm:{length:30,width:20,height:10},updated_at:new Date(now).toISOString()}],
  translation_status:'translated',published:true,purchasable:false,
  preview_approved:true,rights_verified:true
});
test('Taobao official checkout references validate region, freshness, address, count and fees',()=>{
  const v=official.validate(quote(),now);
  assert.equal(v.shipping_amount,35.2);
  assert.equal(v.scope,'regional_reference');
  assert.equal(v.quantity,1);
  assert.throws(()=>official.validate(quote({destination_country:'CN'}),now),/checkout/);
  assert.throws(()=>official.validate(quote({quantity:2}),now),/checkout/);
  assert.throws(()=>official.validate(quote({covers:'china_domestic'}),now),/bao gồm/);
  assert.throws(()=>official.validate(quote({shipping_amount:0}),now),/miễn phí/);
  assert.throws(()=>official.validate(quote({checked_at:new Date(now-25*3600e3).toISOString()}),now),/24 giờ/);
  assert.throws(()=>official.validate(quote({region:'saigon'}),now),/Khu vực/);
  assert.throws(()=>official.validate(quote({method:'consolidated'}),now),/cân đo/);
});
test('Consolidated shipping awaiting warehouse weigh-in cannot invent an amount',()=>{
  const pending=official.validate(quote({
    method:'consolidated',quote_state:'pending_consolidation',
    shipping_amount:null,currency:null,covers:null
  }),now);
  assert.equal(pending.shipping_amount,null);
  assert.throws(()=>official.validate(quote({
    method:'consolidated',quote_state:'pending_consolidation',
    shipping_amount:20
  }),now),/không được/);
  const checked=official.validate(quote({
    method:'consolidated',weighed_at_warehouse:true
  }),now);
  assert.equal(checked.quote_state,'quoted');
});
test('Official quote store and expiry retain no passwords, cookies, URLs or names',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'besi-taobao-cainiao-'));
  try{
    const file=path.join(dir,'quotes.json');
    const saved=official.save(quote(),{file,now});
    assert.equal(saved.saved,true);
    assert.equal(official.lookup('123456789012','SKU-RED','hcm',{file,now}).shipping_amount,35.2);
    assert.equal(official.lookup('123456789012','SKU-RED','hcm',{file,now:now+25*3600e3}),null);
    assert.equal(official.lookup('123456789012','SKU-BLUE','hcm',{file,now}),null);
    const raw=fs.readFileSync(file,'utf8');
    assert.doesNotMatch(raw,/cookie|password|TaobaoSession|street_address|access_token|seller_url/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Public Taobao prefers authorized checkout sample freight and never double-counts tariff',()=>{
  const row=product();
  const approved=official.validate(quote(),now);
  const output=catalog.getPublicCatalog([row],{region:'hcm'},
    {rate,tariff,officialQuotes:[approved],now});
  assert.equal(output.total,1);
  const v=output.data[0].variants[0].pricing;
  assert.equal(v.status,'estimate');
  assert.equal(v.shipping_source,'taobao_checkout_reference');
  assert.equal(v.shipping_vnd,Math.round(35.2*3879));
  assert.equal(v.item_vnd,77580);
  assert.equal(v.total_vnd,77580+Math.round(35.2*3879));
  assert.equal(v.china_domestic_shipping_vnd,undefined);
  assert.equal(v.domestic_vn_shipping_vnd,undefined);
  assert.equal(v.can_order,false);
  const publicJson=JSON.stringify(output);
  assert.doesNotMatch(publicJson,/SKU-RED|123456789012|price_cny_reference|shipping_amount|taobao\.com/);
  const expired=catalog.getPublicCatalog([row],{region:'hcm'},
    {rate,tariff,officialQuotes:[approved],now:now+25*3600e3});
  assert.notEqual(expired.data[0].variants[0].pricing.shipping_source,'taobao_checkout_reference');
});
test('A warehouse consolidation hold suppresses numeric delivery price',()=>{
  const entry=official.validate(quote({
    method:'consolidated',quote_state:'pending_consolidation',
    shipping_amount:null,currency:null,covers:null
  }),now);
  const result=catalog.getPublicCatalog([product()],{region:'hcm'},
    {rate,tariff,officialQuotes:[entry],now});
  const v=result.data[0].variants[0].pricing;
  assert.equal(v.status,'partial');
  assert.equal(v.reason,'taobao_consolidation_pending');
  assert.equal(v.shipping_vnd,null);
  assert.equal(v.total_vnd,null);
});
test('One-time browser pairing never exposes token via status and cannot be replayed',()=>{
  pairing.clear();
  const issued=pairing.issue(now);
  assert.match(issued.token,/^[A-Za-z0-9_-]{32,100}$/);
  assert.equal(pairing.status(now).pending,true);
  assert.doesNotMatch(JSON.stringify(pairing.status(now)),new RegExp(issued.token));
  assert.equal(pairing.verify('invalid',now),false);
  assert.equal(pairing.verify(issued.token,now),true);
  assert.equal(pairing.consume(issued.token,now),true);
  assert.equal(pairing.consume(issued.token,now),false);
  const expired=pairing.issue(now);
  assert.equal(pairing.verify(expired.token,now+pairing.TTL_MS+1000),false);
  pairing.clear();
});
test('Chrome extension is limited to local Taobao DOM check; no login secrets or automation of purchase',()=>{
  const dir=path.join(__dirname,'../tools/taobao-chrome-extension');
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
  assert.equal(manifest.manifest_version,3);
  assert.ok(manifest.host_permissions.includes('https://*.taobao.com/*'));
  assert.ok(manifest.host_permissions.includes('https://besi.com.vn/*'));
  assert.ok(!manifest.host_permissions.some(h=>h.includes('alipay')));
  const js=fs.readFileSync(path.join(dir,'popup.js'),'utf8');
  assert.doesNotThrow(()=>new vm.Script(js));
  assert.match(js,/chrome\.scripting\.executeScript/);
  assert.match(js,/credentials:'omit'/);
  assert.match(js,/\/api\/taobao\/browser-quote/);
  assert.doesNotMatch(js,/document\.cookie|chrome\.cookies|localStorage|sessionStorage|fetch\('https:\/\/.*taobao|checkout\.submit|click\(\)\s*;\s*submit/);
  const html=fs.readFileSync(path.join(dir,'popup.html'),'utf8');
  assert.match(html,/id="pairCode"/);
  assert.match(html,/id="scan"/);
});
