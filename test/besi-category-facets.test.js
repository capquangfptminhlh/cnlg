'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const facets=require('../services/besi/categoryFacets');
const root=path.join(__dirname,'..');
const product=(id,name,price=50000,extra={})=>({id,name,price,in_stock:true,...extra});
const search=(index,q)=>facets.searchIndex(index,{limit:24,...q});
test('realistic BESI case aliases detect phone model and respect variant choice',()=>{
  const catalog=[
    product(1,'Ốp Lưng iPhone 15 Pro Max nhựa dẻo Đen',15000),
    product(2,'Ốp lưng TPU từ 14PRM --> 17PRM',12000),
    product(3,'Ốp lưng 16PRM dẻo',19000),
    product(4,'Ốp lưng Samsung Galaxy S24 Ultra màu xanh',23000),
    product(5,'Miếng dán cường lực iPhone 15 Pro Max',10000,
      {category_name:'Vỏ ốp lưng & miếng dán'})
  ];
  const index=facets.buildIndex(catalog);
  const exact=search(index,{category:'case',model:'iphone-15-pro-max'});
  assert.equal(exact.total,1);
  assert.equal(exact.matched[0].product.id,1);
  assert.ok(exact.possible.some(x=>x.row.product.id===2),
    'range 14-17 Pro Max is plausible but not confirmed for 15');
  assert.ok(!exact.possible.some(x=>x.row.product.id===3),
    '16 Pro Max cannot be suggested as 15 Pro Max');
  assert.ok(!exact.possible.some(x=>x.row.product.id===5),
    'screen protector cannot be offered as case');
  assert.equal(search(index,{category:'case',model:'samsung-s24-ultra'}).total,1);
  assert.deepEqual(facets.declaredModels('IP16PM'),['iphone-16-pro-max']);
  assert.deepEqual(facets.declaredModels('Galaxy S24 Ultra'),['samsung-s24-ultra']);
});
test('option-specific case models do not leak parent model or sell out-of-stock options',()=>{
  const p=product(21,'Ốp lưng iPhone từ 14PRM --> 17PRM',39000,{
    variant_count:3,variants:[
      {id:'14',name:'14PRM Đen',price:29000,in_stock:true},
      {id:'15',name:'15PRM Đen',price:35000,in_stock:true},
      {id:'16',name:'16PRM Trắng',price:35000,in_stock:false}
    ]
  });
  const idx=facets.buildIndex([p]);
  const selected=search(idx,{category:'case',model:'iphone-15-pro-max',color:'den'});
  assert.equal(selected.total,1);
  assert.equal(selected.matched[0].variant.id,'15');
  assert.equal(selected.matched[0].variant.price,35000);
  assert.equal(search(idx,{category:'case',model:'iphone-16-pro-max',color:'trang'}).total,0);
});
test('charger wattage is extracted exactly; cables, power banks and ambiguous wattage excluded',()=>{
  const idx=facets.buildIndex([
    product(10,'Củ sạc nhanh 35W VOLTME Revo 35 Duo GaN',143000),
    product(11,'Củ sạc nhanh 30W VOLTME Revo 30 Mini',110000),
    product(12,'Cáp sạc USB-C to Lightning 35W',35000),
    product(13,'Pin dự phòng 10.000mAh 35W',89000),
    product(14,'Củ sạc nhanh đa công suất 20W và 35W',120000)
  ]);
  const a=search(idx,{category:'charger',watt:35});
  assert.equal(a.total,1);
  assert.equal(a.matched[0].product.id,10);
  assert.equal(a.possibleTotal,1);
  assert.equal(a.possible[0].row.product.id,14);
  assert.equal(search(idx,{category:'charger',watt:30}).total,1);
});
test('power bank capacities recognize 10.000mAh and 20000mAh without confusing watts',()=>{
  const idx=facets.buildIndex([
    product(20,'Pin dự phòng Anker Fusion 10.000mAh 20W',180000),
    product(21,'Pin dự phòng Anker Zolo 20.000mAh 30W',220000),
    product(22,'Pin dự phòng siêu mỏng 5000mAh 20W',79000),
    product(23,'Pin dự phòng 20W siêu mỏng',85000),
    product(24,'Củ sạc 20000mAh (không phải pin)',65000,{in_stock:false})
  ]);
  const result=search(idx,{category:'powerbank',capacity:10000,watt:20});
  assert.equal(result.total,1);
  assert.equal(result.matched[0].product.id,20);
  assert.ok(result.possible.some(x=>x.row.product.id===23));
  assert.equal(search(idx,{category:'powerbank',capacity:20000,watt:30}).total,1);
  assert.equal(facets.declaredCapacity('pin 20k mAh'),20000);
  assert.equal(facets.declaredCapacity('củ sạc PD 35W'),0);
});
test('missing stock variants remain possible but never falsely claim exact price',()=>{
  const idx=facets.buildIndex([
    product(88,'Ốp lưng 15 ProMax Đen',59000,{variant_count:9}),
    product(89,'Củ sạc 35W USB-C',69000,{variant_count:2})
  ]);
  assert.equal(search(idx,{category:'case',model:'iphone-15-pro-max'}).total,0);
  assert.equal(search(idx,{category:'case',model:'iphone-15-pro-max'}).possibleTotal,1);
  assert.equal(search(idx,{category:'charger',watt:35}).total,0);
  assert.equal(search(idx,{category:'charger',watt:35}).possibleTotal,1);
});
test('category filters paginate all products and reject unsupported cross-category filters',()=>{
  const data=Array.from({length:53},(_,i)=>product(100+i,
    'Ốp lưng IP15PM Đen '+i,10000+i*100));
  const idx=facets.buildIndex(data);
  const first=search(idx,{category:'case',model:'iphone-15-pro-max',page:1});
  const third=search(idx,{category:'case',model:'iphone-15-pro-max',page:3});
  assert.equal(first.total,53);
  assert.equal(first.totalPages,3);
  assert.equal(first.matched.length,24);
  assert.equal(third.matched.length,5);
  for(const q of [{category:'case',watt:20},{category:'charger',model:'iphone-15'},
    {category:'powerbank',capacity:12345},{category:'case',model:'iphone-999'},
    {category:'charger',limit:500},{category:'powerbank',page:-1},
    {category:'charger',color:'pink'}]){
    assert.throws(()=>search(idx,q),e=>e.status===400);
  }
});
test('server exposes sanitized whole-catalog category search, UI is present and mutually exclusive',()=>{
  const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
  const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  const ui=fs.readFileSync(path.join(root,'public/besi-category-facets.js'),'utf8');
  const cable=fs.readFileSync(path.join(root,'public/besi-spec-filters.js'),'utf8');
  const css=fs.readFileSync(path.join(root,'public/besi-category-facets.css'),'utf8');
  assert.match(server,/app\.get\('\/api\/products\/category-specs'/);
  assert.match(server,/besiCategoryFacets\.buildIndex\(cachedSellable\)/);
  assert.match(server,/const pub=publicProduct\(product\)/);
  assert.match(server,/cachedCategoryFacetsIndex = null/);
  assert.match(html,/id="besiCategoryFinder"/);
  assert.match(html,/id="besiCaseModel"/);
  assert.match(html,/id="besiChargerWatt"/);
  assert.match(html,/id="besiPowerbankCapacity"/);
  assert.match(html,/id="besiCategoryPossibleGrid"/);
  assert.ok(html.indexOf('/besi-category-facets.css')>html.indexOf('/besi-spec-filters.css'));
  assert.ok(html.indexOf('/besi-category-facets.js')>html.indexOf('/besi-spec-filters.js'));
  assert.doesNotThrow(()=>new vm.Script(ui));
  assert.match(ui,/\/api\/products\/category-specs\?/);
  assert.match(ui,/besi:cable-filters-start/);
  assert.match(cable,/besi:category-filters-start/);
  assert.doesNotMatch(ui,/supplier_cost|source_url|wholesale_price|dealer_price/i);
  assert.equal((css.match(/\{/g)||[]).length,(css.match(/\}/g)||[]).length);
});
