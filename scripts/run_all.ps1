param(
    [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'config.json')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $ConfigPath)) {
    throw "Config file not found: $ConfigPath"
}
$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json

function Resolve-FromRoot([string]$p) {
    if ([System.IO.Path]::IsPathRooted($p)) {
        return $p
    }
    return [System.IO.Path]::GetFullPath((Join-Path $root $p))
}

$nodePath = Resolve-FromRoot $config.nodePath
$nodeModules = Resolve-FromRoot $config.nodeModules
$collectJs = Join-Path $root 'collectors\collect_likes.js'

if (-not (Test-Path $nodePath)) {
    throw "Node.js not found: $nodePath. Check config.json"
}
if (-not (Test-Path (Join-Path $nodeModules 'playwright'))) {
    throw "Playwright not found: $nodeModules. Check config.json"
}

$env:NODE_PATH = $nodeModules

Write-Host "== 1/2 Collecting likes ==" -ForegroundColor Cyan
& $nodePath $collectJs $ConfigPath
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host "== 2/2 Downloading ==" -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\download_videos.ps1') -ConfigPath $ConfigPath
exit $LASTEXITCODE
