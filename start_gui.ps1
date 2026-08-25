param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ConfigPath)) {
    throw "Config file not found: $ConfigPath"
}
$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json

function Resolve-FromRoot([string]$p) {
    if ([System.IO.Path]::IsPathRooted($p)) {
        return $p
    }
    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $p))
}

$nodePath = Resolve-FromRoot $config.nodePath
$nodeModules = Resolve-FromRoot $config.nodeModules

if (-not (Test-Path $nodePath)) {
    throw "Node.js not found: $nodePath. Check config.json"
}
if (-not (Test-Path (Join-Path $nodeModules 'playwright'))) {
    throw "Playwright not found: $nodeModules. Check config.json"
}

$env:NODE_PATH = $nodeModules
& $nodePath (Join-Path $PSScriptRoot 'gui_server.js') @args
exit $LASTEXITCODE
