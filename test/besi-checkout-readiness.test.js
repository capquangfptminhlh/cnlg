'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const guard=require('../public/besi-checkout-guard.js');
const methods={cod:{enabled:true,maxTotal:5000000},bank:{enabled:false}};
test('real checkout settings allow COD only up to server limit, including shipping',()=>{
 const below=guard.evaluate(methods,'COD',4999999);
 assert.equal(below.allowed,true);
 assert.equal(guard.evaluate(methods,'COD',5000000).allowed,true);
 const blocked=guard.evaluate(methods,'COD',5000001);
 assert.equal(blocked.allowed,false);
 assert.equal(blocked.reason,'cod-limit');
 assert.match(blocked.note,/5\.000\.000/);
 assert.equal(guard.evaluate(methods,'BANK',100000).allowed,false);
});
test('enabled bank removes COD ceiling for BANK selection without changing COD itself',()=>{
 const both={cod:{enabled:true,maxTotal:5000000},bank:{enabled:true}};
 assert.equal(guard.evaluate(both,'BANK',25000000).allowed,true);
 assert.equal(guard.evaluate(both,'COD',25000000).allowed,false);
 assert.equal(guard.evaluate({cod:{enabled:false,maxTotal:5000000},bank:{enabled:true}},'COD',1).allowed,false);
});
test('payment options failure and no payment methods fail closed before checkout',()=>{
 for(const options of [null,undefined,{cod:{enabled:false},bank:{enabled:false}}]){
  assert.equal(guard.evaluate(options,'COD',100000).allowed,false);
 }
 assert.equal(guard.evaluate(methods,'COD',100000,{loaded:false}).allowed,false);
 assert.equal(guard.evaluate(methods,'COD',0,{empty:true}).allowed,false);
 assert.equal(guard.evaluate(methods,'BANK',-1).allowed,false);
 assert.equal(guard.evaluate(methods,'CASH',100000).allowed,false);
});
test('payment guard is installed before storefront app and evaluated with shipping quote',()=>{
 const html=read('public/index.html'),app=read('public/app.js');
 assert.ok(html.indexOf('src="/besi-checkout-guard.js"')<html.indexOf('src="/app.js"'));
 assert.match(app,/BesiCheckoutGuard\.evaluate\(payOptions/);
 assert.match(app,/checkoutEstimatedTotal = Number\(q\.total\)/);
 assert.match(app,/submitOrderBtn\.disabled = !readiness\.allowed/);
 assert.match(app,/const ready = paymentReadiness\(\)/);
 assert.match(app,/if \(!ready\.allowed\)/);
 assert.doesNotThrow(()=>new vm.Script(read('public/besi-checkout-guard.js')));
 assert.doesNotThrow(()=>new vm.Script(app));
});
test('Windows updater self-heals disk/main parity but stale Node release safely',()=>{
 const script=read('scripts/auto-update.ps1');
 assert.match(script,/if \(\$old -eq \$new\) \{/);
 assert.match(script,/if \(\$live\.release -eq \$new\.Substring\(0,12\)\) \{ return \}/);
 assert.match(script,/RunGit rev-parse --verify/);
 assert.match(script,/RunGit merge-base --is-ancestor \$runningCommit \$new/);
 assert.match(script,/RunNpm test/);
 assert.match(script,/RunNpm run test:ui/);
 assert.match(script,/if \(RestartStore \$new\) \{/);
 assert.match(script,/WithCatalogKept \{ RunGit reset --hard --quiet \$runningCommit/);
 assert.match(script,/if \(RestartStore \$runningCommit \$false\)/);
});


test('checkout is blocked until shipping quote is confirmed, even when item subtotal is under COD cap',()=>{
 const options={cod:{enabled:true,maxTotal:5000000},bank:{enabled:false}};
 for(const shippingStatus of ['missing','pending','error']){
  const result=guard.evaluate(options,'COD',4950000,{shippingStatus});
  assert.equal(result.allowed,false);
  assert.equal(result.reason,'shipping-'+shippingStatus);
  assert.ok(result.note.length>15);
 }
 assert.equal(guard.evaluate(options,'COD',4950000,{shippingStatus:'ready'}).allowed,true);
 assert.equal(guard.evaluate(options,'COD',5010000,{shippingStatus:'ready'}).allowed,false);
});
test('bank selection also awaits correct shipping total and never bypasses quote',()=>{
 const options={cod:{enabled:true,maxTotal:5000000},bank:{enabled:true}};
 assert.equal(guard.evaluate(options,'BANK',6000000,{shippingStatus:'pending'}).allowed,false);
 assert.equal(guard.evaluate(options,'BANK',6000000,{shippingStatus:'error'}).allowed,false);
 assert.equal(guard.evaluate(options,'BANK',6000000,{shippingStatus:'ready'}).allowed,true);
});
test('checkout UI shows shipping retry, enforces province and ward, validates server quote',()=>{
 const html=read('public/index.html'),app=read('public/app.js');
 assert.match(html,/id="retryShippingQuote"/);
 assert.match(app,/let checkoutShippingStatus = 'missing'/);
 assert.match(app,/shippingStatus: checkoutShippingStatus/);
 assert.match(app,/\? 'pending' : 'missing'/);
 assert.match(app,/!province \|\| !wardSelect\.value \|\| wardSelect\.disabled/);
 assert.match(app,/Number\.isFinite\(Number\(q\.total\)\)/);
 assert.match(app,/checkoutShippingStatus = 'ready'/);
 assert.match(app,/checkoutShippingStatus = 'error'/);
 assert.match(app,/retryShippingQuote'\)\.addEventListener\('click', updateCheckoutSummary\)/);
 assert.doesNotThrow(()=>new vm.Script(app));
});


test('backend rejects unsupported payment methods and gives actionable COD advice when bank unavailable',()=>{
 const server=read('server.js');
 assert.match(server,/if \(!\['COD','BANK'\]\.includes\(paymentMethod\)\)/);
 assert.match(server,/Vui lòng chọn phương thức thanh toán hợp lệ/);
 assert.match(server,/const msg = payOpts\.bank\.enabled/);
 assert.match(server,/giảm giá trị đơn hoặc liên hệ cửa hàng/);
 assert.match(server,/if \(paymentMethod === 'COD' && total_amount > payOpts\.cod\.maxTotal\)/);
});
