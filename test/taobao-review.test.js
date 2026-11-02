'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const importer=require('../services/sources/taobaoImporter');
const review=require('../services/taobaoPreviewReview');
const publicData=require('../services/taobaoPublic');
const row=(id='123456789012')=>({...importer.normalize({
    item_id:id,title:'手机充电线',sku_options:['红色','蓝色'],
    zk_final_price:'15.00'},'充电线'),
  title_vi:'Cáp sạc USB-C',description_vi:'',options_vi:['Đỏ','Xanh'],
  translation_status:'translated'});

function withTemp(fn) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'taobao-review-'));
  const file=path.join(dir,'stage.json');
  return Promise.resolve().then(()=>fn(file)).finally(()=>fs.rmSync(dir,{recursive:true,force:true}));
}
test('Review cannot publish without attesting rights AND human-checked Vietnamese text',()=>withTemp(file=>{
  importer.save(file,[row()]);
  assert.throws(()=>review.approve('123456789012',{
    rightsConfirmed:true,category:'Phụ kiện điện thoại'},{file}),/Phải xác nhận/);
  assert.equal(publicData.catalogFromStage({},()=>importer.read(file)).total,0);
}));
test('Translated and rights-reviewed item appears ONLY in separate Taobao preview, never buyable',()=>withTemp(file=>{
  importer.save(file,[row()]);
  const approved=review.approve('123456789012',{
    rightsConfirmed:true,translationReviewed:true,category:'Phụ kiện điện thoại'},{file});
  assert.equal(approved.approved_for_preview,true);
  const saved=importer.read(file).items[0];
  assert.equal(saved.purchasable,false);
  const preview=publicData.catalogFromStage({},()=>importer.read(file));
  assert.equal(preview.total,1);
  assert.equal(preview.data[0].can_order,false);
  assert.equal(preview.data[0].name,'Cáp sạc USB-C');
  assert.equal(JSON.stringify(preview).includes('123456789012'),false);
  assert.equal(JSON.stringify(preview).includes('15.00'),false);
  review.revoke('123456789012',{file});
  assert.equal(publicData.catalogFromStage({},()=>importer.read(file)).total,0);
}));
test('Review rejects malformed category, untranslated options or unlicensed remote image',()=>withTemp(file=>{
  importer.save(file,[row()]);
  const req={rightsConfirmed:true,translationReviewed:true,category:'配件'};
  assert.throws(()=>review.approve('123456789012',req,{file}),/tiếng Việt/);
  assert.throws(()=>review.approve('123456789012',{...req,category:'Phụ kiện',image:'https://img.alicdn.com/demo.jpg'},{file}),/Ảnh/);
  const broken=row();broken.options_vi=['Đỏ','蓝色'];
  importer.save(file,[broken]);
  assert.throws(()=>review.approve('123456789012',{...req,category:'Phụ kiện'},{file}),/chưa được dịch/);
}));
test('Approved review survives unchanged import, but source text change revokes it',()=>withTemp(async file=>{
  importer.save(file,[row()]);
  review.approve('123456789012',{rightsConfirmed:true,translationReviewed:true,category:'Phụ kiện điện thoại'},{file});
  const product=(title)=>({item_id:'123456789012',title,sku_options:['红色','蓝色'],
    zk_final_price:'19.00'});
  const opts={file,skipPermissionCheck:true,noDelay:true,pages:1,
    fetchPageImpl:async()=>[product('手机充电线')],
    translateImpl:async data=>data.map(x=>({...x,title_vi:'Dây sạc USB-C',
      options_vi:['Đỏ','Xanh'],translation_status:'translated'}))};
  await importer.sync(['充电线'],opts);
  assert.equal(publicData.catalogFromStage({},()=>importer.read(file)).total,1);
  await importer.sync(['充电线'],{...opts,fetchPageImpl:async()=>[product('手机充电线 新版')]});
  assert.equal(publicData.catalogFromStage({},()=>importer.read(file)).total,0);
  assert.equal(importer.read(file).items[0].purchasable,false);
}));
