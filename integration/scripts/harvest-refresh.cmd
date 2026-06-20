@echo off
REM RecruitersOS hiring-signal refresh launcher (called by Task Scheduler).
REM Wraps the PowerShell refresh so schtasks only needs a single path (no quote mangling).
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0harvest-refresh.ps1"
