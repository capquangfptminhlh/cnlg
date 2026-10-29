'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ROOT=path.resolve(__dirname,'..');
const js=fs.readFileSync(path.join(ROOT,'public/besi-spec-filters.js'),'utf8');
const css=fs.readFileSync(path.join(ROOT,'public/besi-spec-filters.css'),'utf8');
const html=fs.readFileSync(path.join(ROOT,'public/index.html'),'utf8');

function runEngine(){
  const nodes=new Map();
  const mockNode=id=>({
    id,hidden:true,value:'',addEventListener(){},
    querySelector(){return {value:'c-lightning',checked:true}},
    querySelectorAll(){return [{checked:true}]},
    closest(){return null},classList:{add(){},remove(){}}
  });
  for(const id of ['besiSpecFinder','besiSpecResults','besiSpecGrid','besiApplySpecs',
    'besiSpecLoadMore','besiSpecColor','besiSpecStatus','besiSpecResultsTitle',
    'besiExitSpecs','besiResetSpecs','besiSpecDetails','searchInput'])
    nodes.set(id,mockNode(id));
  const ctx={
    window:{addEventListener(){}},
    document:{getElementById(id){return nodes.get(id)||null},addEventListener(){}},
    console
  };
  vm.runInNewContext(js,ctx,{filename:'besi-spec-filters.js',timeout:4000});
  return ctx.window.BesiSpecs;
}
function fixture(){
  return {id:123,name:'Cáp USB-C to Lightning 20W',price:49000,in_stock:true,
    variants:[
      {id:'v1',name:'1m Đen',price:49000,in_stock:true},
      {id:'v2',name:'2m Trắng',price:69000,in_stock:true},
      {id:'v3',name:'3m Đen',price:79000,in_stock:false}
    ]};
}
const selection=(length=0,power=0,color='',type='c-lightning')=>({length,power,color,type});
test('BESI specification UI exists and loads at the end, without backend modification',()=>{
  assert.match(html,/id="besiSpecFinder"/);
  assert.match(html,/id="besiSpecResults"/);
  assert.match(html,/id="besiSpecGrid"/);
  assert.match(html,/name="besiConnector"/);
  assert.match(html,/USB-C → Lightning/);
  assert.match(html,/name="besiLength" value="1"/);
  assert.match(html,/name="besiLength" value="2"/);
  assert.match(html,/name="besiWatt" value="60"/);
  assert.match(html,/id="besiSpecColor"/);
  assert.ok(html.indexOf('/besi-spec-filters.js')>html.indexOf('/app.js'));
  assert.ok(html.indexOf('/besi-spec-filters.css')>html.indexOf('/besi-conversion.css'));
  assert.doesNotMatch(html,/data-source-url|data-supplier-cost|wholesale_price/);
});
test('smart finder matches accurate 1m/2m variations and rejects out-of-stock 3m',()=>{
  const engine=runEngine(),p=fixture();
  assert.equal(engine.isMatch(p,selection(1)).variant.id,'v1');
  assert.equal(engine.isMatch(p,selection(2)).variant.id,'v2');
  assert.equal(engine.isMatch(p,selection(3)),null);
  assert.equal(engine.isMatch(p,selection(2,20,'trang')).variant.price,69000);
  assert.equal(engine.isMatch(p,selection(2,20,'den')),null);
  assert.equal(engine.isMatch(p,selection(1,100)),null);
  assert.equal(engine.isMatch({...p,in_stock:false},selection(1)),null);
});
test('connector ends are normalized, but wrong connector and unspecified length do not match',()=>{
  const engine=runEngine();
  assert.equal(engine.connectorMatch('usb c to lightning','c-lightning'),true);
  assert.equal(engine.connectorMatch('type c to lighting','c-lightning'),true);
  assert.equal(engine.connectorMatch('c to lightning','c-lightning'),true);
  assert.equal(engine.connectorMatch('usb a to lightning','c-lightning'),false);
  assert.equal(engine.connectorMatch('usb a to lightning','a-lightning'),true);
  assert.equal(engine.connectorMatch('usb c to usb c','c-c'),true);
  assert.equal(engine.connectorMatch('usb a to usb c','a-c'),true);
  const item={id:9,name:'Cáp USB-C to Lightning 20W',price:35000,in_stock:true};
  assert.equal(engine.isMatch(item,selection(2)),null,
    'Must not invent cable length when not declared');
  assert.ok(engine.isMatch({...item,name:item.name+' 2m'},selection(2)));
  assert.equal(engine.isMatch({...item,name:item.name+' 1m'},selection(2)),null);
});
test('length parsing does not confuse 20W, 10000mAh, 1m and 2m',()=>{
  const engine=runEngine();
  assert.deepEqual(Array.from(engine.declaredLength('Cáp 1m 20W 10000mAh')),[1]);
  assert.deepEqual(Array.from(engine.declaredLength('Cáp 200cm')),[2]);
  assert.deepEqual(Array.from(engine.declaredLength('0,5m')),[.5]);
  assert.deepEqual(Array.from(engine.declaredLength('Phụ kiện 10000mAh')),[]);
});
test('client fetches only public paginated products with truthful progress and no supplier data',()=>{
  assert.match(js,/\/api\/products\?/);
  assert.match(js,/limit:String\(PAGE_SIZE\)/);
  assert.match(js,/storage\.scanned/);
  assert.match(js,/Còn|còn kết quả chưa kiểm tra/);
  assert.match(js,/!storage\.sources\.some|storage\.sources\.some/);
  assert.match(js,/await openProductDetail\(id\)/);
  assert.match(js,/pickVariant\(stillAvailable\.id\)/);
  assert.match(css,/\.besi-spec-grid/);
  assert.match(css,/@media\(max-width:700px\)/);
  assert.equal((css.match(/\{/g)||[]).length,(css.match(/\}/g)||[]).length);
  assert.doesNotMatch(js,/dropbuy|cnlg|techmall|supplier_cost|source_url|dealer_price|wholesale_price/i);
});
