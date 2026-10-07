@echo off
title Abasyn Scheduler - Go Live
REM ============================================================
REM  One-click: run Abasyn Scheduler on a FREE public URL.
REM  Starts MongoDB + backend (production) + an SSH tunnel.
REM  Keep this window OPEN while you want the site reachable.
REM  Free, no account, no card. URL changes each run (see note
REM  at the bottom for a FIXED url).
REM ============================================================

echo.
echo [1/3] Starting MongoDB...
tasklist | find /i "mongod.exe" >nul
if errorlevel 1 (
  start "MongoDB" /min "D:\Mongo DB\bin\mongod.exe" --dbpath "D:\Mongo DB\data" --port 27017 --bind_ip 127.0.0.1
  timeout /t 7 >nul
) else (
  echo     already running.
)

echo [2/3] Starting backend (production mode, port 5000)...
cd /d "D:\abasyn-scheduler\backend"
set NODE_ENV=production
set PORT=5000
start "Abasyn Backend" cmd /k "set NODE_ENV=production&& set PORT=5000&& node server.js"
timeout /t 7 >nul

echo [3/3] Opening public tunnel...
echo.
echo     Look for a line like:  https://XXXXXX.lhr.life
echo     That is your public link. Login: examcell.abasynisb.edu.pk / admin123
echo.
ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -R 80:localhost:5000 nokey@localhost.run

echo.
echo Tunnel closed. The site is offline now. Re-run this file to go live again.
pause
