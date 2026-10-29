'use strict';
/**
 * Indexed, server-side accessory facets. A result is "confirmed" only when
 * the requested attributes are explicitly attached to the same sellable
 * variation. Ambiguous/missing metadata goes to a separate review bucket.
 *
 * Pure derived data. Do not export supplier, cost, source or logistics data.
 */
const CATEGORIES=new Set(['case','charger','powerbank']);
const WATTS=new Set([0,10,12,15,18,20,22.5,25,30,33,35,40,45,50,60,65,67,70,80,90,100,120,140,150,200,240]);
const CAPACITIES=new Set([0,2000,3000,5000,6000,8000,10000,12000,15000,20000,25000,30000,40000,50000]);
const COLORS=new Set(['','den','trang','xanh']);
const MODELS=new Set([
  ...Array.from({length:9},(_,i)=>i+11).flatMap(n=>
    ['', 'pro-max','pro','plus','mini','air','e'].map(v=>'iphone-'+n+(v?'-'+v:''))),
  ...Array.from({length:16},(_,i)=>i+20).flatMap(n=>
    ['','ultra','plus','fe'].map(v=>'samsung-s'+n+(v?'-'+v:''))),
  ...Array.from({length:99},(_,i)=>i+1).flatMap(n=>
    ['','5g'].map(v=>'samsung-a'+n+(v?'-'+v:'')))
]);
const normalize=s=>String(s||'').normalize('NFKC').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d')
  .replace(/[–—→_/-]/g,' ').replace(/\s+/g,' ').trim();
