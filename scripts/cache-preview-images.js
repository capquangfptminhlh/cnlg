'use strict';
/* Public storefront preview: cache actual, publicly served DropBuy thumbnails
 * into the static Pages artifact. Never reads cookies, wholesale prices or PII.
 * Only fetches exact trusted CDN host; bounded concurrency, bytes and time. */
const fs=require('node:fs');
const path=require('node:path');
const dist=path.resolve(__dirname,'../.pages-preview-dist');
const fileName=path.join(dist,'products-public.json');
const data=JSON.parse(fs.readFileSync(fileName,'utf8'));
const max=Number(process.env.CATALOG_IMAGE_LIMIT)||60;
const concurrency=6,timeoutMs=5000,maxBytes=500000;
let cursor=0,downloaded=0,failed=0,bytes=0;
const images=path.join(dist,'images','catalog');
fs.mkdirSync(images,{recursive:true});
function safe(value){
  try{
    const u=new URL(value);
    return u.protocol==='https:'&&u.hostname==='r6i.pen.dropbuy.vn'&&!u.username&&!u.password?u:null;
  }catch{return null;}
}
const chosen=data.products.slice(0,Math.min(max,data.products.length));
async function run(p){
  const u=safe(p.image)||safe(p.image_hd);
  if(!u){failed++;return;}
  try{
    const res=await fetch(u.href,{signal:AbortSignal.timeout(timeoutMs),headers:{'user-agent':'Mozilla/5.0 (compatible; HoangMinhStorePreview/1.0)','accept':'image/avif,image/webp,image/png,image/jpeg,*/*'}});
    if(!res.ok)throw Error('HTTP '+res.status);
    const mime=(res.headers.get('content-type')||'').split(';')[0].toLowerCase();
    const ext=({'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/avif':'.avif'})[mime];
    if(!ext)throw Error('not a supported image: '+mime);
    const buffer=Buffer.from(await res.arrayBuffer());
    if(buffer.length<180||buffer.length>maxBytes)throw Error('image size not allowed '+buffer.length);
    const dest=String(p.id)+ext;
    fs.writeFileSync(path.join(images,dest),buffer);
    p.image='./images/catalog/'+dest;
    downloaded++;bytes+=buffer.length;
  }catch(err){failed++;}
}
(async()=>{
 await Promise.all(Array.from({length:concurrency},async()=>{
  while(cursor<chosen.length){const entry=chosen[cursor++];await run(entry);}
 }));
 fs.writeFileSync(fileName,JSON.stringify(data));
 const summary={attempted:chosen.length,downloaded,failed,kb:Math.round(bytes/1024),originalCount:data.products.length};
 console.log('Catalog public thumbnail cache:',JSON.stringify(summary));
 // Best-effort enhancement, never break full inventory if CDN fails.
})().catch(error=>{console.error(error);process.exitCode=1;});
