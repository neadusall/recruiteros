@echo off
rem ============================================================================
rem RecruitersOS in-market engine — self-healing local launcher.
rem Runs the Next server (loads .env.local: Reoon + pattern cache lean model),
rem and restarts it automatically if it ever exits, so Hire Signals always has a
rem live engine to pull jobs + validate decision-makers. Started at logon by the
rem "RecruitersOS-Engine" scheduled task (and run once immediately on setup).
rem ============================================================================
title RecruitersOS Engine
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "C:\Users\rrnea\recruiteros\integration"

:loop
echo [RecruitersOS] starting engine at %date% %time%
call npm run dev
echo [RecruitersOS] engine exited (code %errorlevel%) — restarting in 15s...
timeout /t 15 /nobreak >nul
goto loop
