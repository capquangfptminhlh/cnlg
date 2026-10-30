'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const discover=require('../services/besi/universalDiscovery');
const root=path.resolve(__dirname,'..');
const load=path=>fs.readFileSync(require('node:path').join(root,path),'utf8');
const cats=[
 {id:10,name:'Điện thoại và phụ kiện',parent_id:null},
 {id:11,name:'Ốp lưng',parent_id:10},
 {id:20,name:'Thời trang',parent_id:null},
 {id:21,name:'Quần áo',parent_id:20},
 {id:22,name:'Giày dép',parent_id:20},
 {id:30,name:'Gia dụng',parent_id:null},
 {id:31,name:'Dụng cụ nhà bếp',parent_id:30}
];
const p=(id,name,category_id,extra={})=>({id,name,category_id,price:120000,in_stock:true,...extra});
const fixture=[
 p(1,'Ốp lưng iPhone 16 Pro Max silicone đen',11,{brand:'BESI',price:39000}),
 p(2,'Áo thun cotton size XL màu trắng',21,{brand:'Áo Việt',price:149000}),
 p(3,'Giày thể thao Nike size 42 màu đen',22,{brand:'Nike',price:490000}),
 p(4,'Bình giữ nhiệt inox 500ml xanh',31,{brand:'LocknLock',price:169000}),
 p(5,'Sạc dự phòng 20000mAh 30W',10,{brand:'Anker',price:279000}),
 p(6,'Dây cáp USB-C to Lightning 2m 20W',10,{price:45000}),
 p(7,'Ốp lưng iPhone 16 có nhiều mẫu ốp màu',11,{price:29000,variant_count:4}),
 p(8,'Áo polo cotton',21,{price:199000,variants:[
   {id:'M',name:'Size M đen',price:199000,in_stock:true},
   {id:'XL',name:'Size XL đen',price:219000,in_stock:true},
   {id:'XXL',name:'Size XXL đen',price:239000,in_stock:false}
 ]}),
 p(9,'Áo sơ mi cotton màu trắng',21,{price:99000}),
 p(10,'Giày chạy bộ size 43',22,{price:590000,in_stock:false}),
 p(11,'Túi đeo chéo chất liệu da thật',20,{price:320000})
];
const index=()=>discover.compile(fixture,cats);
test('universal index covers unrelated industries, nested categories and actual category counts',()=>{
 const idx=index(),out=discover.facetOptions(idx);
 assert.equal(out.total,10,'out-of-stock product not counted');
 assert.ok(out.categories.some(x=>x.id===20&&x.count>=4));
 assert.ok(out.categories.some(x=>x.id===21&&x.count===3));
 assert.ok(out.categories.some(x=>x.id===31&&x.name==='Dụng cụ nhà bếp'));
 assert.ok(out.brands.some(x=>x.value==='Nike'));
 assert.equal(discover.search(idx,{category:20}).total,5);
 assert.equal(discover.search(idx,{category:21}).total,3);
 assert.equal(discover.search(idx,{category:31}).total,1);
});
test('full industry product name and category search is accent-insensitive, paginated',()=>{
 const idx=index();
 assert.equal(discover.search(idx,{q:'ao cotton'}).total,3);
 assert.equal(discover.search(idx,{q:'giay size 42'}).total,1);
 assert.equal(discover.search(idx,{q:'binh giu nhiet'}).total,1);
 assert.equal(discover.search(idx,{q:'dien thoai',category:31}).total,0);
 const page1=discover.search(idx,{q:'cotton',page:1,limit:2});
 const page2=discover.search(idx,{q:'cotton',page:2,limit:2});
 assert.equal(page1.total,3);
 assert.equal(page1.matched.length,2);
 assert.equal(page2.matched.length,1);
 assert.equal(new Set([...page1.matched,...page2.matched].map(x=>x.product.id)).size,3);
});
test('real source-derived size, material, model, price and brand facets',()=>{
 const idx=index();
 assert.equal(discover.search(idx,{category:21,attr:'size',value:'XL'}).total,2);
 assert.throws(()=>discover.search(idx,{category:21,attr:'size',value:'XXL'}),e=>e.status===400,
   'Out-of-stock-only size must never become a selectable option');
 assert.equal(discover.search(idx,{category:21,attr:'material',value:'cotton'}).total,3);
 assert.equal(discover.search(idx,{category:22,attr:'size',value:'42'}).total,1);
 assert.equal(discover.search(idx,{attr:'model',value:'iphone-16-pro-max'}).total,1);
 assert.equal(discover.search(idx,{brand:'Nike',minPrice:400000,maxPrice:500000}).total,1);
 assert.equal(discover.search(idx,{brand:'Nike',maxPrice:100000}).total,0);
 const options=discover.facetOptions(idx,{category:21});
 assert.ok(options.facets.size.some(x=>x.value==='XL'));
 assert.ok(options.facets.material.some(x=>x.value==='cotton'));
 assert.ok(options.facets.color.some(x=>x.value==='trang'));
 assert.ok(!options.facets.size.some(x=>x.value==='42'));
});
test('incomplete source variants show as possible, never confirmed and never fake a price',()=>{
 const idx=index();
 const selected=discover.search(idx,{category:11,attr:'color',value:'den'});
 assert.equal(selected.total,1);
 assert.equal(selected.possibleTotal,1);
 assert.equal(selected.matched[0].product.id,1);
 assert.equal(selected.possible[0].row.product.id,7);
 const xl=discover.search(idx,{category:21,attr:'size',value:'XL'});
 assert.ok(xl.matched.some(x=>x.variant?.id==='XL'&&x.variant.price===219000));
 assert.ok(!xl.matched.some(x=>x.variant?.id==='XXL'));
});
test('dynamic facets include phone specs and cables but do not infer unrelated size',()=>{
 const parsed=discover.parseAttrs('Dây cáp USB-C to Lightning 2m 20W');
 assert.equal(parsed.length[0],'2');
 assert.equal(parsed.connector[0],'c-lightning');
 assert.equal(parsed.watt[0],'20');
 assert.deepEqual(discover.sizes('Cáp Lightning chuẩn 2m'),[]);
 const wardrobe=discover.parseAttrs('Giày size 42 chất liệu da thật','Giày dép');
 assert.ok(wardrobe.size.includes('42'));
 assert.ok(wardrobe.material.includes('leather'));
 const idx=index();
 assert.ok(discover.facetOptions(idx).facets.capacity.some(x=>x.value==='20000'));
});
test('rejects unknown categories, forged attrs, huge query, bad prices and broken pagination',()=>{
 const idx=index();
 for(const q of [{category:999},{attr:'supplier_cost',value:'1000'},
  {attr:'size',value:'XSSSSSS'},{attr:'size',value:'../etc'},
  {minPrice:-100},{minPrice:100000,maxPrice:10000},{maxPrice:1e12},
  {page:0},{possiblePage:-1},{limit:999},{sort:'random'},
  {q:'a'.repeat(200)}]){
  assert.throws(()=>discover.search(idx,q),e=>e.status===400,JSON.stringify(q));
 }
});
test('server performs public-only DTO projection and UI uses non-HTML DOM for source values',()=>{
 const server=load('server.js'),html=load('public/index.html'),
  js=load('public/besi-universal.js'),css=load('public/besi-universal.css');
 assert.match(server,/app\.get\('\/api\/products\/discover\/options'/);
 assert.match(server,/app\.get\('\/api\/products\/discover'/);
 assert.match(server,/besiUniversal\.compile\(cachedSellable,storeCatalog\.getCategories\(\)\)/);
 assert.match(server,/const pub=publicProduct\(row\.product\)/);
 assert.match(server,/cachedUniversalDiscovery = null/);
 assert.match(html,/id="besiUniversalFinder"/);
 assert.match(html,/id="besiUniversalForm"/);
 assert.match(html,/id="besiUniversalAttribute"/);
 assert.match(html,/id="besiUniversalPossibleGrid"/);
 assert.match(html,/\/besi-universal\.js/);
 assert.match(html,/\/besi-universal\.css/);
 assert.doesNotThrow(()=>new vm.Script(js));
 assert.match(js,/\/api\/products\/discover\/options\?/);
 assert.match(js,/\/api\/products\/discover\?/);
 assert.match(js,/document\.createDocumentFragment\(\)/);
 assert.doesNotMatch(js,/innerHTML|supplier_cost|source_url|dealer_price|wholesale_price/i);
 assert.equal((css.match(/\{/g)||[]).length,(css.match(/\}/g)||[]).length);
 const cable=load('public/besi-spec-filters.js'),special=load('public/besi-category-facets.js');
 assert.match(cable,/besi:universal-filters-start/);
 assert.match(special,/besi:universal-filters-start/);
});

test('standalone size variants and RAM/ROM fields stay separate',()=>{
 const idx=discover.compile([
  p(201,'Áo cotton Polo',21,{variants:[
    {id:'M',name:'M',price:100000,in_stock:true},
    {id:'XL',name:'XL',price:110000,in_stock:true}]}),
  p(202,'Giày chạy bộ Nike',22,{variants:[
    {id:'42',name:'42',price:500000,in_stock:true},
    {id:'43',name:'43',price:500000,in_stock:false}]}),
  p(203,'Điện thoại RAM 8GB ROM 256GB',10)
 ],cats);
 assert.equal(discover.search(idx,{attr:'size',value:'XL'}).total,1);
 assert.equal(discover.search(idx,{attr:'size',value:'42'}).total,1);
 assert.throws(()=>discover.search(idx,{attr:'size',value:'43'}),e=>e.status===400,
   'A size available only in sold-out variants must not appear as a selectable facet');
 assert.deepEqual(discover.memory('RAM 8GB ROM 256GB','ram'),['8gb']);
 assert.deepEqual(discover.memory('RAM 8GB ROM 256GB','storage'),['256gb']);
});
test('a 20k item full-industry catalog remains searchable with page-level responses',()=>{
 const source=Array.from({length:20000},(_,i)=>({
  id:i+10000,name:i%2?'Ốp lưng iPhone 16 Pro Max đen':'Áo cotton size XL trắng',
  brand:i%2?'BESI':'Áo Việt',price:100000+i,
  category_id:i%2?11:21,in_stock:true
 }));
 const idx=discover.compile(source,cats);
 const res=discover.search(idx,{category:21,attr:'size',value:'XL',limit:24,page:1});
 assert.equal(res.total,10000);
 assert.equal(res.matched.length,24);
 assert.equal(res.possibleTotal,0);
 assert.ok(discover.facetOptions(idx,{category:11}).facets.model.some(x=>x.value==='iphone-16-pro-max'));
});

test('missing size attributes cannot turn unrelated electronics into possible clothing',()=>{
 const idx=discover.compile([
  p(301,'Áo thun cotton size XL',21,{price:120000}),
  p(302,'Áo polo cotton trơn',21,{price:99000}),
  p(303,'Tai nghe không dây Bluetooth',10,{price:39000}),
  p(304,'Củ sạc USB-C 35W',10,{price:99000}),
  p(305,'Bàn là mini',31,{price:89000}),
  p(306,'Khăn thể thao cotton',31,{price:39000})
 ],cats);
 const r=discover.search(idx,{attr:'size',value:'XL'});
 assert.equal(r.total,1);
 assert.equal(r.matched[0].product.id,301);
 assert.equal(r.possibleTotal,1,'Only plausible apparel missing size should be suggested');
 assert.equal(r.possible[0].row.product.id,302);
 assert.ok(!r.possible.some(x=>[303,304,305,306].includes(x.row.product.id)));
 assert.equal(discover.search(idx,{q:'ao cotton'}).total,2,
   'Áo cotton must not match thao in khăn thể thao cotton');
});
test('color without category or keyword avoids a flood of unknown products',()=>{
 const idx=discover.compile([
  p(311,'Ốp lưng iPhone màu đen',11),
  p(312,'Tai nghe Bluetooth không ghi màu',10),
  p(313,'Giày nữ không ghi màu',22)
 ],cats);
 const broad=discover.search(idx,{attr:'color',value:'den'});
 assert.equal(broad.total,1);
 assert.equal(broad.possibleTotal,0);
 const scoped=discover.search(idx,{category:22,attr:'color',value:'den'});
 assert.equal(scoped.total,0);
 assert.equal(scoped.possibleTotal,1);
});
test('legacy catalog sorting must not mutate shared cachedSellable',()=>{
 const server=load('server.js');
 assert.match(server,/products = \[\.\.\.cachedSellable\];/);
 assert.doesNotMatch(server,/products = cachedSellable;\s+if \(category && category !== 'all'\)/);
});
