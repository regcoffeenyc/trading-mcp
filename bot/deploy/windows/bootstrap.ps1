# One-command install for Windows.
#
#   powershell -ExecutionPolicy Bypass -File deploy\windows\bootstrap.ps1
#
# Installs dependencies, builds, runs the test suite, writes .env from the
# credentials note on your Desktop, and runs the pre-flight check. It does NOT
# start trading and does NOT send any order.

$ErrorActionPreference = 'Stop'
$botRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $botRoot

Write-Host "Bybit bot bootstrap" -ForegroundColor Cyan
Write-Host ("=" * 72)
Write-Host "Working in $botRoot"

# --- Node version ------------------------------------------------------------
try { $nodeVersion = (& node --version) } catch {
  throw "Node.js is not installed or not on PATH. Install Node 22 LTS from https://nodejs.org and reopen PowerShell."
}
$major = [int]($nodeVersion -replace '^v(\d+)\..*$', '$1')
if ($major -lt 22) {
  throw "Node $nodeVersion found, but this bot needs Node 22 or newer (it uses the built-in WebSocket and .env support). Install Node 22 LTS from https://nodejs.org."
}
Write-Host "Node $nodeVersion OK" -ForegroundColor Green

# --- Build and verify --------------------------------------------------------
Write-Host "`nInstalling dependencies..."
& npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { throw "npm install failed." }

Write-Host "`nBuilding..."
& npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed." }

Write-Host "`nRunning the test suite..."
& npm test
if ($LASTEXITCODE -ne 0) { throw "Tests failed. Do not trade with a failing build." }
Write-Host "Tests passed." -ForegroundColor Green

# --- Credentials -------------------------------------------------------------
if (Test-Path (Join-Path $botRoot '.env')) {
  Write-Host "`n.env already exists, leaving it alone." -ForegroundColor Yellow
} else {
  Write-Host "`nReading your API credentials note..."
  & npm run setup
  if ($LASTEXITCODE -ne 0) { throw "Setup could not read your credentials note. See the message above." }
}

# --- Pre-flight --------------------------------------------------------------
Write-Host "`nPre-flight check..."
& npm run doctor

Write-Host "`n$('=' * 72)"
Write-Host "Bootstrap complete. Nothing has been traded." -ForegroundColor Green
Write-Host ""
Write-Host "Next, in order:"
Write-Host "  npm run backtest    what the strategy actually did historically"
Write-Host "  npm start           paper trading (live prices, simulated fills)"
Write-Host ""
Write-Host "Only after those look right, switch MODE and NETWORK in .env."
