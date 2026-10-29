'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.resolve(__dirname,'..');
const facets=require('../services/besi/specIndex');
const script=fs.readFileSync(path.join(ROOT,'public/besi-spec-filters.js'),'utf8');
const css=fs.readFileSync(path.join(ROOT,'public/besi-spec-filters.css'),'utf8');
const html=fs.readFileSync(path.join(ROOT,'public/index.html'),'utf8');
const product=(id,variants)=>({
  id,name:'Cáp sạc USB-C to Lightning 20W',price:49000,
  brand:'BESI',in_stock:true,variants
});
const variants=[
  {id:'V1',name:'1m Đen',price:49000,in_stock:true},
  {id:'V2',name:'2m Trắng',price:69000,in_stock:true},
  {id:'V3',name:'3m Đen',price:79000,in_stock:false}
];
const query=(index,config={})=>facets.searchIndex(index,{type:'c-lightning',...config});
test('index all public, sellable products once; exact 1m 2m variants and correct prices',()=>{
  const index=facets.buildIndex([product(1,variants)]);
  assert.equal(index.indexed,2);
  const one=query(index,{length:1});
  assert.equal(one.total,1);
  assert.equal(one.matched[0].variant.id,'V1');
  const two=query(index,{length:2});
  assert.equal(two.total,1);
  assert.equal(two.matched[0].variant.id,'V2');
  assert.equal(two.matched[0].variant.price,69000);
  assert.equal(query(index,{length:3}).total,0);
  assert.equal(query(index,{length:2,color:'den'}).total,0);
  assert.equal(query(index,{length:2,color:'trang',power:20}).total,1);
  assert.equal(query(index,{length:2,power:100}).total,0);
});
test('connector direction is precise: C-Lightning, A-Lightning, C-C and A-C',()=>{
  const create=(id,name)=>({id,name,price:20000,in_stock:true});
  const rows=[
    create(1,'Cáp Type-C to Lighting 2m'),
    create(2,'Cáp USB-A to Lightning 1m'),
    create(3,'Cáp USB C to USB C 100W 2m'),
    create(4,'Cáp USB-A to USB-C 1m'),
    create(5,'Củ sạc Type-C PD 30W'),
    create(6,'Ốp lưng iPhone Lightning style')
  ];
  const index=facets.buildIndex(rows);
  assert.equal(query(index,{length:2}).matched[0].product.id,1);
  assert.equal(query(index,{length:1}).total,0);
  assert.equal(facets.searchIndex(index,{type:'a-lightning'}).total,1);
  assert.equal(facets.searchIndex(index,{type:'c-c',length:2,power:100}).total,1);
  assert.equal(facets.searchIndex(index,{type:'a-c',length:1}).total,1);
  assert.equal(facets.searchIndex(index,{type:'lightning'}).total,2);
});
test('nothing inferred from missing length or stock; do not confuse mAh with meters',()=>{
  const rows=[
    {id:11,name:'Cáp USB-C to Lightning 10000mAh',price:29000,in_stock:true},
    {id:12,name:'Cáp USB-C to Lightning 200cm 20W',price:39000,in_stock:true},
    {id:13,name:'Cáp USB-C to Lightning 1m',price:39000,in_stock:false},
    {id:14,name:'Cáp USB-C to Lightning 3m',price:39000,in_stock:true,
      variants:[{id:'V4',name:'3m',price:39000,in_stock:false}]}
  ];
  const index=facets.buildIndex(rows);
  assert.equal(query(index,{length:1}).total,0);
  assert.equal(query(index,{length:2}).total,1);
  assert.equal(query(index,{length:3}).total,0);
  assert.deepEqual(facets.lengthOf('Cáp 1,2m 65W'),1.2);
  assert.equal(facets.lengthOf('Pin sạc 20000mAh'),0);
  assert.equal(facets.lengthOf('Cáp có 1m 2m cùng tên'),0);
});
test('results are deduplicated per product, paginated and sorted by actual matched variant price',()=>{
  const items=Array.from({length:60},(_,i)=>({
    id:100+i,name:'Cáp USB-C to Lightning 1m '+i,
    price:100000-i*1000,in_stock:true
  }));
  const index=facets.buildIndex(items);
  const first=query(index,{length:1,page:1,limit:24});
  const third=query(index,{length:1,page:3,limit:24});
  assert.equal(first.total,60);
  assert.equal(first.totalPages,3);
  assert.equal(first.matched.length,24);
  assert.equal(third.matched.length,12);
  assert.equal(first.matched[0].product.id,159);
  assert.equal(new Set([...first.matched,...third.matched].map(x=>x.product.id)).size,36);
});
test('malformed filter and pagination return 400-class rejection',()=>{
  const index=facets.buildIndex([]);
  for(const request of [{type:'unknown'},{length:'2.7'},{power:'999'},{color:'tim'},
    {page:'-1'},{limit:'1000'},{limit:'1e9'}]){
    assert.throws(()=>facets.searchIndex(index,request),err=>err.status===400);
  }
});
test('server implements invalidated full-catalog cache and public-only result projection',()=>{
  const server=fs.readFileSync(path.join(ROOT,'server.js'),'utf8');
  assert.match(server,/app\.get\('\/api\/products\/specs'/);
  assert.match(server,/besiSpecs\.buildIndex\(cachedSellable\)/);
  assert.match(server,/cachedSpecsIndex = null/);
  assert.match(server,/besiSpecs\.searchIndex\(specificationIndex\(\),req\.query\)/);
  assert.match(server,/const pub=publicProduct\(product\)/);
  assert.match(server,/matched_variant:matched/);
  assert.doesNotMatch(script,/dropbuy|cnlg|supplier_cost|source_url|dealer_price|wholesale_price/i);
});
test('front-end queries only server index, shows exact result counts and opens chosen variant',()=>{
  assert.doesNotThrow(()=>new vm.Script(script,{filename:'besi-spec-filters.js'}));
  assert.match(script,/\/api\/products\/specs\?/);
  assert.doesNotMatch(script,/\/api\/products\?/);
  assert.match(script,/matched_variant/);
  assert.match(script,/await openProductDetail\(id\)/);
  assert.match(script,/pickVariant\(available\.id\)/);
  assert.match(script,/stateUi\.total/);
  assert.match(html,/id="besiSpecFinder"/);
  assert.match(html,/name="besiLength" value="1"/);
  assert.match(html,/name="besiLength" value="2"/);
  assert.match(css,/@media\(max-width:700px\)/);
  assert.equal((css.match(/\{/g)||[]).length,(css.match(/\}/g)||[]).length);
});


test('alias dictionary handles C-to-iP, C2L, TC2IP, C2C, A2C and lightning misspellings',()=>{
  assert.equal(facets.connectorOf('Cáp sạc C to IP 20W'), 'c-lightning');
  assert.equal(facets.connectorOf('Cáp C2L 2m'), 'c-lightning');
  assert.equal(facets.connectorOf('Cáp TC2IP 1m'), 'c-lightning');
  assert.equal(facets.connectorOf('Cáp Type-C to Lighting'), 'c-lightning');
  assert.equal(facets.connectorOf('Cáp C2C 100W'), 'c-c');
  assert.equal(facets.connectorOf('Cáp A2C 2m'), 'a-c');
  assert.equal(facets.connectorOf('Cáp USB A to Lightning 1m'), 'a-lightning');
  assert.equal(facets.connectorOf('Dây sạc iPhone PD 2m'), null, 'iPhone alone does not prove Lightning');
  assert.ok(facets.connectorHints('Dây sạc iPhone PD 2m').has('c-lightning'));
  assert.ok(facets.connectorHints('Dây sạc iPhone PD 2m').has('a-lightning'));
});
test('unknown length appears as possible, not confirmed or permanently lost',()=>{
  const items=[
    {id:1,name:'Cáp USB-C to Lightning 2m 20W Đen',price:39000,in_stock:true},
    {id:2,name:'Cáp USB-C to Lightning 20W Đen',price:40000,in_stock:true},
    {id:3,name:'Cáp USB-C to Lightning 1m 20W Đen',price:29000,in_stock:true},
    {id:4,name:'Cáp sạc iPhone PD 20W',price:49000,in_stock:true},
    {id:5,name:'Ốp lưng iPhone',price:25000,in_stock:true}
  ];
  const index=facets.buildIndex(items);
  const result=query(index,{length:2,power:20,color:'den'});
  assert.equal(result.total,1,'2m declared, other specs declared');
  assert.equal(result.matched[0].product.id,1);
  const ids=result.possible.map(({row})=>row.product.id);
  assert.ok(ids.includes(2),'Cable without length must be discoverable as uncertain');
  assert.ok(ids.includes(4),'iPhone PD shorthand must be discoverable as uncertain');
  assert.ok(!ids.includes(3),'Known 1m cable must not appear as 2m candidate');
  assert.ok(!ids.includes(5),'Phone cases must not be offered as cables');
  assert.ok(result.possibleTotal>=2);
  assert.match(result.possible.find(x=>x.row.product.id===2).reasons.join(' '),/Chưa rõ chiều dài/);
});
test('unrecognized connector but explicit cable length is still suggested, never verified',()=>{
  const index=facets.buildIndex([
    {id:21,name:'Dây sạc nhanh iPhone 2m',price:39000,in_stock:true},
    {id:22,name:'Cáp sạc PD 2m',price:29000,in_stock:true}
  ]);
  const selected=query(index,{length:2});
  assert.equal(selected.total,0);
  assert.equal(selected.possibleTotal,2);
  assert.ok(selected.possible.every(x=>x.reasons.includes('Đầu kết nối chưa rõ')));
});
test('candidate pagination reports exact totals, never duplicates products already verified',()=>{
  const products=Array.from({length:20},(_,i)=>({
    id:200+i,name:'Cáp USB-C to Lightning 20W Mẫu '+i,
    price:49000+i,in_stock:true
  }));
  products.push({id:300,name:'Cáp USB-C to Lightning 2m 20W',price:39000,in_stock:true});
  const index=facets.buildIndex(products);
  const first=query(index,{length:2,possiblePage:1});
  const second=query(index,{length:2,possiblePage:2});
  assert.equal(first.total,1);
  assert.equal(first.possibleTotal,20);
  assert.equal(first.possiblePages,3);
  assert.equal(first.possible.length,8);
  assert.equal(second.possible.length,8);
  assert.equal(new Set([...first.possible,...second.possible].map(x=>x.row.product.id)).size,16);
  assert.ok(first.possible.every(x=>x.row.product.id!==300));
});
test('coverage report lists under-specified products privately, without creating fake data',()=>{
  const index=facets.buildIndex([
    {id:1,name:'Cáp USB C to Lightning 2m 20W Đen',price:29000,in_stock:true},
    {id:2,name:'Cáp sạc PD iPhone',price:27000,in_stock:true},
    {id:3,name:'Ốp iPhone',price:20000,in_stock:true}
  ]);
  const summary=facets.coverage(index);
  assert.equal(summary.cableProducts,2);
  assert.ok(summary.reviewCount>=1);
  assert.ok(summary.review.some(x=>x.product.id===2&&x.reason==='unknown_connector'));
  assert.ok(!summary.review.some(x=>x.product.id===3));
  const server=fs.readFileSync(path.join(ROOT,'server.js'),'utf8');
  assert.match(server,/\/api\/admin\/besi\/spec-coverage/);
  assert.match(server,/requireAdmin/);
  assert.match(server,/const possible=found\.possible\.map/);
  assert.match(server,/possibleTotal:found\.possibleTotal/);
});
test('UI explicitly separates uncertain products and supports independently paged candidate results',()=>{
  assert.match(html,/id="besiSpecPossible"/);
  assert.match(html,/id="besiSpecPossibleGrid"/);
  assert.match(html,/id="besiSpecPossibleMore"/);
  assert.match(script,/stateUi\.possibleTotal/);
  assert.match(script,/async function loadPossible/);
  assert.match(script,/Chưa đủ thông số/);
  assert.match(script,/product\.verified_spec!==false/);
  assert.doesNotMatch(script,/source_url|supplier_cost|wholesale_price|dealer_price/i);
});

test('missing keyword in title is rescued by cable category or explicit connector, not charger category',()=>{
  const index=facets.buildIndex([
    {id:601,name:'Baseus C to IP 2m',category_name:'Cáp sạc điện thoại',price:59000,in_stock:true},
    {id:602,name:'Baseus USB-C to Lightning 2m',price:49000,in_stock:true},
    {id:603,name:'Củ sạc Baseus USB-C PD 30W',category_name:'Cáp sạc',price:99000,in_stock:true}
  ]);
  const res=query(index,{length:2});
  assert.equal(res.total,2);
  assert.deepEqual(new Set(res.matched.map(r=>r.product.id)),new Set([601,602]));
  assert.ok(!res.matched.some(r=>r.product.id===603));
});
