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
