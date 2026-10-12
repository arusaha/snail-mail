$ErrorActionPreference = 'Stop'
$snailRoot = Split-Path -Parent $PSScriptRoot
$snailTray = Join-Path $snailRoot 'releases\SnailMailTray.exe'
$snailNode = (Get-Command node.exe).Source
if (-not (Test-Path -LiteralPath $snailTray)) { throw 'Build the tray first with scripts/build-tray.ps1.' }
$snailDesktop = [Environment]::GetFolderPath('Desktop')
$snailShortcutPath = Join-Path $snailDesktop 'Snail Mail Server.lnk'
$snailShell = New-Object -ComObject WScript.Shell
try {
    $snailShortcut = $snailShell.CreateShortcut($snailShortcutPath)
    if ((Test-Path -LiteralPath $snailShortcutPath) -and $snailShortcut.TargetPath -ne $snailTray) {
        throw 'An unrelated Snail Mail Server shortcut already exists on the desktop.'
    }
    $snailShortcut.TargetPath = $snailTray
    $snailShortcut.Arguments = '--root "' + $snailRoot + '" --node "' + $snailNode + '"'
    $snailShortcut.WorkingDirectory = $snailRoot
    $snailShortcut.IconLocation = $snailTray + ',0'
    $snailShortcut.Description = 'Start the Snail Mail server in the system tray without a console window.'
    $snailShortcut.Save()
    Get-Item -LiteralPath $snailShortcutPath | Select-Object FullName
} finally {
    if ($snailShortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($snailShortcut) }
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($snailShell)
}