const error=message=>Object.assign(new Error(message),{status:400});
function typeOf(product){
  const title=normalize(product.name);
  const category=normalize(product.category_name||product.category);
  if(/\b(pin du phong|sac du phong|power ?bank|external battery)\b/.test(title)
    || /\bpin sac du phong\b/.test(category))return 'powerbank';
  if(/\b(op lung|op dien thoai|phone case|protective case|silicone case)\b/.test(title)
    || (/\bvo op lung\b/.test(category)&&!(/\b(mieng dan|kinh cuong luc|screen protector)\b/.test(title))))return 'case';
  if(/\b(cap|cable|day sac|day cap)\b/.test(title))return null;
  if(/\b(cu sac|bo sac|adapter sac|wall charger|gan charger|charging adapter)\b/.test(title))
    return 'charger';
  return null;
}
function declaredPower(s){
  const w=[...normalize(s).matchAll(/(^|[^0-9])(\d{1,3}(?:[.,]\d+)?)\s*w(?![a-z])/g)]
    .map(m=>Number(m[2].replace(',','.'))).filter(n=>n>=5&&n<=240);
  return [...new Set(w)].length===1?w[0]:0;
}
function declaredCapacity(s){
  const matches=[...normalize(s).matchAll(/(^|[^0-9])(\d{1,2}[., ]\d{3}|\d{4,5}|\d{1,2}\s*k)\s*m\s*a\s*h\b/g)]
    .map(m=>m[2].includes('k')?Number(m[2].replace('k','').trim())*1000:
      Number(m[2].replace(/[., ]/g,'')))
    .filter(n=>n>=1000&&n<=50000);
  return [...new Set(matches)].length===1?matches[0]:0;
}
function declaredColor(s){
  const t=' '+normalize(s)+' ';
  const matches=[];
  if(/\b(den|black)\b/.test(t))matches.push('den');
  if(/\b(trang|white)\b/.test(t))matches.push('trang');
  if(/\b(xanh|blue|green)\b/.test(t))matches.push('xanh');
  return matches.length===1?matches[0]:'';
}
function declaredModels(s){
  const t=normalize(s);
  const result=new Set();
  // Strictly match both generation and family. "14prm - 17prm" is
  // ambiguous and cannot be advertised as a confirmed 15 Pro Max.
  const pro=/(?:iphone|ip)?\s*(1[1-7])\s*(?:pro\s*max|promax|prm|pm)\b/g;
  let m;
  while((m=pro.exec(t)))result.add('iphone-'+m[1]+'-pro-max');
  const normal=/(?:iphone|ip)\s*(1[1-7])\b(?!\s*(?:pro|promax|prm|pm))/g;
  while((m=normal.exec(t)))result.add('iphone-'+m[1]);
  const ultra=/(?:samsung|galaxy)?\s*s\s*(2[2-6])\s*ultra\b/g;
  while((m=ultra.exec(t)))result.add('samsung-s'+m[1]+'-ultra');
  // Include actual product generations not covered by legacy fixed filter
  // options. Never infer a model from "Samsung" or "iPhone" without digits.
  const ip=/\b(?:iphone|ip)\s*(1[1-9])\s*(pro\s*max|promax|pro|plus|mini|air|e)?\b/g;
  while((m=ip.exec(t))){
    const suffix=(m[2]||'').replace(/\s+/g,'-');
    result.add('iphone-'+m[1]+(suffix?'-'+suffix:''));
  }
  const sam=/\b(?:samsung|galaxy)\s*(?:galaxy\s*)?([sa])\s*(\d{1,2})\s*(ultra|plus|fe|5g)?\b/g;
  while((m=sam.exec(t))){
    const n=Number(m[2]);
    if(m[1]==='s'&&(n<20||n>35))continue;
    if(m[1]==='a'&&(n<1||n>99))continue;
    result.add('samsung-'+m[1]+n+(m[3]?'-'+m[3]:''));
  }
  return [...result];
}
function modelPotential(text,model,found){
  if(found.includes(model))return true;
  // Explicit conflicting model names are not "maybe" matches, unless
  // the title lists a range (e.g. 14PM -> 17PM) containing the target.
  const m=/^iphone-(1[1-7])-pro-max$/.exec(model);
  if(m&&found.length>=2&&found.every(x=>x.endsWith('-pro-max'))){
    const ns=found.map(x=>Number(x.split('-')[1]));
    if(/(\btu\b|\bden\b|\bto\b|\bsang\b|->|--|\.\.)/.test(String(text).toLowerCase())
      &&Number(m[1])>=Math.min(...ns)&&Number(m[1])<=Math.max(...ns))return true;
  }
  return found.length===0;
}
function buildIndex(products){
  const buckets=new Map([...CATEGORIES].map(c=>[c,[]]));
  for(const p of products||[]){
    if(!p||p.in_stock===false||!Number.isSafeInteger(Number(p.id))
      ||Number(p.price)<=0)continue;
    const category=typeOf(p);
    if(!category)continue;
    const variants=Array.isArray(p.variants)?p.variants:[];
    const incompleteVariations=Number(p.variant_count||0)>Math.max(variants.length,1);
    const choices=variants.length?variants:[null];
    const title=String(p.name||'');
    for(const v of choices){
      if(v&&(v.in_stock===false||Number(v.price)<=0))continue;
      const variantName=String(v?.name||'');
      const text=title+' '+variantName;
      // Variation model overrides parent model only when a variation
      // has exactly one declared model, avoiding cross-option leakage.
      const variantModels=declaredModels(variantName),parentModels=declaredModels(title);
      const models=variantModels.length?variantModels:parentModels;
      buckets.get(category).push({
        product:p,variant:v||null,category,models,sourceText:text,
        watt:declaredPower(variantName)||declaredPower(title),
        capacity:declaredCapacity(variantName)||declaredCapacity(title),
        color:declaredColor(variantName)||declaredColor(title),
        incompleteVariations
      });
    }
  }
  const options={};
  for(const [category,rows] of buckets){
    const models=new Set(),watts=new Set(),capacities=new Set();
    const productIds=new Set();
    for(const row of rows){
      productIds.add(row.product.id);
      for(const model of row.models)if(MODELS.has(model))models.add(model);
      if(row.watt&&WATTS.has(row.watt))watts.add(row.watt);
      if(row.capacity&&CAPACITIES.has(row.capacity))capacities.add(row.capacity);
    }
    options[category]={models:[...models].sort(),watts:[...watts].sort((a,b)=>a-b),
      capacities:[...capacities].sort((a,b)=>a-b),productCount:productIds.size};
  }
  return {buckets,productCount:products?.length||0,options};
}
function validate(q={}){
  const category=String(q.category||'case');
  const model=String(q.model||''),watt=Number(q.watt||0),
    capacity=Number(q.capacity||0),color=String(q.color||'');
  const page=Number(q.page||1),possiblePage=Number(q.possiblePage||1),limit=Number(q.limit||24);
  if(!CATEGORIES.has(category)||(!MODELS.has(model)&&model!=='')
    ||!WATTS.has(watt)||!CAPACITIES.has(capacity)||!COLORS.has(color)
    ||!Number.isSafeInteger(page)||page<1||page>10000
    ||!Number.isSafeInteger(possiblePage)||possiblePage<1||possiblePage>10000
    ||!Number.isSafeInteger(limit)||limit<1||limit>48)throw error('Bộ lọc ngành hàng không hợp lệ');
  if(category!=='case'&&model||category==='case'&&(watt||capacity)
    ||category==='charger'&&capacity||category==='powerbank'&&model)
    throw error('Thuộc tính không phù hợp ngành hàng');
  return {category,model,watt,capacity,color,page,possiblePage,limit};
}
const price=row=>Number(row.variant?.price??row.product.price);
function searchIndex(index,q={}){
  const f=validate(q),confirmed=new Map(),possible=new Map();
  for(const row of index.buckets.get(f.category)||[]){
    if(f.model&&row.models.length&&
      !modelPotential(row.sourceText,f.model,row.models))continue;
    if(f.watt&&row.watt&&row.watt!==f.watt)continue;
    if(f.capacity&&row.capacity&&row.capacity!==f.capacity)continue;
    if(f.color&&row.color&&row.color!==f.color)continue;
    const reasons=[];
    if(row.incompleteVariations)reasons.push('Phân loại chưa có dữ liệu đầy đủ');
    if(f.model&&row.models.length!==1)reasons.push('Chưa xác minh chính xác dòng máy');
    if(f.model&&row.models.length===1&&row.models[0]!==f.model)continue;
    if(f.watt&&!row.watt)reasons.push('Chưa xác minh công suất');
    if(f.capacity&&!row.capacity)reasons.push('Chưa xác minh dung lượng');
    if(f.color&&!row.color)reasons.push('Chưa xác minh màu sắc');
    const target=reasons.length?possible:confirmed;
    const id=Number(row.product.id),old=target.get(id);
    if(!old||reasons.length<old.reasons.length||
      (reasons.length===old.reasons.length&&price(row)<price(old.row)))
      target.set(id,{row,reasons});
  }
  for(const id of confirmed.keys())possible.delete(id);
  const sorter=(a,b)=>price(a.row)-price(b.row)||Number(a.row.product.id)-Number(b.row.product.id);
  const confirmedRows=[...confirmed.values()].sort(sorter);
  const possibleRows=[...possible.values()].sort((a,b)=>a.reasons.length-b.reasons.length||sorter(a,b));
  return {total:confirmedRows.length,possibleTotal:possibleRows.length,page:f.page,
    totalPages:Math.ceil(confirmedRows.length/f.limit)||1,possiblePage:f.possiblePage,
    possiblePages:Math.ceil(possibleRows.length/8)||1,
    matched:confirmedRows.slice((f.page-1)*f.limit,f.page*f.limit).map(x=>x.row),
    possible:possibleRows.slice((f.possiblePage-1)*8,f.possiblePage*8),filter:f};
}
function availableOptions(index,category){
  if(!CATEGORIES.has(category))throw error('Nhóm ngành hàng không hợp lệ');
  return {category,...(index.options?.[category]||
    {models:[],watts:[],capacities:[],productCount:0})};
}
module.exports={typeOf,declaredPower,declaredCapacity,declaredColor,
  declaredModels,modelPotential,buildIndex,searchIndex,validate,availableOptions};
