'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const importer=require('../services/sources/taobaoImporter');
const review=require('../services/taobaoPreviewReview');
const manual=require('../services/taobaoManualSync');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'taobao-admin-'));

test('All Taobao dashboard operations are authenticated and rate-limited, never public purchase actions',()=>{
  const server=read('server.js');
  for(const [method,url] of [
    ['get','status'],['get','review'],['post','approve/:id'],
    ['post','revoke/:id'],['post','tariff'],['post','shipping-check'],['post','fx-refresh'],['post','sync']]){
    const route='/api/admin/taobao/'+url;
    const re=new RegExp("app\\."+method+"\\('"+route.replace(/\//g,'\\/').replace(':id',':id')+"',requireAdmin,rateLimit\\(");
    assert.match(server,re,'Taobao admin route needs auth and per-IP rate limit: '+route);
  }
  assert.match(server,/taobaoReview\.approve\(req\.params\.id/);
  assert.match(server,/taobaoReview\.revoke\(req\.params\.id/);
  assert.match(server,/taobaoPriceShipping\.validateTariff\(req\.body\?\.tariff\)/);
  assert.doesNotMatch(server.slice(server.indexOf("app.get('/api/admin/taobao/status'"),
    server.indexOf("app.get('/sp/:slugId'")),/createOrder|checkout|confirmPayment|purchase|source_url/);
});
test('Taobao dashboard is behind the existing admin-besi asset gate and uses safe text operations',()=>{
  const server=read('server.js'),html=read('public/admin-besi.html'),js=read('public/admin-besi.js');
  assert.match(server,/if \(base === 'admin.html' \|\| base === 'admin-besi.html'\)/);
  assert.match(html,/id="taobao"/);
  assert.match(html,/id="taobaoAdminReviewForm"/);
  assert.match(html,/id="taobaoAdminTariffForm"/);
  assert.match(html,/id="taobaoAdminShippingCheckForm"/);
  assert.match(html,/id="taobaoAdminRows"/);
  assert.match(html,/id="taobaoAdminView"/);
  for(const route of ['/api/admin/taobao/status','/api/admin/taobao/review',
    '/api/admin/taobao/approve/','/api/admin/taobao/revoke/',
    '/api/admin/taobao/tariff','/api/admin/taobao/fx-refresh','/api/admin/taobao/sync']){
    assert.ok(js.includes(route),'Dashboard needs route '+route);
  }
  assert.doesNotThrow(()=>new vm.Script(js,{filename:'admin-besi.js'}));
  assert.doesNotMatch(js,/innerHTML|eval\(/);
  assert.doesNotMatch(html,/sk-proj|TAOBAO_APP_SECRET|TAOBAO_APP_KEY|name="password"/);
  assert.match(read('public/admin-besi.css'),/taobao-admin-forms/);
});
test('Review management can navigate beyond the first 30 products and search untranslated rows',()=>{
  const dir=temp(),file=path.join(dir,'staging.json');
  try{
    const rows=Array.from({length:113},(_,i)=>({
      ...importer.normalize({item_id:String(123456789000+i),title:'手机配件'},'partner-feed'),
      title_vi:i%2?'Cáp sạc '+i:'',category_vi:'Phụ kiện điện thoại',
      translation_status:i%2?'translated':'pending',
      options_vi:[],description_vi:''
    }));
    rows[55].preview_approved=true;rows[55].rights_verified=true;rows[55].published=true;
    importer.save(file,rows);
    const a=review.list({file,limit:20,page:3});
    assert.equal(a.total,113);
    assert.equal(a.rows.length,20);
    assert.equal(a.rows[0].id,String(123456789040));
    const b=review.list({file,view:'review',limit:100,page:1});
    assert.equal(b.total,55);
    const c=review.list({file,view:'approved',limit:20});
    assert.equal(c.total,1);
    assert.equal(c.rows[0].id,String(123456789055));
    const q=review.list({file,q:'Cáp sạc 77',view:'all'});
    assert.equal(q.total,1);
    assert.equal(q.rows[0].title_vi,'Cáp sạc 77');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Manual sync is opt-in, no credentials means no network activity, duplicate jobs blocked',async()=>{
  assert.throws(()=>manual.start({config:null,env:{TAOBAO_AUTO_SYNC:'0'}}),/Chưa cấu hình/);
  // Real manual operator workflow: own API access can be enabled without
  // enabling a 24/7 periodic schedule.
  const manualAccess={
    TAOBAO_AUTO_SYNC:'0',TAOBAO_DATA_PERMISSION:'1',
    TAOBAO_APP_KEY:'mock-key',TAOBAO_APP_SECRET:'mock-secret',
    TAOBAO_ADZONE_ID:'90001',TAOBAO_AUTO_SYNC_KEYWORDS:'手机壳',
    TAOBAO_PAGES_PER_KEYWORD:'1'
  };
  let release,called=0;
  const cfg={keywords:['手机壳'],pages:1};
  const syncImpl=async()=>{called++;return await new Promise(resolve=>{release=resolve;});};
  const first=manual.start({config:cfg,syncImpl});
  assert.equal(first.started,true);
  assert.equal(manual.status().running,true);
  const duplicate=manual.start({config:cfg,syncImpl});
  assert.equal(duplicate.started,false);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(called,1);
  release({fetched:2,translated:1,staged:2,needs_translation:1});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(manual.status().running,false);
  assert.equal(manual.status().last_result.staged,2);
  assert.equal(manual.status().last_result.needs_translation,1);
  assert.equal(manual.status().last_error,null);
});

test('Manual sync works when scheduled polling is disabled but all source rights exist',async()=>{
  const env={
    TAOBAO_AUTO_SYNC:'0',TAOBAO_DATA_PERMISSION:'1',
    TAOBAO_APP_KEY:'mock-key',TAOBAO_APP_SECRET:'mock-secret',
    TAOBAO_ADZONE_ID:'90001',TAOBAO_AUTO_SYNC_KEYWORDS:'手机壳',
    TAOBAO_PAGES_PER_KEYWORD:'1'
  };
  let seen=null;
  const started=manual.start({env,syncImpl:async (keywords,opts)=>{
    seen={keywords,opts};return {fetched:3,staged:3,translated:0,needs_translation:3};
  }});
  assert.equal(started.started,true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(seen,{keywords:['手机壳'],opts:{pages:1}});
  assert.equal(manual.status().running,false);
  assert.equal(manual.status().last_result.fetched,3);
});
