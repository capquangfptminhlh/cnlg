# BESI Windows origin release diagnostic and one-time updater recovery.
# Run in elevated Windows PowerShell on the actual BESI Windows server.
# No passwords, tokens or product data are uploaded.
param(
  [string]$RepoRoot = 'C:\HoangMinh',
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
function Say([string]$text) { Write-Host "[BESI deploy] $text" }
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.git'))) {
  throw "Không thấy Git repo tại $RepoRoot"
}
$RepoRoot=(Resolve-Path -LiteralPath $RepoRoot).Path
Push-Location $RepoRoot
try {
  $local=(& git.exe -c "safe.directory=$($RepoRoot -replace '\\','/')" rev-parse HEAD 2>$null | Select-Object -Last 1)
  if ($LASTEXITCODE -ne 0 -or $local -notmatch '^[a-f0-9]{40}$') { throw 'Không đọc được mã commit local' }
  Say "Commit local: $($local.Substring(0,12))"
  $remote=(& git.exe ls-remote https://github.com/capquangfptminhlh/cnlg.git refs/heads/main 2>$null | Select-Object -Last 1)
  if ($LASTEXITCODE -ne 0) { throw 'Không kết nối được GitHub HTTPS' }
  if ($remote -match '^([a-f0-9]{40})\s') {
    $expected=$Matches[1]
  } else { throw 'Không đọc được commit GitHub main' }
  Say "Commit GitHub main: $($expected.Substring(0,12))"
  $live=$null
  try { $live=Invoke-RestMethod http://127.0.0.1:3000/healthz -TimeoutSec 6 }
  catch { Say 'Origin chưa trả lời healthz trên port 3000' }
  if ($live) { Say "Tiến trình Node đang chạy: $($live.release)" }
  foreach ($taskName in @('HoangMinh Update','HoangMinh Store')) {
    $task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Say "Scheduled Task $($taskName): $(if ($task) { $task.State } else { 'MISSING' })"
  }
  $log=Join-Path $RepoRoot 'data\update.log'
  if (Test-Path -LiteralPath $log) {
    Say '10 dòng log cập nhật gần nhất:'
    Get-Content -LiteralPath $log -Tail 10 | ForEach-Object { Write-Host $_ }
  } else { Say 'Chưa có data\update.log' }
  if (-not $Apply) {
    Say 'Chỉ chẩn đoán. Dùng -Apply để tải và chạy updater mới nhất.'
    exit 0
  }
  $tmp=Join-Path $env:TEMP 'besi-updater-recovery.ps1'
  $source='https://raw.githubusercontent.com/capquangfptminhlh/cnlg/main/scripts/auto-update.ps1'
  Invoke-WebRequest -UseBasicParsing -Uri $source -OutFile $tmp -TimeoutSec 30
  # Verify syntax with the actual PowerShell 5.1 engine BEFORE executing.
  $tokens=$null; $errors=$null
  [System.Management.Automation.Language.Parser]::ParseFile($tmp,[ref]$tokens,[ref]$errors) | Out-Null
  if($errors.Count -ne 0){throw "Updater tải về không hợp lệ: $($errors[0])"}
  Say 'Đã xác minh cú pháp updater. Đang chạy cơ chế có rollback.'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tmp -RepoRoot $RepoRoot
  if($LASTEXITCODE -ne 0){throw "Updater trả exit code $LASTEXITCODE"}
  $after=Invoke-RestMethod http://127.0.0.1:3000/healthz -TimeoutSec 8
  Say "Commit origin sau cập nhật: $($after.release)"
  if($after.release -ne $expected.Substring(0,12)){
    throw "Chưa chạy commit main mới nhất. Kiểm tra data\update.log và tác vụ HoangMinh Store."
  }
  Say 'PASS: origin đang chạy đúng commit mới nhất của GitHub main.'
} finally {
  Pop-Location
}
