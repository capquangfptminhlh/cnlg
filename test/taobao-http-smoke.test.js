'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');

// The server is imported, never launched through require.main, so the
// production catalog sync/order workers do not start in this HTTP smoke test.
process.env.ADMIN_PASSWORD='TAOBAO_HTTP_SMOKE_TEST_ONLY_PASSWORD_DO_NOT_USE';
process.env.TAOBAO_AUTO_SYNC='0';
const {app}=require('../server');
async function withServer(fn){
  const listener=http.createServer(app);
  await new Promise((resolve,reject)=>{
    listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);
  });
  try{return await fn('http://127.0.0.1:'+listener.address().port);}
  finally{await new Promise((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));}
}
test('Real BESI HTTP routes serve dedicated Taobao tab and its API (never an order/cart)',async()=>{
  await withServer(async url=>{
    const tab=await fetch(url+'/taobao',{redirect:'manual'});
    assert.equal(tab.status,200);
    assert.match(tab.headers.get('content-type')||'',/text\/html/);
    const html=await tab.text();
    assert.match(html,/id="taobaoProducts"/);
    assert.match(html,/id="taobaoRegion"/);
    assert.doesNotMatch(html,/id="checkoutForm"|id="cartDrawer"/);
    const script=await fetch(url+'/taobao.js');
    assert.equal(script.status,200);
    const code=await script.text();
    assert.match(code,/\/api\/taobao\/products/);
    assert.match(code,/quoteBlock/);
    const catalog=await fetch(url+'/api/taobao/products?limit=1&region=hcm');
    assert.equal(catalog.status,200);
    const json=await catalog.json();
    assert.equal(json.success,true);
    assert.ok(Array.isArray(json.data));
    assert.ok(Number.isInteger(json.total));
    for(const item of json.data){
      assert.equal(item.can_order,false);
      assert.equal(Object.hasOwn(item,'price_cny_reference'),false);
      assert.equal(Object.hasOwn(item,'link_reference'),false);
      assert.equal(Object.hasOwn(item,'source_id'),false);
      assert.equal(Object.hasOwn(item,'sku_variants'),false);
    }
  });
});
test('Real HTTP rejects anonymous Taobao admin reads/writes including image and price sync',async()=>{
  await withServer(async url=>{
    const paths=[
      {path:'/api/admin/taobao/status',method:'GET'},
      {path:'/api/admin/taobao/review',method:'GET'},
      {path:'/api/admin/taobao/sync',method:'POST'},
      {path:'/api/admin/taobao/fx-refresh',method:'POST'},
      {path:'/api/admin/taobao/tariff',method:'POST'},
      {path:'/api/admin/taobao/approve/123456789012',method:'POST'},
      {path:'/api/admin/taobao/revoke/123456789012',method:'POST'},
      {path:'/api/admin/taobao/image',method:'POST',
        headers:{'Content-Type':'image/png','x-taobao-rights-confirmed':'1'},
        body:Buffer.from('89504e470d0a1a0a0000000d4948445200000001','hex')}
    ];
    for(const entry of paths){
      const r=await fetch(url+entry.path,{method:entry.method,headers:entry.headers,
        body:entry.body|| (entry.method==='POST'?'{}':undefined),redirect:'manual'});
      assert.ok(r.status===401||r.status===403,
        entry.path+' must reject anonymous mutation: HTTP '+r.status);
      const body=await r.text();
      assert.doesNotMatch(body,/TAOBAO_APP_SECRET|TAOBAO_APP_KEY|ADMIN_PASSWORD=/);
    }
    const restricted=await fetch(url+'/admin-besi.html',{redirect:'manual'});
    assert.equal(restricted.status,200);
    assert.doesNotMatch(await restricted.text(),/id="taobaoAdminTariffJson"/,
      'Anonymous browsers must never receive the internal Taobao admin form');
  });
});
