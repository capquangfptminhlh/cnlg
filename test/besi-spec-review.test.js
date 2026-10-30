'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),vm=require('node:vm');
const {createStore,normalizeInput}=require('../services/besi/specReviewStore');
const facets=require('../services/besi/specIndex');
const repo=path.join(__dirname,'..');
const sample={
  id:124062,name:'Cáp Dù 2 mét hãng VVZ đủ chân Micro, Lighting, Type C',
  price:29000,in_stock:true,variant_count:9,
  variants:[
    {id:'micro-black',name:'Micro = M10, Đen',price:29000,in_stock:true},
    {id:'typec-red',name:'Type C = C10, Đỏ',price:29000,in_stock:true},
    {id:'iphone-black',name:'iPhone = L10, Đen',price:29000,in_stock:true},
    {id:'iphone-white',name:'iPhone = L10, Trắng',price:32000,in_stock:false}
  ]
};
const lookup=id=>id===sample.id?sample:null;
test('requires explicit administrator verification and accepts only whitelisted attributes',()=>{
  assert.throws(()=>normalizeInput({
    productId:124062,variantId:'iphone-black',connector:'c-lightning',length:2
  }),/xác nhận/);
  assert.throws(()=>normalizeInput({
    productId:124062,variantId:'iphone-black',connector:'made-up',confirmed:true
  }),/Đầu cáp/);
  assert.throws(()=>normalizeInput({
    productId:124062,variantId:'iphone-black',connector:'c-lightning',length:2.7,confirmed:true
  }),/Chiều dài/);
  assert.throws(()=>normalizeInput({
    productId:124062,variantId:'iphone-black',connector:'c-lightning',color:'tím',confirmed:true
  }),/Màu sắc/);
});
test('exact variation ID required on multi-choice products; unknown variation rejected',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'besi-review-'));
  try{
    const store=createStore(path.join(dir,'review.json'));
    const record={productId:124062,connector:'lightning',length:2,confirmed:true};
    assert.throws(()=>store.save(record,lookup),/từng phân loại/);
    assert.throws(()=>store.save({...record,variantId:'does-not-exist'},lookup),/không tồn tại/);
    assert.throws(()=>store.save({...record,productId:100,variantId:'iphone-black'},lookup),/không tồn tại/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('approved variant survives reindex and source refresh; other options stay unverified',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'besi-reviewed-'));
  try{
    const filename=path.join(dir,'review.json'),store=createStore(filename);
    const initial=facets.searchIndex(facets.buildIndex([sample]),{type:'c-lightning',length:2});
    assert.equal(initial.total,0);
    assert.ok(initial.possibleTotal>0);
    const updated=store.save({productId:124062,variantId:'iphone-black',
      connector:'c-lightning',length:2,color:'den',confirmed:true},lookup);
    assert.equal(updated.revision,1);
    assert.equal(store.get(124062,'iphone-black').connector,'c-lightning');
    if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode&0o777,0o600);
    const cloned={...sample,price:30000,updated_at:'next source sync',
      variants:sample.variants.map(v=>({...v,price:v.price+500}))};
    const fresh=createStore(filename).snapshot();
    const idx=facets.buildIndex([cloned],fresh.records);
    const found=facets.searchIndex(idx,{type:'c-lightning',length:2,color:'den'});
    assert.equal(found.total,1);
    assert.equal(found.matched[0].variant.id,'iphone-black');
    assert.equal(found.matched[0].variant.price,29500);
    assert.equal(idx.reviewedVariations,1);
    assert.equal(facets.searchIndex(idx,{type:'c-c',length:2}).total,0);
    store.remove(124062,'iphone-black');
    assert.equal(createStore(filename).get(124062,'iphone-black'),null);
    assert.equal(facets.searchIndex(facets.buildIndex([cloned],store.snapshot().records),
      {type:'c-lightning',length:2}).total,0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('review entry cannot leak a supplier URL, source price, or arbitrary extra fields',()=>{
  const normalized=normalizeInput({
    productId:5,variantId:'v-1',connector:'c-c',length:1,power:100,
    color:'den',confirmed:true,sourceUrl:'https://external.example',
    supplierCost:5000,secret:'private'
  });
  const text=JSON.stringify(normalized);
  assert.doesNotMatch(text,/external\.example|supplierCost|private|secret/);
  assert.equal(normalized.verified,true);
});
test('server has admin-only correction and reversal endpoints; public results unchanged DTO',()=>{
  const s=fs.readFileSync(path.join(repo,'server.js'),'utf8');
  assert.match(s,/createSpecReviewStore/);
  assert.match(s,/besiSpecs\.buildIndex\(cachedSellable,reviewed\.records\)/);
  assert.match(s,/specsIndexReviewedRev!==reviewed\.revision/);
  assert.match(s,/app\.put\('\/api\/admin\/besi\/spec-review\/:id', requireAdmin/);
  assert.match(s,/app\.delete\('\/api\/admin\/besi\/spec-review\/:id', requireAdmin/);
  assert.match(s,/app\.get\('\/api\/admin\/besi\/spec-review\/:id', requireAdmin/);
  assert.match(s,/const pub=publicProduct\(product\)/);
  const ui=fs.readFileSync(path.join(repo,'public/admin-besi.html'),'utf8');
  const script=fs.readFileSync(path.join(repo,'public/admin-besi.js'),'utf8');
  assert.match(ui,/id="besiReviewConfirm" required/);
  assert.match(ui,/id="besiReviewVariant"/);
  assert.match(script,/confirmed:true/);
  assert.match(script,/\/api\/admin\/besi\/spec-review\//);
  assert.doesNotThrow(()=>new vm.Script(script));
});
test('large catalog reindex uses compact reviewed mappings without upstream writes',()=>{
  const products=Array.from({length:10000},(_,i)=>({
    id:i+1,name:'Cáp USB-C to Lightning 1m 20W Đen',
    price:29000,in_stock:true
  }));
  const idx=facets.buildIndex(products,{
    '50:':{verified:true,productId:50,variantId:'',
      connector:'c-lightning',length:2,power:20,color:'den'}
  });
  assert.equal(idx.cableProducts,10000);
  assert.equal(facets.searchIndex(idx,{type:'c-lightning',length:2}).total,1);
  assert.equal(facets.searchIndex(idx,{type:'c-lightning',length:1}).total,9999);
});

test('local AI suggestions are opt-in, schema-validated, do not auto-verify or contact external hosts',async()=>{
  const ai=require('../services/besi/specLocalAI');
  await assert.rejects(()=>ai.suggest({name:'Cáp sạc C to IP 2m',model:''}),/Chưa cấu hình/);
  let target='',sent=null;
  const candidate=await ai.suggest({
    name:'Cáp C2L 2m 20W',variantName:'Đen',model:'qwen3:4b',
    fetchFn:async(url,request)=>{
      target=url;sent=JSON.parse(request.body);
      return {ok:true,json:async()=>({response:JSON.stringify({
        connector:'c-lightning',length:2,power:20,color:'den'
      })})};
    }
  });
  assert.equal(target,'http://127.0.0.1:11434/api/generate');
  assert.equal(candidate.verified,false);
  assert.match(candidate.status,/phải kiểm tra thực tế/);
  assert.equal(candidate.length,2);
  assert.ok(!JSON.stringify(sent).includes('supplier_cost'));
  await assert.rejects(()=>ai.suggest({
    name:'test',model:'qwen3:4b',
    fetchFn:async()=>({ok:true,json:async()=>({response:'{"connector":"invalid"}'})})
  }),/danh sách/);
  const server=fs.readFileSync(path.join(repo,'server.js'),'utf8');
  assert.match(server,/app\.post\('\/api\/admin\/besi\/spec-ai-suggest\/:id',requireAdmin/);
  assert.match(server,/besiSpecLocalAI\.suggest\(\{name:pub\.name,variantName:variant\?\.name\|\|''\}\)/);
  const adminJs=fs.readFileSync(path.join(repo,'public/admin-besi.js'),'utf8');
  assert.match(adminJs,/besiReviewAskAI/);
  assert.match(adminJs,/besiReviewConfirm'\)\.checked=false/);
});
