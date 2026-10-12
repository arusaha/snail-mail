$ErrorActionPreference = 'Stop'
$snailRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $snailRoot
$snailLocalJdk = Join-Path $snailRoot '.tools\jdk21'
if (-not $env:JAVA_HOME -or -not (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
    $jdkFolder = if (Test-Path -LiteralPath $snailLocalJdk) { Get-ChildItem -Directory $snailLocalJdk | Select-Object -First 1 }
    if (-not $jdkFolder) { throw 'Set JAVA_HOME to JDK 21, or install a JDK under .tools/jdk21.' }
    $env:JAVA_HOME = $jdkFolder.FullName
}
$env:Path = (Join-Path $env:JAVA_HOME 'bin') + ';' + $env:Path
$env:VITE_API_ORIGIN = (Get-Content -LiteralPath 'data/config.json' -Raw | ConvertFrom-Json).publicOrigin
if (-not $env:VITE_API_ORIGIN) { throw 'Set your private Tailscale publicOrigin and allowedLogin in data/config.json before building Android.' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Web build failed' }
npm.cmd exec cap sync android
if ($LASTEXITCODE -ne 0) { throw 'Capacitor sync failed' }
if (-not (Test-Path 'data\signing')) { New-Item -ItemType Directory 'data\signing' | Out-Null }
if (-not (Test-Path 'data\signing\release.jks')) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $signingPassword = [Convert]::ToBase64String($bytes)
    [System.IO.File]::WriteAllText((Join-Path $snailRoot 'data\signing\password'), $signingPassword)
    & (Join-Path $env:JAVA_HOME 'bin\keytool.exe') -genkeypair -keystore 'data\signing\release.jks' -storepass:file 'data\signing\password' -keypass:file 'data\signing\password' -alias snailmail -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Snail Mail Local, OU=Personal, O=Snail Mail, C=US'
    if ($LASTEXITCODE -ne 0) { throw 'Signing key generation failed' }
}
$signingPassword = [System.IO.File]::ReadAllText((Join-Path $snailRoot 'data\signing\password'))
$properties = "storeFile=../data/signing/release.jks`nstorePassword=$signingPassword`nkeyAlias=snailmail`nkeyPassword=$signingPassword`n"
[System.IO.File]::WriteAllText((Join-Path $snailRoot 'android\key.properties'), $properties)
Push-Location android
try { & .\gradlew.bat assembleRelease --console=plain; if ($LASTEXITCODE -ne 0) { throw 'Android build failed' } } finally { Pop-Location }
New-Item -ItemType Directory -Force 'releases' | Out-Null
Copy-Item -LiteralPath 'android\app\build\outputs\apk\release\app-release.apk' -Destination 'releases\snail-mail.apk' -Force
$snailApkHash = (Get-FileHash 'releases\snail-mail.apk' -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText((Join-Path $snailRoot 'releases\snail-mail.apk.sha256'), "$snailApkHash  snail-mail.apk`n")
Get-FileHash 'releases\snail-mail.apk' -Algorithm SHA256 | Select-Object Hash,Path
