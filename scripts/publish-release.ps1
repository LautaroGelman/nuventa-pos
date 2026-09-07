[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$FrontendCommit,
  [Parameter(Mandatory = $true)][string]$PosCommit,
  [ValidateSet('pilot', 'direct', 'stable')][string]$Ring = 'pilot',
  [switch]$AllowUnsignedPreview
)

$ErrorActionPreference = 'Stop'
$required = @('R2_ENDPOINT_URL', 'R2_BUCKET', 'R2_PUBLIC_BASE_URL')
foreach ($name in $required) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
    throw "Missing required environment variable: $name"
  }
}
if ($Ring -eq 'pilot' -and (-not $env:CF_ACCESS_CLIENT_ID -or -not $env:CF_ACCESS_CLIENT_SECRET)) {
  throw 'Private pilot publication requires CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.'
}

$setup = Join-Path $PSScriptRoot "..\dist\Nuventa-POS-Setup-$Version.exe"
$blockmap = "$setup.blockmap"
$latest = Join-Path $PSScriptRoot '..\dist\latest.yml'
foreach ($file in @($setup, $blockmap, $latest)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Release artifact not found: $file" }
}

$latestText = Get-Content -LiteralPath $latest -Raw
$versionedName = "Nuventa-POS-Setup-$Version.exe"
if ($latestText -notmatch [regex]::Escape("path: $versionedName")) {
  throw "latest.yml does not point to $versionedName"
}

$signature = Get-AuthenticodeSignature -LiteralPath $setup
$signed = $signature.Status -eq 'Valid'
if ($Ring -eq 'stable' -and (-not $signed -or -not $signature.TimeStamperCertificate)) {
  throw "Stable releases require a valid Authenticode signature and timestamp (status: $($signature.Status))."
}
if ($Ring -eq 'stable') {
  if ([string]::IsNullOrWhiteSpace($env:WIN_CSC_PUBLISHER_NAME)) {
    throw 'Stable releases require WIN_CSC_PUBLISHER_NAME for publisher verification.'
  }
  if ($signature.SignerCertificate.Subject -notlike "*$($env:WIN_CSC_PUBLISHER_NAME)*") {
    throw 'The Authenticode signer does not match WIN_CSC_PUBLISHER_NAME.'
  }
}
if (-not $signed -and -not $AllowUnsignedPreview) {
  throw "Unsigned pilot/direct publication requires -AllowUnsignedPreview (status: $($signature.Status))."
}

$hash = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
$blockmapHash = (Get-FileHash -LiteralPath $blockmap -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $setup).Length
$blockmapSize = (Get-Item -LiteralPath $blockmap).Length
$baseUrl = $env:R2_PUBLIC_BASE_URL.TrimEnd('/')
$ringUrl = "$baseUrl/$Ring"
$contract = (Get-Content -Raw (Join-Path $PSScriptRoot '..\pos-contract.json') | ConvertFrom-Json).contractVersion
$manifestPath = Join-Path $PSScriptRoot '..\dist\release.json'
[ordered]@{
  version = $Version
  publishedAt = [DateTime]::UtcNow.ToString('o')
  downloadUrl = "$ringUrl/$versionedName"
  sizeBytes = $size
  sha256 = $hash
  blockmapSha256 = $blockmapHash
  blockmapSizeBytes = $blockmapSize
  posCommit = $PosCommit
  frontendCommit = $FrontendCommit
  contractVersion = $contract
  signed = $signed
  channel = $(if ($signed) { 'stable' } else { 'preview' })
} | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8

$endpointArgs = @('--endpoint-url', $env:R2_ENDPOINT_URL, '--no-progress')
$corsFile = Join-Path $PSScriptRoot 'r2-cors.json'
aws s3api put-bucket-cors --bucket $env:R2_BUCKET --cors-configuration "file://$corsFile" `
  --endpoint-url $env:R2_ENDPOINT_URL
if ($LASTEXITCODE -ne 0) { throw 'Could not apply the R2 browser CORS policy.' }
function Upload([string]$File, [string]$Key, [string]$ContentType, [string]$CacheControl) {
  aws s3 cp $File "s3://$($env:R2_BUCKET)/$Key" @endpointArgs `
    --content-type $ContentType --cache-control $CacheControl
  if ($LASTEXITCODE -ne 0) { throw "Upload failed: $Key" }
}
function UploadImmutable([string]$File, [string]$Key, [string]$ContentType) {
  aws s3api head-object --bucket $env:R2_BUCKET --key $Key --endpoint-url $env:R2_ENDPOINT_URL 1>$null 2>$null
  if ($LASTEXITCODE -eq 0) {
    $existing = [System.IO.Path]::GetTempFileName()
    try {
      aws s3 cp "s3://$($env:R2_BUCKET)/$Key" $existing @endpointArgs
      if ($LASTEXITCODE -ne 0) { throw "Could not verify existing immutable object: $Key" }
      $newHash = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash
      $existingHash = (Get-FileHash -LiteralPath $existing -Algorithm SHA256).Hash
      if ($newHash -ne $existingHash) {
        throw "Immutable release object already exists with different bytes: $Key"
      }
      Write-Output "Reusing byte-identical immutable object: $Key"
      return
    } finally {
      Remove-Item -LiteralPath $existing -Force -ErrorAction SilentlyContinue
    }
  }
  Upload $File $Key $ContentType 'public,max-age=31536000,immutable'
}

