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
  timeout /t 60 /nobreak >nul
  goto loop
)
echo [%date% %time%] Khoi dong server...
node server.js >> data\server.log 2>&1
echo [%date% %time%] Server dung, khoi dong lai sau 5 giay... (xem data\server.log)
timeout /t 5 /nobreak >nul
goto loop
