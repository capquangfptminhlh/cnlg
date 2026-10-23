@echo off
REM Mo Cloudflare Tunnel rieng cua cua hang (besi.vn -> cong 3000), tu mo lai neu bi rot. Dong cua so nay de tat.
REM Dung ban sao cloudflared doi ten hm-tunnel.exe: watchdog cua CRM dem tien trinh "cloudflared.exe",
REM chay chung ten se lam no tuong tunnel CRM van song khi da chet.
REM Nhat ky ghi vao data\tunnel.log (khong in ra man hinh: bam vao cua so - QuickEdit - se lam treo lenh in).
cd /d "%~dp0"
title Hoang Minh Tunnel
if not exist tools\hm-tunnel.exe (
  echo [%date% %time%] Thieu tools\hm-tunnel.exe - khong mo tunnel. >> data\tunnel.log
  exit /b 1
)
REM Cau hinh tunnel: uu tien data\tunnel (may chu chay bang tai khoan SYSTEM), khong co thi lay trong %USERPROFILE%\.cloudflared
set "TUNNEL_CFG=%~dp0data\tunnel\hoangminh-store.yml"
if not exist "%TUNNEL_CFG%" set "TUNNEL_CFG=%USERPROFILE%\.cloudflared\hoangminh-store.yml"
if not exist "%TUNNEL_CFG%" (
  echo [%date% %time%] Thieu cau hinh tunnel hoangminh-store.yml - khong mo tunnel. >> data\tunnel.log
  exit /b 1
)
:loop
echo [%date% %time%] Mo tunnel besi.vn... >> data\tunnel.log
tools\hm-tunnel.exe --no-autoupdate --loglevel warn tunnel --config "%TUNNEL_CFG%" run >> data\tunnel.log 2>&1
echo [%date% %time%] Tunnel dung, mo lai sau 10 giay... >> data\tunnel.log
ping -n 11 127.0.0.1 >nul
goto loop
