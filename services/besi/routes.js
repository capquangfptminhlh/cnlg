'use strict';
/* Names, supplier IDs, feed costs and allocations never enter public APIs. */
const {requireAdmin,rateLimit,stripSupplierText}=require('../security');
const {createStore}=require('./store');
const core=require('./core');
function attach(app,options={}){
  const store=options.store||createStore();
  const enabled=()=>process.env.BESI_MARKETPLACE_PUBLIC==='1';
  const handle=fn=>(req,res)=>{
    try{fn(req,res);}catch(error){
      const status=Number.isInteger(error.status)&&error.status>=400&&error.status<500?error.status:500;
      // Never echo parser traces, supplier data, paths or operational details.
      res.status(status).json({success:false,error:status===500?'Lỗi hệ thống':String(error.message).slice(0,180)});
    }
  };
  app.get('/api/admin/besi/overview',requireAdmin,handle((req,res)=>{
    const s=store.read();
    res.set('Cache-Control','no-store').json({success:true,data:{
      suppliers:s.suppliers,offerCount:s.offers.length,
      canonicalProductCount:core.groups(s).length,
      pendingPlans:s.plans.filter(p=>p.status==='DRAFT_REVIEW').length,
      policy:s.policy
    }});
  }));
  app.get('/api/admin/besi/catalog',requireAdmin,handle((req,res)=>{
    const s=store.read(),items=core.publicCatalog(s,s.policy).map(p=>({
      ...p,name:stripSupplierText(p.name),brand:stripSupplierText(p.brand),
      category:stripSupplierText(p.category)
    }));
    res.set('Cache-Control','no-store').json({success:true,total:items.length,data:items.slice(0,100)});
  }));
  app.get('/api/admin/besi/offers',requireAdmin,handle((req,res)=>{
    const s=store.read(),limit=Math.min(100,Math.max(1,Number(req.query.limit)||30));
    const page=Math.max(1,Number(req.query.page)||1);
    res.set('Cache-Control','no-store').json({success:true,total:s.offers.length,
      data:s.offers.slice((page-1)*limit,page*limit)});
  }));
  app.post('/api/admin/besi/suppliers',requireAdmin,handle((req,res)=>{
    const result=store.registerSupplier(req.body||{});
    res.status(201).set('Cache-Control','no-store').json({success:true,data:result});
  }));
  app.patch('/api/admin/besi/suppliers/:id',requireAdmin,handle((req,res)=>{
    const result=store.approveSupplier(req.params.id,req.body||{});
    res.set('Cache-Control','no-store').json({success:true,data:result});
  }));
  app.post('/api/admin/besi/feeds/:supplierId',requireAdmin,handle((req,res)=>{
    const result=store.upsertOffers(req.params.supplierId,req.body?.items);
    res.set('Cache-Control','no-store').json({success:true,data:result});
  }));
  app.put('/api/admin/besi/pricing',requireAdmin,handle((req,res)=>{
    const result=store.setPolicy(req.body||{});
    res.set('Cache-Control','no-store').json({success:true,data:result});
  }));
  app.post('/api/admin/besi/allocate',requireAdmin,handle((req,res)=>{
    // Creates internal DRAFT only. Does not call partners, debit, pay or ship.
    const result=store.createDraft(req.body?.items);
    res.status(201).set('Cache-Control','no-store').json({success:true,data:result});
  }));
  app.get('/api/admin/besi/plans',requireAdmin,handle((req,res)=>{
    const s=store.read();
    const limit=Math.min(100,Math.max(1,Number(req.query.limit)||30));
    res.set('Cache-Control','no-store').json({success:true,data:s.plans.slice(0,limit)});
  }));
  app.get('/api/besi/products',rateLimit('besi-catalog',60e3,100),handle((req,res)=>{
    if(!enabled())return res.status(404).json({success:false,error:'Danh mục đang chuẩn bị'});
    const s=store.read();
    let list=core.publicCatalog(s,s.policy).map(p=>({
      ...p,name:stripSupplierText(p.name),brand:stripSupplierText(p.brand),
      category:stripSupplierText(p.category)
    }));
    const search=String(req.query.search||'').normalize('NFKC').toLocaleLowerCase('vi').trim().slice(0,80);
    if(search)list=list.filter(x=>(x.name+' '+x.brand+' '+x.category).toLocaleLowerCase('vi').includes(search));
    const limit=Math.min(48,Math.max(1,Number(req.query.limit)||24));
    const page=Math.min(10000,Math.max(1,Number(req.query.page)||1));
    res.set('Cache-Control','public, max-age=30').json({success:true,
      total:list.length,page,data:list.slice((page-1)*limit,page*limit)});
  }));
  app.post('/api/besi/quote',rateLimit('besi-quote',60e3,30),handle((req,res)=>{
    if(!enabled())return res.status(404).json({success:false,error:'Báo giá đang chuẩn bị'});
    const s=store.read();
    const quote=core.publicQuote(s,req.body?.items,s.policy);
    res.set('Cache-Control','no-store').json({success:true,data:quote});
  }));
}
module.exports={attach};
