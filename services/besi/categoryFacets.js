'use strict';
/* BESI category-specific specification search.
 * Full sellable catalog is indexed in memory. No supplier IDs, costs or URLs
 * are copied into public API projections. Unknown specs never count as verified.
 */
const base=require('./specIndex');
const norm=base.norm;
const CATEGORIES=new Set(['cases','chargers','powerbanks']);
const powerOptions=[10,12,15,18,20,22.5,25,30,33,35,40,45,50,60,65,67,70,80,90,100,120,140,150,200,240];
const capacities=[2000,3000,5000,6000,8000,10000,12000,15000,20000,25000,30000,40000,50000];
function detectCategory(p){
  const text=norm(p?.name),category=norm(p?.category_name||p?.category||'');
  if(/\b(pin du phong|sac du phong|power ?bank|portable charger)\b/.test(text))return 'powerbanks';
  if(/\b(op lung|op dien thoai|bao da dien thoai|phone case|protective case|back cover|op (?:iphone|samsung|galaxy))\b/.test(text))return 'cases';
  if(/\b(cu sac|bo sac|adapter sac|wall charger|gan charger|sac nhanh)\b/.test(text)
    &&!/\b(cap sac|day sac|pin du phong|sac du phong|power ?bank)\b/.test(text))return 'chargers';
  if(/\b(op lung|mieng dan|phone case)\b/.test(category)&&!/\b(mieng dan|kinh cuong luc|film)\b/.test(text))return 'cases';
  if(/\b(pin.*du phong|sac du phong)\b/.test(category)
    &&!/\b(day cap|cap sac|op lung|cu sac)\b/.test(text))return 'powerbanks';
  if(/\b(cu cap sac|cu sac)\b/.test(category)
    && /\b(cu|bo sac|adapter|charger|gan)\b/.test(text)
    &&!/\b(day cap|cap sac|pin du phong)\b/.test(text))return 'chargers';
  return null;
}
function modelMatches(text){
  const s=norm(text),matches=[];
  // Numeric models are explicit. Never infer iPhone generation from a generic brand.
  const ip=/\biphone\s*(1[1-9])\s*(pro max|promax|pro|plus|mini|air|e)?\b/g;
  let m;
  while((m=ip.exec(s))){
    const suffix=(m[2]||'').replace(/\s+/g,'-');
    matches.push('iphone-'+m[1]+(suffix?'-'+suffix:''));
  }
  // Require Samsung/Galaxy for S and A series; "S24" elsewhere is ambiguous.
  const sm=/\b(?:samsung|galaxy)\s*(?:galaxy\s*)?([sa])\s*(0?[0-9]{1,2})\s*(ultra|plus|fe|5g)?\b/g;
  while((m=sm.exec(s))){
    const n=Number(m[2]);
    if(m[1]==='s'&&(n<20||n>35))continue;
    if(m[1]==='a'&&(n<1||n>99))continue;
    matches.push('galaxy-'+m[1]+String(n)+(m[3]?'-'+m[3]:''));
  }
  return [...new Set(matches)];
}
function phoneModel(text){
  const matches=modelMatches(text);
  return matches.length===1?matches[0]:null;
}
function watts(text){
  const s=norm(text),arr=[...s.matchAll(/(^|[^0-9])(\d{1,3}(?:[.,]\d+)?)\s*w(?![a-z])/g)]
    .map(x=>Number(x[2].replace(',','.'))).filter(n=>powerOptions.includes(n));
  return [...new Set(arr)];
}
function capacityValues(text){
  const original=norm(text).replace(/\u00a0/g,' ');
  const arr=[];
  const re=/\b(\d{1,3}(?:[., ]\d{3})|\d{4,5}|\d{1,2}\s*k)\s*mah\b/g;
  let m;while((m=re.exec(original))){
    const value=/k$/.test(m[1])?Number(m[1].replace(/\s*k$/,''))*1000:
      Number(m[1].replace(/[., ]/g,''));
    if(Number.isFinite(value)&&value>=1000&&value<=50000)arr.push(value);
  }
  return [...new Set(arr)];
}
function uniqueOrNull(values){const arr=[...new Set(values)];return arr.length===1?arr[0]:null;}
function parseSpec(category,productTitle,variantTitle=''){
  const t=norm(productTitle),v=norm(variantTitle);
  const original=String(productTitle||'').toLowerCase();
  // Some supplier titles write "iPhone 14/15", "20/35W" or "5000/10000mAh".
  // A lone trailing measurement is NOT proof of the only sellable option.
  const multiPhone=/\biphone\s*1[1-9]\s*(?:\/|,|&|va|and)\s*1[1-9]\b/i.test(original);
  const multiWatt=/\b\d{1,3}\s*(?:\/|,)\s*\d{1,3}\s*w\b/i.test(original);
  const multiCapacity=/\b\d{4,5}\s*(?:\/|,)\s*\d{4,5}\s*mah\b/i.test(original);
  if(category==='cases'){
    const variantModels=modelMatches(v),parentModels=modelMatches(t);
    const specific=variantModels.length===1;
    return {spec:specific?variantModels[0]:(multiPhone?null:phoneModel(t)),
      ambiguous:variantModels.length>1||(!specific&&(multiPhone||parentModels.length>1))};
  }
  if(category==='chargers'){
    const variantWatts=watts(v),parentWatts=watts(t);
    const specific=variantWatts.length===1;
    return {spec:specific?variantWatts[0]:(multiWatt?null:uniqueOrNull(parentWatts)),
      ambiguous:variantWatts.length>1||(!specific&&(multiWatt||parentWatts.length>1))};
  }
  if(category==='powerbanks'){
    const variantCapacities=capacityValues(v),parentCapacities=capacityValues(t);
    const specific=variantCapacities.length===1;
    return {spec:specific?variantCapacities[0]:(multiCapacity?null:uniqueOrNull(parentCapacities)),
      ambiguous:variantCapacities.length>1||(!specific&&(multiCapacity||parentCapacities.length>1))};
  }
  return {spec:null,ambiguous:false};
}
function buildIndex(products){
  const buckets=new Map([...CATEGORIES].map(c=>[c,[]]));
  const options=new Map([...CATEGORIES].map(c=>[c,new Set()]));
  const stats={cases:0,chargers:0,powerbanks:0};
  for(const p of products||[]){
    if(!p||p.in_stock===false||!Number.isSafeInteger(Number(p.id))||Number(p.price)<=0)continue;
    const category=detectCategory(p);
    if(!category)continue;
    stats[category]++;
    const hasVariants=Array.isArray(p.variants)&&p.variants.length>0;
    const unknownVariants=!hasVariants&&Number(p.variant_count||0)>1;
    const variants=hasVariants?p.variants:[null];
    for(const v of variants){
      if(v&&(v.in_stock===false||Number(v.price)<=0))continue;
      const parsed=parseSpec(category,p.name,v?.name||'');
      // For multi-variant listings with no records, price/option cannot be verified.
      const verified=parsed.spec!==null&&!parsed.ambiguous&&!unknownVariants;
      const row={product:p,variant:v||null,spec:parsed.spec,
        verified,reasons:unknownVariants?['Chưa có chi tiết từng phân loại']:
          parsed.ambiguous?['Có nhiều thông số trong tên']:
            parsed.spec===null?['Chưa rõ thông số']:[]};
      buckets.get(category).push(row);
      // Offer choices from real title/variation mentions even when final SKU
      // needs verification; never claim these are confirmed availability.
      if(parsed.spec!==null&&!parsed.ambiguous)options.get(category).add(parsed.spec);
    }
  }
  return {buckets,options,stats};
}
function validate(q={}){
  const category=String(q.category||'');
  if(!CATEGORIES.has(category))throw Object.assign(new Error('Nhóm hàng không hợp lệ'),{status:400});
  const raw=String(q.value??'');
  const value=raw.trim()||null;
  const page=Number(q.page??1),limit=Number(q.limit??24);
  const possiblePage=Number(q.possiblePage??1);
  if(!Number.isSafeInteger(page)||page<1||page>10000||
     !Number.isSafeInteger(possiblePage)||possiblePage<1||possiblePage>10000||
     !Number.isSafeInteger(limit)||limit<1||limit>48)
    throw Object.assign(new Error('Phân trang không hợp lệ'),{status:400});
  let validated=null;
  if(value!==null){
    if(category==='cases'){
      if(!/^(iphone-1[1-9](?:-(?:pro-max|promax|pro|plus|mini|air|e))?|galaxy-[sa]\d{1,2}(?:-(?:ultra|plus|fe|5g))?)$/.test(value))
        throw Object.assign(new Error('Dòng máy không hợp lệ'),{status:400});
      validated=value.replace('-promax','-pro-max');
    }else{
      const number=Number(value);
      if(!Number.isFinite(number)||!(category==='chargers'?powerOptions:capacities).includes(number))
        throw Object.assign(new Error('Thông số không hợp lệ'),{status:400});
      validated=number;
    }
  }
  return {category,value:validated,page,limit,possiblePage};
}
function searchIndex(index,query={}){
  const f=validate(query),exact=new Map(),possible=new Map();
  for(const row of index.buckets.get(f.category)||[]){
    if(f.value!==null&&row.spec!==null&&row.spec!==f.value)continue;
    const id=Number(row.product.id),price=Number(row.variant?.price??row.product.price);
    if(!(price>0))continue;
    const matches=row.verified&&(f.value===null||row.spec===f.value);
    const dest=matches?exact:possible;
    const prev=dest.get(id);
    if(!prev||price<Number(prev.variant?.price??prev.product.price))dest.set(id,row);
  }
  for(const id of exact.keys())possible.delete(id);
  const order=(a,b)=>Number(a.variant?.price??a.product.price)-
    Number(b.variant?.price??b.product.price)||Number(a.product.id)-Number(b.product.id);
  const good=[...exact.values()].sort(order),uncertain=[...possible.values()].sort(order);
  return {category:f.category,total:good.length,possibleTotal:uncertain.length,
    page:f.page,totalPages:Math.ceil(good.length/f.limit)||1,
    possiblePage:f.possiblePage,possiblePages:Math.ceil(uncertain.length/8)||1,
    matched:good.slice((f.page-1)*f.limit,f.page*f.limit),
    possible:uncertain.slice((f.possiblePage-1)*8,f.possiblePage*8)};
}
function filterOptions(index,category){
  if(!CATEGORIES.has(category))throw Object.assign(new Error('Nhóm hàng không hợp lệ'),{status:400});
  const values=[...(index.options.get(category)||[])].sort((a,b)=>{
    if(typeof a==='number')return a-b;
    return a.localeCompare(b,'vi');
  });
  return {category,values,productCount:index.stats[category]||0};
}
module.exports={buildIndex,searchIndex,filterOptions,detectCategory,parseSpec,
  modelMatches,phoneModel,capacityValues,watts,validate};
