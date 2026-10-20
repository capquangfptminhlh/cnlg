'use strict';
/* Safe read-only proxy for publicly published DropBuy PRODUCT thumbnails.
 * Never forwards user URLs, cookies, sid or credentials to other hosts.
 * Memory cache is bounded; no persistence of private inventory data. */
const MAX_ITEMS=350;
const MAX_BYTES=750000;
const CACHE_AGE=12*60*60*1000;
const TIMEOUT_MS=8000;
const MAX_INFLIGHT=10;
const MAX_WAITING=100;
const cache=new Map();
const pending=new Map();
let active=0;
const waiters=[];

function allowedImage(value){
  if(typeof value!=='string'||value.length>1800)return null;
  try {
    const u=new URL(value);
    if(u.protocol!=='https:'||u.hostname!=='r6i.pen.dropbuy.vn'||u.port||
       u.username||u.password||!u.pathname.startsWith('/md/'))return null;
    return u;
  }catch{return null;}
}
function mimeFor(response){
  const mime=String(response.headers.get('content-type')||'').split(';')[0].toLowerCase();
  return ['image/jpeg','image/png','image/webp','image/avif'].includes(mime)?mime:null;
}
function allowedBytes(buffer,mime){
  if(!Buffer.isBuffer(buffer)||buffer.length<120||buffer.length>MAX_BYTES)return false;
  if(mime==='image/png')return buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(mime==='image/jpeg')return buffer[0]===255&&buffer[1]===216&&buffer[2]===255;
  if(mime==='image/webp')return buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP';
  if(mime==='image/avif')return buffer.toString('ascii',4,8)==='ftyp'&&buffer.toString('ascii',8,16).includes('avif');
  return false;
}
async function boundedFetch(url){
  if(active>=MAX_INFLIGHT){
    if(waiters.length>=MAX_WAITING)throw new Error('Ảnh đang được tải quá nhiều');
    await new Promise(resolve=>waiters.push(resolve));
  }
  active++;
  try {
    const response=await fetch(url.href,{
      method:'GET',redirect:'error',signal:AbortSignal.timeout(TIMEOUT_MS),
      headers:{accept:'image/avif,image/webp,image/png,image/jpeg', 'user-agent':'HoangMinhStore/1.0'}
    });
    if(!response.ok)throw new Error('CDN '+response.status);
    const mime=mimeFor(response);
    if(!mime)throw new Error('Không phải ảnh hợp lệ');
    const declared=Number(response.headers.get('content-length'));
    if(declared>MAX_BYTES)throw new Error('Ảnh quá lớn');
    let bytes=0;const chunks=[];
    for await(const chunk of response.body){
      bytes+=chunk.byteLength;
      if(bytes>MAX_BYTES)throw new Error('Ảnh quá lớn');
      chunks.push(Buffer.from(chunk));
    }
    const buffer=Buffer.concat(chunks,bytes);
    if(!allowedBytes(buffer,mime))throw new Error('Định dạng ảnh không hợp lệ');
    return {buffer,mime};
  }finally{
    active--;
    waiters.shift()?.();
  }
}
async function imageForProduct(product){
  if(!product||!Number.isSafeInteger(Number(product.id)))return null;
  const url=allowedImage(product.image);
  if(!url)return null;
  const key=String(product.id)+'|'+url.href;
  const hit=cache.get(key);
  if(hit&&Date.now()-hit.at<CACHE_AGE){
    cache.delete(key);cache.set(key,hit);
    return hit.result;
  }
  if(pending.has(key))return pending.get(key);
  const task=(async()=>{
    const result=await boundedFetch(url);
    cache.set(key,{at:Date.now(),result});
    while(cache.size>MAX_ITEMS)cache.delete(cache.keys().next().value);
    return result;
  })();
  pending.set(key,task);
  try{return await task;}finally{pending.delete(key);}
}
module.exports={imageForProduct,allowedImage,allowedBytes};
