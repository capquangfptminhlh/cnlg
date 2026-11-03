#!/usr/bin/env node
'use strict';
/**
 * BESI Taobao operator terminal; intentionally has NO public HTTP routes.
 * Never print supplier IDs, API secrets or private feed payloads.
 */
require('dotenv').config();
const fs=require('node:fs'),path=require('node:path');
const importer=require('../services/sources/taobaoImporter');
const price=require('../services/taobaoPriceShipping');
const lock=require('../services/taobaoStageLock');
const preview=require('../services/taobaoPublic');
function status(opt={}){
  const file=opt.file||path.resolve(__dirname,'../data/taobao-staging.json');
  const stage=importer.read(file);
  const rate=opt.rate===undefined?price.getRate():opt.rate;
  const tariff=opt.tariff===undefined?price.getTariff():opt.tariff;
  const catalog=preview.getPublicCatalog(stage.items,{}, {rate,tariff});
  const approved=stage.items.filter(x=>preview.approved(x)).length;
  const counts={
    staged:stage.items.length,
    translated:stage.items.filter(x=>x.translation_status==='translated').length,
    approved_previews:approved,
    active_sale_products:0,
    visible_previews:catalog.total,
    price_quotes_ready:0,
    shipping_quotes_ready:0
  };
  for(const row of stage.items){
    if(!preview.approved(row))continue;
    const vars=Array.isArray(row.sku_variants)&&row.sku_variants.length?row.sku_variants:[row];
    for(const v of vars){
      const q=price.quote(v===row?v:{...v},{region:'hcm',rate,tariff});
      if(q.status==='partial'||q.status==='estimate')counts.price_quotes_ready++;
      if(q.status==='estimate')counts.shipping_quotes_ready++;
    }
  }
  const e=opt.env||process.env;
  return {
    source:'taobao',region:'hcm',
    data_permission:e.TAOBAO_DATA_PERMISSION==='1',
    api_credentials_configured:!!(e.TAOBAO_APP_KEY&&e.TAOBAO_APP_SECRET&&e.TAOBAO_ADZONE_ID),
    auto_sync_enabled:e.TAOBAO_AUTO_SYNC==='1',
    translation_model_configured:!!e.TAOBAO_LOCAL_MODEL,
    fx:rate?{ready:true,as_of:rate.as_of,source:rate.source,rate_vnd_per_cny:rate.rate}:{ready:false},
    freight_tariff:tariff?{ready:true,updated_at:tariff.updated_at}:{ready:false},
    staging_lock:lock.lockState(file),counts
  };
}
function installTariff(jsonPath,opt={}){
  if(opt.confirmed!==true)throw Error('Phải xác nhận cước vận chuyển bằng --confirm-carrier');
  const input=path.resolve(jsonPath||'');
  if(!jsonPath||!fs.statSync(input).isFile())throw Error('Không tìm thấy file biểu phí');
  if(fs.statSync(input).size>32768)throw Error('File biểu phí quá lớn');
  const raw=JSON.parse(fs.readFileSync(input,'utf8'));
  const config=price.validateTariff(raw);
  if(!config||/REPLACE|DEMO|TEST|EXAMPLE/i.test(config.provider))
    throw Error('Biểu phí chưa hợp lệ, hết hạn hoặc còn dữ liệu minh hoạ');
  const file=opt.file||price.SHIPPING_PATH;
  price.saveJson(file,config);
  return {ready:true,route:config.route,updated_at:config.updated_at};
}
async function main(){
  const [command,file,...flags]=process.argv.slice(2);
  if(command==='status'){
    console.log(JSON.stringify(status(),null,2));
  }else if(command==='tariff:set'){
    console.log(JSON.stringify(installTariff(file,{confirmed:flags.includes('--confirm-carrier')}),null,2));
  }else if(command==='fx:refresh'){
    const fx=await price.refreshRate();
    console.log(JSON.stringify({rate_vnd_per_cny:fx.rate,as_of:fx.as_of,source:fx.source},null,2));
  }else{
    console.error('Commands:');
    console.error(' npm run taobao:ops -- status');
    console.error(' npm run taobao:ops -- tariff:set .\\private\\carrier.json --confirm-carrier');
    console.error(' npm run taobao:ops -- fx:refresh');
    process.exitCode=2;
  }
}
if(require.main===module)main().catch(e=>{console.error('Taobao operator:',e.message);process.exitCode=1;});
module.exports={status,installTariff};
