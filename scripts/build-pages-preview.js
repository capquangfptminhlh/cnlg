'use strict';
/* Build a public-safe GitHub Pages artifact containing only storefront assets.
   NEVER copy admin panels, .env, /data, server, cookies or real product data. */
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const dst=path.join(root,'.pages-preview-dist');
const pub=path.join(root,'public');
const allowed=[
  'styles.css','marketplace.css','marketplace-v3.css','motion.css',
  'app.js','marketplace-home.js','favorites.js','motion.js',
  'storefront-premium.css','storefront-premium.js'
];
fs.rmSync(dst,{recursive:true,force:true});
fs.mkdirSync(dst,{recursive:true});
for(const name of allowed)fs.copyFileSync(path.join(pub,name),path.join(dst,name));
fs.copyFileSync(path.join(root,'scripts','pages-preview.js'),path.join(dst,'pages-preview.js'));
fs.writeFileSync(path.join(dst,'.nojekyll'),'');
let html=fs.readFileSync(path.join(pub,'index.html'),'utf8');
for(const name of allowed){
  html=html.replaceAll('="/'+name+'"','="./'+name+'"');
}
html=html.replace(/<script src="\/socket\.io\/socket\.io\.js"><\/script>/,'');
html=html.replaceAll('href="/"','href="./"');
html=html.replace('<script src="./app.js"></script>',
  '<script src="./pages-preview.js"></script>\n  <script src="./app.js"></script>');
html=html.replace('</head>','  <meta name="robots" content="noindex, nofollow">\n  <link rel="stylesheet" href="./pages-preview.css">\n</head>');
html=html.replace('<body>','<body data-demo-mode="true">\n'+
  '  <div class="pages-demo-ribbon" role="status" aria-label="Website demo">\n'+
  '    <strong>CHẾ ĐỘ DEMO</strong><span>Danh mục đã lưu trên GitHub · Giá có thể thay đổi · Không thanh toán thật</span>\n'+
  '  </div>');
html=html.replace('<title>','<title>[DEMO] ');
assert.ok(!html.includes('src="/socket.io/'),'Socket.IO must not connect from preview');
assert.ok(!html.includes('src="/app.js"')&&!html.includes('href="/styles.css"'));
assert.ok(html.indexOf('pages-preview.js')<html.indexOf('src="./app.js"'),'mock must load before storefront');
assert.ok(html.includes('data-demo-mode="true"'));
fs.writeFileSync(path.join(dst,'index.html'),html);

let app=fs.readFileSync(path.join(dst,'app.js'),'utf8');
// The production server owns /sp/ URLs, while GitHub Pages uses /cnlg/#/sp/...
app=app.replace(
  "if (location.pathname !== url) history.pushState({ productId: prod.id }, '', url);",
  "if (location.hash !== '#/sp/' + prod.id) history.pushState({ productId: prod.id }, '', '#/sp/' + prod.id);"
);
app=app.replace(
  "history.pushState(null, '', '/');",
  "history.pushState(null, '', location.pathname);"
);
fs.writeFileSync(path.join(dst,'app.js'),app);

const demoCss=String.raw`
.pages-demo-ribbon {
  position:relative;z-index:1001;width:100%;display:flex;justify-content:center;align-items:center;
  gap:12px;text-align:center;padding:8px 12px;background:#1e293b;color:#fff;font:600 12px/1.5 system-ui,sans-serif;
}
.pages-demo-ribbon strong {background:#fde68a;color:#713f12;padding:3px 8px;border-radius:4px;white-space:nowrap;}
.pages-demo-ribbon span {font-weight:500;}
body[data-demo-mode="true"] .market-banner-label::after {content:" • DEMO";color:#ffebb8;}
.demo-checkout-note {
  padding:12px 14px;background:#fff3df;color:#86471e;border-radius:8px;
  border:1px solid #ffd5a0;font-size:12px;line-height:1.6;font-weight:700;
}
body[data-demo-mode="true"] .btn-confirm-transfer {display:none;}
@media(max-width:700px){
 .pages-demo-ribbon {gap:5px;flex-wrap:wrap;font-size:10px;}
 .pages-demo-ribbon strong {font-size:10px;}
}
`;
fs.writeFileSync(path.join(dst,'pages-preview.css'),demoCss);

/* Generate a PUBLIC storefront-only snapshot. Do not publish the original
   data/products.json: it contains wholesale cost and pricing-rule fields. */
