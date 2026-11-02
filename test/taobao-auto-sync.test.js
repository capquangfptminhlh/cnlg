'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const auto=require('../services/taobaoAutoSync');
const env={TAOBAO_AUTO_SYNC:'1',TAOBAO_DATA_PERMISSION:'1',
  TAOBAO_APP_KEY:'demo',TAOBAO_APP_SECRET:'secret',TAOBAO_ADZONE_ID:'9999',
  TAOBAO_AUTO_SYNC_KEYWORDS:'手机线;手机壳',
  TAOBAO_SYNC_INTERVAL_HOURS:'4',TAOBAO_PAGES_PER_KEYWORD:'3'};
test('Taobao price auto-sync disabled unless permission, credentials, keywords and opt-in exist',()=>{
  assert.equal(auto.config({...env,TAOBAO_AUTO_SYNC:'0'}),null);
  assert.equal(auto.config({...env,TAOBAO_DATA_PERMISSION:'0'}),null);
  assert.equal(auto.config({...env,TAOBAO_APP_KEY:''}),null);
  assert.equal(auto.config({...env,TAOBAO_ADZONE_ID:''}),null);
  assert.equal(auto.config({...env,TAOBAO_AUTO_SYNC_KEYWORDS:''}),null);
  assert.deepEqual(auto.config(env),{keywords:['手机线','手机壳'],hours:4,pages:3});
});
test('Scheduled importer cannot overlap itself and can be stopped',async()=>{
  let resolveFirst,call=0,clear=false,interval=0;
  const syncImpl=async(keys,opt)=>{call++;assert.deepEqual(keys,['手机线','手机壳']);
    assert.equal(opt.pages,3);await new Promise(r=>{resolveFirst=r});return {fetched:1};};
  const runner=auto.start({settings:auto.config(env),syncImpl,runOnStart:false,
    setTimer:(fn,ms)=>{interval=ms;return {fn};},
    clearTimer:()=>{clear=true;}});
  assert.equal(interval,4*3600000);
  const first=runner.runOnce();
  assert.equal(await runner.runOnce(),null);
  assert.equal(call,1);
  resolveFirst();assert.deepEqual(await first,{fetched:1});
  runner.stop();assert.equal(clear,true);
  assert.equal(await runner.runOnce(),null);
  assert.equal(call,1);
});
