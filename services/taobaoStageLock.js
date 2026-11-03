'use strict';
/**
 * Cross-process exclusive lock for the private Taobao JSON staging store.
 * Fail closed on an abandoned lock: operators must verify no importer is
 * running before manually removing it. Never auto-break an active lock.
 */
const fs=require('node:fs');
const path=require('node:path');
const lockPath=file=>path.resolve(file)+'.write.lock';
function acquire(file){
  if(!file||typeof file!=='string')throw Error('Staging file path required');
  const target=lockPath(file);
  fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
  let fd;
  try{
    fd=fs.openSync(target,'wx',0o600);
    fs.writeSync(fd,JSON.stringify({pid:process.pid,started_at:new Date().toISOString()})+'\n');
  }catch(error){
    if(error.code==='EEXIST')throw Error('Taobao staging busy: another importer/review is running; check '+target);
    throw error;
  }finally{
    if(fd!==undefined)fs.closeSync(fd);
  }
  let released=false;
  return ()=>{
    if(released)return;
    released=true;
    fs.unlinkSync(target);
  };
}
function withLockSync(file,fn){
  const release=acquire(file);
  try{return fn();}finally{release();}
}
async function withLock(file,fn){
  const release=acquire(file);
  try{return await fn();}finally{release();}
}
function lockState(file){
  const target=lockPath(file);
  try{
    const stat=fs.statSync(target);
    return {busy:true,since:stat.mtime.toISOString()};
  }catch(e){if(e.code==='ENOENT')return {busy:false};throw e;}
}
module.exports={lockPath,acquire,withLock,withLockSync,lockState};
