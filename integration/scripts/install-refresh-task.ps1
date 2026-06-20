# ============================================================
# RecruitersOS · install the hiring-signal refresh schedule
# Registers a Windows Task Scheduler job that runs the harvester
# every 8 hours (3x/day) so the database stays living and breathing
# without you running anything. Uses Register-ScheduledTask (the
# schtasks.exe path mangles the -File argument under Session 0).
#
# Run once:  powershell -ExecutionPolicy Bypass -File integration\scripts\install-refresh-task.ps1
# Remove:    Unregister-ScheduledTask -TaskName "RecruitersOS Hiring Refresh" -Confirm:$false
# Check:     Get-ScheduledTaskInfo -TaskName "RecruitersOS Hiring Refresh"
# ============================================================

$taskName = "RecruitersOS Hiring Refresh"
$script   = "C:\Users\rrnea\recruiteros\integration\scripts\harvest-refresh.ps1"
$ps       = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

$action  = New-ScheduledTaskAction -Execute $ps `
            -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""

# Every 8 hours, indefinitely; start immediately, and catch up if the machine was asleep.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
            -RepetitionInterval (New-TimeSpan -Hours 8) `
            -RepetitionDuration ([TimeSpan]::FromDays(3650))

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "RecruitersOS: refresh live hiring signals every 8 hours" -Force | Out-Null

Write-Host "Installed '$taskName' — runs every 8 hours."
Write-Host "Run it now to verify:  Start-ScheduledTask -TaskName '$taskName'"
