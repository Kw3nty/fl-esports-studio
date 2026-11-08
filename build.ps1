<#
.SYNOPSIS
  Builds FL Esports Studio: dist\FLEsportsStudio.html, dist\FL Esports Studio.exe
  and release\FL-Esports-Studio-<version>-windows-x64.zip with SHA256SUMS.txt.

.EXAMPLE
  .\build.ps1
  .\build.ps1 -Version 1.6.1 -Python py -Go C:\Go\bin\go.exe
  .\build.ps1 -NoZip
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$Python = 'python',
  [string]$Go = 'go',
  [switch]$NoZip
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location -LiteralPath $root

function Invoke-Native([string]$Title, [scriptblock]$Body) {
  Write-Host "==> $Title" -ForegroundColor Cyan
  $global:LASTEXITCODE = 0
  & $Body
  if ($LASTEXITCODE -ne 0) { throw "$Title failed (exit code $LASTEXITCODE)" }
}

if (-not $Version) {
  if ($env:GITHUB_REF_TYPE -eq 'tag' -and $env:GITHUB_REF_NAME -like 'v*') {
    $Version = $env:GITHUB_REF_NAME.Substring(1)
  } else {
    $m = Select-String -LiteralPath (Join-Path $root 'CHANGELOG.md') -Pattern '^## \[(\d+\.\d+(\.\d+)?)\]' | Select-Object -First 1
    $Version = if ($m) { $m.Matches[0].Groups[1].Value } else { 'dev' }
  }
}
Write-Host "FL Esports Studio $Version" -ForegroundColor Green

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null

Invoke-Native 'Build HTML' { & $Python build.py }
Copy-Item -LiteralPath (Join-Path $dist 'FLEsportsStudio.html') -Destination (Join-Path $root 'launcher\ui') -Force

Invoke-Native 'Build exe' {
  $env:GOOS = 'windows'; $env:GOARCH = 'amd64'; $env:CGO_ENABLED = '0'
  Push-Location -LiteralPath (Join-Path $root 'launcher')
  try { & $Go build -trimpath -ldflags '-H windowsgui -s -w' -o (Join-Path $dist 'FL Esports Studio.exe') . }
  finally { Pop-Location }
}

if ($NoZip) { return }

Write-Host '==> Package' -ForegroundColor Cyan
$release = Join-Path $root 'release'
$name = "FL-Esports-Studio-$Version-windows-x64"
$stage = Join-Path $release 'FL Esports Studio'
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$files = @(
  (Join-Path $dist 'FL Esports Studio.exe'),
  (Join-Path $dist 'FLEsportsStudio.html'),
  (Join-Path $root 'README.md'),
  (Join-Path $root 'CHANGELOG.md'),
  (Join-Path $root 'LICENSE'),
  (Join-Path $root 'THIRD_PARTY_NOTICES.md'),
  (Join-Path $root 'docs\PROTOCOL.md')
)
foreach ($f in $files) { Copy-Item -LiteralPath $f -Destination $stage }
Get-ChildItem -LiteralPath (Join-Path $root 'scripts') -Filter '*.bat' | Copy-Item -Destination $stage

$zip = Join-Path $release "$name.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $true)
Remove-Item -LiteralPath $stage -Recurse -Force

$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $release 'SHA256SUMS.txt'), "$hash  $name.zip" + "`n")
Write-Host "Done: $zip" -ForegroundColor Green
Write-Host "SHA-256: $hash"
