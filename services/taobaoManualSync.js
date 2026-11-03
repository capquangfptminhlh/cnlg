'use strict';
/**
 * In-process manual trigger for authorized Taobao material-search refresh.
 * No secrets or raw supplier information returned to dashboard.
 * Staging cross-process lock still handles concurrent scheduled imports.
 */
const importer=require('./sources/taobaoImporter');
const auto=require('./taobaoAutoSync');
let running=false,started_at=null,finished_at=null,last_result=null,last_error=null;
function status(){
  return {running,started_at,finished_at,last_result,last_error};
}
function start(options={}){
  const config=options.config||auto.authorizedConfig(options.env);
  if(!config)throw Error('Chưa cấu hình quyền dữ liệu, tài khoản API hoặc từ khóa đồng bộ Taobao');
  if(running)return {started:false,reason:'already_running'};
  running=true;started_at=new Date().toISOString();
  last_result=null;last_error=null;
  const job=options.syncImpl||importer.sync;
  Promise.resolve().then(()=>job(config.keywords,{pages:config.pages}))
    .then(result=>{last_result={
      fetched:result?.fetched||0,translated:result?.translated||0,
      staged:result?.staged||0,needs_translation:result?.needs_translation||0
    };})
    .catch(e=>{last_error=String(e?.message||'Đồng bộ thất bại').slice(0,180);})
    .finally(()=>{running=false;finished_at=new Date().toISOString();});
  return {started:true,started_at};
}
module.exports={start,status};
