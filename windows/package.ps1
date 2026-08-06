[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+(?:\.\d+){1,2}$')]
  [string]$Version,

  [string]$OutputDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'outputs')
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path $PSScriptRoot -Parent
$applicationRoot = Join-Path $PSScriptRoot 'app'
$electronRoot = Join-Path $applicationRoot 'node_modules\electron\dist'
$stagingRoot = Join-Path $OutputDirectory ("stage-v{0}" -f $Version)
$payloadRoot = Join-Path $stagingRoot 'StockPet-PnL'
$archivePath = Join-Path $OutputDirectory ("StockPet-PnL-Windows-x64-v{0}.zip" -f $Version)
$packageJsonPath = Join-Path $applicationRoot 'package.json'
$allowedLocales = @('zh-CN.pak', 'en-US.pak')

if (-not (Test-Path -LiteralPath $electronRoot -PathType Container)) {
  throw "Electron runtime not found: $electronRoot"
}

$package = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
if ($package.version -ne $Version) {
  throw "package.json version is $($package.version), expected $Version"
}

if (Test-Path -LiteralPath $stagingRoot) {
  throw "Staging directory already exists: $stagingRoot"
}
if (Test-Path -LiteralPath $archivePath) {
  throw "Release archive already exists: $archivePath"
}

New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
Get-ChildItem -LiteralPath $electronRoot -Force |
  Copy-Item -Destination $payloadRoot -Recurse -Force

# This app is Chinese-only. Keep English as Electron's safe fallback, but do not
# include Chromium's other 53 unused language packs in every release.
$localesDirectory = Join-Path $payloadRoot 'locales'
Get-ChildItem -LiteralPath $localesDirectory -File -Filter '*.pak' |
  Where-Object { $_.Name -notin $allowedLocales } |
  Remove-Item -Force

$applicationDestination = Join-Path $payloadRoot 'resources\app'
New-Item -ItemType Directory -Path $applicationDestination -Force | Out-Null
Get-ChildItem -LiteralPath $applicationRoot -Force |
  Where-Object { $_.Name -notin @('node_modules', '.git', '.DS_Store') } |
  Copy-Item -Destination $applicationDestination -Recurse -Force

Rename-Item -LiteralPath (Join-Path $payloadRoot 'electron.exe') -NewName 'StockPet-PnL.exe'
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'LICENSE') -Destination (Join-Path $payloadRoot 'LICENSE-StockPet-MIT.txt') -Force

Compress-Archive -LiteralPath $payloadRoot -DestinationPath $archivePath -CompressionLevel Optimal

$localeNames = @(Get-ChildItem -LiteralPath $localesDirectory -File -Filter '*.pak' | Select-Object -ExpandProperty Name)
if (@($localeNames | Where-Object { $_ -notin $allowedLocales }).Count -ne 0 -or $localeNames.Count -ne $allowedLocales.Count) {
  throw 'Locale filtering verification failed.'
}

Write-Output "Created $archivePath"
Write-Output "Locales: $($localeNames -join ', ')"
