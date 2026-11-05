'use strict';
/**
 * One-time, five-minute bridge pairing for an authenticated BESI operator
 * and their locally logged-in Taobao browser. NOT a Taobao login/token.
 * No account cookies, passwords or full browser HTML are sent to BESI.
 */
const crypto=require('node:crypto');
const TTL_MS=5*60*1000;
let pending=null;
function issue(now=Date.now()){
  const token=crypto.randomBytes(32).toString('base64url');
  pending={digest:crypto.createHash('sha256').update(token).digest(),
    expires_at:now+TTL_MS};
  return {token,expires_at:new Date(pending.expires_at).toISOString(),
    purpose:'single_verified_taobao_checkout_shipping_quote'};
}
function status(now=Date.now()){
  return {pending:!!pending&&now<=pending.expires_at,
    expires_at:pending&&now<=pending.expires_at?new Date(pending.expires_at).toISOString():null};
}
function verify(token,now=Date.now()){
  if(!pending||now>pending.expires_at||typeof token!=='string'
    ||token.length<32||token.length>100)return false;
  const digest=crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(digest,pending.digest);
}
function consume(token,now=Date.now()){
  if(!verify(token,now))return false;
  pending=null;
  return true;
}
function clear(){pending=null;}
module.exports={issue,status,verify,consume,clear,TTL_MS};
