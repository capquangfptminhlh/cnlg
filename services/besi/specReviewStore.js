'use strict';
/**
 * BESI verified attribute overrides. This private file is separate from
 * supplier feeds, so catalog synchronization cannot erase human corrections.
 * Single-process atomic file storage for MVP, migrate to transactional DB
 * before multiple worker replicas are enabled.
 */
const fs=require('node:fs');
const path=require('node:path');
const CONNECTORS=new Set(['c-lightning','a-lightning','lightning','c-c','a-c']);
const COLORS=new Set(['den','trang','xanh']);
const LENGTHS=new Set([.5,1,1.2,1.5,2,3]);
const POWERS=new Set([20,30,60,100]);
const FILE=path.resolve(__dirname,'../../data/besi-spec-overrides.json');
const bad=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const recordKey=(productId,variantId='')=>String(productId)+':'+String(variantId||'');
function positiveId(v){
  const id=Number(v);
  if(!Number.isSafeInteger(id)||id<1)bad('Mã sản phẩm không hợp lệ');
  return id;
}
function validVariantId(v){
  if(v==null||v==='')return '';
  const s=String(v);
  if(s.length>110||!/^[-a-zA-Z0-9_:.]+$/.test(s))bad('Mã phân loại không hợp lệ');
  return s;
}
function normalizeInput(data){
  if(!data||typeof data!=='object'||Array.isArray(data))bad('Thông số phải là đối tượng');
  const productId=positiveId(data.productId),variantId=validVariantId(data.variantId);
  const connector=String(data.connector||'');
  if(!CONNECTORS.has(connector))bad('Đầu cáp không hợp lệ');
  const length=data.length==null||data.length===''?null:Number(data.length);
  const power=data.power==null||data.power===''?null:Number(data.power);
  const color=String(data.color||'')||null;
  if(length!==null&&!LENGTHS.has(length))bad('Chiều dài không hợp lệ');
  if(power!==null&&!POWERS.has(power))bad('Công suất không hợp lệ');
  if(color!==null&&!COLORS.has(color))bad('Màu sắc không hợp lệ');
  // Any submitted correction requires a human confirmation, not an AI guess.
  if(data.confirmed!==true)bad('Phải xác nhận đã kiểm tra thông số thực tế');
  return {productId,variantId,connector,length,power,color,
    verified:true,reviewedAt:new Date().toISOString()};
}
function createStore(filename=FILE){
  let cache=null,mtime=-1;
  function load(){
    let stat;
    try{stat=fs.statSync(filename)}catch(e){
      if(e.code!=='ENOENT')throw e;
      if(mtime!==0){cache={version:1,revision:0,records:{}};mtime=0;}
      return cache;
    }
    if(stat.size>12*1024*1024)throw Error('BESI spec overrides vượt giới hạn');
    if(cache&&mtime===stat.mtimeMs)return cache;
    const parsed=JSON.parse(fs.readFileSync(filename,'utf8'));
    if(parsed.version!==1||!parsed.records||Array.isArray(parsed.records)||typeof parsed.records!=='object')
      throw Error('Định dạng BESI spec overrides không hợp lệ');
    cache=parsed;mtime=stat.mtimeMs;
    return cache;
  }
  function commit(change){
    const current=load();
    const copy={version:1,revision:(current.revision||0)+1,
      records:{...current.records}};
    const result=change(copy);
    if(Object.keys(copy.records).length>100000)bad('Vượt số lượng thông số kiểm duyệt');
    fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
    const tmp=filename+'.'+process.pid+'.'+require('node:crypto').randomBytes(6).toString('hex')+'.tmp';
    try{
      fs.writeFileSync(tmp,JSON.stringify(copy),{encoding:'utf8',mode:0o600,flag:'wx'});
      fs.renameSync(tmp,filename);fs.chmodSync(filename,0o600);
    }finally{try{fs.unlinkSync(tmp)}catch{}}
    cache=copy;mtime=fs.statSync(filename).mtimeMs;
    return result;
  }
  function save(data,lookup){
    const entry=normalizeInput(data);
    const p=lookup(entry.productId);
    if(!p)bad('Sản phẩm không tồn tại',404);
    const list=Array.isArray(p.variants)?p.variants:[];
    if(entry.variantId){
      if(!list.some(v=>String(v.id)===entry.variantId))bad('Phân loại không tồn tại',404);
    }else if(list.length>1||Number(p.variant_count||0)>1){
      bad('Sản phẩm có nhiều phân loại; phải duyệt đúng từng phân loại');
    }
    const key=recordKey(entry.productId,entry.variantId);
    return commit(s=>{
      s.records[key]=entry;
      return {record:entry,revision:s.revision};
    });
  }
  function remove(productId,variantId=''){
    const key=recordKey(positiveId(productId),validVariantId(variantId));
    return commit(s=>{
      if(!s.records[key])bad('Không có thông số được duyệt',404);
      delete s.records[key];
      return {removed:true,revision:s.revision};
    });
  }
  function snapshot(){
    const current=load();
    return {revision:current.revision,records:current.records};
  }
  function get(productId,variantId=''){
    return load().records[recordKey(positiveId(productId),validVariantId(variantId))]||null;
  }
  return {save,remove,snapshot,get};
}
module.exports={createStore,normalizeInput,recordKey};
