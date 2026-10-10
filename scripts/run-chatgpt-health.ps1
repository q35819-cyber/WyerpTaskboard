param()
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Cli = Join-Path $Root 'cli\chatgpt-health.mjs'
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$StateDir = Join-Path $Root 'data\runtime\chatgpt-health'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$Log = Join-Path $StateDir 'last-run.log'
try {
  $Output = & $Node $Cli check 2>&1 | Out-String
  [IO.File]::WriteAllText($Log, $Output, [Text.UTF8Encoding]::new($false))
  exit $LASTEXITCODE
} catch {
  [IO.File]::WriteAllText($Log, ($_ | Out-String), [Text.UTF8Encoding]::new($false))
  exit 1
}
