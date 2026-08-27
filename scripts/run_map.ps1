param(
    [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'config.json')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $ConfigPath)) {
    throw "Config file not found: $ConfigPath"
}
$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json

$nodePath = if ([System.IO.Path]::IsPathRooted($config.nodePath)) {
    $config.nodePath
} else {
    [System.IO.Path]::GetFullPath((Join-Path $root $config.nodePath))
}

if (-not (Test-Path $nodePath)) {
    throw "Node.js not found: $nodePath"
}

& $nodePath (Join-Path $root 'scripts\map_remaining_video_meta.js') $ConfigPath
exit $LASTEXITCODE
