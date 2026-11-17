$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ToolRoot = Join-Path $ProjectRoot ".local-tools"
$GradleVersion = "8.13"
$CommandLineToolsVersion = "15859902"
$GradleRoot = Join-Path $ToolRoot "gradle\gradle-$GradleVersion"
$SdkRoot = Join-Path $ToolRoot "android-sdk"
$GradleExecutable = Join-Path $GradleRoot "bin\gradle.bat"
$SdkManager = Join-Path $SdkRoot "cmdline-tools\latest\bin\sdkmanager.bat"

function Download-File([string]$Uri, [string]$Destination) {
  Write-Host "Downloading $([System.IO.Path]::GetFileName($Destination))..."
  Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing
  if (-not (Test-Path -LiteralPath $Destination) -or (Get-Item -LiteralPath $Destination).Length -lt 1MB) {
    throw "The download from $Uri was incomplete. Check your internet connection and try again."
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Install Node.js 20 or newer, then run npm run local again."
}
$nodeVersion = (& node --version).Trim()
if ($nodeVersion -notmatch '^v(?:20|2[1-9]|[3-9]\d)\.') {
  throw "This builder needs Node.js 20 or newer. Detected: $nodeVersion"
}
if (-not (Get-Command java -ErrorAction SilentlyContinue) -or -not (Get-Command javac -ErrorAction SilentlyContinue)) {
  throw "Install a 64-bit Java 17 JDK, then run npm run local again. A JRE by itself is not enough."
}
$javaVersion = (& $env:ComSpec /c 'java -version 2>&1' | Out-String)
if ($javaVersion -notmatch 'version "17(?:\.|"|\+)') {
  throw "This builder needs Java 17. Detected: $($javaVersion.Trim())"
}

New-Item -ItemType Directory -Force -Path $ToolRoot | Out-Null

if (-not (Test-Path -LiteralPath $GradleExecutable)) {
  $gradleArchive = Join-Path $ToolRoot "gradle-$GradleVersion-bin.zip"
  $gradleChecksumFile = Join-Path $ToolRoot "gradle-$GradleVersion-bin.zip.sha256"
  if (-not (Test-Path -LiteralPath $gradleArchive) -or (Get-Item -LiteralPath $gradleArchive).Length -lt 1MB) {
    Download-File "https://services.gradle.org/distributions/gradle-$GradleVersion-bin.zip" $gradleArchive
  }
  if (-not (Test-Path -LiteralPath $gradleChecksumFile)) {
    Invoke-WebRequest -Uri "https://services.gradle.org/distributions/gradle-$GradleVersion-bin.zip.sha256" -OutFile $gradleChecksumFile -UseBasicParsing
  }
  $expectedHash = (Get-Content -LiteralPath $gradleChecksumFile -Raw).Trim().Split()[0].ToUpperInvariant()
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  $archiveStream = [System.IO.File]::OpenRead($gradleArchive)
  try {
    $actualHash = [System.BitConverter]::ToString($sha256.ComputeHash($archiveStream)).Replace("-", "")
  } finally {
    $archiveStream.Dispose()
    $sha256.Dispose()
  }
  if ($actualHash -ne $expectedHash) {
    throw "The Gradle download did not match its published SHA-256 checksum. Remove .local-tools/gradle-$GradleVersion-bin.zip and try again."
  }
  Write-Host "Gradle checksum verified; extracting..."
  Expand-Archive -LiteralPath $gradleArchive -DestinationPath (Join-Path $ToolRoot "gradle") -Force
}

if (-not (Test-Path -LiteralPath $SdkManager)) {
  $sdkArchive = Join-Path $ToolRoot "commandlinetools-win-$CommandLineToolsVersion.zip"
  $sdkExtractRoot = Join-Path $ToolRoot "android-sdk-extract"
  Download-File "https://dl.google.com/android/repository/commandlinetools-win-$($CommandLineToolsVersion)_latest.zip" $sdkArchive
  New-Item -ItemType Directory -Force -Path $sdkExtractRoot | Out-Null
  Expand-Archive -LiteralPath $sdkArchive -DestinationPath $sdkExtractRoot -Force
  $sdkToolsSource = Join-Path $sdkExtractRoot "cmdline-tools"
  $sdkToolsDestination = Join-Path $SdkRoot "cmdline-tools\latest"
  if (-not (Test-Path -LiteralPath (Join-Path $sdkToolsSource "bin\sdkmanager.bat"))) {
    throw "The Android command-line tools archive is missing sdkmanager.bat. Remove .local-tools/android-sdk-extract and try again."
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $sdkToolsDestination) | Out-Null
  Move-Item -LiteralPath $sdkToolsSource -Destination $sdkToolsDestination -Force
}

$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot
$env:PATH = "$(Join-Path $GradleRoot 'bin');$(Join-Path $SdkRoot 'cmdline-tools\latest\bin');$(Join-Path $SdkRoot 'platform-tools');$(Join-Path $SdkRoot 'build-tools\36.0.0');$env:PATH"

Write-Host "Android requires you to review and accept its SDK license before installing build tools."
& $SdkManager --licenses
if ($LASTEXITCODE -ne 0) {
  throw "Android SDK license setup failed. Rerun npm run local and accept the displayed licenses."
}

Write-Host "Installing Android SDK platform 36 and build tools. This may take several minutes the first time."
& $SdkManager --install "platform-tools" "platforms;android-36" "build-tools;36.0.0"
if ($LASTEXITCODE -ne 0) {
  throw "Android SDK installation failed. Check your internet connection, then run npm run local again."
}

$env:PORT = "3000"
$env:HOST = "127.0.0.1"
$env:DATA_DIR = Join-Path $ProjectRoot "data"
Set-Location -LiteralPath $ProjectRoot
Write-Host "Starting Web2App Builder at http://localhost:3000"
Write-Host "Keep this window open while an APK is building. Press Ctrl+C to stop the local server."
& node server.js
