'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const imp=require('../services/sources/taobaoImporter');
const item=(id,title='手机充电线')=>({item_id:String(id),title,
  zk_final_price:'12.50',pict_url:'https://img.alicdn.com/abc.jpg',
  item_url:'https://item.taobao.com/item.htm?id='+id,sku_options:['红色','蓝色']});

test('Taobao Open Platform request is signed and paginated without exposing secret',async()=>{
  let sent=null;
  const fake=async(url,opts)=>{
    sent={url,params:new URLSearchParams(opts.body)};
    return {ok:true,json:async()=>({tbk_dg_material_optional_response:{
      result_list:{map_data:[item(123456789012)]}}})};
  };
  const results=await imp.fetchPage('手机充电线',2,{
    appKey:'key',appSecret:'secret',adzoneId:'12345',now:new Date('2026-11-02T00:01:02Z'),fetchImpl:fake});
  assert.equal(results.length,1);
  assert.equal(sent.url,'https://eco.taobao.com/router/rest');
  assert.equal(sent.params.get('page_no'),'2');
  assert.equal(sent.params.get('q'),'手机充电线');
  assert.equal(sent.params.get('timestamp'),'2026-11-02 08:01:02');
  assert.match(sent.params.get('sign'),/^[A-F0-9]{32}$/);
  assert.equal(sent.params.has('app_secret'),false);
});
test('Taobao API fails closed on API errors',async()=>{
  assert.throws(()=>imp.extract({error_response:{msg:'Denied'}}),/Denied/);
  assert.throws(()=>imp.extract({whatever:'x'}),/Unknown/);
});
test('Chinese title, specifications and currency are staged, never purchasable',()=>{
  const row=imp.normalize(item(123456789012),'手机充电线');
  assert.equal(row.id,'123456789012');
  assert.equal(row.price_cny_reference,12.5);
  assert.equal(row.published,false);
  assert.equal(row.purchasable,false);
  assert.equal(row.landed_cost_vnd,null);
  assert.equal(row.stock_verified,false);
  assert.equal(row.translation_status,'pending');
  assert.equal(imp.normalize({item_id:'bad',title:'a'},'x'),null);
});
test('Vietnamese translation checks title, description and all SKU options',async()=>{
  const row=imp.normalize(item(123456789012),'dây sạc');
  const fetchImpl=async()=>({ok:true,json:async()=>({response:JSON.stringify({items:[
    {id:row.id,title_vi:'Cáp sạc điện thoại',description_vi:'',
      options_vi:['Màu đỏ','Màu xanh']} ]})})});
  const translated=await imp.translate([row],{model:'mock',fetchImpl});
  assert.equal(translated[0].translation_status,'translated');
  assert.deepEqual(translated[0].options_vi,['Màu đỏ','Màu xanh']);
  const broken=await imp.translate([row],{model:'mock',fetchImpl:async()=>({
    ok:true,json:async()=>({response:JSON.stringify({items:[{id:row.id,title_vi:'手机',options_vi:['Xanh']}]})})
  })});
  assert.equal(broken[0].translation_status,'pending');
});
test('Import keeps existing rows after partial search, avoids duplicates and does not publish',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'taobao-import-'));
  const file=path.join(dir,'staging.json');
  try {
    let calls=0;
    const opts={file,skipPermissionCheck:true,noDelay:true,pages:2,
      fetchPageImpl:async()=>{calls++;return [item(123456789012)];},
      translateImpl:async rows=>rows.map(x=>({...x,title_vi:'Cáp sạc',
        options_vi:['Đỏ','Xanh'],translation_status:'translated'}))};
    const first=await imp.sync(['手机充电线','手机壳'],opts);
    assert.equal(first.fetched,1);
    assert.equal(first.staged,1);
    assert.equal(first.published,0);
    const second=await imp.sync(['手机壳'],{...opts,fetchPageImpl:async()=>[]});
    assert.equal(second.staged,1);
    const saved=imp.read(file);
    assert.equal(saved.items[0].title_vi,'Cáp sạc');
    assert.equal(saved.items[0].purchasable,false);
    assert.equal(calls,2);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
