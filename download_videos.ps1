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
$ytdlpPath = if ($config.ytdlpPath) { Resolve-FromRoot $config.ytdlpPath } else { '' }
$ffmpegPathConfig = if ($config.ffmpegPath) { Resolve-FromRoot $config.ffmpegPath } else { '' }
$activeUrlsFile = if ($UrlsFile) { Resolve-FromRoot $UrlsFile } else { Resolve-FromRoot $config.urlsFile }
$archiveFile = Resolve-FromRoot $config.archiveFile

$settingsFile = Join-Path $PSScriptRoot 'settings.json'
$folderMode = 'flat'
$nameMode = 'structured'
$downloadDir = Resolve-FromRoot $config.downloadDir
$proxyMode = 'auto'
$proxyUrl = ''
$useDownloadAccount = $false
if (Test-Path $settingsFile) {
    $settings = Get-Content $settingsFile -Raw | ConvertFrom-Json
    if ($null -ne $settings.video) {
        $folderMode = $settings.video.folderMode
        $nameMode = $settings.video.nameMode
        if ($settings.video.downloadDir) {
            $downloadDir = Resolve-FromRoot $settings.video.downloadDir
        }
    } else {
        $folderMode = $settings.folderMode
        $nameMode = $settings.nameMode
    }
    $proxyMode = $settings.proxy
    $proxyUrl = $settings.proxyUrl
    $useDownloadAccount = [bool]$settings.useDownloadAccount
}

$activeCookiesFile = Resolve-FromRoot $config.cookiesFile
$downloadCookiesFile = Resolve-FromRoot $config.downloadCookiesFile
if ($useDownloadAccount -and (Test-Path $downloadCookiesFile)) {
    $activeCookiesFile = $downloadCookiesFile
}

if (-not (Test-Path $activeUrlsFile)) {
    Write-Host "URL list not found: $activeUrlsFile" -ForegroundColor Yellow
    exit 1
}

New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null

$ffmpeg = $null
if ($ffmpegPathConfig -and (Test-Path $ffmpegPathConfig)) {
    $ffmpeg = $ffmpegPathConfig
} else {
    try {
        $ffmpeg = (& $pythonPath -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())").Trim()
    } catch {
    }
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
$outputTemplate = Join-Path $downloadDir ('likes/' + $subPath + '%(upload_date|unknown)s - %(uploader|unknown)s - %(id)s' + $titlePart + '%(playlist_index& - {0}|)s.%(ext)s')

$ytArgs = @(
    '--batch-file', $activeUrlsFile,
    '--cookies', $activeCookiesFile,
    '--ignore-errors',
    '--newline',
    '--no-colors',
    '--retries', '10',
    '--extractor-retries', '10',
    '--fragment-retries', '10',
    '--file-access-retries', '10',
    '--retry-sleep', '3',
    '--sleep-requests', '2',
    '--sleep-interval', '2',
    '--socket-timeout', '30',
    '--http-chunk-size', '10M',
    '--legacy-server-connect',
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

if ($ytdlpPath -and (Test-Path $ytdlpPath)) {
    & $ytdlpPath @ytArgs
} else {
    & $pythonPath -m yt_dlp @ytArgs
}
exit $LASTEXITCODE
