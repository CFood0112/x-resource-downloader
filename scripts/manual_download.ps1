param(
    [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'config.json')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = if (Test-Path $ConfigPath) { Get-Content $ConfigPath -Raw | ConvertFrom-Json } else { $null }

$clipLinks = @()
try {
    $clipText = Get-Clipboard -Raw -ErrorAction Stop
    if ($clipText) {
        $clipLinks = @($clipText -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^https?://' })
    }
} catch {
}

if ($clipLinks.Count -gt 0) {
    Write-Host "从剪贴板读到 $($clipLinks.Count) 个链接："
    $clipLinks | ForEach-Object { Write-Host "  $_" }
    $answer = Read-Host "直接下载这些链接吗？(Y=是 / N=手动粘贴)"
    if ($answer -notmatch '^[Yy]') {
        $clipLinks = @()
    }
}

if ($clipLinks.Count -eq 0) {
    Write-Host "请粘贴链接，每行一个，最后输入空行结束："
    while ($true) {
        $line = Read-Host "链接"
        if ([string]::IsNullOrWhiteSpace($line)) {
            break
        }
        $clipLinks += $line.Trim()
    }
}

if ($clipLinks.Count -eq 0) {
    Write-Host "没有链接，退出。"
    exit 0
}

$manualFile = if ($config -and $config.listsDir) {
    Join-Path $root $config.listsDir 'manual_urls.txt'
} else {
    Join-Path $root 'data\lists\manual_urls.txt'
}
[System.IO.File]::WriteAllLines($manualFile, $clipLinks, (New-Object System.Text.UTF8Encoding $false))
Write-Host "已保存 $($clipLinks.Count) 个链接到 manual_urls.txt"

$forceAnswer = Read-Host "跳过已下载过的吗？(Y=跳过 / N=强制重新下载)"
$forceArgs = @()
if ($forceAnswer -notmatch '^[Yy]') {
    $forceArgs = @('-Force')
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\download_videos.ps1') -ConfigPath $ConfigPath -UrlsFile $manualFile @forceArgs
exit $LASTEXITCODE
