# Cài tự cập nhật BESI trên Windows Server (PowerShell Administrator).
# Repo GitHub public: đọc qua HTTPS, không yêu cầu khóa SSH hay token.
# powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\enable-auto-update.ps1
# Chỉ chọn -UseSshDeployKey nếu muốn chuẩn bị chế độ private.
param([switch]$UseSshDeployKey)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Hãy mở PowerShell bằng "Run as administrator" rồi chạy lại.' }

# HTTPS public là chế độ mặc định; tùy chọn SSH giữ tương thích bản cũ.
if ($UseSshDeployKey) {
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
  
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$repo\scripts\auto-update.ps1`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'HoangMinh Update' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Write-Host ''
Write-Host 'Da dang ky tac vu HoangMinh Update (GitHub main).'
Write-Host 'Nhat ky: data\update.log'
if ($UseSshDeployKey) {
  Write-Host 'Deploy key CONG KHAI; them vao GitHub Settings -> Deploy keys (read-only):'
  Get-Content "$key.pub"
  Write-Host 'KHONG chia se khoa rieng id_ed25519.'
} else {
  Write-Host 'Su dung GitHub HTTPS public, khong can token hay deploy key.'
}
