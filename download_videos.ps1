param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json'),
    [string]$UrlsFile = '',
    [switch]$Force
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

$pythonPath = Resolve-FromRoot $config.pythonPath
$activeUrlsFile = if ($UrlsFile) { Resolve-FromRoot $UrlsFile } else { Resolve-FromRoot $config.urlsFile }
$cookiesFile = Resolve-FromRoot $config.cookiesFile
$archiveFile = Resolve-FromRoot $config.archiveFile
$downloadDir = Resolve-FromRoot $config.downloadDir

$settingsFile = Join-Path $PSScriptRoot 'settings.json'
$folderMode = 'flat'
$nameMode = 'structured'
$proxyMode = 'auto'
$proxyUrl = ''
if (Test-Path $settingsFile) {
    $settings = Get-Content $settingsFile -Raw | ConvertFrom-Json
    $folderMode = $settings.folderMode
    $nameMode = $settings.nameMode
    $proxyMode = $settings.proxy
    $proxyUrl = $settings.proxyUrl
}

if (-not (Test-Path $activeUrlsFile)) {
    Write-Host "URL list not found: $activeUrlsFile" -ForegroundColor Yellow
    exit 1
}

New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null

$ffmpeg = $null
try {
    $ffmpeg = (& $pythonPath -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())").Trim()
} catch {
}

$lineCount = (Get-Content $activeUrlsFile | Where-Object { $_.Trim() }).Count
Write-Host "Downloading $lineCount link(s)..." -ForegroundColor Cyan

switch ($folderMode) {
    'uploader' { $subPath = '%(uploader|unknown)s/' }
    'month' { $subPath = '%(upload_date>%Y-%m|unknown)s/' }
    'uploader_month' { $subPath = '%(uploader|unknown)s/%(upload_date>%Y-%m|unknown)s/' }
    default { $subPath = '' }
}
$titlePart = ''
if ($nameMode -eq 'structured_title') {
    $titlePart = ' - %(title).40s'
}
$outputTemplate = Join-Path $downloadDir ($subPath + '%(upload_date|unknown)s - %(uploader|unknown)s - %(id)s' + $titlePart + '%(playlist_index& - {0}|)s.%(ext)s')

$ytArgs = @(
    '--batch-file', $activeUrlsFile,
    '--cookies', $cookiesFile,
    '--ignore-errors',
    '--newline',
    '--no-colors',
    '--retries', '10',
    '--fragment-retries', '10',
    '--file-access-retries', '10',
    '--retry-sleep', '3',
    '--socket-timeout', '30',
    '--http-chunk-size', '10M',
    '--concurrent-fragments', '3',
    '--yes-playlist',
    '-f', 'best/bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', $outputTemplate
)

if ($Force) {
    $ytArgs += @('--force-overwrites')
} else {
    $ytArgs += @('--download-archive', $archiveFile)
}

if ($proxyMode -eq 'custom' -and $proxyUrl) {
    $ytArgs += @('--proxy', $proxyUrl)
}

if ($ffmpeg) {
    Write-Host "Using ffmpeg: $ffmpeg"
    $ytArgs += @('--ffmpeg-location', $ffmpeg)
}

& $pythonPath -m yt_dlp @ytArgs
exit $LASTEXITCODE
