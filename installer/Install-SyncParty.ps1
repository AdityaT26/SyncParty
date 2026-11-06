# SyncParty installer (fully free path - no Web Store account needed).
# Copies the extension to a stable folder and walks you through the two
# clicks Chrome/Edge require for a locally-loaded extension.
#
# Run:  right-click this file -> "Run with PowerShell"
# (If Windows blocks it:  open PowerShell and run
#   powershell -ExecutionPolicy Bypass -File .\Install-SyncParty.ps1 )

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  SyncParty installer" -ForegroundColor Magenta
Write-Host "  -------------------"

# 1. Locate the extension folder (next to this script).
$src = Join-Path $PSScriptRoot "extension"
if (-not (Test-Path (Join-Path $src "manifest.json"))) {
    Write-Host "  ERROR: 'extension' folder not found next to this script." -ForegroundColor Red
    Write-Host "  Unzip the whole SyncParty zip first, then run this script from inside the unzipped folder."
    Read-Host  "  Press Enter to exit"
    exit 1
}

# 2. Copy to a stable location (so the loaded extension survives moving/deleting the zip).
$dest = Join-Path $env:LOCALAPPDATA "SyncParty\extension"
Write-Host "  Installing to: $dest"
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Path $dest -Force | Out-Null
Copy-Item "$src\*" $dest -Recurse -Force

# 3. Pick a browser.
$chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$edge = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$browser = $null; $extPage = $null; $browserName = $null
if ($chrome) { $browser = $chrome; $extPage = "chrome://extensions/"; $browserName = "Chrome" }
elseif ($edge) { $browser = $edge; $extPage = "edge://extensions/"; $browserName = "Edge" }

if ($chrome -and $edge) {
    $ans = Read-Host "  Found Chrome AND Edge. Install into which? [C]hrome / [E]dge (default C)"
    if ($ans -match '^[eE]') { $browser = $edge; $extPage = "edge://extensions/"; $browserName = "Edge" }
}

if (-not $browser) {
    Write-Host "  Neither Chrome nor Edge was found. Install one, then re-run this script." -ForegroundColor Red
    Read-Host  "  Press Enter to exit"
    exit 1
}

# 4. Put the folder path on the clipboard and open the extensions page.
Set-Clipboard -Value $dest
Start-Process $browser $extPage

Write-Host ""
Write-Host "  $browserName is opening its Extensions page. Now just:" -ForegroundColor Green
Write-Host ""
Write-Host "   1. Turn ON 'Developer mode'  (toggle, top-right corner of that page)"
Write-Host "   2. Click 'Load unpacked'     (button, top-left)"
Write-Host "   3. Paste this path in the folder box (it's already on your clipboard):"
Write-Host "        $dest" -ForegroundColor Yellow
Write-Host "      ...and click 'Select Folder'."
Write-Host ""
Write-Host "  Done! Pin SyncParty from the puzzle-piece icon, open Netflix/Prime/"
Write-Host "  Hotstar/YouTube, click the SyncParty icon and create or join a room."
Write-Host ""
Read-Host "  Press Enter to close"
