$ErrorActionPreference = 'Stop'
$snailRoot = Split-Path -Parent $PSScriptRoot
$snailNode = (Get-Command node.exe).Source
$snailTray = Join-Path $snailRoot 'releases\SnailMailTray.exe'
if (-not (Test-Path -LiteralPath $snailTray)) { throw 'Build the tray first with scripts/build-tray.ps1.' }
Start-Process -FilePath $snailTray -ArgumentList @('--root', ('"' + $snailRoot + '"'), '--node', ('"' + $snailNode + '"')) -WorkingDirectory $snailRoot -WindowStyle Hidden
$snailPort = (Get-Content -LiteralPath (Join-Path $snailRoot 'data\config.json') -Raw | ConvertFrom-Json).port
if (-not $snailPort) { $snailPort = 4318 }
for ($snailAttempt = 0; $snailAttempt -lt 20; $snailAttempt++) {
    try { if ((Invoke-RestMethod "http://127.0.0.1:$snailPort/api/health" -TimeoutSec 2).ok) { exit 0 } } catch {}
    Start-Sleep -Milliseconds 500
}
throw 'The tray started, but the local server did not become healthy. Check data/tray.log.'
