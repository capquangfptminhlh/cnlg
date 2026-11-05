'use strict';
// Runs only in the user's own Chrome extension, never on BESI server.
// A temporary session intentionally dies on browser restart. Only bounded
// Taobao product observations are posted, not cookies/HTML/cart/customer data.
const API='https://besi.com.vn/api/taobao/browser-products';
const KEY='besi_taobao_catalog_capture';
const INTERVAL=90*1000;
const recent=new Map();
const hostAllowed=value=>{
  try{
    const u=new URL(value);
    return u.protocol==='https:'&&(u.hostname==='taobao.com'||u.hostname.endsWith('.taobao.com'));
  }catch{return false;}
};
async function getState(){
  const stored=await chrome.storage.session.get(KEY);
  const state=stored[KEY];
  if(!state||state.enabled!==true||Date.now()>=state.expires_at)return null;
  return state;
}
async function stop(){
  await chrome.storage.session.remove(KEY);
  recent.clear();
  return {enabled:false};
}
async function capture(items,sender,force=false){
  const state=await getState();
  if(!state)return {sent:false,reason:'not_enabled_or_expired'};
  if(!sender?.tab?.id||!hostAllowed(sender.tab.url))
    return {sent:false,reason:'not_a_taobao_tab'};
  if(!Array.isArray(items)||!items.length||items.length>30)
    return {sent:false,reason:'no_valid_products'};
  const fingerprint=String(sender.tab.id)+':'+sender.tab.url+':'+items
    .map(x=>String(x.item_id)+':'+String(x.price_cny)+':'+String(x.stock_status)).join('|');
  const last=recent.get(fingerprint)||0;
  if(!force&&Date.now()-last<INTERVAL)return {sent:false,reason:'already_seen'};
  // Do not forward account cookies, Taobao bearer tokens, DOM HTML or full
  // customer address even when the source site includes those fields.
  const payload={rightsConfirmed:true,items:items.map(x=>({
    item_id:x.item_id,title_zh:x.title_zh,product_url:x.product_url,
    price_cny:x.price_cny,stock_status:x.stock_status,
    stock_quantity:x.stock_quantity,quantity_explicit:x.quantity_explicit,
    observed_at:x.observed_at,page_type:x.page_type
  }))};
  const res=await fetch(API,{method:'POST',credentials:'omit',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+state.token},
    body:JSON.stringify(payload)});
  const result=await res.json().catch(()=>({}));
  if(!res.ok||result.success!==true){
    if(res.status===401||res.status===403)await stop();
    return {sent:false,reason:result.error||'Capture rejected by BESI',status:res.status};
  }
  recent.set(fingerprint,Date.now());
  if(recent.size>100)recent.clear();
  const next={...state,sent:(state.sent||0)+(result.data?.fetched||0),
    last_success:new Date().toISOString(),last_error:null};
  await chrome.storage.session.set({[KEY]:next});
  return {sent:true,accepted:result.data?.fetched||0,
    translated:result.data?.translated||0,inventory_observed:result.data?.inventory_observed||0};
}
async function scanCurrent(){
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab||!hostAllowed(tab.url))throw Error('Mở một trang sản phẩm/tìm kiếm Taobao trước');
  let result;
  try{result=await chrome.tabs.sendMessage(tab.id,{type:'BESI_TAOBAO_SCAN_NOW'});}
  catch{
    // A tab loaded before installation has no content script yet.
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['catalog-content.js']});
    result=await chrome.tabs.sendMessage(tab.id,{type:'BESI_TAOBAO_SCAN_NOW'});
  }
  return result;
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  (async()=>{
    if(message?.type==='BESI_CAPTURE_STATUS'){
      const state=await getState();
      return {enabled:!!state,sent:state?.sent||0,expires_at:state?.expires_at||null,
        last_success:state?.last_success||null,last_error:state?.last_error||null};
    }
    if(message?.type==='BESI_CAPTURE_START'){
      const token=String(message.token||'').trim();
      if(!/^[A-Za-z0-9_-]{32,100}$/.test(token)||message.rightsConfirmed!==true)
        throw Error('Cần mã kết nối hợp lệ và xác nhận quyền thu thập dữ liệu');
      await chrome.storage.session.set({[KEY]:{
        enabled:true,token,expires_at:Date.now()+20*60*1000,sent:0}});
      recent.clear();
      return {enabled:true};
    }
    if(message?.type==='BESI_CAPTURE_STOP')return stop();
    if(message?.type==='BESI_CAPTURE_SCAN_NOW')return scanCurrent();
    if(message?.type==='BESI_TAOBAO_CATALOG_PAGE')
      return capture(message.items,sender,message.force===true);
    return {error:'unknown_message'};
  })().then(reply,error=>reply({error:String(error?.message||error).slice(0,160)}));
  return true;
});
