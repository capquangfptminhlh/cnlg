'use strict';
const {test,describe}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
process.env.ADMIN_PASSWORD='BESI_TEST_ONLY_NOT_A_REAL_CREDENTIAL_123';
const core=require('../services/besi/core');
const {createStore}=require('../services/besi/store');
const fixtures=()=>{
  const s1=core.validateSupplier({id:'supplier001',legalName:'Kho nguồn Thử Nghiệm A',
    displayName:'Kho Nguồn A',verified:true,active:true,shippingFee:5000,leadDays:1});
  const s2=core.validateSupplier({id:'supplier002',legalName:'Kho nguồn Thử Nghiệm B',
    displayName:'Kho Nguồn B',verified:true,active:true,shippingFee:8000,leadDays:2});
  const ids=new Set([s1.id,s2.id]);
  const first=core.validateOffer({supplierId:s1.id,sku:'A-HEAD-1',gtin:'8930000012345',
    name:'Tai nghe Bluetooth Pro',brand:'BESI',model:'HN-1',variant:'Đen',
    cost:80000,stock:3,category:'Thiết bị',image:'/images/besi/safe-card.jpg'},ids);
  const second=core.validateOffer({supplierId:s2.id,sku:'B-HEAD-9',gtin:'8930000012345',
    name:'Tai nghe Bluetooth Pro',brand:'BESI',model:'HN-1',variant:'Đen',
    cost:90000,stock:10,category:'Thiết bị'},ids);
  return {suppliers:[s1,s2],offers:[first,second],policy:core.policyOf()};
};
describe('BESI master catalog and price engine',()=>{
  test('same GTIN and variant group into a single product without revealing source',()=>{
    const state=fixtures(),pub=core.publicCatalog(state,state.policy);
    assert.equal(pub.length,1);
    assert.match(pub[0].id,/^B[a-f0-9]{20}$/);
    assert.equal(pub[0].available,true);
    assert.ok(pub[0].price>80000);
    assert.deepEqual(pub[0].tiers.map(x=>x.minQty),[1,5,20,100]);
    const json=JSON.stringify(pub);
    for(const secret of ['supplier001','supplier002','Kho Nguồn','A-HEAD-1',
      'B-HEAD-9','unitCost','wholesale_price','supplierSku','cost','shippingFee'])
      assert.ok(!json.includes(secret),'Leaked '+secret);
  });
  test('different variants or unrelated titles do not merge',()=>{
    const s=fixtures(),ids=new Set(s.suppliers.map(x=>x.id));
    s.offers.push(core.validateOffer({supplierId:'supplier001',sku:'DIFF-BLUE',
      gtin:'8930000012345',variant:'Xanh',name:'Tai nghe Bluetooth Pro',cost:82000,stock:4},ids));
    s.offers.push(core.validateOffer({supplierId:'supplier001',sku:'A-DIFFERENT',
      name:'Tai nghe Bluetooth Pro',cost:52000,stock:1},ids));
    assert.equal(core.publicCatalog(s).length,3);
  });
  test('manual SKU mapping combines verified matching offers without relying on product titles',()=>{
    const s=fixtures(),ids=new Set(s.suppliers.map(v=>v.id));
    // No GTIN and no full model/variant: admin-curated key is required.
    s.offers=[
      core.validateOffer({supplierId:'supplier001',sku:'SKU-A',
        name:'Máy ép chậm 500W',mappingKey:'juicer-model-500w',cost:120000,stock:3},ids),
      core.validateOffer({supplierId:'supplier002',sku:'SKU-B',
        name:'Máy ép chậm 500W',mappingKey:'juicer-model-500w',cost:125000,stock:5},ids)
    ];
    assert.equal(core.publicCatalog(s).length,1);
    delete s.offers[1].mappingKey;
    assert.equal(core.publicCatalog(s).length,2,'uncurated SKU must not merge by similar name');
  });
  test('no unverified, inactive or zero-stock offer enters a public catalog',()=>{
    const s=fixtures();
    s.suppliers[0].verified=false;
    assert.equal(core.publicCatalog(s).length,1);
    s.suppliers[1].active=false;
    assert.equal(core.publicCatalog(s).length,0);
  });
  test('fee and minimum margin prevent a bulk tier from selling below safety floor',()=>{
    const p=core.policyOf({markupPercent:15,feePercent:3,reservePercent:2,
      marginFloorPercent:5,handlingPerUnit:1000,roundTo:1000,
      tiers:[{minQty:1,discountPercent:0},{minQty:5,discountPercent:30}]});
    const price=core.tierPrice(80000,5,p);
    assert.ok(price>=Math.ceil((80000+1000)/.90/1000)*1000);
    assert.ok(price<=core.tierPrice(80000,1,p));
    assert.throws(()=>core.policyOf({tiers:[{minQty:5,discountPercent:10}]}));
  });
  test('large basket does not underprice inventory from more expensive backup warehouse',()=>{
    const s=fixtures(),id=core.publicCatalog(s)[0].id;
    // Cheap source has 3 units at 80k; remaining 7 must come from 90k.
    const quoted=core.publicQuote(s,[{id,quantity:10}],s.policy);
    const plan=core.draftAllocation(s,[{id,quantity:10}],s.policy);
    const totalSourcing=3*80000+7*90000;
    assert.equal(plan.shipments.reduce((n,x)=>n+x.lines.reduce((v,l)=>v+l.quantity*l.unitCost,0),0),totalSourcing);
    assert.ok(quoted.subtotal>totalSourcing,'Quote must cover blended sourcing cost');
    assert.equal(quoted.subtotal,plan.merchandiseSubtotal);
    const publicItem=core.publicCatalog(s)[0];
    assert.equal(publicItem.tiers.find(t=>t.minQty===20).price,null,'Unavailable bulk tiers must not advertise fictitious prices');
  });
  test('public quotes omit supplier, costs and shipping promises',()=>{
    const s=fixtures(),id=core.publicCatalog(s)[0].id;
    const quote=core.publicQuote(s,[{id,quantity:7}],s.policy);
    assert.equal(quote.items.length,1);
    assert.equal(quote.items[0].quantity,7);
    assert.equal(quote.shippingPending,true);
    assert.equal(quote.payableTotal,null);
    assert.equal(quote.orderEnabled,false);
    assert.doesNotMatch(JSON.stringify(quote),/supplier|cost|stock|sku|dispatch/i);
    assert.throws(()=>core.publicQuote(s,[{id,quantity:14}]),/tồn/);
    assert.throws(()=>core.publicQuote(s,[{id,quantity:1},{id,quantity:2}]),/trùng/i);
  });
  test('allocation splits stock across partners but remains a DRAFT not an actual order',()=>{
    const s=fixtures(),id=core.publicCatalog(s)[0].id;
    const result=core.draftAllocation(s,[{id,quantity:7}],s.policy);
    assert.equal(result.status,'DRAFT_REVIEW');
    assert.equal(result.readyForDispatch,false);
    assert.equal(result.shipments.length,2);
    assert.equal(result.shipments.reduce((sum,x)=>sum+x.lines[0].quantity,0),7);
    assert.ok(result.totalCost>0);
    assert.equal(result.shipments[0].supplierId,'supplier001');
  });
  test('image URLs to upstream servers and invalid supplier references rejected',()=>{
    const ids=new Set(['supplier001']);
    assert.throws(()=>core.validateOffer({supplierId:'supplier001',sku:'A1',
      name:'SP',stock:1,cost:1000,image:'https://vendor.example/p.jpg'},ids),/ảnh/i);
    assert.throws(()=>core.validateOffer({supplierId:'unknown',sku:'A1',
      name:'SP',stock:1,cost:1000},ids),/đối tác/);
  });
});
describe('BESI Supplier Hub durable persistence',()=>{
  test('supplier starts disabled, approval is explicit, import is atomic and draft survives reload',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'besi-hub-'));
    try{
      const dbPath=path.join(dir,'besi.json'),db=createStore(dbPath);
      const a=db.registerSupplier({legalName:'Công ty đầu mối A',displayName:'A'});
      const b=db.registerSupplier({legalName:'Công ty đầu mối B',displayName:'B'});
      assert.equal(a.active,false);assert.equal(a.verified,false);
      db.approveSupplier(a.id,{active:true,verified:true});
      db.approveSupplier(b.id,{active:true,verified:true});
      const feed1=db.upsertOffers(a.id,[{sku:'SKU-1',gtin:'8930000012345',variant:'Đen',
        name:'Tai nghe Bluetooth',cost:80000,stock:2}]);
      assert.equal(feed1.created,1);
      const feed2=db.upsertOffers(b.id,[{sku:'SKU-2',gtin:'8930000012345',variant:'Đen',
        name:'Tai nghe Bluetooth',cost:85000,stock:10}]);
      assert.equal(feed2.created,1);
      const state=db.read(),id=core.publicCatalog(state,state.policy)[0].id;
      const plan=db.createDraft([{id,quantity:4}]);
      assert.equal(plan.shipments.length,2);
      assert.equal(plan.readyForDispatch,false);
      const db2=createStore(dbPath);
      assert.equal(db2.read().plans[0].id,plan.id);
      assert.equal(db2.read().offers.length,2);
      if (process.platform !== 'win32') assert.equal(fs.statSync(dbPath).mode&0o777,0o600);
      assert.throws(()=>db2.upsertOffers(a.id,[{sku:'NEW',name:'OK',cost:1000,stock:1},
        {sku:'BAD',name:'Bad',cost:-5,stock:1}]),/Giá/);
      assert.equal(db2.read().offers.length,2,'invalid batch cannot partially write');
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});


