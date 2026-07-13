# Bulletproof auto-start for the RecruitersOS in-market engine.
# Registers a logon-triggered, self-restarting Scheduled Task (needs admin — run elevated).
# Also removes the no-admin Startup-folder fallback so the engine can't double-launch.

$ErrorActionPreference = "Stop"
$vbs = "C:\Users\rrnea\recruiteros\run-engine-hidden.vbs"

$action   = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"' + $vbs + '"')
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
              -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName "RecruitersOS-Engine" `
  -Action $action -Trigger $trigger -Settings $settings `
  -Description "Keeps the RecruitersOS in-market engine (Reoon + pattern cache) alive for Hire Signals." `
  -RunLevel Limited -Force | Out-Null

# Retire the Startup-folder fallback (the task supersedes it — avoids two engines fighting for :3000).
$startupVbs = "C:\Users\rrnea\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\RecruitersOS-Engine.vbs"
if (Test-Path $startupVbs) { Remove-Item $startupVbs -Force }

"OK: RecruitersOS-Engine task registered (AtLogOn, self-restarting); Startup fallback removed." | Out-File "C:\Users\rrnea\recruiteros\install-engine-task.log" -Encoding utf8
