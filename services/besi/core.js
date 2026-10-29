'use strict';
// BESI marketplace engine. Supplier-side values never belong in public responses.
const crypto = require('node:crypto');
const DEFAULT_POLICY = Object.freeze({
  markupPercent:15, feePercent:2.5, reservePercent:2, marginFloorPercent:5,
  handlingPerUnit:1000, roundTo:1000,
  tiers:[{minQty:1,discountPercent:0},{minQty:5,discountPercent:2},
    {minQty:20,discountPercent:4},{minQty:100,discountPercent:6}]
});
const clean=(x,n=200)=>String(x??'').replace(/[\u0000-\u001f\u007f<>]/g,' ').replace(/\s+/g,' ').trim().slice(0,n);
const normalized=x=>clean(x).normalize('NFKC').toLocaleLowerCase('vi').normalize('NFD')
  .replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').replace(/[^a-z0-9]/g,'');
function bad(message){throw Object.assign(new Error(message),{status:400});}
function money(x,name,max=1e12){
  const v=Number(x);
  if(!Number.isFinite(v)||v<0||v>max)bad(name+' không hợp lệ');
  return v;
}
function integer(x,name,max=10000){
  const v=Number(x);
  if(!Number.isSafeInteger(v)||v<1||v>max)bad(name+' không hợp lệ');
  return v;
}
function policyOf(raw={}){
  const merged={...DEFAULT_POLICY,...raw},p={};
  for(const key of ['markupPercent','feePercent','reservePercent','marginFloorPercent'])
    p[key]=money(merged[key],key,75);
  if(p.feePercent+p.reservePercent+p.marginFloorPercent>=100)bad('Tổng phí vượt giới hạn');
  p.handlingPerUnit=money(merged.handlingPerUnit,'handlingPerUnit',1e6);
  p.roundTo=[1,100,500,1000,5000,10000].includes(Number(merged.roundTo))?Number(merged.roundTo):1000;
  if(!Array.isArray(merged.tiers)||!merged.tiers.length||merged.tiers.length>8)bad('Bậc giá không hợp lệ');
  p.tiers=merged.tiers.map(t=>({
    minQty:integer(t.minQty,'minQty'),
    discountPercent:money(t.discountPercent,'discountPercent',50)
  })).sort((a,b)=>a.minQty-b.minQty);
  if(p.tiers[0].minQty!==1||p.tiers.some((x,i)=>i&&x.minQty===p.tiers[i-1].minQty))
    bad('Bậc giá phải bắt đầu từ một và không trùng nhau');
  return p;
}
function validateSupplier(s){
  if(!s||typeof s!=='object')bad('Thiếu thông tin đối tác');
  const id=clean(s.id,50), legalName=clean(s.legalName,180);
  if(!/^[a-zA-Z0-9_-]{5,50}$/.test(id)||!legalName)bad('Thiếu mã hoặc tên pháp lý của đối tác');
  return {id,legalName,displayName:clean(s.displayName||legalName,180),
    active:s.active===true,verified:s.verified===true,
    contact:clean(s.contact,150),region:clean(s.region,100),
    shippingFee:money(s.shippingFee??0,'shippingFee',1e7),
    leadDays:money(s.leadDays??2,'leadDays',365)};
}
function validateOffer(o,supplierIds){
  if(!o||typeof o!=='object')bad('Dữ liệu sản phẩm không hợp lệ');
  const supplierId=clean(o.supplierId,50),sku=clean(o.sku,90),name=clean(o.name,250);
  if(!supplierIds.has(supplierId)||!sku||!name)bad('Thiếu đối tác, SKU hoặc tên sản phẩm');
  const gtin=clean(o.gtin,14);
  if(gtin&&!/^\d{8,14}$/.test(gtin))bad('GTIN không hợp lệ');
  const cost=money(o.cost,'Giá nguồn');
  if(!cost)bad('Giá nguồn phải lớn hơn không');
  const stock=Number(o.stock);
  if(!Number.isSafeInteger(stock)||stock<0||stock>1e8)bad('Số lượng tồn không hợp lệ');
  const image=clean(o.image,250);
  if(image&&!/^\/images\/besi\/[a-z0-9/_-]+\.(?:png|jpg|jpeg|webp)$/i.test(image))
    bad('Chỉ dùng ảnh đã kiểm duyệt trên domain của BESI');
  const mappingKey=clean(o.mappingKey,80);
  if(mappingKey&&!/^[a-zA-Z0-9_-]{6,80}$/.test(mappingKey))bad('Mã gộp sản phẩm không hợp lệ');
  return {supplierId,sku,name,gtin,mappingKey,brand:clean(o.brand,100),model:clean(o.model,100),
    variant:clean(o.variant,100),category:clean(o.category,120),cost,stock,image,
    active:o.active!==false,updatedAt:new Date().toISOString()};
}
function canonicalKey(o){
  if(o.gtin)return 'gtin:'+o.gtin+':'+normalized(o.variant);
  if(o.mappingKey)return 'curated:'+o.mappingKey;
  // Without a precise variant, brand+model may falsely merge storage/colors.
  if(normalized(o.brand)&&normalized(o.model)&&normalized(o.variant))
    return 'model:'+normalized(o.brand)+':'+normalized(o.model)+':'+normalized(o.variant);
  // Never merge two unrelated goods because their titles sound similar.
  return 'unique:'+o.supplierId+':'+o.sku;
}
const publicId=key=>'B'+crypto.createHash('sha256').update('BESI:v1:'+key).digest('hex').slice(0,20);
function groups(state){
  const allowed=new Map((state.suppliers||[]).filter(s=>s.active&&s.verified).map(s=>[s.id,s]));
  const map=new Map();
  for(const o of state.offers||[]){
    if(o.active===false||o.stock<1||!allowed.has(o.supplierId))continue;
    const key=canonicalKey(o);
    if(!map.has(key))map.set(key,[]);
    map.get(key).push({...o,supplier:allowed.get(o.supplierId)});
  }
  return [...map].map(([key,offers])=>({
    key,id:publicId(key),
    offers:offers.sort((a,b)=>a.cost-b.cost||a.supplier.leadDays-b.supplier.leadDays)
  })).sort((a,b)=>a.id.localeCompare(b.id));
}
function tierPrice(cost,qty,rawPolicy={}){
  const p=policyOf(rawPolicy);
  const floor=(cost+p.handlingPerUnit)/(1-(p.feePercent+p.reservePercent+p.marginFloorPercent)/100);
  const target=Math.max(floor,(cost+p.handlingPerUnit)*(1+p.markupPercent/100));
  const tier=p.tiers.filter(t=>t.minQty<=qty).at(-1);
  return Math.ceil(Math.max(floor,target*(1-tier.discountPercent/100))/p.roundTo)*p.roundTo;
}
function safeName(name,suppliers){
  let result=clean(name,250);
  for(const s of suppliers)for(const phrase of [s.displayName,s.legalName]){
    if(!phrase||phrase.length<4)continue;
    // RegExp escape without creating unsafe regex from supplier-controlled strings.
    const pattern=phrase.replace(/[.*+?^$()|[\]{}\\]/g,'\\$&');
    result=result.replace(new RegExp(pattern,'gi'),'').replace(/\s+/g,' ').trim();
  }
  return result||'Sản phẩm BESI';
}
// Stock-aware sourcing: the advertised unit price must cover every unit
// requested, including units supplied by more expensive backup partners.
function selectStock(offers,quantity){
  let remaining=quantity,totalCost=0;
  const allocations=[];
  for(const offer of offers){
    if(!remaining)break;
    const count=Math.min(remaining,offer.stock);
    if(count<=0)continue;
    allocations.push({offer,quantity:count});
    totalCost+=count*offer.cost;
    remaining-=count;
  }
  if(remaining)bad('Không đủ tồn kho');
  return {allocations,averageCost:totalCost/quantity};
}
function publicCatalog(state,rawPolicy={}){
  const p=policyOf(rawPolicy);
  return groups(state).map(g=>{
    const cheapest=g.offers[0],stock=g.offers.reduce((n,o)=>n+o.stock,0);
    return {id:g.id,name:safeName(cheapest.name,state.suppliers||[]),
      brand:clean(cheapest.brand,100),category:clean(cheapest.category,120),
      image:cheapest.image||'',available:true,price:tierPrice(cheapest.cost,1,p),
      tiers:p.tiers.map(t=>({minQty:t.minQty,
        price:stock>=t.minQty?tierPrice(selectStock(g.offers,t.minQty).averageCost,t.minQty,p):null}))};
  });
}
function quoteInternal(state,lines,policy={}){
  if(!Array.isArray(lines)||!lines.length||lines.length>100)bad('Giỏ hàng vượt giới hạn');
  const lookup=new Map(groups(state).map(g=>[g.id,g])),seen=new Set();
  return lines.map(x=>{
    const id=clean(x?.id,40),quantity=integer(x?.quantity,'Số lượng');
    if(seen.has(id))bad('Sản phẩm bị trùng trong giỏ');
    seen.add(id);
    const group=lookup.get(id);
    if(!group)bad('Sản phẩm không còn bán');
    const stock=group.offers.reduce((n,o)=>n+o.stock,0);
    if(stock<quantity)bad('Không đủ số lượng tồn cho '+id);
    const selection=selectStock(group.offers,quantity);
    const unitPrice=tierPrice(selection.averageCost,quantity,policy);
    return {id,quantity,unitPrice,subtotal:quantity*unitPrice,group,selection};
  });
}
function publicQuote(state,lines,policy={}){
  const quoted=quoteInternal(state,lines,policy);
  return {items:quoted.map(({id,quantity,unitPrice,subtotal})=>({id,quantity,unitPrice,subtotal})),
    subtotal:quoted.reduce((n,o)=>n+o.subtotal,0),
    shippingPending:true,payableTotal:null,orderEnabled:false};
}
function draftAllocation(state,lines,policy={}){
  const quoted=quoteInternal(state,lines,policy),shipments=new Map();
  for(const item of quoted){
    // Same stock selection as quoting; never swap to a costlier offer after pricing.
    for(const {offer:o,quantity} of item.selection.allocations){
      if(!shipments.has(o.supplierId))shipments.set(o.supplierId,{
        supplierId:o.supplierId,shippingFee:o.supplier.shippingFee,
        leadDays:o.supplier.leadDays,lines:[]
      });
      shipments.get(o.supplierId).lines.push({
        productId:item.id,sku:o.sku,quantity,unitCost:o.cost,unitPrice:item.unitPrice
      });
    }
  }
  const list=[...shipments.values()].map(s=>({
    ...s,cost:s.lines.reduce((n,l)=>n+l.unitCost*l.quantity,0)
  }));
  return {status:'DRAFT_REVIEW',readyForDispatch:false,shipments:list,
    shippingEstimate:list.reduce((n,s)=>n+s.shippingFee,0),
    merchandiseSubtotal:quoted.reduce((n,l)=>n+l.subtotal,0),
    totalCost:list.reduce((n,s)=>n+s.cost+s.shippingFee,0)};
}
module.exports={DEFAULT_POLICY,policyOf,validateSupplier,validateOffer,canonicalKey,
  publicId,groups,tierPrice,publicCatalog,publicQuote,draftAllocation};
