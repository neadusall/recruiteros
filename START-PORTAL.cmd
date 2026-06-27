@echo off
title RecruitersOS Portal
setlocal

REM ===========================================================
REM  RecruitersOS Portal - one-click local launcher
REM  Double-click this file to start the Portal.
REM  It opens http://localhost:3040/command in your browser.
REM  Keep this window open while you use it. Ctrl+C to stop.
REM ===========================================================

REM Make sure Node is on PATH (installed at the standard location).
set "PATH=C:\Program Files\nodejs;%PATH%"

cd /d "%~dp0integration"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js was not found. Install it from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

REM If the Portal is already running, just open it (no second server, no port clash).
powershell -NoProfile -Command "try{ if((Invoke-WebRequest 'http://localhost:3040/command' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200){exit 0} }catch{}; exit 1"
if not errorlevel 1 (
  echo.
  echo  Portal is already running. Opening it in your browser...
  start "" "http://localhost:3040/command"
  exit /b 0
)

if not exist node_modules (
  echo.
  echo  One-time setup: installing dependencies. This can take a few minutes...
  echo.
  call npm install
)

echo.
echo  Preparing site assets...
call node sync-public.cjs

echo.
echo  ===========================================================
echo    RecruitersOS Portal is starting...
echo.
echo    Open:  http://localhost:3040/command
echo    Then:  switch to Business Development, open Clients
echo.
echo    Your browser will open automatically once it is ready.
echo    Keep this window open. Press Ctrl+C to stop the Portal.
echo  ===========================================================
echo.

REM Wait (in the background) until the server answers, then open the browser.
start "" powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 90;$i++){try{if((Invoke-WebRequest 'http://localhost:3040/command' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200){Start-Process 'http://localhost:3040/command';break}}catch{}; Start-Sleep -Seconds 2}"

call npx next dev -p 3040
