param()
$ErrorActionPreference = 'Stop'
$TaskName = 'WyerpTaskboard-ChatGPT-MCP-Health'
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $Task) {
  [pscustomobject]@{ installed=$false; state='missing'; task_name=$TaskName; last_run_at=$null; next_run_at=$null; last_task_result=$null } | ConvertTo-Json -Compress
  exit 0
}
$Info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
  installed=$true
  state=[string]$Task.State
  task_name=$TaskName
  last_run_at=if ($Info.LastRunTime -and $Info.LastRunTime.Year -gt 1900) { $Info.LastRunTime.ToString('o') } else { $null }
  next_run_at=if ($Info.NextRunTime -and $Info.NextRunTime.Year -gt 1900) { $Info.NextRunTime.ToString('o') } else { $null }
  last_task_result=$Info.LastTaskResult
  trigger_count=@($Task.Triggers).Count
} | ConvertTo-Json -Compress
