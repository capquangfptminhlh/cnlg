'use strict';
/**
 * Browser-captured Taobao product observations, explicitly initiated by an
 * operator using their OWN logged-in Chrome. No hidden API calls, bypasses,
 * cookies, credential storage, automatic publication or checkout.
 *
 * This is not a reliable full-Taobao product dump. Page stock signals may
 * say only available/unavailable; exact stock count is unknown unless the
 * product detail page explicitly displays a numeric inventory value.
 */
const path=require('node:path');
const importer=require('./sources/taobaoImporter');
const lock=require('./taobaoStageLock');
const FILE=path.resolve(__dirname,'../data/taobao-staging.json');
const STOCK_MAX_AGE_MS=2*3600*1000;
const MAX_BATCH=30;
const clean=(x,n)=>String(x??'').trim().slice(0,n);
function numeric(x){if(x===null||x===undefined||String(x).trim()==='')return null;
  const v=Number(x);return Number.isFinite(v)?v:null;}
function parseProductUrl(raw,id){
  try{
    const u=new URL(String(raw||''));
    if(u.protocol!=='https:'||!(u.hostname==='taobao.com'||u.hostname.endsWith('.taobao.com')))
      return null;
    // Reject ambiguous links; a card's item ID must match its Taobao URL.
    const linked=u.searchParams.get('id')||u.searchParams.get('itemId');
    if(!linked||String(linked)!==String(id))return null;
    return u.origin+u.pathname+'?id='+encodeURIComponent(id);
  }catch{return null;}
}
function normalizeObservation(item,now=Date.now()){
  if(!item||typeof item!=='object'||Array.isArray(item))return null;
  const id=clean(item.item_id,24),title=clean(item.title_zh,500);
  if(!/^[0-9]{6,20}$/.test(id)||!title)return null;
  const url=parseProductUrl(item.product_url,id);
  if(!url)return null;
  const seenAt=Date.parse(String(item.observed_at||''));
  if(!Number.isFinite(seenAt)||seenAt>now+60e3||now-seenAt>10*60e3)return null;
  const price=numeric(item.price_cny);
  const goodPrice=price!==null&&price>0&&price<=1e7?price:null;
  const pageType=item.page_type==='product'?'product':'listing';
  const stock=['in_stock','out_of_stock'].includes(item.stock_status)?item.stock_status:'unknown';
  const quantity=numeric(item.stock_quantity);
  const exactCount=pageType==='product'&&item.quantity_explicit===true
    &&quantity!==null&&Number.isInteger(quantity)&&quantity>=0&&quantity<=1e6
    &&stock===(quantity===0?'out_of_stock':'in_stock')?quantity:null;
  return {id,title,url,observed_at:new Date(seenAt).toISOString(),page_type:pageType,
    price_cny:goodPrice,stock_status:stock,
    stock_quantity:exactCount,quantity_explicit:exactCount!==null};
}
function availability(row,now=Date.now()){
  const t=Date.parse(String(row?.stock_checked_at||''));
  if(!Number.isFinite(t)||t>now+60e3||now-t>STOCK_MAX_AGE_MS)
    return {status:'unknown',quantity:null,verified:false};
  const state=row?.stock_status;
  if(!['in_stock','out_of_stock'].includes(state))
    return {status:'unknown',quantity:null,verified:false};
  return {status:state,quantity:Number.isInteger(row.stock_quantity)?row.stock_quantity:null,
    verified:true,checked_at:new Date(t).toISOString()};
}
async function ingest(observations,options={}){
  if(options.rightsConfirmed!==true)
    throw Error('Operator must explicitly confirm permission to capture product data');
  if(!Array.isArray(observations)||!observations.length||observations.length>MAX_BATCH)
    throw Error('Taobao capture batch must contain 1-30 items');
  const file=options.file||FILE,now=options.now||Date.now();
  // Validate all records before touching the stage, rather than partially
  // trusting malformed/forged observations.
  const items=observations.map(x=>normalizeObservation(x,now));
  if(items.some(x=>!x))throw Error('Taobao page observation invalid or not from verified Taobao product URLs');
  return lock.withLock(file,async()=>{
    const stage=importer.read(file);
    if(stage.version!==1||!Array.isArray(stage.items))
      throw Error('Invalid Taobao staging store');
    const map=new Map(stage.items.map(x=>[String(x.id),x]));
    const seen=new Set();
    let fetched=0,translated=0;
    for(const item of items){
      if(seen.has(item.id))continue;
      const old=map.get(item.id);
      // Only preserve an unobserved price if same original title; never
      // promote a stale price by stamping it with the new scan timestamp.
      const price=item.price_cny??(old?.title_zh===item.title?old.price_cny_reference:null);
      const raw={
        item_id:item.id,title:item.title,zk_final_price:price,
        item_url:item.url
      };
      const counts=await importer.mergeBatch([raw],'operator-browser',map,seen,options);
      fetched+=counts.fetched;translated+=counts.translated;
      const row=map.get(item.id);
      if(!row)continue;
      row.capture_seen_at=item.observed_at;
      if(item.price_cny===null&&old?.title_zh===item.title)
        row.updated_at=old.updated_at; // prevent false price freshness
      if(item.stock_status!=='unknown'){
        row.stock_status=item.stock_status;
        row.stock_checked_at=item.observed_at;
        row.stock_quantity=item.quantity_explicit?item.stock_quantity:null;
        row.stock_verified=true;
      }else if(old?.stock_checked_at&&old.title_zh===item.title){
        // Do not manufacture a change in stock state from a listing page
        // that has no stock indicator; old observation expires after 2h.
        row.stock_status=old.stock_status;
        row.stock_checked_at=old.stock_checked_at;
        row.stock_quantity=old.stock_quantity??null;
        row.stock_verified=old.stock_verified===true;
      }else{
        row.stock_status='unknown';row.stock_quantity=null;row.stock_verified=false;
      }
      row.catalog_observation_source='operator_browser';
      row.purchasable=false;
    }
    importer.save(file,[...map.values()]);
    return {fetched,translated,staged:map.size,
      inventory_observed:items.filter(x=>x.stock_status!=='unknown').length,
      exact_stock_counts:items.filter(x=>x.quantity_explicit).length,
      checkout_enabled:false};
  });
}
module.exports={FILE,MAX_BATCH,STOCK_MAX_AGE_MS,
  parseProductUrl,normalizeObservation,availability,ingest};
