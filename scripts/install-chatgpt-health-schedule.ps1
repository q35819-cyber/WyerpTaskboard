param(
  [ValidateRange(1, 60)]
  [int]$IntervalMinutes = 1
)
$ErrorActionPreference = 'Stop'
$TaskName = 'WyerpTaskboard-ChatGPT-MCP-Health'
$Root = Split-Path -Parent $PSScriptRoot
$Cli = Join-Path $Root 'cli\chatgpt-health.mjs'
$HiddenRunner = Join-Path $PSScriptRoot 'run-hidden.vbs'
if (-not (Test-Path -LiteralPath $Cli)) { throw "ChatGPT健康巡检CLI不存在: $Cli" }
if (-not (Test-Path -LiteralPath $HiddenRunner)) { throw "无窗口启动器不存在: $HiddenRunner" }

$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Wscript = (Get-Command wscript.exe -ErrorAction Stop).Source
$Arguments = '//B //Nologo "' + $HiddenRunner + '" "' + $Node + '" "' + $Cli + '" "check"'
$Action = New-ScheduledTaskAction -Execute $Wscript -Argument $Arguments
$PeriodicTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$LogonTrigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 50) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$Description = "WyerpTaskboard ChatGPT健康巡检：每${IntervalMinutes}分钟无窗口执行轻量检查；仅异常或明确UI需求时按需启动Windows-MCP，不抢前台、不点击正常会话。"
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger @($PeriodicTrigger, $LogonTrigger) -Settings $Settings -Description $Description -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
$StateDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'data\runtime\chatgpt-health'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$State = [ordered]@{
  version=1
  installed=$true
  state='installed'
  task_name=$TaskName
  interval_minutes=$IntervalMinutes
  trigger_mode='logon_plus_interval'
  multiple_instances='IgnoreNew'
  hidden=$true
  launcher='wscript_node_hidden'
  mcp_policy='anomaly_or_explicit_ui_only'
  updated_at=(Get-Date).ToString('o')
}
[IO.File]::WriteAllText((Join-Path $StateDir 'scheduler.json'), ($State | ConvertTo-Json -Depth 4) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName,State,Description
