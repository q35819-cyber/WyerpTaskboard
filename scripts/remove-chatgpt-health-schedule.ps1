param()
$ErrorActionPreference = 'Stop'
$TaskName = 'WyerpTaskboard-ChatGPT-MCP-Health'
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
$Root = Split-Path -Parent $PSScriptRoot
$StateDir = Join-Path $Root 'data\runtime\chatgpt-health'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$State = [ordered]@{ version=1; installed=$false; state='removed'; task_name=$TaskName; updated_at=(Get-Date).ToString('o') }
[IO.File]::WriteAllText((Join-Path $StateDir 'scheduler.json'), ($State | ConvertTo-Json -Depth 3) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
[pscustomobject]@{ TaskName=$TaskName; Removed=[bool]$Task }
