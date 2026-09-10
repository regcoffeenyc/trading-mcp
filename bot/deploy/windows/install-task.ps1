# Registers the bot as a Windows Scheduled Task so it starts at logon and keeps
# running unattended.
#
# Run from an elevated PowerShell inside the bot folder:
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1
#
# Manage afterwards:
#   Start-ScheduledTask  -TaskName BybitBot
#   Stop-ScheduledTask   -TaskName BybitBot
#   Get-ScheduledTask    -TaskName BybitBot | Get-ScheduledTaskInfo
#   Unregister-ScheduledTask -TaskName BybitBot -Confirm:$false

$ErrorActionPreference = 'Stop'

$botRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$runner  = Join-Path $botRoot 'deploy\windows\run-bot.cmd'

if (-not (Test-Path (Join-Path $botRoot 'dist\index.js'))) {
  throw "dist\index.js not found. Run 'npm run build' in $botRoot first."
}
if (-not (Test-Path (Join-Path $botRoot '.env'))) {
  throw ".env not found. Run 'npm run setup' in $botRoot first."
}

$action = New-ScheduledTaskAction -Execute $runner -WorkingDirectory $botRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'BybitBot' -Action $action -Trigger $trigger `
  -Settings $settings -Description 'Bybit trading bot' -Force | Out-Null

Write-Host "Registered scheduled task 'BybitBot'."
Write-Host "Start it now with:  Start-ScheduledTask -TaskName BybitBot"
Write-Host ""
Write-Host "IMPORTANT: a desktop PC is a poor 24/7 host. Disable sleep, or the bot"
Write-Host "stops managing positions whenever the machine sleeps:"
Write-Host "  powercfg /change standby-timeout-ac 0"
Write-Host "  powercfg /change hibernate-timeout-ac 0"
