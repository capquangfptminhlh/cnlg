@echo off
REM Chạy cửa hàng trên Windows, tự khởi động lại nếu server dừng. Đóng cửa sổ này để tắt.
cd /d "%~dp0"
if not exist node_modules (
  echo Dang cai dat thu vien...
  call npm install --omit=dev
)
if not exist data\config.json (
  copy data\config.example.json data\config.json >nul
)
:loop
echo [%date% %time%] Khoi dong server...
node server.js
echo Server dung, khoi dong lai sau 5 giay...
timeout /t 5 /nobreak >nul
goto loop
