param(
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$releaseFolder = (
    Get-ChildItem -LiteralPath (Join-Path $root 'release') -Directory |
    Where-Object { $_.Name -like 'X*' } |
    Select-Object -First 1
).FullName
if (-not $releaseFolder) { throw 'Release folder not found under release/' }
$releaseName = Split-Path -Leaf $releaseFolder

Write-Host 'Building release with -SkipZip...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'build_release.ps1') -SkipZip
if ($LASTEXITCODE -ne 0) { throw 'Release build failed' }

$tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("xrd_release_smoke_" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpRoot | Out-Null
$program = Join-Path $tmpRoot (Join-Path $releaseName 'program')

try {
    Copy-Item -LiteralPath $releaseFolder -Destination $tmpRoot -Recurse -Force
    $programData = Join-Path $program 'data'
    if (Test-Path $programData) {
        Remove-Item -LiteralPath $programData -Recurse -Force
    }

    $node = Join-Path $program 'runtime\node\bin\node.exe'
    if (-not (Test-Path $node)) {
        throw "Bundled Node not found: $node"
    }

    $port = 18765 + (Get-Random -Minimum 0 -Maximum 1000)
    $env:GUI_PORT = "$port"
    $env:GUI_NO_OPEN = '1'
    $env:NO_POPUP = '1'
    $p = Start-Process -FilePath $node -ArgumentList 'gui_server.js','--no-open' -WorkingDirectory $program -PassThru -WindowStyle Hidden

    $base = "http://127.0.0.1:$port"
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        $state = curl.exe -sS "$base/api/state" 2>$null
        if ($state) {
            $stateObj = $state | ConvertFrom-Json
            if ($stateObj.state) { $ready = $true; break }
        }
    }
    if (-not $ready) { throw 'GUI server did not become ready' }

    $requiredDirs = @('cookies','lists','videos','images','logs','jobs','run')
    $missing = @()
    foreach ($d in $requiredDirs) {
        if (-not (Test-Path (Join-Path $programData $d))) { $missing += $d }
    }
    "CREATED_DIRS_OK=$($missing.Count -eq 0)"
    if ($missing.Count) { "MISSING_DIRS=$($missing -join ',')" }

    $accountFile = Join-Path $programData 'cookies\cookies_download_acc1.txt'
    [System.IO.File]::WriteAllText($accountFile, "# Netscape HTTP Cookie File`n.twitter.com`tTRUE`t/`tTRUE`t0`ttwid`tu%3D1234567890123456789`n", (New-Object System.Text.UTF8Encoding $false))
    $state = curl.exe -sS "$base/api/state" | ConvertFrom-Json
    "ACCOUNT_READY=$($state.config.downloadAccountReady)"
    "ACCOUNTS=$($state.config.downloadAccounts -join ',')"
    "ACCOUNT_ID=$($state.config.downloadAccountIds.acc1)"

    $homeBody = (curl.exe -sS "$base/" | Out-String)
    $queue = curl.exe -sS "$base/api/queue" | ConvertFrom-Json
    "HOME_OK=$($homeBody.Length -gt 1000)"
    "OPEN_BUTTONS_OK=$($homeBody.Contains('openVideoDir') -and $homeBody.Contains('openImageDir'))"
    "QUEUE_OK=$($null -ne $queue.queue)"
}
finally {
    if ($p) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
    Remove-Item Env:GUI_PORT -ErrorAction SilentlyContinue
    Remove-Item Env:GUI_NO_OPEN -ErrorAction SilentlyContinue
    Remove-Item Env:NO_POPUP -ErrorAction SilentlyContinue
    if (-not $KeepTemp) {
        Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "Temp kept at: $tmpRoot"
    }
}
