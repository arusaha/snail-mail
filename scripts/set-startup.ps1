param([ValidateSet('status', 'enable', 'disable')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$snailRoot = Split-Path -Parent $PSScriptRoot
$snailTray = Join-Path $snailRoot 'releases\SnailMailTray.exe'
$snailNode = (Get-Command node.exe).Source
if (-not (Test-Path -LiteralPath $snailTray)) { throw 'Build the tray first with scripts/build-tray.ps1.' }
# A pipeline makes PowerShell wait for this GUI executable and capture its exit code.
$snailResult = & $snailTray --root $snailRoot --node $snailNode --startup $Action | Out-String
if ($LASTEXITCODE -ne 0) { throw 'Could not update startup. See the error above.' }
$snailResult
