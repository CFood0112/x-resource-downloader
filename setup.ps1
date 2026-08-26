$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw 'Python 3 not found. Install Python and add it to PATH first.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js not found. Install Node.js and add it to PATH first.'
}

if (-not (Test-Path (Join-Path $root '.venv'))) {
    & python -m venv (Join-Path $root '.venv')
}

$venvPython = Join-Path $root '.venv\Scripts\python.exe'
& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install yt-dlp imageio-ffmpeg

Push-Location $root
try {
    if (-not (Test-Path (Join-Path $root 'node_modules'))) {
        & npm install
    }
} finally {
    Pop-Location
}

if (-not (Test-Path (Join-Path $root 'config.json'))) {
    Copy-Item (Join-Path $root 'config.example.json') (Join-Path $root 'config.json')
}

Write-Host 'Setup complete. Double-click x_video_downloader.bat to start the GUI.'
