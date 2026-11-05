'use strict';
// Server-side, opt-in browser catalog capture session.
// The Taobao account stays inside the operator's own browser. Tokens are
// never stored in repo/data or sent to Taobao. Valid for 20 minutes max.
const crypto=require('node:crypto');
const TTL=20*60*1000;
let session=null;
const digest=token=>crypto.createHash('sha256').update(token).digest();
function issue(now=Date.now()){
  const token=crypto.randomBytes(32).toString('base64url');
  session={digest:digest(token),expires_at:now+TTL,accepted:0};
  return {token,expires_at:new Date(session.expires_at).toISOString(),
    scope:'taobao_catalog_capture',max_items_per_batch:30};
}
function verify(token,now=Date.now()){
  return !!session&&now<session.expires_at&&typeof token==='string'
    &&/^[A-Za-z0-9_-]{32,100}$/.test(token)&&
    crypto.timingSafeEqual(session.digest,digest(token));
}
function status(now=Date.now()){
  return {active:!!session&&now<session.expires_at,
    expires_at:session&&now<session.expires_at?new Date(session.expires_at).toISOString():null,
    accepted:session?.accepted||0};
}
function recorded(n){if(session&&Number.isInteger(n)&&n>=0)session.accepted+=n;}
function revoke(){session=null;return {active:false};}
module.exports={issue,verify,status,recorded,revoke,TTL};
