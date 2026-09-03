[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][ValidateSet('pilot','direct')][string]$From,
  [Parameter(Mandatory = $true)][ValidateSet('direct','stable')][string]$To
)
$ErrorActionPreference = 'Stop'
if ($From -eq $To -or ($From -eq 'direct' -and $To -ne 'stable')) { throw 'Invalid ring promotion.' }
foreach ($name in @('R2_ENDPOINT_URL','R2_BUCKET','R2_PUBLIC_BASE_URL','CF_API_TOKEN','CF_ZONE_ID')) {
  if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing required environment variable: $name" }
}
$endpoint = @('--endpoint-url', $env:R2_ENDPOINT_URL, '--no-progress')
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("nuventa-promote-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $name = "Nuventa-POS-Setup-$Version.exe"
  $files = @($name, "$name.blockmap", "latest-$Version.yml", "release-$Version.json")
  foreach ($file in $files) {
    aws s3 cp "s3://$($env:R2_BUCKET)/$From/$file" (Join-Path $tmp $file) @endpoint
    if ($LASTEXITCODE -ne 0) { throw "Could not retrieve tested source bytes: $From/$file" }
  }
  $release = (Get-Content (Join-Path $tmp "release-$Version.json") -Raw).TrimStart([char]0xFEFF) | ConvertFrom-Json
  $actualHash = (Get-FileHash (Join-Path $tmp $name) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($release.version -ne $Version -or $release.sha256 -ne $actualHash) { throw 'Source evidence does not match installer.' }
  $actualBlockmapHash = (Get-FileHash (Join-Path $tmp "$name.blockmap") -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($release.blockmapSha256 -ne $actualBlockmapHash) { throw 'Source evidence does not match blockmap.' }
  $latestText = Get-Content (Join-Path $tmp "latest-$Version.yml") -Raw
  if ($latestText -notmatch [regex]::Escape("path: $name")) { throw 'Versioned latest.yml points to another installer.' }
  if ($To -eq 'stable') {
    $signature = Get-AuthenticodeSignature (Join-Path $tmp $name)
    if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate) {
      throw 'A build without a valid timestamped Authenticode signature cannot be promoted to stable.'
    }
    $publisherMissing = [string]::IsNullOrWhiteSpace($env:WIN_CSC_PUBLISHER_NAME)
    if ($publisherMissing -or $signature.SignerCertificate.Subject -notlike "*$($env:WIN_CSC_PUBLISHER_NAME)*") {
      throw 'The stable signer does not match WIN_CSC_PUBLISHER_NAME.'
    }
  }
  $base = $env:R2_PUBLIC_BASE_URL.TrimEnd('/')
  $release.downloadUrl = "$base/$To/$name"
  $release.channel = $(if ($release.signed) { 'stable' } else { 'preview' })
  $release | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $tmp "release-$Version.json") -Encoding utf8

  function UploadImmutable([string]$File, [string]$Key, [string]$ContentType) {
    aws s3api head-object --bucket $env:R2_BUCKET --key $Key --endpoint-url $env:R2_ENDPOINT_URL 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) {
      $existing = [System.IO.Path]::GetTempFileName()
      try {
        aws s3 cp "s3://$($env:R2_BUCKET)/$Key" $existing @endpoint
        if ($LASTEXITCODE -ne 0) { throw "Could not verify target immutable object: $Key" }
        if ((Get-FileHash $File -Algorithm SHA256).Hash -ne (Get-FileHash $existing -Algorithm SHA256).Hash) {
          throw "Immutable target already exists with different bytes: $Key"
        }
        return
      } finally {
        Remove-Item -LiteralPath $existing -Force -ErrorAction SilentlyContinue
      }
    }
    aws s3 cp $File "s3://$($env:R2_BUCKET)/$Key" @endpoint --content-type $ContentType --cache-control 'public,max-age=31536000,immutable'
    if ($LASTEXITCODE -ne 0) { throw "Promotion failed for immutable object: $Key" }
  }
  UploadImmutable (Join-Path $tmp $name) "$To/$name" 'application/vnd.microsoft.portable-executable'
  UploadImmutable (Join-Path $tmp "$name.blockmap") "$To/$name.blockmap" 'application/octet-stream'
  UploadImmutable (Join-Path $tmp "latest-$Version.yml") "$To/latest-$Version.yml" 'text/yaml; charset=utf-8'
  UploadImmutable (Join-Path $tmp "release-$Version.json") "$To/release-$Version.json" 'application/json; charset=utf-8'
  foreach ($entry in @(
    @($name, 'Nuventa-POS-Setup-latest.exe', 'application/vnd.microsoft.portable-executable'),
    @("release-$Version.json", 'release.json', 'application/json; charset=utf-8'),
    @("latest-$Version.yml", 'latest.yml', 'text/yaml; charset=utf-8')
  )) {
    aws s3 cp (Join-Path $tmp $entry[0]) "s3://$($env:R2_BUCKET)/$To/$($entry[1])" @endpoint --content-type $entry[2] --cache-control 'no-cache,no-store,must-revalidate'
    if ($LASTEXITCODE -ne 0) { throw "Promotion failed for $($entry[1])" }
  }
  $urls = @("$base/$To/Nuventa-POS-Setup-latest.exe", "$base/$To/release.json", "$base/$To/latest.yml")
  $body = @{ files = $urls } | ConvertTo-Json
  $purge = Invoke-RestMethod -Method Post -Uri "https://api.cloudflare.com/client/v4/zones/$($env:CF_ZONE_ID)/purge_cache" -Headers @{ Authorization = "Bearer $($env:CF_API_TOKEN)"; 'Content-Type' = 'application/json' } -Body $body
  if (-not $purge.success) { throw 'Cloudflare cache purge failed.' }
  Write-Output "Promoted exact tested bytes for $Version from /$From to /$To."
} finally {
  Get-ChildItem -LiteralPath $tmp -File -ErrorAction SilentlyContinue | Remove-Item -Force
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
}
