@echo off
rem ============================================================================
rem RecruitersOS in-market engine — self-healing local launcher.
rem Keeps the Next server (loads .env.local: Reoon + pattern cache + JSearch)
rem alive, restarting it if it ever exits, so Hire Signals always has a live
rem engine. Started at logon by the "RecruitersOS-Engine" scheduled task.
rem
rem NOTE: uses `ping` as the sleep (not `timeout`) because `timeout` fails when
rem run headless/detached ("input redirection is not supported"), which made the
rem loop exit instantly. Logs to engine-launcher.log for debuggability.
rem ============================================================================
title RecruitersOS Engine
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "C:\Users\rrnea\recruiteros\integration"
set "LOG=C:\Users\rrnea\recruiteros\integration\engine-launcher.log"

:loop
echo [RecruitersOS] starting engine at %date% %time% >> "%LOG%"
call npm run dev >> "%LOG%" 2>&1
echo [RecruitersOS] engine exited (code %errorlevel%) at %date% %time% — restarting in ~15s >> "%LOG%"
ping -n 16 127.0.0.1 >nul
goto loop