const productSource=path.join(root,'data','products.json');
const categoriesSource=path.join(root,'data','categories.json');
assert.ok(fs.existsSync(productSource),'Original product cache not found');
const originals=JSON.parse(fs.readFileSync(productSource,'utf8'));
const sourceCategories=JSON.parse(fs.readFileSync(categoriesSource,'utf8'));
assert.ok(Array.isArray(originals),'Product cache must be an array');
assert.ok(Array.isArray(sourceCategories),'Category cache must be an array');
assert.ok(originals.length>=100,'Expected existing full catalog, not 36 mock records');
function cleanText(value,max=280){
  return String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);
}
function cleanNumber(value){
  const number=Number(value);
  return Number.isFinite(number)&&number>=0?number:0;
}
function safeImage(value){
  if(typeof value!=='string')return '';
  let url=value.trim();
  // Relative images belong to the public storefront, not the repository root.
  if(url.startsWith('/images/'))return '.'+url.split('#')[0];
  if(url.startsWith('images/'))return './'+url.split('#')[0];
  // Never publish javascript/data schemes, local file paths or other protocols.
  try{
    const parsed=new URL(url);
    if(!['https:','http:'].includes(parsed.protocol))return '';
    if(parsed.username||parsed.password)return '';
    parsed.hash='';
    const allowed=new Set(['url','w','width','h','height','q','quality','format','fm','fit']);
    for(const key of [...parsed.searchParams.keys()]){
      if(!allowed.has(key.toLowerCase()))parsed.searchParams.delete(key);
    }
    return parsed.href;
  }catch(_){return '';}
}
const seen=new Set();
const products=[];
for(const record of originals){
  if(!record||typeof record!=='object')continue;
  const id=Number(record.id);
  if(!Number.isSafeInteger(id)||id<1||seen.has(id))continue;
  seen.add(id);
  const price=cleanNumber(record.price);
  const original=cleanNumber(record.original_price);
  const categoryId=Number(record.category_id);
  const image=safeImage(record.image);
  const imageHd=safeImage(record.image_hd)||image;
  const gallery=Array.isArray(record.gallery)
    ?record.gallery.slice(0,16).map(item=>{
       const entry=typeof item==='string'?{url:item,thumb:item}:item;
       if(!entry||typeof entry!=='object')return null;
       const url=safeImage(entry.url||entry.image);
       if(!url)return null;
       return {url,thumb:safeImage(entry.thumb)||url,is_video:false};
     }).filter(Boolean):[];
  const sku=cleanText(record.sku,70);
  const category=sourceCategories.find(c=>Number(c.id)===categoryId);
  const p={
    id,
    name:cleanText(record.name,380)||'Sản phẩm '+id,
    slug:cleanText(record.slug,120),
    sku,
    category_id:Number.isSafeInteger(categoryId)?categoryId:0,
    category_name:cleanText(record.category_name||category?.name||'Sản phẩm'),
    price,
    original_price:original>price?original:null,
    discount_percent:original>price&&price>0?Math.round((1-price/original)*100):0,
    image,image_hd:imageHd,
    gallery:gallery.length?gallery:[{url:imageHd,thumb:image}],
    in_stock:record.in_stock!==false,
    is_mall:Boolean(record.is_mall),
    warranty:cleanText(record.warranty,130),
    // The static preview cannot obtain full variant pricing; no real orders.
    variant_count:1,variation_id:id+10000000,
    description:'<p>Ảnh, tên và giá bán được lấy từ bộ nhớ đệm sản phẩm của cửa hàng tại thời điểm tạo bản demo. Không phải báo giá thời gian thực và không thể đặt mua trên GitHub Pages.</p>',
    variants:[{id:id+10000000,name:'Chế độ xem thử',sku,price,in_stock:record.in_stock!==false,is_default:true}],
    variation_options:[]
  };
  products.push(p);
}
assert.ok(products.length>=100,'No usable full catalog after applying public-field allowlist');
const catById=new Map(sourceCategories.map(c=>[Number(c.id),c]));
function descendantIds(id){
  const all=new Set([id]);
  let changed=true;
  while(changed){
    changed=false;
    for(const cat of sourceCategories){
      const catId=Number(cat.id),parent=Number(cat.parent_id);
      if(cat.parent_id!=null&&all.has(parent)&&!all.has(catId)){all.add(catId);changed=true;}
    }
  }
  return all;
}
const categories=sourceCategories.filter(c=>Number.isSafeInteger(Number(c.id))).map(c=>{
  const ids=descendantIds(Number(c.id));
  return {
    id:Number(c.id), name:cleanText(c.name),
    parent_id:c.parent_id==null?null:Number(c.parent_id),
    product_count:products.filter(p=>ids.has(p.category_id)).length
  };
});
const snapshot={generated_at:new Date().toISOString(),source:'public-retail-cache',products,categories};
const snapshotJSON=JSON.stringify(snapshot);
for(const prohibited of ['dropbuy_cost','profit_margin','wholesale_price','public_price','is_wholesale_price','pricing_rule','bankAccount','password','token']){
  assert.ok(!snapshotJSON.includes('"'+prohibited+'"'),'Private field leaked: '+prohibited);
}
fs.writeFileSync(path.join(dst,'products-public.json'),snapshotJSON,'utf8');
// Copy images intended for public display only. Not the private data directory.
const localImages=path.join(pub,'images','products');
if(fs.existsSync(localImages))fs.cpSync(localImages,path.join(dst,'images','products'),{recursive:true});
console.log('Public product snapshot:',products.length,'items in',categories.length,
  'categories; file bytes:',Buffer.byteLength(snapshotJSON),'(cached retail prices, not realtime)');

const expected=['index.html','pages-preview.js','pages-preview.css','products-public.json','.nojekyll',...allowed, ...(fs.existsSync(localImages)?['images']:[])];
assert.deepEqual(fs.readdirSync(dst).sort(),expected.sort(),'unexpected site contents');
const publicSite=fs.readFileSync(path.join(dst,'index.html'),'utf8');
for(const banned of ['ADMIN_PASSWORD','SEPAY_WEBHOOK_KEY','data/config.json','data/orders.json']){
  assert.ok(!publicSite.includes(banned),'sensitive reference: '+banned);
}
console.log('GitHub Pages demo prepared:',expected.filter(x=>x!=='.nojekyll').join(', '));
