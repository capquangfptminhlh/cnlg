# BESI Windows production deployment and diagnostics

This repository contains the **live Node/Express store**, which is served from a Windows machine via a Cloudflare Tunnel. A GitHub CI test pass proves only that source code passed tests: it does **not** restart the running Windows process.

## Observed problem (2026-10-29)

The public /healthz was reachable, but /api/products/category-facets?category=case and /api/products/category-specs were still 404. The source code for both endpoints had already been merged into GitHub main. The historical Windows updater had two potential blockers:

1. It stopped immediately if no SSH deploy key existed, despite the repository being public.
2. It always ran git checkout -- data/products.json, although the current data/ folder is gitignored and the file is no longer tracked.

The updated script uses public HTTPS when no legacy SSH key is present. It only attempts a tracked-file catalog checkout if git ls-files confirms that file is tracked. It runs npm test and npm run test:ui before restarting. After restart it verifies the 12-character running release SHA and a real response from the category facets API. Otherwise it rolls back.

## One-time bootstrap from old Windows installation

Run **on the Windows BESI origin server**, as Administrator. This is an explicitly local operation; running the commands in GitHub Actions or on a laptop will not update the live site. Set the actual repository location if not C:\HoangMinh.

```powershell
$repo = 'C:\HoangMinh'
$script = Join-Path $env:TEMP 'besi-update-from-github.ps1'
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/capquangfptminhlh/cnlg/main/scripts/auto-update.ps1' -OutFile $script
# Review the downloaded script and make sure the URL belongs to YOUR repository.
notepad $script
powershell -NoProfile -ExecutionPolicy Bypass -File $script -RepoRoot $repo
```

The updater does not overwrite source inventory, .env, order records, cookie stores or Cloudflare Tunnel credentials. It requires that the local checkout is an ancestor of GitHub main and refuses to overwrite locally edited tracked files. If npm tests fail, or the restarted release/API is incorrect, it attempts to roll back. **Verify recent backups of data/ before the first production update.**

The restart requires an active Windows Scheduled Task named HoangMinh Store, launching the start.bat watchdog. If this task is absent or stopped, the updater will refuse to kill the running Node process. Restore the existing supervisor configuration first. Do not create a second live store or Cloudflare tunnel.

## Schedule future updates

After the source code has updated successfully, register the automatic updater if not already installed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\HoangMinh\scripts\enable-auto-update.ps1"
```

On the current public repo **no GitHub token or SSH private key is required**. For future private-repo use there is an optional -UseSshDeployKey switch. Never paste deployment keys, .env files or Tunnel credentials into chat or GitHub.

## Check actual production status

Run on the server:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\HoangMinh\scripts\besi-deployment-status.ps1"
```

The script prints local Git HEAD, remote main, update task status, the running release identifier, indexed filter API status and recent updater messages. It does not edit the application.

From any machine that has Node.js, to smoke-test public endpoints without creating orders:

```bash
node scripts/check-besi-production.js https://besi.com.vn
```

To require parity with the exact GitHub main revision:

```bash
node scripts/check-besi-production.js https://besi.com.vn "$(git rev-parse HEAD)"
```

GitHub workflow BESI live production deployment check performs the public smoke check independently of source quality CI.

## Caveats

- If the server runs under PM2, Docker, or another service rather than the Windows start.bat watchdog, use that service's existing upgrade/restart mechanism instead; **do not blindly stop a production process**.
- Existing .env, orders and supplier integrations are never copied to GitHub.
- A release fingerprint of 'unknown' means Git metadata was unavailable on the running server. Configure BESI_DEPLOY_SHA in the private environment or install Git to enable exact deployment parity.
- Do not change the Cloudflare Tunnel or DNS simply to deploy a new version; the problem is normally an old local Node process or updater.

## Taobao tab deployment issue (2026-11-02)

The Taobao tab was merged into `main` in release `37ed9562f075`, while the
external production smoke check observed `67a4366a2e55` on the Windows
origin. CI tested the Taobao tab but did not deploy it.

Investigation found that `scripts/auto-update.ps1` in GitHub had a corrupt
PowerShell condition with a duplicated block inserted into a quoted regex.
This prevents Windows PowerShell 5.1 from parsing the script, so the updater
cannot execute at all when that version is present on the server. The source
has now been repaired, with a Windows PowerShell parser job added to CI and
live smoke checks for `/taobao` and `/api/taobao/products`.

**To recover the existing Windows origin**, an administrator must bootstrap
from the fixed GitHub script as shown in the one-time bootstrap section above.
A broken installed updater cannot fetch its own fix. Inspect the script first,
check backups and run only on the actual origin with its existing watchdog.
Do not run the updater in CI or restart a second Node server. The site is
confirmed updated only when `/healthz` matches GitHub main and the separate
Taobao route and API pass production smoke checks.


## One-command diagnostic and recovery (2026-11-03)

For an old installed updater that cannot execute, download the **new**
diagnostic script on the actual BESI Windows server. **Read it before applying**
and back up the `data/` directory. No code in this repository can repair an
offline Windows host without executing something locally:

```powershell
$recovery = Join-Path $env:TEMP 'besi-diagnose.ps1'
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/capquangfptminhlh/cnlg/main/scripts/diagnose-besi-windows.ps1' -OutFile $recovery
notepad $recovery
# Read-only: local Git, GitHub main, live Node health, scheduled tasks and last updater log
powershell -NoProfile -ExecutionPolicy Bypass -File $recovery -RepoRoot 'C:\HoangMinh'
# Opt in only on the actual Windows origin with an active HoangMinh Store watchdog
powershell -NoProfile -ExecutionPolicy Bypass -File $recovery -RepoRoot 'C:\HoangMinh' -Apply
```

The `-Apply` path downloads and parses the fixed updater using Windows
PowerShell 5.1, runs its backup-conscious fast-forward/test/rollback sequence,
then verifies the live release against GitHub main. It **does not** change
Cloudflare Tunnel settings or introduce anonymous deployment endpoints.
If the watchdog is stopped, the updater refuses to terminate Node. If
GitHub fetch or health checks fail, inspect `data/update.log` and the
previous process status; never claim deployment just because GitHub CI passed.
