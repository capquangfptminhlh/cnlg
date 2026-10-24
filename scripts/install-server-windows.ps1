# Cài cửa hàng lên MÁY CHỦ MỚI (Windows), chạy bằng PowerShell "Run as administrator":
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-server-windows.ps1 -Bundle D:\HoangMinh-chuyen-may-xxxx.zip
#
# Việc làm: kiểm tra Node/Git → cài thư viện → chạy test → bung dữ liệu từ gói chuyển máy → chỉnh nguồn điện
# (không ngủ) → tạo 2 tác vụ chạy khi BẬT MÁY (không cần đăng nhập Windows) → bật và kiểm tra.
# Không có -Bundle: chỉ cài + test (dùng để chuẩn bị trước, chưa nhận khách).
param([string]$Bundle)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tunnelId = '9fb2be2d-01d8-4b78-8f30-d24095156178'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Hãy mở PowerShell bằng "Run as administrator" rồi chạy lại.' }
foreach ($cmd in 'node', 'npm') { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "Chưa cài Node.js (bản LTS) – tải tại https://nodejs.org rồi chạy lại." } }
$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw "Node.js quá cũ ($(node -v)), cần bản 20 trở lên." }

Set-Location $repo
Write-Host '1/6 Cài thư viện...'
npm ci --no-audit --no-fund
if ($LASTEXITCODE) { throw 'npm ci lỗi' }
Write-Host '2/6 Chạy test...'
npm test; if ($LASTEXITCODE) { throw 'Test chưa đạt – dừng cài đặt.' }

if (-not $Bundle) { Write-Host 'Đã cài + test xong. Chạy lại kèm -Bundle <file zip> khi chuyển thật.'; return }
if (-not (Test-Path $Bundle)) { throw "Không thấy gói dữ liệu: $Bundle" }

Write-Host '3/6 Bung dữ liệu...'
$stage = Join-Path $env:TEMP ('hm-unpack-' + [guid]::NewGuid().ToString('N'))
Expand-Archive $Bundle $stage -Force
New-Item -ItemType Directory -Force "$repo\data", "$repo\tools", "$repo\data\tunnel" | Out-Null
Copy-Item "$stage\data\*" "$repo\data\" -Recurse -Force
if (Test-Path "$stage\env.txt") { Copy-Item "$stage\env.txt" "$repo\.env" -Force }
if (Test-Path "$stage\tools\hm-tunnel.exe") { Copy-Item "$stage\tools\hm-tunnel.exe" "$repo\tools\" -Force }
Copy-Item "$stage\tunnel\$tunnelId.json" "$repo\data\tunnel\" -Force
# Đường dẫn khoá tunnel trong cấu hình phải trỏ tới máy mới
$yml = Get-Content "$stage\tunnel\hoangminh-store.yml" -Raw
$yml = [regex]::Replace($yml, '(?m)^credentials-file:.*$', "credentials-file: $repo\data\tunnel\$tunnelId.json")
Set-Content "$repo\data\tunnel\hoangminh-store.yml" $yml -Encoding ascii
Remove-Item $stage -Recurse -Force
if (-not (Test-Path "$repo\tools\hm-tunnel.exe")) { throw 'Thiếu tools\hm-tunnel.exe trong gói dữ liệu.' }

Write-Host '4/6 Nguồn điện: không ngủ, không ngủ đông...'
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change disk-timeout-ac 0
powercfg /hibernate off

Write-Host '5/6 Tạo tác vụ tự chạy khi bật máy...'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
foreach ($t in @(@{ Name = 'HoangMinh Store'; Bat = 'start.bat' }, @{ Name = 'HoangMinh Tunnel'; Bat = 'tunnel.bat' })) {
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$repo\$($t.Bat)`"" -WorkingDirectory $repo
  Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $principal -Settings $settings -Force | Out-Null
}

Write-Host '6/6 Bật cửa hàng + tunnel và kiểm tra...'
Start-ScheduledTask -TaskName 'HoangMinh Store'
$ok = $false
for ($i = 0; $i -lt 60; $i++) { Start-Sleep 2; try { if ((Invoke-RestMethod http://localhost:3000/healthz -TimeoutSec 3).ok) { $ok = $true; break } } catch {} }
if (-not $ok) { throw 'Cửa hàng chưa chạy – xem data\server.log' }
Start-ScheduledTask -TaskName 'HoangMinh Tunnel'
Start-Sleep 15
$h = Invoke-RestMethod http://localhost:3000/healthz
Write-Host ''
Write-Host "XONG. Cửa hàng chạy với $($h.products) sản phẩm. Nhật ký: data\server.log, data\tunnel.log"
Write-Host 'Kiểm tra từ điện thoại (4G): https://besi.com.vn  – và vào admin xem DropBuy còn đăng nhập.'
Write-Host 'Xoá file zip dữ liệu sau khi chắc chắn mọi thứ chạy.'
