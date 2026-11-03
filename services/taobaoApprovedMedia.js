'use strict';
/**
 * Authorized first-party product media only. Never downloads a supplier URL.
 * Image upload requires an authenticated admin and explicit rights attestation
 * at the HTTP boundary. SVG, HTML, arbitrary files and source filenames
 * are never accepted, and no supplier URL is returned.
 */
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const ROOT=path.resolve(__dirname,'../public/images/taobao');
const MAX_BYTES=3*1024*1024;
function extension(data,mime){
  if(!Buffer.isBuffer(data)||data.length<16||data.length>MAX_BYTES)
    throw Error('Ảnh phải từ 16 byte đến 3 MB');
  const type=String(mime||'').toLowerCase().split(';')[0].trim();
  if(type==='image/jpeg'&&data.subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff])))return '.jpg';
  if(type==='image/png'&&data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return '.png';
  if(type==='image/webp'&&data.toString('ascii',0,4)==='RIFF'
    &&data.toString('ascii',8,12)==='WEBP')return '.webp';
  throw Error('Chỉ nhận JPEG, PNG hoặc WebP hợp lệ, không hỗ trợ SVG/HTML');
}
function saveImage(data,mime,opt={}){
  const ext=extension(data,mime);
  const name=crypto.createHash('sha256').update(data).digest('hex')+ext;
  const dir=opt.root||ROOT;
  fs.mkdirSync(dir,{recursive:true,mode:0o755});
  const dest=path.join(dir,name);
  try{fs.writeFileSync(dest,data,{flag:'wx',mode:0o644});}
  catch(e){if(e.code!=='EEXIST')throw e;}
  return {image:'/images/taobao/'+name,bytes:data.length};
}
module.exports={extension,saveImage,MAX_BYTES};
