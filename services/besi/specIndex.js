'use strict';
/**
 * BESI indexed specification search: ephemeral, server-side derived data only.
 * Never stores or serializes upstream source identifiers, URLs or purchase costs.
 * The caller must project matched products through the normal publicProduct DTO.
 */
const CONNECTORS=new Set(['c-lightning','a-lightning','lightning','c-c','a-c']);
const COLORS=new Set(['','den','trang','xanh']);
const LENGTHS=new Set([0,.5,1,1.2,1.5,2,3]);
const POWERS=new Set([0,20,30,60,100]);
const norm=s=>String(s??'').normalize('NFKC').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d')
  .replace(/[→–—_\/-]/g,' ').replace(/\s+/g,' ').trim();
function lengthOf(text){
  const matches=[...norm(text).matchAll(/(^|[^0-9])(\d+(?:[.,]\d+)?)\s*(mm|cm|m|met|meter)(?![a-z])/g)]
    .map(x=>{const n=Number(x[2].replace(',','.'));return x[3]==='mm'?n/1000:x[3]==='cm'?n/100:n})
    .filter(x=>Number.isFinite(x)&&x>.05&&x<=20);
  const distinct=[...new Set(matches)];
  return distinct.length===1?distinct[0]:0;
}
function powerOf(text){
  const found=[...norm(text).matchAll(/(^|[^0-9])(\d{1,3})\s*w(?![a-z])/g)]
    .map(x=>Number(x[2])).filter(x=>x>0&&x<=240);
  return new Set(found).size===1?found[0]:0;
}
function colorOf(text){
  const s=' '+norm(text)+' ';
  if(/\b(black|den)\b/.test(s))return 'den';
  if(/\b(white|trang)\b/.test(s))return 'trang';
  if(/\b(blue|green|xanh)\b/.test(s))return 'xanh';
  return '';
}
function connectorOf(text){
  const s=' '+norm(text)+' ';
  const lightning=/\b(lightning|lighting|lightnig|8 ?pin)\b/.test(s);
  const c=/\b(type ?c|usb ?c|usbc|typec)\b/.test(s)
    || /\bc (?:to|sang) (?:lightning|lighting|lightnig)\b/.test(s);
  const a=/\b(usb ?a|type ?a|usba)\b/.test(s);
  const cc=/\b(?:type c|usb c|typec|usbc|c)\s*(?:to|sang|2 dau|2)\s*(?:type c|usb c|typec|usbc|c)\b/.test(s)
    || (s.match(/\b(type c|usb c|typec|usbc)\b/g)||[]).length>=2;
  if(lightning&&c&&!a)return 'c-lightning';
  if(lightning&&a&&!c)return 'a-lightning';
  if(lightning&&!c&&!a)return 'lightning';
  if(!lightning&&cc)return 'c-c';
  if(!lightning&&c&&a)return 'a-c';
  return null;
}
function cableName(s){
  return /\b(cap|cable|charging cable|day sac|day cap|wire)\b/.test(s);
}
function buildIndex(products){
  const buckets=new Map([...CONNECTORS].map(type=>[type,[]]));
  let indexed=0;
  for(const p of products||[]){
    if(!p||p.in_stock===false||!Number.isSafeInteger(Number(p.id))||Number(p.price)<=0)continue;
    const title=norm(p.name);
    if(!cableName(title))continue;
    const variations=Array.isArray(p.variants)&&p.variants.length?p.variants:[null];
    for(const v of variations){
      if(v&&(v.in_stock===false||!(Number(v.price)>0)))continue;
      const variantText=norm(v?.name);
      const combined=title+' '+variantText;
      const type=connectorOf(combined);
      if(!type)continue;
      // Variation-specific specs must take priority over parent display names.
      const length=lengthOf(variantText)||lengthOf(title);
      const watt=powerOf(variantText)||powerOf(title);
      const color=colorOf(variantText)||colorOf(title);
      const row={product:p,variant:v||null,length,watt,color};
      buckets.get(type).push(row);
      if(type==='c-lightning'||type==='a-lightning'||type==='lightning'){
        // "All Lightning" combines both connector types, but never duplicates
        // a product when its connector is already generic Lightning.
        if(type!=='lightning')buckets.get('lightning').push(row);
      }
      indexed++;
    }
  }
  return {buckets,indexed,productCount:products?.length||0};
}
function validate(query={}){
  const type=String(query.type??'c-lightning');
  const length=Number(query.length||0);
  const power=Number(query.power||0);
  const color=String(query.color||'');
  const page=Number(query.page||1),limit=Number(query.limit||24);
  if(!CONNECTORS.has(type)||!LENGTHS.has(length)||!POWERS.has(power)||!COLORS.has(color)
     ||!Number.isSafeInteger(page)||page<1||page>10000
     ||!Number.isSafeInteger(limit)||limit<1||limit>48){
    const e=new Error('Bộ lọc thông số không hợp lệ');e.status=400;throw e;
  }
  return {type,length,power,color,page,limit};
}
function searchIndex(index,request={}){
  const filter=validate(request);
  const matched=new Map();
  const rows=index.buckets.get(filter.type)||[];
  for(const row of rows){
    if(filter.length&&Math.abs(row.length-filter.length)>.001)continue;
    if(filter.power&&row.watt!==filter.power)continue;
    if(filter.color&&row.color!==filter.color)continue;
    const id=Number(row.product.id);
    const price=Number(row.variant?.price||row.product.price);
    if(!(price>0))continue;
    const previous=matched.get(id);
    if(!previous||price<Number(previous.variant?.price||previous.product.price))matched.set(id,row);
  }
  const ordered=[...matched.values()].sort((a,b)=>
    Number(a.variant?.price||a.product.price)-Number(b.variant?.price||b.product.price)
    ||Number(a.product.id)-Number(b.product.id));
  const total=ordered.length,start=(filter.page-1)*filter.limit;
  return {total,page:filter.page,totalPages:Math.ceil(total/filter.limit)||1,
    matched:ordered.slice(start,start+filter.limit),filter};
}
module.exports={buildIndex,searchIndex,validate,norm,lengthOf,powerOf,colorOf,connectorOf};
