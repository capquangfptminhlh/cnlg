@echo off
REM Chay cua hang tren Windows, tu khoi dong lai neu server dung. Dong cua so nay de tat.
REM Neu cua hang da chay san (vd mo 2 lan), cua so nay chi dung canh va bat len khi server kia tat.
cd /d "%~dp0"
title Hoang Minh Store
if not exist node_modules (
  echo Dang cai dat thu vien...
  call npm install --omit=dev
)
if not exist data\config.json (
  copy data\config.example.json data\config.json >nul
)
if "%HOANGMINH_PORT%"=="" set HOANGMINH_PORT=3000
:loop
curl.exe -s -m 3 -o nul -f http://localhost:%HOANGMINH_PORT%/healthz
if not errorlevel 1 (
  REM Server khac dang chay tren cong nay -> doi 60 giay roi kiem tra lai
  ping -n 61 127.0.0.1 >nul
  goto loop
)
REM Ghi nhat ky vao file, khong in ra man hinh: bam chuot vao cua so (QuickEdit) se lam lenh in ra man hinh treo mai
echo [%date% %time%] Khoi dong server... >> data\server.log
node server.js >> data\server.log 2>&1
echo [%date% %time%] Server dung, khoi dong lai sau 5 giay... >> data\server.log
ping -n 6 127.0.0.1 >nul
goto loop
