param()
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Cli = Join-Path $Root 'cli\task-scan.mjs'
# scheduled mode performs a full scan only when watch/re-arm says it is due.
& $Node $Cli scheduled
exit $LASTEXITCODE
