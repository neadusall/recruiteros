# ============================================================
# RecruitersOS · scheduled hiring-signal refresh
# Run by Windows Task Scheduler a few times a day to keep the
# database living: re-pulls live ATS hiring data, refreshes the
# live in-market pool (.data), the committed seed, and the static
# campaign-builder data, then (optionally) pushes the refresh to
# GitHub so the deployed/cold-start seed stays fresh too.
#
# Register it with: integration/scripts/install-refresh-task.ps1
# Logs to: integration/harvest-refresh.log
# ============================================================

$ErrorActionPreference = "Continue"

# Set $true to also commit + push the refreshed data to GitHub each run (keeps the
# deployed cold-start seed fresh). $false = refresh local data only (the running app
# still shows new leads from .data; nothing leaves the machine).
$PushToGitHub = $true

$repo = "C:\Users\rrnea\recruiteros"
$env:Path = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;$env:Path"
$env:ROS_DATA_DIR = "C:/Users/rrnea/recruiteros/integration/.data"
Set-Location $repo
$log = Join-Path $repo "integration\harvest-refresh.log"

"[$(Get-Date -Format s)] refresh start" | Out-File -Append -Encoding utf8 $log

# 1) Pull live hiring data -> static json + committed seed + live .data pool snapshot
node integration\scripts\harvest.mjs *>> $log

# 2) Best-effort GitHub sync of just the refreshed data files (never blocks the refresh)
if ($PushToGitHub) {
  try {
    git add assets/data/hiring-signals.json integration/lib/inmarket/seed-pool.json 2>$null
    # Only commit if something actually changed
    git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
      git commit -q -m "chore(data): scheduled hiring-signal refresh"
      git pull --rebase origin main *>> $log
      git push origin main *>> $log
      "[$(Get-Date -Format s)] pushed refreshed data" | Out-File -Append -Encoding utf8 $log
    } else {
      "[$(Get-Date -Format s)] no data changes to push" | Out-File -Append -Encoding utf8 $log
    }
  } catch {
    "[$(Get-Date -Format s)] git sync skipped: $($_.Exception.Message)" | Out-File -Append -Encoding utf8 $log
  }
}

"[$(Get-Date -Format s)] refresh done" | Out-File -Append -Encoding utf8 $log
