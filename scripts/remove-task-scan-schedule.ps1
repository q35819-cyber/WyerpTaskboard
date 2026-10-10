param()
$ErrorActionPreference = 'Stop'
$TaskNames = @('WyerpTaskboard-TaskScan', 'WyerpTaskboard-TaskScan-10m')
$removed = @()
foreach ($TaskName in $TaskNames) {
  $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($Task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    $removed += $TaskName
  }
}
$StateDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'data\runtime\task-scan'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$State = [ordered]@{ version=2; installed=$false; state='removed'; task_name='WyerpTaskboard-TaskScan'; updated_at=(Get-Date).ToString('o') }
[IO.File]::WriteAllText((Join-Path $StateDir 'scheduler.json'), ($State | ConvertTo-Json -Depth 4) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
[pscustomobject]@{ TaskName = 'WyerpTaskboard-TaskScan'; Removed = ($removed.Count -gt 0); RemovedTasks = ($removed -join ',') }
