'use strict';
/**
 * Taobao indicative pricing ONLY. Never authorizes payment or checkout.
 * Exchange rate comes from a daily third-party reference feed, and shipping
 * tariffs must be entered from a real freight partner agreement.
 * Missing/stale rates or missing dimensions/fee data fail closed.
 */
const fs=require('node:fs');
const path=require('node:path');
const FX_PATH=path.resolve(__dirname,'../data/taobao-fx.json');
const SHIPPING_PATH=path.resolve(__dirname,'../data/taobao-shipping.json');
const RATE_URL='https://open.er-api.com/v6/latest/CNY';
const RATE_SOURCE='ExchangeRate-API';
const MAX_AGE_MS=48*3600*1000;
const MAX_PRODUCT_PRICE_AGE_MS=7*24*3600*1000;
const validNonnegative=x=>x!==null&&x!==undefined&&String(x).trim()!==''&&Number.isFinite(Number(x))&&Number(x)>=0;
const positive=x=>validNonnegative(x)&&Number(x)>0;
const money=x=>Math.round(Number(x));
const timestamp=x=>Number.isFinite(Date.parse(x))?Date.parse(x):NaN;

function readJson(file) {
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
}
function saveJson(file,data) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=file+'.'+process.pid+'.'+Date.now()+'.tmp';
  try{
    fs.writeFileSync(tmp,JSON.stringify(data,null,2),{flag:'wx',mode:0o600});
    fs.renameSync(tmp,file);
    fs.chmodSync(file,0o600);
  }finally{try{fs.unlinkSync(tmp);}catch{}}
}
function parseRate(payload,now=Date.now()) {
  if(payload?.result!=='success'||payload.base_code!=='CNY')
    throw Error('Invalid CNY exchange-rate provider response');
  const rate=payload.rates?.VND;
  const asOf=Number(payload.time_last_update_unix)*1000;
  if(!positive(rate)||Number(rate)<1000||Number(rate)>10000
     ||!Number.isFinite(asOf)||asOf<946684800000||asOf>now+3600000)
    throw Error('Invalid CNY/VND reference rate or timestamp');
  if(now-asOf>MAX_AGE_MS)throw Error('FX provider data is stale');
  return {currency_from:'CNY',currency_to:'VND',rate:Number(rate),
    as_of:new Date(asOf).toISOString(),source:RATE_SOURCE,
    fetched_at:new Date(now).toISOString()};
}
function currentRate(data,now=Date.now()){
  if(!data||data.source!==RATE_SOURCE||data.currency_from!=='CNY'||data.currency_to!=='VND'
    ||!positive(data.rate)||data.rate<1000||data.rate>10000)return null;
  const t=timestamp(data.as_of);
  if(!Number.isFinite(t)||t>now+3600000||now-t>MAX_AGE_MS)return null;
  return data;
}
function getRate(file=FX_PATH,now=Date.now()){
  return currentRate(readJson(file),now);
}
async function refreshRate(options={}){
  const now=options.now||Date.now();
  const file=options.file||FX_PATH;
  const request=options.fetchImpl||fetch;
  const r=await request(RATE_URL,{
    method:'GET',headers:{accept:'application/json'},
    signal:AbortSignal.timeout(12000)
  });
  if(!r.ok)throw Error('CNY/VND rate provider HTTP '+r.status);
  const next=parseRate(await r.json(),now);
  saveJson(file,next);
  return next;
}
function startRateUpdater(options={}){
  const file=options.file||FX_PATH;
  const refresh=options.refreshImpl||refreshRate;
  const job=async()=>{
    try{
      const fx=getRate(file);
      // Provider is daily and rate-limited. Do not refetch every public request.
      const recent=fx&&timestamp(fx.fetched_at)>Date.now()-23*3600*1000;
      if(!recent)await refresh({file});
    }catch(e){console.warn('[Taobao FX] Reference rate not available:',e.message);}
  };
  void job();
  const timer=setInterval(job,12*3600*1000);
  timer.unref?.();
  return timer;
}
function validateTariff(config){
  if(!config||config.currency!=='VND'||config.route!=='CN-VN'
    ||!positive(config.international_vnd_per_kg)
    ||!validNonnegative(config.handling_vnd)
    ||!positive(config.billing_step_kg)
    ||!positive(config.volumetric_divisor)
    ||!['hcm','hn','other'].every(k=>validNonnegative(config.domestic_vnd?.[k]))
    ||!String(config.provider||'').trim()
    ||!Number.isFinite(timestamp(config.updated_at)))
    return null;
  // Treat freight tariffs older than 90 days as unverified.
  if(Date.now()-timestamp(config.updated_at)>90*86400e3||timestamp(config.updated_at)>Date.now()+3600000)
    return null;
  if(config.billing_step_kg>5||config.international_vnd_per_kg>10000000||config.volumetric_divisor<1000
     ||config.volumetric_divisor>20000)return null;
  return config;
}
function getTariff(file=SHIPPING_PATH){
  return validateTariff(readJson(file));
}
const regionName={hcm:'TP. Hồ Chí Minh',hn:'Hà Nội',other:'Tỉnh/thành khác'};
function quote(row,options={}){
  const region=String(options.region||'hcm').toLowerCase();
  if(!Object.hasOwn(regionName,region))return {status:'unavailable',reason:'invalid_region'};
  const rate=currentRate(options.rate||null,options.now||Date.now());
  const cny=Number(row?.price_cny_reference);
  if(!positive(row?.price_cny_reference))return {status:'unavailable',reason:'missing_product_price'};
  // An old Taobao listing price is not a current quote, even if FX is fresh.
  const checkedAt=timestamp(row?.updated_at);
  const now=options.now||Date.now();
  if(!Number.isFinite(checkedAt)||checkedAt>now+3600000
    ||now-checkedAt>MAX_PRODUCT_PRICE_AGE_MS)
    return {status:'unavailable',reason:'product_price_stale'};
  if(!rate)return {status:'unavailable',reason:'fx_missing_or_stale'};
  const item_vnd=money(cny*rate.rate);
  const base={status:'partial',item_vnd,region,region_name:regionName[region],
    rate_vnd_per_cny:rate.rate,rate_as_of:rate.as_of,rate_source:RATE_SOURCE,
    shipping_vnd:null,total_vnd:null,is_estimate:true,can_order:false};
  const tariff=validateTariff(options.tariff);
  if(!tariff)return {...base,reason:'shipping_tariff_missing'};
  // China domestic shipping = from seller/feed. Zero only if supplier confirms free.
  if(!validNonnegative(row?.china_domestic_shipping_cny))
    return {...base,reason:'china_domestic_shipping_missing'};
  if(!positive(row?.shipping_weight_kg))
    return {...base,reason:'shipping_weight_missing'};
  const weight=Number(row.shipping_weight_kg);
  if(weight>200)return {...base,reason:'shipping_weight_invalid'};
  const dims=row.dimensions_cm||{};
  const hasDims=['length','width','height'].every(k=>positive(dims[k]));
  // Without parcel dimensions, volumetric weight is unknown and a numeric
  // freight total may materially underquote bulky goods. Fail closed.
  if(!hasDims)return {...base,reason:'dimensions_unverified'};
  const volumetric=hasDims?Number(dims.length)*Number(dims.width)*Number(dims.height)/
    Number(tariff.volumetric_divisor):0;
  const rawWeight=Math.max(weight,volumetric);
  const step=Number(tariff.billing_step_kg);
  const billable=Math.ceil((rawWeight-1e-10)/step)*step;
  const domesticChina=money(Number(row.china_domestic_shipping_cny)*rate.rate);
  const intl=money(billable*Number(tariff.international_vnd_per_kg));
  const lastMile=money(tariff.domestic_vnd[region]);
  const handling=money(tariff.handling_vnd);
  const shipping=domesticChina+intl+lastMile+handling;
  return {...base,status:'estimate',reason:null,
    china_domestic_shipping_vnd:domesticChina,
    international_shipping_vnd:intl,domestic_vn_shipping_vnd:lastMile,
    handling_vnd:handling,shipping_vnd:shipping,total_vnd:item_vnd+shipping,
    billable_weight_kg:Number(billable.toFixed(2)),shipping_provider:'Đơn vị vận chuyển',
    shipping_tariff_as_of:tariff.updated_at,
    excludes_duty_tax:true};
}
module.exports={FX_PATH,SHIPPING_PATH,RATE_URL,parseRate,currentRate,getRate,refreshRate,
  startRateUpdater,validateTariff,getTariff,quote,saveJson,regionName};
