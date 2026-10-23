# Đóng gói dữ liệu vận hành để chuyển cửa hàng sang máy chủ khác (chạy trên MÁY CŨ, lúc chuyển).
#
#   powershell -ExecutionPolicy Bypass -File scripts\export-server-bundle.ps1 -StopOld
#
# -StopOld : tắt cửa hàng + tunnel trên máy này và bỏ tự chạy khi bật máy, rồi mới đóng gói.
#            Bắt buộc khi chuyển thật: hai máy cùng chạy tunnel thì Cloudflare chia khách cho cả hai
#            → đơn hàng bị tách ra hai nơi.
#
# File zip chứa đơn hàng, tài khoản DropBuy (đã mã hoá + khoá giải mã), mật khẩu admin, khoá tunnel.
# Chỉ chép bằng USB / mạng nội bộ, KHÔNG gửi qua chat/email/GitHub. Chép xong thì xoá file zip.
param(
  [switch]$StopOld,
  [string]$OutDir = [Environment]::GetFolderPath('Desktop')
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tunnelId = '9fb2be2d-01d8-4b78-8f30-d24095156178'

if ($StopOld) {
  Write-Host 'Tắt cửa hàng và tunnel trên máy này...'
  $startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'HoangMinhStore.cmd'
  if (Test-Path $startup) { Rename-Item $startup 'HoangMinhStore.cmd.da-chuyen-may' -Force }
  Get-ScheduledTask -TaskName 'HoangMinh *' -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-ScheduledTask -TaskName $_.TaskName -ErrorAction SilentlyContinue
    Disable-ScheduledTask -TaskName $_.TaskName | Out-Null
  }
  # Bộ giám sát trước, rồi mới tới node / tunnel (không thì bộ giám sát bật lại ngay)
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
    Where-Object { $_.CommandLine -match [regex]::Escape($repo) -and $_.CommandLine -match 'start\.bat|tunnel\.bat' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='hm-tunnel.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'server\.js' -and ($_.CommandLine -match [regex]::Escape($repo) -or (Get-NetTCPConnection -OwningProcess $_.ProcessId -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep 2
}

$stage = Join-Path $env:TEMP ('hm-bundle-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force "$stage\data", "$stage\tools", "$stage\tunnel" | Out-Null

$dataFiles = 'orders.json', 'config.json', 'admin-secret.json', 'cred.key', 'dropbuy-cred.json', 'address-v2.json', 'products.json', 'categories.json', 'payments.json'
foreach ($f in $dataFiles) { $p = Join-Path "$repo\data" $f; if (Test-Path $p) { Copy-Item $p "$stage\data\" } }
foreach ($d in 'backups', 'products_detail') { $p = Join-Path "$repo\data" $d; if (Test-Path $p) { Copy-Item $p "$stage\data\$d" -Recurse } }
if (Test-Path "$repo\.env") { Copy-Item "$repo\.env" "$stage\env.txt" }
if (Test-Path "$repo\tools\hm-tunnel.exe") { Copy-Item "$repo\tools\hm-tunnel.exe" "$stage\tools\" }

# Cấu hình + khoá tunnel: ưu tiên bản trong data\tunnel, không có thì lấy từ %USERPROFILE%\.cloudflared
$tunnelSrc = if (Test-Path "$repo\data\tunnel\$tunnelId.json") { "$repo\data\tunnel" } else { Join-Path $env:USERPROFILE '.cloudflared' }
Copy-Item (Join-Path $tunnelSrc "$tunnelId.json") "$stage\tunnel\"
Copy-Item (Join-Path $tunnelSrc 'hoangminh-store.yml') "$stage\tunnel\"

$zip = Join-Path $OutDir ('HoangMinh-chuyen-may-' + (Get-Date -Format 'yyyyMMdd-HHmm') + '.zip')
Compress-Archive -Path "$stage\*" -DestinationPath $zip -Force
Remove-Item $stage -Recurse -Force
# PowerShell 5.1 trả cả mảng JSON thành 1 phần tử qua pipeline → gán biến trước rồi mới đếm
$orders = 0; try { $parsed = Get-Content "$repo\data\orders.json" -Raw | ConvertFrom-Json; $orders = @($parsed).Count } catch {}
Write-Host ''
Write-Host "Đã đóng gói: $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB, $orders đơn hàng)"
Write-Host 'Chép file này sang máy chủ mới bằng USB / mạng nội bộ, rồi chạy scripts\install-server-windows.ps1 ở đó.'
if (-not $StopOld) { Write-Host 'LƯU Ý: chưa tắt cửa hàng trên máy này (chạy lại với -StopOld khi chuyển thật).' }
