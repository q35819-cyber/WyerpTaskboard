param()
$ErrorActionPreference = 'Stop'
$TaskNames = @('WyerpTaskboard-TaskScan', 'WyerpTaskboard-TaskScan-10m')
$task = $null
$TaskName = $TaskNames[0]
foreach ($candidate in $TaskNames) {
  $found = Get-ScheduledTask -TaskName $candidate -ErrorAction SilentlyContinue
  if ($found) { $task = $found; $TaskName = $candidate; break }
}
if ($null -eq $task) {
  [pscustomobject]@{
    live_probe = $true
    installed = $false
    state = 'missing'
    task_name = $TaskNames[0]
    last_run_at = $null
    next_run_at = $null
    last_task_result = $null
  } | ConvertTo-Json -Compress
  exit 0
}
$info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
  live_probe = $true
  installed = $true
  state = [string]$task.State
  task_name = $TaskName
  last_run_at = if ($info.LastRunTime -and $info.LastRunTime.Year -gt 1900) { $info.LastRunTime.ToString('o') } else { $null }
  next_run_at = if ($info.NextRunTime -and $info.NextRunTime.Year -gt 1900) { $info.NextRunTime.ToString('o') } else { $null }
  last_task_result = $info.LastTaskResult
  trigger_count = @($task.Triggers).Count
} | ConvertTo-Json -Compress
