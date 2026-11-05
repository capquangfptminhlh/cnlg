'use strict';
/**
 * Human-imported, short-lived Taobao checkout/Cainiao international freight
 * reference. There is NO documented public Taobao affiliate-search endpoint
 * that returns buyer-specific VN checkout logistics quotes; never pretend a
 * search result is a checkout quote. Does not place orders or scrape login.
 */
const fs=require('node:fs');
const path=require('node:path');
const lock=require('./taobaoStageLock');
const price=require('./taobaoPriceShipping');
const FILE=path.resolve(__dirname,'../data/taobao-official-quotes.json');
const REGIONS=['hcm','hn','other'];
const MAX_QUOTE_AGE=24*3600*1000;
const key=(id,sku,region)=>id+':'+sku+':'+region;
const number=x=>x!==null&&x!==undefined&&String(x).trim()!==''&&
  Number.isFinite(Number(x))?Number(x):NaN;
function validate(input,now=Date.now()){
  if(!input||typeof input!=='object')throw Error('Thiếu dữ liệu báo cước Taobao');
  const id=String(input.item_id||'').trim();
  const sku=String(input.sku||'').trim();
  const region=String(input.region||'').trim();
  const method=String(input.method||'').trim();
  const state=String(input.quote_state||'').trim();
  if(!/^[0-9]{6,20}$/.test(id)||sku.length>80||
    (sku&&!/^[A-Za-z0-9_.:-]{1,80}$/.test(sku)))
    throw Error('Mã sản phẩm hoặc SKU không hợp lệ');
  if(!REGIONS.includes(region)||!['direct','consolidated'].includes(method)||
    !['quoted','pending_consolidation','unavailable'].includes(state))
    throw Error('Khu vực, cách vận chuyển hoặc trạng thái Taobao không hợp lệ');
  if(input.source!=='taobao_checkout'||input.confirmedFromCheckout!==true
    ||input.destination_country!=='VN'||input.quantity!==1)
    throw Error('Cần xác nhận đúng cước tại checkout Taobao, 1 sản phẩm và địa chỉ Việt Nam');
  const checked=Date.parse(String(input.checked_at||''));
  if(!Number.isFinite(checked)||checked>now+60000||now-checked>MAX_QUOTE_AGE)
    throw Error('Báo cước Taobao phải được kiểm tra trong vòng 24 giờ');
  const amount=number(input.shipping_amount);
  const currency=String(input.currency||'');
  if(state==='quoted'){
    if(!['CNY','VND'].includes(currency)||!Number.isFinite(amount)||amount<0||amount>1e8)
      throw Error('Số tiền hoặc loại tiền vận chuyển Taobao không hợp lệ');
    if(input.covers!=='door_to_door')
      throw Error('Chưa thể cộng cước nếu không biết khoản nào đã bao gồm');
    if(method==='consolidated'&&input.weighed_at_warehouse!==true)
      throw Error('Gom hàng chỉ báo cước sau khi đã cân đo tại kho');
    if(amount===0&&input.free_shipping_confirmed!==true)
      throw Error('Cước bằng 0 chỉ hợp lệ khi Taobao xác nhận miễn phí vận chuyển');
  }else if(input.shipping_amount!==null&&input.shipping_amount!==undefined){
    throw Error('Trạng thái chưa báo giá không được có số tiền vận chuyển');
  }
  return {item_id:id,sku,region,method,quote_state:state,source:'taobao_checkout',
    destination_country:'VN',quantity:1,
    shipping_amount:state==='quoted'?amount:null,
    currency:state==='quoted'?currency:null,
    covers:state==='quoted'?'door_to_door':null,
    checked_at:new Date(checked).toISOString(),
    // These are indicative quotes for a sample address in the chosen region;
    // they must never be represented as a checkout promise to all customers.
    scope:'regional_reference',
    expires_at:new Date(checked+MAX_QUOTE_AGE).toISOString(),
    verified_operator:true};
}
function read(file=FILE){
  try{
    const data=JSON.parse(fs.readFileSync(file,'utf8'));
    if(data.version!==1||!Array.isArray(data.quotes))throw Error('Invalid Taobao quote store');
    return data.quotes;
  }catch(e){if(e.code==='ENOENT')return [];throw e;}
}
function save(input,options={}){
  const file=options.file||FILE;
  const entry=validate(input,options.now||Date.now());
  return lock.withLockSync(file,()=>{
    const existing=read(file).filter(row=>
      key(row.item_id,row.sku,row.region)!==key(entry.item_id,entry.sku,entry.region));
    existing.push(entry);
    if(existing.length>5000)throw Error('Đã vượt giới hạn kho báo cước Taobao');
    price.saveJson(file,{version:1,quotes:existing});
    return {saved:true,item_id:entry.item_id,sku:entry.sku,region:entry.region,
      state:entry.quote_state,expires_at:entry.expires_at};
  });
}
function lookup(id,sku,region,options={}){
  const now=options.now||Date.now();
  const quotes=options.quotes||read(options.file||FILE);
  const row=quotes.find(q=>q.item_id===String(id)&&q.sku===String(sku||'')&&q.region===region);
  if(!row||row.verified_operator!==true||row.source!=='taobao_checkout'||
    row.destination_country!=='VN'||row.scope!=='regional_reference'||
    row.quantity!==1)return null;
  const checked=Date.parse(row.checked_at),expires=Date.parse(row.expires_at);
  if(!Number.isFinite(checked)||!Number.isFinite(expires)||checked>now+60000||
    now>expires||expires-checked>MAX_QUOTE_AGE)return null;
  return row;
}
function apply(row,official,options={}){
  // Product price and FX must still pass their independent freshness gates.
  const fallback=price.quote(row,{...options,tariff:null});
  if(!official||fallback.status==='unavailable')return fallback;
  const simple={...fallback,shipping_source:'taobao_checkout_reference',
    shipping_method:official.method,quote_checked_at:official.checked_at,
    quote_expires_at:official.expires_at,
    shipping_provider:'Taobao/Cainiao (cước tham khảo)'};
  if(official.quote_state==='unavailable'){
    return {...simple,status:'partial',reason:'taobao_shipping_unavailable'};
  }
  if(official.quote_state==='pending_consolidation'){
    return {...simple,status:'partial',reason:'taobao_consolidation_pending'};
  }
  const rate=price.currentRate(options.rate,options.now||Date.now());
  if(!rate)return {...simple,status:'unavailable',reason:'fx_missing_or_stale'};
  const amount=official.currency==='VND'?Math.round(official.shipping_amount):
    Math.round(official.shipping_amount*rate.rate);
  if(!Number.isFinite(amount)||amount<0)return {...simple,status:'partial',reason:'invalid_official_quote'};
  return {...simple,status:'estimate',reason:null,shipping_vnd:amount,
    total_vnd:simple.item_vnd+amount,official_shipping_vnd:amount,
    excludes_duty_tax:true,can_order:false,is_estimate:true};
}
module.exports={FILE,validate,read,save,lookup,apply};
