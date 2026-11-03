'use strict';
/**
 * Opt-in periodic AUTHORIZED Taobao search catalog refresh.
 * Does not scrape a website or authorize selling. Reuses staging importer.
 * Run only one BESI origin worker; local JSON staging has no multi-node locks.
 */
const importer=require('./sources/taobaoImporter');
function authorizedConfig(env=process.env){
  if(env.TAOBAO_DATA_PERMISSION!=='1'||!env.TAOBAO_APP_KEY||!env.TAOBAO_APP_SECRET
    ||!/^[0-9]+$/.test(String(env.TAOBAO_ADZONE_ID||'')))return null;
  const keywords=String(env.TAOBAO_AUTO_SYNC_KEYWORDS||'')
    .split(';').map(x=>x.trim()).filter(Boolean);
  if(!keywords.length||keywords.length>30)return null;
  const hours=Math.min(72,Math.max(4,Number(env.TAOBAO_SYNC_INTERVAL_HOURS)||12));
  const pages=Math.min(50,Math.max(1,Math.trunc(Number(env.TAOBAO_PAGES_PER_KEYWORD)||2)));
  return {keywords,hours,pages};
}
function config(env=process.env){
  return env.TAOBAO_AUTO_SYNC==='1'?authorizedConfig(env):null;
}
function start(options={}){
  const settings=options.settings||config(options.env);
  if(!settings)return null;
  const sync=options.syncImpl||importer.sync;
  let busy=false,stopped=false;
  const runOnce=async()=>{
    if(busy||stopped)return null;
    busy=true;
    try{
      const result=await sync(settings.keywords,{pages:settings.pages});
      if(options.onResult)options.onResult(result);
      return result;
    }catch(error){
      if(options.onError)options.onError(error);
      else console.warn('[Taobao staging auto-sync]',error.message);
      return null;
    }finally{busy=false;}
  };
  if(options.runOnStart!==false)void runOnce();
  const timer=(options.setTimer||setInterval)(runOnce,settings.hours*3600000);
  timer?.unref?.();
  return {runOnce,stop:()=>{stopped=true;(options.clearTimer||clearInterval)(timer);}};
}
module.exports={config,authorizedConfig,start};
