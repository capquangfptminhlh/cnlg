'use strict';
/**
 * BESI specifications index over existing sellable catalog.
 * Confident hits and incomplete/ambiguous suggestions are NEVER mixed.
 * This remains a derived, in-memory search index; upstream data is unchanged.
 * Caller must project all returned products through publicProduct().
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
const isLightning=s=>/\b(lightning|lighting|lightnig|lightining|8 ?pin)\b/.test(s);
const isUSBc=s=>/\b(type ?c|usb ?c|usbc|typec|usb ?type ?c)\b/.test(s);
const isUSBa=s=>/\b(usb ?a|type ?a|usba)\b/.test(s);
const usbCtoIp=/\b(?:type ?c|usb ?c|usbc|typec|tc|c)\s*(?:to|sang|2)\s*(?:ip|iphone|lightning|lighting|8 ?pin)\b/;
const usbAtoIp=/\b(?:usb ?a|type ?a|usba|a)\s*(?:to|sang|2)\s*(?:ip|iphone|lightning|lighting|8 ?pin)\b/;
const usbCtoC=/\b(?:type ?c|usb ?c|usbc|typec|c)\s*(?:to|sang|2 dau|2)\s*(?:type ?c|usb ?c|usbc|typec|c)\b/;
const usbAtoC=/\b(?:usb ?a|type ?a|usba|a)\s*(?:to|sang|2)\s*(?:type ?c|usb ?c|usbc|typec|c)\b/;
function connectorOf(text){
  const s=' '+norm(text)+' ';
  const l=isLightning(s),c=isUSBc(s),a=isUSBa(s);
  if(usbCtoIp.test(s)||/\b(c2l|c2ip|tc2ip|typec2lightning)\b/.test(s))return 'c-lightning';
  if(usbAtoIp.test(s)||/\b(a2l|a2ip|usb2lightning)\b/.test(s))return 'a-lightning';
  if(usbCtoC.test(s)||/\b(c2c|cc cable|2 dau type c)\b/.test(s))return 'c-c';
  if(usbAtoC.test(s)||/\b(a2c|usb2typec)\b/.test(s))return 'a-c';
  // A shared title listing both Type-C and Lightning may describe separate
  // choices (Micro / Type-C / Lightning), NOT a Type-C -> Lightning cable.
  // Without an explicit connector pair, keep it as an unverified candidate.
  if(l&&c&&!a)return null;
  if(l&&a&&!c)return null;
  if(l&&!c&&!a)return 'lightning';
  // Both USB-C and USB-A mentioned without clear direction: never guess.
  if(!l&&c&&a)return null;
  return null;
}
function cableName(text){
  const s=norm(text);
  if(/\b(cu sac|bo sac|sac du phong|op lung|tai nghe|dau chuyen|adapter|hub|dock)\b/.test(s)
    &&!/\b(cap|cable|day sac|day cap|cord|wire)\b/.test(s))return false;
  return /\b(cap|cable|day sac|day cap|charging cord|charging wire|cord|wire|day data)\b/.test(s);
}
function connectorHints(text){
  const s=norm(text), found=new Set();
  if(/\b(ip|iphone|ipad|lightning|lighting|lightnig|8 ?pin|c2l|a2l)\b/.test(s)){
    for(const type of ['c-lightning','a-lightning','lightning'])found.add(type);
  }
  if(isUSBc(s)||/\b(c2c|c2l|c2ip)\b/.test(s)){
    for(const type of ['c-c','a-c','c-lightning'])found.add(type);
  }
  if(isUSBa(s)){for(const type of ['a-c','a-lightning'])found.add(type);}
  // Completely unspecified cable: retain as an explicitly unverified suggestion.
  if(!found.size)for(const type of CONNECTORS)found.add(type);
  return found;
}
function buildIndex(products,reviewedRecords={}){
  const buckets=new Map([...CONNECTORS].map(type=>[type,[]]));
  const uncertain=new Map([...CONNECTORS].map(type=>[type,[]]));
  const review=[];
  let indexed=0,cableProducts=0,reviewedVariations=0;
  for(const p of products||[]){
    if(!p||p.in_stock===false||!Number.isSafeInteger(Number(p.id))||!(Number(p.price)>0))continue;
    const title=norm(p.name);
    const hasList=Array.isArray(p.variants)&&p.variants.length>0;
    const needsVariantDetail=!hasList&&Number(p.variant_count||0)>1;
    const vars=hasList?p.variants:[null];
    // Missing the word "cáp" in a title must not hide a cable whose
    // category, subtype or an explicit connector pair identifies it.
    const category=norm(p.category_name||p.category||'');
    const otherProduct=/\b(cu sac|bo sac|op lung|tai nghe|adapter|hub|dock|dau chuyen|sac du phong)\b/.test(title);
    const cable=cableName(title)||vars.some(v=>cableName(v?.name))
      ||(!otherProduct&&(cableName(category)||connectorOf(title)!==null));
    if(!cable)continue;
    cableProducts++;
    let incomplete=false,classified=false;
    for(const v of vars){
      if(v&&(v.in_stock===false||!(Number(v.price)>0)))continue;
      const variantText=norm(v?.name),combined=title+' '+variantText;
      // Overrides apply only to the exact live product/variation ID. A
      // product-level review never silently blesses all choices on a listing.
      const key=String(p.id)+':'+String(v?.id||'');
      const override=reviewedRecords[key];
      const isVerified=override?.verified===true
        && Number(override.productId)===Number(p.id)
        && String(override.variantId||'')===String(v?.id||'')
        && !needsVariantDetail;
      const type=isVerified?override.connector:connectorOf(combined);
      const length=isVerified?(override.length??lengthOf(variantText)??lengthOf(title)):
        (lengthOf(variantText)||lengthOf(title));
      const watt=isVerified?(override.power??powerOf(variantText)??powerOf(title)):
        (powerOf(variantText)||powerOf(title));
      const color=isVerified?(override.color||colorOf(variantText)||colorOf(title)):
        (colorOf(variantText)||colorOf(title));
      if(isVerified)reviewedVariations++;
      const row={product:p,variant:v||null,length,watt,color,type,
        unverifiedReason:needsVariantDetail?'Chưa xác minh từng phân loại và giá':null};
      if(type&&!needsVariantDetail){
        buckets.get(type).push(row);
        if(type==='c-lightning'||type==='a-lightning')buckets.get('lightning').push(row);
        classified=true;indexed++;
      }else{
        incomplete=true;
        // Even a clear title cannot confirm the sellable variation if the
        // listing says variant_count>1 but does not include those variants.
        const options=type
          ? new Set([type,...(type.includes('lightning')?['lightning']:[])])
          : connectorHints(combined);
        for(const hint of options)uncertain.get(hint).push(row);
      }
      if(!length||!watt||!color)incomplete=true;
    }
    if(incomplete||!classified){
      // Safe for admin diagnostics when mapped through publicProduct().
      review.push({product:p,reason:!classified?'unknown_connector':'missing_spec'});
    }
  }
  return {buckets,uncertain,review,indexed,cableProducts,reviewedVariations,productCount:products?.length||0};
}
function validate(query={}){
  const type=String(query.type??'c-lightning');
  const length=Number(query.length||0),power=Number(query.power||0),color=String(query.color||'');
  const page=Number(query.page||1),limit=Number(query.limit||24);
  const possiblePage=Number(query.possiblePage||1);
  if(!CONNECTORS.has(type)||!LENGTHS.has(length)||!POWERS.has(power)||!COLORS.has(color)
     ||!Number.isSafeInteger(page)||page<1||page>10000
     ||!Number.isSafeInteger(possiblePage)||possiblePage<1||possiblePage>10000
     ||!Number.isSafeInteger(limit)||limit<1||limit>48){
    const e=new Error('Bộ lọc thông số không hợp lệ');e.status=400;throw e;
  }
  return {type,length,power,color,page,limit,possiblePage};
}
function rowCost(row){return Number(row.variant?.price??row.product.price);}
function searchIndex(index,request={}){
  const filter=validate(request);
  const certain=new Map(),potential=new Map();
  function consider(row,unknownConnector=false){
    if(filter.length&&row.length&&Math.abs(row.length-filter.length)>.001)return;
    if(filter.power&&row.watt&&row.watt!==filter.power)return;
    if(filter.color&&row.color&&row.color!==filter.color)return;
    const id=Number(row.product.id);
    if(!(rowCost(row)>0))return;
    const missing=[];
    if(unknownConnector)missing.push(row.unverifiedReason||'Đầu kết nối chưa rõ');
    if(filter.length&&!row.length)missing.push('Chưa rõ chiều dài');
    if(filter.power&&!row.watt)missing.push('Chưa rõ công suất');
    if(filter.color&&!row.color)missing.push('Chưa rõ màu sắc');
    const target=missing.length?potential:certain;
    const prev=target.get(id);
    if(!prev||missing.length<prev.reasons.length
      ||(missing.length===prev.reasons.length&&rowCost(row)<rowCost(prev.row)))
      target.set(id,{row,reasons:missing});
  }
  for(const row of index.buckets.get(filter.type)||[])consider(row);
  for(const row of index.uncertain?.get(filter.type)||[])consider(row,true);
  for(const id of certain.keys())potential.delete(id);
  const sort=(a,b)=>rowCost(a.row)-rowCost(b.row)||Number(a.row.product.id)-Number(b.row.product.id);
  const certainList=[...certain.values()].sort(sort),potentialList=[...potential.values()].sort((a,b)=>
    a.reasons.length-b.reasons.length||sort(a,b));
  const total=certainList.length,possibleTotal=potentialList.length;
  return {
    total,possibleTotal,page:filter.page,
    totalPages:Math.ceil(total/filter.limit)||1,
    possiblePage:filter.possiblePage,
    possiblePages:Math.ceil(possibleTotal/8)||1,
    matched:certainList.slice((filter.page-1)*filter.limit,filter.page*filter.limit)
      .map(x=>x.row),
    possible:potentialList.slice((filter.possiblePage-1)*8,filter.possiblePage*8),
    filter
  };
}
function coverage(index,{page=1,limit=50}={}){
  const p=Number(page),l=Number(limit);
  if(!Number.isSafeInteger(p)||p<1||p>10000
    ||!Number.isSafeInteger(l)||l<1||l>100)throw Object.assign(
      new Error('Trang báo cáo không hợp lệ'),{status:400});
  return {cableProducts:index.cableProducts,indexedVariations:index.indexed,reviewedVariations:index.reviewedVariations||0,
    reviewCount:index.review.length,page:p,
    totalPages:Math.ceil(index.review.length/l)||1,
    review:index.review.slice((p-1)*l,p*l)};
}
module.exports={buildIndex,searchIndex,coverage,validate,norm,lengthOf,powerOf,colorOf,connectorOf,connectorHints};
