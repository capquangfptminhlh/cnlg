'use strict';
/* Server-only BESI Supplier Hub state. No credentials, secrets or source URLs. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const core=require('./core');
const FILE=path.resolve(__dirname,'../../data/besi-supply-hub.json');
function initial(){return {version:1,suppliers:[],offers:[],plans:[],policy:core.policyOf()};}
function createStore(filename=FILE){
  function read(){
    if(!fs.existsSync(filename))return initial();
    const stat=fs.statSync(filename);
    if(stat.size>16*1024*1024)throw Error('BESI supply data too large');
    const state=JSON.parse(fs.readFileSync(filename,'utf8'));
    if(state.version!==1||!Array.isArray(state.suppliers)||!Array.isArray(state.offers)||!Array.isArray(state.plans))
      throw Error('BESI supply state version is unsupported');
    return state;
  }
  function commit(mutator){
    const current=read();
    const changed=structuredClone(current);
    const value=mutator(changed);
    fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
    const temp=filename+'.'+process.pid+'.tmp';
    try{
      fs.writeFileSync(temp,JSON.stringify(changed),{mode:0o600,flag:'wx'});
      fs.renameSync(temp,filename);
      fs.chmodSync(filename,0o600);
    }finally{try{fs.unlinkSync(temp);}catch{}}
    return value;
  }
  function registerSupplier(data){
    const id='SUP'+crypto.randomBytes(9).toString('hex');
    const supplier=core.validateSupplier({...data,id,verified:false,active:false});
    return commit(s=>{
      if(s.suppliers.length>=500)throw Error('Vượt giới hạn đối tác');
      s.suppliers.push(supplier);
      return supplier;
    });
  }
  function approveSupplier(id,changes={}){
    return commit(s=>{
      const supplier=s.suppliers.find(v=>v.id===id);
      if(!supplier)throw Object.assign(new Error('Không có đối tác'),{status:404});
      // Explicit admin action required for verification and activation.
      if('verified' in changes)supplier.verified=changes.verified===true;
      if('active' in changes)supplier.active=changes.active===true;
      if('shippingFee' in changes)supplier.shippingFee=core.validateSupplier({
        ...supplier,shippingFee:changes.shippingFee
      }).shippingFee;
      if('leadDays' in changes)supplier.leadDays=core.validateSupplier({
        ...supplier,leadDays:changes.leadDays
      }).leadDays;
      return {...supplier};
    });
  }
  function upsertOffers(supplierId,items){
    if(!Array.isArray(items)||!items.length||items.length>200)
      throw Object.assign(new Error('Mỗi lần nhập từ 1 đến 200 sản phẩm'),{status:400});
    return commit(s=>{
      if(!s.suppliers.some(x=>x.id===supplierId))throw Object.assign(new Error('Nguồn chưa đăng ký'),{status:404});
      const ids=new Set(s.suppliers.map(x=>x.id));
      const validated=items.map(x=>core.validateOffer({...x,supplierId},ids));
      const dupe=new Set();
      for(const o of validated){
        if(dupe.has(o.sku))throw Object.assign(new Error('Trùng SKU trong dữ liệu tải lên'),{status:400});
        dupe.add(o.sku);
      }
      const index=new Map(s.offers.map((x,i)=>[x.supplierId+'::'+x.sku,i]));
      let created=0,updated=0;
      for(const o of validated){
        const key=o.supplierId+'::'+o.sku;
        if(index.has(key)){s.offers[index.get(key)]=o;updated++;}
        else{index.set(key,s.offers.length);s.offers.push(o);created++;}
      }
      if(s.offers.length>100000)throw Error('Catalog offer limit exceeded');
      return {created,updated,received:validated.length};
    });
  }
  function setPolicy(value){
    const policy=core.policyOf(value);
    return commit(s=>{s.policy=policy;return policy;});
  }
  function createDraft(lines){
    return commit(s=>{
      const plan=core.draftAllocation(s,lines,s.policy);
      const record={id:'BPLAN'+crypto.randomBytes(9).toString('hex'),
        createdAt:new Date().toISOString(),...plan};
      s.plans.unshift(record);
      if(s.plans.length>5000)s.plans.length=5000;
      return record;
    });
  }
  return {read,registerSupplier,approveSupplier,upsertOffers,setPolicy,createDraft};
}
module.exports={createStore};
