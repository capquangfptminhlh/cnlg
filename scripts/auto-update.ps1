# Tự cập nhật mã nguồn từ GitHub trên máy chủ (tác vụ "HoangMinh Update" chạy mỗi 5 phút, tài khoản SYSTEM).
#
# Có bản mới trên nhánh main → lấy về (chỉ fast-forward) → cài lại thư viện nếu package-lock đổi → chạy test
# → test đạt mới khởi động lại cửa hàng (gián đoạn vài giây) → cửa hàng không lên lại thì quay về bản cũ.
# Test hỏng: giữ nguyên bản đang chạy. Mọi việc ghi vào data\update.log.
#
# Lấy mã bằng khoá chỉ-đọc data\deploy\id_ed25519 (tạo bởi scripts\enable-auto-update.ps1), không cần đăng nhập GitHub.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $repo 'data'
$log = Join-Path $dataDir 'update.log'
$lock = Join-Path $dataDir 'update.lock'
$catalog = Join-Path $dataDir 'products.json'
$rejected = Join-Path $dataDir 'update.rejected'   # bản đã từ chối: không thử lại mỗi 5 phút
$remoteUrl = 'git@github.com:capquangfptminhlh/cnlg.git'
# Chỉ để thử trên máy khác: HM_UPDATE_REMOTE = nguồn git thay thế (bỏ qua khoá deploy), HM_UPDATE_NO_RESTART=1 = không đụng cửa hàng
$testRemote = $env:HM_UPDATE_REMOTE
if ($testRemote) { $remoteUrl = $testRemote }

function Log([string]$m) {
  Add-Content -Path $log -Value ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding utf8
}
function RunGit {
  # PowerShell 5.1 + "Stop" coi mọi dòng git in ra stderr (cảnh báo CRLF…) là lỗi → chỉ dựa vào mã thoát
  $ErrorActionPreference = 'Continue'
  # safe.directory: repo do tài khoản người dùng tạo, tác vụ chạy bằng SYSTEM
  $out = & git.exe -c "safe.directory=$($repo -replace '\\', '/')" @args 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE) { throw "git $($args -join ' '): $($out -join ' ')" }
  return ($out -join "`n").Trim()
}
function RunNpm {
  $ErrorActionPreference = 'Continue'
  $out = & npm.cmd @args 2>&1 | ForEach-Object { "$_" }
  return [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
}
function Healthy([int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i += 2) {
    Start-Sleep 2
    try { if ((Invoke-RestMethod http://localhost:3000/healthz -TimeoutSec 3).ok) { return $true } } catch {}
  }
  return $false
}
function RestartStore {
  if ($env:HM_UPDATE_NO_RESTART -eq '1') { return $true }
  # Tắt node đang giữ cổng 3000; start.bat (tác vụ "HoangMinh Store") tự bật lại sau ~5 giây với mã mới
  $c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { Stop-Process -Id $c.OwningProcess -Force }
  Start-Sleep 3
  return (Healthy 90)
}
# data\products.json do vòng đồng bộ ghi liên tục nhưng vẫn nằm trong git (bản lưu cho bản trưng bày):
# cất bản đang chạy ra ngoài trước khi đổi mã, xong thì trả lại – không bao giờ mất danh mục đang bán
function WithCatalogKept([scriptblock]$body) {
  $tmp = "$catalog.update-keep"
  $had = Test-Path $catalog
  if ($had) { Copy-Item $catalog $tmp -Force; RunGit checkout -- data/products.json | Out-Null }
  try { & $body } finally { if ($had) { Move-Item $tmp $catalog -Force } }
}

# Một lần chạy một bản (khoá cũ quá 30 phút coi như bị treo)
if ((Test-Path $lock) -and (Get-Item $lock).LastWriteTime -gt (Get-Date).AddMinutes(-30)) { return }
Set-Content $lock $PID
try {
  Set-Location $repo
  $key = Join-Path $dataDir 'deploy\id_ed25519'
  if (-not $testRemote -and -not (Test-Path $key)) { return }   # chưa bật tự cập nhật
  $ssh = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
  if (-not (Test-Path $ssh)) { $ssh = 'ssh' }
  if (-not $testRemote) { $env:GIT_SSH_COMMAND = "`"$($ssh -replace '\\', '/')`" -i `"$($key -replace '\\', '/')`" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=`"$((Join-Path $dataDir 'deploy\known_hosts') -replace '\\', '/')`"" }

  RunGit fetch --quiet $remoteUrl 'main:refs/remotes/origin/main' | Out-Null
  $old = RunGit rev-parse HEAD
  $new = RunGit rev-parse origin/main
  if ($old -eq $new) { return }
  if ((Test-Path $rejected) -and (Get-Content $rejected -Raw).Trim() -eq $new) { return }
  # Chỉ nhận bản đi tiếp từ bản đang chạy (không ghi đè sửa tay trên máy chủ)
  $isAncestor = $true
  try { RunGit merge-base --is-ancestor $old $new | Out-Null } catch { $isAncestor = $false }
  if (-not $isAncestor) { Log "BỎ QUA: origin/main ($($new.Substring(0,7))) không đi tiếp từ bản đang chạy ($($old.Substring(0,7))) – cần xử lý tay."; return }
  $dirty = (RunGit status --porcelain --untracked-files=no) -split "`n" | Where-Object { $_ -and $_ -notmatch 'data/products\.json$' }
  if ($dirty) { Log "BỎ QUA: máy chủ có file mã bị sửa tay: $($dirty -join ', ')"; return }

  $subject = RunGit log -1 --format=%s $new
  Log "Có bản mới $($new.Substring(0,7)): $subject"
  $lockChanged = [bool](RunGit diff --name-only $old $new -- package-lock.json)
  WithCatalogKept { RunGit merge --ff-only --quiet $new | Out-Null }
  if ($lockChanged) { Log 'package-lock đổi → cài lại thư viện'; if ((RunNpm ci --no-audit --no-fund).Code) { throw 'npm ci lỗi' } }

  $test = RunNpm test
  if ($test.Code) {
    $failed = ($test.Out | Select-String 'fail (\d+)' | ForEach-Object { $_.Matches[0].Groups[1].Value } | Select-Object -Last 1)
    Log "TEST HỎNG ($failed bài) → giữ bản cũ $($old.Substring(0,7)), không thử lại bản $($new.Substring(0,7)) nữa."
    Set-Content $rejected $new
    WithCatalogKept { RunGit reset --hard --quiet $old | Out-Null }
    if ($lockChanged) { RunNpm ci --no-audit --no-fund | Out-Null }
    return
  }
  if (RestartStore) { Log "ĐÃ CẬP NHẬT lên $($new.Substring(0,7)), cửa hàng chạy bình thường."; return }

  Log "CỬA HÀNG KHÔNG LÊN với bản $($new.Substring(0,7)) → quay về $($old.Substring(0,7))"
  Set-Content $rejected $new
  WithCatalogKept { RunGit reset --hard --quiet $old | Out-Null }
  if ($lockChanged) { RunNpm ci --no-audit --no-fund | Out-Null }
  if (RestartStore) { Log 'Đã quay về bản cũ, cửa hàng chạy lại.' } else { Log 'LỖI: cửa hàng vẫn không lên sau khi quay về – xem data\server.log' }
} catch {
  Log "LỖI: $($_.Exception.Message)"
} finally {
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
}