test('HTTP Supplier Hub is admin-only and public DTO never exposes supplier information',async()=>{
  const express=require('express');
  const {attach}=require('../services/besi/routes');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'besi-routes-'));
  const store=createStore(path.join(dir,'hub.json'));
  const app=express();app.use(express.json({limit:'100kb'}));attach(app,{store});
  const server=await new Promise(resolve=>{
    const s=app.listen(0,'127.0.0.1',()=>resolve(s));
  });
  const base='http://127.0.0.1:'+server.address().port;
  const call=async(p,method='GET',body,auth=false)=>{
    const res=await fetch(base+p,{method,headers:{
      ...(body?{'Content-Type':'application/json'}:{}),
      ...(auth?{'x-admin-key':process.env.ADMIN_PASSWORD}:{})
    },body:body?JSON.stringify(body):undefined});
    return {status:res.status,data:await res.json()};
  };
  try{
    assert.equal((await call('/api/admin/besi/overview')).status,401);
    assert.equal((await call('/api/besi/products')).status,404);
    const created=await call('/api/admin/besi/suppliers','POST',{
      legalName:'Công ty nguồn thí nghiệm',displayName:'Tổng kho nội bộ A',
      shippingFee:5000
    },true);
    assert.equal(created.status,201);
    assert.equal(created.data.data.verified,false);
    const id=created.data.data.id;
    const upsert=await call('/api/admin/besi/feeds/'+id,'POST',{items:[{
      sku:'INTERNAL-SKU-007',name:'Tai nghe mẫu thử',brand:'BESI',model:'S1',
      cost:80000,stock:12,gtin:'8930000012345'
    }]},true);
    assert.equal(upsert.status,200);
    const denied=await call('/api/admin/besi/suppliers/'+id,'PATCH',{verified:true,active:true});
    assert.equal(denied.status,401);
    assert.equal((await call('/api/admin/besi/suppliers/'+id,'PATCH',
      {verified:true,active:true},true)).status,200);
    process.env.BESI_MARKETPLACE_PUBLIC='1';
    const listing=await call('/api/besi/products');
    assert.equal(listing.status,200);
    assert.equal(listing.data.data.length,1);
    const publicData=JSON.stringify(listing.data);
    for(const leak of ['Tổng kho nội bộ A','Công ty nguồn thí nghiệm','INTERNAL-SKU-007',
      'supplierId','shippingFee','cost','80000'])
      assert.ok(!publicData.includes(leak),'Public API leaked: '+leak);
    const pubId=listing.data.data[0].id;
    const quotation=await call('/api/besi/quote','POST',{items:[{id:pubId,quantity:5}]});
    assert.equal(quotation.status,200);
    assert.equal(quotation.data.data.orderEnabled,false);
    const privateDraft=await call('/api/admin/besi/allocate','POST',
      {items:[{id:pubId,quantity:5}]},true);
    assert.equal(privateDraft.status,201);
    assert.equal(privateDraft.data.data.readyForDispatch,false);
    assert.equal((await call('/api/admin/besi/plans')).status,401);
  }finally{
    delete process.env.BESI_MARKETPLACE_PUBLIC;
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
test('admin-only Supplier Hub assets stay behind server login gate',()=>{
  const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  assert.match(server,/base === 'admin-besi\.html'/);
  assert.match(server,/'admin-besi\.js': 'admin-besi\.js'/);
  assert.match(server,/'admin-besi\.css': 'admin-besi\.css'/);
  assert.match(server,/besiMarketplace\.attach\(app\)/);
});
