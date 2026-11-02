'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const imp=require('../services/sources/taobaoImporter');
const preview=require('../services/taobaoPublic');
const review=require('../services/taobaoPreviewReview');
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'besi-taobao-feed-'));
const sample=(id,title='手机充电线',category='手机配件')=>({
  item_id:id,title_zh:title,description_zh:'耐用 100W',category_zh:category,
  options_zh:['红色','蓝色'],price_cny_reference:19.5,
  image_reference:'https://img.alicdn.com/something.jpg'
});
const ai=async rows=>rows.map(x=>({...x,title_vi:'Dây sạc điện thoại 100W',
  description_vi:'Bền bỉ 100W',category_vi:'Phụ kiện điện thoại',
  options_vi:['Đỏ','Xanh'],translation_status:'translated'}));
const opts=(file)=>({file,rightsConfirmed:true,skipPermissionCheck:true,translateImpl:ai});
const feed=(dir,items)=>{
  const filename=path.join(dir,'supplier.jsonl');
  fs.writeFileSync(filename,items.map(x=>JSON.stringify(x)).join('\n')+'\n');
  return filename;
};
test('Licensed JSONL imports titles, descriptions, category and SKU labels to private staged Vietnamese',async()=>{
  const dir=tmp();
  try{
    const file=path.join(dir,'stage.json');
    const data=feed(dir,[sample('123456789012'),sample('123456789013')]);
    const result=await imp.importFeed(data,opts(file));
    assert.equal(result.staged,2);
    assert.equal(result.translated,2);
    assert.equal(result.purchasable,0);
    assert.equal(result.published,0);
    const list=imp.read(file).items;
    assert.equal(list[0].title_vi,'Dây sạc điện thoại 100W');
    assert.equal(list[0].description_vi,'Bền bỉ 100W');
    assert.equal(list[0].category_vi,'Phụ kiện điện thoại');
    assert.deepEqual(list[0].options_vi,['Đỏ','Xanh']);
    assert.equal(list[0].price_cny_reference,19.5);
    assert.equal(list[0].purchasable,false);
    assert.equal(preview.catalogFromStage({},()=>imp.read(file)).total,0);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('No rights attestation means feed never opens',async()=>{
  const dir=tmp();
  try{
    const filename=feed(dir,[sample('123456789012')]);
    await assert.rejects(()=>imp.importFeed(filename,{skipPermissionCheck:true,file:path.join(dir,'stage.json')}),/rightsConfirmed/);
    assert.equal(fs.existsSync(path.join(dir,'stage.json')),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Import checkpoint persists finished 100-row batch if later row is invalid',async()=>{
  const dir=tmp();
  try{
    const file=path.join(dir,'stage.json');
    const rows=Array.from({length:100},(_,i)=>sample(String(123456789000+i)));
    const filename=path.join(dir,'feed.jsonl');
    fs.writeFileSync(filename,rows.map(x=>JSON.stringify(x)).join('\n')+'\n{not json}\n');
    await assert.rejects(()=>imp.importFeed(filename,opts(file)),/line 101/);
    assert.equal(imp.read(file).items.length,100);
    assert.equal(preview.catalogFromStage({},()=>imp.read(file)).total,0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Review survives an unchanged provider feed but is revoked after source category changes',async()=>{
  const dir=tmp();
  try{
    const file=path.join(dir,'stage.json'),filename=feed(dir,[sample('123456789012')]);
    await imp.importFeed(filename,opts(file));
    review.approve('123456789012',{rightsConfirmed:true,translationReviewed:true,category:'Phụ kiện điện thoại'},{file});
    assert.equal(preview.catalogFromStage({},()=>imp.read(file)).total,1);
    await imp.importFeed(filename,opts(file));
    assert.equal(preview.catalogFromStage({},()=>imp.read(file)).total,1);
    feed(dir,[sample('123456789012','手机充电线','手机配件 新分类')]);
    await imp.importFeed(filename,opts(file));
    assert.equal(preview.catalogFromStage({},()=>imp.read(file)).total,0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Incomplete Chinese field translation fails closed with no approval',async()=>{
  const dir=tmp();
  try{
    const file=path.join(dir,'stage.json'),filename=feed(dir,[sample('123456789012')]);
    await imp.importFeed(filename,{...opts(file),translateImpl:async rows=>rows.map(x=>({...x,
      title_vi:'Dây sạc',description_vi:'Bền bỉ',category_vi:'手机配件',options_vi:['Đỏ','Xanh'],translation_status:'translated'}))});
    assert.equal(imp.read(file).items[0].translation_status,'pending');
    assert.throws(()=>review.approve('123456789012',{rightsConfirmed:true,
      translationReviewed:true,category:'Phụ kiện điện thoại'},{file}),/chưa được dịch/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
