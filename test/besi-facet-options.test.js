'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const facet=require('../services/besi/categoryFacets');
const root=path.resolve(__dirname,'..');
const product=(id,name,price=42000)=>({id,name,price,in_stock:true});
test('new iPhone generations and variants do not accidentally match base phone',()=>{
  assert.deepEqual(facet.declaredModels('Ốp iPhone 16 Air'),['iphone-16-air']);
  assert.deepEqual(facet.declaredModels('Ốp iPhone 15 Pro'),['iphone-15-pro']);
  assert.deepEqual(facet.declaredModels('Ốp iPhone 16 Plus'),['iphone-16-plus']);
  assert.deepEqual(facet.declaredModels('Ốp iPhone 15 Pro Max'),['iphone-15-pro-max']);
  assert.deepEqual(facet.declaredModels('Ốp Samsung Galaxy A54 5G'),['samsung-a54-5g']);
  assert.deepEqual(facet.declaredModels('Ốp Samsung Galaxy S24 Plus'),['samsung-s24-plus']);
  assert.deepEqual(facet.declaredModels('Ốp Galaxy S24'),['samsung-s24']);
});
test('dynamic options are generated only from actual catalog attribute mentions',()=>{
  const idx=facet.buildIndex([
    product(1,'Ốp lưng iPhone 16 Air'),
    product(2,'Ốp lưng Samsung Galaxy A54 5G'),
    product(3,'Củ sạc 22.5W USB-C'),
    product(4,'Củ sạc nhanh GaN 35W'),
    product(5,'Pin dự phòng 20 000mAh'),
    product(6,'Pin dự phòng 5000mAh'),
    product(7,'Cáp USB-C to Lightning 100W')
  ]);
  assert.deepEqual(facet.availableOptions(idx,'case').models,
    ['iphone-16-air','samsung-a54-5g']);
  assert.deepEqual(facet.availableOptions(idx,'charger').watts,[22.5,35]);
  assert.deepEqual(facet.availableOptions(idx,'powerbank').capacities,[5000,20000]);
  assert.equal(facet.availableOptions(idx,'charger').productCount,2);
  assert.equal(facet.availableOptions(idx,'powerbank').productCount,2);
  assert.equal(facet.declaredCapacity('Pin 20 000mAh'),20000);
  assert.equal(facet.declaredPower('Củ sạc 22,5W'),22.5);
  assert.equal(facet.searchIndex(idx,{category:'case',model:'iphone-16-air'}).total,1);
  assert.equal(facet.searchIndex(idx,{category:'charger',watt:22.5}).total,1);
});
test('dynamic discovery does not invent missing sizes or imply availability',()=>{
  const idx=facet.buildIndex([
    {...product(11,'Ốp lưng Galaxy S24 Ultra'),variant_count:5},
    product(12,'Ốp lưng Samsung Galaxy A54')
  ]);
  assert.equal(facet.searchIndex(idx,{category:'case',model:'samsung-s24-ultra'}).total,0);
  assert.equal(facet.searchIndex(idx,{category:'case',model:'samsung-s24-ultra'}).possibleTotal,1);
  assert.deepEqual(facet.availableOptions(idx,'case').models,
    ['samsung-a54','samsung-s24-ultra']);
});
test('invalid dynamic facets and pagination are rejected before query',()=>{
  const idx=facet.buildIndex([]);
  for(const q of [{category:'case',model:'iphone-999'},
    {category:'case',page:0},{category:'charger',limit:0},
    {category:'powerbank',possiblePage:0},{category:'charger',watt:237},
    {category:'case',model:'../../admin'}]){
    assert.throws(()=>facet.searchIndex(idx,q),e=>e.status===400);
  }
  assert.throws(()=>facet.availableOptions(idx,'hacked'),e=>e.status===400);
});
test('new options endpoint is public data-only, rate-limited, and browser appends controls safely',()=>{
  const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
  const ui=fs.readFileSync(path.join(root,'public/besi-category-facets.js'),'utf8');
  const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  assert.match(server,/app\.get\('\/api\/products\/category-facets',rateLimit/);
  assert.match(server,/besiCategoryFacets\.availableOptions\(categoryFacetIndex\(\)/);
  assert.match(ui,/\/api\/products\/category-facets\?/);
  assert.match(ui,/function addOptions\(/);
  assert.match(ui,/document\.createElement\('option'\)/);
  assert.doesNotMatch(ui,/innerHTML\s*=|supplier_cost|source_url|wholesale_price|dealer_price/i);
  assert.match(html,/id="besiCaseModel"/);
  assert.match(html,/id="besiChargerWatt"/);
  assert.match(html,/id="besiPowerbankCapacity"/);
  assert.doesNotThrow(()=>new vm.Script(ui));
});
