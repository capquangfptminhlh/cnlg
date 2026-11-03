# BESI Windows origin diagnostics and optional one-time updater recovery.
# ASCII-only source to remain parseable by Windows PowerShell 5.1.
# Run as Administrator on the actual Windows origin. Never on a second copy.
param(
  [string]$RepoRoot = 'C:\HoangMinh',
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
function Say([string]$msg) { Write-Host "[BESI deploy] $msg" }
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.git'))) {
  throw "Git repository missing at $RepoRoot"
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
Push-Location $RepoRoot
try {
  $safeDirectory = $RepoRoot.Replace('\', '/')
  $local = (& git.exe -c "safe.directory=$safeDirectory" rev-parse HEAD 2>$null | Select-Object -Last 1)
  if ($LASTEXITCODE -ne 0 -or $local -notmatch '^[a-f0-9]{40}$') {
    throw 'Cannot read local Git HEAD'
  }
  Say "Local commit: $($local.Substring(0,12))"

  $remote = (& git.exe ls-remote https://github.com/capquangfptminhlh/cnlg.git refs/heads/main 2>$null | Select-Object -Last 1)
  if ($LASTEXITCODE -ne 0) { throw 'Cannot connect to GitHub main using public HTTPS' }
  $m = [regex]::Match([string]$remote, '^([a-f0-9]{40})\s')
  if (-not $m.Success) { throw 'Cannot parse main SHA from GitHub' }
  $expected = $m.Groups[1].Value
  Say "GitHub main: $($expected.Substring(0,12))"

  $live = $null
  try { $live = Invoke-RestMethod 'http://127.0.0.1:3000/healthz' -TimeoutSec 6 }
  catch { Say 'Node origin did not respond to local /healthz' }
  if ($live) { Say "Live Node release: $($live.release)" }

  foreach ($taskName in @('HoangMinh Update', 'HoangMinh Store')) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $state = if ($task) { $task.State } else { 'MISSING' }
    Say ("Scheduled Task " + $taskName + ": " + $state)
  }
  $log = Join-Path $RepoRoot 'data\update.log'
  if (Test-Path -LiteralPath $log) {
    Say 'Latest updater log entries:'
    Get-Content -LiteralPath $log -Tail 10 | ForEach-Object { Write-Host $_ }
  } else { Say 'Update log does not exist yet' }

  if (-not $Apply) {
    Say 'Read-only diagnostic completed. Use -Apply explicitly to run the updater.'
  } else {
    $tempScript = Join-Path $env:TEMP 'besi-updater-recovery.ps1'
    $source = 'https://raw.githubusercontent.com/capquangfptminhlh/cnlg/main/scripts/auto-update.ps1'
    Invoke-WebRequest -UseBasicParsing -Uri $source -OutFile $tempScript -TimeoutSec 30
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($tempScript, [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors.Count -gt 0) {
      throw "Downloaded updater has invalid PowerShell syntax: $($parseErrors[0])"
    }
    Say 'Updater syntax verified. Running existing fast-forward/test/rollback procedure.'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tempScript -RepoRoot $RepoRoot
    if ($LASTEXITCODE -ne 0) { throw "Updater returned exit code $LASTEXITCODE" }
    $after = Invoke-RestMethod 'http://127.0.0.1:3000/healthz' -TimeoutSec 8
    Say "Live release after updater: $($after.release)"
    if ($after.release -ne $expected.Substring(0,12)) {
      throw 'Running Node release is not yet GitHub main. See data\update.log and the Store watchdog.'
    }
    Say 'PASS: Windows origin is running the latest GitHub main release.'
  }
} finally {
  Pop-Location
}
