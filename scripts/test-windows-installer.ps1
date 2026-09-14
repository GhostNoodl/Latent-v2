[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
  [switch]$Run
)
$ErrorActionPreference = 'Stop'
$installerFile = (Resolve-Path -LiteralPath $Installer).Path
if ((Get-FileHash -LiteralPath $installerFile -Algorithm SHA256).Hash -ne $ExpectedSha256) { throw 'Installer checksum differs. No installation performed.' }
$studio = Join-Path $env:LOCALAPPDATA 'Latentv2'
$testRoot = Join-Path $env:LOCALAPPDATA 'LatentInstallerAcceptance'
$appFolder = Join-Path $testRoot 'App'
function Get-LatentRegistrations {
  foreach ($regRoot in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
    if (Test-Path $regRoot) { Get-ChildItem $regRoot | Get-ItemProperty | Where-Object { $_.DisplayName -like 'Latent v2*' } }
  }
}
$existing = @(Get-LatentRegistrations)
$shortcuts = @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Latent v2.lnk'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'Latent v2.lnk'))
$shortcuts += @((Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Latent v2.lnk'), (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'Latent v2.lnk'))
$conflicts = @()
if (Test-Path -LiteralPath $studio) { $conflicts += 'An existing studio was found.' }
if (Test-Path -LiteralPath $testRoot) { $conflicts += 'An earlier acceptance test folder exists.' }
if ($existing.Count) { $conflicts += 'Latent is already registered as installed.' }
if (@(Get-Process -Name 'Latent v2' -ErrorAction SilentlyContinue).Count) { $conflicts += 'Latent is running.' }
if (@($shortcuts | Where-Object { Test-Path -LiteralPath $_ }).Count) { $conflicts += 'Existing Latent shortcuts were found.' }
if ($env:LATENT_DATA_ROOT) { $conflicts += 'LATENT_DATA_ROOT is configured; use a clean test account.' }
$plan = [ordered]@{ installerSha256=$ExpectedSha256.ToLowerInvariant(); mode='plan'; ready=($conflicts.Count -eq 0); conflicts=$conflicts; install='Per-user silent setup in a dedicated test folder'; checks=@('Install files and notices','Same-version reinstall','Uninstall preserves studio sentinel'); notCovered=@('Different-version upgrade','Interactive UI','Engine or GPU setup') }
if (-not $Run) { $plan | ConvertTo-Json -Depth 5; return }
if ($conflicts.Count) { throw ($conflicts -join ' ') }
New-Item -ItemType Directory -Path $testRoot | Out-Null
$receipt = [ordered]@{ schema=1; installerSha256=$ExpectedSha256.ToLowerInvariant(); startedAt=(Get-Date).ToUniversalTime().ToString('o'); installed=$false; sameVersionReinstall=$false; uninstalled=$false; studioPreserved=$false; error=$null }
function Invoke-CheckedProcess([string]$Executable,[string]$Arguments) {
  $child=Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Hidden -PassThru -Wait
  if ($child.ExitCode -ne 0) { throw ('Test process returned exit code '+$child.ExitCode) }
}
try {
  Invoke-CheckedProcess $installerFile ('/S /D='+$appFolder)
  foreach ($file in @('Latent v2.exe','Uninstall Latent v2.exe','LICENSE','THIRD-PARTY-NOTICES.txt','README-WINDOWS.txt','LICENSE.electron.txt','LICENSES.chromium.html')) {
    if (-not (Test-Path -LiteralPath (Join-Path $appFolder $file))) { throw ('Missing installed file: '+$file) }
  }
  if (@(Get-Process -Name 'Latent v2' -ErrorAction SilentlyContinue).Count) { throw 'Silent installation unexpectedly launched the app.' }
  $receipt.installed=$true
  New-Item -ItemType Directory -Path $studio | Out-Null
  $sentinel=Join-Path $studio 'acceptance-preserve.txt'
  $content=[Guid]::NewGuid().ToString()
  [IO.File]::WriteAllText($sentinel,$content)
  Invoke-CheckedProcess $installerFile ('/S /D='+$appFolder)
  if ([IO.File]::ReadAllText($sentinel) -ne $content) { throw 'Reinstall changed studio data.' }
  $receipt.sameVersionReinstall=$true
  $uninstaller=(Resolve-Path -LiteralPath (Join-Path $appFolder 'Uninstall Latent v2.exe')).Path
  if ($uninstaller -ne (Join-Path $appFolder 'Uninstall Latent v2.exe')) { throw 'Unexpected uninstaller location.' }
  Invoke-CheckedProcess $uninstaller ('/S _?='+$appFolder)
  if (Test-Path -LiteralPath (Join-Path $appFolder 'Latent v2.exe')) { throw 'App remained after uninstall.' }
  if (@(Get-LatentRegistrations).Count) { throw 'Uninstall registration remained.' }
  if (@($shortcuts | Where-Object { Test-Path -LiteralPath $_ }).Count) { throw 'App shortcuts remained.' }
  $receipt.uninstalled=$true
  $receipt.studioPreserved=([IO.File]::ReadAllText($sentinel) -eq $content)
  if (-not $receipt.studioPreserved) { throw 'Uninstall changed studio data.' }
} catch { $receipt.error=$_.Exception.Message; throw }
finally {
  $receipt['finishedAt']=(Get-Date).ToUniversalTime().ToString('o')
  $receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $testRoot 'result.json') -Encoding UTF8
}
$receipt | ConvertTo-Json -Depth 5
Write-Output 'Acceptance complete. The tiny studio sentinel remains for inspection. Interactive launch and generation are separate checks.'
