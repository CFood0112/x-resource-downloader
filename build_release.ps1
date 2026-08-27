param(
    [switch]$SkipZip
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dst = Join-Path $root 'release\X资源下载器'
$program = Join-Path $dst 'program'

New-Item -ItemType Directory -Force -Path $program | Out-Null

# Preserve bundled runtime between builds.
$runtimeDir = Join-Path $program 'runtime'
if (-not (Test-Path $runtimeDir)) {
    $candidates = @(
        (Join-Path $root 'release\release\X资源下载器\program\runtime'),
        (Join-Path $root 'release\runtime_temp')
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) {
            Move-Item -LiteralPath $c -Destination $runtimeDir
            break
        }
    }
}

if (Test-Path $runtimeDir) {
    Get-ChildItem -LiteralPath $program -Force | Where-Object { $_.Name -ne 'runtime' } | Remove-Item -Recurse -Force
} else {
    Get-ChildItem -LiteralPath $program -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $program | Out-Null

$files = @(
    'gui_server.js','menu.ps1','start_gui.ps1','start_gui.vbs'
)

foreach ($f in $files) {
    $src = Join-Path $root $f
    if (-not (Test-Path $src)) {
        throw "Missing source file: $f"
    }
    Copy-Item -LiteralPath $src -Destination (Join-Path $program $f) -Force
}

foreach ($dir in @('server', 'ui', 'collectors', 'downloaders', 'scripts')) {
    $srcDir = Join-Path $root $dir
    if (-not (Test-Path $srcDir)) {
        throw "Missing source directory: $dir"
    }
    Copy-Item -LiteralPath $srcDir -Destination (Join-Path $program $dir) -Recurse -Force
}

Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination (Join-Path $dst 'README.md') -Force
Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination (Join-Path $dst 'LICENSE') -Force
Copy-Item -LiteralPath (Join-Path $root 'SECURITY.md') -Destination (Join-Path $dst 'SECURITY.md') -Force
Copy-Item -LiteralPath (Join-Path $root 'CHANGELOG.md') -Destination (Join-Path $dst 'CHANGELOG.md') -Force
Copy-Item -LiteralPath (Join-Path $root 'THIRD_PARTY_NOTICES.md') -Destination (Join-Path $dst 'THIRD_PARTY_NOTICES.md') -Force
$dstLicenses = Join-Path $dst 'THIRD_PARTY_LICENSES'
if (Test-Path $dstLicenses) {
    Remove-Item -LiteralPath $dstLicenses -Recurse -Force
}
$thirdPartyLicenses = Join-Path $root 'THIRD_PARTY_LICENSES'
if (Test-Path $thirdPartyLicenses) {
    Copy-Item -LiteralPath $thirdPartyLicenses -Destination (Join-Path $dst 'THIRD_PARTY_LICENSES') -Recurse -Force
}
$screenshots = Join-Path $root 'screenshots'
if (Test-Path $screenshots) {
    $dstScreenshots = Join-Path $dst 'screenshots'
    if (Test-Path $dstScreenshots) {
        Remove-Item -LiteralPath $dstScreenshots -Recurse -Force
    }
    Copy-Item -LiteralPath $screenshots -Destination (Join-Path $dst 'screenshots') -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $root 'release_config.json') -Destination (Join-Path $program 'config.json') -Force

$binDir = Join-Path $root 'release_bin'
foreach ($bin in @('yt-dlp.exe', 'ffmpeg.exe')) {
    $binSrc = Join-Path $binDir $bin
    if (Test-Path $binSrc) {
        Copy-Item -LiteralPath $binSrc -Destination (Join-Path $program $bin) -Force
    }
}

$pythonRuntime = Join-Path $program 'runtime\python'
if (Test-Path $pythonRuntime) {
    Remove-Item -LiteralPath $pythonRuntime -Recurse -Force
}

$guiLauncher = Join-Path $dst '启动X资源下载器.bat'
$menuLauncher = Join-Path $dst '命令行菜单.bat'
$guiText = "@echo off`r`nchcp 65001 >nul`r`nif not exist `"%~dp0program\runtime\node\bin\node.exe`" goto missing`r`ndel /q `"%~dp0program\gui_ready.txt`" >nul 2>nul`r`ndel /q `"%~dp0program\gui_error.log`" >nul 2>nul`r`nwscript.exe `"%~dp0program\start_gui.vbs`"`r`nset /a tries=0`r`n`r`:wait`r`nif exist `"%~dp0program\gui_ready.txt`" exit /b 0`r`nset /a tries+=1`r`nif %tries% geq 10 goto failed`r`nping -n 2 127.0.0.1 >nul`r`ngoto wait`r`n`r`:failed`r`necho GUI 启动失败，请查看 program\gui_error.log：`r`ntype `"%~dp0program\gui_error.log`"`r`necho.`r`npause`r`nexit /b 1`r`n`r`:missing`r`necho 发行包不完整，缺少内置运行时。请重新解压完整 release。`r`npause`r`nexit /b 1"
$menuText = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0program\menu.ps1`"`r`nif errorlevel 1 pause`r`nexit /b %errorlevel%"
[System.IO.File]::WriteAllText($guiLauncher, $guiText, (New-Object System.Text.UTF8Encoding $false))
[System.IO.File]::WriteAllText($menuLauncher, $menuText, (New-Object System.Text.UTF8Encoding $false))

if (Test-Path (Join-Path $root 'release\release')) {
    Remove-Item -LiteralPath (Join-Path $root 'release\release') -Recurse -Force
}
if (Test-Path (Join-Path $root 'release\runtime_temp')) {
    Remove-Item -LiteralPath (Join-Path $root 'release\runtime_temp') -Recurse -Force
}

$forbidden = @('cookies','settings.json','archive.txt','liked_urls.txt','seen_urls.txt','manual_urls.txt','retry_urls.txt','active_batch.txt','skipped_urls.txt','image_urls.txt','image_archive.txt','image_failed.txt','.gui.lock','gui_ready.txt','profile','downloads','videos','images','logs','data','.venv')
$bad = Get-ChildItem $dst -Recurse -Force | Where-Object {
    if ($_.FullName -like (Join-Path $runtimeDir '*')) { return $false }
    $n = $_.Name
    $forbidden | Where-Object { $n -eq $_ -or $n -like "$_*" } | Select-Object -First 1
}
if ($bad) {
    throw "Privacy validation failed: $($bad.FullName -join ', ')"
}

if (-not $SkipZip) {
Remove-Item -LiteralPath (Join-Path $root 'release\X资源下载器.zip') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $root 'release\release.zip') -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $dst '启动X资源下载器.bat'),(Join-Path $dst '命令行菜单.bat'),(Join-Path $dst 'README.md'),(Join-Path $dst 'LICENSE'),(Join-Path $dst 'SECURITY.md'),(Join-Path $dst 'CHANGELOG.md'),(Join-Path $dst 'THIRD_PARTY_NOTICES.md'),(Join-Path $dst 'THIRD_PARTY_LICENSES'),(Join-Path $dst 'screenshots'),$program -DestinationPath (Join-Path $root 'release\X资源下载器.zip') -CompressionLevel Optimal -Force
Compress-Archive -Path $dst -DestinationPath (Join-Path $root 'release\release.zip') -CompressionLevel Optimal -Force
}

Write-Host 'Release build complete.'
