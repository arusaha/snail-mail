$ErrorActionPreference = 'Stop'
$snailRoot = Split-Path -Parent $PSScriptRoot
$snailTray = Join-Path $snailRoot 'releases\SnailMailTray.exe'
$snailNode = (Get-Command node.exe).Source
if (-not (Test-Path -LiteralPath $snailTray)) { throw 'Build the tray first with scripts/build-tray.ps1.' }
$action = New-ScheduledTaskAction -Execute $snailTray -Argument ('--root "' + $snailRoot + '" --node "' + $snailNode + '"') -WorkingDirectory $snailRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Snail Mail local server' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Snail Mail system tray and hidden local server, served privately through Tailscale.' -Force | Select-Object TaskName,State
& (Join-Path $PSScriptRoot 'install-shortcut.ps1')
