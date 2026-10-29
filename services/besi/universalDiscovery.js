'use strict';
/**
 * All-industry BESI catalog search. Indexes the EXISTING sellable goods only.
 * Attribute options are observed evidence, not invented product variants.
 * Unknown/ambiguous requested attributes are shown separately, never certified.
 *
 * Public DTO projection happens in server.js through publicProduct().
 */
const cable=require('./specIndex');
const accessory=require('./categoryFacets');
const norm=s=>String(s??'').normalize('NFKC').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d')
  .replace(/[→–—_\/\\]/g,' ').replace(/[-]/g,' ').replace(/\s+/g,' ').trim();
const ATTRS={
  model:'Dòng máy',length:'Chiều dài',watt:'Công suất',capacity:'Dung lượng pin',
  color:'Màu sắc',size:'Kích cỡ',material:'Chất liệu',storage:'Dung lượng bộ nhớ',
  ram:'RAM',connector:'Đầu kết nối'
};
const MATERIALS=[
  ['silicone',/\b(silicone|silicon)\b/],['tpu',/\btpu\b/],
  ['cotton',/\b(cotton|100% cotton|vai bong)\b/],['leather',/\b(da that|genuine leather|leather)\b/],
  ['pu',/\b(da pu|pu leather)\b/],['plastic',/\b(nhua|plastic|abs)\b/],
  ['metal',/\b(kim loai|hop kim|aluminum|aluminium|thep)\b/],
  ['glass',/\b(kinh|glass|cuong luc)\b/],['wood',/\b(go tu nhien|wood|wooden)\b/],
  ['polyester',/\bpolyester\b/],['nylon',/\bnylon\b/]
];
const COLORS=[
  ['den',/\b(den|black)\b/],['trang',/\b(trang|white)\b/],
  ['xanh',/\b(xanh|blue|green)\b/],['do',/\b(do|red)\b/],
  ['hong',/\b(hong|pink)\b/],['vang',/\b(vang|yellow|gold)\b/],
  ['tim',/\b(tim|purple)\b/],['xam',/\b(xam|gray|grey)\b/],
  ['nau',/\b(nau|brown)\b/],['cam',/\b(cam|orange)\b/]
];
const sizeLabels=['XXXS','XXS','XS','S','M','L','XL','XXL','XXXL','2XL','3XL','4XL','5XL'];
const attributeKeys=Object.keys(ATTRS);
const bad=msg=>Object.assign(new Error(msg),{status:400});
function values(text,patterns){
  const t=' '+norm(text)+' ';
  return patterns.filter(([,regex])=>regex.test(t)).map(([value])=>value);
}
function sizes(text,context=''){
  const category=norm(context);
  // Prevent classifying "M" for cable metres, "L" for Lightning connector,
  // or shoe model numbers as clothing sizes.
  const apparel=/\b(ao|quan|vay|dam|giay|dep|tui|thoi trang|clothing|shirt|shoe|sneaker|fashion|dress|size)\b/.test(category+' '+norm(text));
  if(!apparel)return [];
  const t=String(text||'').normalize('NFKC');
  const result=[];
  const re=/\b(?:size|sz|co|cỡ)\s*[:=-]?\s*(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|[2-5]XL|3[5-9]|4[0-9]|50)\b/gi;
  let m;while((m=re.exec(t)))result.push(m[1].toUpperCase());
  if(/\b(?:giay|dep|shoe|sneaker|size|cỡ)\b/i.test(t)){
    const shoes=/(?<!\d)(3[5-9]|4[0-9]|50)(?!\d)/g;
    while((m=shoes.exec(t)))result.push(m[1]);
  }
  // Plain isolated letters are not accepted without an explicit size label.
  return [...new Set(result)];
}
function memory(text,kind){
  const t=norm(text);const result=[];
  const re=/\b(\d{1,4})\s*(gb|tb)\b/g;let m;
  while((m=re.exec(t))){
    const mb=Number(m[1])*(m[2]==='tb'?1024:1);
    if(kind==='ram'){
      if(mb<=256&&/\bram\s*[:=-]?\s*\d/.test(t))result.push(mb+'gb');
    }else if(mb>=8&&mb<=8192&&!/\bram\s*[:=-]?\s*\d/.test(t))result.push(mb+'gb');
  }
  return [...new Set(result)];
}
function parseAttrs(text,categoryHint=''){
  const models=accessory.declaredModels(text).filter(x=>x);
  const length=cable.lengthOf(text);
  const watt=accessory.declaredPower(text);
  const capacity=accessory.declaredCapacity(text);
  const connector=cable.connectorOf(text);
  return {
    model:models, length:length?[String(length)]:[],watt:watt?[String(watt)]:[],
    capacity:capacity?[String(capacity)]:[],color:values(text,COLORS),
    size:sizes(text,categoryHint),material:values(text,MATERIALS),
    storage:memory(text,'storage'),ram:memory(text,'ram'),
    connector:connector?[connector]:[]
  };
}
function categoriesIndex(categories){
  const byId=new Map();
  for(const c of categories||[]){
    const id=Number(c?.id);
    if(!Number.isSafeInteger(id))continue;
    byId.set(id,{id,name:String(c.name||'Danh mục').slice(0,110),
      parent:Number(c.parent_id)||0});
  }
  const ancestry=new Map();
  for(const [id] of byId){
    let current=id,steps=0;const parentIds=new Set();
    while(byId.has(current)&&!parentIds.has(current)&&steps++<12){
      parentIds.add(current);current=byId.get(current).parent;
    }
    ancestry.set(id,parentIds);
  }
  return {byId,ancestry};
}
function rowPrice(row){return Number(row.variant?.price??row.product.price);}
function compile(products,categories){
  const cat=categoriesIndex(categories),rows=[],categoriesCount=new Map(),brands=new Map();
  const options=new Map(attributeKeys.map(k=>[k,new Map()]));
  for(const p of products||[]){
    if(!p||p.in_stock===false||!Number.isSafeInteger(Number(p.id))||Number(p.id)<1||
      !(Number(p.price)>0))continue;
    const catId=Number(p.category_id)||0;
    const catName=cat.byId.get(catId)?.name||String(p.category_name||'Khác');
    const brand=String(p.brand||'').trim().slice(0,80);
    const list=Array.isArray(p.variants)&&p.variants.length?p.variants:[null];
    const missingVariants=Number(p.variant_count||0)>list.length;
    const parent=parseAttrs(p.name,catName),title=norm(p.name),brandNorm=norm(brand);
    let hadStock=false;
    for(const variant of list){
      if(variant&&(variant.in_stock===false||!(Number(variant.price)>0)))continue;
      hadStock=true;
      const typed=variant?parseAttrs(variant.name,catName):null;
      const attributes={};
      for(const key of attributeKeys){
        // Explicit variation metadata takes priority. A multi-option parent
        // with conflicting values is NEVER treated as one exact option.
        const source=typed?.[key]?.length?typed[key]:parent[key];
        attributes[key]=[...new Set(source)];
        for(const value of attributes[key]){
          const bucket=options.get(key);
          const counter=bucket.get(value)||0;bucket.set(value,counter+1);
        }
      }
      const phrase=norm([p.name,variant?.name,brand,p.sku,catName].filter(Boolean).join(' '));
      rows.push({product:p,variant,categoryId:catId,categoryName:catName,
        brand,brandNorm,attributes,missingVariants,
        nameNorm:title,hay:phrase,
        // Catalog base prices are valid; variation-specific price only from
        // an actual stock variant, never from guesses.
        price:rowPrice({product:p,variant})});
    }
    if(hadStock){
      for(const ancestor of cat.ancestry.get(catId)||[catId])
        categoriesCount.set(ancestor,(categoriesCount.get(ancestor)||0)+1);
      if(brand)brands.set(brand,(brands.get(brand)||0)+1);
    }
  }
  return {rows,cat,categoriesCount,brands,options,productCount:rows.length};
}
function validate(index,q={}){
  const text=String(q.q||'').trim();
  if(text.length>120)throw bad('Từ khóa quá dài');
  const category=Number(q.category||0);
  if(!Number.isSafeInteger(category)||category<0||
    (category!==0&&!index.cat.byId.has(category)))throw bad('Danh mục không hợp lệ');
  const brand=String(q.brand||'').trim();
  if(brand.length>80)throw bad('Thương hiệu không hợp lệ');
  const attr=String(q.attr||''),value=String(q.value||'');
  if(attr&&!Object.hasOwn(ATTRS,attr))throw bad('Thuộc tính không hợp lệ');
  if(value&&!attr||value.length>90||attr&&value&&!/^[a-z0-9.-]{1,90}$/i.test(value))
    throw bad('Giá trị bộ lọc không hợp lệ');
  // Values are derived from the current catalog, preventing arbitrary filters.
  if(value&&!index.options.get(attr)?.has(value))throw bad('Thông số chưa có trong danh mục');
  const minPrice=q.minPrice==null||q.minPrice===''?0:Number(q.minPrice);
  const maxPrice=q.maxPrice==null||q.maxPrice===''?0:Number(q.maxPrice);
  if(!Number.isFinite(minPrice)||!Number.isFinite(maxPrice)||minPrice<0||maxPrice<0||
     minPrice>1000000000||maxPrice>1000000000||maxPrice&&minPrice>maxPrice)
    throw bad('Khoảng giá không hợp lệ');
  const page=Number(q.page??1),possiblePage=Number(q.possiblePage??1),limit=Number(q.limit??24);
  if(!Number.isSafeInteger(page)||page<1||page>10000||
    !Number.isSafeInteger(possiblePage)||possiblePage<1||possiblePage>10000||
    !Number.isSafeInteger(limit)||limit<1||limit>48)throw bad('Phân trang không hợp lệ');
  const sort=String(q.sort||'relevance');
  if(!['relevance','price-asc','price-desc','name-asc'].includes(sort))throw bad('Cách sắp xếp không hợp lệ');
  return {text,words:norm(text).split(' ').filter(Boolean),category,brand: norm(brand),
    attr,value,minPrice,maxPrice,page,possiblePage,limit,sort};
}
const ALIASES={
  lightning:['lighting','lightnig','iphone','8pin','8 pin'],
  lighting:['lightning','iphone'],type:['usb'],iphone:['ip'],ip:['iphone'],
  sac:['charger','charging'],cap:['cable'],op:['case'],day:['cable'],
  giay:['shoe','sneaker'],ao:['shirt','clothing'],pin:['battery']
};
function wordsMatch(hay,words){
  for(const word of words){
    const variations=[word,...(ALIASES[word]||[])];
    if(!variations.some(v=>hay.includes(v)))return false;
  }
  return true;
}
function scoreRow(row,words){
  if(!words.length)return 0;
  const phrase=words.join(' '),name=row.nameNorm;
  let score=words.filter(w=>name.includes(w)).length*3;
  if(name.includes(phrase))score+=15;
  if(name.startsWith(phrase))score+=12;
  if(row.brandNorm===phrase)score+=10;
  if(norm(row.product.sku)===phrase)score+=20;
  return score;
}
function shortlist(index,f){
  // Traverse all sellable rows: exact totals are computed before paging.
  const results=[];
  for(const row of index.rows){
    if(f.category&&!index.cat.ancestry.get(row.categoryId)?.has(f.category))continue;
    if(f.brand&&row.brandNorm!==f.brand)continue;
    if(f.words.length&&!wordsMatch(row.hay,f.words))continue;
    if(f.minPrice&&row.price<f.minPrice||f.maxPrice&&row.price>f.maxPrice)continue;
    if(!f.minPrice&&f.maxPrice&&row.price>f.maxPrice)continue;
    results.push(row);
  }
  return results;
}
function facetOptions(index,q={}){
  const query=validate(index,{...q,attr:'',value:'',page:1});
  const filtered=shortlist(index,query);
  const uniqueProducts=new Set(filtered.map(r=>r.product.id));
  const filteredCategories=new Map(),brandMap=new Map();
  const attributes=Object.fromEntries(attributeKeys.map(k=>[k,new Map()]));
  for(const row of filtered){
    for(const parent of index.cat.ancestry.get(row.categoryId)||[row.categoryId]){
      const found=filteredCategories.get(parent)||new Set();
      found.add(row.product.id);filteredCategories.set(parent,found);
    }
    if(row.brand){
      const group=brandMap.get(row.brand)||new Set();
      group.add(row.product.id);brandMap.set(row.brand,group);
    }
    for(const key of attributeKeys)for(const value of row.attributes[key]){
      const bucket=attributes[key],set=bucket.get(value)||new Set();
      set.add(row.product.id);bucket.set(value,set);
    }
  }
  const categories=[...filteredCategories].map(([id,set])=>({
    id,name:index.cat.byId.get(id)?.name||'Khác',count:set.size,
    parent:index.cat.byId.get(id)?.parent||0
  })).filter(c=>c.count>0).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'vi'));
  const brands=[...brandMap].map(([value,set])=>({value,count:set.size}))
    .sort((a,b)=>b.count-a.count||a.value.localeCompare(b.value,'vi')).slice(0,120);
  const facets={};
  for(const [key,bucket] of Object.entries(attributes)){
    facets[key]=[...bucket].map(([value,set])=>({value,count:set.size}))
      .sort((a,b)=>b.count-a.count||a.value.localeCompare(b.value,'vi')).slice(0,100);
  }
  return {total:uniqueProducts.size,categories,brands,facets,
    labels:ATTRS};
}
function search(index,q={}){
  const f=validate(index,q),confirmed=new Map(),possible=new Map();
  for(const row of shortlist(index,f)){
    if(f.attr&&f.value&&row.attributes[f.attr].length&&
      !row.attributes[f.attr].includes(f.value))continue;
    const reasons=[];
    if(f.attr&&f.value){
      if(!row.attributes[f.attr].length)reasons.push('Thông số chưa được công bố');
      if(row.attributes[f.attr].length>1)reasons.push('Có nhiều lựa chọn thông số');
      if(row.missingVariants)reasons.push('Chưa có chi tiết từng phân loại');
    }
    const target=reasons.length?possible:confirmed,id=Number(row.product.id);
    const old=target.get(id);
    if(!old||reasons.length<old.reasons.length||
       (reasons.length===old.reasons.length&&row.price<old.row.price))
      target.set(id,{row,reasons,score:scoreRow(row,f.words)});
  }
  for(const id of confirmed.keys())possible.delete(id);
  const order=(a,b)=>{
    if(f.sort==='price-asc')return a.row.price-b.row.price||a.row.product.id-b.row.product.id;
    if(f.sort==='price-desc')return b.row.price-a.row.price||a.row.product.id-b.row.product.id;
    if(f.sort==='name-asc')return a.row.nameNorm.localeCompare(b.row.nameNorm,'vi');
    return b.score-a.score||a.row.price-b.row.price||a.row.product.id-b.row.product.id;
  };
  const hit=[...confirmed.values()].sort(order),maybe=[...possible.values()]
    .sort((a,b)=>a.reasons.length-b.reasons.length||order(a,b));
  return {total:hit.length,possibleTotal:maybe.length,page:f.page,possiblePage:f.possiblePage,
    totalPages:Math.ceil(hit.length/f.limit)||1,possiblePages:Math.ceil(maybe.length/8)||1,
    matched:hit.slice((f.page-1)*f.limit,f.page*f.limit).map(x=>x.row),
    possible:maybe.slice((f.possiblePage-1)*8,f.possiblePage*8)};
}
module.exports={compile,search,facetOptions,parseAttrs,norm,validate,wordsMatch,sizes,memory,ATTRS};
