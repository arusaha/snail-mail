$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'set-startup.ps1') -Action enable
& (Join-Path $PSScriptRoot 'install-shortcut.ps1')
