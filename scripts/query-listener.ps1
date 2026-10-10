param(
  [Parameter(Mandatory=$true)][int]$Port
)
$ErrorActionPreference = "Stop"
$items = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
$pids = @($items | Select-Object -ExpandProperty OwningProcess -Unique)
[pscustomobject]@{
  port = $Port
  pids = @($pids | ForEach-Object { [int]$_ })
} | ConvertTo-Json -Compress -Depth 3
