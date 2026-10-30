'use strict';
/**
 * Check the actual BESI origin via public HTTPS. NO auth/secrets,
 * NO purchases, NO admin endpoints and NO upstream supplier data.
 * Usage: node scripts/check-besi-production.js https://besi.com.vn <40-char-main-sha>
 */
const assert=require('node:assert/strict');
async function main(){
  const root=process.argv[2]||'https://besi.com.vn';
  const expected=process.argv[3]||'';
  if(root!=='https://besi.com.vn')throw Error('Only the approved BESI production hostname can be checked');
  if(expected&&!/^[a-f0-9]{12,40}$/i.test(expected))throw Error('Invalid expected release SHA');
  const fetchText=async path=>{
    const ac=new AbortController();
    const timer=setTimeout(()=>ac.abort(),15000);
    try{
      const response=await fetch(root+path,{headers:{'Accept':'application/json, text/html;q=0.9'},
        redirect:'error',signal:ac.signal});
      if(!response.ok)throw Error(path+': HTTP '+response.status);
      return await response.text();
    }finally{clearTimeout(timer);}
  };
  const json=async path=>{
    const text=await fetchText(path);
    try{return JSON.parse(text);}catch{throw Error(path+': not JSON');}
  };
  const health=await json('/healthz');
  assert.equal(health.ok,true,'Origin health is not ready');
  assert.ok(Number(health.products)>0,'Live catalog appears empty');
  assert.match(String(health.release||''),/^[a-f0-9]{12}$/i,'Origin is missing deploy fingerprint');
  if(expected)assert.equal(health.release,expected.slice(0,12),
    'Live process is running a different commit than GitHub main');
  console.log('PASS health release='+health.release+' products='+health.products);
  const choices=await json('/api/products/category-facets?category=case');
  assert.equal(choices.success,true,'Category facet options are unavailable');
  assert.equal(choices.category,'case');
  assert.ok(Array.isArray(choices.models),'Case model choices missing');
  console.log('PASS category facet options (case models='+choices.models.length+')');
  const search=await json('/api/products/category-specs?category=case&limit=1');
  assert.equal(search.success,true,'Category indexed search is unavailable');
  assert.ok(Array.isArray(search.data),'Category index did not return product list');
  assert.ok(Number.isInteger(search.total),'Missing exact search total');
  console.log('PASS indexed category search (matches='+search.total+')');
  // Full-industry search and dynamic attribute options must also work on
  // the actual running Windows origin, not only in GitHub Actions.
  const universal=await json('/api/products/discover/options');
  assert.equal(universal.success,true,'Universal facets API is unavailable');
  assert.ok(Array.isArray(universal.categories),'Dynamic industry categories missing');
  assert.ok(universal.categories.length>0,'No populated categories discovered');
  const browse=await json('/api/products/discover?limit=2');
  assert.equal(browse.success,true,'Universal search endpoint is unavailable');
  assert.ok(Array.isArray(browse.data),'Universal search items missing');
  assert.ok(Number(browse.total)>0,'Universal search returned an empty live store');
  if((universal.facets?.size||[]).some(x=>x.value==='XL')){
    const size=await json('/api/products/discover?attr=size&value=XL&limit=1');
    assert.equal(size.success,true,'Size facet search failed');
    assert.ok(Number(size.possibleTotal)<Number(browse.total)*0.5,
      'Unrelated items flood the possible-size result list');
    console.log('PASS size XL possible-results relevance ('+size.possibleTotal+' candidates)');
  }
  console.log('PASS full-industry indexed search and dynamic category options');
  const universalJs=await fetchText('/besi-universal.js');
  assert.match(universalJs,/api\\/products\\/discover|api\/products\/discover/,
    'Live full-industry browser bundle is stale');
  const js=await fetchText('/besi-category-facets.js');
  assert.match(js,/category-facets|category-specs/,'Live browser bundle is stale');
  const html=await fetchText('/');
  assert.match(html,/besi-category-facets\.js/,'Live HTML does not load new filters');
  assert.match(html,/besi-universal\.js/,'Live HTML does not load full-industry search');
  console.log('PASS live frontend assets + HTML');
  console.log('BESI PRODUCTION VERIFIED');
}
main().catch(error=>{
  console.error('BESI PRODUCTION NOT DEPLOYED/READY: '+error.message);
  process.exitCode=1;
});
