# BESI Check & Auto-Update Utility
# Kiểm tra GitHub origin/main, tự pull, chạy test và khởi động lại nếu có code mới.
param([switch]$Force)
$ErrorActionPreference = 'Stop'
$repo = 'C:\HoangMinh'
Set-Location $repo

Write-Host "=== BESI AUTO-UPDATE CHECK ===" -ForegroundColor Cyan
Write-Host "Fetching origin..."
& git.exe fetch origin main --quiet
$local = (& git.exe rev-parse HEAD).Trim()
$remote = (& git.exe rev-parse origin/main).Trim()

Write-Host "Local SHA:  $local"
Write-Host "Remote SHA: $remote"

if ($local -eq $remote -and -not $Force) {
  Write-Host "He thong dang o ban moi nhat. Khong can cap nhat." -ForegroundColor Green
  exit 0
}

Write-Host "Phat hien commit moi! Dang tien hanh cap nhat..." -ForegroundColor Yellow
& git.exe pull origin main
if ($LASTEXITCODE -ne 0) {
  Write-Error "Git pull that bai!"
  exit 1
}

Write-Host "Chay kiem thu he thong (npm test & npm run test:ui)..."
& npm.cmd test
if ($LASTEXITCODE -ne 0) {
  Write-Error "Backend test that bai! Giu nguyen he thong."
  exit 1
}

& npm.cmd run test:ui
if ($LASTEXITCODE -ne 0) {
  Write-Error "UI test that bai! Giu nguyen he thong."
  exit 1
}

Write-Host "100% Tests PASS. Dang khoi dong lai Node.js qua /api/admin/restart..." -ForegroundColor Green
& node.exe -e "
const fs = require('fs');
let pw = '';
if (fs.existsSync('.env')) {
  const env = fs.readFileSync('.env', 'utf8');
  const m = env.match(/^ADMIN_PASSWORD=(.*)$/m);
  if (m) pw = m[1].trim();
}
if (!pw && fs.existsSync('data/admin-secret.json')) {
  pw = JSON.parse(fs.readFileSync('data/admin-secret.json', 'utf8')).password;
}
fetch('http://127.0.0.1:3000/api/admin/restart', {
  method: 'POST',
  headers: { 'x-admin-key': pw, 'Content-Type': 'application/json' }
}).then(r => r.json()).then(console.log).catch(console.error);
"

Start-Sleep -Seconds 8
try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:3000/healthz" -TimeoutSec 5
  Write-Host "Restart thanh cong! Health: products=$($h.products), release=$($h.release)" -ForegroundColor Green
} catch {
  Write-Warning "Chua nhan duoc phan hoi healthz sau khi restart."
}
