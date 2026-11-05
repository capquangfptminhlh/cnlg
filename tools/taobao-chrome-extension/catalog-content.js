(()=>{
'use strict';
// Browser DOM observation only; does not fetch private Taobao endpoints,
// read cookies/localStorage, click purchase buttons or navigate pages.
if(globalThis.__besiCatalogContentInstalled)return;
globalThis.__besiCatalogContentInstalled=true;
const allowedHost=h=>h==='taobao.com'||h.endsWith('.taobao.com');
if(!allowedHost(location.hostname))return;
const trim=(v,max=500)=>String(v??'').replace(/\s+/g,' ').trim().slice(0,max);
const visible=e=>!!e&&typeof e.getClientRects==='function'
  &&e.getClientRects().length>0&&e.getAttribute('aria-hidden')!=='true';
function getId(raw){
  try{
    const url=new URL(raw,location.href);
    if(url.protocol!=='https:'||!allowedHost(url.hostname))return null;
    const id=url.searchParams.get('id')||url.searchParams.get('itemId');
    return /^[0-9]{6,20}$/.test(String(id||''))?{id,url:url.origin+url.pathname+'?id='+id}:null;
  }catch{return null;}
}
function priceIn(root){
  const elems=[...root.querySelectorAll('[class*="price" i],[data-price],[class*="Price"]')].slice(0,24);
  const values=[];
  for(const e of elems){
    if(!visible(e))continue;
    const str=trim(e.getAttribute('data-price')||e.textContent,100);
    const candidates=[...str.matchAll(/[¥￥]\s*([0-9]{1,7}(?:\.[0-9]{1,2})?)/g)];
    for(const match of candidates){
      const n=Number(match[1]);
      if(Number.isFinite(n)&&n>0&&n<=1e7)values.push(n);
    }
  }
  const unique=[...new Set(values)];
  return unique.length===1?unique[0]:null;
}
function stockIn(root,detail){
  // Exact stock must come from a visible, unambiguous stock label on a
  // single product detail, not "sold N" or "N people bought".
  const signals=[...root.querySelectorAll('[class*="stock" i],[class*="inventory" i],span,small')];
  let state='unknown',quantity=null,explicit=false;
  for(const e of signals.slice(0,240)){
    if(!visible(e))continue;
    const s=trim(e.textContent,90);
    if(s.length>45)continue;
    if(/(?:售罄|无货|缺货|已下架|暂时缺货)/.test(s)){state='out_of_stock';continue;}
    if(/(?:现货|有货|库存充足)/.test(s)&&state!=='out_of_stock')state='in_stock';
    const m=detail?s.match(/(?:库存|剩余)\s*[:：]?\s*(\d{1,6})\s*(?:件|个|台|套)?\s*$/):null;
    if(m){
      const n=Number(m[1]);
      if(!explicit){quantity=n;explicit=true;state=n===0?'out_of_stock':'in_stock';}
      else if(n!==quantity){quantity=null;explicit=false;state='unknown';break;}
    }
  }
  return {stock_status:state,stock_quantity:explicit?quantity:null,quantity_explicit:explicit};
}
function observation(id,url,title,root,page_type){
  if(!title||title.length<2)return null;
  const stock=stockIn(root,page_type==='product');
  return {item_id:id,product_url:url,title_zh:title,page_type,
    price_cny:priceIn(root),...stock,observed_at:new Date().toISOString()};
}
function collect(){
  const page=getId(location.href);
  const pathname=location.pathname.toLowerCase();
  const blocked=/验证码|安全验证|滑动验证|请先登录|账号异常/.test(trim(document.title,140));
  if(blocked)return {items:[],reason:'login_or_verification_required'};
  if(page&&(pathname.includes('item')||pathname.includes('detail'))){
    const h=[...document.querySelectorAll('h1,[class*="ItemTitle"],[class*="item-title"]')]
      .find(visible);
    const title=trim(h?.textContent||document.querySelector('meta[property="og:title"]')?.content,500);
    const result=observation(page.id,page.url,title,document.body,'product');
    return {items:result?[result]:[],reason:result?'product_observed':'no_visible_product'};
  }
  const found=new Map();
  const links=[...document.querySelectorAll('a[href]')].slice(0,2500);
  for(const a of links){
    if(!visible(a))continue;
    const target=getId(a.href);
    if(!target||found.has(target.id))continue;
    const card=a.closest('article,li,[data-item-id],[class*="card" i],[class*="item" i]')
      ||a.parentElement?.parentElement||a;
    const h=[...card.querySelectorAll('h2,h3,[class*="title" i]')].find(visible);
    const title=trim(h?.textContent||a.getAttribute('title')||a.querySelector('img')?.alt||a.textContent,500);
    const record=observation(target.id,target.url,title,card,'listing');
    if(record)found.set(target.id,record);
    if(found.size>=30)break;
  }
  return {items:[...found.values()],reason:found.size?'listing_observed':'no_visible_product'};
}
function send(force=false){
  try{
    const result=collect();
    if(!result.items.length)return;
    chrome.runtime.sendMessage({type:'BESI_TAOBAO_CATALOG_PAGE',items:result.items,
      force,at:new Date().toISOString()}).catch(()=>{});
  }catch{ /* site DOM changed: no retry storm or unsupported extraction */ }
}
chrome.runtime.onMessage.addListener((msg,_sender,reply)=>{
  if(msg?.type==='BESI_TAOBAO_SCAN_NOW'){
    const result=collect();
    if(result.items.length)send(true);
    reply({count:result.items.length,reason:result.reason});
  }
});
setTimeout(()=>send(false),2400);
setTimeout(()=>send(false),7000);
})();
