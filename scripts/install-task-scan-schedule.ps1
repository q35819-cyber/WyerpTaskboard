param(
  [ValidateRange(1, 1440)]
  [int]$IntervalMinutes = 10
)
$ErrorActionPreference = 'Stop'
$TaskName = 'WyerpTaskboard-TaskScan'
$LegacyTaskName = 'WyerpTaskboard-TaskScan-10m'
$Root = Split-Path -Parent $PSScriptRoot
$Cli = Join-Path $Root 'cli\task-scan.mjs'
$HiddenRunner = Join-Path $PSScriptRoot 'run-hidden.vbs'
if (-not (Test-Path -LiteralPath $Cli)) { throw "扫描CLI不存在: $Cli" }
if (-not (Test-Path -LiteralPath $HiddenRunner)) { throw "无窗口启动器不存在: $HiddenRunner" }

$LegacyTask = Get-ScheduledTask -TaskName $LegacyTaskName -ErrorAction SilentlyContinue
if ($LegacyTask) { Unregister-ScheduledTask -TaskName $LegacyTaskName -Confirm:$false }

$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Wscript = (Get-Command wscript.exe -ErrorAction Stop).Source
$Arguments = '//B //Nologo "' + $HiddenRunner + '" "' + $Node + '" "' + $Cli + '" "scheduled"'
$Action = New-ScheduledTaskAction -Execute $Wscript -Argument $Arguments
$PeriodicTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$LogonTrigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 8) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$Description = "WyerpTaskboard自适应任务巡检：Windows每${IntervalMinutes}分钟触发轻量调度；watch/re-arm时完整扫描白名单项目，idle_suspended时不扫描，不直接修改任务阶段/负责人。"
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger @($PeriodicTrigger, $LogonTrigger) -Settings $Settings -Description $Description -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
$StateDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'data\runtime\task-scan'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$State = [ordered]@{ version=2; installed=$true; state='installed'; task_name=$TaskName; interval_minutes=$IntervalMinutes; trigger_mode='adaptive_logon_plus_interval'; multiple_instances='IgnoreNew'; start_when_available=$true; execution_time_limit_minutes=8; hidden=$true; launcher='wscript_node_hidden'; updated_at=(Get-Date).ToString('o') }
[IO.File]::WriteAllText((Join-Path $StateDir 'scheduler.json'), ($State | ConvertTo-Json -Depth 4) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName,State,Description
