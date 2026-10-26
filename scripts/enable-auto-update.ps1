# Bật tự cập nhật mã nguồn trên máy chủ – chạy MỘT LẦN bằng PowerShell "Run as administrator":
#
#   powershell -ExecutionPolicy Bypass -File C:\HoangMinh\scripts\enable-auto-update.ps1
#
# 1. Tạo khoá chỉ-đọc (deploy key) trong data\deploy (không lên git) và in ra phần CÔNG KHAI của khoá.
#    Gửi dòng "ssh-ed25519 ..." đó cho người quản trị repo để thêm vào GitHub → Settings → Deploy keys (Read-only).
# 2. Tạo tác vụ "HoangMinh Update" chạy scripts\auto-update.ps1 mỗi 5 phút (tài khoản SYSTEM).
# Chạy lại an toàn: khoá đã có thì giữ nguyên.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Hãy mở PowerShell bằng "Run as administrator" rồi chạy lại.' }

$deploy = Join-Path $repo 'data\deploy'
$key = Join-Path $deploy 'id_ed25519'
New-Item -ItemType Directory -Force $deploy | Out-Null
if (-not (Test-Path $key)) {
  $keygen = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh-keygen.exe'
  if (-not (Test-Path $keygen)) { throw 'Thiếu OpenSSH Client: Settings → Apps → Optional features → thêm "OpenSSH Client".' }
  # PowerShell 5.1 không truyền được tham số rỗng (-N "") cho chương trình ngoài → gọi qua cmd
  cmd /c "`"$keygen`" -t ed25519 -N `"`" -q -C besi-server-auto-update -f `"$key`""
  if (-not (Test-Path $key)) { throw 'Không tạo được khoá.' }
}
# OpenSSH trên Windows từ chối khoá riêng mà người khác đọc được → chỉ SYSTEM và Administrators
icacls $key /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$repo\scripts\auto-update.ps1`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'HoangMinh Update' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Write-Host ''
Write-Host 'Đã tạo tác vụ "HoangMinh Update" (mỗi 5 phút). Nhật ký: data\update.log'
Write-Host ''
Write-Host 'KHOÁ CÔNG KHAI – gửi nguyên dòng dưới đây để thêm vào GitHub (Deploy keys, chỉ đọc):'
Write-Host ''
Get-Content "$key.pub"
Write-Host ''
Write-Host 'Chỉ gửi dòng bắt đầu bằng ssh-ed25519. KHÔNG gửi file id_ed25519 (khoá riêng).'
