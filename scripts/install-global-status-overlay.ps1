param([switch]$NoLaunch)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Overlay = Join-Path $Root "scripts\global-status-overlay.ps1"
$Launcher = Join-Path $Root "scripts\start-global-status-overlay.vbs"
if (-not (Test-Path -LiteralPath $Overlay)) { throw "global-status-overlay.ps1 is missing" }
if (-not (Test-Path -LiteralPath $Launcher)) { throw "start-global-status-overlay.vbs is missing" }

$TaskName = "WyerpTaskboard-Global-Status"
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR "System32\wscript.exe") -Argument ("`"" + $Launcher + "`"") -WorkingDirectory $Root
$Principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 3650) -MultipleInstances IgnoreNew
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($ExistingTask) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
$Task = New-ScheduledTask -Action $Action -Principal $Principal -Settings $Settings
Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null

$startup = [Environment]::GetFolderPath("Startup")
$legacyLink = Join-Path $startup "WyerpTaskboard-Global-Status.lnk"
$legacyRemoved = $false
if (Test-Path -LiteralPath $legacyLink) {
  Remove-Item -LiteralPath $legacyLink -Force
  $legacyRemoved = $true
}

if (-not $NoLaunch) {
  Start-ScheduledTask -TaskName $TaskName
}
[pscustomobject]@{ installed=$true; startup_mode="with_taskboard"; scheduled_task=$TaskName; legacy_startup_shortcut_removed=$legacyRemoved; launched=(-not $NoLaunch) } | ConvertTo-Json -Depth 3
