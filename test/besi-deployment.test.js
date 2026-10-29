'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
test('public repo Windows update no longer requires SSH deploy key',()=>{
  const script=read('scripts/auto-update.ps1');
  assert.match(script,/\$remoteUrl = 'https:\/\/github\.com\/capquangfptminhlh\/cnlg\.git'/);
  assert.match(script,/if \(-not \$testRemote -and \(Test-Path \$key\)\)/);
  assert.doesNotMatch(script,/if \(-not \$testRemote -and -not \(Test-Path \$key\)\) \{ return \}/);
  assert.match(script,/\$env:GIT_TERMINAL_PROMPT = '0'/);
  assert.match(script,/RunGit fetch --quiet \$remoteUrl/);
});
test('catalog ignored by git must not be checked out or overwritten',()=>{
  const script=read('scripts/auto-update.ps1');
  assert.match(read('.gitignore'),/data\/\*/);
  assert.match(script,/RunGit ls-files -- data\/products\.json/);
  assert.match(script,/if \(-not \$tracked\) \{ & \$body; return \}/);
  assert.match(script,/if \(\$had\) \{ Copy-Item \$catalog \$tmp -Force; RunGit checkout/);
});
test('Windows updater runs both backend and UI checks, verifies running revision and faceted API',()=>{
  const script=read('scripts/auto-update.ps1');
  assert.match(script,/RunNpm test/);
  assert.match(script,/RunNpm run test:ui/);
  assert.match(script,/function Healthy\(\[int\]\$seconds, \[string\]\$expectedCommit\)/);
  assert.match(script,/health\.release -ne \$expectedShort/);
  assert.match(script,/api\/products\/category-facets\?category=case/);
  assert.match(script,/if \(RestartStore \$new\)/);
  assert.match(script,/if \(RestartStore \$old\)/);
  assert.match(script,/HoangMinh Store/);
});
test('setup works without deploy keys, diagnostic is read-only and release fingerprint is safe',()=>{
  const enable=read('scripts/enable-auto-update.ps1');
  const diag=read('scripts/besi-deployment-status.ps1');
  const server=read('server.js');
  assert.match(enable,/param\(\[switch\]\$UseSshDeployKey\)/);
  assert.match(enable,/if \(\$UseSshDeployKey\) \{/);
  assert.match(enable,/Register-ScheduledTask -TaskName 'HoangMinh Update'/);
  assert.match(diag,/Get-ScheduledTask -TaskName \$taskName/);
  assert.match(diag,/Invoke-RestMethod 'http:\/\/127\.0\.0\.1:3000\/api\/products\/category-facets/);
  assert.doesNotMatch(diag,/Stop-Process|git\.exe\s+(?:reset|checkout|merge)|Start-ScheduledTask/);
  assert.match(server,/release: besiRelease/);
  assert.match(server,/execFileSync\('git', \['rev-parse', '--short=12', 'HEAD'\]/);
});
test('public production smoke check does not require admin or mutate orders',()=>{
  const code=read('scripts/check-besi-production.js');
  assert.doesNotThrow(()=>new vm.Script(code,{filename:'check-besi-production.js'}));
  for(const url of ['/healthz','/api/products/category-facets?category=case',
    '/api/products/category-specs?category=case&limit=1','/besi-category-facets.js'])
    assert.ok(code.includes(url),'Missing public check: '+url);
  assert.doesNotMatch(code,/admin\/|\/api\/orders|\/api\/checkout|supplierCost|secret_token/);
  const workflow=read('.github/workflows/besi-production-check.yml');
  assert.match(workflow,/check-besi-production\.js https:\/\/besi\.com\.vn/);
  assert.match(workflow,/workflow_dispatch/);
});
