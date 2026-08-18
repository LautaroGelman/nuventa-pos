[CmdletBinding()]
param(
  [string]$PackageName = $env:MS_STORE_PACKAGE_NAME,
  [string]$Publisher = $env:MS_STORE_PUBLISHER,
  [string]$PublisherDisplayName = $env:MS_STORE_PUBLISHER_DISPLAY_NAME,
  [string]$Version = $env:MS_STORE_VERSION,
  [string]$FrontendDirectory = $env:NUVENTA_FRONTEND_DIR,
  [switch]$SkipFrontendBuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $projectRoot 'package.json'
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($PackageName)) {
  throw 'Falta MS_STORE_PACKAGE_NAME (Package/Identity/Name de Partner Center).'
}
if ([string]::IsNullOrWhiteSpace($Publisher)) {
  throw 'Falta MS_STORE_PUBLISHER (Package/Identity/Publisher de Partner Center).'
}
if ([string]::IsNullOrWhiteSpace($PublisherDisplayName)) {
  throw 'Falta MS_STORE_PUBLISHER_DISPLAY_NAME (Package/Properties/PublisherDisplayName de Partner Center).'
}

if ([string]::IsNullOrWhiteSpace($Version)) {
  $segments = @([string]$packageJson.version -split '\.')
  if ($segments.Count -ne 3) {
    throw "La version npm '$($packageJson.version)' debe tener tres bloques."
  }
  $Version = "$($segments[0]).$($segments[1]).$($segments[2]).0"
}
if ($Version -notmatch '^[1-9][0-9]{0,4}\.[0-9]{1,5}\.[0-9]{1,5}\.0$') {
  throw "La version Store '$Version' debe usar Major.Minor.Build.0 y cada bloque debe ser 0-65535."
}
$versionParts = @($Version -split '\.' | ForEach-Object { [int]$_ })
if (@($versionParts | Where-Object { $_ -gt 65535 }).Count -gt 0) {
  throw "La version Store '$Version' contiene un bloque mayor que 65535."
}

$layoutRoot = Join-Path $projectRoot 'dist\store-layout'
$layoutDirectory = Join-Path $layoutRoot 'win-unpacked'
$storeOutput = Join-Path $projectRoot 'dist\store'
$manifestDirectory = Join-Path $storeOutput 'manifest'
$manifestPath = Join-Path $manifestDirectory 'Package.appxmanifest'
$executablePath = Join-Path $layoutDirectory 'Nuventa POS.exe'
$logoPath = Join-Path $projectRoot 'assets\icon.ico'
$artifactPath = Join-Path $storeOutput "Nuventa-POS_$($Version)_x64.msix"

if (-not $SkipFrontendBuild) {
  if (-not [string]::IsNullOrWhiteSpace($FrontendDirectory)) {
    $env:NUVENTA_FRONTEND_DIR = $FrontendDirectory
  }
  & npm.cmd run build:web
  if ($LASTEXITCODE -ne 0) { throw 'Fallo la compilacion del frontend para Store.' }
}

& npx.cmd electron-builder --win --x64 --dir "--config.directories.output=$layoutRoot"
if ($LASTEXITCODE -ne 0) { throw 'electron-builder no pudo crear el layout x64.' }
if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
  throw "No se encontro el ejecutable empaquetado: $executablePath"
}

New-Item -ItemType Directory -Path $manifestDirectory -Force | Out-Null
$env:WINAPP_CLI_TELEMETRY_OPTOUT = '1'
& npx.cmd --no-install winapp manifest generate $manifestDirectory `
  --package-name $PackageName `
  --publisher-name $Publisher `
  --version $Version `
  --description 'Nuventa POS - Punto de Venta Offline-First para Windows' `
  --entrypoint $executablePath `
  --template Packaged `
  --logo-path $logoPath `
  --if-exists Overwrite
if ($LASTEXITCODE -ne 0) { throw 'winapp no pudo generar el manifiesto MSIX.' }

[xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
$namespace = New-Object System.Xml.XmlNamespaceManager($manifest.NameTable)
$namespace.AddNamespace('f', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10')
$properties = $manifest.SelectSingleNode('/f:Package/f:Properties', $namespace)
$properties.DisplayName = 'Nuventa POS'
$properties.PublisherDisplayName = $PublisherDisplayName
$resource = $manifest.SelectSingleNode('/f:Package/f:Resources/f:Resource', $namespace)
$resource.SetAttribute('Language', 'es-ar')
$application = $manifest.SelectSingleNode('/f:Package/f:Applications/f:Application', $namespace)
$application.SetAttribute('Id', 'NuventaPOS')
$visualElements = $application.SelectSingleNode("*[local-name()='VisualElements']")
$visualElements.SetAttribute('DisplayName', 'Nuventa POS')
$visualElements.SetAttribute('Description', 'Punto de Venta Offline-First para Windows')
$manifest.Save($manifestPath)

& npx.cmd --no-install winapp pack $layoutDirectory `
  --output $artifactPath `
  --manifest $manifestPath `
  --executable 'Nuventa POS.exe'
if ($LASTEXITCODE -ne 0) { throw 'winapp no pudo generar el paquete MSIX.' }

$artifact = Get-Item -LiteralPath $artifactPath
$hash = Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256
[pscustomobject]@{
  Package = $artifact.FullName
  Version = $Version
  Architecture = 'x64'
  Bytes = $artifact.Length
  SHA256 = $hash.Hash.ToLowerInvariant()
  Signed = $false
  UpdateProvider = 'Microsoft Store'
} | Format-List
