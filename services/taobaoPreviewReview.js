'use strict';
/**
 * Local-only, explicitly approved Taobao PREVIEW review.
 * No buy buttons, public prices, upstream links or source IDs are published.
 * Run on the BESI origin with read/write access to its private staging file.
 */
const fs = require('node:fs');
const path = require('node:path');
const importer = require('./sources/taobaoImporter');
const stageLock = require('./taobaoStageLock');

const validId = value => /^[0-9]{6,20}$/.test(String(value||''));
const allowedImage = image => !image || /^\/images\/taobao\/[a-z0-9/_-]+\.(?:jpg|jpeg|png|webp)$/i.test(image);

function findRow(items,id) {
  if(!validId(id)) throw Error('Taobao ID không hợp lệ');
  const row=items.find(x=>String(x.id)===String(id));
  if(!row) throw Error('Không tìm thấy sản phẩm trong kho chờ Taobao');
  return row;
}
function cleanVi(value,max=100){
  const s=String(value||'').trim().slice(0,max);
  if(!s||importer.hasHan(s)) throw Error('Thiếu nội dung tiếng Việt đã kiểm duyệt');
  return s;
}
function isFullyTranslated(row){
  if(row.translation_status!=='translated'||!row.title_vi||importer.hasHan(row.title_vi))return false;
  if(row.description_zh&&(!row.description_vi||importer.hasHan(row.description_vi)))return false;
  if(row.category_zh&&(!row.category_vi||importer.hasHan(row.category_vi)))return false;
  const originals=Array.isArray(row.options_zh)?row.options_zh:[];
  const translated=Array.isArray(row.options_vi)?row.options_vi:[];
  if(originals.length!==translated.length)return false;
  return translated.every(x=>String(x||'').trim()&&!importer.hasHan(x));
}
function list(options={}){
  const s=importer.read(options.file);
  const page=Math.max(1,Math.min(100000,parseInt(options.page,10)||1));
  const limit=Math.max(1,Math.min(100,parseInt(options.limit,10)||30));
  const q=String(options.q||'').trim().toLocaleLowerCase('vi').slice(0,80);
  const view=String(options.view||'all');
  const rows=s.items.filter(row=>{
    const approved=row.preview_approved===true&&row.rights_verified===true&&row.published===true;
    if(view==='approved'&&!approved)return false;
    if(view==='pending'&&row.translation_status==='translated')return false;
    if(view==='review'&&(approved||row.translation_status!=='translated'))return false;
    return !q||(String(row.id)+' '+String(row.title_vi||'')).toLocaleLowerCase('vi').includes(q);
  });
  return {total:rows.length,page,limit,
    rows:rows.slice((page-1)*limit,page*limit).map(row=>({
      id:String(row.id),title_vi:row.title_vi||'',category_vi:row.category_vi||'',
      translation_status:row.translation_status,
      preview_approved:row.preview_approved===true,
      rights_verified:row.rights_verified===true
    }))};
}
function approve(id,request={},options={}){
  if(request.rightsConfirmed!==true||request.translationReviewed!==true)
    throw Error('Phải xác nhận quyền sử dụng dữ liệu và đã kiểm tra bản dịch');
  const file=options.file||path.resolve(__dirname,'../data/taobao-staging.json');
  return stageLock.withLockSync(file,()=>{
  const s=importer.read(file);
  const row=findRow(s.items,id);
  if(!isFullyTranslated(row))throw Error('Tiêu đề, mô tả hoặc phân loại vẫn chưa được dịch đầy đủ');
  const category=cleanVi(request.category,100);
  const image=String(request.image||'').trim();
  if(!allowedImage(image))throw Error('Ảnh phải là tài sản BESI được cấp phép trong /images/taobao');
  if(image){
    // Only references existing local first-party media files; never hotlink.
    const root=path.resolve(__dirname,'../public');
    const resolved=path.resolve(root,'.'+image);
    if(!resolved.startsWith(root+path.sep)||!fs.existsSync(resolved)||!fs.statSync(resolved).isFile())
      throw Error('Ảnh BESI đã duyệt chưa tồn tại trong public/images/taobao');
  }
  row.category_vi=category; row.besi_image=image;
  row.rights_verified=true;row.preview_approved=true;row.published=true;
  row.purchasable=false;row.preview_reviewed_at=new Date().toISOString();
  importer.save(file,s.items);
  return {id:String(row.id),title_vi:row.title_vi,category_vi:category,
    approved_for_preview:true,can_order:false};
  });
}
function revoke(id,options={}){
  const file=options.file||path.resolve(__dirname,'../data/taobao-staging.json');
  return stageLock.withLockSync(file,()=>{
  const s=importer.read(file);
  const row=findRow(s.items,id);
  row.rights_verified=false;row.preview_approved=false;row.published=false;
  row.purchasable=false;
  importer.save(file,s.items);
  return {id:String(row.id),approved_for_preview:false,can_order:false};
  });
}
module.exports={isFullyTranslated,list,approve,revoke};
