# BESI deployment diagnosis — READ ONLY. Run on the Windows origin server.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\besi-deployment-status.ps1
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$taskName = 'HoangMinh Update'
$publicRemote = 'https://github.com/capquangfptminhlh/cnlg.git'
Write-Host '=== BESI WINDOWS DEPLOYMENT STATUS ==='
Write-Host ("Root: " + $repo)
$localSha = $null
try {
  $localSha = (& git.exe -C $repo rev-parse HEAD 2>$null)
  Write-Host ("Local git HEAD: " + $localSha)
} catch { Write-Host 'Khong doc duoc local git HEAD' }
$remoteSha = $null
try {
  $env:GIT_TERMINAL_PROMPT = '0'
  $remoteLine = (& git.exe ls-remote $publicRemote refs/heads/main 2>$null | Select-Object -First 1)
  if ($remoteLine) { $remoteSha = ($remoteLine -split '\s+')[0] }
  Write-Host ("Remote main: " + $(if ($remoteSha) { $remoteSha } else { 'KHONG DOC DUOC' }))
} catch { Write-Host ('Remote unavailable: ' + $_.Exception.Message) }
if ($localSha -and $remoteSha) {
  if ($localSha -eq $remoteSha) { Write-Host 'SOURCE: local = GitHub main' }
  else { Write-Host 'SOURCE: local CHUA CAP NHAT theo GitHub main' }
}
try {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
  Write-Host ("Auto-update task: " + $task.State + ", last run: " + $info.LastRunTime + ", result: " + $info.LastTaskResult)
} catch {
  Write-Host 'Auto-update task: KHONG CO. Can chay scripts\enable-auto-update.ps1 tren may chu.'
}
try {
  $h = Invoke-RestMethod 'http://127.0.0.1:3000/healthz' -TimeoutSec 6
  Write-Host ("Origin health: ok=" + $h.ok + ", products=" + $h.products + ", release=" + $h.release)
  if ($localSha -and $h.release -and $h.release -ne 'unknown') {
    if ($h.release -eq $localSha.Substring(0,12)) { Write-Host 'RUNNING: process Node dang chay dung git HEAD.' }
    else { Write-Host 'RUNNING: process Node CHUA restart len git HEAD.' }
  }
} catch { Write-Host ('Origin health: ERROR: ' + $_.Exception.Message) }
try {
  $f = Invoke-RestMethod 'http://127.0.0.1:3000/api/products/category-facets?category=case' -TimeoutSec 12
  Write-Host ("Category facets API: " + $(if ($f.success) { 'OK' } else { 'LOI' }))
} catch { Write-Host ('Category facets API: CHUA HOAT DONG: ' + $_.Exception.Message) }
$log = Join-Path $repo 'data\update.log'
if (Test-Path $log) {
  Write-Host '--- Last 12 updater messages ---'
  Get-Content $log -Tail 12 | ForEach-Object { Write-Host $_ }
} else { Write-Host 'Chua co data\update.log — co the task chua chay.' }
Write-Host 'Khong gui khoa SSH, token, mat khau hoac file .env cho bat ky ai.'
