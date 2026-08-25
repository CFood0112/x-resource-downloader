param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json')
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Invoke-DownloadStep {
    param([string]$UrlsFile = '')

    $dlArgs = @('-ConfigPath', $ConfigPath)
    if ($UrlsFile) {
        $dlArgs += @('-UrlsFile', $UrlsFile)
    }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'download_videos.ps1') @dlArgs
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

function Invoke-CollectStep {
    param([int]$Count)

    $env:COLLECT_MAX_LIKES = "$Count"
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'collect_likes.ps1') -ConfigPath $ConfigPath
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    } finally {
        Remove-Item Env:COLLECT_MAX_LIKES -ErrorAction SilentlyContinue
    }
}

function Show-Menu {
    Write-Host ""
    Write-Host "===== X 喜欢视频批量下载 =====" -ForegroundColor Cyan
    Write-Host "1. 采集最近 50 条喜欢视频并下载"
    Write-Host "2. 采集最近 100 条喜欢视频并下载"
    Write-Host "3. 自定义采集数量"
    Write-Host "4. 只下载新增（用上次采集的列表）"
    Write-Host "5. 手动粘贴链接下载"
    Write-Host "0. 退出"
    Write-Host ""
}

while ($true) {
    Show-Menu
    $choice = Read-Host "请选择"

    switch ($choice) {
        '1' {
            Write-Host "== 采集最近 50 条 ==" -ForegroundColor Cyan
            Invoke-CollectStep 50
            Invoke-DownloadStep
        }
        '2' {
            Write-Host "== 采集最近 100 条 ==" -ForegroundColor Cyan
            Invoke-CollectStep 100
            Invoke-DownloadStep
        }
        '3' {
            $count = Read-Host "请输入要采集的视频数量"
            $num = 0
            if (-not [int]::TryParse($count, [ref]$num) -or $num -le 0) {
                Write-Host "数量无效。" -ForegroundColor Yellow
                continue
            }
            Write-Host "== 采集最近 $num 条 ==" -ForegroundColor Cyan
            Invoke-CollectStep $num
            Invoke-DownloadStep
        }
        '4' {
            Write-Host "== 下载上次采集列表中的新增视频 ==" -ForegroundColor Cyan
            Invoke-DownloadStep
        }
        '5' {
            Write-Host "== 手动链接下载 ==" -ForegroundColor Cyan
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'manual_download.ps1') -ConfigPath $ConfigPath
            if ($LASTEXITCODE -ne 0) {
                exit $LASTEXITCODE
            }
        }
        '0' {
            exit 0
        }
        default {
            Write-Host "无效选项，请重新输入。" -ForegroundColor Yellow
        }
    }

    Write-Host ""
    Read-Host "按回车返回菜单"
}
