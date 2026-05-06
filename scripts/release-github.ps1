param(
    [string]$Tag,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

if (-not $env:GH_TOKEN) {
    Write-Error "GH_TOKEN environment variable is not set. Set a GitHub token before publishing."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -Path $projectRoot

$packageJson = Get-Content -Raw -Path (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$version = $packageJson.version
$resolvedTag = if ($Tag) { $Tag } else { "v$version" }

Write-Host "Preparing GitHub release $resolvedTag for version $version..." -ForegroundColor Cyan

if (-not $SkipBuild) {
    Write-Host "Building and publishing with electron-builder..." -ForegroundColor Cyan
    & npm run publish:github
    if ($LASTEXITCODE -ne 0) {
        throw "electron-builder publish failed."
    }
    exit 0
}

Write-Host "SkipBuild enabled. Publishing existing artifacts is not implemented separately; run without -SkipBuild." -ForegroundColor Yellow
