param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ConfigPath)) {
    throw "Config file not found: $ConfigPath"
}
$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json

$nodePath = if ([System.IO.Path]::IsPathRooted($config.nodePath)) {
    $config.nodePath
} else {
    [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $config.nodePath))
}

if (-not (Test-Path $nodePath)) {
    throw "Node.js not found: $nodePath"
}

& $nodePath (Join-Path $PSScriptRoot 'map_remaining_video_meta.js') $ConfigPath
exit $LASTEXITCODE
