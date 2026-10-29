'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const facets=require('../services/besi/categoryFacets');
const root=path.resolve(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const product=(id,name,extra={})=>({id,name,price:49000,in_stock:true,...extra});
const query=(idx,category,value,extra={})=>facets.searchIndex(idx,{category,value,...extra});

test('cases: explicit iPhone, Samsung Galaxy models, variant-specific prices and stock',()=>{
  assert.equal(facets.detectCategory(product(1,'Ốp lưng iPhone 16 Pro Max')),'cases');
  assert.equal(facets.phoneModel('Ốp iPhone 16 Pro Max'),'iphone-16-pro-max');
  assert.equal(facets.phoneModel('Ốp Samsung Galaxy S24 Ultra'),'galaxy-s24-ultra');
  assert.equal(facets.phoneModel('Ốp Samsung A54'),'galaxy-a54');
  const p=product(4,'Ốp lưng iPhone 13/14',{
    variants:[{id:'i13',name:'iPhone 13 Đen',price:29000,in_stock:true},
      {id:'i14',name:'iPhone 14 Trong',price:39000,in_stock:true},
      {id:'i15',name:'iPhone 15 Xanh',price:49000,in_stock:false}]
  });
  const idx=facets.buildIndex([p]);
  assert.equal(query(idx,'cases','iphone-13').total,1);
  assert.equal(query(idx,'cases','iphone-13').matched[0].variant.id,'i13');
  assert.equal(query(idx,'cases','iphone-14').matched[0].variant.price,39000);
  assert.equal(query(idx,'cases','iphone-15').total,0);
  assert.deepEqual(facets.filterOptions(idx,'cases').values,['iphone-13','iphone-14']);
});
test('combined iPhone 14/15 without variation detail remains uncertain, not falsely precise',()=>{
  const idx=facets.buildIndex([
    product(1,'Ốp lưng iPhone 14/15'),
    product(2,'Ốp Samsung Galaxy S25 Ultra', {variant_count:5})
  ]);
  const r=query(idx,'cases','iphone-14');
  assert.equal(r.total,0);
  assert.equal(r.possibleTotal,1);
  assert.match(r.possible[0].reasons.join(' '),/nhiều|Chưa rõ/);
  assert.equal(query(idx,'cases','galaxy-s25-ultra').total,0);
  assert.equal(query(idx,'cases','galaxy-s25-ultra').possibleTotal,1);
  assert.equal(facets.filterOptions(idx,'cases').productCount,2);
});
test('charger power parsing handles actual 35W and variant availability, excludes cables',()=>{
  const idx=facets.buildIndex([
    product(1,'Củ sạc nhanh 2 cổng C+C 35W VOLTME REVO GaN',{
      variants:[{id:'x35',name:'35W Chân EU',price:143000,in_stock:true},
        {id:'x30',name:'30W Chân US',price:139000,in_stock:false}]
    }),
    product(2,'Cáp sạc nhanh USB-C 100W 2m'),
    product(3,'Củ sạc 20/35W', {variant_count:3})
  ]);
  assert.equal(query(idx,'chargers',35).total,1);
  assert.equal(query(idx,'chargers',35).matched[0].variant.id,'x35');
  assert.equal(query(idx,'chargers',30).total,0);
  assert.ok(query(idx,'chargers',35).possibleTotal>=1);
  assert.deepEqual(facets.filterOptions(idx,'chargers').values,[35]);
  assert.equal(facets.detectCategory(product(4,'Cáp sạc nhanh USB-C 100W')),null);
});
test('power banks parse 10.000/20.000 mAh, exclude misleading charger products',()=>{
  const idx=facets.buildIndex([
    product(1,'Pin dự phòng Anker Fusion 10.000mAh', {variant_count:2}),
    product(2,'Pin dự phòng 20.000mAh Anker Zolo 30W'),
    product(3,'Pin sạc dự phòng 5000mAh MagSafe'),
    product(4,'Củ sạc 35W PD'),
    product(5,'Pin dự phòng 5000/10000mAh')
  ]);
  assert.equal(facets.capacityValues('10.000mAh')[0],10000);
  assert.equal(facets.capacityValues('20,000mAh')[0],20000);
  assert.equal(query(idx,'powerbanks',20000).total,1);
  assert.equal(query(idx,'powerbanks',10000).total,0);
  assert.equal(query(idx,'powerbanks',10000).possibleTotal,2);
  assert.equal(query(idx,'powerbanks',5000).total,1);
  assert.equal(query(idx,'powerbanks',5000).possibleTotal,1);
  assert.equal(facets.filterOptions(idx,'powerbanks').productCount,4);
  assert.deepEqual(facets.filterOptions(idx,'powerbanks').values,[5000,10000,20000]);
});
test('API parameter validation rejects injection, malformed pagination and irrelevant categories',()=>{
  const idx=facets.buildIndex([]);
  for(const q of [{category:'unknown'},{category:'cases',value:'../../etc'},
    {category:'chargers',value:'999'},{category:'powerbanks',value:'-2'},
    {category:'cases',page:0},{category:'cases',limit:10000},
    {category:'cases',possiblePage:'2.2'}]){
    assert.throws(()=>facets.searchIndex(idx,q),e=>e.status===400);
  }
});
test('entire catalog pagination, sorting and possible queue are independent',()=>{
  const rows=Array.from({length:100},(_,i)=>product(i+1,'Củ sạc 20W', {price:100000-i}));
  rows.push(product(101,'Củ sạc chưa rõ công suất'));
  const idx=facets.buildIndex(rows);
  const r=query(idx,'chargers',20,{page:2,limit:24});
  assert.equal(r.total,100);assert.equal(r.page,2);assert.equal(r.totalPages,5);
  assert.equal(r.matched.length,24);assert.equal(r.possibleTotal,1);
  assert.equal(r.possible[0].product.id,101);
  const both=query(idx,'chargers','',{page:1,limit:48});
  assert.equal(both.total,100);
  assert.equal(new Set(both.matched.map(x=>x.product.id)).size,48);
});
test('UI, public DTO and cache invalidation are wired without changing checkout',()=>{
  const server=read('server.js'),html=read('public/index.html'),
    script=read('public/besi-category-facets.js'),css=read('public/besi-category-facets.css');
  assert.match(server,/besiCategories\.buildIndex\(cachedSellable\)/);
  assert.match(server,/cachedCategorySpecIndex = null/);
  assert.match(server,/app\.get\('\/api\/products\/category-specs'/);
  assert.match(server,/app\.get\('\/api\/products\/category-facets'/);
  assert.match(server,/const pub=publicProduct\(row\.product\)/);
  assert.match(server,/matched_variant:matched/);
  for(const word of ['cables','cases','chargers','powerbanks'])
    assert.match(html,new RegExp('data-besi-facet-category="'+word+'"'));
  for(const id of ['besiFacetValue','besiCategoryFacet','besiCategoryFacetResults','besiCategoryPossibleGrid'])
    assert.match(html,new RegExp('id="'+id+'"'));
  assert.doesNotThrow(()=>new vm.Script(script));
  assert.match(script,/\/api\/products\/category-facets\?/);
  assert.match(script,/\/api\/products\/category-specs\?/);
  assert.match(script,/await openProductDetail\(id\)/);
  assert.match(script,/pickVariant\(v\.id\)/);
  assert.doesNotMatch(script,/supplier_cost|source_url|dealer_price|wholesale_price|dropbuy|cnlg|techmall/i);
  assert.equal((css.match(/\{/g)||[]).length,(css.match(/\}/g)||[]).length);
});
