param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$FrontendCommit,
  [Parameter(Mandatory = $true)][string]$PosCommit,
  [switch]$AllowUnsigned
)

$ErrorActionPreference = 'Stop'
$required = @('R2_ENDPOINT_URL', 'R2_BUCKET', 'R2_PUBLIC_BASE_URL')
foreach ($name in $required) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
    throw "Missing required environment variable: $name"
  }
}

$setup = Join-Path $PSScriptRoot "..\dist\Nuventa-POS-Setup-$Version.exe"
$blockmap = "$setup.blockmap"
$latest = Join-Path $PSScriptRoot '..\dist\latest.yml'
foreach ($file in @($setup, $blockmap, $latest)) {
  if (-not (Test-Path -LiteralPath $file)) { throw "Release artifact not found: $file" }
}

$signature = Get-AuthenticodeSignature -LiteralPath $setup
if ($signature.Status -ne 'Valid' -and -not $AllowUnsigned) {
  throw "Installer signature is not valid: $($signature.Status)"
}
if ($signature.Status -ne 'Valid') {
  Write-Warning "TEST MODE: publishing unsigned installer ($($signature.Status))."
}

$hash = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $setup).Length
$baseUrl = $env:R2_PUBLIC_BASE_URL.TrimEnd('/')
$versionedName = "Nuventa-POS-Setup-$Version.exe"
$contract = (Get-Content -Raw (Join-Path $PSScriptRoot '..\pos-contract.json') | ConvertFrom-Json).contractVersion
$manifestPath = Join-Path $PSScriptRoot '..\dist\release.json'
[ordered]@{
  version = $Version
  publishedAt = [DateTime]::UtcNow.ToString('o')
  downloadUrl = "$baseUrl/stable/$versionedName"
  sizeBytes = $size
  sha256 = $hash
  posCommit = $PosCommit
  frontendCommit = $FrontendCommit
  contractVersion = $contract
  signed = ($signature.Status -eq 'Valid')
} | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8

$endpointArgs = @('--endpoint-url', $env:R2_ENDPOINT_URL, '--no-progress')
function Assert-PublicHead([string]$Uri, [string]$Description) {
  curl.exe --fail --silent --show-error --head $Uri | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "$Description is not publicly readable." }
}

aws s3 cp $setup "s3://$($env:R2_BUCKET)/stable/$versionedName" @endpointArgs `
  --content-type 'application/vnd.microsoft.portable-executable' `
  --cache-control 'public,max-age=31536000,immutable'
aws s3 cp $blockmap "s3://$($env:R2_BUCKET)/stable/$versionedName.blockmap" @endpointArgs `
  --content-type 'application/octet-stream' `
  --cache-control 'public,max-age=31536000,immutable'

Assert-PublicHead "$baseUrl/stable/$versionedName" 'Versioned installer'

aws s3 cp $setup "s3://$($env:R2_BUCKET)/Nuventa-POS-Setup-latest.exe" @endpointArgs `
  --content-type 'application/vnd.microsoft.portable-executable' `
  --content-disposition 'attachment; filename="Nuventa-POS-Setup-latest.exe"' `
  --cache-control 'no-cache,no-store,must-revalidate'
aws s3 cp $manifestPath "s3://$($env:R2_BUCKET)/stable/release.json" @endpointArgs `
  --content-type 'application/json; charset=utf-8' `
  --cache-control 'no-cache,no-store,must-revalidate'
# Publish updater metadata last so clients never see a release before all of its files exist.
aws s3 cp $latest "s3://$($env:R2_BUCKET)/stable/latest.yml" @endpointArgs `
  --content-type 'text/yaml; charset=utf-8' `
  --cache-control 'no-cache,no-store,must-revalidate'

$manifestMatches = $false
for ($attempt = 1; $attempt -le 6; $attempt++) {
  try {
    $probe = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $publicManifest = Invoke-RestMethod `
      -Uri "$baseUrl/stable/release.json?probe=$probe" `
      -Headers @{ 'Cache-Control' = 'no-cache' } `
      -TimeoutSec 30
    if ($publicManifest -is [string]) {
      $publicManifest = $publicManifest.TrimStart([char]0xFEFF) | ConvertFrom-Json
    }
    if ([string]$publicManifest.version -eq $Version -and [string]$publicManifest.sha256 -eq $hash) {
      $manifestMatches = $true
      break
    }
  } catch {
    Write-Warning "Release manifest probe $attempt failed: $($_.Exception.Message)"
  }
  if ($attempt -lt 6) { Start-Sleep -Seconds 3 }
}
if (-not $manifestMatches) {
  throw 'Published release manifest does not match the installer.'
}
Assert-PublicHead "$baseUrl/Nuventa-POS-Setup-latest.exe" 'Stable download alias'
Write-Output "Published Nuventa POS $Version ($size bytes, SHA-256 $hash)"
