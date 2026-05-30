# ─────────────────────────────────────────────────────────────
# RecruiterOS Outreach Studio — one-command local launch (Windows)
#
#   Right-click → "Run with PowerShell", or:
#     powershell -ExecutionPolicy Bypass -File .\START-STUDIO.ps1
#
# Serves the portal at http://localhost:5173 so the Outreach Studio
# can talk to the browser extension, then opens it.
# ─────────────────────────────────────────────────────────────
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# Node is installed but not always on the session PATH — refresh it.
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path", "User") + ";C:\Program Files\nodejs"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js not found. Install from https://nodejs.org (LTS) and re-run." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "Starting RecruiterOS portal on http://localhost:5173 ..." -ForegroundColor Cyan
Write-Host "Load the extension at chrome://extensions (Developer mode -> Load unpacked -> the 'extension' folder)," -ForegroundColor DarkGray
Write-Host "copy its ID, then open the Studio -> LinkedIn Live tab and paste it." -ForegroundColor DarkGray
Write-Host ""

Start-Process "http://localhost:5173/alfred.html"
node "$PSScriptRoot\server.cjs"
