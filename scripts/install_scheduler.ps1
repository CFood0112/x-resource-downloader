param(
    [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'config.json'),
    [ValidateSet('daily', 'weekly')]
    [string]$Frequency = 'weekly',
    [string]$TaskName = 'X Liked Videos Download'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'run_all.ps1'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -ConfigPath `"$ConfigPath`"" -WorkingDirectory $root

if ($Frequency -eq 'daily') {
    $trigger = New-ScheduledTaskTrigger -Daily -At 3:00am
} else {
    $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3:00am
}

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 6) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force

Write-Host "Scheduled task created: $TaskName ($Frequency)" -ForegroundColor Green
