# Packages the RecruiterOS Chrome extension into a Web Store-ready zip.
#   PS> ./extension/package.ps1
# Output: dist/recruiteros-extension-<version>.zip (manifest.json at the zip root).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path        # .../extension
$repo = Split-Path -Parent $root
$ver  = (Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json).version

# Stage only the runtime files (no README / packaging script / source maps).
$staging = Join-Path ([System.IO.Path]::GetTempPath()) "ros-ext-$ver"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
foreach ($item in @('manifest.json','background.js','config.js','content','lib','popup','icons')) {
  $src = Join-Path $root $item
  if (Test-Path $src) { Copy-Item $src $staging -Recurse }
}

$dist = Join-Path $repo 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$zip = Join-Path $dist "recruiteros-extension-$ver.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }

# Build the zip with forward-slash entry names — the Chrome Web Store rejects the
# backslash paths that Compress-Archive writes on Windows.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [System.IO.File]::Open($zip, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
foreach ($f in (Get-ChildItem -Path $staging -Recurse -File)) {
  $entry = $f.FullName.Substring($staging.Length + 1).Replace('\', '/')
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $f.FullName, $entry) | Out-Null
}
$archive.Dispose(); $stream.Dispose()
Remove-Item $staging -Recurse -Force

Write-Host "Packaged v$ver -> $zip"
Write-Host "Upload this zip at https://chrome.google.com/webstore/devconsole (one-time `$5 developer account)."