# Immutable bytes first. The versioned updater manifest is evidence and makes promotions reproducible.
UploadImmutable $setup "$Ring/$versionedName" 'application/vnd.microsoft.portable-executable'
UploadImmutable $blockmap "$Ring/$versionedName.blockmap" 'application/octet-stream'
UploadImmutable $latest "$Ring/latest-$Version.yml" 'text/yaml; charset=utf-8'
UploadImmutable $manifestPath "$Ring/release-$Version.json" 'application/json; charset=utf-8'

# Mutable pointers last and always no-store.
Upload $setup "$Ring/Nuventa-POS-Setup-latest.exe" 'application/vnd.microsoft.portable-executable' 'no-cache,no-store,must-revalidate'
Upload $manifestPath "$Ring/release.json" 'application/json; charset=utf-8' 'no-cache,no-store,must-revalidate'
Upload $latest "$Ring/latest.yml" 'text/yaml; charset=utf-8' 'no-cache,no-store,must-revalidate'

$purgeUrls = @(
  "$ringUrl/Nuventa-POS-Setup-latest.exe", "$ringUrl/release.json", "$ringUrl/latest.yml"
)
if ($env:CF_API_TOKEN -and $env:CF_ZONE_ID) {
  $purgeBody = @{ files = $purgeUrls } | ConvertTo-Json
  $purge = Invoke-RestMethod -Method Post `
    -Uri "https://api.cloudflare.com/client/v4/zones/$($env:CF_ZONE_ID)/purge_cache" `
    -Headers @{ Authorization = "Bearer $($env:CF_API_TOKEN)"; 'Content-Type' = 'application/json' } `
    -Body $purgeBody
  if (-not $purge.success) { throw 'Cloudflare cache purge failed.' }
} elseif ($Ring -ne 'pilot') {
  throw 'CF_API_TOKEN and CF_ZONE_ID are required to publish mutable direct/stable pointers.'
}

$probeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("nuventa-release-probe-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $probeDir | Out-Null
try {
  $probeHeaders = @{}
  if ($Ring -eq 'pilot') {
    $probeHeaders['CF-Access-Client-Id'] = $env:CF_ACCESS_CLIENT_ID
    $probeHeaders['CF-Access-Client-Secret'] = $env:CF_ACCESS_CLIENT_SECRET
  }
  $publicSetup = Join-Path $probeDir $versionedName
  $publicBlockmap = Join-Path $probeDir "$versionedName.blockmap"
  $publicLatest = Join-Path $probeDir 'latest.yml'
  $publicManifest = Join-Path $probeDir 'release.json'
  Invoke-WebRequest -Uri "$ringUrl/${versionedName}?probe=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" -Headers $probeHeaders -OutFile $publicSetup -UseBasicParsing
  Invoke-WebRequest -Uri "$ringUrl/$versionedName.blockmap?probe=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" -Headers $probeHeaders -OutFile $publicBlockmap -UseBasicParsing
  Invoke-WebRequest -Uri "$ringUrl/latest.yml?probe=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" -Headers $probeHeaders -OutFile $publicLatest -UseBasicParsing
  Invoke-WebRequest -Uri "$ringUrl/release.json?probe=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" -Headers $probeHeaders -OutFile $publicManifest -UseBasicParsing
  if ((Get-FileHash $publicSetup -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw 'Public installer hash mismatch.' }
  if ((Get-FileHash $publicBlockmap -Algorithm SHA256).Hash.ToLowerInvariant() -ne $blockmapHash) { throw 'Public blockmap hash mismatch.' }
  if ((Get-Content $publicLatest -Raw) -ne $latestText) { throw 'Public latest.yml differs byte-for-byte.' }
  $published = (Get-Content $publicManifest -Raw).TrimStart([char]0xFEFF) | ConvertFrom-Json
  if ([string]$published.version -ne $Version -or [string]$published.sha256 -ne $hash) {
    throw 'Public release.json does not match the tested installer.'
  }
  if ($Ring -eq 'pilot') {
    $anonymousProbe = Join-Path $probeDir 'anonymous-probe'
    try {
      Invoke-WebRequest -Uri "$ringUrl/${versionedName}?anonymous=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" `
        -MaximumRedirection 0 -OutFile $anonymousProbe -UseBasicParsing -ErrorAction Stop
      if ((Get-FileHash $anonymousProbe -Algorithm SHA256).Hash.ToLowerInvariant() -eq $hash) {
        throw 'Private pilot is downloadable without Cloudflare Access credentials.'
      }
    } catch {
      if ($_.Exception.Message -like '*downloadable without Cloudflare Access*') { throw }
      # An Access redirect/denial is the expected anonymous result.
    }
  }
} finally {
  Get-ChildItem -LiteralPath $probeDir -File -ErrorAction SilentlyContinue | Remove-Item -Force
  Remove-Item -LiteralPath $probeDir -Force -ErrorAction SilentlyContinue
}

Write-Output "Published Nuventa POS $Version to /$Ring ($size bytes, SHA-256 $hash, signed=$signed)"
