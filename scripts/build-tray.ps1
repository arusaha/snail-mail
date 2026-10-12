$ErrorActionPreference = 'Stop'
$snailRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $snailRoot
$snailCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $snailCompiler)) { throw 'The Windows .NET Framework C# compiler is unavailable.' }
New-Item -ItemType Directory -Force 'releases' | Out-Null
# ICO can embed a PNG. Reuse the app's existing artwork, without adding packages.
@'
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
const png = await sharp('public/icon-192.png').resize(32,32).png().toBuffer();
const header = Buffer.alloc(22);
header.writeUInt16LE(1,2); header.writeUInt16LE(1,4);
header[6]=32; header[7]=32;
header.writeUInt16LE(1,10); header.writeUInt16LE(32,12);
header.writeUInt32LE(png.length,14); header.writeUInt32LE(22,18);
writeFileSync('releases/SnailMailTray.ico',Buffer.concat([header,png]));
'@ | node --input-type=module
if ($LASTEXITCODE -ne 0) { throw 'Tray icon build failed' }
& $snailCompiler /nologo /target:winexe /optimize+ /out:releases\SnailMailTray.exe /win32icon:releases\SnailMailTray.ico /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll windows\SnailMailTray.cs
if ($LASTEXITCODE -ne 0) { throw 'Tray build failed; quit the existing tray before rebuilding.' }
Get-Item -LiteralPath 'releases\SnailMailTray.exe' | Select-Object FullName,Length
